import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetConfig, type SpaceId } from "@homeagent/shared";
import { makeCliClient } from "./cli-client.ts";
import { regeneratePageFromSources, runDreamCycle, retryQuarantinedDreamOperation } from "./dream.ts";
import { DreamRunTracker } from "./dream-progress.ts";
import { listQuarantineRecords } from "./quarantine.ts";
import { SpaceStore } from "./space.ts";
import { FakeLlm } from "./testing.ts";

const SPACE: SpaceId = "team/oc_concurrent_dream";
let dir: string;
let store: SpaceStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ha-concurrent-dream-"));
  process.env.HOMEAGENT_DATA_DIR = dir;
  resetConfig();
  store = new SpaceStore(SPACE, dir);
  store.ensure();
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.HOMEAGENT_DATA_DIR;
  resetConfig();
});

function gate() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Advance only promise continuations: no wall-clock delays or live providers.
async function flush() { for (let i = 0; i < 150; i++) await Promise.resolve(); }

function note(content: string) {
  return { title: "Knowledge", summary: "Evidence", content, aliases: [], tags: [], links: [] };
}

function scenario(count: number, targets = (_part: number) => ["a"], signal?: AbortSignal, honorAbort = true) {
  const content = Array.from({ length: count }, (_, i) => `FRAGMENT_${i + 1}_END`.padEnd(48_000, "文")).join("");
  const id = store.index().insertRaw({ space: SPACE, source: "message", content });
  const gates = Array.from({ length: count }, gate);
  const started: number[] = [];
  const finished: number[] = [];
  const prompts: string[] = [];
  const merges: string[] = [];
  const signals: Array<AbortSignal | undefined> = [];
  let active = 0;
  let peak = 0;
  const client = makeCliClient("codex", "frozen-model", dir, async (_provider, input, _timeout, receivedSignal) => {
    const prompt = input.prompt;
    prompts.push(prompt);
    expect(input.model).toBe("frozen-model");
    const part = Number(/FRAGMENT_(\d+)_END/u.exec(prompt)?.[1]);
    if (prompt.includes("## 待提炼的原始条目")) return JSON.stringify({
      operations: targets(part).map(name => ({ type: "concept", name, title: name, rawIds: [id] })), skippedRawIds: [],
    });
    if (prompt.includes("## 来源分段提取") || prompt.includes("## 多页共享提取")) {
      started.push(part);
      signals.push(receivedSignal);
      active++;
      peak = Math.max(peak, active);
      const pending = gates[part - 1]!;
      const abort = () => pending.reject(new Error("cancelled"));
      if (honorAbort) receivedSignal?.addEventListener("abort", abort, { once: true });
      try { await pending.promise; }
      finally { active--; receivedSignal?.removeEventListener("abort", abort); }
      finished.push(part);
      return JSON.stringify(prompt.includes("## 多页共享提取")
        ? { pages: targets(part).toReversed().map(name => ({ slug: `concepts/${name}`, ...note(`${name}:DETAIL_${part}_END`) })) }
        : note(`DETAIL_${part}_END`));
    }
    expect(active).toBe(0);
    merges.push(prompt);
    return JSON.stringify(note("Main text"));
  }, undefined, undefined, signal);
  return { id, gates, started, finished, prompts, merges, signals, client,
    get active() { return active; }, get peak() { return peak; },
    release() { gates.forEach(item => item.resolve()); } };
}

