/** Daily guided-learning delivery with startup catch-up and retry-safe state. */
import { createHash } from "node:crypto";
import { logger, type SkillWarningView } from "@homeagent/shared";
import type {
  KnowledgeEngine,
  LearningPlan,
  LearningSession,
  LearningSource,
} from "@homeagent/core";
import { formatSkillWarnings } from "@homeagent/orchestrator";
import { dayKey, localHour, type RuntimeLoopHealth } from "./scheduler.ts";

const log = logger.child("learning-scheduler");

export interface LearningScheduleConfig {
  tickMs: number;
}

export const DEFAULT_LEARNING_SCHEDULE: LearningScheduleConfig = {
  tickMs: 15 * 60 * 1000,
};

export type LearningNotify = (
  plan: LearningPlan,
  source: LearningSource,
  session: LearningSession,
  skillWarnings: SkillWarningView[] | undefined,
  idempotencyKey: string,
) => void | Promise<void>;
export type LearningFollowUpNotify = (
  plan: LearningPlan,
  session: LearningSession,
  message: string,
  idempotencyKey: string,
) => void | Promise<void>;

function learningDeliveryKey(prefix: "lesson" | "follow", identity: string): string {
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 32);
  return `ha-${prefix}-${digest}`;
}

export function learningLessonIdempotencyKey(session: LearningSession): string {
  return learningDeliveryKey("lesson", session.id);
}

export function learningFollowUpIdempotencyKey(
  session: LearningSession,
): string {
  return learningDeliveryKey(
    "follow",
    `${session.id}\0${(session.followUpCount ?? 0) + 1}`,
  );
}

export function shouldRunLearningPlan(
  plan: LearningPlan,
  current: LearningSession | undefined,
  now: Date,
): boolean {
  if (plan.status !== "active") return false;
  if (plan.mode === "topic" && plan.profile?.status === "assessing") return false;
  if (current?.status === "prepared") return true;
  if (current?.status === "awaiting_reply") return false;
  if (localHour(now) < plan.hour) return false;
  return plan.lastDeliveredAt === undefined
    || dayKey(new Date(plan.lastDeliveredAt)) !== dayKey(now);
}

export function shouldFollowUpLearningPlan(
  plan: LearningPlan,
  current: LearningSession | undefined,
  now: Date,
): boolean {
  if (plan.status !== "active" || current?.status !== "awaiting_reply") return false;
  if (current.deliveredAt === undefined || (current.followUpCount ?? 0) >= 3) return false;
  if (now.getTime() - current.deliveredAt < 24 * 60 * 60 * 1000) return false;
  return current.lastFollowUpAt === undefined
    || dayKey(new Date(current.lastFollowUpAt)) !== dayKey(now);
}

export function learningNotification(
  plan: LearningPlan,
  session: LearningSession,
  skillWarnings?: SkillWarningView[],
): string {
  const lessonContext = plan.mode === "topic"
    ? [`当前步骤：${session.sectionTitle}`, "", "## 参考材料", session.excerpt]
    : [`今日范围：${session.sectionTitle}`, "", "## 今日原文", session.excerpt];
  const message = [
    `📖 ${plan.name} · 第 ${session.sequence} 课`,
    ...lessonContext,
    "",
    session.guide,
    "",
    "读完后回复并 @我，以“学习回答：”开头；如需跳过，发送 `/learn skip <计划名称或序号>`。",
  ].join("\n");
  const warning = formatSkillWarnings(skillWarnings);
  return warning ? `${message}\n\n${warning}` : message;
}

export function learningFollowUpNotification(
  plan: LearningPlan,
  session: LearningSession,
): string {
  const focus = session.nextFocus || plan.adaptiveFocus || session.sectionTitle;
  return [
    `🌿 「${plan.name}」还在等你，不用赶进度。`,
    `当前停在：${session.sectionTitle}`,
    `可以先用几句话说说你对“${focus}”的理解，我会根据你的回答调整后面的路线。`,
    "",
    "继续：回复并 @我，以“学习回答：”开头",
    `暂时跳过：发送 \`/learn skip ${plan.name}\``,
  ].join("\n");
}

export class LearningScheduler {
  private readonly engine: KnowledgeEngine;
  private readonly cfg: LearningScheduleConfig;
  private readonly notify?: LearningNotify;
  private readonly followUp?: LearningFollowUpNotify;
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
    opts: {
      cfg?: Partial<LearningScheduleConfig>;
      notify?: LearningNotify;
      followUp?: LearningFollowUpNotify;
    } = {},
  ) {
    this.engine = engine;
    this.cfg = { ...DEFAULT_LEARNING_SCHEDULE, ...opts.cfg };
    this.notify = opts.notify;
    this.followUp = opts.followUp;
  }

  async start(): Promise<void> {
    this.started = true;
    try {
      await this.tick("startup-catchup");
      this.timer = setInterval(() => {
        void this.tick("interval").catch((error) => {
          log.error("learning scheduler tick failed", { err: String(error) });
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

  async tick(reason: string, now = new Date()): Promise<string[]> {
    if (this.running) return [];
    this.running = true;
    this.lastTickAt = Date.now();
    this.lastReason = reason;
    const delivered: string[] = [];
    const errors: string[] = [];
    try {
      for (const plan of this.engine.learning.list()) {
        const current = this.engine.learning.currentSession(plan.id);
        if (shouldFollowUpLearningPlan(plan, current, now)) {
          try {
            if (!this.followUp) throw new Error("learning follow-up transport is unavailable");
            const advanced = await this.engine.deliverLearningFollowUp(
              plan.id,
              current!.id,
              now.getTime(),
              async (currentPlan, currentSession) => this.followUp!(
                currentPlan,
                currentSession,
                learningFollowUpNotification(currentPlan, currentSession),
                learningFollowUpIdempotencyKey(currentSession),
              ),
            );
            if (advanced) delivered.push(`follow-up:${plan.id}`);
          } catch (error) {
            errors.push(`follow-up ${plan.id}: ${String(error)}`);
            log.error("scheduled learning follow-up failed", {
              planId: plan.id,
              err: String(error),
            });
          }
          continue;
        }
        if (!shouldRunLearningPlan(plan, current, now)) continue;
        try {
          const advanced = await this.engine.scheduleBackgroundRun(
            `background:learning:${plan.id}:${now.getTime()}`,
            plan.space,
            () => this.engine.deliverLearningSession(
              plan.id,
              now.getTime(),
              async (currentPlan, source, session, skillWarnings) => {
                if (!this.notify) {
                  throw new Error("learning notification transport is unavailable");
                }
                await this.notify(
                  currentPlan,
                  source,
                  session,
                  skillWarnings,
                  learningLessonIdempotencyKey(session),
                );
              },
            ),
          );
          if (advanced) delivered.push(plan.id);
        } catch (error) {
          errors.push(`${plan.id}: ${String(error)}`);
          log.error("scheduled learning delivery failed", {
            planId: plan.id,
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
