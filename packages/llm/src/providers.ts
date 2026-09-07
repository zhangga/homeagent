/**
 * Local agent-CLI providers (mew's "provider" concept, adapted to a single
 * machine). mew routes a task to a provider running on some Device; homeagent
 * has no remote devices, so a "provider" here is an agent CLI installed on THIS
 * machine (claude / codex / trae-cli). This module is the single choke point for
 * all CLI provider traffic — like gateway.ts is for the network gateway.
 *
 * Two responsibilities:
 *   - detectProviders(): probe each known CLI with `--version` (bounded), and
 *     verify each CLI's required execution capabilities and authenticated status
 *     with no-completion probes, so the backend only offers providers that are
 *     runnable and ready.
 *     (A CLI can be on PATH yet broken — e.g. a Windows npm shim under WSL with
 *     no linux `node` — and must NOT be offered.)
 *   - runProviderDetailed(): spawn the CLI non-interactively and normalize its
 *     answer plus any structured usage it reports. runProvider() keeps the
 *     legacy text-only boundary for external callers.
 *
 * The built-in "gateway" provider (the Anthropic network gateway) is handled by
 * gateway.ts, not here; it is always available and is the default.
 */
import { createHash, randomUUID } from "node:crypto";
import { AI_OPERATION_TIMEOUT_MS, brandedEnv, config, logger } from "@homeagent/shared";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ImageInput } from "./gateway.ts";

const log = logger.child("providers");

/** Stable provider ids. "gateway" is the built-in network provider (elsewhere). */
export type ProviderId = "gateway" | "claude" | "codex" | "trae-cli";

export type UsageCostBasis = "reported" | "estimated" | "unavailable";
export type UsageSource = "claude-json" | "codex-jsonl" | "trae-text" | "gateway" | "legacy-text";

/** Provider usage counters preserve provenance and leave unavailable values absent. */
export interface CompletionUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  costUsd?: number;
  costBasis: UsageCostBasis;
  source: UsageSource;
}

/** Structured result returned by a local CLI adapter. */
export interface ProviderRunResult {
  text: string;
  model?: string;
  usage: CompletionUsage;
  /** Provider-owned conversation id returned for an explicitly stateful Chat turn. */
  nativeSessionId?: string;
}

export type NativeSessionRequest =
  | { mode: "start" }
  | { mode: "fork"; id: string };

export class ProviderRunError extends Error {
  constructor(
    readonly provider: ProviderId,
    message: string,
    readonly usage: CompletionUsage,
  ) {
    super(message);
    this.name = "ProviderRunError";
  }
}

/** Reasoning levels currently exposed by the GPT-5.6 family in Codex. */
export const CODEX_REASONING_EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"] as const;
export type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORTS)[number];

const STANDARD_REASONING_EFFORTS: readonly CodexReasoningEffort[] = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
];
const LEGACY_CODEX_REASONING_EFFORTS: readonly CodexReasoningEffort[] = [
  "low",
  "medium",
  "high",
  "xhigh",
];

/** Reasoning choices verified for the selected Codex model. */
export function codexReasoningEffortsForModel(
  model?: string,
): readonly CodexReasoningEffort[] {
  if (model === "gpt-5.6-sol" || model === "gpt-5.6-terra" || model === "gpt-5.6-luna") {
    return CODEX_REASONING_EFFORTS;
  }
  if (model === "gpt-5.5" || model === "gpt-5.4" || model === "gpt-5.4-mini") {
    return STANDARD_REASONING_EFFORTS;
  }
  if (model === "gpt-5.3-codex-spark") return LEGACY_CODEX_REASONING_EFFORTS;
  return [];
}

export function isCodexReasoningEffortSupported(
  model: string | undefined,
  effort: string,
): effort is CodexReasoningEffort {
  return codexReasoningEffortsForModel(model).includes(effort as CodexReasoningEffort);
}

/**
 * The default local CLI used when an agent doesn't specify one. "gateway" is no
 * longer a user-selectable provider (the internal API is only used by the claude
 * CLI, not homeagent directly), so agents default to a real CLI.
 */
export const DEFAULT_CLI_PROVIDER: ProviderId = "claude";

interface CliSpec {
  id: ProviderId;
  /** display name (mirrors mew's labels) */
  name: string;
  /** binary looked up on PATH */
  bin: string;
  /** managed-install override used by the standalone desktop application */
  envBin: "CODEX_BIN" | "CLAUDE_BIN" | "TRAE_BIN";
  /** args that print a version quickly and exit */
  versionArgs: string[];
  /** curated model ids this provider commonly offers (mew shows these per-provider) */
  models: string[];
  /**
   * Build the argv to run a one-shot, non-interactive completion. System/model
   * are folded in per CLI; Claude and Codex read prompts from stdin so message
   * bodies are not exposed through argv or truncated by Windows command shims.
   */
  buildRun: (input: PreparedRunInput) => string[];
}

export interface RunInput {
  prompt: string;
  system?: string;
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
  /** local images attached to the current user turn */
  images?: ImageInput[];
  /** Resolved Skill identifiers supplied independently of ProviderExecution. */
  skills?: string[];
  /** Canonical, hash-verified Skill bundles supplied only for this invocation. */
  skillInputs?: ProviderSkillInput[];
  /** Canonical Agent working directory used by the current call. */
  workdir?: string;
  /** Canonical HomeAgent data root protected from Provider filesystem tools. */
  protectedDataRoot?: string;
  /** Present for Chat, Task, or explicit web-research grants; absent for distillation. */
  execution?: ProviderExecution;
  /** Final-response contract for providers with native structured-output support. */
  outputSchema?: Record<string, unknown>;
  /** Caller output budget, enforced locally when the CLI has no native flag. */
  maxTokens?: number;
  /** Explicitly start or fork a Provider-owned conversation. Omitted calls stay isolated. */
  nativeSession?: NativeSessionRequest;
  /**
   * Apply the same frozen Codex topic boundary to an internal routing or
   * classification call that intentionally does not join Provider history.
   */
  nativeSessionIsolation?: boolean;
}

/** Ephemeral path evidence for one frozen Skill; never persisted or returned to clients. */
export interface ProviderSkillInput {
  name: string;
  directory: string;
  skillFile: string;
  /** Frozen complete-bundle digest captured in durable Run evidence. */
  bundleHash: string;
}

interface PreparedRunInput extends RunInput {
  outputSchemaPath?: string;
  outputLastMessagePath?: string;
  /** Harmless, invocation-owned read root used by the no-model sandbox proof. */
  nativeIsolationReadRoot?: string;
  /** Authentication cache selected by a no-completion status probe. */
  codexCredentialStore?: "file" | "keyring";
}

export class UnsupportedImageInputError extends Error {
  constructor(readonly provider: ProviderId) {
    super(`provider ${provider} does not support image inputs`);
    this.name = "UnsupportedImageInputError";
  }
}

export type ProviderExecutionPermission = "read-only" | "write" | "full";

export interface ProviderExecution {
  permission: ProviderExecutionPermission;
  /** Validated, canonical working directory for the provider process. */
  workdir?: string;
  /** Complete-catalog or pinned Skill identifiers visible to the provider. */
  skills: string[];
  /** Every discovered Skill is available; select only those relevant to the request. */
  skillMode?: "all";
  /** Allow evidence-gathering commands, configured Skills, and native web research together. */
  research?: boolean;
  /** Explicitly allow the provider's native read-only web research tools. */
  webSearch?: boolean;
}

/** Keep skill references identifier-only before interpolating them into prompts. */
export function normalizeProviderSkills(skills: readonly unknown[]): string[] {
  const seen = new Set<string>();
  return skills
    .filter((skill): skill is string => typeof skill === "string")
    .map((skill) => skill.trim())
    .filter((skill) => /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/.test(skill))
    .filter((skill) => {
      if (seen.has(skill)) return false;
      seen.add(skill);
      return true;
    });
}

export function providerSkillReference(
  id: ProviderId,
  skill: string,
): string | undefined {
  const normalized = normalizeProviderSkills([skill])[0];
  if (!normalized) return undefined;
  if (id === "claude") return `/${normalized}`;
  if (id === "codex") return `$${normalized}`;
  if (id === "trae-cli") return normalized;
  return undefined;
}

function normalizeProviderPermission(permission: unknown): ProviderExecutionPermission {
  if (permission === "write" || permission === "full") return permission;
  return "read-only";
}

function sandboxForPermission(
  permission: ProviderExecutionPermission | undefined,
): "read-only" | "workspace-write" | "danger-full-access" {
  if (permission === "write") return "workspace-write";
  if (permission === "full") return "danger-full-access";
  return "read-only";
}

// Matches Core's bounded all-Skill execution evidence. The native permission
// profile below also enforces a platform-specific encoded argv ceiling.
const MAX_PROVIDER_SKILL_INPUTS = 2_000;
const MAX_PROVIDER_SKILL_BUNDLE_ENTRIES = 50_000;
const MAX_PROVIDER_SKILL_BUNDLE_BYTES = 16 * 1024 * 1024;
const MAX_PROVIDER_SKILL_INVOCATION_ENTRIES = 50_000;
const MAX_PROVIDER_SKILL_INVOCATION_BYTES = 16 * 1024 * 1024;
const MAX_CODEX_NATIVE_PERMISSION_CONFIG_CHARS = process.platform === "win32"
  ? 20_000
  : 128_000;

interface ProviderSkillBundleFile {
  path: string;
  mode: number;
  content: Buffer;
}

/**
 * Distinguish "this invocation ran out of shared staging budget" from every
 * other bundle rejection. Only the two capacity limits qualify; integrity
 * failures (symlinks, escapes, mid-capture mutation, missing SKILL.md) must keep
 * failing the whole call so a tampered bundle can never be silently dropped.
 */
function isProviderSkillBudgetExhausted(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return message === "Skill bundle is too large"
    || message === "Skill bundle has too many entries";
}

interface ProviderSkillBundleSnapshot {
  hash: string;
  files: ProviderSkillBundleFile[];
  entries: number;
  totalBytes: number;
}

function sameFileIdentity(
  before: NonNullable<ReturnType<typeof lstatSync>>,
  after: NonNullable<ReturnType<typeof lstatSync>>,
): boolean {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mode === after.mode
    && before.mtimeMs === after.mtimeMs
    && before.ctimeMs === after.ctimeMs;
}

