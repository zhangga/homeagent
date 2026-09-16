import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeEngine } from "./engine.ts";
import { isArchivedExecutionPlan, isResolvedExecutionPlan, LOCAL_EXECUTION_NOT_CONFIRMED } from "./execution-plan.ts";
import { parseSpaceArchive } from "./governance.ts";
import { SkillCatalog } from "./skill-catalog.ts";

let dir: string;
beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), "ha-engine-scopes-"))); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const space = "team/oc_scopes" as const;

async function fixture() {
  const engine = new KnowledgeEngine({ dataDir: join(dir, "data"), skillCatalog: new SkillCatalog({ roots: [] }),
    llm: { complete: async () => { throw new Error("Provider must not be called in this test"); },
      completeJSON: async () => { throw new Error("Provider must not be called in this test"); } } });
  try {
  await engine.ensureSpace(space);
  const agent = engine.agents.create({ provider: "codex" });
  engine.registry.updateMeta(space, { agentId: agent.id });
  engine.feishuBindings.connect({ spaceId: space, chatId: "oc_scopes", boundAppId: "cli_fixture", responseMode: "mentions_only", replyInThread: true });
  const workdir = join(dir, "work"); mkdirSync(workdir);
  const draft = engine.agents.saveDraft(agent.id, { executionMode: "local-full-access", permission: "full", workdir })!;
  engine.localExecution.release(agent.id, draft.id, draft.id, {
    termsVersion: 1, source: "local-operator", taskExecutionEnabled: true,
    expectedScopeFingerprint: engine.localExecution.preview(agent.id, draft.id).fingerprint,
  });
  return { engine, agentId: agent.id };
  } catch (error) { engine.close(); throw error; }
}

test("Engine freezes v2 grants by invocation kind and does not authorize a changed Chat binding or background work", async () => {
  const { engine, agentId } = await fixture();
  try {
    const chat = engine.agentRunExecutionSnapshot(space).executionPlan;
    expect(chat.version).toBe(2);
    expect(chat.localExecution?.kind).toBe("chat");
    expect(isResolvedExecutionPlan(chat)).toBe(true);
    const task = engine.agentRunExecutionSnapshot(space, true, true, "all", "task").executionPlan;
    expect(task.localExecution?.kind).toBe("task");
    const background = engine.agentRunExecutionSnapshot(space, false).executionPlan;
    expect(background.localExecution).toBeUndefined();
    expect(background.resolutionError).toBe(LOCAL_EXECUTION_NOT_CONFIRMED);
    engine.feishuBindings.updatePolicy(space, { responseMode: "all_messages" });
    const changed = engine.agentRunExecutionSnapshot(space).executionPlan;
    expect(changed.localExecution).toBeUndefined();
    expect(changed.resolutionError).toBe(LOCAL_EXECUTION_NOT_CONFIRMED);
    expect(isResolvedExecutionPlan(changed)).toBe(true);
    expect(chat.localExecution?.kind).toBe("chat");
    engine.agents.revokeLocalExecutionGrants(agentId, engine.agents.get(agentId)!.publishedRevisionId!);
    expect(engine.agentRunExecutionSnapshot(space, true, true, "all", "task").executionPlan.resolutionError).toBe(LOCAL_EXECUTION_NOT_CONFIRMED);
  } finally { engine.close(); }
});

test("Space export strips local authority and epochs, while restored terminal plans remain historical only", async () => {
  const { engine, agentId } = await fixture();
  const target = new KnowledgeEngine({ dataDir: join(dir, "restore"), skillCatalog: new SkillCatalog({ roots: [] }) });
  try {
    const plan = engine.agentRunExecutionSnapshot(space).executionPlan;
    const run = engine.chatRuns.start({ space, agentId, input: "offline fixture", trigger: "message", executionPlan: plan, startedAt: 1 });
    engine.chatRuns.succeed(run.id, { finishedAt: 2, output: "done" });
    const task = engine.tasks.create({ space, topic: "offline fixture" })!;
    const started = engine.startTaskRun(task.id, { distill: false });
    expect(started.state).toBe("awaiting_approval");
    expect(started.run.executionPlan?.localExecution?.kind).toBe("task");
    await started.completion;
    engine.taskRuns.cancel(started.run.id, { finishedAt: started.run.startedAt + 1, error: "cancelled offline" });
    const archive = await engine.exportSpace(space);
    expect(isArchivedExecutionPlan(archive.chatRuns[0]?.executionPlan)).toBe(true);
    expect(isArchivedExecutionPlan(archive.taskRuns[0]?.executionPlan)).toBe(true);
    const serialized = JSON.stringify(archive);
    expect(serialized).not.toContain(plan.localExecution!.grantId);
    expect(serialized).not.toContain("policyHash");
    expect(serialized).not.toContain("agentBindingEpoch");
    expect(serialized).not.toContain("executionScopeEpoch");
    expect(() => parseSpaceArchive({ ...archive, chatRuns: [{ ...archive.chatRuns[0], executionPlan: plan }] })).toThrow();
    await target.restoreSpace(archive);
    expect(isArchivedExecutionPlan(target.chatRuns.get(run.id)?.executionPlan)).toBe(true);
    expect(target.agents.listLocalExecutionGrants(agentId)).toEqual([]);
    expect(target.registry.get(space)?.agentBindingEpoch).not.toBe(engine.registry.get(space)?.agentBindingEpoch);
  } finally { engine.close(); target.close(); }
});
