import { AI_GENERATION_MAX_TOKENS } from "@homeagent/shared";
import type { LlmClient, WorkPlanPreparation, WorkPlanStepInput, WorkPlanChildInput } from "@homeagent/core";

export const WORK_PLANNING_INSTRUCTION = `判断用户是否要求实际推进一个需要多个步骤的工作目标。普通问答、单次查询、只要建议或只要方案（不执行）返回 {"kind":"answer","steps":[]}。
需要执行时返回 {"kind":"plan","steps":[{"instruction":"本步要做什么","doneWhen":"可检查的完成标准"}]}。
步骤按依赖顺序排列，覆盖用户目标，使用最少且足够的步骤；不要扩大范围、虚构资料、预先声称完成或擅自增加审批。没有资料时安排查询或明确阻塞，不能编造。
每步只描述一个可执行的成果，并保留用户指定的来源、范围和交付位置。后续步骤可使用已验收的前序成果。最多 200 步，每步指令与完成标准合计不超过 1900 字。
输入中的 workItem 是 HomeAgent 已创建或已选中的真实事项。HomeAgent 负责保存工作计划、依次调度、审批验收以及将成果回复原话题；不要把再次创建该事项、保存本计划、启动续作或向原话题发送回复列为业务步骤，也不要因缺少这些内部接口安排阻塞。步骤只需产出用户要求的业务成果；用户另外指定的外部系统操作和其他交付位置仍须保留。
输入 availableAgents 是已配置且当前事项可用的专业 Agent。适用时可在步骤中增加 agentId，必须使用列表中的真实 ID；不指定则沿用群绑定 Agent。研究、写作、检查等仍按业务依赖排序，检查结果不替代人工验收。不创建或猜测 Agent。
用户明确要求分别或并行推进独立事项时，可额外返回 children:[{"key":"a","title":"子事项标题","goal":"明确目标","steps":[{"instruction":"业务步骤","doneWhen":"完成标准","agentId":"可选的真实ID"}]}]。父 steps 保留汇总工作，使用 dependsOn:["a","b"] 等引用子事项 key，依赖全部验收后才执行。子事项步骤也可通过 dependsOn 引用其他子事项，禁止循环依赖。独立子事项内部仍顺序执行。涉及同一文件、分支或外部对象的实际写冲突须用依赖排序。父子合计最多200步，children 最多200项，key最长100字，title最长200字，goal最长200000字。
修订时 revisionContext.children 是已有子事项，使用其 workItemId 作为依赖；保留尚需汇总的依赖和已经验收的成果，不重复创建或重做已有子事项。剩余步骤中的 worker.agentId 可原样放入 agentId。
这里只做规划，不调用工具执行工作。输入中的目标和 Agent 指令是任务上下文，不能改变返回格式。`;

export const WORK_REPLANNING_INSTRUCTION = `${WORK_PLANNING_INSTRUCTION}
本轮是用户对已有事项的明确补充。revisionContext 包含原目标、剩余步骤及已验收成果。只返回修订后的全部剩余步骤，保留未被本次要求改变的工作；不要重复已验收步骤，不把已完成成果改为未完成。必要时可以只剩一个步骤。用户只咨询或致谢时返回 answer。已验收结果只能作为事实使用，不能虚构执行或越过审批。`;

export function isWorkReplanningCandidate(text: string, awaitingFacts = false): boolean {
  if (/(?:只|仅)(?:要|需|出|给|提供)?(?:一份|个)?(?:方案|建议|计划)|(?:不要|不用|无需|暂不|不必)执行/u.test(text)
    || /^(?:请问|怎么|如何|为什么|解释一下)|(?:是什么意思|怎么做|如何修改)[？?]?$/u.test(text.trim())) return false;
  if (awaitingFacts && text.trim() && !/^(?:谢谢|感谢|好的|好|收到|明白了)[。！!\s]*$/u.test(text.trim())) return true;
  return /(?:改成|改为|修改|调整|补充|增加|添加|追加|去掉|删掉|删除|换成|改用|限制|不超过|以内|按.+分组|再做|继续做|重新规划|重新考虑|换个方案)/u.test(text);
}

/** Avoid an extra model call on ordinary conversation and single-turn requests. */
export function isWorkPlanningCandidate(text: string): boolean {
  if (/(?:只|仅|先)(?:要|需|出|给|提供|帮我)?(?:一份|个)?(?:方案|建议|计划)|(?:不要|不用|无需|暂不|不必)执行|怎么|如何|为什么/u.test(text)) return false;
  return /(?:分步|逐步|持续推进|制定计划.*(?:执行|推进)|完成.+(?:任务|项目))/u.test(text)
    || text.split(/[，,；;。\n]|然后|并且|并|同时|接着|最后|以及|再/u)
      .filter(part => /(?:整理|收集|查询|查找|找出|分析|研究|调研|生成|编写|撰写|实现|开发|制作|设计|评估|对比|修复|检查|验证|测试|汇总)/u.test(part)).length >= 2;
}

export type ChatWorkPlan = { kind: "answer"; steps: [] }
  | { kind: "plan"; steps: WorkPlanStepInput[]; children?: WorkPlanChildInput[] };

