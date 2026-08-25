import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
import { resetConfig } from "@homeagent/shared";
import { SpaceStore } from "./space.ts";
import { regeneratePageFromSources, runDreamCycle, isCacheHit } from "./dream.ts";
import { FakeLlm } from "./testing.ts";
import type { Page } from "@homeagent/shared";
import { makeCliClient } from "./cli-client.ts";

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
    expect(report.pagesWritten).toBe(1);
    expect(generationPrompts.length).toBeGreaterThan(1);
    expect(prompts.every((prompt) => prompt.length <= 100_000)).toBe(true);
    for (const marker of markers) {
      expect(generationPrompts.some((prompt) => prompt.includes(marker))).toBe(true);
    }
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
