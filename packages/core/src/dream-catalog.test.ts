import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AI_ROUTING_MAX_TOKENS, resetConfig, type Page, type SpaceId } from "@homeagent/shared";
import { runDreamCycle } from "./dream.ts";
import { SpaceStore } from "./space.ts";
import { FakeLlm } from "./testing.ts";

const SPACE: SpaceId = "team/oc_dream_catalog";
let dir: string;
let store: SpaceStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ha-dream-catalog-"));
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

function page(name: string, overrides: Partial<Page> = {}): Page {
  return { slug: `concepts/${name}`, type: "concept", title: name, summary: "Stored knowledge", content: "Existing facts",
    aliases: [], tags: [], sources: [], links: [], updatedAt: 1, contentHash: "old", ...overrides };
}

function seedCatalog(count: number) {
  for (let i = 0; i < count; i++) store.index().upsertPage(page(`filler-${i}`, {
    title: `Unrelated item ${i}`, summary: "Unrelated catalog material ".repeat(4), content: "unrelated material", updatedAt: i + 2,
  }));
}

function raw(content: string): string {
  return store.index().insertRaw({ space: SPACE, source: "message", content });
}

function plan(id: string, name: string, title = name, reason = "") {
  return { operations: [{ type: "concept", name, title, reason, rawIds: [id] }], skippedRawIds: [] };
}

const generated = { title: "Updated", summary: "Updated facts", content: "Updated facts", links: [] };
const planning = (prompt: string) => prompt.includes("## 待提炼的原始条目");
const lookup = (prompt: string) => prompt.includes("## 新建页面复用检查");

test("small catalogs still expose every content page with no lookup call", async () => {
  seedCatalog(59);
  store.writePage(page("old", { title: "Existing topic", aliases: ["旧名称"] }));
  const id = raw("New topic information");
  const fake = new FakeLlm().onJSON(opts => planning(opts.prompt ?? "") ? plan(id, "old") : generated);
  const report = await runDreamCycle(store, {}, { client: fake });
  expect(report.errors).toEqual([]);
  expect(fake.calls).toHaveLength(2);
  const prompt = fake.calls[0]!.opts.prompt!;
  for (let i = 0; i < 59; i++) expect(prompt).toContain(`concepts/filler-${i} `);
  expect(prompt).toContain("concepts/old");
});

test("500-page catalogs shrink every long-source planning prompt without adding model calls", async () => {
  seedCatalog(500);
  store.writePage(page("rpc", { title: "远程过程调用", aliases: ["RPC"], summary: "RPC 调用约定" }));
  const source = Array.from({ length: 3 }, () => "SOURCE_FRAGMENT ".padEnd(47_980, " ") + "RPC 调用的新约定".padEnd(20, " ")).join("");
  const id = raw(source);
  const fullCatalog = store.index().listPages().map(ref => `- ${ref.slug} (${ref.type})：${ref.title}｜${ref.summary}`).join("\n");
  const fake = new FakeLlm().onJSON(opts => planning(opts.prompt ?? "") ? plan(id, "rpc") : generated);
  const report = await runDreamCycle(store, {}, { client: fake });
  expect(report.errors).toEqual([]);
  expect(fake.calls).toHaveLength(7);
  const plans = fake.calls.filter(call => planning(call.opts.prompt ?? ""));
  expect(plans).toHaveLength(3);
  for (const call of plans) {
    expect(call.opts.prompt).toContain("concepts/rpc");
    expect(call.opts.prompt).not.toContain("concepts/filler-");
    expect(call.opts.prompt!.length).toBeLessThan(62_000);
  }
  const promptCharacters = plans.reduce((sum, call) => sum + call.opts.prompt!.length, 0);
  expect(promptCharacters).toBeLessThan((source.length + 3 * fullCatalog.length) * 0.65);
  console.info(JSON.stringify({ scenario: "dream-500-page-catalog", planningCalls: plans.length,
    previousRawAndCatalogCharacters: source.length + 3 * fullCatalog.length, planningPromptCharacters: promptCharacters }));
  expect(store.index().getPage("concepts/rpc")?.sources).toEqual([id]);
});

