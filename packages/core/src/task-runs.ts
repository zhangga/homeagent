import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { isCliProvider, type ProviderId } from "@homeagent/llm";
import { isSpaceId, type SpaceId } from "@homeagent/shared";
import type { Task } from "./tasks.ts";
import type {
  ResolvedSkillSnapshot,
  SkillRequestSnapshot,
  SkippedSkillSnapshot,
} from "./skill-catalog.ts";
import { durableFsyncSync, durableRenameSync } from "./durable-file.ts";
import {
  cloneResolvedExecutionPlan,
  isResolvedExecutionPlan,
  type ResolvedExecutionPlan,
} from "./execution-plan.ts";
import type { RunPriority } from "./run-scheduler.ts";
import {
  cloneAggregatedRunUsage,
  isAggregatedRunUsage,
  type AggregatedRunUsage,
} from "./usage.ts";

export type TaskRunStatus =
  | "awaiting_approval"
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out";
export type TaskRunTrigger = "manual" | "scheduled" | "chat" | "retry";
export type TaskRunNotificationStatus = "pending" | "sent" | "failed";
export type TaskRunApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "legacy";
export type TaskRunFailurePhase = "admission" | "provider" | "capture";
export type TaskRunRetryStatus = "waiting" | "claimed" | "exhausted";

export interface TaskRunFailure {
  phase: TaskRunFailurePhase;
  kind: string;
  retryable: boolean;
}

export interface TaskRunRetry {
  attempt: number;
  maxAttempts: number;
  status: TaskRunRetryStatus;
  nextAttemptAt?: number;
  claimedByRunId?: string;
}

export interface TaskRunApproval {
  status: TaskRunApprovalStatus;
  requestedAt: number;
  expiresAt?: number;
  decidedAt?: number;
  decidedBy?: string;
  reason?: string;
}

export interface TaskRunNotification {
  status: TaskRunNotificationStatus;
  attempts: number;
  lastAttemptAt?: number;
  nextAttemptAt?: number;
  sentAt?: number;
  error?: string;
}

export interface TaskRun {
  id: string;
  taskId: string;
  taskName: string;
  space: SpaceId;
  workItemId?: string;
  workActionId?: string;
  topic: string;
  trigger: TaskRunTrigger;
  agentId?: string;
  provider?: ProviderId;
  model?: string;
  executionPlan?: ResolvedExecutionPlan;
  skillEvidence?: TaskRunSkillEvidence;
  retryOf?: string;
  distill: boolean;
  notify?: boolean;
  timeoutMs?: number;
  priority: RunPriority;
  status: TaskRunStatus;
  approval?: TaskRunApproval;
  approvalNotification?: TaskRunNotification;
  queuedAt: number;
  startedAt: number;
  runStartedAt?: number;
  finishedAt?: number;
  output?: string;
  outputTruncated?: boolean;
  summary?: string;
  error?: string;
  failure?: TaskRunFailure;
  retry?: TaskRunRetry;
  usage?: AggregatedRunUsage;
  rawId?: string;
  pagesWritten?: number;
  notification?: TaskRunNotification;
}

export interface TaskRunSkillEvidence {
  requested: SkillRequestSnapshot[];
  resolved: ResolvedSkillSnapshot[];
  skipped: SkippedSkillSnapshot[];
}

interface TaskRunsFile {
  version: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11;
  runs: Record<string, TaskRun>;
}

export interface StartTaskRunInput {
  task: Task;
  trigger: TaskRunTrigger;
  workItemId?: string;
  workActionId?: string;
  agentId?: string;
  provider?: ProviderId;
  model?: string;
  executionPlan?: ResolvedExecutionPlan;
  skillEvidence?: TaskRunSkillEvidence;
  retryOf?: string;
  distill: boolean;
  timeoutMs?: number;
  priority?: RunPriority;
  startedAt?: number;
  approvalRequired?: boolean;
}

export interface DecideTaskRunApprovalInput {
  decidedAt: number;
  decidedBy?: string;
  reason?: string;
}

export interface FinishTaskRunInput {
  finishedAt: number;
  output?: string;
  summary?: string;
  error?: string;
  failure?: TaskRunFailure;
  retry?: TaskRunRetry;
  usage?: AggregatedRunUsage;
  rawId?: string;
  pagesWritten?: number;
}

export interface TaskRunStoreOptions {
  recoverInterrupted?: boolean;
}

export const MAX_TASK_RUN_OUTPUT_CHARACTERS = 100_000;
export const MAX_TASK_RUN_ERROR_CHARACTERS = 20_000;
export const MAX_TASK_RUN_HISTORY_PER_TASK = 100;
export const MAX_TASK_RUN_SKILLS = 2_000;
export const MAX_TASK_RUN_SKILL_MESSAGE_CHARACTERS = 300;
export const MAX_TASK_RUN_APPROVER_CHARACTERS = 300;
export const MAX_AUTOMATIC_TASK_RUN_ATTEMPTS = 2;
export const AUTOMATIC_TASK_RUN_RETRY_DELAY_MS = 60_000;
export const DEFAULT_TASK_RUN_APPROVAL_TTL_MS = 24 * 60 * 60_000;
export const TASK_RUN_APPROVAL_EXPIRY_ACTOR = "homeagent.approval-expiry";
export const TASK_RUN_APPROVAL_EXPIRY_REASON = "Task run approval expired before a decision was made.";
export const LEGACY_TASK_RUN_APPROVAL_ACTOR = "homeagent.archive-v10";
export const LEGACY_TASK_RUN_APPROVAL_REASON =
  "Imported terminal writable Task Run predates durable approval audit; approval was not recorded.";
export const MAX_TASK_NOTIFICATION_ATTEMPTS = 5;
const TASK_NOTIFICATION_RETRY_DELAYS_MS = [
  60_000,
  5 * 60_000,
  30 * 60_000,
  2 * 60 * 60_000,
  6 * 60 * 60_000,
] as const;
const LEGACY_UNAPPROVED_RUN_ERROR =
  "Legacy queued write/full Task Run had no durable approval; execution was refused.";
const INTERRUPTED_RUN_ERROR = "应用在任务完成前停止，运行已标记为失败";

function clone(run: TaskRun): TaskRun {
  return {
    ...run,
    executionPlan: run.executionPlan
      ? cloneResolvedExecutionPlan(run.executionPlan)
      : undefined,
    approval: run.approval ? { ...run.approval } : undefined,
    approvalNotification: run.approvalNotification
      ? { ...run.approvalNotification }
      : undefined,
    failure: run.failure ? { ...run.failure } : undefined,
    retry: run.retry ? { ...run.retry } : undefined,
    usage: run.usage ? cloneAggregatedRunUsage(run.usage) : undefined,
    skillEvidence: run.skillEvidence
      ? {
          requested: run.skillEvidence.requested.map((item) => ({ ...item })),
          resolved: run.skillEvidence.resolved.map((item) => ({ ...item })),
          skipped: run.skillEvidence.skipped.map((item) => ({ ...item })),
        }
      : undefined,
    notification: run.notification ? { ...run.notification } : undefined,
  };
}

