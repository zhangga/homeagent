import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpaceId } from "@homeagent/shared";
import type { ResolvedExecutionPlan } from "./execution-plan.ts";
import {
  ChatRunStore,
  MAX_CHAT_RUN_HISTORY_PER_AGENT,
  MAX_CHAT_RUN_INPUT_CHARACTERS,
} from "./chat-runs.ts";

let dir: string;
const SPACE: SpaceId = "team/oc_chat_runs";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ha-chat-runs-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("ChatRunStore", () => {
  test("persists queued work and only marks it running when admitted", () => {
    const store = new ChatRunStore(dir);
    const queued = store.start({
      space: SPACE,
      input: "queued chat",
      trigger: "message",
      startedAt: 100,
    });

    expect(queued).toEqual(expect.objectContaining({
      status: "queued",
      priority: "interactive",
      queuedAt: 100,
    }));
    expect(new ChatRunStore(dir, { recoverInterrupted: true }).get(queued.id)?.status)
      .toBe("queued");

    const running = store.begin(queued.id, 120);
    expect(running).toEqual(expect.objectContaining({
      status: "running",
      queuedAt: 100,
      runStartedAt: 120,
    }));
  });

  test("persists the source and execution snapshot captured when a run starts", () => {
    const store = new ChatRunStore(dir);
    const run = store.start({
      space: SPACE,
      rawId: "raw_1",
      chatId: "oc_chat_runs",
      messageId: "om_1",
      author: "ou_user",
      input: "总结今天的讨论",
      trigger: "message",
      agentId: "agent_codex",
      provider: "codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      skillEvidence: {
        requested: [{ kind: "legacy-name", name: "meeting-summary" }],
        resolved: [{
          sourceKey: "codex-user:meeting-summary",
          name: "meeting-summary",
          invocationName: "meeting-summary",
          reference: "skill://meeting-summary",
          skillFileHash: "a".repeat(64),
        }],
        skipped: [],
      },
      execution: {
        permission: "read-only",
        skills: ["meeting-summary"],
      },
      startedAt: 100,
    });

    expect(new ChatRunStore(dir).get(run.id)).toEqual({
      id: expect.stringMatching(/^chat_run_/),
      space: SPACE,
      rawId: "raw_1",
      chatId: "oc_chat_runs",
      messageId: "om_1",
      author: "ou_user",
      input: "总结今天的讨论",
      trigger: "message",
      agentId: "agent_codex",
      provider: "codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      skillEvidence: {
        requested: [{ kind: "legacy-name", name: "meeting-summary" }],
        resolved: [{
          sourceKey: "codex-user:meeting-summary",
          name: "meeting-summary",
          invocationName: "meeting-summary",
          reference: "skill://meeting-summary",
          skillFileHash: "a".repeat(64),
        }],
        skipped: [],
      },
      execution: {
        permission: "read-only",
        skills: ["meeting-summary"],
      },
      priority: "interactive",
      status: "queued",
      delivery: { status: "pending", attempts: 0 },
      queuedAt: 100,
      startedAt: 100,
    });
  });

  test("persists a resolved Chat execution plan without a ProviderExecution", () => {
    const store = new ChatRunStore(dir);
    const executionPlan: ResolvedExecutionPlan = {
      version: 1,
      instruction: "Use the original chat persona.",
      provider: "codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
    };

    const run = store.start({
      space: SPACE,
      input: "queued chat",
      trigger: "message",
      executionPlan,
      startedAt: 100,
    });

    expect(new ChatRunStore(dir).get(run.id)?.executionPlan).toEqual(executionPlan);
    expect(JSON.parse(readFileSync(join(dir, "config", "chat-runs.json"), "utf8")).version)
      .toBe(5);
  });

  test("rejects an invalid resolved execution plan before persisting a run", () => {
    const store = new ChatRunStore(dir);

    expect(() => store.start({
      space: SPACE,
      input: "queued chat",
      trigger: "message",
      executionPlan: {
        version: 1,
        instruction: "Use a chat Skill.",
        execution: {
          permission: "read-only",
          skills: ["not a valid skill"],
        },
      },
    })).toThrow("Resolved execution plan");
    expect(store.list()).toEqual([]);
  });

  test("rejects a Chat execution plan that grants provider execution", () => {
    const store = new ChatRunStore(dir);

    expect(() => store.start({
      space: SPACE,
      input: "ordinary chat",
      trigger: "message",
      executionPlan: {
        version: 1,
        instruction: "Answer only.",
        provider: "claude",
        execution: {
          permission: "read-only",
          skills: [],
        },
      },
    })).toThrow("must not grant provider execution");
    expect(store.list()).toEqual([]);
  });

  test("continues to load version 2 history without an execution plan", () => {
    const store = new ChatRunStore(dir);
    const run = store.start({
      space: SPACE,
      input: "legacy chat",
      trigger: "message",
      startedAt: 100,
    });
    const path = join(dir, "config", "chat-runs.json");
    const legacy = JSON.parse(readFileSync(path, "utf8")) as {
      version: number;
      runs: Record<string, Record<string, unknown>>;
    };
    legacy.version = 2;
    delete legacy.runs[run.id]!.executionPlan;
    writeFileSync(path, JSON.stringify(legacy), "utf8");

    expect(new ChatRunStore(dir).get(run.id)).toBeDefined();
  });

  test("recovers an interrupted running record as a typed durable failure", () => {
    const store = new ChatRunStore(dir);
    const run = store.start({
      space: SPACE,
      rawId: "raw_interrupted",
      input: "继续分析",
      trigger: "message",
      startedAt: 100,
    });
    store.begin(run.id, 110);

    expect(new ChatRunStore(dir).get(run.id)?.status).toBe("running");

    const reopened = new ChatRunStore(dir, { recoverInterrupted: true });

    expect(reopened.get(run.id)).toEqual(expect.objectContaining({
      status: "failed",
      finishedAt: expect.any(Number),
      error: {
        kind: "interrupted",
        message: expect.any(String),
      },
    }));
  });

  test("persists provider success before tracking delivery attempts separately", () => {
    const store = new ChatRunStore(dir);
    const run = store.start({
      space: SPACE,
      rawId: "raw_delivery",
      input: "给出结论",
      trigger: "message",
      startedAt: 100,
    });

    store.succeed(run.id, {
      finishedAt: 120,
      output: "这是模型输出",
      traceId: "trace_1",
      usage: {
        calls: 2,
        knownTokenCalls: 1,
        unknownTokenCalls: 1,
        knownCostCalls: 1,
        unknownCostCalls: 1,
        inputTokens: 80,
        outputTokens: 20,
        costUsd: 0.004,
        costBasis: "reported",
        sources: ["claude-json", "trae-text"],
      },
    });
    store.startDeliveryAttempt(run.id, 130);
    store.deliveryFailed(run.id, "Feishu unavailable");

    expect(new ChatRunStore(dir).get(run.id)).toEqual(expect.objectContaining({
      status: "succeeded",
      finishedAt: 120,
      output: "这是模型输出",
      traceId: "trace_1",
      usage: {
        calls: 2,
        knownTokenCalls: 1,
        unknownTokenCalls: 1,
        knownCostCalls: 1,
        unknownCostCalls: 1,
        inputTokens: 80,
        outputTokens: 20,
        costUsd: 0.004,
        costBasis: "reported",
        sources: ["claude-json", "trae-text"],
      },
      error: undefined,
      delivery: {
        status: "failed",
        attempts: 1,
        lastAttemptAt: 130,
        error: "Feishu unavailable",
      },
    }));
  });

  test("raw cleanup removes active generation but preserves an in-flight delivery audit", () => {
    const store = new ChatRunStore(dir);
    const generating = store.start({
      space: SPACE,
      rawId: "raw_generating",
      input: "still generating",
      trigger: "message",
      startedAt: 100,
    });
    store.begin(generating.id, 101);
    const delivering = store.start({
      space: SPACE,
      rawId: "raw_delivering",
      input: "already generated",
      trigger: "message",
      startedAt: 110,
    });
    store.succeed(delivering.id, { finishedAt: 120, output: "reply" });
    store.startDeliveryAttempt(delivering.id, 121);

    expect(store.removeByRawIds(new Set(["raw_generating", "raw_delivering"]))).toBe(1);
    expect(store.get(generating.id)).toBeUndefined();
    expect(store.get(delivering.id)).toEqual(expect.objectContaining({
      delivery: expect.objectContaining({ status: "pending", attempts: 1 }),
    }));

    store.deliverySent(delivering.id, 130);
    expect(store.removeByRawIds(new Set(["raw_delivering"]))).toBe(1);
    expect(store.get(delivering.id)).toBeUndefined();
  });

  test("persists a typed provider failure for diagnosis and retry", () => {
    const store = new ChatRunStore(dir);
    const run = store.start({
      space: SPACE,
      rawId: "raw_failed",
      input: "分析失败原因",
      trigger: "message",
      startedAt: 100,
    });

    store.fail(run.id, {
      finishedAt: 120,
      error: {
        kind: "authentication",
        message: "Provider authentication expired",
      },
    });

    expect(new ChatRunStore(dir).get(run.id)).toEqual(expect.objectContaining({
      status: "failed",
      finishedAt: 120,
      error: {
        kind: "authentication",
        message: "Provider authentication expired",
      },
    }));
  });

  test("terminal transitions cannot rewrite an existing terminal outcome", () => {
    const store = new ChatRunStore(dir);
    const cancelled = store.start({
      space: SPACE,
      input: "cancel this answer",
      trigger: "message",
      startedAt: 100,
    });
    store.cancel(cancelled.id, {
      finishedAt: 110,
      error: { kind: "cancelled", message: "cancelled by user" },
    });
    const cancelledSnapshot = store.get(cancelled.id);

    expect(store.succeed(cancelled.id, {
      finishedAt: 120,
      output: "late provider output",
    })).toBeUndefined();
    expect(store.get(cancelled.id)).toEqual(cancelledSnapshot);

    const succeeded = store.start({
      space: SPACE,
      input: "finish once",
      trigger: "message",
      startedAt: 200,
    });
    store.succeed(succeeded.id, {
      finishedAt: 210,
      output: "durable answer",
    });
    const succeededSnapshot = store.get(succeeded.id);

    expect(store.fail(succeeded.id, {
      finishedAt: 220,
      error: { kind: "process_exit", message: "late failure" },
    })).toBeUndefined();
    expect(store.get(succeeded.id)).toEqual(succeededSnapshot);
  });

  test("persists quality trace evidence with a provider failure", () => {
    const store = new ChatRunStore(dir);
    const run = store.start({
      space: SPACE,
      input: "diagnose the provider failure",
      trigger: "message",
      startedAt: 100,
    });
    store.begin(run.id, 101);

    store.fail(run.id, {
      finishedAt: 120,
      error: { kind: "process_exit", message: "provider exited 1" },
      traceId: "answer_failed_1",
      usage: {
        calls: 1,
        knownTokenCalls: 1,
        unknownTokenCalls: 0,
        knownCostCalls: 1,
        unknownCostCalls: 0,
        inputTokens: 60,
        outputTokens: 7,
        costUsd: 0.006,
        costBasis: "reported",
        sources: ["claude-json"],
      },
    });

    expect(new ChatRunStore(dir).get(run.id)).toEqual(expect.objectContaining({
      status: "failed",
      traceId: "answer_failed_1",
      usage: expect.objectContaining({
        calls: 1,
        inputTokens: 60,
        outputTokens: 7,
        costUsd: 0.006,
        sources: ["claude-json"],
      }),
    }));
  });

  test("bounds retryable input while recording that it was truncated", () => {
    const store = new ChatRunStore(dir);
    const run = store.start({
      space: SPACE,
      rawId: "raw_large",
      input: "x".repeat(MAX_CHAT_RUN_INPUT_CHARACTERS + 1),
      trigger: "message",
    });

    expect(new ChatRunStore(dir).get(run.id)).toEqual(expect.objectContaining({
      input: "x".repeat(MAX_CHAT_RUN_INPUT_CHARACTERS),
      inputTruncated: true,
    }));
  });

  test("retains the latest completed Chat Runs per Agent", () => {
    const store = new ChatRunStore(dir);
    for (let index = 0; index <= MAX_CHAT_RUN_HISTORY_PER_AGENT; index += 1) {
      const run = store.start({
        space: SPACE,
        input: `message ${index}`,
        trigger: "message",
        agentId: "agent_history",
        startedAt: index + 1,
      });
      store.succeed(run.id, {
        finishedAt: run.startedAt,
        output: `answer ${index}`,
      });
    }

    const runs = new ChatRunStore(dir).listByAgent("agent_history", 200);
    expect(runs).toHaveLength(MAX_CHAT_RUN_HISTORY_PER_AGENT);
    expect(runs[0]?.input).toBe(`message ${MAX_CHAT_RUN_HISTORY_PER_AGENT}`);
    expect(runs.at(-1)?.input).toBe("message 1");
  });
});
