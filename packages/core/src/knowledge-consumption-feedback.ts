import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { SpaceId } from "@homeagent/shared";
import { durableFsyncSync, durableRenameSync } from "./durable-file.ts";
import { knowledgePageRevision } from "./local-agent-knowledge.ts";
import type { SpaceStore } from "./space.ts";

export const AGENT_KNOWLEDGE_FEEDBACK_KINDS = [
  "helpful",
  "not_found",
  "incorrect",
  "stale",
  "conflicting",
  "hard_to_reuse",
] as const;

export type AgentKnowledgeFeedbackKind = typeof AGENT_KNOWLEDGE_FEEDBACK_KINDS[number];
export function isAgentKnowledgeFeedbackKind(value: unknown): value is AgentKnowledgeFeedbackKind {
  return typeof value === "string"
    && (AGENT_KNOWLEDGE_FEEDBACK_KINDS as readonly string[]).includes(value);
}
export type AgentKnowledgeFeedbackStatus = "open" | "resolved";
export const AGENT_KNOWLEDGE_FEEDBACK_MANUAL_RESOLUTION_KINDS = [
  "knowledge_changed",
  "knowledge_confirmed",
  "coverage_recorded",
  "duplicate",
  "not_actionable",
] as const;
export type AgentKnowledgeFeedbackManualResolutionKind =
  typeof AGENT_KNOWLEDGE_FEEDBACK_MANUAL_RESOLUTION_KINDS[number];
export function isAgentKnowledgeFeedbackManualResolutionKind(
  value: unknown,
): value is AgentKnowledgeFeedbackManualResolutionKind {
  return typeof value === "string"
    && (AGENT_KNOWLEDGE_FEEDBACK_MANUAL_RESOLUTION_KINDS as readonly string[]).includes(value);
}
export type AgentKnowledgeFeedbackResolutionKind =
  | AgentKnowledgeFeedbackManualResolutionKind
  | "helpful_acknowledged";

export type AgentKnowledgeFeedbackTarget =
  | { kind: "page"; slug: string; revision: string }
  | { kind: "search"; query: string };

export interface SubmitAgentKnowledgeFeedbackInput {
  idempotencyKey: string;
  consumer: string;
  kind: AgentKnowledgeFeedbackKind;
  target: AgentKnowledgeFeedbackTarget;
  note?: string;
}

export interface ResolveAgentKnowledgeFeedbackInput {
  actor: string;
  kind: AgentKnowledgeFeedbackManualResolutionKind;
  note: string;
}

export interface AgentKnowledgeFeedbackResolution {
  actor: string;
  kind: AgentKnowledgeFeedbackResolutionKind;
  note: string;
  resolvedAt: number;
  currentRevision?: string;
}

export interface AgentKnowledgeFeedback {
  id: string;
  idempotencyKey: string;
  space: SpaceId;
  consumer: string;
  kind: AgentKnowledgeFeedbackKind;
  target: AgentKnowledgeFeedbackTarget;
  currentRevisionAtSubmission?: string;
  note?: string;
  status: AgentKnowledgeFeedbackStatus;
  resolution?: AgentKnowledgeFeedbackResolution;
  createdAt: number;
}

export interface AgentKnowledgeFeedbackQuery {
  status?: AgentKnowledgeFeedbackStatus;
  kind?: AgentKnowledgeFeedbackKind;
  limit?: number;
}

export interface AgentKnowledgeFeedbackSummary {
  total: number;
  open: number;
  resolved: number;
  byKind: Record<AgentKnowledgeFeedbackKind, number>;
}

export type AgentKnowledgeFeedbackErrorCode =
  | "invalid_input"
  | "not_found"
  | "conflict"
  | "capacity"
  | "corrupt_state";

export class AgentKnowledgeFeedbackError extends Error {
  constructor(
    readonly code: AgentKnowledgeFeedbackErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AgentKnowledgeFeedbackError";
  }
}

interface FeedbackFile {
  version: 1;
  feedback: AgentKnowledgeFeedback[];
}

