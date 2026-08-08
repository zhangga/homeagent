import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpaceId } from "@homeagent/shared";
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
    });
    store.startDeliveryAttempt(run.id, 130);
    store.deliveryFailed(run.id, "Feishu unavailable");

    expect(new ChatRunStore(dir).get(run.id)).toEqual(expect.objectContaining({
      status: "succeeded",
      finishedAt: 120,
      output: "这是模型输出",
      traceId: "trace_1",
      error: undefined,
      delivery: {
        status: "failed",
        attempts: 1,
        lastAttemptAt: 130,
        error: "Feishu unavailable",
      },
    }));
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