export function isTaskRunFailure(value: unknown): value is TaskRunFailure {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const failure = value as Partial<TaskRunFailure>;
  return ["admission", "provider", "capture"].includes(String(failure.phase))
    && typeof failure.kind === "string"
    && /^[a-z][a-z0-9_]{0,79}$/.test(failure.kind)
    && typeof failure.retryable === "boolean"
    && (!failure.retryable || failure.phase === "provider");
}

export function isTaskRunRetry(value: unknown): value is TaskRunRetry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const retry = value as Partial<TaskRunRetry>;
  if (
    !Number.isInteger(retry.attempt)
    || retry.attempt! < 1
    || !Number.isInteger(retry.maxAttempts)
    || retry.maxAttempts !== MAX_AUTOMATIC_TASK_RUN_ATTEMPTS
    || retry.attempt! > retry.maxAttempts!
    || !["waiting", "claimed", "exhausted"].includes(String(retry.status))
    || (retry.nextAttemptAt !== undefined && (
      typeof retry.nextAttemptAt !== "number"
      || !Number.isFinite(retry.nextAttemptAt)
      || retry.nextAttemptAt < 0
    ))
    || (retry.claimedByRunId !== undefined && (
      typeof retry.claimedByRunId !== "string"
      || retry.claimedByRunId.length === 0
      || retry.claimedByRunId.length > 200
    ))
  ) {
    return false;
  }
  if (retry.status === "waiting") {
    return retry.nextAttemptAt !== undefined
      && retry.claimedByRunId === undefined
      && retry.attempt! < retry.maxAttempts!;
  }
  if (retry.status === "exhausted") {
    return retry.nextAttemptAt === undefined
      && retry.claimedByRunId === undefined;
  }
  return retry.nextAttemptAt === undefined;
}

function isSkillName(value: unknown): value is string {
  return typeof value === "string"
    && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/.test(value);
}

function isSourceKey(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= 600
    && /^(?:shared-agents|codex-user|codex-plugin|codex-vendor|claude-user|claude-plugin|claude-marketplace|trae-user):[^\u0000-\u001f\\]+$/u.test(
      value,
    );
}

export function isTaskRunSkillEvidence(value: unknown): value is TaskRunSkillEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const evidence = value as Partial<TaskRunSkillEvidence>;
  if (
    !Array.isArray(evidence.requested)
    || !Array.isArray(evidence.resolved)
    || !Array.isArray(evidence.skipped)
    || evidence.requested.length > MAX_TASK_RUN_SKILLS
    || evidence.resolved.length > MAX_TASK_RUN_SKILLS
    || evidence.skipped.length > MAX_TASK_RUN_SKILLS
  ) {
    return false;
  }
  const validRequested = evidence.requested.every((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    if (!isSkillName(item.name)) return false;
    if (item.kind === "legacy-name") return true;
    return item.kind === "source" && isSourceKey(item.sourceKey);
  });
  const validResolved = evidence.resolved.every((item) =>
    item
    && typeof item === "object"
    && !Array.isArray(item)
    && isSourceKey(item.sourceKey)
    && isSkillName(item.name)
    && isSkillName(item.invocationName)
    && typeof item.reference === "string"
    && item.reference.length <= 81
    && /^[a-f0-9]{64}$/.test(item.skillFileHash)
  );
  const validSkipped = evidence.skipped.every((item) =>
    item
    && typeof item === "object"
    && !Array.isArray(item)
    && (item.sourceKey === undefined || isSourceKey(item.sourceKey))
    && isSkillName(item.name)
    && [
      "missing_source",
      "invalid_skill",
      "provider_incompatible",
      "ambiguous_legacy_name",
      "shadowed_source",
      "invalid_invocation_name",
      "no_tools_context",
    ].includes(item.code)
    && typeof item.message === "string"
    && item.message.length <= MAX_TASK_RUN_SKILL_MESSAGE_CHARACTERS
  );
  return validRequested && validResolved && validSkipped;
}

function isTaskRunApproval(value: unknown): value is TaskRunApproval {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const approval = value as Partial<TaskRunApproval>;
  const decided = approval.status === "approved"
    || approval.status === "rejected"
    || approval.status === "expired"
    || approval.status === "legacy";
  return (
    ["pending", "approved", "rejected", "expired", "legacy"].includes(String(approval.status))
    && typeof approval.requestedAt === "number"
    && Number.isFinite(approval.requestedAt)
    && approval.requestedAt >= 0
    && (approval.expiresAt === undefined || (
      typeof approval.expiresAt === "number"
      && Number.isFinite(approval.expiresAt)
      && approval.expiresAt > approval.requestedAt
    ))
    && (approval.decidedAt === undefined || (
      typeof approval.decidedAt === "number"
      && Number.isFinite(approval.decidedAt)
      && approval.decidedAt >= approval.requestedAt
    ))
    && (approval.decidedBy === undefined || (
      typeof approval.decidedBy === "string"
      && approval.decidedBy.length > 0
      && approval.decidedBy.length <= MAX_TASK_RUN_APPROVER_CHARACTERS
    ))
    && (approval.reason === undefined || (
      typeof approval.reason === "string"
      && approval.reason.length <= MAX_TASK_RUN_ERROR_CHARACTERS
    ))
    && (decided ? approval.decidedAt !== undefined : approval.decidedAt === undefined)
    && (approval.status !== "pending"
      || (approval.decidedBy === undefined && approval.reason === undefined))
    && (approval.status !== "pending" || approval.expiresAt !== undefined)
    && (approval.status !== "expired" || (
      approval.expiresAt !== undefined
      && approval.decidedAt === approval.expiresAt
      && approval.decidedBy === TASK_RUN_APPROVAL_EXPIRY_ACTOR
      && approval.reason === TASK_RUN_APPROVAL_EXPIRY_REASON
    ))
    && (approval.status !== "legacy" || (
      approval.decidedBy === LEGACY_TASK_RUN_APPROVAL_ACTOR
      && approval.reason === LEGACY_TASK_RUN_APPROVAL_REASON
    ))
  );
}

function isRiskyTaskExecutionPlan(plan: ResolvedExecutionPlan | undefined): boolean {
  return plan?.execution?.permission === "write"
    || plan?.execution?.permission === "full";
}

function clampTerminalTime(
  run: Pick<TaskRun, "startedAt" | "runStartedAt" | "approval">,
  requestedAt: number,
): number {
  return Math.max(
    requestedAt,
    run.runStartedAt ?? run.startedAt,
    run.approval?.decidedAt ?? 0,
  );
}

function validateApprovalDecision(
  input: DecideTaskRunApprovalInput,
  requestedAt: number,
): void {
  if (
    !Number.isFinite(input.decidedAt)
    || input.decidedAt < requestedAt
  ) {
    throw new Error("Task approval decision time is invalid");
  }
  if (
    input.decidedBy !== undefined
    && (
      input.decidedBy.length === 0
      || input.decidedBy.length > MAX_TASK_RUN_APPROVER_CHARACTERS
    )
  ) {
    throw new Error("Task approval decision actor is invalid");
  }
  if (
    input.reason !== undefined
    && input.reason.length > MAX_TASK_RUN_ERROR_CHARACTERS
  ) {
    throw new Error("Task approval decision reason is too long");
  }
}