test.each(["alias", "body", "map"])("large-space candidates include %s matches and exclude other Spaces", async mode => {
  seedCatalog(61);
  const target = page("durable", { title: "持久化约定", aliases: mode === "alias" ? ["SRE"] : [],
    content: mode === "body" ? "罕见量子术语的运行约束" : "Existing facts" });
  store.writePage(target);
  if (mode === "map") store.writePage(page("topic", { slug: "maps/topic", type: "map", title: "航天器维护",
    content: "航天器维护", links: [target.slug] }));
  const other = new SpaceStore("team/oc_other_catalog", dir);
  other.ensure();
  other.writePage(page("foreign-secret", { title: "SRE 航天器维护 罕见量子术语" }));
  other.close();
  const search = mode === "alias" ? spyOn(store.index(), "search").mockReturnValue([]) : undefined;
  try {
    const id = raw(mode === "alias" ? "ＳＲＥ 执行新流程" : mode === "body" ? "罕见量子术语" : "航天器维护");
    const fake = new FakeLlm().onJSON(opts => planning(opts.prompt ?? "") ? plan(id, "durable") : generated);
    expect((await runDreamCycle(store, {}, { client: fake })).errors).toEqual([]);
    const prompt = fake.calls[0]!.opts.prompt!;
    expect(prompt).toContain(target.slug);
    expect(prompt).not.toContain("maps/topic");
    expect(prompt).not.toContain("foreign-secret");
    expect(prompt).not.toContain("concepts/filler-");
  } finally { search?.mockRestore(); }
});

test("new-page checks find weak semantic matches beyond the initial candidates and old fallback depth", async () => {
  seedCatalog(300);
  store.writePage(page("old-release", { title: "生产变更核验", summary: "上线后验证及紧急回退的团队约定" }));
  const id = raw("Deploy checklist improvements");
  const search = spyOn(store.index(), "search").mockReturnValue([]);
  const fake = new FakeLlm().onJSON(opts => {
    const prompt = opts.prompt ?? "";
    if (planning(prompt)) return plan(id, "new-release", "发布后的检查流程", "部署后的检查和回滚约定");
    if (lookup(prompt)) return { matches: prompt.includes("concepts/old-release") ? [{ operation: "op-1", slug: "concepts/old-release" }] : [] };
    return generated;
  });
  try {
    const report = await runDreamCycle(store, {}, { client: fake });
    expect(report.errors).toEqual([]);
    expect(store.index().getPage("concepts/new-release")).toBeNull();
    expect(store.index().getPage("concepts/old-release")?.sources).toEqual([id]);
    const checks = fake.calls.filter(call => lookup(call.opts.prompt ?? ""));
    expect(checks.length).toBeGreaterThan(4);
    for (const check of checks) {
      expect(check.opts.maxTokens).toBe(AI_ROUTING_MAX_TOKENS);
      expect(check.opts.prompt).not.toContain("Deploy checklist improvements");
      expect(check.opts.prompt!.length).toBeLessThan(26_000);
    }
    expect(fake.calls[0]!.opts.prompt).toContain("候选目录");
    expect(fake.calls[0]!.opts.prompt).not.toContain("（暂无）");
  } finally { search.mockRestore(); }
});

test("genuinely new knowledge is created after every existing page has been checked", async () => {
  seedCatalog(125);
  const id = raw("A completely new subject");
  const fake = new FakeLlm().onJSON(opts => planning(opts.prompt ?? "") ? plan(id, "new-subject")
    : lookup(opts.prompt ?? "") ? { matches: [] } : generated);
  const report = await runDreamCycle(store, {}, { client: fake });
  expect(report.errors).toEqual([]);
  const checked = fake.calls.filter(call => lookup(call.opts.prompt ?? "")).map(call => call.opts.prompt!).join("\n");
  for (let i = 0; i < 125; i++) expect(checked).toContain(`concepts/filler-${i} `);
  expect(store.index().getPage("concepts/new-subject")?.sources).toEqual([id]);
});

