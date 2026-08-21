/**
 * Task store (management backend, task-execution platform). A "task" is a
 * recurring or on-demand unit of work run by a space's agent CLI. The first
 * task type is topic research: periodically ask the space's CLI agent to
 * research a topic, capture the result as raw material (source "task") in that
 * space (the dream cycle later distills it into wiki pages), and optionally push
 * a summary to the bound feishu chat.
 *
 * Persisted to data/config/tasks.json through a temporary file + fsync + atomic
 * rename so a process crash cannot expose a partially written task registry.
 */
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SpaceId } from "@homeagent/shared";
import { isSpaceId } from "@homeagent/shared";
import { durableFsyncSync, durableRenameSync } from "./durable-file.ts";

/** How often a task runs. */
export type TaskCadence = "hourly" | "daily" | "weekly";
export const TASK_CADENCES: TaskCadence[] = ["hourly", "daily", "weekly"];
export const DEFAULT_TASK_TIMEOUT_MINUTES = 12;
export const MIN_TASK_TIMEOUT_MINUTES = 1;
export const MAX_TASK_TIMEOUT_MINUTES = 60;

/** Outcome of the last run, for display + scheduling. */
export type TaskStatus = "ok" | "error";

/** A configurable, agent-run task. Today only kind "research" exists. */
export interface Task {
  id: string;
  name: string;
  /** space the result is written to (also the source of the agent/CLI) */
  space: SpaceId;
  /** research topic / prompt handed to the agent */
  topic: string;
  cadence: TaskCadence;
  /** local hour (0-23, Asia/Shanghai) for daily and weekly cadences */
  hour: number;
  /** ISO weekday (1=Monday ... 7=Sunday) for weekly cadence */
  dayOfWeek: number;
  /** whether the scheduler runs it automatically */
  enabled: boolean;
  /** push a summary to the space's bound feishu chat on completion */
  notify: boolean;
  /** distill the captured output into wiki pages right after the run (default true) */
  distillOnRun: boolean;
  /** hard execution limit; the provider process is terminated when exceeded */
  timeoutMinutes: number;
  /** epoch ms of the last run (any outcome) */
  lastRunAt?: number;
  lastStatus?: TaskStatus;
  lastError?: string;
  /** short preview of the last successful output */
  lastSummary?: string;
  createdAt: number;
  updatedAt: number;
}

/** Fields a caller may set when creating/updating a task. */
export interface TaskInput {
  name?: string;
  space?: string;
  topic?: string;
  cadence?: string;
  hour?: number;
  dayOfWeek?: number;
  enabled?: boolean;
  notify?: boolean;
  distillOnRun?: boolean;
  timeoutMinutes?: number;
}

/** Patch applied after a run to record its outcome. */
export interface TaskRunResult {
  at: number;
  status: TaskStatus;
  summary?: string;
  error?: string;
}

interface TasksFile {
  tasks: Record<string, Task>;
}

function normalizeCadence(raw?: string): TaskCadence {
  const v = raw?.trim() as TaskCadence | undefined;
  return v && TASK_CADENCES.includes(v) ? v : "daily";
}

function normalizeHour(raw?: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 8;
  return Math.max(0, Math.min(23, Math.trunc(raw)));
}

function normalizeDayOfWeek(raw?: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 1;
  return Math.max(1, Math.min(7, Math.trunc(raw)));
}

function normalizeTimeoutMinutes(raw?: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_TASK_TIMEOUT_MINUTES;
  return Math.max(
    MIN_TASK_TIMEOUT_MINUTES,
    Math.min(MAX_TASK_TIMEOUT_MINUTES, Math.trunc(raw)),
  );
}

export class TaskStore {
  private configPath: string;
  private tasks: Map<string, Task>;

  constructor(dataDir: string) {
    this.configPath = join(dataDir, "config", "tasks.json");
    this.tasks = this.load();
  }

  private load(): Map<string, Task> {
    const map = new Map<string, Task>();
    if (existsSync(this.configPath)) {
      try {
        const parsed = JSON.parse(readFileSync(this.configPath, "utf8")) as TasksFile;
        for (const [id, t] of Object.entries(parsed.tasks ?? {})) {
          if (t && typeof t.id === "string" && isSpaceId(t.space)) {
            // Backfill for older records written before distillOnRun existed.
            if (typeof t.distillOnRun !== "boolean") t.distillOnRun = true;
            if (typeof t.timeoutMinutes !== "number") {
              t.timeoutMinutes = DEFAULT_TASK_TIMEOUT_MINUTES;
            } else {
              t.timeoutMinutes = normalizeTimeoutMinutes(t.timeoutMinutes);
            }
            // Backfill for records written before weekly scheduling existed.
            t.dayOfWeek = normalizeDayOfWeek(t.dayOfWeek);
            map.set(id, t);
          }
        }
      } catch {
        // corrupt file: start empty rather than crash the backend
      }
    }
    return map;
  }