function validateFinishTaskRunInput(result: FinishTaskRunInput): void {
  if (result.failure !== undefined && !isTaskRunFailure(result.failure)) {
    throw new Error("Task Run failure metadata is invalid");
  }
  if (result.retry !== undefined && !isTaskRunRetry(result.retry)) {
    throw new Error("Task Run retry metadata is invalid");
  }
  if (result.usage !== undefined && !isAggregatedRunUsage(result.usage)) {
    throw new Error("Task Run usage is invalid");
  }
}

function validateAutomaticRetryFailure(
  run: TaskRun,
  result: FinishTaskRunInput,
): void {
  if (!result.retry) return;
  const expectedAttempt = run.retry?.attempt ?? 1;
  if (
    result.retry.attempt !== expectedAttempt
    || result.retry.maxAttempts !== MAX_AUTOMATIC_TASK_RUN_ATTEMPTS
    || result.retry.status === "claimed"
  ) {
    throw new Error("Task Run retry transition is invalid");
  }
  if (result.retry.status === "exhausted") {
    if (expectedAttempt !== MAX_AUTOMATIC_TASK_RUN_ATTEMPTS) {
      throw new Error("Task Run retry cannot be exhausted before its final attempt");
    }
    return;
  }
  if (
    run.executionPlan?.execution?.permission !== "read-only"
    || (run.trigger !== "scheduled" && run.retry === undefined)
    || result.failure?.phase !== "provider"
    || !result.failure.retryable
    || result.output !== undefined
    || result.rawId !== undefined
    || result.retry.nextAttemptAt! < result.finishedAt
  ) {
    throw new Error("Task Run is not eligible for automatic retry");
  }
}

function isTaskRun(value: unknown): value is TaskRun {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const run = value as Partial<TaskRun>;
  const optionalStrings = [
    run.workItemId,
    run.workActionId,
    run.agentId,
    run.model,
    run.retryOf,
    run.output,
    run.summary,
    run.error,
    run.rawId,
  ].every((item) => item === undefined || typeof item === "string");
  const optionalNumbers = [
    run.finishedAt,
    run.pagesWritten,
    run.timeoutMs,
    run.runStartedAt,
  ].every(
    (item) => item === undefined || (typeof item === "number" && Number.isFinite(item)),
  );
  const notification = run.notification;
  const validNotification = notification === undefined || (
    typeof notification === "object"
    && notification !== null
    && !Array.isArray(notification)
    && ["pending", "sent", "failed"].includes(String(notification.status))
    && Number.isInteger(notification.attempts)
    && notification.attempts >= 0
    && [
      notification.lastAttemptAt,
      notification.nextAttemptAt,
      notification.sentAt,
    ].every((item) => item === undefined || (typeof item === "number" && Number.isFinite(item)))
    && (notification.error === undefined || typeof notification.error === "string")
    && (
      notification.error === undefined
      || notification.error.length <= MAX_TASK_RUN_ERROR_CHARACTERS
    )
    && (notification.status !== "sent" || typeof notification.sentAt === "number")
    && (notification.status !== "failed" || typeof notification.error === "string")
  );
  const approvalNotification = run.approvalNotification;
  const validApprovalNotification = approvalNotification === undefined || (
    typeof approvalNotification === "object"
    && approvalNotification !== null
    && !Array.isArray(approvalNotification)
    && ["pending", "sent", "failed"].includes(String(approvalNotification.status))
    && Number.isInteger(approvalNotification.attempts)
    && approvalNotification.attempts >= 0
    && [
      approvalNotification.lastAttemptAt,
      approvalNotification.nextAttemptAt,
      approvalNotification.sentAt,
    ].every((item) => item === undefined || (typeof item === "number" && Number.isFinite(item)))
    && (approvalNotification.error === undefined || typeof approvalNotification.error === "string")
    && (
      approvalNotification.error === undefined
      || approvalNotification.error.length <= MAX_TASK_RUN_ERROR_CHARACTERS
    )
    && (approvalNotification.status !== "sent" || typeof approvalNotification.sentAt === "number")
    && (approvalNotification.status !== "failed" || typeof approvalNotification.error === "string")
  );
  return (
    typeof run.id === "string"
    && typeof run.taskId === "string"
    && typeof run.taskName === "string"
    && typeof run.space === "string"
    && isSpaceId(run.space)
    && typeof run.topic === "string"
    && ["manual", "scheduled", "chat", "retry"].includes(String(run.trigger))
    && (run.provider === undefined || isCliProvider(run.provider))
    && (run.executionPlan === undefined || (
      isResolvedExecutionPlan(run.executionPlan)
      && (run.executionPlan.execution !== undefined
        || run.executionPlan.resolutionError !== undefined)
    ))
    && (run.skillEvidence === undefined || isTaskRunSkillEvidence(run.skillEvidence))
    && (run.failure === undefined || isTaskRunFailure(run.failure))
    && (run.retry === undefined || isTaskRunRetry(run.retry))
    && (run.usage === undefined || isAggregatedRunUsage(run.usage))
    && typeof run.distill === "boolean"
    && (run.notify === undefined || typeof run.notify === "boolean")
    && ["interactive", "manual", "scheduled", "background"].includes(String(run.priority))
    && ["awaiting_approval", "queued", "running", "succeeded", "failed", "cancelled", "timed_out"]
      .includes(String(run.status))
    && (run.approval === undefined || isTaskRunApproval(run.approval))
    && (run.status === "awaiting_approval"
      ? run.approval?.status === "pending"
      : run.approval?.status !== "pending")
    && (run.approval?.status !== "rejected" || run.status === "cancelled")
    && (run.approval?.status !== "expired" || run.status === "cancelled")
    && (
      run.approval?.status !== "approved"
      || run.approval.expiresAt === undefined
      || run.approval.decidedAt! < run.approval.expiresAt
    )
    && (
      run.approval?.status !== "expired"
      || run.finishedAt === run.approval.expiresAt
    )
    && (
      run.approval?.status !== "approved"
      || run.runStartedAt === undefined
      || run.approval.decidedAt! <= run.runStartedAt
    )
    && (
      run.approval?.status !== "approved"
      || run.finishedAt === undefined
      || run.approval.decidedAt! <= run.finishedAt
    )
    && (
      run.approval?.status !== "legacy"
      || (
        run.finishedAt !== undefined
        && run.approval.decidedAt === run.finishedAt
      )
    )
    && (!isRiskyTaskExecutionPlan(run.executionPlan) || run.approval !== undefined)
    && (
      !isRiskyTaskExecutionPlan(run.executionPlan)
      || !["awaiting_approval", "queued", "running"].includes(String(run.status))
      || run.approval?.status === (
        run.status === "awaiting_approval" ? "pending" : "approved"
      )
    )
    && typeof run.queuedAt === "number"
    && Number.isFinite(run.queuedAt)
    && typeof run.startedAt === "number"
    && Number.isFinite(run.startedAt)
    && run.queuedAt === run.startedAt
    && (run.runStartedAt === undefined || run.runStartedAt >= run.queuedAt)
    && optionalStrings
    && optionalNumbers
    && validNotification
    && validApprovalNotification
    && (run.approvalNotification === undefined || run.approval !== undefined)
    && (run.notification === undefined || run.status === "succeeded")
    && (run.notification === undefined || run.notify !== false)
    && (run.failure === undefined || run.status !== "succeeded")
    && (run.retry === undefined || (
      run.executionPlan?.execution?.permission === "read-only"
      && (run.trigger === "scheduled" || run.trigger === "retry")
    ))
    && (run.retry?.status !== "waiting" || (
      run.status === "failed"
      && run.failure?.phase === "provider"
      && run.failure.retryable
      && run.output === undefined
      && run.rawId === undefined
      && run.finishedAt !== undefined
      && run.retry.nextAttemptAt! >= run.finishedAt + AUTOMATIC_TASK_RUN_RETRY_DELAY_MS
    ))
    && (run.retry?.status !== "exhausted" || run.status === "failed")
    && (run.retry?.claimedByRunId === undefined || (
      run.status === "failed"
      && run.failure?.phase === "provider"
      && run.failure.retryable
      && run.output === undefined
      && run.rawId === undefined
    ))
    && (run.trigger !== "retry" || run.retryOf !== undefined)
    && (run.outputTruncated === undefined || typeof run.outputTruncated === "boolean")
    && (
      run.status === "awaiting_approval"
      || run.status === "queued"
      || run.status === "running"
      || typeof run.finishedAt === "number"
    )
    && (run.status !== "running" || typeof run.runStartedAt === "number")
    && (
      !["failed", "cancelled", "timed_out"].includes(String(run.status))
      || typeof run.error === "string"
    )
    && (run.finishedAt === undefined
      || run.finishedAt >= (run.runStartedAt ?? run.startedAt))
    && (run.output === undefined || run.output.length <= MAX_TASK_RUN_OUTPUT_CHARACTERS)
    && (run.error === undefined || run.error.length <= MAX_TASK_RUN_ERROR_CHARACTERS)
    && (!run.outputTruncated || run.output !== undefined)
    && (
      run.pagesWritten === undefined
      || (Number.isInteger(run.pagesWritten) && run.pagesWritten >= 0)
    )
    && (
      run.timeoutMs === undefined
      || (Number.isInteger(run.timeoutMs) && run.timeoutMs > 0)
    )
  );
}

