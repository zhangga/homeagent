/**
 * Local agent-CLI providers (mew's "provider" concept, adapted to a single
 * machine). mew routes a task to a provider running on some Device; homeagent
 * has no remote devices, so a "provider" here is an agent CLI installed on THIS
 * machine (claude / codex / trae-cli). This module is the single choke point for
 * all CLI provider traffic — like gateway.ts is for the network gateway.
 *
 * Two responsibilities:
 *   - detectProviders(): probe each known CLI with `--version` (bounded), and
 *     verify Claude's no-tools argv and authenticated status with no-completion
 *     probes, so the backend only offers providers that are runnable and ready.
 *     (A CLI can be on PATH yet broken — e.g. a Windows npm shim under WSL with
 *     no linux `node` — and must NOT be offered.)
 *   - runProviderDetailed(): spawn the CLI non-interactively and normalize its
 *     answer plus any structured usage it reports. runProvider() keeps the
 *     legacy text-only boundary for external callers.
 *
 * The built-in "gateway" provider (the Anthropic network gateway) is handled by
 * gateway.ts, not here; it is always available and is the default.
 */
import { brandedEnv, logger } from "@homeagent/shared";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MANAGED_CODEX_AUTH_ARGS } from "./provider-setup.ts";
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
}

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
   * are folded in per CLI; Codex reads its prompt from stdin so Windows npm
   * command shims cannot truncate multiline input.
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
  /** Canonical Agent working directory used by the current call. */
  workdir?: string;
  /** Present for Chat, Task, or explicit web-research grants; absent for distillation. */
  execution?: ProviderExecution;
  /** Final-response contract for providers with native structured-output support. */
  outputSchema?: Record<string, unknown>;
  /** Caller output budget, enforced locally when the CLI has no native flag. */
  maxTokens?: number;
}