  private persist(tasks = this.tasks): void {
    const configDir = dirname(this.configPath);
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.configPath}.${process.pid}.${randomUUID()}.tmp`;
    const obj: TasksFile = { tasks: Object.fromEntries(tasks) };
    try {
      writeFileSync(temporaryPath, JSON.stringify(obj, null, 2), {
        encoding: "utf8",
        mode: 0o600,
      });
      const fileDescriptor = openSync(temporaryPath, "r+");
      try {
        durableFsyncSync(fileDescriptor);
      } finally {
        closeSync(fileDescriptor);
      }
      durableRenameSync(temporaryPath, this.configPath);
      const directoryDescriptor = openSync(configDir, "r");
      try {
        durableFsyncSync(directoryDescriptor, {
          allowUnsupportedDirectoryOnWindows: true,
        });
      } finally {
        closeSync(directoryDescriptor);
      }
    } catch (error) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // A successful rename consumes the temporary path.
      }
      throw error;
    }
  }

  private commit<T>(change: (candidate: Map<string, Task>) => T): T {
    const candidate = new Map(
      [...this.tasks].map(([id, task]) => [id, { ...task }]),
    );
    const result = change(candidate);
    this.persist(candidate);
    this.tasks = candidate;
    return result;
  }

  list(): Task[] {
    return [...this.tasks.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  has(id: string): boolean {
    return this.tasks.has(id);
  }

  /** Create a task. Requires a valid space; returns undefined if space is invalid. */
  create(input: TaskInput): Task | undefined {
    const space = input.space?.trim();
    if (!space || !isSpaceId(space)) return undefined;
    const now = Date.now();
    const task: Task = {
      id: `task_${randomUUID()}`,
      name: input.name?.trim() || "未命名任务",
      space,
      topic: input.topic?.trim() ?? "",
      cadence: normalizeCadence(input.cadence),
      hour: normalizeHour(input.hour),
      dayOfWeek: normalizeDayOfWeek(input.dayOfWeek),
      enabled: input.enabled ?? true,
      notify: input.notify ?? true,
      distillOnRun: input.distillOnRun ?? true,
      timeoutMinutes: normalizeTimeoutMinutes(input.timeoutMinutes),
      createdAt: now,
      updatedAt: now,
    };
    return this.commit((candidate) => {
      candidate.set(task.id, task);
      return task;
    });
  }

  /** Patch an existing task. Only provided fields change. Returns undefined if absent. */
  update(id: string, input: TaskInput): Task | undefined {
    if (!this.tasks.has(id)) return undefined;
    return this.commit((candidate) => {
      const task = candidate.get(id)!;
      if (input.name !== undefined) task.name = input.name.trim() || task.name;
      if (input.space !== undefined && isSpaceId(input.space.trim())) {
        task.space = input.space.trim() as SpaceId;
      }
      if (input.topic !== undefined) task.topic = input.topic.trim();
      if (input.cadence !== undefined) task.cadence = normalizeCadence(input.cadence);
      if (input.hour !== undefined) task.hour = normalizeHour(input.hour);
      if (input.dayOfWeek !== undefined) {
        task.dayOfWeek = normalizeDayOfWeek(input.dayOfWeek);
      }
      if (input.enabled !== undefined) task.enabled = input.enabled;
      if (input.notify !== undefined) task.notify = input.notify;
      if (input.distillOnRun !== undefined) task.distillOnRun = input.distillOnRun;
      if (input.timeoutMinutes !== undefined) {
        task.timeoutMinutes = normalizeTimeoutMinutes(input.timeoutMinutes);
      }
      task.updatedAt = Date.now();
      return task;
    });
  }

  /** Record the outcome of a run (for display + scheduling). */
  setLastRun(id: string, result: TaskRunResult): void {
    if (!this.tasks.has(id)) return;
    this.commit((candidate) => {
      const task = candidate.get(id)!;
      task.lastRunAt = result.at;
      task.lastStatus = result.status;
      task.lastSummary = result.status === "ok" ? result.summary : task.lastSummary;
      task.lastError = result.status === "error" ? result.error : undefined;
    });
  }

  remove(id: string): boolean {
    if (!this.tasks.has(id)) return false;
    return this.commit((candidate) => candidate.delete(id));
  }

  /** Restore exact archived task records after archive-level validation. */
  restore(tasks: Task[]): Task[] {
    const incomingIds = new Set<string>();
    for (const task of tasks) {
      if (!isSpaceId(task.space)) throw new Error(`invalid task space: ${task.space}`);
      if (this.tasks.has(task.id) || incomingIds.has(task.id)) {
        throw new Error(`task id already exists: ${task.id}`);
      }
      incomingIds.add(task.id);
    }
    if (tasks.length === 0) return [];
    return this.commit((candidate) => {
      const restored = tasks.map((task) => ({ ...task }));
      for (const task of restored) candidate.set(task.id, task);
      return restored;
    });
  }

  removeBySpace(space: SpaceId): number {
    const removed = [...this.tasks.values()].filter((task) => task.space === space).length;
    if (removed === 0) return 0;
    return this.commit((candidate) => {
      for (const [id, task] of candidate) {
        if (task.space === space) candidate.delete(id);
      }
      return removed;
    });
  }
}