export class TaskRunStore {
  private readonly configPath: string;
  private runs: Map<string, TaskRun>;
  private lastStartedAt: number;

  constructor(dataDir: string, opts: TaskRunStoreOptions = {}) {
    this.configPath = join(dataDir, "config", "task-runs.json");
    this.runs = this.load();
    this.lastStartedAt = 0;
    for (const run of this.runs.values()) {
      this.lastStartedAt = Math.max(this.lastStartedAt, run.startedAt);
    }
    if (opts.recoverInterrupted) this.recoverInterruptedRuns();
  }

  private load(): Map<string, TaskRun> {
    const runs = new Map<string, TaskRun>();
    if (!existsSync(this.configPath)) return runs;
    let migratedUnapprovedRun = false;
    try {
      const parsed = JSON.parse(readFileSync(this.configPath, "utf8")) as Partial<TaskRunsFile>;
      const version = parsed.version;
      if (version === undefined || ![2, 3, 4, 5, 6, 7, 8, 9, 10, 11].includes(version)) return runs;
      migratedUnapprovedRun = version < 9;
      for (const [id, value] of Object.entries(parsed.runs ?? {})) {
        const legacy = value as Partial<TaskRun>;
        const queueNormalized: Partial<TaskRun> = version >= 5
          ? legacy
          : {
              ...legacy,
              priority: (legacy.trigger === "scheduled"
                ? "scheduled"
                : legacy.trigger === "chat"
                  ? "interactive"
                  : "manual") as RunPriority,
              queuedAt: legacy.startedAt,
              runStartedAt: legacy.status === "queued" ? undefined : legacy.startedAt,
            };
        const needsApprovalMigration = version < 7
          && (queueNormalized.status === "queued" || queueNormalized.status === "running")
          && isResolvedExecutionPlan(queueNormalized.executionPlan)
          && isRiskyTaskExecutionPlan(queueNormalized.executionPlan);
        const terminalNormalized: Partial<TaskRun> = needsApprovalMigration
          ? {
              ...queueNormalized,
              status: "failed",
              finishedAt: Math.max(
                Date.now(),
                queueNormalized.runStartedAt ?? queueNormalized.startedAt ?? 0,
              ),
              error: LEGACY_UNAPPROVED_RUN_ERROR,
            }
          : queueNormalized;
        const needsLegacyApprovalAudit = version < 7
          && terminalNormalized.approval === undefined
          && isResolvedExecutionPlan(terminalNormalized.executionPlan)
          && isRiskyTaskExecutionPlan(terminalNormalized.executionPlan)
          && !["awaiting_approval", "queued", "running"].includes(
            String(terminalNormalized.status),
          );
        const approvalNormalized: Partial<TaskRun> = needsLegacyApprovalAudit
          ? {
              ...terminalNormalized,
              approval: {
                status: "legacy",
                requestedAt: terminalNormalized.startedAt ?? 0,
                decidedAt: terminalNormalized.finishedAt,
                decidedBy: LEGACY_TASK_RUN_APPROVAL_ACTOR,
                reason: LEGACY_TASK_RUN_APPROVAL_REASON,
              },
            }
          : terminalNormalized;
        const needsApprovalExpiryMigration = version < 8
          && approvalNormalized.status === "awaiting_approval"
          && approvalNormalized.approval?.status === "pending"
          && approvalNormalized.approval.expiresAt === undefined;
        const expiryNormalized: Partial<TaskRun> = needsApprovalExpiryMigration
          ? {
              ...approvalNormalized,
              approval: {
                ...approvalNormalized.approval!,
                expiresAt: approvalNormalized.approval!.requestedAt
                  + DEFAULT_TASK_RUN_APPROVAL_TTL_MS,
              },
            }
          : approvalNormalized;
        const needsApprovalNotificationMigration = version < 8
          && expiryNormalized.status === "awaiting_approval"
          && expiryNormalized.approval?.status === "pending"
          && expiryNormalized.approvalNotification === undefined;
        const normalized: Partial<TaskRun> = needsApprovalNotificationMigration
          ? {
              ...expiryNormalized,
              approvalNotification: { status: "pending", attempts: 0 },
            }
          : expiryNormalized;
        if (!isTaskRun(normalized) || normalized.id !== id) continue;
        runs.set(id, clone(normalized));
        migratedUnapprovedRun ||= needsApprovalMigration
          || needsLegacyApprovalAudit
          || needsApprovalExpiryMigration
          || needsApprovalNotificationMigration;
      }
    } catch {
      // Corrupt history must not prevent the application from starting.
      return runs;
    }
    if (migratedUnapprovedRun) this.persist(runs);
    return runs;
  }

  private persist(runs = this.runs): void {
    const configDir = dirname(this.configPath);
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    const tempPath = `${this.configPath}.${process.pid}.${randomUUID()}.tmp`;
    const file: TaskRunsFile = { version: 11, runs: Object.fromEntries(runs) };
    try {
      writeFileSync(tempPath, JSON.stringify(file, null, 2), { encoding: "utf8", mode: 0o600 });
      const fileDescriptor = openSync(tempPath, "r+");
      try {
        durableFsyncSync(fileDescriptor);
      } finally {
        closeSync(fileDescriptor);
      }
      durableRenameSync(tempPath, this.configPath);
      const directoryDescriptor = openSync(configDir, "r");
      try {
        durableFsyncSync(directoryDescriptor, {
          allowUnsupportedDirectoryOnWindows: true,
        });
      } finally {
        closeSync(directoryDescriptor);
      }
    } finally {
      if (existsSync(tempPath)) unlinkSync(tempPath);
    }
  }