test("two extraction slots refill independently and out-of-order results retain complete source order", async () => {
  const s = scenario(5);
  const tracker = new DreamRunTracker();
  const runId = tracker.enqueue(SPACE, "manual");
  tracker.start(runId);
  const run = runDreamCycle(store, {}, { client: s.client, onProgress: progress => tracker.update(runId, progress) });
  try {
    await flush();
    expect(s.started).toEqual([1, 2]);
    expect(tracker.list()[0]).toMatchObject({ stage: "extracting", extraction: { active: 2, completed: 0, total: 5 } });
    for (const part of [2, 3, 4, 5]) {
      s.gates[part - 1]!.resolve();
      await flush();
      expect(s.active).toBe(part === 5 ? 1 : 2);
      expect(s.merges).toEqual([]);
      expect(store.index().getPage("concepts/a")).toBeNull();
    }
    expect(s.started).toEqual([1, 2, 3, 4, 5]);
    expect(s.finished).toEqual([2, 3, 4, 5]);
    expect(tracker.list()[0]).toMatchObject({ extraction: { active: 1, completed: 4, total: 5 } });
    s.gates[0]!.resolve();
    const report = await run;
    expect(report.errors).toEqual([]);
    expect(s.peak).toBe(2);
    expect(s.prompts).toHaveLength(11); // Five planning, five extraction, one merge.
    const page = store.index().getPage("concepts/a")!;
    const details = [...page.content.matchAll(/DETAIL_(\d+)_END/gu)].map(match => Number(match[1]));
    expect(details).toEqual([1, 2, 3, 4, 5]);
    expect(page.sources).toEqual([s.id]);
    expect(tracker.list()[0]).not.toHaveProperty("extraction");
  } finally { s.release(); await run; }
});

test("shared extraction uses three provider waves for six fragments and is reused by all target pages", async () => {
  const s = scenario(6, () => ["a", "b", "c", "d"]);
  const run = runDreamCycle(store, {}, { client: s.client });
  try {
    for (let wave = 0; wave < 3; wave++) {
      await flush();
      expect(s.started).toHaveLength((wave + 1) * 2);
      expect(s.active).toBe(2);
      s.gates[wave * 2 + 1]!.resolve();
      s.gates[wave * 2]!.resolve();
    }
    const report = await run;
    expect(report.pagesWritten).toBe(4);
    expect(report.errors).toEqual([]);
    expect(s.peak).toBe(2);
    expect(s.started).toEqual([1, 2, 3, 4, 5, 6]);
    expect(s.prompts).toHaveLength(16); // Six planning, six shared extraction, four merges.
    for (const name of ["a", "b", "c", "d"]) {
      const page = store.index().getPage(`concepts/${name}`)!;
      expect([...page.content.matchAll(/DETAIL_(\d+)_END/gu)].map(match => Number(match[1]))).toEqual([1, 2, 3, 4, 5, 6]);
      expect(page.content).toContain(`${name}:DETAIL_6_END`);
    }
  } finally { s.release(); await run; }
});

test("manual full regeneration extracts the entire source concurrently without repeating planning", async () => {
  const s = scenario(3);
  store.writePage({ slug: "concepts/a", type: "concept", ...note("OLD_PAGE"), sources: [s.id], updatedAt: 1, contentHash: "old" });
  const run = regeneratePageFromSources(store, "concepts/a", [], {}, { client: s.client });
  try {
    await flush();
    expect(s.started).toEqual([1, 2]);
    s.release();
    const page = await run;
    expect(s.started).toEqual([1, 2, 3]);
    expect(s.peak).toBe(2);
    expect(s.prompts).toHaveLength(4);
    expect(s.merges[0]).toContain("OLD_PAGE");
    expect([...page.content.matchAll(/DETAIL_(\d+)_END/gu)].map(match => Number(match[1]))).toEqual([1, 2, 3]);
    expect(page.sources).toEqual([s.id]);
  } finally { s.release(); await run; }
});

test("cancellation from extraction progress is checked before launching a provider", async () => {
  const abort = new AbortController();
  const s = scenario(3, () => ["a"], abort.signal);
  const run = runDreamCycle(store, { signal: abort.signal }, { client: s.client, onProgress(progress) {
    if (progress.stage === "extracting") abort.abort(new Error("cancelled"));
  } });
  await expect(run).rejects.toThrow("cancelled");
  expect(s.started).toEqual([]);
  expect(s.prompts).toHaveLength(3);
  expect(store.index().countRaw(true)).toBe(1);
  expect(listQuarantineRecords(store)).toEqual([]);
});

