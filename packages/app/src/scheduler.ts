/**
 * Dream-cycle scheduler (plan §VII, Q9). Robust to local sleep/shutdown by not
 * relying on a precise cron fire: it wakes on a coarse interval, and on each
 * wake (and once at startup — the "catch-up") it distills any space whose last
 * dream is older than the staleness threshold, or when the daily run hour has
 * passed and today's run hasn't happened yet. Once due, it drains several
 * bounded batches; durable carry-over resumes on the next tick.
 *
 * The decision of *whether* to run a space is a pure function (shouldRunSpace)
 * so the policy is unit-tested without timers.
 */
import { logger, config, type SpaceId } from "@homeagent/shared";
import type { KnowledgeEngine } from "@homeagent/core";

const log = logger.child("scheduler");

export interface ScheduleConfig {
  /** local hour (Asia/Shanghai) for the nightly run; default 3 */
  hour: number;
  /** re-run a space if its last dream is older than this many hours */
  stalenessHours: number;
  /** wake cadence in ms; default 15 min */
  tickMs: number;
  /** admitted pending Raw entries in one bounded Dream batch */
  batchEntries: number;
  /** maximum batches drained for one Space during a scheduler tick */
  maxCatchUpBatches: number;
  /** delete distilled raw messages older than this many days; 0 disables */
  rawRetentionDays: number;
}

export const DEFAULT_SCHEDULE: ScheduleConfig = {
  hour: 3,
  stalenessHours: 24,
  tickMs: 15 * 60 * 1000,
  batchEntries: 40,
  maxCatchUpBatches: 4,
  rawRetentionDays: 90,
};

/** Local hour (0-23) in Asia/Shanghai for a given instant. */
export function localHour(at: Date): number {
  const s = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    hour12: false,
  }).format(at);
  const h = parseInt(s, 10);
  return h === 24 ? 0 : h; // some ICU builds emit "24" for midnight
}

export interface SpaceState {
  id: SpaceId;
  lastDreamAt?: number;
  /** whether the space has any pending (un-ingested) raw entries */
  hasPending: boolean;
  /** creation time of the oldest admitted pending Raw, when known */
  oldestPendingAt?: number;
}

export interface RuntimeLoopHealth {
  started: boolean;
  running: boolean;
  lastStatus?: "ok" | "error";
  lastTickAt?: number;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  lastReason?: string;
  lastError?: string;
  /** Dream batches completed during the latest tick. */
  lastBatchesRun?: number;
  /** admitted Raw handled by Dream batches during the latest tick. */
  lastProcessedRaw?: number;
  /** admitted Raw still pending across all Spaces after the latest tick. */
  lastPendingRaw?: number;
  /** whether at least one Space reached the per-tick catch-up bound. */
  lastBacklogLimited?: boolean;
}

/**
 * Decide whether to run a dream cycle for a space right now. Runs when:
 *   - there is pending raw AND
 *     - the space has never been distilled, OR
 *     - an admitted pending Raw predates the latest completed cycle, OR
 *     - its last dream is older than stalenessHours (catch-up after downtime), OR
 *     - it's at/after the nightly hour and it hasn't been distilled today.
 * No pending raw => never run (nothing to do; saves cost).
 */
export function shouldRunSpace(
  state: SpaceState,
  now: Date,
  cfg: ScheduleConfig,
): boolean {
  if (!state.hasPending) return false;
  if (state.lastDreamAt === undefined) return true;
  // A Raw older than the last completed cycle was already waiting when that
  // cycle finished. Treat it as durable carry-over instead of waiting a day.
  if (
    state.oldestPendingAt !== undefined
    && state.oldestPendingAt <= state.lastDreamAt
  ) return true;

  const ageMs = now.getTime() - state.lastDreamAt;
  if (ageMs >= cfg.stalenessHours * 3600_000) return true;

  // Nightly window: after the configured hour and not yet run today.
  if (localHour(now) >= cfg.hour) {
    const lastDay = dayKey(new Date(state.lastDreamAt));
    const nowDay = dayKey(now);
    if (lastDay !== nowDay) return true;
  }
  return false;
}

