/**
 * Human-readable authoritative storage for Raw records.
 *
 * Records are partitioned by their UTC creation day and stored as current-state
 * JSONL snapshots under raw/records/YYYY/MM/DD.jsonl. SQLite remains the fast
 * query projection; this module is the durable source used to repair or rebuild
 * that projection after a crash or index deletion.
 *
 * A day's file is atomically replaced whenever one of its records changes. The
 * per-space Serializer ensures writers do not overlap in normal operation.
 */
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type {
  Attachment,
  RawAdmission,
  RawRecord,
  RawSource,
  SpaceId,
} from "@homeagent/shared";
import type { MessageRetractionRecord } from "./governance.ts";
import { durableFsyncSync, durableRenameSync } from "./durable-file.ts";

const RAW_JOURNAL_FORMAT = "homeagent.raw-journal";
const RAW_JOURNAL_VERSION = 1;
const RAW_SOURCES: RawSource[] = ["message", "doc", "manual", "task", "learning"];
const RAW_ADMISSIONS: RawAdmission[] = ["ready", "held", "excluded"];

interface RawJournalManifest {
  format: typeof RAW_JOURNAL_FORMAT;
  version: typeof RAW_JOURNAL_VERSION;
  partition: "createdAt-utc-day";
  recordFormat: "jsonl-current-state";
}

interface ReadableRawRecord extends RawRecord {
  /** Redundant, human-readable rendering of createdAt. */
  createdAtIso: string;
}

function atomicWrite(path: string, content: string): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 });
    const descriptor = openSync(temporary, "r+");
    try {
      durableFsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    durableRenameSync(temporary, path);
    try {
      const directoryDescriptor = openSync(directory, "r");
      try {
        durableFsyncSync(directoryDescriptor, { allowUnsupportedDirectoryOnWindows: true });
      } finally {
        closeSync(directoryDescriptor);
      }
    } catch {
      // The atomic rename is the logical commit point. Some Windows/Bun
      // combinations cannot open or flush directories; the visible file is
      // still authoritative and a later rewrite remains atomic.
    }
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}

function parseAttachments(value: unknown, label: string): Attachment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((item, index) => {
    if (!isRecord(item)) throw new Error(`${label}[${index}] must be an object`);
    const kind = requiredString(item.kind, `${label}[${index}].kind`) as Attachment["kind"];
    if (!["image", "pdf", "audio", "file"].includes(kind)) {
      throw new Error(`${label}[${index}].kind is invalid`);
    }
    return {
      kind,
      ref: requiredString(item.ref, `${label}[${index}].ref`),
      ...(optionalString(item.name, `${label}[${index}].name`) === undefined
        ? {}
        : { name: optionalString(item.name, `${label}[${index}].name`) }),
    };
  });
}

function cloneRaw(record: RawRecord): RawRecord {
  return {
    ...record,
    attachments: record.attachments?.map((attachment) => ({ ...attachment })) ?? [],
  };
}

function utcDay(createdAt: number): string {
  const iso = new Date(createdAt).toISOString();
  return iso.slice(0, 10);
}

function readableRaw(record: RawRecord): ReadableRawRecord {
  return {
    id: record.id,
    space: record.space,
    source: record.source,
    createdAt: record.createdAt,
    createdAtIso: new Date(record.createdAt).toISOString(),
    admission: record.admission,
    ingested: record.ingested,
    ...(record.workItemId === undefined ? {} : { workItemId: record.workItemId }),
    ...(record.workActionId === undefined ? {} : { workActionId: record.workActionId }),
    ...(record.agentId === undefined ? {} : { agentId: record.agentId }),
    ...(record.agentHandled === undefined ? {} : { agentHandled: record.agentHandled }),
    ...(record.agentResponse === undefined ? {} : { agentResponse: record.agentResponse }),
    ...(record.agentRespondedAt === undefined
      ? {}
      : { agentRespondedAt: record.agentRespondedAt }),
    ...(record.author === undefined ? {} : { author: record.author }),
    ...(record.chatId === undefined ? {} : { chatId: record.chatId }),
    ...(record.messageId === undefined ? {} : { messageId: record.messageId }),
    content: record.content,
    attachments: record.attachments?.map((attachment) => ({ ...attachment })) ?? [],
  };
}

