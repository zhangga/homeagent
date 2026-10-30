import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetConfig, type Page, type SpaceId } from "@homeagent/shared";
import { runDreamCycle, retryQuarantinedDreamOperation, regeneratePageFromSources } from "./dream.ts";
import { listQuarantineRecords } from "./quarantine.ts";
import { SpaceStore } from "./space.ts";
import { FakeLlm } from "./testing.ts";
import { pageBlocks } from "./dream-page-update.ts";
import { chatRawImportId, parseChatRawImport } from "./chat-raw-import.ts";
import { makeCliClient } from "./cli-client.ts";

const SPACE: SpaceId = "team/oc_page_update";
let dir: string;
let store: SpaceStore;
const slug = "concepts/handbook";
const detailsHeader = "## 来源分段详情\n\n> 以下保留全部分段提炼证据，可能包含历史版本；当前结论及纠错以上方主文为准。\n\n";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ha-page-update-"));
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

function seed(content: string, source: "message" | "manual" = "message") {
  return store.index().insertRaw({ space: SPACE, source, content });
}
function save(content: string, sources: string[] = []): Page {
  const page: Page = { slug, type: "concept", title: "Handbook", summary: "Operational handbook", content, sources,
    aliases: ["Guide"], tags: ["Operations"], links: ["concepts/retained"], updatedAt: 1, contentHash: "old" };
  store.writePage(page);
  return page;
}
function largePage(): string {
  return "# Handbook\n\nIntroduction.\n\n" + Array.from({ length: 30 }, (_, i) =>
    `## Section ${i}\n\n${`UNCHANGED_${i}_`.padEnd(3_950, "x")}\n\n`).join("")
    + "## Release\n\nRelease timeout: 10 seconds.\n";
}
interface VisibleBlock { id: string; heading: string; readonly: boolean; content?: string; preview?: string }
function jsonSection(prompt: string, heading: string): VisibleBlock[] {
  return prompt.split(`${heading}\n`)[1]!.split("\n## ")[0]!.trim().split("\n").filter(line => line.startsWith("{"))
    .map(line => JSON.parse(line) as VisibleBlock);
}
const routing = (prompt: string) => prompt.includes("## 旧页局部更新：选择内容块");
const patching = (prompt: string) => prompt.includes("## 旧页局部更新：提交修改");
function patch(edits: Array<{ id: string; content: string }> = [], append = "", readBlockIds: string[] = []) {
  return { title: "Handbook", summary: "Updated handbook", aliases: ["Guide"], tags: ["Operations"], links: ["concepts/retained"],
    edits, append, readBlockIds, readNextCatalog: false };
}
function fakeFor(id: string, handler?: (prompt: string) => unknown): FakeLlm {
  return new FakeLlm().onJSON(opts => {
    const prompt = opts.prompt ?? "";
    if (prompt.includes("## 待提炼的原始条目")) return {
      operations: [{ type: "concept", name: "handbook", title: "Handbook", rawIds: [id] }], skippedRawIds: [],
    };
    if (handler) return handler(prompt);
    if (routing(prompt)) return { readBlockIds: jsonSection(prompt, "## 旧页块目录").filter(block => block.heading.includes("Release")).map(block => block.id) };
    if (patching(prompt)) return patch(jsonSection(prompt, "## 当前内容块").filter(block => block.content?.includes("Release timeout"))
      .map(block => ({ id: block.id, content: block.content!.replace("10 seconds", "30 seconds") })));
    return { title: "Handbook", summary: "Updated", content: "Release timeout: 30 seconds.", links: [] };
  });
}

