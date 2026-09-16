import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeEngine, type EngineOptions } from "./engine.ts";
import { SkillCatalog } from "./skill-catalog.ts";
import { isLocalExecutionGrant } from "./local-execution-grants.ts";

let root: string;
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), "ha-retention-"))); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
const space = "team/oc_retention" as const;

function open(options: Pick<EngineOptions, "runProvider" | "nativeSessionPreflight"> = {}) {
  return new KnowledgeEngine({ dataDir: join(root, "data"), skillCatalog: new SkillCatalog({ roots: [] }),
    recoverInterruptedChatRuns: false, recoverInterruptedTaskRuns: false, runProvider: async () => "offline", ...options });
}

function publish(engine: KnowledgeEngine, agentId: string) {
  const draft = engine.agents.getDraft(agentId) ?? engine.agents.saveDraft(agentId, { instruction: "new revision" })!;
  return engine.localExecution.release(agentId, draft.id, draft.id, {
    termsVersion: 1, source: "local-operator", taskExecutionEnabled: true,
    expectedScopeFingerprint: engine.localExecution.preview(agentId, draft.id).fingerprint,
  })!;
}

async function fixture(options: Pick<EngineOptions, "runProvider" | "nativeSessionPreflight"> = {}) {
  const engine = open();
  let agentId: string;
  try {
    await engine.ensureSpace(space);
    agentId = engine.agents.create({ provider: "codex" }).id;
    engine.registry.updateMeta(space, { agentId });
    engine.feishuBindings.connect({ spaceId: space, chatId: "oc_retention", boundAppId: "cli_fixture", responseMode: "mentions_only", replyInThread: true });
    const workdir = join(root, "work"); mkdirSync(workdir);
    engine.agents.saveDraft(agentId, { executionMode: "local-full-access", permission: "full", workdir });
    publish(engine, agentId);
  } finally { engine.close(); }
  // Offline capacity fixture only: no live Engine or data directory is modified.
  const path = join(root, "data", "config", "agents.json");
  const data = JSON.parse(readFileSync(path, "utf8"));
  const template = Object.values(data.localExecutionGrants)[0];
  if (!isLocalExecutionGrant(template)) throw new Error("Invalid offline grant fixture");
  const history = data.revisions[agentId];
  for (let i = 0; i < 99; i++) {
    const revision = { ...history[0], id: `agent_revision_${randomUUID()}`, number: history.length + 1, basedOnRevisionId: history[0].id };
    history.unshift(revision);
    const grantId = `local_execution_grant_${randomUUID()}`;
    data.localExecutionGrants[grantId] = { ...template, id: grantId, agentRevisionId: revision.id };
  }
  data.agents[agentId].publishedRevisionId = history[0].id;
  writeFileSync(path, JSON.stringify(data));
  return { engine: open(options), agentId };
}

test("Engine retention protects every nonterminal Run and terminal history cannot restore an evicted grant", async () => {
  let calls = 0;
  let { engine, agentId } = await fixture({ runProvider: async () => { calls++; return "offline"; } });
  try {
    const current = engine.agents.get(agentId)!.publishedRevisionId;
    const old = engine.agents.listLocalExecutionGrants(agentId).filter(grant => grant.agentRevisionId !== current);
    const task = engine.tasks.create({ space, topic: "offline retention", distillOnRun: false })!;
    const snapshot = engine.agentRunExecutionSnapshot(space);
    const chatIds: string[] = [];
    for (const [index, grant] of old.entries()) {
      const kind = index % 5 < 2 ? "chat" : "task";
      const plan = { ...snapshot.executionPlan, agentRevisionId: grant.agentRevisionId,
        localExecution: engine.localExecution.referenceFor(space, agentId, grant.agentRevisionId, kind)! };
      if (kind === "chat") {
        const run = engine.chatRuns.start({ space, agentId, executionPlan: plan, input: "offline", trigger: "message" });
        if (index % 5 === 1) engine.chatRuns.begin(run.id);
        chatIds.push(run.id);
      } else {
        const run = engine.taskRuns.start({ task, agentId, executionPlan: plan, trigger: "manual", distill: false, approvalRequired: true });
        if (index % 5 >= 3) engine.taskRuns.approve(run.id, { decidedAt: Date.now(), decidedBy: "offline-human" });
        if (index % 5 === 4) engine.taskRuns.begin(run.id);
      }
    }
    expect(new Set(engine.taskRuns.list().map(run => run.status))).toEqual(new Set(["awaiting_approval", "queued", "running"]));
    expect(() => publish(engine, agentId)).toThrow("无法安全清理");
    const terminal = engine.chatRuns.succeed(chatIds[0]!, { output: "retained history", finishedAt: Date.now() })!;
    publish(engine, agentId);
    expect(engine.agents.listLocalExecutionGrants(agentId)).toHaveLength(100);
    expect(engine.agents.listLocalExecutionGrants(agentId).some(grant => grant.id === old[0]!.id)).toBe(false);
    expect(engine.chatRuns.get(terminal.id)?.executionPlan).toEqual(terminal.executionPlan);
    expect(engine.localExecution.referenceFor(space, agentId, old[0]!.agentRevisionId, "chat")).toBeUndefined();
    engine.close(); engine = open({ runProvider: async () => { calls++; return "offline"; } });
    expect(engine.chatRuns.get(terminal.id)?.output).toBe("retained history");
    expect(engine.chatRuns.list().filter(run => run.status === "queued" || run.status === "running")).toHaveLength(chatIds.length - 1);
    expect(engine.agents.listLocalExecutionGrants(agentId)).toHaveLength(100);
    const plan = terminal.executionPlan!;
    await expect(engine.askWithExecutionPlan([space], "old history", { ...snapshot.executionPlan,
      agentRevisionId: plan.agentRevisionId, localExecution: snapshot.executionPlan.localExecution && { ...snapshot.executionPlan.localExecution, grantId: old[0]!.id } },
    snapshot.skillEvidence, {}, agentId)).rejects.toThrow("local-execution-consent-revoked");
    expect(calls).toBe(0);
  } finally { engine.close(); }
}, 20_000);