function parseRaw(value: unknown, expectedSpace: SpaceId, label: string): RawRecord {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const space = requiredString(value.space, `${label}.space`) as SpaceId;
  if (space !== expectedSpace) throw new Error(`${label}.space does not match journal space`);
  const source = requiredString(value.source, `${label}.source`) as RawSource;
  if (!RAW_SOURCES.includes(source)) throw new Error(`${label}.source is invalid`);
  const admission = requiredString(value.admission, `${label}.admission`) as RawAdmission;
  if (!RAW_ADMISSIONS.includes(admission)) throw new Error(`${label}.admission is invalid`);
  if (typeof value.ingested !== "boolean") throw new Error(`${label}.ingested must be a boolean`);
  const createdAt = finiteNumber(value.createdAt, `${label}.createdAt`);
  return {
    id: requiredString(value.id, `${label}.id`),
    space,
    source,
    admission,
    ingested: value.ingested,
    createdAt,
    ...(optionalString(value.workItemId, `${label}.workItemId`) === undefined
      ? {}
      : { workItemId: optionalString(value.workItemId, `${label}.workItemId`) }),
    ...(optionalString(value.workActionId, `${label}.workActionId`) === undefined
      ? {}
      : { workActionId: optionalString(value.workActionId, `${label}.workActionId`) }),
    ...(optionalString(value.agentId, `${label}.agentId`) === undefined
      ? {}
      : { agentId: optionalString(value.agentId, `${label}.agentId`) }),
    ...(optionalBoolean(value.agentHandled, `${label}.agentHandled`) === undefined
      ? {}
      : { agentHandled: optionalBoolean(value.agentHandled, `${label}.agentHandled`) }),
    ...(optionalString(value.agentResponse, `${label}.agentResponse`) === undefined
      ? {}
      : { agentResponse: optionalString(value.agentResponse, `${label}.agentResponse`) }),
    ...(value.agentRespondedAt === undefined || value.agentRespondedAt === null
      ? {}
      : { agentRespondedAt: finiteNumber(value.agentRespondedAt, `${label}.agentRespondedAt`) }),
    author: optionalString(value.author, `${label}.author`),
    chatId: optionalString(value.chatId, `${label}.chatId`),
    messageId: optionalString(value.messageId, `${label}.messageId`),
    content: typeof value.content === "string"
      ? value.content
      : (() => { throw new Error(`${label}.content must be a string`); })(),
    attachments: parseAttachments(value.attachments, `${label}.attachments`),
  };
}

function parseRetraction(value: unknown, label: string): MessageRetractionRecord {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return {
    chatId: requiredString(value.chatId, `${label}.chatId`),
    messageId: requiredString(value.messageId, `${label}.messageId`),
    originalAuthor: requiredString(value.originalAuthor, `${label}.originalAuthor`),
    retractedBy: requiredString(value.retractedBy, `${label}.retractedBy`),
    createdAt: finiteNumber(value.createdAt, `${label}.createdAt`),
  };
}

function retractionKey(record: Pick<MessageRetractionRecord, "chatId" | "messageId">): string {
  return `${record.chatId}\0${record.messageId}`;
}

/**
 * Deep Raw persistence module. Its small interface hides file partitioning,
 * validation, atomic replacement, legacy initialization, and current-state
 * materialization from callers.
 */
export class RawJournal {
  readonly root: string;
  readonly recordsDir: string;
  readonly manifestPath: string;
  readonly retractionsPath: string;
  readonly space: SpaceId;
  private records = new Map<string, RawRecord>();
  private retractions = new Map<string, MessageRetractionRecord>();
  private ready = false;

  constructor(root: string, space: SpaceId) {
    this.root = root;
    this.space = space;
    this.recordsDir = join(root, "records");
    this.manifestPath = join(root, "manifest.json");
    this.retractionsPath = join(root, "retractions.jsonl");
    if (existsSync(this.manifestPath)) this.load();
  }

  isInitialized(): boolean {
    return this.ready;
  }

