import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { deflateSync } from "node:zlib";
import {
  recordSoakEvidence,
  type FeishuSoakScenario,
  type SoakEvidence,
} from "./soak-runtime.ts";

export const AUTOMATED_FEISHU_SOAK_SCENARIOS = [
  "group_binding_lifecycle",
  "message_capture",
  "mention_answer",
  "proactive_participation",
  "image_analysis",
  "attachment_extraction",
  "research_notification",
  "reminder_delivery",
  "learning_interaction",
  "distill_citation",
  "agent_revision_lifecycle",
  "writable_task_approval",
  "readonly_task_retry",
] as const;

export type AutomatedScenario = (typeof AUTOMATED_FEISHU_SOAK_SCENARIOS)[number];
export const AGENT_PLATFORM_SOAK_SCENARIOS = [
  "agent_revision_lifecycle",
  "writable_task_approval",
  "readonly_task_retry",
] as const;
export type AgentPlatformScenario = (typeof AGENT_PLATFORM_SOAK_SCENARIOS)[number];

function isAgentPlatformScenario(value: AutomatedScenario): value is AgentPlatformScenario {
  return (AGENT_PLATFORM_SOAK_SCENARIOS as readonly string[]).includes(value);
}

export interface LarkMessage {
  message_id: string;
  content?: string;
  create_time?: string;
  thread_id?: string;
  sender?: {
    id?: string;
    sender_type?: string;
    open_bot_id?: string;
  };
  thread_replies?: LarkMessage[];
}

export interface LarkMessagePage {
  messages: LarkMessage[];
  hasMore: boolean;
  pageToken?: string;
}

interface LarkCliEnvelope {
  ok?: boolean;
  data?: unknown;
  error?: {
    message?: string;
    hint?: string;
    subtype?: string;
    missing_scopes?: string[];
  };
  [key: string]: unknown;
}

export interface StoredTask {
  id: string;
  name: string;
  space: string;
  topic?: string;
  cadence?: string;
  hour?: number;
  enabled?: boolean;
  notify?: boolean;
  distillOnRun?: boolean;
  timeoutMinutes?: number;
}

export interface StoredTaskRun {
  id: string;
  taskId: string;
  taskName?: string;
  space?: string;
  topic?: string;
  status: string;
  trigger?: string;
  agentId?: string;
  provider?: string;
  model?: string;
  executionPlan?: {
    version?: number;
    agentRevisionId?: string;
    instruction: string;
    provider?: string;
    model?: string;
    reasoningEffort?: string;
    execution?: {
      permission?: string;
      workdir?: string;
      skills?: string[];
      webSearch?: boolean;
    };
    resolutionError?: string;
  };
  skillEvidence?: unknown;
  distill?: boolean;
  notify?: boolean;
  timeoutMs?: number;
  priority?: string;
  startedAt: number;
  runStartedAt?: number;
  finishedAt?: number;
  output?: string;
  summary?: string;
  usage?: unknown;
  rawId?: string;
  pagesWritten?: number;
  failure?: {
    phase?: string;
    kind?: string;
    retryable?: boolean;
  };
  retry?: {
    attempt?: number;
    maxAttempts?: number;
    status?: string;
    nextAttemptAt?: number;
    claimedByRunId?: string;
  };
  retryOf?: string;
  approval?: {
    status?: string;
    requestedAt?: number;
    expiresAt?: number;
    decidedAt?: number;
    decidedBy?: string;
  };
  approvalNotification?: {
    status?: string;
    attempts?: number;
    sentAt?: number;
  };
  notification?: {
    status?: string;
    sentAt?: number;
  };
}

interface StoredReminder {
  id: string;
  title: string;
  sourceMessageId?: string;
  lastNotifiedAt?: number;
  status: string;
}

export interface StoredLearningPlan {
  id: string;
  name: string;
  chatId: string;
  creatorId: string;
}

export interface StoredLearningSession {
  id: string;
  planId: string;
  status: string;
  deliveredAt?: number;
  completedAt?: number;
}

interface ResearchEvidence {
  task: StoredTask;
  run: StoredTaskRun;
  noticeMessageId?: string;
}

interface LarkProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

type ProcessRunner = (args: string[], cwd: string) => Promise<LarkProcessResult>;

export interface FeishuSoakDriverOptions {
  chatId: string;
  botOpenId: string;
  dataDir: string;
  evidencePath: string;
  monitorPath: string;
  windowStartedAt?: number;
  adminUrl: string;
  adminToken?: string;
  researchTaskName?: string;
  approvalExpiredRunId?: string;
  approvalIdempotencyRunId?: string;
  retryTaskId?: string;
  retryBusinessMarker?: string;
  scenarios: AutomatedScenario[];
  responseTimeoutMs: number;
  longTimeoutMs: number;
  sender: "api" | "ui";
  dryRun: boolean;
}

interface StoredFeishuBinding {
  chatId: string;
  spaceId: string;
  state: "active" | "disconnected" | "needs_reconnect";
  boundAppId?: string;
  responseMode: "mentions_only" | "smart" | "all_messages";
  participationLevel?: "reserved" | "balanced" | "active";
  replyInThread: boolean;
}

interface StoredSpaceMeta {
  id: string;
  agentId?: string;
}

export interface FeishuSoakAdminFormRequest {
  adminUrl: string;
  adminToken?: string;
  path: string;
  form: Record<string, string>;
  fetchImpl?: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
}

export interface FeishuSoakAdminFormResponse {
  status: number;
  location: string;
}

export interface UiUserAction {
  type: "soak_user_action";
  action: "send_text" | "reply_text" | "send_image" | "send_file";
  chatId: string;
  text?: string;
  mentionBot?: boolean;
  rootMessageId?: string;
  path?: string;
}

interface ScenarioResult {
  scenario: AutomatedScenario;
  ok: boolean;
  artifactId?: string;
  error?: string;
}

class LarkCliError extends Error {
  readonly envelope?: LarkCliEnvelope;

  constructor(message: string, envelope?: LarkCliEnvelope) {
    super(message);
    this.name = "LarkCliError";
    this.envelope = envelope;
  }
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function parseLarkCliResult(stdout: string): LarkCliEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    throw new LarkCliError("lark-cli returned invalid JSON");
  }
  const envelope = object(parsed) as LarkCliEnvelope;
  if (envelope.ok === false) {
    const message = envelope.error?.message?.trim() || "lark-cli request failed";
    const hint = envelope.error?.hint?.trim();
    throw new LarkCliError(hint ? `${message}. ${hint}` : message, envelope);
  }
  return envelope;
}

export function flattenLarkMessages(messages: LarkMessage[]): LarkMessage[] {
  const flattened: LarkMessage[] = [];
  const seen = new Set<string>();
  const visit = (candidate: LarkMessage) => {
    if (candidate.message_id && !seen.has(candidate.message_id)) {
      seen.add(candidate.message_id);
      flattened.push(candidate);
    }
    for (const reply of candidate.thread_replies ?? []) visit(reply);
  };
  for (const candidate of messages) visit(candidate);
  return flattened;
}

function isBotMessage(message: LarkMessage, botOpenId: string): boolean {
  return message.sender?.open_bot_id === botOpenId
    || (message.sender?.sender_type === "app" && message.sender?.id === botOpenId);
}

export function findBotReply(
  messages: LarkMessage[],
  options: {
    botOpenId: string;
    rootMessageId: string;
    contentIncludes?: string[];
    contentPattern?: RegExp;
  },
): LarkMessage | undefined {
  const root = flattenLarkMessages(messages).find(
    (message) => message.message_id === options.rootMessageId,
  );
  if (!root) return undefined;
  const candidates = flattenLarkMessages(root.thread_replies ?? []);
  return candidates.find((candidate) => {
    if (!isBotMessage(candidate, options.botOpenId)) return false;
    const content = candidate.content ?? "";
    if (options.contentIncludes?.some((part) => !content.includes(part))) return false;
    if (options.contentPattern && !options.contentPattern.test(content)) return false;
    return !looksLikeFailureReply(content);
  });
}

function looksLikeFailureReply(content: string): boolean {
  return /(?:暂时不可用|尚未配置可用的\s*CLI|运行失败|请求超时|稍后重试|provider unavailable)/iu
    .test(content);
}

export function isTransientLarkFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:HTTP\s*429|Too Many Requests|rate.?limit|invalid (?:response|JSON)|unexpected end of JSON|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|temporarily unavailable|timeout)/iu
    .test(message);
}

export async function executeVerifiedScenario(
  scenario: FeishuSoakScenario,
  evidencePath: string,
  verify: () => Promise<string>,
): Promise<SoakEvidence> {
  const artifactId = (await verify()).trim();
  if (!artifactId) throw new Error(`${scenario} did not produce an artifact id`);
  return recordSoakEvidence(evidencePath, { scenario, ok: true, artifactId });
}

export interface AgentPlatformSoakEvidence {
  at: number;
  scenario: AgentPlatformScenario;
  ok: true;
  artifactId: string;
  details?: Record<string, unknown>;
}

function sha256Evidence(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function safeEvidenceString(value: unknown): string | undefined {
  return typeof value === "string"
      && value.length > 0
      && value.length <= 200
      && !/[\r\n]/u.test(value)
    ? value
    : undefined;
}

function safeEvidenceNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Strictly allowlist non-sensitive metadata before writing the shared sidecar. */
export function sanitizeAgentPlatformEvidenceDetails(
  value: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!value) return undefined;
  const result: Record<string, unknown> = {};
  const triggerPath = safeEvidenceString(value.triggerPath);
  if (["web_admin_post", "production_scheduler_retry"].includes(triggerPath ?? "")) {
    result.triggerPath = triggerPath;
  }
  const windowStartedAt = safeEvidenceNumber(value.windowStartedAt);
  if (windowStartedAt !== undefined) result.windowStartedAt = windowStartedAt;

  const resourceSource = object(value.resourceIds);
  const resourceIds: Record<string, string> = {};
  for (const key of [
    "agentId",
    "taskId",
    "firstRevisionId",
    "secondRevisionId",
    "rollbackRevisionId",
    "secondRevisionRunId",
    "rollbackRunId",
    "approvedRunId",
    "rejectedRunId",
    "expiredRunId",
    "idempotencyRunId",
    "parentRunId",
    "retryRunId",
  ]) {
    const id = safeEvidenceString(resourceSource[key]);
    if (id) resourceIds[key] = id;
  }
  if (Object.keys(resourceIds).length > 0) result.resourceIds = resourceIds;

  const revisions = Array.isArray(value.revisions)
    ? value.revisions.slice(0, 10).flatMap((candidate) => {
      const revision = object(candidate);
      const id = safeEvidenceString(revision.id);
      const source = safeEvidenceString(revision.source);
      const snapshotSha256 = safeEvidenceString(revision.snapshotSha256);
      if (!id || !source || !/^[a-f0-9]{64}$/u.test(snapshotSha256 ?? "")) return [];
      const basedOnRevisionId = safeEvidenceString(revision.basedOnRevisionId);
      return [{ id, source, snapshotSha256, ...(basedOnRevisionId ? { basedOnRevisionId } : {}) }];
    })
    : [];
  if (revisions.length > 0) result.revisions = revisions;

  const allowedRunStrings = [
    "id", "taskId", "status", "trigger", "agentId", "agentRevisionId",
    "executionPlanSha256", "outputSha256", "notificationStatus", "approvalStatus",
    "approvalNotificationStatus", "failurePhase", "failureKind", "retryStatus",
    "retryClaimedByRunId", "retryOf", "rawId",
  ] as const;
  const allowedRunNumbers = [
    "startedAt", "runStartedAt", "finishedAt", "notificationSentAt",
    "approvalRequestedAt", "approvalExpiresAt", "approvalDecidedAt",
    "approvalNotificationAttempts", "approvalNotificationSentAt", "retryAttempt",
    "retryMaxAttempts", "pagesWritten",
  ] as const;
  const runs = Array.isArray(value.runs)
    ? value.runs.slice(0, 10).flatMap((candidate) => {
      const run = object(candidate);
      const id = safeEvidenceString(run.id);
      if (!id) return [];
      const safe: Record<string, unknown> = { id };
      for (const key of allowedRunStrings) {
        const field = safeEvidenceString(run[key]);
        if (
          field
          && (!key.endsWith("Sha256") || /^[a-f0-9]{64}$/u.test(field))
        ) safe[key] = field;
      }
      for (const key of allowedRunNumbers) {
        const field = safeEvidenceNumber(run[key]);
        if (field !== undefined) safe[key] = field;
      }
      if (typeof run.failureRetryable === "boolean") {
        safe.failureRetryable = run.failureRetryable;
      }
      return [safe];
    })
    : [];
  if (runs.length > 0) result.runs = runs;

  const messages = Array.isArray(value.messages)
    ? value.messages.slice(0, 20).flatMap((candidate) => {
      const message = object(candidate);
      const id = safeEvidenceString(message.id);
      const contentSha256 = safeEvidenceString(message.contentSha256);
      if (!id || !/^[a-f0-9]{64}$/u.test(contentSha256 ?? "")) return [];
      const createTime = safeEvidenceString(message.createTime);
      return [{ id, contentSha256, ...(createTime ? { createTime } : {}) }];
    })
    : [];
  if (messages.length > 0) result.messages = messages;
  return result;
}

function durableRunMetadata(run: StoredTaskRun): Record<string, unknown> {
  return {
    id: run.id,
    taskId: run.taskId,
    status: run.status,
    ...(run.trigger ? { trigger: run.trigger } : {}),
    ...(run.agentId ? { agentId: run.agentId } : {}),
    ...(run.executionPlan?.agentRevisionId
      ? { agentRevisionId: run.executionPlan.agentRevisionId }
      : {}),
    executionPlanSha256: sha256Evidence(run.executionPlan ?? null),
    outputSha256: sha256Evidence([run.output ?? null, run.summary ?? null]),
    startedAt: run.startedAt,
    ...(run.runStartedAt !== undefined ? { runStartedAt: run.runStartedAt } : {}),
    ...(run.finishedAt !== undefined ? { finishedAt: run.finishedAt } : {}),
    ...(run.notification?.status ? { notificationStatus: run.notification.status } : {}),
    ...(run.notification?.sentAt !== undefined
      ? { notificationSentAt: run.notification.sentAt }
      : {}),
    ...(run.approval?.status ? { approvalStatus: run.approval.status } : {}),
    ...(run.approval?.requestedAt !== undefined
      ? { approvalRequestedAt: run.approval.requestedAt }
      : {}),
    ...(run.approval?.expiresAt !== undefined
      ? { approvalExpiresAt: run.approval.expiresAt }
      : {}),
    ...(run.approval?.decidedAt !== undefined
      ? { approvalDecidedAt: run.approval.decidedAt }
      : {}),
    ...(run.approvalNotification?.status
      ? { approvalNotificationStatus: run.approvalNotification.status }
      : {}),
    ...(run.approvalNotification?.attempts !== undefined
      ? { approvalNotificationAttempts: run.approvalNotification.attempts }
      : {}),
    ...(run.approvalNotification?.sentAt !== undefined
      ? { approvalNotificationSentAt: run.approvalNotification.sentAt }
      : {}),
    ...(run.failure?.phase ? { failurePhase: run.failure.phase } : {}),
    ...(run.failure?.kind ? { failureKind: run.failure.kind } : {}),
    ...(run.failure?.retryable !== undefined
      ? { failureRetryable: run.failure.retryable }
      : {}),
    ...(run.retry?.attempt !== undefined ? { retryAttempt: run.retry.attempt } : {}),
    ...(run.retry?.maxAttempts !== undefined
      ? { retryMaxAttempts: run.retry.maxAttempts }
      : {}),
    ...(run.retry?.status ? { retryStatus: run.retry.status } : {}),
    ...(run.retry?.claimedByRunId
      ? { retryClaimedByRunId: run.retry.claimedByRunId }
      : {}),
    ...(run.retryOf ? { retryOf: run.retryOf } : {}),
    ...(run.rawId ? { rawId: run.rawId } : {}),
    ...(run.pagesWritten !== undefined ? { pagesWritten: run.pagesWritten } : {}),
  };
}