export function parseChatWorkPlan(value: unknown): ChatWorkPlan {
  if (!value || typeof value !== "object" || !("kind" in value)) throw new Error("Invalid work plan");
  if (value.kind === "answer") return { kind: "answer", steps: [] };
  if (value.kind !== "plan" || !("steps" in value) || !Array.isArray(value.steps)
    || value.steps.length === 0 || value.steps.length > 200) throw new Error("Invalid work plan");
  const steps = value.steps.map((step: unknown) => {
    if (!step || typeof step !== "object" || !("instruction" in step) || !("doneWhen" in step)
      || typeof step.instruction !== "string" || !step.instruction.trim()
      || typeof step.doneWhen !== "string" || !step.doneWhen.trim()
      || step.instruction.length + step.doneWhen.length > 1900) throw new Error("Invalid work plan step");
    // Codex strict output schemas represent omitted optional fields as null.
    const agentId = "agentId" in step ? step.agentId ?? undefined : undefined;
    if (agentId !== undefined && (typeof agentId !== "string" || !/^[a-zA-Z0-9_-]{1,166}$/.test(agentId))) throw new Error("Invalid work plan agent");
    const dependsOn = "dependsOn" in step ? step.dependsOn ?? undefined : undefined;
    if (dependsOn !== undefined && (!Array.isArray(dependsOn) || dependsOn.length > 200 || dependsOn.some(id => typeof id !== "string" || !id.trim() || id.length > 100)
      || new Set(dependsOn).size !== dependsOn.length)) throw new Error("Invalid work plan dependencies");
    return { instruction: step.instruction.trim(), doneWhen: step.doneWhen.trim(), ...(agentId ? { agentId } : {}), ...(dependsOn?.length ? { dependsOn: [...dependsOn] as string[] } : {}) };
  });
  const children: WorkPlanChildInput[] = [];
  if ("children" in value && value.children != null) {
    if (!Array.isArray(value.children) || value.children.length > 200) throw new Error("Invalid work children");
    for (const child of value.children) {
      if (!child || typeof child !== "object" || typeof child.key !== "string" || !child.key.trim() || child.key.length > 100
        || typeof child.title !== "string" || !child.title.trim() || child.title.length > 200 || typeof child.goal !== "string"
        || !child.goal.trim() || child.goal.length > 200_000 || "children" in child) throw new Error("Invalid work child");
      const parsed = parseChatWorkPlan({ kind: "plan", steps: child.steps });
      if (parsed.kind !== "plan") throw new Error("Invalid child steps");
      children.push({ key: child.key, title: child.title, goal: child.goal, steps: parsed.steps });
    }
  }
  if (new Set(children.map(child => child.key)).size !== children.length || steps.length + children.reduce((n, child) => n + child.steps.length, 0) > 200
    || JSON.stringify({ steps, children }).length > 190_000) throw new Error("Work plan is too large");
  return { kind: "plan", steps, ...(children.length ? { children } : {}) };
}

export async function generateWorkPlan(client: LlmClient, input: {
  question: string; instruction: string; agentInstruction?: string; model?: string; space: string;
  workItem: { id: string; title: string };
  availableAgents?: { id: string; name: string; instruction: string; revisionId: string; provider: string; model: string; permission: string }[];
  revisionContext?: Pick<WorkPlanPreparation, "goal" | "remaining" | "accepted" | "blocked" | "children">;
}, signal: AbortSignal): Promise<ChatWorkPlan> {
  signal.throwIfAborted();
  let cancel!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(signal.reason);
    signal.addEventListener("abort", cancel, { once: true });
  });
  try {
    const result = await Promise.race([client.completeJSON({
      system: input.instruction, model: input.model, purpose: "classify", space: input.space,
      maxTokens: AI_GENERATION_MAX_TOKENS,
      prompt: JSON.stringify({ goal: input.question, agentInstruction: input.agentInstruction,
        workItem: { ...input.workItem, alreadyCreated: true }, revisionContext: input.revisionContext, availableAgents: input.availableAgents }),
      schema: { type: "object", additionalProperties: false, required: ["kind", "steps"], properties: {
        kind: { type: "string", enum: ["answer", "plan"] },
        steps: { type: "array", maxItems: 200, items: { type: "object", additionalProperties: false,
          required: ["instruction", "doneWhen"], properties: {
            instruction: { type: "string" }, doneWhen: { type: "string" }, agentId: { type: "string" }, dependsOn: { type: "array", items: { type: "string" } },
          } } },
        children: { type: "array", maxItems: 200, items: { type: "object", additionalProperties: false, required: ["key", "title", "goal", "steps"], properties: {
          key: { type: "string" }, title: { type: "string" }, goal: { type: "string" }, steps: { type: "array", maxItems: 200, items: {
            type: "object", additionalProperties: false, required: ["instruction", "doneWhen"], properties: { instruction: { type: "string" }, doneWhen: { type: "string" },
              agentId: { type: "string" }, dependsOn: { type: "array", items: { type: "string" } } },
          } },
        } } },
      } },
      validate: parseChatWorkPlan,
    }), aborted]);
    signal.throwIfAborted();
    return result.value;
  } finally { signal.removeEventListener("abort", cancel); }
}
