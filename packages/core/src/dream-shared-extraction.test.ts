import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AI_GENERATION_MAX_TOKENS, resetConfig, type SpaceId } from "@homeagent/shared";
import { runDreamCycle, retryQuarantinedDreamOperation } from "./dream.ts";
import { listQuarantineRecords } from "./quarantine.ts";
import { SpaceStore } from "./space.ts";
import { FakeLlm } from "./testing.ts";
import { makeCliClient } from "./cli-client.ts";
import { chatRawImportId, parseChatRawImport } from "./chat-raw-import.ts";

const SPACE: SpaceId = "team/oc_shared_dream";
let dir: string;
let store: SpaceStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ha-shared-dream-"));
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

function seed(content: string): string {
  return store.index().insertRaw({ space: SPACE, source: "message", content });
}

function operation(name: string, rawIds: string[]) {
  return { type: "concept", name, title: name, rawIds };
}

function note(content: string) {
  return { title: "Knowledge", summary: "Evidence", content, aliases: [], tags: [], links: [] };
}

function sourceBodies(prompt: string): string[] {
  return [...prompt.matchAll(/<(?:entry|source)\b[^>]*>\n([\s\S]*?)\n<\/(?:entry|source)>/gu)].map(match => match[1]!);
}

test("reads three shared fragments once for four pages, reducing 19 calls to 10", async () => {
  const markers = ["FIRST_FACT", "MIDDLE_FACT", "TAIL_FACT"];
  const content = markers.map(marker => marker.padEnd(48_000, "x")).join("");
  const id = seed(content);
  const names = ["alpha", "beta", "gamma", "delta"];
  const fake = new FakeLlm().onJSON(opts => {
    const prompt = opts.prompt ?? "";
    if (prompt.includes("## 待提炼的原始条目")) return {
      operations: names.map(name => operation(name, [id])), skippedRawIds: [],
    };
    if (prompt.includes("## 多页共享提取")) {
      expect(opts.maxTokens).toBe(AI_GENERATION_MAX_TOKENS);
      expect(sourceBodies(prompt)).toHaveLength(1);
      const marker = markers.find(item => prompt.includes(item))!;
      // Dispatch by identity, not by the order returned by the model.
      return { pages: names.toReversed().map(name => ({ slug: `concepts/${name}`, ...note(`${name}:${marker}`) })) };
    }
    return note("Main text; full evidence is attached by the application.");
  });

  const report = await runDreamCycle(store, {}, { client: fake });
  expect(report.errors).toEqual([]);
  expect(report.pagesWritten).toBe(4);
  expect(fake.calls).toHaveLength(10);
  const shared = fake.calls.filter(call => call.opts.prompt?.includes("## 多页共享提取"));
  expect(shared).toHaveLength(3);
  expect(shared.flatMap(call => sourceBodies(call.opts.prompt!)).join("")).toBe(content);
  expect(fake.calls.flatMap(call => sourceBodies(call.opts.prompt!)).reduce((sum, body) => sum + body.length, 0)).toBe(288_000);
  for (const name of names) {
    const page = store.index().getPage(`concepts/${name}`)!;
    expect(page.sources).toEqual([id]);
    for (const marker of markers) expect(page.content).toContain(`${name}:${marker}`);
    for (const other of names.filter(item => item !== name)) expect(page.content).not.toContain(`${other}:`);
  }
  expect(report.processedRawIds).toEqual([id]);
});

