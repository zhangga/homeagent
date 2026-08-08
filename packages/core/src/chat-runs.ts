import { randomUUID } from "node:crypto";
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
import {
  CODEX_REASONING_EFFORTS,
  type CodexReasoningEffort,
  type ProviderExecution,
  type ProviderId,
} from "@homeagent/llm";
import { isSpaceId, type SpaceId } from "@homeagent/shared";
import { durableFsyncSync, durableRenameSync } from "./durable-file.ts";
import {
  MAX_TASK_RUN_SKILLS,
  isTaskRunSkillEvidence,
  type TaskRunSkillEvidence,
} from "./task-runs.ts";
import type { RunPriority } from "./run-scheduler.ts";

export type ChatRunTrigger = "message" | "retry";
export type ChatRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out";
export type ChatRunDeliveryStatus = "pending" | "sent" | "failed";
export type ChatRunErrorKind =
  | "interrupted"
  | "cancelled"
  | "timeout"
  | "authentication"
  | "provider_unavailable"
  | "process_exit"
  | "unknown";

export interface ChatRunError {
  kind: ChatRunErrorKind;
  message: string;
}

export interface ChatRunDelivery {
  status: ChatRunDeliveryStatus;
  attempts: number;
  lastAttemptAt?: number;
  sentAt?: number;
  error?: string;
}

export interface ChatRun {
  id: string;
  space: SpaceId;
  rawId?: string;
  chatId?: string;
  messageId?: string;
  author?: string;
  input: string;
  inputTruncated?: boolean;
  trigger: ChatRunTrigger;
  agentId?: string;
  provider?: ProviderId;
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
  skillEvidence?: TaskRunSkillEvidence;
  execution?: ProviderExecution;
  retryOf?: string;
  priority: RunPriority;
  status: ChatRunStatus;
  delivery: ChatRunDelivery;
  queuedAt: number;
  startedAt: number;
  runStartedAt?: number;
  finishedAt?: number;
  output?: string;
  outputTruncated?: boolean;
  traceId?: string;
  error?: ChatRunError;
}

export interface StartChatRunInput {
  space: SpaceId;
  rawId?: string;
  chatId?: string;
  messageId?: string;
  author?: string;
  input: string;
  trigger: ChatRunTrigger;
  agentId?: string;
  provider?: ProviderId;
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
  skillEvidence?: TaskRunSkillEvidence;
  execution?: ProviderExecution;
  retryOf?: string;
  priority?: RunPriority;
  startedAt?: number;
}

export interface ChatRunStoreOptions {
  recoverInterrupted?: boolean;
}

export interface FinishChatRunSuccessInput {
  finishedAt: number;
  output: string;
  traceId?: string;
}

export interface FinishChatRunFailureInput {
  finishedAt: number;
  error: ChatRunError;
}

interface ChatRunsFile {
  version: 1 | 2;
  runs: Record<string, ChatRun>;
}

export const MAX_CHAT_RUN_OUTPUT_CHARACTERS = 100_000;
export const MAX_CHAT_RUN_INPUT_CHARACTERS = 100_000;
export const MAX_CHAT_RUN_ERROR_CHARACTERS = 20_000;
export const MAX_CHAT_RUN_HISTORY_PER_AGENT = 100;

function clone(run: ChatRun): ChatRun {
  return {
    ...run,
    skillEvidence: run.skillEvidence
      ? {
          requested: run.skillEvidence.requested.map((item) => ({ ...item })),
          resolved: run.skillEvidence.resolved.map((item) => ({ ...item })),
          skipped: run.skillEvidence.skipped.map((item) => ({ ...item })),
        }
      : undefined,
    execution: run.execution
      ? { ...run.execution, skills: [...run.execution.skills] }
      : undefined,
    delivery: { ...run.delivery },
    error: run.error ? { ...run.error } : undefined,
  };
}

function isProviderId(value: unknown): value is ProviderId {
  return ["gateway", "claude", "codex", "trae-cli"].includes(String(value));
}

function isRunPriority(value: unknown): value is RunPriority {
  return ["interactive", "manual", "scheduled", "background"].includes(String(value));
}

function isExecution(value: unknown): value is ProviderExecution {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const execution = value as Partial<ProviderExecution>;
  return (
    execution.permission === "read-only"
    && Array.isArray(execution.skills)
    && execution.skills.length <= MAX_TASK_RUN_SKILLS
    && execution.skills.every((skill) =>
      typeof skill === "string"
      && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/.test(skill)
    )
    && execution.workdir === undefined
    && (execution.webSearch === undefined || typeof execution.webSearch === "boolean")
  );
}

