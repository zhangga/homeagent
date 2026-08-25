import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Page, PageRef, RawRecord, SpaceId } from "@homeagent/shared";
import type { SpaceStore } from "./space.ts";

export type KnowledgeGovernanceAction =
  | "rules_updated"
  | "rule_reset"
  | "raw_redistilled"
  | "page_deleted"
  | "page_regenerated"
  | "correction_submitted";

export type KnowledgeGovernanceStatus = "succeeded" | "failed";

export interface KnowledgeGovernanceAuditRecord {
  id: string;
  space: SpaceId;
  action: KnowledgeGovernanceAction;
  actor: string;
  target: string;
  status: KnowledgeGovernanceStatus;
  summary: string;
  rawIds: string[];
  pageSlugs: string[];
  createdAt: number;
}

export interface KnowledgeGovernanceSnapshot {
  purpose: string;
  schema: string;
  audit: KnowledgeGovernanceAuditRecord[];
}

export interface RawGovernanceDetail {
  raw: RawRecord;
  pages: PageRef[];
}

export interface KnowledgePageDeleteResult {
  status: "deleted" | "not_found";
  slug: string;
  rawIds: string[];
}

export interface KnowledgePageRegenerationResult {
  status: "regenerated" | "not_found" | "failed";
  slug: string;
  rawIds: string[];
  page?: Page;
  reason?: string;
}

export interface KnowledgeCorrectionResult extends KnowledgePageRegenerationResult {
  rawId?: string;
}

export interface KnowledgeGovernanceAuditInput {
  action: KnowledgeGovernanceAction;
  actor: string;
  target: string;
  status?: KnowledgeGovernanceStatus;
  summary: string;
  rawIds?: string[];
  pageSlugs?: string[];
  createdAt?: number;
}

const MAX_RULE_CHARACTERS = 50_000;
const MAX_AUDIT_SUMMARY_CHARACTERS = 1_000;
const ACTIONS: KnowledgeGovernanceAction[] = [
  "rules_updated",
  "rule_reset",
  "raw_redistilled",
  "page_deleted",
  "page_regenerated",
  "correction_submitted",
];
const STATUSES: KnowledgeGovernanceStatus[] = ["succeeded", "failed"];

function governanceDirectory(store: SpaceStore): string {
  return join(store.root, "governance");
}

function auditPath(store: SpaceStore): string {
  return join(governanceDirectory(store), "audit.jsonl");
}

function ensureSafeGovernanceDirectory(store: SpaceStore): string {
  const directory = governanceDirectory(store);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stats = lstatSync(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error("unsafe governance directory");
  }
  return directory;
}

function assertSafeAuditFile(store: SpaceStore): void {
  const path = auditPath(store);
  if (!existsSync(path)) return;
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("unsafe governance audit file");
}

function writeAuditRecords(
  store: SpaceStore,
  records: KnowledgeGovernanceAuditRecord[],
): void {
  const directory = ensureSafeGovernanceDirectory(store);
  assertSafeAuditFile(store);
  const path = auditPath(store);
  const temporary = join(directory, `.audit-${randomUUID()}.tmp`);
  const content = records.length === 0
    ? ""
    : `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
  try {
    writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function cleanText(value: string, label: string, max: number): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label}不能为空`);
  if (value.includes("\0")) throw new Error(`${label}包含非法字符`);
  if (value.length > max) throw new Error(`${label}不能超过 ${max} 字符`);
  return trimmed;
}

function cleanStrings(value: string[]): string[] {
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))];
}

export function normalizeSpaceRule(value: string, label: "purpose" | "schema"): string {
  return `${cleanText(value, label, MAX_RULE_CHARACTERS)}\n`;
}

export function normalizeGovernanceActor(actor: string): string {
  return cleanText(actor, "操作人", 200);
}

export function normalizeKnowledgeCorrection(correction: string): string {
  return cleanText(correction, "纠错说明", 20_000);
}

