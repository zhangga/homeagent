import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { NewRunEvent, RunEvent } from "@homeagent/shared";

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

export class RunEventStore {
  private readonly nextSeq = new Map<string, number>();
  private readonly listeners = new Map<string, Set<(event: RunEvent) => void>>();

  constructor(private readonly dataDir: string) {}

  append(input: NewRunEvent): RunEvent {
    if (!RUN_ID_RE.test(input.runId)) throw new Error("Run event id is invalid");
    const title = boundText(input.title, MAX_TITLE_CHARACTERS);
    if (!title) throw new Error("Run event title is required");
    const current = this.list(input.runId);
    if (current.length >= MAX_EVENTS_PER_RUN) throw new Error("Run event limit reached");
    const path = eventPath(this.dataDir, input.runId);
    const size = existsSync(path) ? Bun.file(path).size : 0;
    if (size >= MAX_EVENT_FILE_BYTES) throw new Error("Run event file size limit reached");
    const seq = this.nextSeq.get(input.runId) ?? ((current.at(-1)?.seq ?? 0) + 1);
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
    appendFileSync(path, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
    const descriptor = openSync(path, "r+");
    try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
    this.nextSeq.set(input.runId, seq + 1);
    for (const listener of [...(this.listeners.get(input.runId) ?? [])]) {
      try { listener(structuredClone(event)); } catch { /* observers cannot roll back commits */ }
    }
    return structuredClone(event);
  }

  list(runId: string, afterSeq = 0): RunEvent[] {
    const path = eventPath(this.dataDir, runId);
    if (!existsSync(path)) return [];
    const text = readFileSync(path, "utf8");
    const events: RunEvent[] = [];
    let previous = 0;
    for (const line of text.split(/\r?\n/u)) {
      if (!line.trim()) continue;
      let value: unknown;
      try { value = JSON.parse(line); } catch { throw new Error("Run event history is corrupt"); }
      if (!validEvent(value, runId) || value.seq <= previous) {
        throw new Error("Run event history is corrupt");
      }
      previous = value.seq;
      if (value.seq > afterSeq) events.push(structuredClone(value));
    }
    this.nextSeq.set(runId, previous + 1);
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
