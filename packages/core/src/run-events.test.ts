import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunEventStore } from "./run-events.ts";
import * as durable from "./durable-file.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ha-run-events-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

test("persists ordered events and resumes sequence after reopen", () => {
  const first = new RunEventStore(dir);
  expect(first.append({ runId: "chat_run_one", at: 100, kind: "run.queued", visibility: "public", title: "已排队" }).seq).toBe(1);
  expect(first.append({ runId: "chat_run_one", at: 110, kind: "run.started", visibility: "public", title: "已开始" }).seq).toBe(2);
  const reopened = new RunEventStore(dir);
  expect(reopened.list("chat_run_one").map(event => event.seq)).toEqual([1, 2]);
  expect(reopened.append({ runId: "chat_run_one", at: 120, kind: "run.succeeded", visibility: "public", title: "已完成" }).seq).toBe(3);
});

test("replays after a sequence and publishes only after persistence", () => {
  const store = new RunEventStore(dir);
  const seen: number[] = [];
  const unsubscribe = store.subscribe("chat_run_two", event => seen.push(event.seq));
  store.append({ runId: "chat_run_two", at: 100, kind: "phase.started", visibility: "public", title: "准备执行" });
  store.append({ runId: "chat_run_two", at: 110, kind: "assistant.delta", visibility: "public", title: "生成回答", delta: "你好" });
  unsubscribe();
  store.append({ runId: "chat_run_two", at: 120, kind: "run.succeeded", visibility: "public", title: "已完成" });
  expect(seen).toEqual([1, 2]);
  expect(store.list("chat_run_two", 1).map(event => event.seq)).toEqual([2, 3]);
});

test("bounds and sanitizes public text", () => {
  const store = new RunEventStore(dir);
  const event = store.append({ runId: "chat_run_three", at: 100, kind: "assistant.delta", visibility: "public", title: `执行\u0000阶段${"x".repeat(200)}`, detail: "d".repeat(3_000), delta: "z".repeat(5_000) });
  expect(event.title.length).toBe(120);
  expect(event.title.includes("\u0000")).toBe(false);
  expect(event.detail?.length).toBe(2_000);
  expect(event.delta?.length).toBe(4_000);
});

test("rejects a corrupt or non-monotonic journal", async () => {
  const store = new RunEventStore(dir);
  store.append({ runId: "chat_run_four", at: 100, kind: "run.queued", visibility: "public", title: "已排队" });
  const path = join(dir, "runs", "chat-events", "chat_run_four.jsonl");
  await Bun.write(path, `${await Bun.file(path).text()}{"schemaVersion":1,"runId":"chat_run_four","seq":1,"at":110,"kind":"run.started","visibility":"public","title":"重复"}\n`);
  expect(() => new RunEventStore(dir).list("chat_run_four")).toThrow("corrupt");
});

const progress = { runId: "chat_progress", at: 100, kind: "assistant.snapshot", visibility: "public", title: "生成回答" } as const;
const progressPath = () => join(dir, "runs", "chat-events", `${progress.runId}.jsonl`);

test("consecutive appends do not parse earlier progress events again", () => {
  const store = new RunEventStore(dir);
  store.append(progress);
  const parse = spyOn(JSON, "parse");
  try {
    for (let i = 1; i < 200; i++) store.append(progress);
    expect(parse).not.toHaveBeenCalled();
  } finally { parse.mockRestore(); }
  expect(store.list(progress.runId).map(event => event.seq)).toEqual(Array.from({ length: 200 }, (_, i) => i + 1));
});

test("refreshes the cached sequence after another store appends or the journal is replaced or removed", () => {
  const store = new RunEventStore(dir);
  const other = new RunEventStore(dir);
  const first = store.append(progress);
  expect(other.append(progress).seq).toBe(2);
  expect(store.append(progress).seq).toBe(3);
  const path = progressPath();
  writeFileSync(path + ".new", JSON.stringify({ ...first, seq: 14 })); // A valid last line without a newline.
  renameSync(path + ".new", path);
  expect(store.append(progress).seq).toBe(15);
  expect(other.list(progress.runId).map(event => event.seq)).toEqual([14, 15]);
  rmSync(path);
  expect(store.append(progress).seq).toBe(1);
});

test("rejects a same-size corrupt edit before appending to a cached journal", () => {
  const store = new RunEventStore(dir);
  store.append(progress);
  const path = progressPath();
  const edited = readFileSync(path, "utf8").replace('"seq":1', '"seq":0');
  writeFileSync(path, edited);
  utimesSync(path, new Date(1_000), new Date(1_000));
  expect(() => store.append(progress)).toThrow("corrupt");
  expect(readFileSync(path, "utf8")).toBe(edited);
});

test("enforces the event count after a rescan and a cached append with non-contiguous sequence numbers", () => {
  const store = new RunEventStore(dir);
  const first = store.append(progress);
  const lines = Array.from({ length: 1_999 }, (_, i) => JSON.stringify({ ...first, seq: i + 10 }));
  writeFileSync(progressPath(), lines.join("\n") + "\n");
  expect(store.append(progress).seq).toBe(2_009);
  expect(store.list(progress.runId, 2_008)).toHaveLength(1);
  expect(() => store.append(progress)).toThrow("event limit");
  expect(() => new RunEventStore(dir).append(progress)).toThrow("event limit");
});

test("enforces the journal byte limit after an external write", () => {
  const store = new RunEventStore(dir);
  store.append(progress);
  const path = progressPath();
  const line = readFileSync(path, "utf8");
  writeFileSync(path, line + " ".repeat(2 * 1024 * 1024 - Buffer.byteLength(line)));
  expect(() => store.append(progress)).toThrow("file size limit");
});

test("recovers the on-disk sequence after fsync fails and does not publish the failed append", () => {
  const store = new RunEventStore(dir);
  const seen: number[] = [];
  store.subscribe(progress.runId, event => seen.push(event.seq));
  store.append(progress);
  const flush = spyOn(durable, "durableFsyncSync").mockImplementationOnce(() => { throw new Error("flush failed"); });
  try {
    expect(() => store.append(progress)).toThrow("flush failed");
  } finally { flush.mockRestore(); }
  expect(seen).toEqual([1]);
  expect(store.append(progress).seq).toBe(3);
  expect(seen).toEqual([1, 3]);
  expect(new RunEventStore(dir).list(progress.runId).map(event => event.seq)).toEqual([1, 2, 3]);
});
