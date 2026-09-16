import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeEngine, type EngineOptions } from "./engine.ts";
import { SkillCatalog } from "./skill-catalog.ts";
import { LEGACY_CODEX_FULL_RECONFIRMATION, type ResolvedExecutionPlan } from "./execution-plan.ts";

let dir: string;
beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), "ha-engine-permits-"))); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const space = "team/oc_permits" as const;

async function fixture(options: Pick<EngineOptions, "runProvider" | "llm" | "nativeSessionPreflight" | "skillCatalog"> = {}) {
  const engine = new KnowledgeEngine({ dataDir: join(dir, "data"), skillCatalog: new SkillCatalog({ roots: [] }), ...options });
  try {
    await engine.ensureSpace(space);
    const agent = engine.agents.create({ provider: "codex" });
    engine.registry.updateMeta(space, { agentId: agent.id });
    engine.feishuBindings.connect({ spaceId: space, chatId: "oc_permits", boundAppId: "cli_fixture", responseMode: "mentions_only", replyInThread: true });
    const workdir = join(dir, "work"); mkdirSync(workdir, { recursive: true });
    const draft = engine.agents.saveDraft(agent.id, { executionMode: "local-full-access", permission: "full", workdir })!;
    engine.localExecution.release(agent.id, draft.id, draft.id, {
      termsVersion: 1, source: "local-operator", taskExecutionEnabled: true,
      expectedScopeFingerprint: engine.localExecution.preview(agent.id, draft.id).fingerprint,
    });
    const snapshot = engine.agentRunExecutionSnapshot(space, true, false, "all");
    return { engine, agentId: agent.id, snapshot, workdir };
  } catch (error) { engine.close(); throw error; }
}

test("a confirmed full native Chat starts with a Core permit, and revocation during preparation prevents launch", async () => {
  let engine: KnowledgeEngine;
  let agentId: string;
  let revokeDuringPreparation = false;
  let started = 0;
  const setup = await fixture({ runProvider: async (_provider, input) => {
    if (revokeDuringPreparation) engine.agents.revokeLocalExecutionGrants(agentId, engine.agents.get(agentId)!.publishedRevisionId!);
    expect(input.execution?.executionMode).toBe("local-full-access");
    expect(input.acquireExecutionPermit).toBeDefined();
    const permit = input.acquireExecutionPermit!();
    const unregister = permit.register(() => {});
    started++;
    permit.release();
    unregister();
    return { text: "offline answer", nativeSessionId: "11111111-2222-4333-8444-555555555555", usage: { source: "legacy-text", costBasis: "unavailable" } };
  } });
  ({ engine, agentId } = setup);
  try {
    const ask = () => engine.askWithExecutionPlan([space], "offline question", setup.snapshot.executionPlan,
      setup.snapshot.skillEvidence, { nativeSession: { mode: "start" } }, agentId);
    expect((await ask()).answer).toBe("offline answer");
    expect(started).toBe(1);
    revokeDuringPreparation = true;
    await expect(ask()).rejects.toThrow("local-execution-consent-revoked");
    expect(started).toBe(1);
  } finally { engine.close(); }
});

test("full Tasks require their own approval and never transfer full access to post-task Dream calls", async () => {
  const permissions: Array<string | undefined> = [];
  const { engine } = await fixture({ runProvider: async (_provider, input) => {
    permissions.push(input.execution?.permission);
    const permit = input.acquireExecutionPermit?.();
    const unregister = permit?.register(() => {});
    permit?.release(); unregister?.();
    return input.outputSchema ? JSON.stringify({ operations: [] }) : "offline research result";
  } });
  try {
    const task = engine.tasks.create({ space, topic: "offline research", distillOnRun: true })!;
    const pending = engine.startTaskRun(task.id);
    expect(pending.state).toBe("awaiting_approval");
    expect(permissions).toEqual([]);
    const approved = engine.approveTaskRun(pending.run.id, "offline-human");
    expect((await approved.completion).ok).toBe(true);
    expect(permissions[0]).toBe("full");
    expect(permissions.length).toBeGreaterThan(1);
    expect(permissions.slice(1).every(permission => permission === undefined)).toBe(true);
  } finally { engine.close(); }
});