function snapshotProviderSkillBundle(
  skillFile: string,
  maxEntries = MAX_PROVIDER_SKILL_BUNDLE_ENTRIES,
  maxTotalBytes = MAX_PROVIDER_SKILL_BUNDLE_BYTES,
): ProviderSkillBundleSnapshot {
  const root = dirname(skillFile);
  const rootBefore = lstatSync(root);
  const canonicalRoot = realpathSync(root);
  if (rootBefore.isSymbolicLink() || !rootBefore.isDirectory()) {
    throw new Error("Skill bundle root is invalid");
  }
  const files: ProviderSkillBundleFile[] = [];
  const pending = [{ directory: root, relativeDir: "", depth: 0 }];
  let entries = 0;
  let totalBytes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.depth > 32) throw new Error("Skill bundle is too deeply nested");
    const directoryBefore = lstatSync(current.directory);
    const canonicalDirectory = realpathSync(current.directory);
    const directoryFromRoot = relative(canonicalRoot, canonicalDirectory);
    if (
      directoryBefore.isSymbolicLink()
      || !directoryBefore.isDirectory()
      || directoryFromRoot === ".."
      || directoryFromRoot.startsWith(`..${sep}`)
      || isAbsolute(directoryFromRoot)
    ) {
      throw new Error("Skill bundle directory escapes its root");
    }
    const children = readdirSync(current.directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      entries += 1;
      if (entries > maxEntries) throw new Error("Skill bundle has too many entries");
      const fullPath = join(current.directory, child.name);
      const metadata = lstatSync(fullPath);
      if (metadata.isSymbolicLink()) {
        throw new Error("Skill bundle cannot contain symbolic links");
      }
      const canonicalPath = realpathSync(fullPath);
      const fromRoot = relative(canonicalRoot, canonicalPath);
      if (
        fromRoot === ".."
        || fromRoot.startsWith(`..${sep}`)
        || isAbsolute(fromRoot)
      ) {
        throw new Error("Skill bundle entry escapes its root");
      }
      const relativePath = join(current.relativeDir, child.name).split(sep).join("/");
      if (metadata.isDirectory()) {
        pending.push({
          directory: fullPath,
          relativeDir: relativePath,
          depth: current.depth + 1,
        });
        continue;
      }
      if (!metadata.isFile()) throw new Error("Skill bundle contains a non-regular file");
      totalBytes += metadata.size;
      if (totalBytes > maxTotalBytes) throw new Error("Skill bundle is too large");
      const content = readFileSync(fullPath);
      const after = lstatSync(fullPath);
      if (after.isSymbolicLink() || !after.isFile() || !sameFileIdentity(metadata, after)) {
        throw new Error("Skill bundle changed while it was being captured");
      }
      files.push({ path: relativePath, mode: metadata.mode & 0o777, content });
    }
    const directoryAfter = lstatSync(current.directory);
    if (!sameFileIdentity(directoryBefore, directoryAfter)) {
      throw new Error("Skill bundle directory changed while it was being captured");
    }
  }
  const rootAfter = lstatSync(root);
  if (!sameFileIdentity(rootBefore, rootAfter)) {
    throw new Error("Skill bundle root changed while it was being captured");
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  if (!files.some((file) => file.path === "SKILL.md")) {
    throw new Error("Skill bundle has no SKILL.md");
  }
  if (files.length === 1 && files[0]!.path === "SKILL.md") {
    return {
      hash: createHash("sha256").update(files[0]!.content).digest("hex"),
      files,
      entries,
      totalBytes,
    };
  }
  const hash = createHash("sha256").update("homeagent-skill-bundle-v1\0");
  for (const file of files) {
    hash.update(
      `${Buffer.byteLength(file.path)}:${file.path}\0${file.mode}\0${file.content.length}\0`,
    );
    hash.update(file.content);
  }
  return { hash: hash.digest("hex"), files, entries, totalBytes };
}

/** Compute the complete frozen Skill manifest shared with Core admission. */
export function hashProviderSkillBundle(
  skillFile: string,
  maxEntries?: number,
  maxTotalBytes?: number,
): string {
  return snapshotProviderSkillBundle(skillFile, maxEntries, maxTotalBytes).hash;
}

interface StagedProviderSkillInputs {
  inputs: ProviderSkillInput[];
  cleanup: () => void;
}

function stageProviderSkillInputs(
  inputs: readonly ProviderSkillInput[],
  signal?: AbortSignal,
): StagedProviderSkillInputs {
  if (signal?.aborted) {
    throw signal.reason ?? new Error("provider Skill staging cancelled");
  }
  if (inputs.length === 0) return { inputs: [], cleanup: () => {} };
  const stageRoot = stageCodexNativeTemporaryDirectory("homeagent-codex-skills-");
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try {
      rmSync(stageRoot, { recursive: true, force: true });
    } catch {
      log.warn("Codex staged Skill cleanup failed");
    }
  };
  try {
    let stagedEntries = 0;
    let stagedBytes = 0;
    const overBudget: string[] = [];
    const staged: ProviderSkillInput[] = [];
    inputs.forEach((input, index) => {
      if (signal?.aborted) {
        throw signal.reason ?? new Error("provider Skill staging cancelled");
      }
      let captured: ProviderSkillBundleSnapshot;
      try {
        captured = snapshotProviderSkillBundle(
          input.skillFile,
          Math.min(
            MAX_PROVIDER_SKILL_BUNDLE_ENTRIES,
            MAX_PROVIDER_SKILL_INVOCATION_ENTRIES - stagedEntries,
          ),
          Math.min(
            MAX_PROVIDER_SKILL_BUNDLE_BYTES,
            MAX_PROVIDER_SKILL_INVOCATION_BYTES - stagedBytes,
          ),
        );
      } catch (error) {
        // Exhausting the shared per-invocation budget is a capacity limit, not
        // evidence that the frozen bundle was tampered with. Drop the Skill from
        // this invocation instead of failing the whole call; a bundle that
        // actually changed still fails the hash comparison below.
        if (isProviderSkillBudgetExhausted(error)) {
          overBudget.push(input.name);
          return;
        }
        throw error;
      }
      stagedEntries += captured.entries;
      stagedBytes += captured.totalBytes;
      if (captured.hash !== input.bundleHash) {
        throw new Error("frozen Skill bundle changed before staging");
      }
      const directory = join(stageRoot, `skill-${String(index).padStart(4, "0")}`);
      mkdirSync(directory, { recursive: false, mode: 0o700 });
      for (const file of captured.files) {
        if (signal?.aborted) {
          throw signal.reason ?? new Error("provider Skill staging cancelled");
        }
        const path = join(directory, ...file.path.split("/"));
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        writeFileSync(path, file.content, { flag: "wx", mode: file.mode });
        chmodSync(path, file.mode);
      }
      if (signal?.aborted) {
        throw signal.reason ?? new Error("provider Skill staging cancelled");
      }
      const skillFile = join(directory, "SKILL.md");
      if (hashProviderSkillBundle(skillFile) !== input.bundleHash) {
        throw new Error("staged Skill bundle failed verification");
      }
      staged.push({
        name: input.name,
        directory: realpathSync(directory),
        skillFile: realpathSync(skillFile),
        bundleHash: input.bundleHash,
      });
    });
    if (overBudget.length > 0) {
      log.warn("Codex Skill staging exceeded the per-invocation budget", {
        droppedCount: overBudget.length,
        stagedCount: staged.length,
      });
    }
    return { inputs: staged, cleanup };
  } catch (error) {
    cleanup();
    if (signal?.aborted) throw signal.reason ?? error;
    throw new Error("provider Skill input changed after frozen validation");
  }
}

function comparablePath(path: string): string {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

function samePath(left: string, right: string): boolean {
  return comparablePath(left) === comparablePath(right);
}

function pathIsWithinOrEqual(path: string, root: string): boolean {
  const fromRoot = relative(root, path);
  return fromRoot === ""
    || (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot));
}

function canonicalProtectedDataRoot(protectedDataRoot?: string): string {
  try {
    const configuredDataRoot = protectedDataRoot ?? config().dataDir;
    const metadata = lstatSync(configuredDataRoot);
    const canonical = realpathSync(configuredDataRoot);
    if (
      metadata.isSymbolicLink()
      || !metadata.isDirectory()
      || !samePath(canonical, configuredDataRoot)
    ) {
      throw new Error("changed");
    }
    return canonical;
  } catch {
    throw new Error("provider codex native session isolation is unavailable");
  }
}

function normalizeProviderSkillInputs(inputs: readonly unknown[] | undefined): ProviderSkillInput[] {
  if (!inputs) return [];
  if (inputs.length > MAX_PROVIDER_SKILL_INPUTS) {
    throw new Error("provider Skill inputs exceed the supported limit");
  }
  return inputs.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("provider Skill input is invalid");
    }
    const candidate = value as Partial<ProviderSkillInput>;
    const name = normalizeProviderSkills([candidate.name])[0];
    if (
      !name
      || name !== candidate.name
      || typeof candidate.directory !== "string"
      || typeof candidate.skillFile !== "string"
      || typeof candidate.bundleHash !== "string"
      || !/^[a-f0-9]{64}$/u.test(candidate.bundleHash)
    ) {
      throw new Error("provider Skill input is invalid");
    }
    let directory: string;
    let skillFile: string;
    try {
      directory = realpathSync(candidate.directory);
      skillFile = realpathSync(candidate.skillFile);
      const directoryMetadata = lstatSync(candidate.directory);
      const fileMetadata = lstatSync(candidate.skillFile);
      if (
        directoryMetadata.isSymbolicLink()
        || !directoryMetadata.isDirectory()
        || fileMetadata.isSymbolicLink()
        || !fileMetadata.isFile()
        || !samePath(dirname(skillFile), directory)
        || basename(skillFile) !== "SKILL.md"
      ) {
        throw new Error("invalid");
      }
    } catch {
      throw new Error("provider Skill input is unavailable");
    }
    return { name, directory, skillFile, bundleHash: candidate.bundleHash };
  });
}

function codexUntrustedProjectOverride(workdir: string | undefined): string {
  const absoluteWorkdir = resolve(workdir ?? process.cwd());
  // Codex's `-c` parser splits dotted paths before TOML key decoding. Supplying
  // the complete inline table keeps dots in Windows/user/repository paths inside
  // the quoted key instead of accidentally creating nested config keys.
  return `projects={${JSON.stringify(absoluteWorkdir)}={trust_level="untrusted"}}`;
}

const CODEX_NATIVE_PERMISSION_PROFILE = "homeagent_topic";

function usesCodexNativeIsolation(input: Pick<
  RunInput,
  "nativeSession" | "nativeSessionIsolation"
>): boolean {
  return input.nativeSession !== undefined || input.nativeSessionIsolation === true;
}

function codexSkillIsolationOverrides(): string[] {
  return [
    // Do not search parent repositories for `.codex` configuration or Skills.
    "-c",
    "project_root_markers=[]",
    // Codex Skill discovery is broader than HomeAgent's frozen catalog. Keep
    // it entirely out of the prompt and supply exact bundle paths ourselves.
    "-c",
    "skills={include_instructions=false,bundled={enabled=false},config=[]}",
  ];
}

function codexNativeIsolationOverrides(
  execution: ProviderExecution | undefined,
  workdir: string | undefined,
  skillInputs: readonly ProviderSkillInput[],
  probeReadRoot?: string,
  protectedDataRoot?: string,
): string[] {
  if (!execution || execution.permission === "full") {
    throw new Error("provider codex native session isolation is unavailable");
  }
  const configuredWorkdir = execution.workdir ?? workdir;
  if (!configuredWorkdir) {
    throw new Error("provider codex native session isolation is unavailable");
  }
  if (
    execution.workdir
    && workdir
    && !samePath(execution.workdir, workdir)
  ) {
    throw new Error("provider codex native session isolation is unavailable");
  }
  let frozenWorkdir: string;
  try {
    if (!isAbsolute(configuredWorkdir)) throw new Error("relative");
    const metadata = lstatSync(configuredWorkdir);
    frozenWorkdir = realpathSync(configuredWorkdir);
    if (
      metadata.isSymbolicLink()
      || !metadata.isDirectory()
      || !samePath(frozenWorkdir, configuredWorkdir)
    ) {
      throw new Error("changed");
    }
  } catch {
    throw new Error("provider codex native session isolation is unavailable");
  }
  const codexHome = providerCodexHome();
  const dataRoot = canonicalProtectedDataRoot(protectedDataRoot);
  if (pathIsWithinOrEqual(frozenWorkdir, codexHome)) {
    throw new Error("provider codex native session isolation is unavailable");
  }
  if (
    pathIsWithinOrEqual(frozenWorkdir, dataRoot)
    || pathIsWithinOrEqual(dataRoot, frozenWorkdir)
  ) {
    throw new Error("provider codex native session isolation is unavailable");
  }
  const filesystem = new Map<string, "read" | "write" | "deny">([
    [":root", "deny"],
    [":minimal", "read"],
    [codexHome, "deny"],
    [frozenWorkdir, execution.permission === "write" ? "write" : "read"],
  ]);
  for (const skill of skillInputs) {
    if (samePath(skill.directory, codexHome)) {
      throw new Error("provider codex native session isolation is unavailable");
    }
    if (pathIsWithinOrEqual(dataRoot, skill.directory)) {
      // A Skill allow-entry must never cover HomeAgent's protected data root.
      throw new Error("provider codex native session isolation is unavailable");
    }
    if (
      pathIsWithinOrEqual(skill.directory, frozenWorkdir)
      || pathIsWithinOrEqual(frozenWorkdir, skill.directory)
    ) {
      // Even a read-only Workdir would expose the mutable live Skill bundle
      // beside its frozen staged copy, so every native turn rejects overlap.
      throw new Error("provider codex native session isolation is unavailable");
    }
    filesystem.set(skill.directory, "read");
  }
  if (probeReadRoot) {
    let canonicalProbeRoot: string;
    try {
      const metadata = lstatSync(probeReadRoot);
      canonicalProbeRoot = realpathSync(probeReadRoot);
      if (
        metadata.isSymbolicLink()
        || !metadata.isDirectory()
        || !samePath(canonicalProbeRoot, probeReadRoot)
        || pathIsWithinOrEqual(canonicalProbeRoot, codexHome)
        || pathIsWithinOrEqual(canonicalProbeRoot, frozenWorkdir)
        || pathIsWithinOrEqual(frozenWorkdir, canonicalProbeRoot)
        || pathIsWithinOrEqual(canonicalProbeRoot, dataRoot)
        || pathIsWithinOrEqual(dataRoot, canonicalProbeRoot)
      ) {
        throw new Error("invalid");
      }
    } catch {
      throw new Error("provider codex native session isolation is unavailable");
    }
    filesystem.set(canonicalProbeRoot, "read");
  }
  const filesystemToml = [...filesystem]
    .map(([path, access]) => `${JSON.stringify(path)}="${access}"`)
    .join(",");
  const permissionOverride =
    `permissions={${CODEX_NATIVE_PERMISSION_PROFILE}={filesystem={${filesystemToml}},network={enabled=false}}}`;
  if (permissionOverride.length > MAX_CODEX_NATIVE_PERMISSION_CONFIG_CHARS) {
    throw new Error("provider codex native session isolation is unavailable");
  }
  return [
    "-c",
    `default_permissions="${CODEX_NATIVE_PERMISSION_PROFILE}"`,
    "-c",
    permissionOverride,
  ];
}

