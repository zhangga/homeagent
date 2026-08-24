import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeLlm, KnowledgeEngine, SkillCatalog } from "@homeagent/core";
import {
  handleLearningAnswer,
  handleLearningCommand,
  parseLearningAnswer,
  parseLearningCommand,
} from "./learning-commands.ts";

describe("learning command parsing", () => {
  test("recognizes explicit plan controls and answers only", () => {
    expect(parseLearningCommand("/learn")).toEqual({ verb: "list", arg: "" });
    expect(parseLearningCommand("/learn new 原则")).toEqual({ verb: "new", arg: "原则" });
    expect(parseLearningCommand("/learn topic Rust 异步编程"))
      .toEqual({ verb: "topic", arg: "Rust 异步编程" });
    expect(parseLearningCommand("/learn add 1")).toEqual({ verb: "add", arg: "1" });
    expect(parseLearningCommand("/learn route Rust 异步"))
      .toEqual({ verb: "route", arg: "Rust 异步" });
    expect(parseLearningCommand("/learn resources Rust 异步"))
      .toEqual({ verb: "resources", arg: "Rust 异步" });
    expect(parseLearningCommand("/learn 暂停 1")).toEqual({ verb: "pause", arg: "1" });
    expect(parseLearningCommand("/learn resume 原则")).toEqual({ verb: "resume", arg: "原则" });
    expect(parseLearningCommand("/learn skip 1")).toEqual({ verb: "skip", arg: "1" });
    expect(parseLearningCommand("/learn delete 原则")).toEqual({ verb: "delete", arg: "原则" });
    expect(parseLearningCommand("谁负责后端？")).toBeNull();
    expect(parseLearningAnswer("学习回答：我认为作者在区分原则和规则"))
      .toBe("我认为作者在区分原则和规则");
    expect(parseLearningAnswer("这周有什么安排？")).toBeNull();
  });
});

