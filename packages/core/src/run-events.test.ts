import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunEventStore } from "./run-events.ts";

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
