import { parseWorkActionProviderReport, type KnowledgeEngine, type TaskRun } from "@homeagent/core";
import type { OutboundReply } from "@homeagent/connectors";

/** Prefer the original local route; imported plans use existing Space-bound Task delivery. */
export function chatWorkNotification(engine: KnowledgeEngine, run: TaskRun): OutboundReply | undefined {
  if (!run.workItemId || !run.workActionId) return undefined;
  const item = engine.workItems.get(run.workItemId);
  if (!item || (!item.chatPlanRunId && !item.parentWorkItemId)) return undefined;
  const source = engine.chatWorkPlanSource(item.id)?.message;
  if (!source) return undefined;
  const action = engine.workContinuations.get(run.workActionId);
  if (!action || action.space !== run.space || item.space !== run.space
    || !action.taskRunIds.includes(run.id)) throw new Error("Chat work notification ownership mismatch");
  const completionTracked = engine.workEvents.list(item.space).some(notice => notice.workItemId === item.id
    && notice.kind === "completion" && notice.status !== "cancelled"
    && JSON.stringify(notice.planRef) === JSON.stringify(item.planRef));
  const status = action.status === "blocked" ? "遇到阻塞"
    : action.status === "awaiting_acceptance" ? "等待验收"
    : item.phase === "completed" && !completionTracked ? "已完成" : "本步已通过验收";
  const report = parseWorkActionProviderReport(run.output ?? "");
  return {
    chatId: source.chatId, replyToMessageId: source.messageId,
    inThread: source.chatType === "group" && engine.feishuBindings.activeByChatId(source.chatId)?.replyInThread === true,
    idempotencyKey: `ha-done-${run.id}`,
    markdown: [
      `${item.parentWorkItemId ? "子事项" : "工作计划"}「${item.title}」${status}`, "", action.instruction, "", report?.result ?? run.summary ?? "",
      ...(action.status === "blocked" ? ["", `阻塞：${action.error ?? "请查看工作台详情"}`] : []),
      "", action.status === "awaiting_acceptance" ? "请在工作台验收本步成果，通过后继续下一步。"
        : item.phase === "completed" ? item.parentWorkItemId ? "子事项已验收，父目标将等待其他依赖后继续。" : completionTracked ? "本步已通过验收，完成通知将回复本话题。" : "全部步骤已验收，事项已完成。"
        : `剩余 ${item.nextActions.length} 步，可在工作台查看进展。`,
    ].join("\n"),
  };
}
