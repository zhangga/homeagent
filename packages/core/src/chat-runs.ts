import { createHash, randomUUID } from "node:crypto";
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
  type NativeSessionRequest,
  type ProviderExecution,
  type ProviderId,
} from "@homeagent/llm";
import { isSpaceId, type SpaceId } from "@homeagent/shared";
import { durableFsyncSync, durableRenameSync } from "./durable-file.ts";
import {
  cloneResolvedExecutionPlan,
  isProviderExecution,
  isResolvedExecutionPlan,
  type ResolvedExecutionPlan,
} from "./execution-plan.ts";
import {
  isTaskRunSkillEvidence,
  type TaskRunSkillEvidence,
} from "./task-runs.ts";
import type { RunPriority } from "./run-scheduler.ts";
import {
  cloneAggregatedRunUsage,
  isAggregatedRunUsage,
  type AggregatedRunUsage,
} from "./usage.ts";

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
  workItemId?: string;
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
  executionPlan?: ResolvedExecutionPlan;
  /** Fail-closed marker: this run was queued with a durable native-session plan. */
  topicNativeSessionExpected?: true;
  /** provider runtime limit frozen when this Chat Run is queued */
  timeoutMs?: number;
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
  usage?: AggregatedRunUsage;
  error?: ChatRunError;
}

/** A reply has crossed the durable delivery boundary but has not settled yet. */
export function isChatRunDeliveryInFlight(
  run: Pick<ChatRun, "status" | "delivery">,
): boolean {
  return run.status === "succeeded"
    && run.delivery.status === "pending"
    && run.delivery.attempts > 0;
}

export interface StartChatRunInput {
  space: SpaceId;
  workItemId?: string;
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
  executionPlan?: ResolvedExecutionPlan;
  timeoutMs?: number;
  retryOf?: string;
  priority?: RunPriority;
  startedAt?: number;
  /** Durable local routing plan for one Feishu topic Provider conversation. */
  topicNativeSession?: TopicNativeSessionPlan;
}

export interface ChatRunStoreOptions {
  recoverInterrupted?: boolean;
}

export interface FinishChatRunSuccessInput {
  finishedAt: number;
  output: string;
  traceId?: string;
  usage?: AggregatedRunUsage;
  /** New Provider-owned head produced by the prepared start/fork turn. */
  nativeSessionId?: string;
}

export interface FinishChatRunFailureInput {
  finishedAt: number;
  error: ChatRunError;
  traceId?: string;
  usage?: AggregatedRunUsage;
}

export interface TopicNativeSessionPlan {
  kind: "feishu-topic";
  chatId: string;
  rootMessageId: string;
  threadId?: string;
  parentMessageId?: string;
  provider: "codex";
  compatibilityKey: string;
}

interface TopicNativeSessionRecord {
  space: SpaceId;
  kind: "feishu-topic";
  chatId: string;
  rootMessageId: string;
  provider: "codex";
  compatibilityVersion: 1;
  compatibilityKey: string;
  sessionId: string;
  lastChatRunId: string;
  createdAt: number;
  updatedAt: number;
  turnCount: number;
}

interface ChatRunsFile {
  version: 1 | 2 | 3 | 4 | 5 | 6;
  runs: Record<string, ChatRun>;
  topicNativeSessionPlans?: Record<string, TopicNativeSessionPlan>;
  topicNativeSessions?: Record<string, TopicNativeSessionRecord>;
}

export const MAX_CHAT_RUN_OUTPUT_CHARACTERS = 100_000;
export const MAX_CHAT_RUN_INPUT_CHARACTERS = 100_000;
export const MAX_CHAT_RUN_ERROR_CHARACTERS = 20_000;
export const MAX_CHAT_RUN_HISTORY_PER_AGENT = 100;
export const MAX_TOPIC_NATIVE_SESSION_ID_CHARACTERS = 256;
export const MAX_TOPIC_NATIVE_SESSIONS_PER_SPACE = 100;
export const MAX_TOPIC_NATIVE_SESSIONS = 5_000;
export const MAX_TOPIC_NATIVE_SESSION_PLANS = 10_000;

const TOPIC_NATIVE_SESSION_COMPATIBILITY_VERSION = 1;
const TOPIC_NATIVE_SESSION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const OPAQUE_UUID_RE =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu;
const TOPIC_NATIVE_SESSION_COMPATIBILITY_KEY_RE = /^[0-9a-f]{64}$/u;
const TOPIC_NATIVE_SESSION_EXTERNAL_ID_RE = /^[a-zA-Z0-9_-]{1,256}$/u;

export interface TopicNativeSessionCompatibilityInput {
  agentId?: string;
  executionPlan?: ResolvedExecutionPlan;
  skillEvidence?: TaskRunSkillEvidence;
}

function canonicalJson(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (!item || typeof item !== "object") return item;
    const record = item as Record<string, unknown>;
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      if (record[key] !== undefined) normalized[key] = normalize(record[key]);
    }
    return normalized;
  };
  return JSON.stringify(normalize(value));
}

/** Fingerprint every frozen input that can change a Provider conversation's semantics. */
export function topicNativeSessionCompatibilityKey(
  input: TopicNativeSessionCompatibilityInput,
): string {
  if (input.executionPlan !== undefined && !isResolvedExecutionPlan(input.executionPlan)) {
    throw new Error("Resolved execution plan is invalid");
  }
  if (input.skillEvidence !== undefined && !isTaskRunSkillEvidence(input.skillEvidence)) {
    throw new Error("Skill evidence is invalid or exceeds persistence limits");
  }
  return createHash("sha256").update(canonicalJson({
    version: TOPIC_NATIVE_SESSION_COMPATIBILITY_VERSION,
    agentId: input.agentId ?? null,
    executionPlan: input.executionPlan
      ? cloneResolvedExecutionPlan(input.executionPlan)
      : null,
    skillEvidence: input.skillEvidence
      ? {
          requested: input.skillEvidence.requested.map((item) => ({ ...item })),
          resolved: input.skillEvidence.resolved.map((item) => ({ ...item })),
          skipped: input.skillEvidence.skipped.map((item) => ({ ...item })),
        }
      : null,
  })).digest("hex");
}

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
    executionPlan: run.executionPlan
      ? cloneResolvedExecutionPlan(run.executionPlan)
      : undefined,
    delivery: { ...run.delivery },
    usage: run.usage ? cloneAggregatedRunUsage(run.usage) : undefined,
    error: run.error ? { ...run.error } : undefined,
  };
}