interface PreparedRunInput extends RunInput {
  outputSchemaPath?: string;
  outputLastMessagePath?: string;
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

export interface DetectedProvider {
  id: ProviderId;
  name: string;
  bin: string;
  available: boolean;
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
    buildRun: ({ prompt, system, model, execution }) => {
      // Safe mode preserves OAuth/keychain authentication while disabling
      // ambient CLAUDE.md, hooks, plugins, MCP servers and custom commands.
      // Explicitly pinned native Skills need Claude's Skill discovery, so those
      // authorized task calls rely on the frozen tool grant plus strict MCP.
      const args = ["-p", prompt];
      if (!execution || execution.webSearch || execution.skills.length === 0) {
        args.push("--safe-mode");
      }
      args.push(
        "--no-session-persistence",
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
      outputSchemaPath,
      outputLastMessagePath,
    }) => {
      // Chat and Task execution reach this adapter. Ephemeral mode and ignored
      // ambient config/rules isolate each one-shot from global state.
      const args: string[] = ["-c", 'approval_policy="never"'];
      if (reasoningEffort) args.push("-c", `model_reasoning_effort="${reasoningEffort}"`);
      if (execution?.webSearch || execution?.research) args.push("--search");
      const sandbox = sandboxForPermission(execution?.permission);
      // Codex 0.147+ scopes these isolation flags to the `exec` subcommand.
      // Keeping them before `exec` makes the CLI exit during argument parsing.
      args.push(
        "exec",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--json",
        "--sandbox",
        sandbox,
      );
      args.push("--skip-git-repo-check");
      if (outputSchemaPath) args.push("--output-schema", outputSchemaPath);
      if (outputLastMessagePath) args.push("-o", outputLastMessagePath);
      if (model) args.push("-m", model);
      for (const image of images ?? []) args.push("--image", image.path);
      // Codex's --image accepts multiple values. Terminate option parsing
      // explicitly, then use `-` so multiline prompts travel over stdin rather
      // than through Windows' lossy npm .cmd argument forwarding.
      args.push("--", "-");
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

/** Every Claude flag used by ordinary Chat/dream/learning execution. */
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
const CODEX_AUTH_UNAVAILABLE_DETAIL = "ChatGPT 尚未连接";

function codexAuthArgsForCurrentBinary(): readonly string[] {
  return brandedEnv(process.env, "CODEX_BIN")?.trim()
    ? MANAGED_CODEX_AUTH_ARGS
    : [];
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
 * needs a no-completion `login status` probe. Claude needs no-completion
 * `--help` and `auth status --json` probes proving every ordinary no-tools flag
 * exists and each CLI considers its current auth usable.
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
          let authProbe: Awaited<ReturnType<typeof runCmd>>;
          try {
            authProbe = await runCmd(
              bin,
              [...codexAuthArgsForCurrentBinary(), "login", "status"],
              timeoutMs,
            );
          } catch {
            out.push({
              ...base(spec, bin),
              available: false,
              detail: CODEX_AUTH_UNAVAILABLE_DETAIL,
            });
            continue;
          }
          if (authProbe.timedOut || authProbe.code !== 0) {
            out.push({
              ...base(spec, bin),
              available: false,
              detail: CODEX_AUTH_UNAVAILABLE_DETAIL,
            });
            continue;
          }
          out.push({ ...base(spec, bin), available: true, detail: version });
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

/** Prefer stderr for CLI failures, but many agent CLIs print errors to stdout. */
export function providerFailureDetail(stdout: string, stderr: string): string {
  return (stderr.trim() || stdout.trim() || "no output").slice(0, 300);
}

function structuredFailureDetail(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const detail = value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return detail ? detail.slice(0, 300) : undefined;
}

/** The curated CLI model catalog, keyed by provider id. */
export function curatedProviderModels(): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  for (const spec of KNOWN) map[spec.id] = spec.models;
  return map;
}

function injectProviderSkills(id: ProviderId, input: RunInput): RunInput {
  const skills = normalizeProviderSkills(
    Array.isArray(input.execution?.skills)
      ? input.execution.skills
      : Array.isArray(input.skills)
        ? input.skills
        : [],
  );
  const prepared: RunInput = {
    ...input,
    skills,
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
  // Native Skill invocation requires an execution grant. Background no-tools
  // completions keep evidence in the Run trace but do not ask the CLI to load
  // a local Skill.
  if (!prepared.execution || skills.length === 0) return prepared;
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
  timeoutMs = 120_000,
  signal?: AbortSignal,
): Promise<ProviderRunResult> {
  const spec = specById.get(id);
  if (!spec) throw new Error(`unknown provider: ${id}`);
  if ((input.images?.length ?? 0) > 4) {
    throw new Error("provider calls accept at most 4 images");
  }
  if (input.images?.length && id !== "codex") {
    throw new UnsupportedImageInputError(id);
  }
  const prepared = injectProviderSkills(id, input);
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
  const stagedSchema = id === "codex" && prepared.outputSchema
    ? stageCodexOutputSchema(prepared.outputSchema)
    : undefined;
  try {
    const providerInput: PreparedRunInput = {
      ...prepared,
      ...(stagedSchema
        ? {
            outputSchemaPath: stagedSchema.schemaPath,
            outputLastMessagePath: stagedSchema.outputPath,
          }
        : {}),
    };
    const args = spec.buildRun(providerInput);
    if (id === "codex") args.unshift(...codexAuthArgsForCurrentBinary());
    const bin = providerBin(spec);
    log.info("running local provider", { id, bin });
    const { code, stdout, stderr, timedOut, aborted } = await runCmd(
      bin,
      args,
      timeoutMs,
      signal,
      prepared.execution?.workdir ?? prepared.workdir,
      id === "codex" ? prepared.prompt : undefined,
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
      if (parsed) return parsed;
      return unavailableResult(stdout, "legacy-text");
    }
    if (id === "codex") {
      const parsed = parseCodexResult(stdout, stagedSchema ? "" : undefined);
      if (stagedSchema) {
        return {
          text: readCodexFinalOutput(stagedSchema.outputPath, prepared.maxTokens),
          usage: parsed?.usage ?? unavailableResult("", "codex-jsonl").usage,
        };
      }
      if (parsed) return parsed;
      return unavailableResult(stdout, "legacy-text");
    }
    return unavailableResult(stdout, "trae-text");
  } finally {
    stagedSchema?.cleanup();
  }
}

/** Backward-compatible text-only provider API. */
export async function runProvider(
  id: ProviderId,
  input: RunInput,
  timeoutMs = 120_000,
  signal?: AbortSignal,
): Promise<string> {
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
  return { text: result.result.trim(), usage };
}

function parseCodexResult(
  stdout: string,
  finalText?: string,
): ProviderRunResult | undefined {
  let lastText: string | undefined;
  let failure: string | undefined;
  let rawUsage: Record<string, unknown> | undefined;
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
      failure = typeof error?.message === "string" ? error.message : "turn.failed";
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
  return { text: text.trim(), usage };
}

/** Normalize provider timeout detection across traces, metrics, and user notices. */
export function isProviderTimeoutError(error: unknown): boolean {
  return /timed?\s*out|timeout|超时/iu.test(String(error));
}
