import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpaceId } from "@homeagent/shared";
import type { Task } from "./tasks.ts";
import {
  MAX_TASK_RUN_ERROR_CHARACTERS,
  MAX_TASK_RUN_HISTORY_PER_TASK,
  MAX_TASK_RUN_OUTPUT_CHARACTERS,
  TaskRunStore,
} from "./task-runs.ts";

let dir: string;
const SPACE: SpaceId = "team/oc_task_runs";
const TASK: Task = {
  id: "task_history",
  name: "历史任务",
  space: SPACE,
  topic: "记录运行历史",
  cadence: "daily",
  hour: 8,
  enabled: true,
  notify: false,
  distillOnRun: false,
  timeoutMinutes: 5,
  createdAt: 1,
  updatedAt: 1,
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ha-task-runs-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("TaskRunStore", () => {
  test("recovers an interrupted running record as a durable failure", () => {
    const store = new TaskRunStore(dir);
    const run = store.start({ task: TASK, trigger: "manual", distill: false });

    const secondary = new TaskRunStore(dir);
    expect(secondary.get(run.id)?.status).toBe("running");

    const reopened = new TaskRunStore(dir, { recoverInterrupted: true });

    expect(reopened.get(run.id)).toEqual(expect.objectContaining({
      status: "failed",
      error: "应用在任务完成前停止，运行已标记为失败",
      finishedAt: expect.any(Number),
    }));
  });

  test("retains the latest 100 completed runs per task", () => {
    const store = new TaskRunStore(dir);
    for (let index = 0; index <= MAX_TASK_RUN_HISTORY_PER_TASK; index += 1) {
      const run = store.start({ task: TASK, trigger: "scheduled", distill: false });
      store.succeed(run.id, {
        finishedAt: run.startedAt,
        output: `运行输出 ${index}`,
        summary: `运行输出 ${index}`,
      });
    }

    const runs = store.list(TASK.id);
    expect(runs).toHaveLength(MAX_TASK_RUN_HISTORY_PER_TASK);
    expect(runs[0]?.output).toBe("运行输出 100");
    expect(runs.at(-1)?.output).toBe("运行输出 1");
  });

  test("bounds persisted output while recording that it was truncated", () => {
    const store = new TaskRunStore(dir);
    const run = store.start({ task: TASK, trigger: "manual", distill: false });
    store.succeed(run.id, {
      finishedAt: run.startedAt,
      output: "x".repeat(MAX_TASK_RUN_OUTPUT_CHARACTERS + 1),
    });

    expect(store.get(run.id)).toEqual(expect.objectContaining({
      output: "x".repeat(MAX_TASK_RUN_OUTPUT_CHARACTERS),
      outputTruncated: true,
    }));
  });

  test("bounds persisted errors", () => {
    const store = new TaskRunStore(dir);
    const run = store.start({ task: TASK, trigger: "manual", distill: false });
    store.fail(run.id, {
      finishedAt: run.startedAt,
      error: "e".repeat(MAX_TASK_RUN_ERROR_CHARACTERS + 1),
    });

    expect(store.get(run.id)?.error).toBe("e".repeat(MAX_TASK_RUN_ERROR_CHARACTERS));
  });

  test("keeps runs and the monotonic timestamp unchanged when persistence fails", () => {
    const store = new TaskRunStore(dir);
    const persist = (TaskRunStore.prototype as unknown as {
      persist: () => void;
    }).persist.bind(store);
    Object.defineProperty(store, "persist", {
      configurable: true,
      value: () => {
        throw new Error("disk unavailable");
      },
    });

    expect(() => store.start({
      task: TASK,
      trigger: "manual",
      distill: false,
      startedAt: 100,
    })).toThrow("disk unavailable");
    expect(store.list()).toEqual([]);

    Object.defineProperty(store, "persist", { configurable: true, value: persist });
    const run = store.start({
      task: TASK,
      trigger: "manual",
      distill: false,
      startedAt: 100,
    });
    expect(run.startedAt).toBe(100);
  });

  test("persists the Agent execution selected when a run starts", () => {
    const store = new TaskRunStore(dir);

    const run = store.start({
      task: TASK,
      trigger: "manual",
      distill: false,
      agentId: "agent_codex",
      provider: "codex",
      model: "gpt-5.6-luna",
    });

    expect(new TaskRunStore(dir).get(run.id)).toEqual(expect.objectContaining({
      agentId: "agent_codex",
      provider: "codex",
      model: "gpt-5.6-luna",
    }));
  });

  test("lists only exact Agent runs newest first with a bounded limit", () => {
    const store = new TaskRunStore(dir);
    store.start({
      task: TASK,
      trigger: "manual",
      distill: false,
      agentId: "agent_other",
      provider: "claude",
      startedAt: 10,
    });
    const older = store.start({
      task: TASK,
      trigger: "manual",
      distill: false,
      agentId: "agent_codex",
      provider: "codex",
      startedAt: 20,
    });
    const newer = store.start({
      task: TASK,
      trigger: "manual",
      distill: false,
      agentId: "agent_codex",
      provider: "codex",
      startedAt: 30,
    });

    expect(store.listByAgent("agent_codex", 1).map((run) => run.id)).toEqual([newer.id]);
    expect(store.listByAgent("agent_codex", 1000).map((run) => run.id)).toEqual([
      newer.id,
      older.id,
    ]);
    const listed = store.listByAgent("agent_codex");
    listed[0]!.taskName = "mutated";
    expect(store.get(newer.id)?.taskName).toBe(TASK.name);
  });

  test("loads version 2 history but rejects unknown file versions and providers", () => {
    const store = new TaskRunStore(dir);
    const run = store.start({
      task: TASK,
      trigger: "manual",
      distill: false,
      agentId: "agent_legacy",
      provider: "codex",
    });
    const path = join(dir, "config", "task-runs.json");
    const legacy = JSON.parse(readFileSync(path, "utf8")) as {
      version: number;
      runs: Record<string, Record<string, unknown>>;
    };
    legacy.version = 2;
    delete legacy.runs[run.id]!.agentId;
    delete legacy.runs[run.id]!.provider;
    writeFileSync(path, JSON.stringify(legacy), "utf8");
    expect(new TaskRunStore(dir).get(run.id)).toBeDefined();

    legacy.version = 3;
    legacy.runs[run.id]!.provider = "gateway";
    writeFileSync(path, JSON.stringify(legacy), "utf8");
    expect(new TaskRunStore(dir).get(run.id)).toBeUndefined();

    legacy.version = 99;
    delete legacy.runs[run.id]!.provider;
    writeFileSync(path, JSON.stringify(legacy), "utf8");
    expect(new TaskRunStore(dir).list()).toEqual([]);
  });
});