function cloneTopicNativeSessionPlan(
  plan: TopicNativeSessionPlan,
): TopicNativeSessionPlan {
  return { ...plan };
}

function cloneTopicNativeSessionRecord(
  session: TopicNativeSessionRecord,
): TopicNativeSessionRecord {
  return { ...session, sessionId: session.sessionId.toLowerCase() };
}

function isTopicExternalId(value: unknown): value is string {
  return typeof value === "string" && TOPIC_NATIVE_SESSION_EXTERNAL_ID_RE.test(value);
}

function normalizeNativeSessionId(value: unknown): string | undefined {
  return typeof value === "string" && TOPIC_NATIVE_SESSION_ID_RE.test(value)
    ? value.toLowerCase()
    : undefined;
}

function isNativeSessionId(value: unknown): value is string {
  return normalizeNativeSessionId(value) !== undefined;
}

function sanitizeChatRunDiagnostic(value: string): string {
  return value.replace(OPAQUE_UUID_RE, "[redacted-id]")
    .slice(0, MAX_CHAT_RUN_ERROR_CHARACTERS);
}

function isTopicNativeSessionPlan(value: unknown): value is TopicNativeSessionPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const plan = value as Partial<TopicNativeSessionPlan>;
  return plan.kind === "feishu-topic"
    && isTopicExternalId(plan.chatId)
    && isTopicExternalId(plan.rootMessageId)
    && (plan.threadId === undefined || isTopicExternalId(plan.threadId))
    && (plan.parentMessageId === undefined || isTopicExternalId(plan.parentMessageId))
    && plan.provider === "codex"
    && typeof plan.compatibilityKey === "string"
    && TOPIC_NATIVE_SESSION_COMPATIBILITY_KEY_RE.test(plan.compatibilityKey);
}

function topicNativeSessionKey(
  space: SpaceId,
  plan: Pick<TopicNativeSessionPlan, "chatId" | "rootMessageId">,
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([space, plan.chatId, plan.rootMessageId]))
    .digest("hex");
  return `feishu_topic_${digest}`;
}

function isTopicNativeSessionRecord(
  key: string,
  value: unknown,
): value is TopicNativeSessionRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const session = value as Partial<TopicNativeSessionRecord>;
  return typeof session.space === "string"
    && isSpaceId(session.space)
    && session.kind === "feishu-topic"
    && isTopicExternalId(session.chatId)
    && isTopicExternalId(session.rootMessageId)
    && topicNativeSessionKey(session.space, session as TopicNativeSessionRecord) === key
    && session.provider === "codex"
    && session.compatibilityVersion === TOPIC_NATIVE_SESSION_COMPATIBILITY_VERSION
    && typeof session.compatibilityKey === "string"
    && TOPIC_NATIVE_SESSION_COMPATIBILITY_KEY_RE.test(session.compatibilityKey)
    && isNativeSessionId(session.sessionId)
    && typeof session.lastChatRunId === "string"
    && /^chat_run_[a-zA-Z0-9-]{1,160}$/u.test(session.lastChatRunId)
    && typeof session.createdAt === "number"
    && Number.isFinite(session.createdAt)
    && session.createdAt >= 0
    && typeof session.updatedAt === "number"
    && Number.isFinite(session.updatedAt)
    && session.updatedAt >= session.createdAt
    && typeof session.turnCount === "number"
    && Number.isSafeInteger(session.turnCount)
    && session.turnCount > 0;
}

function topicNativeSessionHasProvenance(
  session: TopicNativeSessionRecord,
  runs: ReadonlyMap<string, ChatRun>,
  plans: ReadonlyMap<string, TopicNativeSessionPlan>,
): boolean {
  const run = runs.get(session.lastChatRunId);
  const plan = plans.get(session.lastChatRunId);
  return run?.status === "succeeded"
    && run.topicNativeSessionExpected === true
    && run.space === session.space
    && plan?.kind === session.kind
    && plan.chatId === session.chatId
    && plan.rootMessageId === session.rootMessageId
    && plan.provider === session.provider
    && plan.compatibilityKey === session.compatibilityKey;
}

function topicNativeSessionIsContinuationEligible(
  session: TopicNativeSessionRecord,
  runs: ReadonlyMap<string, ChatRun>,
  plans: ReadonlyMap<string, TopicNativeSessionPlan>,
): boolean {
  return topicNativeSessionHasProvenance(session, runs, plans)
    && runs.get(session.lastChatRunId)?.delivery.status === "sent";
}

function assertTopicNativeSessionPlan(
  input: StartChatRunInput,
  plan: TopicNativeSessionPlan,
): void {
  if (!isTopicNativeSessionPlan(plan)) {
    throw new Error("Feishu topic native session plan is invalid or exceeds persistence limits");
  }
  if (input.chatId !== plan.chatId) {
    throw new Error("Feishu topic native session chat does not match the Chat Run");
  }
  if (input.executionPlan?.provider !== plan.provider || input.provider !== undefined
    && input.provider !== plan.provider) {
    throw new Error("Feishu topic native session provider does not match the frozen execution plan");
  }
  const expectedCompatibilityKey = topicNativeSessionCompatibilityKey({
    agentId: input.agentId,
    executionPlan: input.executionPlan,
    skillEvidence: input.skillEvidence,
  });
  if (plan.compatibilityKey !== expectedCompatibilityKey) {
    throw new Error("Feishu topic native session compatibility does not match frozen inputs");
  }
}