  private commit<T>(
    change: (
      candidate: Map<string, TaskRun>,
      state: { lastStartedAt: number },
    ) => T,
  ): T {
    const candidate = new Map(
      [...this.runs].map(([id, run]) => [id, clone(run)]),
    );
    const state = { lastStartedAt: this.lastStartedAt };
    const result = change(candidate, state);
    this.persist(candidate);
    this.runs = candidate;
    this.lastStartedAt = state.lastStartedAt;
    return result;
  }

  private recoverInterruptedRuns(): void {
    const now = Date.now();
    const interrupted = [...this.runs.values()].filter((run) => run.status === "running");
    if (interrupted.length === 0) return;
    this.commit((candidate) => {
      const affectedTaskIds = new Set<string>();
      for (const run of candidate.values()) {
        if (run.status !== "running") continue;
        run.status = "failed";
        run.finishedAt = clampTerminalTime(run, now);
        run.error = INTERRUPTED_RUN_ERROR;
        run.failure = { phase: "admission", kind: "interrupted", retryable: false };
        if (
          run.retry
          && run.retry.attempt >= run.retry.maxAttempts
        ) {
          run.retry = {
            attempt: run.retry.attempt,
            maxAttempts: run.retry.maxAttempts,
            status: "exhausted",
          };
        }
        affectedTaskIds.add(run.taskId);
      }
      for (const taskId of affectedTaskIds) this.pruneCompletedRuns(taskId, candidate);
    });
  }

  private pruneCompletedRuns(taskId: string, runs = this.runs): void {
    const completed = [...runs.values()].filter(
      (run) =>
        run.taskId === taskId
        && run.status !== "awaiting_approval"
        && run.status !== "queued"
        && run.status !== "running",
    ).filter((run) => {
      if (run.retry?.status === "waiting") return false;
      if (run.retry?.status !== "claimed" || !run.retry.claimedByRunId) return true;
      const child = runs.get(run.retry.claimedByRunId);
      return child === undefined
        || !["awaiting_approval", "queued", "running"].includes(child.status);
    });
    const excess = completed.length - MAX_TASK_RUN_HISTORY_PER_TASK;
    if (excess <= 0) return;
    for (const run of completed.slice(0, excess)) runs.delete(run.id);
  }

  /**
   * Repair the narrow capture crash window where Raw was durable before the
   * Task Run could persist its evidence id. Existing evidence is immutable.
   */
  reconcileRawEvidence(id: string, rawId: string): TaskRun | undefined {
    if (!rawId.trim()) throw new Error("Task Run Raw evidence id is required");
    return this.commit((candidate) => {
      const run = candidate.get(id);
      if (!run) return undefined;
      if (run.rawId !== undefined) {
        if (run.rawId !== rawId) {
          throw new Error(`Task Run Raw evidence already points elsewhere: ${id}`);
        }
        return clone(run);
      }
      const repaired = { ...run, rawId };
      if (!isTaskRun(repaired)) {
        throw new Error(`Task Run cannot accept recovered Raw evidence: ${id}`);
      }
      candidate.set(id, repaired);
      return clone(repaired);
    });
  }

  start(input: StartTaskRunInput): TaskRun {
    if (input.executionPlan !== undefined && !isResolvedExecutionPlan(input.executionPlan)) {
      throw new Error("Resolved execution plan is invalid");
    }
    if (
      input.executionPlan !== undefined
      && input.executionPlan.execution === undefined
      && input.executionPlan.resolutionError === undefined
    ) {
      throw new Error("Resolved Task plan requires a task execution grant or resolution error");
    }
    if (input.approvalRequired && !isRiskyTaskExecutionPlan(input.executionPlan)) {
      throw new Error("Task approval is only valid for write or full execution");
    }
    if (!input.approvalRequired && isRiskyTaskExecutionPlan(input.executionPlan)) {
      throw new Error("Write or full task execution requires approval");
    }
    if (
      input.skillEvidence !== undefined
      && !isTaskRunSkillEvidence(input.skillEvidence)
    ) {
      throw new Error("Skill evidence is invalid or exceeds persistence limits");
    }
    return this.commit((candidate, state) => {
      const requestedStartedAt = input.startedAt ?? Date.now();
      const startedAt = Math.max(requestedStartedAt, state.lastStartedAt + 1);
      state.lastStartedAt = startedAt;
      const id = `run_${randomUUID()}`;
      const run: TaskRun = {
        id,
        taskId: input.task.id,
        taskName: input.task.name,
        space: input.task.space,
        topic: input.task.topic,
        trigger: input.trigger,
        workItemId: input.workItemId,
        workActionId: input.workActionId,
        agentId: input.agentId,
        provider: input.provider,
        model: input.model,
        executionPlan: input.executionPlan
          ? cloneResolvedExecutionPlan(input.executionPlan)
          : undefined,
        skillEvidence: input.skillEvidence
          ? {
              requested: input.skillEvidence.requested.map((item) => ({ ...item })),
              resolved: input.skillEvidence.resolved.map((item) => ({ ...item })),
              skipped: input.skillEvidence.skipped.map((item) => ({ ...item })),
            }
          : undefined,
        retryOf: input.retryOf,
        distill: input.distill,
        notify: input.task.notify,
        timeoutMs: input.timeoutMs,
        priority: input.priority ?? (
          input.trigger === "scheduled"
            ? "scheduled"
            : input.trigger === "chat"
              ? "interactive"
              : "manual"
        ),
        status: input.approvalRequired ? "awaiting_approval" : "queued",
        approval: input.approvalRequired
          ? {
              status: "pending",
              requestedAt: startedAt,
              expiresAt: startedAt + DEFAULT_TASK_RUN_APPROVAL_TTL_MS,
            }
          : undefined,
        approvalNotification: input.approvalRequired
          ? { status: "pending", attempts: 0 }
          : undefined,
        queuedAt: startedAt,
        startedAt,
      };
      for (const previous of candidate.values()) {
        if (
          previous.taskId !== run.taskId
          || previous.status !== "failed"
          || previous.retry?.status !== "waiting"
        ) {
          continue;
        }
        previous.retry = {
          attempt: previous.retry.attempt,
          maxAttempts: previous.retry.maxAttempts,
          status: "claimed",
          claimedByRunId: run.id,
        };
      }
      candidate.set(run.id, run);
      return clone(run);
    });
  }

