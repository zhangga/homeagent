import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliConnector, type Connector } from "@homeagent/connectors";
import { Orchestrator } from "@homeagent/orchestrator";
import {
  FakeLlm,
  KnowledgeEngine,
  type LearningPlan,
  type LearningSession,
} from "@homeagent/core";
import {
  LearningScheduler,
  learningFollowUpNotification,
  learningNotification,
  shouldAdvanceUnansweredLearningPlan,
  shouldFollowUpLearningPlan,
  shouldRunLearningPlan,
} from "./learning-scheduler.ts";

const NOW = new Date("2026-07-15T10:00:00+08:00");

function plan(overrides: Partial<LearningPlan> = {}): LearningPlan {
  return {
    id: "learn_1",
    name: "读原则",
    space: "personal/ou_me",
    creatorId: "ou_me",
    chatId: "oc_p2p",
    mode: "reading",
    route: [],
    routeIndex: 0,
    sourceId: "source_1",
    sourceLength: 1000,
    hour: 8,
    dailyCharacters: 500,
    cursor: 0,
    status: "active",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function session(overrides: Partial<LearningSession> = {}): LearningSession {
  return {
    id: "session_1",
    planId: "learn_1",
    sequence: 1,
    startOffset: 0,
    endOffset: 500,
    sectionTitle: "第一章",
    excerpt: "今日原文",
    guide: "## 今日目标\n理解第一章",
    status: "prepared",
    preparedAt: 1,
    ...overrides,
  };
}

describe("shouldRunLearningPlan", () => {
  test("runs once after the configured hour and rolls an unanswered lesson on the next day", () => {
    expect(shouldRunLearningPlan(plan(), undefined, NOW)).toBe(true);
    expect(shouldRunLearningPlan(plan({ hour: 11 }), undefined, NOW)).toBe(false);
    expect(shouldRunLearningPlan(
      plan({ lastDeliveredAt: new Date("2026-07-15T08:00:00+08:00").getTime() }),
      undefined,
      NOW,
    )).toBe(false);
    expect(shouldRunLearningPlan(plan(), session({ status: "prepared" }), NOW)).toBe(true);
    expect(shouldRunLearningPlan(plan(), session({ status: "awaiting_reply" }), NOW)).toBe(false);
    const yesterday = new Date("2026-07-14T08:00:00+08:00").getTime();
    expect(shouldRunLearningPlan(
      plan({ lastDeliveredAt: yesterday }),
      session({ status: "awaiting_reply", deliveredAt: yesterday }),
      NOW,
    )).toBe(true);
    expect(shouldAdvanceUnansweredLearningPlan(
      plan({ lastDeliveredAt: yesterday }),
      session({ status: "awaiting_reply", deliveredAt: yesterday }),
      NOW,
    )).toBe(true);
    expect(shouldRunLearningPlan(plan({ status: "paused" }), undefined, NOW)).toBe(false);
    expect(shouldRunLearningPlan(plan({
      mode: "topic",
      topic: "Rust",
      route: [{
        id: "step_1",
        title: "诊断",
        objective: "等待诊断",
        status: "active",
        attempts: 0,
      }],
      profile: {
        status: "assessing",
        level: "unknown",
        levelRationale: "等待回答",
        goals: [],
        strengths: [],
        gaps: [],
        preferences: [],
        pace: "steady",
        dailyMinutes: 25,
        evidence: [],
        revision: 0,
        updatedAt: 1,
      },
    }), undefined, NOW)).toBe(false);
  });
});

describe("shouldFollowUpLearningPlan", () => {
  test("follows up once per day after 24 hours and stops after three nudges", () => {
    const deliveredAt = NOW.getTime() - 25 * 60 * 60 * 1000;
    expect(shouldFollowUpLearningPlan(
      plan(),
      session({ status: "awaiting_reply", deliveredAt }),
      NOW,
    )).toBe(true);
    expect(shouldFollowUpLearningPlan(
      plan(),
      session({
        status: "awaiting_reply",
        deliveredAt,
        lastFollowUpAt: NOW.getTime() - 60 * 60 * 1000,
      }),
      NOW,
    )).toBe(false);
    expect(shouldFollowUpLearningPlan(
      plan(),
      session({ status: "awaiting_reply", deliveredAt, followUpCount: 3 }),
      NOW,
    )).toBe(false);
  });
});

describe("LearningScheduler", () => {
  let dir: string;
  let llm: FakeLlm;
  let engine: KnowledgeEngine;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ha-learning-scheduler-"));
    llm = new FakeLlm();
    engine = new KnowledgeEngine({ dataDir: dir, llm });
  });

  test("appends safe Skill warnings to a lesson notification", () => {
    const message = learningNotification(plan(), session(), [{
      code: "missing_source",
      name: "coach[*]",
      message: "绑定的 Skill 当前不存在",
    }]);

    expect(message).toContain("Skill 提示");
    expect(message).toContain("coach");
    expect(message).not.toContain("*");
  });

  afterEach(() => {
    engine.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("delivers one due lesson and does not redeliver while awaiting a reply", async () => {
    const created = seedPlan(engine);
    llm.queueText("## 今日目标\n理解第一章");
    const notified: string[] = [];
    const scheduler = new LearningScheduler(engine, {
      notify: async (_plan, _source, current) => { notified.push(current.id); },
    });

    expect(await scheduler.tick("due", NOW)).toEqual([created.id]);
    expect(await scheduler.tick("again", NOW)).toEqual([]);
    expect(notified).toHaveLength(1);
    expect(engine.learning.currentSession(created.id)?.status).toBe("awaiting_reply");
  });

  test("archives an unanswered lesson and delivers the next day's lesson", async () => {
    const created = seedPlan(engine);
    llm.queueText("## 今日目标\n理解第一章");
    const scheduler = new LearningScheduler(engine, { notify: async () => {} });

    expect(await scheduler.tick("day-one", NOW)).toEqual([created.id]);
    const first = engine.learning.currentSession(created.id)!;
    llm.queueText("## 今日目标\n理解下一段");
    const tomorrow = new Date("2026-07-16T10:00:00+08:00");

    expect(await scheduler.tick("day-two", tomorrow)).toEqual([created.id]);
    expect(engine.learning.sessionsForPlan(created.id)).toEqual([
      expect.objectContaining({ id: first.id, status: "skipped" }),
      expect.objectContaining({ sequence: 2, status: "awaiting_reply" }),
    ]);
  });

  test("a reply to yesterday's Feishu push after restart leaves today's lesson awaiting the correct answer", async () => {
    const created = seedPlan(engine);
    const appId = "cli_school";
    llm.queueText("理解第一章").queueText("理解第二章");
    const scheduler = new LearningScheduler(engine, {
      notify: (_plan, _source, session) => ({ appId, messageId: `om_lesson_${session.sequence}` }),
    });
    await scheduler.tick("first lesson", NOW);
    await scheduler.tick("second lesson", new Date("2026-07-16T10:00:00+08:00"));
    expect(engine.learning.exportBySpace(created.space).sessions.some(session => session.replyReceipts)).toBe(false);
    engine.close();
    engine = new KnowledgeEngine({ dataDir: dir, llm });
    const cli = new CliConnector();
    const connector: Connector = { name: "feishu", start: handler => cli.start(handler), stop: () => cli.stop(),
      notice: (chat, text) => cli.notice(chat, text), reply: out => cli.reply(out) };
    const orch = new Orchestrator({ connector, engine, activeFeishuAppId: appId, llm });
    const submit = (messageId: string, parentMessageId: string) => cli.inject({ kind: "message", eventId: messageId, messageId,
      chatType: "p2p", chatId: created.chatId, senderId: created.creatorId, text: `学习回答：[${created.name}] 我的理解`,
      parentMessageId, mentionsBot: false, createdAt: Date.now() });
    await orch.start();
    try {
      const before = llm.calls.length;
      await submit("om_answer_old", "om_lesson_1");
      expect(cli.sent.at(-1)?.markdown).toContain("第 1 课，这一课已归档");
      expect(cli.sent.at(-1)?.markdown).toContain("第 2 课");
      await submit("om_answer_unknown", "om_unknown");
      expect(cli.sent.at(-1)?.markdown).toContain("另发一条消息");
      expect(llm.calls).toHaveLength(before);
      expect(engine.learning.currentSession(created.id)?.status).toBe("awaiting_reply");
      llm.queueJSON({ feedback: "## 回应点评\n需要复习\n\n## 需要澄清\n概念\n\n## 今日总结\n复习\n\n## 下一步\n继续",
        mastery: "review", nextFocus: "联系实际例子" });
      await submit("om_answer_current", "om_lesson_2");
      expect(cli.sent.at(-1)?.markdown).toContain("第 2 课反馈");
      expect(engine.learning.sessionsForPlan(created.id).map(session => session.status)).toEqual(["skipped", "completed"]);
      await submit("om_answer_again", "om_lesson_2");
      expect(cli.sent.at(-1)?.markdown).toContain("这一课已完成");
    } finally { await orch.stop(); }
  });

  test("retries the same prepared lesson after delivery failure", async () => {
    const created = seedPlan(engine);
    llm.queueText("## 今日目标\n理解第一章");
    const attempted: string[] = [];
    const scheduler = new LearningScheduler(engine, {
      notify: async (_plan, _source, current) => {
        attempted.push(current.id);
        throw new Error("network unavailable");
      },
    });

    expect(await scheduler.tick("first", NOW)).toEqual([]);
    expect(await scheduler.tick("retry", NOW)).toEqual([]);
    expect(attempted[0]).toBe(attempted[1]);
    expect(engine.learning.currentSession(created.id)?.status).toBe("prepared");
    expect(scheduler.health()).toEqual(expect.objectContaining({
      lastStatus: "error",
      lastError: expect.stringContaining("network unavailable"),
    }));
  });

  test("retries a post-send lesson commit with one stable transport idempotency key", async () => {
    const created = seedPlan(engine);
    llm.queueText("## 今日目标\n理解第一章");
    const persistDelivered = engine.learning.markDelivered.bind(engine.learning);
    let commitAttempts = 0;
    engine.learning.markDelivered = (...args) => {
      commitAttempts += 1;
      return commitAttempts === 1 ? undefined : persistDelivered(...args);
    };
    const attemptedKeys: string[] = [];
    const acceptedKeys = new Set<string>();
    let physicalDeliveries = 0;
    const scheduler = new LearningScheduler(engine, {
      notify: async (_plan, _source, _session, _warnings, deliveryKey: string) => {
        attemptedKeys.push(deliveryKey);
        if (!acceptedKeys.has(deliveryKey)) {
          acceptedKeys.add(deliveryKey);
          physicalDeliveries += 1;
        }
        return { appId: "cli_school", messageId: "om_accepted_once" };
      },
    });

    expect(await scheduler.tick("post-send-commit-failed", NOW)).toEqual([]);
    expect(await scheduler.tick("retry", NOW)).toEqual([created.id]);
    expect(attemptedKeys).toEqual([expect.any(String), attemptedKeys[0]]);
    expect(attemptedKeys[0]).toMatch(/^ha-lesson-/);
    expect(physicalDeliveries).toBe(1);
    expect(engine.learning.currentSession(created.id)?.replyReceipts).toEqual([{ appId: "cli_school", messageId: "om_accepted_once" }]);
  });

  test("persists a friendly follow-up only after successful delivery", async () => {
    const created = seedPlan(engine);
    llm.queueText("## 今日目标\n理解第一章");
    const scheduler = new LearningScheduler(engine, {
      notify: async () => {},
      followUp: async (_plan, _session, message) => {
        expect(message).toContain("不用赶进度");
        expect(message).toContain("学习回答：");
      },
    });
    await scheduler.tick("deliver", NOW);
    engine.learning.update(created.id, undefined, { hour: 23 }, NOW.getTime() + 1);
    const current = engine.learning.currentSession(created.id)!;
    const later = new Date(NOW.getTime() + 25 * 60 * 60 * 1000);

    expect(await scheduler.tick("follow-up", later)).toEqual([`follow-up:${created.id}`]);
    expect(engine.learning.currentSession(created.id)).toEqual(expect.objectContaining({
      id: current.id,
      followUpCount: 1,
      lastFollowUpAt: later.getTime(),
    }));
    expect(await scheduler.tick("same-day", later)).toEqual([]);
  });

  test("keeps follow-up state retryable when notification delivery fails", async () => {
    const created = seedPlan(engine);
    llm.queueText("## 今日目标\n理解第一章");
    const scheduler = new LearningScheduler(engine, {
      notify: async () => {},
      followUp: async () => { throw new Error("network unavailable"); },
    });
    await scheduler.tick("deliver", NOW);
    engine.learning.update(created.id, undefined, { hour: 23 }, NOW.getTime() + 1);
    const later = new Date(NOW.getTime() + 25 * 60 * 60 * 1000);

    expect(await scheduler.tick("follow-up", later)).toEqual([]);
    expect(engine.learning.currentSession(created.id)?.followUpCount).toBeUndefined();
    expect(scheduler.health().lastError).toContain("network unavailable");
  });

  test("does not report an empty follow-up commit and retries with one stable idempotency key", async () => {
    const created = seedPlan(engine);
    llm.queueText("## 今日目标\n理解第一章");
    const persistFollowUp = engine.learning.markFollowedUp.bind(engine.learning);
    let commitAttempts = 0;
    const attemptedKeys: string[] = [];
    const acceptedKeys = new Set<string>();
    let physicalDeliveries = 0;
    const scheduler = new LearningScheduler(engine, {
      notify: async () => {},
      followUp: async (_plan, _session, _message, deliveryKey: string) => {
        attemptedKeys.push(deliveryKey);
        if (acceptedKeys.has(deliveryKey)) return;
        acceptedKeys.add(deliveryKey);
        physicalDeliveries += 1;
      },
    });
    await scheduler.tick("deliver", NOW);
    engine.learning.update(created.id, undefined, { hour: 23 }, NOW.getTime() + 1);
    engine.learning.markFollowedUp = (...args) => {
      commitAttempts += 1;
      return commitAttempts === 1 ? undefined : persistFollowUp(...args);
    };
    const later = new Date(NOW.getTime() + 25 * 60 * 60 * 1000);
    const nextDayRetry = new Date(later.getTime() + 24 * 60 * 60 * 1000);

    expect(await scheduler.tick("post-send-commit-empty", later)).toEqual([]);
    expect(await scheduler.tick("retry-next-day", nextDayRetry))
      .toEqual([`follow-up:${created.id}`]);
    expect(attemptedKeys).toEqual([expect.any(String), attemptedKeys[0]]);
    expect(attemptedKeys[0]).toMatch(/^ha-follow-/);
    expect(physicalDeliveries).toBe(1);
  });

  test("prevents export or deletion while an awaiting-reply follow-up is being delivered", async () => {
    engine.ensureSpace("personal/ou_me", { chatId: "oc_p2p" });
    const created = seedPlan(engine);
    llm.queueText("## 今日目标\n理解第一章");
    let deliveryStarted!: () => void;
    let releaseDelivery!: () => void;
    const started = new Promise<void>((resolve) => { deliveryStarted = resolve; });
    const released = new Promise<void>((resolve) => { releaseDelivery = resolve; });
    const scheduler = new LearningScheduler(engine, {
      notify: async () => {},
      followUp: async () => {
        deliveryStarted();
        await released;
      },
    });
    await scheduler.tick("deliver", NOW);
    engine.learning.update(created.id, undefined, { hour: 23 }, NOW.getTime() + 1);
    const later = new Date(NOW.getTime() + 25 * 60 * 60 * 1000);

    const tick = scheduler.tick("follow-up", later);
    await started;
    try {
      await expect(engine.exportSpace("personal/ou_me"))
        .rejects.toThrow("space has delivering learning sessions");
      await expect(engine.deleteSpace("personal/ou_me"))
        .rejects.toThrow("space has delivering learning sessions");
    } finally {
      releaseDelivery();
      await tick;
    }
    expect(engine.learning.currentSession(created.id)?.followUpCount).toBe(1);
    expect((await engine.deleteSpace("personal/ou_me")).status).toBe("deleted");
  });

  test("prevents deleting a space while a lesson is being delivered", async () => {
    engine.ensureSpace("personal/ou_me", { chatId: "oc_p2p" });
    seedPlan(engine);
    llm.queueText("## 今日目标\n理解第一章");
    let deliveryStarted!: () => void;
    let releaseDelivery!: () => void;
    const started = new Promise<void>((resolve) => { deliveryStarted = resolve; });
    const released = new Promise<void>((resolve) => { releaseDelivery = resolve; });
    const scheduler = new LearningScheduler(engine, {
      notify: async () => {
        deliveryStarted();
        await released;
      },
    });

    const tick = scheduler.tick("test", NOW);
    await started;
    await expect(engine.exportSpace("personal/ou_me"))
      .rejects.toThrow("space has delivering learning sessions");
    await expect(engine.deleteSpace("personal/ou_me"))
      .rejects.toThrow("space has delivering learning sessions");
    releaseDelivery();
    await tick;
    expect((await engine.deleteSpace("personal/ou_me")).status).toBe("deleted");
  });

  test("renders the source excerpt, guide, and explicit answer instruction", () => {
    const message = learningNotification(plan(), session());
    expect(message).toContain("📖 读原则 · 第 1 课");
    expect(message).toContain("## 今日原文\n今日原文");
    expect(message).toContain("学习回答：[读原则]");
    expect(message).toContain("不回答也不会阻塞明天的新课");
    expect(message).toContain("下一课要求：");
  });

  test("labels a topic step and its supplied references without calling them book text", () => {
    const message = learningNotification(
      plan({
        mode: "topic",
        topic: "Rust 异步编程",
        route: [{
          id: "step_1",
          title: "Future",
          objective: "理解 Future",
          status: "active",
          attempts: 0,
        }],
        routeIndex: 0,
      }),
      session({
        routeStepId: "step_1",
        sectionTitle: "Future",
        excerpt: "[材料1：Async Book]\nFuture 需要 poll。",
      }),
    );

    expect(message).toContain("当前步骤：Future");
    expect(message).toContain("## 参考材料\n[材料1：Async Book]");
    expect(message).not.toContain("## 今日原文");
  });

  test("renders a low-pressure follow-up with exact continuation controls", () => {
    const message = learningFollowUpNotification(
      plan({ adaptiveFocus: "理解 Future 的 poll" }),
      session({ status: "awaiting_reply", sectionTitle: "Future" }),
    );
    expect(message).toContain("还在等你");
    expect(message).toContain("理解 Future 的 poll");
    expect(message).toContain("/learn skip 读原则");
  });
});

function seedPlan(engine: KnowledgeEngine): LearningPlan {
  return engine.learning.create({
    name: "读原则",
    space: "personal/ou_me",
    creatorId: "ou_me",
    chatId: "oc_p2p",
    sourceTitle: "原则",
    sourceContent: `# 第一章\n\n${"正文".repeat(350)}\n\n# 第二章\n\n${"后文".repeat(350)}`,
    sourceRawIds: ["raw_book"],
    sourceMessageId: "om_book",
    hour: 8,
    dailyCharacters: 500,
  }, NOW.getTime() - 1000);
}
