import { expect, test } from "bun:test";
import type { TaskRun, WorkAction, WorkActionAcceptance, WorkItem } from "@homeagent/core";
import { selectWorkAttention } from "./work-attention.ts";

const item: WorkItem = {
  id: "work_a", space: "team/oc_a", title: "验收事项", phase: "active", active: true,
  brief: "", runbook: "", summary: "", blockers: [], nextActions: ["执行检查"],
  rawIds: [], pageSlugs: [], chatRunIds: [], taskRunIds: ["run_1", "run_2"], createdAt: 1, updatedAt: 1,
};
const action: WorkAction = {
  id: "action_a", workItemId: item.id, space: item.space, instruction: "执行检查",
  status: "awaiting_approval", attempt: 2, taskRunIds: ["run_1", "run_2"], createdAt: 1, updatedAt: 2,
};
const run: TaskRun = {
  id: "run_2", taskId: action.id, taskName: "执行检查", space: item.space, workItemId: item.id, workActionId: action.id,
  topic: "检查执行", status: "awaiting_approval", approval: { status: "pending", requestedAt: 1 },
  trigger: "retry", distill: false, priority: "manual", queuedAt: 1, startedAt: 1,
};
const report: WorkActionAcceptance = {
  taskRunId: run.id, attempt: 2, permission: "write", status: "pending", requestedAt: 6, summary: "验收摘要",
  report: { version: 1, outcome: "completed", result: "验收摘要", blockers: [], checks: [],
    evidence: [{ kind: "task_run", id: run.id }, { kind: "page", id: "plans/existing-page" }] },
};

test("a live approval stays visible when the item phase, next instruction or continuation policy changes", () => {
  for (const phase of ["active", "blocked", "completed"] as const) {
    const changed = { ...item, active: false, phase, nextActions: ["已修改步骤"] };
    expect(selectWorkAttention(changed, [action], () => run)).toMatchObject({
      kind: "awaiting_approval", runId: run.id, href: "/tasks/runs/run_2",
    });
  }
  expect(selectWorkAttention({ ...item, phase: "completed" }, [{ ...action, status: "running" }], () => ({ ...run, status: "running" })).kind)
    .toBe("running");
});

test("approval links require the current attempt and matching action ownership, including on legacy items", () => {
  for (const wrong of [
    { ...run, space: "team/oc_other" as const }, { ...run, workItemId: "another" }, { ...run, workActionId: "another" },
    { ...run, taskId: "another" }, { ...run, id: "run_1" }, { ...run, status: "cancelled" as const, finishedAt: 7 },
    { ...run, approval: { status: "approved" as const, requestedAt: 1 } },
  ]) {
    const state = selectWorkAttention(item, [action], () => wrong);
    expect(state.runId).toBeUndefined();
    expect(state.href).not.toContain("/tasks/runs/");
  }
  expect(selectWorkAttention({ ...item, taskRunIds: [] }, [action], () => run).href).toBe(`/tasks/runs/${run.id}`);
  expect(selectWorkAttention(item, [{ ...action, space: "team/oc_other" }], () => run).kind).toBe("normal");
});

test("the pending acceptance belongs to this attempt, and retry preparation never borrows an old result or Run", () => {
  const gate: WorkAction = { ...action, status: "awaiting_acceptance", acceptances: [report] };
  const succeeded: TaskRun = { ...run, status: "succeeded", finishedAt: 5, summary: "旧版写出的摘要" };
  expect(selectWorkAttention(item, [gate], () => succeeded)).toMatchObject({
    kind: "awaiting_acceptance", runId: run.id, href: "/work/work_a#acceptance-action_a-run_2",
  });
  const earlier = { ...report, taskRunId: "run_1", attempt: 1 };
  expect(selectWorkAttention(item, [{ ...gate, acceptances: [earlier] }], () => succeeded).acceptance).toBeUndefined();
  const retry: WorkAction = { ...gate, status: "queued", attempt: 3, acceptances: [{ ...report, status: "rejected" }] };
  const preparing = selectWorkAttention(item, [retry], () => succeeded);
  expect(preparing.kind).toBe("queued");
  expect(preparing.runId).toBeUndefined();
  expect(preparing.acceptance).toBeUndefined();
  expect(preparing.href).toBe("/work/work_a#work-next-action");
  expect(selectWorkAttention(item, [{ ...retry, status: "blocked", error: "等待测试环境" }], () => succeeded))
    .toMatchObject({ kind: "blocked", description: "等待测试环境" });
});

test("ordinary or completed items stay out of the action queue when their historical run is terminal", () => {
  const history = { ...action, status: "succeeded" as const };
  expect(selectWorkAttention(item, [history], () => run).kind).toBe("normal");
  expect(selectWorkAttention({ ...item, phase: "completed" }, [history], () => run).kind).toBe("completed");
  expect(selectWorkAttention(item, [history], () => run).runId).toBeUndefined();
});

test("only idle plan steps consult dependency readiness; existing approvals and runs stay first", () => {
  const child: WorkItem = { ...item, parentWorkItemId: "work_parent" };
  const readPausedParent = () => ({ kind: "parent_paused" as const, title: "父目标" });
  expect(selectWorkAttention(child, [action], () => run, [], [], readPausedParent).kind).toBe("awaiting_approval");
  expect(selectWorkAttention(child, [{ ...action, status: "running" }], () => ({ ...run, status: "running" }), [], [], readPausedParent).kind)
    .toBe("running");
  expect(selectWorkAttention(child, [], () => undefined, [], [], readPausedParent).kind).toBe("blocked");
  expect(selectWorkAttention(item, [], () => undefined, [], [], readPausedParent).kind).toBe("normal");
});