export function assertGovernablePageSlug(slug: string): string {
  const normalized = cleanText(slug, "知识页 slug", 300);
  const segments = normalized.split("/");
  if (
    normalized.startsWith("/")
    || normalized.includes("\\")
    || segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error("知识页 slug 不安全");
  }
  if (["index", "overview", "log", "glossary"].includes(normalized) || normalized.startsWith("maps/")) {
    throw new Error("自动生成的导航页不能人工删除或重新生成");
  }
  return normalized;
}

export function appendKnowledgeGovernanceAudit(
  store: SpaceStore,
  input: KnowledgeGovernanceAuditInput,
): KnowledgeGovernanceAuditRecord {
  const record: KnowledgeGovernanceAuditRecord = {
    id: randomUUID(),
    space: store.space,
    action: input.action,
    actor: normalizeGovernanceActor(input.actor),
    target: cleanText(input.target, "治理目标", 500),
    status: input.status ?? "succeeded",
    summary: cleanText(input.summary, "治理摘要", MAX_AUDIT_SUMMARY_CHARACTERS),
    rawIds: cleanStrings(input.rawIds ?? []),
    pageSlugs: cleanStrings(input.pageSlugs ?? []),
    createdAt: input.createdAt ?? Date.now(),
  };
  writeAuditRecords(store, [...listKnowledgeGovernanceAudit(store), record]);
  return record;
}

export function parseKnowledgeGovernanceAuditRecord(
  value: unknown,
  line: number,
  space: SpaceId,
): KnowledgeGovernanceAuditRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`governance audit line ${line} must be an object`);
  }
  const item = value as Record<string, unknown>;
  const action = item.action as KnowledgeGovernanceAction;
  const status = item.status as KnowledgeGovernanceStatus;
  if (item.space !== space) throw new Error(`governance audit line ${line} has the wrong space`);
  if (!ACTIONS.includes(action)) throw new Error(`governance audit line ${line} has an invalid action`);
  if (!STATUSES.includes(status)) throw new Error(`governance audit line ${line} has an invalid status`);
  if (
    typeof item.id !== "string"
    || typeof item.actor !== "string"
    || typeof item.target !== "string"
    || typeof item.summary !== "string"
    || typeof item.createdAt !== "number"
    || !Number.isFinite(item.createdAt)
    || !Array.isArray(item.rawIds)
    || item.rawIds.some((entry) => typeof entry !== "string")
    || !Array.isArray(item.pageSlugs)
    || item.pageSlugs.some((entry) => typeof entry !== "string")
  ) {
    throw new Error(`governance audit line ${line} is invalid`);
  }
  return {
    id: cleanText(item.id, "审计 id", 200),
    space,
    action,
    actor: normalizeGovernanceActor(item.actor),
    target: cleanText(item.target, "治理目标", 500),
    status,
    summary: cleanText(item.summary, "治理摘要", MAX_AUDIT_SUMMARY_CHARACTERS),
    rawIds: cleanStrings(item.rawIds as string[]),
    pageSlugs: cleanStrings(item.pageSlugs as string[]),
    createdAt: item.createdAt,
  };
}

export function listKnowledgeGovernanceAudit(
  store: SpaceStore,
): KnowledgeGovernanceAuditRecord[] {
  const path = auditPath(store);
  if (!existsSync(path)) return [];
  assertSafeAuditFile(store);
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new Error(`governance audit line ${index + 1} is invalid JSON`);
      }
      return parseKnowledgeGovernanceAuditRecord(parsed, index + 1, store.space);
    });
}

export function restoreKnowledgeGovernanceAudit(
  store: SpaceStore,
  records: KnowledgeGovernanceAuditRecord[],
): void {
  if (records.length === 0) return;
  const normalized = records.map((record, index) =>
    parseKnowledgeGovernanceAuditRecord(record, index + 1, store.space)
  );
  const ids = new Set<string>();
  for (const record of normalized) {
    if (ids.has(record.id)) throw new Error(`duplicate governance audit id: ${record.id}`);
    ids.add(record.id);
  }
  writeAuditRecords(store, normalized);
}
