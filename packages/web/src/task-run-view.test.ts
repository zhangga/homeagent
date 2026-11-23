import { describe, expect, test } from "bun:test";
import { MAX_TASK_NOTIFICATION_ATTEMPTS, type Task, type TaskRun } from "@homeagent/core";
import { taskRunRefreshState } from "./task-run-refresh.ts";
import { taskRunView } from "./views.ts";

const task: Task = {
  id: "tk_research", name: "研究任务的新名称", space: "team/oc_research", topic: "当前主题",
  cadence: "daily", hour: 8, dayOfWeek: 1, enabled: true, notify: true, distillOnRun: true,
  timeoutMinutes: 360, createdAt: 1, updatedAt: 100,
};
const snapshot: TaskRun = {
  id: "run_original", taskId: task.id, taskName: "当次任务名称", space: task.space, topic: "冻结的研究主题",
  trigger: "manual", distill: true, priority: "manual", status: "queued", queuedAt: 10, startedAt: 10,
  executionPlan: { version: 1, instruction: "冻结的指令", provider: "codex", model: "frozen-model",
    execution: { permission: "write", workdir: "/tmp/research", skills: [] } },
};

async function render(fields: Partial<TaskRun>) {
  const run = { ...snapshot, ...fields };
  const body = String(await taskRunView(run, task));
  const start = body.indexOf(`<section class="card task-run-result" data-task-run-status="${run.status}">`);
  expect(start).toBeGreaterThan(-1);
  const primary = body.slice(start, body.indexOf("</section>", start));
  const detailsStart = body.indexOf('<details class="card" data-task-run-details>');
  expect(detailsStart).toBeGreaterThan(start);
  return { body, primary, details: body.slice(detailsStart) };
}

describe("Task Run status detail", () => {
  test("success leads with output and evidence, separate from a failed delivery", async () => {
    const { body, primary, details } = await render({ status: "succeeded", rawId: "raw_research",
      pagesWritten: 0, output: "结论 <script> 尚需复核", outputTruncated: true,
      skillEvidence: { requested: [], resolved: [], skipped: [] },
      notification: { status: "failed", attempts: 2, nextAttemptAt: 1000, error: "飞书未收到通知" } });
    expect(primary).toContain("结论 &lt;script&gt; 尚需复核");
    expect(primary).toContain("/spaces/team%2Foc_research/raw/raw_research");
    expect(primary.indexOf("结论")).toBeLessThan(primary.indexOf("查看原始记录"));
    expect(primary).not.toContain(">raw_research<");
    expect(details).toContain(">raw_research<");
    expect(primary).toContain("写入知识页：0");
    expect(primary).toContain("输出过长");
    expect(primary).not.toContain("通知失败");
    expect(body).toContain('/tasks/runs/run_original/notification/retry');
    expect(body).not.toContain('action="/tasks/runs/run_original/retry"');
    expect(details).toContain("冻结的指令");
    expect(details).toContain("Skill 解析");
    expect(body).toContain("<script>");
  });

  test("the approval surface shows the frozen scope and all three decisions", async () => {
    const { body, primary, details } = await render({ status: "awaiting_approval",
      approval: { status: "pending", requestedAt: 12, expiresAt: 1012 } });
    for (const content of [snapshot.topic, "write", "/tmp/research", "审批截止", "批准并执行", "拒绝", "撤销申请"]) {
      expect(primary).toContain(content);
    }
    for (const action of ["approve", "reject", "cancel"]) {
      expect(primary).toContain(`action="/tasks/runs/run_original/${action}"`);
    }
    expect(body).not.toContain(task.topic);
    expect(details).toContain("frozen-model");
    expect(body).toContain("<script>");
  });

  test("long frozen topics and paths keep their full contents available before approval", async () => {
    const topic = "核对这批资料的完整来源。".repeat(40);
    const workdir = "/tmp/" + "research/".repeat(40);
    const { primary } = await render({ topic, status: "awaiting_approval",
      executionPlan: { version: 1, instruction: "", provider: "codex", execution: { permission: "write", workdir, skills: [] } },
      approval: { status: "pending", requestedAt: 12 } });
    expect(primary).toContain(`<summary>查看完整主题</summary><div class="task-run-text">${topic}</div>`);
    expect(primary).toContain(`<summary>查看完整工作目录</summary><div class="task-run-text">${workdir}</div>`);
    expect(primary).toContain("批准并执行");
    const short = await render({ topic: "🐾".repeat(80), status: "awaiting_approval" });
    expect(short.primary).not.toContain("查看完整主题");
  });

  test("failed runs explain manual and scheduled retries, and link a claimed retry to its own run", async () => {
    const failed: Partial<TaskRun> = { status: "failed", error: "服务暂时繁忙",
      failure: { phase: "provider", kind: "overloaded", retryable: true } };
    const { primary, details } = await render({ ...failed,
      retry: { attempt: 1, maxAttempts: 3, status: "waiting", nextAttemptAt: 1000 } });
    expect(primary).toContain("服务暂时繁忙");
    expect(primary).toContain("等待自动重试");
    expect(primary).toContain("取消自动重试");
    expect(primary).toContain('action="/tasks/runs/run_original/retry"');
    expect(primary).toContain("重新审批");
    expect(details).toContain("Provider · overloaded");
    const claimed = await render({ ...failed,
      retry: { attempt: 1, maxAttempts: 3, status: "claimed", claimedByRunId: "run_child" } });
    expect(claimed.primary).toContain('href="/tasks/runs/run_child"');
    expect(claimed.primary).not.toContain("取消自动重试");
    const historical = await render({ ...failed, executionPlan: undefined });
    expect(historical.primary).toContain("没有可执行的冻结计划");
    expect(historical.primary).toContain('action="/tasks/runs/run_original/retry"');
  });

  test("expired decisions cannot be approved and active runs keep the cancel and refresh paths", async () => {
    const expired = await render({ status: "cancelled", approval: { status: "expired", requestedAt: 5, expiresAt: 105 } });
    expect(expired.primary).toContain("审批已过期");
    expect(expired.body).not.toContain('action="/tasks/runs/run_original/approve"');
    expect(expired.body).not.toContain("<script>");
    const timeout = await render({ status: "timed_out", error: "超过运行上限" });
    expect(timeout.primary).toContain("超过运行上限");
    expect(timeout.primary).toContain("重新运行");
    for (const status of ["queued", "running"] as const) {
      const { body, primary } = await render({ status });
      expect(primary).toContain('action="/tasks/runs/run_original/cancel"');
      expect(primary).not.toContain("重新运行");
      expect(body).toContain("<script>");
    }
  });
});

