import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpaceId } from "@homeagent/shared";
import {
  AI_GENERATION_MAX_TOKENS,
  AI_ROUTING_MAX_TOKENS,
  resetConfig,
} from "@homeagent/shared";
import { SpaceStore } from "./space.ts";
import { regeneratePageFromSources, retryQuarantinedDreamOperation, runDreamCycle, isCacheHit } from "./dream.ts";
import { getQuarantineRecord, listQuarantineRecords } from "./quarantine.ts";
import { FakeLlm } from "./testing.ts";
import type { Page } from "@homeagent/shared";
import { makeCliClient } from "./cli-client.ts";
import { chatRawImportId, parseChatRawImport } from "./chat-raw-import.ts";

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

test("Dream distinguishes captured chat editions from administrator corrections", async () => {
  const entry = parseChatRawImport(JSON.stringify({ version: 1, chatId: "oc_dream", startAt: 0, endAt: 3000,
    mainComplete: true, threadsComplete: true, olderThreadsScanned: true, failedMessageIds: [],
    messages: [{ messageId: "om_revision", createdAt: 1000, updatedAt: 2000, text: "已完成恢复", attachments: [] }] }), SPACE, "oc_dream").entries[0]!;
  const id = chatRawImportId(SPACE, "oc_dream", "om_revision", 2000);
  store.index().captureImportedRaw(id, entry);
  const fake = new FakeLlm();
  fake.queueJSON({ operations: [{ type: "source", name: "incident", title: "应急记录", rawIds: [id] }], skippedRawIds: [] });
  fake.queueJSON({ title: "应急记录", summary: "已恢复", aliases: [], tags: [], links: [], content: "# 应急记录\n已完成恢复。" });
  await runDreamCycle(store, {}, { client: fake });
  const prompt = fake.calls.find(call => call.opts.prompt?.includes("## 相关原始来源"))?.opts.prompt ?? "";
  expect(prompt).toContain('type="chat-source-snapshot"');
  expect(prompt).toContain("旧版本只用于变更历史");
  expect(prompt).not.toContain("## 人工纠错规则");
  expect(store.index().getPage("sources/incident")?.sources).toEqual([id]);
});

function writeDreamCodexProvider(directory: string): { bin: string; calls: string } {
  const script = join(directory, "dream-codex.js");
  const bin = join(directory, process.platform === "win32" ? "dream-codex.cmd" : "dream-codex");
  const calls = join(directory, "dream-codex-calls.jsonl");
  writeFileSync(script, [
    'const { appendFileSync, existsSync, writeFileSync } = require("node:fs");',
    "const args = process.argv.slice(2);",
    'const schemaIndex = args.indexOf("--output-schema");',
    'const outputIndex = args.findIndex((arg) => arg === "-o" || arg === "--output-last-message");',
    'if (schemaIndex < 0 || !existsSync(args[schemaIndex + 1])) { process.stderr.write("missing schema"); process.exit(41); }',
    'if (outputIndex < 0 || !args[outputIndex + 1]) { process.stderr.write("missing final output"); process.exit(42); }',
    "let prompt = '';",
    'process.stdin.setEncoding("utf8");',
    "process.stdin.on('data', (chunk) => { prompt += chunk; });",
    "process.stdin.on('end', () => {",
    `  appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args, prompt }) + "\\n");`,
    '  if (prompt.includes("## JSON Schema")) { process.stderr.write("schema duplicated in prompt"); process.exitCode = 43; return; }',
    '  const rawId = /<(?:entry|source) id="([^"]+)"/.exec(prompt)?.[1];',
    '  const value = prompt.includes("## 待提炼的原始条目")',
    "    ? { operations: [{ type: 'concept', name: 'cli-seam', title: 'CLI Seam', rawIds: [rawId] }], skippedRawIds: [] }",
    "    : { title: 'CLI Seam', summary: '结构化边界已贯通。', aliases: [], tags: [], links: [], content: '# CLI Seam\\n\\n结构化边界已贯通。' };",
    '  writeFileSync(args[outputIndex + 1], JSON.stringify(value), "utf8");',
    "  process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 20, output_tokens: 10 } }));",
    "});",
  ].join("\n"), "utf8");
  writeFileSync(
    bin,
    process.platform === "win32"
      ? `@echo off\r\n"${process.execPath}" "%~dp0\\dream-codex.js" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/dream-codex.js" "$@"\n`,
    "utf8",
  );
  if (process.platform !== "win32") chmodSync(bin, 0o755);
  return { bin, calls };
}

