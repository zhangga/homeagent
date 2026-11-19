import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeEngine, SkillCatalog } from "@homeagent/core";
import type { TaskRun, WorkAction, WorkActionAcceptance, WorkItem } from "@homeagent/core";
import { createWebApp } from "./app.ts";
import { selectWorkAttention } from "./work-attention.ts";
import { taskRunView, workItemsView } from "./views.ts";

const item: WorkItem = {
  id: "work_review", space: "team/oc_review", title: "核对发布结果", brief: "对照变更清单",
  runbook: "运行检查", phase: "active", active: true, summary: "初稿已完成", blockers: [],
  nextActions: ["核验配置"], rawIds: [], pageSlugs: [], chatRunIds: [], taskRunIds: ["run_a"],
  createdAt: 1, updatedAt: 2,
};
const action: WorkAction = {
  id: "action_a", space: item.space, workItemId: item.id, instruction: item.nextActions[0]!,
  attempt: 1, taskRunIds: ["run_a"], status: "running", createdAt: 2, updatedAt: 3,
};
const run: TaskRun = {
  id: "run_a", space: item.space, workItemId: item.id, workActionId: action.id, taskId: action.id,
  taskName: "核对配置", topic: action.instruction, status: "running", priority: "manual",
  startedAt: 4, queuedAt: 3, distill: false, trigger: "manual",
};
const report: WorkActionAcceptance = {
  taskRunId: run.id, attempt: 1, permission: "write", status: "pending", requestedAt: 8,
  rawId: "raw_a", summary: "核对完成", report: { version: 1, outcome: "completed", result: "版本一致，证据已保存。",
    blockers: [], checks: [{ status: "passed", name: "版本核对" }],
    evidence: [{ kind: "raw", id: "raw_a" }, { kind: "task_run", id: run.id }] },
};
async function render(selected: WorkItem, actions: WorkAction[], runs: TaskRun[],
  ownership?: Pick<NonNullable<Parameters<typeof workItemsView>[6]>, "taskRunBelongs" | "unrelatedChatRunIds">) {
  const attention = selectWorkAttention(selected, actions, id => runs.find(record => record.id === id), [], runs);
  const body = String(await workItemsView([selected], selected, [], actions, undefined, undefined, {
    currentIds: [selected.id], inputs: [], chatRuns: [], attention, ...ownership,
  }));
  const start = body.indexOf('id="work-next-action"');
  const more = body.indexOf('<details class="card work-fold">', start);
  expect(start).toBeGreaterThan(-1);
  expect(more).toBeGreaterThan(start);
  return { body, primary: body.slice(start, more), rest: body.slice(more) };
}

