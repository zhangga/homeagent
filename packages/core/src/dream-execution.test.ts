import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetConfig, saveSettings, AI_GENERATION_MAX_TOKENS } from "@homeagent/shared";
import { ProviderRunError, type CompletionUsage } from "@homeagent/llm";
import { DreamExecution, dreamMetricsLog } from "./dream-execution.ts";
import { makeCliClient } from "./cli-client.ts";
import { observeLlmUsage } from "./usage.ts";
import { runDreamCycle, retryQuarantinedDreamOperation, regeneratePageFromSources } from "./dream.ts";
import { listQuarantineRecords } from "./quarantine.ts";
import { SpaceStore } from "./space.ts";
import type { DreamProgress } from "./dream-progress.ts";
import { KnowledgeEngine } from "./engine.ts";
import { SkillCatalog } from "./skill-catalog.ts";

const SPACE = "team/oc_dream_stages";
const models = { planning: "planning-model", extraction: "extraction-model", merge: "merge-model" };
const usage: CompletionUsage = { inputTokens: 100, outputTokens: 20, cachedInputTokens: 30, reasoningTokens: 5, costBasis: "unavailable", source: "codex-jsonl" };
let dir: string;
let store: SpaceStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ha-dream-stages-"));
  process.env.HOMEAGENT_DATA_DIR = dir; resetConfig();
  store = new SpaceStore(SPACE, dir); store.ensure();
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); delete process.env.HOMEAGENT_DATA_DIR; resetConfig(); });
function note(content = "Complete evidence") { return { title: "Topic", summary: "Evidence", content, links: [] }; }
function seed(parts = 2) { return store.index().insertRaw({ space: SPACE, source: "message", content: "Source fact ".padEnd(48_000, "文").repeat(parts) }); }
function stage(prompt: string) { return prompt.includes("## 待提炼的原始条目") ? "planning" : prompt.includes("## 来源分段提取") ? "extraction" : "merge"; }
function gate() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }

test("configured phase models reach the actual CLI and reported usage is attributed once to each stage", async () => {
  const id = seed();
  saveSettings({ dreamPlanningModel: models.planning, dreamExtractionModel: models.extraction, dreamMergeModel: models.merge }, dir);
  const actual: Array<[string, string | undefined]> = [];
  const outerUsage: unknown[] = [];
  const signal = new AbortController().signal;
  const base = makeCliClient("codex", "space-model", dir, async (_provider, input, _timeout, received) => {
    expect(received).toBe(signal);
    expect(input.execution).toBeUndefined();
    expect(input.skills).toEqual([]);
    const phase = stage(input.prompt);
    actual.push([phase, input.model]);
    if (phase !== "planning") expect(input.maxTokens).toBe(AI_GENERATION_MAX_TOKENS);
    // Changes during a run must affect only the next run.
    saveSettings({ dreamPlanningModel: "new-plan", dreamExtractionModel: "new-extract", dreamMergeModel: "new-merge" }, dir);
    return { text: JSON.stringify(phase === "planning" ? { operations: [{ type: "concept", name: "topic", title: "Topic", rawIds: [id] }], skippedRawIds: [] } : note()), usage };
  }, undefined, "high", signal);
  const report = await runDreamCycle(store, {}, { client: observeLlmUsage(base, item => outerUsage.push(item)) });
  expect(report.errors).toEqual([]);
  expect(actual).toEqual([["planning", models.planning], ["planning", models.planning], ["extraction", models.extraction], ["extraction", models.extraction], ["merge", models.merge]]);
  expect(outerUsage).toHaveLength(5);
  expect(report.metrics!.phases.planning).toMatchObject({ model: models.planning, calls: 2, inputTokens: 200, outputTokens: 40, knownTokenCalls: 2, unknownTokenCalls: 0 });
  expect(report.metrics!.phases.extraction).toMatchObject({ calls: 2, inputTokens: 200, cachedInputTokens: 60, outputTokens: 40, reasoningTokens: 10 });
  expect(report.metrics!.phases.merge).toMatchObject({ calls: 1, inputTokens: 100, outputTokens: 20 });
  const log = store.index().getPage("log")!.content;
  expect(log).toContain('"input_tokens":200');
  expect(log).toContain(models.extraction);
  expect(log).not.toContain("Source fact");
});

test("empty overrides inherit the actual Space model and preserve ordinary CLI model freezing", async () => {
  const id = seed(1);
  const selected: Array<string | undefined> = [];
  const client = makeCliClient("codex", "space-model", dir, async (_provider, input) => {
    selected.push(input.model);
    return JSON.stringify(stage(input.prompt) === "planning" ? { operations: [{ type: "concept", name: "topic", title: "Topic", rawIds: [id] }], skippedRawIds: [] } : note());
  });
  saveSettings({ dreamPlanningModel: "global-model" }, dir);
  const inherited = new DreamExecution(client, { models: { planning: undefined } });
  await inherited.phase("planning").client.complete({ prompt: "inherit configured model" });
  expect(selected.pop()).toBe("global-model");
  const report = await runDreamCycle(store, { models: { planning: "" } }, { client });
  expect(selected).toEqual(["space-model", "space-model"]);
  expect(report.metrics!.phases.extraction.calls).toBe(0);
  expect(report.metrics!.phases.merge).toMatchObject({ model: "space-model", calls: 1, unknownTokenCalls: 1 });
  expect(report.metrics!.phases.merge.inputTokens).toBeUndefined();
  await client.complete({ prompt: "ordinary", model: "ignored-call-model" });
  expect(selected.at(-1)).toBe("space-model");
});

