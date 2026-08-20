import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeEngine } from "@homeagent/core";
import type { SpaceId } from "@homeagent/shared";
import { WorkContinuationScheduler } from "./work-continuation-scheduler.ts";

const SPACE: SpaceId = "team/work_scheduler";

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
      dataDir: dir,
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
});
