import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type SpaceId } from "@homeagent/shared";
import { KnowledgeEngine, type Task, type TaskRun } from "@homeagent/core";
import {
  formatTaskRunNotification,
  shouldRunTask,
  TaskScheduler,
} from "./task-scheduler.ts";

const SPACE: SpaceId = "team/oc_tsched";
// Fixed instants in Asia/Shanghai.
const T10 = new Date("2026-07-06T10:00:00+08:00");
const T23 = new Date("2026-07-06T23:00:00+08:00");

function task(over: Partial<Task>): Task {
  const value = {
    id: "task_1",
    name: "t",
    space: SPACE,
    topic: "x",
    cadence: "daily",
    hour: 8,
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