export const MAX_AGENT_KNOWLEDGE_FEEDBACK_RECORDS = 5_000;
const MAX_FEEDBACK_FILE_BYTES = 32 * 1024 * 1024;
const MAX_IDEMPOTENCY_KEY_CHARACTERS = 200;
const MAX_CONSUMER_CHARACTERS = 200;
const MAX_NOTE_CHARACTERS = 4_000;
const MAX_SLUG_CHARACTERS = 300;
const MAX_QUERY_CHARACTERS = 500;
const MAX_LIST_LIMIT = 500;
const PAGE_REVISION_PATTERN = /^[a-f0-9]{64}$/;

function cloneTarget(target: AgentKnowledgeFeedbackTarget): AgentKnowledgeFeedbackTarget {
  return target.kind === "page" ? { ...target } : { ...target };
}

function cloneFeedback(record: AgentKnowledgeFeedback): AgentKnowledgeFeedback {
  return {
    ...record,
    target: cloneTarget(record.target),
    ...(record.resolution ? { resolution: { ...record.resolution } } : {}),
  };
}

function cleanString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new AgentKnowledgeFeedbackError("invalid_input", `${label} must be a string`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new AgentKnowledgeFeedbackError(
      "invalid_input",
      `${label} must contain between 1 and ${maximum} characters`,
    );
  }
  return normalized;
}

function cleanOptionalString(value: unknown, label: string, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  return cleanString(value, label, maximum);
}

function cleanSlug(value: unknown): string {
  const slug = cleanString(value, "slug", MAX_SLUG_CHARACTERS);
  const segments = slug.split("/");
  if (
    slug.startsWith("/")
    || slug.includes("\\")
    || segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new AgentKnowledgeFeedbackError("invalid_input", "slug is unsafe");
  }
  return slug;
}

function normalizeTarget(value: unknown): AgentKnowledgeFeedbackTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AgentKnowledgeFeedbackError("invalid_input", "target must be an object");
  }
  const target = value as Record<string, unknown>;
  if (target.kind === "page") {
    if (Object.keys(target).some((key) => !["kind", "slug", "revision"].includes(key))) {
      throw new AgentKnowledgeFeedbackError("invalid_input", "target has unexpected fields");
    }
    const revision = cleanString(target.revision, "revision", 64);
    if (!PAGE_REVISION_PATTERN.test(revision)) {
      throw new AgentKnowledgeFeedbackError("invalid_input", "revision is invalid");
    }
    return { kind: "page", slug: cleanSlug(target.slug), revision };
  }
  if (target.kind === "search") {
    if (Object.keys(target).some((key) => !["kind", "query"].includes(key))) {
      throw new AgentKnowledgeFeedbackError("invalid_input", "target has unexpected fields");
    }
    return { kind: "search", query: cleanString(target.query, "query", MAX_QUERY_CHARACTERS) };
  }
  throw new AgentKnowledgeFeedbackError("invalid_input", "target kind is invalid");
}

function normalizeSubmission(input: SubmitAgentKnowledgeFeedbackInput): SubmitAgentKnowledgeFeedbackInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new AgentKnowledgeFeedbackError("invalid_input", "feedback must be an object");
  }
  if (Object.keys(input).some((key) => (
    !["idempotencyKey", "consumer", "kind", "target", "note"].includes(key)
  ))) {
    throw new AgentKnowledgeFeedbackError("invalid_input", "feedback has unexpected fields");
  }
  if (!isAgentKnowledgeFeedbackKind(input.kind)) {
    throw new AgentKnowledgeFeedbackError("invalid_input", "feedback kind is invalid");
  }
  const note = cleanOptionalString(input.note, "note", MAX_NOTE_CHARACTERS);
  return {
    idempotencyKey: cleanString(
      input.idempotencyKey,
      "idempotencyKey",
      MAX_IDEMPOTENCY_KEY_CHARACTERS,
    ),
    consumer: cleanString(input.consumer, "consumer", MAX_CONSUMER_CHARACTERS),
    kind: input.kind,
    target: normalizeTarget(input.target),
    ...(note === undefined ? {} : { note }),
  };
}

