import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page, SpaceId } from "@homeagent/shared";
import { refreshDigest } from "./digest.ts";
import { KnowledgeEngine } from "./engine.ts";
import { SpaceStore } from "./space.ts";

const SPACE: SpaceId = "team/oc_digest";

function contentPage(
  slug: string,
  title: string,
  summary: string,
  tags: string[],
  updatedAt: number,
): Page {
  return {
    slug,
    type: "concept",
    title,
    summary,
    aliases: [],
    tags,
    sources: [],
    links: [],
    content: `# ${title}\n\n${summary}\n`,
    updatedAt,
    contentHash: `source-${slug}`,
  };
}

describe("refreshDigest", () => {
  let directory: string;
  let store: SpaceStore;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "homeagent-digest-"));
    store = new SpaceStore(SPACE, directory);
    store.ensure();
  });

  afterEach(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test("creates topic maps and keeps the top-level index focused on those maps", () => {
    store.writePage(contentPage(
      "concepts/cache",
      "缓存策略",
      "团队缓存失效约定。",
      ["后端"],
      100,
    ));
    store.writePage(contentPage(
      "concepts/deploy",
      "部署流程",
      "后端服务部署步骤。",
      ["后端"],
      200,
    ));
    store.writePage(contentPage(
      "concepts/interview",
      "用户访谈",
      "产品访谈结论。",
      ["产品"],
      300,
    ));

    refreshDigest(store);

    const backend = store.index().getPage("maps/后端");
    expect(backend).toEqual(expect.objectContaining({
      type: "map",
      title: "后端",
      links: ["concepts/cache", "concepts/deploy"],
    }));
    expect(backend?.content).toContain("[[concepts/cache|缓存策略]]");

    const index = store.index().getPage("index");
    expect(index?.links).toEqual(["maps/产品", "maps/后端"]);
    expect(index?.content).toContain("[[maps/后端|后端]]");
    expect(index?.content).not.toContain("[[concepts/cache");
  });

  test("removes a stale topic map when content moves to another topic", () => {
    store.writePage(contentPage(
      "concepts/cache",
      "缓存策略",
      "团队缓存失效约定。",
      ["后端"],
      100,
    ));
    refreshDigest(store);
    expect(store.index().getPage("maps/后端")).not.toBeNull();

    store.writePage(contentPage(
      "concepts/cache",
      "缓存策略",
      "产品侧缓存体验约定。",
      ["产品"],
      200,
    ));
    refreshDigest(store);

    expect(store.index().getPage("maps/后端")).toBeNull();
    expect(store.index().getPage("maps/产品")?.links).toEqual(["concepts/cache"]);
  });

  test("does not rewrite unchanged navigation pages", () => {
    store.writePage(contentPage(
      "concepts/cache",
      "缓存策略",
      "团队缓存失效约定。",
      ["后端"],
      100,
    ));
    expect(refreshDigest(store)).toBeGreaterThan(0);

    expect(refreshDigest(store)).toBe(0);
  });

  test("bounds top-level topics without hiding pages with long-tail tags", () => {
    for (let index = 0; index < 30; index += 1) {
      store.writePage(contentPage(
        `concepts/item-${index}`,
        `条目 ${index}`,
        `长尾主题条目 ${index}。`,
        [`topic-${index}`],
        index,
      ));
    }

    refreshDigest(store);

    const maps = store.index().allPages().filter((page) => page.type === "map");
    expect(maps).toHaveLength(25);
    expect(new Set(maps.flatMap((page) => page.links)).size).toBe(30);
  });

  test("splits a large topic into bounded second-level maps", () => {
    for (let index = 0; index < 205; index += 1) {
      store.writePage(contentPage(
        `concepts/backend-${index.toString().padStart(3, "0")}`,
        `后端条目 ${index}`,
        `后端知识 ${index}。`,
        ["后端"],
        index,
      ));
    }

    refreshDigest(store);

    const root = store.index().getPage("maps/后端");
    expect(root?.links).toEqual([
      "maps/后端-part-001",
      "maps/后端-part-002",
      "maps/后端-part-003",
    ]);
    const shards = root?.links.map((slug) => store.index().getPage(slug)) ?? [];
    expect(shards.every((page) => page?.type === "map")).toBe(true);
    expect(shards.every((page) => (page?.links.length ?? 0) <= 100)).toBe(true);
    expect(new Set(shards.flatMap((page) => page?.links ?? [])).size).toBe(205);
    expect(store.index().getPage("index")?.links).toEqual(["maps/后端"]);
  });

  test("overview surfaces recent changes and structural knowledge gaps", () => {
    store.writePage(contentPage(
      "concepts/old",
      "旧约定",
      "较早的团队约定。",
      ["后端"],
      100,
    ));
    store.writePage(contentPage(
      "concepts/recent",
      "最新结论",
      "最近更新但尚未归类。",
      [],
      300,
    ));

    refreshDigest(store);

    const overview = store.index().getPage("overview");
    expect(overview?.content).toContain("## 最近更新");
    expect(overview?.content.indexOf("[[concepts/recent|最新结论]]"))
      .toBeLessThan(overview?.content.indexOf("[[concepts/old|旧约定]]") ?? 0);
    expect(overview?.content).toContain("1 个知识页没有主题标签");
    expect(overview?.content).toContain("2 个知识页没有关联其他知识页");
  });

  test("backfills maps for an existing Space when the engine reopens", () => {
    const legacyDirectory = join(directory, "legacy-repository");
    const original = new KnowledgeEngine({ dataDir: legacyDirectory });
    original.ensureSpace(SPACE);
    original.registry.store(SPACE).writePage(contentPage(
      "concepts/cache",
      "缓存策略",
      "团队缓存失效约定。",
      ["后端"],
      100,
    ));
    original.close();

    const reopened = new KnowledgeEngine({ dataDir: legacyDirectory });
    try {
      expect(reopened.registry.store(SPACE).index().getPage("maps/后端")?.links)
        .toEqual(["concepts/cache"]);
    } finally {
      reopened.close();
    }
  });
});
