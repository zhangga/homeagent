import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeEngine } from "./engine.ts";
import { SkillCatalog } from "./skill-catalog.ts";
import type { EngineOptions } from "./engine.ts";
import { ProviderPreparationError } from "@homeagent/llm";

const fixtures: { engine: KnowledgeEngine; root: string }[] = [];
afterEach(() => { for (const { engine, root } of fixtures.splice(0)) { engine.close(); rmSync(root, { recursive: true, force: true }); } });
async function fixture(preflight: EngineOptions["nativeSessionPreflight"] = async () => {}, readiness?: EngineOptions["readiness"], catalog?: (root: string) => SkillCatalog) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ha-readiness-")));
  const workdir = join(root, "work"); mkdirSync(workdir);
  const engine = new KnowledgeEngine({ dataDir: join(root, "data"), skillCatalog: catalog?.(root) ?? new SkillCatalog({ roots: [] }),
    runProvider: async () => { throw new Error("No model calls in readiness tests"); }, nativeSessionPreflight: preflight, readiness });
  fixtures.push({ engine, root });
  const space = "team/oc_ready" as const;
  await engine.ensureSpace(space);
  const agent = engine.agents.create({ name: "Ready fixture", provider: "codex", permission: "read-only", executionMode: "isolated", workdir });
  engine.registry.updateMeta(space, { agentId: agent.id });
  engine.feishuBindings.connect({ spaceId: space, chatId: "oc_ready", boundAppId: "cli_fixture", responseMode: "mentions_only", replyInThread: true });
  return { engine, root, workdir, space, agentId: agent.id };
}

test("only an explicit no-model check prepares the published Agent; a draft does not replace that context", async () => {
  let probes = 0;
  const { engine, agentId } = await fixture(async (_id, _timeout, _signal, _cwd, execution) => {
    probes++; expect(execution?.executionMode).toBe("isolated");
  });
  expect(engine.agentReadiness.status(agentId)?.state).toBe("unknown");
  expect(probes).toBe(0);
  const ready = await engine.agentReadiness.check(agentId);
  expect(ready).toMatchObject({ state: "ready", mode: "isolated", sandboxCheck: "passed", modelCall: "not-verified" });
  engine.saveAgentDraft(agentId, { instruction: "unpublished" });
  expect(engine.agentReadiness.status(agentId)).toEqual(ready);
  expect(probes).toBe(1);
});

test("full readiness requires current consent and never treats a revoked grant as prepared", async () => {
  let probes = 0;
  const { engine, agentId, workdir } = await fixture(async () => { probes++; });
  engine.agents.update(agentId, { executionMode: "local-full-access", permission: "full", workdir });
  expect(await engine.agentReadiness.check(agentId)).toMatchObject({ state: "unavailable", sandboxCheck: "not-applicable",
    failure: { reason: "local-execution-consent-required" } });
  expect(probes).toBe(0);
  const draft = engine.saveAgentDraft(agentId, {})!;
  engine.releaseAgent(agentId, draft.id, draft.id, { termsVersion: 1, source: "local-operator", taskExecutionEnabled: false,
    expectedScopeFingerprint: engine.localExecution.preview(agentId, draft.id).fingerprint });
  expect(await engine.agentReadiness.check(agentId)).toMatchObject({ state: "ready", mode: "local-full-access", sandboxCheck: "not-applicable" });
  engine.agents.revokeLocalExecutionGrants(agentId, engine.agents.get(agentId)!.publishedRevisionId!);
  expect(engine.agentReadiness.status(agentId)?.state).not.toBe("ready");
  expect(await engine.agentReadiness.check(agentId)).toMatchObject({ state: "unavailable", failure: { reason: "local-execution-consent-revoked" } });
  expect(probes).toBe(1);
});

test("a refreshed Skill catalog and a replaced Workdir invalidate cached readiness without probing", async () => {
  let probes = 0;
  const { engine, agentId, workdir } = await fixture(async () => { probes++; });
  await engine.agentReadiness.check(agentId);
  engine.skillCatalog.refresh();
  expect(engine.agentReadiness.status(agentId)).toMatchObject({ state: "unknown", reason: "configuration-changed" });
  await engine.agentReadiness.check(agentId);
  renameSync(workdir, `${workdir}-old`); mkdirSync(workdir);
  expect(engine.agentReadiness.status(agentId)?.state).toBe("unknown");
  expect(probes).toBe(2);
});

test("readiness expires and a changed CLI identity cannot inherit a previously successful check", async () => {
  let time = 1000; let identity = "cli-one";
  const { engine, agentId } = await fixture(undefined, { now: () => time, providerIdentity: () => identity });
  await engine.agentReadiness.check(agentId);
  identity = "cli-two";
  expect(engine.agentReadiness.status(agentId)).toMatchObject({ state: "unknown", reason: "configuration-changed" });
  await engine.agentReadiness.check(agentId);
  time += 60_000;
  expect(engine.agentReadiness.status(agentId)).toMatchObject({ state: "unknown", reason: "expired" });
});

