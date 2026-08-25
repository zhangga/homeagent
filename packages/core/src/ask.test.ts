import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JSONOptions } from "@homeagent/llm";
import type { Page, SpaceId } from "@homeagent/shared";
import { resetConfig } from "@homeagent/shared";
import { SpaceStore } from "./space.ts";
import { ask, buildCatalog, expandGraph, resolveCitations } from "./ask.ts";
import { makeCliClient } from "./cli-client.ts";
import { refreshDigest } from "./digest.ts";
import { FakeLlm } from "./testing.ts";

let dir: string;
let store: SpaceStore;
const SPACE: SpaceId = "team/oc_ask";

function page(slug: string, title: string, content: string, extra: Partial<Page> = {}): Page {
  return {
    slug,
    type: "entity",
    title,
    summary: content.slice(0, 30),
    aliases: [],
    tags: [],
    sources: [],
    links: [],
    content,
    updatedAt: Date.now(),
    contentHash: "h",
    ...extra,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hb-ask-"));
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

// Route by inspecting the schema on the JSON call: the routing schema has a
// `relevant` property, the synthesis schema has `grounded`. This lets one fake
// serve both LLM steps deterministically.
function scriptedLlm(opts: {
  routeSlugs: string[];
  relevant: boolean;
  answer: string;
  grounded: boolean;
  usedSlugs?: string[];
  generalText?: string;
}): FakeLlm {
  const fake = new FakeLlm();
  fake.onJSON((call: JSONOptions<unknown>) => {
    const props = (call.schema as { properties?: Record<string, unknown> }).properties ?? {};
    if ("relevant" in props) {
      return { slugs: opts.routeSlugs, relevant: opts.relevant };
    }
    if ("grounded" in props) {
      return {
        answer: opts.answer,
        grounded: opts.grounded,
        usedSlugs: opts.usedSlugs ?? opts.routeSlugs,
        gaps: [],
      };
    }
    throw new Error("unexpected schema in scripted fake");
  });
  fake.onText(() => opts.generalText ?? "general fallback answer");
  return fake;
}

describe("buildCatalog", () => {
  test("collects content pages and excludes singletons", () => {
    store.writePage(page("entities/alice", "Alice", "后端负责人"));
    store.writePage(page("index", "Index", "toc", { type: "index" }));
    const catalog = buildCatalog([store], "谁负责后端");
    expect(catalog.map((c) => c.ref.slug)).toEqual(["entities/alice"]);
  });

  test("uses a matching topic map to expand a bounded large-space catalog", () => {
    for (let index = 0; index < 61; index += 1) {
      store.writePage(page(
        `concepts/item-${index}`,
        `条目 ${index}`,
        `固定填充内容 ${index}。`,
        { type: "concept", updatedAt: index },
      ));
    }
    refreshDigest(store);

    const catalog = buildCatalog([store], "概念");

    expect(catalog).toHaveLength(60);
    expect(catalog.every((candidate) => candidate.ref.type !== "map")).toBeTrue();
  });

  test("walks a matching root map into bounded second-level maps", () => {
    for (let index = 0; index < 101; index += 1) {
      store.writePage(page(
        `concepts/backend-${index.toString().padStart(3, "0")}`,
        `后端条目 ${index}`,
        `固定填充内容 ${index}。`,
        { type: "concept", tags: ["后端"], updatedAt: index },
      ));
    }
    refreshDigest(store);

    const catalog = buildCatalog([store], "下级地图");

    expect(catalog).toHaveLength(60);
    expect(catalog.every((candidate) => candidate.ref.slug.startsWith("concepts/backend-")))
      .toBeTrue();
  });

});

describe("expandGraph", () => {
  test("follows wikilinks one hop", () => {
    store.writePage(page("entities/alice", "Alice", "见 backend", { links: ["concepts/backend"] }));
    store.writePage(page("concepts/backend", "Backend", "后端"));
    const slugs = expandGraph(store, ["entities/alice"], 8);
    expect(slugs).toContain("entities/alice");
    expect(slugs).toContain("concepts/backend");
  });

  test("follows shared raw sources", () => {
    store.writePage(page("entities/alice", "Alice", "a", { sources: ["raw-1"] }));
    store.writePage(page("entities/orion", "Orion", "o", { sources: ["raw-1"] }));
    const slugs = expandGraph(store, ["entities/alice"], 8);
    expect(slugs).toContain("entities/orion");
  });

  test("respects maxPages cap", () => {
    store.writePage(page("a", "A", "x", { links: ["b"] }));
    store.writePage(page("b", "B", "x", { links: ["c"] }));
    store.writePage(page("c", "C", "x"));
    expect(expandGraph(store, ["a"], 2).length).toBe(2);
  });
});

describe("resolveCitations", () => {
  test("maps slugs to titles, dedupes, preserves order", () => {
    const loaded = [
      { slug: "entities/alice", page: page("entities/alice", "Alice", "x") },
      { slug: "concepts/backend", page: page("concepts/backend", "Backend", "x") },
    ];
    const cites = resolveCitations(["concepts/backend", "entities/alice", "concepts/backend"], loaded);
    expect(cites).toEqual([
      { slug: "concepts/backend", title: "Backend" },
      { slug: "entities/alice", title: "Alice" },
    ]);
  });

  test("ignores slugs not in loaded set", () => {
    const loaded = [{ slug: "a", page: page("a", "A", "x") }];
    expect(resolveCitations(["missing"], loaded)).toEqual([]);
  });

  test("resolves an opaque citation without guessing an ambiguous slug", () => {
    const loaded = [
      {
        slug: "entities/alice",
        key: "source-1",
        page: page("entities/alice", "Team Alice", "x"),
      },
      {
        slug: "entities/alice",
        key: "source-2",
        page: page("entities/alice", "Personal Alice", "x"),
      },
    ];

    expect(resolveCitations(["source-2"], loaded)).toEqual([
      { slug: "entities/alice", title: "Personal Alice" },
    ]);
    expect(resolveCitations(["entities/alice"], loaded)).toEqual([]);
  });
});

describe("ask pipeline", () => {
  test("grounded answer from knowledge base with citations (Q1)", async () => {
    store.writePage(page("entities/alice", "Alice", "Alice 负责后端服务。"));
    const fake = scriptedLlm({
      routeSlugs: ["entities/alice"],
      relevant: true,
      answer: "后端由 [[entities/alice|Alice]] 负责。",
      grounded: true,
      usedSlugs: ["entities/alice"],
    });
    const res = await ask([store], "谁负责后端？", {}, { client: fake });
    expect(res.source).toBe("knowledge");
    expect(res.citations).toEqual([{ slug: "entities/alice", title: "Alice" }]);
    expect(res.answer).toContain("Alice");
  });

  test("grounded citations expose bounded Raw provenance and evidence freshness", async () => {
    const sourceCreatedAt = Date.now() - 400 * 24 * 60 * 60 * 1_000;
    const rawId = store.index().insertRaw({
      space: SPACE,
      source: "manual",
      content: "Alice 负责后端服务。",
      createdAt: sourceCreatedAt,
    });
    store.writePage(page("entities/alice", "Alice", "Alice 负责后端服务。", {
      sources: [rawId],
    }));
    const fake = scriptedLlm({
      routeSlugs: ["entities/alice"],
      relevant: true,
      answer: "后端由 Alice 负责。",
      grounded: true,
      usedSlugs: ["entities/alice"],
    });

    const result = await ask([store], "谁负责后端？", {}, { client: fake });

    expect(result.citations).toEqual([{
      slug: "entities/alice",
      title: "Alice",
      evidence: {
        sourceCount: 1,
        latestSourceAt: sourceCreatedAt,
        freshness: "stale",
        complete: true,
      },
    }]);
  });

  test("synthesis receives evidence time and conflict guidance without Raw ids", async () => {
    const sourceCreatedAt = Date.UTC(2025, 0, 2);
    const rawId = store.index().insertRaw({
      space: SPACE,
      source: "manual",
      content: "Alice 负责后端服务。",
      createdAt: sourceCreatedAt,
    });
    store.writePage(page("entities/alice", "Alice", "Alice 负责后端服务。", {
      sources: [rawId],
    }));
    const fake = new FakeLlm();
    fake.onJSON((call) => {
      const properties = (call.schema as { properties?: Record<string, unknown> }).properties ?? {};
      if ("relevant" in properties) {
        return { slugs: ["entities/alice"], relevant: true };
      }
      const prompt = String(call.prompt);
      expect(prompt).toContain(`latestEvidenceAt="${sourceCreatedAt}"`);
      expect(prompt).toContain("优先采用证据更新且证据链完整的页面");
      expect(prompt).not.toContain(rawId);
      return {
        answer: "后端由 Alice 负责。",
        grounded: true,
        usedSlugs: ["entities/alice"],
        gaps: [],
      };
    });

    await expect(ask([store], "谁负责后端？", {}, { client: fake }))
      .resolves.toEqual(expect.objectContaining({ source: "knowledge" }));
  });

  test("a large catalog routes bounded batches when literal FTS has no candidates", async () => {
    for (let index = 0; index < 60; index += 1) {
      store.writePage(page(
        `concepts/filler-${index}`,
        `普通条目 ${index}`,
        `固定评测填充内容 ${index}。`,
        { updatedAt: 100 + index },
      ));
    }
    store.writePage(page(
      "entities/alice-incident",
      "Alice",
      "Alice 负责生产事故响应。",
      { updatedAt: 1 },
    ));
    const fake = scriptedLlm({
      routeSlugs: ["entities/alice-incident"],
      relevant: true,
      answer: "线上故障应联系 Alice。",
      grounded: true,
      usedSlugs: ["entities/alice-incident"],
    });

    const result = await ask([store], "线上故障该找哪位？", {}, { client: fake });

    expect(result).toEqual(expect.objectContaining({
      source: "knowledge",
      citations: [{ slug: "entities/alice-incident", title: "Alice" }],
    }));
    expect(fake.calls.filter((call) => call.kind === "json")).toHaveLength(3);
  });

  test("a large catalog retries bounded routing when literal candidates are irrelevant", async () => {
    for (let index = 0; index < 59; index += 1) {
      store.writePage(page(
        `concepts/filler-${index}`,
        `普通条目 ${index}`,
        `固定评测填充内容 ${index}。`,
        { updatedAt: 100 + index },
      ));
    }
    store.writePage(page(
      "concepts/incident-words",
      "线上故障词汇",
      "这个页面只解释线上故障这个短语。",
      { updatedAt: 1_000 },
    ));
    store.writePage(page(
      "entities/alice-incident",
      "Alice",
      "Alice 负责生产事故响应。",
      { updatedAt: 1 },
    ));
    const fake = new FakeLlm();
    fake.onJSON((call) => {
      const properties = (call.schema as { properties?: Record<string, unknown> }).properties ?? {};
      if ("relevant" in properties) {
        return String(call.prompt).includes("entities/alice-incident")
          ? { slugs: ["entities/alice-incident"], relevant: true }
          : { slugs: [], relevant: false };
      }
      return {
        answer: "线上故障应联系 Alice。",
        grounded: true,
        usedSlugs: ["entities/alice-incident"],
        gaps: [],
      };
    });
    fake.onText(() => "general fallback answer");

    const result = await ask([store], "线上故障该找哪位？", {}, { client: fake });

    expect(result).toEqual(expect.objectContaining({
      source: "knowledge",
      citations: [{ slug: "entities/alice-incident", title: "Alice" }],
    }));
    expect(fake.calls.filter((call) => call.kind === "json")).toHaveLength(4);
  });

  test("large-catalog fallback never exceeds four routing batches", async () => {
    for (let index = 0; index < 241; index += 1) {
      store.writePage(page(
        `concepts/bounded-${index}`,
        `普通条目 ${index}`,
        `固定评测填充内容 ${index}。`,
        { updatedAt: index },
      ));
    }
    const fake = scriptedLlm({
      routeSlugs: [],
      relevant: false,
      answer: "",
      grounded: false,
      generalText: "知识库没有相关记录。",
    });

    const result = await ask([store], "完全不相关的未知主题", {}, { client: fake });

    expect(result.source).toBe("general");
    expect(fake.calls.filter((call) => call.kind === "json")).toHaveLength(4);
  });

  test("large-catalog fallback gives later spaces a bounded routing batch", async () => {
    const other = new SpaceStore("team/oc_ask_other", dir);
    other.ensure();
    try {
      for (let index = 0; index < 240; index += 1) {
        store.writePage(page(
          `concepts/primary-${index}`,
          `主空间条目 ${index}`,
          `主空间固定填充内容 ${index}。`,
          { updatedAt: index },
        ));
      }
      for (let index = 0; index < 60; index += 1) {
        other.writePage(page(
          `concepts/secondary-${index}`,
          `次空间条目 ${index}`,
          `次空间固定填充内容 ${index}。`,
          { updatedAt: 100 + index },
        ));
      }
      other.writePage(page(
        "entities/alice-incident",
        "Alice",
        "Alice 负责生产事故响应。",
        { updatedAt: 1 },
      ));
      const fake = scriptedLlm({
        routeSlugs: ["entities/alice-incident"],
        relevant: true,
        answer: "线上故障应联系 Alice。",
        grounded: true,
        usedSlugs: ["entities/alice-incident"],
      });

      const result = await ask(
        [store, other],
        "线上故障该找哪位？",
        {},
        { client: fake },
      );

      expect(result).toEqual(expect.objectContaining({
        source: "knowledge",
        citations: [{ slug: "entities/alice-incident", title: "Alice" }],
      }));
      expect(fake.calls.filter((call) => call.kind === "json")).toHaveLength(4);
    } finally {
      other.close();
    }
  });

  test("bounded fallback represents every space before taking more from one", async () => {
    const extras = Array.from({ length: 4 }, (_, index) => {
      const candidate = new SpaceStore(`team/oc_fair_${index}` as SpaceId, dir);
      candidate.ensure();
      return candidate;
    });
    const stores = [store, ...extras];
    try {
      for (const [spaceIndex, candidate] of stores.entries()) {
        for (let index = 0; index < 60; index += 1) {
          candidate.writePage(page(
            `concepts/fair-${spaceIndex}-${index}`,
            `空间 ${spaceIndex} 条目 ${index}`,
            `固定填充内容 ${spaceIndex}-${index}。`,
            { updatedAt: index },
          ));
        }
        candidate.writePage(page(
          spaceIndex === stores.length - 1 ? "entities/alice-incident" : `concepts/fair-${spaceIndex}-60`,
          spaceIndex === stores.length - 1 ? "Alice" : `空间 ${spaceIndex} 条目 60`,
          spaceIndex === stores.length - 1
            ? "Alice 负责生产事故响应。"
            : `固定填充内容 ${spaceIndex}-60。`,
          { updatedAt: 10_000 },
        ));
      }
      const fake = scriptedLlm({
        routeSlugs: ["entities/alice-incident"],
        relevant: true,
        answer: "线上故障应联系 Alice。",
        grounded: true,
        usedSlugs: ["entities/alice-incident"],
      });

      const result = await ask(
        stores,
        "线上故障该找哪位？",
        {},
        { client: fake },
      );

      expect(result).toEqual(expect.objectContaining({
        source: "knowledge",
        citations: [{ slug: "entities/alice-incident", title: "Alice" }],
      }));
    } finally {
      for (const candidate of extras) candidate.close();
    }
  });

  test("opaque routing does not expose spaces or mix pages that share a slug", async () => {
    const personalSpace: SpaceId = "personal/ou_ask";
    const personal = new SpaceStore(personalSpace, dir);
    personal.ensure();
    try {
      store.writePage(page(
        "entities/alice",
        "Team Alice",
        "This team-space page contains the wrong Alice record.",
      ));
      personal.writePage(page(
        "entities/alice",
        "Personal Alice",
        "This personal-space page is the intended Alice record.",
      ));
      const fake = new FakeLlm();
      fake.onJSON((call) => {
        const properties = (call.schema as { properties?: Record<string, unknown> }).properties ?? {};
        if ("relevant" in properties) {
          const prompt = String(call.prompt);
          expect(prompt).not.toContain(SPACE);
          expect(prompt).not.toContain(personalSpace);
          const personalLine = prompt.split("\n").find((line) => line.includes("Personal Alice"));
          const candidateKey = personalLine?.match(/^- (page-\d+)/u)?.[1];
          expect(candidateKey).toBeDefined();
          return { slugs: [candidateKey!], relevant: true };
        }
        expect(String(call.prompt)).toContain("intended Alice record");
        expect(String(call.prompt)).not.toContain("wrong Alice record");
        return {
          answer: "Use the personal Alice record.",
          grounded: true,
          usedSlugs: ["entities/alice"],
          gaps: [],
        };
      });
      fake.onText(() => "general fallback answer");
      let evidence: unknown;

      const result = await ask(
        [store, personal],
        "Resolve the ambiguous Alice reference.",
        {},
        {
          client: fake,
          onRetrieval: (value) => {
            evidence = value;
          },
        },
      );

      expect(result).toEqual(expect.objectContaining({
        source: "knowledge",
        citations: [{ slug: "entities/alice", title: "Personal Alice", space: personalSpace }],
      }));
      expect(evidence).toEqual({
        pages: [{
          space: personalSpace,
          slug: "entities/alice",
          contentHash: "h",
        }],
      });
    } finally {
      personal.close();
    }
  });

  test("reports the exact loaded page hashes used by the retrieval pipeline", async () => {
    store.writePage(page("entities/alice", "Alice", "backend owner", {
      contentHash: "sha256-source-alice",
    }));
    const fake = scriptedLlm({
      routeSlugs: ["entities/alice"],
      relevant: true,
      answer: "Alice owns the backend.",
      grounded: true,
      usedSlugs: ["entities/alice"],
    });
    let evidence: unknown;

    await ask([store], "Who owns the backend?", {}, {
      client: fake,
      onRetrieval: (value) => {
        evidence = value;
      },
    });

    expect(evidence).toEqual({
      pages: [{
        space: SPACE,
        slug: "entities/alice",
        contentHash: "sha256-source-alice",
      }],
    });
  });

  test("out-of-KB question falls back to general (Q1)", async () => {
    store.writePage(page("entities/alice", "Alice", "Alice 负责后端服务。"));
    const fake = scriptedLlm({
      routeSlugs: [],
      relevant: false,
      answer: "",
      grounded: false,
      generalText: "北京今天多云。（这不在知识库记录中）",
    });
    const res = await ask([store], "北京今天天气如何？", {}, { client: fake });
    expect(res.source).toBe("general");
    expect(res.citations).toEqual([]);
    expect(res.answer).toContain("北京");
    expect(fake.calls.filter((call) => call.kind === "json")).toHaveLength(1);
  });

  test("empty knowledge base uses general fallback (Q3 cold start)", async () => {
    const fake = scriptedLlm({
      routeSlugs: [],
      relevant: false,
      answer: "",
      grounded: false,
      generalText: "知识库为空，这是通用回答。",
    });
    const res = await ask([store], "随便问点什么", {}, { client: fake });
    expect(res.source).toBe("general");
    // routing/synthesis should not have been called on an empty KB
    expect(fake.calls.filter((c) => c.kind === "json").length).toBe(0);
  });

  test("general fallback preserves visual inputs from the user turn", async () => {
    const fake = scriptedLlm({
      routeSlugs: [],
      relevant: false,
      answer: "",
      grounded: false,
      generalText: "这顿晚餐的摆盘很用心。",
    });

    await ask(
      [store],
      "分析下这顿晚餐",
      { images: [{ path: "/tmp/dinner.png" }] },
      { client: fake },
    );

    const call = fake.calls.find((candidate) => candidate.kind === "complete");
    expect(call?.opts.images).toEqual([{ path: "/tmp/dinner.png" }]);
  });

  test("general conversation asks one natural clarification when the user's goal is unclear", async () => {
    const fake = scriptedLlm({
      routeSlugs: [],
      relevant: false,
      answer: "",
      grounded: false,
      generalText: "你希望我总结、分析，还是记录上面的内容？",
    });

    await ask([store], "帮我处理一下这个", {}, { client: fake });

    const call = fake.calls.find((candidate) => candidate.kind === "complete");
    expect(String(call?.opts.system)).toContain("意图或指代不清");
    expect(String(call?.opts.system)).toContain("只追问一个");
    expect(String(call?.opts.prompt)).toContain("帮我处理一下这个");
  });

  test("general fallback preserves that the bound Agent workdir was available", async () => {
    const fake = scriptedLlm({
      routeSlugs: [],
      relevant: false,
      answer: "",
      grounded: false,
      generalText: "后端由 Alice 负责。",
    });

    const res = await ask(
      [store],
      "谁负责后端？",
      { fallbackContext: "agent-workdir" },
      { client: fake },
    );

    expect(res.context).toBe("agent-workdir");
    expect(res.answer).toBe("后端由 Alice 负责。");
    const call = fake.calls.find((candidate) => candidate.kind === "complete");
    expect(String(call?.opts.system)).toContain("绑定工作目录");
    expect(String(call?.opts.system)).not.toContain("以下是我的一般性回答");
  });

  test("knowledgeOnly never falls back to general", async () => {
    const fake = scriptedLlm({ routeSlugs: [], relevant: false, answer: "", grounded: false });
    const res = await ask([store], "x", { knowledgeOnly: true }, { client: fake });
    expect(res.source).toBe("general");
    expect(res.answer).toBe("");
    // no general text call made
    expect(fake.calls.some((c) => c.kind === "complete")).toBe(false);
  });

  test("synthesis not grounded -> general fallback", async () => {
    store.writePage(page("entities/alice", "Alice", "Alice 负责后端。"));
    const fake = scriptedLlm({
      routeSlugs: ["entities/alice"],
      relevant: true,
      answer: "",
      grounded: false,
      generalText: "通用回答。",
    });
    const res = await ask([store], "问一个页面答不了的问题", {}, { client: fake });
    expect(res.source).toBe("general");
  });

  test("runs the whole pipeline through a CLI-backed client", async () => {
    store.writePage(page("entities/alice", "Alice", "Alice 负责后端服务。"));
    // A CLI client whose runner returns JSON for structured calls (route +
    // synth) and text otherwise — proving ask() is client-agnostic.
    const cli = makeCliClient("claude", "", dir, async (_id, input) => {
      if (/JSON Schema/.test(input.prompt) && /relevant/.test(input.prompt)) {
        return JSON.stringify({ slugs: ["entities/alice"], relevant: true });
      }
      if (/JSON Schema/.test(input.prompt) && /grounded/.test(input.prompt)) {
        return JSON.stringify({
          answer: "后端由 [[entities/alice|Alice]] 负责。",
          grounded: true,
          usedSlugs: ["entities/alice"],
          gaps: [],
        });
      }
      return "unexpected";
    });
    const res = await ask([store], "谁负责后端？", {}, { client: cli });
    expect(res.source).toBe("knowledge");
    expect(res.answer).toContain("Alice");
    expect(res.citations.map((c) => c.slug)).toContain("entities/alice");
  });
});
