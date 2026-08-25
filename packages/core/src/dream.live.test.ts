/**
 * Live dream-cycle test. Skipped unless HOMEAGENT_LIVE=1. Verifies the full
 * two-step distillation against the real gateway produces a sensible page with
 * provenance. Run:
 *   HOMEAGENT_LIVE=1 bun test packages/core/src/dream.live.test.ts
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brandedEnv, resetConfig, type SpaceId } from "@homeagent/shared";
import { SpaceStore } from "./space.ts";
import { runDreamCycle } from "./dream.ts";

const LIVE = brandedEnv(process.env, "LIVE") === "1";
const maybe = LIVE ? describe : describe.skip;

let dir: string;
let store: SpaceStore;
const SPACE: SpaceId = "team/oc_live_dream";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hb-dream-live-"));
  process.env.HOMEAGENT_DATA_DIR = dir;
  resetConfig();
  store = new SpaceStore(SPACE, dir);
  store.ensure();
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.HOMEAGENT_DATA_DIR;
  resetConfig();
});

maybe("dream cycle (live)", () => {
  test("distills messages into pages with provenance", async () => {
    const idx = store.index();
    const id1 = idx.insertRaw({
      space: SPACE,
      source: "message",
      author: "ou_lead",
      content: "我们的后端负责人是 Alice，她主导服务端架构与数据库设计。",
    });
    const id2 = idx.insertRaw({
      space: SPACE,
      source: "message",
      author: "ou_pm",
      content: "项目 Orion 的后端由 Alice 带队，目标是今年 Q4 上线。",
    });
    idx.insertRaw({ space: SPACE, source: "message", content: "哈哈哈哈 😂" }); // noise

    const report = await runDreamCycle(store, { model: "claude-sonnet-5" });
    expect(report.examined).toBe(3);
    expect(report.pagesWritten).toBeGreaterThanOrEqual(1);

    const pages = idx.listPages().filter((p) => p.type !== "map" && !["index", "overview", "log", "glossary"].includes(p.slug));
    expect(pages.length).toBeGreaterThanOrEqual(1);

    // At least one page should trace back to the seeded raw entries.
    const all = idx.allPages().filter((p) => p.type !== "map" && !["index", "overview", "log", "glossary"].includes(p.slug));
    const traced = all.some((p) => p.sources.includes(id1) || p.sources.includes(id2));
    expect(traced).toBe(true);

    // map pages regenerated
    expect(idx.getPage("index")).not.toBeNull();
    console.error("[live dream] pages:", all.map((p) => `${p.slug} <- ${p.sources.join(",")}`));
  }, 120000);
});