test("ordinary Chat and injected clients cannot bypass a changed full-access scope", async () => {
  let calls = 0;
  const { engine } = await fixture({ llm: {
    complete: async () => { calls++; return { text: "offline answer", model: "fake" }; },
    completeJSON: async () => { calls++; throw new Error("unexpected routing"); },
  } });
  try {
    expect((await engine.ask([space], "offline question")).answer).toBe("offline answer");
    const captured = engine.agentCallContext(space, { taskExecution: true });
    engine.feishuBindings.disconnect(space);
    await expect(captured.client.complete({ prompt: "old client" })).rejects.toThrow("local-execution-consent-revoked");
    await expect(engine.ask([space], "new question")).rejects.toThrow();
    expect(calls).toBe(1);
  } finally { engine.close(); }
});

test.each(["revoke", "delete-agent", "unbind", "disconnect", "policy", "close"] as const)(
  "in-flight full processes are cancelled on %s and their late answer is discarded", async change => {
    const started = Promise.withResolvers<void>();
    const stopped = Promise.withResolvers<void>();
    let cancellations = 0;
    const { engine, agentId, snapshot } = await fixture({ runProvider: async (_provider, input) => {
      const permit = input.acquireExecutionPermit!();
      const unregister = permit.register(() => { cancellations++; stopped.resolve(); });
      permit.release();
      started.resolve();
      await stopped.promise;
      unregister();
      return "late answer must not be accepted";
    } });
    try {
      const asking = engine.askWithExecutionPlan([space], "offline question", snapshot.executionPlan, snapshot.skillEvidence, {}, agentId);
      const outcome = asking.then(() => "unexpected success", error => String(error));
      await started.promise;
      if (change === "revoke") engine.agents.revokeLocalExecutionGrants(agentId, engine.agents.get(agentId)!.publishedRevisionId!);
      if (change === "delete-agent") engine.agents.remove(agentId);
      if (change === "unbind") engine.registry.updateMeta(space, { agentId: "" });
      if (change === "disconnect") engine.feishuBindings.disconnect(space);
      if (change === "policy") engine.feishuBindings.updatePolicy(space, { responseMode: "all_messages" });
      if (change === "close") engine.close();
      expect(cancellations).toBe(1);
      expect(await outcome).toContain("local-execution-consent-revoked");
    } finally { stopped.resolve(); engine.close(); }
  },
);

test("restart stops legacy full queued and awaiting-approval Runs without changing their frozen plans", async () => {
  const { engine, agentId, workdir } = await fixture({ runProvider: async () => { throw new Error("must not execute"); } });
  const plan: ResolvedExecutionPlan = { version: 1, instruction: "legacy instruction", provider: "codex", workdir,
    execution: { permission: "full", workdir, skills: [] } };
  const ids: string[] = [];
  for (const status of ["queued", "awaiting_approval"] as const) {
    const task = engine.tasks.create({ space, topic: `legacy ${status}` })!;
    const run = engine.taskRuns.start({ task, trigger: "manual", agentId, executionPlan: plan, approvalRequired: true, distill: false });
    if (status === "queued") engine.taskRuns.approve(run.id, { decidedAt: run.startedAt, decidedBy: "old-human" });
    ids.push(run.id);
  }
  const chat = engine.chatRuns.start({ space, agentId, input: "legacy", trigger: "message", executionPlan: plan });
  engine.close();
  const reopened = new KnowledgeEngine({ dataDir: join(dir, "data"), skillCatalog: new SkillCatalog({ roots: [] }),
    runProvider: async () => { throw new Error("must not execute"); } });
  try {
    expect(reopened.resumeQueuedTaskRuns()).toEqual([]);
    for (const id of ids) {
      const run = reopened.taskRuns.get(id)!;
      expect(["failed", "cancelled"]).toContain(run.status);
      expect(run.error).toContain(LEGACY_CODEX_FULL_RECONFIRMATION);
      expect(run.executionPlan).toEqual(plan);
    }
    expect(reopened.chatRuns.get(chat.id)?.status).toBe("failed");
    expect(reopened.chatRuns.get(chat.id)?.error?.message).toContain(LEGACY_CODEX_FULL_RECONFIRMATION);
    expect(reopened.chatRuns.get(chat.id)?.executionPlan).toEqual(plan);
  } finally { reopened.close(); }
});

