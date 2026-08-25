/** Independent, provider-free schedule for deterministic Wiki Maintenance. */
import { logger, type SpaceId } from "@homeagent/shared";
import type { KnowledgeEngine } from "@homeagent/core";
import type { RuntimeLoopHealth } from "./scheduler.ts";

const log = logger.child("maintenance-scheduler");

export interface MaintenanceScheduleConfig {
  /** Minimum time between successful cycles for one Space. */
  intervalHours: number;
  /** Scheduler wake cadence. */
  tickMs: number;
}

export const DEFAULT_MAINTENANCE_SCHEDULE: MaintenanceScheduleConfig = {
  intervalHours: 7 * 24,
  tickMs: 60 * 60 * 1_000,
};

export function shouldRunMaintenance(
  lastMaintenanceAt: number | undefined,
  now: Date,
  config: MaintenanceScheduleConfig,
): boolean {
  if (lastMaintenanceAt === undefined) return true;
  return now.getTime() - lastMaintenanceAt >= config.intervalHours * 3_600_000;
}

export class MaintenanceScheduler {
  private readonly engine: KnowledgeEngine;
  private readonly config: MaintenanceScheduleConfig;
  private timer?: ReturnType<typeof setInterval>;
  private started = false;
  private running = false;
  private lastStatus?: "ok" | "error";
  private lastTickAt?: number;
  private lastSuccessAt?: number;
  private lastFailureAt?: number;
  private lastReason?: string;
  private lastError?: string;

  constructor(engine: KnowledgeEngine, config: Partial<MaintenanceScheduleConfig> = {}) {
    this.engine = engine;
    this.config = { ...DEFAULT_MAINTENANCE_SCHEDULE, ...config };
  }

  async start(): Promise<void> {
    this.started = true;
    try {
      await this.tick("startup-catchup");
      this.timer = setInterval(() => {
        void this.tick("interval").catch((error) => {
          log.error("maintenance scheduler tick failed", { err: String(error) });
        });
      }, this.config.tickMs);
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

  async tick(reason: string, now = new Date()): Promise<SpaceId[]> {
    if (this.running) return [];
    this.running = true;
    this.lastTickAt = Date.now();
    this.lastReason = reason;
    const ran: SpaceId[] = [];
    const errors: string[] = [];
    try {
      for (const meta of this.engine.registry.list()) {
        if (!shouldRunMaintenance(meta.lastMaintenanceAt, now, this.config)) continue;
        try {
          const report = await this.engine.scheduleBackgroundRun(
            `background:wiki-maintenance:${meta.id}:${now.getTime()}`,
            meta.id,
            () => this.engine.runWikiMaintenanceCycle(meta.id),
          );
          ran.push(meta.id);
          log.info("Wiki Maintenance completed", {
            space: meta.id,
            scannedPages: report.scannedPages,
            issueCount: report.issues.length,
            truncated: report.truncated,
          });
        } catch (error) {
          errors.push(`${meta.id}: ${String(error)}`);
          log.error("scheduled Wiki Maintenance failed", {
            space: meta.id,
            err: String(error),
          });
        }
      }
    } catch (error) {
      errors.push(String(error));
      throw error;
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
