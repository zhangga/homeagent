import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkPlanStore, parseWorkPlanRevision, type WorkPlanRevision } from "./work-plans.ts";
import { WorkItemStore } from "./work-items.ts";

test("plan revisions retain distinct step identities and reopen without sharing mutable state", () => {
  const root = mkdtempSync(join(tmpdir(), "ha-work-plan-"));
  try {
    const store = new WorkPlanStore(root);
    const revision: WorkPlanRevision = { version: 1,
      workItemId: "work_00000000-0000-0000-0000-000000000001", space: "team/test", revision: 1,
      goal: "分别检查两份资料", reason: "首次规划", source: { kind: "manual", id: "manual-test" },
      steps: [
        { id: "step_00000000000000000000000000000001", instruction: "检查资料", doneWhen: "注明来源" },
        { id: "step_00000000000000000000000000000002", instruction: "检查资料", doneWhen: "注明来源" },
      ], acceptedActionIds: [], createdAt: 100 };
    const ref = store.save(revision);
    revision.steps[0]!.instruction = "被调用者修改";
    const reopened = new WorkPlanStore(root).get(revision.workItemId, ref);
    expect(reopened.steps.map(step => step.instruction)).toEqual(["检查资料", "检查资料"]);
    expect(new Set(reopened.steps.map(step => step.id)).size).toBe(2);
    expect(store.page(revision.workItemId).map(entry => entry.revision)).toEqual([1]);
    expect(() => store.save(revision)).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a failed plan pointer commit leaves the old revision executable after reopening", () => {
  const root = mkdtempSync(join(tmpdir(), "ha-plan-pointer-"));
  const path = join(root, "config", "work-items.json");
  try {
    const items = new WorkItemStore(root);
    const item = items.create({ space: "team/test", title: "修改计划" });
    const first: WorkPlanRevision = { version: 1, workItemId: item.id, space: item.space, revision: 1,
      goal: "生成周报", reason: "首次规划", source: { kind: "manual", id: "manual-1" },
      steps: [{ id: "step_00000000000000000000000000000001", instruction: "生成周报", doneWhen: "包含来源" }],
      acceptedActionIds: [], createdAt: 1 };
    const saved = items.commitPlan(item.id, first);
    renameSync(path, `${path}.saved`);
    mkdirSync(path);
    expect(() => items.commitPlan(item.id, { ...first, revision: 2, previous: saved.planRef,
      source: { kind: "manual", id: "manual-2" }, steps: [{ id: "step_00000000000000000000000000000002", instruction: "生成摘要", doneWhen: "100字以内" }] })).toThrow();
    expect(items.get(item.id)?.planRef).toEqual(saved.planRef);
    rmdirSync(path);
    renameSync(`${path}.saved`, path);
    const reopened = new WorkItemStore(root);
    expect(reopened.get(item.id)?.nextActions).toEqual(["1. 生成周报\n完成标准：包含来源"]);
    expect(reopened.plans.history(item.id, saved.planRef!).map(plan => plan.revision)).toEqual([1]);
    expect(reopened.plans.nextRevision(item.id)).toBe(3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("plan definitions reject malformed steps, path escapes, and changed contents", () => {
  const root = mkdtempSync(join(tmpdir(), "ha-plan-validation-"));
  try {
    const store = new WorkPlanStore(root);
    const plan: WorkPlanRevision = { version: 1, workItemId: "work_00000000-0000-0000-0000-000000000001", space: "team/test", revision: 1,
      goal: "生成周报", reason: "首次规划", source: { kind: "manual", id: "manual-1" },
      steps: [{ id: "step_00000000000000000000000000000001", instruction: "生成周报", doneWhen: "包含来源" }], acceptedActionIds: [], createdAt: 1 };
    for (const invalid of [ { ...plan, steps: [plan.steps[0], plan.steps[0]] },
      { ...plan, steps: [{ ...plan.steps[0], doneWhen: "" }] }, { ...plan, workItemId: "../escape" },
      { ...plan, previous: { revision: 1, digest: "0".repeat(64) } }, { ...plan, goal: "x".repeat(200_001) },
      { ...plan, steps: Array.from({ length: 201 }, (_, i) => ({ ...plan.steps[0], id: `step_${i.toString(16).padStart(32, "0")}` })) },
      { ...plan, steps: [{ ...plan.steps[0], instruction: "x".repeat(1_901) }] } ]) {
      expect(() => parseWorkPlanRevision(invalid)).toThrow();
    }
    const ref = store.save(plan);
    const changed = { ...plan, goal: "篡改后的目标" };
    writeFileSync(join(root, "config", "work-plans", plan.workItemId, "revision_1.json"), JSON.stringify(changed));
    expect(() => store.get(plan.workItemId, ref)).toThrow("digest mismatch");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