function normalizeResolution(input: ResolveAgentKnowledgeFeedbackInput): ResolveAgentKnowledgeFeedbackInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new AgentKnowledgeFeedbackError("invalid_input", "resolution must be an object");
  }
  if (Object.keys(input).some((key) => !["actor", "kind", "note"].includes(key))) {
    throw new AgentKnowledgeFeedbackError("invalid_input", "resolution has unexpected fields");
  }
  if (!isAgentKnowledgeFeedbackManualResolutionKind(input.kind)) {
    throw new AgentKnowledgeFeedbackError("invalid_input", "resolution kind is invalid");
  }
  return {
    actor: cleanString(input.actor, "actor", MAX_CONSUMER_CHARACTERS),
    kind: input.kind,
    note: cleanString(input.note, "note", MAX_NOTE_CHARACTERS),
  };
}

function sameSubmission(
  record: AgentKnowledgeFeedback,
  input: SubmitAgentKnowledgeFeedbackInput,
): boolean {
  return record.consumer === input.consumer
    && record.kind === input.kind
    && record.note === input.note
    && JSON.stringify(record.target) === JSON.stringify(input.target);
}

function feedbackDirectory(store: SpaceStore): string {
  return join(store.root, "governance");
}

function feedbackPath(store: SpaceStore): string {
  return join(feedbackDirectory(store), "agent-consumption-feedback.json");
}

function ensureSafeDirectory(store: SpaceStore): string {
  const directory = feedbackDirectory(store);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stats = lstatSync(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new AgentKnowledgeFeedbackError("corrupt_state", "feedback directory is unsafe");
  }
  return directory;
}

function assertSafeFile(store: SpaceStore): void {
  const path = feedbackPath(store);
  if (!existsSync(path)) return;
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_FEEDBACK_FILE_BYTES) {
    throw new AgentKnowledgeFeedbackError("corrupt_state", "feedback file is unsafe");
  }
}

function parseRecord(value: unknown, space: SpaceId, index: number): AgentKnowledgeFeedback {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AgentKnowledgeFeedbackError("corrupt_state", `feedback record ${index + 1} is invalid`);
  }
  const item = value as Record<string, unknown>;
  if (item.space !== space) {
    throw new AgentKnowledgeFeedbackError(
      "corrupt_state",
      `feedback record ${index + 1} has the wrong space`,
    );
  }
  try {
    const input = normalizeSubmission({
      idempotencyKey: item.idempotencyKey,
      consumer: item.consumer,
      kind: item.kind,
      target: item.target,
      ...(item.note === undefined ? {} : { note: item.note }),
    } as SubmitAgentKnowledgeFeedbackInput);
    const resolution = item.resolution === undefined
      ? undefined
      : parseResolution(item.resolution, index);
    if (
      typeof item.id !== "string"
      || item.id.length === 0
      || item.id.length > 200
      || (item.status !== "open" && item.status !== "resolved")
      || (item.status === "open" && resolution !== undefined)
      || (item.status === "resolved" && resolution === undefined)
      || typeof item.createdAt !== "number"
      || !Number.isFinite(item.createdAt)
      || (item.currentRevisionAtSubmission !== undefined
        && (typeof item.currentRevisionAtSubmission !== "string"
          || !PAGE_REVISION_PATTERN.test(item.currentRevisionAtSubmission)))
    ) {
      throw new Error("invalid persisted fields");
    }
    if (
      (input.target.kind === "page" && item.currentRevisionAtSubmission === undefined)
      || (input.target.kind === "search" && item.currentRevisionAtSubmission !== undefined)
      || (resolution !== undefined && resolution.resolvedAt < item.createdAt)
      || (input.kind === "helpful"
        && (item.status !== "resolved" || resolution?.kind !== "helpful_acknowledged"))
      || (input.kind !== "helpful" && resolution?.kind === "helpful_acknowledged")
      || (resolution?.kind === "knowledge_changed"
        && (input.target.kind !== "page" || resolution.currentRevision === undefined))
      || (resolution?.kind === "knowledge_confirmed"
        && (input.target.kind !== "page" || resolution.currentRevision === undefined))
      || (resolution?.kind === "coverage_recorded"
        && (input.target.kind !== "search" || resolution.currentRevision !== undefined))
      || ((resolution?.kind === "duplicate" || resolution?.kind === "not_actionable")
        && resolution.currentRevision !== undefined)
    ) {
      throw new AgentKnowledgeFeedbackError(
        "corrupt_state",
        `feedback record ${index + 1} has an invalid resolution`,
      );
    }
    if (
      resolution?.kind === "knowledge_changed"
      && input.target.kind === "page"
      && resolution.currentRevision === input.target.revision
    ) {
      throw new AgentKnowledgeFeedbackError(
        "corrupt_state",
        `feedback record ${index + 1} revision has not changed`,
      );
    }
    return {
      id: item.id,
      space,
      ...input,
      ...(item.currentRevisionAtSubmission === undefined
        ? {}
        : { currentRevisionAtSubmission: item.currentRevisionAtSubmission }),
      status: item.status,
      ...(resolution ? { resolution } : {}),
      createdAt: item.createdAt,
    };
  } catch (error) {
    if (error instanceof AgentKnowledgeFeedbackError && error.code === "corrupt_state") throw error;
    throw new AgentKnowledgeFeedbackError(
      "corrupt_state",
      `feedback record ${index + 1} is invalid`,
    );
  }
}

