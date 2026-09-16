import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as durable from "./durable-file.ts";
import { chatSourceProgressInstruction, ChatSourceProgressStore } from "./chat-source-progress.ts";

let root: string;
let store: ChatSourceProgressStore;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ha-source-progress-")));
  const workspace = join(root, "workspace"); mkdirSync(workspace);
  store = new ChatSourceProgressStore(root, workspace, "team/oc_one", "binding-1");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const window = { startAt: 1000, endAt: 2000, incomplete: false, failedMessageIds: [] as string[] };

test("advances only after full coverage, retains gaps across newer queries and reopen", () => {
  expect(store.read()).toBeUndefined();
  expect(store.commit(window).coveredThrough).toBe(2000);
  expect(store.commit({ ...window, startAt: 2000, endAt: 3000, incomplete: true, failedMessageIds: ["om_failed"] }).retryStartAt).toBe(2000);
  const later = store.commit({ ...window, startAt: 3000, endAt: 4000 });
  expect(later.coveredThrough).toBe(2000);
  expect(later.failedMessageIds).toEqual(["om_failed"]);
  const reopened = new ChatSourceProgressStore(root, join(root, "workspace"), "team/oc_one", "binding-1");
  expect(reopened.read()).toEqual(later);
  expect(reopened.commit({ ...window, startAt: 1999, endAt: 4000 })).toMatchObject({ retryStartAt: 4000, coveredThrough: 4000, failedMessageIds: [] });
});

test("empty fully covered windows advance and older out-of-order completion never skips a gap", () => {
  store.commit({ ...window, incomplete: true });
  store.commit({ ...window, startAt: 2000, endAt: 4000, incomplete: true });
  expect(store.commit(window)).toMatchObject({ retryStartAt: 1000, pendingThrough: 4000 });
  expect(store.read()?.coveredThrough).toBeUndefined();
  expect(store.commit({ ...window, endAt: 4000 }).coveredThrough).toBe(4000);
});

test("persistence failure preserves prior checkpoint and successful retry commits", () => {
  store.commit(window);
  const before = readFileSync(store.file, "utf8");
  const failure = spyOn(durable, "writeAtomicStateFile").mockImplementation(() => { throw new Error("simulated failure"); });
  try { expect(() => store.commit({ ...window, startAt: 2000, endAt: 3000 })).toThrow(); }
  finally { failure.mockRestore(); }
  expect(readFileSync(store.file, "utf8")).toBe(before);
  expect(store.commit({ ...window, startAt: 2000, endAt: 3000 }).coveredThrough).toBe(3000);
});

test("ownership changes ignore old progress; malformed/future/oversized state fails closed", () => {
  store.commit(window);
  const other = new ChatSourceProgressStore(root, join(root, "workspace"), "team/oc_one", "binding-2");
  expect(other.read()).toBeUndefined();
  const valid = store.read()!;
  for (const value of [{ ...valid, version: 2 }, { ...valid, retryStartAt: -1 }, { ...valid, pendingThrough: 999 },
    { ...valid, failedMessageIds: ["a".repeat(257)] }]) {
    writeFileSync(store.file, JSON.stringify(value));
    expect(() => store.read()).toThrow();
  }
  writeFileSync(store.file, " ".repeat(512 * 1024 + 1));
  expect(() => store.read()).toThrow();
});

test("bounds pending IDs before writing and clones state", () => {
  const ids = Array.from({ length: 1000 }, (_, i) => `om_${i}`);
  const saved = store.commit({ ...window, incomplete: true, failedMessageIds: ids });
  ids[0] = "mutated";
  saved.failedMessageIds[0] = "mutated-again";
  expect(store.read()?.failedMessageIds[0]).toBe("om_0");
  expect(() => store.commit({ ...window, incomplete: true, failedMessageIds: ["om_overflow"] })).toThrow();
  expect(store.read()?.failedMessageIds).toHaveLength(1000);
  const instruction = chatSourceProgressInstruction(store.read());
  expect(instruction).toContain('"failedCount":1000');
  expect(instruction).not.toContain('"om_50"');
  expect(instruction).toContain("整个待补窗口");
});

test("rejects hardlinks and symlink ancestors without changing their target", () => {
  store.commit(window);
  const other = join(root, "other.json"); writeFileSync(other, "private");
  rmSync(store.file); linkSync(other, store.file);
  expect(() => store.read()).toThrow();
  rmSync(store.file);
  const linked = join(root, "linked");
  symlinkSync(join(root, "workspace"), linked, process.platform === "win32" ? "junction" : "dir");
  const unsafe = new ChatSourceProgressStore(root, linked, "team/oc_one", "binding-1");
  expect(() => unsafe.commit(window)).toThrow();
  expect(readFileSync(other, "utf8")).toBe("private");
});

test("different requested sources have separate progress and resolved identity changes reset the baseline", () => {
  const one = new ChatSourceProgressStore(root, join(root, "workspace"), "team/oc_one", "binding-1", "name:PST");
  const two = new ChatSourceProgressStore(root, join(root, "workspace"), "team/oc_one", "binding-1", "name:OTHER");
  one.commit({ ...window, sourceChatId: "oc_pst" });
  expect(two.read()).toBeUndefined();
  expect(store.read()).toBeUndefined();
  const next = one.commit({ ...window, sourceChatId: "oc_replacement", startAt: 3000, endAt: 4000, incomplete: true });
  expect(next.coveredThrough).toBeUndefined();
  expect(next.retryStartAt).toBe(3000);
  expect(next.sourceChatId).toBe("oc_replacement");
});

test("legacy current-group progress keeps unresolved gaps when adding source identity", () => {
  store.commit({ ...window, incomplete: true, failedMessageIds: ["om_old_gap"] });
  const next = store.commit({ ...window, sourceChatId: "oc_one", startAt: 2000, endAt: 3000 });
  expect(next.retryStartAt).toBe(1000);
  expect(next.coveredThrough).toBeUndefined();
  expect(next.failedMessageIds).toEqual(["om_old_gap"]);
});
