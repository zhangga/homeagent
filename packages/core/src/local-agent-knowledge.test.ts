import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page, SpaceId } from "@homeagent/shared";
import { KnowledgeEngine } from "./engine.ts";
import { LocalAgentKnowledge } from "./local-agent-knowledge.ts";

const TEAM: SpaceId = "team/oc_agent_reader";
const PERSONAL: SpaceId = "personal/ou_agent_reader";

function page(slug: string, title: string): Page {
  return {
    slug,
    type: "concept",
    title,
    summary: `${title}摘要`,
    aliases: [],
    tags: ["测试"],
    sources: [],
    links: [],
    content: `# ${title}\n\n正文。\n`,
    updatedAt: Date.now(),
    contentHash: `${slug}-hash`,
  };
}

describe("local Agent knowledge interface", () => {
  let dataDir: string;
  let engine: KnowledgeEngine;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "homeagent-agent-knowledge-"));
    engine = new KnowledgeEngine({ dataDir });
    engine.ensureSpace(TEAM);
    engine.ensureSpace(PERSONAL);
    engine.updateSpaceMeta(TEAM, { name: "研发群", chatId: "oc_private" });
    await engine.upsertPage(TEAM, page("concepts/release", "发布流程"));
    await engine.upsertPage(TEAM, {
      ...page("overview", "知识概览"),
      type: "overview",
      links: ["concepts/release"],
      content: "# 知识概览\n\n- [[concepts/release|发布流程]]\n",
    });
    await engine.upsertPage(PERSONAL, page("concepts/notes", "个人笔记"));
  });

  afterEach(() => {
    engine.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("lists a bounded safe Space summary without management metadata", async () => {
    const reader = new LocalAgentKnowledge(engine);

    const result = await reader.call("list_spaces", { limit: 1 });

    expect(result).toEqual({
      spaces: [{
        space: PERSONAL,
        kind: "personal",
        pageCount: 1,
      }],
      totalSpaces: 2,
      truncated: true,
    });
    expect(JSON.stringify(result)).not.toContain("oc_private");
    expect(JSON.stringify(result)).not.toContain("agentId");
  });

  test("reads one Space overview without Raw or projection internals", async () => {
    const reader = new LocalAgentKnowledge(engine);

    const result = await reader.call("get_overview", { space: TEAM });

    expect(result).toEqual({
      page: expect.objectContaining({
        space: TEAM,
        slug: "overview",
        type: "overview",
        title: "知识概览",
        content: expect.stringContaining("发布流程"),
      }),
    });
    expect(JSON.stringify(result)).not.toContain("contentHash");
    expect(JSON.stringify(result)).not.toContain("sources");
  });

  test("lists only bounded top-level Knowledge maps", async () => {
    await engine.upsertPage(TEAM, {
      ...page("maps/topic-release", "发布主题"),
      type: "map",
      summary: "发布知识入口",
    });
    await engine.upsertPage(TEAM, {
      ...page("maps/topic-release/deep", "发布子主题"),
      type: "map",
    });
    await engine.upsertPage(TEAM, {
      ...page("index", "知识索引"),
      type: "index",
      links: ["maps/topic-release"],
    });
    const reader = new LocalAgentKnowledge(engine);

    const result = await reader.call("list_maps", { space: TEAM, limit: 1 });

    expect(result).toEqual({
      maps: [{
        space: TEAM,
        slug: "maps/topic-release",
        title: "发布主题",
        summary: "发布知识入口",
        tags: ["测试"],
      }],
      totalMaps: 1,
      truncated: false,
    });
    expect(JSON.stringify(result)).not.toContain("发布子主题");
  });

  test("searches one explicit Space and never returns generated navigation pages", async () => {
    await engine.upsertPage(TEAM, {
      ...page("maps/topic-release", "发布发布发布地图"),
      type: "map",
    });
    const reader = new LocalAgentKnowledge(engine);

    const result = await reader.call("search_knowledge", {
      space: TEAM,
      query: "发布",
      limit: 8,
    });

    expect(result).toEqual({
      hits: [expect.objectContaining({
        space: TEAM,
        slug: "concepts/release",
        title: "发布流程",
        type: "concept",
      })],
      truncated: false,
    });
    expect(JSON.stringify(result)).not.toContain("maps/topic-release");
  });

  test("reads a page with an evidence summary but without Raw ids", async () => {
    const createdAt = Date.now() - 10_000;
    const rawId = await engine.remember({
      space: TEAM,
      source: "manual",
      content: "发布前必须完成回归。",
      createdAt,
    });
    await engine.upsertPage(TEAM, {
      ...page("concepts/release", "发布流程"),
      sources: [rawId],
    });
    const reader = new LocalAgentKnowledge(engine);

    const result = await reader.call("get_page", {
      space: TEAM,
      slug: "concepts/release",
    });

    expect(result).toEqual({
      page: expect.objectContaining({
        space: TEAM,
        slug: "concepts/release",
        content: expect.stringContaining("正文"),
      }),
      evidence: {
        sourceCount: 1,
        latestEvidenceAt: createdAt,
        freshness: "recent",
        complete: true,
      },
    });
    expect(JSON.stringify(result)).not.toContain(rawId);
    expect(JSON.stringify(result)).not.toContain("contentHash");
  });

  test("returns a stable opaque page revision that changes with knowledge content", async () => {
    const reader = new LocalAgentKnowledge(engine);

    const first = await reader.call("get_page", {
      space: TEAM,
      slug: "concepts/release",
    });
    const repeated = await reader.call("get_page", {
      space: TEAM,
      slug: "concepts/release",
    });

    if (!("page" in first) || !("page" in repeated)) {
      throw new Error("get_page returned an unexpected result");
    }

    expect(first.page.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(first.page.revision).toBe(repeated.page.revision);

    await engine.upsertPage(TEAM, {
      ...page("concepts/release", "发布流程"),
      content: "# 发布流程\n\n更新后的正文。\n",
    });
    const changed = await reader.call("get_page", {
      space: TEAM,
      slug: "concepts/release",
    });

    if (!("page" in changed)) {
      throw new Error("get_page returned an unexpected result");
    }

    expect(changed.page.revision).not.toBe(first.page.revision);
  });

  test("bounds an unusually large page body and marks the returned content incomplete", async () => {
    await engine.upsertPage(TEAM, {
      ...page("concepts/large", "超大页面"),
      content: "甲".repeat(200_001),
    });
    const reader = new LocalAgentKnowledge(engine);

    const result = await reader.call("get_page", {
      space: TEAM,
      slug: "concepts/large",
    });

    expect("page" in result && result.page.content.length).toBe(200_000);
    expect("page" in result && result.page.contentTruncated).toBe(true);
  });

  test("traces a page to bounded Raw metadata without returning Raw content", async () => {
    const createdAt = Date.now() - 20_000;
    const rawId = await engine.remember({
      space: TEAM,
      source: "message",
      author: "ou_owner",
      chatId: "oc_private_chat",
      messageId: "om_private_message",
      content: "不应通过 Agent 接口返回的原始正文",
      createdAt,
    });
    await engine.upsertPage(TEAM, {
      ...page("concepts/release", "发布流程"),
      sources: [rawId],
    });
    const reader = new LocalAgentKnowledge(engine);

    const result = await reader.call("get_page_trace", {
      space: TEAM,
      slug: "concepts/release",
    });

    expect(result).toEqual({
      trace: {
        space: TEAM,
        slug: "concepts/release",
        title: "发布流程",
        sourceCount: 1,
        sources: [{
          rawId,
          source: "message",
          admission: "ready",
          createdAt,
          author: "ou_owner",
        }],
        missingSourceIds: [],
        latestEvidenceAt: createdAt,
        freshness: "recent",
        complete: true,
        truncated: false,
      },
    });
    expect(JSON.stringify(result)).not.toContain("原始正文");
    expect(JSON.stringify(result)).not.toContain("messageId");
    expect(JSON.stringify(result)).not.toContain("chatId");
  });

  test("rejects undeclared arguments instead of silently broadening a query", async () => {
    const reader = new LocalAgentKnowledge(engine);

    await expect(reader.call("search_knowledge", {
      space: PERSONAL,
      query: "发布",
      spaces: [TEAM, PERSONAL],
    })).rejects.toMatchObject({
      name: "LocalAgentKnowledgeError",
      code: "invalid_input",
      message: "unexpected arguments",
    });
  });
});
