import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type SpaceId } from "@homeagent/shared";
import {
  DEFAULT_TASK_RUN_APPROVAL_TTL_MS,
  KnowledgeEngine,
  type Task,
  type TaskRun,
} from "@homeagent/core";
import {
  formatTaskApprovalNotification,
  formatTaskRunNotification,
  shouldRunTask,
  TaskScheduler,
} from "./task-scheduler.ts";

const SPACE: SpaceId = "team/oc_tsched";
const SECOND_SPACE: SpaceId = "team/oc_tsched_second";
// Fixed instants in Asia/Shanghai.
const T10 = new Date("2026-07-06T10:00:00+08:00");
const T23 = new Date("2026-07-06T23:00:00+08:00");

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await Bun.sleep(10);
  }
  return predicate();
}

function task(over: Partial<Task>): Task {
  const value = {
    id: "task_1",
    name: "t",
    space: SPACE,
    topic: "x",
    cadence: "daily",
    hour: 8,
    dayOfWeek: 1,
    enabled: true,
    notify: false,
    distillOnRun: false,
    timeoutMinutes: 5,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
  return {
    ...value,
    timeoutMinutes: over.timeoutMinutes ?? value.timeoutMinutes,
  } as Task;
}

describe("shouldRunTask", () => {
  test("approval notification contains a safe review summary", () => {
    const run = {
      id: "run_approval_notice",
      taskId: "task_1",
      taskName: "Repository maintenance",
      space: SPACE,
      topic: "sensitive topic that must stay in the Web review",
      trigger: "scheduled",
      distill: false,
      priority: "scheduled",
      status: "awaiting_approval",
      queuedAt: 1,
      startedAt: 1,
      approval: {
        status: "pending",
        requestedAt: 1,
        expiresAt: 86_400_001,
      },
      approvalNotification: { status: "pending", attempts: 0 },
      executionPlan: {
        version: 1,
        instruction: "secret instruction",
        provider: "codex",
        execution: { permission: "write", workdir: "C:\\secret", skills: [] },
      },
    } satisfies TaskRun;

    const message = formatTaskApprovalNotification(run);
    expect(message).toContain("Repository maintenance");
    expect(message).toContain("write");
    expect(message).toContain("审批截止");
    expect(message).toContain(run.id);
    expect(message).not.toContain("secret instruction");
    expect(message).not.toContain("C:\\secret");
  });

  test("task notification includes persisted skipped-Skill warnings", () => {
    const run = {
      id: "run_skill_warning",
      taskId: "task_1",
      taskName: "Research",
      space: SPACE,
      topic: "x",
      trigger: "scheduled",
      distill: false,
      priority: "scheduled",
      status: "succeeded",
      queuedAt: 1,
      startedAt: 1,
      runStartedAt: 1,
      finishedAt: 2,
      summary: "Completed",
      skillEvidence: {
        requested: [{ kind: "legacy-name", name: "review" }],
        resolved: [],
        skipped: [{
          name: "review",
          code: "ambiguous_legacy_name",
          message: "Legacy Skill name is not bound to an exact source",
        }],
      },
    } satisfies TaskRun;

    const message = formatTaskRunNotification(run);

    expect(message).toContain("Completed");
    expect(message).toContain("review");
    expect(message).toContain("基础 Agent 已继续执行");
    expect(message).not.toContain("Legacy Skill name is not bound");
  });

  test("work action notification distinguishes execution from acceptance", () => {
    const run = {
      id: "run_1",
      taskId: "action_1",
      taskName: "继续：灰度发布",
      workItemId: "work_1",
      workActionId: "action_1",
      space: SPACE,
      topic: "x",
      trigger: "scheduled",
      distill: false,
      priority: "scheduled",
      status: "succeeded",
      queuedAt: 1,
      startedAt: 1,
      runStartedAt: 1,
      finishedAt: 2,
      summary: "命令执行完成",
    } satisfies TaskRun;

    const message = formatTaskRunNotification(run);

    expect(message).toContain("执行已完成，结果已进入验收流程");
    expect(message).not.toContain("任务「继续：灰度发布」已完成");
  });

  test("disabled never runs", () => {
    expect(shouldRunTask(task({ enabled: false }), T10)).toBe(false);
  });

  test("never-run task runs", () => {
    expect(shouldRunTask(task({ lastRunAt: undefined }), T10)).toBe(true);
  });

  test("daily: past hour + not run today -> run; already today -> skip", () => {
    const yesterday = new Date("2026-07-05T09:00:00+08:00").getTime();
    expect(shouldRunTask(task({ cadence: "daily", hour: 8, lastRunAt: yesterday }), T10)).toBe(true);
    const earlierToday = new Date("2026-07-06T08:30:00+08:00").getTime();
    expect(shouldRunTask(task({ cadence: "daily", hour: 8, lastRunAt: earlierToday }), T10)).toBe(false);
  });

  test("daily: before hour -> skip", () => {
    const early = new Date("2026-07-06T06:00:00+08:00");
    expect(shouldRunTask(task({ cadence: "daily", hour: 8, lastRunAt: 0 }), early)).toBe(false);
  });

  test("hourly: >=1h since last -> run; <1h -> skip", () => {
    expect(shouldRunTask(task({ cadence: "hourly", lastRunAt: T23.getTime() - 3600_000 }), T23)).toBe(true);
    expect(shouldRunTask(task({ cadence: "hourly", lastRunAt: T23.getTime() - 600_000 }), T23)).toBe(false);
  });

  test("weekly: runs after the selected weekday/hour only once per week", () => {
    const previousMonday = new Date("2026-06-29T09:00:00+08:00").getTime();
    expect(shouldRunTask(task({
      cadence: "weekly",
      dayOfWeek: 1,
      hour: 8,
      lastRunAt: previousMonday,
    }), T10)).toBe(true);

    const earlierToday = new Date("2026-07-06T08:30:00+08:00").getTime();
    expect(shouldRunTask(task({
      cadence: "weekly",
      dayOfWeek: 1,
      hour: 8,
      lastRunAt: earlierToday,
    }), T10)).toBe(false);

    expect(shouldRunTask(task({
      cadence: "weekly",
      dayOfWeek: 2,
      hour: 8,
      lastRunAt: previousMonday,
    }), T10)).toBe(false);
  });

  test("weekly: a task created after this week's occurrence waits until next week", () => {
    const createdAfterSchedule = new Date("2026-07-06T09:00:00+08:00").getTime();
    expect(shouldRunTask(task({
      cadence: "weekly",
      dayOfWeek: 1,
      hour: 8,
      createdAt: createdAfterSchedule,
      lastRunAt: undefined,
    }), T10)).toBe(false);
  });
});

describe("TaskScheduler.tick", () => {
  let dir: string;
  let engine: KnowledgeEngine;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hb-tsched-"));
    engine = new KnowledgeEngine({
      dataDir: dir,
      runProvider: async () => "研究结果要点",
    });
    engine.ensureSpace(SPACE);
  });

  afterEach(() => {
    engine.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("runs a due task and fires notify on success", async () => {
    const t = engine.tasks.create({ name: "调研", space: SPACE, topic: "x", notify: true })!;
    const notified: string[] = [];
    const sched = new TaskScheduler(engine, { notify: (task) => void notified.push(task.id) });
    const ran = await sched.tick("test", T10);
    expect(ran).toContain(t.id);
    expect(notified).toContain(t.id);
    expect(engine.tasks.get(t.id)?.lastStatus).toBe("ok");
    expect(engine.listTaskRuns(t.id)[0]).toEqual(expect.objectContaining({
      trigger: "scheduled",
      notification: expect.objectContaining({ status: "sent", attempts: 1 }),
    }));
  });

  test("submits every independent due task before awaiting the first completion", async () => {
    engine.close();
    let finishFirst!: (value: string) => void;
    const firstCompletion = new Promise<string>((resolve) => {
      finishFirst = resolve;
    });
    let providerCalls = 0;
    engine = new KnowledgeEngine({
      dataDir: dir,
      runProvider: async () => {
        providerCalls += 1;
        return providerCalls === 1 ? firstCompletion : "第二个任务完成";
      },
    });
    engine.ensureSpace(SPACE);
    engine.ensureSpace(SECOND_SPACE);
    const first = engine.tasks.create({
      name: "慢任务",
      space: SPACE,
      topic: "first",
      notify: true,
      distillOnRun: false,
    })!;
    const second = engine.tasks.create({
      name: "独立任务",
      space: SECOND_SPACE,
      topic: "second",
      notify: true,
      distillOnRun: false,
    })!;
    const notified: string[] = [];
    const scheduler = new TaskScheduler(engine, {
      notify: async (current) => {
        notified.push(current.id);
      },
    });

    const ticking = scheduler.tick("independent-due-tasks", T10);
    const secondRunsBeforeFirstCompletion = engine.listTaskRuns(second.id).length;
    const secondFinishedBeforeFirstCompletion = await waitFor(() => {
      const run = engine.listTaskRuns(second.id)[0];
      return run?.status === "succeeded" && run.notification?.status === "sent";
    });
    finishFirst("第一个任务完成");
    const ran = await ticking;

    expect(secondRunsBeforeFirstCompletion).toBe(1);
    expect(secondFinishedBeforeFirstCompletion).toBeTrue();
    expect(ran).toEqual([first.id, second.id]);
    expect(notified.sort()).toEqual([first.id, second.id].sort());
    expect(engine.listTaskRuns(first.id)[0]?.notification).toEqual(
      expect.objectContaining({ status: "sent", attempts: 1 }),
    );
    expect(engine.listTaskRuns(second.id)[0]?.notification).toEqual(
      expect.objectContaining({ status: "sent", attempts: 1 }),
    );
  });

  test("admits and waits for a due durable Task Run retry", async () => {
    engine.close();
    let providerCalls = 0;
    engine = new KnowledgeEngine({
      dataDir: dir,
      runProvider: async () => {
        providerCalls += 1;
        return "retry recovered";
      },
    });
    engine.ensureSpace(SPACE);
    const t = engine.tasks.create({
      name: "due retry",
      space: SPACE,
      topic: "retry from scheduler",
      distillOnRun: false,
    })!;
    const failed = engine.taskRuns.start({
      task: t,
      trigger: "scheduled",
      provider: "claude",
      executionPlan: {
        version: 1,
        instruction: "Frozen scheduler retry.",
        provider: "claude",
        execution: { permission: "read-only", skills: [] },
      },
      distill: false,
      startedAt: T10.getTime() - 70_000,
    });
    engine.taskRuns.begin(failed.id, T10.getTime() - 69_000);
    engine.taskRuns.fail(failed.id, {
      finishedAt: T10.getTime() - 60_000,
      error: "Error: provider overloaded (503)",
      failure: { phase: "provider", kind: "overloaded", retryable: true },
      retry: {
        attempt: 1,
        maxAttempts: 2,
        status: "waiting",
        nextAttemptAt: T10.getTime(),
      },
    });
    engine.tasks.setLastRun(t.id, {
      at: T10.getTime() - 60_000,
      status: "error",
      error: "Error: provider overloaded (503)",
    });

    const sched = new TaskScheduler(engine);
    expect(await sched.tick("due-retry", T10)).toEqual([]);
    expect(providerCalls).toBe(1);
    const runs = engine.listTaskRuns(t.id);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toEqual(expect.objectContaining({
      status: "succeeded",
      trigger: "retry",
      retryOf: failed.id,
    }));
  });

  test("submits an independent due task before awaiting a slow durable retry", async () => {
    engine.close();
    let finishRetry!: (value: string) => void;
    const retryCompletion = new Promise<string>((resolve) => {
      finishRetry = resolve;
    });
    engine = new KnowledgeEngine({
      dataDir: dir,
      runProvider: async (_provider, input) => (
        input.prompt.includes("slow retry topic")
          ? retryCompletion
          : "独立到期任务完成"
      ),
    });
    engine.ensureSpace(SPACE);
    engine.ensureSpace(SECOND_SPACE);
    const retryTask = engine.tasks.create({
      name: "slow retry",
      space: SPACE,
      topic: "slow retry topic",
      cadence: "hourly",
      notify: true,
      distillOnRun: false,
    })!;
    const failed = engine.taskRuns.start({
      task: retryTask,
      trigger: "scheduled",
      provider: "claude",
      executionPlan: {
        version: 1,
        instruction: "Frozen slow retry.",
        provider: "claude",
        execution: { permission: "read-only", skills: [] },
      },
      distill: false,
      startedAt: T10.getTime() - 3_700_000,
    });
    engine.taskRuns.begin(failed.id, T10.getTime() - 3_690_000);
    engine.taskRuns.fail(failed.id, {
      finishedAt: T10.getTime() - 3_600_000,
      error: "Error: provider overloaded (503)",
      failure: { phase: "provider", kind: "overloaded", retryable: true },
      retry: {
        attempt: 1,
        maxAttempts: 2,
        status: "waiting",
        nextAttemptAt: T10.getTime(),
      },
    });
    engine.tasks.setLastRun(retryTask.id, {
      at: T10.getTime() - 3_600_000,
      status: "error",
      error: "Error: provider overloaded (503)",
    });
    const independent = engine.tasks.create({
      name: "independent due task",
      space: SECOND_SPACE,
      topic: "independent due topic",
      notify: true,
      distillOnRun: false,
    })!;
    const notified: string[] = [];
    const scheduler = new TaskScheduler(engine, {
      notify: async (task) => {
        notified.push(task.id);
      },
    });

    const ticking = scheduler.tick("slow-due-retry", T10);
    const independentRunsBeforeRetryCompletion = engine.listTaskRuns(independent.id).length;
    const retryRunsBeforeRetryCompletion = engine.listTaskRuns(retryTask.id).length;
    const independentFinishedBeforeRetryCompletion = await waitFor(() => {
      const run = engine.listTaskRuns(independent.id)[0];
      return run?.status === "succeeded" && run.notification?.status === "sent";
    });
    finishRetry("重试完成");
    const ran = await ticking;

    expect(independentRunsBeforeRetryCompletion).toBe(1);
    expect(retryRunsBeforeRetryCompletion).toBe(2);
    expect(independentFinishedBeforeRetryCompletion).toBeTrue();
    expect(ran).toEqual([independent.id]);
    expect(engine.listTaskRuns(retryTask.id)).toHaveLength(2);
    expect(notified.sort()).toEqual([retryTask.id, independent.id].sort());
    expect(engine.listTaskRuns(retryTask.id)[0]?.notification).toEqual(
      expect.objectContaining({ status: "sent", attempts: 1 }),
    );
    expect(engine.listTaskRuns(independent.id)[0]?.notification).toEqual(
      expect.objectContaining({ status: "sent", attempts: 1 }),
    );
  });

  test("observes a retry rejection while an approval notification is still pending", async () => {
    let finishApprovalNotification!: () => void;
    const approvalNotification = new Promise<void>((resolve) => {
      finishApprovalNotification = resolve;
    });
    let failRetry!: (error: Error) => void;
    const retryCompletion = new Promise<void>((_resolve, reject) => {
      failRetry = reject;
    });
    const retryTask = task({ id: "task-retry-rejection", notify: false });
    const schedulerEngine = {
      expireTaskRunApprovals: () => [],
      retryDueTaskRuns: () => [{
        run: { id: "run-retry-rejection", taskId: retryTask.id },
        completion: retryCompletion,
      }],
      listTaskRunApprovalsNeedingNotification: () => [{ id: "run-slow-approval" }],
      taskForRun: () => retryTask,
      deliverTaskRunApprovalNotification: () => approvalNotification,
      listTaskRunsNeedingNotification: () => [],
      tasks: { list: () => [] },
      listTaskRuns: () => [],
    } as unknown as KnowledgeEngine;
    const scheduler = new TaskScheduler(schedulerEngine, {
      notifyApproval: async () => {},
    });
    const unhandled: string[] = [];
    const recordUnhandled = (error: unknown) => {
      unhandled.push(String(error));
    };
    process.on("unhandledRejection", recordUnhandled);

    const ticking = scheduler.tick("retry-rejection", T10);
    failRetry(new Error("retry completion failed early"));
    await Bun.sleep(20);
    const earlyUnhandled = [...unhandled];
    finishApprovalNotification();
    const outcome = await ticking.then(
      (ran) => ({ ran }),
      (error) => ({ error: String(error) }),
    );
    process.off("unhandledRejection", recordUnhandled);

    expect(earlyUnhandled).toEqual([]);
    expect(outcome).toEqual({ ran: [] });
    expect(scheduler.health()).toEqual(expect.objectContaining({
      running: false,
      lastStatus: "error",
      lastError: expect.stringContaining("retry completion failed early"),
    }));
  });

  test("persists a notification failure and retries it on a later tick", async () => {
    const t = engine.tasks.create({
      name: "通知恢复",
      space: SPACE,
      topic: "x",
      notify: true,
      distillOnRun: false,
    })!;
    let attempts = 0;
    const sched = new TaskScheduler(engine, {
      notify: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("Feishu network unavailable");
      },
    });

    expect(await sched.tick("initial", T10)).toEqual([t.id]);
    expect(engine.listTaskRuns(t.id)[0]?.notification).toEqual(expect.objectContaining({
      status: "failed",
      attempts: 1,
      error: "Error: Feishu network unavailable",
      nextAttemptAt: T10.getTime() + 60_000,
    }));
    expect(sched.health()).toEqual(expect.objectContaining({
      lastStatus: "error",
      lastError: expect.stringContaining("Feishu network unavailable"),
    }));

    const retryAt = new Date(engine.tasks.get(t.id)!.lastRunAt! + 60_000);
    expect(await sched.tick("notification-retry", retryAt)).toEqual([]);
    expect(attempts).toBe(2);
    expect(engine.listTaskRuns(t.id)[0]?.notification).toEqual(expect.objectContaining({
      status: "sent",
      attempts: 2,
      sentAt: retryAt.getTime(),
    }));
    expect(sched.health()).toEqual(expect.objectContaining({
      lastStatus: "ok",
      lastError: undefined,
    }));
  });

  test("expires approvals before attempting to deliver their notifications", async () => {
    const t = engine.tasks.create({
      name: "expired approval",
      space: SPACE,
      topic: "do not notify stale approval requests",
      distillOnRun: false,
    })!;
    const run = engine.taskRuns.start({
      task: t,
      trigger: "scheduled",
      distill: false,
      startedAt: T10.getTime() - DEFAULT_TASK_RUN_APPROVAL_TTL_MS,
      approvalRequired: true,
      executionPlan: {
        version: 1,
        instruction: "Expired write request.",
        provider: "codex",
        execution: {
          permission: "write",
          workdir: dir,
          skills: [],
        },
      },
    });
    const notified: string[] = [];
    const sched = new TaskScheduler(engine, {
      notifyApproval: async (_task, approvalRun) => {
        notified.push(approvalRun.id);
      },
    });

    expect(await sched.tick("approval-expiry", T10)).toEqual([]);
    expect(notified).toEqual([]);
    expect(engine.getTaskRun(run.id)).toEqual(expect.objectContaining({
      status: "cancelled",
      approval: expect.objectContaining({ status: "expired" }),
    }));
  });

  test("delivers one logical approval notification after restart", async () => {
    const agent = engine.agents.create({
      name: "scheduled writer",
      provider: "codex",
      permission: "write",
      workdir: dir,
    });
    engine.updateSpaceMeta(SPACE, { agentId: agent.id });
    const t = engine.tasks.create({
      name: "durable approval notice",
      space: SPACE,
      topic: "notify after restart",
      distillOnRun: false,
    })!;
    const pending = engine.startTaskRun(t.id, { trigger: "scheduled" }).run;
    engine.close();
    engine = new KnowledgeEngine({ dataDir: dir, runProvider: async () => "must not run" });

    const deliveryKeys: string[] = [];
    const sched = new TaskScheduler(engine, {
      notifyApproval: async (_task, run, deliveryKey) => {
        expect(run.id).toBe(pending.id);
        deliveryKeys.push(deliveryKey);
      },
    });
    const firstTick = new Date(pending.startedAt + 1);
    expect(await sched.tick("approval-notification", firstTick)).toEqual([]);
    expect(engine.getTaskRun(pending.id)?.approvalNotification).toEqual(
      expect.objectContaining({ status: "sent", attempts: 1 }),
    );

    expect(await sched.tick("approval-notification-again", new Date(firstTick.getTime() + 1))).toEqual([]);
    expect(deliveryKeys).toEqual([`ha-appr-${pending.id}`]);
  });

  test("notifies a newly-created scheduled approval in the same tick", async () => {
    const agent = engine.agents.create({
      name: "same-tick writer",
      provider: "codex",
      permission: "write",
      workdir: dir,
    });
    engine.updateSpaceMeta(SPACE, { agentId: agent.id });
    const t = engine.tasks.create({
      name: "same-tick approval",
      space: SPACE,
      topic: "notify without waiting for another cadence",
      distillOnRun: false,
    })!;
    const notified: string[] = [];
    const sched = new TaskScheduler(engine, {
      notifyApproval: async (_task, run) => {
        notified.push(run.id);
      },
    });

    expect(await sched.tick("new-approval", T10)).toEqual([t.id]);
    const run = engine.listTaskRuns(t.id)[0]!;
    expect(run.status).toBe("awaiting_approval");
    expect(notified).toEqual([run.id]);
    expect(engine.getTaskRun(run.id)?.approvalNotification).toEqual(
      expect.objectContaining({ status: "sent", attempts: 1 }),
    );
  });

  test("skips a disabled task and does not notify", async () => {
    const t = engine.tasks.create({ name: "off", space: SPACE, topic: "x", enabled: false, notify: true })!;
    const notified: string[] = [];
    const sched = new TaskScheduler(engine, { notify: (task) => void notified.push(task.id) });
    const ran = await sched.tick("test", T10);
    expect(ran).not.toContain(t.id);
    expect(notified).toEqual([]);
  });

  test("skips a due task that is already running without degrading the loop", async () => {
    engine.close();
    let finish: ((value: string) => void) | undefined;
    engine = new KnowledgeEngine({
      dataDir: dir,
      runProvider: async () => new Promise<string>((resolve) => {
        finish = resolve;
      }),
    });
    engine.ensureSpace(SPACE);
    const task = engine.tasks.create({
      name: "single-flight",
      space: SPACE,
      topic: "x",
      distillOnRun: false,
    })!;
    const active = engine.startTaskRun(task.id, { trigger: "manual" });
    const sched = new TaskScheduler(engine);

    expect(await sched.tick("test", T10)).toEqual([]);
    expect(sched.health()).toEqual(expect.objectContaining({
      lastStatus: "ok",
      lastError: undefined,
    }));
    expect(engine.listTaskRuns(task.id)).toHaveLength(1);

    finish?.("完成");
    await active.completion;
  });

  test("exposes whether the task scheduler loop is started", async () => {
    const sched = new TaskScheduler(engine);

    await sched.start();
    expect(sched.health()).toEqual(
      expect.objectContaining({
        started: true,
        running: false,
        lastStatus: "ok",
        lastSuccessAt: expect.any(Number),
        lastReason: "startup-catchup",
      }),
    );

    sched.stop();
    expect(sched.health().started).toBe(false);
  });

  test("records a startup failure and does not claim the loop started", async () => {
    engine.tasks.list = () => {
      throw new Error("task registry unavailable");
    };
    const sched = new TaskScheduler(engine);

    await expect(sched.start()).rejects.toThrow("task registry unavailable");
    expect(sched.health()).toEqual(
      expect.objectContaining({
        started: false,
        running: false,
        lastStatus: "error",
        lastFailureAt: expect.any(Number),
        lastReason: "startup-catchup",
        lastError: expect.stringContaining("task registry unavailable"),
      }),
    );
  });
});
