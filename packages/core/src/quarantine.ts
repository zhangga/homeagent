/** Durable per-space records for distillation outputs that could not be generated. */
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { SpaceStore } from "./space.ts";
import type { QuarantinedDreamOperation, QuarantineRecord } from "./types.ts";

export interface NewQuarantineRecord {
  slug: string;
  error: string;
  rawIds: string[];
  createdAt: number;
  operation?: QuarantinedDreamOperation;
}

const MAX_QUARANTINE_ERROR_CHARACTERS = 4_000;
const MAX_QUARANTINE_RAW_IDS = 40;
const MAX_QUARANTINE_IDENTIFIER_CHARACTERS = 240;

function rawIds(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value
        .filter((item): item is string =>
          typeof item === "string"
          && item.length > 0
          && item.length <= MAX_QUARANTINE_IDENTIFIER_CHARACTERS)
        .slice(0, MAX_QUARANTINE_RAW_IDS))]
    : [];
}

function operation(value: unknown): QuarantinedDreamOperation | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (
    !["entity", "concept", "source", "analysis"].includes(String(item.type))
    || typeof item.name !== "string"
    || !item.name.trim()
    || item.name.length > MAX_QUARANTINE_IDENTIFIER_CHARACTERS
    || typeof item.title !== "string"
    || !item.title.trim()
    || item.title.length > MAX_QUARANTINE_IDENTIFIER_CHARACTERS
    || (item.basePageHash !== null
      && (typeof item.basePageHash !== "string" || !/^[a-f0-9]{64}$/u.test(item.basePageHash)))
  ) return undefined;
  const plannedRawIds = rawIds(item.rawIds);
  if (plannedRawIds.length === 0) return undefined;
  return {
    type: item.type as QuarantinedDreamOperation["type"],
    name: item.name.trim(),
    title: item.title.trim(),
    rawIds: plannedRawIds,
    basePageHash: item.basePageHash as string | null,
  };
}

function directory(store: SpaceStore): string {
  return join(store.root, "quarantine");
}

function isSafeDirectory(store: SpaceStore): boolean {
  try {
    const stats = lstatSync(directory(store));
    return stats.isDirectory() && !stats.isSymbolicLink();
  } catch {
    return false;
  }
}

function isRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

function pathFor(store: SpaceStore, id: string): string | undefined {
  const safe = id.length > 0
    && id.length <= 240
    && id !== "."
    && id !== ".."
    && !/[\\/\0]/u.test(id);
  return safe ? join(directory(store), `${id}.json`) : undefined;
}

function invalidRecord(
  store: SpaceStore,
  id: string,
  createdAt: number,
  reason: string,
): QuarantineRecord {
  return {
    id,
    space: store.space,
    slug: "（损坏的隔离记录）",
    error: `隔离记录无法读取：${reason}`,
    rawIds: [],
    createdAt,
  };
}

function parseRecord(store: SpaceStore, id: string, path: string): QuarantineRecord {
  const fallbackCreatedAt = lstatSync(path).mtimeMs;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return invalidRecord(store, id, fallbackCreatedAt, "内容不是对象");
    }
    const slug = typeof value.slug === "string" && value.slug.trim()
      ? value.slug.trim()
      : "（未知知识页）";
    const error = typeof value.error === "string" && value.error.trim()
      ? value.error.trim().slice(0, MAX_QUARANTINE_ERROR_CHARACTERS)
      : "未知提炼错误";
    const recordRawIds = rawIds(value.rawIds);
    const legacyCreatedAt = typeof value.at === "string" ? Date.parse(value.at) : Number.NaN;
    const createdAt = typeof value.createdAt === "number" && Number.isFinite(value.createdAt)
      ? value.createdAt
      : Number.isFinite(legacyCreatedAt)
        ? legacyCreatedAt
        : fallbackCreatedAt;
    const frozenOperation = operation(value.operation);
    return {
      id,
      space: store.space,
      slug,
      error,
      rawIds: recordRawIds,
      createdAt,
      ...(frozenOperation ? { operation: frozenOperation } : {}),
    };
  } catch (error) {
    return invalidRecord(store, id, fallbackCreatedAt, String(error));
  }
}

/** List newest failures first. Malformed JSON remains visible for manual diagnosis. */
export function listQuarantineRecords(store: SpaceStore): QuarantineRecord[] {
  const dir = directory(store);
  if (!isSafeDirectory(store)) return [];
  return readdirSync(dir)
    .filter((entry) => entry.endsWith(".json"))
    .flatMap((entry) => {
      const id = entry.slice(0, -5);
      const path = pathFor(store, id);
      return path && isRegularFile(path) ? [parseRecord(store, id, path)] : [];
    })
    .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}

export function getQuarantineRecord(store: SpaceStore, id: string): QuarantineRecord | undefined {
  if (!isSafeDirectory(store)) return undefined;
  const path = pathFor(store, id);
  return path && isRegularFile(path) ? parseRecord(store, id, path) : undefined;
}

export function writeQuarantineRecord(
  store: SpaceStore,
  input: NewQuarantineRecord,
): QuarantineRecord {
  const slug = input.slug.trim();
  if (!slug || slug.length > MAX_QUARANTINE_IDENTIFIER_CHARACTERS || slug.includes("\0")) {
    throw new Error("invalid quarantine Knowledge page slug");
  }
  if (!Number.isFinite(input.createdAt) || input.createdAt < 0) {
    throw new Error("invalid quarantine creation time");
  }
  const recordRawIds = rawIds(input.rawIds);
  if (recordRawIds.length === 0) throw new Error("quarantine record requires Raw sources");
  const frozenOperation = input.operation === undefined ? undefined : operation(input.operation);
  if (input.operation !== undefined && !frozenOperation) {
    throw new Error("invalid frozen Dream operation");
  }
  if (
    frozenOperation
    && (
      frozenOperation.rawIds.length !== recordRawIds.length
      || frozenOperation.rawIds.some((rawId, index) => rawId !== recordRawIds[index])
    )
  ) throw new Error("frozen Dream operation does not match quarantine Raw sources");
  const dir = directory(store);
  mkdirSync(dir, { recursive: true });
  if (!isSafeDirectory(store)) throw new Error("unsafe quarantine directory");
  const id = `quarantine-${randomUUID()}`;
  const path = pathFor(store, id)!;
  const temporary = `${path}.${randomUUID()}.tmp`;
  const record: QuarantineRecord = {
    id,
    space: store.space,
    slug,
    error: input.error.trim().slice(0, MAX_QUARANTINE_ERROR_CHARACTERS) || "未知提炼错误",
    rawIds: recordRawIds,
    createdAt: input.createdAt,
    ...(frozenOperation ? { operation: frozenOperation } : {}),
  };
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
  return record;
}

export function removeQuarantineRecord(store: SpaceStore, id: string): boolean {
  if (!isSafeDirectory(store)) return false;
  const path = pathFor(store, id);
  if (!path || !isRegularFile(path)) return false;
  rmSync(path);
  return true;
}

export function removeQuarantineRecordsCoveredBy(
  store: SpaceStore,
  slug: string,
  rawIds: Iterable<string>,
): number {
  const coveredRawIds = new Set(rawIds);
  let removed = 0;
  for (const record of listQuarantineRecords(store)) {
    if (
      record.slug === slug
      && record.rawIds.length > 0
      && record.rawIds.every((rawId) => coveredRawIds.has(rawId))
      && removeQuarantineRecord(store, record.id)
    ) {
      removed += 1;
    }
  }
  return removed;
}