test("preserves page-specific fragment routing and source order through partial overlap", async () => {
  const markers = ["A_ONLY", "SHARED", "B_ONLY", "SHARED_AGAIN"];
  const id = seed(markers.map(marker => marker.padEnd(48_000, "x")).join(""));
  const other = seed("UNRELATED_SOURCE");
  const fake = new FakeLlm().onJSON(opts => {
    const prompt = opts.prompt ?? "";
    const marker = markers.find(item => sourceBodies(prompt).some(body => body === item.padEnd(48_000, "x")));
    if (prompt.includes("## 待提炼的原始条目")) return {
      operations: marker === "A_ONLY" ? [operation("a", [id])]
        : marker === "B_ONLY" ? [operation("b", [id])]
        : marker ? [operation("a", [id]), operation("b", [id])]
        : [operation("unrelated", [other])], skippedRawIds: [],
    };
    if (prompt.includes("## 多页共享提取")) return {
      pages: ["a", "b"].map(name => ({ slug: `concepts/${name}`, ...note(`${name}:${marker}`) })),
    };
    return note(marker ?? (prompt.includes("UNRELATED_SOURCE") ? "UNRELATED_SOURCE" : "Main text"));
  });
  const report = await runDreamCycle(store, {}, { client: fake });
  expect(report.errors).toEqual([]);
  expect(report.pagesWritten).toBe(3);
  const generationSources = fake.calls.filter(call => !call.opts.prompt?.includes("## 待提炼的原始条目"))
    .flatMap(call => sourceBodies(call.opts.prompt!));
  for (const marker of ["A_ONLY", "SHARED", "B_ONLY", "SHARED_AGAIN", "UNRELATED_SOURCE"]) {
    expect(generationSources.filter(body => body.startsWith(marker + (marker === "SHARED" ? "x" : "")))).toHaveLength(1);
  }
  const a = store.index().getPage("concepts/a")!;
  const b = store.index().getPage("concepts/b")!;
  expect(a.content).not.toContain("B_ONLY");
  expect(b.content).not.toContain("A_ONLY");
  expect(a.content.indexOf("A_ONLY")).toBeLessThan(a.content.indexOf("a:SHARED"));
  expect(b.content.indexOf("b:SHARED")).toBeLessThan(b.content.indexOf("B_ONLY"));
  expect(a.content).toContain("a:SHARED_AGAIN");
  expect(b.content.indexOf("B_ONLY")).toBeLessThan(b.content.indexOf("b:SHARED_AGAIN"));
  expect(a.sources).toEqual([id]);
  expect(b.sources).toEqual([id]);
  expect(store.index().getPage("concepts/unrelated")?.sources).toEqual([other]);
});

test("merges even one shared source group with each page's existing knowledge", async () => {
  const id = seed("NEW_SHARED_FACT");
  for (const name of ["a", "b"]) store.writePage({ slug: `concepts/${name}`, type: "concept", title: name,
    summary: "Old", content: `OLD_${name}`, aliases: [], tags: [], links: [], sources: [], updatedAt: 1, contentHash: "old" });
  const fake = new FakeLlm().onJSON(opts => {
    const prompt = opts.prompt ?? "";
    if (prompt.includes("## 待提炼的原始条目")) return {
      operations: [operation("a", [id]), operation("b", [id])], skippedRawIds: [],
    };
    if (prompt.includes("## 多页共享提取")) {
      expect(prompt).not.toContain("OLD_");
      return { pages: ["a", "b"].map(name => ({ slug: `concepts/${name}`, ...note(`${name}:NEW_SHARED_FACT`) })) };
    }
    expect(prompt).toContain("## 分段提炼结果");
    const name = prompt.includes("OLD_a") ? "a" : "b";
    expect(prompt).not.toContain(`${name === "a" ? "b" : "a"}:NEW_SHARED_FACT`);
    return note(`OLD_${name}\nUpdated main text`);
  });
  expect((await runDreamCycle(store, {}, { client: fake })).errors).toEqual([]);
  expect(fake.calls).toHaveLength(4);
  for (const name of ["a", "b"]) {
    const page = store.index().getPage(`concepts/${name}`)!;
    expect(page.content).toContain(`OLD_${name}`);
    expect(page.content).toContain(`${name}:NEW_SHARED_FACT`);
  }
});

test.each(["missing", "duplicate", "unknown", "empty", "long-summary", "provider"])(
  "a %s shared result quarantines its pages once and permits an unrelated page to finish", async failure => {
    const id = seed("SHARED_SOURCE");
    const other = seed("OTHER_SOURCE");
    const fake = new FakeLlm().onJSON(opts => {
      const prompt = opts.prompt ?? "";
      if (prompt.includes("## 待提炼的原始条目")) return {
        operations: [operation("a", [id]), operation("b", [id]), operation("other", [other])], skippedRawIds: [],
      };
      if (prompt.includes("## 多页共享提取")) {
        if (failure === "provider") throw new Error("synthetic provider failure");
        const pages = ["a", "b"].map(name => ({ slug: `concepts/${name}`, ...note("Evidence") }));
        if (failure === "missing") pages.pop();
        if (failure === "duplicate") pages[1]!.slug = pages[0]!.slug;
        if (failure === "unknown") pages[1]!.slug = "concepts/foreign";
        if (failure === "empty") pages[1]!.content = " ";
        if (failure === "long-summary") pages[1]!.summary = "x".repeat(1_001);
        return { pages };
      }
      return note("OTHER_SOURCE");
    });
    const report = await runDreamCycle(store, {}, { client: fake });
    expect(report.pagesWritten).toBe(1);
    expect(report.pagesQuarantined).toBe(2);
    expect(fake.calls.filter(call => call.opts.prompt?.includes("## 多页共享提取"))).toHaveLength(1);
    expect(store.index().getPage("concepts/a")).toBeNull();
    expect(store.index().getPage("concepts/b")).toBeNull();
    expect(store.index().getPage("concepts/other")?.sources).toEqual([other]);
    store.close();
    store = new SpaceStore(SPACE, dir);
    const records = listQuarantineRecords(store);
    expect(records).toHaveLength(2);
    for (const record of records) {
      expect(record.rawIds).toEqual([id]);
      const retry = new FakeLlm().queueJSON(note("SHARED_SOURCE"));
      expect((await retryQuarantinedDreamOperation(store, record, {}, { client: retry })).errors).toEqual([]);
      expect(retry.calls).toHaveLength(1);
      expect(retry.calls[0]!.opts.prompt).not.toContain("OTHER_SOURCE");
    }
  },
);

