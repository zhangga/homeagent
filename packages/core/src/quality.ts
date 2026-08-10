/**
 * Durable local records for the AI quality loop. Full question/answer context is
 * kept on the user's machine for diagnosis; health snapshots expose aggregates
 * only and never include message content.
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
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { ProviderId } from "@homeagent/llm";
import { isSpaceId, type Citation, type SpaceId } from "@homeagent/shared";
import { durableFsyncSync, durableRenameSync } from "./durable-file.ts";
import {
  cloneAggregatedRunUsage,
  isAggregatedRunUsage,
  type AggregatedRunUsage,
} from "./usage.ts";

export type AnswerOutcome = "succeeded" | "failed" | "timed_out";
export const ANSWER_FEEDBACK_KINDS = [
  "helpful",
  "unhelpful",
  "citation_error",
] as const;
export type AnswerFeedbackKind = (typeof ANSWER_FEEDBACK_KINDS)[number];
export const NEGATIVE_ANSWER_FEEDBACK_KINDS = [
  "unhelpful",
  "citation_error",
] as const;
export type NegativeAnswerFeedbackKind = (typeof NEGATIVE_ANSWER_FEEDBACK_KINDS)[number];

export interface AnswerTraceSkill {
  sourceKey: string;
  skillFileHash: string;
}

export interface AnswerTraceExecution {
  agentId?: string;
  agentRevisionId?: string;
  provider?: ProviderId;
  model?: string;
  promptVersion: "ask-v1";
  instructionHash: string;
  skills: AnswerTraceSkill[];
}

export interface AnswerTraceRetrievalPage {
  space: SpaceId;
  slug: string;
  contentHash: string;
}

export interface AnswerTrace {
  id: string;
  spaces: SpaceId[];
  question: string;
  outcome: AnswerOutcome;
  source?: "knowledge" | "general";
  answer?: string;
  citations: Citation[];
  execution?: AnswerTraceExecution;
  retrievalPages?: AnswerTraceRetrievalPage[];
  usage?: AggregatedRunUsage;
  latencyMs: number;
  error?: string;
  createdAt: number;
}

export interface AnswerTraceInput {
  spaces: SpaceId[];
  question: string;
  outcome: AnswerOutcome;
  source?: "knowledge" | "general";
  answer?: string;
  citations: Citation[];
  execution?: AnswerTraceExecution;
  retrievalPages?: AnswerTraceRetrievalPage[];
  usage?: AggregatedRunUsage;
  latencyMs: number;
  error?: string;
  createdAt?: number;
}

export interface AnswerFeedback {
  id: string;
  traceId: string;
  kind: AnswerFeedbackKind;
  note?: string;
  createdAt: number;
  resolvedAt?: number;
  resolutionNote?: string;
  evaluationCaseId?: string;
}

export type QualityReviewStatus = "open" | "resolved";

export interface QualityEvaluationCase {
  id: string;
  traceId: string;
  spaces: SpaceId[];
  question: string;
  observedAnswer?: string;
  observedSource?: "knowledge" | "general";
  observedCitations: Citation[];
  feedbackKind: NegativeAnswerFeedbackKind;
  feedbackNote?: string;
  curatorNote: string;
  createdAt: number;
}

export type QualityRerunStatus = "running" | "completed" | "failed";

/**
 * Audit record for re-evaluating a durable Chat Run. This is intentionally a
 * rerun, not a deterministic replay: the frozen Agent plan is reused while the
 * knowledge base, provider service, and local environment may have changed.
 */
export interface QualityRerun {
  id: string;
  sourceChatRunId: string;
  sourceTraceId: string;
  candidateTraceId?: string;
  status: QualityRerunStatus;
  createdAt: number;
  completedAt?: number;
  error?: string;
}

/** Bounded quality evidence embedded in a portable space archive. */
export interface QualityArchive {
  traces: AnswerTrace[];
  reruns: QualityRerun[];
}

export interface QualityArchiveChatRun {
  id: string;
  traceId?: string;
}

export interface QualityArchiveRestoreReceipt {
  traceIds: string[];
  rerunIds: string[];
}

export interface StartQualityRerunInput {
  sourceChatRunId: string;
  sourceTraceId: string;
  createdAt?: number;
}

export interface AnswerFeedbackReview {
  trace: AnswerTrace;
  feedback: AnswerFeedback;
  status: QualityReviewStatus;
  evaluationCase?: QualityEvaluationCase;
}

export interface QualityReviewQuery {
  status?: QualityReviewStatus;
  spaces?: SpaceId[];
  kinds?: readonly AnswerFeedbackKind[];
}

export interface QualitySnapshot {
  answers: {
    total: number;
    succeeded: number;
    failed: number;
    timedOut: number;
    knowledge: number;
    general: number;
    averageLatencyMs: number;
    maxLatencyMs: number;
  };
  feedback: {
    total: number;
    helpful: number;
    unhelpful: number;
    citationError: number;
    helpfulRate?: number;
  };
}

