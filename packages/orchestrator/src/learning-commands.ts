/** Explicit chat controls for durable guided-learning plans. */
import { learningProgress, type KnowledgeEngine, type LearningPlan } from "@homeagent/core";
import type { SpaceId } from "@homeagent/shared";
import { formatSkillWarnings } from "./format.ts";
import { LEARNING_HELP } from "./messages.ts";

export interface LearningCommand {
  verb: "list" | "new" | "topic" | "add" | "route" | "resources"
    | "pause" | "resume" | "skip" | "delete" | "help";
  arg: string;
}

export interface LearningCommandContext {
  space: SpaceId;
  chatId: string;
  actorId: string;
  sourceMessageId?: string;
}

export function learningCommandNeedsSource(command: LearningCommand): boolean {
  return command.verb === "new" || command.verb === "add";
}

function withSkillWarnings(
  message: string,
  engine: KnowledgeEngine,
  space: SpaceId,
): string {
  const warning = formatSkillWarnings(engine.skillWarningsForSpace(space));
  return warning ? `${message}\n\n${warning}` : message;
}

function withoutMentions(text: string): string {
  return text.trim().replace(/^(?:@\S+\s*)+/u, "").trim();
}

export function parseLearningCommand(text: string): LearningCommand | null {
  const match = withoutMentions(text).match(/^\/learn(?:ing)?\b\s*(.*)$/isu);
  if (!match) return null;
  const rest = (match[1] ?? "").trim();
  if (!rest) return { verb: "list", arg: "" };
  const separator = rest.search(/\s/u);
  const keyword = (separator < 0 ? rest : rest.slice(0, separator)).toLowerCase();
  const arg = separator < 0 ? "" : rest.slice(separator + 1).trim();
  const verbs: Record<string, LearningCommand["verb"]> = {
    list: "list",
    列表: "list",
    new: "new",
    新建: "new",
    创建: "new",
    topic: "topic",
    主题: "topic",
    add: "add",
    source: "add",
    材料: "add",
    route: "route",
    路线: "route",
    resources: "resources",
    resource: "resources",
    资料推荐: "resources",
    联网资料: "resources",
    pause: "pause",
    暂停: "pause",
    resume: "resume",
    继续: "resume",
    恢复: "resume",
    skip: "skip",
    跳过: "skip",
    delete: "delete",
    删除: "delete",
    help: "help",
    帮助: "help",
  };
  const verb = verbs[keyword];
  return verb ? { verb, arg } : { verb: "help", arg: "" };
}

export function parseLearningAnswer(text: string): string | null {
  const match = withoutMentions(text).match(/^学习回答\s*[：:]\s*(.+)$/isu);
  const answer = match?.[1]?.trim();
  return answer || null;
}

function ownedPlans(engine: KnowledgeEngine, context: LearningCommandContext): LearningPlan[] {
  return engine.learning.listBySpace(context.space)
    .filter((plan) => plan.creatorId === context.actorId);
}

function findPlan(plans: LearningPlan[], query: string): LearningPlan | undefined {
  const index = Number(query);
  if (Number.isInteger(index) && index >= 1 && index <= plans.length) return plans[index - 1];
  const normalized = query.toLocaleLowerCase();
  return plans.find((plan) => plan.name.toLocaleLowerCase() === normalized);
}

function statusLabel(plan: LearningPlan): string {
  if (plan.status === "paused") return "已暂停";
  if (plan.status === "completed") return "已完成";
  if (plan.mode === "topic" && plan.profile?.status === "assessing") return "待诊断";
  return engineProgress(plan) === 100 ? "已完成" : "进行中";
}

function engineProgress(plan: LearningPlan): number {
  return learningProgress(plan);
}

function routeStatusIcon(status: LearningPlan["route"][number]["status"]): string {
  if (status === "active") return "▶️";
  if (status === "completed") return "✅";
  if (status === "skipped") return "⏭️";
  return "○";
}

