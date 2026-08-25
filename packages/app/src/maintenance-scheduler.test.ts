import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeEngine } from "@homeagent/core";
import type { SpaceId } from "@homeagent/shared";
import { MaintenanceScheduler, shouldRunMaintenance } from "./maintenance-scheduler.ts";

const SPACE: SpaceId = "team/oc_maintenance_scheduler";

let dataDir: string;
let engine: KnowledgeEngine;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "homeagent-maintenance-scheduler-"));
  engine = new KnowledgeEngine({ dataDir });
  engine.ensureSpace(SPACE);
});

afterEach(() => {
  engine.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("MaintenanceScheduler", () => {
  test("runs missing and expired timestamps but skips a recent successful cycle", () => {
    const now = new Date("2026-08-24T03:00:00Z");
    const config = { intervalHours: 7 * 24, tickMs: 60_000 };

    expect(shouldRunMaintenance(undefined, now, config)).toBe(true);
    expect(shouldRunMaintenance(now.getTime() - 6 * 24 * 3_600_000, now, config)).toBe(false);
    expect(shouldRunMaintenance(now.getTime() - 7 * 24 * 3_600_000, now, config)).toBe(true);
  });

  test("runs a new Space even when it has no pending Raw", async () => {
    const scheduler = new MaintenanceScheduler(engine, {
      intervalHours: 7 * 24,
      tickMs: 60_000,
    });

    const ran = await scheduler.tick("startup-catchup", new Date("2026-08-24T03:00:00Z"));

    expect(ran).toEqual([SPACE]);
    expect(engine.registry.get(SPACE)?.lastMaintenanceAt).toEqual(expect.any(Number));
  });

  test("reuses the persisted timestamp after process reopen", async () => {
    const scheduler = new MaintenanceScheduler(engine);
    const firstNow = new Date();
    expect(await scheduler.tick("startup-catchup", firstNow)).toEqual([SPACE]);

    engine.close();
    engine = new KnowledgeEngine({ dataDir });
    const reopened = new MaintenanceScheduler(engine);

    expect(await reopened.tick("startup-catchup", firstNow)).toEqual([]);
    expect((await engine.health()).details?.maintenanceCycles).toContainEqual(
      expect.objectContaining({
        space: SPACE,
        lastStatus: "ok",
        lastIssueCount: 0,
      }),
    );
  });

  test("contains a Space failure and exposes it through loop health", async () => {
    const failure = spyOn(engine, "runWikiMaintenanceCycle")
      .mockRejectedValue(new Error("maintenance read failed"));
    const scheduler = new MaintenanceScheduler(engine);

    try {
      expect(await scheduler.tick("interval", new Date())).toEqual([]);
      expect(scheduler.health()).toEqual(expect.objectContaining({
        running: false,
        lastStatus: "error",
        lastFailureAt: expect.any(Number),
        lastError: expect.stringContaining("maintenance read failed"),
      }));
    } finally {
      failure.mockRestore();
    }
  });
});