interface QualityFile {
  version: 1;
  traces: AnswerTrace[];
  feedback: AnswerFeedback[];
  evaluationCases: QualityEvaluationCase[];
  reruns: QualityRerun[];
}

const MAX_TRACES = 1000;
const MAX_FEEDBACK = 2000;
const MAX_EVALUATION_CASES = 1000;
const MAX_RERUNS = 1000;
const MAX_QUESTION_LENGTH = 4000;
const MAX_ANSWER_LENGTH = 12_000;
const MAX_ERROR_LENGTH = 1000;
const MAX_NOTE_LENGTH = 1000;
const MAX_ARCHIVE_SPACES = 50;
const MAX_ARCHIVE_CITATIONS = 100;
const MAX_ARCHIVE_TEXT_LENGTH = 500;
const MAX_ARCHIVE_SPACE_ID_LENGTH = 600;
const FEEDBACK_KINDS = new Set<AnswerFeedbackKind>(ANSWER_FEEDBACK_KINDS);
const NEGATIVE_FEEDBACK_KINDS = new Set<AnswerFeedbackKind>(NEGATIVE_ANSWER_FEEDBACK_KINDS);

export function isAnswerFeedbackKind(value: unknown): value is AnswerFeedbackKind {
  return typeof value === "string" && FEEDBACK_KINDS.has(value as AnswerFeedbackKind);
}

export function isNegativeAnswerFeedbackKind(
  value: unknown,
): value is NegativeAnswerFeedbackKind {
  return isAnswerFeedbackKind(value) && NEGATIVE_FEEDBACK_KINDS.has(value);
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function bounded(value: string | undefined, limit: number): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, limit) : undefined;
}

function validCitation(value: unknown): value is Citation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const citation = value as Partial<Citation>;
  return typeof citation.slug === "string" && citation.slug.length > 0
    && typeof citation.title === "string" && citation.title.length > 0
    && (citation.space === undefined || (
      typeof citation.space === "string" && isSpaceId(citation.space)
    ));
}

function validTraceExecution(value: unknown): value is AnswerTraceExecution {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<AnswerTraceExecution>;
  return (item.agentId === undefined || (
    typeof item.agentId === "string" && item.agentId.length > 0 && item.agentId.length <= 200
  ))
    && (item.agentRevisionId === undefined || (
      typeof item.agentRevisionId === "string"
      && item.agentRevisionId.length > 0
      && item.agentRevisionId.length <= 200
    ))
    && (item.provider === undefined
      || ["gateway", "claude", "codex", "trae-cli"].includes(item.provider))
    && (item.model === undefined || (
      typeof item.model === "string" && item.model.length > 0 && item.model.length <= 200
    ))
    && item.promptVersion === "ask-v1"
    && typeof item.instructionHash === "string"
    && /^[0-9a-f]{64}$/u.test(item.instructionHash)
    && Array.isArray(item.skills)
    && item.skills.length <= 50
    && item.skills.every((skill) => (
      !!skill
      && typeof skill === "object"
      && !Array.isArray(skill)
      && typeof skill.sourceKey === "string"
      && skill.sourceKey.length > 0
      && skill.sourceKey.length <= 600
      && typeof skill.skillFileHash === "string"
      && /^[0-9a-f]{64}$/u.test(skill.skillFileHash)
    ));
}

function validTraceRetrievalPage(value: unknown): value is AnswerTraceRetrievalPage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<AnswerTraceRetrievalPage>;
  return typeof item.space === "string"
    && isSpaceId(item.space)
    && typeof item.slug === "string"
    && item.slug.length > 0
    && item.slug.length <= 500
    && typeof item.contentHash === "string"
    && item.contentHash.length > 0
    && item.contentHash.length <= 200;
}

function validTrace(value: unknown): value is AnswerTrace {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const trace = value as Partial<AnswerTrace>;
  return typeof trace.id === "string" && trace.id.length > 0
    && Array.isArray(trace.spaces)
    && trace.spaces.length > 0
    && trace.spaces.every((space) => typeof space === "string" && isSpaceId(space))
    && typeof trace.question === "string"
    && ["succeeded", "failed", "timed_out"].includes(trace.outcome ?? "")
    && (trace.source === undefined || trace.source === "knowledge" || trace.source === "general")
    && (trace.answer === undefined || typeof trace.answer === "string")
    && Array.isArray(trace.citations)
    && trace.citations.every(validCitation)
    && trace.citations.every((citation) => (
      citation.space === undefined || trace.spaces?.includes(citation.space) === true
    ))
    && (trace.execution === undefined || validTraceExecution(trace.execution))
    && (trace.retrievalPages === undefined || (
      Array.isArray(trace.retrievalPages)
      && trace.retrievalPages.length <= 50
      && trace.retrievalPages.every(validTraceRetrievalPage)
    ))
    && (trace.usage === undefined || isAggregatedRunUsage(trace.usage))
    && finiteNonNegative(trace.latencyMs)
    && (trace.error === undefined || typeof trace.error === "string")
    && finiteNonNegative(trace.createdAt);
}

