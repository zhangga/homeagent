import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeEngine, SkillCatalog } from "@homeagent/core";
import type { SpaceId } from "@homeagent/shared";
import { WorkContinuationScheduler } from "./work-continuation-scheduler.ts";

const SPACE: SpaceId = "team/work_scheduler";
const SECOND_SPACE: SpaceId = "team/work_scheduler_second";

describe("WorkContinuationScheduler", () => {
  let dir: string;
  let engine: KnowledgeEngine;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "homeagent-work-scheduler-"));
  });

  afterEach(() => {
    engine?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("runs at most one next action per opted-in work item in a tick", async () => {
    let providerCalls = 0;
    engine = new KnowledgeEngine({
      dataDir: dir, skillCatalog: new SkillCatalog({ roots: [] }),
      runProvider: async () => {
        providerCalls += 1;
        return JSON.stringify({
          version: 1,
          outcome: "completed",
          result: `完成动作 ${providerCalls}`,
          blockers: [],
          checks: [{ name: "动作结果核对", status: "passed" }],
        });
      },
    });
    engine.ensureSpace(SPACE);
    const item = engine.workItems.create({
      space: SPACE,
      title: "连续完成发布检查",
      nextActions: ["检查配置", "检查指标"],
    });
    engine.configureWorkContinuation(item.id, true);
    const scheduler = new WorkContinuationScheduler(engine);

    const ran = await scheduler.tick("test");

    expect(ran).toEqual([item.id]);
    expect(providerCalls).toBe(1);
    expect(engine.workItems.get(item.id)?.nextActions).toEqual(["检查指标"]);
  });

  test("startup installs the continuation loop without waiting for a slow recovered action", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    engine = new KnowledgeEngine({ dataDir: dir, skillCatalog: new SkillCatalog({ roots: [] }),
      runProvider: async () => {
        entered.resolve(); await release.promise;
        return JSON.stringify({ version: 1, outcome: "completed", result: "恢复动作已完成",
          blockers: [], checks: [{ name: "恢复检查", status: "passed" }] });
      } });
    engine.ensureSpace(SPACE);
    const item = engine.workItems.create({ space: SPACE, title: "恢复工作计划", nextActions: ["恢复首步"] });
    engine.configureWorkContinuation(item.id, true);
    const scheduler = new WorkContinuationScheduler(engine);
    let listening = false;
    const starting = scheduler.start().then(() => { listening = true; });
    try {
      await entered.promise;
      expect(listening).toBe(true);
      expect(scheduler.health()).toEqual(expect.objectContaining({ started: true, running: true }));
    } finally {
      release.resolve();
      await starting;
      scheduler.stop();
      for (let i = 0; i < 200 && engine.workContinuations.activeForWorkItem(item.id); i++) await Bun.sleep(5);
      expect(engine.workContinuations.list(item.id)[0]?.status).toBe("succeeded");
    }
  });

  test("submits one action for every independent work item before awaiting completion", async () => {
    const bothStarted = Promise.withResolvers<void>();
    let finishFirst!: (value: string) => void;
    const firstCompletion = new Promise<string>((resolve) => {
      finishFirst = resolve;
    });
    let providerCalls = 0;
    engine = new KnowledgeEngine({
      dataDir: dir, skillCatalog: new SkillCatalog({ roots: [] }),
      runProvider: async () => {
        providerCalls += 1;
        if (providerCalls === 1) return firstCompletion;
        bothStarted.resolve();
        return JSON.stringify({
          version: 1,
          outcome: "completed",
          result: "第二个工作项完成",
          blockers: [],
          checks: [{ name: "第二项检查", status: "passed" }],
        });
      },
    });
    engine.ensureSpace(SPACE);
    engine.ensureSpace(SECOND_SPACE);
    const first = engine.workItems.create({
      space: SPACE,
      title: "慢工作项",
      nextActions: ["慢动作", "慢工作项下一轮"],
    });
    const second = engine.workItems.create({
      space: SECOND_SPACE,
      title: "独立工作项",
      nextActions: ["独立动作", "独立工作项下一轮"],
    });
    engine.configureWorkContinuation(first.id, true);
    engine.configureWorkContinuation(second.id, true);
    const scheduler = new WorkContinuationScheduler(engine);

    const ticking = scheduler.tick("independent-work-items");
    await bothStarted.promise;
    const stillDueBeforeFirstCompletion = engine.listDueWorkContinuations()
      .map((item) => item.id);
    finishFirst(JSON.stringify({
      version: 1,
      outcome: "completed",
      result: "第一个工作项完成",
      blockers: [],
      checks: [{ name: "第一项检查", status: "passed" }],
    }));
    const ran = await ticking;

    expect(stillDueBeforeFirstCompletion).toEqual([]);
    expect(ran.sort()).toEqual([first.id, second.id].sort());
    expect(providerCalls).toBe(2);
    expect(engine.workItems.get(first.id)?.nextActions).toEqual(["慢工作项下一轮"]);
    expect(engine.workItems.get(second.id)?.nextActions).toEqual(["独立工作项下一轮"]);
    const runs = engine.listTaskRuns().filter((run) => run.workActionId);
    expect(runs).toHaveLength(2);
    expect(runs.every((run) => run.notification?.status === "pending")).toBeTrue();
  });

  test("observes every submitted completion rejection before an earlier run settles", async () => {
    const submitted = Promise.withResolvers<void>();
    let finishFirst!: () => void;
    const firstCompletion = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    let failSecond!: (error: Error) => void;
    const secondCompletion = new Promise<void>((_resolve, reject) => {
      failSecond = reject;
    });
    const schedulerEngine = {
      listDueWorkContinuations: () => [{ id: "work-first" }, { id: "work-second" }],
      startWorkContinuationAsync: async (workItemId: string) => {
        if (workItemId === "work-second") submitted.resolve();
        return ({
        state: "scheduled" as const,
        completion: workItemId === "work-first" ? firstCompletion : secondCompletion,
      }); },
    } as unknown as KnowledgeEngine;
    const scheduler = new WorkContinuationScheduler(schedulerEngine);
    const unhandled: string[] = [];
    const recordUnhandled = (error: unknown) => {
      unhandled.push(String(error));
    };
    process.on("unhandledRejection", recordUnhandled);

    const ticking = scheduler.tick("early-rejection");
    await submitted.promise;
    failSecond(new Error("second completion failed early"));
    await Bun.sleep(20);
    const earlyUnhandled = [...unhandled];
    finishFirst();
    const outcome = await ticking.then(
      (ran) => ({ ran }),
      (error) => ({ error: String(error) }),
    );
    process.off("unhandledRejection", recordUnhandled);

    expect(earlyUnhandled).toEqual([]);
    expect(outcome).toEqual({ ran: ["work-first", "work-second"] });
    expect(scheduler.health()).toEqual(expect.objectContaining({
      running: false,
      lastStatus: "error",
      lastError: expect.stringContaining("second completion failed early"),
    }));
  });
});