describe("learning command handling", () => {
  let dir: string;
  let llm: FakeLlm;
  let engine: KnowledgeEngine;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ha-learning-commands-"));
    llm = new FakeLlm();
    engine = new KnowledgeEngine({ dataDir: dir, llm });
    engine.ensureSpace("personal/ou_me", { chatId: "oc_p2p" });
  });

  afterEach(() => {
    engine.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("creates a plan only from a replied-to readable source", async () => {
    const context = {
      space: "personal/ou_me" as const,
      chatId: "oc_p2p",
      actorId: "ou_me",
    };
    expect(await handleLearningCommand(engine, { verb: "new", arg: "原则" }, context))
      .toContain("请回复包含书籍附件");

    await engine.remember({
      space: context.space,
      source: "message",
      author: "ou_me",
      chatId: context.chatId,
      messageId: "om_book",
      content: "# 附件：book.md\n\n# 第一章\n\n正文",
    });
    const created = await handleLearningCommand(
      engine,
      { verb: "new", arg: "原则" },
      { ...context, sourceMessageId: "om_book" },
    );
    expect(created).toContain("已创建学习计划「原则」");
    expect(await handleLearningCommand(engine, { verb: "list", arg: "" }, context))
      .toContain("1. 原则");
  });

  test("creates a topic route, adds replied material, and displays adaptive progress", async () => {
    const context = {
      space: "personal/ou_me" as const,
      chatId: "oc_p2p",
      actorId: "ou_me",
    };
    llm.queueJSON({
      name: "Rust 异步",
      steps: [
        { title: "Future", objective: "理解 Future" },
        { title: "运行时", objective: "理解运行时" },
      ],
    });

    const created = await handleLearningCommand(
      engine,
      { verb: "topic", arg: "Rust 异步编程" },
      context,
    );
    expect(created).toContain("已创建主题学习计划「Rust 异步」");
    expect(await handleLearningCommand(engine, { verb: "route", arg: "1" }, context))
      .toContain("▶️ Future — 理解 Future");

    await engine.remember({
      space: context.space,
      source: "message",
      author: "ou_me",
      chatId: context.chatId,
      messageId: "om_async",
      content: "# 附件：async.md\n\nFuture 只有在 poll 时推进。",
      attachments: [{ kind: "file", ref: "file_async", name: "async.md" }],
    });
    const added = await handleLearningCommand(
      engine,
      { verb: "add", arg: "1" },
      { ...context, sourceMessageId: "om_async" },
    );
    expect(added).toContain("已添加材料「async.md」");
    expect(engine.learning.source(engine.learning.list()[0]!.id)?.materials).toHaveLength(1);
  });

  test("surfaces a safe Skill warning after a learning Agent call", async () => {
    engine.close();
    const skillRoot = join(dir, "skill-root");
    const skillDir = join(skillRoot, "coach");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      ["---", "name: coach", "description: Coach.", "---"].join("\n"),
      "utf8",
    );
    const catalog = new SkillCatalog({
      roots: [{
        kind: "shared-agents",
        path: skillRoot,
        providerIds: ["claude", "codex", "trae-cli"],
      }],
    });
    catalog.refresh();
    engine = new KnowledgeEngine({ dataDir: dir, llm, skillCatalog: catalog });
    engine.ensureSpace("personal/ou_me", { chatId: "oc_p2p" });
    const agent = engine.agents.create({
      name: "Learning Agent",
      provider: "claude",
      visibility: "Personal",
      skills: [{
        kind: "source",
        sourceKey: "shared-agents:coach",
        name: "coach",
      }],
    });
    engine.updateSpaceMeta("personal/ou_me", { agentId: agent.id });
    rmSync(skillDir, { recursive: true, force: true });
    llm.queueJSON({
      name: "Rust",
      assessmentQuestions: [
        "你了解 Future 吗？",
        "你写过异步代码吗？",
        "你希望解决什么问题？",
      ],
      steps: [
        { title: "Future", objective: "理解 Future" },
        { title: "Runtime", objective: "理解运行时" },
      ],
    });

    const reply = await handleLearningCommand(
      engine,
      { verb: "topic", arg: "Rust" },
      {
        space: "personal/ou_me",
        chatId: "oc_p2p",
        actorId: "ou_me",
      },
    );

    expect(reply).toContain("Skill 提示");
    expect(reply).toContain("coach");
    expect(reply).not.toContain(skillRoot);
  });

  test("runs an入学诊断 before starting a personalized topic route", async () => {
    const context = {
      space: "personal/ou_me" as const,
      chatId: "oc_p2p",
      actorId: "ou_me",
    };
    llm.queueJSON({
      name: "分布式系统",
      assessmentQuestions: [
        "做过哪些相关项目？",
        "如何理解一致性？",
        "每天能投入多久？",
      ],
      steps: [
        { title: "概念导览", objective: "建立术语地图" },
        { title: "一致性", objective: "理解一致性模型" },
      ],
    });

    const created = await handleLearningCommand(
      engine,
      { verb: "topic", arg: "分布式系统" },
      context,
    );
    expect(created).toContain("开始前，我想先了解你目前的基础和目标");
    expect(created).toContain("1. 做过哪些相关项目？");
    expect(created).toContain("学习回答：");
    expect(await handleLearningCommand(engine, { verb: "route", arg: "1" }, context))
      .toContain("当前是初步路线");

    llm.queueJSON({
      level: "beginner",
      levelRationale: "有后端经验但缺少一致性实践",
      goals: ["设计高可用服务"],
      strengths: ["后端开发"],
      gaps: ["故障模型", "一致性模型"],
      preferences: ["案例驱动"],
      pace: "steady",
      dailyMinutes: 30,
      evidence: ["只能说出 CAP 的名称"],
      adjustment: "从故障模型开始。",
      steps: [
        { title: "故障模型", objective: "理解网络和节点故障" },
        { title: "一致性模型", objective: "比较一致性保证" },
      ],
    });
    const assessed = await handleLearningAnswer(
      engine,
      "做过普通后端；CAP 只记得名称；每天 30 分钟。",
      context,
    );

    expect(assessed).toContain("已完成「分布式系统」入学诊断");
    expect(assessed).toContain("当前判断：入门");
    expect(assessed).toContain("每天约 30 分钟");
    expect(assessed).toContain("1. 故障模型");
    expect(engine.learning.list()[0]?.profile?.status).toBe("active");
  });

  test("refreshes and lists verified online learning resources", async () => {
    engine.close();
    engine = new KnowledgeEngine({
      dataDir: dir,
      llm,
      learningResearch: async () => ({
        query: "Rust Waker official documentation",
        resources: [{
          title: "Async Book: Wakeups",
          url: "https://rust-lang.github.io/async-book/02_execution/03_wakeups.html",
          publisher: "Rust Project",
          summary: "解释任务唤醒机制。",
          relevance: "补足 Waker 与 executor 协作知识。",
          kind: "documentation",
        }],
      }),
    });
    engine.ensureSpace("personal/ou_me", { chatId: "oc_p2p" });
    engine.learning.createTopic({
      name: "Rust 异步",
      topic: "Rust 异步编程",
      space: "personal/ou_me",
      creatorId: "ou_me",
      chatId: "oc_p2p",
      route: [
        { title: "Waker", objective: "理解任务唤醒" },
        { title: "运行时", objective: "理解调度机制" },
      ],
    }, 1);

    const response = await handleLearningCommand(
      engine,
      { verb: "resources", arg: "1" },
      { space: "personal/ou_me", chatId: "oc_p2p", actorId: "ou_me" },
    );

    expect(response).toContain("已按「Rust Waker official documentation」");
    expect(response).toContain("Async Book: Wakeups");
    expect(response).toContain("https://rust-lang.github.io/");
  });

  test("scopes pause, resume, skip, and delete to the creator", async () => {
    const plan = seedAwaitingPlan(engine, "ou_me");
    const owner = { space: "personal/ou_me" as const, chatId: "oc_p2p", actorId: "ou_me" };
    const other = { ...owner, actorId: "ou_other" };

    expect(await handleLearningCommand(engine, { verb: "pause", arg: "1" }, other))
      .toContain("没找到");
    expect(await handleLearningCommand(engine, { verb: "skip", arg: "1" }, owner))
      .toContain("已跳过");
    expect(await handleLearningCommand(engine, { verb: "pause", arg: "1" }, owner))
      .toContain("已暂停");
    expect(await handleLearningCommand(engine, { verb: "resume", arg: plan.name }, owner))
      .toContain("已恢复");
    expect(await handleLearningCommand(engine, { verb: "delete", arg: "1" }, owner))
      .toContain("已删除");
    expect(engine.learning.get(plan.id)).toBeUndefined();
  });

  test("submits an answer only when exactly one owned lesson is awaiting", async () => {
    const plan = seedAwaitingPlan(engine, "ou_me");
    llm.queueJSON({
      feedback: "## 回应点评\n很好\n\n## 需要澄清\n无\n\n## 今日总结\n完成\n\n## 下一步\n继续",
      mastery: "ready",
      nextFocus: "继续下一段阅读",
      learningRecord: {
        title: "掌握正文要点",
        summary: "能够用自己的话概括正文内容。",
        evidence: "回答与原文重点一致。",
        implications: [],
      },
    });

    const reply = await handleLearningAnswer(engine, "我的理解", {
      space: "personal/ou_me",
      chatId: "oc_p2p",
      actorId: "ou_me",
    });

    expect(reply).toContain("✅ 已记录「读书」第 1 课");
    expect(reply).toContain("## 回应点评");
    expect(engine.learning.currentSession(plan.id)).toBeUndefined();
  });
});

function seedAwaitingPlan(engine: KnowledgeEngine, creatorId: string) {
  const plan = engine.learning.create({
    name: "读书",
    space: "personal/ou_me",
    creatorId,
    chatId: "oc_p2p",
    sourceTitle: "书",
    sourceContent: "正文内容共八字",
    sourceRawIds: ["raw_book"],
    sourceMessageId: "om_book",
  }, 1);
  const session = engine.learning.prepareSession(plan.id, {
    startOffset: 0,
    endOffset: 4,
    sectionTitle: "第一章",
    excerpt: "正文内容",
    guide: "导读",
    preparedAt: 2,
  })!;
  engine.learning.markDelivered(session.id, 3);
  return plan;
}