test.each(["provider", "unknown-page", "duplicate-operation", "unknown-operation", "cancel"])(
  "%s during reuse checking leaves the entire batch pending and preserves old pages", async failure => {
    seedCatalog(61);
    const id = raw("New evidence");
    const noise = raw("Hello");
    const abort = new AbortController();
    const fake = new FakeLlm().onJSON(opts => {
      const prompt = opts.prompt ?? "";
      if (planning(prompt)) return { ...plan(id, "new"), skippedRawIds: [noise] };
      if (lookup(prompt)) {
        if (failure === "provider") throw new Error("synthetic lookup failure");
        if (failure === "cancel") { abort.abort(new Error("cancelled")); return { matches: [] }; }
        const slug = /concepts\/filler-\d+/u.exec(prompt)![0];
        const match = { operation: "op-1", slug };
        return { matches: failure === "duplicate-operation" ? [match, match]
          : failure === "unknown-page" ? [{ ...match, slug: "concepts/not-in-batch" }]
          : [{ ...match, operation: "op-999" }] };
      }
      return generated;
    });
    if (failure === "cancel") await expect(runDreamCycle(store, { signal: abort.signal }, { client: fake })).rejects.toThrow("cancelled");
    else {
      const report = await runDreamCycle(store, {}, { client: fake });
      expect(report.errors).not.toEqual([]);
      expect(report.pagesWritten).toBe(0);
      expect(report.processedRawIds).toEqual([]);
    }
    expect(store.index().countRaw(true)).toBe(2);
    expect(store.index().getPage("concepts/new")).toBeNull();
    expect(store.index().getPage("concepts/filler-0")?.content).toBe("unrelated material");
  },
);

