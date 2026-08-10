/**
 * A CLI-backed LlmClient. Instead of the network gateway, all LLM work is run
 * through a local agent CLI (claude / codex / trae-cli) via runProvider(). This
 * is the only LLM path in homeagent — there is no network-API fallback.
 *
 *   - complete(): the CLI's stdout is the answer text.
 *   - completeJSON(): we append a strict "output only JSON matching this schema"
 *     instruction to the prompt, then parse the CLI's stdout (tolerating ```json
 *     fences``` and surrounding prose). Because CLIs give no structured-output
 *     guarantee, callers must handle a thrown parse/validation error — dream
 *     already quarantines bad output, and ask surfaces a graceful message.
 *
 * These CLIs are full coding agents: slower and heavier than an API call, and
 * they manage their own auth/model. Structured usage is preserved when a CLI
 * reports it; unavailable counters and costs stay absent rather than becoming
 * misleading zeroes.
 */
import type {
  CodexReasoningEffort,
  CallPurpose,
  CompletionUsage,
  CompleteOptions,
  CompleteResult,
  JSONOptions,
  ProviderRunResult,
  ProviderExecution,
  ProviderId,
} from "@homeagent/llm";
import { runProviderDetailed as realRunProvider } from "@homeagent/llm";
import {
  BudgetExceededError,
  ProviderRunError,
  checkBudget,
  recordCall,
} from "@homeagent/llm";
import { logger } from "@homeagent/shared";
import type { LlmClient } from "./llm.ts";

const log = logger.child("cli-client");

/** A provider call completed, but its text could not satisfy the caller's JSON contract. */
export class CliCompletionError extends Error {
  constructor(
    message: string,
    readonly usage: CompletionUsage,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "CliCompletionError";
  }
}

export type RunProviderFn = (
  id: ProviderId,
  input: {
    prompt: string;
    system?: string;
    model?: string;
    reasoningEffort?: CodexReasoningEffort;
    images?: CompleteOptions["images"];
    skills?: string[];
    execution?: ProviderExecution;
  },
  timeoutMs?: number,
  signal?: AbortSignal,
) => Promise<string | ProviderRunResult>;

function normalizeProviderResult(
  output: string | ProviderRunResult,
  fallbackModel: string,
): CompleteResult {
  if (typeof output === "string") {
    return {
      text: output.trim(),
      model: fallbackModel,
      usage: { costBasis: "unavailable", source: "legacy-text" },
    };
  }
  return {
    text: output.text.trim(),
    model: output.model ?? fallbackModel,
    usage: { ...output.usage },
  };
}

const unavailableUsage = (): CompletionUsage => ({
  costBasis: "unavailable",
  source: "legacy-text",
});

function recordCliCall(input: {
  provider: ProviderId;
  fallbackModel: string;
  purpose: CallPurpose;
  space?: string;
  started: number;
  ok: boolean;
  result?: CompleteResult;
  failure?: unknown;
  dataDir?: string;
}): void {
  const usage = input.result?.usage
    ?? (input.failure instanceof ProviderRunError ? input.failure.usage : unavailableUsage());
  recordCall({
    t: new Date().toISOString(),
    model: input.result?.model ?? input.fallbackModel,
    purpose: input.purpose,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    costUsd: usage.costUsd,
    usage,
    provider: input.provider,
    space: input.space,
    ok: input.ok,
    ms: Date.now() - input.started,
  }, input.dataDir);
}