test("concurrent extraction measures the union of model wait intervals and accounts for failure usage", async () => {
  let clock = 0;
  const a = gate(); const b = gate(); let calls = 0;
  const client = makeCliClient("codex", "base-model", dir, async () => {
    const call = ++calls;
    await (call === 1 ? a.promise : b.promise);
    if (call === 2) throw new ProviderRunError("codex", "private provider diagnostic", { ...usage, inputTokens: 25 });
    return { text: JSON.stringify(note()), usage };
  });
  const execution = new DreamExecution(client, { models }, undefined, () => clock);
  const extractor = execution.phase("extraction").client;
  const first = extractor.completeJSON({ prompt: "private Raw A", schema: {} });
  clock = 10;
  const second = extractor.completeJSON({ prompt: "private Raw B", schema: {} });
  const settled = Promise.allSettled([first, second]);
  clock = 30; a.resolve(); await first;
  expect(execution.snapshot().phases.extraction).toMatchObject({ elapsedMs: 30, calls: 1, activeCalls: 1 });
  clock = 50; b.resolve(); await settled;
  const snapshot = execution.snapshot();
  expect(snapshot.phases.extraction).toMatchObject({ elapsedMs: 50, calls: 2, activeCalls: 0, failedCalls: 1, inputTokens: 125, outputTokens: 40 });
  expect(JSON.stringify(snapshot)).not.toContain("private");
  snapshot.phases.extraction.calls = 99;
  expect(execution.snapshot().phases.extraction.calls).toBe(2);
});

test("known zero and unknown usage remain distinguishable", async () => {
  let count = 0;
  const client = makeCliClient("codex", undefined, dir, async () => ++count === 1
    ? { text: "{}", usage: { inputTokens: 0, outputTokens: 0, costBasis: "unavailable", source: "codex-jsonl" } }
    : "{}");
  const execution = new DreamExecution(client);
  await execution.phase("planning").client.completeJSON({ prompt: "a", schema: {} });
  await execution.phase("planning").client.completeJSON({ prompt: "b", schema: {} });
  expect(execution.snapshot().phases.planning).toMatchObject({ calls: 2, inputTokens: 0, outputTokens: 0, knownTokenCalls: 1, unknownTokenCalls: 1 });
  expect(execution.snapshot().phases.planning.model).toBeUndefined();
  expect(dreamMetricsLog(execution.snapshot())).toContain('"unknown_token_calls":1');
});

test("changing only planning or merge models keeps extraction checkpoints reusable while changing extraction invalidates them", async () => {
  const id = seed();
  let fail = true;
  const called: string[] = [];
  const client = makeCliClient("codex", "base", dir, async (_provider, input) => {
    const phase = stage(input.prompt); called.push(phase);
    if (phase === "merge" && fail) throw new Error("merge failed");
    return { text: JSON.stringify(phase === "planning" ? { operations: [{ type: "concept", name: "topic", title: "Topic", rawIds: [id] }], skippedRawIds: [] } : note()), usage };
  });
  await runDreamCycle(store, { models }, { client });
  const record = listQuarantineRecords(store)[0]!;
  called.length = 0;
  const retry = await retryQuarantinedDreamOperation(store, record, { models: { ...models, planning: "new-plan", merge: "new-merge" } }, { client });
  expect(called).toEqual(["merge"]);
  expect(retry.metrics!.phases.extraction).toMatchObject({ calls: 0, elapsedMs: 0, reusedExtractions: 2, unknownTokenCalls: 0 });
  expect(retry.metrics!.phases.extraction.inputTokens).toBeUndefined();
  expect(retry.metrics!.phases.merge.failedCalls).toBe(1);
  fail = false; called.length = 0;
  const fresh = await retryQuarantinedDreamOperation(store, record, { models: { ...models, extraction: "new-extractor" } }, { client });
  expect(fresh.errors).toEqual([]);
  expect(called).toEqual(["extraction", "extraction", "merge"]);
});

test("shared extraction is counted once, even when multiple pages reuse it", async () => {
  const id = seed(1);
  const client = makeCliClient("codex", "base", dir, async (_provider, input) => {
    const phase = stage(input.prompt);
    const value = phase === "planning" ? { operations: ["a", "b"].map(name => ({ type: "concept", name, title: name, rawIds: [id] })), skippedRawIds: [] }
      : phase === "extraction" ? { pages: ["a", "b"].map(name => ({ slug: `concepts/${name}`, ...note(name) })) } : note();
    return { text: JSON.stringify(value), usage };
  });
  const report = await runDreamCycle(store, { models }, { client });
  expect(report.errors).toEqual([]);
  expect(report.metrics!.phases.extraction).toMatchObject({ calls: 1, inputTokens: 100, reusedExtractions: 1 });
  expect(report.metrics!.phases.merge.calls).toBe(2);
});