describe("work detail", () => {
  test.each(["accept", "reject"] as const)("a legacy item opens its verified current report directly from the list and supports %s", async choice => {
    const dir = mkdtempSync(join(tmpdir(), "homeagent-work-history-"));
    const engine = new KnowledgeEngine({ dataDir: dir, skillCatalog: new SkillCatalog({ roots: [] }),
      runProvider: async () => "已核对样本" });
    try {
      engine.ensureSpace(item.space);
      const agent = engine.agents.create({ name: "验收", provider: "claude", permission: "write", workdir: dir });
      engine.registry.updateMeta(item.space, { agentId: agent.id });
      const work = engine.workItems.create({ space: item.space, title: "旧版事项", nextActions: ["核对样本"] });
      const started = engine.startWorkContinuation(work.id);
      await engine.approveTaskRun(started.run.id, "operator").completion;
      const [stored] = engine.workItems.removeBySpace(item.space);
      engine.workItems.restore([{ ...stored!, taskRunIds: [] }]);
      const app = createWebApp({ engine });
      const anchor = `acceptance-${started.run.workActionId}-${started.run.id}`;
      const index = await (await app.request("/work")).text();
      expect(index).toContain(`data-work-item="${work.id}" data-work-state="awaiting_acceptance"`);
      expect(index).toContain(`href="/work/${work.id}#${anchor}"`);
      const body = await (await app.request(`/work/${work.id}`)).text();
      const history = body.indexOf("<summary>动作历史");
      const path = `/work/actions/${started.run.workActionId}/${choice}`;
      expect(history).toBeGreaterThan(-1);
      const primary = body.slice(0, history);
      expect(primary).toContain('data-work-attention="awaiting_acceptance"');
      expect(primary).toContain(`id="${anchor}"`);
      expect(primary).toContain(`name="runId" value="${started.run.id}"`);
      expect(primary).toContain(`action="${path}"`);
      expect(body.split(`action="${path}"`)).toHaveLength(2);
      const response = await app.request(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ runId: started.run.id, reason: "核对后需补充材料" }) });
      expect(response.status).toBe(302);
      expect(engine.workContinuations.get(started.run.workActionId!)?.status).toBe(choice === "accept" ? "succeeded" : "blocked");
    } finally {
      engine.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the linked pending report leads with its result and a single pair of decisions", async () => {
    const { body, primary, rest } = await render(item,
      [{ ...action, status: "awaiting_acceptance", acceptances: [report] }],
      [{ ...run, status: "succeeded", finishedAt: 8, summary: report.summary, rawId: report.rawId }]);
    expect(primary).toContain('data-work-attention="awaiting_acceptance"');
    expect(primary).toContain('id="acceptance-action_a-run_a"');
    expect(primary.indexOf(report.report.result)).toBeLessThan(primary.indexOf("执行检查"));
    expect(primary).toContain('class="work-report-audit"');
    expect(primary).toContain('href="/spaces/team%2Foc_review/raw/raw_a"');
    expect(primary).toContain('name="runId" value="run_a"');
    expect(primary).toContain('name="reason" rows="2" required');
    for (const choice of ["accept", "reject"]) {
      expect(body.split(`action="/work/actions/action_a/${choice}"`)).toHaveLength(2);
    }
    expect(rest).toContain("动作历史");
    expect(rest).toContain("编辑事项与计划");
    expect(rest).toContain('action="/work/work_review/continuation"');
  });

  test("history does not offer decisions for an earlier attempt or a known unrelated Run", async () => {
    const legacy = { ...item, taskRunIds: [] };
    const current = { ...action, status: "awaiting_acceptance" as const, acceptances: [report] };
    for (const rendered of [
      await render(legacy, [{ ...current, attempt: 2 }], []),
      await render(legacy, [{ ...current, taskRunIds: ["run_different"] }], []),
      await render(legacy, [current], [], { taskRunBelongs: () => false }),
    ]) {
      expect(rendered.body).not.toContain('action="/work/actions/action_a/accept"');
      expect(rendered.body).not.toContain('action="/work/actions/action_a/reject"');
    }
  });

  test("pending approval points directly to the frozen Run and running work points to progress", async () => {
    const approval = await render(item, [{ ...action, status: "awaiting_approval" }],
      [{ ...run, status: "awaiting_approval", approval: { status: "pending", requestedAt: 4 } }]);
    expect(approval.primary).toContain('href="/tasks/runs/run_a">前往审批</a>');
    expect(approval.primary).not.toContain('/approve"');
    const running = await render(item, [action], [run]);
    expect(running.primary).toContain('href="/tasks/runs/run_a">查看执行进度</a>');
    expect(running.primary).toContain('action="/work/actions/action_a/cancel"');
    expect(running.primary).toContain('name="attempt" value="1"');
    const queued = await render(item, [{ ...action, status: "queued", attempt: 2 }],
      [{ ...run, status: "failed", finishedAt: 5 }]);
    expect(queued.primary).toContain('data-work-attention="queued"');
    expect(queued.primary).not.toContain("查看执行进度");
    expect(queued.rest).toContain('href="/tasks/runs/run_a"');
  });

  test("blocked work exposes its reasons and existing action boundary without losing settings", async () => {
    const projected = "核验配置：检查未通过";
    const blocked = { ...item, phase: "blocked" as const, blockers: ["缺少签署回执", projected],
      actionBlockers: { [action.id]: projected } };
    const { primary, rest } = await render(blocked,
      [{ ...action, status: "blocked", error: "检查未通过" }], [{ ...run, status: "failed", finishedAt: 5 }]);
    expect(primary).toContain('data-work-attention="blocked"');
    expect(primary).toContain("缺少签署回执");
    expect(primary).toContain("检查未通过");
    expect(primary).not.toContain(projected);
    expect(rest).toContain(projected);
    expect(primary).toContain('action="/work/actions/action_a/retry"');
    expect(primary).toContain('action="/work/actions/action_a/abandon"');
    expect(primary).toContain('name="runId" value="run_a"');
    expect(rest).toContain('name="runbook"');
    expect(rest).toContain('action="/work/work_review/activity"');
    const completed = await render({ ...item, phase: "completed" }, [], []);
    expect(completed.primary).toContain("事项已完成");
    expect(completed.primary).toContain(item.summary);
    expect(completed.primary).not.toContain("继续一次");
  });

  test("the approval Run for a work action leads with its instruction and retains the frozen prompt", async () => {
    const waiting: TaskRun = { ...run, status: "awaiting_approval", approval: { status: "pending", requestedAt: 4 },
      topic: "原始执行提示。".repeat(90), executionPlan: { version: 1, instruction: "", provider: "codex",
        execution: { permission: "write", workdir: "/tmp/review", skills: [] } } };
    const page = String(await taskRunView(waiting, undefined, undefined, undefined, { action, item }));
    const beforePrompt = page.slice(page.indexOf('data-task-run-status="awaiting_approval">'), page.indexOf("<details><summary>查看完整冻结任务主题"));
    expect(beforePrompt).toContain("本次动作");
    expect(beforePrompt).toContain(action.instruction);
    expect(beforePrompt).not.toContain("原始执行提示");
    expect(page).toContain(waiting.topic);
    expect(page).toContain("/tmp/review");
    expect(page).toContain('action="/tasks/runs/run_a/approve"');
    const mismatch = String(await taskRunView(waiting, undefined, undefined, undefined,
      { action: { ...action, workItemId: "work_other" }, item }));
    expect(mismatch).not.toContain("<strong>本次动作</strong>");
  });

  test("an unrelated stored Run is not linked or submitted in an action form", async () => {
    const mixed = { ...item, taskRunIds: ["run_old", "run_wrong"], chatRunIds: ["chat_unknown", "chat_wrong"] };
    const historicalAction = { ...action, status: "blocked" as const, taskRunIds: mixed.taskRunIds,
      checkpoint: { completedAt: 4, summary: "历史进展仍保留" } };
    const { body, primary } = await render(mixed, [historicalAction], [], {
      taskRunBelongs: id => id !== "run_wrong", unrelatedChatRunIds: new Set(["chat_wrong"]),
    });
    expect(primary).not.toContain('action="/work/actions/action_a/retry"');
    expect(primary).not.toContain('action="/work/actions/action_a/abandon"');
    expect(body).not.toContain('href="/tasks/runs/run_wrong"');
    expect(body).not.toContain('href="/chats/runs/chat_wrong"');
    expect(body).toContain('href="/tasks/runs/run_old"');
    expect(body).toContain('href="/chats/runs/chat_unknown"');
    expect(body).toContain("历史进展仍保留");
  });
});
