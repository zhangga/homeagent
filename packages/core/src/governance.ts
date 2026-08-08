import {
  isSpaceId,
  type Attachment,
  type Page,
  type PageType,
  type RawRecord,
  type RawSource,
  type SpaceId,
} from "@homeagent/shared";
import {
  CODEX_REASONING_EFFORTS,
  isCliProvider,
  isCodexReasoningEffortSupported,
  normalizeProviderSkills,
} from "@homeagent/llm";
import type { Agent, AgentSkillBinding } from "./agents.ts";
import {
  AGENT_PERMISSIONS,
  AGENT_VISIBILITIES,
  agentVisibleInSpace,
  isAgentSkillName,
  isAgentSkillSourceKey,
} from "./agents.ts";
import {
  DEFAULT_TASK_TIMEOUT_MINUTES,
  MAX_TASK_TIMEOUT_MINUTES,
  MIN_TASK_TIMEOUT_MINUTES,
  TASK_CADENCES,
  type Task,
} from "./tasks.ts";
import {
  MAX_TASK_RUN_ERROR_CHARACTERS,
  MAX_TASK_RUN_HISTORY_PER_TASK,
  MAX_TASK_RUN_OUTPUT_CHARACTERS,
  isTaskRunSkillEvidence,
  type TaskRun,
  type TaskRunNotification,
} from "./task-runs.ts";
import {
  MAX_CHAT_RUN_HISTORY_PER_AGENT,
  isChatRun,
  type ChatRun,
} from "./chat-runs.ts";
import type { Reminder } from "./reminders.ts";
import type {
  LearningArchive,
  LearnerProfile,
  LearningPlan,
  LearningSession,
  LearningSource,
} from "./learning.ts";
import { MAX_LEARNING_SOURCE_CHARACTERS } from "./learning.ts";
import {
  normalizeLearningResource,
  type LearningResource,
} from "./learning-research.ts";
import type { SpaceMeta } from "./types.ts";
import { isGroupParticipationLevel } from "./group-participation.ts";
import {
  parseKnowledgeGovernanceAuditRecord,
  type KnowledgeGovernanceAuditRecord,
} from "./knowledge-governance.ts";

export const SPACE_ARCHIVE_FORMAT = "homeagent.space" as const;
export const LEGACY_SPACE_ARCHIVE_FORMAT = "homebrain.space" as const;
export const LEGACY_SPACE_ARCHIVE_VERSION = 1 as const;
export const LEARNING_SPACE_ARCHIVE_VERSION = 2 as const;
export const ADAPTIVE_LEARNING_SPACE_ARCHIVE_VERSION = 3 as const;
export const KNOWLEDGE_GOVERNANCE_SPACE_ARCHIVE_VERSION = 4 as const;
export const TASK_RUN_HISTORY_SPACE_ARCHIVE_VERSION = 5 as const;
export const TASK_EXECUTION_SPACE_ARCHIVE_VERSION = 6 as const;
export const AGENT_SKILL_BINDINGS_SPACE_ARCHIVE_VERSION = 7 as const;
export const CHAT_RUN_HISTORY_SPACE_ARCHIVE_VERSION = 8 as const;
export const RUN_QUEUE_SPACE_ARCHIVE_VERSION = 9 as const;
export const SPACE_ARCHIVE_VERSION = RUN_QUEUE_SPACE_ARCHIVE_VERSION;

export interface MessageRetractionRecord {
  chatId: string;
  messageId: string;
  originalAuthor: string;
  retractedBy: string;
  createdAt: number;
}

/** Portable, versioned backup for one complete knowledge space. */
export interface SpaceArchiveV1 {
  format: typeof SPACE_ARCHIVE_FORMAT;
  version: typeof LEGACY_SPACE_ARCHIVE_VERSION;
  exportedAt: number;
  space: SpaceMeta;
  agent?: Agent;
  purpose: string;
  schema: string;
  pages: Page[];
  raw: RawRecord[];
  retractions: MessageRetractionRecord[];
  tasks: Task[];
  reminders: Reminder[];
}

export interface SpaceArchiveV2 extends Omit<SpaceArchiveV1, "version"> {
  version: typeof LEARNING_SPACE_ARCHIVE_VERSION;
  learning: LearningArchive;
}

export interface SpaceArchiveV3 extends Omit<SpaceArchiveV2, "version"> {
  version: typeof ADAPTIVE_LEARNING_SPACE_ARCHIVE_VERSION;
}

export interface SpaceArchiveV4 extends Omit<SpaceArchiveV3, "version"> {
  version: typeof KNOWLEDGE_GOVERNANCE_SPACE_ARCHIVE_VERSION;
  governanceAudit: KnowledgeGovernanceAuditRecord[];
}

export interface SpaceArchiveV5 extends Omit<SpaceArchiveV4, "version"> {
  version: typeof TASK_RUN_HISTORY_SPACE_ARCHIVE_VERSION;
  taskRuns: TaskRun[];
}

export interface SpaceArchiveV6 extends Omit<SpaceArchiveV5, "version"> {
  version: typeof TASK_EXECUTION_SPACE_ARCHIVE_VERSION;
}

export interface SpaceArchiveV7 extends Omit<SpaceArchiveV6, "version"> {
  version: typeof AGENT_SKILL_BINDINGS_SPACE_ARCHIVE_VERSION;
}

export interface SpaceArchiveV8 extends Omit<SpaceArchiveV7, "version"> {
  version: typeof CHAT_RUN_HISTORY_SPACE_ARCHIVE_VERSION;
  chatRuns: ChatRun[];
}

export interface SpaceArchiveV9 extends Omit<SpaceArchiveV8, "version"> {
  version: typeof RUN_QUEUE_SPACE_ARCHIVE_VERSION;
}

/** Current normalized archive shape returned by export and parsing. */
export type SpaceArchive = SpaceArchiveV9;

export interface SpaceDeleteResult {
  status: "deleted" | "not_found";
  space: SpaceMeta["id"];
  pagesDeleted: number;
  rawDeleted: number;
  tasksDeleted: number;
  remindersDeleted: number;
  learningPlansDeleted: number;
}

export interface RawRetentionReport {
  retentionDays: number;
  cutoff: number;
  deleted: number;
  bySpace: Record<string, number>;
}

const PAGE_TYPES: PageType[] = [
  "index",
  "overview",
  "log",
  "glossary",
  "entity",
  "concept",
  "source",
  "analysis",
];
const RAW_SOURCES: RawSource[] = ["message", "doc", "manual", "task", "learning"];
const ATTACHMENT_KINDS: Attachment["kind"][] = ["image", "pdf", "audio", "file"];

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function nonemptyText(value: unknown, label: string): string {
  const parsed = text(value, label);
  if (parsed.length === 0) throw new Error(`${label} must not be empty`);
  return parsed;
}

