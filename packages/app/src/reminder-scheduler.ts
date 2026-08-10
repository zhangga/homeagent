/** Proactive delivery loop for durable user reminders. */
import { createHash } from "node:crypto";
import { logger } from "@homeagent/shared";
import type { KnowledgeEngine, Reminder } from "@homeagent/core";
import type { RuntimeLoopHealth } from "./scheduler.ts";

const log = logger.child("reminder-scheduler");

export interface ReminderScheduleConfig {
  /** Reminder delivery should feel timely while remaining cheap. */
  tickMs: number;
}

export const DEFAULT_REMINDER_SCHEDULE: ReminderScheduleConfig = {
  tickMs: 30_000,
};

export type ReminderNotify = (
  reminder: Reminder,
  message: string,
  idempotencyKey: string,
) => void | Promise<void>;

export function reminderIdempotencyKey(reminder: Reminder): string {
  const digest = createHash("sha256")
    .update(`${reminder.id}\0${reminder.nextTriggerAt}`)
    .digest("hex")
    .slice(0, 32);
  return `ha-reminder-${digest}`;
}

export function reminderNotification(reminder: Reminder): string {
  const lines = [`⏰ 提醒：${reminder.title}`];
  if (reminder.untilConfirmed) {
    const confirmation = reminder.title.startsWith("确认")
      ? reminder.title
      : `确认${reminder.title}`;
    lines.push("", `回复并 @我“${confirmation}”即可停止重复提醒。`);
  }
  return lines.join("\n");
}

export class ReminderScheduler {
  private readonly engine: KnowledgeEngine;
  private readonly cfg: ReminderScheduleConfig;
  private readonly notify?: ReminderNotify;
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
    opts: { cfg?: Partial<ReminderScheduleConfig>; notify?: ReminderNotify } = {},
  ) {
    this.engine = engine;
    this.cfg = { ...DEFAULT_REMINDER_SCHEDULE, ...opts.cfg };
    this.notify = opts.notify;
  }

  async start(): Promise<void> {
    this.started = true;
    try {
      await this.tick("startup-catchup");
      this.timer = setInterval(() => {
        void this.tick("interval").catch((err) => {
          log.error("reminder scheduler tick failed", { err: String(err) });
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

  async tick(reason: string, now = new Date()): Promise<string[]> {
    if (this.running) return [];
    this.running = true;
    this.lastTickAt = Date.now();
    this.lastReason = reason;
    const delivered: string[] = [];
    const errors: string[] = [];
    try {
      for (const reminder of this.engine.reminders.due(now.getTime())) {
        try {
          const advanced = await this.engine.deliverReminder(
            reminder.id,
            now.getTime(),
            async (current) => {
              if (!this.notify) {
                throw new Error("reminder notification transport is unavailable");
              }
              await this.notify(
                current,
                reminderNotification(current),
                reminderIdempotencyKey(current),
              );
            },
          );
          if (advanced) delivered.push(reminder.id);
        } catch (err) {
          errors.push(`${reminder.id}: ${String(err)}`);
          log.error("reminder delivery failed", { reminderId: reminder.id, err: String(err) });
        }
      }
    } catch (err) {
      errors.push(String(err));
      throw err;
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
    return delivered;
  }
}
