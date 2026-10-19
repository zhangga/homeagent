import { createHash } from "node:crypto";
import { logger, type SpaceId } from "@homeagent/shared";
import { isResolvedExecutionPlan, type KnowledgeEngine, type TaskRun } from "@homeagent/core";
import { buildTaskApprovalCard, type CardActionEvent, type Connector, type TaskApprovalCardSnapshot } from "@homeagent/connectors";
import { formatTaskApprovalNotification } from "./task-scheduler.ts";

const log = logger.child("task-approvals");

interface ApprovalAction {
  runId: string;
  requestedAt: number;
  decision: "approve" | "reject";
}

function approvalAction(event: CardActionEvent): ApprovalAction | undefined {
  const value = event.actionValue;
  if (event.actionTag !== "button" || value.action !== "homeagent.task-approval"
    || typeof value.runId !== "string" || !/^run_[a-zA-Z0-9-]{1,160}$/u.test(value.runId)
    || typeof value.requestedAt !== "number" || !Number.isSafeInteger(value.requestedAt) || value.requestedAt < 0
    || (value.decision !== "approve" && value.decision !== "reject")) return undefined;
  return { runId: value.runId, requestedAt: value.requestedAt, decision: value.decision };
}

function snapshot(run: TaskRun, message?: string): TaskApprovalCardSnapshot {
  const plan = run.executionPlan;
  const approval = run.approval;
  const state = approval?.status === "approved" ? "approved"
    : approval?.status === "rejected" ? "rejected" : approval?.status === "expired" ? "expired"
    : run.status === "awaiting_approval" && approval?.status === "pending" && isResolvedExecutionPlan(plan)
      ? "pending" : "unavailable";
  return { runId: run.id, taskName: run.taskName, topic: run.topic,
    requestedAt: approval?.requestedAt ?? run.startedAt,
    expiresAt: approval?.expiresAt ?? run.startedAt, state,
    permission: plan?.execution?.permission ?? "unknown", provider: plan?.provider, model: plan?.model,
    reasoningEffort: plan?.reasoningEffort, workdir: plan?.workdir ?? plan?.execution?.workdir,
    timeoutMs: run.timeoutMs, decisionBy: approval?.decidedBy, personal: run.space.startsWith("personal/"), message };
}

export interface FeishuTaskApprovalOptions {
  engine: KnowledgeEngine;
  connector: Connector;
  /** Reuse production's enabled-app/group checks for all notices and callbacks. */
  assertDeliveryAllowed: (space: SpaceId, chatId: string) => void;
  notifyCompleted: (run: TaskRun) => Promise<void>;
  now?: () => number;
}

/** Projection of existing Task Run approval state; no new execution authority/store. */
export class FeishuTaskApprovals {
  private readonly now: () => number;
  constructor(private readonly opts: FeishuTaskApprovalOptions) { this.now = opts.now ?? Date.now; }

  async notify(run: TaskRun, deliveryKey: string): Promise<void> {
    const chatId = this.opts.engine.registry.get(run.space)?.chatId;
    if (!chatId) throw new Error("任务空间没有绑定飞书会话");
    this.opts.assertDeliveryAllowed(run.space, chatId);
    if (this.opts.connector.noticeCard) {
      await this.opts.connector.noticeCard(chatId, buildTaskApprovalCard(snapshot(run)), { idempotencyKey: deliveryKey });
    } else {
      await this.opts.connector.notice(chatId, formatTaskApprovalNotification(run), { idempotencyKey: deliveryKey });
    }
  }

  async handle(event: CardActionEvent): Promise<void> {
    const action = approvalAction(event);
    if (!action) return;
    const { engine, connector } = this.opts;
    let run = engine.getTaskRun(action.runId);
    if (!run || engine.registry.get(run.space)?.chatId !== event.chatId
      || run.approval?.requestedAt !== action.requestedAt || !run.approvalNotification?.attempts) {
      await this.reply(event, "该审批卡片与当前会话或审批申请不匹配，未执行任何操作。");
      return;
    }
    try { this.opts.assertDeliveryAllowed(run.space, event.chatId); }
    catch { await this.reply(event, "当前飞书会话已停用或绑定已变化，未执行审批。"); return; }
    let authorized = run.space === `personal/${event.operatorId}`;
    if (run.space.startsWith("team/")) {
      try { authorized = await connector.isChatAdministrator?.(event.chatId, event.operatorId) === true; }
      catch { authorized = false; }
    }
    if (!authorized) {
      await this.reply(event, run.space.startsWith("team/")
        ? "只有群主或群管理员可以审批本群任务。" : "只有本人可以审批个人空间的任务。");
      return;
    }
    // The role lookup is asynchronous: recheck routing before the durable decision.
    try { this.opts.assertDeliveryAllowed(run.space, event.chatId); }
    catch { await this.reply(event, "当前飞书会话已停用或绑定已变化，未执行审批。"); return; }
    run = engine.getTaskRun(action.runId);
    if (!run || engine.registry.get(run.space)?.chatId !== event.chatId
      || run.approval?.requestedAt !== action.requestedAt) return;
    if (run.approval.status === "pending" && (run.approval.expiresAt ?? 0) <= this.now()) {
      engine.expireTaskRunApprovals(this.now());
      run = engine.getTaskRun(run.id)!;
    }
    let message: string | undefined;
    if (run.status === "awaiting_approval" && run.approval?.status === "pending") {
      try {
        const decidedBy = `feishu:${event.operatorId}`;
        if (action.decision === "approve") {
          const started = engine.approveTaskRun(run.id, decidedBy);
          // Core persists the positive approval before scheduling a provider call.
          void started.completion.then(async report => {
            const completed = engine.getTaskRun(report.runId);
            if (report.ok && completed?.notification) {
              await engine.deliverTaskRunNotification(completed.id, current => this.opts.notifyCompleted(current));
            }
          }).catch(() => log.warn("飞书审批后的任务完成通知未送达，将沿用现有通知重试", { runId: started.run.id }));
        } else {
          engine.rejectTaskRun(run.id, decidedBy, "通过飞书审批卡片拒绝执行");
        }
      } catch {
        // A persistence failure may follow a committed decision: always reload.
        message = "审批状态或执行条件已变化，请核对当前结果；仍待审批时可重试。";
      }
    }
    run = engine.getTaskRun(run.id)!;
    await this.refresh(event, run, message);
  }

  private async reply(event: CardActionEvent, markdown: string): Promise<void> {
    const id = createHash("sha256").update(event.eventId).digest("hex").slice(0, 32);
    await this.opts.connector.reply({ chatId: event.chatId, replyToMessageId: event.messageId,
      idempotencyKey: `ha-appr-feedback-${id}`, markdown });
  }

  private async refresh(event: CardActionEvent, run: TaskRun, message?: string): Promise<void> {
    const card = snapshot(run, message);
    try {
      if (!this.opts.connector.updateCard) throw new Error("card updates unavailable");
      await this.opts.connector.updateCard(event.messageId, buildTaskApprovalCard(card));
    } catch {
      log.warn("飞书审批卡片更新失败，审批决定仍以持久化记录为准", { runId: run.id });
      const labels = { pending: "当前仍待审批，请稍后重试。", approved: "审批已通过，任务按本次冻结计划执行。",
        rejected: "审批已拒绝，本次任务不会执行。", expired: "审批已过期，本次任务不会执行。",
        unavailable: "本次审批已失效，请在管理后台核对运行状态。" };
      await this.reply(event, labels[card.state]);
    }
  }
}