function durableMessageMetadata(message: LarkMessage): Record<string, unknown> {
  return {
    id: message.message_id,
    contentSha256: sha256Evidence(message.content ?? ""),
    ...(message.create_time ? { createTime: message.create_time } : {}),
  };
}

export interface AgentPlatformSoakFailureEvidence {
  at: number;
  scenario: AgentPlatformScenario;
  ok: false;
  artifactId: string;
  reason: string;
  cleanupErrors: string[];
  manualRecovery: string;
}

export type SoakCleanupEntry = {
  scenario: AgentPlatformScenario;
  label: string;
  manualRecovery: string;
  interrupt: (reason: string) => void;
  cleanup: () => Promise<string[]>;
};

export type SoakCleanupRegistration = {
  cleanup: () => Promise<string[]>;
};

type RegisteredSoakCleanup = SoakCleanupEntry & {
  token: symbol;
  cleanupPromise?: Promise<string[]>;
};

export interface SoakCleanupFailure {
  scenario: AgentPlatformScenario;
  label: string;
  cleanupErrors: string[];
  manualRecovery: string;
}

/**
 * Process-wide ownership registry for acceptance resources. Registrations are
 * made before the first mutation and cleanup is idempotent so a signal and the
 * scenario's normal finally path can safely race.
 */
export class SoakCleanupRegistry {
  private readonly entries = new Map<symbol, RegisteredSoakCleanup>();

  get size(): number {
    return this.entries.size;
  }

  register(entry: SoakCleanupEntry): SoakCleanupRegistration {
    const token = Symbol(entry.label);
    const registered: RegisteredSoakCleanup = { ...entry, token };
    this.entries.set(token, registered);
    return {
      cleanup: () => this.cleanupEntry(registered),
    };
  }

  private async cleanupEntry(entry: RegisteredSoakCleanup): Promise<string[]> {
    if (entry.cleanupPromise) return entry.cleanupPromise;
    const attempt = Promise.resolve()
      .then(entry.cleanup)
      .catch((error) => [`cleanup threw: ${safeError(error)}`]);
    entry.cleanupPromise = attempt;
    const errors = await attempt;
    if (entry.cleanupPromise === attempt) {
      entry.cleanupPromise = undefined;
      if (errors.length === 0) this.entries.delete(entry.token);
    }
    return errors;
  }

  async shutdown(reason: string, timeoutMs: number): Promise<SoakCleanupFailure[]> {
    const entries = [...this.entries.values()].reverse();
    for (const entry of entries) {
      try {
        entry.interrupt(reason);
      } catch {
        // Cleanup still has a chance to make the owned production state safe.
      }
    }
    if (entries.length === 0) return [];

    const boundedMs = Math.max(1, timeoutMs);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolveTimeout) => {
      timeout = setTimeout(() => resolveTimeout("timeout"), boundedMs);
    });
    const completed = (async () => {
      const results: Array<{ entry: RegisteredSoakCleanup; errors: string[] }> = [];
      for (const entry of entries) {
        results.push({ entry, errors: await this.cleanupEntry(entry) });
      }
      return results;
    })();
    const outcome = await Promise.race([completed, timedOut]);
    if (timeout) clearTimeout(timeout);

    if (outcome === "timeout") {
      return entries.map((entry) => ({
        scenario: entry.scenario,
        label: entry.label,
        cleanupErrors: [`cleanup timed out after ${boundedMs}ms`],
        manualRecovery: entry.manualRecovery,
      }));
    }
    return outcome.map(({ entry, errors }) => ({
      scenario: entry.scenario,
      label: entry.label,
      cleanupErrors: errors,
      manualRecovery: entry.manualRecovery,
    }));
  }
}

export function shouldAbortRemainingAgentPlatformScenarios(
  failedScenario: AutomatedScenario,
  registry: SoakCleanupRegistry,
): boolean {
  return isAgentPlatformScenario(failedScenario) && registry.size > 0;
}

interface SoakProcessEvents {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
}

export function installSoakShutdownHandlers(options: {
  registry: SoakCleanupRegistry;
  processEvents: SoakProcessEvents;
  timeoutMs: number;
  recordFailure: (failure: AgentPlatformSoakFailureEvidence) => void;
  exit: (code: number) => void;
}): () => void {
  let shuttingDown = false;
  const shutdown = (reason: "SIGINT" | "SIGTERM" | "beforeExit", exitCode: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    void options.registry.shutdown(reason, options.timeoutMs)
      .then((failures) => {
        for (const failure of failures) {
          options.recordFailure({
            at: Date.now(),
            scenario: failure.scenario,
            ok: false,
            artifactId: failure.label,
            reason,
            cleanupErrors: failure.cleanupErrors,
            manualRecovery: failure.manualRecovery,
          });
        }
      })
      .catch((error) => {
        console.error(`[F5] ${reason} cleanup failed: ${safeError(error)}`);
      })
      .finally(() => options.exit(exitCode));
  };
  const onSigint = () => shutdown("SIGINT", 130);
  const onSigterm = () => shutdown("SIGTERM", 143);
  const onBeforeExit = (...args: unknown[]) => {
    if (options.registry.size === 0) return;
    const currentCode = typeof args[0] === "number" ? args[0] : 0;
    shutdown("beforeExit", currentCode === 0 ? 1 : currentCode);
  };
  options.processEvents.on("SIGINT", onSigint);
  options.processEvents.on("SIGTERM", onSigterm);
  options.processEvents.on("beforeExit", onBeforeExit);
  return () => {
    options.processEvents.off("SIGINT", onSigint);
    options.processEvents.off("SIGTERM", onSigterm);
    options.processEvents.off("beforeExit", onBeforeExit);
  };
}

export function agentPlatformEvidencePath(legacyEvidencePath: string): string {
  const absolute = resolve(legacyEvidencePath);
  return join(
    dirname(absolute),
    `${basename(absolute, ".jsonl")}.agent-platform.jsonl`,
  );
}

