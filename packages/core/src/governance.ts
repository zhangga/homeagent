import {
  isSpaceId,
  type Attachment,
  type Page,
  type PageType,
  type RawAdmission,
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
import type { Agent, AgentRevision, AgentSkillBinding } from "./agents.ts";
import {
  AGENT_PERMISSIONS,
  AGENT_VISIBILITIES,
  MAX_AGENT_REVISION_HISTORY,
  agentVisibleInSpace,
  assertAgentRevisionHistory,
  isAgentSkillName,
  isAgentSkillSourceKey,
  isAgentRevision,
  materializeLegacyAgentRevisionHistory,
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
  MAX_TASK_RUN_APPROVER_CHARACTERS,
  LEGACY_TASK_RUN_APPROVAL_ACTOR,
  LEGACY_TASK_RUN_APPROVAL_REASON,
  TASK_RUN_APPROVAL_EXPIRY_ACTOR,
  TASK_RUN_APPROVAL_EXPIRY_REASON,
  isTaskRunFailure,
  isTaskRunRetry,
  isTaskRunSkillEvidence,
  type TaskRun,
  type TaskRunApproval,
  type TaskRunNotification,
} from "./task-runs.ts";
import {
  cloneAggregatedRunUsage,
  isAggregatedRunUsage,
} from "./usage.ts";
import {
  MAX_CHAT_RUN_HISTORY_PER_AGENT,
  isChatRun,
  type ChatRun,
} from "./chat-runs.ts";
import {
  cloneResolvedExecutionPlan,
  isResolvedExecutionPlan,
  type ResolvedExecutionPlan,
} from "./execution-plan.ts";
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
import {
  parseQualityArchive,
  type QualityArchive,
} from "./quality.ts";
import {
  isWorkItem,
  workActionBlockerMessage,
  type WorkItem,
} from "./work-items.ts";
import {
  isWorkAction,
  isWorkContinuationPolicy,
  parseWorkActionProviderReport,
  type WorkAction,
  type WorkActionAcceptance,
  type WorkActionExecutionCheck,
  type WorkContinuationPolicy,
} from "./work-continuation.ts";

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
export const RUN_EXECUTION_PLAN_SPACE_ARCHIVE_VERSION = 10 as const;
export const AGENT_LIFECYCLE_APPROVAL_SPACE_ARCHIVE_VERSION = 11 as const;
export const TASK_APPROVAL_EXPIRY_SPACE_ARCHIVE_VERSION = 12 as const;
export const TASK_RUN_RESILIENCE_SPACE_ARCHIVE_VERSION = 13 as const;
export const CHAT_QUALITY_TRACE_SPACE_ARCHIVE_VERSION = 14 as const;
export const WORK_CONTEXT_SPACE_ARCHIVE_VERSION = 15 as const;
export const RAW_ADMISSION_SPACE_ARCHIVE_VERSION = 16 as const;
export const SPACE_ARCHIVE_VERSION = RAW_ADMISSION_SPACE_ARCHIVE_VERSION;

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

export interface SpaceArchiveV10 extends Omit<SpaceArchiveV9, "version"> {
  version: typeof RUN_EXECUTION_PLAN_SPACE_ARCHIVE_VERSION;
}

export interface SpaceArchiveV11 extends Omit<SpaceArchiveV10, "version"> {
  version: typeof AGENT_LIFECYCLE_APPROVAL_SPACE_ARCHIVE_VERSION;
  agentRevisions: AgentRevision[];
}

export interface SpaceArchiveV12 extends Omit<SpaceArchiveV11, "version"> {
  version: typeof TASK_APPROVAL_EXPIRY_SPACE_ARCHIVE_VERSION;
}

export interface SpaceArchiveV13 extends Omit<SpaceArchiveV12, "version"> {
  version: typeof TASK_RUN_RESILIENCE_SPACE_ARCHIVE_VERSION;
}

export interface SpaceArchiveV14 extends Omit<SpaceArchiveV13, "version"> {
  version: typeof CHAT_QUALITY_TRACE_SPACE_ARCHIVE_VERSION;
  quality: QualityArchive;
}

export interface SpaceArchiveV15 extends Omit<SpaceArchiveV14, "version"> {
  version: typeof WORK_CONTEXT_SPACE_ARCHIVE_VERSION;
  workItems: WorkItem[];
  workActions: WorkAction[];
  workContinuationPolicies: WorkContinuationPolicy[];
}

export interface SpaceArchiveV16 extends Omit<SpaceArchiveV15, "version"> {
  version: typeof RAW_ADMISSION_SPACE_ARCHIVE_VERSION;
}

/** Current normalized archive shape returned by export and parsing. */
export type SpaceArchive = SpaceArchiveV16;

export interface SpaceDeleteResult {
  status: "deleted" | "not_found";
  space: SpaceMeta["id"];
  pagesDeleted: number;
  rawDeleted: number;
  tasksDeleted: number;
  workItemsDeleted: number;
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

function parseRaw(value: unknown, index: number, space: SpaceId, version: number): RawRecord {
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
  const admission = (version < RAW_ADMISSION_SPACE_ARCHIVE_VERSION
    ? "ready"
    : text(item.admission, `raw[${index}].admission`)) as RawAdmission;
  if (admission !== "ready" && admission !== "held" && admission !== "excluded") {
    throw new Error(`raw[${index}].admission is invalid`);
  }
  const workActionId = version < RAW_ADMISSION_SPACE_ARCHIVE_VERSION
    ? undefined
    : optionalText(item.workActionId, `raw[${index}].workActionId`);
  if (admission !== "ready" && (source !== "task" || !workActionId)) {
    throw new Error(
      `raw[${index}] ${admission} Raw must have task WorkAction provenance`,
    );
  }
  return {
    id: nonemptyText(item.id, `raw[${index}].id`),
    space,
    source,
    workItemId: version < WORK_CONTEXT_SPACE_ARCHIVE_VERSION
      ? undefined
      : optionalText(item.workItemId, `raw[${index}].workItemId`),
    workActionId,
    admission,
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
    publishedRevisionId: optionalText(
      item.publishedRevisionId,
      "agent.publishedRevisionId",
    ),
    createdAt: finiteNumber(item.createdAt, "agent.createdAt"),
    updatedAt: finiteNumber(item.updatedAt, "agent.updatedAt"),
  };
}

function expectedWorkActionRawAdmission(
  action: WorkAction,
  run: TaskRun,
): RawAdmission {
  const acceptance = action.acceptances?.find(
    (candidate) => candidate.taskRunId === run.id && candidate.rawId === run.rawId,
  );
  if (acceptance?.status === "accepted") return "ready";
  if (acceptance?.status === "rejected") return "excluded";
  if (acceptance?.status === "pending") return "held";
  if (["failed", "timed_out", "cancelled"].includes(run.status)) {
    return "excluded";
  }
  return action.status === "blocked" || action.status === "cancelled"
    ? "excluded"
    : "held";
}

function reconcileLegacyWorkActionAcceptanceRawEvidence(
  action: WorkAction,
  run: TaskRun,
  rawId: string,
): void {
  const acceptance = action.acceptances?.find(
    (candidate) => candidate.taskRunId === run.id,
  );
  if (!acceptance) return;
  if (acceptance.rawId !== undefined && acceptance.rawId !== rawId) {
    throw new Error(`work action acceptance Raw evidence conflicts with recovered Raw: ${run.id}`);
  }
  const rawEvidence = acceptance.report.evidence.filter(
    (evidence) => evidence.kind === "raw",
  );
  if (rawEvidence.some((evidence) => evidence.id !== rawId)) {
    throw new Error(`work action report Raw evidence conflicts with recovered Raw: ${run.id}`);
  }
  const captureCheck = acceptance.report.checks.at(-2);
  if (
    !captureCheck
    || captureCheck.name !== "执行输出已归档"
    || captureCheck.status === "not_run"
    || captureCheck.detail !== undefined
  ) {
    throw new Error(`work action report Raw check conflicts with recovered Raw: ${run.id}`);
  }
  acceptance.rawId = rawId;
  if (rawEvidence.length === 0) {
    acceptance.report.evidence.push({ kind: "raw", id: rawId });
  }
  captureCheck.status = "passed";
  if (acceptance.status !== "accepted") return;
  const checkpoint = action.checkpoint;
  if (!checkpoint || checkpoint.taskRunId !== run.id) {
    throw new Error(`work action checkpoint does not match recovered Raw: ${run.id}`);
  }
  if (checkpoint.rawId !== undefined && checkpoint.rawId !== rawId) {
    throw new Error(`work action checkpoint Raw evidence conflicts with recovered Raw: ${run.id}`);
  }
  checkpoint.rawId = rawId;
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

function parseAgentRevisions(
  value: unknown,
  agent: Agent | undefined,
  version: number,
): AgentRevision[] {
  if (version < AGENT_LIFECYCLE_APPROVAL_SPACE_ARCHIVE_VERSION) return [];
  if (!Array.isArray(value)) throw new Error("agentRevisions must be an array");
  if (value.length > MAX_AGENT_REVISION_HISTORY) {
    throw new Error(`agentRevisions exceeds ${MAX_AGENT_REVISION_HISTORY} revisions`);
  }
  if (!agent) {
    if (value.length > 0) throw new Error("agentRevisions requires agent");
    return [];
  }
  if (!agent.publishedRevisionId || value.length === 0) {
    throw new Error("agent published revision history is missing");
  }
  const history = value.map((entry, index): AgentRevision => {
    if (!isAgentRevision(entry, agent)) {
      throw new Error(`agentRevisions[${index}] is invalid`);
    }
    return {
      ...entry,
      snapshot: {
        ...entry.snapshot,
        skills: entry.snapshot.skills.map((binding) => ({ ...binding })),
      },
    };
  });
  assertAgentRevisionHistory(agent, history, "agentRevisions");
  return history;
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
  field: "notification" | "approvalNotification" = "notification",
): TaskRunNotification | undefined {
  if (value === undefined) return undefined;
  const label = `taskRuns[${index}].${field}`;
  const item = record(value, label);
  const status = text(
    item.status,
    `${label}.status`,
  ) as TaskRunNotification["status"];
  if (!["pending", "sent", "failed"].includes(status)) {
    throw new Error(`${label}.status is invalid`);
  }
  const attempts = finiteNumber(
    item.attempts,
    `${label}.attempts`,
  );
  if (!Number.isInteger(attempts) || attempts < 0) {
    throw new Error(`${label}.attempts is invalid`);
  }
  const notification: TaskRunNotification = {
    status,
    attempts,
    ...(item.lastAttemptAt === undefined ? {} : {
      lastAttemptAt: finiteNumber(
        item.lastAttemptAt,
        `${label}.lastAttemptAt`,
      ),
    }),
    ...(item.nextAttemptAt === undefined ? {} : {
      nextAttemptAt: finiteNumber(
        item.nextAttemptAt,
        `${label}.nextAttemptAt`,
      ),
    }),
    ...(item.sentAt === undefined ? {} : {
      sentAt: finiteNumber(item.sentAt, `${label}.sentAt`),
    }),
    ...(item.error === undefined ? {} : {
      error: text(item.error, `${label}.error`),
    }),
  };
  if (status === "sent" && notification.sentAt === undefined) {
    throw new Error(`${label}.sentAt is required`);
  }
  if (status === "failed" && !notification.error) {
    throw new Error(`${label}.error is required`);
  }
  if (
    notification.error
    && notification.error.length > MAX_TASK_RUN_ERROR_CHARACTERS
  ) {
    throw new Error(
      `${label}.error exceeds ${MAX_TASK_RUN_ERROR_CHARACTERS} characters`,
    );
  }
  return notification;
}

function parseTaskRunApproval(
  value: unknown,
  index: number,
  version: number,
): TaskRunApproval | undefined {
  if (
    version < AGENT_LIFECYCLE_APPROVAL_SPACE_ARCHIVE_VERSION
    || value === undefined
  ) {
    return undefined;
  }
  const item = record(value, `taskRuns[${index}].approval`);
  const status = text(
    item.status,
    `taskRuns[${index}].approval.status`,
  ) as TaskRunApproval["status"];
  if (
    status !== "approved"
    && status !== "rejected"
    && status !== "legacy"
    && !(
      version >= TASK_APPROVAL_EXPIRY_SPACE_ARCHIVE_VERSION
      && status === "expired"
    )
  ) {
    throw new Error(`taskRuns[${index}].approval.status is invalid`);
  }
  const requestedAt = finiteNumber(
    item.requestedAt,
    `taskRuns[${index}].approval.requestedAt`,
  );
  if (requestedAt < 0) {
    throw new Error(`taskRuns[${index}].approval.requestedAt is invalid`);
  }
  const expiresAt = item.expiresAt === undefined
    ? undefined
    : finiteNumber(item.expiresAt, `taskRuns[${index}].approval.expiresAt`);
  if (expiresAt !== undefined && expiresAt <= requestedAt) {
    throw new Error(`taskRuns[${index}].approval.expiresAt is invalid`);
  }
  const decidedAt = finiteNumber(
    item.decidedAt,
    `taskRuns[${index}].approval.decidedAt`,
  );
  if (decidedAt < requestedAt) {
    throw new Error(`taskRuns[${index}].approval timestamps are invalid`);
  }
  if (status === "approved" && expiresAt !== undefined && decidedAt >= expiresAt) {
    throw new Error(`taskRuns[${index}].approval was decided after expiry`);
  }
  const decidedBy = optionalText(
    item.decidedBy,
    `taskRuns[${index}].approval.decidedBy`,
  );
  if (
    decidedBy !== undefined
    && (decidedBy.length === 0 || decidedBy.length > MAX_TASK_RUN_APPROVER_CHARACTERS)
  ) {
    throw new Error(`taskRuns[${index}].approval.decidedBy is too long`);
  }
  const reason = optionalText(item.reason, `taskRuns[${index}].approval.reason`);
  if (reason && reason.length > MAX_TASK_RUN_ERROR_CHARACTERS) {
    throw new Error(`taskRuns[${index}].approval.reason is too long`);
  }
  if (
    status === "legacy"
    && (
      decidedBy !== LEGACY_TASK_RUN_APPROVAL_ACTOR
      || reason !== LEGACY_TASK_RUN_APPROVAL_REASON
    )
  ) {
    throw new Error(`taskRuns[${index}].legacy approval audit is invalid`);
  }
  if (
    status === "expired"
    && (
      expiresAt === undefined
      || decidedAt !== expiresAt
      || decidedBy !== TASK_RUN_APPROVAL_EXPIRY_ACTOR
      || reason !== TASK_RUN_APPROVAL_EXPIRY_REASON
    )
  ) {
    throw new Error(`taskRuns[${index}].expired approval audit is invalid`);
  }
  return { status, requestedAt, expiresAt, decidedAt, decidedBy, reason };
}

function parseRunExecutionPlan(
  value: unknown,
  label: string,
  version: number,
): ResolvedExecutionPlan | undefined {
  if (
    version < RUN_EXECUTION_PLAN_SPACE_ARCHIVE_VERSION
    || value === undefined
  ) {
    return undefined;
  }
  if (!isResolvedExecutionPlan(value)) {
    throw new Error(`${label} is invalid`);
  }
  return cloneResolvedExecutionPlan(value);
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
  const workActionId = version < WORK_CONTEXT_SPACE_ARCHIVE_VERSION
    ? undefined
    : optionalText(item.workActionId, `taskRuns[${index}].workActionId`);
  if (!taskIds.has(taskId) && !workActionId) {
    throw new Error(`taskRuns[${index}].taskId is unknown`);
  }
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
  const launchAdmission = item.launchAdmission === undefined
    ? undefined
    : text(item.launchAdmission, `taskRuns[${index}].launchAdmission`) as TaskRun["launchAdmission"];
  if (
    launchAdmission !== undefined
    && launchAdmission !== "pending"
    && launchAdmission !== "admitted"
  ) {
    throw new Error(`taskRuns[${index}].launchAdmission is invalid`);
  }
  if (launchAdmission === "pending" && status === "succeeded") {
    throw new Error(`taskRuns[${index}].pending launch admission cannot have succeeded`);
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
  const rawId = optionalText(item.rawId, `taskRuns[${index}].rawId`);
  const approvalNotification = version < TASK_APPROVAL_EXPIRY_SPACE_ARCHIVE_VERSION
    ? undefined
    : parseTaskRunNotification(item.approvalNotification, index, "approvalNotification");
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
  const executionPlan = parseRunExecutionPlan(
    item.executionPlan,
    `taskRuns[${index}].executionPlan`,
    version,
  );
  if (
    executionPlan !== undefined
    && executionPlan.execution === undefined
    && executionPlan.resolutionError === undefined
  ) {
    throw new Error(`taskRuns[${index}].executionPlan is invalid`);
  }
  const parsedApproval = parseTaskRunApproval(item.approval, index, version);
  const writableExecution = executionPlan?.execution?.permission !== undefined
    && executionPlan.execution.permission !== "read-only";
  const approval = parsedApproval ?? (
    version < AGENT_LIFECYCLE_APPROVAL_SPACE_ARCHIVE_VERSION
    && writableExecution
      ? {
          status: "legacy" as const,
          requestedAt: startedAt,
          decidedAt: finishedAt,
          decidedBy: LEGACY_TASK_RUN_APPROVAL_ACTOR,
          reason: LEGACY_TASK_RUN_APPROVAL_REASON,
        }
      : undefined
  );
  if (approval?.status === "rejected" && status !== "cancelled") {
    throw new Error(`taskRuns[${index}].rejected approval requires cancelled status`);
  }
  if (approval?.status === "expired" && status !== "cancelled") {
    throw new Error(`taskRuns[${index}].expired approval requires cancelled status`);
  }
  if (approval?.status === "expired" && approval.decidedAt !== finishedAt) {
    throw new Error(`taskRuns[${index}].expired approval must match finishedAt`);
  }
  if (approvalNotification && approval === undefined) {
    throw new Error(`taskRuns[${index}].approvalNotification requires approval`);
  }
  if (
    approval?.status === "approved"
    && runStartedAt !== undefined
    && approval.decidedAt! > runStartedAt
  ) {
    throw new Error(`taskRuns[${index}] started before approval`);
  }
  if (
    approval?.status === "approved"
    && approval.decidedAt! > finishedAt
  ) {
    throw new Error(`taskRuns[${index}] finished before approval`);
  }
  if (
    approval?.status === "legacy"
    && approval.decidedAt !== finishedAt
  ) {
    throw new Error(`taskRuns[${index}].legacy approval must match finishedAt`);
  }
  if (
    version >= AGENT_LIFECYCLE_APPROVAL_SPACE_ARCHIVE_VERSION
    && writableExecution
    && approval === undefined
  ) {
    throw new Error(`taskRuns[${index}].approval is required for writable execution`);
  }
  const failure = version < TASK_RUN_RESILIENCE_SPACE_ARCHIVE_VERSION
    || item.failure === undefined
    ? undefined
    : (() => {
        if (!isTaskRunFailure(item.failure)) {
          throw new Error(`taskRuns[${index}].failure is invalid`);
        }
        return { ...item.failure };
      })();
  const retry = version < TASK_RUN_RESILIENCE_SPACE_ARCHIVE_VERSION
    || item.retry === undefined
    ? undefined
    : (() => {
        if (!isTaskRunRetry(item.retry)) {
          throw new Error(`taskRuns[${index}].retry is invalid`);
        }
        if (item.retry.status === "waiting") {
          throw new Error(`taskRuns[${index}].retry cannot restore waiting execution`);
        }
        return { ...item.retry };
      })();
  const usage = version < TASK_RUN_RESILIENCE_SPACE_ARCHIVE_VERSION
    || item.usage === undefined
    ? undefined
    : (() => {
        if (!isAggregatedRunUsage(item.usage)) {
          throw new Error(`taskRuns[${index}].usage is invalid`);
        }
        return cloneAggregatedRunUsage(item.usage);
      })();
  if (failure !== undefined && status === "succeeded") {
    throw new Error(`taskRuns[${index}].failure conflicts with succeeded status`);
  }
  if (retry?.status === "exhausted" && status !== "failed") {
    throw new Error(`taskRuns[${index}].retry exhausted requires failed status`);
  }
  if (
    retry !== undefined
    && (
      executionPlan?.execution?.permission !== "read-only"
      || (trigger !== "scheduled" && trigger !== "retry")
    )
  ) {
    throw new Error(`taskRuns[${index}].retry is not eligible for automatic execution`);
  }
  if (
    retry?.claimedByRunId !== undefined
    && (
      status !== "failed"
      || failure?.phase !== "provider"
      || !failure.retryable
      || output !== undefined
      || rawId !== undefined
    )
  ) {
    throw new Error(`taskRuns[${index}].retry claim audit is invalid`);
  }
  return {
    id: nonemptyText(item.id, `taskRuns[${index}].id`),
    taskId,
    taskName: text(item.taskName, `taskRuns[${index}].taskName`),
    space,
    workItemId: version < WORK_CONTEXT_SPACE_ARCHIVE_VERSION
      ? undefined
      : optionalText(item.workItemId, `taskRuns[${index}].workItemId`),
    workActionId,
    topic: text(item.topic, `taskRuns[${index}].topic`),
    trigger,
    agentId: optionalText(item.agentId, `taskRuns[${index}].agentId`),
    provider,
    model: optionalText(item.model, `taskRuns[${index}].model`),
    executionPlan,
    skillEvidence,
    retryOf: optionalText(item.retryOf, `taskRuns[${index}].retryOf`),
    distill: boolean(item.distill, `taskRuns[${index}].distill`),
    notify,
    timeoutMs,
    priority,
    launchAdmission,
    status,
    approval,
    approvalNotification,
    queuedAt,
    startedAt,
    runStartedAt,
    finishedAt,
    output,
    outputTruncated,
    summary: optionalText(item.summary, `taskRuns[${index}].summary`),
    error,
    failure,
    retry,
    usage,
    rawId,
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
  const normalized = {
    ...legacy,
    ...(version < RUN_QUEUE_SPACE_ARCHIVE_VERSION
      ? {
          priority: "interactive",
          queuedAt: legacy.startedAt,
          runStartedAt: legacy.startedAt,
        }
      : {}),
    executionPlan: parseRunExecutionPlan(
      legacy.executionPlan,
      `chatRuns[${index}].executionPlan`,
      version,
    ),
    usage: version < TASK_RUN_RESILIENCE_SPACE_ARCHIVE_VERSION
      ? undefined
      : legacy.usage,
  };
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
    workItemId: version < WORK_CONTEXT_SPACE_ARCHIVE_VERSION
      ? undefined
      : normalized.workItemId,
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
    executionPlan: normalized.executionPlan
      ? cloneResolvedExecutionPlan(normalized.executionPlan)
      : undefined,
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
    traceId: version < CHAT_QUALITY_TRACE_SPACE_ARCHIVE_VERSION
      ? undefined
      : normalized.traceId,
    usage: normalized.usage
      ? cloneAggregatedRunUsage(normalized.usage)
      : undefined,
    error: normalized.error ? { ...normalized.error } : undefined,
  };
}

function parseWorkItem(value: unknown, index: number, space: SpaceId): WorkItem {
  if (!isWorkItem(value)) throw new Error(`workItems[${index}] is invalid`);
  if (value.space !== space) {
    throw new Error(`workItems[${index}].space does not match archive space`);
  }
  return {
    ...value,
    blockers: [...value.blockers],
    nextActions: [...value.nextActions],
    rawIds: [...value.rawIds],
    pageSlugs: [...value.pageSlugs],
    chatRunIds: [...value.chatRunIds],
    taskRunIds: [...value.taskRunIds],
    completedActionIds: [...(value.completedActionIds ?? [])],
    actionBlockers: { ...(value.actionBlockers ?? {}) },
  };
}

function parseWorkAction(value: unknown, index: number, space: SpaceId): WorkAction {
  if (!isWorkAction(value)) throw new Error(`workActions[${index}] is invalid`);
  if (value.space !== space) {
    throw new Error(`workActions[${index}].space does not match archive space`);
  }
  if (["queued", "awaiting_approval", "running", "awaiting_acceptance"].includes(value.status)) {
    throw new Error(`workActions[${index}] cannot restore an active action`);
  }
  if (value.status === "succeeded" && !value.checkpoint) {
    throw new Error(`workActions[${index}] succeeded without a checkpoint`);
  }
  if (value.status === "blocked" && !value.error) {
    throw new Error(`workActions[${index}] blocked without an error`);
  }
  return {
    ...value,
    taskRunIds: [...value.taskRunIds],
    acceptances: value.acceptances?.map((acceptance) => ({
      ...acceptance,
      report: {
        ...acceptance.report,
        blockers: [...acceptance.report.blockers],
        checks: acceptance.report.checks.map((check) => ({ ...check })),
        evidence: acceptance.report.evidence.map((evidence) => ({ ...evidence })),
      },
    })),
    checkpoint: value.checkpoint ? { ...value.checkpoint } : undefined,
  };
}

function sameWorkActionCheck(
  actual: WorkActionExecutionCheck,
  expected: WorkActionExecutionCheck,
): boolean {
  return actual.name === expected.name
    && actual.status === expected.status
    && actual.detail === expected.detail;
}

function workActionAcceptanceMatchesRunOutput(
  acceptance: WorkActionAcceptance,
  run: TaskRun,
): boolean {
  const providerReport = parseWorkActionProviderReport(run.output ?? "");
  const expectedSummary = (providerReport?.result ?? run.output ?? "").slice(0, 200);
  const expectedChecks: WorkActionExecutionCheck[] = [
    {
      name: "结构化执行报告",
      status: providerReport ? "passed" : "failed",
      detail: providerReport
        ? undefined
        : "Provider 未返回可校验的 WorkAction JSON 报告，禁止自动验收",
    },
    ...(providerReport?.checks ?? []),
    { name: "Task Run 成功结束", status: "passed" },
    {
      name: "执行输出已归档",
      status: run.rawId ? "passed" : "failed",
    },
    {
      name: "执行输出未截断",
      status: run.outputTruncated ? "failed" : "passed",
    },
  ];
  const expectedBlockers = providerReport?.blockers ?? [];
  return run.summary === expectedSummary
    && acceptance.report.outcome === (providerReport?.outcome ?? "unverified")
    && acceptance.report.result === expectedSummary
    && acceptance.report.blockers.length === expectedBlockers.length
    && acceptance.report.blockers.every((blocker, index) => blocker === expectedBlockers[index])
    && acceptance.report.checks.length === expectedChecks.length
    && acceptance.report.checks.every((check, index) => (
      sameWorkActionCheck(check, expectedChecks[index]!)
    ));
}

function parseWorkContinuationPolicy(
  value: unknown,
  index: number,
  space: SpaceId,
): WorkContinuationPolicy {
  if (!isWorkContinuationPolicy(value)) {
    throw new Error(`workContinuationPolicies[${index}] is invalid`);
  }
  if (value.space !== space) {
    throw new Error(
      `workContinuationPolicies[${index}].space does not match archive space`,
    );
  }
  return { ...value };
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
      && version !== RUN_EXECUTION_PLAN_SPACE_ARCHIVE_VERSION
      && version !== AGENT_LIFECYCLE_APPROVAL_SPACE_ARCHIVE_VERSION
      && version !== TASK_APPROVAL_EXPIRY_SPACE_ARCHIVE_VERSION
      && version !== TASK_RUN_RESILIENCE_SPACE_ARCHIVE_VERSION
      && version !== CHAT_QUALITY_TRACE_SPACE_ARCHIVE_VERSION
      && version !== WORK_CONTEXT_SPACE_ARCHIVE_VERSION
      && version !== RAW_ADMISSION_SPACE_ARCHIVE_VERSION
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
    || (
      version >= AGENT_LIFECYCLE_APPROVAL_SPACE_ARCHIVE_VERSION
      && !Array.isArray(root.agentRevisions)
    )
    || (
      version >= WORK_CONTEXT_SPACE_ARCHIVE_VERSION
      && !Array.isArray(root.workItems)
    )
  ) {
    throw new Error("archive collections must be arrays");
  }
  const defaultVisibility = space.id.startsWith("personal/") ? "Personal" : "Team";
  const parsedAgent = root.agent === undefined
    ? undefined
    : parseAgent(root.agent, defaultVisibility, version);
  if (parsedAgent && parsedAgent.id !== space.agentId) {
    throw new Error("agent.id does not match space.agentId");
  }
  if (parsedAgent && !agentVisibleInSpace(parsedAgent, space.id)) {
    throw new Error("agent.visibility does not match archive space");
  }
  const legacyAgentHistory = parsedAgent
    && version < AGENT_LIFECYCLE_APPROVAL_SPACE_ARCHIVE_VERSION
    ? materializeLegacyAgentRevisionHistory(parsedAgent)
    : undefined;
  const agent = legacyAgentHistory?.agent ?? parsedAgent;
  const agentRevisions = legacyAgentHistory?.revisions
    ?? parseAgentRevisions(root.agentRevisions, agent, version);
  const pages = root.pages.map(parsePage);
  const raw = root.raw.map((item, index) => parseRaw(item, index, id, version));
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
  const rawById = new Map(raw.map((entry) => [entry.id, entry]));
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
  const workItems = version < WORK_CONTEXT_SPACE_ARCHIVE_VERSION
    ? []
    : (root.workItems as unknown[]).map((item, index) => parseWorkItem(item, index, id));
  const workItemById = new Map(workItems.map((item) => [item.id, item]));
  const workActions = version < WORK_CONTEXT_SPACE_ARCHIVE_VERSION
    ? []
    : ((root.workActions ?? []) as unknown[]).map((item, index) =>
        parseWorkAction(item, index, id)
      );
  const workActionById = new Map(workActions.map((action) => [action.id, action]));
  const workContinuationPolicies = version < WORK_CONTEXT_SPACE_ARCHIVE_VERSION
    ? []
    : ((root.workContinuationPolicies ?? []) as unknown[]).map((item, index) =>
        parseWorkContinuationPolicy(item, index, id)
      );
  if (workItems.filter((item) => item.active).length > 1) {
    throw new Error("archive has multiple active work items for one space");
  }
  for (const entry of raw) {
    if (
      entry.workActionId
      && (entry.source !== "task" || !workActionById.has(entry.workActionId))
    ) {
      throw new Error(`Raw WorkAction association is invalid: ${entry.id}`);
    }
    if (!entry.workItemId) continue;
    const item = workItemById.get(entry.workItemId);
    if (!item || !item.rawIds.includes(entry.id)) {
      throw new Error(`raw work item association is invalid: ${entry.id}`);
    }
  }
  for (const run of taskRuns) {
    if (!run.workItemId) continue;
    const item = workItemById.get(run.workItemId);
    if (!item || !item.taskRunIds.includes(run.id)) {
      throw new Error(`task run work item association is invalid: ${run.id}`);
    }
  }
  const taskRunById = new Map(taskRuns.map((run) => [run.id, run]));
  const pageBySlug = new Map(pages.map((page) => [page.slug, page]));
  const legacyReferencedRawIds = version < RAW_ADMISSION_SPACE_ARCHIVE_VERSION
    ? new Set(taskRuns.flatMap((run) => run.rawId ? [run.rawId] : []))
    : undefined;
  for (const action of workActions) {
    const item = workItemById.get(action.workItemId);
    if (!item) throw new Error(`work action workItemId is unknown: ${action.id}`);
    for (const runId of action.taskRunIds) {
      const run = taskRunById.get(runId);
      if (
        !run
        || run.workActionId !== action.id
        || run.workItemId !== action.workItemId
        || run.taskId !== action.id
      ) {
        throw new Error(`work action task run association is invalid: ${action.id}`);
      }
    }
    if (legacyReferencedRawIds) {
      for (const [runIndex, runId] of action.taskRunIds.entries()) {
        const run = taskRunById.get(runId)!;
        if (run.rawId) continue;
        const nextRun = taskRunById.get(action.taskRunIds[runIndex + 1] ?? "");
        const prefix = `# 任务研究：${run.taskName}\n主题：${run.topic}\n\n`;
        const legacyCandidates = raw.filter((entry) =>
          entry.source === "task"
          && entry.workActionId === undefined
          && entry.workItemId === action.workItemId
          && !legacyReferencedRawIds.has(entry.id)
          && entry.createdAt >= run.startedAt
          && (run.finishedAt === undefined || entry.createdAt <= run.finishedAt)
          && (nextRun === undefined || entry.createdAt < nextRun.startedAt)
          && entry.content.startsWith(prefix)
        );
        if (legacyCandidates.length > 1) {
          throw new Error(`work action Raw evidence is ambiguous: ${run.id}`);
        }
        const recovered = legacyCandidates[0];
        if (recovered) {
          reconcileLegacyWorkActionAcceptanceRawEvidence(action, run, recovered.id);
          run.rawId = recovered.id;
          legacyReferencedRawIds.add(recovered.id);
        }
      }
    }
    if (action.checkpoint?.rawId && !rawIds.has(action.checkpoint.rawId)) {
      throw new Error(`work action checkpoint rawId is unknown: ${action.id}`);
    }
    for (const acceptance of action.acceptances ?? []) {
      const run = taskRunById.get(acceptance.taskRunId);
      if (!run || run.status !== "succeeded" || run.finishedAt === undefined) {
        throw new Error(`work action acceptance run is invalid: ${action.id}`);
      }
      if (
        acceptance.requestedAt !== run.finishedAt
        || acceptance.rawId !== run.rawId
        || acceptance.summary !== run.summary
      ) {
        throw new Error(`work action acceptance result does not match its run: ${action.id}`);
      }
      if (!workActionAcceptanceMatchesRunOutput(acceptance, run)) {
        throw new Error(
          `work action acceptance report does not match its run output: ${action.id}`,
        );
      }
      const permission = run.executionPlan?.execution?.permission ?? "unknown";
      if (acceptance.permission !== permission) {
        throw new Error(`work action acceptance permission is invalid: ${action.id}`);
      }
      if (
        acceptance.status === "accepted"
        && acceptance.mode === "automatic"
        && (
          acceptance.permission !== "read-only"
          || !acceptance.rawId
          || acceptance.report.outcome !== "completed"
          || run.outputTruncated === true
          || acceptance.report.checks.some((check) => check.status !== "passed")
        )
      ) {
        throw new Error(`work action automatic acceptance is unsafe: ${action.id}`);
      }
      for (const evidence of acceptance.report.evidence) {
        if (evidence.kind === "task_run" && evidence.id !== run.id) {
          throw new Error(`work action task run evidence is invalid: ${action.id}`);
        }
        if (evidence.kind === "raw" && evidence.id !== run.rawId) {
          throw new Error(`work action raw evidence is invalid: ${action.id}`);
        }
        if (evidence.kind === "page") {
          const page = pageBySlug.get(evidence.id);
          if (!page || !run.rawId || !page.sources.includes(run.rawId)) {
            throw new Error(`work action page evidence is invalid: ${action.id}`);
          }
        }
      }
    }
    const accepted = action.acceptances?.at(-1);
    if (action.checkpoint && accepted?.status === "accepted") {
      if (
        action.checkpoint.taskRunId !== accepted.taskRunId
        || action.checkpoint.summary !== accepted.summary
        || action.checkpoint.rawId !== accepted.rawId
        || action.checkpoint.completedAt !== accepted.decidedAt
      ) {
        throw new Error(`work action checkpoint acceptance is invalid: ${action.id}`);
      }
    }
    if (action.status === "succeeded" && !item.completedActionIds?.includes(action.id)) {
      throw new Error(`completed work action is not projected into its work item: ${action.id}`);
    }
    const projectedBlocker = action.error
      ? workActionBlockerMessage(action.instruction, action.error)
      : undefined;
    if (
      action.status === "blocked"
      && (item.actionBlockers?.[action.id] !== projectedBlocker
        || !item.blockers.includes(projectedBlocker!))
    ) {
      throw new Error(`blocked work action is not projected into its work item: ${action.id}`);
    }
  }
  for (const item of workItems) {
    for (const actionId of item.completedActionIds ?? []) {
      const action = workActionById.get(actionId);
      if (!action || action.workItemId !== item.id || action.status !== "succeeded") {
        throw new Error(`completed work action is invalid: ${actionId}`);
      }
    }
    for (const [actionId, blocker] of Object.entries(item.actionBlockers ?? {})) {
      const action = workActionById.get(actionId);
      if (
        !action
        || action.workItemId !== item.id
        || action.status !== "blocked"
        || !action.error
        || workActionBlockerMessage(action.instruction, action.error) !== blocker
        || !item.blockers.includes(blocker)
      ) {
        throw new Error(`blocked work action is invalid: ${actionId}`);
      }
    }
  }
  for (const run of taskRuns) {
    if (!run.workActionId) continue;
    const action = workActionById.get(run.workActionId);
    if (!action || !action.taskRunIds.includes(run.id)) {
      throw new Error(`task run work action association is invalid: ${run.id}`);
    }
  }
  const workActionRunByRawId = new Map<string, TaskRun>();
  for (const run of taskRuns) {
    if (!run.workActionId || !run.rawId) continue;
    const previous = workActionRunByRawId.get(run.rawId);
    if (previous && previous.id !== run.id) {
      throw new Error(`Raw WorkAction association is ambiguous: ${run.rawId}`);
    }
    workActionRunByRawId.set(run.rawId, run);
    const entry = rawById.get(run.rawId)!;
    const action = workActionById.get(run.workActionId)!;
    const item = run.workItemId ? workItemById.get(run.workItemId) : undefined;
    if (
      !item
      || entry.workItemId !== run.workItemId
      || !item.rawIds.includes(entry.id)
    ) {
      throw new Error(`Raw WorkItem association is invalid: ${entry.id}`);
    }
    const expectedAdmission = expectedWorkActionRawAdmission(action, run);
    if (version < RAW_ADMISSION_SPACE_ARCHIVE_VERSION) {
      entry.workActionId = run.workActionId;
      entry.admission = expectedAdmission;
    } else if (
      entry.source !== "task"
      || entry.workActionId !== run.workActionId
      || entry.admission !== expectedAdmission
    ) {
      throw new Error(`Raw admission does not match WorkAction evidence: ${entry.id}`);
    }
  }
  for (const entry of raw) {
    if (entry.workActionId && !workActionRunByRawId.has(entry.id)) {
      throw new Error(`Raw WorkAction association is invalid: ${entry.id}`);
    }
  }
  const pollutedPages = pages.filter((page) =>
    page.sources.some((sourceId) => {
      const source = rawById.get(sourceId);
      return source !== undefined && source.admission !== "ready";
    })
  );
  if (pollutedPages.length > 0 && version >= RAW_ADMISSION_SPACE_ARCHIVE_VERSION) {
    throw new Error(
      `page sources non-ready Raw: ${pollutedPages[0]!.slug}`,
    );
  }
  if (pollutedPages.length > 0) {
    const removedSlugs = new Set([
      ...pollutedPages.map((page) => page.slug),
      "index",
      "glossary",
      "overview",
    ]);
    for (const page of pollutedPages) {
      for (const sourceId of page.sources) {
        const source = rawById.get(sourceId);
        if (source?.admission === "ready") source.ingested = false;
      }
    }
    for (let index = pages.length - 1; index >= 0; index -= 1) {
      if (removedSlugs.has(pages[index]!.slug)) pages.splice(index, 1);
    }
    for (const item of workItems) {
      item.pageSlugs = item.pageSlugs.filter((slug) => !removedSlugs.has(slug));
    }
    for (const action of workActions) {
      for (const acceptance of action.acceptances ?? []) {
        acceptance.report.evidence = acceptance.report.evidence.filter(
          (evidence) => evidence.kind !== "page" || !removedSlugs.has(evidence.id),
        );
      }
    }
  }
  for (const policy of workContinuationPolicies) {
    if (!workItemById.has(policy.workItemId)) {
      throw new Error(`work continuation policy workItemId is unknown: ${policy.workItemId}`);
    }
  }
  for (const run of chatRuns) {
    if (!run.workItemId) continue;
    const item = workItemById.get(run.workItemId);
    if (!item || !item.chatRunIds.includes(run.id)) {
      throw new Error(`chat run work item association is invalid: ${run.id}`);
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
  assertUnique(workItems, (item) => item.id, "work item id");
  assertUnique(workActions, (item) => item.id, "work action id");
  assertUnique(workContinuationPolicies, (item) => item.workItemId, "work continuation policy");
  assertUnique(reminders, (reminder) => reminder.id, "reminder id");
  const quality = version < CHAT_QUALITY_TRACE_SPACE_ARCHIVE_VERSION
    ? { traces: [], reruns: [] }
    : parseQualityArchive(root.quality);
  const traceById = new Map(quality.traces.map((trace) => [trace.id, trace]));
  const directTraceIds = new Set<string>();
  const chatRunById = new Map(chatRuns.map((run) => [run.id, run]));
  for (const run of chatRuns) {
    if (!run.traceId) continue;
    const trace = traceById.get(run.traceId);
    if (!trace) {
      throw new Error(`chat run trace is missing from quality archive: ${run.id}`);
    }
    if (!trace.spaces.includes(run.space)) {
      throw new Error(`chat run trace does not include its archive space: ${run.id}`);
    }
    directTraceIds.add(run.traceId);
  }
  const candidateTraceIds = new Set<string>();
  for (const rerun of quality.reruns) {
    const sourceRun = chatRunById.get(rerun.sourceChatRunId);
    if (!sourceRun || sourceRun.traceId !== rerun.sourceTraceId) {
      throw new Error(`quality rerun does not match an archived chat run: ${rerun.id}`);
    }
    if (rerun.candidateTraceId) candidateTraceIds.add(rerun.candidateTraceId);
  }
  for (const trace of quality.traces) {
    if (!directTraceIds.has(trace.id) && !candidateTraceIds.has(trace.id)) {
      throw new Error(`quality archive contains an unrelated trace: ${trace.id}`);
    }
  }
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
    agentRevisions,
    purpose: text(root.purpose, "purpose"),
    schema: text(root.schema, "schema"),
    pages,
    raw,
    retractions,
    tasks,
    taskRuns,
    chatRuns,
    workItems,
    workActions,
    workContinuationPolicies,
    quality,
    reminders,
    learning,
    governanceAudit,
  };
}