test.each(["merge", "save"])("a page %s failure does not repeat shared extraction for its sibling", async failure => {
  const id = seed("SHARED_SOURCE");
  const fake = new FakeLlm().onJSON(opts => {
    const prompt = opts.prompt ?? "";
    if (prompt.includes("## 待提炼的原始条目")) return {
      operations: [operation("a", [id]), operation("b", [id])], skippedRawIds: [],
    };
    if (prompt.includes("## 多页共享提取")) return {
      pages: ["a", "b"].map(name => ({ slug: `concepts/${name}`, ...note(`${name}:SHARED_SOURCE`) })),
    };
    if (failure === "merge" && prompt.includes("slug: concepts/a,")) throw new Error("synthetic merge failure");
    return note("Main text");
  });
  const writePage = store.writePage.bind(store);
  const write = spyOn(store, "writePage").mockImplementation(page => {
    if (failure === "save" && page.slug === "concepts/a") throw new Error("synthetic save failure");
    writePage(page);
  });
  try {
    const report = await runDreamCycle(store, {}, { client: fake });
    expect(report.pagesWritten).toBe(1);
    expect(report.pagesQuarantined).toBe(1);
    expect(fake.calls.filter(call => call.opts.prompt?.includes("## 多页共享提取"))).toHaveLength(1);
    expect(store.index().getPage("concepts/b")?.content).toContain("b:SHARED_SOURCE");
    expect(listQuarantineRecords(store)[0]?.slug).toBe("concepts/a");
  } finally { write.mockRestore(); }
});

test("cancelling shared extraction leaves Raw pending and writes no partial pages", async () => {
  const id = seed("FIRST".padEnd(48_000, "x") + "TAIL");
  const abort = new AbortController();
  const fake = new FakeLlm().onJSON(opts => {
    if (opts.prompt?.includes("## 待提炼的原始条目")) return {
      operations: [operation("a", [id]), operation("b", [id])], skippedRawIds: [],
    };
    abort.abort(new Error("cancelled"));
    return { pages: ["a", "b"].map(name => ({ slug: `concepts/${name}`, ...note("FIRST") })) };
  });
  await expect(runDreamCycle(store, { signal: abort.signal }, { client: fake })).rejects.toThrow("cancelled");
  expect(fake.calls).toHaveLength(3);
  expect(store.index().getPage("concepts/a")).toBeNull();
  expect(store.index().getPage("concepts/b")).toBeNull();
  expect(store.index().countRaw(true)).toBe(1);
  expect(listQuarantineRecords(store)).toEqual([]);
});

test("groups short sources only when every target has the same provenance", async () => {
  const common = [seed("COMMON_FIRST"), seed("COMMON_SECOND")];
  const exclusive = seed("A_PRIVATE");
  const fake = new FakeLlm().onJSON(opts => {
    const prompt = opts.prompt ?? "";
    if (prompt.includes("## 待提炼的原始条目")) return {
      operations: [operation("a", [...common, exclusive]), operation("b", common)], skippedRawIds: [],
    };
    if (prompt.includes("## 多页共享提取")) {
      expect(sourceBodies(prompt)).toEqual(["COMMON_FIRST", "COMMON_SECOND"]);
      expect(prompt).not.toContain("A_PRIVATE");
      return { pages: ["a", "b"].map(name => ({ slug: `concepts/${name}`, ...note("COMMON_FIRST\nCOMMON_SECOND") })) };
    }
    if (prompt.includes("## 来源分段提取")) return note("A_PRIVATE");
    return note("Main text");
  });
  expect((await runDreamCycle(store, {}, { client: fake })).errors).toEqual([]);
  expect(fake.calls.filter(call => call.opts.prompt?.includes("## 多页共享提取"))).toHaveLength(1);
  expect(store.index().getPage("concepts/a")?.sources).toEqual([...common, exclusive]);
  expect(store.index().getPage("concepts/a")?.content).toContain("A_PRIVATE");
  expect(store.index().getPage("concepts/b")?.sources).toEqual(common);
  expect(store.index().getPage("concepts/b")?.content).not.toContain("A_PRIVATE");
});