/** Local day key (YYYY-MM-DD) in Asia/Shanghai — used to detect "already ran today". */
export function dayKey(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

export class Scheduler {
  private engine: KnowledgeEngine;
  private cfg: ScheduleConfig;
  /** true when the nightly hour was pinned by the caller (tests); else follow config() */
  private hourPinned: boolean;
  /** true when retention was pinned by the caller (tests); else follow config() */
  private retentionPinned: boolean;
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private started = false;
  private lastStatus?: "ok" | "error";
  private lastTickAt?: number;
  private lastSuccessAt?: number;
  private lastFailureAt?: number;
  private lastReason?: string;
  private lastError?: string;
  private lastBatchesRun?: number;
  private lastProcessedRaw?: number;
  private lastPendingRaw?: number;
  private lastBacklogLimited?: boolean;

  constructor(engine: KnowledgeEngine, cfg: Partial<ScheduleConfig> = {}) {
    this.engine = engine;
    this.cfg = { ...DEFAULT_SCHEDULE, ...cfg };
    this.hourPinned = cfg.hour !== undefined;
    this.retentionPinned = cfg.rawRetentionDays !== undefined;
  }

  /**
   * Effective schedule for a tick. The nightly hour follows the editable global
   * setting (config().dreamHour) unless a caller pinned it explicitly; config
   * reads are wrapped so a scheduler used in tests without env still works.
   */
  private effectiveConfig(): ScheduleConfig {
    let hour = this.cfg.hour;
    let rawRetentionDays = this.cfg.rawRetentionDays;
    try {
      const live = config();
      if (!this.hourPinned) hour = live.dreamHour;
      if (!this.retentionPinned) rawRetentionDays = live.rawRetentionDays;
    } catch {
      // config() may be unavailable (missing env in unit tests); keep default.
    }
    return { ...this.cfg, hour, rawRetentionDays };
  }

  /** Start the loop and run an immediate catch-up pass. */
  async start(): Promise<void> {
    this.started = true;
    try {
      await this.tick("startup-catchup");
      this.timer = setInterval(() => {
        void this.tick("interval").catch((err) => {
          log.error("scheduler tick failed", { err: String(err) });
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
      lastBatchesRun: this.lastBatchesRun,
      lastProcessedRaw: this.lastProcessedRaw,
      lastPendingRaw: this.lastPendingRaw,
      lastBacklogLimited: this.lastBacklogLimited,
    };
  }

  /** One scheduling pass over all known spaces. Exposed for tests. */
  async tick(reason: string, now = new Date()): Promise<SpaceId[]> {
    if (this.running) return [];
    this.running = true;
    this.lastTickAt = Date.now();
    this.lastReason = reason;
    const cfg = this.effectiveConfig();
    const ran: SpaceId[] = [];
    const errors: string[] = [];
    let batchesRun = 0;
    let processedRaw = 0;
    let pendingRaw = 0;
    let backlogLimited = false;
    try {
      for (const meta of this.engine.registry.list()) {
        const idx = this.engine.registry.store(meta.id).index();
        const oldestPending = idx.listRaw({ onlyPending: true, limit: 1 })[0];
        const state: SpaceState = {
          id: meta.id,
          lastDreamAt: meta.lastDreamAt,
          hasPending: oldestPending !== undefined,
          oldestPendingAt: oldestPending?.createdAt,
        };
        if (!shouldRunSpace(state, now, cfg)) {
          pendingRaw += idx.countRaw(true);
          continue;
        }
        log.info("scheduling dream cycle", { space: meta.id, reason });
        const model = this.engine.agentForSpace(meta.id)?.model || undefined;
        const maxBatches = Math.max(1, Math.floor(cfg.maxCatchUpBatches));
        const batchEntries = Math.max(1, Math.floor(cfg.batchEntries));
        let spaceBatches = 0;
        let spaceFailed = false;
        try {
          for (let batch = 0; batch < maxBatches && idx.countRaw(true) > 0; batch += 1) {
            const pendingBefore = idx.countRaw(true);
            const report = await this.engine.scheduleBackgroundRun(
              `background:dream:${meta.id}:${now.getTime()}:${batch}`,
              meta.id,
              () => this.engine.runDreamCycle(meta.id, { model, maxEntries: batchEntries }),
            );
            batchesRun += 1;
            spaceBatches += 1;
            processedRaw += report.processedRawIds.length;
            if (!ran.includes(meta.id)) ran.push(meta.id);
            if (report.errors.length > 0) {
              spaceFailed = true;
              const detail = report.errors.join("; ").slice(0, 400);
              errors.push(`${meta.id}: ${detail}`);
              log.error("scheduled dream batch failed", {
                space: meta.id,
                batch: batch + 1,
                err: detail,
              });
              break;
            }
            const pendingAfter = idx.countRaw(true);
            if (pendingAfter >= pendingBefore) {
              spaceFailed = true;
              const detail = `提炼批次没有处理任何 Raw（仍有 ${pendingAfter} 条待提炼）`;
              errors.push(`${meta.id}: ${detail}`);
              log.error("scheduled dream batch made no progress", {
                space: meta.id,
                batch: batch + 1,
                pendingRaw: pendingAfter,
              });
              break;
            }
          }
        } catch (err) {
          spaceFailed = true;
          errors.push(`${meta.id}: ${String(err)}`);
          log.error("scheduled dream failed", { space: meta.id, err: String(err) });
        }
        const remaining = idx.countRaw(true);
        pendingRaw += remaining;
        if (!spaceFailed && remaining > 0 && spaceBatches >= maxBatches) {
          backlogLimited = true;
        }
      }
      const retention = await this.engine.pruneRawMessages(cfg.rawRetentionDays, now.getTime());
      if (retention.deleted > 0) {
        log.info("pruned expired raw messages", {
          retentionDays: retention.retentionDays,
          deleted: retention.deleted,
        });
      }
    } catch (err) {
      errors.push(String(err));
      throw err;
    } finally {
      this.running = false;
      this.lastBatchesRun = batchesRun;
      this.lastProcessedRaw = processedRaw;
      this.lastPendingRaw = pendingRaw;
      this.lastBacklogLimited = backlogLimited;
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