export async function handleLearningCommand(
  engine: KnowledgeEngine,
  command: LearningCommand,
  context: LearningCommandContext,
): Promise<string> {
  if (command.verb === "help") return LEARNING_HELP;
  const plans = ownedPlans(engine, context);
  if (command.verb === "list") {
    if (plans.length === 0) {
      return "还没有学习计划。可发送 `/learn topic <主题>` 创建主题路线，或回复材料后发送 `/learn new <名称>`。";
    }
    return [
      "我的学习计划：",
      ...plans.map((plan, index) =>
        `${index + 1}. ${plan.name} · ${plan.mode === "topic" ? "主题" : "材料"}学习 · ${statusLabel(plan)} · ${engineProgress(plan)}% · 每天 ${plan.hour}:00`
      ),
    ].join("\n");
  }

  if (command.verb === "topic") {
    const topic = command.arg.trim();
    if (!topic) return "请指定学习主题：`/learn topic <主题>`。";
    try {
      const plan = await engine.createTopicLearningPlan({
        space: context.space,
        chatId: context.chatId,
        creatorId: context.actorId,
        topic,
      });
      if (plan.profile?.status === "assessing" && plan.assessmentQuestions?.length) {
        return withSkillWarnings([
          `✅ 已创建主题学习计划「${plan.name}」。开始前，我想先了解你目前的基础和目标：`,
          "",
          ...plan.assessmentQuestions.map((question, index) => `${index + 1}. ${question}`),
          "",
          "请按编号回复，并以“学习回答：”开头。完成诊断后，我会重做路线并开始每日学习。",
        ].join("\n"), engine, context.space);
      }
      return withSkillWarnings(
        `✅ 已创建主题学习计划「${plan.name}」，共 ${plan.route.length} 个步骤，默认每天 8:00 推送一课。发送 \`/learn route ${plan.name}\` 查看路线。`,
        engine,
        context.space,
      );
    } catch (error) {
      return `创建主题学习计划失败：${String(error).replace(/^Error:\s*/u, "")}`;
    }
  }

  if (command.verb === "new") {
    const name = command.arg.trim();
    if (!name) return "请指定书名：`/learn new <书名>`。";
    if (!context.sourceMessageId) {
      return "请回复包含书籍附件或飞书文档的原消息，再发送 /learn new <书名>。";
    }
    try {
      engine.createLearningPlanFromMessage({
        space: context.space,
        chatId: context.chatId,
        messageId: context.sourceMessageId,
        creatorId: context.actorId,
        name,
      });
      return `✅ 已创建学习计划「${name}」，默认每天 8:00 推送一课。发送 \`/learn\` 可查看进度。`;
    } catch (error) {
      return `创建学习计划失败：${String(error).replace(/^Error:\s*/u, "")}`;
    }
  }

  const query = command.arg.trim();
  if (!query) return `请指定计划名称或序号。\n\n${LEARNING_HELP}`;
  const target = findPlan(plans, query);
  if (!target) return `没找到你的学习计划「${query}」。发送 \`/learn\` 查看列表。`;

  if (command.verb === "route") {
    if (target.mode !== "topic") return `学习计划「${target.name}」是材料阅读计划，没有主题路线。`;
    return [
      `学习路线「${target.name}」：`,
      target.profile?.status === "assessing"
        ? "🧭 当前是初步路线，完成入学诊断后会按你的水平和目标重做。"
        : "",
      ...target.route.map((step) =>
        `${routeStatusIcon(step.status)} ${step.title} — ${step.objective}${step.attempts > 0 ? `（已学习 ${step.attempts} 次）` : ""}`
      ),
      target.lastRouteAdjustment ? `\n路线调整：${target.lastRouteAdjustment}` : "",
      target.adaptiveFocus ? `\n下一课重点：${target.adaptiveFocus}` : "",
      target.onlineResources?.length
        ? `\n当前联网资料：${target.onlineResources.length} 份（路线 v${target.resourceResearchVersion}）`
        : "",
    ].filter(Boolean).join("\n");
  }
  if (command.verb === "resources") {
    if (target.mode !== "topic") return `学习计划「${target.name}」是材料阅读计划，不需要联网资料推荐。`;
    if (target.profile?.status === "assessing") {
      return `请先完成「${target.name}」的入学诊断，再按你的真实水平联网推荐资料。`;
    }
    if (target.status !== "active") {
      return `学习计划「${target.name}」当前是${statusLabel(target)}状态；恢复计划后再刷新联网资料。`;
    }
    const beforeAt = target.resourceResearchAt;
    let refreshed: LearningPlan;
    try {
      refreshed = await engine.refreshLearningResources(target.id, Date.now(), true);
    } catch (error) {
      return `联网资料刷新失败：${String(error).replace(/^Error:\s*/u, "")}`;
    }
    const resources = refreshed.onlineResources ?? [];
    if (resources.length === 0) {
      return withSkillWarnings([
        `这次没有为「${target.name}」获得可验证的联网资料。`,
        "课程仍会使用用户材料和明确标注的模型一般知识继续进行；你可以稍后重试。",
      ].join("\n"), engine, context.space);
    }
    const retained = refreshed.resourceResearchAt === beforeAt;
    return withSkillWarnings([
      retained
        ? `本次联网刷新未产生新结果，以下保留「${target.name}」上次核验的资料：`
        : `🔎 已按「${refreshed.resourceResearchQuery}」为「${target.name}」核验并推荐：`,
      "",
      ...resources.flatMap((resource, index) => [
        `${index + 1}. ${resource.title} · ${resource.publisher}`,
        `   ${resource.relevance}`,
        `   ${resource.url}`,
      ]),
    ].join("\n"), engine, context.space);
  }
  if (command.verb === "add") {
    if (!context.sourceMessageId) {
      return `请回复要添加的附件、文章或飞书文档，再发送 /learn add ${target.name}。`;
    }
    try {
      engine.addLearningMaterialFromMessage(
        target.id,
        context.actorId,
        context.sourceMessageId,
      );
      const source = engine.learning.source(target.id);
      const material = source?.materials.at(-1);
      return `✅ 已添加材料「${material?.title ?? "学习材料"}」到「${target.name}」，目前共 ${source?.materials.length ?? 0} 份。`;
    } catch (error) {
      return `添加学习材料失败：${String(error).replace(/^Error:\s*/u, "")}`;
    }
  }

  if (command.verb === "pause") {
    return engine.learning.pause(target.id, context.actorId)
      ? `⏸️ 已暂停学习计划「${target.name}」。`
      : `学习计划「${target.name}」当前无法暂停。`;
  }
  if (command.verb === "resume") {
    return engine.learning.resume(target.id, context.actorId)
      ? `▶️ 已恢复学习计划「${target.name}」。`
      : `学习计划「${target.name}」当前无法恢复。`;
  }
  if (command.verb === "skip") {
    return engine.learning.skipCurrent(target.id, context.actorId)
      ? `⏭️ 已跳过学习计划「${target.name}」的当前课程，进度已推进。`
      : `学习计划「${target.name}」当前没有等待处理的课程。`;
  }
  return engine.learning.remove(target.id, context.actorId)
    ? `🗑️ 已删除学习计划「${target.name}」。`
    : `学习计划「${target.name}」删除失败。`;
}