/** Run the script delivered with this page against a controllable status endpoint and clock. */
async function openRunPage(initial: TaskRun) {
  const body = String(await taskRunView(initial, task));
  const script = body.match(/<script>([\s\S]*?)<\/script>/u)?.[1];
  const renderedState = JSON.stringify(taskRunRefreshState(initial));
  expect(body).toContain(`data-task-run-snapshot="${Bun.escapeHTML(renderedState)}"`);
  const path = `/tasks/runs/${initial.id}`;
  let latest = initial, reload = false, timer: (() => Promise<void>) | undefined;
  const document = Object.assign(new EventTarget(), {
    hidden: false,
    querySelector: (selector: string) => selector === "[data-task-run-snapshot]"
      ? { dataset: { taskRunSnapshot: renderedState } } : null,
  });
  if (script) {
    new Function("document", "window", "location", "fetch", "setTimeout", "clearTimeout", script)(
      document, new EventTarget(), { pathname: path, replace: (url: string) => { expect(url).toBe(path); reload = true; } },
      async (url: string) => {
        expect(url).toBe(path + "/status");
        return Response.json(taskRunRefreshState(latest));
      },
      (callback: () => Promise<void>) => { timer = callback; }, () => { timer = undefined; },
    );
  }
  return {
    body, get polling() { return timer !== undefined; },
    async poll(next: TaskRun) {
      latest = next;
      const callback = timer;
      if (!callback) throw new Error("No status poll scheduled");
      timer = undefined;
      await callback();
      return reload;
    },
  };
}

test("an open failed Run follows its automatic retry to the child and retires cancellation", async () => {
  const waiting: TaskRun = { ...snapshot, status: "failed",
    retry: { attempt: 1, maxAttempts: 2, status: "waiting", nextAttemptAt: 1000 } };
  const claimed: TaskRun = { ...waiting,
    retry: { attempt: 1, maxAttempts: 2, status: "claimed", claimedByRunId: "run_child" } };
  const page = await openRunPage(waiting);
  expect(page.body).toContain("取消自动重试");
  // The child may already exist before the first request from this page.
  expect(await page.poll(claimed)).toBe(true);
  const updated = await openRunPage(claimed);
  expect(updated.body).toContain('href="/tasks/runs/run_child"');
  expect(updated.body).not.toContain("取消自动重试");
  expect(updated.polling).toBe(false);
});

test("an open succeeded Run follows notification attempts and stops when delivery settles", async () => {
  const pending: TaskRun = { ...snapshot, status: "succeeded", notification: { status: "pending", attempts: 0 } };
  const failed: TaskRun = { ...pending, notification: { status: "failed", attempts: 1, nextAttemptAt: 2000, error: "暂时无法投递" } };
  const finalAttempt: TaskRun = { ...failed, notification: { status: "pending", attempts: MAX_TASK_NOTIFICATION_ATTEMPTS } };
  const sent: TaskRun = { ...pending, notification: { status: "sent", attempts: MAX_TASK_NOTIFICATION_ATTEMPTS, sentAt: 3000 } };
  const page = await openRunPage(pending);
  expect(await page.poll(pending)).toBe(false);
  expect(await page.poll(failed)).toBe(true);
  const retryPage = await openRunPage(failed);
  expect(retryPage.body).toContain("重试通知");
  expect(await retryPage.poll(finalAttempt)).toBe(true);
  expect(await (await openRunPage(finalAttempt)).poll(sent)).toBe(true);
  const delivered = await openRunPage(sent);
  expect(delivered.body).toContain("已发送");
  expect(delivered.body).not.toContain("重试通知");
  expect(delivered.polling).toBe(false);
  const exhausted = await openRunPage({ ...failed, notification: { ...failed.notification!, attempts: MAX_TASK_NOTIFICATION_ATTEMPTS } });
  expect(exhausted.body).toContain("可手动重试通知");
  expect(exhausted.polling).toBe(false);
});