const PROVIDER_ENVIRONMENT_KEYS = process.platform === "win32"
  ? [
      "PATH",
      "PATHEXT",
      "COMSPEC",
      "SYSTEMROOT",
      "WINDIR",
      "SYSTEMDRIVE",
      "USERNAME",
      "USERDOMAIN",
      "USERPROFILE",
      "HOMEDRIVE",
      "HOMEPATH",
      "HOME",
      "PROGRAMFILES",
      "PROGRAMFILES(X86)",
      "PROGRAMW6432",
      "PROGRAMDATA",
      "LOCALAPPDATA",
      "APPDATA",
      "TEMP",
      "TMP",
      "TMPDIR",
      "POWERSHELL",
      "PWSH",
      "SSL_CERT_FILE",
      "SSL_CERT_DIR",
    ]
  : [
      "PATH",
      "HOME",
      "SHELL",
      "USER",
      "LOGNAME",
      "TMPDIR",
      "TEMP",
      "TMP",
      "LANG",
      "LC_ALL",
      "LC_CTYPE",
      "XDG_RUNTIME_DIR",
      "DBUS_SESSION_BUS_ADDRESS",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_CACHE_HOME",
      "XDG_STATE_HOME",
      "SSL_CERT_FILE",
      "SSL_CERT_DIR",
    ];

const CODEX_TOOL_ENVIRONMENT_KEYS = process.platform === "win32"
  ? [
      "PATH",
      "PATHEXT",
      "COMSPEC",
      "SYSTEMROOT",
      "WINDIR",
      "SYSTEMDRIVE",
      "USERNAME",
      "USERDOMAIN",
      "USERPROFILE",
      "HOMEDRIVE",
      "HOMEPATH",
      "HOME",
      "PROGRAMFILES",
      "PROGRAMFILES(X86)",
      "PROGRAMW6432",
      "PROGRAMDATA",
      "LOCALAPPDATA",
      "APPDATA",
      "TEMP",
      "TMP",
      "TMPDIR",
    ]
  : [
      "PATH",
      "HOME",
      "SHELL",
      "USER",
      "LOGNAME",
      "TMPDIR",
      "TEMP",
      "TMP",
      "LANG",
      "LC_ALL",
      "LC_CTYPE",
    ];

/**
 * Provider CLIs need their normal user/profile directories for managed OAuth,
 * but must not inherit HomeAgent/Codex Desktop context or ambient API secrets.
 */
export function providerChildEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const normalized = new Map<string, string>();
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) normalized.set(key.toUpperCase(), value);
  }
  const environment: Record<string, string> = { NO_COLOR: "1" };
  for (const key of PROVIDER_ENVIRONMENT_KEYS) {
    const value = normalized.get(key);
    if (value !== undefined) environment[key] = value;
  }
  // Never reuse an ambient Codex Desktop/terminal home. A dedicated persistent
  // home keeps HomeAgent's OAuth account metadata and native rollouts separate;
  // the setup flow, probes, and real calls all pass through this same function.
  environment.CODEX_HOME = providerCodexHome(source);
  const configuredClaudeHome = brandedEnv(source, "CLAUDE_CONFIG_DIR")?.trim();
  if (configuredClaudeHome) environment.CLAUDE_CONFIG_DIR = resolve(configuredClaudeHome);
  return environment;
}

/** Resolve the single Codex state root shared by discovery, setup, probes, and runs. */
export function providerCodexHome(source: NodeJS.ProcessEnv = process.env): string {
  const configuredCodexHome = brandedEnv(source, "CODEX_HOME")?.trim();
  const configuredDataDir = brandedEnv(source, "DATA_DIR")?.trim();
  return resolve(
    configuredCodexHome
      || join(
        configuredDataDir ? resolve(configuredDataDir) : config().dataDir,
        "provider-state",
        "codex",
      ),
  );
}

/**
 * Create the dedicated Codex state root without traversing a symlink/junction.
 * Codex refuses to start when CODEX_HOME is absent, so setup must establish this
 * directory before launching device authentication.
 */
export function ensureProviderCodexHome(source: NodeJS.ProcessEnv = process.env): string {
  const target = providerCodexHome(source);
  const missing: string[] = [];
  let cursor = target;

  try {
    while (true) {
      try {
        const metadata = lstatSync(cursor);
        const canonical = realpathSync(cursor);
        if (
          metadata.isSymbolicLink()
          || !metadata.isDirectory()
          || !samePath(canonical, cursor)
        ) {
          throw new Error("invalid Provider state directory");
        }
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const parent = dirname(cursor);
        if (samePath(parent, cursor)) throw error;
        missing.push(cursor);
        cursor = parent;
      }
    }

    for (const directory of missing.reverse()) {
      const parentMetadata = lstatSync(cursor);
      const canonicalParent = realpathSync(cursor);
      if (
        parentMetadata.isSymbolicLink()
        || !parentMetadata.isDirectory()
        || !samePath(canonicalParent, cursor)
        || !samePath(dirname(directory), cursor)
      ) {
        throw new Error("invalid Provider state parent");
      }
      mkdirSync(directory, { recursive: false, mode: 0o700 });
      const createdMetadata = lstatSync(directory);
      const canonicalCreated = realpathSync(directory);
      if (
        createdMetadata.isSymbolicLink()
        || !createdMetadata.isDirectory()
        || !samePath(canonicalCreated, directory)
      ) {
        throw new Error("invalid Provider state directory");
      }
      cursor = directory;
    }

    chmodSync(target, 0o700);
    const finalMetadata = lstatSync(target);
    const canonicalTarget = realpathSync(target);
    if (
      finalMetadata.isSymbolicLink()
      || !finalMetadata.isDirectory()
      || !samePath(canonicalTarget, target)
    ) {
      throw new Error("invalid Provider state directory");
    }
    return canonicalTarget;
  } catch {
    throw new Error("provider codex state directory is unavailable");
  }
}

const MAX_CODEX_AUTH_CACHE_BYTES = 1024 * 1024;

/**
 * Seed the isolated Provider home with the authenticated console CLI identity.
 * Only auth.json crosses the boundary: ambient config, rules, plugins, Skills,
 * rollouts, and sessions remain outside HomeAgent's execution environment.
 */
export function prepareProviderCodexHome(
  source: NodeJS.ProcessEnv = process.env,
  userHome = homedir(),
): string {
  const targetHome = ensureProviderCodexHome(source);
  const targetAuth = join(targetHome, "auth.json");
  const ambientHome = resolve(source.CODEX_HOME?.trim() || join(userHome, ".codex"));
  const ambientAuth = join(ambientHome, "auth.json");
  if (samePath(ambientAuth, targetAuth)) return targetHome;

  if (existsSync(targetAuth)) {
    try {
      const metadata = lstatSync(targetAuth);
      if (
        metadata.isSymbolicLink()
        || !metadata.isFile()
        || !samePath(realpathSync(targetAuth), targetAuth)
      ) {
        throw new Error("invalid Provider authentication cache");
      }
      chmodSync(targetAuth, 0o600);
    } catch {
      throw new Error("provider codex authentication cache is unavailable");
    }
    // A console re-login rotates the ambient tokens and revokes the previous
    // refresh token, which would otherwise leave this cache authenticating as a
    // revoked identity indefinitely. Adopt the ambient credential only when it
    // is strictly newer, so a cache this side refreshed is never rolled back.
    try {
      if (codexAuthRefreshedAt(ambientAuth) > codexAuthRefreshedAt(targetAuth)) {
        importCodexAuthCache(targetHome, targetAuth, ambientAuth, true);
      }
    } catch {
      // A stale cache still authenticates until its access token expires;
      // refresh failures must not break an otherwise usable provider home.
    }
    return targetHome;
  }

  importCodexAuthCache(targetHome, targetAuth, ambientAuth, false);
  return targetHome;
}

/**
 * Read the credential rotation timestamp used to order two caches. Returns 0
 * when the file is missing, unreadable, or lacks a usable `last_refresh`, so an
 * unparseable ambient file can never appear newer than a working cache.
 */
function codexAuthRefreshedAt(path: string): number {
  try {
    const metadata = lstatSync(path);
    if (
      metadata.isSymbolicLink()
      || !metadata.isFile()
      || metadata.size <= 0
      || metadata.size > MAX_CODEX_AUTH_CACHE_BYTES
    ) {
      return 0;
    }
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { last_refresh?: unknown };
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return 0;
    const stamp = Date.parse(String(parsed.last_refresh ?? ""));
    return Number.isFinite(stamp) ? stamp : 0;
  } catch {
    return 0;
  }
}

/**
 * Copy the ambient credential into the isolated home via a same-directory
 * temporary file, fsync, and atomic rename/link. Only auth.json crosses the
 * boundary, and provenance is revalidated immediately before the copy.
 */
function importCodexAuthCache(
  targetHome: string,
  targetAuth: string,
  ambientAuth: string,
  replaceExisting: boolean,
): void {
  let contents: Buffer;
  try {
    const metadata = lstatSync(ambientAuth);
    if (
      metadata.isSymbolicLink()
      || !metadata.isFile()
      || metadata.size <= 0
      || metadata.size > MAX_CODEX_AUTH_CACHE_BYTES
      || !samePath(realpathSync(ambientAuth), ambientAuth)
    ) {
      return;
    }
    contents = readFileSync(ambientAuth);
    const parsed = JSON.parse(contents.toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
  } catch {
    return;
  }

  const temporaryAuth = join(
    targetHome,
    `.auth.json.${process.pid}.${randomUUID()}.tmp`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporaryAuth, "wx", 0o600);
    writeFileSync(descriptor, contents);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    if (replaceExisting) {
      // Rename replaces the stale cache atomically; readers observe either the
      // previous or the refreshed credential, never a partial file.
      renameSync(temporaryAuth, targetAuth);
    } else {
      // Creating the final hard link is atomic and refuses to replace a cache
      // established concurrently by an explicit HomeAgent login.
      linkSync(temporaryAuth, targetAuth);
    }
    chmodSync(targetAuth, 0o600);
  } catch {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Best-effort cleanup preserves the original import failure.
      }
    }
  } finally {
    try {
      unlinkSync(temporaryAuth);
    } catch {
      // The temporary file may not have been created or may already be gone.
    }
  }
}

