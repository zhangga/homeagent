/** Safe action-boundary catch-up loop for opted-in WorkItems. */
import { logger } from "@homeagent/shared";
import type { KnowledgeEngine } from "@homeagent/core";
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
  private lastStatus?: "ok" | "error";
  private lastTickAt?: number;
  private lastSuccessAt?: number;
  private lastFailureAt?: number;
  private lastReason?: string;
  private lastError?: string;

  constructor(
    engine: KnowledgeEngine,
    opts: { cfg?: Partial<WorkContinuationScheduleConfig> } = {},
  ) {
    this.engine = engine;
    this.cfg = { ...DEFAULT_WORK_CONTINUATION_SCHEDULE, ...opts.cfg };
  }

  async start(): Promise<void> {
    this.started = true;
    try {
      await this.tick("startup-catchup");
      this.timer = setInterval(() => {
        void this.tick("interval").catch((error) => {
          log.error("work continuation scheduler tick failed", { error: String(error) });
        });
      }, this.cfg.tickMs);
    } catch (error) {
      this.started = false;
      throw error;
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

  async tick(reason: string): Promise<string[]> {
    if (this.running) return [];
    this.running = true;
    this.lastTickAt = Date.now();
    this.lastReason = reason;
    const ran: string[] = [];
    const errors: string[] = [];
    try {
      // Snapshot once: a successful action cannot recursively run the next one
      // in the same tick. This is the safety brake against runaway loops.
      for (const item of this.engine.listDueWorkContinuations()) {
        try {
          const started = this.engine.startWorkContinuation(item.id, { trigger: "scheduled" });
          ran.push(item.id);
          if (started.state === "scheduled") await started.completion;
        } catch (error) {
          errors.push(`${item.id}: ${String(error)}`);
          log.error("work continuation failed", { workItemId: item.id, error: String(error) });
        }
      }
    } finally {
      this.running = false;
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
