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
import { isSpaceId, type SpaceId } from "@homeagent/shared";
import type { Task } from "./tasks.ts";
import { durableFsyncSync, durableRenameSync } from "./durable-file.ts";

export type TaskRunStatus = "running" | "succeeded" | "failed" | "cancelled" | "timed_out";
export type TaskRunTrigger = "manual" | "scheduled" | "chat" | "retry";
export type TaskRunNotificationStatus = "pending" | "sent" | "failed";

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
  topic: string;
  trigger: TaskRunTrigger;
  retryOf?: string;
  distill: boolean;
  notify?: boolean;
  timeoutMs?: number;
  status: TaskRunStatus;
  startedAt: number;
  finishedAt?: number;
  output?: string;
  outputTruncated?: boolean;
  summary?: string;
  error?: string;
  rawId?: string;
  pagesWritten?: number;
  notification?: TaskRunNotification;
}

interface TaskRunsFile {
  version: 2;
  runs: Record<string, TaskRun>;
}

export interface StartTaskRunInput {
  task: Task;
  trigger: TaskRunTrigger;
  retryOf?: string;
  distill: boolean;
  timeoutMs?: number;
  startedAt?: number;
}

export interface FinishTaskRunInput {
  finishedAt: number;
  output?: string;
  summary?: string;
  error?: string;
  rawId?: string;
  pagesWritten?: number;
}

export interface TaskRunStoreOptions {
  recoverInterrupted?: boolean;
}

export const MAX_TASK_RUN_OUTPUT_CHARACTERS = 100_000;
export const MAX_TASK_RUN_ERROR_CHARACTERS = 20_000;
export const MAX_TASK_RUN_HISTORY_PER_TASK = 100;
export const MAX_TASK_NOTIFICATION_ATTEMPTS = 5;
const TASK_NOTIFICATION_RETRY_DELAYS_MS = [
  60_000,
  5 * 60_000,
  30 * 60_000,
  2 * 60 * 60_000,
  6 * 60 * 60_000,
] as const;
const INTERRUPTED_RUN_ERROR = "应用在任务完成前停止，运行已标记为失败";

function clone(run: TaskRun): TaskRun {
  return {
    ...run,
    notification: run.notification ? { ...run.notification } : undefined,
  };
}