test("a small update to a 120k page only reads relevant blocks and preserves all other bytes", async () => {
  const before = largePage();
  save(before);
  const id = seed("Release timeout is now 30 seconds.".padEnd(1_000, " "));
  const fake = fakeFor(id);
  const report = await runDreamCycle(store, {}, { client: fake });
  expect(report.errors).toEqual([]);
  const generated = store.index().getPage(slug)!;
  expect(generated.content).toBe(before.replace("10 seconds", "30 seconds"));
  expect(generated.aliases).toEqual(["Guide"]);
  expect(generated.links).toContain("concepts/retained");
  expect(generated.sources).toEqual([id]);
  const calls = fake.calls.filter(call => !call.opts.prompt?.includes("## 待提炼的原始条目"));
  expect(calls.some(call => routing(call.opts.prompt!))).toBe(true);
  const inputCharacters = calls.reduce((sum, call) => sum + call.opts.prompt!.length, 0);
  expect(inputCharacters).toBeLessThan(before.length * 0.4);
  expect(calls.every(call => call.opts.prompt!.length < 60_000)).toBe(true);
  console.info(JSON.stringify({ scenario: "large-page-local-update", oldPageCharacters: before.length, generationPromptCharacters: inputCharacters,
    generationCalls: calls.length }));
  store.close();
  store = new SpaceStore(SPACE, dir);
  expect(store.readPageFile(slug)?.content).toBe(before.replace("10 seconds", "30 seconds").trimEnd() + "\n");
  store.rebuildIndex();
  expect(store.index().getPage(slug)?.content).toContain("UNCHANGED_29_");
});

test("old source details remain verbatim and outside the edit output", async () => {
  const history = detailsHeader + "### 来源分段 1\n\n来源 Raw：old（1/1）\n\n来源元数据：[]\n\n" + "HISTORICAL_FACT\n".repeat(6_000);
  const before = "# Handbook\n\n## Release\n\nRelease timeout: 10 seconds.\n\n" + history;
  save(before);
  const id = seed("Release timeout is now 30 seconds.");
  const fake = fakeFor(id);
  expect((await runDreamCycle(store, {}, { client: fake })).errors).toEqual([]);
  const after = store.index().getPage(slug)!.content;
  expect(after).toBe(before.replace("10 seconds", "30 seconds"));
  expect(after.endsWith(history)).toBe(true);
  for (const call of fake.calls.filter(call => patching(call.opts.prompt ?? ""))) {
    expect(call.opts.prompt).not.toContain("HISTORICAL_FACT\n".repeat(50));
  }
});

test("additional block reads support weak matches without committing partial edits", async () => {
  save(largePage());
  const id = seed("A semantic update");
  let target = "";
  let attempts = 0;
  const fake = fakeFor(id, prompt => {
    if (routing(prompt)) {
      target = jsonSection(prompt, "## 旧页块目录").find(block => block.heading.includes("Release"))!.id;
      return { readBlockIds: [] };
    }
    if (!patching(prompt)) throw new Error("expected local patch");
    expect(store.index().getPage(slug)?.content).toBe(largePage());
    if (++attempts === 1) return patch([], "", [target]);
    return patch(jsonSection(prompt, "## 当前内容块").filter(block => block.id === target)
      .map(block => ({ id: block.id, content: block.content!.replace("10 seconds", "30 seconds") })));
  });
  expect((await runDreamCycle(store, {}, { client: fake })).errors).toEqual([]);
  expect(attempts).toBe(2);
  expect(store.index().getPage(slug)?.content).toBe(largePage().replace("10 seconds", "30 seconds"));
});

test.each(["unknown", "unread", "duplicate", "evidence", "repeat-read", "provider", "save"])(
  "%s patch failure preserves the original page and retries after reopen", async failure => {
    const before = largePage() + detailsHeader + "Historical evidence.\n";
    save(before);
    const id = seed("Release timeout is now 30 seconds.");
    let hidden = "";
    let historical = "";
    const fake = fakeFor(id, prompt => {
      if (routing(prompt)) {
        const blocks = jsonSection(prompt, "## 旧页块目录");
        hidden ||= blocks.find(block => block.heading.includes("Section 20"))?.id ?? "";
        historical ||= blocks.find(block => block.readonly)?.id ?? "";
        return { readBlockIds: blocks.filter(block => block.heading.includes("Release") || (failure === "evidence" && block.readonly)).map(block => block.id) };
      }
      if (!patching(prompt)) return { title: "Wrong", summary: "Wrong", content: "Lost old facts" };
      if (failure === "provider") throw new Error("synthetic patch failure");
      const blocks = jsonSection(prompt, "## 当前内容块");
      const target = blocks.find(block => block.content?.includes("Release timeout"))!;
      const edit = { id: target.id, content: target.content!.replace("10 seconds", "30 seconds") };
      if (failure === "unknown") return patch([{ ...edit, id: "block-missing" }]);
      if (failure === "unread") return patch([{ ...edit, id: hidden }]);
      if (failure === "duplicate") return patch([edit, edit]);
      if (failure === "evidence") return patch([{ ...edit, id: historical }]);
      if (failure === "repeat-read") return patch([], "", [target.id]);
      return patch([edit]);
    });
    const realWrite = store.writePage.bind(store);
    const write = spyOn(store, "writePage").mockImplementation(page => {
      if (failure === "save" && page.slug === slug) throw new Error("synthetic save failure");
      realWrite(page);
    });
    try {
      const report = await runDreamCycle(store, {}, { client: fake });
      expect(report.pagesWritten).toBe(0);
      expect(report.pagesQuarantined).toBe(1);
      expect(store.index().getPage(slug)?.content).toBe(before);
    } finally { write.mockRestore(); }
    store.close();
    store = new SpaceStore(SPACE, dir);
    const record = listQuarantineRecords(store)[0]!;
    expect(record.operation?.sourceFragments).toHaveLength(1);
    const retry = fakeFor(id);
    expect((await retryQuarantinedDreamOperation(store, record, {}, { client: retry })).errors).toEqual([]);
    expect(store.index().getPage(slug)?.content).toBe(before.replace("10 seconds", "30 seconds"));
  },
);

