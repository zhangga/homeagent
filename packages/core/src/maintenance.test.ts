import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page, SpaceId } from "@homeagent/shared";
import { KnowledgeEngine } from "./engine.ts";
import { parseSpaceArchive } from "./governance.ts";

const SPACE: SpaceId = "team/oc_maintenance";

let dataDir: string;
let engine: KnowledgeEngine;

function page(overrides: Partial<Page> = {}): Page {
  return {
    slug: "concepts/alpha",
    type: "concept",
    title: "Alpha",
    summary: "Alpha 概念。",
    aliases: [],
    tags: [],
    sources: [],
    links: [],
    content: "# Alpha\n\nAlpha 概念。\n",
    updatedAt: 1,
    contentHash: "alpha-hash",
    ...overrides,
  };
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "homeagent-maintenance-"));
  engine = new KnowledgeEngine({ dataDir });
  engine.ensureSpace(SPACE);
});

afterEach(() => {
  engine.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("Wiki Maintenance cycle", () => {
  test("does not treat generated topic maps as content-page maintenance findings", async () => {
    await engine.upsertPage(SPACE, page({
      slug: "maps/backend",
      type: "map",
      title: "后端",
      summary: "系统生成的主题导航。",
      content: "# 后端\n",
      contentHash: "map-hash",
    }));

    const report = await engine.runWikiMaintenanceCycle(SPACE);

    expect(report.totalPages).toBe(0);
    expect(report.scannedPages).toBe(0);
    expect(report.issues).toEqual([]);
  });

  test("runs without pending Raw and reports broken links without mutating Knowledge pages", async () => {
    await engine.upsertPage(SPACE, page({ links: ["concepts/missing"] }));
    const before = await engine.getPage(SPACE, "concepts/alpha");

    const report = await engine.runWikiMaintenanceCycle(SPACE);

    expect(report.scannedPages).toBe(1);
    expect(report.issues).toContainEqual(expect.objectContaining({
      kind: "broken_link",
      pageSlug: "concepts/alpha",
      targetSlug: "concepts/missing",
    }));
    expect(await engine.getPage(SPACE, "concepts/alpha")).toEqual(before);
  });

  test("never scans or updates another Space", async () => {
    const other = "personal/ou_maintenance_other" as const;
    engine.ensureSpace(other);
    await engine.upsertPage(SPACE, page());
    await engine.upsertPage(other, page({ links: ["concepts/private-missing"] }));

    const report = await engine.runWikiMaintenanceCycle(SPACE);

    expect(report.space).toBe(SPACE);
    expect(report.issues).not.toContainEqual(expect.objectContaining({
      targetSlug: "concepts/private-missing",
    }));
    expect(engine.registry.get(other)?.lastMaintenanceAt).toBeUndefined();
  });

  test("reports Knowledge pages with no incoming content-page links as orphans", async () => {
    await engine.upsertPage(SPACE, page({ links: ["concepts/beta"] }));
    await engine.upsertPage(SPACE, page({
      slug: "concepts/beta",
      title: "Beta",
      summary: "Beta 概念。",
      content: "# Beta\n\nBeta 概念。\n",
      contentHash: "beta-hash",
    }));

    const report = await engine.runWikiMaintenanceCycle(SPACE);

    expect(report.issues.filter((issue) => issue.kind === "orphan_page")).toEqual([
      expect.objectContaining({ pageSlug: "concepts/alpha" }),
    ]);
  });

  test("reports duplicate page identities derived from titles and aliases", async () => {
    await engine.upsertPage(SPACE, page({
      title: "发布流程",
      aliases: ["Release Process"],
    }));
    await engine.upsertPage(SPACE, page({
      slug: "analysis/release",
      type: "analysis",
      title: "Release Process",
      summary: "发布分析。",
      content: "# Release Process\n\n发布分析。\n",
      contentHash: "release-hash",
    }));

    const report = await engine.runWikiMaintenanceCycle(SPACE);

    expect(report.issues).toContainEqual(expect.objectContaining({
      kind: "duplicate_identity",
      pageSlug: "analysis/release",
      targetSlug: "concepts/alpha",
    }));
  });

  test("reports Knowledge pages whose full Markdown exceeds the configured bound", async () => {
    await engine.upsertPage(SPACE, page({ content: `# Alpha\n\n${"甲".repeat(80)}\n` }));

    const report = await engine.runWikiMaintenanceCycle(SPACE, {
      maxPageCharacters: 40,
    });

    expect(report.issues).toContainEqual(expect.objectContaining({
      kind: "oversized_page",
      pageSlug: "concepts/alpha",
    }));
  });

  test("reports provenance ids whose Raw records are no longer available", async () => {
    await engine.upsertPage(SPACE, page({ sources: ["raw-missing"] }));

    const report = await engine.runWikiMaintenanceCycle(SPACE);

    expect(report.issues).toContainEqual(expect.objectContaining({
      kind: "missing_source",
      pageSlug: "concepts/alpha",
      sourceId: "raw-missing",
    }));
  });

  test("reports a content page that has no Raw provenance", async () => {
    await engine.upsertPage(SPACE, page({ sources: [] }));

    const report = await engine.runWikiMaintenanceCycle(SPACE);

    expect(report.issues).toContainEqual(expect.objectContaining({
      kind: "untraceable_page",
      pageSlug: "concepts/alpha",
    }));
  });

  test("reports a page whose newest complete Raw evidence is stale", async () => {
    const sourceCreatedAt = Date.now() - 400 * 24 * 60 * 60 * 1_000;
    const rawId = await engine.remember({
      space: SPACE,
      source: "manual",
      content: "旧版发布策略。",
      createdAt: sourceCreatedAt,
    });
    await engine.upsertPage(SPACE, page({ sources: [rawId] }));

    const report = await engine.runWikiMaintenanceCycle(SPACE);

    expect(report.issues).toContainEqual(expect.objectContaining({
      kind: "stale_evidence",
      pageSlug: "concepts/alpha",
      evidenceAt: sourceCreatedAt,
    }));
  });

  test("reports held or excluded Raw that must not support a Knowledge page", async () => {
    const heldId = "raw-maintenance-held";
    const excludedId = "raw-maintenance-excluded";
    await engine.upsertPage(SPACE, page({ sources: [heldId, excludedId] }));
    const index = engine.registry.store(SPACE).index();
    index.restoreRaw({
      id: heldId,
      space: SPACE,
      source: "task",
      admission: "held",
      workActionId: "action-maintenance-held",
      content: "尚未验收的候选事实",
      createdAt: 1,
      ingested: false,
    });
    index.restoreRaw({
      id: excludedId,
      space: SPACE,
      source: "task",
      admission: "excluded",
      workActionId: "action-maintenance-excluded",
      content: "已经排除的候选事实",
      createdAt: 2,
      ingested: false,
    });

    const report = await engine.runWikiMaintenanceCycle(SPACE);

    expect(report.issues.filter((issue) => issue.kind === "inadmissible_source")).toEqual([
      expect.objectContaining({ sourceId: heldId, sourceAdmission: "held" }),
      expect.objectContaining({ sourceId: excludedId, sourceAdmission: "excluded" }),
    ]);
  });

  test("bounds page inspection and issue output for large Spaces", async () => {
    await engine.upsertPage(SPACE, page({ slug: "concepts/a", title: "A", links: ["missing/a"] }));
    await engine.upsertPage(SPACE, page({ slug: "concepts/b", title: "B", links: ["missing/b"] }));
    await engine.upsertPage(SPACE, page({ slug: "concepts/c", title: "C", links: ["missing/c"] }));

    const report = await engine.runWikiMaintenanceCycle(SPACE, {
      maxPages: 2,
      maxIssues: 1,
    });

    expect(report).toEqual(expect.objectContaining({
      totalPages: 3,
      scannedPages: 2,
      truncated: true,
    }));
    expect(report.issues).toHaveLength(1);
  });

  test("publishes the latest Maintenance result through Knowledge health", async () => {
    await engine.upsertPage(SPACE, page({ links: ["concepts/missing"] }));

    const report = await engine.runWikiMaintenanceCycle(SPACE);
    const health = await engine.health();

    expect(health.details?.maintenanceCycles).toContainEqual(expect.objectContaining({
      space: SPACE,
      running: false,
      lastStatus: "ok",
      lastScannedPages: report.scannedPages,
      lastIssueCount: report.issues.length,
      lastTruncated: report.truncated,
    }));
  });

  test("preserves the last successful cycle timestamp through Space archive restore", async () => {
    await engine.runWikiMaintenanceCycle(SPACE);
    const expectedAt = engine.registry.get(SPACE)?.lastMaintenanceAt;
    const archive = await engine.exportSpace(SPACE);
    const targetDir = mkdtempSync(join(tmpdir(), "homeagent-maintenance-restore-"));
    const target = new KnowledgeEngine({ dataDir: targetDir });

    try {
      await target.restoreSpace(archive);
      expect(target.registry.get(SPACE)?.lastMaintenanceAt).toBe(expectedAt);
    } finally {
      target.close();
      rmSync(targetDir, { recursive: true, force: true });
    }
  });

  test("rejects out-of-bounds persisted Maintenance summaries before restore", async () => {
    await engine.runWikiMaintenanceCycle(SPACE);
    const archive = await engine.exportSpace(SPACE);
    archive.space.lastMaintenanceIssueCount = 5_001;

    expect(() => parseSpaceArchive(archive)).toThrow(
      "space.lastMaintenanceIssueCount must be an integer between 0 and 5000",
    );
  });

  test("reports failure without publishing a successful summary when persistence fails", async () => {
    await engine.upsertPage(SPACE, page());
    const before = await engine.getPage(SPACE, "concepts/alpha");
    const persist = spyOn(engine.registry, "setLastMaintenance")
      .mockImplementation(() => { throw new Error("injected maintenance persistence failure"); });

    try {
      await expect(engine.runWikiMaintenanceCycle(SPACE)).rejects.toThrow(
        "injected maintenance persistence failure",
      );
    } finally {
      persist.mockRestore();
    }

    expect(engine.registry.get(SPACE)?.lastMaintenanceAt).toBeUndefined();
    expect(await engine.getPage(SPACE, "concepts/alpha")).toEqual(before);
    expect((await engine.health()).details?.maintenanceCycles).toContainEqual(
      expect.objectContaining({ space: SPACE, running: false, lastStatus: "error" }),
    );
  });
});