function isTaskRun(value: unknown): value is TaskRun {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const run = value as Partial<TaskRun>;
  const optionalStrings = [
    run.retryOf,
    run.output,
    run.summary,
    run.error,
    run.rawId,
  ].every((item) => item === undefined || typeof item === "string");
  const optionalNumbers = [run.finishedAt, run.pagesWritten, run.timeoutMs].every(
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
  return (
    typeof run.id === "string"
    && typeof run.taskId === "string"
    && typeof run.taskName === "string"
    && typeof run.space === "string"
    && isSpaceId(run.space)
    && typeof run.topic === "string"
    && ["manual", "scheduled", "chat", "retry"].includes(String(run.trigger))
    && typeof run.distill === "boolean"
    && (run.notify === undefined || typeof run.notify === "boolean")
    && ["running", "succeeded", "failed", "cancelled", "timed_out"].includes(String(run.status))
    && typeof run.startedAt === "number"
    && Number.isFinite(run.startedAt)
    && optionalStrings
    && optionalNumbers
    && validNotification
    && (run.notification === undefined || run.status === "succeeded")
    && (run.notification === undefined || run.notify !== false)
    && (run.outputTruncated === undefined || typeof run.outputTruncated === "boolean")
    && (run.status === "running" || typeof run.finishedAt === "number")
    && (
      !["failed", "cancelled", "timed_out"].includes(String(run.status))
      || typeof run.error === "string"
    )
    && (run.finishedAt === undefined || run.finishedAt >= run.startedAt)
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
    try {
      const parsed = JSON.parse(readFileSync(this.configPath, "utf8")) as Partial<TaskRunsFile>;
      for (const [id, value] of Object.entries(parsed.runs ?? {})) {
        if (!isTaskRun(value) || value.id !== id) continue;
        runs.set(id, clone(value));
      }
    } catch {
      // Corrupt history must not prevent the application from starting.
    }
    return runs;
  }

  private persist(runs = this.runs): void {
    const configDir = dirname(this.configPath);
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    const tempPath = `${this.configPath}.${process.pid}.${randomUUID()}.tmp`;
    const file: TaskRunsFile = { version: 2, runs: Object.fromEntries(runs) };
    try {
      writeFileSync(tempPath, JSON.stringify(file, null, 2), { encoding: "utf8", mode: 0o600 });
      const fileDescriptor = openSync(tempPath, "r");
      try {
        durableFsyncSync(fileDescriptor);
      } finally {
        closeSync(fileDescriptor);
      }
      durableRenameSync(tempPath, this.configPath);
      const directoryDescriptor = openSync(configDir, "r");
      try {
        durableFsyncSync(directoryDescriptor);
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
        run.finishedAt = Math.max(now, run.startedAt);
        run.error = INTERRUPTED_RUN_ERROR;
        affectedTaskIds.add(run.taskId);
      }
      for (const taskId of affectedTaskIds) this.pruneCompletedRuns(taskId, candidate);
    });
  }

  private pruneCompletedRuns(taskId: string, runs = this.runs): void {
    const completed = [...runs.values()].filter(
      (run) => run.taskId === taskId && run.status !== "running",
    );
    const excess = completed.length - MAX_TASK_RUN_HISTORY_PER_TASK;
    if (excess <= 0) return;
    for (const run of completed.slice(0, excess)) runs.delete(run.id);
  }

  start(input: StartTaskRunInput): TaskRun {
    return this.commit((candidate, state) => {
      const requestedStartedAt = input.startedAt ?? Date.now();
      const startedAt = Math.max(requestedStartedAt, state.lastStartedAt + 1);
      state.lastStartedAt = startedAt;
      const run: TaskRun = {
        id: `run_${randomUUID()}`,
        taskId: input.task.id,
        taskName: input.task.name,
        space: input.task.space,
        topic: input.task.topic,
        trigger: input.trigger,
        retryOf: input.retryOf,
        distill: input.distill,
        notify: input.task.notify,
        timeoutMs: input.timeoutMs,
        status: "running",
        startedAt,
      };
      candidate.set(run.id, run);
      return clone(run);
    });
  }

  succeed(id: string, result: FinishTaskRunInput): TaskRun | undefined {
    if (!this.runs.has(id)) return undefined;
    return this.commit((candidate) => {
      const run = candidate.get(id)!;
      const output = result.output ?? "";
      run.status = "succeeded";
      run.finishedAt = result.finishedAt;
      run.output = output.slice(0, MAX_TASK_RUN_OUTPUT_CHARACTERS);
      run.outputTruncated = output.length > MAX_TASK_RUN_OUTPUT_CHARACTERS || undefined;
      run.summary = result.summary;
      run.error = undefined;
      run.rawId = result.rawId;
      run.pagesWritten = result.pagesWritten;
      run.notification = run.notify
        ? { status: "pending", attempts: 0 }
        : undefined;
      this.pruneCompletedRuns(run.taskId, candidate);
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
    if (!this.runs.has(id)) return undefined;
    return this.commit((candidate) => {
      const run = candidate.get(id)!;
      const output = result.output;
      run.status = status;
      run.finishedAt = result.finishedAt;
      run.error = (result.error ?? defaultError).slice(0, MAX_TASK_RUN_ERROR_CHARACTERS);
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

  restore(runs: TaskRun[]): TaskRun[] {
    const incomingIds = new Set<string>();
    for (const run of runs) {
      if (this.runs.has(run.id) || incomingIds.has(run.id)) {
        throw new Error(`task run id already exists: ${run.id}`);
      }
      if (run.status === "running") throw new Error(`cannot restore a running task run: ${run.id}`);
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
