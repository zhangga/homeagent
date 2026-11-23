import {
  isTaskRunLaunchAdmitted,
  type ChatRun,
  type KnowledgeEngine,
  type TaskRun,
  type WorkAction,
  type WorkActionAcceptance,
  type WorkItem,
  type WorkPlanWait,
} from "@homeagent/core";

export interface WorkAttention {
  kind: "awaiting_acceptance" | "awaiting_approval" | "running" | "queued" | "blocked" | "normal" | "completed";
  action?: WorkAction;
  acceptance?: WorkActionAcceptance;
  runId?: string;
  description?: string;
  href?: string;
}

export function belongsToAction(item: WorkItem, action: WorkAction, run: TaskRun): boolean {
  return action.workItemId === item.id && action.space === item.space
    && run.space === item.space && run.workItemId === item.id
    && run.workActionId === action.id && run.taskId === action.id
    && action.taskRunIds.includes(run.id);
}

const liveTaskStatuses = ["awaiting_approval", "running", "queued"] as const;
const liveChatStatuses = ["running", "queued"] as const;

export const workDecisionLabels = {
  awaiting_approval: { label: "待审批", link: "处理审批" },
  awaiting_acceptance: { label: "待验收", link: "查看报告" },
  blocked: { label: "受阻", link: "查看阻塞原因" },
} as const;

export interface HomeDecision {
  kind: keyof typeof workDecisionLabels;
  title: string;
  space: WorkItem["space"];
  href: string;
}

function activeTaskAttention(run: TaskRun, description: string, action?: WorkAction): WorkAttention | undefined {
  if (!isTaskRunLaunchAdmitted(run) || run.finishedAt !== undefined) return;
  if (run.status !== "running" && run.status !== "queued" && run.status !== "awaiting_approval") return;
  if (run.status === "awaiting_approval" && run.approval?.status !== "pending") return;
  return { kind: run.status, action, runId: run.id, description, href: `/tasks/runs/${encodeURIComponent(run.id)}` };
}

function currentActionAttention(item: WorkItem, action: WorkAction, taskRunById: (id: string) => TaskRun | undefined): WorkAttention {
  const workHref = `/work/${encodeURIComponent(item.id)}`;
  const href = `${workHref}#work-next-action`;
  // Claiming a retry increments attempt before its new Task Run is written. Never substitute the previous slot.
  const runId = action.taskRunIds[action.attempt - 1];
  const candidate = runId && runId === action.taskRunIds.at(-1) ? taskRunById(runId) : undefined;
  const run = candidate && candidate.id === runId && belongsToAction(item, action, candidate) ? candidate : undefined;
  if (action.status === "awaiting_acceptance") {
    const acceptance = action.acceptances?.at(-1);
    if (run?.status === "succeeded" && acceptance?.status === "pending"
      && acceptance.attempt === action.attempt && acceptance.taskRunId === run.id) {
      return { kind: "awaiting_acceptance", action, acceptance, runId: run.id, description: acceptance.report.result,
        href: `${workHref}#acceptance-${encodeURIComponent(action.id)}-${encodeURIComponent(run.id)}` };
    }
    return { kind: "blocked", action, description: "验收报告尚未关联到本次运行。", href };
  }
  const live = run && activeTaskAttention(run, action.instruction, action);
  if (live && (live.kind !== "awaiting_approval" || action.status === "awaiting_approval")) return live;
  if (action.status === "queued") return { kind: "queued", action, description: action.instruction, href };
  return { kind: "blocked", action, description: "当前动作没有可处理的运行，请查看事项进度。", href };
}

/** Actions arrive newest first. A durable pending decision takes precedence over the item's editable phase. */
export function selectWorkAttention(
  item: WorkItem, actions: readonly WorkAction[], taskRunById: (id: string) => TaskRun | undefined,
  chatRuns: readonly ChatRun[] = [], plainTaskRuns: readonly TaskRun[] = [],
  readPlanWait?: () => WorkPlanWait | undefined,
): WorkAttention {
  const owned = actions.filter(entry => entry.workItemId === item.id && entry.space === item.space);
  const action = owned.find(entry => entry.status === "awaiting_acceptance" || entry.status === "awaiting_approval"
    || entry.status === "running" || entry.status === "queued");
  const current = action && currentActionAttention(item, action, taskRunById);
  if (current?.kind === "awaiting_acceptance" || current?.kind === "awaiting_approval") return current;
  const plain = plainTaskRuns.filter(run => !run.workActionId && run.workItemId === item.id && run.space === item.space
    && !owned.some(entry => entry.id === run.taskId || entry.taskRunIds.includes(run.id)))
    .map(run => activeTaskAttention(run, run.taskName));
  const approval = plain.find(entry => entry?.kind === "awaiting_approval");
  if (approval) return approval;
  const blockedAction = owned[0]?.status === "blocked" ? owned[0] : undefined;
  if (item.phase !== "completed" && (item.phase === "blocked" || item.blockers.length || (!action && blockedAction))) {
    return { kind: "blocked", action: blockedAction, description: blockedAction?.error ?? item.blockers[0],
      href: `/work/${encodeURIComponent(item.id)}#work-next-action` };
  }
  if (item.phase !== "completed" && current?.kind === "blocked") return current;
  const chats = chatRuns.filter(run => run.space === item.space && run.workItemId === item.id
    && run.launchAdmission !== "pending" && run.finishedAt === undefined);
  for (const kind of liveChatStatuses) {
    if (current?.kind === kind) return current;
    const task = plain.find(entry => entry?.kind === kind);
    if (task) return task;
    const chat = chats.find(run => run.status === kind);
    if (chat) return { kind, runId: chat.id, description: "关联对话", href: `/chats/runs/${encodeURIComponent(chat.id)}` };
  }
  if (item.phase === "completed") return { kind: "completed", description: item.summary || undefined };
  if (item.nextActions.length && (item.planRef || item.parentWorkItemId)) {
    const wait = readPlanWait?.();
    if (wait) {
      const title = wait.title ? `「${wait.title}」` : "";
      const reason = {
        dependency: `下一步等待依赖事项${title}完成验收。`,
        parent_paused: `父目标${title}已暂停，恢复后才能继续下一步。`,
        parent_completed: `父目标${title}已完成，子事项无法继续执行。`,
        parent_pending: `下一步正在等待父目标${title}就绪。`,
      }[wait.kind];
      return { kind: "blocked", description: reason, href: `/work/${encodeURIComponent(item.id)}#work-next-action` };
    }
  }
  return { kind: "normal", description: item.nextActions[0] };
}