  initialize(
    records: readonly RawRecord[],
    retractions: readonly MessageRetractionRecord[],
  ): void {
    if (this.ready) throw new Error("Raw journal is already initialized");
    rmSync(this.recordsDir, { recursive: true, force: true });
    rmSync(this.retractionsPath, { force: true });
    const nextRecords = new Map<string, RawRecord>();
    for (const record of records) {
      this.assertRecord(record);
      if (nextRecords.has(record.id)) throw new Error(`duplicate Raw id: ${record.id}`);
      nextRecords.set(record.id, cloneRaw(record));
    }
    const nextRetractions = new Map<string, MessageRetractionRecord>();
    for (const record of retractions) {
      const key = retractionKey(record);
      if (nextRetractions.has(key)) throw new Error(`duplicate message retraction: ${key}`);
      nextRetractions.set(key, { ...record });
    }
    for (const day of new Set([...nextRecords.values()].map((record) => utcDay(record.createdAt)))) {
      this.persistDay(day, nextRecords);
    }
    this.persistRetractions(nextRetractions);
    const manifest: RawJournalManifest = {
      format: RAW_JOURNAL_FORMAT,
      version: RAW_JOURNAL_VERSION,
      partition: "createdAt-utc-day",
      recordFormat: "jsonl-current-state",
    };
    atomicWrite(this.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    this.records = nextRecords;
    this.retractions = nextRetractions;
    this.ready = true;
  }

  listRaw(): RawRecord[] {
    return [...this.records.values()]
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .map(cloneRaw);
  }

  listRetractions(): MessageRetractionRecord[] {
    return [...this.retractions.values()]
      .sort((a, b) => a.createdAt - b.createdAt
        || a.chatId.localeCompare(b.chatId)
        || a.messageId.localeCompare(b.messageId))
      .map((record) => ({ ...record }));
  }

  insert(record: RawRecord): void {
    this.assertReady();
    this.assertRecord(record);
    if (this.records.has(record.id)) throw new Error(`Raw id already exists: ${record.id}`);
    const next = new Map(this.records);
    next.set(record.id, cloneRaw(record));
    this.persistDay(utcDay(record.createdAt), next);
    this.records = next;
  }

  replaceMany(records: readonly RawRecord[]): void {
    this.assertReady();
    if (records.length === 0) return;
    const next = new Map(this.records);
    const days = new Set<string>();
    for (const record of records) {
      this.assertRecord(record);
      const current = next.get(record.id);
      if (!current) throw new Error(`unknown Raw id: ${record.id}`);
      if (current.createdAt !== record.createdAt) {
        throw new Error(`Raw createdAt is immutable: ${record.id}`);
      }
      next.set(record.id, cloneRaw(record));
      days.add(utcDay(record.createdAt));
    }
    for (const day of days) this.persistDay(day, next);
    this.records = next;
  }

  deleteMany(ids: readonly string[]): number {
    this.assertReady();
    if (ids.length === 0) return 0;
    const next = new Map(this.records);
    const days = new Set<string>();
    let deleted = 0;
    for (const id of new Set(ids)) {
      const current = next.get(id);
      if (!current) continue;
      next.delete(id);
      days.add(utcDay(current.createdAt));
      deleted += 1;
    }
    for (const day of days) this.persistDay(day, next);
    this.records = next;
    return deleted;
  }

  insertRetraction(record: MessageRetractionRecord): void {
    this.assertReady();
    const key = retractionKey(record);
    const current = this.retractions.get(key);
    if (current) {
      if (JSON.stringify(current) !== JSON.stringify(record)) {
        throw new Error(`message retraction conflicts with existing record: ${key}`);
      }
      return;
    }
    const next = new Map(this.retractions);
    next.set(key, { ...record });
    this.persistRetractions(next);
    this.retractions = next;
  }

  private assertReady(): void {
    if (!this.ready) throw new Error("Raw journal is not initialized");
  }

  private assertRecord(record: RawRecord): void {
    if (record.space !== this.space) {
      throw new Error(`Raw record belongs to another space: ${record.id}`);
    }
    if (!Number.isFinite(record.createdAt)) throw new Error(`Raw createdAt is invalid: ${record.id}`);
    // Also verifies the timestamp is representable before it is used as a path.
    new Date(record.createdAt).toISOString();
  }

  private persistDay(day: string, records: ReadonlyMap<string, RawRecord>): void {
    const [year, month, date] = day.split("-");
    const path = join(this.recordsDir, year!, month!, `${date}.jsonl`);
    const content = [...records.values()]
      .filter((record) => utcDay(record.createdAt) === day)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .map((record) => JSON.stringify(readableRaw(record)))
      .join("\n");
    atomicWrite(path, content.length > 0 ? `${content}\n` : "");
  }

  private persistRetractions(
    retractions: ReadonlyMap<string, MessageRetractionRecord>,
  ): void {
    const content = [...retractions.values()]
      .sort((a, b) => a.createdAt - b.createdAt
        || a.chatId.localeCompare(b.chatId)
        || a.messageId.localeCompare(b.messageId))
      .map((record) => JSON.stringify(record))
      .join("\n");
    atomicWrite(this.retractionsPath, content.length > 0 ? `${content}\n` : "");
  }

  private load(): void {
    const manifestValue = JSON.parse(readFileSync(this.manifestPath, "utf8")) as unknown;
    if (!isRecord(manifestValue)
      || manifestValue.format !== RAW_JOURNAL_FORMAT
      || manifestValue.version !== RAW_JOURNAL_VERSION
      || manifestValue.partition !== "createdAt-utc-day"
      || manifestValue.recordFormat !== "jsonl-current-state") {
      throw new Error(`unsupported Raw journal manifest: ${this.manifestPath}`);
    }
    const nextRecords = new Map<string, RawRecord>();
    for (const path of this.recordFiles()) {
      const relativePath = relative(this.recordsDir, path).split(sep).join("/");
      const match = /^(\d{4})\/(\d{2})\/(\d{2})\.jsonl$/u.exec(relativePath);
      if (!match) throw new Error(`invalid Raw journal partition path: ${relativePath}`);
      const expectedDay = `${match[1]}-${match[2]}-${match[3]}`;
      const lines = readFileSync(path, "utf8").split(/\r?\n/u);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]!.trim();
        if (!line) continue;
        let value: unknown;
        try {
          value = JSON.parse(line) as unknown;
        } catch (error) {
          throw new Error(`invalid Raw journal JSON at ${path}:${index + 1}: ${String(error)}`);
        }
        const record = parseRaw(value, this.space, `${path}:${index + 1}`);
        if (utcDay(record.createdAt) !== expectedDay) {
          throw new Error(`Raw record is stored in the wrong day partition: ${record.id}`);
        }
        if (nextRecords.has(record.id)) throw new Error(`duplicate Raw id: ${record.id}`);
        nextRecords.set(record.id, record);
      }
    }
    const nextRetractions = new Map<string, MessageRetractionRecord>();
    if (existsSync(this.retractionsPath)) {
      const lines = readFileSync(this.retractionsPath, "utf8").split(/\r?\n/u);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]!.trim();
        if (!line) continue;
        let value: unknown;
        try {
          value = JSON.parse(line) as unknown;
        } catch (error) {
          throw new Error(`invalid Raw retraction JSON at ${this.retractionsPath}:${index + 1}: ${String(error)}`);
        }
        const record = parseRetraction(value, `${this.retractionsPath}:${index + 1}`);
        const key = retractionKey(record);
        if (nextRetractions.has(key)) throw new Error(`duplicate message retraction: ${key}`);
        nextRetractions.set(key, record);
      }
    }
    this.records = nextRecords;
    this.retractions = nextRetractions;
    this.ready = true;
  }

  private recordFiles(): string[] {
    const files: string[] = [];
    const walk = (directory: string): void => {
      if (!existsSync(directory)) return;
      for (const name of readdirSync(directory)) {
        const path = join(directory, name);
        const stats = statSync(path);
        if (stats.isDirectory()) walk(path);
        else if (name.endsWith(".jsonl")) files.push(path);
      }
    };
    walk(this.recordsDir);
    return files.sort();
  }
}
