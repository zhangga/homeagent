import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page, SpaceId } from "@homeagent/shared";
import { KnowledgeEngine } from "./engine.ts";
import { evidenceFreshness } from "./traceability.ts";

const SPACE: SpaceId = "team/oc_traceability";
const DAY_MS = 24 * 60 * 60 * 1_000;

let dataDir: string;
let engine: KnowledgeEngine;

function page(sources: string[]): Page {
  return {
    slug: "concepts/release-policy",
    type: "concept",
    title: "发布策略",
    summary: "团队发布策略。",
    aliases: [],
    tags: ["发布"],
    sources,
    links: [],
    content: "# 发布策略\n\n团队发布策略。\n",
    updatedAt: Date.now(),
    contentHash: "release-policy-hash",
  };
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "homeagent-traceability-"));
  engine = new KnowledgeEngine({ dataDir });
  engine.ensureSpace(SPACE);
});

afterEach(() => {
  engine.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("Knowledge traceability", () => {
  test("classifies exact freshness boundaries and fails closed on an incomplete chain", () => {
    const now = Date.UTC(2026, 7, 25);

    expect(evidenceFreshness(now - 90 * DAY_MS, true, now)).toBe("recent");
    expect(evidenceFreshness(now - 90 * DAY_MS - 1, true, now)).toBe("aging");
    expect(evidenceFreshness(now - 365 * DAY_MS, true, now)).toBe("aging");
    expect(evidenceFreshness(now - 365 * DAY_MS - 1, true, now)).toBe("stale");
    expect(evidenceFreshness(now, false, now)).toBe("unknown");
  });

  test("resolves a Knowledge page to its Raw evidence and reports old evidence as stale", async () => {
    const sourceCreatedAt = Date.now() - 400 * DAY_MS;
    const rawId = await engine.remember({
      space: SPACE,
      source: "manual",
      author: "ou_owner",
      content: "发布窗口固定在每周二。",
      createdAt: sourceCreatedAt,
    });
    await engine.upsertPage(SPACE, page([rawId]));

    const trace = await engine.getKnowledgePageTrace(SPACE, "concepts/release-policy");

    expect(trace).toEqual(expect.objectContaining({
      space: SPACE,
      page: expect.objectContaining({ slug: "concepts/release-policy" }),
      sourceCount: 1,
      latestEvidenceAt: sourceCreatedAt,
      freshness: "stale",
      complete: true,
      truncated: false,
    }));
    expect(trace?.sources).toEqual([expect.objectContaining({
      id: rawId,
      source: "manual",
      admission: "ready",
      author: "ou_owner",
      createdAt: sourceCreatedAt,
    })]);
  });

  test("fails closed when a referenced Raw source is missing", async () => {
    await engine.upsertPage(SPACE, page(["raw-missing"]));

    const trace = await engine.getKnowledgePageTrace(SPACE, "concepts/release-policy");

    expect(trace).toEqual(expect.objectContaining({
      sourceCount: 1,
      sources: [],
      missingSourceIds: ["raw-missing"],
      freshness: "unknown",
      complete: false,
    }));
  });

  test("bounds evidence details while preserving the authoritative source count", async () => {
    const sourceIds = Array.from({ length: 101 }, (_, index) => `raw-missing-${index}`);
    await engine.upsertPage(SPACE, page(sourceIds));

    const trace = await engine.getKnowledgePageTrace(SPACE, "concepts/release-policy");

    expect(trace).toEqual(expect.objectContaining({
      sourceCount: 101,
      freshness: "unknown",
      complete: false,
      truncated: true,
    }));
    expect(trace?.missingSourceIds).toHaveLength(100);
  });
});