test("cached targets are excluded from extraction while forced regeneration still includes them", async () => {
  const id = seed("SHARED_FACT");
  store.writePage({ slug: "concepts/a", type: "concept", title: "a", summary: "Old", content: "Old",
    sources: [], links: [], aliases: [], tags: [], updatedAt: 1, contentHash: "old" });
  const initial = new FakeLlm().queueJSON({ operations: [operation("a", [id])], skippedRawIds: [] }).queueJSON(note("SHARED_FACT"));
  expect((await runDreamCycle(store, {}, { client: initial })).errors).toEqual([]);
  const cached = store.index().getPage("concepts/a")!;
  store.index().markPending([id]);
  const update = new FakeLlm().queueJSON({ operations: [operation("a", [id]), operation("b", [id])], skippedRawIds: [] })
    .queueJSON(note("SHARED_FACT"));
  const report = await runDreamCycle(store, {}, { client: update });
  expect(report.errors).toEqual([]);
  expect(report.pagesWritten).toBe(1);
  expect(update.calls).toHaveLength(2);
  expect(store.index().getPage("concepts/a")).toEqual(cached);
  const forced = new FakeLlm().onJSON(opts => opts.prompt?.includes("## 待提炼的原始条目")
    ? { operations: [operation("a", [id]), operation("b", [id])], skippedRawIds: [] }
    : opts.prompt?.includes("## 多页共享提取")
      ? { pages: ["a", "b"].map(name => ({ slug: `concepts/${name}`, ...note("SHARED_FACT") })) }
      : note("Updated"));
  expect((await runDreamCycle(store, { force: true }, { client: forced })).pagesWritten).toBe(2);
  expect(forced.calls.filter(call => call.opts.prompt?.includes("## 多页共享提取"))).toHaveLength(1);
});

test("shared extraction preserves Unicode boundaries and chat versions through the CLI JSON seam", async () => {
  const content = "FIRST".padEnd(47_999, "x") + "😀TAIL";
  const entry = parseChatRawImport(JSON.stringify({ version: 1, chatId: "oc_shared_dream", startAt: 0, endAt: 3000,
    mainComplete: true, threadsComplete: true, olderThreadsScanned: true, failedMessageIds: [],
    messages: [{ messageId: "om_edition", createdAt: 1000, updatedAt: 2000, text: content, attachments: [] }] }), SPACE, "oc_shared_dream").entries[0]!;
  const metadataLength = entry.content.length - content.length;
  entry.content = entry.content.replace(content, "FIRST".padEnd(47_999 - metadataLength, "x") + "😀TAIL");
  const id = chatRawImportId(SPACE, "oc_shared_dream", "om_edition", 2000);
  store.index().captureImportedRaw(id, entry);
  const prompts: string[] = [];
  const client = makeCliClient("codex", "", dir, async (_provider, input) => {
    const prompt = input.prompt;
    prompts.push(prompt);
    if (prompt.includes("## 待提炼的原始条目")) return JSON.stringify({
      operations: [operation("a", [id]), operation("b", [id])], skippedRawIds: [],
    });
    if (prompt.includes("## 多页共享提取")) {
      expect(input.outputSchema).toMatchObject({ properties: { pages: { minItems: 2, maxItems: 2 } } });
      expect(prompt).toContain('"type":"chat-source-snapshot"');
      expect(prompt).toContain('"messageId":"om_edition"');
      expect(prompt).toContain('"updatedAt":2000');
      expect(prompt).not.toContain("## 人工纠错规则");
      return JSON.stringify({ pages: ["a", "b"].map(name => ({ slug: `concepts/${name}`,
        ...note(sourceBodies(prompt)[0]!.includes("FIRST") ? "FIRST" : "😀TAIL") })) });
    }
    expect(prompt).toContain('"updatedAt":2000');
    return JSON.stringify(note("Current conclusions"));
  });
  expect((await runDreamCycle(store, {}, { client })).errors).toEqual([]);
  const extracted = prompts.filter(prompt => prompt.includes("## 多页共享提取")).flatMap(sourceBodies);
  expect(extracted.join("")).toBe(entry.content);
  expect(extracted.map(body => body.length)).toEqual([47_999, 6]);
  expect(extracted[1]).toStartWith("😀");
  for (const name of ["a", "b"]) {
    expect(store.index().getPage(`concepts/${name}`)?.content).toContain("😀TAIL");
    expect(store.index().getPage(`concepts/${name}`)?.content).toContain('"updatedAt":2000');
  }
});