function validFeedback(value: unknown): value is AnswerFeedback {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const feedback = value as Partial<AnswerFeedback>;
  return typeof feedback.id === "string" && feedback.id.length > 0
    && typeof feedback.traceId === "string" && feedback.traceId.length > 0
    && isAnswerFeedbackKind(feedback.kind)
    && (feedback.note === undefined || typeof feedback.note === "string")
    && finiteNonNegative(feedback.createdAt)
    && (
      (feedback.resolvedAt === undefined && feedback.resolutionNote === undefined)
      || (
        finiteNonNegative(feedback.resolvedAt)
        && typeof feedback.resolutionNote === "string"
        && feedback.resolutionNote.trim().length > 0
      )
    )
    && (feedback.evaluationCaseId === undefined || typeof feedback.evaluationCaseId === "string");
}

function validEvaluationCase(value: unknown): value is QualityEvaluationCase {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<QualityEvaluationCase>;
  return typeof item.id === "string" && item.id.length > 0
    && typeof item.traceId === "string" && item.traceId.length > 0
    && Array.isArray(item.spaces)
    && item.spaces.length > 0
    && item.spaces.every((space) => typeof space === "string" && isSpaceId(space))
    && typeof item.question === "string"
    && (item.observedAnswer === undefined || typeof item.observedAnswer === "string")
    && (
      item.observedSource === undefined
      || item.observedSource === "knowledge"
      || item.observedSource === "general"
    )
    && Array.isArray(item.observedCitations)
    && item.observedCitations.every(validCitation)
    && isNegativeAnswerFeedbackKind(item.feedbackKind)
    && (item.feedbackNote === undefined || typeof item.feedbackNote === "string")
    && typeof item.curatorNote === "string"
    && item.curatorNote.trim().length > 0
    && finiteNonNegative(item.createdAt);
}

function validRerun(value: unknown): value is QualityRerun {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<QualityRerun>;
  const terminal = item.status === "completed" || item.status === "failed";
  return typeof item.id === "string" && item.id.length > 0 && item.id.length <= 200
    && typeof item.sourceChatRunId === "string"
    && item.sourceChatRunId.length > 0
    && item.sourceChatRunId.length <= 200
    && typeof item.sourceTraceId === "string"
    && item.sourceTraceId.length > 0
    && item.sourceTraceId.length <= 200
    && (item.candidateTraceId === undefined || (
      typeof item.candidateTraceId === "string"
      && item.candidateTraceId.length > 0
      && item.candidateTraceId.length <= 200
    ))
    && ["running", "completed", "failed"].includes(String(item.status))
    && finiteNonNegative(item.createdAt)
    && (item.completedAt === undefined || (
      finiteNonNegative(item.completedAt)
      && item.completedAt >= item.createdAt
    ))
    && (item.error === undefined || (
      typeof item.error === "string"
      && item.error.length > 0
      && item.error.length <= MAX_ERROR_LENGTH
    ))
    && (terminal ? item.completedAt !== undefined : item.completedAt === undefined)
    && (item.status === "completed"
      ? item.candidateTraceId !== undefined && item.error === undefined
      : item.candidateTraceId === undefined)
    && (item.status === "failed" ? item.error !== undefined : item.error === undefined);
}

function validArchiveTrace(value: unknown): value is AnswerTrace {
  if (!validTrace(value)) return false;
  return value.id.length <= 200
    && value.spaces.length <= MAX_ARCHIVE_SPACES
    && new Set(value.spaces).size === value.spaces.length
    && value.spaces.every((space) => space.length <= MAX_ARCHIVE_SPACE_ID_LENGTH)
    && value.question.length <= MAX_QUESTION_LENGTH
    && (value.answer === undefined || value.answer.length <= MAX_ANSWER_LENGTH)
    && value.citations.length <= MAX_ARCHIVE_CITATIONS
    && value.citations.every((citation) => (
      citation.slug.length <= MAX_ARCHIVE_TEXT_LENGTH
      && citation.title.length <= MAX_ARCHIVE_TEXT_LENGTH
      && (citation.space === undefined || citation.space.length <= MAX_ARCHIVE_SPACE_ID_LENGTH)
    ))
    && (value.error === undefined || value.error.length <= MAX_ERROR_LENGTH);
}