  succeed(id: string, result: FinishTaskRunInput): TaskRun | undefined {
    const existing = this.runs.get(id);
    if (!existing || !["queued", "running"].includes(existing.status)) return undefined;
    validateFinishTaskRunInput(result);
    if (result.failure !== undefined || result.retry !== undefined) {
      throw new Error("Successful Task Run cannot persist failure or retry metadata");
    }
    return this.commit((candidate) => {
      const run = candidate.get(id)!;
      const output = result.output ?? "";
      run.runStartedAt ??= Math.max(
        run.startedAt,
        run.approval?.decidedAt ?? 0,
      );
      run.status = "succeeded";
      run.finishedAt = clampTerminalTime(run, result.finishedAt);
      run.output = output.slice(0, MAX_TASK_RUN_OUTPUT_CHARACTERS);
      run.outputTruncated = output.length > MAX_TASK_RUN_OUTPUT_CHARACTERS || undefined;
      run.summary = result.summary;
      run.error = undefined;
      run.failure = undefined;
      run.usage = result.usage ? cloneAggregatedRunUsage(result.usage) : undefined;
      run.rawId = result.rawId;
      run.pagesWritten = result.pagesWritten;
      run.notification = run.notify
        ? { status: "pending", attempts: 0 }
        : undefined;
      this.pruneCompletedRuns(run.taskId, candidate);
      return clone(run);
    });
  }

  startApprovalNotificationAttempt(
    id: string,
    attemptedAt: number,
  ): TaskRun | undefined {
    const existing = this.runs.get(id);
    if (
      existing?.status !== "awaiting_approval"
      || existing.approval?.status !== "pending"
      || existing.approval.expiresAt === undefined
      || attemptedAt >= existing.approval.expiresAt
      || !existing.approvalNotification
      || existing.approvalNotification.status === "sent"
      || existing.approvalNotification.attempts >= MAX_TASK_NOTIFICATION_ATTEMPTS
      || (
        existing.approvalNotification.nextAttemptAt !== undefined
        && existing.approvalNotification.nextAttemptAt > attemptedAt
      )
    ) {
      return undefined;
    }
    return this.commit((candidate) => {
      const run = candidate.get(id)!;
      const attempts = run.approvalNotification!.attempts + 1;
      const retryDelay = TASK_NOTIFICATION_RETRY_DELAYS_MS[
        Math.min(attempts - 1, TASK_NOTIFICATION_RETRY_DELAYS_MS.length - 1)
      ]!;
      run.approvalNotification = {
        status: "pending",
        attempts,
        lastAttemptAt: attemptedAt,
        nextAttemptAt: attemptedAt + retryDelay,
      };
      return clone(run);
    });
  }

  approvalNotificationFailed(id: string, error: string): TaskRun | undefined {
    const existing = this.runs.get(id);
    if (!existing?.approvalNotification || existing.approvalNotification.status === "sent") {
      return undefined;
    }
    return this.commit((candidate) => {
      const run = candidate.get(id)!;
      run.approvalNotification!.status = "failed";
      run.approvalNotification!.error = error.slice(0, MAX_TASK_RUN_ERROR_CHARACTERS);
      return clone(run);
    });
  }

  approvalNotificationSent(id: string, sentAt: number): TaskRun | undefined {
    const existing = this.runs.get(id);
    if (!existing?.approvalNotification) return undefined;
    if (existing.approvalNotification.status === "sent") return clone(existing);
    return this.commit((candidate) => {
      const run = candidate.get(id)!;
      run.approvalNotification = {
        status: "sent",
        attempts: run.approvalNotification!.attempts,
        lastAttemptAt: run.approvalNotification!.lastAttemptAt,
        sentAt,
      };
      return clone(run);
    });
  }

  startNotificationAttempt(
    id: string,
    attemptedAt: number,
  ): TaskRun | undefined {
    const existing = this.runs.get(id);
    if (!existing || existing.status !== "succeeded" || !existing.notification) return undefined;
    return this.commit((candidate) => {
      const run = candidate.get(id)!;
      const attempts = run.notification!.attempts + 1;
      const retryDelay = TASK_NOTIFICATION_RETRY_DELAYS_MS[
        Math.min(attempts - 1, TASK_NOTIFICATION_RETRY_DELAYS_MS.length - 1)
      ]!;
      run.notification = {
        status: "pending",
        attempts,
        lastAttemptAt: attemptedAt,
        nextAttemptAt: attemptedAt + retryDelay,
      };
      return clone(run);
    });
  }

  notificationFailed(id: string, error: string): TaskRun | undefined {
    if (!this.runs.get(id)?.notification) return undefined;
    return this.commit((candidate) => {
      const run = candidate.get(id)!;
      run.notification!.status = "failed";
      run.notification!.error = error.slice(0, MAX_TASK_RUN_ERROR_CHARACTERS);
      return clone(run);
    });
  }

  notificationSent(id: string, sentAt: number): TaskRun | undefined {
    if (!this.runs.get(id)?.notification) return undefined;
    return this.commit((candidate) => {
      const run = candidate.get(id)!;
      run.notification = {
        status: "sent",
        attempts: run.notification!.attempts,
        lastAttemptAt: run.notification!.lastAttemptAt,
        sentAt,
      };
      return clone(run);
    });
  }

  private finishWithError(
    id: string,
    status: "failed" | "cancelled" | "timed_out",
    result: FinishTaskRunInput,
    defaultError: string,
  ): TaskRun | undefined {
    const existing = this.runs.get(id);
    const pendingCancellation = existing?.status === "awaiting_approval"
      && status === "cancelled";
    if (
      !existing
      || (
        !pendingCancellation
        && !["queued", "running"].includes(existing.status)
      )
    ) {
      return undefined;
    }
    validateFinishTaskRunInput(result);
    if (status !== "failed" && result.retry !== undefined) {
      throw new Error("Only a failed Task Run can be retried automatically");
    }
    if (status === "failed") validateAutomaticRetryFailure(existing, result);
    return this.commit((candidate) => {
      const run = candidate.get(id)!;
      const output = result.output;
      if (run.status !== "awaiting_approval" && run.status !== "queued") {
        run.runStartedAt ??= run.startedAt;
      }
      run.status = status;
      run.finishedAt = clampTerminalTime(run, result.finishedAt);
      run.error = (result.error ?? defaultError).slice(0, MAX_TASK_RUN_ERROR_CHARACTERS);
      run.failure = result.failure ? { ...result.failure } : undefined;
      run.retry = result.retry
        ? result.retry.status === "waiting"
          ? {
              ...result.retry,
              nextAttemptAt: run.finishedAt + AUTOMATIC_TASK_RUN_RETRY_DELAY_MS,
            }
          : { ...result.retry }
        : run.retry;
      run.usage = result.usage ? cloneAggregatedRunUsage(result.usage) : undefined;
      if (run.approval?.status === "pending") {
        run.approval = {
          status: "rejected",
          requestedAt: run.approval.requestedAt,
          expiresAt: run.approval.expiresAt,
          decidedAt: Math.max(run.finishedAt, run.approval.requestedAt),
          reason: run.error,
        };
      }
      run.output = output?.slice(0, MAX_TASK_RUN_OUTPUT_CHARACTERS);
      run.outputTruncated = output && output.length > MAX_TASK_RUN_OUTPUT_CHARACTERS
        ? true
        : undefined;
      run.rawId = result.rawId;
      run.pagesWritten = result.pagesWritten;
      this.pruneCompletedRuns(run.taskId, candidate);
      return clone(run);
    });
  }

  fail(id: string, result: FinishTaskRunInput): TaskRun | undefined {
    return this.finishWithError(id, "failed", result, "任务运行失败");
  }