test("concurrent checks coalesce, expose checking, and publication cancels the old probe instead of installing its late result", async () => {
  let finish!: () => void; let signal: AbortSignal | undefined; let probes = 0;
  const { engine, agentId } = await fixture(async (_id, _timeout, incoming) => {
    probes++; signal = incoming; await new Promise<void>(resolve => { finish = resolve; });
  });
  const first = engine.agentReadiness.check(agentId);
  const second = engine.agentReadiness.check(agentId);
  expect(engine.agentReadiness.status(agentId)?.state).toBe("checking");
  const draft = engine.saveAgentDraft(agentId, { instruction: "new release" })!;
  engine.releaseAgent(agentId, draft.id, draft.id);
  expect(signal?.aborted).toBe(true);
  finish();
  expect(await first).toMatchObject({ state: "unknown", reason: "configuration-changed" });
  expect(await second).toEqual(await first);
  expect(engine.agentReadiness.status(agentId)?.state).not.toBe("ready");
  expect(probes).toBe(1);
});

test("an isolation proof failure is fixed evidence, while unknown provider diagnostics never escape", async () => {
  let recognized = true;
  const { engine, agentId } = await fixture(async () => {
    if (recognized) throw new ProviderPreparationError({ stage: "native-session", reason: "protected-root-readable", exitCode: 75 });
    throw new Error("private stdout: token=must-not-leak");
  });
  expect(await engine.agentReadiness.check(agentId)).toMatchObject({ state: "unavailable", sandboxCheck: "failed", failure: { reason: "protected-root-readable" } });
  recognized = false;
  const failed = await engine.agentReadiness.check(agentId);
  expect(failed).toMatchObject({ state: "unavailable", sandboxCheck: "not-checked", reason: "check-failed" });
  expect(JSON.stringify(failed)).not.toContain("must-not-leak");
});

test("checking another Agent with unchanged Skills does not invalidate the first Agent's unexpired proof", async () => {
  const { engine, agentId, workdir } = await fixture();
  const second = engine.agents.create({ name: "Second Agent", provider: "codex", executionMode: "isolated", workdir });
  const first = await engine.agentReadiness.check(agentId);
  await engine.agentReadiness.check(second.id);
  expect(engine.agentReadiness.status(agentId)).toEqual(first);
  expect(engine.agentReadiness.status(second.id)?.state).toBe("ready");
});

test("Skill resources changing during a probe cannot install a successful readiness result", async () => {
  let resource = "";
  const { engine, agentId } = await fixture(async () => { writeFileSync(resource, "changed resource"); }, undefined, root => {
    const path = join(root, "skills", "fixture"); mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "SKILL.md"), "---\nname: fixture\ndescription: Offline fixture.\n---\nRead the resource.");
    resource = join(path, "resource.txt"); writeFileSync(resource, "original resource");
    return new SkillCatalog({ roots: [{ path: join(root, "skills"), kind: "shared-agents", providerIds: ["codex"] }] });
  });
  expect(await engine.agentReadiness.check(agentId)).toMatchObject({ state: "unavailable" });
  expect(engine.agentReadiness.status(agentId)?.state).not.toBe("ready");
});

test("at most two distinct Agents probe concurrently and Engine close cancels both without granting readiness", async () => {
  const finishes: (() => void)[] = []; const signals: (AbortSignal | undefined)[] = [];
  const { engine, agentId, workdir } = await fixture(async (_id, _timeout, signal) => {
    signals.push(signal); await new Promise<void>(resolve => finishes.push(resolve));
  });
  const second = engine.agents.create({ name: "Two", provider: "codex", executionMode: "isolated", workdir });
  const third = engine.agents.create({ name: "Three", provider: "codex", executionMode: "isolated", workdir });
  const pending = [engine.agentReadiness.check(agentId), engine.agentReadiness.check(second.id)];
  expect(await engine.agentReadiness.check(third.id)).toMatchObject({ state: "unknown", reason: "busy" });
  expect(signals).toHaveLength(2);
  engine.close();
  expect(signals.every(signal => signal?.aborted)).toBe(true);
  finishes.forEach(finish => finish());
  expect((await Promise.all(pending)).every(result => result?.state === "unknown")).toBe(true);
});

test("the 257th cached Agent evicts the oldest diagnostic without changing configuration or extending other expiries", async () => {
  const { engine, agentId, workdir } = await fixture(undefined, { now: () => 1000, providerIdentity: () => "fixture" });
  await engine.agentReadiness.check(agentId);
  let last = agentId;
  for (let index = 0; index < 256; index++) {
    last = engine.agents.create({ name: `Capacity ${index}`, provider: "codex", executionMode: "isolated", workdir }).id;
    await engine.agentReadiness.check(last);
  }
  expect(engine.agentReadiness.status(agentId)).toMatchObject({ state: "unknown", reason: "not-checked" });
  expect(engine.agentReadiness.status(last)).toMatchObject({ state: "ready", expiresAt: 61_000 });
  expect(engine.agents.has(agentId)).toBe(true);
}, 45_000);