/** Strictly validate untrusted quality evidence before any durable restore write. */
export function parseQualityArchive(value: unknown): QualityArchive {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("quality archive must be an object");
  }
  const root = value as Partial<QualityArchive>;
  if (!Array.isArray(root.traces) || !Array.isArray(root.reruns)) {
    throw new Error("quality archive collections must be arrays");
  }
  if (root.traces.length > MAX_TRACES) {
    throw new Error(`quality archive exceeds ${MAX_TRACES} traces`);
  }
  if (root.reruns.length > MAX_RERUNS) {
    throw new Error(`quality archive exceeds ${MAX_RERUNS} reruns`);
  }
  if (root.traces.some((trace) => !validArchiveTrace(trace))) {
    throw new Error("quality archive contains an invalid answer trace");
  }
  if (root.reruns.some((rerun) => !validRerun(rerun) || rerun.status === "running")) {
    throw new Error("quality archive contains an invalid or active rerun audit");
  }
  const traceIds = new Set<string>();
  for (const trace of root.traces) {
    if (traceIds.has(trace.id)) throw new Error(`duplicate quality trace id: ${trace.id}`);
    traceIds.add(trace.id);
  }
  const rerunIds = new Set<string>();
  for (const rerun of root.reruns) {
    if (rerunIds.has(rerun.id)) throw new Error(`duplicate quality rerun id: ${rerun.id}`);
    rerunIds.add(rerun.id);
    if (
      !traceIds.has(rerun.sourceTraceId)
      || (rerun.candidateTraceId !== undefined && !traceIds.has(rerun.candidateTraceId))
    ) {
      throw new Error(`quality rerun trace is missing from archive: ${rerun.id}`);
    }
  }
  return {
    traces: root.traces.map(cloneTrace),
    reruns: root.reruns.map(cloneRerun),
  };
}

function cloneTrace(trace: AnswerTrace): AnswerTrace {
  return {
    ...trace,
    spaces: [...trace.spaces],
    citations: trace.citations.map((citation) => ({ ...citation })),
    execution: trace.execution
      ? {
          ...trace.execution,
          skills: trace.execution.skills.map((skill) => ({ ...skill })),
        }
      : undefined,
    retrievalPages: trace.retrievalPages?.map((page) => ({ ...page })),
    usage: trace.usage ? cloneAggregatedRunUsage(trace.usage) : undefined,
  };
}

function cloneEvaluationCase(item: QualityEvaluationCase): QualityEvaluationCase {
  return {
    ...item,
    spaces: [...item.spaces],
    observedCitations: item.observedCitations.map((citation) => ({ ...citation })),
  };
}

function cloneRerun(item: QualityRerun): QualityRerun {
  return { ...item };
}

function canonicalJson(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (!item || typeof item !== "object") return item;
    const normalized: Record<string, unknown> = {};
    const record = item as Record<string, unknown>;
    for (const key of Object.keys(record).sort()) {
      if (record[key] !== undefined) normalized[key] = normalize(record[key]);
    }
    return normalized;
  };
  return JSON.stringify(normalize(value));
}

function sameTrace(left: AnswerTrace, right: AnswerTrace): boolean {
  return canonicalJson(cloneTrace(left)) === canonicalJson(cloneTrace(right));
}

function sameRerun(left: QualityRerun, right: QualityRerun): boolean {
  return canonicalJson(cloneRerun(left)) === canonicalJson(cloneRerun(right));
}

export class QualityStore {
  private readonly configPath: string;
  private readonly archiveRestoreReceipts = new WeakSet<QualityArchiveRestoreReceipt>();
  private traces: AnswerTrace[];
  private feedbackRecords: AnswerFeedback[];
  private evaluationCaseRecords: QualityEvaluationCase[];
  private rerunRecords: QualityRerun[];

  constructor(dataDir: string) {
    this.configPath = join(dataDir, "quality", "quality.json");
    const loaded = this.load();
    this.traces = loaded.traces;
    this.feedbackRecords = loaded.feedback;
    this.evaluationCaseRecords = loaded.evaluationCases;
    this.rerunRecords = loaded.reruns;
    this.recoverInterruptedReruns();
  }

  private recoverInterruptedReruns(): void {
    if (!this.rerunRecords.some((item) => item.status === "running")) return;
    const now = Date.now();
    const reruns = this.rerunRecords.map((item): QualityRerun => item.status === "running"
      ? {
          ...item,
          status: "failed",
          completedAt: Math.max(now, item.createdAt),
          error: "The application stopped before the evaluation rerun completed.",
        }
      : item);
    this.persist(this.traces, this.feedbackRecords, this.evaluationCaseRecords, reruns);
    this.rerunRecords = reruns;
  }