test("full Chat quality reruns are explicitly refused even while the original grant is valid", async () => {
  let calls = 0;
  const { engine, agentId, snapshot } = await fixture({ runProvider: async () => { calls++; return "unapproved replay"; } });
  try {
    const trace = engine.quality.recordTrace({ spaces: [space], question: "offline", outcome: "succeeded", source: "general",
      answer: "historical", citations: [], latencyMs: 1, createdAt: 1 });
    const run = engine.chatRuns.start({ space, agentId, input: "offline", trigger: "message", executionPlan: snapshot.executionPlan,
      skillEvidence: snapshot.skillEvidence, startedAt: 2 });
    engine.chatRuns.succeed(run.id, { finishedAt: 3, output: "historical", traceId: trace.id });
    await expect(engine.rerunChatRunForEvaluation(run.id)).rejects.toThrow("本机完全访问运行暂不支持质量重评");
    expect(calls).toBe(0);
    expect(engine.chatRuns.get(run.id)?.status).toBe("succeeded");
  } finally { engine.close(); }
});

test.each(["publish", "revoke"] as const)("routing followed by %s never substitutes the final call's frozen contract", async change => {
  let engine: KnowledgeEngine;
  let agentId: string;
  const instructions: Array<string | undefined> = [];
  const setup = await fixture({ runProvider: async (_provider, input) => {
    const permit = input.acquireExecutionPermit!();
    const unregister = permit.register(() => {}); permit.release();
    instructions.push(input.system);
    expect(input.nativeTopic).toBe(true);
    expect(input.execution?.executionMode).toBe("local-full-access");
    if (!input.nativeSession) {
      if (change === "revoke") engine.agents.revokeLocalExecutionGrants(agentId, engine.agents.get(agentId)!.publishedRevisionId!);
      else {
        const draft = engine.agents.saveDraft(agentId, { instruction: "NEW INSTRUCTION MUST NOT LEAK" })!;
        engine.localExecution.release(agentId, draft.id, draft.id, {
          termsVersion: 1, source: "local-operator", taskExecutionEnabled: true,
          expectedScopeFingerprint: engine.localExecution.preview(agentId, draft.id).fingerprint,
        });
      }
    }
    unregister();
    return { text: JSON.stringify(input.nativeSession
      ? { answer: "Alice 负责后端。", grounded: true, usedSlugs: ["entities/alice"], gaps: [] }
      : { slugs: ["entities/alice"], relevant: true }), usage: { source: "legacy-text", costBasis: "unavailable" },
      ...(input.nativeSession ? { nativeSessionId: "11111111-2222-4333-8444-555555555555" } : {}) };
  } });
  ({ engine, agentId } = setup);
  try {
    engine.registry.store(space).writePage({ slug: "entities/alice", type: "entity", title: "Alice", summary: "Alice 负责后端。",
      content: "Alice 负责后端。", aliases: [], tags: [], sources: [], links: [], contentHash: "h", updatedAt: 1 });
    const asking = engine.askWithExecutionPlan([space], "谁负责后端？", setup.snapshot.executionPlan, setup.snapshot.skillEvidence,
      { nativeSession: { mode: "start" } }, agentId);
    if (change === "revoke") {
      await expect(asking).rejects.toThrow("local-execution-consent-revoked");
      expect(instructions).toHaveLength(1);
    } else {
      expect((await asking).answer).toContain("Alice");
      expect(instructions).toHaveLength(2);
      expect(instructions.every(instruction => !instruction?.includes("NEW INSTRUCTION MUST NOT LEAK"))).toBe(true);
    }
  } finally { engine.close(); }
});

test("native preparation cannot replace the full Workdir before an injected Provider starts", async () => {
  let calls = 0;
  const { engine, agentId, snapshot } = await fixture({
    nativeSessionPreflight: async (_provider, _timeout, _signal, workdir) => {
      renameSync(workdir!, `${workdir}.original`); mkdirSync(workdir!);
    },
    runProvider: async () => { calls++; return "must not execute"; },
  });
  try {
    await expect(engine.askWithExecutionPlan([space], "offline", snapshot.executionPlan, snapshot.skillEvidence,
      { nativeSession: { mode: "start" } }, agentId)).rejects.toThrow("execution-mode-invalid");
    expect(calls).toBe(0);
  } finally { engine.close(); }
});