const CODEX_DISABLED_AMBIENT_FEATURES = [
  "hooks",
  "apps",
  "goals",
  "multi_agent",
  "plugins",
  "remote_plugin",
  "memories",
] as const;

const CODEX_NATIVE_DISABLED_AMBIENT_FEATURES = [
  "browser_use",
  "browser_use_external",
  "computer_use",
  "image_generation",
  "in_app_browser",
  "skill_mcp_dependency_install",
  "skill_search",
  "tool_suggest",
  "view_image",
  "workspace_dependencies",
] as const;

export interface DetectedProvider {
  id: ProviderId;
  name: string;
  bin: string;
  available: boolean;
  /** Whether this installed CLI can safely continue Provider-owned conversations. */
  nativeSessions?: boolean;
  /** Safe, bounded reason native conversations are unavailable when recovery is known. */
  nativeSessionIssue?: "windows-elevated-sandbox-required";
  /** version string when available; else a short reason it is not */
  detail: string;
}

/**
 * The fixed set of known local agent CLIs (per product decision). Invocation
 * modes are verified against the installed CLIs:
 *   - claude   : `claude -p "<prompt>" [--model m] [--append-system-prompt s]`
 *   - trae-cli : `trae-cli exec "<prompt>" [-m model]`
 *   - codex    : `codex exec "<prompt>" [-m model]` (Codex CLI non-interactive)
 */
const KNOWN: CliSpec[] = [
  {
    id: "claude",
    name: "Claude Code",
    bin: "claude",
    envBin: "CLAUDE_BIN",
    versionArgs: ["--version"],
    models: ["sonnet", "opus", "haiku", "claude-sonnet-4-6", "claude-opus-4-8"],
    buildRun: ({ system, model, execution }) => {
      // Safe mode preserves OAuth/keychain authentication while disabling
      // ambient CLAUDE.md, hooks, plugins, MCP servers and custom commands.
      // Explicitly pinned native Skills need Claude's Skill discovery, so those
      // authorized task calls rely on the frozen tool grant plus strict MCP.
      // Claude native sessions are rejected before this builder: its current
      // CLI cannot combine OAuth/keychain auth, frozen Skills and safe mode.
      const args = ["-p"];
      if (!execution || execution.webSearch || execution.skills.length === 0) {
        args.push("--safe-mode");
      }
      args.push("--no-session-persistence");
      args.push(
        "--strict-mcp-config",
        "--output-format",
        "json",
      );
      if (!execution) {
        // --allowedTools only changes approval; --tools "" actually removes
        // every built-in tool from the ordinary completion process.
        args.push("--tools", "");
      } else if (execution.permission === "read-only") {
        const tools = execution.research
          ? "Read,Glob,Grep,Bash,WebSearch,WebFetch"
          : execution.webSearch
            ? "WebSearch,WebFetch"
            : "Read,Glob,Grep";
        args.push(
          "--tools",
          tools,
          "--permission-mode",
          "dontAsk",
        );
      } else if (execution.permission === "write") {
        const tools = execution.research
          ? "Read,Glob,Grep,Edit,Write,NotebookEdit,Bash,WebSearch,WebFetch"
          : execution.webSearch
            ? "Read,Glob,Grep,Edit,Write,NotebookEdit,WebSearch,WebFetch"
            : "Read,Glob,Grep,Edit,Write,NotebookEdit";
        args.push(
          "--tools",
          tools,
          "--permission-mode",
          "acceptEdits",
        );
      } else {
        args.push("--tools", "default", "--dangerously-skip-permissions");
      }
      if (model) args.push("--model", model);
      if (system) args.push("--append-system-prompt", system);
      return args;
    },
  },
  {
    id: "codex",
    name: "Codex",
    bin: "codex",
    envBin: "CODEX_BIN",
    versionArgs: ["--version"],
    // Curated from OpenAI's current model catalog (CLIs expose no list command).
    models: [
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.3-codex-spark",
    ],
    buildRun: ({
      model,
      reasoningEffort,
      images,
      execution,
      skillInputs,
      workdir,
      protectedDataRoot,
      nativeSession,
      nativeSessionIsolation,
      nativeIsolationReadRoot,
      codexCredentialStore,
      outputSchemaPath,
      outputLastMessagePath,
    }) => {
      // Runtime overrides plus the exec isolation flags keep ambient
      // configuration out of the call. Only an explicit Codex topic
      // conversation request may persist Provider state.
      const args: string[] = [
        "-c",
        'approval_policy="never"',
        // Headless Codex rebuilds its approval policy when an ambient
        // auto-reviewer is active, which can silently widen an explicit
        // sandbox. Pin human review so `never` remains fail-closed.
        "-c",
        'approvals_reviewer="user"',
        // Use either the isolated file copy or the verified Codex OS keyring.
        // Ambient configuration and other CODEX_HOME state remain isolated.
        "-c",
        `cli_auth_credentials_store="${codexCredentialStore ?? "file"}"`,
        // Keep subprocesses launched by Codex on a small, explicit environment.
        // `include_only` is applied after managed config `set` values and thus
        // also prevents a broader machine policy from injecting secret env vars.
        "-c",
        'shell_environment_policy.inherit="core"',
        "-c",
        "shell_environment_policy.ignore_default_excludes=false",
        "-c",
        `shell_environment_policy.include_only=${JSON.stringify(CODEX_TOOL_ENVIRONMENT_KEYS)}`,
        "-c",
        "shell_environment_policy.experimental_use_profile=false",
        "-c",
        "allow_login_shell=false",
        // User config is ignored below. Explicitly mark the exact execution
        // root untrusted as well, so broader System/Enterprise trust entries
        // cannot activate repository-owned `.codex/config.toml` layers.
        "-c",
        codexUntrustedProjectOverride(execution?.workdir ?? workdir),
        // `--ignore-user-config` does not suppress repository AGENTS.md files.
        // Runtime overrides have highest precedence over project configuration.
        "-c",
        "project_doc_max_bytes=0",
        "-c",
        "project_doc_fallback_filenames=[]",
        "-c",
        'developer_instructions=""',
        "-c",
        'web_search="disabled"',
      ];
      args.push(...codexSkillIsolationOverrides());
      const nativeIsolation = usesCodexNativeIsolation({
        nativeSession,
        nativeSessionIsolation,
      });
      if (nativeIsolation) {
        args.push(...codexNativeIsolationOverrides(
          execution,
          workdir,
          skillInputs ?? [],
          nativeIsolationReadRoot,
          protectedDataRoot,
        ));
      }
      for (const feature of CODEX_DISABLED_AMBIENT_FEATURES) {
        args.push("--disable", feature);
      }
      for (const feature of CODEX_NATIVE_DISABLED_AMBIENT_FEATURES) {
        args.push("--disable", feature);
      }
      if (reasoningEffort) args.push("-c", `model_reasoning_effort="${reasoningEffort}"`);
      if (execution?.webSearch || execution?.research) args.push("--search");
      const sandbox = sandboxForPermission(execution?.permission);
      // Codex 0.147+ scopes these isolation flags to the `exec` subcommand.
      // Keeping them before `exec` makes the CLI exit during argument parsing.
      args.push("exec");
      if (!nativeSession) args.push("--ephemeral");
      args.push(
        "--strict-config",
        "--ignore-user-config",
        "--ignore-rules",
        "--json",
      );
      // Legacy --sandbox takes precedence over permission profiles. Native
      // topic turns must use the exact root-deny profile built above.
      if (!nativeIsolation) args.push("--sandbox", sandbox);
      args.push("--skip-git-repo-check");
      if (outputSchemaPath) args.push("--output-schema", outputSchemaPath);
      if (outputLastMessagePath) args.push("-o", outputLastMessagePath);
      if (model) args.push("-m", model);
      for (const image of images ?? []) args.push("--image", image.path);
      // Codex's --image accepts multiple values. Terminate option parsing
      // explicitly, then use `-` so multiline prompts travel over stdin rather
      // than through Windows' lossy npm .cmd argument forwarding.
      if (nativeSession?.mode === "fork") args.push("fork", nativeSession.id, "-");
      else args.push("--", "-");
      return args;
    },
  },
  {
    id: "trae-cli",
    name: "TRAE CLI",
    bin: "trae-cli",
    envBin: "TRAE_BIN",
    versionArgs: ["--version"],
    models: ["openrouter-3o", "openrouter-sonnet", "openrouter-gpt-5"],
    buildRun: ({ prompt, model, execution }) => {
      // Chat/Task execution maps the Agent's permission tier to TRAE's sandbox.
      const sandbox = sandboxForPermission(execution?.permission);
      const args = ["exec", "--sandbox", sandbox, prompt];
      if (model) args.push("-m", model);
      return args;
    },
  },
];

/** Curated model ids for the built-in network gateway (Anthropic). */
export const GATEWAY_MODELS = ["claude-sonnet-5", "claude-haiku-4-5-20251001", "claude-opus-4-8"];

const specById = new Map<ProviderId, CliSpec>(KNOWN.map((s) => [s.id, s]));

/** Every Claude flag required by ordinary isolated execution. */
const CLAUDE_ORDINARY_REQUIRED_FLAGS = [
  "-p",
  "--safe-mode",
  "--no-session-persistence",
  "--strict-mcp-config",
  "--output-format",
  "--tools",
  "--model",
  "--append-system-prompt",
] as const;
const MAX_CLAUDE_AUTH_STATUS_BYTES = 16 * 1024;
const CLAUDE_AUTH_UNAVAILABLE_DETAIL = "Claude 认证不可用";
const CODEX_AUTH_UNAVAILABLE_DETAIL = "HomeAgent 尚未连接当前 Codex 账号";
const CODEX_NATIVE_SESSION_UNAVAILABLE_DETAIL = "Codex 原生会话能力不可用";
const CODEX_NATIVE_SESSION_PREFLIGHT_ERROR =
  "provider codex native session isolation is unavailable";
const CODEX_WINDOWS_ELEVATED_SANDBOX_REQUIRED =
  "Restricted read-only access requires the elevated Windows sandbox backend";
const MIN_CODEX_NATIVE_SESSION_VERSION = [0, 152, 1] as const;
const MAX_CODEX_MCP_LIST_BYTES = 64 * 1024;
const MAX_CODEX_MCP_PROBE_STDERR_BYTES = 4 * 1024;
const CODEX_WINDOWS_ARG0_WARNING_PATTERNS = [
  /^WARNING: failed to clean up stale arg0 temp dirs: [^\r\n]*\(os error 5\)$/u,
  /^WARNING: proceeding, even though we could not create PATH aliases: [^\r\n]*\(os error 5\) at path "[^"\r\n]+"$/u,
] as const;
const CODEX_LOGIN_STATUS_ARGS = [
  "-c",
  'cli_auth_credentials_store="file"',
  "login",
  "status",
] as const;
const CODEX_KEYRING_LOGIN_STATUS_ARGS = [
  "-c",
  'cli_auth_credentials_store="keyring"',
  "login",
  "status",
] as const;
const codexCredentialStoreByBin = new Map<string, "file" | "keyring">();

function codexCredentialStoreKey(bin: string): string {
  return `${bin}\u0000${providerCodexHome()}`;
}

function codexMcpProbeStderrIsSafe(stderr: string): boolean {
  if (stderr.trim().length === 0) return true;
  if (Buffer.byteLength(stderr, "utf8") > MAX_CODEX_MCP_PROBE_STDERR_BYTES) return false;
  const lines = stderr.trim().split(/\r?\n/u);
  return lines.length <= CODEX_WINDOWS_ARG0_WARNING_PATTERNS.length
    && lines.every((line) => CODEX_WINDOWS_ARG0_WARNING_PATTERNS.some((pattern) => pattern.test(line)));
}