  cancel(id: string, result: FinishTaskRunInput): TaskRun | undefined {
    return this.finishWithError(id, "cancelled", result, "任务已由用户取消");
  }

  timeout(id: string, result: FinishTaskRunInput): TaskRun | undefined {
    return this.finishWithError(id, "timed_out", result, "任务运行超时");
  }

  get(id: string): TaskRun | undefined {
    const run = this.runs.get(id);
    return run ? clone(run) : undefined;
  }

  has(id: string): boolean {
    return this.runs.has(id);
  }

  list(taskId?: string): TaskRun[] {
    return [...this.runs.values()]
      .filter((run) => !taskId || run.taskId === taskId)
      .sort((a, b) => b.startedAt - a.startedAt)
      .map(clone);
  }

  listDueRetries(now = Date.now()): TaskRun[] {
    if (!Number.isFinite(now) || now < 0) {
      throw new Error("Task Run retry time is invalid");
    }
    return [...this.runs.values()]
      .filter((run) => (
        run.status === "failed"
        && run.retry?.status === "waiting"
        && run.retry.nextAttemptAt !== undefined
        && run.retry.nextAttemptAt <= now
      ))
      .sort((left, right) =>
        left.retry!.nextAttemptAt! - right.retry!.nextAttemptAt!
        || left.id.localeCompare(right.id)
      )
      .map(clone);
  }

  /** Permanently stop a pending automatic retry without rewriting its failure audit. */
  exhaustRetry(id: string): TaskRun | undefined {
    const existing = this.runs.get(id);
    if (existing?.status !== "failed" || existing.retry?.status !== "waiting") {
      return undefined;
    }
    return this.commit((candidate) => {
      const run = candidate.get(id);
      if (run?.status !== "failed" || run.retry?.status !== "waiting") {
        return undefined;
      }
      run.retry = {
        attempt: run.retry.attempt,
        maxAttempts: run.retry.maxAttempts,
        status: "exhausted",
      };
      this.pruneCompletedRuns(run.taskId, candidate);
      return clone(run);
    });
  }

  /**
   * Claim a due retry and create its queued child in the same durable commit.
   * This is a fresh execution of the frozen plan, not a provider checkpoint.
   */
  claimRetry(id: string, claimedAt = Date.now()): TaskRun | undefined {
    if (!Number.isFinite(claimedAt) || claimedAt < 0) {
      throw new Error("Task Run retry claim time is invalid");
    }
    const existing = this.runs.get(id);
    if (
      existing?.status !== "failed"
      || existing.retry?.status !== "waiting"
      || existing.retry.nextAttemptAt === undefined
      || existing.retry.nextAttemptAt > claimedAt
      || existing.retry.attempt >= existing.retry.maxAttempts
      || existing.failure?.phase !== "provider"
      || !existing.failure.retryable
      || existing.output !== undefined
      || existing.rawId !== undefined
      || existing.executionPlan?.execution?.permission !== "read-only"
      || (existing.trigger !== "scheduled" && existing.trigger !== "retry")
    ) {
      return undefined;
    }
    return this.commit((candidate, state) => {
      const parent = candidate.get(id);
      if (
        parent?.status !== "failed"
        || parent.retry?.status !== "waiting"
        || parent.retry.nextAttemptAt === undefined
        || parent.retry.nextAttemptAt > claimedAt
      ) {
        return undefined;
      }
      const superseding = [...candidate.values()]
        .filter((run) => (
          run.id !== parent.id
          && run.taskId === parent.taskId
          && run.startedAt > parent.finishedAt!
        ))
        .sort((left, right) => right.startedAt - left.startedAt || right.id.localeCompare(left.id))[0];
      if (superseding) {
        parent.retry = {
          attempt: parent.retry.attempt,
          maxAttempts: parent.retry.maxAttempts,
          status: "claimed",
          claimedByRunId: superseding.id,
        };
        return undefined;
      }
      const startedAt = Math.max(claimedAt, state.lastStartedAt + 1);
      state.lastStartedAt = startedAt;
      const childId = `run_${randomUUID()}`;
      parent.retry = {
        attempt: parent.retry.attempt,
        maxAttempts: parent.retry.maxAttempts,
        status: "claimed",
        claimedByRunId: childId,
      };
      const child: TaskRun = {
        id: childId,
        taskId: parent.taskId,
        taskName: parent.taskName,
        space: parent.space,
        topic: parent.topic,
        trigger: "retry",
        workItemId: parent.workItemId,
        workActionId: parent.workActionId,
        agentId: parent.agentId,
        provider: parent.provider,
        model: parent.model,
        executionPlan: parent.executionPlan
          ? cloneResolvedExecutionPlan(parent.executionPlan)
          : undefined,
        skillEvidence: parent.skillEvidence
          ? {
              requested: parent.skillEvidence.requested.map((item) => ({ ...item })),
              resolved: parent.skillEvidence.resolved.map((item) => ({ ...item })),
              skipped: parent.skillEvidence.skipped.map((item) => ({ ...item })),
            }
          : undefined,
        retryOf: parent.id,
        distill: parent.distill,
        notify: parent.notify,
        timeoutMs: parent.timeoutMs,
        priority: parent.priority,
        status: "queued",
        queuedAt: startedAt,
        startedAt,
        retry: {
          attempt: parent.retry.attempt + 1,
          maxAttempts: parent.retry.maxAttempts,
          status: "claimed",
        },
      };
      candidate.set(child.id, child);
      return clone(child);
    });
  }

  approve(
    id: string,
    input: DecideTaskRunApprovalInput,
  ): TaskRun | undefined {
    const existing = this.runs.get(id);
    if (
      existing?.status !== "awaiting_approval"
      || existing.approval?.status !== "pending"
    ) {
      return undefined;
    }
    validateApprovalDecision(input, existing.approval.requestedAt);
    return this.commit((candidate) => {
      const run = candidate.get(id);
      if (
        run?.status !== "awaiting_approval"
        || run.approval?.status !== "pending"
      ) {
        return undefined;
      }
      if (
        run.approval.expiresAt !== undefined
        && input.decidedAt >= run.approval.expiresAt
      ) {
        const expiresAt = run.approval.expiresAt;
        run.status = "cancelled";
        run.finishedAt = clampTerminalTime(run, expiresAt);
        run.error = TASK_RUN_APPROVAL_EXPIRY_REASON;
        run.approval = {
          status: "expired",
          requestedAt: run.approval.requestedAt,
          expiresAt,
          decidedAt: expiresAt,
          decidedBy: TASK_RUN_APPROVAL_EXPIRY_ACTOR,
          reason: TASK_RUN_APPROVAL_EXPIRY_REASON,
        };
        this.pruneCompletedRuns(run.taskId, candidate);
        return undefined;
      }
      run.status = "queued";
      run.approval = {
        status: "approved",
        requestedAt: run.approval.requestedAt,
        expiresAt: run.approval.expiresAt,
        decidedAt: input.decidedAt,
        decidedBy: input.decidedBy,
        reason: input.reason,
      };
      return clone(run);
    });
  }