test("explicit model switching adapts unsupported Codex reasoning without changing the base client", async () => {
  const actual: Array<[string | undefined, string | undefined]> = [];
  const base = makeCliClient("codex", "gpt-6-astra", dir, async (_provider, input) => {
    actual.push([input.model, input.reasoningEffort]); return "{}";
  }, undefined, "ultra");
  const execution = new DreamExecution(base, { models: { planning: "gpt-6-luna" } });
  await execution.phase("planning").client.complete({ prompt: "plan" });
  await execution.phase("merge").client.complete({ prompt: "merge" });
  await base.complete({ prompt: "ordinary" });
  expect(actual).toEqual([["gpt-6-luna", "max"], ["gpt-6-astra", "ultra"], ["gpt-6-astra", "ultra"]]);
});

test("failed analysis and cancellation retain metrics without counting unstarted calls", async () => {
  seed();
  const failed = makeCliClient("codex", "base", dir, async () => { throw new ProviderRunError("codex", "failure", usage); });
  const report = await runDreamCycle(store, { models }, { client: failed });
  expect(report.metrics!.phases.planning).toMatchObject({ calls: 1, failedCalls: 1, inputTokens: 100 });
  expect(report.metrics!.phases.extraction.calls).toBe(0);
  const progress: DreamProgress[] = [];
  const controller = new AbortController();
  const client = makeCliClient("codex", "base", dir, async () => "{}");
  await expect(runDreamCycle(store, { models, signal: controller.signal }, { client, onProgress: item => {
    progress.push(item);
    if (item.metrics?.phases.planning.activeCalls) controller.abort(new Error("stop before invocation"));
  } })).rejects.toThrow("stop before invocation");
  expect(progress.at(-1)!.metrics!.phases.planning).toMatchObject({ calls: 0, activeCalls: 0, failedCalls: 0 });
});

test("manual full regeneration uses extraction and merge model selections", async () => {
  const id = seed();
  store.writePage({ slug: "concepts/topic", type: "concept", title: "Topic", summary: "Old", content: "Old", sources: [id], aliases: [], tags: [], links: [], updatedAt: 1, contentHash: "old" });
  const actual: Array<string | undefined> = [];
  const progress: DreamProgress[] = [];
  const client = makeCliClient("codex", "base", dir, async (_provider, input) => { actual.push(input.model); return { text: JSON.stringify(note()), usage }; });
  await regeneratePageFromSources(store, "concepts/topic", [], { models }, { client, onProgress: item => progress.push(item) });
  expect(actual).toEqual([models.extraction, models.extraction, models.merge]);
  expect(progress.at(-1)!.metrics!.phases.merge.calls).toBe(1);
});

test("post-Task Dream retains the Task's frozen model rather than applying mutable global stage settings", async () => {
  saveSettings({ dreamPlanningModel: "other-plan", dreamExtractionModel: "other-extraction", dreamMergeModel: "other-merge" }, dir);
  const calls: Array<{ model?: string; tools: boolean }> = [];
  const engine = new KnowledgeEngine({ dataDir: dir, skillCatalog: new SkillCatalog({ roots: [] }), runProvider: async (_provider, input) => {
    calls.push({ model: input.model, tools: !!input.execution });
    if (input.prompt.includes("## 待提炼的原始条目")) {
      const id = /<entry id="([^"]+)"/u.exec(input.prompt)![1];
      return JSON.stringify({ operations: [{ type: "concept", name: "task-topic", title: "Task topic", rawIds: [id] }], skippedRawIds: [] });
    }
    if (input.prompt.includes("## 来源分段提取") || input.prompt.includes("## 分段提炼结果")) return JSON.stringify(note());
    return "Research fact ".padEnd(60_000, "文");
  } });
  try {
    engine.ensureSpace(SPACE);
    const agent = engine.agents.create({ name: "Frozen task model", provider: "codex", model: "gpt-6.1-sol", permission: "read-only" });
    engine.updateSpaceMeta(SPACE, { agentId: agent.id });
    const task = engine.tasks.create({ name: "Research", space: SPACE, topic: "Offline research", enabled: false, notify: false, distillOnRun: true })!;
    const report = await engine.runTask(task.id);
    expect(report.status).toBe("succeeded");
    expect(report.pagesWritten).toBe(1);
    expect(calls).toHaveLength(6);
    expect(calls.every(call => call.model === "gpt-6.1-sol")).toBe(true);
    expect(calls.slice(1).every(call => !call.tools)).toBe(true);
    expect(engine.listDreamRuns(SPACE)[0]!.metrics!.phases.extraction.calls).toBe(2);
  } finally { engine.close(); }
});
