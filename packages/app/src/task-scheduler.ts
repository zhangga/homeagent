/**
 * Task scheduler (task-execution platform). A coarse-tick loop mirroring the
 * dream Scheduler (scheduler.ts): it wakes on an interval (and once at startup)
 * and runs any enabled task whose cadence is due. The run/skip decision is a
 * pure function (shouldRunTask) so the policy is unit-tested without timers.
 *
 * Each task has its own cadence (hourly / daily-at-hour); unlike the dream
 * scheduler's single global hour, cadence is per task. On success, if the task
 * opts in and its space is bound to a feishu chat, a summary is pushed via the
 * optional notify callback (wired to connector.notice in main.ts).
 */
import { logger } from "@homeagent/shared";
import {
  TaskAlreadyRunningError,
  skillWarningViews,
  type KnowledgeEngine,
  type Task,
  type TaskRun,
} from "@homeagent/core";
import { formatSkillWarnings } from "@homeagent/orchestrator";
import { localHour, dayKey, type RuntimeLoopHealth } from "./scheduler.ts";

const log = logger.child("task-scheduler");

export interface TaskScheduleConfig {
  /** wake cadence in ms; default 15 min */
  tickMs: number;
}

export const DEFAULT_TASK_SCHEDULE: TaskScheduleConfig = {
  tickMs: 15 * 60 * 1000,
};

/**
 * Decide whether a task should run now. Runs when enabled AND:
 *   - never run before, OR
 *   - hourly: last run >= ~1h ago, OR
 *   - daily: at/after its hour and not yet run today.
 */
export function shouldRunTask(task: Task, now: Date): boolean {
  if (!task.enabled) return false;
  if (task.lastRunAt === undefined) return true;

  if (task.cadence === "hourly") {
    return now.getTime() - task.lastRunAt >= 3600_000;
  }
  // daily
  if (localHour(now) >= task.hour) {
    return dayKey(new Date(task.lastRunAt)) !== dayKey(now);
  }
  return false;
}

/** Called after a successful run when the task opts into notifications. */
export type TaskNotify = (task: Task, run: TaskRun) => void | Promise<void>;
export type TaskApprovalNotify = (
  task: Task,
  run: TaskRun,
  deliveryKey: string,
) => void | Promise<void>;

export function formatTaskRunNotification(run: TaskRun): string {
  const summary = run.summary?.trim();
  if (!summary) throw new Error(`task run has no notification summary: ${run.taskName}`);
  const warning = formatSkillWarnings(
    skillWarningViews({ skipped: run.skillEvidence?.skipped ?? [] }),
  );
  if (run.workActionId) {
    return [
      `🧭 工作动作「${run.taskName}」执行已完成，结果已进入验收流程：`,
      "",
      summary,
      `Run：${run.id}`,
      "请前往 HomeAgent 管理后台查看自动或人工验收结果。",
      ...(warning ? ["", warning] : []),
    ].join("\n");
  }
  return [
    `🔎 任务「${run.taskName}」已完成：`,
    "",
    summary,
    ...(warning ? ["", warning] : []),
  ].join("\n");
}

export function formatTaskApprovalNotification(run: TaskRun): string {
  const approval = run.approval;
  if (approval?.status !== "pending" || approval.expiresAt === undefined) {
    throw new Error(`task run has no pending approval: ${run.taskName}`);
  }
  const permission = run.executionPlan?.execution?.permission ?? "unknown";
  return [
    `🔐 任务「${run.taskName}」等待高权限审批`,
    "",
    `权限：${permission}`,
    `审批截止：${new Date(approval.expiresAt).toLocaleString("zh-CN", { hour12: false })}`,
    `Run：${run.id}`,
    "请前往 HomeAgent 管理后台查看冻结执行计划并作出决定。",
  ].join("\n");
}

export class TaskScheduler {
  private engine: KnowledgeEngine;
  private cfg: TaskScheduleConfig;
  private notify?: TaskNotify;
  private notifyApproval?: TaskApprovalNotify;
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private started = false;
  private lastStatus?: "ok" | "error";
  private lastTickAt?: number;
  private lastSuccessAt?: number;
  private lastFailureAt?: number;
  private lastReason?: string;
  private lastError?: string;

  constructor(engine: KnowledgeEngine, opts: {
    cfg?: Partial<TaskScheduleConfig>;
    notify?: TaskNotify;
    notifyApproval?: TaskApprovalNotify;
  } = {}) {
    this.engine = engine;
    this.cfg = { ...DEFAULT_TASK_SCHEDULE, ...opts.cfg };
    this.notify = opts.notify;
    this.notifyApproval = opts.notifyApproval;
  }