  reject(
    id: string,
    input: DecideTaskRunApprovalInput,
  ): TaskRun | undefined {
    const existing = this.runs.get(id);
    if (
      existing?.status !== "awaiting_approval"
      || existing.approval?.status !== "pending"
    ) {
      return undefined;
    }
    validateApprovalDecision(input, existing.approval.requestedAt);
    return this.commit((candidate) => {
      const run = candidate.get(id);
      if (
        run?.status !== "awaiting_approval"
        || run.approval?.status !== "pending"
      ) {
        return undefined;
      }
      if (
        run.approval.expiresAt !== undefined
        && input.decidedAt >= run.approval.expiresAt
      ) {
        const expiresAt = run.approval.expiresAt;
        run.status = "cancelled";
        run.finishedAt = clampTerminalTime(run, expiresAt);
        run.error = TASK_RUN_APPROVAL_EXPIRY_REASON;
        run.approval = {
          status: "expired",
          requestedAt: run.approval.requestedAt,
          expiresAt,
          decidedAt: expiresAt,
          decidedBy: TASK_RUN_APPROVAL_EXPIRY_ACTOR,
          reason: TASK_RUN_APPROVAL_EXPIRY_REASON,
        };
        this.pruneCompletedRuns(run.taskId, candidate);
        return undefined;
      }
      const reason = input.reason ?? "Task run approval was rejected";
      run.status = "cancelled";
      run.finishedAt = clampTerminalTime(run, input.decidedAt);
      run.error = reason;
      run.approval = {
        status: "rejected",
        requestedAt: run.approval!.requestedAt,
        expiresAt: run.approval!.expiresAt,
        decidedAt: input.decidedAt,
        decidedBy: input.decidedBy,
        reason: input.reason,
      };
      this.pruneCompletedRuns(run.taskId, candidate);
      return clone(run);
    });
  }

  expireApprovals(now = Date.now()): TaskRun[] {
    if (!Number.isFinite(now) || now < 0) {
      throw new Error("Task approval expiry time is invalid");
    }
    const due = [...this.runs.values()].filter((run) =>
      run.status === "awaiting_approval"
      && run.approval?.status === "pending"
      && run.approval.expiresAt !== undefined
      && run.approval.expiresAt <= now
    );
    if (due.length === 0) return [];
    return this.commit((candidate) => {
      const expired: TaskRun[] = [];
      const affectedTaskIds = new Set<string>();
      for (const current of due) {
        const run = candidate.get(current.id);
        if (
          run?.status !== "awaiting_approval"
          || run.approval?.status !== "pending"
          || run.approval.expiresAt === undefined
          || run.approval.expiresAt > now
        ) {
          continue;
        }
        const expiresAt = run.approval.expiresAt;
        run.status = "cancelled";
        run.finishedAt = clampTerminalTime(run, expiresAt);
        run.error = TASK_RUN_APPROVAL_EXPIRY_REASON;
        run.approval = {
          status: "expired",
          requestedAt: run.approval.requestedAt,
          expiresAt,
          decidedAt: expiresAt,
          decidedBy: TASK_RUN_APPROVAL_EXPIRY_ACTOR,
          reason: TASK_RUN_APPROVAL_EXPIRY_REASON,
        };
        affectedTaskIds.add(run.taskId);
        expired.push(clone(run));
      }
      for (const taskId of affectedTaskIds) this.pruneCompletedRuns(taskId, candidate);
      return expired.sort((left, right) =>
        left.finishedAt! - right.finishedAt! || left.id.localeCompare(right.id)
      );
    });
  }

  begin(id: string, runStartedAt = Date.now()): TaskRun | undefined {
    if (this.runs.get(id)?.status !== "queued") return undefined;
    return this.commit((candidate) => {
      const run = candidate.get(id)!;
      run.status = "running";
      run.runStartedAt = Math.max(
        runStartedAt,
        run.queuedAt,
        run.approval?.decidedAt ?? 0,
      );
      return clone(run);
    });
  }

  listByAgent(agentId: string, limit = 20): TaskRun[] {
    const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit) || 20));
    return [...this.runs.values()]
      .filter((run) => run.agentId === agentId)
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, boundedLimit)
      .map(clone);
  }

  listNeedingNotification(now = Date.now()): TaskRun[] {
    return [...this.runs.values()]
      .filter((run) => (
        run.status === "succeeded"
        && run.notification !== undefined
        && run.notification.status !== "sent"
        && run.notification.attempts < MAX_TASK_NOTIFICATION_ATTEMPTS
        && (
          run.notification.nextAttemptAt === undefined
          || run.notification.nextAttemptAt <= now
        )
      ))
      .sort((a, b) => a.startedAt - b.startedAt)
      .map(clone);
  }

  listNeedingApprovalNotification(now = Date.now()): TaskRun[] {
    return [...this.runs.values()]
      .filter((run) => (
        run.status === "awaiting_approval"
        && run.approval?.status === "pending"
        && run.approval.expiresAt !== undefined
        && run.approval.expiresAt > now
        && run.approvalNotification !== undefined
        && run.approvalNotification.status !== "sent"
        && run.approvalNotification.attempts < MAX_TASK_NOTIFICATION_ATTEMPTS
        && (
          run.approvalNotification.nextAttemptAt === undefined
          || run.approvalNotification.nextAttemptAt <= now
        )
      ))
      .sort((left, right) => left.startedAt - right.startedAt || left.id.localeCompare(right.id))
      .map(clone);
  }

  restore(runs: TaskRun[]): TaskRun[] {
    const incomingIds = new Set<string>();
    for (const run of runs) {
      if (!isTaskRun(run)) throw new Error("invalid task run");
      if (this.runs.has(run.id) || incomingIds.has(run.id)) {
        throw new Error(`task run id already exists: ${run.id}`);
      }
      if (
        run.status === "awaiting_approval"
        || run.status === "queued"
        || run.status === "running"
        || run.retry?.status === "waiting"
      ) {
        throw new Error(`cannot restore an active task run (including waiting retry): ${run.id}`);
      }
      incomingIds.add(run.id);
    }
    if (runs.length === 0) return [];
    return this.commit((candidate, state) => {
      const restored = [...runs]
        .sort((a, b) => a.startedAt - b.startedAt)
        .map(clone);
      for (const run of restored) {
        candidate.set(run.id, run);
        state.lastStartedAt = Math.max(state.lastStartedAt, run.startedAt);
      }
      for (const taskId of new Set(restored.map((run) => run.taskId))) {
        this.pruneCompletedRuns(taskId, candidate);
      }
      return restored.map(clone);
    });
  }

  remove(id: string): boolean {
    if (!this.runs.has(id)) return false;
    return this.commit((candidate) => candidate.delete(id));
  }

  removeByTask(taskId: string): number {
    const removed = [...this.runs.values()].filter((run) => run.taskId === taskId).length;
    if (removed === 0) return 0;
    return this.commit((candidate) => {
      for (const [id, run] of candidate) {
        if (run.taskId === taskId) candidate.delete(id);
      }
      return removed;
    });
  }

  removeBySpace(space: SpaceId): number {
    const removed = [...this.runs.values()].filter((run) => run.space === space).length;
    if (removed === 0) return 0;
    return this.commit((candidate) => {
      for (const [id, run] of candidate) {
        if (run.space === space) candidate.delete(id);
      }
      return removed;
    });
  }
}
