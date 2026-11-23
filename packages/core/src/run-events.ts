import {
  appendFileSync,
  type BigIntStats,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { NewRunEvent, RunEvent } from "@homeagent/shared";
import { durableFsyncSync } from "./durable-file.ts";

const RUN_ID_RE = /^[a-zA-Z0-9_-]{1,160}$/u;
const MAX_TITLE_CHARACTERS = 120;
const MAX_DETAIL_CHARACTERS = 2_000;
const MAX_DELTA_CHARACTERS = 4_000;
const MAX_EVENTS_PER_RUN = 2_000;
const MAX_EVENT_FILE_BYTES = 2 * 1024 * 1024;

function eventPath(dataDir: string, runId: string): string {
  if (!RUN_ID_RE.test(runId)) throw new Error("Run event id is invalid");
  return join(dataDir, "runs", "chat-events", `${runId}.jsonl`);
}

function boundText(value: string | undefined, limit: number): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "").trim();
  return normalized ? normalized.slice(0, limit) : undefined;
}

function validEvent(value: unknown, runId?: string): value is RunEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as RunEvent;
  return event.schemaVersion === 1
    && typeof event.runId === "string"
    && RUN_ID_RE.test(event.runId)
    && (runId === undefined || event.runId === runId)
    && Number.isSafeInteger(event.seq)
    && event.seq > 0
    && Number.isSafeInteger(event.at)
    && event.at >= 0
    && typeof event.kind === "string"
    && (event.visibility === "public" || event.visibility === "operator")
    && typeof event.title === "string"
    && event.title.length > 0
    && event.title.length <= MAX_TITLE_CHARACTERS
    && (event.detail === undefined || (typeof event.detail === "string" && event.detail.length <= MAX_DETAIL_CHARACTERS))
    && (event.delta === undefined || (typeof event.delta === "string" && event.delta.length <= MAX_DELTA_CHARACTERS));
}

interface JournalHead {
  count: number;
  lastSeq: number;
  needsSeparator: boolean;
}

function fileVersion(info: BigIntStats): string {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
}

function scanJournal(text: string, runId: string, visit?: (event: RunEvent) => void): JournalHead {
  let lastSeq = 0;
  let count = 0;
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw new Error("Run event history is corrupt"); }
    if (!validEvent(value, runId) || value.seq <= lastSeq) throw new Error("Run event history is corrupt");
    lastSeq = value.seq;
    count++;
    visit?.(value);
  }
  return { count, lastSeq, needsSeparator: text.length > 0 && !text.endsWith("\n") };
}

export class RunEventStore {
  private readonly heads = new Map<string, JournalHead & { version: string }>();
  private readonly listeners = new Map<string, Set<(event: RunEvent) => void>>();

  constructor(private readonly dataDir: string) {}

  append(input: NewRunEvent): RunEvent {
    if (!RUN_ID_RE.test(input.runId)) throw new Error("Run event id is invalid");
    const title = boundText(input.title, MAX_TITLE_CHARACTERS);
    if (!title) throw new Error("Run event title is required");
    const path = eventPath(this.dataDir, input.runId);
    const before = statSync(path, { bigint: true, throwIfNoEntry: false });
    const cached = this.heads.get(input.runId);
    const head = before && cached?.version === fileVersion(before)
      ? cached
      : scanJournal(before ? readFileSync(path, "utf8") : "", input.runId);
    if (head.count >= MAX_EVENTS_PER_RUN) throw new Error("Run event limit reached");
    if (before && before.size >= MAX_EVENT_FILE_BYTES) throw new Error("Run event file size limit reached");
    const seq = head.lastSeq + 1;
    const event: RunEvent = {
      ...input,
      schemaVersion: 1,
      seq,
      title,
      detail: boundText(input.detail, MAX_DETAIL_CHARACTERS),
      delta: boundText(input.delta, MAX_DELTA_CHARACTERS),
    };
    if (!validEvent(event, input.runId)) throw new Error("Run event is invalid");
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const line = `${head.needsSeparator ? "\n" : ""}${JSON.stringify(event)}\n`;
    const descriptor = openSync(path, "a", 0o600);
    // A write or flush failure can leave complete or partial bytes on disk.
    this.heads.delete(input.runId);
    let after: BigIntStats;
    try {
      appendFileSync(descriptor, line, "utf8");
      durableFsyncSync(descriptor);
      after = fstatSync(descriptor, { bigint: true });
    } finally { closeSync(descriptor); }
    if (after.size === (before?.size ?? 0n) + BigInt(Buffer.byteLength(line))) {
      this.heads.set(input.runId, { count: head.count + 1, lastSeq: seq, needsSeparator: false, version: fileVersion(after) });
    }
    for (const listener of [...(this.listeners.get(input.runId) ?? [])]) {
      try { listener(structuredClone(event)); } catch { /* observers cannot roll back commits */ }
    }
    return structuredClone(event);
  }

  list(runId: string, afterSeq = 0): RunEvent[] {
    const path = eventPath(this.dataDir, runId);
    if (!existsSync(path)) return [];
    const events: RunEvent[] = [];
    scanJournal(readFileSync(path, "utf8"), runId, event => {
      if (event.seq > afterSeq) events.push(event);
    });
    return events;
  }

  subscribe(runId: string, listener: (event: RunEvent) => void): () => void {
    if (!RUN_ID_RE.test(runId)) throw new Error("Run event id is invalid");
    const listeners = this.listeners.get(runId) ?? new Set();
    listeners.add(listener);
    this.listeners.set(runId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(runId);
    };
  }
}
