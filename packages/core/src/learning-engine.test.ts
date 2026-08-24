import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpaceId } from "@homeagent/shared";
import { KnowledgeEngine } from "./engine.ts";
import { FakeLlm } from "./testing.ts";

const SPACE: SpaceId = "personal/ou_me";
const NOW = new Date("2026-07-15T08:00:00+08:00").getTime();

function topicGuide(sourceSection = "暂无用户材料"): string {
  return [
    "## 今日目标\n理解当前知识点",
    `## 来源材料\n${sourceSection}`,
    "## 扩展知识\n以下来自模型一般知识，未经外部检索验证。",
    "## 推荐资料\n本次未获得可验证的联网资料。",
    "## 回忆练习\n先不看答案，回忆上一课的关键点。",
    "## 实践任务\n用自己的话解释概念",
    "## 思考题\n这个概念解决了什么问题？",
  ].join("\n\n");
}

describe("guided learning engine", () => {
  let dir: string;
  let llm: FakeLlm;
  let engine: KnowledgeEngine;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ha-learning-engine-"));
    llm = new FakeLlm();
    engine = new KnowledgeEngine({ dataDir: dir, llm });
    engine.ensureSpace(SPACE, { chatId: "oc_p2p" });
  });

  afterEach(() => {
    engine.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("creates a plan from the longest readable record derived from the replied-to message", async () => {
    const messageId = "om_book";
    await engine.remember({
      space: SPACE,
      source: "message",
      author: "ou_me",
      chatId: "oc_p2p",
      messageId,
      content: "一本书",
    });
    const rawId = await engine.remember({
      space: SPACE,
      source: "message",
      author: "ou_me",
      chatId: "oc_p2p",
      messageId,
      content: "# 附件：principles.md\n\n# 第一章\n\n这是足够长的正文。",
      attachments: [{ kind: "file", ref: "file_book", name: "principles.md" }],
    });

    const plan = engine.createLearningPlanFromMessage({
      space: SPACE,
      chatId: "oc_p2p",
      messageId,
      creatorId: "ou_me",
      name: "读《原则》",
      hour: 9,
    });

    expect(plan).toEqual(expect.objectContaining({
      name: "读《原则》",
      creatorId: "ou_me",
      hour: 9,
    }));
    expect(engine.learning.source(plan.id)).toEqual(expect.objectContaining({
      title: "principles.md",
      rawIds: [rawId],
      content: "# 第一章\n\n这是足够长的正文。",
    }));
  });

  test("refuses a reply target that has no readable source", () => {
    expect(() => engine.createLearningPlanFromMessage({
      space: SPACE,
      chatId: "oc_p2p",
      messageId: "om_missing",
      creatorId: "ou_me",
      name: "空书",
    })).toThrow("没有找到可阅读的书籍内容");
  });

  test("creates a topic plan from a model-generated route", async () => {
    llm.queueJSON({
      name: "Rust 异步编程入门",
      steps: [
        { title: "Future 基础", objective: "理解 Future 的惰性轮询" },
        { title: "运行时", objective: "理解 executor 与 reactor" },
        { title: "并发实践", objective: "能选择 join、select 和 spawn" },
      ],
    });

    const plan = await engine.createTopicLearningPlan({
      space: SPACE,
      chatId: "oc_p2p",
      creatorId: "ou_me",
      topic: "Rust 异步编程",
      hour: 9,
    });

    expect(plan).toEqual(expect.objectContaining({
      name: "Rust 异步编程入门",
      topic: "Rust 异步编程",
      mode: "topic",
      hour: 9,
    }));
    expect(plan.route.map((step) => step.title)).toEqual([
      "Future 基础",
      "运行时",
      "并发实践",
    ]);
    expect(llm.calls.at(-1)).toEqual(expect.objectContaining({ kind: "json" }));
    expect(llm.calls.at(-1)?.opts.prompt).toContain("Rust 异步编程");
  });

  test("diagnoses the learner before activating a customized topic route", async () => {
    llm.queueJSON({
      name: "分布式系统进阶",
      assessmentQuestions: [
        "你做过哪些分布式项目？",
        "如何解释一致性与可用性的权衡？",
        "每天可以投入多久？",
      ],
      steps: [
        { title: "概念导览", objective: "建立分布式系统术语地图" },
        { title: "一致性", objective: "理解一致性模型" },
      ],
    });
    const plan = await engine.createTopicLearningPlan({
      space: SPACE,
      chatId: "oc_p2p",
      creatorId: "ou_me",
      topic: "分布式系统",
    });

    expect(plan.profile?.status).toBe("assessing");
    expect(plan.assessmentQuestions).toHaveLength(3);
    await expect(engine.prepareLearningSession(plan.id, NOW + 1))
      .rejects.toThrow("assessment is incomplete");

    llm.queueJSON({
      level: "beginner",
      levelRationale: "有后端经验，但尚不能解释一致性权衡",
      goals: ["能设计高可用服务"],
      strengths: ["熟悉单体后端开发"],
      gaps: ["故障模型", "一致性模型"],
      preferences: ["案例驱动", "动手实验"],
      pace: "steady",
      dailyMinutes: 30,
      evidence: ["回答中没有给出分区发生时的取舍"],
      adjustment: "跳过编程基础，从故障与一致性开始。",
      steps: [
        { title: "故障模型", objective: "理解节点和网络故障" },
        { title: "一致性模型", objective: "比较不同一致性保证" },
        { title: "共识", objective: "理解 Raft 的工程权衡" },
      ],
    });
    const assessed = await engine.answerLearningAssessment(
      plan.id,
      "ou_me",
      "做过普通后端；CAP 只记得三个词；每天 30 分钟。",
      NOW + 2,
    );

    expect(assessed.profile).toEqual(expect.objectContaining({
      status: "active",
      level: "beginner",
      dailyMinutes: 30,
      gaps: ["故障模型", "一致性模型"],
    }));
    expect(assessed.route.map((step) => step.title)).toEqual([
      "故障模型",
      "一致性模型",
      "共识",
    ]);
    expect(llm.calls.at(-1)?.opts.prompt).toContain("CAP 只记得三个词");
  });

  test("adds a replied source to an owned topic plan", async () => {
    llm.queueJSON({
      name: "Rust 异步",
      steps: [
        { title: "Future", objective: "理解 Future" },
        { title: "运行时", objective: "理解运行时" },
      ],
    });
    const plan = await engine.createTopicLearningPlan({
      space: SPACE,
      chatId: "oc_p2p",
      creatorId: "ou_me",
      topic: "Rust 异步编程",
    });
    const rawId = await engine.remember({
      space: SPACE,
      source: "message",
      author: "ou_me",
      chatId: "oc_p2p",
      messageId: "om_async_book",
      content: "# 附件：async-book.md\n\n# Future\n\nFuture 是一种惰性计算。",
      attachments: [{ kind: "file", ref: "file_async", name: "async-book.md" }],
    });

    expect(() => engine.addLearningMaterialFromMessage(
      plan.id,
      "ou_other",
      "om_async_book",
    )).toThrow("只有学习计划创建者");
    const updated = engine.addLearningMaterialFromMessage(
      plan.id,
      "ou_me",
      "om_async_book",
    );
    const docRawId = await engine.remember({
      space: SPACE,
      source: "doc",
      author: "ou_me",
      chatId: "oc_p2p",
      messageId: "om_async_doc",
      content: "# 来源文档：https://example.feishu.cn/docx/async\n\n没有标题的文档正文。",
    });
    engine.addLearningMaterialFromMessage(plan.id, "ou_me", "om_async_doc");

    expect(updated.mode).toBe("topic");
    expect(engine.learning.source(plan.id)?.materials).toEqual([
      expect.objectContaining({ title: "async-book.md", rawIds: [rawId] }),
      expect.objectContaining({
        title: "https://example.feishu.cn/docx/async",
        rawIds: [docRawId],
      }),
    ]);
  });

  test("prepares one grounded lesson without advancing reading progress", async () => {
    const content = `# 第一章\n\n${"正文".repeat(300)}`;
    const plan = engine.learning.create({
      name: "读原则",
      space: SPACE,
      creatorId: "ou_me",
      chatId: "oc_p2p",
      sourceTitle: "原则",
      sourceContent: content,
      sourceRawIds: ["raw_book"],
      sourceMessageId: "om_book",
      dailyCharacters: 500,
    }, NOW);
    llm.queueText("## 今日目标\n理解第一章\n\n## 阅读提示\n慢读\n\n## 重点概念\n原则\n\n## 思考题\n1. 为什么？");

    const session = await engine.prepareLearningSession(plan.id, NOW + 1);

    expect(session).toEqual(expect.objectContaining({
      sequence: 1,
      status: "prepared",
      startOffset: 0,
      sectionTitle: "第一章",
      guide: expect.stringContaining("## 今日目标"),
    }));
    expect(session.excerpt).toContain("# 第一章");
    expect(engine.learning.get(plan.id)?.cursor).toBe(0);
    expect(llm.calls.at(-1)?.opts.prompt).toContain(session.excerpt);
  });

  test("prepares a topic lesson that separates supplied material from model expansion", async () => {
    llm.queueJSON({
      name: "Rust 异步",
      steps: [
        { title: "Future 基础", objective: "理解 Future 的惰性轮询" },
        { title: "运行时", objective: "理解运行时" },
      ],
    });
    const plan = await engine.createTopicLearningPlan({
      space: SPACE,
      chatId: "oc_p2p",
      creatorId: "ou_me",
      topic: "Rust 异步编程",
    });
    engine.learning.addMaterial(plan.id, "ou_me", {
      title: "Async Book",
      content: "Future 只有在被 poll 时才会推进。",
      rawIds: ["raw_async"],
      messageId: "om_async",
    }, NOW + 1);
    llm.queueText([
      "## 今日目标\n理解 Future",
      "## 来源材料\n[材料1] Future 需要 poll",
      "## 扩展知识\n以下来自模型一般知识，未经外部检索验证。",
      "## 推荐资料\n本次未获得可验证的联网资料。",
      "## 回忆练习\n先回忆 Future 为什么不会自动推进。",
      "## 实践任务\n解释 poll",
      "## 思考题\n为什么 Future 是惰性的？",
    ].join("\n\n"));

    const session = await engine.prepareLearningSession(plan.id, NOW + 2);

    expect(session).toEqual(expect.objectContaining({
      routeStepId: plan.route[0]?.id,
      sectionTitle: "Future 基础",
      startOffset: 0,
      endOffset: 1,
      excerpt: expect.stringContaining("[材料1：Async Book]"),
    }));
    const prompt = llm.calls.at(-1)?.opts.prompt ?? "";
    expect(prompt).toContain("Future 只有在被 poll 时才会推进");
    expect(prompt).toContain("## 来源材料");
    expect(prompt).toContain("## 扩展知识");
    expect(engine.learning.get(plan.id)?.routeIndex).toBe(0);
  });

  test("researches verified online resources before preparing a topic lesson", async () => {
    engine.close();
    const requests: string[] = [];
    engine = new KnowledgeEngine({
      dataDir: dir,
      llm,
      learningResearch: async (request) => {
        requests.push(`${request.stepTitle}:${request.gaps.join(",")}`);
        return {
          query: "Rust Async Book Waker",
          resources: [{
            title: "Async Book: Wakeups",
            url: "https://rust-lang.github.io/async-book/02_execution/03_wakeups.html",
            publisher: "Rust Project",
            summary: "解释 Waker 如何通知 executor 重新轮询任务。",
            relevance: "直接补足 Waker 与调度器协作的知识缺口。",
            kind: "documentation",
          }],
        };
      },
    });
    engine.ensureSpace(SPACE, { chatId: "oc_p2p" });
    llm.queueJSON({
      name: "Rust 异步",
      steps: [
        { title: "Waker", objective: "理解任务唤醒机制" },
        { title: "运行时", objective: "理解运行时" },
      ],
    });
    const plan = await engine.createTopicLearningPlan({
      space: SPACE,
      chatId: "oc_p2p",
      creatorId: "ou_me",
      topic: "Rust 异步编程",
    });
    llm.queueText([
      "## 今日目标\n理解 Waker",
      "## 来源材料\n暂无用户材料",
      "## 扩展知识\n以下来自模型一般知识，未经外部检索验证。",
      "## 推荐资料\n[联网资料1] Rust Async Book：https://rust-lang.github.io/async-book/02_execution/03_wakeups.html。",
      "## 回忆练习\n先回忆任务何时需要再次 poll。",
      "## 实践任务\n画出唤醒流程",
      "## 思考题\n唤醒是否等于立即 poll？",
    ].join("\n\n"));

    const session = await engine.prepareLearningSession(plan.id, NOW + 1);
    const researched = engine.learning.get(plan.id)!;

    expect(requests).toEqual(["Waker:"]);
    expect(researched.onlineResources).toEqual([
      expect.objectContaining({
        title: "Async Book: Wakeups",
        routeVersion: 1,
      }),
    ]);
    expect(session.guide).toContain("[联网资料1]");
    expect(llm.calls.at(-1)?.opts.prompt).toContain("## 已核验联网资料");
    expect(llm.calls.at(-1)?.opts.prompt).toContain(
      "https://rust-lang.github.io/async-book/02_execution/03_wakeups.html",
    );
  });

  test("continues with an honest offline lesson when web research fails", async () => {
    engine.close();
    engine = new KnowledgeEngine({
      dataDir: dir,
      llm,
      learningResearch: async () => {
        throw new Error("search unavailable");
      },
    });
    engine.ensureSpace(SPACE, { chatId: "oc_p2p" });
    llm.queueJSON({
      name: "数据库事务",
      steps: [
        { title: "隔离级别", objective: "理解并发异常" },
        { title: "MVCC", objective: "理解版本可见性" },
      ],
    });
    const plan = await engine.createTopicLearningPlan({
      space: SPACE,
      chatId: "oc_p2p",
      creatorId: "ou_me",
      topic: "数据库事务",
    });
    llm.queueText(topicGuide());

    const session = await engine.prepareLearningSession(plan.id, NOW + 1);

    expect(session.guide).toContain("本次未获得可验证的联网资料");
    expect(engine.learning.get(plan.id)?.onlineResources).toEqual([]);
  });

  test("rejects a topic lesson that fabricates a material citation or external link", async () => {
    llm.queueJSON({
      name: "Rust 异步",
      steps: [
        { title: "Future", objective: "理解 Future" },
        { title: "运行时", objective: "理解运行时" },
      ],
    });
    const plan = await engine.createTopicLearningPlan({
      space: SPACE,
      chatId: "oc_p2p",
      creatorId: "ou_me",
      topic: "Rust 异步编程",
    });
    engine.learning.addMaterial(plan.id, "ou_me", {
      title: "Async Book",
      content: "Future 只有在被 poll 时才会推进。",
      rawIds: ["raw_async"],
      messageId: "om_async",
    });
    llm.queueText([
      "## 今日目标\n理解 Future",
      "## 来源材料\n[材料9] 声称 Future 会自动运行",
      "## 扩展知识\n模型一般知识，未经外部检索验证：https://invented.example/future",
      "## 推荐资料\n本次未获得可验证的联网资料。",
      "## 回忆练习\n回忆 Future 的推进条件。",
      "## 实践任务\n解释 poll",
      "## 思考题\nFuture 如何推进？",
    ].join("\n\n"));

    await expect(engine.prepareLearningSession(plan.id, NOW + 1))
      .rejects.toThrow("不存在的材料");
    expect(engine.learning.currentSession(plan.id)).toBeUndefined();
  });

  test("uses every topic material and rotates long excerpts after a review", async () => {
    llm.queueJSON({
      name: "分布式系统",
      steps: [
        { title: "一致性", objective: "理解一致性模型" },
        { title: "共识", objective: "理解共识算法" },
      ],
    });
    const plan = await engine.createTopicLearningPlan({
      space: SPACE,
      chatId: "oc_p2p",
      creatorId: "ou_me",
      topic: "分布式系统",
    });
    for (const label of ["A", "B", "C", "D"]) {
      engine.learning.addMaterial(plan.id, "ou_me", {
        title: `材料${label}`,
        content: `${label}-开头-${"甲".repeat(3_100)}${label}-后半-${"乙".repeat(3_100)}`,
        rawIds: [`raw_${label}`],
        messageId: `om_${label}`,
      });
    }
    llm.queueText(topicGuide("[材料1] 对比四份材料中的一致性定义"));
    const first = await engine.prepareLearningSession(plan.id, NOW + 1);

    for (const [index, label] of ["A", "B", "C", "D"].entries()) {
      expect(first.excerpt).toContain(`[材料${index + 1}：材料${label}]`);
      expect(first.excerpt).toContain(`${label}-开头-`);
      expect(first.excerpt).not.toContain(`${label}-后半-`);
    }
    engine.learning.markDelivered(first.id, NOW + 2);
    llm.queueJSON({
      feedback: "## 回应点评\n需要继续\n\n## 今日总结\n尚未掌握",
      mastery: "review",
      nextFocus: "比较不同一致性模型",
    });
    await engine.answerLearningSession(plan.id, "ou_me", "还不清楚", NOW + 3);
    llm.queueText(topicGuide("[材料1] 继续比较不同一致性模型"));
    const retry = await engine.prepareLearningSession(plan.id, NOW + 4);

    for (const label of ["A", "B", "C", "D"]) {
      expect(retry.excerpt).toContain(`${label}-后半-`);
    }
  });

  test("retries the same prepared lesson and marks it delivered only after transport succeeds", async () => {
    const content = `# 第一章\n\n${"正文".repeat(300)}`;
    const plan = engine.learning.create({
      name: "读原则",
      space: SPACE,
      creatorId: "ou_me",
      chatId: "oc_p2p",
      sourceTitle: "原则",
      sourceContent: content,
      sourceRawIds: ["raw_book"],
      sourceMessageId: "om_book",
      dailyCharacters: 500,
    }, NOW);
    llm.queueText("## 今日目标\n理解第一章");
    const delivered: string[] = [];

    await expect(engine.deliverLearningSession(plan.id, NOW + 1, async (_plan, _source, session) => {
      delivered.push(session.id);
      throw new Error("network unavailable");
    })).rejects.toThrow("network unavailable");
    expect(engine.learning.currentSession(plan.id)?.status).toBe("prepared");

    expect(await engine.deliverLearningSession(plan.id, NOW + 2, async (_plan, _source, session) => {
      delivered.push(session.id);
    })).toBe(true);
    expect(delivered[0]).toBe(delivered[1]);
    expect(engine.learning.currentSession(plan.id)?.status).toBe("awaiting_reply");
    expect(await engine.deliverLearningSession(plan.id, NOW + 3, async () => {
      throw new Error("must not redeliver");
    })).toBe(false);
  });

  test("only the learner can answer, receive feedback, and advance knowledge-backed progress", async () => {
    const plan = engine.learning.create({
      name: "读原则",
      space: SPACE,
      creatorId: "ou_me",
      chatId: "oc_p2p",
      sourceTitle: "原则",
      sourceContent: "# 第一章\n\n短正文",
      sourceRawIds: ["raw_book"],
      sourceMessageId: "om_book",
    }, NOW);
    llm.queueText("## 今日目标\n理解第一章");
    await engine.deliverLearningSession(plan.id, NOW + 1, async () => {});

    await expect(engine.answerLearningSession(plan.id, "ou_other", "我的回答", NOW + 2))
      .rejects.toThrow("只有学习计划创建者可以提交回答");
    llm.queueJSON({
      feedback: "## 回应点评\n理解正确\n\n## 需要澄清\n无\n\n## 今日总结\n掌握重点\n\n## 下一步\n继续阅读",
      mastery: "ready",
      nextFocus: "继续用具体案例辨析原则与规则",
      learningRecord: {
        title: "区分原则与规则",
        summary: "原则用于指导判断，规则用于约束具体行为。",
        evidence: "学习者能够用自己的话指出作者强调原则。",
        implications: ["下一课可以比较不同原则的适用边界"],
      },
    });
    const result = await engine.answerLearningSession(plan.id, "ou_me", "作者强调原则", NOW + 3);

    expect(result.feedback).toContain("## 回应点评");
    expect(result.session.status).toBe("completed");
    expect(engine.learning.get(plan.id)).toEqual(expect.objectContaining({
      cursor: plan.sourceLength,
      status: "completed",
    }));
    expect(result.rawId).toBeDefined();
    expect(engine.registry.store(SPACE).index().getRaw(result.rawId!)).toEqual(expect.objectContaining({
      source: "learning",
      author: "ou_me",
      content: expect.stringContaining("# 学习记录：区分原则与规则"),
    }));
  });

  test("keeps a reading segment active and out of Raw until understanding is demonstrated", async () => {
    const plan = engine.learning.create({
      name: "读原则",
      space: SPACE,
      creatorId: "ou_me",
      chatId: "oc_p2p",
      sourceTitle: "原则",
      sourceContent: "# 第一章\n\n短正文",
      sourceRawIds: ["raw_book"],
      sourceMessageId: "om_book",
    }, NOW);
    llm.queueText("## 今日目标\n理解第一章");
    await engine.deliverLearningSession(plan.id, NOW + 1, async () => {});
    llm.queueJSON({
      feedback: "## 回应点评\n仍在复述导读\n\n## 需要澄清\n原则与规则的差别\n\n## 今日总结\n尚未达到目标\n\n## 下一步\n换一个案例",
      mastery: "review",
      nextFocus: "用生活案例区分原则与规则",
    });

    const reviewed = await engine.answerLearningSession(
      plan.id,
      "ou_me",
      "我还说不清楚",
      NOW + 2,
    );

    expect(reviewed.rawId).toBeUndefined();
    expect(reviewed.plan).toEqual(expect.objectContaining({
      cursor: 0,
      status: "active",
      adaptiveFocus: "用生活案例区分原则与规则",
    }));
    expect(engine.registry.store(SPACE).index().listRaw({})
      .filter((raw) => raw.source === "learning")).toHaveLength(0);

    engine.close();
    engine = new KnowledgeEngine({ dataDir: dir, llm });
    expect(engine.learning.get(plan.id)).toEqual(expect.objectContaining({
      cursor: 0,
      status: "active",
      adaptiveFocus: "用生活案例区分原则与规则",
    }));
    llm.queueText("## 今日目标\n换一个案例补强第一章");
    const retry = await engine.prepareLearningSession(plan.id, NOW + 3);
    expect(retry.excerpt).toBe("# 第一章\n\n短正文");
    expect(llm.calls.at(-1)?.opts.prompt).toContain("用生活案例区分原则与规则");
  });

  test("uses verified learning records for spaced retrieval in a later topic lesson", async () => {
    const plan = engine.learning.createTopic({
      name: "Rust 异步",
      topic: "Rust 异步编程",
      space: SPACE,
      creatorId: "ou_me",
      chatId: "oc_p2p",
      route: [
        { title: "Future", objective: "理解惰性轮询" },
        { title: "Waker", objective: "理解唤醒机制" },
      ],
    }, NOW);
    llm.queueText(topicGuide());
    await engine.deliverLearningSession(plan.id, NOW + 1, async () => {});
    llm.queueJSON({
      feedback: "## 回应点评\n解释准确\n\n## 今日总结\n已理解惰性轮询",
      mastery: "ready",
      nextFocus: "Waker 如何触发再次轮询",
      learningRecord: {
        title: "Future 是惰性计算",
        summary: "Future 只有在被 poll 时才会推进。",
        evidence: "学习者能脱离导读准确解释推进条件。",
        implications: ["可以继续学习 Waker"],
      },
    });
    const learned = await engine.answerLearningSession(
      plan.id,
      "ou_me",
      "Future 不会自己运行，只有 poll 才推进。",
      NOW + 2,
    );
    expect(learned.rawId).toBeDefined();

    llm.queueText(topicGuide());
    await engine.prepareLearningSession(plan.id, NOW + 3);
    const prompt = llm.calls.at(-1)?.opts.prompt ?? "";
    expect(prompt).toContain("[已验证记录：第 1 课 · Future]");
    expect(prompt).toContain("Future 不会自己运行，只有 poll 才推进");
    expect(prompt).toContain("间隔提取");
  });

  test("uses structured mastery feedback to adapt the next topic lesson", async () => {
    llm.queueJSON({
      name: "Rust 异步",
      steps: [
        { title: "Future", objective: "理解 Future 的惰性轮询" },
        { title: "运行时", objective: "理解 executor" },
      ],
    });
    const plan = await engine.createTopicLearningPlan({
      space: SPACE,
      chatId: "oc_p2p",
      creatorId: "ou_me",
      topic: "Rust 异步编程",
    });
    llm.queueText(topicGuide());
    await engine.deliverLearningSession(plan.id, NOW + 1, async () => {});
    llm.queueJSON({
      feedback: "## 回应点评\n把 Future 和线程混淆了\n\n## 今日总结\n需要补强轮询模型",
      mastery: "review",
      nextFocus: "用状态机解释 Future 的 poll 过程",
      level: "beginner",
      levelRationale: "仍将 Future 误解为后台线程",
      goals: ["掌握 Rust 异步编程"],
      strengths: ["知道 Future 表示异步计算"],
      gaps: ["惰性轮询", "Waker"],
      preferences: ["状态机示例"],
      pace: "steady",
      dailyMinutes: 25,
      evidence: ["回答称 Future 是后台线程"],
      routeAdjustment: "保留当前步骤，并在运行时之前加入 Waker。",
      upcomingSteps: [
        { title: "Waker", objective: "理解任务唤醒机制" },
        { title: "运行时", objective: "理解 executor" },
      ],
    });

    const result = await engine.answerLearningSession(
      plan.id,
      "ou_me",
      "Future 就是一个后台线程",
      NOW + 2,
    );

    expect(result.session).toEqual(expect.objectContaining({
      mastery: "review",
      nextFocus: "用状态机解释 Future 的 poll 过程",
    }));
    expect(result.plan).toEqual(expect.objectContaining({
      routeIndex: 0,
      adaptiveFocus: "用状态机解释 Future 的 poll 过程",
      routeVersion: 2,
      lastRouteAdjustment: "保留当前步骤，并在运行时之前加入 Waker。",
    }));
    expect(result.plan.route.map((step) => step.title)).toEqual([
      "Future",
      "Waker",
      "运行时",
    ]);
    expect(result.plan.profile).toEqual(expect.objectContaining({
      level: "beginner",
      revision: 1,
      gaps: ["惰性轮询", "Waker"],
    }));
    llm.queueText(topicGuide());
    await engine.prepareLearningSession(plan.id, NOW + 3);
    expect(llm.calls.at(-1)?.opts.prompt).toContain("用状态机解释 Future 的 poll 过程");
    expect((await engine.health()).details?.learning).toEqual(expect.objectContaining({
      topic: 1,
      reading: 0,
      materials: 0,
      reviewing: 1,
    }));
  });

  test("does not advance progress when the completed learning record cannot be captured", async () => {
    const plan = engine.learning.create({
      name: "读原则",
      space: SPACE,
      creatorId: "ou_me",
      chatId: "oc_p2p",
      sourceTitle: "原则",
      sourceContent: "# 第一章\n\n短正文",
      sourceRawIds: ["raw_book"],
      sourceMessageId: "om_book",
    }, NOW);
    llm.queueText("## 今日目标\n理解第一章");
    await engine.deliverLearningSession(plan.id, NOW + 1, async () => {});
    llm.queueJSON({
      feedback: "## 回应点评\n理解正确\n\n## 需要澄清\n无\n\n## 今日总结\n掌握重点\n\n## 下一步\n继续",
      mastery: "ready",
      nextFocus: "继续阅读",
      learningRecord: {
        title: "掌握第一章重点",
        summary: "能够概括第一章的核心观点。",
        evidence: "学习者给出了符合原文的解释。",
        implications: [],
      },
    });
    Object.defineProperty(engine, "remember", {
      value: async () => { throw new Error("capture unavailable"); },
    });

    await expect(engine.answerLearningSession(plan.id, "ou_me", "我的理解", NOW + 2))
      .rejects.toThrow("capture unavailable");
    expect(engine.learning.get(plan.id)?.cursor).toBe(0);
    expect(engine.learning.currentSession(plan.id)?.status).toBe("awaiting_reply");
  });
});
