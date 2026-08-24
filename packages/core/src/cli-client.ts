/**
 * A CLI-backed LlmClient. Instead of the network gateway, all LLM work is run
 * through a local agent CLI (claude / codex / trae-cli) via runProvider(). This
 * is the only LLM path in homeagent — there is no network-API fallback.
 *
 *   - complete(): the CLI's stdout is the answer text.
 *   - completeJSON(): Codex receives its schema through the native output
 *     contract; other CLIs receive a strict JSON instruction in the prompt.
 *     Core then parses and validates the final response at the domain seam.
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
export type CliCompletionFailureKind = "invalid_json" | "schema_validation";

export class CliCompletionError extends Error {
  constructor(
    message: string,
    readonly usage: CompletionUsage,
    readonly kind: CliCompletionFailureKind,
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
    workdir?: string;
    execution?: ProviderExecution;
    outputSchema?: Record<string, unknown>;
    maxTokens?: number;
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
  dataDir: string;
}): void {
  const usage = input.result?.usage
    ?? (input.failure instanceof ProviderRunError ? input.failure.usage : unavailableUsage());
  try {
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
  } catch (error) {
    log.warn("CLI usage accounting persistence failed", {
      provider: input.provider,
      err: String(error),
    });
  }
}

/** Extract the first JSON object/array from CLI stdout (handles code fences + prose). */
export function extractJson(raw: string): unknown {
  const text = raw.trim();
  // Parse the complete payload before looking for a wrapper. Generated JSON
  // string fields may legitimately contain Markdown code fences, and treating
  // those inner fences as the outer response corrupts an otherwise valid value.
  try {
    return JSON.parse(text);
  } catch {
    // Continue with compatibility recovery for providers that wrap JSON.
  }

  // Only accept a standard unlabeled/JSON fence. A language fence inside
  // surrounding prose is content, not a structured response wrapper.
  const fence = text.match(/```(?:json[ \t]*)?\r?\n([\s\S]*?)```/i);
  const candidate = fence ? fence[1]!.trim() : text;
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
 * value since research runs longer than Q&A. Resolved native `skills` are
 * forwarded with Chat/Task execution grants; background no-tools calls record
 * them as skipped instead of asking the provider to execute them.
 * `accountingDataDir` is required so callers cannot silently write usage into
 * the process-wide default data directory.
 */
export function makeCliClient(
  provider: ProviderId,
  model: string | undefined,
  accountingDataDir: string,
  run: RunProviderFn = realRunProvider,
  timeoutMs?: number,
  reasoningEffort?: CodexReasoningEffort,
  signal?: AbortSignal,
  execution?: ProviderExecution,
  skills: string[] = execution?.skills ?? [],
  workdir?: string,
): LlmClient {
  if (typeof accountingDataDir !== "string" || !accountingDataDir.trim()) {
    throw new Error("accounting data directory is required");
  }
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
            workdir,
            execution,
            maxTokens: opts.maxTokens,
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
      const structuredPrompt = withSystem(opts.system, base);
      const prompt = provider === "codex"
        ? structuredPrompt
        : structuredPrompt + jsonInstruction(opts.schema);
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
            workdir,
            execution,
            ...(provider === "codex" ? { outputSchema: opts.schema } : {}),
            maxTokens: opts.maxTokens,
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
            "invalid_json",
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
            "schema_validation",
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