test("candidate saturation still permits an old page outside the first 60 to be reused", async () => {
  seedCatalog(65);
  const id = raw("Unrelated item is changing");
  const fake = new FakeLlm().onJSON(opts => {
    const prompt = opts.prompt ?? "";
    if (planning(prompt)) {
      const catalog = prompt.split("## 待提炼的原始条目")[0]!;
      expect([...catalog.matchAll(/^- concepts\//gmu)].length).toBeLessThanOrEqual(60);
      expect(catalog).not.toContain("concepts/filler-64 ");
      return plan(id, "renamed-topic");
    }
    if (lookup(prompt)) return { matches: prompt.includes("concepts/filler-64 ") ? [{ operation: "op-1", slug: "concepts/filler-64" }] : [] };
    return generated;
  });
  const search = spyOn(store.index(), "search").mockImplementation(() => Array.from({ length: 60 }, (_, i) => ({
    slug: `concepts/filler-${i}`, title: `Unrelated item ${i}`, type: "concept", snippet: "", score: i,
  })));
  try {
    expect((await runDreamCycle(store, {}, { client: fake })).errors).toEqual([]);
    expect(store.index().getPage("concepts/renamed-topic")).toBeNull();
    expect(store.index().getPage("concepts/filler-64")?.sources).toEqual([id]);
  } finally { search.mockRestore(); }
});

test("metadata batches obey the character budget and do not stop at a fixed batch count", async () => {
  for (let i = 0; i < 61; i++) store.index().upsertPage(page(`verbose-${i}`, { summary: "S".repeat(1_000),
    aliases: ["a".repeat(200), "b".repeat(200)], tags: ["t".repeat(200)] }));
  const id = raw("An unrelated new topic");
  const fake = new FakeLlm().onJSON(opts => planning(opts.prompt ?? "") ? plan(id, "new-topic")
    : lookup(opts.prompt ?? "") ? { matches: [] } : generated);
  expect((await runDreamCycle(store, {}, { client: fake })).errors).toEqual([]);
  const checks = fake.calls.filter(call => lookup(call.opts.prompt ?? ""));
  expect(checks.length).toBeGreaterThan(4);
  for (const call of checks) expect(call.opts.prompt!.length).toBeLessThan(26_000);
  const checked = checks.map(call => call.opts.prompt).join("\n");
  for (let i = 0; i < 61; i++) expect(checked).toContain(`concepts/verbose-${i} `);
});

test("multiple proposed updates resolving to one old page retain their exact Raw sources", async () => {
  seedCatalog(61);
  store.writePage(page("existing", { title: "Canonical subject" }));
  const first = raw("FIRST_SOURCE");
  const second = raw("SECOND_SOURCE");
  const fake = new FakeLlm().onJSON(opts => {
    const prompt = opts.prompt ?? "";
    if (planning(prompt)) return { operations: [plan(first, "new-a").operations[0], plan(second, "new-b").operations[0]], skippedRawIds: [] };
    if (lookup(prompt)) return { matches: prompt.includes("concepts/existing ")
      ? ["op-1", "op-2"].map(operation => ({ operation, slug: "concepts/existing" })) : [] };
    expect(prompt).toContain("FIRST_SOURCE");
    expect(prompt).toContain("SECOND_SOURCE");
    return generated;
  });
  const report = await runDreamCycle(store, {}, { client: fake });
  expect(report.errors).toEqual([]);
  expect(report.pagesWritten).toBe(1);
  expect(store.index().getPage("concepts/existing")?.sources).toEqual([first, second]);
  expect(store.index().getPage("concepts/new-a")).toBeNull();
  expect(store.index().getPage("concepts/new-b")).toBeNull();
});

test("later fragments see the newly planned page and avoid rescanning the catalog for it", async () => {
  seedCatalog(61);
  const id = raw("NovelSubject ".padEnd(48_000, " ") + "NovelSubject tail");
  let plans = 0;
  const fake = new FakeLlm().onJSON(opts => {
    const prompt = opts.prompt ?? "";
    if (planning(prompt)) {
      if (++plans === 2) expect(prompt.split("## 待提炼的原始条目")[0]).toContain("concepts/novel");
      return plan(id, "novel", "NovelSubject");
    }
    return lookup(prompt) ? { matches: [] } : generated;
  });
  expect((await runDreamCycle(store, {}, { client: fake })).errors).toEqual([]);
  expect(fake.calls.filter(call => lookup(call.opts.prompt ?? ""))).toHaveLength(2);
  expect(store.index().getPage("concepts/novel")?.sources).toEqual([id]);
});

test("a later reuse-check failure preserves earlier planned fragments pending across reopen", async () => {
  seedCatalog(61);
  const id = raw("FIRST_FRAGMENT".padEnd(48_000, " ") + "LAST_FRAGMENT");
  const fake = new FakeLlm().onJSON(opts => {
    const prompt = opts.prompt ?? "";
    if (planning(prompt)) return plan(id, prompt.includes("LAST_FRAGMENT") ? "new-last" : "filler-0");
    if (lookup(prompt)) throw new Error("synthetic late failure");
    throw new Error("generation must not start");
  });
  const report = await runDreamCycle(store, {}, { client: fake });
  expect(report.pagesWritten).toBe(0);
  expect(report.errors).toHaveLength(1);
  expect(report.processedRawIds).toEqual([]);
  store.close();
  store = new SpaceStore(SPACE, dir);
  expect(store.index().getRaw(id)?.ingested).toBe(false);
  expect(store.index().getRaw(id)?.content).toContain("LAST_FRAGMENT");
});

test("oversized metadata is fully checked in bounded pieces, including a late alias", async () => {
  store.writePage(page("long-metadata", { summary: "旧".repeat(50_000), aliases: ["ActualLateAlias"] }));
  const id = raw("New evidence about a formerly named subject");
  const fake = new FakeLlm().onJSON(opts => {
    const prompt = opts.prompt ?? "";
    expect(prompt.length).toBeLessThan(26_000);
    if (planning(prompt)) return plan(id, "proposed", "ActualLateAlias");
    if (lookup(prompt)) return { matches: prompt.includes("ActualLateAlias") && prompt.split("## 本空间已有页面（本批）")[1]?.includes("ActualLateAlias")
      ? [{ operation: "op-1", slug: "concepts/long-metadata" }] : [] };
    return generated;
  });
  expect((await runDreamCycle(store, {}, { client: fake })).errors).toEqual([]);
  const checks = fake.calls.filter(call => lookup(call.opts.prompt ?? ""));
  expect(checks).toHaveLength(3);
  const directoryText = checks.map(call => call.opts.prompt!.split("## 本空间已有页面（本批）")[1]!).join("");
  expect([...directoryText.matchAll(/旧/gu)].length).toBeGreaterThanOrEqual(50_000);
  expect(store.index().getPage("concepts/long-metadata")?.sources).toEqual([id]);
  expect(store.index().getPage("concepts/proposed")).toBeNull();
});