export function recordAgentPlatformFailureEvidence(
  evidencePath: string,
  evidence: AgentPlatformSoakFailureEvidence,
): AgentPlatformSoakFailureEvidence {
  const output = resolve(evidencePath);
  mkdirSync(dirname(output), { recursive: true });
  appendFileSync(output, `${JSON.stringify(evidence)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return evidence;
}

export async function executeVerifiedAgentPlatformScenario(
  scenario: AgentPlatformScenario,
  evidencePath: string,
  verify: () => Promise<string>,
  details: () => Record<string, unknown> | undefined = () => undefined,
): Promise<AgentPlatformSoakEvidence> {
  const artifactId = (await verify()).trim();
  if (!artifactId || artifactId.length > 200 || /[\r\n]/u.test(artifactId)) {
    throw new Error(`${scenario} did not produce a short artifact id`);
  }
  const durableDetails = sanitizeAgentPlatformEvidenceDetails(details());
  const evidence: AgentPlatformSoakEvidence = {
    at: Date.now(),
    scenario,
    ok: true,
    artifactId,
    ...(durableDetails ? { details: durableDetails } : {}),
  };
  const output = resolve(evidencePath);
  mkdirSync(dirname(output), { recursive: true });
  appendFileSync(output, `${JSON.stringify(evidence)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return evidence;
}

export function selectReusableResearchRun(
  tasks: StoredTask[],
  runs: StoredTaskRun[],
  options: { chatId: string; windowStartedAt: number; taskName?: string },
): ResearchEvidence | undefined {
  const byId = new Map(
    tasks
      .filter((task) => task.space === `team/${options.chatId}`)
      .filter((task) => task.notify !== false)
      .filter((task) => !options.taskName || task.name === options.taskName)
      .map((task) => [task.id, task]),
  );
  const run = runs
    .filter((candidate) => byId.has(candidate.taskId))
    .filter((candidate) => candidate.status === "succeeded")
    .filter((candidate) => candidate.startedAt >= options.windowStartedAt)
    .filter((candidate) => candidate.notification?.status === "sent")
    .sort((left, right) => right.startedAt - left.startedAt)[0];
  return run ? { task: byId.get(run.taskId)!, run } : undefined;
}

export function selectInFlightResearchRun(
  tasks: StoredTask[],
  runs: StoredTaskRun[],
  options: { chatId: string; windowStartedAt: number; taskName?: string },
): ResearchEvidence | undefined {
  const byId = new Map(
    tasks
      .filter((task) => task.space === `team/${options.chatId}`)
      .filter((task) => task.notify !== false)
      .filter((task) => !options.taskName || task.name === options.taskName)
      .map((task) => [task.id, task]),
  );
  const run = runs
    .filter((candidate) => byId.has(candidate.taskId))
    .filter((candidate) => candidate.status === "running")
    .filter((candidate) => candidate.startedAt >= options.windowStartedAt)
    .sort((left, right) => right.startedAt - left.startedAt)[0];
  return run ? { task: byId.get(run.taskId)!, run } : undefined;
}

function valuesFromFile<T>(path: string, key: string): T[] {
  if (!existsSync(path)) return [];
  const parsed = object(JSON.parse(readFileSync(path, "utf8")));
  const collection = parsed[key];
  if (Array.isArray(collection)) return collection as T[];
  return Object.values(object(collection)) as T[];
}

function firstSampleAt(path: string): number | undefined {
  if (!existsSync(path)) return undefined;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const at = object(JSON.parse(line)).at;
      if (typeof at === "number" && Number.isFinite(at)) return at;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function parseLarkCreateTime(value: string): number {
  const trimmed = value.trim();
  if (/^\d+$/u.test(trimmed)) {
    const numeric = Number(trimmed);
    if (!Number.isFinite(numeric)) return NaN;
    return trimmed.length <= 10 ? numeric * 1_000 : numeric;
  }
  return Date.parse(trimmed.includes("T") ? trimmed : trimmed.replace(" ", "T"));
}

function isFreshUserMessage(
  message: LarkMessage,
  botOpenId: string,
  notBefore: number,
): boolean {
  if (isBotMessage(message, botOpenId) || message.sender?.sender_type === "app") return false;
  const createdAt = message.create_time ? parseLarkCreateTime(message.create_time) : NaN;
  return Number.isFinite(createdAt) && createdAt >= notBefore - 60_000;
}

export function findFreshUserMessage(
  messages: LarkMessage[],
  options: {
    botOpenId: string;
    notBefore: number;
    contentIncludes: string;
    rootMessageId?: string;
  },
): LarkMessage | undefined {
  const candidates = options.rootMessageId
    ? flattenLarkMessages(messages).find(
      (candidate) => candidate.message_id === options.rootMessageId,
    )?.thread_replies ?? []
    : messages;
  return flattenLarkMessages(candidates).find((candidate) =>
    isFreshUserMessage(candidate, options.botOpenId, options.notBefore)
    && (candidate.content ?? "").includes(options.contentIncludes)
  );
}

export function latestDeliveredLearningSession(
  sessions: StoredLearningSession[],
  planId: string,
): StoredLearningSession | undefined {
  return sessions
    .filter((candidate) => candidate.planId === planId && candidate.deliveredAt !== undefined)
    .sort((left, right) => (right.deliveredAt ?? 0) - (left.deliveredAt ?? 0))[0];
}

function uiText(text: string): { text: string; mentionBot: boolean } {
  const mention = /^<at\s+[^>]*>agent<\/at>\s*/u;
  return {
    text: text.replace(mention, ""),
    mentionBot: mention.test(text),
  };
}

function uiProbe(text: string): string {
  const normalized = uiText(text).text;
  const markers = normalized.match(/F5-[\p{L}\p{N}_-]+/gu) ?? [];
  return markers.sort((left, right) => right.length - left.length)[0]
    ?? normalized.slice(0, 120);
}

async function defaultProcessRunner(args: string[], cwd: string): Promise<LarkProcessResult> {
  const subprocess = Bun.spawn(["lark-cli", ...args], {
    cwd,
    env: {
      ...process.env,
      LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
      LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function nonzeroLarkFailure(result: LarkProcessResult): LarkCliError {
  let envelope: LarkCliEnvelope | undefined;
  let stdoutMessage = "";
  if (result.stdout.trim()) {
    try {
      envelope = object(JSON.parse(result.stdout.trim())) as LarkCliEnvelope;
      stdoutMessage = envelope.error?.message?.trim() ?? "";
    } catch {
      stdoutMessage = "lark-cli returned invalid JSON";
    }
  }
  const detail = result.stderr.trim() || stdoutMessage || `lark-cli exited with ${result.exitCode}`;
  return new LarkCliError(detail, envelope);
}

export async function invokeLarkCliWithRetry(
  args: string[],
  cwd: string,
  options: {
    attempts?: number;
    processRunner?: ProcessRunner;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<LarkCliEnvelope> {
  const attempts = options.attempts ?? 4;
  const processRunner = options.processRunner ?? defaultProcessRunner;
  const sleep = options.sleep ?? Bun.sleep;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await processRunner([...args, "--format", "json"], cwd);
      if (result.exitCode !== 0) throw nonzeroLarkFailure(result);
      return parseLarkCliResult(result.stdout);
    } catch (error) {
      lastError = error;
      if (!isTransientLarkFailure(error) || attempt === attempts) break;
      await sleep(Math.min(8_000, 750 * 2 ** (attempt - 1)));
    }
  }
  throw lastError;
}

function messageIdFrom(envelope: LarkCliEnvelope): string {
  const data = object(envelope.data);
  const id = data.message_id ?? envelope.message_id;
  if (typeof id !== "string" || !id.startsWith("om_")) {
    throw new Error("lark-cli response did not contain a message id");
  }
  return id;
}

function messagesFrom(envelope: LarkCliEnvelope): LarkMessage[] {
  const data = object(envelope.data);
  const messages = data.messages ?? data.items;
  return Array.isArray(messages) ? messages as LarkMessage[] : [];
}

export function currentSoakWindowStartedAt(
  monitorPath: string,
  declaredStartedAt: number | undefined,
): number {
  if (declaredStartedAt === undefined) {
    throw new Error("--window-started-at is required for Agent platform acceptance");
  }
  if (
    !Number.isSafeInteger(declaredStartedAt)
    || declaredStartedAt <= 0
  ) {
    throw new Error("--window-started-at must be a positive epoch-millisecond timestamp or ISO date");
  }
  if (!existsSync(monitorPath)) {
    throw new Error(`monitor file does not exist: ${monitorPath}`);
  }
  let hasCurrentSample = false;
  const lines = readFileSync(monitorPath, "utf8").split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!line.trim()) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = object(JSON.parse(line));
    } catch {
      throw new Error(`monitor line ${index + 1} is not valid JSON`);
    }
    if (typeof parsed.at !== "number" || !Number.isFinite(parsed.at)) {
      throw new Error(`monitor line ${index + 1} has no numeric at timestamp`);
    }
    if (parsed.at >= declaredStartedAt) hasCurrentSample = true;
  }
  if (!hasCurrentSample) {
    throw new Error("monitor has no sample in the declared current window");
  }
  return declaredStartedAt;
}

function messagePageFrom(envelope: LarkCliEnvelope): LarkMessagePage {
  const data = object(envelope.data);
  const pageToken = data.page_token ?? data.pageToken;
  return {
    messages: messagesFrom(envelope),
    hasMore: data.has_more === true || data.hasMore === true,
    ...(typeof pageToken === "string" && pageToken.trim()
      ? { pageToken: pageToken.trim() }
      : {}),
  };
}

export async function collectLarkMessagesSince(
  loadPage: (pageToken?: string) => Promise<LarkMessagePage>,
  windowStartedAt: number,
  maxPages = 100,
): Promise<LarkMessage[]> {
  if (!Number.isFinite(windowStartedAt) || windowStartedAt < 0) {
    throw new Error("message evidence window start is invalid");
  }
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 1_000) {
    throw new Error("message evidence page limit is invalid");
  }
  const threshold = windowStartedAt - 60_000;
  const seenTokens = new Set<string>();
  const messages = new Map<string, LarkMessage>();
  let pageToken: string | undefined;
  for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
    const page = await loadPage(pageToken);
    for (const candidate of page.messages) {
      if (!messages.has(candidate.message_id)) messages.set(candidate.message_id, candidate);
    }
    const timestamps = page.messages.map((candidate) =>
      candidate.create_time ? parseLarkCreateTime(candidate.create_time) : NaN
    );
    const reachedWindowStart = timestamps.length > 0
      && timestamps.every(Number.isFinite)
      && Math.min(...timestamps) < threshold;
    if (!page.hasMore || reachedWindowStart) {
      return [...messages.values()].filter((candidate) => {
        const createdAt = candidate.create_time
          ? parseLarkCreateTime(candidate.create_time)
          : NaN;
        return !Number.isFinite(createdAt) || createdAt >= threshold;
      });
    }
    if (!page.pageToken || seenTokens.has(page.pageToken)) {
      throw new Error("Feishu message pagination did not advance");
    }
    seenTokens.add(page.pageToken);
    pageToken = page.pageToken;
  }
  throw new Error("Feishu message pagination did not reach the soak window start");
}

function crc32(input: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function solidRedPng(width = 160, height = 120): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const scanlines = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const offset = y * (width * 3 + 1);
    scanlines[offset] = 0;
    for (let x = 0; x < width; x += 1) {
      scanlines[offset + 1 + x * 3] = 235;
      scanlines[offset + 2 + x * 3] = 45;
      scanlines[offset + 3 + x * 3] = 55;
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function attachmentFixture(marker: string): string {
  const principle = [
    `F5 自动验收资料，唯一口令：${marker}-ATTACHMENT。`,
    "家庭与团队协作原则：重要结论要说明来源，操作步骤要可复现，失败时要保留诊断信息。",
    "本资料用于验证文本附件提取、学习课程生成和知识引用，不包含真实隐私或生产凭据。",
  ].join("\n");
  return [
    "# HomeAgent F5 自动验收材料",
    "",
    ...Array.from({ length: 18 }, (_, index) => `第 ${index + 1} 节\n${principle}`),
  ].join("\n\n");
}

export function resolveRequestedScenarios(value: string | undefined): AutomatedScenario[] {
  if (!value) return [...AUTOMATED_FEISHU_SOAK_SCENARIOS];
  const requested = value.split(",").map((part) => part.trim()).filter(Boolean);
  const allowed = new Set<string>(AUTOMATED_FEISHU_SOAK_SCENARIOS);
  for (const scenario of requested) {
    if (scenario === "network_recovery") {
      throw new Error("network_recovery intentionally requires supervised network interruption");
    }
    if (!allowed.has(scenario)) throw new Error(`unknown automated scenario: ${scenario}`);
  }
  const expanded = new Set(requested as AutomatedScenario[]);
  if (expanded.has("learning_interaction")) expanded.add("attachment_extraction");
  if (expanded.has("distill_citation")) expanded.add("message_capture");
  return AUTOMATED_FEISHU_SOAK_SCENARIOS.filter((scenario) => expanded.has(scenario));
}

function stringArg(args: string[], flag: string, fallback?: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function numberArg(args: string[], flag: string, fallback: number): number {
  const raw = stringArg(args, flag);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${flag} must be positive`);
  return value;
}

function configuredWebPort(
  dataDir: string,
  env: Record<string, string | undefined>,
): number {
  const fromEnvironment = Number(env.HOMEAGENT_WEB_PORT);
  if (
    Number.isInteger(fromEnvironment)
    && fromEnvironment > 0
    && fromEnvironment <= 65_535
  ) {
    return fromEnvironment;
  }
  try {
    const settings = object(JSON.parse(
      readFileSync(join(dataDir, "config", "settings.json"), "utf8"),
    ));
    const fromSettings = settings.webPort;
    if (
      typeof fromSettings === "number"
      && Number.isInteger(fromSettings)
      && fromSettings > 0
      && fromSettings <= 65_535
    ) {
      return fromSettings;
    }
  } catch {
    // The default is also used before HomeAgent has written settings.json.
  }
  return 3_000;
}

function timestampArg(args: string[], flag: string): number | undefined {
  const raw = stringArg(args, flag);
  if (raw === undefined) return undefined;
  const numeric = Number(raw);
  const parsed = Number.isFinite(numeric) ? numeric : Date.parse(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive epoch-millisecond timestamp or ISO date`);
  }
  return parsed;
}

function normalizeAdminUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("--admin-url must be a valid HTTP URL");
  }
  if (
    !["http:", "https:"].includes(url.protocol)
    || url.username
    || url.password
    || (url.pathname !== "/" && url.pathname !== "")
    || url.search
    || url.hash
  ) {
    throw new Error("--admin-url must contain only an HTTP(S) origin");
  }
  return url.origin;
}

export function parseFeishuSoakOptions(
  args: string[],
  env: Record<string, string | undefined> = process.env,
): FeishuSoakDriverOptions {
  const valueFlags = new Set([
    "--chat-id",
    "--bot-open-id",
    "--data-dir",
    "--admin-url",
    "--evidence",
    "--monitor",
    "--research-task",
    "--approval-expired-run-id",
    "--approval-idempotency-run-id",
    "--retry-task-id",
    "--retry-business-marker",
    "--window-started-at",
    "--scenarios",
    "--sender",
    "--response-timeout-seconds",
    "--long-timeout-minutes",
  ]);
  const booleanFlags = new Set(["--dry-run"]);
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!valueFlags.has(arg) && !booleanFlags.has(arg)) throw new Error(`unknown argument: ${arg}`);
    if (seen.has(arg)) throw new Error(`duplicate argument: ${arg}`);
    seen.add(arg);
    if (valueFlags.has(arg)) index += 1;
  }

  const dataDir = resolve(stringArg(args, "--data-dir", "./data")!);
  const evidencePath = resolve(stringArg(args, "--evidence", "./data/soak/soak-evidence.jsonl")!);
  const sender = stringArg(args, "--sender", "api");
  if (sender !== "api" && sender !== "ui") {
    throw new Error("--sender must be api or ui");
  }
  return {
    chatId: stringArg(args, "--chat-id") ?? "",
    botOpenId: stringArg(args, "--bot-open-id") ?? "",
    dataDir,
    evidencePath,
    monitorPath: resolve(
      stringArg(args, "--monitor", join(dirname(evidencePath), "soak-24h.jsonl"))!,
    ),
    windowStartedAt: timestampArg(args, "--window-started-at"),
    researchTaskName: stringArg(args, "--research-task"),
    approvalExpiredRunId: stringArg(args, "--approval-expired-run-id"),
    approvalIdempotencyRunId: stringArg(args, "--approval-idempotency-run-id"),
    retryTaskId: stringArg(args, "--retry-task-id"),
    retryBusinessMarker: stringArg(args, "--retry-business-marker"),
    adminUrl: normalizeAdminUrl(
      stringArg(
        args,
        "--admin-url",
        `http://127.0.0.1:${configuredWebPort(dataDir, env)}`,
      )!,
    ),
    adminToken: env.HOMEAGENT_SOAK_ADMIN_TOKEN?.trim() || undefined,
    scenarios: resolveRequestedScenarios(stringArg(args, "--scenarios")),
    responseTimeoutMs: numberArg(args, "--response-timeout-seconds", 180) * 1_000,
    longTimeoutMs: numberArg(args, "--long-timeout-minutes", 25) * 60_000,
    sender,
    dryRun: args.includes("--dry-run"),
  };
}

/**
 * Fail before the driver performs any management mutation when production-only
 * evidence cannot be generated through HomeAgent's public administration UI.
 */
export function assertAgentPlatformPreconditions(options: FeishuSoakDriverOptions): void {
  if (options.scenarios.includes("writable_task_approval")) {
    if (!options.approvalExpiredRunId) {
      throw new Error(
        "writable_task_approval requires --approval-expired-run-id from the production expiry loop",
      );
    }
    if (!options.approvalIdempotencyRunId) {
      throw new Error(
        "writable_task_approval requires --approval-idempotency-run-id with at least two delivery attempts",
      );
    }
  }
  if (options.scenarios.includes("readonly_task_retry")) {
    if (!options.retryTaskId) {
      throw new Error(
        "readonly_task_retry requires --retry-task-id for a scheduled read-only fault-injection task",
      );
    }
    const marker = options.retryBusinessMarker?.trim();
    if (!marker) {
      throw new Error(
        "readonly_task_retry requires --retry-business-marker from the task's unique output contract",
      );
    }
    if (marker.length > 120 || /[\r\n]/u.test(marker)) {
      throw new Error("--retry-business-marker must be a short single-line marker");
    }
  }
  if (
    options.scenarios.some(isAgentPlatformScenario)
    && options.windowStartedAt === undefined
  ) {
    throw new Error("Agent platform acceptance requires --window-started-at for this soak session");
  }
}

export interface StoredAgentRevisionSnapshot {
  name: string;
  instruction: string;
  model: string;
  reasoningEffort: string;
  provider: string;
  visibility: string;
  workdir?: string;
  permission: string;
  skills: unknown[];
}

