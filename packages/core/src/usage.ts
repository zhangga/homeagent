import {
  BudgetExceededError,
  ProviderRunError,
  type CompletionUsage,
  type JSONOptions,
} from "@homeagent/llm";
import type { LlmClient } from "./llm.ts";

export type AggregatedCostBasis = CompletionUsage["costBasis"] | "mixed";

/**
 * Honest aggregate for a multi-call operation. Optional totals mean that at
 * least one provider reported that metric; the coverage counters make partial
 * aggregates explicit instead of silently treating missing usage as zero.
 */
export interface AggregatedRunUsage {
  calls: number;
  knownTokenCalls: number;
  unknownTokenCalls: number;
  knownCostCalls: number;
  unknownCostCalls: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  costUsd?: number;
  costBasis: AggregatedCostBasis;
  sources: CompletionUsage["source"][];
}

const COST_BASES = new Set<AggregatedCostBasis>([
  "reported",
  "estimated",
  "unavailable",
  "mixed",
]);
const USAGE_SOURCES = new Set<CompletionUsage["source"]>([
  "claude-json",
  "codex-jsonl",
  "trae-text",
  "gateway",
  "legacy-text",
]);

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isOptionalNonNegativeNumber(value: unknown): boolean {
  return value === undefined
    || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function isOptionalTokenCount(value: unknown): boolean {
  return value === undefined || isCount(value);
}

export function isAggregatedRunUsage(value: unknown): value is AggregatedRunUsage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const usage = value as Partial<AggregatedRunUsage>;
  const tokenTotals = TOKEN_FIELDS.filter((field) => usage[field] !== undefined).length;
  return isCount(usage.calls)
    && isCount(usage.knownTokenCalls)
    && isCount(usage.unknownTokenCalls)
    && usage.knownTokenCalls + usage.unknownTokenCalls === usage.calls
    && (usage.knownTokenCalls === 0 ? tokenTotals === 0 : tokenTotals > 0)
    && isCount(usage.knownCostCalls)
    && isCount(usage.unknownCostCalls)
    && usage.knownCostCalls + usage.unknownCostCalls === usage.calls
    && TOKEN_FIELDS.every((field) => isOptionalTokenCount(usage[field]))
    && isOptionalNonNegativeNumber(usage.costUsd)
    && typeof usage.costBasis === "string"
    && COST_BASES.has(usage.costBasis as AggregatedCostBasis)
    && Array.isArray(usage.sources)
    && usage.sources.length <= 10
    && usage.sources.length <= usage.calls
    && usage.sources.every((source) => (
      typeof source === "string"
      && USAGE_SOURCES.has(source as CompletionUsage["source"])
    ))
    && new Set(usage.sources).size === usage.sources.length
    && (usage.knownTokenCalls > 0 || usage.knownCostCalls > 0
      ? usage.sources.length > 0
      : true)
    && (usage.costBasis !== "mixed" || usage.knownCostCalls >= 2)
    && (usage.knownCostCalls > 0
      ? usage.costUsd !== undefined && usage.costBasis !== "unavailable"
      : usage.costUsd === undefined && usage.costBasis === "unavailable");
}

export function cloneAggregatedRunUsage(usage: AggregatedRunUsage): AggregatedRunUsage {
  return { ...usage, sources: [...usage.sources] };
}

const TOKEN_FIELDS = [
  "inputTokens",
  "cachedInputTokens",
  "cacheCreationInputTokens",
  "outputTokens",
  "reasoningTokens",
] as const;

export class RunUsageAccumulator {
  private readonly usages: (CompletionUsage | undefined)[] = [];

  record(usage?: CompletionUsage): void {
    this.usages.push(validCompletionUsage(usage));
  }

  snapshot(): AggregatedRunUsage {
    const aggregate: AggregatedRunUsage = {
      calls: this.usages.length,
      knownTokenCalls: 0,
      unknownTokenCalls: 0,
      knownCostCalls: 0,
      unknownCostCalls: 0,
      costBasis: "unavailable",
      sources: [],
    };
    const sources = new Set<CompletionUsage["source"]>();
    const knownCostBases = new Set<CompletionUsage["costBasis"]>();
    for (const usage of this.usages) {
      if (usage) sources.add(usage.source);
      const hasTokens = usage !== undefined
        && TOKEN_FIELDS.some((field) => usage[field] !== undefined);
      if (hasTokens) aggregate.knownTokenCalls += 1;
      else aggregate.unknownTokenCalls += 1;
      if (usage?.costUsd !== undefined) {
        aggregate.knownCostCalls += 1;
        knownCostBases.add(usage.costBasis);
        aggregate.costUsd = (aggregate.costUsd ?? 0) + usage.costUsd;
      } else {
        aggregate.unknownCostCalls += 1;
      }
      if (!usage) continue;
      for (const field of TOKEN_FIELDS) {
        const value = usage[field];
        if (value !== undefined) aggregate[field] = (aggregate[field] ?? 0) + value;
      }
    }
    aggregate.sources = [...sources].sort();
    if (knownCostBases.size === 1) {
      aggregate.costBasis = [...knownCostBases][0]!;
    } else if (knownCostBases.size > 1) {
      aggregate.costBasis = "mixed";
    }
    return aggregate;
  }
}

function validCompletionUsage(value: unknown): CompletionUsage | undefined {
  const usage = value;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return undefined;
  const candidate = usage as Partial<CompletionUsage>;
  if (
    !["reported", "estimated", "unavailable"].includes(String(candidate.costBasis))
    || !USAGE_SOURCES.has(candidate.source as CompletionUsage["source"])
    || TOKEN_FIELDS.some((field) => !isOptionalTokenCount(candidate[field]))
    || !isOptionalNonNegativeNumber(candidate.costUsd)
    || (candidate.costUsd === undefined) !== (candidate.costBasis === "unavailable")
  ) {
    return undefined;
  }
  return { ...candidate } as CompletionUsage;
}

function usageFromError(error: unknown): CompletionUsage | undefined {
  if (!error || typeof error !== "object" || Array.isArray(error)) return undefined;
  return validCompletionUsage(
    error instanceof ProviderRunError
      ? error.usage
      : (error as { usage?: unknown }).usage,
  );
}

/** Observe every logical LLM call, including failures with provider usage. */
export function observeLlmUsage(
  client: LlmClient,
  record: (usage?: CompletionUsage) => void,
  onExecutionEvidence?: import("@homeagent/llm").RunInput["onExecutionEvidence"],
): LlmClient {
  return {
    async complete(options) {
      try {
        const result = await client.complete(onExecutionEvidence ? { ...options, onExecutionEvidence } : options);
        record(result.usage);
        return result;
      } catch (error) {
        if (!(error instanceof BudgetExceededError)) {
          record(usageFromError(error));
        }
        throw error;
      }
    },
    async completeJSON<T>(options: JSONOptions<T>) {
      try {
        const output = await client.completeJSON<T>(onExecutionEvidence ? { ...options, onExecutionEvidence } : options);
        record(output.result.usage);
        return output;
      } catch (error) {
        if (!(error instanceof BudgetExceededError)) {
          record(usageFromError(error));
        }
        throw error;
      }
    },
  };
}
