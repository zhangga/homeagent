/** Safe action-boundary catch-up loop for opted-in WorkItems. */
import { logger } from "@homeagent/shared";
import type { KnowledgeEngine, StartedTaskRun, TaskRun } from "@homeagent/core";
import type { RuntimeLoopHealth } from "./scheduler.ts";

const log = logger.child("work-continuation-scheduler");

export interface WorkContinuationScheduleConfig {
  tickMs: number;
}

export const DEFAULT_WORK_CONTINUATION_SCHEDULE: WorkContinuationScheduleConfig = {
  tickMs: 60_000,
};

export class WorkContinuationScheduler {
  private readonly engine: KnowledgeEngine;
  private readonly cfg: WorkContinuationScheduleConfig;
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private started = false;
  private stopping = false;
  private lastStatus?: "ok" | "error";
  private lastTickAt?: number;
  private lastSuccessAt?: number;
  private lastFailureAt?: number;
  private lastReason?: string;
  private lastError?: string;
  private inFlight = new Map<string, Promise<void>>();
  private notify?: (run: TaskRun) => void | Promise<void>;
  private notifyApproval?: (run: TaskRun, deliveryKey: string) => void | Promise<void>;

  constructor(
    engine: KnowledgeEngine,
    opts: { cfg?: Partial<WorkContinuationScheduleConfig>;
      notify?: (run: TaskRun) => void | Promise<void>;
      notifyApproval?: (run: TaskRun, deliveryKey: string) => void | Promise<void> } = {},
  ) {
    this.engine = engine;
    this.cfg = { ...DEFAULT_WORK_CONTINUATION_SCHEDULE, ...opts.cfg };
    this.notify = opts.notify;
    this.notifyApproval = opts.notifyApproval;
  }

  async start(): Promise<void> {
    this.stopping = false;
    this.started = true;
    const dispatch = (reason: string) => {
      void this.tick(reason).catch(() => {
        this.lastStatus = "error";
        this.lastFailureAt = Date.now();
        this.lastError = "工作续作调度检查失败";
        log.error("work continuation scheduler tick failed", { reason });
      });
    };
    // Recovery can run a long action. Install the loop and return control to
    // the composition root so other schedules and action boundaries stay live.
    this.timer = setInterval(() => dispatch("interval"), this.cfg.tickMs);
    dispatch("startup-catchup");
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.started = false;
    this.stopping = true;
  }

  health(): RuntimeLoopHealth {
    return {
      started: this.started,
      running: this.running || this.inFlight.size > 0,
      lastStatus: this.lastStatus,
      lastTickAt: this.lastTickAt,
      lastSuccessAt: this.lastSuccessAt,
      lastFailureAt: this.lastFailureAt,
      lastReason: this.lastReason,
      lastError: this.lastError,
    };
  }

  private async observe(started: StartedTaskRun): Promise<void> {
    if (started.state === "awaiting_approval" && this.notifyApproval) {
      await this.engine.deliverTaskRunApprovalNotification(started.run.id, this.notifyApproval);
    }
    if (started.state === "scheduled") {
      await started.completion;
      if (this.notify && this.engine.getTaskRun(started.run.id)?.notification) {
        await this.engine.deliverTaskRunNotification(started.run.id, this.notify);
      }
    }
  }

  private submit(workItemId: string) {
    // Reserve before Skill preparation yields, so a tick and a chat wake cannot
    // both claim the same next action.
    const admitted = Promise.resolve().then(() =>
      this.engine.startWorkContinuationAsync(workItemId, { trigger: "scheduled" }));
    const completion = admitted.then(started => this.observe(started));
    void completion.catch(() => {});
    this.inFlight.set(workItemId, completion);
    return { admitted, completion };
  }

  /** A newly delivered plan need not wait for another item's long-running tick. */
  async wake(workItemId: string): Promise<void> {
    if (this.stopping || this.inFlight.has(workItemId) || !this.engine.listDueWorkContinuations().some(item => item.id === workItemId)) return;
    const { completion } = this.submit(workItemId);
    try { await completion; } finally { this.inFlight.delete(workItemId); }
  }

  async tick(reason: string): Promise<string[]> {
    if (this.running || this.stopping) return [];
    this.running = true;
    this.lastTickAt = Date.now();
    this.lastReason = reason;
    const ran: string[] = [];
    const errors: string[] = [];
    try {
      // Snapshot once: a successful action cannot recursively run the next one
      // in the same tick. This is the safety brake against runaway loops.
      const scheduled: Array<{ workItemId: string; completion: Promise<unknown> }> = [];
      try {
        for (const item of this.engine.listDueWorkContinuations()) {
          if (this.inFlight.has(item.id)) continue;
          try {
            const { admitted, completion } = this.submit(item.id);
            await admitted;
            ran.push(item.id);
            scheduled.push({ workItemId: item.id, completion });
          } catch (error) {
            this.inFlight.delete(item.id);
            errors.push(`${item.id}: ${String(error)}`);
            log.error("work continuation failed", { workItemId: item.id, error: String(error) });
          }
        }
      } finally {
        // Long execution belongs to the item's reservation, not the global
        // admission loop. Another item's next boundary must remain schedulable.
        this.running = false;
      }
      await Promise.all(scheduled.map(async (entry) => {
        try {
          await entry.completion;
        } catch (error) {
          errors.push(`${entry.workItemId}: ${String(error)}`);
          log.error("work continuation failed", {
            workItemId: entry.workItemId,
            error: String(error),
          });
        } finally {
          this.inFlight.delete(entry.workItemId);
        }
      }));
    } finally {
      if (errors.length === 0) {
        this.lastStatus = "ok";
        this.lastSuccessAt = Date.now();
        this.lastError = undefined;
      } else {
        this.lastStatus = "error";
        this.lastFailureAt = Date.now();
        this.lastError = errors.join("; ").slice(0, 500);
      }
    }
    return ran;
  }
}
