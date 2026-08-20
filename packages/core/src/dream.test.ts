import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpaceId } from "@homeagent/shared";
import { resetConfig } from "@homeagent/shared";
import { SpaceStore } from "./space.ts";
import { regeneratePageFromSources, runDreamCycle, isCacheHit } from "./dream.ts";
import { FakeLlm } from "./testing.ts";
import type { Page } from "@homeagent/shared";

let dir: string;
let store: SpaceStore;
const SPACE: SpaceId = "team/oc_dream";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hb-dream-"));
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

function seedRaw(content: string): string {
  return store.index().insertRaw({ space: SPACE, source: "message", content });
}

describe("runDreamCycle", () => {
  test("manual page regeneration rejects a held WorkAction Raw before calling the LLM", async () => {
    const readyRawId = seedRaw("Alice 负责发布流程。");
    const heldRawId = store.index().insertRaw({
      space: SPACE,
      source: "task",
      content: "尚未验收的发布结果",
      admission: "held",
      workActionId: "action-held",
    });
    store.writePage({
      slug: "entities/alice",
      type: "entity",
      title: "Alice",
      summary: "负责发布流程。",
      aliases: [],
      tags: [],
      sources: [readyRawId],
      links: [],
      content: "# Alice\n\nAlice 负责发布流程。\n",
      updatedAt: 1,
      contentHash: "existing",
    });
    const fake = new FakeLlm();

    await expect(regeneratePageFromSources(
      store,
      "entities/alice",
      [heldRawId],
      {},
      { client: fake },
    )).rejects.toThrow("尚未通过动作验收");
    expect(fake.calls).toEqual([]);
    expect(store.index().getPage("entities/alice")?.sources).toEqual([readyRawId]);
  });

  test("distills a worthwhile entry into a page with provenance", async () => {
    const id = seedRaw("Alice 是我们的后端负责人，主导服务端架构设计。");
    const fake = new FakeLlm();
    fake.queueJSON({
      operations: [
        { type: "entity", name: "alice", title: "Alice", rawIds: [id], reason: "team member" },
      ],
      skippedRawIds: [],
    });
    fake.queueJSON({
      title: "Alice",
      summary: "后端负责人。",
      aliases: ["爱丽丝"],
      tags: ["team"],
      links: [],
      content: "# Alice\n\nAlice 是后端负责人，主导服务端架构。\n",
    });

    const report = await runDreamCycle(store, {}, { client: fake });
    expect(report.examined).toBe(1);
    expect(report.distilled).toBe(1);
    expect(report.skipped).toBe(0);
    expect(report.pagesWritten).toBe(1);

    const page = store.index().getPage("entities/alice");
    expect(page).not.toBeNull();
    expect(page!.sources).toContain(id); // provenance recorded
    expect(page!.title).toBe("Alice");
    const generationPrompt = fake.calls.filter((call) => call.kind === "json")[1]?.opts.prompt;
    expect(generationPrompt).toContain("aliases 只填写来源或既有页面明确支持");
    expect(generationPrompt).toContain("输出更新后的完整集合");
    expect(generationPrompt).toContain("不要为了提高检索召回而臆造");
    // raw marked ingested
    expect(store.index().countRaw(true)).toBe(0);
  });

  test("source-grounded aliases survive Dream and become FTS candidates", async () => {
    const id = seedRaw("Alice 是线上故障联系人，负责生产事故响应。");
    const fake = new FakeLlm();
    fake.queueJSON({
      operations: [
        { type: "entity", name: "alice", title: "Alice", rawIds: [id], reason: "owner" },
      ],
      skippedRawIds: [],
    });
    fake.queueJSON({
      title: "Alice",
      summary: "生产事故响应负责人。",
      aliases: ["线上故障联系人"],
      tags: ["生产事故"],
      links: [],
      content: "# Alice\n\nAlice 负责生产事故响应。\n",
    });

    await runDreamCycle(store, {}, { client: fake });

    expect(store.index().search("线上故障该找哪位？", 10).map((hit) => hit.slug))
      .toContain("entities/alice");
  });

  test("automatic updates preserve existing search aliases and tags", async () => {
    store.writePage({
      slug: "entities/alice",
      type: "entity",
      title: "Alice",
      summary: "生产事故响应负责人。",
      aliases: ["线上故障联系人"],
      tags: ["生产事故", "应急响应"],
      sources: [],
      links: [],
      content: "# Alice\n\nAlice 负责生产事故响应。\n",
      updatedAt: 1,
      contentHash: "existing",
    });
    const id = seedRaw("Alice 新增负责服务端应急演练。");
    const fake = new FakeLlm();
    fake.queueJSON({
      operations: [
        { type: "entity", name: "alice", title: "Alice", rawIds: [id], reason: "update" },
      ],
      skippedRawIds: [],
    });
    fake.queueJSON({
      title: "Alice",
      summary: "负责生产事故响应与服务端应急演练。",
      links: [],
      content: "# Alice\n\nAlice 负责生产事故响应与服务端应急演练。\n",
    });

    await runDreamCycle(store, {}, { client: fake });

    expect(store.index().getPage("entities/alice")).toEqual(expect.objectContaining({
      aliases: ["线上故障联系人"],
      tags: ["生产事故", "应急响应"],
    }));
  });

  test("automatic updates can replace stale search aliases and tags", async () => {
    store.writePage({
      slug: "entities/alice",
      type: "entity",
      title: "Alice",
      summary: "生产事故响应负责人。",
      aliases: ["线上故障联系人"],
      tags: ["生产事故", "应急响应"],
      sources: [],
      links: [],
      content: "# Alice\n\nAlice 负责生产事故响应。\n",
      updatedAt: 1,
      contentHash: "existing",
    });
    const id = seedRaw("Alice 已转任前端平台负责人，不再负责生产事故响应。");
    const fake = new FakeLlm();
    fake.queueJSON({
      operations: [
        { type: "entity", name: "alice", title: "Alice", rawIds: [id], reason: "update" },
      ],
      skippedRawIds: [],
    });
    fake.queueJSON({
      title: "Alice",
      summary: "前端平台负责人。",
      aliases: ["前端平台负责人"],
      tags: ["前端平台"],
      links: [],
      content: "# Alice\n\nAlice 已转任前端平台负责人，不再负责生产事故响应。\n",
    });

    await runDreamCycle(store, {}, { client: fake });

    expect(store.index().getPage("entities/alice")).toEqual(expect.objectContaining({
      aliases: ["前端平台负责人"],
      tags: ["前端平台"],
    }));
  });

  test("generated search metadata is bounded before indexing", async () => {
    const id = seedRaw("Alice 负责生产事故响应。");
    const fake = new FakeLlm();
    fake.queueJSON({
      operations: [
        { type: "entity", name: "alice", title: "Alice", rawIds: [id], reason: "new" },
      ],
      skippedRawIds: [],
    });
    fake.queueJSON({
      title: "Alice",
      summary: "生产事故响应负责人。",
      aliases: ["x".repeat(500), ...Array.from({ length: 100 }, (_, index) => `alias-${index}`)],
      tags: Array.from({ length: 100 }, (_, index) => `tag-${index}`),
      links: [],
      content: "# Alice\n\nAlice 负责生产事故响应。\n",
    });

    await runDreamCycle(store, {}, { client: fake });

    const generated = store.index().getPage("entities/alice")!;
    expect(generated.aliases).toHaveLength(64);
    expect(generated.tags).toHaveLength(64);
    expect(generated.aliases.every((value) => value.length <= 200)).toBe(true);
  });

  test("skips noise entries without creating pages (Q7)", async () => {
    const noise = seedRaw("哈哈哈");
    const fake = new FakeLlm();
    fake.queueJSON({ operations: [], skippedRawIds: [noise] });

    const report = await runDreamCycle(store, {}, { client: fake });
    expect(report.skipped).toBe(1);
    expect(report.pagesWritten).toBe(0);
    // no CONTENT pages created (a `log` singleton may record the cycle ran)
    const content = store.index().listPages().filter((r) => r.type !== "log");
    expect(content.length).toBe(0);
    expect(store.index().countRaw(true)).toBe(0); // noise still marked ingested
  });

  test("refreshes deterministic map pages after writing content", async () => {
    const id = seedRaw("项目 Orion 是我们的旗舰产品。");
    const fake = new FakeLlm();
    fake.queueJSON({
      operations: [{ type: "entity", name: "orion", title: "Orion", rawIds: [id] }],
      skippedRawIds: [],
    });
    fake.queueJSON({
      title: "Orion",
      summary: "旗舰产品。",
      aliases: [],
      tags: [],
      links: [],
      content: "# Orion\n\n旗舰产品。\n",
    });
    await runDreamCycle(store, {}, { client: fake });
    // index/glossary/overview generated deterministically
    expect(store.index().getPage("index")).not.toBeNull();
    expect(store.index().getPage("glossary")).not.toBeNull();
    expect(store.index().getPage("overview")).not.toBeNull();
    // index links to the new page
    expect(store.index().getPage("index")!.content).toContain("entities/orion");
    // log page appended
    expect(store.index().getPage("log")).not.toBeNull();
  });

  test("quarantines a page when generation fails validation", async () => {
    const id = seedRaw("some content worth a page");
    const fake = new FakeLlm();
    fake.queueJSON({
      operations: [{ type: "concept", name: "thing", title: "Thing", rawIds: [id] }],
      skippedRawIds: [],
    });
    // Bad generate result: empty content -> validation throws
    fake.queueJSON({ title: "Thing", summary: "", content: "   " });

    const report = await runDreamCycle(store, {}, { client: fake });
    expect(report.pagesQuarantined).toBe(1);
    expect(report.pagesWritten).toBe(0);
    const qdir = join(store.root, "quarantine");
    expect(existsSync(qdir)).toBe(true);
    expect(readdirSync(qdir).length).toBe(1);
    // contributing raw still marked ingested so it won't loop
    expect(store.index().countRaw(true)).toBe(0);
  });

  test("empty pending batch is a no-op", async () => {
    const fake = new FakeLlm();
    const report = await runDreamCycle(store, {}, { client: fake });
    expect(report.examined).toBe(0);
    expect(fake.calls.length).toBe(0);
  });

  test("second run with no new raw does not regenerate (incremental)", async () => {
    const id = seedRaw("Bob 负责前端。");
    const fake = new FakeLlm();
    fake.queueJSON({
      operations: [{ type: "entity", name: "bob", title: "Bob", rawIds: [id] }],
      skippedRawIds: [],
    });
    fake.queueJSON({ title: "Bob", summary: "前端。", aliases: [], tags: [], links: [], content: "# Bob\n前端。\n" });
    await runDreamCycle(store, {}, { client: fake });

    // Second run: nothing pending -> no LLM calls
    const fake2 = new FakeLlm();
    const r2 = await runDreamCycle(store, {}, { client: fake2 });
    expect(r2.examined).toBe(0);
    expect(fake2.calls.length).toBe(0);
  });
});

describe("isCacheHit", () => {
  const p = (hash: string): Page => ({
    slug: "x",
    type: "concept",
    title: "x",
    summary: "",
    aliases: [],
    tags: [],
    sources: [],
    links: [],
    content: "c",
    updatedAt: 0,
    contentHash: hash,
  });

  test("miss when no existing page", () => {
    expect(isCacheHit(null, "h", false)).toBe(false);
  });
  test("hit when hash matches and not forced", () => {
    expect(isCacheHit(p("h"), "h", false)).toBe(true);
  });
  test("miss when hash differs", () => {
    expect(isCacheHit(p("h1"), "h2", false)).toBe(false);
  });
  test("force always misses", () => {
    expect(isCacheHit(p("h"), "h", true)).toBe(false);
  });
});