  /** Start the loop and run an immediate catch-up pass. */
  async start(): Promise<void> {
    this.started = true;
    try {
      await this.tick("startup-catchup");
      this.timer = setInterval(() => {
        void this.tick("interval").catch((err) => {
          log.error("task scheduler tick failed", { err: String(err) });
        });
      }, this.cfg.tickMs);
    } catch (err) {
      this.started = false;
      throw err;
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.started = false;
  }

  health(): RuntimeLoopHealth {
    return {
      started: this.started,
      running: this.running,
      lastStatus: this.lastStatus,
      lastTickAt: this.lastTickAt,
      lastSuccessAt: this.lastSuccessAt,
      lastFailureAt: this.lastFailureAt,
      lastReason: this.lastReason,
      lastError: this.lastError,
    };
  }

  /** One scheduling pass over all tasks. Exposed for tests. Returns ids that ran. */
  async tick(reason: string, now = new Date()): Promise<string[]> {
    if (this.running) return [];
    this.running = true;
    this.lastTickAt = Date.now();
    this.lastReason = reason;
    const ran: string[] = [];
    const errors: string[] = [];
    const retriedTaskIds = new Set<string>();
    try {
      this.engine.expireTaskRunApprovals(now.getTime());
      for (const retry of this.engine.retryDueTaskRuns(now.getTime())) {
        retriedTaskIds.add(retry.run.taskId);
        const report = await retry.completion;
        if (report.ok && this.notify) {
          const task = this.engine.taskForRun(report.runId);
          if (task?.notify) {
            try {
              await this.engine.deliverTaskRunNotification(
                report.runId,
                (run) => this.notify!(task, run),
                { attemptedAt: Math.max(now.getTime(), report.finishedAt) },
              );
            } catch (error) {
              errors.push(`notification ${report.runId}: ${String(error)}`);
              log.warn("retried task notification failed", {
                runId: report.runId,
                taskId: report.taskId,
                err: String(error),
              });
            }
          }
        }
      }
      if (this.notifyApproval) {
        for (const run of this.engine.listTaskRunApprovalsNeedingNotification(now.getTime())) {
          const task = this.engine.taskForRun(run.id);
          if (!task) continue;
          try {
            await this.engine.deliverTaskRunApprovalNotification(
              run.id,
              (current, deliveryKey) => this.notifyApproval!(task, current, deliveryKey),
              { attemptedAt: now.getTime() },
            );
          } catch (error) {
            errors.push(`approval notification ${run.id}: ${String(error)}`);
            log.warn("task approval notification retry failed", {
              runId: run.id,
              taskId: task.id,
              err: String(error),
            });
          }
        }
      }
      if (this.notify) {
        for (const run of this.engine.listTaskRunsNeedingNotification(now.getTime())) {
          const task = this.engine.taskForRun(run.id);
          if (!task) continue;
          try {
            await this.engine.deliverTaskRunNotification(
              run.id,
              (current) => this.notify!(task, current),
              { attemptedAt: now.getTime() },
            );
          } catch (err) {
            errors.push(`notification ${run.id}: ${String(err)}`);
            log.warn("task notification retry failed", {
              runId: run.id,
              taskId: task.id,
              err: String(err),
            });
          }
        }
      }
      for (const task of this.engine.tasks.list()) {
        if (retriedTaskIds.has(task.id)) continue;
        if (!shouldRunTask(task, now)) continue;
        log.info("running scheduled task", { taskId: task.id, space: task.space, reason });
        try {
          const report = await this.engine.runTask(task.id, { trigger: "scheduled" });
          ran.push(task.id);
          if (report.status === "awaiting_approval" && this.notifyApproval) {
            const pending = this.engine.getTaskRun(report.runId);
            if (pending) {
              try {
                await this.engine.deliverTaskRunApprovalNotification(
                  pending.id,
                  (current, deliveryKey) => this.notifyApproval!(task, current, deliveryKey),
                  { attemptedAt: Math.max(now.getTime(), pending.startedAt) },
                );
              } catch (error) {
                errors.push(`approval notification ${pending.id}: ${String(error)}`);
                log.warn("task approval notification failed", {
                  runId: pending.id,
                  taskId: task.id,
                  err: String(error),
                });
              }
            }
          }
          if (report.ok && task.notify && this.notify) {
            try {
              await this.engine.deliverTaskRunNotification(
                report.runId,
                (run) => this.notify!(task, run),
                { attemptedAt: now.getTime() },
              );
            } catch (err) {
              errors.push(`notification ${report.runId}: ${String(err)}`);
              log.warn("task notification failed", {
                runId: report.runId,
                taskId: task.id,
                err: String(err),
              });
            }
          }
        } catch (err) {
          if (err instanceof TaskAlreadyRunningError) {
            log.info("scheduled task already running; skipping duplicate", {
              taskId: task.id,
              runId: err.runId,
            });
            continue;
          }
          errors.push(`${task.id}: ${String(err)}`);
          log.error("scheduled task failed", { taskId: task.id, err: String(err) });
        }
      }
      const unresolvedNotifications = this.engine.listTaskRuns().filter(
        (run) => run.notification?.status === "failed",
      );
      if (unresolvedNotifications.length > 0) {
        errors.push(`${unresolvedNotifications.length} task notification(s) awaiting retry`);
      }
    } catch (err) {
      errors.push(String(err));
      throw err;
    } finally {
      this.running = false;
      if (errors.length === 0) {
        this.lastSuccessAt = Date.now();
        this.lastStatus = "ok";
        this.lastError = undefined;
      } else {
        this.lastFailureAt = Date.now();
        this.lastStatus = "error";
        this.lastError = errors.join("; ").slice(0, 500);
      }
    }
    return ran;
  }
}
