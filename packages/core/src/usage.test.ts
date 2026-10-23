import { describe, expect, test } from "bun:test";
import {
  BudgetExceededError,
  ProviderRunError,
  type CompleteResult,
  type JSONOptions,
} from "@homeagent/llm";
import type { LlmClient } from "./llm.ts";
import type { ProviderProgressEvent } from "@homeagent/shared";
import {
  isAggregatedRunUsage,
  observeLlmUsage,
  RunUsageAccumulator,
} from "./usage.ts";

describe("run usage aggregation", () => {
  test("streams explicitly public execution updates during JSON synthesis without exposing JSON or routing text", async () => {
    const seen: ProviderProgressEvent[] = [];
    const client: LlmClient = {
      async complete() { return { text: "", model: "fake" }; },
      async completeJSON<T>(options: JSONOptions<T>) {
        for (const text of ["执行进展：已取得 28 条消息，继续翻页。", '{"answer":"PRIVATE_FINAL_JSON"}', "执行进展：{\"answer\":\"PRIVATE_MARKED_JSON\"}", "PRIVATE_UNMARKED_TEXT"]) {
          await options.onProgress?.({ kind: "assistant_snapshot", at: 100, title: "正在生成回答", phase: "answer", delta: text });
        }
        throw new Error("fixture completion");
      },
    };
    const observed = observeLlmUsage(client, () => {}, undefined, event => { seen.push(event); });
    await expect(observed.completeJSON({ schema: {}, prompt: "route" })).rejects.toThrow();
    await expect(observed.completeJSON({ schema: {}, prompt: "answer", publicAssistantProgress: true })).rejects.toThrow();
    expect(seen.map(event => event.delta)).toEqual(["已取得 28 条消息，继续翻页。"]);
    expect(seen[0]?.title).toBe("执行进展");
  });
  test("publishes answer summaries but keeps routing summaries and structured JSON private", async () => {
    const seen: ProviderProgressEvent[] = [];
    const client: LlmClient = {
      async complete() { return { text: "", model: "fake" }; },
      async completeJSON<T>(options: JSONOptions<T>) {
        await options.onProgress?.({ kind: "reasoning_summary", at: 100, title: "思考摘要", phase: "provider", delta: options.publicReasoningSummary ? "正在核对回答依据。" : "PRIVATE_ROUTING_SUMMARY" });
        await options.onProgress?.({ kind: "assistant_snapshot", at: 101, title: "结构化结果", delta: "PRIVATE_JSON" });
        throw new Error("test completion");
      },
    };
    const observed = observeLlmUsage(client, () => {}, undefined, event => { seen.push(event); });
    await expect(observed.completeJSON({ schema: {}, prompt: "route" })).rejects.toThrow("test completion");
    await expect(observed.completeJSON({ schema: {}, prompt: "answer", publicReasoningSummary: true })).rejects.toThrow("test completion");
    expect(seen.map(event => event.delta)).toEqual(["正在核对回答依据。"]);
  });
  test("publishes public completion notes but suppresses internal structured routing text", async () => {
    const seen: ProviderProgressEvent[] = [];
    const emit = async (options: { onProgress?: (event: ProviderProgressEvent) => void | Promise<void> }, text: string) => {
      await options.onProgress?.({ kind: "assistant_snapshot", at: 100, title: "公开说明", delta: text });
      await options.onProgress?.({ kind: "phase", at: 101, title: "Provider 执行完成", phase: "provider" });
    };
    const client: LlmClient = {
      async complete(options) {
        await emit(options, "先核对构建状态");
        return { text: "完成", model: "fake" };
      },
      async completeJSON<T>(options: JSONOptions<T>) {
        await emit(options, "PRIVATE_ROUTING_JSON");
        throw new Error("routing stopped");
      },
    };
    const observed = observeLlmUsage(client, () => {}, undefined, event => { seen.push(event); });
    await observed.complete({ prompt: "answer" });
    await expect(observed.completeJSON({ prompt: "route", schema: {} })).rejects.toThrow("routing stopped");
    expect(seen.map(event => event.delta ?? event.title)).toEqual(["先核对构建状态", "Provider 执行完成", "Provider 执行完成"]);
    expect(seen.at(-1)?.visibility).toBe("operator");
  });
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
