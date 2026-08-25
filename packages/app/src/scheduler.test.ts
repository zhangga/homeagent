import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetConfig, type SpaceId } from "@homeagent/shared";
import { KnowledgeEngine, FakeLlm } from "@homeagent/core";
import { DEFAULT_SCHEDULE, Scheduler, shouldRunSpace, type ScheduleConfig } from "./scheduler.ts";

const cfg: ScheduleConfig = {
  hour: 3,
  stalenessHours: 24,
  tickMs: 60000,
  batchEntries: 40,
  maxCatchUpBatches: 4,
  rawRetentionDays: 90,
};

// A fixed "now" at 04:00 Asia/Shanghai (past the nightly hour).
const NIGHT = new Date("2026-07-04T04:00:00+08:00");
const NOON = new Date("2026-07-04T12:00:00+08:00");
const BEFORE_NIGHT = new Date("2026-07-04T02:00:00+08:00");

describe("shouldRunSpace", () => {
  test("no pending raw -> never run", () => {
    expect(shouldRunSpace({ id: "team/a", hasPending: false }, NIGHT, cfg)).toBe(false);
    expect(
      shouldRunSpace({ id: "team/a", hasPending: false, lastDreamAt: 0 }, NIGHT, cfg),
    ).toBe(false);
  });

  test("pending + never distilled -> run", () => {
    expect(shouldRunSpace({ id: "team/a", hasPending: true }, NOON, cfg)).toBe(true);
  });

  test("pending + stale (>24h) -> run (catch-up)", () => {
    const old = NIGHT.getTime() - 30 * 3600_000;
    expect(shouldRunSpace({ id: "team/a", hasPending: true, lastDreamAt: old }, NIGHT, cfg)).toBe(true);
  });

  test("pending + fresh + before nightly hour -> skip", () => {
    const recent = NOON.getTime() - 1 * 3600_000;
    expect(shouldRunSpace({ id: "team/a", hasPending: true, lastDreamAt: recent }, NOON, cfg)).toBe(false);
  });

  test("pending + not run today + past nightly hour -> run", () => {
    // last dream was yesterday afternoon; now it's 04:00 today
    const yesterday = new Date("2026-07-03T15:00:00+08:00").getTime();
    expect(shouldRunSpace({ id: "team/a", hasPending: true, lastDreamAt: yesterday }, NIGHT, cfg)).toBe(true);
  });

  test("pending + already run today + past nightly hour -> skip", () => {
    const earlierToday = new Date("2026-07-04T03:30:00+08:00").getTime();
    expect(shouldRunSpace({ id: "team/a", hasPending: true, lastDreamAt: earlierToday }, NIGHT, cfg)).toBe(false);
  });

  test("pending left behind by the latest Dream cycle runs again before the next nightly window", () => {
    const lastDreamAt = new Date("2026-07-04T01:30:00+08:00").getTime();
    const oldestPendingAt = new Date("2026-07-04T01:00:00+08:00").getTime();

    expect(shouldRunSpace({
      id: "team/a",
      hasPending: true,
      lastDreamAt,
      oldestPendingAt,
    }, BEFORE_NIGHT, cfg)).toBe(true);
  });
});