test("manual corrections inspect all editable blocks even when routing selects none", async () => {
  const before = largePage();
  save(before);
  const id = seed("Correction: Release timeout is 30 seconds.", "manual");
  const read: string[] = [];
  const fake = fakeFor(id, prompt => {
    if (routing(prompt)) return { readBlockIds: [] };
    if (!patching(prompt)) throw new Error("expected local patch");
    expect(prompt).toContain("## 人工纠错规则");
    const blocks = jsonSection(prompt, "## 当前内容块");
    read.push(...blocks.map(block => block.content!));
    return patch(blocks.filter(block => block.content?.includes("Release timeout"))
      .map(block => ({ id: block.id, content: block.content!.replace("10 seconds", "30 seconds") })));
  });
  expect((await runDreamCycle(store, {}, { client: fake })).errors).toEqual([]);
  expect(read.join("")).toBe(before);
  expect(store.index().getPage(slug)?.content).toBe(before.replace("10 seconds", "30 seconds"));
});

test("cancellation during local editing does not save or consume Raw", async () => {
  save(largePage());
  const id = seed("Release update");
  const abort = new AbortController();
  const fake = fakeFor(id, prompt => {
    if (routing(prompt)) return { readBlockIds: [] };
    abort.abort(new Error("cancelled"));
    return patch();
  });
  await expect(runDreamCycle(store, { signal: abort.signal }, { client: fake })).rejects.toThrow("cancelled");
  expect(store.index().getPage(slug)?.content).toBe(largePage());
  expect(store.index().getRaw(id)?.ingested).toBe(false);
  expect(listQuarantineRecords(store)).toEqual([]);
});

test("explicit full regeneration keeps its full-source generation behavior", async () => {
  const id = seed("All authoritative replacement facts");
  save(largePage(), [id]);
  const fake = new FakeLlm().queueJSON({ title: "Replacement", summary: "Replacement", content: "Full regenerated page", links: [] });
  expect((await regeneratePageFromSources(store, slug, [], {}, { client: fake })).content).toBe("Full regenerated page\n");
  expect(fake.calls).toHaveLength(1);
  expect(fake.calls[0]!.opts.prompt).toContain("All authoritative replacement facts");
});

test("block partitioning preserves Markdown, CRLF, Unicode and fenced headings exactly", () => {
  const content = "Preamble\r\n\r\n# Heading\r\n\r\n" + "text ".repeat(3_000) + "😀END\r\n"
    + "```markdown\n" + detailsHeader + "### Not a real section\n```\n"
    + "## Repeated\n\nSame\n\n## Repeated\n\nSame\n\n"
    + "~~~ts\n" + "const n = 42;\n".repeat(900) + "~~~\n## Release\nNew\n";
  const blocks = pageBlocks(content);
  expect(blocks.map(block => block.content).join("")).toBe(content);
  expect(blocks.every(block => block.content.length <= 8_000 && !block.readonly)).toBe(true);
  expect(blocks.every(block => !/[\uD800-\uDBFF]$/u.test(block.content) && !/^[\uDC00-\uDFFF]/u.test(block.content))).toBe(true);
  expect(new Set(blocks.map(block => block.id)).size).toBe(blocks.length);
  expect(pageBlocks(content).map(block => block.id)).toEqual(blocks.map(block => block.id));
  expect(blocks.some(block => block.heading === "Not a real section")).toBe(false);
  const flat = "x".repeat(7_999) + "😀" + "y".repeat(50_000);
  expect(pageBlocks(flat).map(block => block.content).join("")).toBe(flat);
  expect(pageBlocks(flat)[1]!.content).toStartWith("😀");
});

