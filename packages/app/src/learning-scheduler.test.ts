import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  test("runs once after the configured hour and waits for an answer", () => {
    expect(shouldRunLearningPlan(plan(), undefined, NOW)).toBe(true);
    expect(shouldRunLearningPlan(plan({ hour: 11 }), undefined, NOW)).toBe(false);
    expect(shouldRunLearningPlan(
      plan({ lastDeliveredAt: new Date("2026-07-15T08:00:00+08:00").getTime() }),
      undefined,
      NOW,
    )).toBe(false);
    expect(shouldRunLearningPlan(plan(), session({ status: "prepared" }), NOW)).toBe(true);
    expect(shouldRunLearningPlan(plan(), session({ status: "awaiting_reply" }), NOW)).toBe(false);
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
    const later = new Date(NOW.getTime() + 25 * 60 * 60 * 1000);

    expect(await scheduler.tick("follow-up", later)).toEqual([]);
    expect(engine.learning.currentSession(created.id)?.followUpCount).toBeUndefined();
    expect(scheduler.health().lastError).toContain("network unavailable");
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
    expect(message).toContain("学习回答：");
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
    sourceContent: `# 第一章\n\n${"正文".repeat(300)}`,
    sourceRawIds: ["raw_book"],
    sourceMessageId: "om_book",
    hour: 8,
    dailyCharacters: 500,
  }, NOW.getTime() - 1000);
}