test.each(["normal", "agent-backup"] as const)("%s recovery rechecks queued full authorization without inventing approval", async recovery => {
  const { engine, agentId } = await fixture({ runProvider: async () => { throw new Error("not started yet"); } });
  const snapshot = engine.agentRunExecutionSnapshot(space, true, true, "all", "task");
  const task = engine.tasks.create({ space, topic: "frozen restart" })!;
  const queued = engine.taskRuns.start({ task, trigger: "manual", agentId, executionPlan: snapshot.executionPlan,
    skillEvidence: snapshot.skillEvidence, approvalRequired: true, distill: false });
  engine.taskRuns.approve(queued.id, { decidedAt: queued.startedAt, decidedBy: "offline-human" });
  engine.close();
  if (recovery === "agent-backup") writeFileSync(join(dir, "data", "config", "agents.json"), "invalid JSON");
  let starts = 0;
  const reopened = new KnowledgeEngine({ dataDir: join(dir, "data"), skillCatalog: new SkillCatalog({ roots: [] }),
    runProvider: async (_provider, input) => {
      const permit = input.acquireExecutionPermit!();
      const unregister = permit.register(() => {}); starts++; permit.release(); unregister();
      return "offline output";
    } });
  try {
    const resumed = reopened.resumeQueuedTaskRuns();
    if (recovery === "normal") {
      expect(resumed).toHaveLength(1);
      expect((await resumed[0]!.completion).status).toBe("succeeded");
      expect(starts).toBe(1);
    } else {
      expect(resumed).toEqual([]);
      expect(reopened.taskRuns.get(queued.id)?.status).toBe("failed");
      expect(reopened.taskRuns.get(queued.id)?.error).toContain("确认已失效");
      expect(starts).toBe(0);
    }
    expect(reopened.taskRuns.get(queued.id)?.executionPlan).toEqual(snapshot.executionPlan);
  } finally { reopened.close(); }
});

test("mutating the caller's plan during preflight cannot change the frozen final instruction", async () => {
  let mutate = () => {};
  let instruction: string | undefined;
  const { engine, agentId, snapshot } = await fixture({ nativeSessionPreflight: async () => { mutate(); },
    runProvider: async (_provider, input) => { instruction = input.system; return "offline answer"; } });
  mutate = () => { snapshot.executionPlan.instruction = "MUTATED OUTSIDE RUN"; };
  try {
    await engine.askWithExecutionPlan([space], "offline", snapshot.executionPlan, snapshot.skillEvidence,
      { nativeSession: { mode: "start" } }, agentId);
    expect(instruction).not.toContain("MUTATED OUTSIDE RUN");
  } finally { engine.close(); }
});

test("manual full Task retry preserves its old grant and limits, needs new human approval, and refuses revocation", async () => {
  const { engine, agentId } = await fixture({ runProvider: async () => "offline output" });
  try {
    const task = engine.tasks.create({ space, topic: "retry frozen", timeoutMinutes: 360 })!;
    const initial = engine.startTaskRun(task.id, { distill: false });
    engine.rejectTaskRun(initial.run.id, "offline-human", "not now");
    const draft = engine.agents.saveDraft(agentId, { instruction: "new revision" })!;
    engine.localExecution.release(agentId, draft.id, draft.id, { termsVersion: 1, source: "local-operator", taskExecutionEnabled: true,
      expectedScopeFingerprint: engine.localExecution.preview(agentId, draft.id).fingerprint });
    engine.tasks.update(task.id, { timeoutMinutes: 720 });
    const retry = engine.retryTaskRun(initial.run.id);
    expect(retry.run.executionPlan).toEqual(initial.run.executionPlan);
    expect(retry.run.timeoutMs).toBe(initial.run.timeoutMs);
    expect(retry.run.approval?.status).toBe("pending");
    engine.agents.revokeLocalExecutionGrants(agentId, engine.agents.get(agentId)!.publishedRevisionId!);
    expect(engine.taskRuns.get(retry.run.id)?.status).toBe("cancelled");
    expect(() => engine.retryTaskRun(initial.run.id)).toThrow("确认已失效");
    expect(engine.taskRuns.list(task.id)).toHaveLength(2);
  } finally { engine.close(); }
});

