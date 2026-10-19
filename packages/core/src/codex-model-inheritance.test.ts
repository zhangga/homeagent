import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config, resetConfig, type SpaceId } from "@homeagent/shared";
import type { RunInput } from "@homeagent/llm";
import { KnowledgeEngine } from "./engine.ts";
import { isResolvedExecutionPlan } from "./execution-plan.ts";
import { SkillCatalog } from "./skill-catalog.ts";

const SPACE: SpaceId = "team/oc_codex_model_defaults";
const ENV_KEYS = ["CODEX_HOME", "HOMEAGENT_DATA_DIR", "HOMEAGENT_DEFAULT_PROVIDER", "HOMEAGENT_DEFAULT_MODEL"] as const;
let previous: Partial<Record<typeof ENV_KEYS[number], string>>;
let root: string;
let dataDir: string;
let configPath: string;
let engine: KnowledgeEngine;
let calls: RunInput[];
let failProvider: boolean;

function openEngine(): KnowledgeEngine {
  return new KnowledgeEngine({
    dataDir,
    skillCatalog: new SkillCatalog({ roots: [] }),
    runProvider: async (_provider, input) => {
      calls.push(input);
      if (failProvider) throw new Error("temporary test failure");
      return "已按冻结的模型配置完成";
    },
  });
}

function saveLocal(model: string, effort: string): void {
  writeFileSync(configPath, `model = "${model}"\nmodel_reasoning_effort = "${effort}"`);
}

beforeEach(() => {
  previous = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  root = realpathSync(mkdtempSync(join(tmpdir(), "ha-codex-model-inheritance-")));
  dataDir = join(root, "data");
  const consoleHome = join(root, "console");
  mkdirSync(consoleHome);
  configPath = join(consoleHome, "config.toml");
  process.env.CODEX_HOME = consoleHome;
  process.env.HOMEAGENT_DATA_DIR = dataDir;
  process.env.HOMEAGENT_DEFAULT_PROVIDER = "codex";
  process.env.HOMEAGENT_DEFAULT_MODEL = "";
  resetConfig();
  saveLocal("gpt-6.1-sol", "xhigh");
  calls = [];
  failProvider = false;
  engine = openEngine();
  engine.ensureSpace(SPACE);
  const agent = engine.agents.create({ name: "继承本机配置", provider: "codex", permission: "read-only" });
  engine.registry.updateMeta(SPACE, { agentId: agent.id });
});

afterEach(() => {
  engine.close();
  rmSync(root, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    const value = previous[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetConfig();
});

test("new Chat snapshots inherit local defaults and preserve them after reopen", async () => {
  const frozen = engine.agentRunExecutionSnapshot(SPACE);
  expect(frozen).toEqual(expect.objectContaining({ model: "gpt-6.1-sol", reasoningEffort: "xhigh" }));
  const run = engine.chatRuns.start({ space: SPACE, input: "检查配置", trigger: "message",
    agentId: frozen.agent?.id, provider: frozen.provider, model: frozen.model,
    reasoningEffort: frozen.reasoningEffort, executionPlan: frozen.executionPlan,
    skillEvidence: frozen.skillEvidence });
  saveLocal("gpt-future-model", "ultra");
  engine.close();
  engine = openEngine();
  const stored = engine.chatRuns.get(run.id)!;
  expect(stored.executionPlan).toEqual(frozen.executionPlan);
  if (!isResolvedExecutionPlan(stored.executionPlan)) throw new Error("missing frozen execution plan");
  await engine.askWithExecutionPlan([SPACE], "检查配置", stored.executionPlan, stored.skillEvidence);
  expect(calls.length).toBeGreaterThan(0);
  expect(calls.every(input => input.model === "gpt-6.1-sol" && input.reasoningEffort === "xhigh")).toBe(true);
  expect(engine.agentRunExecutionSnapshot(SPACE)).toEqual(expect.objectContaining({
    model: "gpt-future-model", reasoningEffort: "ultra",
  }));
});

test("Task retries retain inherited model preferences after local config changes and restart", async () => {
  const task = engine.tasks.create({ name: "验证继承", space: SPACE, topic: "检查配置", distillOnRun: false })!;
  failProvider = true;
  const started = engine.startTaskRun(task.id, { distill: false });
  expect(started.run.executionPlan).toEqual(expect.objectContaining({ model: "gpt-6.1-sol", reasoningEffort: "xhigh" }));
  expect((await started.completion).ok).toBe(false);
  saveLocal("gpt-future-model", "ultra");
  engine.close();
  engine = openEngine();
  failProvider = false;
  calls = [];
  const retry = engine.retryTaskRun(started.run.id);
  expect((await retry.completion).ok).toBe(true);
  expect(calls.length).toBeGreaterThan(0);
  expect(calls.every(input => input.model === "gpt-6.1-sol" && input.reasoningEffort === "xhigh")).toBe(true);
  calls = [];
  expect((await engine.runTask(task.id, { distill: false })).ok).toBe(true);
  expect(calls.length).toBeGreaterThan(0);
  expect(calls.every(input => input.model === "gpt-future-model" && input.reasoningEffort === "ultra")).toBe(true);
});

test("Agent and HomeAgent explicit settings keep priority and other Providers do not inherit Codex", () => {
  config().defaultModel = "gpt-6-astra";
  expect(engine.agentRunExecutionSnapshot(SPACE)).toEqual(expect.objectContaining({ model: "gpt-6-astra", reasoningEffort: "xhigh" }));
  const agent = engine.agentForSpace(SPACE)!;
  engine.agents.update(agent.id, { model: "gpt-5.6-sol", reasoningEffort: "high" });
  expect(engine.agentRunExecutionSnapshot(SPACE)).toEqual(expect.objectContaining({ model: "gpt-5.6-sol", reasoningEffort: "high" }));
  engine.agents.update(agent.id, { provider: "claude", model: "", reasoningEffort: "" });
  const other = engine.agentRunExecutionSnapshot(SPACE);
  expect(other.model).toBeUndefined();
  expect(other.reasoningEffort).toBeUndefined();
});

test("background no-tools clients inherit both preferences without enabling Agent tools", async () => {
  await engine.agentCallContext(SPACE, { taskExecution: false }).client.complete({ prompt: "提炼资料" });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toEqual(expect.objectContaining({ model: "gpt-6.1-sol", reasoningEffort: "xhigh" }));
  expect(calls[0]?.execution).toBeUndefined();
});