export function parseAgentKnowledgeFeedbackArchiveRecord(
  value: unknown,
  index: number,
  space: SpaceId,
): AgentKnowledgeFeedback {
  return parseRecord(value, space, index);
}

function parseResolution(value: unknown, index: number): AgentKnowledgeFeedbackResolution {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AgentKnowledgeFeedbackError(
      "corrupt_state",
      `feedback resolution ${index + 1} is invalid`,
    );
  }
  const item = value as Record<string, unknown>;
  try {
    const actor = cleanString(item.actor, "actor", MAX_CONSUMER_CHARACTERS);
    const note = cleanString(item.note, "note", MAX_NOTE_CHARACTERS);
    const kind = item.kind === "helpful_acknowledged"
      ? item.kind
      : normalizeResolution({ actor, kind: item.kind, note } as ResolveAgentKnowledgeFeedbackInput)
        .kind;
    if (
      typeof item.resolvedAt !== "number"
      || !Number.isFinite(item.resolvedAt)
      || (item.currentRevision !== undefined
        && (typeof item.currentRevision !== "string"
          || !PAGE_REVISION_PATTERN.test(item.currentRevision)))
    ) {
      throw new Error("invalid persisted resolution");
    }
    return {
      actor,
      kind,
      note,
      resolvedAt: item.resolvedAt,
      ...(item.currentRevision === undefined ? {} : { currentRevision: item.currentRevision }),
    };
  } catch {
    throw new AgentKnowledgeFeedbackError(
      "corrupt_state",
      `feedback resolution ${index + 1} is invalid`,
    );
  }
}

/** Durable, Space-scoped governance module for local Agent knowledge feedback. */
export class KnowledgeConsumptionFeedbackStore {
  constructor(private readonly store: SpaceStore) {}