test("full native Chat freezes Skills inside Workdir without applying an isolated-only source-root restriction", async () => {
  const skillRoot = join(dir, "work", "skills");
  const skillDir = join(skillRoot, "fixture"); mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "---\nname: fixture\ndescription: Offline Skill.\n---\nRead the fixture.");
  let calls = 0;
  const { engine, agentId, snapshot } = await fixture({
    skillCatalog: new SkillCatalog({ roots: [{ kind: "codex-user", path: skillRoot, providerIds: ["codex"] }] }),
    runProvider: async (_provider, input) => { calls++; expect(input.skillInputs).toHaveLength(1); return "offline answer"; },
  });
  try {
    expect((await engine.askWithExecutionPlan([space], "offline", snapshot.executionPlan, snapshot.skillEvidence,
      { nativeSession: { mode: "start" } }, agentId)).answer).toBe("offline answer");
    expect(calls).toBe(1);
  } finally { engine.close(); }
});

test("revoked routing cannot turn into a successful canned knowledge-only answer", async () => {
  let revoke = () => {};
  const { engine, agentId, snapshot } = await fixture({ runProvider: async () => {
    revoke(); return JSON.stringify({ slugs: [], relevant: false });
  } });
  revoke = () => { engine.agents.revokeLocalExecutionGrants(agentId, engine.agents.get(agentId)!.publishedRevisionId!); };
  try {
    engine.registry.store(space).writePage({ slug: "entities/alice", type: "entity", title: "Alice", summary: "unrelated",
      content: "unrelated", aliases: [], tags: [], sources: [], links: [], contentHash: "h", updatedAt: 1 });
    await expect(engine.askWithExecutionPlan([space], "zqxvunknown", snapshot.executionPlan, snapshot.skillEvidence,
      { knowledgeOnly: true }, agentId)).rejects.toThrow("local-execution-consent-revoked");
  } finally { engine.close(); }
});

test("revocation still cancels a full Task after its model finishes while no-tools distillation is pending", async () => {
  const distilling = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<string>();
  let signal: AbortSignal | undefined;
  const { engine, agentId } = await fixture({ runProvider: async (_provider, input, _timeout, abortSignal) => {
    if (input.execution?.permission === "full") return "offline result";
    signal = abortSignal;
    signal?.addEventListener("abort", () => finish.reject(signal?.reason), { once: true });
    distilling.resolve();
    return finish.promise;
  } });
  let completion: Promise<unknown> | undefined;
  try {
    const task = engine.tasks.create({ space, topic: "offline", distillOnRun: true })!;
    const pending = engine.startTaskRun(task.id);
    const approved = engine.approveTaskRun(pending.run.id, "offline-human");
    completion = approved.completion;
    await distilling.promise;
    engine.agents.revokeLocalExecutionGrants(agentId, engine.agents.get(agentId)!.publishedRevisionId!);
    expect(signal?.aborted).toBe(true);
    expect((await approved.completion).status).toBe("cancelled");
  } finally { finish.resolve(JSON.stringify({ operations: [] })); await completion; engine.close(); }
});

test("a Skill change during full preflight fails the whole knowledge-only Run before routing", async () => {
  const skillRoot = join(dir, "skills");
  const skillDir = join(skillRoot, "fixture"); mkdirSync(skillDir, { recursive: true });
  const path = join(skillDir, "SKILL.md");
  writeFileSync(path, "---\nname: fixture\ndescription: Offline Skill.\n---\nOriginal content.");
  let calls = 0;
  const { engine, agentId, snapshot } = await fixture({
    skillCatalog: new SkillCatalog({ roots: [{ kind: "codex-user", path: skillRoot, providerIds: ["codex"] }] }),
    nativeSessionPreflight: async () => { writeFileSync(path, "---\nname: fixture\ndescription: Offline Skill.\n---\nChanged content."); },
    runProvider: async () => { calls++; return "must not execute"; },
  });
  try {
    engine.registry.store(space).writePage({ slug: "entities/alice", type: "entity", title: "Alice", summary: "unrelated",
      content: "unrelated", aliases: [], tags: [], sources: [], links: [], contentHash: "h", updatedAt: 1 });
    await expect(engine.askWithExecutionPlan([space], "zqxvunknown", snapshot.executionPlan, snapshot.skillEvidence,
      { knowledgeOnly: true, nativeSession: { mode: "start" } }, agentId)).rejects.toThrow("execution-mode-invalid");
    expect(calls).toBe(0);
  } finally { engine.close(); }
});
