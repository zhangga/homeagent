import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LearningPlanStore, learningProgress } from "./learning.ts";

const NOW = new Date("2026-07-15T08:00:00+08:00").getTime();

describe("LearningPlanStore", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ha-learning-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("persists a source snapshot and active plan", () => {
    const store = new LearningPlanStore(dir);
    const content = "# 第一章\n\n正文";

    const plan = store.create({
      name: "读原则",
      space: "personal/ou_me",
      creatorId: "ou_me",
      chatId: "oc_p2p",
      sourceTitle: "原则",
      sourceContent: content,
      sourceRawIds: ["raw_book"],
      sourceMessageId: "om_book",
      hour: 8,
      dailyCharacters: 3000,
    }, NOW);

    expect(plan).toEqual(expect.objectContaining({
      id: expect.stringMatching(/^learn_/),
      status: "active",
      cursor: 0,
      sourceLength: content.length,
      createdAt: NOW,
    }));
    expect(store.source(plan.id)).toEqual(expect.objectContaining({
      title: "原则",
      content,
      rawIds: ["raw_book"],
      messageId: "om_book",
    }));
    expect(new LearningPlanStore(dir).get(plan.id)).toEqual(plan);
    expect(existsSync(join(dir, "config", "learning.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "config", "learning.json"), "utf8")).plans[plan.id].name)
      .toBe("读原则");
  });

  test("persists a topic plan with an explicit learning route", () => {
    const store = new LearningPlanStore(dir);

    const plan = store.createTopic({
      name: "学习 Rust 异步编程",
      topic: "Rust 异步编程",
      space: "personal/ou_me",
      creatorId: "ou_me",
      chatId: "oc_p2p",
      route: [
        { title: "Future 基础", objective: "理解惰性求值与轮询模型" },
        { title: "异步运行时", objective: "理解 executor、reactor 与任务调度" },
        { title: "并发实践", objective: "能选择 join、select 与 spawn" },
      ],
    }, NOW);

    expect(plan).toEqual(expect.objectContaining({
      mode: "topic",
      topic: "Rust 异步编程",
      routeIndex: 0,
    }));
    expect(plan.adaptiveFocus).toBeUndefined();
    expect(plan.route.map((step) => [step.title, step.status, step.attempts])).toEqual([
      ["Future 基础", "active", 0],
      ["异步运行时", "pending", 0],
      ["并发实践", "pending", 0],
    ]);
    expect(store.source(plan.id)).toEqual(expect.objectContaining({
      title: "主题：Rust 异步编程",
      materials: [],
      rawIds: [],
    }));
    expect(new LearningPlanStore(dir).get(plan.id)).toEqual(plan);
  });

  test("completes a topic assessment and atomically replaces the provisional route", () => {
    const store = new LearningPlanStore(dir);
    const plan = store.createTopic({
      name: "分布式系统",
      topic: "分布式系统",
      space: "personal/ou_me",
      creatorId: "ou_me",
      chatId: "oc_p2p",
      assessmentQuestions: [
        "做过哪些相关项目？",
        "如何理解一致性？",
        "每天能投入多久？",
      ],
      route: [
        { title: "概念导览", objective: "建立术语地图" },
        { title: "一致性", objective: "理解一致性模型" },
      ],
    }, NOW);

    expect(plan.profile).toEqual(expect.objectContaining({
      status: "assessing",
      level: "unknown",
      revision: 0,
    }));
    expect(store.prepareSession(plan.id, {
      startOffset: 0,
      endOffset: 1,
      routeStepId: plan.route[0]!.id,
      sectionTitle: "概念导览",
      excerpt: "暂无用户材料",
      guide: "诊断前不应开课",
      preparedAt: NOW + 1,
    })).toBeUndefined();

    const updated = store.completeAssessment(plan.id, "ou_me", {
      answers: "做过单体服务；知道 CAP；每天 30 分钟。",
      profile: {
        level: "beginner",
        levelRationale: "有工程经验，但缺少分布式一致性实践",
        goals: ["能设计高可用服务"],
        strengths: ["熟悉单体服务开发"],
        gaps: ["一致性模型", "故障恢复"],
        preferences: ["案例驱动"],
        pace: "steady",
        dailyMinutes: 30,
        evidence: ["能够描述 CAP 的三个词，但无法解释权衡"],
      },
      route: [
        { title: "故障模型", objective: "理解网络与节点故障" },
        { title: "一致性模型", objective: "比较线性一致性与最终一致性" },
        { title: "共识实践", objective: "理解 Raft 的工程取舍" },
      ],
      adjustment: "跳过通用编程基础，从故障模型开始。",
    }, NOW + 2)!;

    expect(updated.profile).toEqual(expect.objectContaining({
      status: "active",
      level: "beginner",
      dailyMinutes: 30,
      revision: 1,
    }));
    expect(updated.route.map((step) => [step.title, step.status])).toEqual([
      ["故障模型", "active"],
      ["一致性模型", "pending"],
      ["共识实践", "pending"],
    ]);
    expect(updated.routeVersion).toBe(2);
    expect(new LearningPlanStore(dir).get(plan.id)).toEqual(updated);
  });

  test("rejects oversized topic route fields before persistence", () => {
    const store = new LearningPlanStore(dir);

    expect(() => store.createTopic({
      name: "学习计划",
      topic: "主题",
      space: "personal/ou_me",
      creatorId: "ou_me",
      chatId: "oc_p2p",
      route: [
        { title: "第一步", objective: "甲".repeat(501) },
        { title: "第二步", objective: "正常目标" },
      ],
    }, NOW)).toThrow("invalid topic learning plan input");
    expect(store.list()).toEqual([]);
  });

  test("migrates pre-topic reading state on load", () => {
    const store = new LearningPlanStore(dir);
    const plan = createPlan(store);
    const path = join(dir, "config", "learning.json");
    const file = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
    delete file.plans[plan.id].mode;
    delete file.plans[plan.id].route;
    delete file.plans[plan.id].routeIndex;
    delete file.sources[plan.sourceId].materials;
    writeFileSync(path, JSON.stringify(file));

    const migrated = new LearningPlanStore(dir);

    expect(migrated.get(plan.id)).toEqual(expect.objectContaining({
      mode: "reading",
      route: [],
      routeIndex: 0,
    }));
    expect(migrated.source(plan.id)?.materials).toEqual([
      expect.objectContaining({ title: "书", rawIds: ["raw_1"] }),
    ]);
  });

  test("appends distinct source materials to a topic plan without changing its route progress", () => {
    const store = new LearningPlanStore(dir);
    const plan = store.createTopic({
      name: "学习 Rust",
      topic: "Rust 异步编程",
      space: "personal/ou_me",
      creatorId: "ou_me",
      chatId: "oc_p2p",
      route: [
        { title: "Future", objective: "理解 Future" },
        { title: "运行时", objective: "理解运行时" },
      ],
    }, NOW);

    expect(store.addMaterial(plan.id, "ou_other", {
      title: "错误权限",
      content: "不应写入",
      rawIds: ["raw_wrong"],
      messageId: "om_wrong",
    }, NOW + 1)).toBeUndefined();
    const updated = store.addMaterial(plan.id, "ou_me", {
      title: "Rust Async Book",
      content: "Future 是一种惰性计算。",
      rawIds: ["raw_async"],
      messageId: "om_async",
    }, NOW + 2)!;

    expect(updated).toEqual(expect.objectContaining({ routeIndex: 0, cursor: 0 }));
    expect(store.source(plan.id)).toEqual(expect.objectContaining({
      rawIds: ["raw_async"],
      content: expect.stringContaining("# 来源材料：Rust Async Book"),
      materials: [expect.objectContaining({
        title: "Rust Async Book",
        rawIds: ["raw_async"],
        messageId: "om_async",
      })],
    }));
    expect(() => store.addMaterial(plan.id, "ou_me", {
      title: "重复材料",
      content: "重复",
      rawIds: ["raw_async_2"],
      messageId: "om_async",
    }, NOW + 3)).toThrow("已经添加");
    expect(new LearningPlanStore(dir).source(plan.id)?.materials).toHaveLength(1);
  });

  test("keeps a weak topic step active and advances it only after mastery", () => {
    const store = new LearningPlanStore(dir);
    const plan = store.createTopic({
      name: "学习 Rust",
      topic: "Rust 异步编程",
      space: "personal/ou_me",
      creatorId: "ou_me",
      chatId: "oc_p2p",
      route: [
        { title: "Future", objective: "理解 Future" },
        { title: "运行时", objective: "理解运行时" },
      ],
    }, NOW);
    const firstStep = plan.route[0]!;
    const first = store.prepareSession(plan.id, {
      startOffset: 0,
      endOffset: 1,
      routeStepId: firstStep.id,
      sectionTitle: firstStep.title,
      excerpt: "暂无用户材料",
      guide: "## 今日目标\n理解 Future",
      preparedAt: NOW + 1,
    })!;
    store.markDelivered(first.id, NOW + 2);

    store.completeSession(first.id, {
      learnerReply: "Future 是线程",
      feedback: "还需要区分 Future 与线程",
      mastery: "review",
      nextFocus: "Future 的惰性轮询",
      adjustNextLesson: true,
      nextLessonRequest: "下一课继续补强 Future 的惰性轮询",
      completedAt: NOW + 3,
    });
    expect(store.get(plan.id)).toEqual(expect.objectContaining({
      routeIndex: 0,
      adaptiveFocus: "Future 的惰性轮询",
      status: "active",
    }));
    expect(store.get(plan.id)?.route[0]).toEqual(expect.objectContaining({
      status: "active",
      attempts: 1,
    }));

    const retry = store.prepareSession(plan.id, {
      startOffset: 0,
      endOffset: 1,
      routeStepId: firstStep.id,
      sectionTitle: firstStep.title,
      excerpt: "暂无用户材料",
      guide: "## 今日目标\n补强 Future",
      preparedAt: NOW + 4,
    })!;
    store.markDelivered(retry.id, NOW + 5);
    store.completeSession(retry.id, {
      learnerReply: "Future 被 poll 才推进",
      feedback: "已经掌握",
      mastery: "ready",
      nextFocus: "executor 如何调度 Future",
      adjustNextLesson: true,
      nextLessonRequest: "下一课衔接 executor",
      completedAt: NOW + 6,
    });

    expect(store.get(plan.id)).toEqual(expect.objectContaining({
      routeIndex: 1,
      adaptiveFocus: "executor 如何调度 Future",
      status: "active",
    }));
    expect(store.get(plan.id)?.route.map((step) => [step.status, step.attempts])).toEqual([
      ["completed", 2],
      ["active", 0],
    ]);

    const secondStep = store.get(plan.id)!.route[1]!;
    const second = store.prepareSession(plan.id, {
      startOffset: 1,
      endOffset: 2,
      routeStepId: secondStep.id,
      sectionTitle: secondStep.title,
      excerpt: "暂无用户材料",
      guide: "## 今日目标\n理解运行时",
      preparedAt: NOW + 7,
    })!;
    store.markDelivered(second.id, NOW + 8);
    store.skipCurrent(plan.id, "ou_me", NOW + 9);
    expect(store.get(plan.id)).toEqual(expect.objectContaining({
      routeIndex: 2,
      status: "completed",
    }));
    expect(learningProgress(store.get(plan.id)!)).toBe(100);
  });

  test("updates the learner profile and replaces only future route steps after feedback", () => {
    const store = new LearningPlanStore(dir);
    const plan = store.createTopic({
      name: "学习 Rust",
      topic: "Rust 异步编程",
      space: "personal/ou_me",
      creatorId: "ou_me",
      chatId: "oc_p2p",
      route: [
        { title: "Future", objective: "理解 Future" },
        { title: "运行时", objective: "理解运行时" },
        { title: "并发实践", objective: "完成并发任务" },
      ],
    }, NOW);
    const session = store.prepareSession(plan.id, {
      startOffset: 0,
      endOffset: 1,
      routeStepId: plan.route[0]!.id,
      sectionTitle: "Future",
      excerpt: "暂无用户材料",
      guide: "## 今日目标\n理解 Future",
      preparedAt: NOW + 1,
    })!;
    store.markDelivered(session.id, NOW + 2);
    store.completeSession(session.id, {
      learnerReply: "Future 被 poll 才推进",
      feedback: "已经掌握 Future 的核心机制",
      mastery: "ready",
      nextFocus: "理解唤醒机制",
      adaptive: {
        profile: {
          level: "intermediate",
          levelRationale: "能够准确解释惰性轮询",
          goals: ["独立排查异步程序问题"],
          strengths: ["Future 心智模型"],
          gaps: ["Waker 与调度器协作"],
          preferences: ["代码实验"],
          pace: "intensive",
          dailyMinutes: 45,
          evidence: ["明确指出 Future 只有在 poll 时推进"],
        },
        routeAdjustment: "删除重复的 Future 入门内容，补入唤醒机制。",
        upcomingSteps: [
          { title: "Waker", objective: "理解任务如何被重新调度" },
          { title: "运行时诊断", objective: "使用 tracing 排查阻塞" },
        ],
      },
      adjustNextLesson: true,
      nextLessonRequest: "下一课进入 Waker",
      completedAt: NOW + 3,
    });

    const updated = store.get(plan.id)!;
    expect(updated.route[0]).toEqual(expect.objectContaining({
      id: plan.route[0]!.id,
      status: "completed",
    }));
    expect(updated.route.slice(1).map((step) => [step.title, step.status])).toEqual([
      ["Waker", "active"],
      ["运行时诊断", "pending"],
    ]);
    expect(updated.profile).toEqual(expect.objectContaining({
      level: "intermediate",
      revision: 1,
      dailyMinutes: 45,
    }));
    expect(updated.lastRouteAdjustment).toContain("补入唤醒机制");
    expect(updated.routeVersion).toBe(2);
  });

  test("preserves diagnosis evidence across later route revisions", () => {
    const store = new LearningPlanStore(dir);
    const plan = store.createTopic({
      name: "学习数据库",
      topic: "数据库事务",
      space: "personal/ou_me",
      creatorId: "ou_me",
      chatId: "oc_p2p",
      assessmentQuestions: [
        "如何理解事务？",
        "遇到过哪些并发异常？",
        "希望解决什么实际问题？",
      ],
      route: [
        { title: "事务基础", objective: "理解 ACID" },
        { title: "隔离概览", objective: "认识常见并发现象" },
      ],
    }, NOW);
    const assessed = store.completeAssessment(plan.id, "ou_me", {
      answers: "知道 ACID，但没有处理过隔离级别问题。",
      profile: {
        level: "beginner",
        levelRationale: "具备术语基础，缺少实践",
        goals: ["能够定位事务异常"],
        strengths: ["了解 ACID"],
        gaps: ["隔离级别"],
        preferences: ["案例驱动"],
        pace: "steady",
        dailyMinutes: 30,
        evidence: ["诊断时能说出 ACID"],
      },
      route: [
        { title: "隔离级别", objective: "理解常见并发现象" },
        { title: "锁与版本", objective: "比较并发控制机制" },
      ],
      adjustment: "从隔离级别案例开始。",
    }, NOW + 1)!;
    const session = store.prepareSession(plan.id, {
      startOffset: 0,
      endOffset: 1,
      routeStepId: assessed.route[0]!.id,
      sectionTitle: "隔离级别",
      excerpt: "暂无用户材料",
      guide: "通过案例判断隔离问题",
      preparedAt: NOW + 2,
    })!;
    store.markDelivered(session.id, NOW + 3);
    store.completeSession(session.id, {
      learnerReply: "这个例子属于不可重复读。",
      feedback: "判断正确",
      mastery: "ready",
      nextFocus: "理解 MVCC",
      adaptive: {
        profile: {
          level: "intermediate",
          levelRationale: "能够识别典型隔离异常",
          goals: ["能够定位事务异常"],
          strengths: ["识别不可重复读"],
          gaps: ["MVCC"],
          preferences: ["案例驱动"],
          pace: "steady",
          dailyMinutes: 30,
          evidence: ["课程中正确识别不可重复读"],
        },
        routeAdjustment: "转入 MVCC。",
        upcomingSteps: [{ title: "MVCC", objective: "理解版本可见性" }],
      },
      adjustNextLesson: true,
      nextLessonRequest: "下一课进入 MVCC",
      completedAt: NOW + 4,
    });

    expect(store.get(plan.id)?.profile?.evidence).toEqual([
      "诊断时能说出 ACID",
      "课程中正确识别不可重复读",
    ]);
  });

  test("binds online recommendations to the current route version", () => {
    const store = new LearningPlanStore(dir);
    const plan = store.createTopic({
      name: "学习 Rust",
      topic: "Rust 异步编程",
      space: "personal/ou_me",
      creatorId: "ou_me",
      chatId: "oc_p2p",
      route: [
        { title: "Future", objective: "理解 Future" },
        { title: "运行时", objective: "理解运行时" },
      ],
    }, NOW);
    const researched = store.replaceOnlineResources(plan.id, 1, {
      query: "Rust Future official documentation",
      resources: [{
        title: "Async Book",
        url: "https://rust-lang.github.io/async-book/?utm_source=test",
        publisher: "Rust Project",
        summary: "Rust 官方异步编程教程。",
        relevance: "适合建立 Future 与运行时心智模型。",
        kind: "documentation",
      }],
    }, NOW + 1)!;

    expect(researched.onlineResources).toEqual([
      expect.objectContaining({
        title: "Async Book",
        url: "https://rust-lang.github.io/async-book/",
        routeVersion: 1,
      }),
    ]);
    expect(researched.resourceResearchQuery).toContain("Future");

    const session = store.prepareSession(plan.id, {
      startOffset: 0,
      endOffset: 1,
      routeStepId: plan.route[0]!.id,
      sectionTitle: "Future",
      excerpt: "暂无用户材料",
      guide: "理解 Future",
      preparedAt: NOW + 2,
    })!;
    store.markDelivered(session.id, NOW + 3);
    store.completeSession(session.id, {
      learnerReply: "Future 需要被 poll",
      feedback: "判断正确",
      mastery: "ready",
      nextFocus: "理解 Waker",
      adaptive: {
        profile: {
          level: "intermediate",
          levelRationale: "能够解释 Future 的推进机制",
          goals: ["理解异步运行时"],
          strengths: ["Future 心智模型"],
          gaps: ["Waker"],
          preferences: ["代码实验"],
          pace: "steady",
          dailyMinutes: 30,
          evidence: ["说明 Future 需要被 poll"],
        },
        routeAdjustment: "转入 Waker。",
        upcomingSteps: [
          { title: "Waker", objective: "理解任务唤醒" },
          { title: "运行时", objective: "理解调度机制" },
        ],
      },
      adjustNextLesson: true,
      nextLessonRequest: "下一课进入 Waker",
      completedAt: NOW + 4,
    });

    const revised = store.get(plan.id)!;
    expect(revised.routeVersion).toBe(2);
    expect(revised.onlineResources).toEqual([]);
    expect(revised.resourceResearchVersion).toBeUndefined();
    expect(store.replaceOnlineResources(plan.id, 1, {
      query: "stale",
      resources: [{
        title: "Stale",
        url: "https://example.com/stale",
        publisher: "Example",
        summary: "旧路线资料。",
        relevance: "已经过期。",
        kind: "article",
      }],
    }, NOW + 5)).toBeUndefined();
  });

  test("keeps a prepared lesson retryable until delivery succeeds", () => {
    const store = new LearningPlanStore(dir);
    const plan = createPlan(store);

    const session = store.prepareSession(plan.id, {
      startOffset: 0,
      endOffset: 4,
      sectionTitle: "第一章",
      excerpt: "正文",
      guide: "## 今日目标\n理解正文",
      preparedAt: NOW,
    });

    expect(session).toEqual(expect.objectContaining({
      id: expect.stringMatching(/^learn_session_/),
      sequence: 1,
      status: "prepared",
    }));
    expect(store.prepareSession(plan.id, {
      startOffset: 0,
      endOffset: 8,
      sectionTitle: "不应重复",
      excerpt: "另一段",
      guide: "另一份导读",
      preparedAt: NOW + 1,
    })?.id).toBe(session?.id);

    expect(store.markDelivered(session!.id, NOW + 1000)?.status).toBe("awaiting_reply");
    expect(new LearningPlanStore(dir).currentSession(plan.id)).toEqual(expect.objectContaining({
      id: session!.id,
      status: "awaiting_reply",
      deliveredAt: NOW + 1000,
    }));
  });

  test("advances progress only after an awaiting lesson is completed", () => {
    const store = new LearningPlanStore(dir);
    const plan = createPlan(store);
    const session = store.prepareSession(plan.id, {
      startOffset: 0,
      endOffset: 4,
      sectionTitle: "第一章",
      excerpt: "正文内容",
      guide: "导读",
      preparedAt: NOW,
    })!;

    expect(store.completeSession(session.id, {
      learnerReply: "抢答",
      feedback: "尚未投递",
      completedAt: NOW + 1,
    })).toBeUndefined();
    expect(store.get(plan.id)?.cursor).toBe(0);

    store.markDelivered(session.id, NOW + 2);
    expect(store.completeSession(session.id, {
      learnerReply: "我的理解",
      feedback: "理解正确",
      completedAt: NOW + 3,
    })).toEqual(expect.objectContaining({
      status: "completed",
      learnerReply: "我的理解",
      feedback: "理解正确",
    }));
    const reopened = new LearningPlanStore(dir);
    expect(reopened.get(plan.id)).toEqual(expect.objectContaining({
      cursor: 4,
      status: "active",
    }));
    expect(reopened.currentSession(plan.id)).toBeUndefined();
  });

  test("atomically archives an unanswered lesson so the next lesson can be prepared", () => {
    const store = new LearningPlanStore(dir);
    const plan = createPlan(store);
    const session = store.prepareSession(plan.id, {
      startOffset: 0,
      endOffset: 4,
      sectionTitle: "第一章",
      excerpt: "正文内容",
      guide: "导读",
      preparedAt: NOW,
    })!;
    store.markDelivered(session.id, NOW + 1);

    expect(store.advanceUnanswered(plan.id, "wrong-session", NOW + 2)).toBeUndefined();
    expect(store.advanceUnanswered(plan.id, session.id, NOW + 2)).toEqual(
      expect.objectContaining({ id: session.id, status: "skipped", completedAt: NOW + 2 }),
    );

    const reopened = new LearningPlanStore(dir);
    expect(reopened.get(plan.id)).toEqual(expect.objectContaining({ cursor: 4, status: "active" }));
    expect(reopened.currentSession(plan.id)).toBeUndefined();
    expect(reopened.sessionsForPlan(plan.id)).toEqual([
      expect.objectContaining({ id: session.id, status: "skipped" }),
    ]);
  });

  test("enforces chat ownership while allowing explicit administrative updates", () => {
    const store = new LearningPlanStore(dir);
    const plan = createPlan(store);

    expect(store.pause(plan.id, "ou_other")).toBeUndefined();
    expect(store.pause(plan.id, "ou_me")?.status).toBe("paused");
    expect(store.resume(plan.id, "ou_me")?.status).toBe("active");
    expect(store.update(plan.id, "ou_other", { hour: 22 })).toBeUndefined();
    expect(store.update(plan.id, undefined, { hour: 99, dailyCharacters: 100 }))
      .toEqual(expect.objectContaining({ hour: 23, dailyCharacters: 500 }));
  });

  test("lets only the creator skip an awaiting lesson and completes at end of source", () => {
    const store = new LearningPlanStore(dir);
    const plan = createPlan(store);
    const session = store.prepareSession(plan.id, {
      startOffset: 0,
      endOffset: plan.sourceLength,
      sectionTitle: "全书",
      excerpt: "正文内容共八字",
      guide: "导读",
      preparedAt: NOW,
    })!;
    store.markDelivered(session.id, NOW + 1);

    expect(store.skipCurrent(plan.id, "ou_other", NOW + 2)).toBeUndefined();
    expect(store.skipCurrent(plan.id, "ou_me", NOW + 2)?.status).toBe("skipped");
    expect(store.get(plan.id)).toEqual(expect.objectContaining({
      cursor: plan.sourceLength,
      status: "completed",
    }));
  });

  test("completing or skipping the current lesson does not implicitly resume a paused plan", () => {
    const store = new LearningPlanStore(dir);
    const completedPlan = createPlan(store);
    const completedSession = store.prepareSession(completedPlan.id, {
      startOffset: 0,
      endOffset: 4,
      sectionTitle: "第一章",
      excerpt: "正文内容",
      guide: "导读",
      preparedAt: NOW,
    })!;
    store.markDelivered(completedSession.id, NOW + 1);
    store.pause(completedPlan.id, "ou_me", NOW + 2);
    store.completeSession(completedSession.id, {
      learnerReply: "我的理解",
      feedback: "理解正确",
      completedAt: NOW + 3,
    });
    expect(store.get(completedPlan.id)?.status).toBe("paused");

    const skippedPlan = createPlan(store);
    const skippedSession = store.prepareSession(skippedPlan.id, {
      startOffset: 0,
      endOffset: 4,
      sectionTitle: "第一章",
      excerpt: "正文内容",
      guide: "导读",
      preparedAt: NOW + 4,
    })!;
    store.markDelivered(skippedSession.id, NOW + 5);
    store.pause(skippedPlan.id, "ou_me", NOW + 6);
    store.skipCurrent(skippedPlan.id, "ou_me", NOW + 7);
    expect(store.get(skippedPlan.id)?.status).toBe("paused");
  });

  test("keeps visible state unchanged when durable persistence fails", () => {
    const store = new LearningPlanStore(dir);
    const plan = createPlan(store);
    Object.defineProperty(store, "persist", {
      value: () => { throw new Error("disk full"); },
    });

    expect(() => store.pause(plan.id, "ou_me", NOW + 1)).toThrow("disk full");
    expect(store.get(plan.id)?.status).toBe("active");
    expect(() => store.create({
      name: "不能留在内存",
      space: "personal/ou_me",
      creatorId: "ou_me",
      chatId: "oc_p2p",
      sourceTitle: "失败书籍",
      sourceContent: "内容",
      sourceRawIds: ["raw_failed"],
      sourceMessageId: "om_failed",
    }, NOW + 2)).toThrow("disk full");
    expect(store.list()).toHaveLength(1);
  });

  test("exports and restores a complete space-scoped learning graph", () => {
    const store = new LearningPlanStore(dir);
    const plan = createPlan(store);
    const session = store.prepareSession(plan.id, {
      startOffset: 0,
      endOffset: 4,
      sectionTitle: "第一章",
      excerpt: "正文内容",
      guide: "导读",
      preparedAt: NOW,
    })!;
    store.markDelivered(session.id, NOW + 1);

    const archive = store.exportBySpace("personal/ou_me");
    expect(archive).toEqual({
      plans: [expect.objectContaining({ id: plan.id })],
      sources: [expect.objectContaining({ content: "正文内容共八字" })],
      sessions: [expect.objectContaining({ id: session.id, status: "awaiting_reply" })],
    });

    const restored = new LearningPlanStore(join(dir, "restored"));
    expect(restored.restore(archive).map((item) => item.id)).toEqual([plan.id]);
    expect(restored.source(plan.id)?.content).toBe("正文内容共八字");
    expect(restored.currentSession(plan.id)?.id).toBe(session.id);
  });

  test("rejects a restore graph whose current session belongs to another plan", () => {
    const source = new LearningPlanStore(join(dir, "source"));
    const first = createPlan(source);
    const second = createPlan(source);
    const session = source.prepareSession(second.id, {
      startOffset: 0,
      endOffset: 4,
      sectionTitle: "第一章",
      excerpt: "正文内容",
      guide: "导读",
      preparedAt: NOW,
    })!;
    const archive = source.exportBySpace("personal/ou_me");
    archive.plans[0] = { ...archive.plans[0]!, currentSessionId: session.id };

    const target = new LearningPlanStore(join(dir, "target"));
    expect(() => target.restore(archive)).toThrow("current session");
    expect(target.list()).toEqual([]);
    expect(source.get(first.id)).toBeDefined();
  });

  test("rejects topic archives with out-of-range learner profile fields", () => {
    const source = new LearningPlanStore(join(dir, "invalid-profile-source"));
    const plan = source.createTopic({
      name: "学习数据库",
      topic: "数据库事务",
      space: "personal/ou_me",
      creatorId: "ou_me",
      chatId: "oc_p2p",
      route: [
        { title: "事务基础", objective: "理解 ACID" },
        { title: "隔离级别", objective: "理解并发异常" },
      ],
    }, NOW);
    const archive = source.exportBySpace("personal/ou_me");
    archive.plans[0] = {
      ...archive.plans[0]!,
      profile: {
        ...plan.profile!,
        dailyMinutes: 120,
      },
    };

    const target = new LearningPlanStore(join(dir, "invalid-profile-target"));
    expect(() => target.restore(archive)).toThrow("invalid or duplicate learning plan");
    expect(target.list()).toEqual([]);
  });

  test("rejects topic archives whose sessions point at the wrong route step", () => {
    const source = new LearningPlanStore(join(dir, "topic-source"));
    const plan = source.createTopic({
      name: "学习 Rust",
      topic: "Rust 异步编程",
      space: "personal/ou_me",
      creatorId: "ou_me",
      chatId: "oc_p2p",
      route: [
        { title: "Future", objective: "理解 Future" },
        { title: "运行时", objective: "理解运行时" },
      ],
    }, NOW);
    source.prepareSession(plan.id, {
      startOffset: 0,
      endOffset: 1,
      routeStepId: plan.route[0]!.id,
      sectionTitle: "Future",
      excerpt: "暂无用户材料",
      guide: "导读",
      preparedAt: NOW + 1,
    });
    const archive = source.exportBySpace("personal/ou_me");
    archive.sessions[0] = {
      ...archive.sessions[0]!,
      routeStepId: plan.route[1]!.id,
    };

    const target = new LearningPlanStore(join(dir, "topic-target"));
    expect(() => target.restore(archive)).toThrow("route step");
    expect(target.list()).toEqual([]);
  });

  test("removes source snapshots and sessions by provenance, owner, or space", () => {
    const store = new LearningPlanStore(dir);
    const first = createPlan(store);
    const second = store.create({
      name: "另一计划",
      space: "team/oc_team",
      creatorId: "ou_other",
      chatId: "oc_team",
      sourceTitle: "另一书",
      sourceContent: "另一正文",
      sourceRawIds: ["raw_other"],
      sourceMessageId: "om_other",
    }, NOW + 1);

    expect(store.remove(first.id, "ou_other")).toBe(false);
    expect(store.removeByRawIds(new Set(["raw_1"]))).toBe(1);
    expect(store.get(first.id)).toBeUndefined();
    expect(store.removeBySpace("team/oc_team")).toBe(1);
    expect(store.get(second.id)).toBeUndefined();
    expect(store.list()).toEqual([]);
  });
});

function createPlan(store: LearningPlanStore) {
  return store.create({
    name: "读书",
    space: "personal/ou_me",
    creatorId: "ou_me",
    chatId: "oc_p2p",
    sourceTitle: "书",
    sourceContent: "正文内容共八字",
    sourceRawIds: ["raw_1"],
    sourceMessageId: "om_1",
    hour: 8,
    dailyCharacters: 3000,
  }, NOW);
}