test.each(["preflight", "ordinary-chat", "standalone-client"] as const)(
  "retention protects a transient %s until completion, without a durable Run", async stage => {
    const waiting = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const { engine, agentId } = await fixture({
      nativeSessionPreflight: async () => { waiting.resolve(); await finish.promise; },
      runProvider: async (_provider, input) => {
        if (stage !== "preflight") { waiting.resolve(); await finish.promise; }
        const permit = input.acquireExecutionPermit!();
        const stop = permit.register(() => {}); permit.release(); stop();
        return "offline result";
      },
    });
    let outcome: Promise<unknown> | undefined;
    try {
      const snapshot = engine.agentRunExecutionSnapshot(space);
      const currentGrantId = snapshot.executionPlan.localExecution!.grantId;
      const old = engine.agents.listLocalExecutionGrants(agentId).filter(grant => grant.id !== currentGrantId);
      for (const grant of old.slice(0, 98)) {
        engine.chatRuns.start({ space, agentId, input: "protected queue", trigger: "message", executionPlan: {
          ...snapshot.executionPlan, agentRevisionId: grant.agentRevisionId,
          localExecution: engine.localExecution.referenceFor(space, agentId, grant.agentRevisionId, "chat")!,
        } });
      }
      const asking = stage === "preflight"
        ? engine.askWithExecutionPlan([space], "offline", snapshot.executionPlan, snapshot.skillEvidence, { nativeSession: { mode: "start" } }, agentId)
        : stage === "ordinary-chat" ? engine.ask([space], "offline")
        : engine.agentCallContext(space, { taskExecution: true }).client.complete({ prompt: "offline" });
      outcome = asking.then(() => "success", error => String(error));
      await waiting.promise;
      publish(engine, agentId);
      expect(() => publish(engine, agentId)).toThrow("无法安全清理");
      expect(engine.agents.listLocalExecutionGrants(agentId).some(grant => grant.id === currentGrantId)).toBe(true);
      finish.resolve();
      expect(await outcome).toBe("success");
      publish(engine, agentId);
      expect(engine.agents.listLocalExecutionGrants(agentId).some(grant => grant.id === currentGrantId)).toBe(false);
    } finally { finish.resolve(); await outcome; engine.close(); }
  }, 20_000,
);

test.each(["preflight", "provider"] as const)("failed %s releases transient retention without weakening the next authorization check", async stage => {
  const { engine, agentId } = await fixture({
    nativeSessionPreflight: async () => { if (stage === "preflight") throw new Error("offline failure"); },
    runProvider: async () => { throw new Error("offline failure"); },
  });
  try {
    const snapshot = engine.agentRunExecutionSnapshot(space);
    await expect(engine.askWithExecutionPlan([space], "offline", snapshot.executionPlan, snapshot.skillEvidence,
      { nativeSession: { mode: "start" } }, agentId)).rejects.toThrow("offline failure");
    expect(engine.localExecution.referencedGrantIds()?.size).toBe(0);
    engine.agents.revokeLocalExecutionGrants(agentId, engine.agents.get(agentId)!.publishedRevisionId!);
    await expect(engine.askWithExecutionPlan([space], "offline", snapshot.executionPlan, snapshot.skillEvidence,
      {}, agentId)).rejects.toThrow("local-execution-consent-revoked");
    expect(engine.localExecution.referencedGrantIds()?.size).toBe(0);
  } finally { engine.close(); }
});