export function isChatRun(value: unknown): value is ChatRun {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const run = value as Partial<ChatRun>;
  const delivery = run.delivery;
  return (
    typeof run.id === "string"
    && typeof run.space === "string"
    && isSpaceId(run.space)
    && typeof run.input === "string"
    && run.input.length <= MAX_CHAT_RUN_INPUT_CHARACTERS
    && (run.inputTruncated === undefined || typeof run.inputTruncated === "boolean")
    && ["message", "retry"].includes(String(run.trigger))
    && ["queued", "running", "succeeded", "failed", "cancelled", "timed_out"]
      .includes(String(run.status))
    && isRunPriority(run.priority)
    && typeof run.queuedAt === "number"
    && Number.isFinite(run.queuedAt)
    && typeof run.startedAt === "number"
    && Number.isFinite(run.startedAt)
    && run.queuedAt === run.startedAt
    && (run.runStartedAt === undefined
      || (typeof run.runStartedAt === "number"
        && Number.isFinite(run.runStartedAt)
        && run.runStartedAt >= run.queuedAt))
    && (run.finishedAt === undefined
      || (typeof run.finishedAt === "number"
        && Number.isFinite(run.finishedAt)
        && run.finishedAt >= (run.runStartedAt ?? run.startedAt)))
    && [run.rawId, run.chatId, run.messageId, run.author, run.agentId, run.model, run.retryOf]
      .every((item) => item === undefined || typeof item === "string")
    && [run.output, run.traceId]
      .every((item) => item === undefined || typeof item === "string")
    && (run.output === undefined || run.output.length <= MAX_CHAT_RUN_OUTPUT_CHARACTERS)
    && (run.outputTruncated === undefined || typeof run.outputTruncated === "boolean")
    && (run.provider === undefined || isProviderId(run.provider))
    && (run.reasoningEffort === undefined
      || CODEX_REASONING_EFFORTS.includes(run.reasoningEffort))
    && (run.skillEvidence === undefined || isTaskRunSkillEvidence(run.skillEvidence))
    && (run.execution === undefined || isExecution(run.execution))
    && (run.error === undefined || (
      typeof run.error === "object"
      && !Array.isArray(run.error)
      && [
        "interrupted",
        "cancelled",
        "timeout",
        "authentication",
        "provider_unavailable",
        "process_exit",
        "unknown",
      ].includes(String(run.error.kind))
      && typeof run.error.message === "string"
      && run.error.message.length <= MAX_CHAT_RUN_ERROR_CHARACTERS
    ))
    && delivery !== undefined
    && typeof delivery === "object"
    && !Array.isArray(delivery)
    && ["pending", "sent", "failed"].includes(String(delivery.status))
    && Number.isInteger(delivery.attempts)
    && delivery.attempts >= 0
    && [delivery.lastAttemptAt, delivery.sentAt]
      .every((item) => item === undefined
        || (typeof item === "number" && Number.isFinite(item)))
    && (delivery.error === undefined || typeof delivery.error === "string")
    && (delivery.error === undefined
      || delivery.error.length <= MAX_CHAT_RUN_ERROR_CHARACTERS)
    && (
      run.status === "queued"
      || run.status === "running"
      || typeof run.finishedAt === "number"
    )
    && (run.status !== "running" || typeof run.runStartedAt === "number")
    && (
      !["failed", "cancelled", "timed_out"].includes(String(run.status))
      || run.error !== undefined
    )
    && (delivery.status !== "sent" || typeof delivery.sentAt === "number")
    && (delivery.status !== "failed" || typeof delivery.error === "string")
  );
}

export class ChatRunStore {
  private readonly configPath: string;
  private runs: Map<string, ChatRun>;
  private lastStartedAt: number;

  constructor(dataDir: string, opts: ChatRunStoreOptions = {}) {
    this.configPath = join(dataDir, "config", "chat-runs.json");
    this.runs = this.load();
    this.lastStartedAt = 0;
    for (const run of this.runs.values()) {
      this.lastStartedAt = Math.max(this.lastStartedAt, run.startedAt);
    }
    if (opts.recoverInterrupted) this.recoverInterruptedRuns();
  }