test("a failed extraction stops queued work, drains both failures, and preserves the full frozen retry after reopen", async () => {
  const s = scenario(4);
  store.writePage({ slug: "concepts/a", type: "concept", ...note("OLD_PAGE"), sources: [], updatedAt: 1, contentHash: "old" });
  let settled = false;
  const run = runDreamCycle(store, {}, { client: s.client }).finally(() => { settled = true; });
  try {
    await flush();
    expect(s.started).toEqual([1, 2]);
    s.gates[1]!.reject(new Error("second fragment failed first"));
    await flush();
    expect(settled).toBe(false);
    expect(s.started).toEqual([1, 2]);
    expect(listQuarantineRecords(store)).toEqual([]);
    s.gates[0]!.reject(new Error("first fragment also failed"));
    const report = await run;
    expect(report.pagesWritten).toBe(0);
    expect(report.pagesQuarantined).toBe(1);
    expect(report.errors[0]).toContain("second fragment failed first");
    expect(store.index().getPage("concepts/a")?.content).toBe("OLD_PAGE");
    store.close();
    store = new SpaceStore(SPACE, dir);
    const record = listQuarantineRecords(store)[0]!;
    expect(record.operation?.sourceFragments?.map(fragment => fragment.part)).toEqual([1, 2, 3, 4]);
    const retry = new FakeLlm().onJSON(opts => note(opts.prompt?.includes("## 来源分段提取") ? "Recovered detail" : "Recovered page"));
    expect((await retryQuarantinedDreamOperation(store, record, {}, { client: retry })).errors).toEqual([]);
    expect(retry.calls).toHaveLength(5);
  } finally { s.release(); await run; }
});

test("a private failure preserves in-flight shared evidence for a sibling and permits an unrelated page", async () => {
  const s = scenario(4, part => part === 1 ? ["a", "b"] : part === 4 ? ["other"] : ["a"]);
  const run = runDreamCycle(store, {}, { client: s.client });
  try {
    await flush();
    expect(s.started).toEqual([1, 2]);
    s.gates[1]!.reject(new Error("private extraction failed"));
    await flush();
    s.gates[0]!.resolve();
    const report = await run;
    expect(report.pagesWritten).toBe(2);
    expect(report.pagesQuarantined).toBe(1);
    expect(s.started).toEqual([1, 2]);
    expect(store.index().getPage("concepts/a")).toBeNull();
    expect(store.index().getPage("concepts/b")?.content).toContain("b:DETAIL_1_END");
    expect(store.index().getPage("concepts/b")?.content).not.toContain("DETAIL_2_END");
    expect(store.index().getPage("concepts/other")).not.toBeNull();
  } finally { s.release(); await run; }
});

test("a cached shared failure prevents sibling pages from launching more extraction", async () => {
  const s = scenario(4, () => ["a", "b"]);
  const run = runDreamCycle(store, {}, { client: s.client });
  try {
    await flush();
    expect(s.started).toEqual([1, 2]);
    s.gates[1]!.reject(new Error("shared extraction failed"));
    await flush();
    s.gates[0]!.resolve();
    const report = await run;
    expect(report.pagesQuarantined).toBe(2);
    expect(report.pagesWritten).toBe(0);
    expect(s.started).toEqual([1, 2]);
    expect(s.merges).toEqual([]);
  } finally { s.release(); await run; }
});

test.each([true, false])("cancellation stops dispatch and waits for started providers (provider honors abort: %s)", async honorAbort => {
  const abort = new AbortController();
  const s = scenario(4, () => ["a", "b"], abort.signal, honorAbort);
  let settled = false;
  const run = runDreamCycle(store, { signal: abort.signal }, { client: s.client });
  void run.then(() => { settled = true; }, () => { settled = true; });
  try {
    await flush();
    expect(s.started).toEqual([1, 2]);
    expect(s.signals).toEqual([abort.signal, abort.signal]);
    abort.abort(new Error("cancelled"));
    await flush();
    if (!honorAbort) {
      expect(settled).toBe(false);
      s.gates[1]!.resolve();
      await flush();
      expect(settled).toBe(false);
      s.gates[0]!.resolve();
    }
    await expect(run).rejects.toThrow("cancelled");
    expect(s.started).toEqual([1, 2]);
    expect(s.active).toBe(0);
    expect(s.merges).toEqual([]);
    expect(store.index().countRaw(true)).toBe(1);
    expect(store.index().getPage("concepts/a")).toBeNull();
    expect(listQuarantineRecords(store)).toEqual([]);
  } finally { s.release(); await run.catch(() => {}); }
});