interface LoadedChatRunState {
  runs: Map<string, ChatRun>;
  topicNativeSessionPlans: Map<string, TopicNativeSessionPlan>;
  topicNativeSessions: Map<string, TopicNativeSessionRecord>;
}

interface TopicNativeSessionLease {
  topicKey: string;
  request: NativeSessionRequest;
  expectedSessionId: string | undefined;
  expectedCompatibilityKey: string | undefined;
}

interface ChatRunStoreLocalSpaceSnapshot {
  space: SpaceId;
  runs: ChatRun[];
  topicNativeSessionPlans: Map<string, TopicNativeSessionPlan>;
  topicNativeSessions: Map<string, TopicNativeSessionRecord>;
  topicNativeSessionLeases: Map<string, TopicNativeSessionLease>;
}

function cloneTopicNativeSessionLease(
  lease: TopicNativeSessionLease,
): TopicNativeSessionLease {
  return { ...lease, request: { ...lease.request } };
}

function pruneTopicNativeSessions(
  sessions: Map<string, TopicNativeSessionRecord>,
): void {
  const oldestFirst = (
    entries: Array<[string, TopicNativeSessionRecord]>,
  ): Array<[string, TopicNativeSessionRecord]> => entries.sort((a, b) =>
    a[1].updatedAt - b[1].updatedAt || a[0].localeCompare(b[0])
  );
  const bySpace = new Map<SpaceId, Array<[string, TopicNativeSessionRecord]>>();
  for (const entry of sessions) {
    const entries = bySpace.get(entry[1].space) ?? [];
    entries.push(entry);
    bySpace.set(entry[1].space, entries);
  }
  for (const entries of bySpace.values()) {
    const excess = entries.length - MAX_TOPIC_NATIVE_SESSIONS_PER_SPACE;
    if (excess <= 0) continue;
    for (const [key] of oldestFirst(entries).slice(0, excess)) sessions.delete(key);
  }
  const globalExcess = sessions.size - MAX_TOPIC_NATIVE_SESSIONS;
  if (globalExcess <= 0) return;
  for (const [key] of oldestFirst([...sessions]).slice(0, globalExcess)) {
    sessions.delete(key);
  }
}

function pruneTopicNativeSessionPlans(
  runs: Map<string, ChatRun>,
  plans: Map<string, TopicNativeSessionPlan>,
  allowDroppingActive: boolean,
  protectedRunIds: ReadonlySet<string> = new Set(),
): void {
  const excess = () => plans.size - MAX_TOPIC_NATIVE_SESSION_PLANS;
  if (excess() <= 0) return;
  const oldestTerminal = [...plans.keys()]
    .filter((runId) => {
      if (protectedRunIds.has(runId)) return false;
      const status = runs.get(runId)?.status;
      return status !== "queued" && status !== "running";
    })
    .sort((a, b) =>
      (runs.get(a)?.startedAt ?? 0) - (runs.get(b)?.startedAt ?? 0)
      || a.localeCompare(b)
    );
  for (const runId of oldestTerminal.slice(0, Math.max(0, excess()))) {
    plans.delete(runId);
  }
  if (excess() <= 0) return;
  if (!allowDroppingActive) {
    throw new Error("Too many active Feishu topic native session plans");
  }
  const oldestRemaining = [...plans.keys()]
    .filter((runId) => !protectedRunIds.has(runId))
    .sort((a, b) =>
      (runs.get(a)?.startedAt ?? 0) - (runs.get(b)?.startedAt ?? 0)
      || a.localeCompare(b)
    );
  for (const runId of oldestRemaining.slice(0, excess())) plans.delete(runId);
  if (excess() > 0) {
    throw new Error("Too many retained Feishu topic native session plans");
  }
}

function pruneUnprovenTopicNativeSessions(
  runs: ReadonlyMap<string, ChatRun>,
  plans: ReadonlyMap<string, TopicNativeSessionPlan>,
  sessions: Map<string, TopicNativeSessionRecord>,
): void {
  for (const [key, session] of sessions) {
    if (!topicNativeSessionHasProvenance(session, runs, plans)) sessions.delete(key);
  }
}

function leaseMatchesSession(
  lease: TopicNativeSessionLease,
  session: TopicNativeSessionRecord | undefined,
): boolean {
  if (lease.expectedSessionId === undefined) return session === undefined;
  return session?.sessionId === lease.expectedSessionId
    && session.compatibilityKey === lease.expectedCompatibilityKey;
}

function isProviderId(value: unknown): value is ProviderId {
  return ["gateway", "claude", "codex", "trae-cli"].includes(String(value));
}