  private load(): Map<string, ChatRun> {
    const runs = new Map<string, ChatRun>();
    if (!existsSync(this.configPath)) return runs;
    try {
      const parsed = JSON.parse(readFileSync(this.configPath, "utf8")) as Partial<ChatRunsFile>;
      if (parsed.version !== 1 && parsed.version !== 2) return runs;
      for (const [id, value] of Object.entries(parsed.runs ?? {})) {
        const legacy = value as Partial<ChatRun>;
        const normalized = parsed.version === 1
          ? {
              ...legacy,
              priority: "interactive",
              queuedAt: legacy.startedAt,
              runStartedAt: legacy.status === "queued" ? undefined : legacy.startedAt,
            }
          : legacy;
        if (!isChatRun(normalized) || normalized.id !== id) continue;
        runs.set(id, clone(normalized));
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
    const file: ChatRunsFile = { version: 2, runs: Object.fromEntries(runs) };
    try {
      writeFileSync(tempPath, JSON.stringify(file, null, 2), {
        encoding: "utf8",
        mode: 0o600,
      });
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
    change: (candidate: Map<string, ChatRun>, state: { lastStartedAt: number }) => T,
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
    if (![...this.runs.values()].some((run) => run.status === "running")) return;
    this.commit((candidate) => {
      for (const run of candidate.values()) {
        if (run.status !== "running") continue;
        run.status = "failed";
        run.finishedAt = Math.max(now, run.runStartedAt ?? run.startedAt);
        run.error = {
          kind: "interrupted",
          message: "The application stopped before the chat response completed.",
        };
      }
      this.pruneCompletedRuns(candidate);
    });
  }

  private pruneCompletedRuns(runs = this.runs): void {
    const completedByOwner = new Map<string, ChatRun[]>();
    for (const run of runs.values()) {
      if (run.status === "queued" || run.status === "running") continue;
      const owner = run.agentId ? `agent:${run.agentId}` : `space:${run.space}`;
      const completed = completedByOwner.get(owner) ?? [];
      completed.push(run);
      completedByOwner.set(owner, completed);
    }
    for (const completed of completedByOwner.values()) {
      completed.sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
      const excess = completed.length - MAX_CHAT_RUN_HISTORY_PER_AGENT;
      for (let index = 0; index < excess; index += 1) {
        runs.delete(completed[index]!.id);
      }
    }
  }

  start(input: StartChatRunInput): ChatRun {
    if (input.skillEvidence !== undefined && !isTaskRunSkillEvidence(input.skillEvidence)) {
      throw new Error("Skill evidence is invalid or exceeds persistence limits");
    }
    if (input.execution !== undefined && !isExecution(input.execution)) {
      throw new Error("Chat execution snapshot is invalid");
    }
    return this.commit((candidate, state) => {
      const requestedStartedAt = input.startedAt ?? Date.now();
      const startedAt = Math.max(requestedStartedAt, state.lastStartedAt + 1);
      state.lastStartedAt = startedAt;
      const run: ChatRun = {
        ...input,
        id: `chat_run_${randomUUID()}`,
        input: input.input.slice(0, MAX_CHAT_RUN_INPUT_CHARACTERS),
        inputTruncated:
          input.input.length > MAX_CHAT_RUN_INPUT_CHARACTERS || undefined,
        skillEvidence: input.skillEvidence
          ? {
              requested: input.skillEvidence.requested.map((item) => ({ ...item })),
              resolved: input.skillEvidence.resolved.map((item) => ({ ...item })),
              skipped: input.skillEvidence.skipped.map((item) => ({ ...item })),
            }
          : undefined,
        execution: input.execution
          ? { ...input.execution, skills: [...input.execution.skills] }
          : undefined,
        priority: input.priority ?? "interactive",
        status: "queued",
        delivery: { status: "pending", attempts: 0 },
        queuedAt: startedAt,
        startedAt,
      };
      candidate.set(run.id, run);
      return clone(run);
    });
  }

  begin(id: string, runStartedAt = Date.now()): ChatRun | undefined {
    if (this.runs.get(id)?.status !== "queued") return undefined;
    return this.commit((candidate) => {
      const run = candidate.get(id)!;
      run.status = "running";
      run.runStartedAt = Math.max(runStartedAt, run.queuedAt);
      return clone(run);
    });
  }

  succeed(id: string, result: FinishChatRunSuccessInput): ChatRun | undefined {
    if (!this.runs.has(id)) return undefined;
    return this.commit((candidate) => {
      const run = candidate.get(id)!;
      run.runStartedAt ??= run.startedAt;
      run.status = "succeeded";
      run.finishedAt = Math.max(result.finishedAt, run.startedAt);
      run.output = result.output.slice(0, MAX_CHAT_RUN_OUTPUT_CHARACTERS);
      run.outputTruncated =
        result.output.length > MAX_CHAT_RUN_OUTPUT_CHARACTERS || undefined;
      run.traceId = result.traceId;
      run.error = undefined;
      this.pruneCompletedRuns(candidate);
      return clone(run);
    });
  }

  fail(id: string, result: FinishChatRunFailureInput): ChatRun | undefined {
    return this.finishFailure(id, "failed", result);
  }

  timeout(id: string, result: FinishChatRunFailureInput): ChatRun | undefined {
    return this.finishFailure(id, "timed_out", result);
  }

  cancel(id: string, result: FinishChatRunFailureInput): ChatRun | undefined {
    return this.finishFailure(id, "cancelled", result);
  }

  private finishFailure(
    id: string,
    status: "failed" | "cancelled" | "timed_out",
    result: FinishChatRunFailureInput,
  ): ChatRun | undefined {
    if (!this.runs.has(id)) return undefined;
    return this.commit((candidate) => {
      const run = candidate.get(id)!;
      if (run.status !== "queued") run.runStartedAt ??= run.startedAt;
      run.status = status;
      run.finishedAt = Math.max(result.finishedAt, run.runStartedAt ?? run.startedAt);
      run.error = {
        kind: result.error.kind,
        message: result.error.message.slice(0, MAX_CHAT_RUN_ERROR_CHARACTERS),
      };
      this.pruneCompletedRuns(candidate);
      return clone(run);
    });
  }

  startDeliveryAttempt(id: string, attemptedAt: number): ChatRun | undefined {
    if (!this.runs.has(id)) return undefined;
    return this.commit((candidate) => {
      const run = candidate.get(id)!;
      run.delivery = {
        status: "pending",
        attempts: run.delivery.attempts + 1,
        lastAttemptAt: attemptedAt,
      };
      return clone(run);
    });
  }

  deliveryFailed(id: string, error: string): ChatRun | undefined {
    if (!this.runs.has(id)) return undefined;
    return this.commit((candidate) => {
      const run = candidate.get(id)!;
      run.delivery = {
        ...run.delivery,
        status: "failed",
        error: error.slice(0, MAX_CHAT_RUN_ERROR_CHARACTERS),
        sentAt: undefined,
      };
      return clone(run);
    });
  }

  deliverySent(id: string, sentAt: number): ChatRun | undefined {
    if (!this.runs.has(id)) return undefined;
    return this.commit((candidate) => {
      const run = candidate.get(id)!;
      run.delivery = {
        ...run.delivery,
        status: "sent",
        sentAt,
        error: undefined,
      };
      return clone(run);
    });
  }

  get(id: string): ChatRun | undefined {
    const run = this.runs.get(id);
    return run ? clone(run) : undefined;
  }

  has(id: string): boolean {
    return this.runs.has(id);
  }

  list(space?: SpaceId): ChatRun[] {
    return [...this.runs.values()]
      .filter((run) => !space || run.space === space)
      .sort((a, b) => b.startedAt - a.startedAt || a.id.localeCompare(b.id))
      .map(clone);
  }

  listByAgent(agentId: string, limit = 20): ChatRun[] {
    return [...this.runs.values()]
      .filter((run) => run.agentId === agentId)
      .sort((a, b) => b.startedAt - a.startedAt || a.id.localeCompare(b.id))
      .slice(0, Math.max(0, Math.floor(limit)))
      .map(clone);
  }

  restore(runs: ChatRun[]): ChatRun[] {
    const incomingIds = new Set<string>();
    for (const run of runs) {
      if (!isChatRun(run)) throw new Error("invalid chat run");
      if (run.status === "queued" || run.status === "running") {
        throw new Error(`cannot restore an active chat run: ${run.id}`);
      }
      if (this.runs.has(run.id) || incomingIds.has(run.id)) {
        throw new Error(`chat run id already exists: ${run.id}`);
      }
      incomingIds.add(run.id);
    }
    if (runs.length === 0) return [];
    return this.commit((candidate, state) => {
      const restored = [...runs]
        .sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id))
        .map(clone);
      for (const run of restored) {
        candidate.set(run.id, run);
        state.lastStartedAt = Math.max(state.lastStartedAt, run.startedAt);
      }
      this.pruneCompletedRuns(candidate);
      return restored.map(clone);
    });
  }

  remove(id: string): boolean {
    if (!this.runs.has(id)) return false;
    return this.commit((candidate) => candidate.delete(id));
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

  removeByRawIds(rawIds: ReadonlySet<string>): number {
    if (rawIds.size === 0) return 0;
    const removed = [...this.runs.values()].filter(
      (run) => run.rawId && rawIds.has(run.rawId),
    ).length;
    if (removed === 0) return 0;
    return this.commit((candidate) => {
      for (const [id, run] of candidate) {
        if (run.rawId && rawIds.has(run.rawId)) candidate.delete(id);
      }
      return removed;
    });
  }
}