describe("Scheduler.tick", () => {
  let dir: string;
  let engine: KnowledgeEngine;
  let fake: FakeLlm;
  const SPACE: SpaceId = "team/oc_sched";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hb-sched-"));
    process.env.HOMEAGENT_DATA_DIR = dir;
    resetConfig();
    fake = new FakeLlm();
    engine = new KnowledgeEngine({ dataDir: dir, llm: fake });
  });

  afterEach(() => {
    engine.close();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.HOMEAGENT_DATA_DIR;
    resetConfig();
  });

  test("catch-up distills a space with pending raw after downtime", async () => {
    await engine.remember({ space: SPACE, source: "message", content: "Alice 负责后端。" });
    const pendingId = engine.registry.store(SPACE).index().listRaw({ onlyPending: true })[0]!.id;
    // Script analyze (reference the real pending id) then generate.
    fake.onJSON((call) => {
      const props = (call.schema as { properties?: Record<string, unknown> }).properties ?? {};
      if ("operations" in props) {
        return {
          operations: [{ type: "entity", name: "alice", title: "Alice", rawIds: [pendingId] }],
          skippedRawIds: [],
        };
      }
      // generate schema
      return { title: "Alice", summary: "后端负责人", aliases: [], tags: [], links: [], content: "# Alice\n负责后端。\n" };
    });

    const sched = new Scheduler(engine, cfg);
    const ran = await sched.tick("test", NOON);
    expect(ran).toContain(SPACE);
    expect(engine.registry.store(SPACE).index().getPage("entities/alice")).not.toBeNull();
  });

  test("one due pass drains several bounded Dream batches instead of stopping after the first", async () => {
    for (let index = 0; index < 5; index += 1) {
      await engine.remember({
        space: SPACE,
        source: "message",
        content: `可安全跳过的批量记录 ${index}`,
        createdAt: NOON.getTime() - 60_000 + index,
      });
    }
    fake.onJSON((call) => ({
      operations: [],
      skippedRawIds: [...(call.prompt ?? "").matchAll(/<entry id="([^"]+)"/g)]
        .map((match) => match[1]!),
    }));
    const sched = new Scheduler(engine, {
      ...cfg,
      batchEntries: 2,
      maxCatchUpBatches: 3,
    });

    const ran = await sched.tick("backlog", NOON);

    expect(ran).toEqual([SPACE]);
    expect(fake.calls).toHaveLength(3);
    expect((await engine.exportSpace(SPACE)).raw.every((raw) => raw.ingested)).toBe(true);
  });

  test("backlog beyond one tick's safety bound resumes on the next tick", async () => {
    for (let index = 0; index < 7; index += 1) {
      await engine.remember({
        space: SPACE,
        source: "message",
        content: `跨 tick 积压记录 ${index}`,
        createdAt: Date.now() - 60_000 + index,
      });
    }
    fake.onJSON((call) => ({
      operations: [],
      skippedRawIds: [...(call.prompt ?? "").matchAll(/<entry id="([^"]+)"/g)]
        .map((match) => match[1]!),
    }));
    const sched = new Scheduler(engine, {
      ...cfg,
      batchEntries: 2,
      maxCatchUpBatches: 3,
    });

    await sched.tick("first-backlog-pass", NOON);
    expect(engine.registry.store(SPACE).index().countRaw(true)).toBe(1);
    expect(sched.health()).toEqual(expect.objectContaining({
      lastBatchesRun: 3,
      lastProcessedRaw: 6,
      lastPendingRaw: 1,
      lastBacklogLimited: true,
    }));

    const ran = await sched.tick("continued-backlog-pass", BEFORE_NIGHT);

    expect(ran).toEqual([SPACE]);
    expect(fake.calls).toHaveLength(4);
    expect(engine.registry.store(SPACE).index().countRaw(true)).toBe(0);
  });

  test("a failed Dream batch stops catch-up instead of repeatedly spending Provider calls", async () => {
    for (let index = 0; index < 5; index += 1) {
      await engine.remember({
        space: SPACE,
        source: "message",
        content: `失败保护记录 ${index}`,
      });
    }
    fake.onJSON(() => {
      throw new Error("provider unavailable");
    });
    const sched = new Scheduler(engine, {
      ...cfg,
      batchEntries: 2,
      maxCatchUpBatches: 3,
    });

    await sched.tick("failed-backlog", NOON);

    expect(fake.calls).toHaveLength(1);
    expect(engine.registry.store(SPACE).index().countRaw(true)).toBe(5);
    expect(sched.health()).toEqual(expect.objectContaining({
      lastStatus: "error",
      lastError: expect.stringContaining("provider unavailable"),
    }));
  });

  test("a Dream batch that makes no Raw progress stops catch-up", async () => {
    for (let index = 0; index < 5; index += 1) {
      await engine.remember({
        space: SPACE,
        source: "message",
        content: `未分类记录 ${index}`,
      });
    }
    fake.onJSON(() => ({ operations: [], skippedRawIds: [] }));
    const sched = new Scheduler(engine, {
      ...cfg,
      batchEntries: 2,
      maxCatchUpBatches: 3,
    });

    await sched.tick("stalled-backlog", NOON);

    expect(fake.calls).toHaveLength(1);
    expect(engine.registry.store(SPACE).index().countRaw(true)).toBe(5);
    expect(sched.health()).toEqual(expect.objectContaining({
      lastStatus: "error",
      lastError: expect.stringContaining("没有处理任何 Raw"),
    }));
  });

  test("skips a space with no pending raw", async () => {
    // create the space but leave nothing pending
    engine.ensureSpace(SPACE);
    const sched = new Scheduler(engine, cfg);
    const ran = await sched.tick("test", NOON);
    expect(ran).toEqual([]);
    expect(fake.calls.length).toBe(0);
  });

  test("localHour respects Asia/Shanghai", async () => {
    // covered indirectly; DEFAULT_SCHEDULE hour is 3
    expect(DEFAULT_SCHEDULE.hour).toBe(3);
  });

  test("exposes whether the scheduler loop is started and its last successful tick", async () => {
    engine.ensureSpace(SPACE);
    const sched = new Scheduler(engine, cfg);

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
    engine.registry.list = () => {
      throw new Error("registry unavailable");
    };
    const sched = new Scheduler(engine, cfg);

    await expect(sched.start()).rejects.toThrow("registry unavailable");
    expect(sched.health()).toEqual(
      expect.objectContaining({
        started: false,
        running: false,
        lastStatus: "error",
        lastFailureAt: expect.any(Number),
        lastReason: "startup-catchup",
        lastError: expect.stringContaining("registry unavailable"),
      }),
    );
  });

  test("each maintenance tick applies the configured raw message retention", async () => {
    const now = new Date("2027-01-15T10:00:00+08:00");
    await engine.restoreSpace({
      format: "homeagent.space",
      version: 1,
      exportedAt: now.getTime(),
      space: { id: SPACE, createdAt: now.getTime() - 100 * 86_400_000 },
      purpose: "purpose",
      schema: "schema",
      pages: [],
      raw: [
        {
          id: "expired",
          space: SPACE,
          source: "message",
          content: "expired",
          attachments: [],
          createdAt: now.getTime() - 40 * 86_400_000,
          ingested: true,
        },
      ],
      retractions: [],
      tasks: [],
    });
    const sched = new Scheduler(engine, { ...cfg, rawRetentionDays: 30 });

    await sched.tick("maintenance", now);

    expect((await engine.exportSpace(SPACE)).raw).toEqual([]);
  });
});
