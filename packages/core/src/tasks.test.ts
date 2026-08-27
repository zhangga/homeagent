import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpaceId } from "@homeagent/shared";
import { TaskStore } from "./tasks.ts";

let dir: string;
const SPACE: SpaceId = "team/oc_task";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hb-tasks-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("TaskStore", () => {
  test("create requires a valid space; defaults + persistence", () => {
    const store = new TaskStore(dir);
    expect(store.create({ name: "x", space: "not-a-space" })).toBeUndefined();

    const t = store.create({ name: "每日AI", space: SPACE, topic: "大模型进展" });
    expect(t).toBeDefined();
    expect(t!.id).toMatch(/^task_/);
    expect(t!.cadence).toBe("daily"); // default
    expect(t!.hour).toBe(8); // default
    expect(t!.dayOfWeek).toBe(1); // Monday, only used by weekly cadence
    expect(t!.enabled).toBe(true);
    expect(t!.notify).toBe(true);
    expect(t!.distillOnRun).toBe(true); // default on
    expect(t!.timeoutMinutes).toBe(360);

    const path = join(dir, "config", "tasks.json");
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8")).tasks[t!.id].topic).toBe("大模型进展");
  });

  test("cadence + schedule fields normalize", () => {
    const store = new TaskStore(dir);
    const a = store.create({ name: "a", space: SPACE, cadence: "weird", hour: 99 });
    expect(a!.cadence).toBe("daily");
    expect(a!.hour).toBe(23); // clamped
    const b = store.create({ name: "b", space: SPACE, cadence: "hourly", hour: 5 });
    expect(b!.cadence).toBe("hourly");
    expect(b!.hour).toBe(5);
    const c = store.create({
      name: "c",
      space: SPACE,
      cadence: "weekly",
      hour: 9,
      dayOfWeek: 99,
    });
    expect(c!.cadence).toBe("weekly");
    expect(c!.hour).toBe(9);
    expect(c!.dayOfWeek).toBe(7);
  });

  test("timeout minutes use the stability-first range", () => {
    const store = new TaskStore(dir);
    expect(store.create({ name: "legacy", space: SPACE, timeoutMinutes: 12 })?.timeoutMinutes).toBe(360);
    expect(store.create({ name: "normal", space: SPACE, timeoutMinutes: 420 })?.timeoutMinutes).toBe(420);
    expect(store.create({ name: "bounded", space: SPACE, timeoutMinutes: 9_999 })?.timeoutMinutes).toBe(1_440);
  });

  test("older persisted tasks backfill the weekly weekday", () => {
    const store = new TaskStore(dir);
    const task = store.create({ name: "legacy", space: SPACE })!;
    const path = join(dir, "config", "tasks.json");
    const file = JSON.parse(readFileSync(path, "utf8"));
    delete file.tasks[task.id].dayOfWeek;
    writeFileSync(path, JSON.stringify(file), "utf8");

    expect(new TaskStore(dir).get(task.id)?.dayOfWeek).toBe(1);
  });

  test("update patches only provided fields", () => {
    const store = new TaskStore(dir);
    const t = store.create({ name: "A", space: SPACE, topic: "x", enabled: true })!;
    const up = store.update(t.id, { enabled: false, topic: "y" });
    expect(up?.enabled).toBe(false);
    expect(up?.topic).toBe("y");
    expect(up?.name).toBe("A");
  });

  test("setLastRun records outcome and survives reload", () => {
    const store = new TaskStore(dir);
    const t = store.create({ name: "A", space: SPACE })!;
    store.setLastRun(t.id, { at: 123, status: "ok", summary: "did it" });
    const reopened = new TaskStore(dir);
    const got = reopened.get(t.id);
    expect(got?.lastRunAt).toBe(123);
    expect(got?.lastStatus).toBe("ok");
    expect(got?.lastSummary).toBe("did it");
  });

  test("setLastRun error keeps prior summary and stores error", () => {
    const store = new TaskStore(dir);
    const t = store.create({ name: "A", space: SPACE })!;
    store.setLastRun(t.id, { at: 1, status: "ok", summary: "good" });
    store.setLastRun(t.id, { at: 2, status: "error", error: "boom" });
    const got = store.get(t.id);
    expect(got?.lastStatus).toBe("error");
    expect(got?.lastError).toBe("boom");
    expect(got?.lastSummary).toBe("good"); // preserved
  });

  test("remove deletes and persists", () => {
    const store = new TaskStore(dir);
    const t = store.create({ name: "A", space: SPACE })!;
    expect(store.remove(t.id)).toBe(true);
    expect(new TaskStore(dir).has(t.id)).toBe(false);
  });

  test("keeps visible task state unchanged when durable persistence fails", () => {
    const store = new TaskStore(dir);
    const task = store.create({
      name: "稳定任务",
      space: SPACE,
      topic: "原始主题",
    })!;
    Object.defineProperty(store, "persist", {
      value: () => {
        throw new Error("disk unavailable");
      },
    });

    expect(() => store.update(task.id, { topic: "不应生效" })).toThrow("disk unavailable");
    expect(store.get(task.id)?.topic).toBe("原始主题");
  });

  test("rejects duplicate restore ids without exposing partial state", () => {
    const store = new TaskStore(dir);
    const task = {
      id: "task_restore",
      name: "恢复任务",
      space: SPACE,
      topic: "恢复",
      cadence: "daily" as const,
      hour: 8,
      dayOfWeek: 1,
      enabled: true,
      notify: false,
      distillOnRun: false,
      timeoutMinutes: 5,
      createdAt: 1,
      updatedAt: 1,
    };

    expect(() => store.restore([task, { ...task }])).toThrow("task id already exists");
    expect(store.list()).toEqual([]);
  });
});