export interface StoredAgent extends StoredAgentRevisionSnapshot {
  id: string;
  publishedRevisionId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface StoredAgentRevision {
  id: string;
  agentId: string;
  number: number;
  source: string;
  basedOnRevisionId?: string;
  createdAt: number;
  snapshot: StoredAgentRevisionSnapshot;
}

export interface AgentRevisionLifecycleEvidenceInput {
  agent: StoredAgent;
  revisions: StoredAgentRevision[];
  runs: StoredTaskRun[];
  firstRevisionId: string;
  secondRevisionId: string;
  rollbackRevisionId: string;
  secondRevisionRunId: string;
  rollbackRunId: string;
  businessMarkers: {
    secondRevision: string;
    rollback: string;
  };
  businessNotices: LarkMessage[];
  botOpenId: string;
}

/**
 * Validate the production evidence needed for an Agent release/rollback gate.
 * This deliberately consumes only durable public artifacts: Agent revision
 * history and Task Run execution plans. A redirect alone is never acceptance.
 */
export function assertAgentRevisionLifecycleEvidence(
  input: AgentRevisionLifecycleEvidenceInput,
): string {
  const revision = (id: string, label: string): StoredAgentRevision => {
    const found = input.revisions.find((candidate) => candidate.id === id);
    if (!found || found.agentId !== input.agent.id) {
      throw new Error(`${label} revision is missing from the Agent history`);
    }
    return found;
  };
  const run = (id: string, label: string): StoredTaskRun => {
    const found = input.runs.find((candidate) => candidate.id === id);
    if (!found) throw new Error(`${label} Run is missing from durable history`);
    if (found.status !== "succeeded") throw new Error(`${label} Run did not succeed`);
    if (found.agentId !== input.agent.id) {
      throw new Error(`${label} Run is not attributed to the acceptance Agent`);
    }
    return found;
  };

  const first = revision(input.firstRevisionId, "v1");
  const second = revision(input.secondRevisionId, "v2");
  const rolledBack = revision(input.rollbackRevisionId, "rollback");
  if (first.source === "draft") throw new Error("v1 evidence points to an unpublished draft");
  if (second.source !== "release") throw new Error("v2 evidence is not a published release");
  if (
    rolledBack.source !== "rollback"
    || rolledBack.basedOnRevisionId !== first.id
  ) {
    throw new Error("rollback is not a new publication based on v1");
  }
  const materializedSnapshot: StoredAgentRevisionSnapshot = {
    name: input.agent.name,
    instruction: input.agent.instruction,
    model: input.agent.model,
    reasoningEffort: input.agent.reasoningEffort,
    provider: input.agent.provider,
    visibility: input.agent.visibility,
    ...(input.agent.workdir ? { workdir: input.agent.workdir } : {}),
    permission: input.agent.permission,
    skills: input.agent.skills,
  };
  const snapshotKey = (snapshot: StoredAgentRevisionSnapshot): string => JSON.stringify([
    snapshot.name,
    snapshot.instruction,
    snapshot.model,
    snapshot.reasoningEffort,
    snapshot.provider,
    snapshot.visibility,
    snapshot.workdir ?? null,
    snapshot.permission,
    snapshot.skills,
  ]);
  if (
    snapshotKey(rolledBack.snapshot) !== snapshotKey(first.snapshot)
    || snapshotKey(materializedSnapshot) !== snapshotKey(first.snapshot)
  ) {
    throw new Error("rollback revision did not restore the v1 snapshot");
  }
  if (input.agent.publishedRevisionId !== rolledBack.id) {
    throw new Error("the rolled-back revision is not the Agent's published head");
  }

  const secondRun = run(input.secondRevisionRunId, "v2");
  const rollbackRun = run(input.rollbackRunId, "rollback");
  const executionPlanMatches = (
    candidate: StoredTaskRun,
    expected: StoredAgentRevisionSnapshot,
  ): boolean => {
    const skillNames = expected.skills.map((binding) => {
      const name = object(binding).name;
      return typeof name === "string" ? name : undefined;
    });
    const plan = candidate.executionPlan;
    return plan?.version === 1
      && plan.instruction === expected.instruction
      && plan.provider === expected.provider
      && (plan.model ?? "") === expected.model
      && (plan.reasoningEffort ?? "") === expected.reasoningEffort
      && plan.resolutionError === undefined
      && plan.execution?.permission === expected.permission
      && (plan.execution.workdir ?? undefined) === expected.workdir
      && skillNames.every((name): name is string => name !== undefined)
      && JSON.stringify(plan.execution.skills ?? []) === JSON.stringify(skillNames);
  };
  if (secondRun.executionPlan?.agentRevisionId !== second.id) {
    throw new Error("v2 Run is not attributed to the published v2 revision");
  }
  if (!executionPlanMatches(secondRun, second.snapshot)) {
    throw new Error("v2 Run did not freeze the complete v2 execution plan");
  }
  if (rollbackRun.executionPlan?.agentRevisionId !== rolledBack.id) {
    throw new Error("post-rollback Run is not attributed to the rollback revision");
  }
  if (!executionPlanMatches(rollbackRun, first.snapshot)) {
    throw new Error("post-rollback Run did not freeze the complete restored v1 execution plan");
  }
  if (
    secondRun.startedAt < second.createdAt
    || secondRun.startedAt >= rolledBack.createdAt
    || secondRun.finishedAt === undefined
    || secondRun.finishedAt < rolledBack.createdAt
    || rollbackRun.startedAt < rolledBack.createdAt
  ) {
    throw new Error("Agent lifecycle Run ordering is inconsistent with its revisions");
  }

  const markers = input.businessMarkers;
  if (
    !markers.secondRevision.trim()
    || !markers.rollback.trim()
    || markers.secondRevision === markers.rollback
  ) {
    throw new Error("Agent lifecycle business markers must be non-empty and distinct");
  }
  const visibleMessageIds: string[] = [];
  for (const [label, candidate, marker] of [
    ["v2", secondRun, markers.secondRevision],
    ["rollback", rollbackRun, markers.rollback],
  ] as const) {
    if (candidate.notification?.status !== "sent") {
      throw new Error(`${label} Run completion notification was not durably sent`);
    }
    if (!(candidate.output ?? candidate.summary ?? "").includes(marker)) {
      throw new Error(`${label} Run output does not contain its business marker`);
    }
    if (!candidate.taskName) {
      throw new Error(`${label} Run has no frozen Task name for Feishu attribution`);
    }
    const visible = flattenLarkMessages(input.businessNotices).filter((message) =>
      isBotMessage(message, input.botOpenId)
      && (message.content ?? "").includes(candidate.taskName!)
      && (message.content ?? "").includes(marker)
    );
    if (visible.length !== 1) {
      throw new Error(
        `${label} Feishu business notification expected one message, found ${visible.length}`,
      );
    }
    visibleMessageIds.push(visible[0]!.message_id);
  }
  if (new Set(visibleMessageIds).size !== visibleMessageIds.length) {
    throw new Error("Agent lifecycle markers were combined into one Feishu business message");
  }

  return `${input.agent.id}:${secondRun.id}:${rollbackRun.id}`;
}

export interface WritableTaskApprovalEvidenceInput {
  /** Snapshot captured from durable storage before the approval mutation. */
  pending: StoredTaskRun;
  /** The same Run after approval and execution. */
  approved: StoredTaskRun;
  /** A separate Run closed through the public reject action. */
  rejected: StoredTaskRun;
  /** A separate Run closed by the production expiry loop. */
  expired: StoredTaskRun;
  /** A fault-injected delivery sample; it may be a different approval Run. */
  idempotency: StoredTaskRun;
  spaceId: string;
  windowStartedAt: number;
  /** Messages fetched from Feishu after a retried approval delivery. */
  approvalNotices: LarkMessage[];
  botOpenId: string;
  completionMarker: string;
}

function hasProviderExecutionEvidence(run: StoredTaskRun): boolean {
  return run.runStartedAt !== undefined
    || run.usage !== undefined
    || run.output !== undefined
    || run.rawId !== undefined
    || (run.pagesWritten ?? 0) > 0;
}

/** Validate durable approval, expiry and transport-idempotency evidence. */
export function assertWritableTaskApprovalEvidence(
  input: WritableTaskApprovalEvidenceInput,
): string {
  const evidenceRuns = [
    input.pending,
    input.approved,
    input.rejected,
    input.expired,
    input.idempotency,
  ];
  if (evidenceRuns.some((run) =>
    run.space !== input.spaceId || run.startedAt < input.windowStartedAt
  )) {
    throw new Error("approval evidence is outside the current soak window or target space");
  }
  if (new Set([
    input.approved.id,
    input.rejected.id,
    input.expired.id,
    input.idempotency.id,
  ]).size !== 4) {
    throw new Error("approval evidence Run ids must be distinct");
  }
  const permission = input.pending.executionPlan?.execution?.permission;
  if (
    !["write", "full"].includes(permission ?? "")
    || !input.pending.executionPlan?.execution?.workdir
  ) {
    throw new Error("approval evidence is not for a writable frozen execution plan");
  }
  if (
    input.pending.status !== "awaiting_approval"
    || input.pending.approval?.status !== "pending"
  ) {
    throw new Error("pending approval snapshot is missing");
  }
  if (hasProviderExecutionEvidence(input.pending) || input.pending.finishedAt !== undefined) {
    throw new Error("Provider evidence exists before approval");
  }

  if (input.approved.id !== input.pending.id || input.approved.status !== "succeeded") {
    throw new Error("approved Run did not complete successfully");
  }
  const decisionAt = input.approved.approval?.decidedAt;
  if (
    input.approved.approval?.status !== "approved"
    || decisionAt === undefined
    || input.approved.runStartedAt === undefined
    || input.approved.runStartedAt < decisionAt
  ) {
    throw new Error("approved Run began before its durable approval decision");
  }
  if (!hasProviderExecutionEvidence(input.approved)) {
    throw new Error("approved Run has no Provider execution evidence");
  }
  if (input.approved.notification?.status !== "sent") {
    throw new Error("approved Run completion notification was not durably sent");
  }
  if (
    !input.completionMarker.trim()
    || !(input.approved.output ?? input.approved.summary ?? "").includes(input.completionMarker)
  ) {
    throw new Error("approved Run output does not contain its completion marker");
  }

  for (const [label, run, expected] of [
    ["rejected", input.rejected, "rejected"],
    ["expired", input.expired, "expired"],
  ] as const) {
    if (run.status !== "cancelled" || run.approval?.status !== expected) {
      throw new Error(`${label} approval did not reach its durable terminal state`);
    }
    if (hasProviderExecutionEvidence(run)) {
      throw new Error(`${label} approval unexpectedly executed its Provider`);
    }
  }

  if (input.approved.approvalNotification?.status !== "sent") {
    throw new Error("approved Run has no sent approval notification audit");
  }
  const idempotencyDecisionAt = input.idempotency.approval?.decidedAt;
  if (
    input.idempotency.status !== "succeeded"
    || input.idempotency.approval?.status !== "approved"
    || idempotencyDecisionAt === undefined
    || input.idempotency.runStartedAt === undefined
    || input.idempotency.runStartedAt < idempotencyDecisionAt
    || !hasProviderExecutionEvidence(input.idempotency)
  ) {
    throw new Error("idempotency approval Run was not approved and successfully executed");
  }
  if (
    input.idempotency.approvalNotification?.status !== "sent"
    || (input.idempotency.approvalNotification.attempts ?? 0) < 2
    || input.idempotency.approvalNotification.sentAt === undefined
    || input.idempotency.approvalNotification.sentAt > idempotencyDecisionAt
  ) {
    throw new Error("approval notification was not durably retried and sent");
  }
  const visibleNotices = flattenLarkMessages(input.approvalNotices).filter((candidate) =>
    isBotMessage(candidate, input.botOpenId)
    && (candidate.content ?? "").includes(input.idempotency.id)
  );
  if (visibleNotices.length !== 1) {
    throw new Error(
      `approval notification idempotency expected one Feishu message, found ${visibleNotices.length}`,
    );
  }
  if (!input.approved.taskName) {
    throw new Error("approved Run has no frozen Task name for Feishu attribution");
  }
  const completionNotices = flattenLarkMessages(input.approvalNotices).filter((candidate) =>
    isBotMessage(candidate, input.botOpenId)
    && (candidate.content ?? "").includes(input.approved.taskName!)
    && (candidate.content ?? "").includes(input.completionMarker)
  );
  if (completionNotices.length !== 1) {
    throw new Error(
      `approved Feishu business notification expected one message, found ${completionNotices.length}`,
    );
  }
  if (completionNotices[0]!.message_id === visibleNotices[0]!.message_id) {
    throw new Error("approval request and completion evidence resolved to one Feishu message");
  }

  return `${input.approved.id}:${input.rejected.id}:${input.expired.id}:${input.idempotency.id}`;
}

export interface ReadonlyTaskRetryEvidenceInput {
  runs: StoredTaskRun[];
  taskId: string;
  parentRunId: string;
  retryRunId: string;
  windowStartedAt: number;
  /** Unique marker demanded in both Provider output and the Feishu notice. */
  businessMarker: string;
  businessNotices: LarkMessage[];
  botOpenId: string;
}

/** Validate one fresh automatic retry, not a Provider checkpoint or manual rerun. */
export function assertReadonlyTaskRetryEvidence(
  input: ReadonlyTaskRetryEvidenceInput,
): string {
  const taskRuns = input.runs.filter((run) => run.taskId === input.taskId);
  const parent = taskRuns.find((run) => run.id === input.parentRunId);
  const child = taskRuns.find((run) => run.id === input.retryRunId);
  if (!parent || !child) throw new Error("automatic retry parent/child evidence is missing");
  if (
    parent.startedAt < input.windowStartedAt
    || child.startedAt < input.windowStartedAt
  ) {
    throw new Error("automatic retry evidence is outside the current soak window");
  }
  if (
    parent.trigger !== "scheduled"
    || parent.status !== "failed"
    || parent.executionPlan?.execution?.permission !== "read-only"
    || parent.failure?.phase !== "provider"
    || parent.failure.retryable !== true
  ) {
    throw new Error("retry parent is not an eligible scheduled read-only Provider failure");
  }
  if (!["overloaded", "rate_limited", "transient_provider"].includes(
    parent.failure.kind ?? "",
  )) {
    throw new Error("retry parent failure kind is not transient");
  }
  if (
    parent.retry?.attempt !== 1
    || parent.retry.maxAttempts !== 2
    || parent.retry.status !== "claimed"
    || parent.retry.claimedByRunId !== child.id
  ) {
    throw new Error("retry parent did not atomically claim exactly one child Run");
  }
  const linkedChildren = taskRuns.filter((run) => run.retryOf === parent.id);
  if (linkedChildren.length !== 1 || linkedChildren[0]?.id !== child.id) {
    throw new Error(`retry parent has ${linkedChildren.length} linked child Runs`);
  }
  if (
    child.trigger !== "retry"
    || child.retryOf !== parent.id
    || child.retry?.attempt !== 2
    || child.retry.maxAttempts !== 2
    || child.status !== "succeeded"
  ) {
    throw new Error("automatic retry child did not succeed as attempt 2 of 2");
  }
  if (
    parent.finishedAt === undefined
    || child.startedAt < parent.finishedAt + 60_000
  ) {
    throw new Error("automatic retry did not preserve the production retry delay");
  }
  const frozenKey = (run: StoredTaskRun): string => JSON.stringify([
    run.taskId,
    run.taskName ?? null,
    run.space ?? null,
    run.topic ?? null,
    run.agentId ?? null,
    run.provider ?? null,
    run.model ?? null,
    run.executionPlan?.version ?? null,
    run.executionPlan?.agentRevisionId ?? null,
    run.executionPlan?.instruction ?? null,
    run.executionPlan?.provider ?? null,
    run.executionPlan?.model ?? null,
    run.executionPlan?.reasoningEffort ?? null,
    run.executionPlan?.execution?.permission ?? null,
    run.executionPlan?.execution?.workdir ?? null,
    run.executionPlan?.execution?.skills ?? null,
    run.executionPlan?.execution?.webSearch ?? null,
    run.executionPlan?.resolutionError ?? null,
    run.skillEvidence ?? null,
    run.distill ?? null,
    run.notify ?? null,
    run.timeoutMs ?? null,
    run.priority ?? null,
  ]);
  if (frozenKey(child) !== frozenKey(parent)) {
    throw new Error("automatic retry child did not reuse the frozen execution plan");
  }

  const produced = [parent, child].filter((run) =>
    run.rawId !== undefined
    || run.output !== undefined
    || (run.pagesWritten ?? 0) > 0
  );
  if (
    produced.length !== 1
    || produced[0]?.id !== child.id
    || !child.rawId
    || !(child.output ?? "").includes(input.businessMarker)
  ) {
    throw new Error("retry chain did not produce exactly one marked business output");
  }
  const notified = [parent, child].filter((run) => run.notification?.status === "sent");
  if (notified.length !== 1 || notified[0]?.id !== child.id) {
    throw new Error("retry chain did not durably send exactly one business notification");
  }
  const visible = flattenLarkMessages(input.businessNotices).filter((candidate) =>
    isBotMessage(candidate, input.botOpenId)
    && (candidate.content ?? "").includes(child.taskName ?? "")
    && (candidate.content ?? "").includes(input.businessMarker)
  );
  if (visible.length !== 1) {
    throw new Error(`expected one Feishu business notification, found ${visible.length}`);
  }

  return `${parent.id}:${child.id}:${child.rawId}`;
}

function allowedAdminMutationPath(path: string): boolean {
  if (path === "/integrations/groups/connect") return true;
  return [
    /^\/integrations\/groups\/[^/?#]+\/disconnect$/u,
    /^\/agents$/u,
    /^\/agents\/[^/?#]+$/u,
    /^\/agents\/[^/?#]+\/delete$/u,
    /^\/agents\/[^/?#]+\/revisions\/[^/?#]+\/rollback$/u,
    /^\/spaces\/[^/?#]+\/agent$/u,
    /^\/tasks$/u,
    /^\/tasks\/[^/?#]+$/u,
    /^\/tasks\/[^/?#]+\/(?:run|delete)$/u,
    /^\/tasks\/runs\/[^/?#]+\/(?:approve|reject|cancel)$/u,
  ].some((pattern) => pattern.test(path));
}

export async function postFeishuSoakAdminForm(
  request: FeishuSoakAdminFormRequest,
): Promise<FeishuSoakAdminFormResponse> {
  if (!allowedAdminMutationPath(request.path)) {
    throw new Error("unsupported soak administration path");
  }
  const origin = normalizeAdminUrl(request.adminUrl);
  const headers = new Headers({
    "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
    origin,
    "sec-fetch-site": "same-origin",
  });
  if (request.adminToken) {
    headers.set("authorization", `Bearer ${request.adminToken}`);
  }
  const response = await (request.fetchImpl ?? fetch)(
    `${origin}${request.path}`,
    {
      method: "POST",
      headers,
      body: new URLSearchParams(request.form),
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    },
  );
  const location = response.headers.get("location") ?? "";
  const rejectedConnect = request.path === "/integrations/groups/connect"
    && location.startsWith("/integrations/groups/connect?");
  if (
    response.status < 300
    || response.status >= 400
    || rejectedConnect
  ) {
    const responseText = await response.text();
    const detail = (request.adminToken
      ? responseText.replaceAll(request.adminToken, "[redacted]")
      : responseText)
      .replace(/\s+/gu, " ")
      .slice(0, 300);
    throw new Error(
      `HomeAgent administration request failed (${response.status})${
        detail ? `: ${detail}` : ""
      }`,
    );
  }
  if (!location.startsWith("/") || location.startsWith("//") || /[\r\n]/u.test(location)) {
    throw new Error("HomeAgent administration response did not contain a safe redirect");
  }
  return { status: response.status, location };
}

export function resourceIdFromAdminRedirect(location: string, prefix: string): string {
  const pathname = new URL(location, "http://homeagent.invalid").pathname;
  if (!prefix.startsWith("/") || !prefix.endsWith("/") || !pathname.startsWith(prefix)) {
    throw new Error("HomeAgent administration redirect did not identify one direct resource");
  }
  const encoded = pathname.slice(prefix.length);
  if (!encoded || encoded.includes("/")) {
    throw new Error("HomeAgent administration redirect did not identify one direct resource");
  }
  const id = decodeURIComponent(encoded);
  if (!id || /[\r\n/]/u.test(id)) {
    throw new Error("HomeAgent administration redirect contained an invalid resource id");
  }
  return id;
}

export function canRestoreTemporaryAgentBinding(
  currentAgentId: string,
  originalAgentId: string,
  temporaryAgentId: string,
): boolean {
  return currentAgentId === originalAgentId || currentAgentId === temporaryAgentId;
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/gu, " ").slice(0, 500);
}

class FeishuSoakDriver {
  private readonly options: FeishuSoakDriverOptions;
  private readonly runMarker: string;
  private readonly fixtureDir: string;
  private readonly processRunner: ProcessRunner;
  private readonly cleanupRegistry: SoakCleanupRegistry;
  private readonly inFlightAdminMutations = new Set<Promise<FeishuSoakAdminFormResponse>>();
  private readonly platformEvidenceDetails = new Map<AgentPlatformScenario, Record<string, unknown>>();
  private interruptedReason?: string;
  private attachmentMessageId?: string;
  private captured?: { messageId: string; rawId: string; token: string };

  constructor(
    options: FeishuSoakDriverOptions,
    processRunner: ProcessRunner = defaultProcessRunner,
    cleanupRegistry: SoakCleanupRegistry = new SoakCleanupRegistry(),
  ) {
    this.options = options;
    this.processRunner = processRunner;
    this.cleanupRegistry = cleanupRegistry;
    this.runMarker = `F5-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8)}`;
    this.fixtureDir = mkdtempSync(join(tmpdir(), "homeagent-f5-e2e-"));
  }

  close(): void {
    rmSync(this.fixtureDir, { recursive: true, force: true });
  }

  private storedBinding(): StoredFeishuBinding | undefined {
    return valuesFromFile<StoredFeishuBinding>(
      join(this.options.dataDir, "config", "feishu-group-bindings.json"),
      "bindings",
    ).find((binding) => binding.chatId === this.options.chatId);
  }

  private spaceId(): string {
    return `team/${this.options.chatId}`;
  }

  private storedSpaces(): StoredSpaceMeta[] {
    return valuesFromFile<StoredSpaceMeta>(
      join(this.options.dataDir, "config", "spaces.json"),
      "spaces",
    );
  }

  private storedSpace(): StoredSpaceMeta | undefined {
    return this.storedSpaces().find((space) => space.id === this.spaceId());
  }

  private storedAgent(id: string): StoredAgent | undefined {
    return this.storedAgents().find((agent) => agent.id === id);
  }

  private storedAgents(): StoredAgent[] {
    return valuesFromFile<StoredAgent>(
      join(this.options.dataDir, "config", "agents.json"),
      "agents",
    );
  }

  private storedAgentRevisions(id: string): StoredAgentRevision[] {
    const path = join(this.options.dataDir, "config", "agents.json");
    if (!existsSync(path)) return [];
    const parsed = object(JSON.parse(readFileSync(path, "utf8")));
    const revisions = object(parsed.revisions)[id];
    return Array.isArray(revisions) ? revisions as StoredAgentRevision[] : [];
  }

  private async adminForm(
    path: string,
    form: Record<string, string> = {},
    allowInterrupted = false,
  ): Promise<FeishuSoakAdminFormResponse> {
    if (!allowInterrupted) this.assertNotInterrupted();
    const mutation = postFeishuSoakAdminForm({
      adminUrl: this.options.adminUrl,
      adminToken: this.options.adminToken,
      path,
      form,
    });
    this.inFlightAdminMutations.add(mutation);
    try {
      const response = await mutation;
      if (!allowInterrupted) this.assertNotInterrupted();
      return response;
    } finally {
      this.inFlightAdminMutations.delete(mutation);
    }
  }

  private assertNotInterrupted(): void {
    if (this.interruptedReason) {
      throw new Error(`soak interrupted by ${this.interruptedReason}`);
    }
  }

  private interrupt(reason: string): void {
    this.interruptedReason ??= reason;
  }

  private async waitForAdminMutationsForCleanup(timeoutMs = 16_000): Promise<void> {
    const mutations = [...this.inFlightAdminMutations];
    if (mutations.length === 0) return;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(
        () => reject(new Error(`in-flight administration mutation did not settle in ${timeoutMs}ms`)),
        timeoutMs,
      );
    });
    try {
      await Promise.race([Promise.allSettled(mutations), timedOut]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async assignSpaceAgent(agentId: string, allowInterrupted = false): Promise<void> {
    await this.adminForm(
      `/spaces/${encodeURIComponent(this.spaceId())}/agent`,
      { agentId },
      allowInterrupted,
    );
    await this.poll("space Agent assignment", 15_000, async () => {
      const assigned = this.storedSpace()?.agentId ?? "";
      return assigned === agentId ? true : undefined;
    }, 250, allowInterrupted);
  }

  private async waitForTaskRunTerminal(runId: string): Promise<StoredTaskRun> {
    return this.poll("Task Run terminal state", this.options.longTimeoutMs, async () => {
      const run = this.taskRuns().find((candidate) => candidate.id === runId);
      if (!run) return undefined;
      if (["failed", "timed_out", "cancelled"].includes(run.status)) {
        throw new Error(`Task Run ${run.id} ended with ${run.status}`);
      }
      return run.status === "succeeded" ? run : undefined;
    }, 2_000);
  }

  private async waitForTaskRunNotified(runId: string): Promise<StoredTaskRun> {
    return this.poll("Task Run completion notification", this.options.longTimeoutMs, async () => {
      const run = this.taskRuns().find((candidate) => candidate.id === runId);
      if (!run) return undefined;
      if (["failed", "timed_out", "cancelled"].includes(run.status)) {
        throw new Error(`Task Run ${run.id} ended with ${run.status}`);
      }
      if (run.notification?.status === "failed") {
        throw new Error(`Task Run ${run.id} completion notification failed`);
      }
      return run.status === "succeeded" && run.notification?.status === "sent"
        ? run
        : undefined;
    }, 2_000);
  }

  private async cancelTaskRunForCleanup(runId: string): Promise<void> {
    const current = this.taskRuns().find((run) => run.id === runId);
    if (!current || !["awaiting_approval", "queued", "running"].includes(current.status)) {
      return;
    }
    await this.adminForm(`/tasks/runs/${encodeURIComponent(runId)}/cancel`, {}, true);
    await this.poll("Task Run cleanup cancellation", 15_000, async () => {
      const run = this.taskRuns().find((candidate) => candidate.id === runId);
      return !run || !["awaiting_approval", "queued", "running"].includes(run.status)
        ? true
        : undefined;
    }, 250, true);
  }

  private async cleanupTemporaryAgentTask(input: {
    label: string;
    originalAgentId: string;
    agentName: string;
    taskName: string;
    agentId?: string;
    taskId?: string;
    runIds: string[];
  }): Promise<string[]> {
    const errors: string[] = [];
    try {
      await this.waitForAdminMutationsForCleanup();
    } catch (error) {
      errors.push(`wait for administration mutation: ${safeError(error)}`);
    }

    let agentId = input.agentId;
    if (agentId) {
      const stored = this.storedAgent(agentId);
      if (stored && stored.name !== input.agentName) {
        errors.push(`Agent ${agentId} does not match owned name ${input.agentName}; left unchanged`);
        agentId = undefined;
      }
    } else {
      const candidates = this.storedAgents().filter((agent) => agent.name === input.agentName);
      if (candidates.length === 1) agentId = candidates[0]!.id;
      if (candidates.length > 1) {
        errors.push(`multiple Agents match owned name ${input.agentName}; left unchanged`);
      }
    }

    let taskId = input.taskId;
    if (taskId) {
      const stored = this.tasks().find((task) => task.id === taskId);
      if (stored && stored.name !== input.taskName) {
        errors.push(`Task ${taskId} does not match owned name ${input.taskName}; left unchanged`);
        taskId = undefined;
      }
    } else {
      const candidates = this.tasks().filter((task) => task.name === input.taskName);
      if (candidates.length === 1) taskId = candidates[0]!.id;
      if (candidates.length > 1) {
        errors.push(`multiple Tasks match owned name ${input.taskName}; left unchanged`);
      }
    }

    if (taskId) {
      const task = this.tasks().find((candidate) => candidate.id === taskId);
      if (task) {
        try {
          await this.adminForm(
            `/tasks/${encodeURIComponent(taskId)}`,
            this.taskEditorForm(task, { enabled: false }),
            true,
          );
          await this.poll(`${input.label} Task disable`, 15_000, async () => {
            const current = this.tasks().find((candidate) => candidate.id === taskId);
            return !current || current.enabled === false ? true : undefined;
          }, 250, true);
        } catch (error) {
          errors.push(`disable ${taskId}: ${safeError(error)}`);
        }
      }
    }

    const ownedRunIds = new Set(input.runIds);
    if (taskId) {
      for (const run of this.taskRuns()) {
        if (run.taskId === taskId && ["awaiting_approval", "queued", "running"].includes(run.status)) {
          ownedRunIds.add(run.id);
        }
      }
    }
    for (const runId of ownedRunIds) {
      try {
        await this.cancelTaskRunForCleanup(runId);
      } catch (error) {
        errors.push(`cancel ${runId}: ${safeError(error)}`);
      }
    }
    if (taskId) {
      try {
        await this.adminForm(`/tasks/${encodeURIComponent(taskId)}/delete`, {}, true);
        await this.poll(`${input.label} Task deletion`, 15_000, async () =>
          this.tasks().some((task) => task.id === taskId) ? undefined : true, 250, true
        );
      } catch (error) {
        errors.push(`delete ${taskId}: ${safeError(error)}`);
      }
    }
    const currentAgentId = this.storedSpace()?.agentId ?? "";
    const expectedTemporaryAgentId = agentId ?? input.originalAgentId;
    if (!canRestoreTemporaryAgentBinding(
      currentAgentId,
      input.originalAgentId,
      expectedTemporaryAgentId,
    )) {
      errors.push(
        `restore space Agent: assignment changed concurrently to ${currentAgentId}; left unchanged`,
      );
    } else {
      try {
        await this.assignSpaceAgent(input.originalAgentId, true);
      } catch (error) {
        errors.push(`restore space Agent: ${safeError(error)}`);
      }
    }
    if (agentId) {
      const bindings = this.storedSpaces().filter(
        (space) => space.agentId === agentId,
      );
      if (bindings.length > 0) {
        errors.push(
          `delete ${agentId}: still bound to ${bindings.map((space) => space.id).join(", ")}`,
        );
      } else {
        try {
          await this.adminForm(`/agents/${encodeURIComponent(agentId)}/delete`, {}, true);
          await this.poll(`${input.label} Agent deletion`, 15_000, async () =>
            this.storedAgent(agentId!) ? undefined : true, 250, true
          );
        } catch (error) {
          errors.push(`delete ${agentId}: ${safeError(error)}`);
        }
      }
    }
    return errors;
  }

  private taskEditorForm(
    task: StoredTask,
    overrides: Partial<Pick<StoredTask, "topic" | "enabled" | "notify">> = {},
  ): Record<string, string> {
    const enabled = overrides.enabled ?? task.enabled ?? false;
    const notify = overrides.notify ?? task.notify ?? false;
    return {
      name: task.name,
      space: task.space,
      topic: overrides.topic ?? task.topic ?? "",
      cadence: task.cadence ?? "daily",
      hour: String(task.hour ?? 8),
      timeoutMinutes: String(task.timeoutMinutes ?? 12),
      ...(enabled ? { enabled: "on" } : {}),
      ...(notify ? { notify: "on" } : {}),
      ...(task.distillOnRun ? { distillOnRun: "on" } : {}),
    };
  }

  private registerTemporaryAgentCleanup(input: {
    scenario: "agent_revision_lifecycle" | "writable_task_approval";
    label: string;
    originalAgentId: string;
    agentName: string;
    taskName: string;
    ownership: { agentId?: string; taskId?: string; runIds: string[] };
  }): SoakCleanupRegistration {
    const manualRecovery =
      `SIGKILL cannot be caught. Restore ${this.spaceId()} to Agent `
      + `${input.originalAgentId || "<default>"}; disable/delete Task named ${input.taskName}; `
      + `then remove Agent named ${input.agentName} only if no Space is bound to it.`;
    return this.cleanupRegistry.register({
      scenario: input.scenario,
      label: input.agentName,
      manualRecovery,
      interrupt: (reason) => this.interrupt(reason),
      cleanup: () => this.cleanupTemporaryAgentTask({
        label: input.label,
        originalAgentId: input.originalAgentId,
        agentName: input.agentName,
        taskName: input.taskName,
        agentId: input.ownership.agentId,
        taskId: input.ownership.taskId,
        runIds: input.ownership.runIds,
      }),
    });
  }

  private async waitForBinding(
    state: StoredFeishuBinding["state"],
  ): Promise<StoredFeishuBinding> {
    return this.poll(`group binding ${state}`, 15_000, async () => {
      const binding = this.storedBinding();
      return binding?.state === state ? binding : undefined;
    }, 250);
  }

  private async adminConnect(
    policy: Pick<
      StoredFeishuBinding,
      "responseMode" | "participationLevel" | "replyInThread"
    >,
  ): Promise<StoredFeishuBinding> {
    await postFeishuSoakAdminForm({
      adminUrl: this.options.adminUrl,
      adminToken: this.options.adminToken,
      path: "/integrations/groups/connect",
      form: {
        chatId: this.options.chatId,
        responseMode: policy.responseMode,
        ...(policy.participationLevel
          ? { participationLevel: policy.participationLevel }
          : {}),
        ...(policy.replyInThread ? { replyInThread: "on" } : {}),
      },
    });
    return this.waitForBinding("active");
  }

  private async adminDisconnect(spaceId: string): Promise<void> {
    await postFeishuSoakAdminForm({
      adminUrl: this.options.adminUrl,
      adminToken: this.options.adminToken,
      path: `/integrations/groups/${encodeURIComponent(spaceId)}/disconnect`,
      form: {},
    });
    await this.waitForBinding("disconnected");
  }

  private async lifecycleMentionProbe(label: string): Promise<{
    messageId: string;
    replyId: string;
    rawId: string;
  }> {
    const token = `${this.runMarker}-${label}`;
    const messageId = await this.sendText(
      this.mention(
        `连接生命周期验收：9 + 6 等于多少？请用中文数字回答，并原样包含 ${token}`,
      ),
      `${this.runMarker}-${label.toLowerCase()}`,
    );
    const [reply, raw] = await Promise.all([
      this.waitForBotReply(messageId, { includes: ["十五", token] }),
      this.poll("connected group capture", this.options.responseTimeoutMs, async () =>
        this.rawForMessage(messageId, token)
      ),
    ]);
    return {
      messageId,
      replyId: reply.message_id,
      rawId: raw.id,
    };
  }

  private async assertDisconnectedPrivacy(): Promise<void> {
    const token = `${this.runMarker}-DISCONNECTED`;
    const messageId = await this.sendText(
      this.mention(
        `断开期间不应收录或回复这条消息。隐私验收标记：${token}`,
      ),
      `${this.runMarker}-disconnected`,
    );
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      if (this.rawForMessage(messageId, token)) {
        throw new Error("disconnected group message was unexpectedly captured");
      }
      const root = flattenLarkMessages(await this.listMessages()).find(
        (candidate) => candidate.message_id === messageId,
      );
      if (!root) throw new Error("disconnected probe is not visible to the Bot");
      if (
        flattenLarkMessages(root.thread_replies ?? []).some(
          (candidate) => isBotMessage(candidate, this.options.botOpenId),
        )
      ) {
        throw new Error("disconnected group message unexpectedly received a reply");
      }
      await Bun.sleep(Math.min(5_000, Math.max(1, deadline - Date.now())));
    }
  }

  private async groupBindingLifecycle(): Promise<string> {
    const original = this.storedBinding();
    if (original?.state === "needs_reconnect") {
      throw new Error(
        "group_binding_lifecycle requires an active, disconnected, or new target group",
      );
    }
    const lifecyclePolicy = original
      ? {
        responseMode: original.responseMode,
        participationLevel: original.participationLevel,
        replyInThread: original.replyInThread,
      }
      : {
        responseMode: "mentions_only" as const,
        participationLevel: undefined,
        replyInThread: true,
      };
    let lifecycleSpaceId: string | undefined;
    try {
      const connected = await this.adminConnect(lifecyclePolicy);
      lifecycleSpaceId = connected.spaceId;
      await this.lifecycleMentionProbe("ACTIVE");

      await this.adminDisconnect(connected.spaceId);
      await this.assertDisconnectedPrivacy();

      const reconnected = await this.adminConnect(lifecyclePolicy);
      if (reconnected.spaceId !== lifecycleSpaceId) {
        throw new Error("reconnect did not reuse the original group workspace");
      }
      const resumed = await this.lifecycleMentionProbe("RECONNECTED");
      return resumed.replyId;
    } finally {
      const current = this.storedBinding();
      if (original) {
        const restored = await this.adminConnect({
          responseMode: original.responseMode,
          participationLevel: original.participationLevel,
          replyInThread: original.replyInThread,
        });
        if (restored.spaceId !== original.spaceId) {
          throw new Error("cleanup did not restore the original group workspace");
        }
        if (original.state === "disconnected") {
          await this.adminDisconnect(original.spaceId);
        }
      } else if (current) {
        await this.adminDisconnect(current.spaceId);
      }
    }
  }

  private mention(text: string): string {
    return `<at user_id="${this.options.botOpenId}">agent</at> ${text}`;
  }

  private async lark(args: string[], cwd = process.cwd(), attempts = 4): Promise<LarkCliEnvelope> {
    return invokeLarkCliWithRetry(args, cwd, {
      attempts,
      processRunner: this.processRunner,
    });
  }

  private async requireFullGroupMessageCapability(): Promise<void> {
    const result = await this.processRunner([
      "auth",
      "check",
      "--scope",
      "im:message.group_msg",
      "--json",
    ], process.cwd());
    let parsed: Record<string, unknown>;
    try {
      parsed = object(JSON.parse(result.stdout.trim()));
    } catch {
      throw new Error(
        "proactive_participation requires a verified im:message.group_msg capability",
      );
    }
    const missing = Array.isArray(parsed.missing) ? parsed.missing : [];
    const granted = Array.isArray(parsed.granted)
      ? parsed.granted
      : Array.isArray(parsed.scopes)
        ? parsed.scopes
        : [];
    if (
      result.exitCode !== 0
      || missing.includes("im:message.group_msg")
      || !granted.includes("im:message.group_msg")
    ) {
      throw new Error(
        "proactive_participation requires enterprise approval for im:message.group_msg",
      );
    }
  }

  private emitUiAction(action: UiUserAction): void {
    console.log(`[F5_USER_ACTION] ${JSON.stringify(action)}`);
  }

  private async waitForUiMessage(
    probe: string,
    notBefore: number,
    rootMessageId?: string,
  ): Promise<string> {
    const message = await this.poll("UI user action", this.options.responseTimeoutMs, async () =>
      findFreshUserMessage(await this.listMessages(), {
        botOpenId: this.options.botOpenId,
        notBefore,
        contentIncludes: probe,
        rootMessageId,
      })
    );
    return message.message_id;
  }

  private async sendText(text: string, idempotencyKey: string): Promise<string> {
    if (this.options.sender === "ui") {
      const request = uiText(text);
      const notBefore = Date.now();
      this.emitUiAction({
        type: "soak_user_action",
        action: "send_text",
        chatId: this.options.chatId,
        ...request,
      });
      return this.waitForUiMessage(uiProbe(text), notBefore);
    }
    const envelope = await this.lark([
      "im", "+messages-send",
      "--as", "user",
      "--chat-id", this.options.chatId,
      "--text", text,
      "--idempotency-key", idempotencyKey.slice(0, 50),
    ]);
    return messageIdFrom(envelope);
  }

  private async replyText(rootMessageId: string, text: string, key: string): Promise<string> {
    if (this.options.sender === "ui") {
      const request = uiText(text);
      const notBefore = Date.now();
      this.emitUiAction({
        type: "soak_user_action",
        action: "reply_text",
        chatId: this.options.chatId,
        rootMessageId,
        ...request,
      });
      return this.waitForUiMessage(uiProbe(text), notBefore, rootMessageId);
    }
    const envelope = await this.lark([
      "im", "+messages-reply",
      "--as", "user",
      "--message-id", rootMessageId,
      "--text", text,
      "--reply-in-thread",
      "--idempotency-key", key.slice(0, 50),
    ]);
    return messageIdFrom(envelope);
  }

  private async sendMedia(kind: "file" | "image", path: string, key: string): Promise<string> {
    if (this.options.sender === "ui") {
      const notBefore = Date.now();
      this.emitUiAction({
        type: "soak_user_action",
        action: kind === "image" ? "send_image" : "send_file",
        chatId: this.options.chatId,
        path,
      });
      return this.waitForUiMessage(kind === "image" ? "[图片]" : basename(path), notBefore);
    }
    const envelope = await this.lark([
      "im", "+messages-send",
      "--as", "user",
      "--chat-id", this.options.chatId,
      `--${kind}`, `./${basename(path)}`,
      "--idempotency-key", key.slice(0, 50),
    ], dirname(path));
    return messageIdFrom(envelope);
  }

  private async listMessagePage(pageToken?: string): Promise<LarkMessagePage> {
    const envelope = await this.lark([
      "im", "+chat-messages-list",
      "--as", "bot",
      "--chat-id", this.options.chatId,
      "--page-size", "50",
      "--order", "desc",
      "--no-reactions",
      ...(pageToken ? ["--page-token", pageToken] : []),
    ]);
    return messagePageFrom(envelope);
  }

  private async listMessages(): Promise<LarkMessage[]> {
    return (await this.listMessagePage()).messages;
  }

  private async listMessagesSince(windowStartedAt: number): Promise<LarkMessage[]> {
    return collectLarkMessagesSince(
      (pageToken) => this.listMessagePage(pageToken),
      windowStartedAt,
    );
  }

  private async poll<T>(
    label: string,
    timeoutMs: number,
    check: () => Promise<T | undefined>,
    intervalMs = 3_000,
    allowInterrupted = false,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      if (!allowInterrupted) this.assertNotInterrupted();
      try {
        const result = await check();
        if (!allowInterrupted) this.assertNotInterrupted();
        if (result !== undefined) return result;
      } catch (error) {
        lastError = error;
        if (!isTransientLarkFailure(error)) throw error;
      }
      await Bun.sleep(Math.min(intervalMs, Math.max(1, deadline - Date.now())));
    }
    throw new Error(`${label} timed out${lastError ? `: ${safeError(lastError)}` : ""}`);
  }

  private async waitForBotReply(
    rootMessageId: string,
    options: { includes?: string[]; pattern?: RegExp; timeoutMs?: number },
  ): Promise<LarkMessage> {
    return this.poll("bot reply", options.timeoutMs ?? this.options.responseTimeoutMs, async () =>
      findBotReply(await this.listMessages(), {
        botOpenId: this.options.botOpenId,
        rootMessageId,
        contentIncludes: options.includes,
        contentPattern: options.pattern,
      })
    );
  }

  private async waitForBotNotice(
    includes: string[],
    timeoutMs: number,
    notBefore?: number,
  ): Promise<LarkMessage> {
    return this.poll("bot notice", timeoutMs, async () =>
      flattenLarkMessages(await this.listMessages()).find((candidate) => {
        if (!isBotMessage(candidate, this.options.botOpenId)) return false;
        const content = candidate.content ?? "";
        const createdAt = candidate.create_time ? parseLarkCreateTime(candidate.create_time) : NaN;
        const freshEnough = notBefore === undefined
          || (Number.isFinite(createdAt) && createdAt >= notBefore - 60_000);
        return freshEnough
          && includes.every((part) => content.includes(part))
          && !looksLikeFailureReply(content);
      })
    );
  }

  private async assertNoBotReply(rootMessageId: string, observationMs: number): Promise<void> {
    const deadline = Date.now() + observationMs;
    while (Date.now() < deadline) {
      const root = flattenLarkMessages(await this.listMessages()).find(
        (candidate) => candidate.message_id === rootMessageId,
      );
      if (!root) throw new Error("message_capture root message is not visible to the bot");
      if (root && flattenLarkMessages(root.thread_replies ?? []).some(
        (candidate) => isBotMessage(candidate, this.options.botOpenId),
      )) {
        throw new Error("message_capture unexpectedly received a bot reply");
      }
      await Bun.sleep(Math.min(5_000, Math.max(1, deadline - Date.now())));
    }
  }

  private databasePath(): string {
    return join(
      this.options.dataDir,
      "workspaces",
      `team__${this.options.chatId}`,
      ".index.db",
    );
  }

  private rawForMessage(messageId: string, contentIncludes?: string): { id: string } | undefined {
    const database = new Database(this.databasePath(), { readonly: true });
    try {
      const row = contentIncludes
        ? database.query(
          "SELECT id FROM raw WHERE chat_id = ? AND message_id = ? AND content LIKE ? ORDER BY created DESC LIMIT 1",
        ).get(this.options.chatId, messageId, `%${contentIncludes}%`)
        : database.query(
          "SELECT id FROM raw WHERE chat_id = ? AND message_id = ? ORDER BY created DESC LIMIT 1",
        ).get(this.options.chatId, messageId);
      const id = object(row).id;
      return typeof id === "string" ? { id } : undefined;
    } finally {
      database.close();
    }
  }

  private pageForRaw(rawId: string): { slug: string; title: string } | undefined {
    const database = new Database(this.databasePath(), { readonly: true });
    try {
      const row = database.query(
        `SELECT slug, title FROM pages
         WHERE EXISTS (SELECT 1 FROM json_each(pages.sources_json) WHERE value = ?)
         ORDER BY updated DESC LIMIT 1`,
      ).get(rawId);
      const value = object(row);
      return typeof value.slug === "string" && typeof value.title === "string"
        ? { slug: value.slug, title: value.title }
        : undefined;
    } finally {
      database.close();
    }
  }

  private async messageCapture(): Promise<string> {
    const token = `${this.runMarker}-CAPTURE`;
    const messageId = await this.sendText(
      `【${this.runMarker}】家庭与团队自动验收事实：F5 收录口令是 ${token}。这是一条陈述，请静默收录。`,
      `${this.runMarker}-capture`,
    );
    const raw = await this.poll("message capture", this.options.responseTimeoutMs, async () =>
      this.rawForMessage(messageId, token)
    );
    this.captured = { messageId, rawId: raw.id, token };
    await this.assertNoBotReply(messageId, 45_000);
    return messageId;
  }

  private async mentionAnswer(): Promise<string> {
    const token = `${this.runMarker}-MENTION-OK`;
    const messageId = await this.sendText(
      this.mention(`自动验收问题：7 + 8 等于多少？请用中文数字回答，并原样包含 ${token}`),
      `${this.runMarker}-mention`,
    );
    const reply = await this.waitForBotReply(messageId, { includes: ["十五", token] });
    return reply.message_id;
  }

  private async proactiveParticipation(): Promise<string> {
    await this.requireFullGroupMessageCapability();
    const token = `${this.runMarker}-PROACTIVE-OK`;
    const messageId = await this.sendText(
      `这是面向全群的明确问题：7 + 6 等于多少？请用中文数字回答，并原样包含 ${token}。`,
      `${this.runMarker}-proactive`,
    );
    const reply = await this.waitForBotReply(messageId, { includes: ["十三", token] });
    return reply.message_id;
  }

  private async imageAnalysis(): Promise<string> {
    const imagePath = join(this.fixtureDir, `${this.runMarker}-red.png`);
    writeFileSync(imagePath, solidRedPng(), { mode: 0o600 });
    const rootMessageId = await this.sendMedia(
      "image",
      imagePath,
      `${this.runMarker}-image`,
    );
    const token = `${this.runMarker}-IMAGE-OK`;
    await this.replyText(
      rootMessageId,
      this.mention(`请识别这张纯色图片的主要颜色，不要猜测未看到的内容；回答颜色名称并原样附上 ${token}`),
      `${this.runMarker}-image-question`,
    );
    const reply = await this.waitForBotReply(rootMessageId, {
      includes: ["红色", token],
      timeoutMs: this.options.longTimeoutMs,
    });
    return reply.message_id;
  }

  private async attachmentExtraction(): Promise<string> {
    const token = `${this.runMarker}-ATTACHMENT`;
    const fixturePath = join(this.fixtureDir, `${this.runMarker}-attachment.txt`);
    writeFileSync(fixturePath, attachmentFixture(this.runMarker), { encoding: "utf8", mode: 0o600 });
    const messageId = await this.sendMedia(
      "file",
      fixturePath,
      `${this.runMarker}-attachment`,
    );
    await this.poll("attachment extraction", this.options.responseTimeoutMs, async () =>
      this.rawForMessage(messageId, token)
    );
    this.attachmentMessageId = messageId;
    return messageId;
  }

  private agentEditorForm(
    agent: StoredAgent,
    instruction: string,
    expectedHeadRevisionId: string,
    agentAction: "draft" | "publish",
  ): Record<string, string> {
    return {
      name: agent.name,
      instruction,
      provider: agent.provider,
      model: agent.model,
      reasoningEffort: agent.reasoningEffort,
      visibility: agent.visibility,
      permission: agent.permission,
      workdir: agent.workdir ?? "",
      skillSelectorPresent: "1",
      expectedHeadRevisionId,
      agentAction,
    };
  }

  private async startTaskRunFromAdmin(taskId: string): Promise<StoredTaskRun> {
    const response = await this.adminForm(`/tasks/${encodeURIComponent(taskId)}/run`);
    const runId = resourceIdFromAdminRedirect(response.location, "/tasks/runs/");
    return this.poll("Task Run creation", this.options.responseTimeoutMs, async () =>
      this.taskRuns().find((candidate) => candidate.id === runId), 250
    );
  }

  private async agentRevisionLifecycle(): Promise<string> {
    const originalSpace = this.storedSpace();
    if (!originalSpace) {
      throw new Error(
        `agent_revision_lifecycle requires an existing connected space: ${this.spaceId()}`,
      );
    }
    const windowStartedAt = currentSoakWindowStartedAt(
      this.options.monitorPath,
      this.options.windowStartedAt,
    );
    const originalAgentId = originalSpace.agentId ?? "";
    const v1Instruction = `${this.runMarker}-AGENT-V1 immutable acceptance instruction`;
    const v2Instruction = `${this.runMarker}-AGENT-V2 immutable acceptance instruction`;
    const agentName = `${this.runMarker}-release-gate`;
    const taskName = `${this.runMarker}-agent-lifecycle`;
    const v2Marker = `${this.runMarker}-V2-COMPLETE`;
    const rollbackMarker = `${this.runMarker}-ROLLBACK-COMPLETE`;
    const ownership: { agentId?: string; taskId?: string; runIds: string[] } = { runIds: [] };
    const cleanupRegistration = this.registerTemporaryAgentCleanup({
      scenario: "agent_revision_lifecycle",
      label: "acceptance",
      originalAgentId,
      agentName,
      taskName,
      ownership,
    });
    let artifactId: string | undefined;
    let scenarioError: unknown;

    try {
      const createdResponse = await this.adminForm("/agents", {
        name: agentName,
        instruction: v1Instruction,
        model: "",
        visibility: "Team",
        permission: "read-only",
        skillSelectorPresent: "1",
      });
      ownership.agentId = resourceIdFromAdminRedirect(createdResponse.location, "/agents/");
      const created = await this.poll("acceptance Agent creation", 15_000, async () =>
        this.storedAgent(ownership.agentId!), 250
      );
      const firstRevisionId = created.publishedRevisionId;
      if (!firstRevisionId) throw new Error("created Agent has no published v1 revision");
      await this.assignSpaceAgent(created.id);

      await this.adminForm(
        `/agents/${encodeURIComponent(created.id)}`,
        this.agentEditorForm(created, v2Instruction, firstRevisionId, "publish"),
      );
      const publishedV2 = await this.poll("Agent v2 publication", 15_000, async () => {
        const current = this.storedAgent(created.id);
        return current?.publishedRevisionId
          && current.publishedRevisionId !== firstRevisionId
          && current.instruction === v2Instruction
          ? current
          : undefined;
      }, 250);
      const secondRevisionId = publishedV2.publishedRevisionId!;

      const taskResponse = await this.adminForm("/tasks", {
        name: taskName,
        space: this.spaceId(),
        topic: `Return a concise acceptance result containing exactly ${v2Marker}.`,
        cadence: "daily",
        hour: "8",
        notify: "on",
        timeoutMinutes: String(Math.max(1, Math.ceil(this.options.longTimeoutMs / 60_000))),
      });
      ownership.taskId = resourceIdFromAdminRedirect(taskResponse.location, "/tasks/");
      const createdTask = await this.poll("acceptance Task creation", 15_000, async () =>
        this.tasks().find((task) => task.id === ownership.taskId), 250
      );
      if (createdTask.enabled !== false) {
        throw new Error("acceptance Task must remain scheduler-disabled during manual validation");
      }
      if (createdTask.notify !== true) {
        throw new Error("acceptance Task must enable completion notifications");
      }

      const v2Run = await this.startTaskRunFromAdmin(ownership.taskId);
      ownership.runIds.push(v2Run.id);
      if (!["queued", "running"].includes(v2Run.status)) {
        throw new Error(
          "v2 Task Run completed before the rollback boundary could be observed",
        );
      }

      await this.adminForm(
        `/agents/${encodeURIComponent(created.id)}/revisions/${encodeURIComponent(firstRevisionId)}/rollback`,
        { expectedHeadRevisionId: secondRevisionId },
      );
      const rolledBack = await this.poll("Agent v1 rollback publication", 15_000, async () => {
        const current = this.storedAgent(created.id);
        return current?.publishedRevisionId
          && current.publishedRevisionId !== secondRevisionId
          && current.instruction === v1Instruction
          ? current
          : undefined;
      }, 250);
      const rollbackRevisionId = rolledBack.publishedRevisionId!;
      await this.waitForTaskRunNotified(v2Run.id);

      const taskForRollback = this.tasks().find((task) => task.id === ownership.taskId);
      if (!taskForRollback) throw new Error("acceptance Task disappeared before rollback Run");
      await this.adminForm(
        `/tasks/${encodeURIComponent(taskForRollback.id)}`,
        this.taskEditorForm(taskForRollback, {
          topic: `Return a concise acceptance result containing exactly ${rollbackMarker}.`,
          notify: true,
        }),
      );
      await this.poll("rollback Task marker update", 15_000, async () => {
        const current = this.tasks().find((task) => task.id === taskForRollback.id);
        return current?.topic?.includes(rollbackMarker) && current.notify === true
          ? current
          : undefined;
      }, 250);

      const rollbackRun = await this.startTaskRunFromAdmin(ownership.taskId);
      ownership.runIds.push(rollbackRun.id);
      await this.waitForTaskRunNotified(rollbackRun.id);
      const revisions = this.storedAgentRevisions(created.id);
      const lifecycleRuns = this.taskRuns().filter((run) => run.taskId === ownership.taskId);
      const businessNotices = await this.listMessagesSince(windowStartedAt);
      artifactId = assertAgentRevisionLifecycleEvidence({
        agent: rolledBack,
        revisions,
        runs: lifecycleRuns,
        firstRevisionId,
        secondRevisionId,
        rollbackRevisionId,
        secondRevisionRunId: v2Run.id,
        rollbackRunId: rollbackRun.id,
        businessMarkers: { secondRevision: v2Marker, rollback: rollbackMarker },
        businessNotices,
        botOpenId: this.options.botOpenId,
      });
      this.platformEvidenceDetails.set("agent_revision_lifecycle", {
        triggerPath: "web_admin_post",
        windowStartedAt,
        resourceIds: {
          agentId: rolledBack.id,
          taskId: ownership.taskId,
          firstRevisionId,
          secondRevisionId,
          rollbackRevisionId,
          secondRevisionRunId: v2Run.id,
          rollbackRunId: rollbackRun.id,
        },
        revisions: revisions.filter((revision) =>
          [firstRevisionId, secondRevisionId, rollbackRevisionId].includes(revision.id)
        ).map((revision) => ({
          id: revision.id,
          source: revision.source,
          ...(revision.basedOnRevisionId
            ? { basedOnRevisionId: revision.basedOnRevisionId }
            : {}),
          snapshotSha256: sha256Evidence(revision.snapshot),
        })),
        runs: lifecycleRuns.filter((run) =>
          [v2Run.id, rollbackRun.id].includes(run.id)
        ).map(durableRunMetadata),
        messages: businessNotices.filter((message) =>
          [v2Marker, rollbackMarker].some((marker) => (message.content ?? "").includes(marker))
        ).map(durableMessageMetadata),
      });
    } catch (error) {
      scenarioError = error;
    }

    const cleanupErrors = await cleanupRegistration.cleanup();

    if (scenarioError) {
      throw new Error(
        `${safeError(scenarioError)}${cleanupErrors.length > 0
          ? `; cleanup failed: ${cleanupErrors.join("; ")}`
          : ""}`,
      );
    }
    if (cleanupErrors.length > 0) {
      throw new Error(`agent_revision_lifecycle cleanup failed: ${cleanupErrors.join("; ")}`);
    }
    if (!artifactId) throw new Error("agent_revision_lifecycle produced no evidence");
    return artifactId;
  }

  private async writableTaskApproval(): Promise<string> {
    const originalSpace = this.storedSpace();
    if (!originalSpace) {
      throw new Error(
        `writable_task_approval requires an existing connected space: ${this.spaceId()}`,
      );
    }
    const windowStartedAt = currentSoakWindowStartedAt(
      this.options.monitorPath,
      this.options.windowStartedAt,
    );
    const expired = this.taskRuns().find(
      (run) => run.id === this.options.approvalExpiredRunId,
    );
    if (!expired) {
      throw new Error(
        `expired approval Run is missing: ${this.options.approvalExpiredRunId}`,
      );
    }
    const idempotency = this.taskRuns().find(
      (run) => run.id === this.options.approvalIdempotencyRunId,
    );
    if (!idempotency) {
      throw new Error(
        `idempotency approval Run is missing: ${this.options.approvalIdempotencyRunId}`,
      );
    }
    if (expired.id === idempotency.id) {
      throw new Error("approval expiry and idempotency evidence require distinct Run ids");
    }
    if ([expired, idempotency].some((run) =>
      run.space !== this.spaceId() || run.startedAt < windowStartedAt
    )) {
      throw new Error("external approval evidence is outside the current soak window or space");
    }
    if (
      expired.status !== "cancelled"
      || expired.approval?.status !== "expired"
      || hasProviderExecutionEvidence(expired)
    ) {
      throw new Error("--approval-expired-run-id is not a zero-execution expired approval");
    }
    if (
      idempotency.status !== "succeeded"
      || idempotency.approval?.status !== "approved"
      || idempotency.approval.decidedAt === undefined
      || idempotency.runStartedAt === undefined
      || idempotency.runStartedAt < idempotency.approval.decidedAt
      || !hasProviderExecutionEvidence(idempotency)
      || idempotency.approvalNotification?.status !== "sent"
      || (idempotency.approvalNotification.attempts ?? 0) < 2
      || idempotency.approvalNotification.sentAt === undefined
      || idempotency.approvalNotification.sentAt > idempotency.approval.decidedAt
    ) {
      throw new Error(
        "--approval-idempotency-run-id is not an approved successful post-retry sample",
      );
    }

    const originalAgentId = originalSpace.agentId ?? "";
    const agentName = `${this.runMarker}-approval-gate`;
    const taskName = `${this.runMarker}-approval`;
    const completionMarker = `${this.runMarker}-APPROVED`;
    const ownership: { agentId?: string; taskId?: string; runIds: string[] } = { runIds: [] };
    const cleanupRegistration = this.registerTemporaryAgentCleanup({
      scenario: "writable_task_approval",
      label: "writable acceptance",
      originalAgentId,
      agentName,
      taskName,
      ownership,
    });
    let artifactId: string | undefined;
    let scenarioError: unknown;

    try {
      const createdResponse = await this.adminForm("/agents", {
        name: agentName,
        instruction: `${this.runMarker}-WRITE execute only after durable approval`,
        model: "",
        visibility: "Team",
        permission: "write",
        workdir: this.fixtureDir,
        skillSelectorPresent: "1",
      });
      ownership.agentId = resourceIdFromAdminRedirect(createdResponse.location, "/agents/");
      const agent = await this.poll("writable acceptance Agent creation", 15_000, async () =>
        this.storedAgent(ownership.agentId!), 250
      );
      if (agent.permission !== "write" || agent.workdir !== this.fixtureDir) {
        throw new Error("writable acceptance Agent did not persist its execution boundary");
      }
      await this.assignSpaceAgent(agent.id);

      const taskResponse = await this.adminForm("/tasks", {
        name: taskName,
        space: this.spaceId(),
        topic: `Do not modify files. Return a concise result containing ${completionMarker}.`,
        cadence: "daily",
        hour: "8",
        notify: "on",
        timeoutMinutes: String(Math.max(1, Math.ceil(this.options.longTimeoutMs / 60_000))),
      });
      ownership.taskId = resourceIdFromAdminRedirect(taskResponse.location, "/tasks/");
      const createdTask = await this.poll("writable acceptance Task creation", 15_000, async () =>
        this.tasks().find((task) => task.id === ownership.taskId), 250
      );
      if (createdTask.enabled !== false) {
        throw new Error("writable acceptance Task must remain scheduler-disabled");
      }
      if (createdTask.notify !== true) {
        throw new Error("writable acceptance Task must enable completion notifications");
      }

      const pendingRun = await this.startTaskRunFromAdmin(ownership.taskId);
      ownership.runIds.push(pendingRun.id);
      if (
        pendingRun.status !== "awaiting_approval"
        || pendingRun.approval?.status !== "pending"
        || hasProviderExecutionEvidence(pendingRun)
      ) {
        throw new Error("write Task did not stop before Provider execution for approval");
      }
      const pending = structuredClone(pendingRun);
      await this.poll("approval notification delivery", this.options.longTimeoutMs, async () => {
        const current = this.taskRuns().find((run) => run.id === pending.id);
        return current?.approvalNotification?.status === "sent" ? current : undefined;
      }, 2_000);
      await this.adminForm(`/tasks/runs/${encodeURIComponent(pending.id)}/approve`);
      const approved = await this.waitForTaskRunNotified(pending.id);

      const pendingReject = await this.startTaskRunFromAdmin(ownership.taskId);
      ownership.runIds.push(pendingReject.id);
      if (
        pendingReject.status !== "awaiting_approval"
        || pendingReject.approval?.status !== "pending"
        || hasProviderExecutionEvidence(pendingReject)
      ) {
        throw new Error("rejection sample executed before its approval decision");
      }
      await this.adminForm(`/tasks/runs/${encodeURIComponent(pendingReject.id)}/reject`);
      const rejected = await this.poll("approval rejection", 15_000, async () => {
        const current = this.taskRuns().find((run) => run.id === pendingReject.id);
        return current?.status === "cancelled" && current.approval?.status === "rejected"
          ? current
          : undefined;
      }, 250);

      const approvalNotices = await this.listMessagesSince(windowStartedAt);
      artifactId = assertWritableTaskApprovalEvidence({
        pending,
        approved,
        rejected,
        expired,
        idempotency,
        spaceId: this.spaceId(),
        windowStartedAt,
        approvalNotices,
        botOpenId: this.options.botOpenId,
        completionMarker,
      });
      this.platformEvidenceDetails.set("writable_task_approval", {
        triggerPath: "web_admin_post",
        windowStartedAt,
        resourceIds: {
          agentId: ownership.agentId,
          taskId: ownership.taskId,
          approvedRunId: approved.id,
          rejectedRunId: rejected.id,
          expiredRunId: expired.id,
          idempotencyRunId: idempotency.id,
        },
        runs: [pending, approved, rejected, expired, idempotency].map(durableRunMetadata),
        messages: approvalNotices.filter((message) => {
          const content = message.content ?? "";
          return content.includes(completionMarker) || content.includes(idempotency.id);
        }).map(durableMessageMetadata),
      });
    } catch (error) {
      scenarioError = error;
    }

    const cleanupErrors = await cleanupRegistration.cleanup();

    if (scenarioError) {
      throw new Error(
        `${safeError(scenarioError)}${cleanupErrors.length > 0
          ? `; cleanup failed: ${cleanupErrors.join("; ")}`
          : ""}`,
      );
    }
    if (cleanupErrors.length > 0) {
      throw new Error(`writable_task_approval cleanup failed: ${cleanupErrors.join("; ")}`);
    }
    if (!artifactId) throw new Error("writable_task_approval produced no evidence");
    return artifactId;
  }

  private async readonlyTaskRetry(): Promise<string> {
    const taskId = this.options.retryTaskId!;
    const marker = this.options.retryBusinessMarker!;
    const task = this.tasks().find((candidate) => candidate.id === taskId);
    if (!task) throw new Error(`retry acceptance Task is missing: ${taskId}`);
    if (task.space !== this.spaceId()) {
      throw new Error(`retry acceptance Task is not bound to ${this.spaceId()}`);
    }
    const windowStartedAt = currentSoakWindowStartedAt(
      this.options.monitorPath,
      this.options.windowStartedAt,
    );
    const runs = this.taskRuns().filter((run) =>
      run.taskId === taskId && run.startedAt >= windowStartedAt
    );
    const parent = runs
      .filter((run) =>
        run.trigger === "scheduled"
        && run.status === "failed"
        && run.retry?.status === "claimed"
        && run.retry.claimedByRunId
      )
      .sort((left, right) => right.startedAt - left.startedAt)[0];
    if (!parent?.retry?.claimedByRunId) {
      throw new Error(
        "readonly_task_retry requires a supervised transient Provider failure inside the soak window",
      );
    }
    const child = runs.find((run) => run.id === parent.retry!.claimedByRunId);
    if (!child) throw new Error("automatic retry child is missing from the soak window");
    const businessNotices = await this.listMessagesSince(windowStartedAt);
    const artifactId = assertReadonlyTaskRetryEvidence({
      runs,
      taskId,
      parentRunId: parent.id,
      retryRunId: child.id,
      windowStartedAt,
      businessMarker: marker,
      businessNotices,
      botOpenId: this.options.botOpenId,
    });
    this.platformEvidenceDetails.set("readonly_task_retry", {
      triggerPath: "production_scheduler_retry",
      windowStartedAt,
      resourceIds: {
        taskId,
        parentRunId: parent.id,
        retryRunId: child.id,
      },
      runs: [parent, child].map(durableRunMetadata),
      messages: businessNotices.filter((message) =>
        (message.content ?? "").includes(marker)
      ).map(durableMessageMetadata),
    });
    return artifactId;
  }

  private tasks(): StoredTask[] {
    return valuesFromFile<StoredTask>(join(this.options.dataDir, "config", "tasks.json"), "tasks");
  }

  private taskForResearch(): StoredTask {
    const selected = this.tasks()
      .filter((task) => task.space === `team/${this.options.chatId}`)
      .filter((task) => task.notify !== false)
      .filter((task) => !this.options.researchTaskName || task.name === this.options.researchTaskName)
      .at(-1);
    if (!selected) throw new Error("no notifying research task is configured for this chat");
    return selected;
  }

  private taskRuns(): StoredTaskRun[] {
    return valuesFromFile<StoredTaskRun>(
      join(this.options.dataDir, "config", "task-runs.json"),
      "runs",
    );
  }

  private async researchNotification(): Promise<string> {
    const windowStartedAt = firstSampleAt(this.options.monitorPath);
    if (windowStartedAt === undefined) {
      throw new Error(`cannot determine soak window start from ${this.options.monitorPath}`);
    }
    const selection = {
      chatId: this.options.chatId,
      windowStartedAt,
      taskName: this.options.researchTaskName,
    };
    let evidence = selectReusableResearchRun(this.tasks(), this.taskRuns(), selection);

    if (!evidence) {
      const active = selectInFlightResearchRun(this.tasks(), this.taskRuns(), selection);
      const pending = active ?? await (async () => {
        const task = this.taskForResearch();
        const sentAt = Date.now();
        await this.sendText(
          this.mention(`/task run ${task.name}`),
          `${this.runMarker}-research`,
        );
        const run = await this.poll("research task start", this.options.responseTimeoutMs, async () =>
          this.taskRuns()
            .filter((candidate) => candidate.taskId === task.id && candidate.startedAt >= sentAt)
            .sort((left, right) => right.startedAt - left.startedAt)[0]
        );
        return { task, run };
      })();
      const completed = await this.poll("research task completion", this.options.longTimeoutMs, async () => {
        const current = this.taskRuns().find((candidate) => candidate.id === pending.run.id);
        if (!current) return undefined;
        if (["failed", "timed_out", "cancelled"].includes(current.status)) {
          throw new Error(`research task ${current.id} ended with ${current.status}`);
        }
        return current.status === "succeeded" && current.notification?.status === "sent"
          ? current
          : undefined;
      }, 5_000);
      evidence = { task: pending.task, run: completed };
    }

    const notice = await this.waitForBotNotice(
      [`任务「${evidence.task.name}」已完成`],
      this.options.responseTimeoutMs,
      evidence.run.notification?.sentAt,
    );
    evidence.noticeMessageId = notice.message_id;
    return evidence.run.id;
  }

  private reminders(): StoredReminder[] {
    return valuesFromFile<StoredReminder>(
      join(this.options.dataDir, "config", "reminders.json"),
      "reminders",
    );
  }

  private async reminderDelivery(): Promise<string> {
    const token = `${this.runMarker}-REMINDER`;
    const messageId = await this.sendText(
      this.mention(`1分钟后提醒我 ${token}`),
      `${this.runMarker}-reminder`,
    );
    await this.waitForBotReply(messageId, { includes: ["已创建提醒", token] });
    const reminder = await this.poll("reminder persistence", this.options.responseTimeoutMs, async () =>
      this.reminders().find((candidate) => candidate.sourceMessageId === messageId)
    );
    await this.poll("reminder delivery", 3 * 60_000, async () => {
      const current = this.reminders().find((candidate) => candidate.id === reminder.id);
      return current?.lastNotifiedAt ? current : undefined;
    });
    await this.waitForBotNotice(["⏰ 提醒", token], this.options.responseTimeoutMs);
    return reminder.id;
  }

  private learningState(): {
    plans: StoredLearningPlan[];
    sessions: StoredLearningSession[];
  } {
    const path = join(this.options.dataDir, "config", "learning.json");
    return {
      plans: valuesFromFile<StoredLearningPlan>(path, "plans"),
      sessions: valuesFromFile<StoredLearningSession>(path, "sessions"),
    };
  }

  private async learningInteraction(): Promise<string> {
    if (!this.attachmentMessageId) {
      throw new Error("learning_interaction requires attachment_extraction in the same run");
    }
    const planName = `${this.runMarker}-学习计划`;
    await this.replyText(
      this.attachmentMessageId,
      `/learn new ${planName}`,
      `${this.runMarker}-learn-new`,
    );
    const created = await this.waitForBotReply(this.attachmentMessageId, {
      includes: ["已创建学习计划", planName],
      timeoutMs: this.options.longTimeoutMs,
    });
    void created;
    const plan = await this.poll("learning plan persistence", this.options.responseTimeoutMs, async () =>
      this.learningState().plans.find((candidate) => candidate.name === planName)
    );
    await this.waitForBotNotice([`📖 ${planName}`, "第 1 课"], this.options.longTimeoutMs);
    const session = await this.poll("learning session persistence", this.options.responseTimeoutMs, async () =>
      latestDeliveredLearningSession(this.learningState().sessions, plan.id)
    );
    const answerMessageId = await this.sendText(
      this.mention(`学习回答：我理解到重要结论要说明来源，操作步骤应可复现。${this.runMarker}`),
      `${this.runMarker}-learn-answer`,
    );
    await this.waitForBotReply(answerMessageId, {
      includes: ["已记录", planName],
      timeoutMs: this.options.longTimeoutMs,
    });
    await this.poll("learning answer persistence", this.options.responseTimeoutMs, async () => {
      const current = this.learningState().sessions.find((candidate) => candidate.id === session.id);
      return current?.status === "completed" && current.completedAt ? current : undefined;
    });
    return plan.id;
  }

  private async distillCitation(): Promise<string> {
    if (!this.captured) {
      throw new Error("distill_citation requires message_capture in the same run");
    }
    const commandMessageId = await this.sendText(
      this.mention("重新提炼"),
      `${this.runMarker}-distill`,
    );
    await this.waitForBotReply(commandMessageId, { includes: ["开始重新提炼"] });
    const page = await this.poll("manual distillation", this.options.longTimeoutMs, async () =>
      this.pageForRaw(this.captured!.rawId)
    );
    const messageId = await this.sendText(
      this.mention("刚才记录的 F5 收录口令是什么？请只依据知识库回答并引用来源。"),
      `${this.runMarker}-citation`,
    );
    const reply = await this.waitForBotReply(messageId, {
      includes: [this.captured.token, `[[${page.slug}|${page.title}]]`],
      timeoutMs: this.options.longTimeoutMs,
    });
    return reply.message_id;
  }

  private verifier(scenario: AutomatedScenario): () => Promise<string> {
    const verifiers: Record<AutomatedScenario, () => Promise<string>> = {
      group_binding_lifecycle: () => this.groupBindingLifecycle(),
      message_capture: () => this.messageCapture(),
      mention_answer: () => this.mentionAnswer(),
      proactive_participation: () => this.proactiveParticipation(),
      image_analysis: () => this.imageAnalysis(),
      attachment_extraction: () => this.attachmentExtraction(),
      research_notification: () => this.researchNotification(),
      reminder_delivery: () => this.reminderDelivery(),
      learning_interaction: () => this.learningInteraction(),
      distill_citation: () => this.distillCitation(),
      agent_revision_lifecycle: () => this.agentRevisionLifecycle(),
      writable_task_approval: () => this.writableTaskApproval(),
      readonly_task_retry: () => this.readonlyTaskRetry(),
    };
    return verifiers[scenario];
  }

  async run(): Promise<ScenarioResult[]> {
    const results: ScenarioResult[] = [];
    for (const scenario of this.options.scenarios) {
      console.log(`[F5] ${scenario}: running`);
      try {
        const evidence = isAgentPlatformScenario(scenario)
          ? await executeVerifiedAgentPlatformScenario(
            scenario,
            agentPlatformEvidencePath(this.options.evidencePath),
            this.verifier(scenario),
            () => this.platformEvidenceDetails.get(scenario),
          )
          : await executeVerifiedScenario(
            scenario,
            this.options.evidencePath,
            this.verifier(scenario),
          );
        results.push({ scenario, ok: true, artifactId: evidence.artifactId });
        console.log(`[F5] ${scenario}: passed (${evidence.artifactId})`);
      } catch (error) {
        const message = safeError(error);
        results.push({ scenario, ok: false, error: message });
        console.error(`[F5] ${scenario}: failed (${message})`);
        if (isAgentPlatformScenario(scenario) && !this.interruptedReason) {
          recordAgentPlatformFailureEvidence(
            agentPlatformEvidencePath(this.options.evidencePath),
            {
              at: Date.now(),
              scenario,
              ok: false,
              artifactId: `${this.runMarker}:${scenario}`,
              reason: message,
              cleanupErrors: /cleanup failed/iu.test(message) ? [message] : [],
              manualRecovery:
                `Inspect ${this.spaceId()}, disable/delete temporary Tasks named ${this.runMarker}-*, `
                + `and remove temporary Agents named ${this.runMarker}-* only when no Space binds them.`,
            },
          );
        }
        if (shouldAbortRemainingAgentPlatformScenarios(scenario, this.cleanupRegistry)) {
          console.error(
            `[F5] ${scenario}: cleanup ownership remains; aborting later Agent platform mutations`,
          );
          break;
        }
      }
    }
    return results;
  }
}

function printPlan(options: FeishuSoakDriverOptions): void {
  console.log(JSON.stringify({
    chatId: options.chatId,
    adminUrl: options.adminUrl,
    evidencePath: options.evidencePath,
    agentPlatformEvidencePath: agentPlatformEvidencePath(options.evidencePath),
    monitorPath: options.monitorPath,
    windowStartedAt: options.windowStartedAt
      ?? "required for Agent platform scenarios: current soak session epoch-ms or ISO timestamp",
    scenarios: options.scenarios,
    sender: options.sender,
    requiredUserScopes: options.sender === "api"
      ? ["im:message.send_as_user", "im:message", "im:resource:upload", "im:resource"]
      : [],
    uiActionPrefix: options.sender === "ui" ? "[F5_USER_ACTION]" : undefined,
    agentPlatformPreconditions: {
      triggerPath:
        "HomeAgent Web administration POST forms; this does not claim Feishu /task run coverage",
      writable_task_approval: {
        approvalExpiredRunId: options.approvalExpiredRunId
          ?? "required: production-expired zero-execution approval Run",
        approvalIdempotencyRunId: options.approvalIdempotencyRunId
          ?? "required: approval Run with >=2 delivery attempts and one visible Feishu notice",
        externalAction:
          "use production expiry and a supervised post-send delivery retry; the driver will not alter clocks or persistence",
      },
      readonly_task_retry: {
        retryTaskId: options.retryTaskId
          ?? "required: scheduled read-only fault-injection Task",
        retryBusinessMarker: options.retryBusinessMarker
          ?? "required: unique marker present in Provider output and Feishu notice",
        externalAction:
          "cause one transient Provider failure during the soak window, then restore it before the 60s retry",
      },
    },
    interruptionCleanup: {
      captured: ["SIGINT", "SIGTERM", "beforeExit"],
      timeoutSeconds: 45,
      sigkill:
        "SIGKILL cannot be caught: restore the target Space Agent binding, disable/delete F5-* temporary Tasks, then remove unbound F5-* temporary Agents.",
    },
    supervisedScenario: "network_recovery",
  }, null, 2));
}

if (import.meta.main) {
  try {
    const options = parseFeishuSoakOptions(process.argv.slice(2));
    if (!options.chatId) throw new Error("--chat-id is required");
    if (!options.botOpenId) throw new Error("--bot-open-id is required");
    if (options.dryRun) {
      printPlan(options);
    } else {
      assertAgentPlatformPreconditions(options);
      const cleanupRegistry = new SoakCleanupRegistry();
      const disposeShutdownHandlers = installSoakShutdownHandlers({
        registry: cleanupRegistry,
        processEvents: process,
        timeoutMs: 45_000,
        recordFailure: (failure) => {
          recordAgentPlatformFailureEvidence(
            agentPlatformEvidencePath(options.evidencePath),
            failure,
          );
          console.error(
            `[F5] ${failure.reason}: ${failure.manualRecovery}`,
          );
        },
        exit: (code) => process.exit(code),
      });
      const driver = new FeishuSoakDriver(options, defaultProcessRunner, cleanupRegistry);
      try {
        const results = await driver.run();
        const failed = results.filter((result) => !result.ok);
        console.log(JSON.stringify({
          passed: results.length - failed.length,
          failed: failed.length,
          supervisedRemaining: "network_recovery",
          results,
        }, null, 2));
        if (failed.length > 0) process.exitCode = 1;
      } finally {
        driver.close();
        if (cleanupRegistry.size === 0) disposeShutdownHandlers();
      }
    }
  } catch (error) {
    console.error(`soak:feishu: ${safeError(error)}`);
    process.exitCode = 1;
  }
}
