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
import { isSpaceId, type Citation, type SpaceId } from "@homeagent/shared";
import { durableFsyncSync, durableRenameSync } from "./durable-file.ts";

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

export interface AnswerTrace {
  id: string;
  spaces: SpaceId[];
  question: string;
  outcome: AnswerOutcome;
  source?: "knowledge" | "general";
  answer?: string;
  citations: Citation[];
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
  traces: AnswerTrace[];
  feedback: AnswerFeedback[];
  evaluationCases: QualityEvaluationCase[];
}

const MAX_TRACES = 1000;
const MAX_FEEDBACK = 2000;
const MAX_EVALUATION_CASES = 1000;
const MAX_QUESTION_LENGTH = 4000;
const MAX_ANSWER_LENGTH = 12_000;
const MAX_ERROR_LENGTH = 1000;
const MAX_NOTE_LENGTH = 1000;
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
    && typeof citation.title === "string" && citation.title.length > 0;
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

function cloneTrace(trace: AnswerTrace): AnswerTrace {
  return {
    ...trace,
    spaces: [...trace.spaces],
    citations: trace.citations.map((citation) => ({ ...citation })),
  };
}

function cloneEvaluationCase(item: QualityEvaluationCase): QualityEvaluationCase {
  return {
    ...item,
    spaces: [...item.spaces],
    observedCitations: item.observedCitations.map((citation) => ({ ...citation })),
  };
}

export class QualityStore {
  private readonly configPath: string;
  private traces: AnswerTrace[];
  private feedbackRecords: AnswerFeedback[];
  private evaluationCaseRecords: QualityEvaluationCase[];

  constructor(dataDir: string) {
    this.configPath = join(dataDir, "quality", "quality.json");
    const loaded = this.load();
    this.traces = loaded.traces;
    this.feedbackRecords = loaded.feedback;
    this.evaluationCaseRecords = loaded.evaluationCases;
  }

  private load(): QualityFile {
    if (!existsSync(this.configPath)) return { traces: [], feedback: [], evaluationCases: [] };
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
      return { traces, feedback, evaluationCases };
    } catch {
      return { traces: [], feedback: [], evaluationCases: [] };
    }
  }

  private persist(
    traces = this.traces,
    feedback = this.feedbackRecords,
    evaluationCases = this.evaluationCaseRecords,
  ): void {
    const directory = dirname(this.configPath);
    mkdirSync(directory, { recursive: true });
    const temporaryPath = `${this.configPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(
        temporaryPath,
        JSON.stringify({ traces, feedback, evaluationCases } satisfies QualityFile, null, 2),
        { encoding: "utf8", mode: 0o600 },
      );
      const fileDescriptor = openSync(temporaryPath, "r");
      try {
        durableFsyncSync(fileDescriptor);
      } finally {
        closeSync(fileDescriptor);
      }
      durableRenameSync(temporaryPath, this.configPath);
      const directoryDescriptor = openSync(directory, "r");
      try {
        durableFsyncSync(directoryDescriptor);
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
    const trace: AnswerTrace = {
      id: `answer_${randomUUID()}`,
      spaces: [...new Set(input.spaces.filter(isSpaceId))],
      question: input.question.slice(0, MAX_QUESTION_LENGTH),
      outcome: input.outcome,
      source: input.source,
      answer: bounded(input.answer, MAX_ANSWER_LENGTH),
      citations: input.citations.map((citation) => ({ ...citation })),
      latencyMs: Math.max(0, Math.round(input.latencyMs)),
      error: bounded(input.error, MAX_ERROR_LENGTH),
      createdAt: input.createdAt ?? Date.now(),
    };
    const traces = [...this.traces, trace].slice(-MAX_TRACES);
    const traceIds = new Set(traces.map((record) => record.id));
    const feedback = this.feedbackRecords
      .filter((record) => traceIds.has(record.traceId))
      .slice(-MAX_FEEDBACK);
    this.persist(traces, feedback);
    this.traces = traces;
    this.feedbackRecords = feedback;
    return cloneTrace(trace);
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
