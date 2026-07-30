/**
 * Local agent-CLI providers (mew's "provider" concept, adapted to a single
 * machine). mew routes a task to a provider running on some Device; homeagent
 * has no remote devices, so a "provider" here is an agent CLI installed on THIS
 * machine (claude / codex / trae-cli). This module is the single choke point for
 * all CLI provider traffic — like gateway.ts is for the network gateway.
 *
 * Two responsibilities:
 *   - detectProviders(): probe each known CLI with `--version` (bounded), so the
 *     backend only offers providers that are actually installed AND runnable.
 *     (A CLI can be on PATH yet broken — e.g. a Windows npm shim under WSL with
 *     no linux `node` — and must NOT be offered.)
 *   - runProvider(): spawn the CLI non-interactively with a prompt/system/model
 *     and return its stdout text.
 *
 * The built-in "gateway" provider (the Anthropic network gateway) is handled by
 * gateway.ts, not here; it is always available and is the default.
 */
import { brandedEnv, logger } from "@homeagent/shared";
import { MANAGED_CODEX_AUTH_ARGS } from "./provider-setup.ts";
import type { ImageInput } from "./gateway.ts";

const log = logger.child("providers");

/** Stable provider ids. "gateway" is the built-in network provider (elsewhere). */
export type ProviderId = "gateway" | "claude" | "codex" | "trae-cli";

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
  buildRun: (input: RunInput) => string[];
}

export interface RunInput {
  prompt: string;
  system?: string;
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
  /** local images attached to the current user turn */
  images?: ImageInput[];
  /** Present only for an explicit task execution, never ordinary Q&A/distillation. */
  execution?: ProviderExecution;
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
  /** Safe skill identifiers that the provider must load before acting. */
  skills: string[];
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
      // Lean/read-only mode: --bare skips hooks/CLAUDE.md/memory/keychain and
      // --allowedTools "" disables all tools. Measured ~2.6x faster and avoids
      // permission prompts — right for Q&A/distillation (no side effects).
      const args = ["-p", prompt, "--bare"];
      if (!execution) {
        args.push("--allowedTools", "");
      } else if (execution.permission === "read-only") {
        args.push(
          "--tools",
          execution.webSearch
            ? "Read,Glob,Grep,WebSearch,WebFetch"
            : "Read,Glob,Grep",
          "--permission-mode",
          "dontAsk",
        );
      } else if (execution.permission === "write") {
        const tools = execution.webSearch
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
    buildRun: ({ model, reasoningEffort, images, execution }) => {
      // Ordinary LLM work stays read-only; task execution maps the Agent's
      // permission tier to Codex's sandbox without interactive approvals.
      const args: string[] = [];
      if (reasoningEffort) args.push("-c", `model_reasoning_effort="${reasoningEffort}"`);
      if (execution) args.push("-c", 'approval_policy="never"');
      if (execution?.webSearch) args.push("--search");
      const sandbox = sandboxForPermission(execution?.permission);
      args.push("exec", "--sandbox", sandbox);
      if (execution) args.push("--skip-git-repo-check");
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
      // Ordinary LLM work stays read-only; task execution maps the Agent's
      // permission tier to TRAE's sandbox.
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
 * command exits 0 and prints something (installed AND runnable). Bounded so a
 * hanging CLI can't stall the backend.
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

/** The curated CLI model catalog, keyed by provider id. */
export function curatedProviderModels(): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  for (const spec of KNOWN) map[spec.id] = spec.models;
  return map;
}

function injectExecutionSkills(id: ProviderId, input: RunInput): RunInput {
  if (!input.execution) return input;
  const skills = normalizeProviderSkills(
    Array.isArray(input.execution.skills) ? input.execution.skills : [],
  );
  const prepared = {
    ...input,
    execution: {
      permission: normalizeProviderPermission(input.execution.permission),
      workdir: typeof input.execution.workdir === "string"
        ? input.execution.workdir
        : undefined,
      skills,
      webSearch: input.execution.webSearch === true,
    },
  };
  if (skills.length === 0) return prepared;
  const references = skills
    .map((skill) => providerSkillReference(id, skill))
    .filter((reference): reference is string => Boolean(reference));
  return {
    ...prepared,
    prompt: [
      `必须先加载并遵循以下已配置技能：${references.join("、")}。`,
      "如果任一技能不可用，停止执行并明确报告，不要假装已经使用。",
      "",
      prepared.prompt,
    ].join("\n"),
  };
}

/**
 * Run a one-shot completion via a local CLI provider. Returns trimmed stdout.
 * Throws on non-zero exit / timeout so callers can surface a bounded failure.
 * These CLIs are full coding agents: slower and heavier than the gateway, and
 * they manage their own auth — so this is best-effort "hand the question to the
 * local agent", not a lightweight completion.
 */
export async function runProvider(
  id: ProviderId,
  input: RunInput,
  timeoutMs = 120_000,
  signal?: AbortSignal,
): Promise<string> {
  const spec = specById.get(id);
  if (!spec) throw new Error(`unknown provider: ${id}`);
  if ((input.images?.length ?? 0) > 4) {
    throw new Error("provider calls accept at most 4 images");
  }
  if (input.images?.length && id !== "codex") {
    throw new UnsupportedImageInputError(id);
  }
  const prepared = injectExecutionSkills(id, input);
  if (prepared.execution?.webSearch && prepared.execution.permission !== "read-only") {
    throw new Error("web search requires read-only provider execution");
  }
  if (prepared.execution?.webSearch && id === "trae-cli") {
    throw new Error("provider trae-cli does not support web search");
  }
  const args = spec.buildRun(prepared);
  if (id === "codex" && brandedEnv(process.env, "CODEX_BIN")?.trim()) {
    args.unshift(...MANAGED_CODEX_AUTH_ARGS);
  }
  const bin = providerBin(spec);
  log.info("running local provider", { id, bin });
  const { code, stdout, stderr, timedOut, aborted } = await runCmd(
    bin,
    args,
    timeoutMs,
    signal,
    prepared.execution?.workdir,
    id === "codex" ? prepared.prompt : undefined,
  );
  if (aborted) throw signal?.reason ?? new Error(`provider ${id} cancelled`);
  if (timedOut) throw new Error(`provider ${id} timed out after ${timeoutMs}ms`);
  if (code !== 0) throw new Error(`provider ${id} exited ${code}: ${providerFailureDetail(stdout, stderr)}`);
  return stdout.trim();
}

/** Normalize provider timeout detection across traces, metrics, and user notices. */
export function isProviderTimeoutError(error: unknown): boolean {
  return /timed?\s*out|timeout|超时/iu.test(String(error));
}
