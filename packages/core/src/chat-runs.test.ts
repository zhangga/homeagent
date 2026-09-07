import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SpaceId } from "@homeagent/shared";
import type { ResolvedExecutionPlan } from "./execution-plan.ts";
import {
  ChatRunStore,
  MAX_CHAT_RUN_HISTORY_PER_AGENT,
  MAX_CHAT_RUN_INPUT_CHARACTERS,
  MAX_TOPIC_NATIVE_SESSIONS_PER_SPACE,
  topicNativeSessionCompatibilityKey,
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
      timeoutMs: 7 * 60_000,
      startedAt: 100,
    });

    expect(new ChatRunStore(dir).get(run.id)?.executionPlan).toEqual(executionPlan);
    expect(new ChatRunStore(dir).get(run.id)?.timeoutMs).toBe(7 * 60_000);
    expect(JSON.parse(readFileSync(join(dir, "config", "chat-runs.json"), "utf8")).version)
      .toBe(6);
  });

  test("reuses a successfully delivered Feishu topic session after its Chat Run commit", () => {
    const store = new ChatRunStore(dir);
    const executionPlan: ResolvedExecutionPlan = {
      version: 1,
      agentRevisionId: "agent_revision_topic-v1",
      instruction: "Continue the Feishu topic naturally.",
      provider: "codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
    };
    const skillEvidence = {
      requested: [],
      resolved: [],
      skipped: [],
    };
    const compatibilityKey = topicNativeSessionCompatibilityKey({
      agentId: "agent_topic",
      executionPlan,
      skillEvidence,
    });
    const topicNativeSession = {
      kind: "feishu-topic" as const,
      chatId: "oc_chat_runs",
      rootMessageId: "om_root",
      threadId: "omt_thread",
      parentMessageId: "om_parent",
      provider: "codex" as const,
      compatibilityKey,
    };
    const first = store.start({
      space: SPACE,
      chatId: "oc_chat_runs",
      messageId: "om_first",
      input: "第一轮",
      trigger: "message",
      agentId: "agent_topic",
      executionPlan,
      skillEvidence,
      topicNativeSession,
      startedAt: 100,
    });
    store.begin(first.id, 101);

    expect(store.prepareTopicNativeSession(first.id)).toEqual({ mode: "start" });

    const firstSessionId = "11111111-2222-4333-8444-555555555555";
    store.succeed(first.id, {
      finishedAt: 110,
      output: "第一轮回答",
      nativeSessionId: firstSessionId,
    });
    store.deliverySent(first.id, 111);

    const reopened = new ChatRunStore(dir);
    const second = reopened.start({
      space: SPACE,
      chatId: "oc_chat_runs",
      messageId: "om_second",
      input: "第二轮",
      trigger: "message",
      agentId: "agent_topic",
      executionPlan,
      skillEvidence,
      topicNativeSession,
      startedAt: 120,
    });
    reopened.begin(second.id, 121);
    expect(reopened.prepareTopicNativeSession(second.id)).toEqual({
      mode: "fork",
      id: firstSessionId,
    });
    reopened.fail(second.id, {
      finishedAt: 130,
      error: { kind: "process_exit", message: "provider failed" },
    });

    const retry = new ChatRunStore(dir);
    const third = retry.start({
      space: SPACE,
      chatId: "oc_chat_runs",
      messageId: "om_third",
      input: "重试第二轮",
      trigger: "retry",
      agentId: "agent_topic",
      executionPlan,
      skillEvidence,
      topicNativeSession,
      startedAt: 140,
    });
    retry.begin(third.id, 141);
    expect(retry.prepareTopicNativeSession(third.id)).toEqual({
      mode: "fork",
      id: firstSessionId,
    });
  });

  test("does not restore a pending-delivery Provider turn as a reusable topic head", () => {
    const store = new ChatRunStore(dir);
    const executionPlan: ResolvedExecutionPlan = {
      version: 1,
      instruction: "Continue the Feishu topic naturally.",
      provider: "codex",
    };
    const topicNativeSession = {
      kind: "feishu-topic" as const,
      chatId: "oc_chat_runs",
      rootMessageId: "om_pending_root",
      provider: "codex" as const,
      compatibilityKey: topicNativeSessionCompatibilityKey({ executionPlan }),
    };
    const first = store.start({
      space: SPACE,
      chatId: "oc_chat_runs",
      messageId: "om_pending_first",
      input: "第一轮",
      trigger: "message",
      executionPlan,
      topicNativeSession,
      startedAt: 100,
    });
    store.begin(first.id, 101);
    expect(store.prepareTopicNativeSession(first.id)).toEqual({ mode: "start" });
    store.succeed(first.id, {
      finishedAt: 110,
      output: "尚未确认送达的回答",
      nativeSessionId: "11111111-2222-4333-8444-555555555555",
    });
    store.startDeliveryAttempt(first.id, 111);

    const reopened = new ChatRunStore(dir);
    const second = reopened.start({
      space: SPACE,
      chatId: "oc_chat_runs",
      messageId: "om_pending_second",
      input: "第二轮",
      trigger: "message",
      executionPlan,
      topicNativeSession,
      startedAt: 120,
    });
    reopened.begin(second.id, 121);

    expect(reopened.prepareTopicNativeSession(second.id)).toEqual({ mode: "start" });
  });

  test("keeps the retry plan behind a deep-cloned local-only seam", () => {
    const store = new ChatRunStore(dir);
    const executionPlan: ResolvedExecutionPlan = {
      version: 1,
      instruction: "Topic agent",
      provider: "codex",
    };
    const topicNativeSession = {
      kind: "feishu-topic" as const,
      chatId: "oc_chat_runs",
      rootMessageId: "om_root",
      threadId: "omt_thread",
      parentMessageId: "om_parent",
      provider: "codex" as const,
      compatibilityKey: topicNativeSessionCompatibilityKey({ executionPlan }),
    };
    const run = store.start({
      space: SPACE,
      chatId: "oc_chat_runs",
      messageId: "om_first",
      input: "first",
      trigger: "message",
      executionPlan,
      topicNativeSession,
      startedAt: 100,
    });

    expect(store.get(run.id)).not.toHaveProperty("topicNativeSession");
    const returned = store.topicNativeSessionForRun(run.id)!;
    returned.rootMessageId = "mutated";
    expect(store.topicNativeSessionForRun(run.id)).toEqual(topicNativeSession);
    expect(new ChatRunStore(dir).topicNativeSessionForRun(run.id)).toEqual(topicNativeSession);
  });

  test("normalizes Provider session UUIDs before persisting and comparing heads", () => {
    const store = new ChatRunStore(dir);
    const executionPlan: ResolvedExecutionPlan = {
      version: 1,
      instruction: "Topic agent",
      provider: "codex",
    };
    const topicNativeSession = {
      kind: "feishu-topic" as const,
      chatId: "oc_chat_runs",
      rootMessageId: "om_root",
      provider: "codex" as const,
      compatibilityKey: topicNativeSessionCompatibilityKey({ executionPlan }),
    };
    const first = store.start({
      space: SPACE,
      chatId: "oc_chat_runs",
      messageId: "om_first",
      input: "first",
      trigger: "message",
      executionPlan,
      topicNativeSession,
      startedAt: 100,
    });
    store.begin(first.id, 101);
    store.prepareTopicNativeSession(first.id);
    store.succeed(first.id, {
      finishedAt: 110,
      output: "done",
      nativeSessionId: "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE",
    });
    store.deliverySent(first.id, 111);

    const reopened = new ChatRunStore(dir);
    const second = reopened.start({
      space: SPACE,
      chatId: "oc_chat_runs",
      messageId: "om_second",
      input: "second",
      trigger: "message",
      executionPlan,
      topicNativeSession,
      startedAt: 120,
    });
    reopened.begin(second.id, 121);

    expect(reopened.prepareTopicNativeSession(second.id)).toEqual({
      mode: "fork",
      id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    });
    expect(() => reopened.succeed(second.id, {
      finishedAt: 130,
      output: "not a fork",
      nativeSessionId: "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE",
    })).toThrow("Provider did not fork the native session");
  });

  test("starts a fresh provider session for another topic or incompatible frozen plan", () => {
    const store = new ChatRunStore(dir);
    const plan: ResolvedExecutionPlan = {
      version: 1,
      instruction: "Original persona",
      provider: "codex",
      model: "gpt-5.6-sol",
    };
    const start = (
      messageId: string,
      rootMessageId: string,
      executionPlan = plan,
      startedAt = 100,
    ) => {
      const compatibilityKey = topicNativeSessionCompatibilityKey({ executionPlan });
      const run = store.start({
        space: SPACE,
        chatId: "oc_chat_runs",
        messageId,
        input: messageId,
        trigger: "message",
        executionPlan,
        topicNativeSession: {
          kind: "feishu-topic",
          chatId: "oc_chat_runs",
          rootMessageId,
          provider: "codex",
          compatibilityKey,
        },
        startedAt,
      });
      store.begin(run.id, startedAt + 1);
      return run;
    };

    const first = start("om_first", "om_root_a");
    expect(store.prepareTopicNativeSession(first.id)).toEqual({ mode: "start" });
    store.succeed(first.id, {
      finishedAt: 110,
      output: "done",
      nativeSessionId: "11111111-2222-4333-8444-555555555555",
    });
    store.deliverySent(first.id, 111);

    const otherTopic = start("om_other", "om_root_b", plan, 120);
    expect(store.prepareTopicNativeSession(otherTopic.id)).toEqual({ mode: "start" });
    store.fail(otherTopic.id, {
      finishedAt: 125,
      error: { kind: "unknown", message: "stop" },
    });

    const incompatiblePlan = { ...plan, instruction: "New persona" };
    const incompatible = start("om_changed", "om_root_a", incompatiblePlan, 130);
    expect(store.prepareTopicNativeSession(incompatible.id)).toEqual({ mode: "start" });
    expect(() => store.succeed(incompatible.id, {
      finishedAt: 140,
      output: "not fresh",
      nativeSessionId: "11111111-2222-4333-8444-555555555555",
    })).toThrow("Provider did not start a fresh native session");
  });

  test("rejects unbounded topic plans and malformed Provider session ids", () => {
    const store = new ChatRunStore(dir);
    const executionPlan: ResolvedExecutionPlan = {
      version: 1,
      instruction: "Topic agent",
      provider: "codex",
    };
    const compatibilityKey = topicNativeSessionCompatibilityKey({ executionPlan });
    const input = {
      space: SPACE,
      chatId: "oc_chat_runs",
      messageId: "om_first",
      input: "first",
      trigger: "message" as const,
      executionPlan,
      startedAt: 100,
    };
    expect(() => store.start({
      ...input,
      topicNativeSession: {
        kind: "feishu-topic",
        chatId: "oc_chat_runs",
        rootMessageId: "x".repeat(257),
        provider: "codex",
        compatibilityKey,
      },
    })).toThrow("invalid or exceeds persistence limits");
    expect(() => store.start({
      ...input,
      topicNativeSession: {
        kind: "feishu-topic",
        chatId: "oc_chat_runs",
        rootMessageId: "om_root",
        provider: "codex",
        compatibilityKey: "not-a-hash",
      },
    })).toThrow("invalid or exceeds persistence limits");

    const run = store.start({
      ...input,
      topicNativeSession: {
        kind: "feishu-topic",
        chatId: "oc_chat_runs",
        rootMessageId: "om_root",
        provider: "codex",
        compatibilityKey,
      },
    });
    store.begin(run.id, 101);
    store.prepareTopicNativeSession(run.id);
    expect(() => store.succeed(run.id, {
      finishedAt: 110,
      output: "done",
      nativeSessionId: "--dangerous-session-id",
    })).toThrow("Provider native session id is invalid");
    expect(store.get(run.id)?.status).toBe("running");
  });

  test("bounds persisted topic heads per Space with deterministic LRU eviction", () => {
    const store = new ChatRunStore(dir);
    const executionPlan: ResolvedExecutionPlan = {
      version: 1,
      instruction: "Topic agent",
      provider: "codex",
    };
    const compatibilityKey = topicNativeSessionCompatibilityKey({ executionPlan });
    const start = (rootMessageId: string, messageId: string, startedAt: number) => {
      const run = store.start({
        space: SPACE,
        chatId: "oc_chat_runs",
        messageId,
        input: messageId,
        trigger: "message",
        executionPlan,
        topicNativeSession: {
          kind: "feishu-topic",
          chatId: "oc_chat_runs",
          rootMessageId,
          provider: "codex",
          compatibilityKey,
        },
        startedAt,
      });
      store.begin(run.id, startedAt + 1);
      return run;
    };
    for (let index = 0; index <= MAX_TOPIC_NATIVE_SESSIONS_PER_SPACE; index += 1) {
      const run = start(`om_root_${index}`, `om_message_${index}`, 100 + index * 10);
      store.prepareTopicNativeSession(run.id);
      store.succeed(run.id, {
        finishedAt: 105 + index * 10,
        output: "done",
        nativeSessionId:
          `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
      });
      store.deliverySent(run.id, 106 + index * 10);
    }

    const oldest = start("om_root_0", "om_oldest_probe", 2_000);
    expect(store.prepareTopicNativeSession(oldest.id)).toEqual({ mode: "start" });
    const newest = start(
      `om_root_${MAX_TOPIC_NATIVE_SESSIONS_PER_SPACE}`,
      "om_newest_probe",
      2_010,
    );
    expect(store.prepareTopicNativeSession(newest.id)).toEqual({
      mode: "fork",
      id:
        `00000000-0000-4000-8000-${MAX_TOPIC_NATIVE_SESSIONS_PER_SPACE.toString(16).padStart(12, "0")}`,
    });
  });

  test("uses canonical frozen inputs for the topic compatibility key", () => {
    const executionPlan: ResolvedExecutionPlan = {
      version: 1,
      instruction: "Canonical topic agent",
      provider: "codex",
      model: "gpt-5.6-sol",
    };
    const first = topicNativeSessionCompatibilityKey({
      agentId: "agent_topic",
      executionPlan,
      skillEvidence: {
        requested: [],
        resolved: [{
          sourceKey: "codex-user:review",
          name: "review",
          invocationName: "review",
          reference: "review/SKILL.md",
          skillFileHash: "a".repeat(64),
        }],
        skipped: [],
      },
    });
    const second = topicNativeSessionCompatibilityKey({
      skillEvidence: {
        skipped: [],
        resolved: [{
          skillFileHash: "a".repeat(64),
          reference: "review/SKILL.md",
          invocationName: "review",
          name: "review",
          sourceKey: "codex-user:review",
        }],
        requested: [],
      },
      executionPlan: { ...executionPlan },
      agentId: "agent_topic",
    });

    expect(second).toBe(first);
  });

  test("invalidates only the requested Feishu topic session", () => {
    const store = new ChatRunStore(dir);
    const executionPlan: ResolvedExecutionPlan = {
      version: 1,
      instruction: "Topic agent",
      provider: "codex",
    };
    const compatibilityKey = topicNativeSessionCompatibilityKey({ executionPlan });
    const start = (rootMessageId: string, messageId: string, startedAt: number) => {
      const run = store.start({
        space: SPACE,
        chatId: "oc_chat_runs",
        messageId,
        input: messageId,
        trigger: "message",
        executionPlan,
        topicNativeSession: {
          kind: "feishu-topic",
          chatId: "oc_chat_runs",
          rootMessageId,
          provider: "codex",
          compatibilityKey,
        },
        startedAt,
      });
      store.begin(run.id, startedAt + 1);
      return run;
    };
    const first = start("om_root_a", "om_a1", 100);
    store.prepareTopicNativeSession(first.id);
    store.succeed(first.id, {
      finishedAt: 110,
      output: "a",
      nativeSessionId: "11111111-2222-4333-8444-555555555555",
    });
    store.deliverySent(first.id, 111);
    const second = start("om_root_b", "om_b1", 120);
    store.prepareTopicNativeSession(second.id);
    store.succeed(second.id, {
      finishedAt: 130,
      output: "b",
      nativeSessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    });
    store.deliverySent(second.id, 131);

    expect(store.invalidateTopicNativeSessions(
      SPACE,
      "oc_chat_runs",
      "om_root_a",
    )).toBe(1);

    const afterA = start("om_root_a", "om_a2", 140);
    expect(store.prepareTopicNativeSession(afterA.id)).toEqual({ mode: "start" });
    const afterB = start("om_root_b", "om_b2", 150);
    expect(store.prepareTopicNativeSession(afterB.id)).toEqual({
      mode: "fork",
      id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    });
  });

  test("invalidates every topic session in one Feishu chat when no root is given", () => {
    const store = new ChatRunStore(dir);
    const executionPlan: ResolvedExecutionPlan = {
      version: 1,
      instruction: "Topic agent",
      provider: "codex",
    };
    const compatibilityKey = topicNativeSessionCompatibilityKey({ executionPlan });
    const start = (rootMessageId: string, messageId: string, startedAt: number) => {
      const run = store.start({
        space: SPACE,
        chatId: "oc_chat_runs",
        messageId,
        input: messageId,
        trigger: "message",
        executionPlan,
        topicNativeSession: {
          kind: "feishu-topic",
          chatId: "oc_chat_runs",
          rootMessageId,
          provider: "codex",
          compatibilityKey,
        },
        startedAt,
      });
      store.begin(run.id, startedAt + 1);
      return run;
    };
    const first = start("om_root_a", "om_a1", 100);
    store.prepareTopicNativeSession(first.id);
    store.succeed(first.id, {
      finishedAt: 110,
      output: "a",
      nativeSessionId: "11111111-2222-4333-8444-555555555555",
    });
    const second = start("om_root_b", "om_b1", 120);
    store.prepareTopicNativeSession(second.id);
    store.succeed(second.id, {
      finishedAt: 130,
      output: "b",
      nativeSessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    });

    expect(store.invalidateTopicNativeSessions(SPACE, "oc_chat_runs")).toBe(2);
    expect(store.prepareTopicNativeSession(start("om_root_a", "om_a2", 140).id))
      .toEqual({ mode: "start" });
    expect(store.prepareTopicNativeSession(start("om_root_b", "om_b2", 150).id))
      .toEqual({ mode: "start" });
  });

  test("invalidates every persisted topic session in one Space", () => {
    const store = new ChatRunStore(dir);
    const otherSpace: SpaceId = "team/oc_chat_runs_other";
    const executionPlan: ResolvedExecutionPlan = {
      version: 1,
      instruction: "Topic agent",
      provider: "codex",
    };
    const compatibilityKey = topicNativeSessionCompatibilityKey({ executionPlan });
    const start = (
      space: SpaceId,
      chatId: string,
      rootMessageId: string,
      messageId: string,
      startedAt: number,
    ) => {
      const topicNativeSession = {
        kind: "feishu-topic" as const,
        chatId,
        rootMessageId,
        provider: "codex" as const,
        compatibilityKey,
      };
      const run = store.start({
        space,
        chatId,
        messageId,
        input: messageId,
        trigger: "message",
        executionPlan,
        topicNativeSession,
        startedAt,
      });
      store.begin(run.id, startedAt + 1);
      return { run, topicNativeSession };
    };
    const first = start(SPACE, "oc_chat_runs", "om_root_a", "om_a1", 100);
    store.prepareTopicNativeSession(first.run.id);
    store.succeed(first.run.id, {
      finishedAt: 110,
      output: "a",
      nativeSessionId: "11111111-2222-4333-8444-555555555555",
    });
    store.deliverySent(first.run.id, 111);
    const second = start(SPACE, "oc_another_chat", "om_root_b", "om_b1", 120);
    store.prepareTopicNativeSession(second.run.id);
    store.succeed(second.run.id, {
      finishedAt: 130,
      output: "b",
      nativeSessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    });
    store.deliverySent(second.run.id, 131);
    const other = start(otherSpace, "oc_other", "om_root_c", "om_c1", 140);
    store.prepareTopicNativeSession(other.run.id);
    store.succeed(other.run.id, {
      finishedAt: 150,
      output: "c",
      nativeSessionId: "22222222-3333-4444-8555-666666666666",
    });
    store.deliverySent(other.run.id, 151);

    expect(store.invalidateTopicNativeSessionsForSpace(SPACE)).toBe(2);

    const reopened = new ChatRunStore(dir);
    const afterFirst = reopened.start({
      space: SPACE,
      chatId: first.topicNativeSession.chatId,
      messageId: "om_a2",
      input: "a2",
      trigger: "message",
      executionPlan,
      topicNativeSession: first.topicNativeSession,
      startedAt: 160,
    });
    reopened.begin(afterFirst.id, 161);
    expect(reopened.prepareTopicNativeSession(afterFirst.id)).toEqual({ mode: "start" });
    const afterOther = reopened.start({
      space: otherSpace,
      chatId: other.topicNativeSession.chatId,
      messageId: "om_c2",
      input: "c2",
      trigger: "message",
      executionPlan,
      topicNativeSession: other.topicNativeSession,
      startedAt: 170,
    });
    reopened.begin(afterOther.id, 171);
    expect(reopened.prepareTopicNativeSession(afterOther.id)).toEqual({
      mode: "fork",
      id: "22222222-3333-4444-8555-666666666666",
    });
  });

  test("drops the old topic head when a static reply succeeds without preparing Provider", () => {
    const store = new ChatRunStore(dir);
    const executionPlan: ResolvedExecutionPlan = {
      version: 1,
      instruction: "Topic agent",
      provider: "codex",
    };
    const topicNativeSession = {
      kind: "feishu-topic" as const,
      chatId: "oc_chat_runs",
      rootMessageId: "om_root",
      provider: "codex" as const,
      compatibilityKey: topicNativeSessionCompatibilityKey({ executionPlan }),
    };
    const start = (messageId: string, startedAt: number) => {
      const run = store.start({
        space: SPACE,
        chatId: "oc_chat_runs",
        messageId,
        input: messageId,
        trigger: "message",
        executionPlan,
        topicNativeSession,
        startedAt,
      });
      store.begin(run.id, startedAt + 1);
      return run;
    };
    const providerTurn = start("om_provider", 100);
    store.prepareTopicNativeSession(providerTurn.id);
    store.succeed(providerTurn.id, {
      finishedAt: 110,
      output: "provider reply",
      nativeSessionId: "11111111-2222-4333-8444-555555555555",
    });

    const staticTurn = start("om_static", 120);
    store.succeed(staticTurn.id, { finishedAt: 130, output: "static reply" });

    const afterStatic = start("om_after", 140);
    expect(store.prepareTopicNativeSession(afterStatic.id)).toEqual({ mode: "start" });
  });

  test("invalidates the prepared head when Provider reports that it is unavailable", () => {
    const store = new ChatRunStore(dir);
    const executionPlan: ResolvedExecutionPlan = {
      version: 1,
      instruction: "Topic agent",
      provider: "codex",
    };
    const topicNativeSession = {
      kind: "feishu-topic" as const,
      chatId: "oc_chat_runs",
      rootMessageId: "om_root",
      provider: "codex" as const,
      compatibilityKey: topicNativeSessionCompatibilityKey({ executionPlan }),
    };
    const start = (messageId: string, startedAt: number) => {
      const run = store.start({
        space: SPACE,
        chatId: "oc_chat_runs",
        messageId,
        input: messageId,
        trigger: "message",
        executionPlan,
        topicNativeSession,
        startedAt,
      });
      store.begin(run.id, startedAt + 1);
      return run;
    };
    const first = start("om_first", 100);
    store.prepareTopicNativeSession(first.id);
    store.succeed(first.id, {
      finishedAt: 110,
      output: "done",
      nativeSessionId: "11111111-2222-4333-8444-555555555555",
    });
    store.deliverySent(first.id, 111);
    const unavailable = start("om_unavailable", 120);
    expect(store.prepareTopicNativeSession(unavailable.id)).toEqual({
      mode: "fork",
      id: "11111111-2222-4333-8444-555555555555",
    });

    expect(store.invalidateTopicNativeSessionForRun(unavailable.id)).toBe(true);
    store.fail(unavailable.id, {
      finishedAt: 130,
      error: { kind: "provider_unavailable", message: "session unavailable" },
    });

    const reopened = new ChatRunStore(dir);
    const afterUnavailable = reopened.start({
      space: SPACE,
      chatId: "oc_chat_runs",
      messageId: "om_after",
      input: "after",
      trigger: "retry",
      executionPlan,
      topicNativeSession: reopened.topicNativeSessionForRun(unavailable.id),
      startedAt: 140,
    });
    reopened.begin(afterUnavailable.id, 141);
    expect(reopened.prepareTopicNativeSession(afterUnavailable.id)).toEqual({ mode: "start" });
  });

  test("atomically fails a missing Provider session and invalidates its head", () => {
    const store = new ChatRunStore(dir);
    const executionPlan: ResolvedExecutionPlan = {
      version: 1,
      instruction: "Topic agent",
      provider: "codex",
    };
    const topicNativeSession = {
      kind: "feishu-topic" as const,
      chatId: "oc_chat_runs",
      rootMessageId: "om_root",
      provider: "codex" as const,
      compatibilityKey: topicNativeSessionCompatibilityKey({ executionPlan }),
    };
    const start = (messageId: string, startedAt: number) => {
      const run = store.start({
        space: SPACE,
        chatId: "oc_chat_runs",
        messageId,
        input: messageId,
        trigger: "message",
        executionPlan,
        topicNativeSession,
        startedAt,
      });
      store.begin(run.id, startedAt + 1);
      return run;
    };
    const first = start("om_first", 100);
    store.prepareTopicNativeSession(first.id);
    store.succeed(first.id, {
      finishedAt: 110,
      output: "first",
      nativeSessionId: "11111111-2222-4333-8444-555555555555",
    });
    store.deliverySent(first.id, 111);
    const missing = start("om_missing", 120);
    expect(store.prepareTopicNativeSession(missing.id)).toEqual({
      mode: "fork",
      id: "11111111-2222-4333-8444-555555555555",
    });

    const prototype = ChatRunStore.prototype as unknown as {
      persist: (...args: unknown[]) => void;
    };
    const originalPersist = prototype.persist;
    prototype.persist = () => {
      throw new Error("simulated persistence failure");
    };
    try {
      expect(() => store.failAndInvalidateTopicNativeSession(missing.id, {
        finishedAt: 130,
        error: {
          kind: "provider_unavailable",
          message: "no rollout found for thread id 11111111-2222-4333-8444-555555555555",
        },
      })).toThrow("simulated persistence failure");
    } finally {
      prototype.persist = originalPersist;
    }

    expect(store.get(missing.id)?.status).toBe("running");
    store.failAndInvalidateTopicNativeSession(missing.id, {
      finishedAt: 131,
      error: {
        kind: "provider_unavailable",
        message: "no rollout found for thread id 11111111-2222-4333-8444-555555555555",
      },
    });
    const reopened = new ChatRunStore(dir);
    expect(reopened.get(missing.id)?.error?.message).toBe(
      "no rollout found for thread id [redacted-id]",
    );
    const followup = reopened.start({
      space: SPACE,
      chatId: "oc_chat_runs",
      messageId: "om_followup",
      input: "followup",
      trigger: "message",
      executionPlan,
      topicNativeSession,
      startedAt: 140,
    });
    reopened.begin(followup.id, 141);
    expect(reopened.prepareTopicNativeSession(followup.id)).toEqual({ mode: "start" });
  });

  test("does not advance the run or topic head when the atomic success write fails", () => {
    const store = new ChatRunStore(dir);
    const executionPlan: ResolvedExecutionPlan = {
      version: 1,
      instruction: "Topic agent",
      provider: "codex",
    };
    const topicNativeSession = {
      kind: "feishu-topic" as const,
      chatId: "oc_chat_runs",
      rootMessageId: "om_root",
      provider: "codex" as const,
      compatibilityKey: topicNativeSessionCompatibilityKey({ executionPlan }),
    };
    const start = (messageId: string, startedAt: number) => {
      const run = store.start({
        space: SPACE,
        chatId: "oc_chat_runs",
        messageId,
        input: messageId,
        trigger: "message",
        executionPlan,
        topicNativeSession,
        startedAt,
      });
      store.begin(run.id, startedAt + 1);
      return run;
    };
    const first = start("om_first", 100);
    store.prepareTopicNativeSession(first.id);
    store.succeed(first.id, {
      finishedAt: 110,
      output: "first",
      nativeSessionId: "11111111-2222-4333-8444-555555555555",
    });
    store.deliverySent(first.id, 111);
    const second = start("om_second", 120);
    store.prepareTopicNativeSession(second.id);

    const prototype = ChatRunStore.prototype as unknown as {
      persist: (...args: unknown[]) => void;
    };
    const originalPersist = prototype.persist;
    prototype.persist = () => {
      throw new Error("simulated persistence failure");
    };
    try {
      expect(() => store.succeed(second.id, {
        finishedAt: 130,
        output: "second",
        nativeSessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      })).toThrow("simulated persistence failure");
    } finally {
      prototype.persist = originalPersist;
    }

    expect(store.get(second.id)?.status).toBe("running");
    expect(store.prepareTopicNativeSession(second.id)).toEqual({
      mode: "fork",
      id: "11111111-2222-4333-8444-555555555555",
    });
    const reopened = new ChatRunStore(dir);
    expect(reopened.get(second.id)?.status).toBe("running");
    expect(reopened.prepareTopicNativeSession(second.id)).toEqual({
      mode: "fork",
      id: "11111111-2222-4333-8444-555555555555",
    });
  });

  test("does not overwrite or invalidate a newer head from a stale prepared turn", () => {
    const store = new ChatRunStore(dir);
    const executionPlan: ResolvedExecutionPlan = {
      version: 1,
      instruction: "Topic agent",
      provider: "codex",
    };
    const topicNativeSession = {
      kind: "feishu-topic" as const,
      chatId: "oc_chat_runs",
      rootMessageId: "om_root",
      provider: "codex" as const,
      compatibilityKey: topicNativeSessionCompatibilityKey({ executionPlan }),
    };
    const start = (messageId: string, startedAt: number) => {
      const run = store.start({
        space: SPACE,
        chatId: "oc_chat_runs",
        messageId,
        input: messageId,
        trigger: "message",
        executionPlan,
        topicNativeSession,
        startedAt,
      });
      store.begin(run.id, startedAt + 1);
      return run;
    };
    const first = start("om_first", 100);
    store.prepareTopicNativeSession(first.id);
    store.succeed(first.id, {
      finishedAt: 110,
      output: "first",
      nativeSessionId: "11111111-2222-4333-8444-555555555555",
    });
    store.deliverySent(first.id, 111);
    const stale = start("om_stale", 120);
    const winner = start("om_winner", 130);
    expect(store.prepareTopicNativeSession(stale.id)).toEqual({
      mode: "fork",
      id: "11111111-2222-4333-8444-555555555555",
    });
    store.prepareTopicNativeSession(winner.id);
    store.succeed(winner.id, {
      finishedAt: 140,
      output: "winner",
      nativeSessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    });
    store.deliverySent(winner.id, 141);

    expect(() => store.succeed(stale.id, {
      finishedAt: 150,
      output: "stale",
      nativeSessionId: "99999999-8888-4777-8666-555555555555",
    })).toThrow("head changed before Chat Run commit");
    expect(store.invalidateTopicNativeSessionForRun(stale.id)).toBe(false);
    store.fail(stale.id, {
      finishedAt: 151,
      error: { kind: "unknown", message: "stale" },
    });

    const after = start("om_after", 160);
    expect(store.prepareTopicNativeSession(after.id)).toEqual({
      mode: "fork",
      id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    });
  });

  test("restores topic plans and heads from a local Space deletion snapshot", () => {
    const store = new ChatRunStore(dir);
    const executionPlan: ResolvedExecutionPlan = {
      version: 1,
      instruction: "Topic agent",
      provider: "codex",
    };
    const topicNativeSession = {
      kind: "feishu-topic" as const,
      chatId: "oc_chat_runs",
      rootMessageId: "om_root",
      provider: "codex" as const,
      compatibilityKey: topicNativeSessionCompatibilityKey({ executionPlan }),
    };
    const first = store.start({
      space: SPACE,
      chatId: "oc_chat_runs",
      messageId: "om_first",
      input: "first",
      trigger: "message",
      executionPlan,
      topicNativeSession,
      startedAt: 100,
    });
    store.begin(first.id, 101);
    store.prepareTopicNativeSession(first.id);
    store.succeed(first.id, {
      finishedAt: 110,
      output: "done",
      nativeSessionId: "11111111-2222-4333-8444-555555555555",
    });
    store.deliverySent(first.id, 111);
    const inFlight = store.start({
      space: SPACE,
      chatId: "oc_chat_runs",
      messageId: "om_in_flight",
      input: "in flight",
      trigger: "message",
      executionPlan,
      topicNativeSession,
      startedAt: 120,
    });
    store.begin(inFlight.id, 121);
    expect(store.prepareTopicNativeSession(inFlight.id)).toEqual({
      mode: "fork",
      id: "11111111-2222-4333-8444-555555555555",
    });
    const snapshot = store.snapshotLocalBySpace(SPACE);

    expect(store.removeBySpace(SPACE)).toBe(2);
    store.restoreLocalSnapshot(snapshot);

    expect(store.get(first.id)?.status).toBe("succeeded");
    expect(store.topicNativeSessionForRun(first.id)).toEqual(topicNativeSession);
    store.succeed(inFlight.id, {
      finishedAt: 130,
      output: "in flight done",
      nativeSessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    });
    store.deliverySent(inFlight.id, 131);
    const followup = store.start({
      space: SPACE,
      chatId: "oc_chat_runs",
      messageId: "om_followup",
      input: "followup",
      trigger: "message",
      executionPlan,
      topicNativeSession,
      startedAt: 140,
    });
    store.begin(followup.id, 141);
    expect(store.prepareTopicNativeSession(followup.id)).toEqual({
      mode: "fork",
      id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    });
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

  test("persists a Chat execution plan that grants provider tools and Skills", () => {
    const store = new ChatRunStore(dir);
    const executionPlan: ResolvedExecutionPlan = {
      version: 1,
      instruction: "Use every available Skill.",
      provider: "codex",
      execution: {
        permission: "full",
        workdir: dir,
        skills: ["lark-doc"],
      },
    };

    const run = store.start({
      space: SPACE,
      input: "ordinary chat",
      trigger: "message",
      execution: executionPlan.execution,
      executionPlan,
    });

    expect(new ChatRunStore(dir).get(run.id)).toEqual(expect.objectContaining({
      execution: executionPlan.execution,
      executionPlan,
    }));
  });

  test("rejects a non-positive provider timeout before persisting a run", () => {
    const store = new ChatRunStore(dir);

    expect(() => store.start({
      space: SPACE,
      input: "ordinary chat",
      trigger: "message",
      timeoutMs: 0,
    })).toThrow("Chat timeout");
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
    delete legacy.runs[run.id]!.timeoutMs;
    writeFileSync(path, JSON.stringify(legacy), "utf8");

    const reopened = new ChatRunStore(dir).get(run.id);
    expect(reopened?.id).toBe(run.id);
    expect(reopened?.timeoutMs).toBeUndefined();
  });

  test("loads v1-v5 Chat Runs without accepting injected topic session state", () => {
    const store = new ChatRunStore(dir);
    const run = store.start({
      space: SPACE,
      chatId: "oc_chat_runs",
      messageId: "om_legacy",
      input: "legacy",
      trigger: "message",
      startedAt: 100,
    });
    const path = join(dir, "config", "chat-runs.json");
    const current = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
    current.topicNativeSessions = {
      injected: {
        sessionId: "11111111-2222-4333-8444-555555555555",
      },
    };
    current.topicNativeSessionPlans = {
      [run.id]: {
        kind: "feishu-topic",
        chatId: "oc_chat_runs",
        rootMessageId: "om_root",
        provider: "codex",
        compatibilityKey: "a".repeat(64),
      },
    };

    for (const version of [1, 2, 3, 4, 5]) {
      current.version = version;
      writeFileSync(path, JSON.stringify(current), "utf8");
      const reopened = new ChatRunStore(dir);
      expect(reopened.get(run.id)?.input).toBe("legacy");
      expect(reopened.topicNativeSessionForRun(run.id)).toBeUndefined();
    }
  });

  test("refuses to overwrite corrupt or future Chat Run history", () => {
    const path = join(dir, "config", "chat-runs.json");
    mkdirSync(dirname(path), { recursive: true });
    const future = JSON.stringify({
      version: 7,
      runs: { future_run: { privateFutureState: "preserve-me" } },
    });
    writeFileSync(path, future, "utf8");

    expect(() => new ChatRunStore(dir)).toThrow("unsupported newer version");
    expect(readFileSync(path, "utf8")).toBe(future);

    const corrupt = "{not valid json";
    writeFileSync(path, corrupt, "utf8");
    expect(() => new ChatRunStore(dir)).toThrow("history is corrupt");
    expect(readFileSync(path, "utf8")).toBe(corrupt);
  });

  test("drops persisted Claude topic plans and heads when loading v6", () => {
    const store = new ChatRunStore(dir);
    const executionPlan: ResolvedExecutionPlan = {
      version: 1,
      instruction: "Topic agent",
      provider: "codex",
    };
    const run = store.start({
      space: SPACE,
      chatId: "oc_chat_runs",
      messageId: "om_first",
      input: "first",
      trigger: "message",
      executionPlan,
      topicNativeSession: {
        kind: "feishu-topic",
        chatId: "oc_chat_runs",
        rootMessageId: "om_root",
        provider: "codex",
        compatibilityKey: topicNativeSessionCompatibilityKey({ executionPlan }),
      },
      startedAt: 100,
    });
    store.begin(run.id, 101);
    store.prepareTopicNativeSession(run.id);
    store.succeed(run.id, {
      finishedAt: 110,
      output: "done",
      nativeSessionId: "11111111-2222-4333-8444-555555555555",
    });
    const path = join(dir, "config", "chat-runs.json");
    const persisted = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
    persisted.runs[run.id].executionPlan.provider = "claude";
    persisted.topicNativeSessionPlans[run.id].provider = "claude";
    const [session] = Object.values(persisted.topicNativeSessions) as Array<Record<string, any>>;
    session!.provider = "claude";
    writeFileSync(path, JSON.stringify(persisted), "utf8");

    const reopened = new ChatRunStore(dir);
    expect(reopened.get(run.id)?.topicNativeSessionExpected).toBe(true);
    expect(reopened.topicNativeSessionForRun(run.id)).toBeUndefined();
  });

  test("keeps a fail-closed marker when a queued v6 topic plan is corrupted", () => {
    const store = new ChatRunStore(dir);
    const executionPlan: ResolvedExecutionPlan = {
      version: 1,
      instruction: "Topic agent",
      provider: "codex",
    };
    const run = store.start({
      space: SPACE,
      chatId: "oc_chat_runs",
      messageId: "om_queued",
      input: "queued",
      trigger: "message",
      executionPlan,
      topicNativeSession: {
        kind: "feishu-topic",
        chatId: "oc_chat_runs",
        rootMessageId: "om_root",
        provider: "codex",
        compatibilityKey: topicNativeSessionCompatibilityKey({ executionPlan }),
      },
      startedAt: 100,
    });
    const path = join(dir, "config", "chat-runs.json");
    const persisted = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
    delete persisted.topicNativeSessionPlans[run.id];
    writeFileSync(path, JSON.stringify(persisted), "utf8");

    const reopened = new ChatRunStore(dir);
    expect(reopened.get(run.id)?.topicNativeSessionExpected).toBe(true);
    expect(reopened.topicNativeSessionForRun(run.id)).toBeUndefined();
    expect(reopened.prepareTopicNativeSession(run.id)).toBeUndefined();
  });

  test("drops a v6 topic plan whose compatibility key does not match frozen inputs", () => {
    const store = new ChatRunStore(dir);
    const executionPlan: ResolvedExecutionPlan = {
      version: 1,
      instruction: "Topic agent",
      provider: "codex",
      execution: { permission: "read-only", skills: ["lark-doc"] },
    };
    const skillEvidence = {
      requested: [{ kind: "legacy-name" as const, name: "lark-doc" }],
      resolved: [],
      skipped: [],
    };
    const topicNativeSession = {
      kind: "feishu-topic" as const,
      chatId: "oc_chat_runs",
      rootMessageId: "om_root",
      provider: "codex" as const,
      compatibilityKey: topicNativeSessionCompatibilityKey({
        agentId: "agent_topic",
        executionPlan,
        skillEvidence,
      }),
    };
    const run = store.start({
      space: SPACE,
      chatId: "oc_chat_runs",
      messageId: "om_first",
      input: "first",
      trigger: "message",
      agentId: "agent_topic",
      executionPlan,
      skillEvidence,
      topicNativeSession,
      startedAt: 100,
    });
    store.begin(run.id, 101);
    store.prepareTopicNativeSession(run.id);
    store.succeed(run.id, {
      finishedAt: 110,
      output: "done",
      nativeSessionId: "11111111-2222-4333-8444-555555555555",
    });
    const path = join(dir, "config", "chat-runs.json");
    const persisted = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
    const forgedKey = "f".repeat(64);
    persisted.topicNativeSessionPlans[run.id].compatibilityKey = forgedKey;
    const [session] = Object.values(persisted.topicNativeSessions) as Array<Record<string, any>>;
    session!.compatibilityKey = forgedKey;
    writeFileSync(path, JSON.stringify(persisted), "utf8");

    const reopened = new ChatRunStore(dir);
    expect(reopened.get(run.id)?.topicNativeSessionExpected).toBe(true);
    expect(reopened.topicNativeSessionForRun(run.id)).toBeUndefined();
    const followup = reopened.start({
      space: SPACE,
      chatId: "oc_chat_runs",
      messageId: "om_followup",
      input: "followup",
      trigger: "message",
      agentId: "agent_topic",
      executionPlan,
      skillEvidence,
      topicNativeSession,
      startedAt: 120,
    });
    reopened.begin(followup.id, 121);
    expect(reopened.prepareTopicNativeSession(followup.id)).toEqual({ mode: "start" });
  });

  test("drops a v6 topic head whose last Chat Run provenance is missing", () => {
    const store = new ChatRunStore(dir);
    const executionPlan: ResolvedExecutionPlan = {
      version: 1,
      instruction: "Topic agent",
      provider: "codex",
    };
    const topicNativeSession = {
      kind: "feishu-topic" as const,
      chatId: "oc_chat_runs",
      rootMessageId: "om_root",
      provider: "codex" as const,
      compatibilityKey: topicNativeSessionCompatibilityKey({ executionPlan }),
    };
    const first = store.start({
      space: SPACE,
      rawId: "raw_first",
      chatId: "oc_chat_runs",
      messageId: "om_first",
      input: "first",
      trigger: "message",
      executionPlan,
      topicNativeSession,
      startedAt: 100,
    });
    store.begin(first.id, 101);
    store.prepareTopicNativeSession(first.id);
    store.succeed(first.id, {
      finishedAt: 110,
      output: "first",
      nativeSessionId: "11111111-2222-4333-8444-555555555555",
    });
    const path = join(dir, "config", "chat-runs.json");
    const persisted = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
    const [session] = Object.values(persisted.topicNativeSessions) as Array<Record<string, any>>;
    session!.lastChatRunId = "chat_run_missing";
    writeFileSync(path, JSON.stringify(persisted), "utf8");

    const reopened = new ChatRunStore(dir);
    const followup = reopened.start({
      space: SPACE,
      chatId: "oc_chat_runs",
      messageId: "om_followup",
      input: "followup",
      trigger: "message",
      executionPlan,
      topicNativeSession,
      startedAt: 120,
    });
    reopened.begin(followup.id, 121);

    expect(reopened.prepareTopicNativeSession(followup.id)).toEqual({ mode: "start" });
  });

  test("retains the succeeded Chat Run referenced by a current topic head", () => {
    const store = new ChatRunStore(dir);
    const executionPlan: ResolvedExecutionPlan = {
      version: 1,
      instruction: "Topic agent",
      provider: "codex",
    };
    const topicNativeSession = {
      kind: "feishu-topic" as const,
      chatId: "oc_chat_runs",
      rootMessageId: "om_root",
      provider: "codex" as const,
      compatibilityKey: topicNativeSessionCompatibilityKey({
        agentId: "agent_topic",
        executionPlan,
      }),
    };
    const head = store.start({
      space: SPACE,
      chatId: "oc_chat_runs",
      messageId: "om_head",
      input: "head",
      trigger: "message",
      agentId: "agent_topic",
      executionPlan,
      topicNativeSession,
      startedAt: 100,
    });
    store.begin(head.id, 101);
    store.prepareTopicNativeSession(head.id);
    store.succeed(head.id, {
      finishedAt: 102,
      output: "head",
      nativeSessionId: "11111111-2222-4333-8444-555555555555",
    });
    store.deliverySent(head.id, 103);

    for (let index = 0; index < MAX_CHAT_RUN_HISTORY_PER_AGENT; index += 1) {
      const run = store.start({
        space: SPACE,
        input: `ordinary-${index}`,
        trigger: "message",
        agentId: "agent_topic",
        startedAt: 200 + index * 2,
      });
      store.succeed(run.id, {
        finishedAt: 201 + index * 2,
        output: "done",
      });
    }

    const reopened = new ChatRunStore(dir);
    expect(reopened.get(head.id)?.status).toBe("succeeded");
    const followup = reopened.start({
      space: SPACE,
      chatId: "oc_chat_runs",
      messageId: "om_followup",
      input: "followup",
      trigger: "message",
      agentId: "agent_topic",
      executionPlan,
      topicNativeSession,
      startedAt: 500,
    });
    reopened.begin(followup.id, 501);
    expect(reopened.prepareTopicNativeSession(followup.id)).toEqual({
      mode: "fork",
      id: "11111111-2222-4333-8444-555555555555",
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

  test("raw cleanup atomically removes a Chat Run and invalidates its topic head", () => {
    const store = new ChatRunStore(dir);
    const executionPlan: ResolvedExecutionPlan = {
      version: 1,
      instruction: "Topic agent",
      provider: "codex",
    };
    const topicNativeSession = {
      kind: "feishu-topic" as const,
      chatId: "oc_chat_runs",
      rootMessageId: "om_root",
      provider: "codex" as const,
      compatibilityKey: topicNativeSessionCompatibilityKey({ executionPlan }),
    };
    const removedRun = store.start({
      space: SPACE,
      rawId: "raw_old",
      chatId: "oc_chat_runs",
      messageId: "om_old",
      input: "old",
      trigger: "message",
      executionPlan,
      topicNativeSession,
      startedAt: 100,
    });
    store.begin(removedRun.id, 101);
    store.prepareTopicNativeSession(removedRun.id);
    store.succeed(removedRun.id, {
      finishedAt: 110,
      output: "old",
      nativeSessionId: "11111111-2222-4333-8444-555555555555",
    });
    const currentHead = store.start({
      space: SPACE,
      rawId: "raw_current",
      chatId: "oc_chat_runs",
      messageId: "om_current",
      input: "current",
      trigger: "message",
      executionPlan,
      topicNativeSession,
      startedAt: 120,
    });
    store.begin(currentHead.id, 121);
    store.prepareTopicNativeSession(currentHead.id);
    store.succeed(currentHead.id, {
      finishedAt: 130,
      output: "current",
      nativeSessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    });

    const prototype = ChatRunStore.prototype as unknown as {
      persist: (...args: unknown[]) => void;
    };
    const originalPersist = prototype.persist;
    prototype.persist = () => {
      throw new Error("simulated persistence failure");
    };
    try {
      expect(() => store.removeByRawIds(new Set(["raw_old"])))
        .toThrow("simulated persistence failure");
    } finally {
      prototype.persist = originalPersist;
    }

    expect(store.get(removedRun.id)?.status).toBe("succeeded");
    const reopenedAfterFailure = new ChatRunStore(dir);
    expect(reopenedAfterFailure.get(removedRun.id)?.status).toBe("succeeded");
    expect(reopenedAfterFailure.removeByRawIds(new Set(["raw_old"]))).toBe(1);
    expect(reopenedAfterFailure.get(removedRun.id)).toBeUndefined();
    expect(reopenedAfterFailure.get(currentHead.id)?.status).toBe("succeeded");
    const persisted = JSON.parse(
      readFileSync(join(dir, "config", "chat-runs.json"), "utf8"),
    ) as Record<string, any>;
    expect(Object.keys(persisted.topicNativeSessions)).toHaveLength(0);

    const reopened = new ChatRunStore(dir);
    const followup = reopened.start({
      space: SPACE,
      chatId: "oc_chat_runs",
      messageId: "om_followup",
      input: "followup",
      trigger: "message",
      executionPlan,
      topicNativeSession,
      startedAt: 140,
    });
    reopened.begin(followup.id, 141);
    expect(reopened.prepareTopicNativeSession(followup.id)).toEqual({ mode: "start" });
  });

  test("raw cleanup invalidates a topic head while preserving its in-flight delivery audit", () => {
    const store = new ChatRunStore(dir);
    const executionPlan: ResolvedExecutionPlan = {
      version: 1,
      instruction: "Topic agent",
      provider: "codex",
    };
    const topicNativeSession = {
      kind: "feishu-topic" as const,
      chatId: "oc_chat_runs",
      rootMessageId: "om_root",
      provider: "codex" as const,
      compatibilityKey: topicNativeSessionCompatibilityKey({ executionPlan }),
    };
    const delivering = store.start({
      space: SPACE,
      rawId: "raw_delivering_topic",
      chatId: "oc_chat_runs",
      messageId: "om_delivering",
      input: "delivering",
      trigger: "message",
      executionPlan,
      topicNativeSession,
      startedAt: 100,
    });
    store.begin(delivering.id, 101);
    store.prepareTopicNativeSession(delivering.id);
    store.succeed(delivering.id, {
      finishedAt: 110,
      output: "reply",
      nativeSessionId: "11111111-2222-4333-8444-555555555555",
    });
    store.startDeliveryAttempt(delivering.id, 111);

    expect(store.removeByRawIds(new Set(["raw_delivering_topic"]))).toBe(0);
    expect(store.get(delivering.id)?.delivery).toEqual(expect.objectContaining({
      status: "pending",
      attempts: 1,
    }));
    const reopened = new ChatRunStore(dir);
    const followup = reopened.start({
      space: SPACE,
      chatId: "oc_chat_runs",
      messageId: "om_followup",
      input: "followup",
      trigger: "message",
      executionPlan,
      topicNativeSession,
      startedAt: 120,
    });
    reopened.begin(followup.id, 121);
    expect(reopened.prepareTopicNativeSession(followup.id)).toEqual({ mode: "start" });
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