  private load(): QualityFile {
    if (!existsSync(this.configPath)) {
      return { version: 1, traces: [], feedback: [], evaluationCases: [], reruns: [] };
    }
    try {
      const parsed = JSON.parse(readFileSync(this.configPath, "utf8")) as Partial<QualityFile>;
      const traces = Array.isArray(parsed.traces)
        ? parsed.traces.filter(validTrace).slice(-MAX_TRACES).map(cloneTrace)
        : [];
      const traceIds = new Set(traces.map((trace) => trace.id));
      const feedback = Array.isArray(parsed.feedback)
        ? parsed.feedback
          .filter(validFeedback)
          .filter((record) => traceIds.has(record.traceId))
          .slice(-MAX_FEEDBACK)
          .map((record) => ({ ...record }))
        : [];
      const evaluationCases = Array.isArray(parsed.evaluationCases)
        ? parsed.evaluationCases
          .filter(validEvaluationCase)
          .slice(-MAX_EVALUATION_CASES)
          .map(cloneEvaluationCase)
        : [];
      const reruns = Array.isArray(parsed.reruns)
        ? parsed.reruns
          .filter(validRerun)
          .filter((item) => (
            traceIds.has(item.sourceTraceId)
            && (item.candidateTraceId === undefined || traceIds.has(item.candidateTraceId))
          ))
          .slice(-MAX_RERUNS)
          .map(cloneRerun)
        : [];
      return { version: 1, traces, feedback, evaluationCases, reruns };
    } catch {
      return { version: 1, traces: [], feedback: [], evaluationCases: [], reruns: [] };
    }
  }

