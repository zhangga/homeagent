import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetConfig, type DreamReport } from "@homeagent/shared";
import { KnowledgeEngine } from "./engine.ts";
import { SkillCatalog } from "./skill-catalog.ts";
import { FakeLlm } from "./testing.ts";
import { DreamRunTracker } from "./dream-progress.ts";
import type { LlmClient } from "./llm.ts";

const SPACE = "team/oc_dream_progress";
let dir: string;
let engine: KnowledgeEngine;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hb-dream-progress-"));
  process.env.HOMEAGENT_DATA_DIR = dir;
  resetConfig();
});
afterEach(() => {
  engine?.close();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.HOMEAGENT_DATA_DIR;
  resetConfig();
});

function createEngine(llm: LlmClient) {
  engine = new KnowledgeEngine({ dataDir: dir, llm, skillCatalog: new SkillCatalog({ roots: [] }) });
  engine.ensureSpace(SPACE);
  return engine;
}

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("reports queued work, blocked model calls, every fragment and terminal counts without source bodies", async () => {
  const fake = new FakeLlm();
  const analysisEntered = gate();
  const analysisRelease = gate();
  const generationEntered = gate();
  const generationRelease = gate();
  let calls = 0;
  const fragments: number[] = [];
  const client: LlmClient = {
    complete: (opts) => fake.complete(opts),
    async completeJSON(opts) {
      calls += 1;
      if (calls === 1) { analysisEntered.resolve(); await analysisRelease.promise; }
      if (calls === 2) { generationEntered.resolve(); await generationRelease.promise; }
      const chunk = engine.listDreamRuns().find((run) => run.status === "running")?.chunk;
      if (chunk) fragments.push(chunk.index);
      return fake.completeJSON(opts);
    },
  };
  createEngine(client);
  const rawId = await engine.rememberFile({
    space: SPACE, source: "manual", content: `PRIVATE_BODY_${"甲".repeat(100_000)}`,
  }, { attachment: { kind: "file", ref: "test", name: "长资料.jsonl" }, bytes: new TextEncoder().encode("original") });
  fake.queueJSON({ operations: [{ type: "concept", name: "release", title: "发布约定", rawIds: [rawId] }], skippedRawIds: [] });
  for (let i = 0; i < 3; i += 1) fake.queueJSON({ title: "发布约定", summary: "summary", content: "正文", links: [] });
  const first = engine.runDreamCycle(SPACE, { trigger: "import", batch: { index: 1, total: 2 } });
  await analysisEntered.promise;
  const second = engine.runDreamCycle(SPACE);
  try {
    const analyzing = engine.listDreamRuns().find((run) => run.status === "running")!;
    expect(analyzing).toMatchObject({ stage: "analyzing", rawCount: 1, trigger: "import", batch: { index: 1, total: 2 } });
    expect(analyzing.sources).toEqual([{ id: rawId, name: "长资料.jsonl" }]);
    expect(engine.listDreamRuns().filter((run) => run.status === "queued")).toHaveLength(1);
    expect(JSON.stringify(engine.listDreamRuns())).not.toContain("PRIVATE_BODY");
    expect(JSON.stringify((await engine.health()).details)).not.toContain("长资料.jsonl");
    analyzing.sources![0]!.name = "mutated";
    expect(engine.listDreamRuns().find((run) => run.status === "running")?.sources?.[0]?.name).toBe("长资料.jsonl");
    analysisRelease.resolve();
    await generationEntered.promise;
    expect(engine.listDreamRuns().find((run) => run.status === "running")).toMatchObject({
      stage: "generating", page: { title: "发布约定", index: 1 }, chunk: { index: 1, total: 3 }, pagesTotal: 1,
    });
  } finally {
    analysisRelease.resolve();
    generationRelease.resolve();
    await Promise.all([first, second]);
  }
  expect(engine.listDreamRuns().every((run) => run.status === "completed")).toBeTrue();
  expect(fragments).toEqual([1, 2, 3]);
  expect(engine.listDreamRuns().find((run) => run.trigger === "import")).toMatchObject({
    pagesWritten: 1, pagesCompleted: 1, pagesTotal: 1, processedRaw: 1, errorCount: 0,
  });
  expect(engine.listDreamRuns("team/oc_other")).toEqual([]);
  engine.close();
  createEngine(fake);
  expect(engine.listDreamRuns()).toEqual([]);
});

test("failed analysis, cancellation and quarantine retry leave accurate terminal states", async () => {
  const fake = new FakeLlm();
  createEngine(fake);
  const rawId = await engine.remember({ space: SPACE, source: "message", content: "故障复盘" });
  await engine.runDreamCycle(SPACE);
  expect(engine.listDreamRuns()[0]).toMatchObject({ status: "failed", errorCount: 1, stage: "analyzing" });
  expect(JSON.stringify(engine.listDreamRuns())).not.toContain("FakeLlm");
  const cancelled = new AbortController();
  cancelled.abort(new Error("PRIVATE_DIAGNOSTIC"));
  await expect(engine.runDreamCycle(SPACE, { signal: cancelled.signal })).rejects.toThrow();
  expect(engine.listDreamRuns()[0]?.status).toBe("cancelled");
  expect(JSON.stringify(engine.listDreamRuns())).not.toContain("PRIVATE_DIAGNOSTIC");
  fake.queueJSON({ operations: [{ type: "concept", name: "retry", title: "重试页面", rawIds: [rawId] }], skippedRawIds: [] });
  fake.queueJSON({ title: "重试页面", content: "" });
  await engine.runDreamCycle(SPACE);
  const quarantine = (await engine.listQuarantines(SPACE))[0]!;
  fake.queueJSON({ title: "重试页面", summary: "恢复", content: "已恢复" });
  await engine.retryQuarantine(SPACE, quarantine.id);
  expect(engine.listDreamRuns()[0]).toMatchObject({ trigger: "retry", status: "completed", pagesWritten: 1, pagesTotal: 1 });
});

test("tracker keeps active runs plus 50 terminal runs and measures progress without fake heartbeats", () => {
  let at = 100;
  const tracker = new DreamRunTracker(() => at);
  const active = tracker.enqueue(SPACE, "manual");
  tracker.start(active);
  tracker.update(active, { stage: "analyzing" });
  at = 10_000;
  expect(tracker.list()[0]?.updatedAt).toBe(100);
  const report: DreamReport = { space: SPACE, examined: 0, processedRawIds: [], distilled: 0,
    skipped: 0, pagesWritten: 0, pagesQuarantined: 0, errors: [], startedAt: 0, finishedAt: 1 };
  for (let i = 0; i < 55; i += 1) {
    at += 1;
    const id = tracker.enqueue(SPACE, "manual");
    tracker.start(id);
    tracker.finish(id, report);
  }
  expect(tracker.list()).toHaveLength(51);
  expect(tracker.list()[0]?.id).toBe(active);
  tracker.removeSpace(SPACE);
  expect(tracker.list()).toEqual([]);
});