describe("runDreamCycle", () => {
  test("keeps generated topic maps out of the Dream planning catalog", async () => {
    store.writePage({
      slug: "maps/hidden-map",
      type: "map",
      title: "不应参与提炼规划",
      summary: "系统生成的导航页。",
      aliases: [],
      tags: [],
      sources: [],
      links: [],
      content: "# 不应参与提炼规划\n",
      updatedAt: 1,
      contentHash: "map-hash",
    });
    const rawId = seedRaw("一条新的产品知识。");
    const fake = new FakeLlm();
    fake.queueJSON({ operations: [], skippedRawIds: [rawId] });

    await runDreamCycle(store, {}, { client: fake });

    const planningPrompt = fake.calls.find((call) => call.kind === "json")?.opts.prompt ?? "";
    expect(planningPrompt).not.toContain("maps/hidden-map");
    expect(planningPrompt).not.toContain("不应参与提炼规划");
  });

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
    expect(fake.calls.filter((call) => call.kind === "json").map((call) => call.opts.maxTokens))
      .toEqual([AI_ROUTING_MAX_TOKENS, AI_GENERATION_MAX_TOKENS]);
    expect(generationPrompt).toContain("aliases 只填写来源或既有页面明确支持");
    expect(generationPrompt).toContain("输出更新后的完整集合");
    expect(generationPrompt).toContain("不要为了提高检索召回而臆造");
    // raw marked ingested
    expect(store.index().countRaw(true)).toBe(0);
  });

  test("distills every part of a long Raw through bounded provider prompts", async () => {
    const markers = ["BEGIN_MARKER", "MIDDLE_MARKER", "END_MARKER"];
    const id = seedRaw([
      markers[0],
      "甲".repeat(55_000),
      markers[1],
      "乙".repeat(55_000),
      markers[2],
    ].join("\n"));
    const fake = new FakeLlm();
    let generation = 0;
    fake.onJSON((opts) => {
      if (opts.prompt?.includes("## 待提炼的原始条目")) {
        return {
          operations: [{ type: "source", name: "long-raw", title: "Long Raw", rawIds: [id] }],
          skippedRawIds: [],
        };
      }
      generation += 1;
      return {
        title: "Long Raw",
        summary: "长资料已分段提炼。",
        aliases: [],
        tags: [],
        links: [],
        content: `# Long Raw\n\n已合并第 ${generation} 段。`,
      };
    });

    const report = await runDreamCycle(store, {}, { client: fake });

    const prompts = fake.calls
      .filter((call) => call.kind === "json")
      .map((call) => call.opts.prompt ?? "");
    const generationPrompts = prompts.filter((prompt) => prompt.includes("## 相关原始来源"));
    const planningPrompts = prompts.filter((prompt) => prompt.includes("## 待提炼的原始条目"));
    expect(report.pagesWritten).toBe(1);
    expect(generationPrompts.length).toBeGreaterThan(1);
    expect(prompts.every((prompt) => prompt.length <= 100_000)).toBe(true);
    for (const marker of markers) {
      expect(generationPrompts.some((prompt) => prompt.includes(marker))).toBe(true);
      expect(planningPrompts.some((prompt) => prompt.includes(marker))).toBe(true);
    }
  });

  test("a useful middle fragment is not skipped when other fragments are noise", async () => {
    const id = seedRaw(`${"A".repeat(48_000)}MIDDLE_ONLY_FACT${"B".repeat(48_000)}`);
    const fake = new FakeLlm();
    fake.onJSON(opts => {
      if (opts.prompt?.includes("## 待提炼的原始条目")) return opts.prompt.includes("MIDDLE_ONLY_FACT")
        ? { operations: [{ type: "concept", name: "middle", title: "中间事实", rawIds: [id] }], skippedRawIds: [] }
        : { operations: [], skippedRawIds: [id] };
      return { title: "中间事实", summary: "中间事实", content: "MIDDLE_ONLY_FACT", links: [] };
    });
    const report = await runDreamCycle(store, {}, { client: fake });
    expect(report.skipped).toBe(0);
    expect(report.pagesWritten).toBe(1);
    expect(store.index().getPage("concepts/middle")?.sources).toEqual([id]);
    expect(store.index().countRaw(true)).toBe(0);
    expect(fake.calls.filter(call => call.opts.prompt?.includes("## 相关原始来源"))).toHaveLength(1);
  });

  test("extracts long-source facts independently and writes the whole page only once", async () => {
    const markers = ["FIRST_FACT", "MIDDLE_FACT", "TAIL_FACT"];
    const id = seedRaw(markers.map(marker => marker.padEnd(48_000, "文")).join(""));
    const existing: Page = { slug: "concepts/incremental", type: "concept", title: "增量提炼",
      summary: "原有知识", content: "# 增量提炼\n\nEXISTING_KNOWLEDGE", aliases: ["旧别名"], tags: [],
      links: [], sources: [], updatedAt: 1, contentHash: "old" };
    store.writePage(existing);
    const fake = new FakeLlm().onJSON(opts => {
      const prompt = opts.prompt ?? "";
      if (prompt.includes("## 待提炼的原始条目")) return {
        operations: [{ type: "concept", name: "incremental", title: "增量提炼", rawIds: [id] }], skippedRawIds: [],
      };
      if (prompt.includes("## 分段提炼结果")) return {
        title: "增量提炼", summary: "新知识导读", content: "# 增量提炼\n\nEXISTING_KNOWLEDGE\n新知识见分段详情。", links: [],
      };
      const facts = markers.filter(marker => prompt.includes(marker));
      return { title: "增量提炼", summary: facts.join("、"), content: facts.join("\n")
        + (prompt.includes("EXISTING_KNOWLEDGE") ? "\nEXISTING_KNOWLEDGE" : ""), links: [] };
    });
    const report = await runDreamCycle(store, {}, { client: fake });
    expect(report.errors).toEqual([]);
    const extraction = fake.calls.filter(call => call.opts.prompt?.includes("## 来源分段提取"));
    const synthesis = fake.calls.filter(call => call.opts.prompt?.includes("## 分段提炼结果"));
    expect(extraction).toHaveLength(3);
    expect(synthesis).toHaveLength(1);
    for (const [i, call] of extraction.entries()) {
      expect(call.opts.prompt).toContain(markers[i]!);
      expect(call.opts.prompt).not.toContain("EXISTING_KNOWLEDGE");
      expect(call.opts.prompt).toContain("不要生成或重写整页");
      for (const other of markers.filter((_, j) => i !== j)) expect(call.opts.prompt).not.toContain(other);
    }
    expect(synthesis[0]!.opts.prompt).toContain("EXISTING_KNOWLEDGE");
    for (const marker of markers) expect(store.index().getPage(existing.slug)?.content).toContain(marker);
    expect(store.index().getPage(existing.slug)?.content).toContain("EXISTING_KNOWLEDGE");
    expect(store.index().getPage(existing.slug)?.aliases).toEqual(["旧别名"]);
    expect(report.processedRawIds).toEqual([id]);
  });

  test("avoids cumulative page replay in a deterministic prompt and output volume comparison", async () => {
    const facts = Array.from({ length: 6 }, (_, i) => `FACT_${i}_END`.padEnd(1_000, "知"));
    const raw = facts.map((_, i) => `SOURCE_${i}_END`.padEnd(48_000, "文")).join("");
    const id = seedRaw(raw);
    const base = "EXISTING_KNOWLEDGE".padEnd(12_000, "旧");
    store.writePage({ slug: "concepts/volume", type: "concept", title: "调用量", summary: "旧知识", content: base,
      sources: [], links: [], aliases: [], tags: [], updatedAt: 1, contentHash: "old" });
    let outputCharacters = 0;
    const fake = new FakeLlm().onJSON(opts => {
      const prompt = opts.prompt ?? "";
      if (prompt.includes("## 待提炼的原始条目")) return {
        operations: [{ type: "concept", name: "volume", title: "调用量", rawIds: [id] }], skippedRawIds: [],
      };
      const index = facts.findIndex((_, i) => prompt.includes(`SOURCE_${i}_END`));
      const content = prompt.includes("## 来源分段提取") ? facts[index]! : `${base}\n${facts.join("\n")}`;
      outputCharacters += content.length;
      return { title: "调用量", summary: "事实导读", content, links: [] };
    });
    const report = await runDreamCycle(store, {}, { client: fake });
    expect(report.errors).toEqual([]);
    const legacyBodies = facts.map((_, i) => `${base}\n${facts.slice(0, i + 1).join("\n")}`);
    const legacyOutputCharacters = legacyBodies.reduce((sum, body) => sum + body.length, 0);
    const legacyInputCharacters = raw.length + base.length + legacyBodies.slice(0, -1).reduce((sum, body) => sum + body.length, 0);
    const inputCharacters = fake.calls.filter(call => !call.opts.prompt?.includes("## 待提炼的原始条目"))
      .reduce((sum, call) => sum + (call.opts.prompt?.length ?? 0), 0);
    expect(outputCharacters).toBeLessThan(legacyOutputCharacters * 0.4);
    expect(inputCharacters).toBeLessThan(legacyInputCharacters * 0.9);
    const page = store.index().getPage("concepts/volume")!;
    expect(page.content).toContain(base);
    for (const fact of facts) expect(page.content).toContain(fact);
  });

  test("Unicode boundaries preserve the complete source through independent extraction", async () => {
    const content = "BEGIN".padEnd(47_999, "文") + "😀TAIL_FACT";
    const id = seedRaw(content);
    const fake = new FakeLlm().onJSON(opts => opts.prompt?.includes("## 待提炼的原始条目")
      ? { operations: [{ type: "concept", name: "unicode", title: "Unicode", rawIds: [id] }], skippedRawIds: [] }
      : { title: "Unicode", summary: "Unicode", content: "BEGIN\n😀TAIL_FACT", links: [] });
    const report = await runDreamCycle(store, {}, { client: fake });
    expect(report.errors).toEqual([]);
    const extracted = fake.calls.filter(call => call.opts.prompt?.includes("## 来源分段提取"))
      .flatMap(call => [...call.opts.prompt!.matchAll(/<source[^>]*>\n([\s\S]*?)\n<\/source>/gu)].map(match => match[1]!));
    expect(extracted).toHaveLength(2);
    expect(extracted.join("")).toBe(content);
    expect(extracted[1]).toStartWith("😀");
  });

  test("invalid extraction metadata preserves the complete source in the retry plan", async () => {
    const id = seedRaw("FIRST".padEnd(48_000, "文") + "TAIL");
    const fake = new FakeLlm().onJSON(opts => opts.prompt?.includes("## 待提炼的原始条目")
      ? { operations: [{ type: "concept", name: "invalid-note", title: "无效片段", rawIds: [id] }], skippedRawIds: [] }
      : { title: "无效片段", summary: "摘".repeat(1_001), content: "FIRST", links: [] });
    const report = await runDreamCycle(store, {}, { client: fake });
    expect(report.pagesWritten).toBe(0);
    expect(report.pagesQuarantined).toBe(1);
    expect(fake.calls.filter(call => call.opts.prompt?.includes("## 分段提炼结果"))).toEqual([]);
    const record = listQuarantineRecords(store)[0]!;
    expect(record.operation?.sourceFragments?.map(fragment => fragment.part)).toEqual([1, 2]);
    expect(store.index().getRaw(id)?.content).toContain("TAIL");
  });

  test("retains oversized extracted details verbatim instead of summarizing facts away", async () => {
    const id = seedRaw("FIRST_SOURCE".padEnd(48_000, "文") + "LAST_SOURCE");
    const details = ["    const indented = 1;\n\nFIRST_DETAIL 123ms\n```ts\nconst x = 1;\n```\n" + "甲".repeat(30_000),
      "乙".repeat(30_000) + "\nTAIL_DETAIL：仅当 enabled=true 时生效。"];
    let extraction = 0;
    const fake = new FakeLlm().onJSON(opts => {
      const prompt = opts.prompt ?? "";
      if (prompt.includes("## 待提炼的原始条目")) return {
        operations: [{ type: "concept", name: "details", title: "完整细节", rawIds: [id] }], skippedRawIds: [],
      };
      if (prompt.includes("## 来源分段提取")) return { title: "完整细节", summary: `分段导读 ${++extraction}`,
        content: details[extraction - 1], links: ["concepts/related"] };
      expect(prompt.length).toBeLessThan(52_000);
      expect(prompt).not.toContain("甲".repeat(100));
      expect(prompt).not.toContain("乙".repeat(100));
      expect(prompt).toContain("分段导读 1");
      expect(prompt).toContain("分段导读 2");
      return { title: "完整细节", summary: "导读", content: "# 完整细节\n\n集中整理的导读。", links: [] };
    });
    const report = await runDreamCycle(store, {}, { client: fake });
    expect(report.errors).toEqual([]);
    expect(report.pagesWritten).toBe(1);
    expect(fake.calls.filter(call => call.opts.prompt?.includes("## 分段提炼结果"))).toHaveLength(1);
    const page = store.index().getPage("concepts/details")!;
    for (const detail of details) expect(page.content).toContain(detail);
    expect(page.content).toContain(`${id}（1/2）`);
    expect(page.content).toContain(`${id}（2/2）`);
    expect(page.links).toContain("concepts/related");
    store.close();
    store = new SpaceStore(SPACE, dir);
    for (const detail of details) expect(store.index().getPage(page.slug)?.content).toContain(detail);
    expect(store.index().getRaw(id)?.content).toContain("LAST_SOURCE");
  });

  test("bounds a large section overview while retaining every evidence body", async () => {
    const count = 50;
    const id = seedRaw(Array.from({ length: count }, (_, i) => `RAW_${i}`.padEnd(48_000, "文")).join(""));
    let extraction = 0;
    let overviewCalls = 0;
    const fake = new FakeLlm().onJSON(opts => {
      const prompt = opts.prompt ?? "";
      if (prompt.includes("## 待提炼的原始条目")) return {
        operations: [{ type: "concept", name: "many-details", title: "分段细节", rawIds: [id] }], skippedRawIds: [],
      };
      if (prompt.includes("## 来源分段提取")) {
        extraction += 1;
        return { title: "分段细节", summary: `导读 ${extraction}`.padEnd(1_000, "导"),
          content: `DETAIL_${extraction}_END`.padEnd(1_001, "知"), links: [] };
      }
      if (prompt.includes("## 分段提炼导读压缩")) {
        overviewCalls += 1;
        return { summary: "全部细节的主题导航" };
      }
      return { title: "分段细节", summary: "总览", content: "# 分段细节\n总览。", links: [] };
    });
    const report = await runDreamCycle(store, {}, { client: fake });
    expect(report.errors).toEqual([]);
    expect(extraction).toBe(count);
    expect(overviewCalls).toBeGreaterThan(0);
    expect(fake.calls.every(call => (call.opts.prompt?.length ?? 0) < 55_000)).toBe(true);
    const page = store.index().getPage("concepts/many-details")!;
    for (let i = 1; i <= count; i += 1) expect(page.content).toContain(`DETAIL_${i}_END`);
    expect(report.processedRawIds).toEqual([id]);
  });

  test("the final merge retains source types and chat edition identity after independent extraction", async () => {
    const entry = parseChatRawImport(JSON.stringify({ version: 1, chatId: "oc_dream", startAt: 0, endAt: 3000,
      mainComplete: true, threadsComplete: true, olderThreadsScanned: true, failedMessageIds: [],
      messages: [{ messageId: "om_edition", createdAt: 1000, updatedAt: 2000,
        text: "最新消息版本".padEnd(49_000, "文"), attachments: [] }] }), SPACE, "oc_dream").entries[0]!;
    const id = chatRawImportId(SPACE, "oc_dream", "om_edition", 2000);
    store.index().captureImportedRaw(id, entry);
    const correction = store.index().insertRaw({ space: SPACE, source: "manual", content: "管理员纠错：使用新版配置" });
    const fake = new FakeLlm().onJSON(opts => {
      if (opts.prompt?.includes("## 待提炼的原始条目")) return {
        operations: [{ type: "concept", name: "edition", title: "消息版本", rawIds: [id, correction] }], skippedRawIds: [],
      };
      return { title: "消息版本", summary: "版本导读", content: "该段中的版本事实。", links: [] };
    });
    const report = await runDreamCycle(store, {}, { client: fake });
    expect(report.errors).toEqual([]);
    const prompt = fake.calls.find(call => call.opts.prompt?.includes("## 分段提炼结果"))!.opts.prompt!;
    expect(prompt).toContain('"type":"chat-source-snapshot"');
    expect(prompt).toContain('"messageId":"om_edition"');
    expect(prompt).toContain('"updatedAt":2000');
    expect(prompt).toContain('"type":"manual"');
    expect(prompt).toContain("## 人工纠错规则");
    expect(prompt).toContain("## 群消息版本规则");
  });

  test.each(["extract", "merge", "save"])("%s failure preserves the page and a complete retry plan across reopen", async failure => {
    const id = seedRaw("FIRST_RETRY".padEnd(48_000, "文") + "TAIL_RETRY");
    const slug = "concepts/retry-long";
    store.writePage({ slug, type: "concept", title: "重试", summary: "旧知识", content: "EXISTING_FACT",
      sources: [], links: [], aliases: [], tags: [], updatedAt: 1, contentHash: "old" });
    let extraction = 0;
    const fake = new FakeLlm().onJSON(opts => {
      const prompt = opts.prompt ?? "";
      if (prompt.includes("## 待提炼的原始条目")) return {
        operations: [{ type: "concept", name: "retry-long", title: "重试", rawIds: [id] }], skippedRawIds: [],
      };
      if (prompt.includes("## 来源分段提取") && ++extraction === 2 && failure === "extract") throw new Error("extraction failed");
      if (prompt.includes("## 分段提炼结果") && failure === "merge") throw new Error("merge failed");
      return { title: "重试", summary: "重试", content: "FIRST_RETRY\nTAIL_RETRY", links: [] };
    });
    const writePage = store.writePage.bind(store);
    const write = spyOn(store, "writePage").mockImplementation(page => {
      if (failure === "save" && page.slug === slug) throw new Error("save failed");
      writePage(page);
    });
    let report;
    try { report = await runDreamCycle(store, {}, { client: fake }); } finally { write.mockRestore(); }
    expect(report.pagesWritten).toBe(0);
    expect(report.pagesQuarantined).toBe(1);
    expect(store.index().getPage(slug)?.content).toBe("EXISTING_FACT");
    const recordId = listQuarantineRecords(store)[0]!.id;
    store.close();
    store = new SpaceStore(SPACE, dir);
    const record = getQuarantineRecord(store, recordId)!;
    expect(record.operation?.sourceFragments?.map(fragment => fragment.part)).toEqual([1, 2]);
    const retry = new FakeLlm().onJSON(opts => {
      const prompt = opts.prompt ?? "";
      expect(prompt).not.toContain("## 待提炼的原始条目");
      return { title: "重试", summary: "重试", content: ["FIRST_RETRY", "TAIL_RETRY", "EXISTING_FACT"]
        .filter(fact => prompt.includes(fact)).join("\n"), links: [] };
    });
    const recovered = await retryQuarantinedDreamOperation(store, record, {}, { client: retry });
    expect(recovered.errors).toEqual([]);
    expect(retry.calls).toHaveLength(3);
    expect(retry.calls.filter(call => call.opts.prompt?.includes("## 分段提炼结果"))).toHaveLength(1);
    expect(store.index().getPage(slug)?.content).toContain("FIRST_RETRY");
    expect(store.index().getPage(slug)?.content).toContain("TAIL_RETRY");
    expect(store.index().getPage(slug)?.content).toContain("EXISTING_FACT");
  });

  test("cancellation between extractions does not launch another fragment or write a partial page", async () => {
    const id = seedRaw("FIRST".padEnd(48_000, "文") + "TAIL");
    const abort = new AbortController();
    const fake = new FakeLlm().onJSON(opts => {
      if (opts.prompt?.includes("## 待提炼的原始条目")) return {
        operations: [{ type: "concept", name: "cancel-long", title: "取消", rawIds: [id] }], skippedRawIds: [],
      };
      abort.abort(new Error("cancelled"));
      return { title: "取消", summary: "片段", content: "FIRST", links: [] };
    });
    await expect(runDreamCycle(store, { signal: abort.signal }, { client: fake })).rejects.toThrow("cancelled");
    expect(fake.calls.filter(call => call.opts.prompt?.includes("## 相关原始来源"))).toHaveLength(1);
    expect(store.index().getPage("concepts/cancel-long")).toBeNull();
    expect(store.index().countRaw(true)).toBe(1);
    expect(listQuarantineRecords(store)).toEqual([]);
  });

  test("routes long source fragments to their planned pages without replaying unrelated parts", async () => {
    const markers = ["FIRST_TOPIC", "SECOND_TOPIC", "LAST_TOPIC"];
    const content = markers.map(marker => marker.padEnd(48_000, "文")).join("");
    const id = seedRaw(content);
    const fake = new FakeLlm();
    fake.onJSON(opts => {
      const prompt = opts.prompt ?? "";
      if (prompt.includes("## 待提炼的原始条目")) {
        const name = prompt.includes("SECOND_TOPIC") ? "second" : "first-and-last";
        const op = { type: "concept", name, title: name, rawIds: [id] };
        return { operations: [op, op], skippedRawIds: [] };
      }
      return { title: "相关主题", summary: "", content: markers.filter(marker => prompt.includes(marker)).join("\n") };
    });

    const report = await runDreamCycle(store, {}, { client: fake });
    const generated = fake.calls.filter(call => call.opts.prompt?.includes("## 相关原始来源"));
    expect(generated).toHaveLength(3);
    const sources = generated.flatMap(call => [...call.opts.prompt!.matchAll(/<source[^>]*part="(\d+)\/3">\n([\s\S]*?)\n<\/source>/gu)]
      .map(match => ({ part: Number(match[1]), content: match[2]! })));
    expect(sources.sort((a, b) => a.part - b.part).map(source => source.content).join("")).toBe(content);
    expect(store.index().getPage("concepts/first-and-last")?.content).toContain("FIRST_TOPIC\nLAST_TOPIC");
    expect(store.index().getPage("concepts/first-and-last")?.content).not.toContain("SECOND_TOPIC");
    expect(store.index().getPage("concepts/second")?.content).toContain("SECOND_TOPIC");
    expect(report.processedRawIds).toEqual([id]);
    expect(report.pagesWritten).toBe(2);
  });

  test("an unclassified later fragment cannot be marked ingested by an earlier page", async () => {
    const id = seedRaw("FIRST_FACT".padEnd(48_000, "文") + "UNCLASSIFIED_TAIL");
    const fake = new FakeLlm();
    fake.onJSON(opts => opts.prompt?.includes("## 待提炼的原始条目")
      ? { operations: opts.prompt.includes("FIRST_FACT") ? [{ type: "concept", name: "first", title: "First", rawIds: [id] }] : [], skippedRawIds: [] }
      : { title: "First", content: "FIRST_FACT" });
    const report = await runDreamCycle(store, {}, { client: fake });
    expect(report.processedRawIds).toEqual([]);
    expect(report.errors).not.toHaveLength(0);
    expect(store.index().countRaw(true)).toBe(1);
    store.close();
    store = new SpaceStore(SPACE, dir);
    expect(store.index().getRaw(id)?.content).toContain("UNCLASSIFIED_TAIL");
    expect(store.index().countRaw(true)).toBe(1);
  });

  test("quarantine retries retain only the frozen relevant fragments after reopen", async () => {
    const id = seedRaw("UNRELATED_TOPIC".padEnd(48_000, "文") + "RETRY_TOPIC");
    const fake = new FakeLlm();
    fake.onJSON(opts => {
      if (opts.prompt?.includes("## 待提炼的原始条目")) return opts.prompt.includes("RETRY_TOPIC")
        ? { operations: [{ type: "concept", name: "retry-fragment", title: "Retry", rawIds: [id] }], skippedRawIds: [] }
        : { operations: [], skippedRawIds: [id] };
      throw new Error("capacity");
    });
    await runDreamCycle(store, {}, { client: fake });
    const recordId = listQuarantineRecords(store)[0]!.id;
    store.close();
    store = new SpaceStore(SPACE, dir);
    const record = getQuarantineRecord(store, recordId)!;
    const retry = new FakeLlm().queueJSON({ title: "Retry", content: "RETRY_TOPIC" });
    const report = await retryQuarantinedDreamOperation(store, record, {}, { client: retry });
    expect(report.errors).toEqual([]);
    expect(retry.calls).toHaveLength(1);
    expect(retry.calls[0]!.opts.prompt).toContain("RETRY_TOPIC");
    expect(retry.calls[0]!.opts.prompt).not.toContain("UNRELATED_TOPIC");
    expect(store.index().getPage("concepts/retry-fragment")?.sources).toEqual([id]);
  });

  test("failed later planning fragments leave all source material pending for retry", async () => {
    const id = seedRaw("A".repeat(100_000));
    const fake = new FakeLlm();
    let calls = 0;
    fake.onJSON(() => {
      if (++calls > 1) throw new Error("later planning failed");
      return { operations: [], skippedRawIds: [id] };
    });
    const report = await runDreamCycle(store, {}, { client: fake });
    expect(report.pagesWritten).toBe(0);
    expect(report.errors).toHaveLength(1);
    expect(store.index().countRaw(true)).toBe(1);
    expect(report.processedRawIds).toEqual([]);
    const retry = new FakeLlm();
    retry.onJSON(() => ({ operations: [], skippedRawIds: [id] }));
    expect((await runDreamCycle(store, {}, { client: retry })).skipped).toBe(1);
    expect(store.index().countRaw(true)).toBe(0);
  });

  test("distills through the real Codex CLI adapter final-artifact seam", async () => {
    const previous = process.env.HOMEAGENT_CODEX_BIN;
    const provider = writeDreamCodexProvider(dir);
    process.env.HOMEAGENT_CODEX_BIN = provider.bin;
    try {
      const rawId = seedRaw("结构化输出应从最终产物文件进入 Dream。");
      const client = makeCliClient("codex", "", dir);

      const report = await runDreamCycle(store, {}, { client });

      expect(report).toEqual(expect.objectContaining({
        pagesWritten: 1,
        pagesQuarantined: 0,
      }));
      expect(store.index().getPage("concepts/cli-seam")).toEqual(expect.objectContaining({
        sources: [rawId],
        content: "# CLI Seam\n\n结构化边界已贯通。\n",
      }));
      const calls = readFileSync(provider.calls, "utf8")
        .trim()
        .split(/\r?\n/u)
        .map((line) => JSON.parse(line) as { args: string[]; prompt: string });
      expect(calls).toHaveLength(2);
      expect(calls.every((call) => call.args.includes("-o"))).toBe(true);
      expect(calls.every((call) => !call.prompt.includes("## JSON Schema"))).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.HOMEAGENT_CODEX_BIN;
      else process.env.HOMEAGENT_CODEX_BIN = previous;
    }
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
    // index reveals the topic map, which then links to the content page
    expect(store.index().getPage("index")!.links).toEqual(["maps/type-entity"]);
    expect(store.index().getPage("maps/type-entity")!.content).toContain("entities/orion");
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