  private persist(
    traces = this.traces,
    feedback = this.feedbackRecords,
    evaluationCases = this.evaluationCaseRecords,
    reruns = this.rerunRecords,
  ): void {
    const directory = dirname(this.configPath);
    mkdirSync(directory, { recursive: true });
    const temporaryPath = `${this.configPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(
        temporaryPath,
        JSON.stringify({
          version: 1,
          traces,
          feedback,
          evaluationCases,
          reruns,
        } satisfies QualityFile, null, 2),
        { encoding: "utf8", mode: 0o600 },
      );
      const fileDescriptor = openSync(temporaryPath, "r+");
      try {
        durableFsyncSync(fileDescriptor);
      } finally {
        closeSync(fileDescriptor);
      }
      durableRenameSync(temporaryPath, this.configPath);
      const directoryDescriptor = openSync(directory, "r");
      try {
        durableFsyncSync(directoryDescriptor, {
          allowUnsupportedDirectoryOnWindows: true,
        });
      } finally {
        closeSync(directoryDescriptor);
      }
    } catch (err) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // The rename may already have consumed the temporary path.
      }
      throw err;
    }
  }

  recordTrace(input: AnswerTraceInput): AnswerTrace {
    const execution = input.execution
      ? {
          ...input.execution,
          skills: input.execution.skills.slice(0, 50).map((skill) => ({ ...skill })),
        }
      : undefined;
    const retrievalPages = input.retrievalPages
      ?.slice(0, 50)
      .map((page) => ({ ...page }));
    if (execution !== undefined && !validTraceExecution(execution)) {
      throw new Error("answer trace execution evidence is invalid");
    }
    if (retrievalPages?.some((page) => !validTraceRetrievalPage(page))) {
      throw new Error("answer trace retrieval evidence is invalid");
    }
    const usage = input.usage ? cloneAggregatedRunUsage(input.usage) : undefined;
    if (usage !== undefined && !isAggregatedRunUsage(usage)) {
      throw new Error("answer trace usage evidence is invalid");
    }
    const trace: AnswerTrace = {
      id: `answer_${randomUUID()}`,
      spaces: [...new Set(input.spaces.filter(isSpaceId))],
      question: input.question.slice(0, MAX_QUESTION_LENGTH),
      outcome: input.outcome,
      source: input.source,
      answer: bounded(input.answer, MAX_ANSWER_LENGTH),
      citations: input.citations.map((citation) => ({ ...citation })),
      execution,
      retrievalPages,
      usage,
      latencyMs: Math.max(0, Math.round(input.latencyMs)),
      error: bounded(input.error, MAX_ERROR_LENGTH),
      createdAt: input.createdAt ?? Date.now(),
    };
    const traces = [...this.traces, trace].slice(-MAX_TRACES);
    const traceIds = new Set(traces.map((record) => record.id));
    const feedback = this.feedbackRecords
      .filter((record) => traceIds.has(record.traceId))
      .slice(-MAX_FEEDBACK);
    const reruns = this.rerunRecords.filter((item) => (
      traceIds.has(item.sourceTraceId)
      && (item.candidateTraceId === undefined || traceIds.has(item.candidateTraceId))
    ));
    this.persist(traces, feedback, this.evaluationCaseRecords, reruns);
    this.traces = traces;
    this.feedbackRecords = feedback;
    this.rerunRecords = reruns;
    return cloneTrace(trace);
  }

  exportArchive(chatRuns: readonly QualityArchiveChatRun[]): QualityArchive {
    const traces: AnswerTrace[] = [];
    const included = new Set<string>();
    const sourceTraceByChatRun = new Map<string, string>();
    for (const run of chatRuns) {
      if (run.traceId) sourceTraceByChatRun.set(run.id, run.traceId);
      if (!run.traceId || included.has(run.traceId)) continue;
      const trace = this.traces.find((item) => item.id === run.traceId);
      if (!trace) throw new Error(`chat run source trace is unavailable: ${run.traceId}`);
      traces.push(cloneTrace(trace));
      included.add(trace.id);
    }
    const reruns = this.rerunRecords
      .filter((rerun) => (
        rerun.status !== "running"
        && sourceTraceByChatRun.get(rerun.sourceChatRunId) === rerun.sourceTraceId
      ))
      .map(cloneRerun);
    for (const rerun of reruns) {
      if (!rerun.candidateTraceId || included.has(rerun.candidateTraceId)) continue;
      const trace = this.traces.find((item) => item.id === rerun.candidateTraceId);
      if (!trace) throw new Error(`quality rerun candidate trace is unavailable: ${rerun.id}`);
      traces.push(cloneTrace(trace));
      included.add(trace.id);
    }
    return parseQualityArchive({ traces, reruns });
  }

  assertCanRestoreArchive(value: unknown): QualityArchive {
    const archive = parseQualityArchive(value);
    const traceById = new Map(this.traces.map((trace) => [trace.id, trace]));
    const rerunById = new Map(this.rerunRecords.map((rerun) => [rerun.id, rerun]));
    for (const trace of archive.traces) {
      const existing = traceById.get(trace.id);
      if (existing && !sameTrace(existing, trace)) {
        throw new Error(`quality trace id already exists with different data: ${trace.id}`);
      }
    }
    for (const rerun of archive.reruns) {
      const existing = rerunById.get(rerun.id);
      if (existing && !sameRerun(existing, rerun)) {
        throw new Error(`quality rerun id already exists with different data: ${rerun.id}`);
      }
    }
    const addedTraceCount = archive.traces.filter((trace) => !traceById.has(trace.id)).length;
    const addedRerunCount = archive.reruns.filter((rerun) => !rerunById.has(rerun.id)).length;
    if (this.traces.length + addedTraceCount > MAX_TRACES) {
      throw new Error(`quality store exceeds ${MAX_TRACES} traces`);
    }
    if (this.rerunRecords.length + addedRerunCount > MAX_RERUNS) {
      throw new Error(`quality store exceeds ${MAX_RERUNS} reruns`);
    }
    return archive;
  }

  restoreArchive(value: unknown): QualityArchiveRestoreReceipt {
    const archive = this.assertCanRestoreArchive(value);
    const traceById = new Map(this.traces.map((trace) => [trace.id, trace]));
    const rerunById = new Map(this.rerunRecords.map((rerun) => [rerun.id, rerun]));
    const addedTraces = archive.traces.filter((trace) => !traceById.has(trace.id));
    const addedReruns = archive.reruns.filter((rerun) => !rerunById.has(rerun.id));
    const traces = [...this.traces, ...addedTraces];
    const reruns = [...this.rerunRecords, ...addedReruns];
    if (addedTraces.length === 0 && addedReruns.length === 0) {
      const receipt = { traceIds: [], rerunIds: [] };
      this.archiveRestoreReceipts.add(receipt);
      return receipt;
    }
    this.persist(traces, this.feedbackRecords, this.evaluationCaseRecords, reruns);
    this.traces = traces;
    this.rerunRecords = reruns;
    const receipt = {
      traceIds: addedTraces.map((trace) => trace.id),
      rerunIds: addedReruns.map((rerun) => rerun.id),
    };
    this.archiveRestoreReceipts.add(receipt);
    return receipt;
  }

  rollbackArchiveRestore(receipt: QualityArchiveRestoreReceipt): void {
    if (!this.archiveRestoreReceipts.has(receipt)) {
      throw new Error("quality archive restore receipt is invalid or already rolled back");
    }
    if (receipt.traceIds.length === 0 && receipt.rerunIds.length === 0) {
      this.archiveRestoreReceipts.delete(receipt);
      return;
    }
    const traceIds = new Set(receipt.traceIds);
    const rerunIds = new Set(receipt.rerunIds);
    const traces = this.traces.filter((trace) => !traceIds.has(trace.id));
    const reruns = this.rerunRecords.filter((rerun) => !rerunIds.has(rerun.id));
    this.persist(traces, this.feedbackRecords, this.evaluationCaseRecords, reruns);
    this.traces = traces;
    this.rerunRecords = reruns;
    this.archiveRestoreReceipts.delete(receipt);
  }

  trace(id: string): AnswerTrace | undefined {
    const trace = this.traces.find((record) => record.id === id);
    return trace ? cloneTrace(trace) : undefined;
  }

  traceBelongsToSpace(id: string, space: SpaceId): boolean {
    return this.traces.some((trace) => trace.id === id && trace.spaces.includes(space));
  }

  recordFeedback(
    traceId: string,
    kind: AnswerFeedbackKind,
    note?: string,
    createdAt = Date.now(),
  ): AnswerFeedback | undefined {
    if (!isAnswerFeedbackKind(kind)) return undefined;
    if (!this.traces.some((trace) => trace.id === traceId)) return undefined;
    if (this.feedbackRecords.some((record) => record.traceId === traceId)) return undefined;
    const record: AnswerFeedback = {
      id: `feedback_${randomUUID()}`,
      traceId,
      kind,
      note: bounded(note, MAX_NOTE_LENGTH),
      createdAt,
    };
    const feedback = [...this.feedbackRecords, record].slice(-MAX_FEEDBACK);
    this.persist(this.traces, feedback);
    this.feedbackRecords = feedback;
    return { ...record };
  }

  feedbackFor(traceId: string): AnswerFeedback | undefined {
    const record = this.feedbackRecords.find((feedback) => feedback.traceId === traceId);
    return record ? { ...record } : undefined;
  }

  feedbackReviews(query: QualityReviewQuery = {}): AnswerFeedbackReview[] {
    const spaces = query.spaces ? new Set(query.spaces) : undefined;
    const kinds = query.kinds ? new Set(query.kinds) : undefined;
    const traces = new Map(this.traces.map((trace) => [trace.id, trace]));
    const evaluationCases = new Map(
      this.evaluationCaseRecords.map((item) => [item.id, item]),
    );
    const reviews: AnswerFeedbackReview[] = [];
    for (const feedback of this.feedbackRecords) {
      const trace = traces.get(feedback.traceId);
      if (!trace) continue;
      const status: QualityReviewStatus = feedback.resolvedAt === undefined ? "open" : "resolved";
      if (query.status && query.status !== status) continue;
      if (spaces && !trace.spaces.some((space) => spaces.has(space))) continue;
      if (kinds && !kinds.has(feedback.kind)) continue;
      const evaluationCase = feedback.evaluationCaseId
        ? evaluationCases.get(feedback.evaluationCaseId)
        : undefined;
      reviews.push({
        trace: cloneTrace(trace),
        feedback: { ...feedback },
        status,
        ...(evaluationCase ? { evaluationCase: cloneEvaluationCase(evaluationCase) } : {}),
      });
    }
    return reviews;
  }

  promoteFeedbackToEvaluationCase(
    traceId: string,
    curatorNote: string,
    createdAt = Date.now(),
  ): QualityEvaluationCase | undefined {
    const normalizedNote = bounded(curatorNote, MAX_NOTE_LENGTH);
    if (!normalizedNote) return undefined;
    const feedbackIndex = this.feedbackRecords.findIndex((item) => item.traceId === traceId);
    if (feedbackIndex < 0) return undefined;
    const feedback = this.feedbackRecords[feedbackIndex]!;
    if (!isNegativeAnswerFeedbackKind(feedback.kind) || feedback.evaluationCaseId) {
      return undefined;
    }
    const trace = this.traces.find((item) => item.id === traceId);
    if (!trace) return undefined;
    const item: QualityEvaluationCase = {
      id: `evaluation_${randomUUID()}`,
      traceId,
      spaces: [...trace.spaces],
      question: trace.question,
      observedAnswer: trace.answer,
      observedSource: trace.source,
      observedCitations: trace.citations.map((citation) => ({ ...citation })),
      feedbackKind: feedback.kind,
      feedbackNote: feedback.note,
      curatorNote: normalizedNote,
      createdAt,
    };
    const evaluationCases = [...this.evaluationCaseRecords, item].slice(-MAX_EVALUATION_CASES);
    const feedbackRecords = this.feedbackRecords.map((record, index) =>
      index === feedbackIndex ? { ...record, evaluationCaseId: item.id } : record
    );
    this.persist(this.traces, feedbackRecords, evaluationCases);
    this.feedbackRecords = feedbackRecords;
    this.evaluationCaseRecords = evaluationCases;
    return cloneEvaluationCase(item);
  }

  resolveFeedback(
    traceId: string,
    resolutionNote: string,
    resolvedAt = Date.now(),
  ): AnswerFeedback | undefined {
    const normalizedNote = bounded(resolutionNote, MAX_NOTE_LENGTH);
    if (!normalizedNote) return undefined;
    const feedbackIndex = this.feedbackRecords.findIndex((item) => item.traceId === traceId);
    const feedback = this.feedbackRecords[feedbackIndex];
    if (
      !feedback
      || !isNegativeAnswerFeedbackKind(feedback.kind)
      || feedback.resolvedAt !== undefined
    ) {
      return undefined;
    }
    const updated = {
      ...feedback,
      resolvedAt,
      resolutionNote: normalizedNote,
    };
    const feedbackRecords = this.feedbackRecords.map((record, index) =>
      index === feedbackIndex ? updated : record
    );
    this.persist(this.traces, feedbackRecords);
    this.feedbackRecords = feedbackRecords;
    return { ...updated };
  }

  evaluationCases(): QualityEvaluationCase[] {
    return this.evaluationCaseRecords.map(cloneEvaluationCase);
  }

  startRerun(input: StartQualityRerunInput): QualityRerun | undefined {
    if (!this.traces.some((trace) => trace.id === input.sourceTraceId)) return undefined;
    const sourceChatRunId = input.sourceChatRunId.trim();
    if (!sourceChatRunId || sourceChatRunId.length > 200) return undefined;
    const createdAt = input.createdAt ?? Date.now();
    if (!finiteNonNegative(createdAt)) return undefined;
    const item: QualityRerun = {
      id: `rerun_${randomUUID()}`,
      sourceChatRunId,
      sourceTraceId: input.sourceTraceId,
      status: "running",
      createdAt,
    };
    const reruns = [...this.rerunRecords, item].slice(-MAX_RERUNS);
    this.persist(this.traces, this.feedbackRecords, this.evaluationCaseRecords, reruns);
    this.rerunRecords = reruns;
    return cloneRerun(item);
  }

  completeRerun(
    id: string,
    candidateTraceId: string,
    completedAt = Date.now(),
  ): QualityRerun | undefined {
    const index = this.rerunRecords.findIndex((item) => item.id === id);
    const current = this.rerunRecords[index];
    if (
      !current
      || current.status !== "running"
      || !this.traces.some((trace) => trace.id === candidateTraceId)
      || !finiteNonNegative(completedAt)
      || completedAt < current.createdAt
    ) {
      return undefined;
    }
    const updated: QualityRerun = {
      ...current,
      status: "completed",
      candidateTraceId,
      completedAt,
    };
    const reruns = this.rerunRecords.map((item, itemIndex) =>
      itemIndex === index ? updated : item
    );
    this.persist(this.traces, this.feedbackRecords, this.evaluationCaseRecords, reruns);
    this.rerunRecords = reruns;
    return cloneRerun(updated);
  }

  failRerun(id: string, error: string, completedAt = Date.now()): QualityRerun | undefined {
    const index = this.rerunRecords.findIndex((item) => item.id === id);
    const current = this.rerunRecords[index];
    const normalizedError = bounded(error, MAX_ERROR_LENGTH);
    if (
      !current
      || current.status !== "running"
      || !normalizedError
      || !finiteNonNegative(completedAt)
      || completedAt < current.createdAt
    ) {
      return undefined;
    }
    const updated: QualityRerun = {
      ...current,
      status: "failed",
      completedAt,
      error: normalizedError,
    };
    const reruns = this.rerunRecords.map((item, itemIndex) =>
      itemIndex === index ? updated : item
    );
    this.persist(this.traces, this.feedbackRecords, this.evaluationCaseRecords, reruns);
    this.rerunRecords = reruns;
    return cloneRerun(updated);
  }

  rerunsForChatRun(sourceChatRunId: string): QualityRerun[] {
    return this.rerunRecords
      .filter((item) => item.sourceChatRunId === sourceChatRunId)
      .sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id))
      .map(cloneRerun);
  }

  snapshot(): QualitySnapshot {
    const succeeded = this.traces.filter((trace) => trace.outcome === "succeeded").length;
    const failed = this.traces.filter((trace) => trace.outcome === "failed").length;
    const timedOut = this.traces.filter((trace) => trace.outcome === "timed_out").length;
    const knowledge = this.traces.filter((trace) => trace.source === "knowledge").length;
    const general = this.traces.filter((trace) => trace.source === "general").length;
    const totalLatency = this.traces.reduce((sum, trace) => sum + trace.latencyMs, 0);
    const maxLatencyMs = this.traces.reduce(
      (maximum, trace) => Math.max(maximum, trace.latencyMs),
      0,
    );
    const helpful = this.feedbackRecords.filter((record) => record.kind === "helpful").length;
    const unhelpful = this.feedbackRecords.filter((record) => record.kind === "unhelpful").length;
    const citationError = this.feedbackRecords.filter(
      (record) => record.kind === "citation_error",
    ).length;
    const rated = helpful + unhelpful + citationError;
    return {
      answers: {
        total: this.traces.length,
        succeeded,
        failed,
        timedOut,
        knowledge,
        general,
        averageLatencyMs: this.traces.length === 0
          ? 0
          : Math.round(totalLatency / this.traces.length),
        maxLatencyMs,
      },
      feedback: {
        total: this.feedbackRecords.length,
        helpful,
        unhelpful,
        citationError,
        ...(rated > 0 ? { helpfulRate: helpful / rated } : {}),
      },
    };
  }
}
