import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeEngine } from "./engine.ts";
import { SkillCatalog } from "./skill-catalog.ts";
import { parseSpaceArchive } from "./governance.ts";
import { parseWorkPlanRevision, workPlanDigest, type WorkPlanChildInput } from "./work-plans.ts";

const SPACE = "team/m3" as const;
const children: WorkPlanChildInput[] = ["a", "b"].map(key => ({ key, title: `研究${key}`, goal: `汇总${key}`,
  steps: [{ instruction: `汇总${key}`, doneWhen: "提供总数" }] }));
const report = JSON.stringify({ version: 1, outcome: "completed", result: "合计20", blockers: [], checks: [{ name: "核算", status: "passed" }] });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ha-delegation-"));
  const options = { dataDir: root, skillCatalog: new SkillCatalog({ roots: [] }), runProvider: async () => report };
  let engine = new KnowledgeEngine(options); engine.ensureSpace(SPACE);
  const item = engine.workItems.create({ space: SPACE, title: "并行研究目标" });
  return { root, item, get engine() { return engine; },
    plan(input = children) { return engine.commitWorkPlanRevision(engine.prepareWorkPlanRevision(item.id, { kind: "manual", id: "m3" }),
      [{ instruction: "汇总研究结果", doneWhen: "包含a和b", dependsOn: input.map(child => child.key) }], { children: input }); },
    reopen() { engine.close(); engine = new KnowledgeEngine({ ...options, skillCatalog: new SkillCatalog({ roots: [] }) }); },
    close() { engine.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("worker publication changes cannot replace the revision frozen in a step", async () => {
  const f = fixture();
  try {
    const agent = f.engine.agents.create({ name: "研究", instruction: "使用已确认术语", visibility: "Team", provider: "codex" });
    f.engine.commitWorkPlanRevision(f.engine.prepareWorkPlanRevision(f.item.id, { kind: "manual", id: "worker" }), [
      { instruction: "研究测试数据", doneWhen: "得出结论", agentId: agent.id },
    ]);
    f.engine.agents.update(agent.id, { instruction: "改用新术语", model: "new-model" });
    f.reopen();
    const started = await f.engine.startWorkContinuationAsync(f.item.id);
    expect(started.run.agentId).toBe(agent.id);
    expect(started.run.executionPlan?.agentRevisionId).toBe(agent.publishedRevisionId);
    expect(started.run.executionPlan?.instruction).toBe("使用已确认术语");
    await started.completion;
    const archive = await f.engine.exportSpace(SPACE);
    expect(archive.workPlans[0]?.workers?.[0]?.agent.instruction).toBe("使用已确认术语");
    expect(() => parseSpaceArchive({ ...archive, version: 23 })).toThrow("v24");
  } finally { f.close(); }
});

test("delegation preserves Space visibility and the coordinator execution permission", () => {
  const f = fixture();
  try {
    const agents = [f.engine.agents.create({ name: "私人", visibility: "Personal" }),
      f.engine.agents.create({ name: "写入", visibility: "Team", permission: "write", workdir: f.root })];
    for (const agent of agents) expect(() => f.engine.commitWorkPlanRevision(f.engine.prepareWorkPlanRevision(f.item.id, { kind: "manual", id: "bad-worker" }), [
      { instruction: "调研", doneWhen: "注明来源", agentId: agent.id },
    ])).toThrow("专业 Agent");
    expect(f.engine.workItems.get(f.item.id)?.planRef).toBeUndefined();
    expect(f.engine.listTaskRuns()).toEqual([]);
  } finally { f.close(); }
});

test("child plans and parent pointer become visible in one durable commit", () => {
  const f = fixture(); const path = join(f.root, "config", "work-items.json");
  try {
    renameSync(path, `${path}.saved`); mkdirSync(path);
    expect(() => f.plan()).toThrow();
    expect(f.engine.workItems.list(SPACE)).toHaveLength(1);
    expect(f.engine.workItems.get(f.item.id)?.planRef).toBeUndefined();
    rmdirSync(path); renameSync(`${path}.saved`, path); f.reopen();
    expect(f.engine.workItems.list(SPACE)).toHaveLength(1);
    f.plan(); f.reopen();
    expect(f.engine.workItems.list(SPACE)).toHaveLength(3);
    expect(f.engine.workItems.currentForSpace(SPACE)?.id).toBe(f.item.id);
  } finally { f.close(); }
});

test("dependency cycles and cross-Space references cannot partially create a work graph", () => {
  const f = fixture();
  try {
    const cyclic = structuredClone(children);
    cyclic[0]!.steps[0]!.dependsOn = ["b"]; cyclic[1]!.steps[0]!.dependsOn = ["a"];
    expect(() => f.plan(cyclic)).toThrow("cycle");
    expect(f.engine.workItems.list(SPACE)).toHaveLength(1);
    f.engine.ensureSpace("team/other");
    const other = f.engine.workItems.create({ space: "team/other", title: "其他空间" });
    expect(() => f.engine.commitWorkPlanRevision(f.engine.prepareWorkPlanRevision(f.item.id, { kind: "manual", id: "cross" }), [
      { instruction: "汇总", doneWhen: "有数据", dependsOn: [other.id] },
    ])).toThrow("same Space");
    expect(f.engine.workItems.get(f.item.id)?.planRef).toBeUndefined();
  } finally { f.close(); }
});

test("sibling dependencies serialize conflicting work before the parent aggregation", async () => {
  const f = fixture();
  try {
    const ordered = structuredClone(children); ordered[1]!.steps[0]!.dependsOn = ["a"];
    f.plan(ordered); f.engine.configureWorkContinuation(f.item.id, true);
    const graph = f.engine.getWorkPlanView(f.item.id)!;
    const a = graph.children.find(child => child.key === "a")!.workItemId, b = graph.children.find(child => child.key === "b")!.workItemId;
    expect(f.engine.listDueWorkContinuations().map(item => item.id)).toEqual([a]);
    expect(() => f.engine.startWorkContinuation(b)).toThrow("依赖");
    await (await f.engine.startWorkContinuationAsync(a)).completion;
    expect(f.engine.listDueWorkContinuations().map(item => item.id)).toEqual([b]);
    await (await f.engine.startWorkContinuationAsync(b)).completion;
    expect(f.engine.listDueWorkContinuations().map(item => item.id)).toEqual([f.item.id]);
  } finally { f.close(); }
});

test("later parent reviewers receive accepted child evidence without repeating dependency declarations", async () => {
  const root = mkdtempSync(join(tmpdir(), "ha-parent-evidence-")), prompts: string[] = [];
  const engine = new KnowledgeEngine({ dataDir: root, skillCatalog: new SkillCatalog({ roots: [] }),
    runProvider: async (_provider, input) => { prompts.push(input.prompt); return report; } });
  try {
    engine.ensureSpace(SPACE);
    const parent = engine.workItems.create({ space: SPACE, title: "核算并审查" });
    engine.commitWorkPlanRevision(engine.prepareWorkPlanRevision(parent.id, { kind: "manual", id: "evidence" }), [
      { instruction: "准备摘要格式", doneWhen: "有格式" },
      { instruction: "汇总子成果", doneWhen: "包含两组数据", dependsOn: ["a", "b"] },
      { instruction: "对照子成果审查摘要", doneWhen: "逐项核对原始成果" },
      { instruction: "形成最终成果", doneWhen: "成果完整" },
    ], { children });
    const graph = engine.getWorkPlanView(parent.id)!;
    await (await engine.startWorkContinuationAsync(parent.id)).completion;
    expect(prompts.at(-1)).not.toContain("已验收的依赖成果");
    const childRuns = [];
    for (const child of graph.children) {
      const started = await engine.startWorkContinuationAsync(child.workItemId);
      await started.completion;
      childRuns.push(engine.getTaskRun(started.run.id)!);
    }
    await (await engine.startWorkContinuationAsync(parent.id)).completion;
    await (await engine.startWorkContinuationAsync(parent.id)).completion;
    const reviewPrompt = prompts.at(-1)!;
    expect(reviewPrompt).toContain("已验收的依赖成果");
    for (const child of childRuns) {
      expect(reviewPrompt).toContain(child.workItemId!);
      expect(reviewPrompt).toContain(child.id);
      expect(reviewPrompt).toContain(child.rawId!);
    }
  } finally { engine.close(); rmSync(root, { recursive: true, force: true }); }
});

test("pending parent cancellation survives reopen and affects only owned children", () => {
  const f = fixture();
  try {
    f.plan(); f.engine.configureWorkContinuation(f.item.id, true);
    const child = f.engine.getWorkPlanView(f.item.id)!.children[0]!;
    f.engine.commitWorkPlanRevision(f.engine.prepareWorkPlanRevision(child.workItemId, { kind: "manual", id: "nested" }), [
      { instruction: "汇总子调研", doneWhen: "注明来源", dependsOn: ["nested"] },
    ], { children: [{ key: "nested", title: "进一步研究", goal: "核对来源", steps: [{ instruction: "核对", doneWhen: "来源准确" }] }] });
    const independent = f.engine.workItems.create({ space: SPACE, title: "独立目标", nextActions: ["继续自己的工作"] });
    f.engine.configureWorkContinuation(independent.id, true);
    f.engine.workItems.recordChildCancellation(f.item.id);
    f.reopen(); f.engine.reconcileChatWorkPlans();
    expect(f.engine.workItems.get(f.item.id)?.childCancellation?.status).toBe("applied");
    expect(f.engine.workItems.list(SPACE).filter(item => item.parentWorkItemId).every(item => !item.active)).toBe(true);
    expect(f.engine.listDueWorkContinuations().map(item => item.id)).toEqual([independent.id]);
  } finally { f.close(); }
});

test("v24 round trips parent links and dependencies without local cancellation or delivery authority", async () => {
  const f = fixture(); const target = fixture();
  try {
    f.plan(); f.engine.cancelWorkChildren(f.item.id);
    const archive = await f.engine.exportSpace(SPACE);
    expect(archive.version).toBe(25);
    expect(JSON.stringify(archive)).not.toContain("childCancellation");
    await target.engine.deleteSpace(SPACE);
    await target.engine.restoreSpace(archive);
    expect(target.engine.getWorkPlanView(f.item.id)?.children).toHaveLength(2);
    expect(target.engine.chatWorkPlanSource(f.item.id)).toBeUndefined();
    const malformed = structuredClone(archive);
    malformed.workItems.find(item => item.parentWorkItemId)!.parentWorkItemId = "work_00000000-0000-0000-0000-000000000000";
    expect(() => parseSpaceArchive(malformed)).toThrow();
    const plan = archive.workPlans.find(plan => plan.workItemId === f.item.id)!;
    expect(workPlanDigest(parseWorkPlanRevision(plan))).toBe(archive.workItems.find(item => item.id === f.item.id)!.planRef!.digest);
  } finally { target.close(); f.close(); }
});
