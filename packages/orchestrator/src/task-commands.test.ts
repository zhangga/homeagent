import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetConfig, type SpaceId } from "@homeagent/shared";
import { KnowledgeEngine } from "@homeagent/core";
import { parseTaskCommand, handleTaskCommand } from "./task-commands.ts";

describe("parseTaskCommand", () => {
  test("bare /task and /tasks -> list", () => {
    expect(parseTaskCommand("/task")).toEqual({ verb: "list", arg: "" });
    expect(parseTaskCommand("/tasks")).toEqual({ verb: "list", arg: "" });
    expect(parseTaskCommand("  /task list ")).toEqual({ verb: "list", arg: "" });
  });

  test("new / run carry their argument", () => {
    expect(parseTaskCommand("/task new 大模型进展")).toEqual({ verb: "new", arg: "大模型进展" });
    expect(parseTaskCommand("/task run 2")).toEqual({ verb: "run", arg: "2" });
    expect(parseTaskCommand("/task 新建 每日AI")).toEqual({ verb: "new", arg: "每日AI" });
  });

  test("help and unknown subcommand -> help", () => {
    expect(parseTaskCommand("/task help")).toEqual({ verb: "help", arg: "" });
    expect(parseTaskCommand("/task frobnicate")).toEqual({ verb: "help", arg: "" });
  });

  test("non-task messages return null", () => {
    expect(parseTaskCommand("谁负责后端？")).toBeNull();
    expect(parseTaskCommand("/dream")).toBeNull();
    expect(parseTaskCommand("taskbar 有点卡")).toBeNull();
  });
});

describe("handleTaskCommand", () => {
  let dir: string;
  let engine: KnowledgeEngine;
  const SPACE: SpaceId = "team/oc_cmd";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hb-taskcmd-"));
    process.env.HOMEAGENT_DATA_DIR = dir;
    resetConfig();
    engine = new KnowledgeEngine({ dataDir: dir, runProvider: async () => "ok" });
    engine.ensureSpace(SPACE);
  });

  afterEach(() => {
    engine.close();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.HOMEAGENT_DATA_DIR;
    resetConfig();
  });

  test("list on empty space nudges to create", async () => {
    const reply = await handleTaskCommand(engine, SPACE, { verb: "list", arg: "" });
    expect(reply).toContain("还没有任务");
  });

  test("new creates a daily task in the space", async () => {
    const reply = await handleTaskCommand(engine, SPACE, { verb: "new", arg: "大模型 Agent 进展" });
    expect(reply).toContain("已创建");
    const tasks = engine.tasks.list().filter((t) => t.space === SPACE);
    expect(tasks.length).toBe(1);
    expect(tasks[0]!.topic).toBe("大模型 Agent 进展");
    expect(tasks[0]!.cadence).toBe("daily");
    expect(tasks[0]!.timeoutMinutes).toBe(12);
  });

  test("new without a topic asks for one", async () => {
    const reply = await handleTaskCommand(engine, SPACE, { verb: "new", arg: "" });
    expect(reply).toContain("研究主题");
    expect(engine.tasks.list().length).toBe(0);
  });

  test("list shows created tasks", async () => {
    engine.tasks.create({ name: "任务甲", space: SPACE, topic: "x" });
    engine.tasks.create({
      name: "周报",
      space: SPACE,
      topic: "weekly",
      cadence: "weekly",
      dayOfWeek: 5,
      hour: 17,
    });
    const reply = await handleTaskCommand(engine, SPACE, { verb: "list", arg: "" });
    expect(reply).toContain("任务甲");
    expect(reply).toContain("1.");
    expect(reply).toContain("周报 · 每周五17点");
  });

  test("run by index dispatches the task (fire-and-forget)", async () => {
    const t = engine.tasks.create({ name: "跑我", space: SPACE, topic: "x" })!;
    const ran: string[] = [];
    const reply = await handleTaskCommand(engine, SPACE, { verb: "run", arg: "1" }, { runTask: (id) => ran.push(id) });
    expect(reply).toContain("已开始运行");
    expect(ran).toEqual([t.id]);
  });

  test("run by name works; unknown name is reported", async () => {
    const t = engine.tasks.create({ name: "命名任务", space: SPACE, topic: "x" })!;
    const ran: string[] = [];
    await handleTaskCommand(engine, SPACE, { verb: "run", arg: "命名任务" }, { runTask: (id) => ran.push(id) });
    expect(ran).toEqual([t.id]);
    const miss = await handleTaskCommand(engine, SPACE, { verb: "run", arg: "不存在" }, { runTask: (id) => ran.push(id) });
    expect(miss).toContain("没找到");
    expect(ran).toEqual([t.id]); // unchanged
  });

  test("run scopes to the space (a task in another space is not found)", async () => {
    engine.ensureSpace("team/oc_other");
    engine.tasks.create({ name: "别处任务", space: "team/oc_other", topic: "x" });
    const ran: string[] = [];
    const reply = await handleTaskCommand(engine, SPACE, { verb: "run", arg: "别处任务" }, { runTask: (id) => ran.push(id) });
    expect(reply).toContain("没找到");
    expect(ran).toEqual([]);
  });

  test("run reports the active run instead of claiming a duplicate started", async () => {
    let finish: ((value: string) => void) | undefined;
    const duplicateEngine = new KnowledgeEngine({
      dataDir: join(dir, "duplicate"),
      runProvider: async () => new Promise<string>((resolve) => {
        finish = resolve;
      }),
    });
    duplicateEngine.ensureSpace(SPACE);
    const task = duplicateEngine.tasks.create({
      name: "运行中任务",
      space: SPACE,
      topic: "x",
      distillOnRun: false,
    })!;
    const active = duplicateEngine.startTaskRun(task.id, { trigger: "chat" });

    const reply = await handleTaskCommand(
      duplicateEngine,
      SPACE,
      { verb: "run", arg: task.name },
    );

    expect(reply).toContain("正在运行");
    expect(reply).toContain(active.run.id);
    expect(duplicateEngine.listTaskRuns(task.id)).toHaveLength(1);
    finish?.("完成");
    await active.completion;
    duplicateEngine.close();
  });
});