function assertUnique<T>(items: T[], key: (item: T) => string, label: string): void {
  const seen = new Set<string>();
  for (const item of items) {
    const value = key(item);
    if (seen.has(value)) throw new Error(`duplicate ${label}: ${value}`);
    seen.add(value);
  }
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be a string array`);
  }
  return [...value] as string[];
}

function optionalText(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : text(value, label);
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  return value === undefined ? undefined : boolean(value, label);
}

function optionalFiniteNumber(value: unknown, label: string): number | undefined {
  return value === undefined ? undefined : finiteNumber(value, label);
}

function reasoningEffort(value: unknown, model: string): Agent["reasoningEffort"] {
  if (value === undefined || value === "") return "";
  const effort = text(value, "agent.reasoningEffort") as Agent["reasoningEffort"];
  const valid = model
    ? isCodexReasoningEffortSupported(model, effort)
    : CODEX_REASONING_EFFORTS.includes(effort as (typeof CODEX_REASONING_EFFORTS)[number]);
  if (!valid) {
    throw new Error("agent.reasoningEffort is invalid");
  }
  return effort;
}

function safeSlug(value: unknown, label: string): string {
  const slug = text(value, label);
  const segments = slug.split("/");
  if (
    slug.length === 0 ||
    slug.length > 300 ||
    slug.startsWith("/") ||
    slug.includes("\\") ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`${label} is unsafe`);
  }
  return slug;
}

function parsePage(value: unknown, index: number): Page {
  const item = record(value, `pages[${index}]`);
  const type = text(item.type, `pages[${index}].type`) as PageType;
  if (!PAGE_TYPES.includes(type)) throw new Error(`pages[${index}].type is invalid`);
  return {
    slug: safeSlug(item.slug, `pages[${index}].slug`),
    type,
    title: text(item.title, `pages[${index}].title`),
    summary: text(item.summary, `pages[${index}].summary`),
    aliases: strings(item.aliases, `pages[${index}].aliases`),
    tags: strings(item.tags, `pages[${index}].tags`),
    sources: strings(item.sources, `pages[${index}].sources`),
    links: strings(item.links, `pages[${index}].links`),
    content: text(item.content, `pages[${index}].content`),
    updatedAt: finiteNumber(item.updatedAt, `pages[${index}].updatedAt`),
    contentHash: text(item.contentHash, `pages[${index}].contentHash`),
  };
}

function parseRaw(value: unknown, index: number, space: SpaceId): RawRecord {
  const item = record(value, `raw[${index}]`);
  const rawSpace = text(item.space, `raw[${index}].space`);
  if (rawSpace !== space) throw new Error(`raw[${index}].space does not match archive space`);
  const source = text(item.source, `raw[${index}].source`) as RawSource;
  if (!RAW_SOURCES.includes(source)) throw new Error(`raw[${index}].source is invalid`);
  if (!Array.isArray(item.attachments)) throw new Error(`raw[${index}].attachments must be an array`);
  const attachments = item.attachments.map((value, attachmentIndex) => {
    const attachment = record(value, `raw[${index}].attachments[${attachmentIndex}]`);
    const kind = text(attachment.kind, `raw[${index}].attachments[${attachmentIndex}].kind`) as Attachment["kind"];
    if (!ATTACHMENT_KINDS.includes(kind)) throw new Error(`raw[${index}].attachments[${attachmentIndex}].kind is invalid`);
    return {
      kind,
      ref: text(attachment.ref, `raw[${index}].attachments[${attachmentIndex}].ref`),
      name: optionalText(attachment.name, `raw[${index}].attachments[${attachmentIndex}].name`),
    };
  });
  return {
    id: nonemptyText(item.id, `raw[${index}].id`),
    space,
    source,
    agentId: optionalText(item.agentId, `raw[${index}].agentId`),
    agentHandled: optionalBoolean(item.agentHandled, `raw[${index}].agentHandled`),
    agentResponse: optionalText(item.agentResponse, `raw[${index}].agentResponse`),
    agentRespondedAt: optionalFiniteNumber(
      item.agentRespondedAt,
      `raw[${index}].agentRespondedAt`,
    ),
    author: optionalText(item.author, `raw[${index}].author`),
    chatId: optionalText(item.chatId, `raw[${index}].chatId`),
    messageId: optionalText(item.messageId, `raw[${index}].messageId`),
    content: text(item.content, `raw[${index}].content`),
    attachments,
    createdAt: finiteNumber(item.createdAt, `raw[${index}].createdAt`),
    ingested: boolean(item.ingested, `raw[${index}].ingested`),
  };
}

function parseAgent(
  value: unknown,
  defaultVisibility: Agent["visibility"],
  version: number,
): Agent {
  const item = record(value, "agent");
  const provider = text(item.provider, "agent.provider");
  if (!isCliProvider(provider)) throw new Error("agent.provider is invalid");
  const permission = text(item.permission, "agent.permission") as Agent["permission"];
  if (!AGENT_PERMISSIONS.includes(permission)) throw new Error("agent.permission is invalid");
  const visibility = (optionalText(item.visibility, "agent.visibility") ?? defaultVisibility) as Agent["visibility"];
  if (!AGENT_VISIBILITIES.includes(visibility)) throw new Error("agent.visibility is invalid");
  const model = text(item.model, "agent.model");
  return {
    id: nonemptyText(item.id, "agent.id"),
    name: text(item.name, "agent.name"),
    instruction: text(item.instruction, "agent.instruction"),
    model,
    reasoningEffort: reasoningEffort(item.reasoningEffort, model),
    provider,
    visibility,
    workdir: optionalText(item.workdir, "agent.workdir"),
    permission,
    skills: parseAgentSkills(item.skills, version),
    createdAt: finiteNumber(item.createdAt, "agent.createdAt"),
    updatedAt: finiteNumber(item.updatedAt, "agent.updatedAt"),
  };
}

function parseAgentSkills(value: unknown, version: number): AgentSkillBinding[] {
  if (version < AGENT_SKILL_BINDINGS_SPACE_ARCHIVE_VERSION) {
    return normalizeProviderSkills(strings(value, "agent.skills")).map((name) => ({
      kind: "legacy-name" as const,
      name,
    }));
  }
  if (!Array.isArray(value)) throw new Error("agent.skills must be an array");
  const bindings = value.map((entry, index): AgentSkillBinding => {
    const item = record(entry, `agent.skills[${index}]`);
    const kind = text(item.kind, `agent.skills[${index}].kind`);
    const name = text(item.name, `agent.skills[${index}].name`);
    if (!isAgentSkillName(name)) {
      throw new Error(`agent.skills[${index}].name is invalid`);
    }
    if (kind === "legacy-name") return { kind, name };
    if (kind !== "source") throw new Error(`agent.skills[${index}].kind is invalid`);
    const sourceKey = text(item.sourceKey, `agent.skills[${index}].sourceKey`);
    if (!isAgentSkillSourceKey(sourceKey)) {
      throw new Error(`agent.skills[${index}].sourceKey is invalid`);
    }
    return { kind, sourceKey, name };
  });
  assertUnique(
    bindings,
    (binding) => binding.kind === "source"
      ? `source:${binding.sourceKey}`
      : `legacy:${binding.name}`,
    "agent Skill binding",
  );
  return bindings;
}

function parseTask(value: unknown, index: number, space: SpaceId, version: number): Task {
  const item = record(value, `tasks[${index}]`);
  if (item.space !== space) throw new Error(`tasks[${index}].space does not match archive space`);
  const cadence = text(item.cadence, `tasks[${index}].cadence`) as Task["cadence"];
  if (!TASK_CADENCES.includes(cadence)) throw new Error(`tasks[${index}].cadence is invalid`);
  const lastStatus = optionalText(item.lastStatus, `tasks[${index}].lastStatus`) as Task["lastStatus"];
  if (lastStatus && lastStatus !== "ok" && lastStatus !== "error") {
    throw new Error(`tasks[${index}].lastStatus is invalid`);
  }
  const hour = finiteNumber(item.hour, `tasks[${index}].hour`);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new Error(`tasks[${index}].hour is invalid`);
  }
  const timeoutMinutes = item.timeoutMinutes === undefined
    && version < TASK_EXECUTION_SPACE_ARCHIVE_VERSION
    ? DEFAULT_TASK_TIMEOUT_MINUTES
    : finiteNumber(item.timeoutMinutes, `tasks[${index}].timeoutMinutes`);
  if (
    !Number.isInteger(timeoutMinutes)
    || timeoutMinutes < MIN_TASK_TIMEOUT_MINUTES
    || timeoutMinutes > MAX_TASK_TIMEOUT_MINUTES
  ) {
    throw new Error(`tasks[${index}].timeoutMinutes is invalid`);
  }
  return {
    id: nonemptyText(item.id, `tasks[${index}].id`),
    name: text(item.name, `tasks[${index}].name`),
    space,
    topic: text(item.topic, `tasks[${index}].topic`),
    cadence,
    hour,
    enabled: boolean(item.enabled, `tasks[${index}].enabled`),
    notify: boolean(item.notify, `tasks[${index}].notify`),
    distillOnRun: boolean(item.distillOnRun, `tasks[${index}].distillOnRun`),
    timeoutMinutes,
    lastRunAt: item.lastRunAt === undefined ? undefined : finiteNumber(item.lastRunAt, `tasks[${index}].lastRunAt`),
    lastStatus,
    lastError: optionalText(item.lastError, `tasks[${index}].lastError`),
    lastSummary: optionalText(item.lastSummary, `tasks[${index}].lastSummary`),
    createdAt: finiteNumber(item.createdAt, `tasks[${index}].createdAt`),
    updatedAt: finiteNumber(item.updatedAt, `tasks[${index}].updatedAt`),
  };
}

function parseTaskRunNotification(
  value: unknown,
  index: number,
): TaskRunNotification | undefined {
  if (value === undefined) return undefined;
  const item = record(value, `taskRuns[${index}].notification`);
  const status = text(
    item.status,
    `taskRuns[${index}].notification.status`,
  ) as TaskRunNotification["status"];
  if (!["pending", "sent", "failed"].includes(status)) {
    throw new Error(`taskRuns[${index}].notification.status is invalid`);
  }
  const attempts = finiteNumber(
    item.attempts,
    `taskRuns[${index}].notification.attempts`,
  );
  if (!Number.isInteger(attempts) || attempts < 0) {
    throw new Error(`taskRuns[${index}].notification.attempts is invalid`);
  }
  const notification: TaskRunNotification = {
    status,
    attempts,
    ...(item.lastAttemptAt === undefined ? {} : {
      lastAttemptAt: finiteNumber(
        item.lastAttemptAt,
        `taskRuns[${index}].notification.lastAttemptAt`,
      ),
    }),
    ...(item.nextAttemptAt === undefined ? {} : {
      nextAttemptAt: finiteNumber(
        item.nextAttemptAt,
        `taskRuns[${index}].notification.nextAttemptAt`,
      ),
    }),
    ...(item.sentAt === undefined ? {} : {
      sentAt: finiteNumber(item.sentAt, `taskRuns[${index}].notification.sentAt`),
    }),
    ...(item.error === undefined ? {} : {
      error: text(item.error, `taskRuns[${index}].notification.error`),
    }),
  };
  if (status === "sent" && notification.sentAt === undefined) {
    throw new Error(`taskRuns[${index}].notification.sentAt is required`);
  }
  if (status === "failed" && !notification.error) {
    throw new Error(`taskRuns[${index}].notification.error is required`);
  }
  if (
    notification.error
    && notification.error.length > MAX_TASK_RUN_ERROR_CHARACTERS
  ) {
    throw new Error(
      `taskRuns[${index}].notification.error exceeds ${MAX_TASK_RUN_ERROR_CHARACTERS} characters`,
    );
  }
  return notification;
}

function parseTaskRun(
  value: unknown,
  index: number,
  space: SpaceId,
  taskIds: Set<string>,
  version: number,
): TaskRun {
  const item = record(value, `taskRuns[${index}]`);
  if (item.space !== space) {
    throw new Error(`taskRuns[${index}].space does not match archive space`);
  }
  const taskId = nonemptyText(item.taskId, `taskRuns[${index}].taskId`);
  if (!taskIds.has(taskId)) throw new Error(`taskRuns[${index}].taskId is unknown`);
  const status = text(item.status, `taskRuns[${index}].status`) as TaskRun["status"];
  if (!["succeeded", "failed", "cancelled", "timed_out"].includes(status)) {
    throw new Error(`taskRuns[${index}].status is invalid`);
  }
  const trigger = text(item.trigger, `taskRuns[${index}].trigger`) as TaskRun["trigger"];
  if (!["manual", "scheduled", "chat", "retry"].includes(trigger)) {
    throw new Error(`taskRuns[${index}].trigger is invalid`);
  }
  const startedAt = finiteNumber(item.startedAt, `taskRuns[${index}].startedAt`);
  const priority = version < RUN_QUEUE_SPACE_ARCHIVE_VERSION
    ? trigger === "scheduled"
      ? "scheduled"
      : trigger === "chat"
        ? "interactive"
        : "manual"
    : text(item.priority, `taskRuns[${index}].priority`) as TaskRun["priority"];
  if (!["interactive", "manual", "scheduled", "background"].includes(priority)) {
    throw new Error(`taskRuns[${index}].priority is invalid`);
  }
  const queuedAt = version < RUN_QUEUE_SPACE_ARCHIVE_VERSION
    ? startedAt
    : finiteNumber(item.queuedAt, `taskRuns[${index}].queuedAt`);
  const runStartedAt = version < RUN_QUEUE_SPACE_ARCHIVE_VERSION
    ? startedAt
    : item.runStartedAt === undefined
      ? undefined
      : finiteNumber(item.runStartedAt, `taskRuns[${index}].runStartedAt`);
  if (
    queuedAt !== startedAt
    || (runStartedAt !== undefined && runStartedAt < queuedAt)
  ) {
    throw new Error(`taskRuns[${index}] queue timestamps are invalid`);
  }
  const finishedAt = finiteNumber(item.finishedAt, `taskRuns[${index}].finishedAt`);
  if (finishedAt < (runStartedAt ?? queuedAt)) {
    throw new Error(`taskRuns[${index}].finishedAt is invalid`);
  }
  const output = optionalText(item.output, `taskRuns[${index}].output`);
  if (output && output.length > MAX_TASK_RUN_OUTPUT_CHARACTERS) {
    throw new Error(
      `taskRuns[${index}].output exceeds ${MAX_TASK_RUN_OUTPUT_CHARACTERS} characters`,
    );
  }
  const pagesWritten = item.pagesWritten === undefined
    ? undefined
    : finiteNumber(item.pagesWritten, `taskRuns[${index}].pagesWritten`);
  if (pagesWritten !== undefined && (!Number.isInteger(pagesWritten) || pagesWritten < 0)) {
    throw new Error(`taskRuns[${index}].pagesWritten is invalid`);
  }
  const error = optionalText(item.error, `taskRuns[${index}].error`);
  if (status !== "succeeded" && !error) {
    throw new Error(`taskRuns[${index}].error is required`);
  }
  if (error && error.length > MAX_TASK_RUN_ERROR_CHARACTERS) {
    throw new Error(
      `taskRuns[${index}].error exceeds ${MAX_TASK_RUN_ERROR_CHARACTERS} characters`,
    );
  }
  const outputTruncated = item.outputTruncated === undefined
    ? undefined
    : boolean(item.outputTruncated, `taskRuns[${index}].outputTruncated`);
  if (outputTruncated && output === undefined) {
    throw new Error(`taskRuns[${index}].outputTruncated requires output`);
  }
  const timeoutMs = item.timeoutMs === undefined
    ? undefined
    : finiteNumber(item.timeoutMs, `taskRuns[${index}].timeoutMs`);
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs <= 0)) {
    throw new Error(`taskRuns[${index}].timeoutMs is invalid`);
  }
  const notify = item.notify === undefined
    ? undefined
    : boolean(item.notify, `taskRuns[${index}].notify`);
  const notification = parseTaskRunNotification(item.notification, index);
  if (notification && status !== "succeeded") {
    throw new Error(`taskRuns[${index}].notification requires a succeeded run`);
  }
  if (notification && notify === false) {
    throw new Error(`taskRuns[${index}].notification conflicts with notify=false`);
  }
  const provider = optionalText(item.provider, `taskRuns[${index}].provider`);
  if (provider !== undefined && !isCliProvider(provider)) {
    throw new Error(`taskRuns[${index}].provider is invalid`);
  }
  const skillEvidence = version < AGENT_SKILL_BINDINGS_SPACE_ARCHIVE_VERSION
    || item.skillEvidence === undefined
    ? undefined
    : (() => {
        if (!isTaskRunSkillEvidence(item.skillEvidence)) {
          throw new Error(`taskRuns[${index}].skillEvidence is invalid`);
        }
        return {
          requested: item.skillEvidence.requested.map((entry) => ({ ...entry })),
          resolved: item.skillEvidence.resolved.map((entry) => ({ ...entry })),
          skipped: item.skillEvidence.skipped.map((entry) => ({ ...entry })),
        };
      })();
  return {
    id: nonemptyText(item.id, `taskRuns[${index}].id`),
    taskId,
    taskName: text(item.taskName, `taskRuns[${index}].taskName`),
    space,
    topic: text(item.topic, `taskRuns[${index}].topic`),
    trigger,
    agentId: optionalText(item.agentId, `taskRuns[${index}].agentId`),
    provider,
    model: optionalText(item.model, `taskRuns[${index}].model`),
    skillEvidence,
    retryOf: optionalText(item.retryOf, `taskRuns[${index}].retryOf`),
    distill: boolean(item.distill, `taskRuns[${index}].distill`),
    notify,
    timeoutMs,
    priority,
    status,
    queuedAt,
    startedAt,
    runStartedAt,
    finishedAt,
    output,
    outputTruncated,
    summary: optionalText(item.summary, `taskRuns[${index}].summary`),
    error,
    rawId: optionalText(item.rawId, `taskRuns[${index}].rawId`),
    pagesWritten,
    notification,
  };
}

function parseChatRun(
  value: unknown,
  index: number,
  space: SpaceId,
  version: number,
): ChatRun {
  const legacy = record(value, `chatRuns[${index}]`);
  const normalized = version < RUN_QUEUE_SPACE_ARCHIVE_VERSION
    ? {
        ...legacy,
        priority: "interactive",
        queuedAt: legacy.startedAt,
        runStartedAt: legacy.startedAt,
      }
    : legacy;
  if (!isChatRun(normalized)) throw new Error(`chatRuns[${index}] is invalid`);
  if (normalized.space !== space) {
    throw new Error(`chatRuns[${index}].space does not match archive space`);
  }
  if (normalized.status === "queued" || normalized.status === "running") {
    throw new Error(`chatRuns[${index}] cannot restore an active record`);
  }
  return {
    id: nonemptyText(normalized.id, `chatRuns[${index}].id`),
    space,
    rawId: normalized.rawId,
    chatId: normalized.chatId,
    messageId: normalized.messageId,
    author: normalized.author,
    input: normalized.input,
    inputTruncated: normalized.inputTruncated,
    trigger: normalized.trigger,
    agentId: normalized.agentId,
    provider: normalized.provider,
    model: normalized.model,
    reasoningEffort: normalized.reasoningEffort,
    skillEvidence: normalized.skillEvidence
      ? {
          requested: normalized.skillEvidence.requested.map((item) => ({ ...item })),
          resolved: normalized.skillEvidence.resolved.map((item) => ({ ...item })),
          skipped: normalized.skillEvidence.skipped.map((item) => ({ ...item })),
        }
      : undefined,
    execution: normalized.execution
      ? { ...normalized.execution, skills: [...normalized.execution.skills] }
      : undefined,
    retryOf: normalized.retryOf,
    priority: normalized.priority,
    status: normalized.status,
    delivery: { ...normalized.delivery },
    queuedAt: normalized.queuedAt,
    startedAt: normalized.startedAt,
    runStartedAt: normalized.runStartedAt,
    finishedAt: normalized.finishedAt,
    output: normalized.output,
    outputTruncated: normalized.outputTruncated,
    traceId: normalized.traceId,
    error: normalized.error ? { ...normalized.error } : undefined,
  };
}

function parseReminder(value: unknown, index: number, space: SpaceId): Reminder {
  const item = record(value, `reminders[${index}]`);
  if (item.space !== space) {
    throw new Error(`reminders[${index}].space does not match archive space`);
  }
  const status = text(item.status, `reminders[${index}].status`) as Reminder["status"];
  if (!["scheduled", "completed", "cancelled"].includes(status)) {
    throw new Error(`reminders[${index}].status is invalid`);
  }
  const repeatEveryMs = item.repeatEveryMs === undefined
    ? undefined
    : finiteNumber(item.repeatEveryMs, `reminders[${index}].repeatEveryMs`);
  if (repeatEveryMs !== undefined && repeatEveryMs < 60_000) {
    throw new Error(`reminders[${index}].repeatEveryMs is invalid`);
  }
  const untilConfirmed = boolean(item.untilConfirmed, `reminders[${index}].untilConfirmed`);
  if (untilConfirmed && repeatEveryMs === undefined) {
    throw new Error(`reminders[${index}] requires repeatEveryMs`);
  }
  return {
    id: nonemptyText(item.id, `reminders[${index}].id`),
    title: nonemptyText(item.title, `reminders[${index}].title`),
    space,
    chatId: nonemptyText(item.chatId, `reminders[${index}].chatId`),
    creatorId: nonemptyText(item.creatorId, `reminders[${index}].creatorId`),
    triggerAt: finiteNumber(item.triggerAt, `reminders[${index}].triggerAt`),
    nextTriggerAt: finiteNumber(item.nextTriggerAt, `reminders[${index}].nextTriggerAt`),
    repeatEveryMs,
    untilConfirmed,
    status,
    sourceMessageId: optionalText(item.sourceMessageId, `reminders[${index}].sourceMessageId`),
    lastNotifiedAt: item.lastNotifiedAt === undefined
      ? undefined
      : finiteNumber(item.lastNotifiedAt, `reminders[${index}].lastNotifiedAt`),
    completedAt: item.completedAt === undefined
      ? undefined
      : finiteNumber(item.completedAt, `reminders[${index}].completedAt`),
    cancelledAt: item.cancelledAt === undefined
      ? undefined
      : finiteNumber(item.cancelledAt, `reminders[${index}].cancelledAt`),
    createdAt: finiteNumber(item.createdAt, `reminders[${index}].createdAt`),
    updatedAt: finiteNumber(item.updatedAt, `reminders[${index}].updatedAt`),
  };
}

function parseLearningSource(value: unknown, index: number, version: number): LearningSource {
  const item = record(value, `learning.sources[${index}]`);
  const content = nonemptyText(item.content, `learning.sources[${index}].content`);
  if (content.length > MAX_LEARNING_SOURCE_CHARACTERS) {
    throw new Error(
      `learning.sources[${index}].content exceeds ${MAX_LEARNING_SOURCE_CHARACTERS} characters`,
    );
  }
  const title = nonemptyText(item.title, `learning.sources[${index}].title`);
  const rawIds = strings(item.rawIds, `learning.sources[${index}].rawIds`);
  const messageId = nonemptyText(item.messageId, `learning.sources[${index}].messageId`);
  const createdAt = finiteNumber(item.createdAt, `learning.sources[${index}].createdAt`);
  const materials = version < ADAPTIVE_LEARNING_SPACE_ARCHIVE_VERSION
    ? rawIds.length > 0
      ? [{ title, rawIds: [...rawIds], messageId, startOffset: 0, endOffset: content.length, createdAt }]
      : []
    : (() => {
        if (!Array.isArray(item.materials)) {
          throw new Error(`learning.sources[${index}].materials must be an array`);
        }
        return item.materials.map((value, materialIndex) => {
          const material = record(
            value,
            `learning.sources[${index}].materials[${materialIndex}]`,
          );
          const startOffset = finiteNumber(
            material.startOffset,
            `learning.sources[${index}].materials[${materialIndex}].startOffset`,
          );
          const endOffset = finiteNumber(
            material.endOffset,
            `learning.sources[${index}].materials[${materialIndex}].endOffset`,
          );
          if (
            !Number.isInteger(startOffset) || !Number.isInteger(endOffset)
            || startOffset < 0 || endOffset <= startOffset || endOffset > content.length
          ) throw new Error(`learning.sources[${index}].materials[${materialIndex}] offsets are invalid`);
          return {
            title: nonemptyText(
              material.title,
              `learning.sources[${index}].materials[${materialIndex}].title`,
            ),
            rawIds: strings(
              material.rawIds,
              `learning.sources[${index}].materials[${materialIndex}].rawIds`,
            ),
            messageId: nonemptyText(
              material.messageId,
              `learning.sources[${index}].materials[${materialIndex}].messageId`,
            ),
            startOffset,
            endOffset,
            createdAt: finiteNumber(
              material.createdAt,
              `learning.sources[${index}].materials[${materialIndex}].createdAt`,
            ),
          };
        });
      })();
  return {
    id: nonemptyText(item.id, `learning.sources[${index}].id`),
    title,
    content,
    rawIds,
    messageId,
    materials,
    createdAt,
  };
}

function parseLearnerProfile(
  value: unknown,
  planIndex: number,
  fallbackAt: number,
): LearnerProfile {
  if (value === undefined) {
    return {
      status: "active",
      level: "unknown",
      levelRationale: "旧版计划尚未积累足够的水平判断证据",
      goals: [],
      strengths: [],
      gaps: [],
      preferences: [],
      pace: "steady",
      dailyMinutes: 25,
      evidence: [],
      revision: 0,
      updatedAt: fallbackAt,
    };
  }
  const label = `learning.plans[${planIndex}].profile`;
  const item = record(value, label);
  const status = text(item.status, `${label}.status`) as LearnerProfile["status"];
  const level = text(item.level, `${label}.level`) as LearnerProfile["level"];
  const pace = text(item.pace, `${label}.pace`) as LearnerProfile["pace"];
  const dailyMinutes = finiteNumber(item.dailyMinutes, `${label}.dailyMinutes`);
  const revision = finiteNumber(item.revision, `${label}.revision`);
  const bounded = (key: "goals" | "strengths" | "gaps" | "preferences" | "evidence") => {
    const parsed = strings(item[key], `${label}.${key}`);
    if (parsed.length > (key === "evidence" ? 24 : 12) || parsed.some((entry) => !entry.trim())) {
      throw new Error(`${label}.${key} is invalid`);
    }
    return parsed;
  };
  if (!["assessing", "active"].includes(status)) {
    throw new Error(`${label}.status is invalid`);
  }
  if (!["unknown", "beginner", "intermediate", "advanced"].includes(level)) {
    throw new Error(`${label}.level is invalid`);
  }
  if (!["gentle", "steady", "intensive"].includes(pace)) {
    throw new Error(`${label}.pace is invalid`);
  }
  if (!Number.isInteger(dailyMinutes) || dailyMinutes < 10 || dailyMinutes > 90) {
    throw new Error(`${label}.dailyMinutes is invalid`);
  }
  if (!Number.isInteger(revision) || revision < 0) {
    throw new Error(`${label}.revision is invalid`);
  }
  return {
    status,
    level,
    levelRationale: text(item.levelRationale, `${label}.levelRationale`),
    goals: bounded("goals"),
    strengths: bounded("strengths"),
    gaps: bounded("gaps"),
    preferences: bounded("preferences"),
    pace,
    dailyMinutes,
    evidence: bounded("evidence"),
    revision,
    updatedAt: item.updatedAt === undefined
      ? fallbackAt
      : finiteNumber(item.updatedAt, `${label}.updatedAt`),
  };
}

function parseLearningResources(
  value: unknown,
  planIndex: number,
  routeVersion: number,
): LearningResource[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 5) {
    throw new Error(`learning.plans[${planIndex}].onlineResources is invalid`);
  }
  const resources = value.map((entry, resourceIndex) => {
    const label = `learning.plans[${planIndex}].onlineResources[${resourceIndex}]`;
    const item = record(entry, label);
    const normalized = normalizeLearningResource(item);
    const resourceRouteVersion = finiteNumber(item.routeVersion, `${label}.routeVersion`);
    if (
      !normalized
      || !Number.isInteger(resourceRouteVersion)
      || resourceRouteVersion !== routeVersion
    ) throw new Error(`${label} is invalid`);
    return {
      ...normalized,
      id: nonemptyText(item.id, `${label}.id`),
      routeVersion: resourceRouteVersion,
      recommendedAt: finiteNumber(item.recommendedAt, `${label}.recommendedAt`),
    };
  });
  if (new Set(resources.map((resource) => resource.url)).size !== resources.length) {
    throw new Error(`learning.plans[${planIndex}].onlineResources is invalid`);
  }
  return resources;
}

function parseLearningPlan(
  value: unknown,
  index: number,
  space: SpaceId,
  version: number,
): LearningPlan {
  const item = record(value, `learning.plans[${index}]`);
  if (item.space !== space) {
    throw new Error(`learning.plans[${index}].space does not match archive space`);
  }
  const sourceLength = finiteNumber(item.sourceLength, `learning.plans[${index}].sourceLength`);
  const hour = finiteNumber(item.hour, `learning.plans[${index}].hour`);
  const dailyCharacters = finiteNumber(
    item.dailyCharacters,
    `learning.plans[${index}].dailyCharacters`,
  );
  const cursor = finiteNumber(item.cursor, `learning.plans[${index}].cursor`);
  if (!Number.isInteger(sourceLength) || sourceLength <= 0) {
    throw new Error(`learning.plans[${index}].sourceLength is invalid`);
  }
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new Error(`learning.plans[${index}].hour is invalid`);
  }
  if (!Number.isInteger(dailyCharacters) || dailyCharacters < 500 || dailyCharacters > 8000) {
    throw new Error(`learning.plans[${index}].dailyCharacters is invalid`);
  }
  if (!Number.isInteger(cursor) || cursor < 0 || cursor > sourceLength) {
    throw new Error(`learning.plans[${index}].cursor is invalid`);
  }
  const status = text(item.status, `learning.plans[${index}].status`) as LearningPlan["status"];
  if (!["active", "paused", "completed"].includes(status)) {
    throw new Error(`learning.plans[${index}].status is invalid`);
  }
  const mode = version < ADAPTIVE_LEARNING_SPACE_ARCHIVE_VERSION
    ? "reading" as const
    : text(item.mode, `learning.plans[${index}].mode`) as LearningPlan["mode"];
  if (!["reading", "topic"].includes(mode)) {
    throw new Error(`learning.plans[${index}].mode is invalid`);
  }
  const route = version < ADAPTIVE_LEARNING_SPACE_ARCHIVE_VERSION
    ? []
    : (() => {
        if (!Array.isArray(item.route)) {
          throw new Error(`learning.plans[${index}].route must be an array`);
        }
        return item.route.map((value, stepIndex) => {
          const step = record(value, `learning.plans[${index}].route[${stepIndex}]`);
          const stepStatus = text(
            step.status,
            `learning.plans[${index}].route[${stepIndex}].status`,
          ) as LearningPlan["route"][number]["status"];
          const attempts = finiteNumber(
            step.attempts,
            `learning.plans[${index}].route[${stepIndex}].attempts`,
          );
          if (!["pending", "active", "completed", "skipped"].includes(stepStatus)) {
            throw new Error(`learning.plans[${index}].route[${stepIndex}].status is invalid`);
          }
          if (!Number.isInteger(attempts) || attempts < 0) {
            throw new Error(`learning.plans[${index}].route[${stepIndex}].attempts is invalid`);
          }
          return {
            id: nonemptyText(step.id, `learning.plans[${index}].route[${stepIndex}].id`),
            title: nonemptyText(
              step.title,
              `learning.plans[${index}].route[${stepIndex}].title`,
            ),
            objective: nonemptyText(
              step.objective,
              `learning.plans[${index}].route[${stepIndex}].objective`,
            ),
            status: stepStatus,
            attempts,
          };
        });
      })();
  const routeIndex = version < ADAPTIVE_LEARNING_SPACE_ARCHIVE_VERSION
    ? 0
    : finiteNumber(item.routeIndex, `learning.plans[${index}].routeIndex`);
  if (!Number.isInteger(routeIndex) || routeIndex < 0 || routeIndex > route.length) {
    throw new Error(`learning.plans[${index}].routeIndex is invalid`);
  }
  const assessmentQuestions = mode === "topic" && item.assessmentQuestions !== undefined
    ? strings(item.assessmentQuestions, `learning.plans[${index}].assessmentQuestions`)
    : mode === "topic" ? [] : undefined;
  if (
    assessmentQuestions !== undefined
    && (
      assessmentQuestions.length > 6
      || assessmentQuestions.some((question) => !question.trim())
    )
  ) throw new Error(`learning.plans[${index}].assessmentQuestions is invalid`);
  const profile = mode === "topic"
    ? parseLearnerProfile(item.profile, index, finiteNumber(
        item.updatedAt,
        `learning.plans[${index}].updatedAt`,
      ))
    : undefined;
  const routeVersion = mode === "topic" && item.routeVersion !== undefined
    ? finiteNumber(item.routeVersion, `learning.plans[${index}].routeVersion`)
    : mode === "topic" ? 1 : undefined;
  if (
    routeVersion !== undefined
    && (!Number.isInteger(routeVersion) || routeVersion < 1)
  ) throw new Error(`learning.plans[${index}].routeVersion is invalid`);
  const onlineResources = mode === "topic"
    ? parseLearningResources(item.onlineResources, index, routeVersion!)
    : undefined;
  const resourceResearchVersion = mode === "topic" && item.resourceResearchVersion !== undefined
    ? finiteNumber(
        item.resourceResearchVersion,
        `learning.plans[${index}].resourceResearchVersion`,
      )
    : undefined;
  const resourceResearchAt = mode === "topic" && item.resourceResearchAt !== undefined
    ? finiteNumber(item.resourceResearchAt, `learning.plans[${index}].resourceResearchAt`)
    : undefined;
  const resourceResearchQuery = mode === "topic"
    ? optionalText(
        item.resourceResearchQuery,
        `learning.plans[${index}].resourceResearchQuery`,
      )
    : undefined;
  if (
    onlineResources !== undefined
    && (
      onlineResources.length === 0
        ? resourceResearchVersion !== undefined
          || resourceResearchAt !== undefined
          || resourceResearchQuery !== undefined
        : !Number.isInteger(resourceResearchVersion)
          || resourceResearchVersion !== routeVersion
          || resourceResearchAt === undefined
          || !resourceResearchQuery?.trim()
    )
  ) throw new Error(`learning.plans[${index}].resourceResearch is invalid`);
  return {
    id: nonemptyText(item.id, `learning.plans[${index}].id`),
    name: nonemptyText(item.name, `learning.plans[${index}].name`),
    space,
    creatorId: nonemptyText(item.creatorId, `learning.plans[${index}].creatorId`),
    chatId: nonemptyText(item.chatId, `learning.plans[${index}].chatId`),
    mode,
    topic: version < ADAPTIVE_LEARNING_SPACE_ARCHIVE_VERSION
      ? undefined
      : optionalText(item.topic, `learning.plans[${index}].topic`),
    route,
    routeIndex,
    adaptiveFocus: version < ADAPTIVE_LEARNING_SPACE_ARCHIVE_VERSION
      ? undefined
      : optionalText(item.adaptiveFocus, `learning.plans[${index}].adaptiveFocus`),
    assessmentQuestions,
    assessmentAnswers: mode === "topic"
      ? optionalText(item.assessmentAnswers, `learning.plans[${index}].assessmentAnswers`)
      : undefined,
    profile,
    routeVersion,
    lastRouteAdjustment: mode === "topic"
      ? optionalText(
          item.lastRouteAdjustment,
          `learning.plans[${index}].lastRouteAdjustment`,
        )
      : undefined,
    onlineResources,
    resourceResearchVersion,
    resourceResearchAt,
    resourceResearchQuery,
    sourceId: nonemptyText(item.sourceId, `learning.plans[${index}].sourceId`),
    sourceLength,
    hour,
    dailyCharacters,
    cursor,
    status,
    currentSessionId: optionalText(
      item.currentSessionId,
      `learning.plans[${index}].currentSessionId`,
    ),
    lastDeliveredAt: item.lastDeliveredAt === undefined
      ? undefined
      : finiteNumber(item.lastDeliveredAt, `learning.plans[${index}].lastDeliveredAt`),
    createdAt: finiteNumber(item.createdAt, `learning.plans[${index}].createdAt`),
    updatedAt: finiteNumber(item.updatedAt, `learning.plans[${index}].updatedAt`),
  };
}

function parseLearningSession(value: unknown, index: number, version: number): LearningSession {
  const item = record(value, `learning.sessions[${index}]`);
  const sequence = finiteNumber(item.sequence, `learning.sessions[${index}].sequence`);
  const startOffset = finiteNumber(item.startOffset, `learning.sessions[${index}].startOffset`);
  const endOffset = finiteNumber(item.endOffset, `learning.sessions[${index}].endOffset`);
  if (!Number.isInteger(sequence) || sequence < 1) {
    throw new Error(`learning.sessions[${index}].sequence is invalid`);
  }
  if (
    !Number.isInteger(startOffset) || !Number.isInteger(endOffset)
    || startOffset < 0 || endOffset <= startOffset
  ) {
    throw new Error(`learning.sessions[${index}] offsets are invalid`);
  }
  const status = text(
    item.status,
    `learning.sessions[${index}].status`,
  ) as LearningSession["status"];
  if (!["prepared", "awaiting_reply", "completed", "skipped"].includes(status)) {
    throw new Error(`learning.sessions[${index}].status is invalid`);
  }
  const mastery = version < ADAPTIVE_LEARNING_SPACE_ARCHIVE_VERSION || item.mastery === undefined
    ? undefined
    : text(item.mastery, `learning.sessions[${index}].mastery`) as LearningSession["mastery"];
  if (mastery !== undefined && !["review", "ready"].includes(mastery)) {
    throw new Error(`learning.sessions[${index}].mastery is invalid`);
  }
  return {
    id: nonemptyText(item.id, `learning.sessions[${index}].id`),
    planId: nonemptyText(item.planId, `learning.sessions[${index}].planId`),
    sequence,
    startOffset,
    endOffset,
    sectionTitle: nonemptyText(item.sectionTitle, `learning.sessions[${index}].sectionTitle`),
    excerpt: nonemptyText(item.excerpt, `learning.sessions[${index}].excerpt`),
    guide: nonemptyText(item.guide, `learning.sessions[${index}].guide`),
    status,
    learnerReply: optionalText(item.learnerReply, `learning.sessions[${index}].learnerReply`),
    feedback: optionalText(item.feedback, `learning.sessions[${index}].feedback`),
    routeStepId: version < ADAPTIVE_LEARNING_SPACE_ARCHIVE_VERSION
      ? undefined
      : optionalText(item.routeStepId, `learning.sessions[${index}].routeStepId`),
    mastery,
    nextFocus: version < ADAPTIVE_LEARNING_SPACE_ARCHIVE_VERSION
      ? undefined
      : optionalText(item.nextFocus, `learning.sessions[${index}].nextFocus`),
    routeAdjustment: version < ADAPTIVE_LEARNING_SPACE_ARCHIVE_VERSION
      ? undefined
      : optionalText(
          item.routeAdjustment,
          `learning.sessions[${index}].routeAdjustment`,
        ),
    preparedAt: finiteNumber(item.preparedAt, `learning.sessions[${index}].preparedAt`),
    deliveredAt: item.deliveredAt === undefined
      ? undefined
      : finiteNumber(item.deliveredAt, `learning.sessions[${index}].deliveredAt`),
    lastFollowUpAt: item.lastFollowUpAt === undefined
      ? undefined
      : finiteNumber(item.lastFollowUpAt, `learning.sessions[${index}].lastFollowUpAt`),
    followUpCount: item.followUpCount === undefined
      ? undefined
      : (() => {
          const count = finiteNumber(
            item.followUpCount,
            `learning.sessions[${index}].followUpCount`,
          );
          if (!Number.isInteger(count) || count < 0) {
            throw new Error(`learning.sessions[${index}].followUpCount is invalid`);
          }
          return count;
        })(),
    completedAt: item.completedAt === undefined
      ? undefined
      : finiteNumber(item.completedAt, `learning.sessions[${index}].completedAt`),
  };
}

function parseLearningArchive(
  value: unknown,
  version: number,
  space: SpaceId,
): LearningArchive {
  if (version === LEGACY_SPACE_ARCHIVE_VERSION) {
    return { plans: [], sources: [], sessions: [] };
  }
  const learning = record(value, "learning");
  if (
    !Array.isArray(learning.plans)
    || !Array.isArray(learning.sources)
    || !Array.isArray(learning.sessions)
  ) {
    throw new Error("learning collections must be arrays");
  }
  const plans = learning.plans.map(
    (item, index) => parseLearningPlan(item, index, space, version),
  );
  const sources = learning.sources.map(
    (item, index) => parseLearningSource(item, index, version),
  );
  const sessions = learning.sessions.map(
    (item, index) => parseLearningSession(item, index, version),
  );
  assertUnique(plans, (plan) => plan.id, "learning plan id");
  assertUnique(sources, (source) => source.id, "learning source id");
  assertUnique(sessions, (session) => session.id, "learning session id");
  assertUnique(sessions, (session) => `${session.planId}\0${session.sequence}`, "learning session sequence");
  assertUnique(plans, (plan) => plan.sourceId, "learning plan sourceId");
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const planById = new Map(plans.map((plan) => [plan.id, plan]));
  const sessionById = new Map(sessions.map((session) => [session.id, session]));
  for (const plan of plans) {
    const source = sourceById.get(plan.sourceId);
    if (!source) throw new Error(`learning plan sourceId is unknown: ${plan.sourceId}`);
    if (plan.sourceLength !== source.content.length) {
      throw new Error(`learning plan sourceLength does not match source: ${plan.id}`);
    }
    if (plan.currentSessionId) {
      const session = sessionById.get(plan.currentSessionId);
      if (!session || session.planId !== plan.id) {
        throw new Error(`learning plan currentSessionId is invalid: ${plan.id}`);
      }
    }
  }
  for (const session of sessions) {
    const plan = planById.get(session.planId);
    if (!plan) throw new Error(`learning session planId is unknown: ${session.planId}`);
    if (session.endOffset > plan.sourceLength) {
      throw new Error(`learning session exceeds source length: ${session.id}`);
    }
  }
  const referencedSourceIds = new Set(plans.map((plan) => plan.sourceId));
  if (sources.some((source) => !referencedSourceIds.has(source.id))) {
    throw new Error("learning source is not referenced by a plan");
  }
  return { plans, sources, sessions };
}

/** Validate and normalize untrusted JSON before any restore writes occur. */
export function parseSpaceArchive(value: unknown): SpaceArchive {
  const root = record(value, "archive");
  const version = root.version;
  if (
    (root.format !== SPACE_ARCHIVE_FORMAT && root.format !== LEGACY_SPACE_ARCHIVE_FORMAT)
    || (
      version !== LEGACY_SPACE_ARCHIVE_VERSION
      && version !== LEARNING_SPACE_ARCHIVE_VERSION
      && version !== ADAPTIVE_LEARNING_SPACE_ARCHIVE_VERSION
      && version !== KNOWLEDGE_GOVERNANCE_SPACE_ARCHIVE_VERSION
      && version !== TASK_RUN_HISTORY_SPACE_ARCHIVE_VERSION
      && version !== TASK_EXECUTION_SPACE_ARCHIVE_VERSION
      && version !== AGENT_SKILL_BINDINGS_SPACE_ARCHIVE_VERSION
      && version !== CHAT_RUN_HISTORY_SPACE_ARCHIVE_VERSION
      && version !== RUN_QUEUE_SPACE_ARCHIVE_VERSION
    )
  ) {
    throw new Error("unsupported space archive format or version");
  }
  const meta = record(root.space, "space");
  const id = text(meta.id, "space.id");
  if (!isSpaceId(id)) throw new Error("space.id is invalid");
  const participationLevel = optionalText(
    meta.participationLevel,
    "space.participationLevel",
  );
  if (participationLevel !== undefined && !isGroupParticipationLevel(participationLevel)) {
    throw new Error("space.participationLevel is invalid");
  }
  const space: SpaceMeta = {
    id,
    createdAt: finiteNumber(meta.createdAt, "space.createdAt"),
    lastDreamAt: meta.lastDreamAt === undefined ? undefined : finiteNumber(meta.lastDreamAt, "space.lastDreamAt"),
    chatId: optionalText(meta.chatId, "space.chatId"),
    name: optionalText(meta.name, "space.name"),
    agentId: optionalText(meta.agentId, "space.agentId"),
    replyInThread: meta.replyInThread === undefined ? undefined : boolean(meta.replyInThread, "space.replyInThread"),
    mentionsOnly: meta.mentionsOnly === undefined ? undefined : boolean(meta.mentionsOnly, "space.mentionsOnly"),
    participationLevel,
  };
  if (
    !Array.isArray(root.pages)
    || !Array.isArray(root.raw)
    || !Array.isArray(root.retractions)
    || !Array.isArray(root.tasks)
    || (root.reminders !== undefined && !Array.isArray(root.reminders))
    || (
      version >= KNOWLEDGE_GOVERNANCE_SPACE_ARCHIVE_VERSION
      && !Array.isArray(root.governanceAudit)
    )
    || (
      version >= TASK_RUN_HISTORY_SPACE_ARCHIVE_VERSION
      && !Array.isArray(root.taskRuns)
    )
    || (
      version >= CHAT_RUN_HISTORY_SPACE_ARCHIVE_VERSION
      && !Array.isArray(root.chatRuns)
    )
  ) {
    throw new Error("archive collections must be arrays");
  }
  const defaultVisibility = space.id.startsWith("personal/") ? "Personal" : "Team";
  const agent = root.agent === undefined
    ? undefined
    : parseAgent(root.agent, defaultVisibility, version);
  if (agent && agent.id !== space.agentId) {
    throw new Error("agent.id does not match space.agentId");
  }
  if (agent && !agentVisibleInSpace(agent, space.id)) {
    throw new Error("agent.visibility does not match archive space");
  }
  const pages = root.pages.map(parsePage);
  const raw = root.raw.map((item, index) => parseRaw(item, index, id));
  const retractions = root.retractions.map((value, index) => {
    const item = record(value, `retractions[${index}]`);
    return {
      chatId: nonemptyText(item.chatId, `retractions[${index}].chatId`),
      messageId: nonemptyText(item.messageId, `retractions[${index}].messageId`),
      originalAuthor: text(item.originalAuthor, `retractions[${index}].originalAuthor`),
      retractedBy: text(item.retractedBy, `retractions[${index}].retractedBy`),
      createdAt: finiteNumber(item.createdAt, `retractions[${index}].createdAt`),
    };
  });
  const tasks = root.tasks.map((item, index) => parseTask(item, index, id, version));
  const taskIds = new Set(tasks.map((task) => task.id));
  const taskRuns = version < TASK_RUN_HISTORY_SPACE_ARCHIVE_VERSION
    ? []
    : (root.taskRuns as unknown[]).map((item, index) =>
        parseTaskRun(item, index, id, taskIds, version)
      );
  const taskRunCounts = new Map<string, number>();
  for (const run of taskRuns) {
    const count = (taskRunCounts.get(run.taskId) ?? 0) + 1;
    if (count > MAX_TASK_RUN_HISTORY_PER_TASK) {
      throw new Error(
        `taskRuns exceeds ${MAX_TASK_RUN_HISTORY_PER_TASK} records for task ${run.taskId}`,
      );
    }
    taskRunCounts.set(run.taskId, count);
  }
  const rawIds = new Set(raw.map((entry) => entry.id));
  for (const run of taskRuns) {
    if (run.rawId && !rawIds.has(run.rawId)) {
      throw new Error(`task run rawId is unknown: ${run.id}`);
    }
  }
  const chatRuns = version < CHAT_RUN_HISTORY_SPACE_ARCHIVE_VERSION
    ? []
    : (root.chatRuns as unknown[]).map((item, index) =>
        parseChatRun(item, index, id, version)
      );
  const chatRunCounts = new Map<string, number>();
  for (const run of chatRuns) {
    const owner = run.agentId ? `agent:${run.agentId}` : `space:${run.space}`;
    const count = (chatRunCounts.get(owner) ?? 0) + 1;
    if (count > MAX_CHAT_RUN_HISTORY_PER_AGENT) {
      throw new Error(
        `chatRuns exceeds ${MAX_CHAT_RUN_HISTORY_PER_AGENT} records for ${owner}`,
      );
    }
    chatRunCounts.set(owner, count);
    if (run.rawId && !rawIds.has(run.rawId)) {
      throw new Error(`chat run rawId is unknown: ${run.id}`);
    }
  }
  const reminders = (root.reminders ?? []).map(
    (item: unknown, index: number) => parseReminder(item, index, id),
  );
  assertUnique(pages, (page) => page.slug, "page slug");
  assertUnique(raw, (entry) => entry.id, "raw id");
  assertUnique(retractions, (entry) => `${entry.chatId}\0${entry.messageId}`, "retraction");
  assertUnique(tasks, (task) => task.id, "task id");
  assertUnique(taskRuns, (run) => run.id, "task run id");
  assertUnique(chatRuns, (run) => run.id, "chat run id");
  assertUnique(reminders, (reminder) => reminder.id, "reminder id");
  const learning = parseLearningArchive(root.learning, version, id);
  const governanceAudit = version < KNOWLEDGE_GOVERNANCE_SPACE_ARCHIVE_VERSION
    ? []
    : (root.governanceAudit as unknown[]).map((item, index) =>
        parseKnowledgeGovernanceAuditRecord(item, index + 1, id)
      );
  assertUnique(governanceAudit, (record) => record.id, "governance audit id");
  return {
    format: SPACE_ARCHIVE_FORMAT,
    version: SPACE_ARCHIVE_VERSION,
    exportedAt: finiteNumber(root.exportedAt, "exportedAt"),
    space,
    agent,
    purpose: text(root.purpose, "purpose"),
    schema: text(root.schema, "schema"),
    pages,
    raw,
    retractions,
    tasks,
    taskRuns,
    chatRuns,
    reminders,
    learning,
    governanceAudit,
  };
}