/** Extract the first JSON object/array from CLI stdout (handles code fences + prose). */
export function extractJson(raw: string): unknown {
  const text = raw.trim();
  // Prefer a fenced ```json ... ``` block when present.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1]!.trim() : text;
  // Try a direct parse first.
  try {
    return JSON.parse(candidate);
  } catch {
    // Fall back to the outermost {...} or [...] span.
    const start = candidate.search(/[{[]/);
    if (start === -1) throw new Error("no JSON found in CLI output");
    const open = candidate[start];
    const close = open === "{" ? "}" : "]";
    const end = candidate.lastIndexOf(close);
    if (end <= start) throw new Error("unbalanced JSON in CLI output");
    return JSON.parse(candidate.slice(start, end + 1));
  }
}

function jsonInstruction(schema: Record<string, unknown>): string {
  return [
    "",
    "严格要求：只输出一个 JSON，对应下面的 JSON Schema，不要输出任何解释、前后缀或 Markdown 代码块标记。",
    "## JSON Schema",
    JSON.stringify(schema),
  ].join("\n");
}

/**
 * Build an LlmClient that runs everything through a local CLI provider. `model`
 * is the model passed to the CLI (empty => the CLI's own default). `run` is
 * injectable for tests (defaults to the real spawn-based runProvider).
 * `timeoutMs` (optional) overrides the per-call timeout — tasks pass a larger
 * value since research runs longer than Q&A. Resolved native `skills` are only
 * forwarded with an explicit task execution grant; no-tools calls record them
 * as skipped instead of asking the provider to discover or execute them.
 * `accountingDataDir` keeps usage logs colocated with the owning engine.
 */
export function makeCliClient(
  provider: ProviderId,
  model: string | undefined,
  run: RunProviderFn = realRunProvider,
  timeoutMs?: number,
  reasoningEffort?: CodexReasoningEffort,
  signal?: AbortSignal,
  execution?: ProviderExecution,
  skills: string[] = execution?.skills ?? [],
  accountingDataDir?: string,
): LlmClient {
  // The model is fixed at construction (the engine already resolved it from the
  // space's agent / global default). We deliberately IGNORE per-call opts.model:
  // ask/dream pass network-gateway tier names (e.g. "claude-sonnet-5",
  // config().modelFast) that a local CLI doesn't recognize and would reject.
  // Empty model => the CLI's own default.
  const cliModel = model || undefined;
  // Fold the system prompt into the user prompt: not every CLI honors a system
  // flag (claude does via --append-system-prompt, but codex/trae-cli don't), so
  // prepending guarantees the persona/instructions reach the model everywhere.
  const withSystem = (system: string | undefined, body: string) =>
    system?.trim() ? `${system.trim()}\n\n${body}` : body;

  return {
    async complete(opts: CompleteOptions): Promise<CompleteResult> {
      const base = opts.prompt ?? (opts.messages ?? []).map((m) => m.content).join("\n\n");
      const prompt = withSystem(opts.system, base);
      const purpose = opts.purpose ?? "other";
      const decision = checkBudget(purpose, undefined, accountingDataDir);
      if (!decision.allowed) throw new BudgetExceededError(decision);
      const started = Date.now();
      let result: CompleteResult | undefined;
      let failure: unknown;
      let ok = false;
      try {
        const out = await run(
          provider,
          {
            prompt,
            system: opts.system,
            model: cliModel,
            reasoningEffort,
            images: opts.images,
            skills: [...skills],
            execution,
          },
          timeoutMs,
          signal,
        );
        result = normalizeProviderResult(out, cliModel ?? provider);
        ok = true;
        return result;
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        recordCliCall({
          provider,
          fallbackModel: cliModel ?? provider,
          purpose,
          space: opts.space,
          started,
          ok,
          result,
          failure,
          dataDir: accountingDataDir,
        });
      }
    },

    async completeJSON<T>(opts: JSONOptions<T>): Promise<{ value: T; result: CompleteResult }> {
      const base = opts.prompt ?? (opts.messages ?? []).map((m) => m.content).join("\n\n");
      const prompt = withSystem(opts.system, base) + jsonInstruction(opts.schema);
      const purpose = opts.purpose ?? "other";
      const decision = checkBudget(purpose, undefined, accountingDataDir);
      if (!decision.allowed) throw new BudgetExceededError(decision);
      const started = Date.now();
      let result: CompleteResult | undefined;
      let failure: unknown;
      let ok = false;
      try {
        const out = await run(
          provider,
          {
            prompt,
            system: opts.system,
            model: cliModel,
            reasoningEffort,
            images: opts.images,
            skills: [...skills],
            execution,
          },
          timeoutMs,
          signal,
        );
        result = normalizeProviderResult(out, cliModel ?? provider);
        let parsed: unknown;
        try {
          parsed = extractJson(result.text);
        } catch (err) {
          log.warn("CLI JSON parse failed", { provider, err: String(err) });
          throw new CliCompletionError(
            `provider ${provider} did not return parseable JSON`,
            result.usage ?? unavailableUsage(),
            err,
          );
        }
        let value: T;
        try {
          value = opts.validate ? opts.validate(parsed) : (parsed as T);
        } catch (err) {
          throw new CliCompletionError(
            err instanceof Error ? err.message : String(err),
            result.usage ?? unavailableUsage(),
            err,
          );
        }
        ok = true;
        return { value, result: { ...result, text: "" } };
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        recordCliCall({
          provider,
          fallbackModel: cliModel ?? provider,
          purpose,
          space: opts.space,
          started,
          ok,
          result,
          failure,
          dataDir: accountingDataDir,
        });
      }
    },
  };
}