  private load(): AgentKnowledgeFeedback[] {
    const path = feedbackPath(this.store);
    if (!existsSync(path)) return [];
    assertSafeFile(this.store);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw new AgentKnowledgeFeedbackError("corrupt_state", "feedback file is invalid JSON");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new AgentKnowledgeFeedbackError("corrupt_state", "feedback file is invalid");
    }
    const file = parsed as Partial<FeedbackFile>;
    if (file.version !== 1 || !Array.isArray(file.feedback)) {
      throw new AgentKnowledgeFeedbackError("corrupt_state", "feedback file version is invalid");
    }
    if (file.feedback.length > MAX_AGENT_KNOWLEDGE_FEEDBACK_RECORDS) {
      throw new AgentKnowledgeFeedbackError("corrupt_state", "feedback file exceeds its record limit");
    }
    const records = file.feedback.map((record, index) => parseRecord(record, this.store.space, index));
    const ids = new Set<string>();
    const idempotencyKeys = new Set<string>();
    for (const record of records) {
      if (ids.has(record.id) || idempotencyKeys.has(record.idempotencyKey)) {
        throw new AgentKnowledgeFeedbackError("corrupt_state", "feedback identifiers are duplicated");
      }
      ids.add(record.id);
      idempotencyKeys.add(record.idempotencyKey);
    }
    return records;
  }

  private persist(records: AgentKnowledgeFeedback[]): void {
    const directory = ensureSafeDirectory(this.store);
    assertSafeFile(this.store);
    const path = feedbackPath(this.store);
    const temporaryPath = join(
      directory,
      `.agent-consumption-feedback.${process.pid}.${randomUUID()}.tmp`,
    );
    try {
      writeFileSync(
        temporaryPath,
        JSON.stringify({ version: 1, feedback: records } satisfies FeedbackFile, null, 2),
        { encoding: "utf8", mode: 0o600 },
      );
      const fileDescriptor = openSync(temporaryPath, "r+");
      try {
        durableFsyncSync(fileDescriptor);
      } finally {
        closeSync(fileDescriptor);
      }
      durableRenameSync(temporaryPath, path);
      const directoryDescriptor = openSync(directory, "r");
      try {
        durableFsyncSync(directoryDescriptor, { allowUnsupportedDirectoryOnWindows: true });
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

  exportArchive(): AgentKnowledgeFeedback[] {
    return this.load().map(cloneFeedback);
  }

  summary(): AgentKnowledgeFeedbackSummary {
    const records = this.load();
    const byKind: Record<AgentKnowledgeFeedbackKind, number> = {
      helpful: 0,
      not_found: 0,
      incorrect: 0,
      stale: 0,
      conflicting: 0,
      hard_to_reuse: 0,
    };
    let open = 0;
    for (const record of records) {
      byKind[record.kind] += 1;
      if (record.status === "open") open += 1;
    }
    return {
      total: records.length,
      open,
      resolved: records.length - open,
      byKind,
    };
  }

  restoreArchive(records: AgentKnowledgeFeedback[]): void {
    if (records.length === 0) return;
    if (records.length > MAX_AGENT_KNOWLEDGE_FEEDBACK_RECORDS) {
      throw new AgentKnowledgeFeedbackError("capacity", "feedback record limit reached");
    }
    if (this.load().length > 0) {
      throw new AgentKnowledgeFeedbackError("conflict", "feedback records already exist");
    }
    const normalized = records.map((record, index) =>
      parseAgentKnowledgeFeedbackArchiveRecord(record, index, this.store.space)
    );
    const ids = new Set<string>();
    const idempotencyKeys = new Set<string>();
    for (const record of normalized) {
      if (ids.has(record.id) || idempotencyKeys.has(record.idempotencyKey)) {
        throw new AgentKnowledgeFeedbackError(
          "corrupt_state",
          "feedback identifiers are duplicated",
        );
      }
      ids.add(record.id);
      idempotencyKeys.add(record.idempotencyKey);
    }
    this.persist(normalized);
  }

  submit(input: SubmitAgentKnowledgeFeedbackInput): AgentKnowledgeFeedback {
    const normalized = normalizeSubmission(input);
    const records = this.load();
    const replay = records.find((record) => record.idempotencyKey === normalized.idempotencyKey);
    if (replay) {
      if (!sameSubmission(replay, normalized)) {
        throw new AgentKnowledgeFeedbackError(
          "conflict",
          "idempotencyKey was already used for different feedback",
        );
      }
      return cloneFeedback(replay);
    }
    if (records.length >= MAX_AGENT_KNOWLEDGE_FEEDBACK_RECORDS) {
      throw new AgentKnowledgeFeedbackError("capacity", "feedback record limit reached");
    }
    const page = normalized.target.kind === "page"
      ? this.store.index().getPage(normalized.target.slug)
      : undefined;
    if (normalized.target.kind === "page" && !page) {
      throw new AgentKnowledgeFeedbackError("not_found", "feedback page was not found");
    }
    const createdAt = Date.now();
    const record: AgentKnowledgeFeedback = {
      id: `agent_feedback_${randomUUID()}`,
      idempotencyKey: normalized.idempotencyKey,
      space: this.store.space,
      consumer: normalized.consumer,
      kind: normalized.kind,
      target: cloneTarget(normalized.target),
      ...(page ? { currentRevisionAtSubmission: knowledgePageRevision(page) } : {}),
      ...(normalized.note === undefined ? {} : { note: normalized.note }),
      status: normalized.kind === "helpful" ? "resolved" : "open",
      ...(normalized.kind === "helpful"
        ? {
            resolution: {
              actor: normalized.consumer,
              kind: "helpful_acknowledged" as const,
              note: "Agent 标记该知识有帮助。",
              resolvedAt: createdAt,
              ...(page ? { currentRevision: knowledgePageRevision(page) } : {}),
            },
          }
        : {}),
      createdAt,
    };
    this.persist([...records, record]);
    return cloneFeedback(record);
  }

  resolve(id: string, input: ResolveAgentKnowledgeFeedbackInput): AgentKnowledgeFeedback {
    const feedbackId = cleanString(id, "feedback id", 200);
    const normalized = normalizeResolution(input);
    const records = this.load();
    const index = records.findIndex((record) => record.id === feedbackId);
    const existing = records[index];
    if (!existing) {
      throw new AgentKnowledgeFeedbackError("not_found", "feedback record was not found");
    }
    if (existing.resolution) {
      if (
        existing.resolution.actor === normalized.actor
        && existing.resolution.kind === normalized.kind
        && existing.resolution.note === normalized.note
      ) {
        return cloneFeedback(existing);
      }
      throw new AgentKnowledgeFeedbackError("conflict", "feedback is already resolved");
    }

    if (normalized.kind === "coverage_recorded" && existing.target.kind !== "search") {
      throw new AgentKnowledgeFeedbackError(
        "invalid_input",
        "coverage_recorded can only resolve search feedback",
      );
    }
    if (normalized.kind === "knowledge_confirmed" && existing.target.kind !== "page") {
      throw new AgentKnowledgeFeedbackError(
        "invalid_input",
        "knowledge_confirmed can only resolve page feedback",
      );
    }

    let currentRevision: string | undefined;
    if (normalized.kind === "knowledge_changed" || normalized.kind === "knowledge_confirmed") {
      if (existing.target.kind !== "page") {
        throw new AgentKnowledgeFeedbackError(
          "invalid_input",
          `${normalized.kind} can only resolve page feedback`,
        );
      }
      const page = this.store.index().getPage(existing.target.slug);
      if (!page) {
        throw new AgentKnowledgeFeedbackError("not_found", "feedback page was not found");
      }
      currentRevision = knowledgePageRevision(page);
      if (
        normalized.kind === "knowledge_changed"
        && currentRevision === existing.target.revision
      ) {
        throw new AgentKnowledgeFeedbackError(
          "conflict",
          "knowledge page revision has not changed",
        );
      }
    }

    const resolved: AgentKnowledgeFeedback = {
      ...existing,
      target: cloneTarget(existing.target),
      status: "resolved",
      resolution: {
        ...normalized,
        resolvedAt: Date.now(),
        ...(currentRevision ? { currentRevision } : {}),
      },
    };
    const candidate = records.slice();
    candidate[index] = resolved;
    this.persist(candidate);
    return cloneFeedback(resolved);
  }

  list(query: AgentKnowledgeFeedbackQuery = {}): AgentKnowledgeFeedback[] {
    if (query.status !== undefined && query.status !== "open" && query.status !== "resolved") {
      throw new AgentKnowledgeFeedbackError("invalid_input", "feedback status is invalid");
    }
    if (query.kind !== undefined && !AGENT_KNOWLEDGE_FEEDBACK_KINDS.includes(query.kind)) {
      throw new AgentKnowledgeFeedbackError("invalid_input", "feedback kind is invalid");
    }
    const limit = query.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
      throw new AgentKnowledgeFeedbackError(
        "invalid_input",
        `limit must be an integer between 1 and ${MAX_LIST_LIMIT}`,
      );
    }
    return this.load()
      .filter((record) => query.status === undefined || record.status === query.status)
      .filter((record) => query.kind === undefined || record.kind === query.kind)
      .sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id))
      .slice(0, limit)
      .map(cloneFeedback);
  }
}