test("new main text is inserted before unchanged historical details", async () => {
  const history = detailsHeader + "### 来源分段 1\n\n" + "Archive detail\n".repeat(4_000);
  const before = "# Handbook\n\nExisting main.\n\n" + history;
  save(before);
  const id = seed("A new independent operational rule");
  const fake = fakeFor(id, prompt => routing(prompt) ? { readBlockIds: [] } : patch([], "## New rule\nAn added fact."));
  expect((await runDreamCycle(store, {}, { client: fake })).errors).toEqual([]);
  const result = store.index().getPage(slug)!.content;
  expect(result).toContain("Existing main.");
  expect(result.indexOf("## New rule")).toBeLessThan(result.indexOf(detailsHeader));
  expect(result.endsWith(history)).toBe(true);
});

test.each([1500, 3000])("chat edition %i loads matching old evidence and keeps a newer known version authoritative", async updatedAt => {
  const meta = JSON.stringify([{ rawId: "old", type: "chat-source-snapshot", chatId: "oc_page_update", messageId: "om_release", updatedAt: 2000 }]);
  const history = detailsHeader + `### 来源分段 1\n\n来源元数据：${meta}\n\n` + "Message recovery fact.\n".repeat(3_000);
  const before = largePage().replace("Release timeout: 10 seconds.", "CURRENT_VERSION_2000") + "\n" + history;
  save(before);
  const entry = parseChatRawImport(JSON.stringify({ version: 1, chatId: "oc_page_update", startAt: 0, endAt: 4000,
    mainComplete: true, threadsComplete: true, olderThreadsScanned: true, failedMessageIds: [],
    messages: [{ messageId: "om_release", createdAt: 1000, updatedAt, text: `INCOMING_VERSION_${updatedAt}`, attachments: [] }] }), SPACE, "oc_page_update").entries[0]!;
  const id = chatRawImportId(SPACE, "oc_page_update", "om_release", updatedAt);
  store.index().captureImportedRaw(id, entry);
  let historyCharacters = 0;
  const fake = fakeFor(id, prompt => {
    if (routing(prompt)) return { readBlockIds: [] };
    expect(patching(prompt)).toBe(true);
    expect(prompt).toContain("## 群消息版本规则");
    expect(prompt).not.toContain("## 人工纠错规则");
    expect(prompt).toContain('已保存同消息的最新版本 metadata：[{"chatId":"oc_page_update","messageId":"om_release","updatedAt":2000}]');
    const blocks = jsonSection(prompt, "## 当前内容块");
    historyCharacters += blocks.filter(block => block.readonly).reduce((sum, block) => sum + block.content!.length, 0);
    return patch(updatedAt > 2000 ? blocks.filter(block => !block.readonly && block.content?.includes("CURRENT_VERSION_2000"))
      .map(block => ({ id: block.id, content: block.content!.replace("CURRENT_VERSION_2000", `CURRENT_VERSION_${updatedAt}`) })) : []);
  });
  expect((await runDreamCycle(store, {}, { client: fake })).errors).toEqual([]);
  expect(historyCharacters).toBeGreaterThan(60_000);
  const result = store.index().getPage(slug)!.content;
  expect(result.endsWith(history)).toBe(true);
  expect(result).toContain(`CURRENT_VERSION_${Math.max(2000, updatedAt)}`);
});