export async function handleLearningAnswer(
  engine: KnowledgeEngine,
  answer: string,
  context: Omit<LearningCommandContext, "sourceMessageId">,
): Promise<string> {
  const assessing = ownedPlans(engine, context)
    .filter((plan) => plan.mode === "topic" && plan.profile?.status === "assessing");
  const awaiting = ownedPlans(engine, context)
    .filter((plan) => engine.learning.currentSession(plan.id)?.status === "awaiting_reply");
  const candidates = [...assessing, ...awaiting];
  if (candidates.length === 0) return "当前没有等待你回答的学习课程或入学诊断。";
  if (candidates.length > 1) {
    return `有多个学习计划正在等待回答，请先处理到只剩一个：${candidates.map((plan) => plan.name).join("、")}`;
  }
  if (assessing.length === 1) {
    const assessed = await engine.answerLearningAssessment(
      assessing[0]!.id,
      context.actorId,
      answer,
    );
    const profile = assessed.profile!;
    return withSkillWarnings([
      `🧭 已完成「${assessed.name}」入学诊断，并按你的回答重做学习路线。`,
      "",
      `当前判断：${levelLabel(profile.level)} — ${profile.levelRationale}`,
      `建议节奏：${paceLabel(profile.pace)}，每天约 ${profile.dailyMinutes} 分钟`,
      profile.goals.length > 0 ? `学习目标：${profile.goals.join("；")}` : "",
      profile.strengths.length > 0 ? `知识优势：${profile.strengths.join("；")}` : "",
      profile.gaps.length > 0 ? `优先补齐：${profile.gaps.join("；")}` : "",
      assessed.lastRouteAdjustment ? `路线调整：${assessed.lastRouteAdjustment}` : "",
      "",
      "定制路线：",
      ...assessed.route.map((step, index) => `${index + 1}. ${step.title} — ${step.objective}`),
      "",
      `下一课将在每天 ${assessed.hour}:00 推送；你也可以发送 \`/learn route ${assessed.name}\` 随时查看变化。`,
    ].filter(Boolean).join("\n"), engine, context.space);
  }
  const target = awaiting[0]!;
  const result = await engine.answerLearningSession(target.id, context.actorId, answer);
  const completion = result.plan.status === "completed"
    ? result.plan.mode === "topic"
      ? "\n\n🎉 这个主题的学习路线已完成。"
      : "\n\n🎉 这本书的计划已完成。"
    : result.session.mastery === "review"
      ? `\n\n🔁 下一课将继续当前步骤，重点补强：${result.session.nextFocus}`
      : "";
  return withSkillWarnings(
    `✅ 已记录「${target.name}」第 ${result.session.sequence} 课。\n\n${result.feedback}${completion}`,
    engine,
    context.space,
  );
}

function levelLabel(level: NonNullable<LearningPlan["profile"]>["level"]): string {
  if (level === "advanced") return "进阶";
  if (level === "intermediate") return "中阶";
  if (level === "beginner") return "入门";
  return "待观察";
}

function paceLabel(pace: NonNullable<LearningPlan["profile"]>["pace"]): string {
  if (pace === "intensive") return "强化";
  if (pace === "gentle") return "轻量";
  return "稳步";
}