function isRunPriority(value: unknown): value is RunPriority {
  return ["interactive", "manual", "scheduled", "background"].includes(String(value));
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
    && [run.workItemId, run.rawId, run.chatId, run.messageId, run.author, run.agentId, run.model, run.retryOf]
      .every((item) => item === undefined || typeof item === "string")
    && [run.output, run.traceId]
      .every((item) => item === undefined || typeof item === "string")
    && (run.output === undefined || run.output.length <= MAX_CHAT_RUN_OUTPUT_CHARACTERS)
    && (run.outputTruncated === undefined || typeof run.outputTruncated === "boolean")
    && (run.provider === undefined || isProviderId(run.provider))
    && (run.reasoningEffort === undefined
      || CODEX_REASONING_EFFORTS.includes(run.reasoningEffort))
    && (run.skillEvidence === undefined || isTaskRunSkillEvidence(run.skillEvidence))
    && (run.execution === undefined || isProviderExecution(run.execution))
    && (run.executionPlan === undefined || isResolvedExecutionPlan(run.executionPlan))
    && (run.topicNativeSessionExpected === undefined
      || run.topicNativeSessionExpected === true)
    && (run.timeoutMs === undefined || (
      Number.isInteger(run.timeoutMs)
      && run.timeoutMs > 0
    ))
    && (run.usage === undefined || isAggregatedRunUsage(run.usage))
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
  private topicNativeSessionPlans: Map<string, TopicNativeSessionPlan>;
  private topicNativeSessions: Map<string, TopicNativeSessionRecord>;
  private readonly topicNativeSessionLeases = new Map<string, TopicNativeSessionLease>();
  private lastStartedAt: number;

  constructor(dataDir: string, opts: ChatRunStoreOptions = {}) {
    this.configPath = join(dataDir, "config", "chat-runs.json");
    const loaded = this.load();
    this.runs = loaded.runs;
    this.topicNativeSessionPlans = loaded.topicNativeSessionPlans;
    this.topicNativeSessions = loaded.topicNativeSessions;
    this.lastStartedAt = 0;
    for (const run of this.runs.values()) {
      this.lastStartedAt = Math.max(this.lastStartedAt, run.startedAt);
    }
    if (opts.recoverInterrupted) this.recoverInterruptedRuns();
  }

  private load(): LoadedChatRunState {
    const runs = new Map<string, ChatRun>();
    const topicNativeSessionPlans = new Map<string, TopicNativeSessionPlan>();
    const topicNativeSessions = new Map<string, TopicNativeSessionRecord>();
    const empty = (): LoadedChatRunState => ({
      runs,
      topicNativeSessionPlans,
      topicNativeSessions,
    });
    if (!existsSync(this.configPath)) return empty();
    let parsed: Partial<ChatRunsFile>;
    try {
      const value: unknown = JSON.parse(readFileSync(this.configPath, "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("invalid root");
      }
      parsed = value as Partial<ChatRunsFile>;
    } catch {
      throw new Error("Chat Run history is corrupt; refusing to overwrite it");
    }
    if (![1, 2, 3, 4, 5, 6].includes(Number(parsed.version))) {
      throw new Error("Chat Run history uses an unsupported newer version");
    }
    if (!parsed.runs || typeof parsed.runs !== "object" || Array.isArray(parsed.runs)) {
      throw new Error("Chat Run history is corrupt; refusing to overwrite it");
    }
    if (parsed.version === 6 && (
      (parsed.topicNativeSessionPlans !== undefined && (
        !parsed.topicNativeSessionPlans
        || typeof parsed.topicNativeSessionPlans !== "object"
        || Array.isArray(parsed.topicNativeSessionPlans)
      ))
      || (parsed.topicNativeSessions !== undefined && (
        !parsed.topicNativeSessions
        || typeof parsed.topicNativeSessions !== "object"
        || Array.isArray(parsed.topicNativeSessions)
      ))
    )) {
      throw new Error("Chat Run history is corrupt; refusing to overwrite it");
    }
    try {
      for (const [id, value] of Object.entries(parsed.runs ?? {})) {
        const legacy = value as Partial<ChatRun>;
        const {
          topicNativeSessionExpected: _legacyTopicNativeSessionExpected,
          ...legacyWithoutTopicNativeSessionExpected
        } = legacy;
        const normalized = parsed.version === 1
          ? {
              ...legacyWithoutTopicNativeSessionExpected,
              priority: "interactive",
              queuedAt: legacy.startedAt,
              runStartedAt: legacy.status === "queued" ? undefined : legacy.startedAt,
            }
          : parsed.version === 6
          ? legacy
          : legacyWithoutTopicNativeSessionExpected;
        if (!isChatRun(normalized) || normalized.id !== id) continue;
        runs.set(id, clone(normalized));
      }
      if (parsed.version === 6) {
        for (const [runId, value] of Object.entries(parsed.topicNativeSessionPlans ?? {})) {
          const run = runs.get(runId);
          if (
            !run
            || run.topicNativeSessionExpected !== true
            || !isTopicNativeSessionPlan(value)
          ) continue;
          try {
            assertTopicNativeSessionPlan({
              ...run,
              topicNativeSession: value,
            }, value);
          } catch {
            continue;
          }
          topicNativeSessionPlans.set(runId, cloneTopicNativeSessionPlan(value));
        }
        for (const [key, value] of Object.entries(parsed.topicNativeSessions ?? {})) {
          if (!isTopicNativeSessionRecord(key, value)) continue;
          const session = cloneTopicNativeSessionRecord(value);
          if (!topicNativeSessionIsContinuationEligible(
            session,
            runs,
            topicNativeSessionPlans,
          )) {
            continue;
          }
          topicNativeSessions.set(key, session);
        }
        pruneTopicNativeSessions(topicNativeSessions);
        const protectedRunIds = new Set(
          [...topicNativeSessions.values()].map((session) => session.lastChatRunId),
        );
        pruneTopicNativeSessionPlans(
          runs,
          topicNativeSessionPlans,
          true,
          protectedRunIds,
        );
        pruneUnprovenTopicNativeSessions(
          runs,
          topicNativeSessionPlans,
          topicNativeSessions,
        );
      }
    } catch {
      throw new Error("Chat Run history is corrupt; refusing to overwrite it");
    }
    return empty();
  }

  private persist(
    runs = this.runs,
    topicNativeSessionPlans = this.topicNativeSessionPlans,
    topicNativeSessions = this.topicNativeSessions,
  ): void {
    const configDir = dirname(this.configPath);
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    const tempPath = `${this.configPath}.${process.pid}.${randomUUID()}.tmp`;
    const file: ChatRunsFile = {
      version: 6,
      runs: Object.fromEntries(runs),
      topicNativeSessionPlans: Object.fromEntries(topicNativeSessionPlans),
      topicNativeSessions: Object.fromEntries(topicNativeSessions),
    };
    try {
      writeFileSync(tempPath, JSON.stringify(file, null, 2), {
        encoding: "utf8",
        mode: 0o600,
      });
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
      candidate: Map<string, ChatRun>,
      state: { lastStartedAt: number },
      topicNativeSessionPlans: Map<string, TopicNativeSessionPlan>,
      topicNativeSessions: Map<string, TopicNativeSessionRecord>,
    ) => T,
  ): T {
    const candidate = new Map(
      [...this.runs].map(([id, run]) => [id, clone(run)]),
    );
    const candidatePlans = new Map(
      [...this.topicNativeSessionPlans]
        .map(([id, plan]) => [id, cloneTopicNativeSessionPlan(plan)]),
    );
    const candidateSessions = new Map(
      [...this.topicNativeSessions]
        .map(([key, session]) => [key, cloneTopicNativeSessionRecord(session)]),
    );
    const state = { lastStartedAt: this.lastStartedAt };
    const result = change(candidate, state, candidatePlans, candidateSessions);
    this.pruneOrphanTopicNativeSessionPlans(candidate, candidatePlans);
    pruneUnprovenTopicNativeSessions(candidate, candidatePlans, candidateSessions);
    pruneTopicNativeSessions(candidateSessions);
    this.pruneCompletedRuns(candidate, candidateSessions);
    this.pruneOrphanTopicNativeSessionPlans(candidate, candidatePlans);
    const protectedRunIds = new Set(
      [...candidateSessions.values()].map((session) => session.lastChatRunId),
    );
    pruneTopicNativeSessionPlans(
      candidate,
      candidatePlans,
      false,
      protectedRunIds,
    );
    pruneUnprovenTopicNativeSessions(candidate, candidatePlans, candidateSessions);
    this.persist(candidate, candidatePlans, candidateSessions);
    this.runs = candidate;
    this.topicNativeSessionPlans = candidatePlans;
    this.topicNativeSessions = candidateSessions;
    this.lastStartedAt = state.lastStartedAt;
    return result;
  }

  private pruneOrphanTopicNativeSessionPlans(
    runs: Map<string, ChatRun>,
    plans: Map<string, TopicNativeSessionPlan>,
  ): void {
    for (const runId of plans.keys()) {
      if (!runs.has(runId)) plans.delete(runId);
    }
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
    });
  }

  private pruneCompletedRuns(
    runs = this.runs,
    sessions = this.topicNativeSessions,
  ): void {
    const protectedRunIds = new Set(
      [...sessions.values()].map((session) => session.lastChatRunId),
    );
    const completedByOwner = new Map<string, ChatRun[]>();
    for (const run of runs.values()) {
      if (
        run.status === "queued"
        || run.status === "running"
        || isChatRunDeliveryInFlight(run)
      ) continue;
      const owner = run.agentId ? `agent:${run.agentId}` : `space:${run.space}`;
      const completed = completedByOwner.get(owner) ?? [];
      completed.push(run);
      completedByOwner.set(owner, completed);
    }
    for (const completed of completedByOwner.values()) {
      completed.sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
      let excess = completed.length - MAX_CHAT_RUN_HISTORY_PER_AGENT;
      for (const run of completed) {
        if (excess <= 0) break;
        if (protectedRunIds.has(run.id)) continue;
        runs.delete(run.id);
        excess -= 1;
      }
    }
  }

  start(input: StartChatRunInput): ChatRun {
    if (
      input.timeoutMs !== undefined
      && (!Number.isInteger(input.timeoutMs) || input.timeoutMs <= 0)
    ) {
      throw new Error("Chat timeout must be a positive integer");
    }
    if (input.executionPlan !== undefined && !isResolvedExecutionPlan(input.executionPlan)) {
      throw new Error("Resolved execution plan is invalid");
    }
    if (input.skillEvidence !== undefined && !isTaskRunSkillEvidence(input.skillEvidence)) {
      throw new Error("Skill evidence is invalid or exceeds persistence limits");
    }
    if (input.execution !== undefined && !isProviderExecution(input.execution)) {
      throw new Error("Chat execution snapshot is invalid");
    }
    if (input.topicNativeSession !== undefined) {
      assertTopicNativeSessionPlan(input, input.topicNativeSession);
    }
    return this.commit((candidate, state, topicNativeSessionPlans) => {
      const requestedStartedAt = input.startedAt ?? Date.now();
      const startedAt = Math.max(requestedStartedAt, state.lastStartedAt + 1);
      state.lastStartedAt = startedAt;
      const { topicNativeSession, ...chatRunInput } = input;
      const run: ChatRun = {
        ...chatRunInput,
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
        executionPlan: input.executionPlan
          ? cloneResolvedExecutionPlan(input.executionPlan)
          : undefined,
        ...(topicNativeSession ? { topicNativeSessionExpected: true as const } : {}),
        priority: input.priority ?? "interactive",
        status: "queued",
        delivery: { status: "pending", attempts: 0 },
        queuedAt: startedAt,
        startedAt,
      };
      candidate.set(run.id, run);
      if (topicNativeSession) {
        topicNativeSessionPlans.set(
          run.id,
          cloneTopicNativeSessionPlan(topicNativeSession),
        );
      }
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

  topicNativeSessionForRun(id: string): TopicNativeSessionPlan | undefined {
    const plan = this.topicNativeSessionPlans.get(id);
    return plan ? cloneTopicNativeSessionPlan(plan) : undefined;
  }

  prepareTopicNativeSession(id: string): NativeSessionRequest | undefined {
    const run = this.runs.get(id);
    const plan = this.topicNativeSessionPlans.get(id);
    if (!run || run.status !== "running" || !plan) return undefined;
    const existingLease = this.topicNativeSessionLeases.get(id);
    if (existingLease) return { ...existingLease.request };

    const topicKey = topicNativeSessionKey(run.space, plan);
    let session = this.topicNativeSessions.get(topicKey);
    if (
      session
      && !topicNativeSessionIsContinuationEligible(
        session,
        this.runs,
        this.topicNativeSessionPlans,
      )
    ) {
      this.commit((runs, _state, plans, sessions) => {
        const candidate = sessions.get(topicKey);
        if (
          candidate
          && !topicNativeSessionIsContinuationEligible(candidate, runs, plans)
        ) {
          sessions.delete(topicKey);
        }
      });
      session = this.topicNativeSessions.get(topicKey);
    }
    const compatible = session?.provider === plan.provider
      && session.compatibilityKey === plan.compatibilityKey;
    const request: NativeSessionRequest = compatible && session
      ? { mode: "fork", id: session.sessionId }
      : { mode: "start" };
    this.topicNativeSessionLeases.set(id, {
      topicKey,
      request,
      expectedSessionId: session?.sessionId,
      expectedCompatibilityKey: session?.compatibilityKey,
    });
    return { ...request };
  }

  invalidateTopicNativeSessionForRun(id: string): boolean {
    const plan = this.topicNativeSessionPlans.get(id);
    const lease = this.topicNativeSessionLeases.get(id);
    if (!plan || !lease) return false;
    const current = this.topicNativeSessions.get(lease.topicKey);
    if (!leaseMatchesSession(lease, current)) return false;
    if (!current) {
      this.topicNativeSessionLeases.delete(id);
      return false;
    }
    const removed = this.commit((_runs, _state, _plans, sessions) => {
      const candidate = sessions.get(lease.topicKey);
      if (!leaseMatchesSession(lease, candidate)) return false;
      return sessions.delete(lease.topicKey);
    });
    if (removed) this.topicNativeSessionLeases.delete(id);
    return removed;
  }

  invalidateTopicNativeSessions(
    space: SpaceId,
    chatId: string,
    rootMessageId?: string,
  ): number {
    if (!isSpaceId(space)) throw new Error("Space id is invalid");
    if (!isTopicExternalId(chatId)) {
      throw new Error("Feishu topic chat id is invalid or exceeds persistence limits");
    }
    if (rootMessageId !== undefined && !isTopicExternalId(rootMessageId)) {
      throw new Error("Feishu topic root message id is invalid or exceeds persistence limits");
    }
    const matches = [...this.topicNativeSessions]
      .filter(([, session]) => session.space === space
        && session.chatId === chatId
        && (rootMessageId === undefined || session.rootMessageId === rootMessageId))
      .map(([key]) => key);
    const invalidatedTopicKeys = new Set(matches);
    if (rootMessageId !== undefined) {
      invalidatedTopicKeys.add(topicNativeSessionKey(space, {
        chatId,
        rootMessageId,
      }));
    }
    if (matches.length > 0) {
      this.commit((_runs, _state, _plans, sessions) => {
        for (const key of matches) sessions.delete(key);
      });
    }
    for (const [runId, lease] of this.topicNativeSessionLeases) {
      if (rootMessageId === undefined) {
        const run = this.runs.get(runId);
        const plan = this.topicNativeSessionPlans.get(runId);
        if (run?.space === space && plan?.chatId === chatId) {
          this.topicNativeSessionLeases.delete(runId);
        }
      } else if (invalidatedTopicKeys.has(lease.topicKey)) {
        this.topicNativeSessionLeases.delete(runId);
      }
    }
    return matches.length;
  }

  invalidateTopicNativeSessionsForSpace(space: SpaceId): number {
    if (!isSpaceId(space)) throw new Error("Space id is invalid");
    const matches = [...this.topicNativeSessions]
      .filter(([, session]) => session.space === space)
      .map(([key]) => key);
    if (matches.length > 0) {
      this.commit((_runs, _state, _plans, sessions) => {
        for (const key of matches) sessions.delete(key);
      });
    }
    for (const [runId] of this.topicNativeSessionLeases) {
      if (this.runs.get(runId)?.space === space) {
        this.topicNativeSessionLeases.delete(runId);
      }
    }
    return matches.length;
  }

  succeed(id: string, result: FinishChatRunSuccessInput): ChatRun | undefined {
    if (!["queued", "running"].includes(this.runs.get(id)?.status ?? "")) {
      return undefined;
    }
    const succeeded = this.commit((candidate, _state, plans, sessions) => {
      const run = candidate.get(id)!;
      if (!["queued", "running"].includes(run.status)) return undefined;
      const plan = plans.get(id);
      const lease = this.topicNativeSessionLeases.get(id);
      if (result.nativeSessionId !== undefined) {
        if (!plan || !lease) {
          throw new Error("Provider native session was not prepared for this Chat Run");
        }
        const nativeSessionId = normalizeNativeSessionId(result.nativeSessionId);
        if (!nativeSessionId) {
          throw new Error("Provider native session id is invalid");
        }
        const current = sessions.get(lease.topicKey);
        if (!leaseMatchesSession(lease, current)) {
          throw new Error("Provider native session head changed before Chat Run commit");
        }
        if (
          lease.request.mode === "fork"
          && nativeSessionId === lease.request.id.toLowerCase()
        ) {
          throw new Error("Provider did not fork the native session");
        }
        if (
          lease.request.mode === "start"
          && lease.expectedSessionId !== undefined
          && nativeSessionId === lease.expectedSessionId.toLowerCase()
        ) {
          throw new Error("Provider did not start a fresh native session");
        }
        const finishedAt = Math.max(result.finishedAt, run.startedAt);
        sessions.set(lease.topicKey, {
          space: run.space,
          kind: "feishu-topic",
          chatId: plan.chatId,
          rootMessageId: plan.rootMessageId,
          provider: plan.provider,
          compatibilityVersion: TOPIC_NATIVE_SESSION_COMPATIBILITY_VERSION,
          compatibilityKey: plan.compatibilityKey,
          sessionId: nativeSessionId,
          lastChatRunId: run.id,
          createdAt: lease.request.mode === "fork" && current
            ? current.createdAt
            : finishedAt,
          updatedAt: finishedAt,
          turnCount: lease.request.mode === "fork" && current
            ? Math.min(Number.MAX_SAFE_INTEGER, current.turnCount + 1)
            : 1,
        });
      } else if (lease) {
        throw new Error("Prepared Provider native session did not return a session id");
      } else if (plan) {
        // A static reply did not enter Provider history. Continuing the old
        // head would falsely claim that this visible turn was part of it.
        sessions.delete(topicNativeSessionKey(run.space, plan));
      }
      run.runStartedAt ??= run.startedAt;
      run.status = "succeeded";
      run.finishedAt = Math.max(result.finishedAt, run.startedAt);
      run.output = result.output.slice(0, MAX_CHAT_RUN_OUTPUT_CHARACTERS);
      run.outputTruncated =
        result.output.length > MAX_CHAT_RUN_OUTPUT_CHARACTERS || undefined;
      run.traceId = result.traceId;
      run.usage = result.usage ? cloneAggregatedRunUsage(result.usage) : undefined;
      run.error = undefined;
      return clone(run);
    });
    this.topicNativeSessionLeases.delete(id);
    return succeeded;
  }

  fail(id: string, result: FinishChatRunFailureInput): ChatRun | undefined {
    return this.finishFailure(id, "failed", result);
  }

  failAndInvalidateTopicNativeSession(
    id: string,
    result: FinishChatRunFailureInput,
  ): ChatRun | undefined {
    return this.finishFailure(id, "failed", result, true);
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
    invalidateTopicNativeSession = false,
  ): ChatRun | undefined {
    if (!["queued", "running"].includes(this.runs.get(id)?.status ?? "")) {
      return undefined;
    }
    const lease = this.topicNativeSessionLeases.get(id);
    const failed = this.commit((candidate, _state, _plans, sessions) => {
      const run = candidate.get(id)!;
      if (!["queued", "running"].includes(run.status)) return undefined;
      if (invalidateTopicNativeSession && lease) {
        const current = sessions.get(lease.topicKey);
        if (leaseMatchesSession(lease, current)) sessions.delete(lease.topicKey);
      }
      if (run.status !== "queued") run.runStartedAt ??= run.startedAt;
      run.status = status;
      run.finishedAt = Math.max(result.finishedAt, run.runStartedAt ?? run.startedAt);
      run.error = {
        kind: result.error.kind,
        message: sanitizeChatRunDiagnostic(result.error.message),
      };
      run.traceId = result.traceId;
      run.usage = result.usage ? cloneAggregatedRunUsage(result.usage) : undefined;
      return clone(run);
    });
    this.topicNativeSessionLeases.delete(id);
    return failed;
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
    return this.commit((candidate, _state, _plans, sessions) => {
      const run = candidate.get(id)!;
      run.delivery = {
        ...run.delivery,
        status: "failed",
        error: sanitizeChatRunDiagnostic(error),
        sentAt: undefined,
      };
      for (const [key, session] of sessions) {
        if (session.lastChatRunId === id) sessions.delete(key);
      }
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

  snapshotLocalBySpace(space: SpaceId): ChatRunStoreLocalSpaceSnapshot {
    const runs = [...this.runs.values()]
      .filter((run) => run.space === space)
      .map(clone);
    const runIds = new Set(runs.map((run) => run.id));
    return {
      space,
      runs,
      topicNativeSessionPlans: new Map(
        [...this.topicNativeSessionPlans]
          .filter(([runId]) => runIds.has(runId))
          .map(([runId, plan]) => [runId, cloneTopicNativeSessionPlan(plan)]),
      ),
      topicNativeSessions: new Map(
        [...this.topicNativeSessions]
          .filter(([, session]) => session.space === space)
          .map(([key, session]) => [key, cloneTopicNativeSessionRecord(session)]),
      ),
      topicNativeSessionLeases: new Map(
        [...this.topicNativeSessionLeases]
          .filter(([runId]) => runIds.has(runId))
          .map(([runId, lease]) => [runId, cloneTopicNativeSessionLease(lease)]),
      ),
    };
  }

  restoreLocalSnapshot(snapshot: ChatRunStoreLocalSpaceSnapshot): void {
    if (!snapshot || !isSpaceId(snapshot.space)
      || !Array.isArray(snapshot.runs)
      || !(snapshot.topicNativeSessionPlans instanceof Map)
      || !(snapshot.topicNativeSessions instanceof Map)
      || !(snapshot.topicNativeSessionLeases instanceof Map)) {
      throw new Error("Chat Run local Space snapshot is invalid");
    }
    const snapshotRuns = new Map<string, ChatRun>();
    for (const run of snapshot.runs) {
      if (!isChatRun(run) || run.space !== snapshot.space || snapshotRuns.has(run.id)) {
        throw new Error("Chat Run local Space snapshot contains an invalid run");
      }
      snapshotRuns.set(run.id, clone(run));
    }
    const snapshotPlans = new Map<string, TopicNativeSessionPlan>();
    for (const [runId, plan] of snapshot.topicNativeSessionPlans) {
      const run = snapshotRuns.get(runId) ?? this.runs.get(runId);
      if (
        !run
        || run.space !== snapshot.space
        || run.topicNativeSessionExpected !== true
        || !isTopicNativeSessionPlan(plan)
      ) {
        throw new Error("Chat Run local Space snapshot contains an invalid topic plan");
      }
      assertTopicNativeSessionPlan({ ...run, topicNativeSession: plan }, plan);
      snapshotPlans.set(runId, cloneTopicNativeSessionPlan(plan));
    }
    const snapshotSessions = new Map<string, TopicNativeSessionRecord>();
    for (const [key, session] of snapshot.topicNativeSessions) {
      if (
        session.space !== snapshot.space
        || !isTopicNativeSessionRecord(key, session)
        || !topicNativeSessionHasProvenance(session, snapshotRuns, snapshotPlans)
      ) {
        throw new Error("Chat Run local Space snapshot contains an invalid topic session");
      }
      snapshotSessions.set(key, cloneTopicNativeSessionRecord(session));
    }
    const snapshotLeases = new Map<string, TopicNativeSessionLease>();
    for (const [runId, lease] of snapshot.topicNativeSessionLeases) {
      const run = snapshotRuns.get(runId);
      const plan = snapshotPlans.get(runId);
      const current = snapshotSessions.get(lease.topicKey);
      const compatible = current !== undefined
        && plan !== undefined
        && current.provider === plan.provider
        && current.compatibilityKey === plan.compatibilityKey;
      const expectedSessionId = lease.expectedSessionId === undefined
        ? undefined
        : normalizeNativeSessionId(lease.expectedSessionId);
      if (
        !run
        || run.status !== "running"
        || !plan
        || lease.topicKey !== topicNativeSessionKey(run.space, plan)
        || expectedSessionId !== lease.expectedSessionId
        || ((lease.expectedSessionId === undefined)
          !== (lease.expectedCompatibilityKey === undefined))
        || (lease.expectedCompatibilityKey !== undefined
          && !TOPIC_NATIVE_SESSION_COMPATIBILITY_KEY_RE.test(
            lease.expectedCompatibilityKey,
          ))
        || !leaseMatchesSession(lease, current)
        || (lease.request.mode === "fork"
          ? !compatible
            || normalizeNativeSessionId(lease.request.id) !== lease.request.id
            || lease.request.id !== current?.sessionId
          : lease.request.mode !== "start" || compatible)
      ) {
        throw new Error("Chat Run local Space snapshot contains an invalid topic lease");
      }
      const existing = this.topicNativeSessionLeases.get(runId);
      if (existing && canonicalJson(existing) !== canonicalJson(lease)) {
        throw new Error(`chat run topic lease already exists: ${runId}`);
      }
      snapshotLeases.set(runId, cloneTopicNativeSessionLease(lease));
    }
    this.commit((runs, state, plans, sessions) => {
      for (const [runId, run] of snapshotRuns) {
        const current = runs.get(runId);
        if (current && canonicalJson(current) !== canonicalJson(run)) {
          throw new Error(`chat run id already exists: ${runId}`);
        }
        runs.set(runId, clone(run));
        state.lastStartedAt = Math.max(state.lastStartedAt, run.startedAt);
      }
      for (const [runId, plan] of snapshotPlans) {
        const current = plans.get(runId);
        if (current && canonicalJson(current) !== canonicalJson(plan)) {
          throw new Error(`chat run topic plan already exists: ${runId}`);
        }
        plans.set(runId, cloneTopicNativeSessionPlan(plan));
      }
      for (const [key, session] of snapshotSessions) {
        const current = sessions.get(key);
        if (current && canonicalJson(current) !== canonicalJson(session)) {
          throw new Error(`chat run topic session already exists: ${key}`);
        }
        sessions.set(key, cloneTopicNativeSessionRecord(session));
      }
    });
    for (const [runId, lease] of snapshotLeases) {
      this.topicNativeSessionLeases.set(runId, cloneTopicNativeSessionLease(lease));
    }
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
      return restored.map(clone);
    });
  }

  remove(id: string): boolean {
    if (!this.runs.has(id)) return false;
    const removed = this.commit((candidate) => candidate.delete(id));
    if (removed) this.topicNativeSessionLeases.delete(id);
    return removed;
  }

  removeBySpace(space: SpaceId): number {
    const removed = [...this.runs.values()].filter((run) => run.space === space).length;
    const sessionKeys = [...this.topicNativeSessions]
      .filter(([, session]) => session.space === space)
      .map(([key]) => key);
    if (removed === 0 && sessionKeys.length === 0) return 0;
    const result = this.commit((candidate, _state, _plans, sessions) => {
      for (const [id, run] of candidate) {
        if (run.space === space) candidate.delete(id);
      }
      for (const key of sessionKeys) sessions.delete(key);
      return removed;
    });
    for (const [runId, lease] of this.topicNativeSessionLeases) {
      if (sessionKeys.includes(lease.topicKey) || !this.runs.has(runId)) {
        this.topicNativeSessionLeases.delete(runId);
      }
    }
    return result;
  }

  removeByRawIds(rawIds: ReadonlySet<string>): number {
    if (rawIds.size === 0) return 0;
    const matchingRuns = [...this.runs.values()].filter(
      (run) => run.rawId && rawIds.has(run.rawId),
    );
    const removed = matchingRuns.filter((run) => !isChatRunDeliveryInFlight(run)).length;
    const hasTopicSessionPlan = matchingRuns.some(
      (run) => this.topicNativeSessionPlans.has(run.id),
    );
    if (removed === 0 && !hasTopicSessionPlan) return 0;
    const invalidatedTopicKeys = new Set<string>();
    const result = this.commit((candidate, _state, plans, sessions) => {
      for (const [id, run] of candidate) {
        if (!run.rawId || !rawIds.has(run.rawId)) continue;
        const plan = plans.get(id);
        if (plan) {
          const topicKey = topicNativeSessionKey(run.space, plan);
          sessions.delete(topicKey);
          invalidatedTopicKeys.add(topicKey);
        }
        if (!isChatRunDeliveryInFlight(run)) candidate.delete(id);
      }
      return removed;
    });
    for (const [runId, lease] of this.topicNativeSessionLeases) {
      if (!this.runs.has(runId) || invalidatedTopicKeys.has(lease.topicKey)) {
        this.topicNativeSessionLeases.delete(runId);
      }
    }
    return result;
  }
}