test("long shared-source extraction feeds local updates without replaying old pages", async () => {
  const before = largePage();
  const base = save(before);
  store.writePage({ ...base, slug: "concepts/second" });
  const id = seed("SOURCE_FIRST".padEnd(48_000, "x") + "SOURCE_TAIL");
  const fake = new FakeLlm().onJSON(opts => {
    const prompt = opts.prompt ?? "";
    if (prompt.includes("## 待提炼的原始条目")) return { operations: ["handbook", "second"].map(name => ({
      type: "concept", name, title: name, rawIds: [id] })), skippedRawIds: [] };
    if (prompt.includes("## 多页共享提取")) return { pages: [slug, "concepts/second"].map(target => ({
      slug: target, title: target, summary: "Evidence", content: prompt.includes("SOURCE_TAIL") ? "TAIL_FACT" : "FIRST_FACT", links: [] })) };
    if (routing(prompt)) return { readBlockIds: [] };
    expect(patching(prompt)).toBe(true);
    expect(prompt).toContain("FIRST_FACT");
    expect(prompt).toContain("TAIL_FACT");
    return patch([], "New knowledge is in the source details.");
  });
  const report = await runDreamCycle(store, {}, { client: fake });
  expect(report.errors).toEqual([]);
  expect(report.pagesWritten).toBe(2);
  expect(fake.calls.filter(call => call.opts.prompt?.includes("## 多页共享提取"))).toHaveLength(2);
  for (const target of [slug, "concepts/second"]) {
    const result = store.index().getPage(target)!;
    expect(result.content).toStartWith(before);
    expect(result.content).toContain("FIRST_FACT");
    expect(result.content).toContain("TAIL_FACT");
    expect(result.sources).toEqual([id]);
  }
});

test.each(["unknown", "duplicate"])("%s selection never writes or falls back to a whole-page rewrite", async failure => {
  save(largePage());
  const id = seed("New source");
  const fake = fakeFor(id, prompt => {
    const first = jsonSection(prompt, "## 旧页块目录")[0]!.id;
    return { readBlockIds: failure === "unknown" ? ["missing"] : [first, first] };
  });
  const report = await runDreamCycle(store, {}, { client: fake });
  expect(report.pagesQuarantined).toBe(1);
  expect(fake.calls).toHaveLength(2);
  expect(store.index().getPage(slug)?.content).toBe(largePage());
});

test("local patch rejects a changed page base before overwriting another update", async () => {
  const original = save(largePage());
  const id = seed("New source");
  const fake = fakeFor(id, prompt => {
    if (routing(prompt)) return { readBlockIds: [] };
    store.writePage({ ...original, content: "Concurrent edit" });
    return patch([], "New fact");
  });
  const report = await runDreamCycle(store, {}, { client: fake });
  expect(report.pagesQuarantined).toBe(1);
  expect(store.index().getPage(slug)?.content).toBe("Concurrent edit");
});

