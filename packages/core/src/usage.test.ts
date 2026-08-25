import { describe, expect, test } from "bun:test";
import {
  BudgetExceededError,
  ProviderRunError,
  type CompleteResult,
  type JSONOptions,
} from "@homeagent/llm";
import type { LlmClient } from "./llm.ts";
import {
  isAggregatedRunUsage,
  observeLlmUsage,
  RunUsageAccumulator,
} from "./usage.ts";

describe("run usage aggregation", () => {
  test("keeps partial token and cost coverage explicit", () => {
    const accumulator = new RunUsageAccumulator();
    accumulator.record({
      inputTokens: 100,
      cachedInputTokens: 40,
      outputTokens: 20,
      costUsd: 0.01,
      costBasis: "reported",
      source: "claude-json",
    });
    accumulator.record({ costBasis: "unavailable", source: "trae-text" });

    const usage = accumulator.snapshot();

    expect(usage).toEqual({
      calls: 2,
      knownTokenCalls: 1,
      unknownTokenCalls: 1,
      knownCostCalls: 1,
      unknownCostCalls: 1,
      inputTokens: 100,
      cachedInputTokens: 40,
      outputTokens: 20,
      costUsd: 0.01,
      costBasis: "reported",
      sources: ["claude-json", "trae-text"],
    });
    expect(isAggregatedRunUsage(usage)).toBeTrue();
  });

  test("records provider-reported usage when a logical call fails", async () => {
    const calls: Array<Parameters<RunUsageAccumulator["record"]>[0]> = [];
    const failed: LlmClient = {
      async complete(): Promise<CompleteResult> {
        throw new ProviderRunError("claude", "rate limited", {
          inputTokens: 30,
          costUsd: 0.002,
          costBasis: "reported",
          source: "claude-json",
        });
      },
      async completeJSON<T>(_options: JSONOptions<T>) {
        throw new Error("not used");
      },
    };
    const observed = observeLlmUsage(failed, (usage) => calls.push(usage));

    await expect(observed.complete({ prompt: "hello" })).rejects.toThrow("rate limited");

    expect(calls).toEqual([{
      inputTokens: 30,
      costUsd: 0.002,
      costBasis: "reported",
      source: "claude-json",
    }]);
  });

  test("does not count an external cost-admission rejection as a provider call", async () => {
    const calls: unknown[] = [];
    const blocked: LlmClient = {
      async complete(): Promise<CompleteResult> {
        throw new BudgetExceededError({
          allowed: false,
          enforced: true,
          referenceExceeded: true,
          spent: 1,
          budget: 1,
          unknownCostCalls: 0,
          accountingComplete: true,
        });
      },
      async completeJSON<T>(_options: JSONOptions<T>) {
        throw new Error("not used");
      },
    };
    const observed = observeLlmUsage(blocked, (usage) => calls.push(usage));

    await expect(observed.complete({ prompt: "hello" })).rejects.toBeInstanceOf(
      BudgetExceededError,
    );

    expect(calls).toEqual([]);
  });

  test("rejects aggregates whose coverage contradicts their totals or provenance", () => {
    const base = {
      calls: 1,
      knownTokenCalls: 0,
      unknownTokenCalls: 1,
      knownCostCalls: 0,
      unknownCostCalls: 1,
      costBasis: "unavailable" as const,
      sources: ["codex-jsonl" as const],
    };

    expect(isAggregatedRunUsage({ ...base, inputTokens: 999 })).toBeFalse();
    expect(isAggregatedRunUsage({
      ...base,
      knownTokenCalls: 1,
      unknownTokenCalls: 0,
    })).toBeFalse();
    expect(isAggregatedRunUsage({
      ...base,
      calls: 0,
      unknownTokenCalls: 0,
      unknownCostCalls: 0,
    })).toBeFalse();
    expect(isAggregatedRunUsage({
      ...base,
      knownTokenCalls: 1,
      unknownTokenCalls: 0,
      inputTokens: 1,
      sources: [],
    })).toBeFalse();
    expect(isAggregatedRunUsage({
      ...base,
      knownCostCalls: 1,
      unknownCostCalls: 0,
      costUsd: 0.01,
      costBasis: "mixed",
    })).toBeFalse();
    expect(isAggregatedRunUsage({
      ...base,
      knownTokenCalls: 1,
      unknownTokenCalls: 0,
      inputTokens: 1.5,
    })).toBeFalse();
  });

  test("does not trust malformed usage attached to a provider error", async () => {
    const calls: Array<Parameters<RunUsageAccumulator["record"]>[0]> = [];
    const failed: LlmClient = {
      async complete(): Promise<CompleteResult> {
        throw new ProviderRunError("claude", "bad usage", {
          inputTokens: 1.5,
          costUsd: 0.01,
          costBasis: "unavailable",
          source: "claude-json",
        });
      },
      async completeJSON<T>(_options: JSONOptions<T>) {
        throw new Error("not used");
      },
    };

    await expect(observeLlmUsage(failed, (usage) => calls.push(usage)).complete({
      prompt: "hello",
    })).rejects.toThrow("bad usage");

    expect(calls).toEqual([undefined]);
  });
});