function stageCodexIsolationSentinel(): {
  path: string;
  cleanup: () => void;
} {
  const codexHome = ensureProviderCodexHome();
  const directory = mkdtempSync(join(codexHome, ".homeagent-isolation-probe-"));
  const path = join(directory, "sentinel");
  try {
    writeFileSync(path, "homeagent isolation probe\n", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    try {
      rmdirSync(directory);
    } catch {
      // Preserve the staging failure if best-effort cleanup also fails.
    }
    throw error;
  }
  return {
    path,
    cleanup: () => {
      let failed = false;
      try {
        unlinkSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") failed = true;
      }
      try {
        rmdirSync(directory);
      } catch {
        failed = true;
      }
      if (failed) log.warn("Codex isolation probe cleanup failed");
    },
  };
}

function stageCodexRootDenySentinel(protectedDataRoot?: string): {
  path: string;
  cleanup: () => void;
} {
  const dataRoot = canonicalProtectedDataRoot(protectedDataRoot);
  const codexHome = providerCodexHome();
  // This sentinel must be denied solely by `:root=deny`; placing it beneath
  // the explicit CODEX_HOME deny would not prove the root rule is enforced.
  if (pathIsWithinOrEqual(dataRoot, codexHome)) {
    throw new Error(CODEX_NATIVE_SESSION_PREFLIGHT_ERROR);
  }
  const runRoot = join(dataRoot, "run");
  mkdirSync(runRoot, { recursive: true, mode: 0o700 });
  const runMetadata = lstatSync(runRoot);
  const canonicalRunRoot = realpathSync(runRoot);
  if (
    runMetadata.isSymbolicLink()
    || !runMetadata.isDirectory()
    || !samePath(runRoot, canonicalRunRoot)
    || pathIsWithinOrEqual(canonicalRunRoot, codexHome)
  ) {
    throw new Error(CODEX_NATIVE_SESSION_PREFLIGHT_ERROR);
  }
  const directory = mkdtempSync(join(canonicalRunRoot, "codex-root-deny-probe-"));
  const canonicalDirectory = realpathSync(directory);
  if (!samePath(directory, canonicalDirectory)) {
    try {
      rmdirSync(directory);
    } catch {
      // Preserve the fixed staging failure.
    }
    throw new Error(CODEX_NATIVE_SESSION_PREFLIGHT_ERROR);
  }
  const path = join(canonicalDirectory, "sentinel");
  try {
    writeFileSync(path, "homeagent root deny probe\n", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    try {
      rmdirSync(canonicalDirectory);
    } catch {
      // Preserve the staging failure.
    }
    throw error;
  }
  return {
    path,
    cleanup: () => {
      let failed = false;
      try {
        unlinkSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") failed = true;
      }
      try {
        rmdirSync(canonicalDirectory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") failed = true;
      }
      if (failed) log.warn("Codex root isolation probe cleanup failed");
    },
  };
}

function stageCodexNativeTemporaryDirectory(prefix: string): string {
  const parent = realpathSync(tmpdir());
  const created = mkdtempSync(join(parent, prefix));
  const metadata = lstatSync(created);
  const canonical = realpathSync(created);
  if (
    metadata.isSymbolicLink()
    || !metadata.isDirectory()
    || !samePath(created, canonical)
  ) {
    try {
      rmdirSync(created);
    } catch {
      // The fixed isolation failure below is the public contract.
    }
    throw new Error(CODEX_NATIVE_SESSION_PREFLIGHT_ERROR);
  }
  return canonical;
}

interface CodexNativeIsolationContext {
  workdir: string;
  probeReadRoot: string;
  allowedSentinel: string;
  removeAllowedSentinel: () => void;
  cleanup: () => void;
}

function stageCodexNativeIsolationContext(
  execution: ProviderExecution | undefined,
  workdir?: string,
  protectedDataRoot?: string,
): CodexNativeIsolationContext {
  if (!execution || execution.permission === "full") {
    throw new Error(CODEX_NATIVE_SESSION_PREFLIGHT_ERROR);
  }
  if (execution.workdir && workdir && !samePath(execution.workdir, workdir)) {
    throw new Error(CODEX_NATIVE_SESSION_PREFLIGHT_ERROR);
  }

  let ownedWorkdir: string | undefined;
  let effectiveWorkdir = execution.workdir ?? workdir;
  if (!effectiveWorkdir) {
    if (execution.permission !== "read-only") {
      throw new Error(CODEX_NATIVE_SESSION_PREFLIGHT_ERROR);
    }
    ownedWorkdir = stageCodexNativeTemporaryDirectory("homeagent-codex-workdir-");
    effectiveWorkdir = ownedWorkdir;
  }

  const probeReadRoot = stageCodexNativeTemporaryDirectory("homeagent-codex-read-probe-");
  const allowedSentinel = join(probeReadRoot, "sentinel");
  let allowedSentinelPresent = false;
  let cleaned = false;
  try {
    // This is deliberately harmless. The probe must prove both that the
    // allowlist works and that the sibling CODEX_HOME sentinel is denied.
    writeFileSync(allowedSentinel, "homeagent allowed read probe\n", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    allowedSentinelPresent = true;
    const effectiveExecution = { ...execution, workdir: effectiveWorkdir };
    codexNativeIsolationOverrides(
      effectiveExecution,
      effectiveWorkdir,
      [],
      probeReadRoot,
      protectedDataRoot,
    );
  } catch (error) {
    if (allowedSentinelPresent) {
      try {
        unlinkSync(allowedSentinel);
      } catch {
        // Preserve the staging failure.
      }
    }
    try {
      rmdirSync(probeReadRoot);
    } catch {
      // Preserve the staging failure.
    }
    if (ownedWorkdir) {
      try {
        rmdirSync(ownedWorkdir);
      } catch {
        // Preserve the staging failure.
      }
    }
    throw error;
  }

  const removeAllowedSentinel = () => {
    if (!allowedSentinelPresent) return;
    unlinkSync(allowedSentinel);
    allowedSentinelPresent = false;
  };
  return {
    workdir: effectiveWorkdir,
    probeReadRoot,
    allowedSentinel,
    removeAllowedSentinel,
    cleanup: () => {
      if (cleaned) return;
      cleaned = true;
      let failed = false;
      if (allowedSentinelPresent) {
        try {
          unlinkSync(allowedSentinel);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") failed = true;
        }
        allowedSentinelPresent = false;
      }
      try {
        rmdirSync(probeReadRoot);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") failed = true;
      }
      if (ownedWorkdir) {
        try {
          rmdirSync(ownedWorkdir);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") failed = true;
        }
      }
      if (failed) log.warn("Codex native isolation directory cleanup failed");
    },
  };
}

function codexSentinelReadCommand(
  deniedCodexHomePath: string,
  deniedRootPath: string,
  allowedPath: string,
): string[] {
  if (process.platform === "win32") {
    const quotedCodexHomePath = deniedCodexHomePath.replace(/'/gu, "''");
    const quotedRootPath = deniedRootPath.replace(/'/gu, "''");
    const quotedAllowedPath = allowedPath.replace(/'/gu, "''");
    const script = [
      "try {",
      `  [void][System.IO.File]::ReadAllBytes('${quotedCodexHomePath}')`,
      "  exit 73",
      "} catch {}",
      "try {",
      `  [void][System.IO.File]::ReadAllBytes('${quotedRootPath}')`,
      "  exit 75",
      "} catch {}",
      "try {",
      `  [void][System.IO.File]::ReadAllBytes('${quotedAllowedPath}')`,
      "  exit 0",
      "} catch { exit 74 }",
    ].join("\r\n");
    return [
      "powershell.exe",
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ];
  }
  return [
    "/bin/sh",
    "-c",
    'if IFS= read -r _ < "$1"; then exit 73; fi; if IFS= read -r _ < "$2"; then exit 75; fi; if IFS= read -r _ < "$3"; then exit 0; else exit 74; fi',
    "homeagent-isolation-probe",
    deniedCodexHomePath,
    deniedRootPath,
    allowedPath,
  ];
}

interface CodexNativeSessionCapability {
  available: boolean;
  issue?: DetectedProvider["nativeSessionIssue"];
}

async function codexNativeFilesystemIsolationCapability(
  bin: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  context: CodexNativeIsolationContext,
  execution: ProviderExecution,
  skillInputs: readonly ProviderSkillInput[],
  protectedDataRoot?: string,
): Promise<CodexNativeSessionCapability> {
  let codexHomeSentinel: ReturnType<typeof stageCodexIsolationSentinel> | undefined;
  let rootSentinel: ReturnType<typeof stageCodexRootDenySentinel> | undefined;
  try {
    const effectiveExecution = { ...execution, workdir: context.workdir };
    const overrides = codexNativeIsolationOverrides(
      effectiveExecution,
      context.workdir,
      skillInputs,
      context.probeReadRoot,
      protectedDataRoot,
    );
    codexHomeSentinel = stageCodexIsolationSentinel();
    rootSentinel = stageCodexRootDenySentinel(protectedDataRoot);
    if (skillInputs.some((skill) => pathIsWithinOrEqual(rootSentinel!.path, skill.directory))) {
      throw new Error(CODEX_NATIVE_SESSION_PREFLIGHT_ERROR);
    }
    const args = [...overrides];
    for (const feature of [
      ...CODEX_DISABLED_AMBIENT_FEATURES,
      ...CODEX_NATIVE_DISABLED_AMBIENT_FEATURES,
    ]) {
      args.push("--disable", feature);
    }
    args.push(
      "sandbox",
      "-P",
      CODEX_NATIVE_PERMISSION_PROFILE,
      "--include-managed-config",
      "-C",
      context.workdir,
      ...codexSentinelReadCommand(
        codexHomeSentinel.path,
        rootSentinel.path,
        context.allowedSentinel,
      ),
    );
    const probe = await runCmd(
      bin,
      args,
      Math.min(timeoutMs, 6_000),
      signal,
      context.workdir,
    );
    if (probe.aborted) {
      throw signal?.reason ?? new Error("provider capability probe cancelled");
    }
    // The child returns 73 only if it can read the CODEX_HOME sentinel. Any
    // sandbox setup/config failure is non-zero as well, so only 0 proves deny.
    const available = !probe.timedOut && probe.code === 0;
    if (available) context.removeAllowedSentinel();
    if (available) return { available: true };
    return {
      available: false,
      ...(probe.stderr.includes(CODEX_WINDOWS_ELEVATED_SANDBOX_REQUIRED)
        ? { issue: "windows-elevated-sandbox-required" as const }
        : {}),
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { available: false };
  } finally {
    rootSentinel?.cleanup();
    codexHomeSentinel?.cleanup();
  }
}

function codexVersionSupportsNativeSessions(version: string): boolean {
  const match = /(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?(?:\s|$)/u.exec(version);
  if (!match) return false;
  const installed = match.slice(1, 4).map(Number);
  for (let index = 0; index < MIN_CODEX_NATIVE_SESSION_VERSION.length; index += 1) {
    const delta = installed[index]! - MIN_CODEX_NATIVE_SESSION_VERSION[index]!;
    if (delta !== 0) return delta > 0;
  }
  return true;
}

async function codexNativeSessionsAvailable(
  bin: string,
  timeoutMs: number,
  signal?: AbortSignal,
  knownVersion?: string,
  workdir?: string,
): Promise<boolean> {
  try {
    let version = knownVersion;
    if (!version) {
      const versionProbe = await runCmd(
        bin,
        ["--version"],
        Math.min(timeoutMs, 6_000),
        signal,
      );
    if (versionProbe.aborted) {
      throw signal?.reason ?? new Error("provider capability probe cancelled");
    }
      if (versionProbe.timedOut || versionProbe.code !== 0) return false;
      version = `${versionProbe.stdout}\n${versionProbe.stderr}`;
    }
    if (!codexVersionSupportsNativeSessions(version)) return false;
    const probe = await runCmd(
      bin,
      ["exec", "fork", "--help"],
      Math.min(timeoutMs, 6_000),
      signal,
    );
    if (probe.aborted) throw signal?.reason ?? new Error("provider capability probe cancelled");
    if (probe.timedOut || probe.code !== 0) return false;

    // Codex has no global switch that can suppress System/MDM-managed MCP
    // servers. A Provider-native topic would let those tools persist across
    // turns, so prove the effective list is empty in the exact execution root
    // before allowing any model call. Never expose list contents in errors.
    const mcpProbe = await runCmd(
      bin,
      [
        "-c",
        codexUntrustedProjectOverride(workdir),
        "mcp",
        "list",
        "--json",
      ],
      Math.min(timeoutMs, 6_000),
      signal,
      workdir,
    );
    if (mcpProbe.aborted) {
      throw signal?.reason ?? new Error("provider capability probe cancelled");
    }
    if (
      mcpProbe.timedOut
      || mcpProbe.code !== 0
      || !codexMcpProbeStderrIsSafe(mcpProbe.stderr)
      || Buffer.byteLength(mcpProbe.stdout, "utf8") > MAX_CODEX_MCP_LIST_BYTES
    ) {
      return false;
    }
    try {
      const configured: unknown = JSON.parse(mcpProbe.stdout);
      return Array.isArray(configured) && configured.length === 0;
    } catch {
      return false;
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    return false;
  }
}

async function codexNativeIsolationContextAvailable(
  bin: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  context: CodexNativeIsolationContext,
  execution: ProviderExecution,
  skillInputs: readonly ProviderSkillInput[],
  knownVersion?: string,
  protectedDataRoot?: string,
): Promise<boolean> {
  return (await codexNativeIsolationContextCapability(
    bin,
    timeoutMs,
    signal,
    context,
    execution,
    skillInputs,
    knownVersion,
    protectedDataRoot,
  )).available;
}

async function codexNativeIsolationContextCapability(
  bin: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  context: CodexNativeIsolationContext,
  execution: ProviderExecution,
  skillInputs: readonly ProviderSkillInput[],
  knownVersion?: string,
  protectedDataRoot?: string,
): Promise<CodexNativeSessionCapability> {
  const sessionsAvailable = await codexNativeSessionsAvailable(
    bin,
    timeoutMs,
    signal,
    knownVersion,
    context.workdir,
  );
  if (!sessionsAvailable) return { available: false };
  return await codexNativeFilesystemIsolationCapability(
    bin,
    timeoutMs,
    signal,
    context,
    execution,
    skillInputs,
    protectedDataRoot,
  );
}

/** Fail closed before any Chat routing/synthesis call can use a native session. */
export async function preflightProviderNativeSession(
  id: ProviderId,
  timeoutMs = AI_OPERATION_TIMEOUT_MS,
  signal?: AbortSignal,
  workdir?: string,
  execution?: ProviderExecution,
  skillInputs: readonly ProviderSkillInput[] = [],
  protectedDataRoot?: string,
): Promise<void> {
  if (id !== "codex") {
    throw new Error(`provider ${id} does not support native sessions`);
  }
  const spec = specById.get(id)!;
  let context: CodexNativeIsolationContext | undefined;
  let stagedSkillInputs: StagedProviderSkillInputs | undefined;
  try {
    const normalizedSkillInputs = normalizeProviderSkillInputs(skillInputs);
    context = stageCodexNativeIsolationContext(execution, workdir, protectedDataRoot);
    const effectiveExecution = { ...execution!, workdir: context.workdir };
    // Validate the live source paths before replacing them with private staged
    // copies. Otherwise a Workdir grant could still expose mutable source bytes.
    codexNativeIsolationOverrides(
      effectiveExecution,
      context.workdir,
      normalizedSkillInputs,
      context.probeReadRoot,
      protectedDataRoot,
    );
    stagedSkillInputs = stageProviderSkillInputs(normalizedSkillInputs, signal);
    // Validate the exact profile before any subprocess and reject native full:
    // Codex's danger-full-access mode cannot be narrowed by deny entries.
    codexNativeIsolationOverrides(
      effectiveExecution,
      context.workdir,
      stagedSkillInputs.inputs,
      context.probeReadRoot,
      protectedDataRoot,
    );
    if (!await codexNativeIsolationContextAvailable(
      providerBin(spec),
      timeoutMs,
      signal,
      context,
      effectiveExecution,
      stagedSkillInputs.inputs,
      undefined,
      protectedDataRoot,
    )) {
      throw new Error(CODEX_NATIVE_SESSION_PREFLIGHT_ERROR);
    }
  } catch (error) {
    if (signal?.aborted) {
      throw signal.reason ?? error;
    }
    throw new Error(CODEX_NATIVE_SESSION_PREFLIGHT_ERROR);
  } finally {
    context?.cleanup();
    stagedSkillInputs?.cleanup();
  }
}

function missingClaudeOrdinaryFlags(help: string): string[] {
  const flags = new Set(help.match(/--?[a-zA-Z][a-zA-Z0-9-]*/gu) ?? []);
  return CLAUDE_ORDINARY_REQUIRED_FLAGS.filter((flag) => !flags.has(flag));
}

function claudeAuthIsLoggedIn(stdout: string): boolean {
  if (Buffer.byteLength(stdout, "utf8") > MAX_CLAUDE_AUTH_STATUS_BYTES) return false;
  try {
    const value: unknown = JSON.parse(stdout);
    return Boolean(
      value
      && typeof value === "object"
      && !Array.isArray(value)
      && (value as { loggedIn?: unknown }).loggedIn === true,
    );
  } catch {
    return false;
  }
}

/** Spawn a command with a hard timeout; resolve stdout/stderr/exit code. */
async function runCmd(
  bin: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
  cwd?: string,
  stdin?: string,
): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
}> {
  if (signal?.aborted) throw signal.reason ?? new Error("provider run cancelled");
  const proc = Bun.spawn([bin, ...args], {
    cwd,
    env: providerChildEnvironment(),
    stdout: "pipe",
    stderr: "pipe",
    stdin: stdin === undefined ? "ignore" : "pipe",
  });
  if (stdin !== undefined && proc.stdin && typeof proc.stdin !== "number") {
    proc.stdin.write(stdin);
    proc.stdin.end();
  }
  let timedOut = false;
  let aborted = false;
  let terminating = false;
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
  const terminate = () => {
    if (terminating) return;
    terminating = true;
    proc.kill(); // SIGTERM
    forceKillTimer = setTimeout(() => {
      proc.kill(9); // SIGKILL if the CLI ignored graceful termination
    }, 2_000);
  };
  const timer = setTimeout(() => {
    timedOut = true;
    terminate();
  }, timeoutMs);
  const onAbort = () => {
    aborted = true;
    terminate();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr, timedOut, aborted };
  } finally {
    clearTimeout(timer);
    if (forceKillTimer) clearTimeout(forceKillTimer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Probe every known CLI once. A provider is "available" only if its version
 * command exits 0 and prints something (installed AND runnable). Codex also
 * needs no-completion `login status` and `exec fork --help` probes. Claude needs
 * no-completion `--help` and `auth status --json` probes proving every ordinary
 * isolation flag exists and each CLI considers its current auth usable.
 * Bounded so a hanging CLI can't stall the backend.
 */
export async function detectProviders(timeoutMs = 6000): Promise<DetectedProvider[]> {
  const out: DetectedProvider[] = [];
  for (const spec of KNOWN) {
    const bin = providerBin(spec);
    try {
      const { code, stdout, stderr, timedOut } = await runCmd(bin, spec.versionArgs, timeoutMs);
      const version = (stdout || stderr).trim().split("\n")[0]?.slice(0, 80) ?? "";
      if (timedOut) {
        out.push({ ...base(spec, bin), available: false, detail: "探测超时" });
      } else if (code === 0 && version && !/not found|no such|cannot|error/i.test(version)) {
        if (spec.id === "codex") {
          // Reuse the console login that the user already completed. The probes
          // below run against the isolated CODEX_HOME, so without seeding its
          // credential cache first a perfectly usable console account is
          // reported as unavailable. Seeding is idempotent, never overwrites an
          // existing cache, and validates provenance before copying; a failure
          // here must not mask a working keyring login, so fall through.
          try {
            prepareProviderCodexHome();
          } catch {
            // Keep probing: the keyring store may still hold usable credentials.
          }
          let credentialStore: "file" | "keyring" | undefined;
          for (const [store, args] of [
            ["file", CODEX_LOGIN_STATUS_ARGS],
            ["keyring", CODEX_KEYRING_LOGIN_STATUS_ARGS],
          ] as const) {
            try {
              const authProbe = await runCmd(bin, [...args], timeoutMs);
              if (!authProbe.timedOut && authProbe.code === 0) {
                credentialStore = store;
                break;
              }
            } catch {
              // Try the other official credential cache before declaring auth unavailable.
            }
          }
          if (!credentialStore) {
            codexCredentialStoreByBin.delete(codexCredentialStoreKey(bin));
            out.push({
              ...base(spec, bin),
              available: false,
              detail: CODEX_AUTH_UNAVAILABLE_DETAIL,
            });
            continue;
          }
          codexCredentialStoreByBin.set(codexCredentialStoreKey(bin), credentialStore);
          let nativeCapability: CodexNativeSessionCapability = { available: false };
          let nativeContext: CodexNativeIsolationContext | undefined;
          try {
            const genericExecution: ProviderExecution = {
              permission: "read-only",
              skills: [],
            };
            nativeContext = stageCodexNativeIsolationContext(genericExecution);
            nativeCapability = await codexNativeIsolationContextCapability(
              bin,
              timeoutMs,
              undefined,
              nativeContext,
              { ...genericExecution, workdir: nativeContext.workdir },
              [],
              version,
            );
          } catch {
            nativeCapability = { available: false };
          } finally {
            nativeContext?.cleanup();
          }
          if (!nativeCapability.available) {
            out.push({
              ...base(spec, bin),
              available: true,
              nativeSessions: false,
              ...(nativeCapability.issue ? { nativeSessionIssue: nativeCapability.issue } : {}),
              detail: `${version}；${CODEX_NATIVE_SESSION_UNAVAILABLE_DETAIL}`,
            });
            continue;
          }
          out.push({
            ...base(spec, bin),
            available: true,
            nativeSessions: true,
            detail: version,
          });
          continue;
        }
        if (spec.id !== "claude") {
          out.push({ ...base(spec, bin), available: true, detail: version });
          continue;
        }
        let helpProbe: Awaited<ReturnType<typeof runCmd>>;
        try {
          helpProbe = await runCmd(bin, ["--help"], timeoutMs);
        } catch (err) {
          out.push({
            ...base(spec, bin),
            available: false,
            detail: `普通对话能力探测失败（${String(err).slice(0, 40)}）`,
          });
          continue;
        }
        if (helpProbe.timedOut) {
          out.push({ ...base(spec, bin), available: false, detail: "普通对话能力探测超时" });
          continue;
        }
        if (helpProbe.code !== 0) {
          out.push({
            ...base(spec, bin),
            available: false,
            detail: `普通对话能力探测失败（退出码 ${helpProbe.code}）`,
          });
          continue;
        }
        const missingFlags = missingClaudeOrdinaryFlags(
          `${helpProbe.stdout}\n${helpProbe.stderr}`,
        );
        if (missingFlags.length > 0) {
          out.push({
            ...base(spec, bin),
            available: false,
            detail: `普通对话不可用：缺少 ${missingFlags.join("、")}`,
          });
          continue;
        }
        let authProbe: Awaited<ReturnType<typeof runCmd>>;
        try {
          authProbe = await runCmd(bin, ["auth", "status", "--json"], timeoutMs);
        } catch {
          out.push({
            ...base(spec, bin),
            available: false,
            detail: CLAUDE_AUTH_UNAVAILABLE_DETAIL,
          });
          continue;
        }
        if (
          authProbe.timedOut
          || authProbe.code !== 0
          || !claudeAuthIsLoggedIn(authProbe.stdout)
        ) {
          out.push({
            ...base(spec, bin),
            available: false,
            detail: CLAUDE_AUTH_UNAVAILABLE_DETAIL,
          });
          continue;
        }
        out.push({ ...base(spec, bin), available: true, detail: version });
      } else {
        out.push({ ...base(spec, bin), available: false, detail: version || `退出码 ${code}` });
      }
    } catch (err) {
      out.push({
        ...base(spec, bin),
        available: false,
        detail: `未安装（${String(err).slice(0, 40)}）`,
      });
    }
  }
  return out;
}

function providerBin(spec: CliSpec): string {
  return brandedEnv(process.env, spec.envBin)?.trim() || spec.bin;
}

function base(spec: CliSpec, bin: string): Omit<DetectedProvider, "available" | "detail"> {
  return { id: spec.id, name: spec.name, bin };
}

/** True for a provider id that maps to a known local CLI (not "gateway"). */
export function isCliProvider(id: string): id is ProviderId {
  return specById.has(id as ProviderId);
}

/** True when ordinary Chat/dream/learning can run in the provider's restricted mode. */
export function providerSupportsOrdinaryCompletion(id: string): id is "claude" | "codex" {
  return id === "claude" || id === "codex";
}

/**
 * Curated model ids per CLI provider id. Drives the provider-dependent Model
 * dropdown (mew shows different models per provider). Free-text is still
 * accepted elsewhere; this is just the menu. CLIs have no list-models command,
 * so these lists are curated. (The network gateway is not a user-selectable
 * provider, so it is not included.)
 */
export async function providerModels(): Promise<Record<string, string[]>> {
  return curatedProviderModels();
}

function sanitizedProviderDiagnostic(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const detail = value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, " ")
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu,
      "[redacted-id]",
    )
    .replace(/\s+/gu, " ")
    .trim();
  return detail ? detail.slice(0, 300) : undefined;
}

/** Prefer stderr for CLI failures, but many agent CLIs print errors to stdout. */
export function providerFailureDetail(stdout: string, stderr: string): string {
  return sanitizedProviderDiagnostic(stderr)
    ?? sanitizedProviderDiagnostic(stdout)
    ?? "no output";
}

function structuredFailureDetail(value: unknown): string | undefined {
  return sanitizedProviderDiagnostic(value);
}

/** The curated CLI model catalog, keyed by provider id. */
export function curatedProviderModels(): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  for (const spec of KNOWN) map[spec.id] = spec.models;
  return map;
}

/**
 * Restrict the requested Skill names to the bundles that survived staging.
 * Returns nothing when every Skill was staged, so the ordinary path is
 * untouched and the invocation list still mirrors the frozen evidence.
 */
function providerSkillInvocationNarrowing(
  input: RunInput,
  requestedInputs: readonly ProviderSkillInput[],
  staged: readonly ProviderSkillInput[],
): Partial<RunInput> {
  // Only staging can drop bundles. Providers that never stage, and calls that
  // carry a name-only Skill contract with no bundles, keep their execution
  // contract verbatim so it is never silently emptied.
  if (requestedInputs.length === 0) return {};
  if (requestedInputs.length === staged.length) return {};
  const kept = new Set(staged.map((skill) => skill.name));
  const requested = Array.isArray(input.execution?.skills)
    ? input.execution.skills
    : Array.isArray(input.skills)
      ? input.skills
      : [];
  const skills = requested.filter((name) => kept.has(name));
  return {
    skills,
    ...(input.execution ? { execution: { ...input.execution, skills } } : {}),
  };
}

function injectProviderSkills(id: ProviderId, input: RunInput): RunInput {
  const skills = normalizeProviderSkills(
    Array.isArray(input.execution?.skills)
      ? input.execution.skills
      : Array.isArray(input.skills)
        ? input.skills
        : [],
  );
  const skillInputs = normalizeProviderSkillInputs(input.skillInputs);
  const prepared: RunInput = {
    ...input,
    skills,
    skillInputs,
    ...(input.execution
      ? {
          execution: {
            permission: normalizeProviderPermission(input.execution.permission),
            workdir: typeof input.execution.workdir === "string"
              ? input.execution.workdir
              : undefined,
            skills,
            skillMode: input.execution.skillMode === "all" ? "all" : undefined,
            research: input.execution.research === true,
            webSearch: input.execution.webSearch === true,
          },
        }
      : {}),
  };
  if (
    id === "codex"
    && prepared.execution
    && (
      skillInputs.length !== skills.length
      || skillInputs.some((skill, index) => skill.name !== skills[index])
    )
  ) {
    throw new Error("provider Codex Skill inputs do not match frozen evidence");
  }
  // Native Skill invocation requires an execution grant. Background no-tools
  // completions keep evidence in the Run trace but do not ask the CLI to load
  // a local Skill.
  if (!prepared.execution || skills.length === 0) return prepared;
  if (id === "codex") {
    const instruction = prepared.execution.skillMode === "all"
      ? "可按需使用下列已冻结技能；只使用与当前请求相关的技能。"
      : "必须使用并遵循下列已冻结技能。";
    return {
      ...prepared,
      prompt: [
        instruction,
        "以下是本轮唯一有效的技能映射；忽略会话历史中的旧技能路径。使用某个技能前，必须先读取下列映射中的 SKILL.md；只可从对应目录读取技能资源，禁止搜索、发现或加载其他技能。",
        ...skillInputs.map((skill) => `- ${skill.name}: ${JSON.stringify(skill.skillFile)}`),
        "如果任一所需技能或资源不可读取，停止执行并明确报告，不要假装已经使用。",
        "",
        prepared.prompt,
      ].join("\n"),
    };
  }
  const references = skills
    .map((skill) => providerSkillReference(id, skill))
    .filter((reference): reference is string => Boolean(reference));
  const instruction = prepared.execution.skillMode === "all"
    ? [
        `可按需使用以下技能：${references.join("、")}；只加载与当前请求相关的技能。`,
        "如果所需技能不可用，停止执行并明确报告。",
      ]
    : [
        `必须先加载并遵循以下已配置技能：${references.join("、")}。`,
        "如果任一技能不可用，停止执行并明确报告，不要假装已经使用。",
      ];
  return {
    ...prepared,
    prompt: [
      ...instruction,
      "",
      prepared.prompt,
    ].join("\n"),
  };
}

const MAX_CODEX_OUTPUT_SCHEMA_BYTES = 64 * 1024;
const MAX_CODEX_FINAL_OUTPUT_BYTES = 1024 * 1024;

function isSchemaObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function schemaAllowsNull(value: unknown): boolean {
  if (!isSchemaObject(value)) return false;
  const type = value.type;
  if (type === "null" || (Array.isArray(type) && type.includes("null"))) return true;
  for (const keyword of ["anyOf", "oneOf"] as const) {
    const alternatives = value[keyword];
    if (Array.isArray(alternatives) && alternatives.some(schemaAllowsNull)) return true;
  }
  return false;
}

/** Adapt caller JSON Schema to the strict subset required by Codex output schemas. */
function strictCodexOutputSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strictCodexOutputSchema);
  if (!isSchemaObject(value)) return value;

  const properties = isSchemaObject(value.properties) ? value.properties : undefined;
  const required = new Set(
    Array.isArray(value.required)
      ? value.required.filter((item): item is string => typeof item === "string")
      : [],
  );
  const schemaType = value.type;
  const isObject = schemaType === "object"
    || (Array.isArray(schemaType) && schemaType.includes("object"));
  const normalized: Record<string, unknown> = {};

  for (const [key, child] of Object.entries(value)) {
    if (isObject && (key === "required" || key === "additionalProperties")) continue;
    if (isObject && key === "properties" && properties) {
      normalized.properties = Object.fromEntries(
        Object.entries(properties).map(([name, propertySchema]) => {
          const normalizedProperty = strictCodexOutputSchema(propertySchema);
          return [
            name,
            required.has(name) || schemaAllowsNull(normalizedProperty)
              ? normalizedProperty
              : { anyOf: [normalizedProperty, { type: "null" }] },
          ];
        }),
      );
      continue;
    }
    normalized[key] = strictCodexOutputSchema(child);
  }

  if (isObject) {
    if (properties) normalized.required = Object.keys(properties);
    normalized.additionalProperties = false;
  }
  return normalized;
}

function stageCodexOutputSchema(schema: Record<string, unknown>): {
  schemaPath: string;
  outputPath: string;
  cleanup: () => void;
} {
  const serialized = JSON.stringify(strictCodexOutputSchema(schema));
  if (Buffer.byteLength(serialized, "utf8") > MAX_CODEX_OUTPUT_SCHEMA_BYTES) {
    throw new Error("provider output schema exceeds the supported size");
  }
  const directory = mkdtempSync(join(tmpdir(), "homeagent-codex-schema-"));
  const schemaPath = join(directory, "output-schema.json");
  const outputPath = join(directory, "final-output.json");
  try {
    writeFileSync(schemaPath, `${serialized}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    try {
      rmdirSync(directory);
    } catch {
      // Preserve the staging failure if best-effort cleanup also fails.
    }
    throw error;
  }
  return {
    schemaPath,
    outputPath,
    cleanup: () => {
      let failed = false;
      for (const path of [outputPath, schemaPath]) {
        try {
          unlinkSync(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") failed = true;
        }
      }
      try {
        rmdirSync(directory);
      } catch {
        failed = true;
      }
      if (failed) log.warn("Codex output schema cleanup failed");
    },
  };
}

function codexFinalOutputLimit(maxTokens: number | undefined): number {
  if (maxTokens === undefined || !Number.isFinite(maxTokens) || maxTokens <= 0) {
    return MAX_CODEX_FINAL_OUTPUT_BYTES;
  }
  // Codex exposes no output-token argv. Keep enough room for UTF-8/JSON
  // expansion while enforcing the caller's budget as a bounded local artifact.
  return Math.min(
    MAX_CODEX_FINAL_OUTPUT_BYTES,
    Math.max(16 * 1024, Math.ceil(maxTokens) * 16),
  );
}

function readCodexFinalOutput(path: string, maxTokens?: number): string {
  let metadata: ReturnType<typeof lstatSync>;
  try {
    metadata = lstatSync(path);
  } catch {
    throw new Error("provider codex did not write its final output");
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("provider codex returned an invalid final output file");
  }
  if (metadata.size > codexFinalOutputLimit(maxTokens)) {
    throw new Error("provider codex final output exceeds the requested output budget");
  }
  const text = readFileSync(path, "utf8").trim();
  if (!text) throw new Error("provider codex returned an empty final output");
  return text;
}

/**
 * Run a one-shot completion via a local CLI provider with normalized usage.
 * Throws on non-zero exit / timeout so callers can surface a bounded failure.
 * These CLIs are full coding agents: slower and heavier than the gateway, and
 * they manage their own auth — so this is best-effort "hand the question to the
 * local agent", not a lightweight completion.
 */
export async function runProviderDetailed(
  id: ProviderId,
  input: RunInput,
  timeoutMs = AI_OPERATION_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<ProviderRunResult> {
  const spec = specById.get(id);
  if (!spec) throw new Error(`unknown provider: ${id}`);
  validateNativeSessionRequest(id, input.nativeSession);
  const nativeIsolation = usesCodexNativeIsolation(input);
  if (nativeIsolation && id !== "codex") {
    throw new Error(`provider ${id} does not support isolated native sessions`);
  }
  if ((input.images?.length ?? 0) > 4) {
    throw new Error("provider calls accept at most 4 images");
  }
  if (input.images?.length && id !== "codex") {
    throw new UnsupportedImageInputError(id);
  }
  let isolationContext: CodexNativeIsolationContext | undefined;
  let stagedSchema: ReturnType<typeof stageCodexOutputSchema> | undefined;
  let stagedSkillInputs: StagedProviderSkillInputs | undefined;
  try {
    const normalizedSkillInputs = normalizeProviderSkillInputs(input.skillInputs);
    let effectiveInput: RunInput = { ...input, skillInputs: normalizedSkillInputs };
    if (nativeIsolation) {
      isolationContext = stageCodexNativeIsolationContext(
        input.execution,
        input.execution?.workdir ?? input.workdir,
        input.protectedDataRoot,
      );
      effectiveInput = {
        ...effectiveInput,
        workdir: isolationContext.workdir,
        execution: {
          ...input.execution!,
          workdir: isolationContext.workdir,
        },
      };
      codexNativeIsolationOverrides(
        effectiveInput.execution,
        isolationContext.workdir,
        normalizedSkillInputs,
        isolationContext.probeReadRoot,
        input.protectedDataRoot,
      );
    }
    stagedSkillInputs = id === "codex"
      ? stageProviderSkillInputs(normalizedSkillInputs, signal)
      : { inputs: normalizedSkillInputs, cleanup: () => {} };
    effectiveInput = {
      ...effectiveInput,
      skillInputs: stagedSkillInputs.inputs,
      // Staging may drop Skills that no longer fit the shared per-invocation
      // budget. Narrow the invocation list to exactly what was staged so the
      // frozen-evidence check keeps comparing argv against real staged bundles.
      ...providerSkillInvocationNarrowing(
        effectiveInput,
        normalizedSkillInputs,
        stagedSkillInputs.inputs,
      ),
    };
    const prepared = injectProviderSkills(id, effectiveInput);
    const bin = providerBin(spec);
    if (nativeIsolation) {
      if (!await codexNativeIsolationContextAvailable(
        bin,
        timeoutMs,
        signal,
        isolationContext!,
        prepared.execution!,
        prepared.skillInputs ?? [],
        undefined,
        prepared.protectedDataRoot,
      )) {
        throw new Error(CODEX_NATIVE_SESSION_PREFLIGHT_ERROR);
      }
    }
    if (!prepared.execution && id === "trae-cli") {
      throw new Error(`provider ${id} cannot provide a no-tools execution mode`);
    }
    if (prepared.execution?.webSearch && prepared.execution.permission !== "read-only") {
      throw new Error("web search requires read-only provider execution");
    }
    if (prepared.execution?.webSearch && id === "trae-cli") {
      throw new Error("provider trae-cli does not support web search");
    }
    if (prepared.execution?.webSearch && id === "codex") {
      throw new Error(
        "provider codex cannot isolate web search from local file tools",
      );
    }
    stagedSchema = id === "codex" && prepared.outputSchema
      ? stageCodexOutputSchema(prepared.outputSchema)
      : undefined;
    const providerInput: PreparedRunInput = {
      ...prepared,
      ...(id === "codex"
        ? {
            codexCredentialStore:
              codexCredentialStoreByBin.get(codexCredentialStoreKey(bin)) ?? "file",
          }
        : {}),
      ...(isolationContext
        ? { nativeIsolationReadRoot: isolationContext.probeReadRoot }
        : {}),
      ...(stagedSchema
        ? {
            outputSchemaPath: stagedSchema.schemaPath,
            outputLastMessagePath: stagedSchema.outputPath,
          }
        : {}),
    };
    const args = spec.buildRun(providerInput);
    log.info("running local provider", { id, bin });
    const { code, stdout, stderr, timedOut, aborted } = await runCmd(
      bin,
      args,
      timeoutMs,
      signal,
      prepared.execution?.workdir ?? prepared.workdir,
      id === "claude" || id === "codex" ? prepared.prompt : undefined,
    );
    if (aborted) throw signal?.reason ?? new Error(`provider ${id} cancelled`);
    if (timedOut) throw new Error(`provider ${id} timed out after ${timeoutMs}ms`);
    if (code !== 0) {
      if (id === "claude") {
        const parsed = parseClaudeResult(stdout);
        if (parsed) {
          throw new ProviderRunError(
            id,
            `provider ${id} exited ${code}: ${providerFailureDetail(stdout, stderr)}`,
            parsed.usage,
          );
        }
      }
      if (id === "codex") {
        const parsed = parseCodexResult(stdout, stagedSchema ? "" : undefined);
        if (parsed) {
          throw new ProviderRunError(
            id,
            `provider ${id} exited ${code}: ${providerFailureDetail(stdout, stderr)}`,
            parsed.usage,
          );
        }
      }
      throw new Error(`provider ${id} exited ${code}: ${providerFailureDetail(stdout, stderr)}`);
    }
    if (id === "claude") {
      const parsed = parseClaudeResult(stdout);
      return validateNativeSessionResult(
        prepared.nativeSession,
        parsed ?? unavailableResult(stdout, "legacy-text"),
      );
    }
    if (id === "codex") {
      const parsed = parseCodexResult(stdout, stagedSchema ? "" : undefined);
      if (stagedSchema) {
        return validateNativeSessionResult(prepared.nativeSession, {
          text: readCodexFinalOutput(stagedSchema.outputPath, prepared.maxTokens),
          usage: parsed?.usage ?? unavailableResult("", "codex-jsonl").usage,
          nativeSessionId: parsed?.nativeSessionId,
        });
      }
      return validateNativeSessionResult(
        prepared.nativeSession,
        parsed ?? unavailableResult(stdout, "legacy-text"),
      );
    }
    return unavailableResult(stdout, "trae-text");
  } finally {
    stagedSchema?.cleanup();
    isolationContext?.cleanup();
    stagedSkillInputs?.cleanup();
  }
}

/** Backward-compatible text-only provider API. */
export async function runProvider(
  id: ProviderId,
  input: RunInput,
  timeoutMs = AI_OPERATION_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<string> {
  if (input.nativeSession) {
    throw new Error("text-only provider API does not support native sessions");
  }
  return (await runProviderDetailed(id, input, timeoutMs, signal)).text;
}

function unavailableResult(text: string, source: UsageSource): ProviderRunResult {
  return {
    text: text.trim(),
    usage: { costBasis: "unavailable", source },
  };
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

const NATIVE_SESSION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function nativeSessionId(value: unknown): string | undefined {
  return typeof value === "string" && NATIVE_SESSION_ID_RE.test(value)
    ? value.toLowerCase()
    : undefined;
}

function validateNativeSessionRequest(
  provider: ProviderId,
  request: NativeSessionRequest | undefined,
): void {
  if (!request) return;
  if (provider !== "codex") {
    throw new Error(`provider ${provider} does not support isolated native sessions`);
  }
  if (request.mode === "start") return;
  if (request.mode === "fork") {
    if (!nativeSessionId(request.id)) {
      throw new Error("provider native session id is invalid");
    }
    return;
  }
  throw new Error("provider native session request is invalid");
}

function validateNativeSessionResult(
  request: NativeSessionRequest | undefined,
  result: ProviderRunResult,
): ProviderRunResult {
  if (!request) {
    const ordinaryResult = { ...result };
    delete ordinaryResult.nativeSessionId;
    return ordinaryResult;
  }
  if (request.mode === "start") {
    if (!result.nativeSessionId) {
      throw new Error("provider did not return a valid native session id");
    }
    return result;
  }
  if (!result.nativeSessionId) {
    throw new Error("provider did not return a valid forked native session id");
  }
  if (result.nativeSessionId === nativeSessionId(request.id)) {
    throw new Error("provider did not fork the native session");
  }
  return result;
}

function parseClaudeResult(stdout: string): ProviderRunResult | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout.trim());
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const result = raw as Record<string, unknown>;
  if (result.type !== "result") return undefined;
  const rawUsage = result.usage && typeof result.usage === "object" && !Array.isArray(result.usage)
    ? result.usage as Record<string, unknown>
    : {};
  const usage: CompletionUsage = {
    inputTokens: nonNegativeNumber(rawUsage.input_tokens),
    cachedInputTokens: nonNegativeNumber(rawUsage.cache_read_input_tokens),
    cacheCreationInputTokens: nonNegativeNumber(rawUsage.cache_creation_input_tokens),
    outputTokens: nonNegativeNumber(rawUsage.output_tokens),
    costUsd: nonNegativeNumber(result.total_cost_usd),
    costBasis: nonNegativeNumber(result.total_cost_usd) === undefined
      ? "unavailable"
      : "reported",
    source: "claude-json",
  };
  for (const key of Object.keys(usage) as (keyof CompletionUsage)[]) {
    if (usage[key] === undefined) delete usage[key];
  }
  if (
    result.is_error === true
    || (typeof result.subtype === "string" && result.subtype.startsWith("error"))
  ) {
    const subtype = typeof result.subtype === "string" ? result.subtype : "error";
    const detail = structuredFailureDetail(result.result);
    throw new ProviderRunError(
      "claude",
      `provider claude returned ${subtype}${detail ? `: ${detail}` : ""}`,
      usage,
    );
  }
  if (typeof result.result !== "string") return undefined;
  return {
    text: result.result.trim(),
    usage,
    nativeSessionId: nativeSessionId(result.session_id),
  };
}

function parseCodexResult(
  stdout: string,
  finalText?: string,
): ProviderRunResult | undefined {
  let lastText: string | undefined;
  let failure: string | undefined;
  let rawUsage: Record<string, unknown> | undefined;
  let parsedNativeSessionId: string | undefined;
  for (const line of stdout.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const event = raw as Record<string, unknown>;
    if (event.type === "thread.started") {
      parsedNativeSessionId = nativeSessionId(event.thread_id);
    }
    if (event.type === "item.completed" && event.item && typeof event.item === "object") {
      const item = event.item as Record<string, unknown>;
      if (item.type === "agent_message" && typeof item.text === "string") {
        lastText = item.text;
      }
    }
    if (
      (event.type === "turn.completed" || event.type === "turn.failed")
      && event.usage
      && typeof event.usage === "object"
      && !Array.isArray(event.usage)
    ) {
      rawUsage = event.usage as Record<string, unknown>;
    }
    if (event.type === "turn.failed") {
      const error = event.error && typeof event.error === "object" && !Array.isArray(event.error)
        ? event.error as Record<string, unknown>
        : undefined;
      failure = structuredFailureDetail(error?.message) ?? "turn.failed";
    }
  }
  const usage: CompletionUsage = {
    inputTokens: nonNegativeNumber(rawUsage?.input_tokens),
    cachedInputTokens: nonNegativeNumber(rawUsage?.cached_input_tokens),
    cacheCreationInputTokens: nonNegativeNumber(rawUsage?.cache_write_input_tokens),
    outputTokens: nonNegativeNumber(rawUsage?.output_tokens),
    reasoningTokens: nonNegativeNumber(rawUsage?.reasoning_output_tokens),
    costBasis: "unavailable",
    source: "codex-jsonl",
  };
  for (const key of Object.keys(usage) as (keyof CompletionUsage)[]) {
    if (usage[key] === undefined) delete usage[key];
  }
  if (failure !== undefined) {
    throw new ProviderRunError("codex", `provider codex returned ${failure}`, usage);
  }
  const text = finalText ?? lastText;
  if (text === undefined) return undefined;
  return {
    text: text.trim(),
    usage,
    nativeSessionId: parsedNativeSessionId,
  };
}

/** Normalize provider timeout detection across traces, metrics, and user notices. */
export function isProviderTimeoutError(error: unknown): boolean {
  return /timed?\s*out|timeout|超时/iu.test(String(error));
}

/**
 * True only when a requested Provider-native parent no longer exists.
 * Capability/configuration failures are deliberately excluded: callers must
 * preserve the last committed topic head for transient or repairable failures.
 */
export function isProviderNativeSessionParentMissingError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\bno rollout found for thread id\b|\bno conversation found\b|\b(?:session|conversation|thread)(?:\s+id)?\b.{0,80}\b(?:not found|does not exist|unknown)\b/iu
    .test(message);
}
