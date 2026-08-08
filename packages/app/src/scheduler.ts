/**
 * Dream-cycle scheduler (plan §VII, Q9). Robust to local sleep/shutdown by not
 * relying on a precise cron fire: it wakes on a coarse interval, and on each
 * wake (and once at startup — the "catch-up") it distills any space whose last
 * dream is older than the staleness threshold, or when the daily run hour has
 * passed and today's run hasn't happened yet.
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
  /** delete distilled raw messages older than this many days; 0 disables */
  rawRetentionDays: number;
}

export const DEFAULT_SCHEDULE: ScheduleConfig = {
  hour: 3,
  stalenessHours: 24,
  tickMs: 15 * 60 * 1000,
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
}

/**
 * Decide whether to run a dream cycle for a space right now. Runs when:
 *   - there is pending raw AND
 *     - the space has never been distilled, OR
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
    try {
      for (const meta of this.engine.registry.list()) {
        const idx = this.engine.registry.store(meta.id).index();
        const state: SpaceState = {
          id: meta.id,
          lastDreamAt: meta.lastDreamAt,
          hasPending: idx.countRaw(true) > 0,
        };
        if (!shouldRunSpace(state, now, cfg)) continue;
        log.info("scheduling dream cycle", { space: meta.id, reason });
        try {
          // Per-space agent model (management backend), if assigned.
          const model = this.engine.agentForSpace(meta.id)?.model || undefined;
          await this.engine.scheduleBackgroundRun(
            `background:dream:${meta.id}:${now.getTime()}`,
            meta.id,
            () => this.engine.runDreamCycle(meta.id, { model }),
          );
          ran.push(meta.id);
        } catch (err) {
          errors.push(`${meta.id}: ${String(err)}`);
          log.error("scheduled dream failed", { space: meta.id, err: String(err) });
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