test("additional directory pages can be inspected without replaying the entire old page", async () => {
  const before = "# Handbook\n\n" + Array.from({ length: 160 }, (_, i) => `## Topic ${i}\n\n${"fact ".repeat(100)}\n\n`).join("");
  save(before);
  const id = seed("Weakly matched update");
  let nextRequests = 0;
  const fake = fakeFor(id, prompt => {
    if (routing(prompt)) return { readBlockIds: [] };
    const available = prompt.split(/## 可追加读取的块目录[^\n]*\n/u)[1]!.split("\n## 当前内容块")[0]!;
    const entries: Array<{ id: string; heading: string; selected: boolean }> = available.trim().split("\n")
      .filter(line => line.startsWith("{")).map(line => JSON.parse(line));
    const target = entries.find(block => block.heading === "Topic 159");
    if (!target) { nextRequests++; return { ...patch(), readNextCatalog: true }; }
    if (!target.selected) return patch([], "", [target.id]);
    const block = jsonSection(prompt, "## 当前内容块").find(block => block.id === target.id)!;
    return patch([{ id: block.id, content: block.content!.replace("fact ", "updated fact ") }]);
  });
  expect((await runDreamCycle(store, {}, { client: fake })).errors).toEqual([]);
  expect(nextRequests).toBeGreaterThan(0);
  expect(store.index().getPage(slug)?.content).toContain("## Topic 159\n\nupdated fact");
  expect(fake.calls.filter(call => patching(call.opts.prompt ?? "")).every(call => call.opts.prompt!.length < 32_000)).toBe(true);
});

test.each([48_000, 48_001])("old page size %i selects the intended generation path", async size => {
  save("x".repeat(size));
  const id = seed("Unrelated additional fact");
  const fake = fakeFor(id, prompt => routing(prompt) ? { readBlockIds: [] }
    : patching(prompt) ? patch([], "Additional fact")
      : { title: "Handbook", summary: "Updated", content: "Whole generated page", links: [] });
  const report = await runDreamCycle(store, {}, { client: fake });
  expect(report.errors).toEqual([]);
  expect(fake.calls.some(call => routing(call.opts.prompt ?? ""))).toBe(size > 48_000);
  if (size > 48_000) expect(store.index().getPage(slug)?.content).toStartWith("x".repeat(size));
});

test("the CLI JSON contract delivers local patches and retains frozen output limits", async () => {
  save(largePage());
  const id = seed("Release timeout is now 30 seconds.");
  const client = makeCliClient("codex", "", dir, async (_provider, input) => {
    expect(input.outputSchema).toBeDefined();
    expect(input.maxTokens).toBe(patching(input.prompt) ? 65_536 : 8_192);
    // Exercise real JSON serialization and parsing at the CLI boundary.
    if (patching(input.prompt)) {
      expect(input.outputSchema?.required).toContain("readNextCatalog");
      return JSON.stringify(patch(jsonSection(input.prompt, "## 当前内容块").filter(block => block.content?.includes("Release timeout"))
        .map(block => ({ id: block.id, content: block.content!.replace("10 seconds", "30 seconds") }))));
    }
    if (routing(input.prompt)) return JSON.stringify({ readBlockIds: jsonSection(input.prompt, "## 旧页块目录")
      .filter(block => block.heading.includes("Release")).map(block => block.id) });
    return JSON.stringify({ operations: [{ type: "concept", name: "handbook", title: "Handbook", rawIds: [id] }], skippedRawIds: [] });
  });
  expect((await runDreamCycle(store, {}, { client })).errors).toEqual([]);
  expect(store.index().getPage(slug)?.content).toBe(largePage().replace("10 seconds", "30 seconds"));
});

test("a failure in a later edit batch never commits earlier in-memory edits", async () => {
  const before = largePage();
  save(before);
  const id = seed("Correct the complete handbook", "manual");
  let edits = 0;
  const fake = fakeFor(id, prompt => {
    if (routing(prompt)) return { readBlockIds: [] };
    if (++edits === 2) throw new Error("later batch failed");
    const first = jsonSection(prompt, "## 当前内容块")[0]!;
    return patch([{ id: first.id, content: "# Changed title\n\n" }]);
  });
  const report = await runDreamCycle(store, {}, { client: fake });
  expect(edits).toBe(2);
  expect(report.pagesQuarantined).toBe(1);
  expect(store.index().getPage(slug)?.content).toBe(before);
  store.close();
  store = new SpaceStore(SPACE, dir);
  expect(store.readPageFile(slug)?.content).toBe(before);
});

test("a replacement without trailing newlines cannot join the next untouched heading", async () => {
  const before = largePage();
  save(before);
  const id = seed("Section 0 changed");
  const fake = fakeFor(id, prompt => routing(prompt) ? { readBlockIds: jsonSection(prompt, "## 旧页块目录")
    .filter(block => block.heading === "Section 0").map(block => block.id) }
    : patch(jsonSection(prompt, "## 当前内容块").filter(block => block.heading === "Section 0")
      .map(block => ({ id: block.id, content: "## Section 0\n\nNew fact." }))));
  expect((await runDreamCycle(store, {}, { client: fake })).errors).toEqual([]);
  expect(store.index().getPage(slug)?.content).toContain("New fact.\n\n## Section 1");
});

test.each(["oversized", "mixed-read", "no-next-catalog"])("rejects a %s patch without modifying the base", async failure => {
  save(largePage());
  const id = seed("Release update");
  let target = "";
  const fake = fakeFor(id, prompt => {
    if (routing(prompt)) {
      target = jsonSection(prompt, "## 旧页块目录").find(block => block.heading.includes("Release"))!.id;
      return { readBlockIds: [] };
    }
    if (failure === "oversized") return patch([], "x".repeat(65_536 * 16 + 1));
    if (failure === "mixed-read") return patch([], "New fact", [target]);
    return { ...patch(), readNextCatalog: true };
  });
  expect((await runDreamCycle(store, {}, { client: fake })).pagesQuarantined).toBe(1);
  expect(store.index().getPage(slug)?.content).toBe(largePage());
});