function groupedByItem<T extends { workItemId?: string }>(records: readonly T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const record of records) {
    if (!record.workItemId) continue;
    const group = groups.get(record.workItemId);
    if (group) group.push(record);
    else groups.set(record.workItemId, [record]);
  }
  return groups;
}

export function workAttentionIndex(engine: KnowledgeEngine, items: WorkItem[],
  liveTasks = engine.taskRuns.list(undefined, liveTaskStatuses),
  liveChats = engine.chatRuns.list(undefined, liveChatStatuses)): Map<string, WorkAttention> {
  const allActions = engine.workContinuations.list();
  const actions = groupedByItem(allActions);
  const actionIds = new Set(allActions.map(action => action.id));
  const chats = groupedByItem(liveChats);
  const plain = groupedByItem(liveTasks.filter(run => run.workItemId && !run.workActionId && !actionIds.has(run.taskId)));
  const tasks = new Map(liveTasks.map(run => [run.id, run]));
  // Only a current candidate (e.g. a completed Run awaiting acceptance) needs a historical lookup.
  const getRun = (id: string) => tasks.get(id) ?? engine.taskRuns.get(id);
  return new Map(items.map(item => [item.id, selectWorkAttention(item, actions.get(item.id) ?? [], getRun,
    chats.get(item.id), plain.get(item.id), () => engine.getWorkPlanWait(item.id))]));
}

export function homeDecisions(engine: KnowledgeEngine, liveTasks: TaskRun[], liveChats: ChatRun[]): HomeDecision[] {
  const items = engine.workItems.list();
  const attention = workAttentionIndex(engine, items, liveTasks, liveChats);
  const decisions = new Map<string, HomeDecision>();
  for (const item of items) {
    const state = attention.get(item.id);
    if (state?.href && (state.kind === "awaiting_acceptance" || state.kind === "awaiting_approval" || state.kind === "blocked")) {
      decisions.set(state.href, { kind: state.kind, title: item.title, space: item.space, href: state.href });
    }
  }
  for (const run of liveTasks) {
    const approval = activeTaskAttention(run, run.taskName);
    if (approval?.kind === "awaiting_approval" && approval.href && !decisions.has(approval.href)) {
      decisions.set(approval.href, { kind: approval.kind, title: run.taskName, space: run.space, href: approval.href });
    }
  }
  return [...decisions.values()];
}

export function workAttentionDetail(engine: KnowledgeEngine, item: WorkItem) {
  const actions = engine.workContinuations.list(item.id).filter(action => action.space === item.space);
  const actionById = new Map(actions.map(action => [action.id, action]));
  const tasks = new Map<string, TaskRun | undefined>();
  const getRun = (id: string) => {
    if (!tasks.has(id)) tasks.set(id, engine.taskRuns.get(id));
    return tasks.get(id);
  };
  // Historical references can predate explicit owners. Preserve them unless a stored record contradicts the link.
  const taskRunBelongs = (id: string, actionId?: string): boolean => {
    const run = getRun(id);
    if (!run) return true;
    if (run.space !== item.space || (run.workItemId && run.workItemId !== item.id)) return false;
    if (actionId && (run.taskId !== actionId || (run.workActionId && run.workActionId !== actionId))) return false;
    const owner = run.workActionId && (actionById.get(run.workActionId) ?? engine.workContinuations.get(run.workActionId));
    return !owner || (owner.space === item.space && owner.workItemId === item.id && run.taskId === owner.id);
  };
  const plain = engine.taskRuns.list(undefined, liveTaskStatuses).filter(run =>
    run.workItemId === item.id && run.space === item.space && !run.workActionId && !engine.workContinuations.get(run.taskId));
  for (const run of plain) tasks.set(run.id, run);
  const chatRuns = engine.chatRuns.list(item.space).filter(run => run.workItemId === item.id);
  const visibleChats = new Set(chatRuns.map(run => run.id));
  const unrelatedChatRunIds = new Set(item.chatRunIds.filter(id => {
    if (visibleChats.has(id)) return false;
    const run = engine.chatRuns.get(id);
    return run && (run.space !== item.space || (run.workItemId && run.workItemId !== item.id));
  }));
  const plan = engine.getWorkPlanView(item.id);
  const attention = selectWorkAttention(item, actions, getRun, chatRuns, plain, () => plan ? plan.wait : engine.getWorkPlanWait(item.id));
  return { actions, chatRuns, attention, taskRunBelongs, unrelatedChatRunIds, plan };
}
