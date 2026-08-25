import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spaceToDir, type Page, type SpaceId } from "@homeagent/shared";
import { KnowledgeEngine } from "./engine.ts";
import {
  LocalAgentKnowledge,
  type LocalAgentPageResult,
} from "./local-agent-knowledge.ts";

const TEAM: SpaceId = "team/oc_agent_feedback";
const PERSONAL: SpaceId = "personal/ou_agent_feedback";

function page(content = "发布前必须完成回归。\n"): Page {
  return {
    slug: "concepts/release",
    type: "concept",
    title: "发布流程",
    summary: "发布前检查要求",
    aliases: [],
    tags: ["发布"],
    sources: [],
    links: [],
    content,
    updatedAt: 1_777_000_000_000,
    contentHash: "release-v1",
  };
}

describe("Agent knowledge consumption feedback", () => {
  let dataDir: string;
  let engine: KnowledgeEngine;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "homeagent-consumption-feedback-"));
    engine = new KnowledgeEngine({ dataDir });
    engine.ensureSpace(TEAM);
    await engine.upsertPage(TEAM, page());
  });

  afterEach(() => {
    engine.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("records page feedback against the exact revision an Agent consumed", async () => {
    const reader = new LocalAgentKnowledge(engine);
    const pageResult = await reader.call("get_page", {
      space: TEAM,
      slug: "concepts/release",
    }) as LocalAgentPageResult;

    const recorded = await engine.submitAgentKnowledgeFeedback(TEAM, {
      idempotencyKey: "claude-run-42:feedback-1",
      consumer: "claude-code",
      kind: "incorrect",
      target: {
        kind: "page",
        slug: pageResult.page.slug,
        revision: pageResult.page.revision,
      },
      note: "回归范围已经变化。",
    });

    expect(engine.listAgentKnowledgeFeedback(TEAM)).toEqual([recorded]);
    expect(recorded).toMatchObject({
      space: TEAM,
      consumer: "claude-code",
      kind: "incorrect",
      target: {
        kind: "page",
        slug: "concepts/release",
        revision: pageResult.page.revision,
      },
      currentRevisionAtSubmission: pageResult.page.revision,
      status: "open",
      note: "回归范围已经变化。",
    });
  });

  test("only resolves a knowledge-changed report after the bound page revision changes", async () => {
    const reader = new LocalAgentKnowledge(engine);
    const pageResult = await reader.call("get_page", {
      space: TEAM,
      slug: "concepts/release",
    }) as LocalAgentPageResult;
    const recorded = await engine.submitAgentKnowledgeFeedback(TEAM, {
      idempotencyKey: "cursor-run-7:feedback-1",
      consumer: "cursor",
      kind: "stale",
      target: {
        kind: "page",
        slug: pageResult.page.slug,
        revision: pageResult.page.revision,
      },
      note: "这项发布要求已过期。",
    });

    await expect(engine.resolveAgentKnowledgeFeedback(TEAM, recorded.id, {
      actor: "operator",
      kind: "knowledge_changed",
      note: "已经更新知识页。",
    })).rejects.toMatchObject({ code: "conflict" });

    await engine.upsertPage(TEAM, {
      ...page("新的发布流程不再要求这项回归。\n"),
      updatedAt: 1_777_000_100_000,
      contentHash: "release-v2",
    });
    const resolved = await engine.resolveAgentKnowledgeFeedback(TEAM, recorded.id, {
      actor: "operator",
      kind: "knowledge_changed",
      note: "已经更新知识页。",
    });

    expect(resolved).toMatchObject({
      id: recorded.id,
      status: "resolved",
      resolution: {
        kind: "knowledge_changed",
        actor: "operator",
        note: "已经更新知识页。",
        currentRevision: expect.stringMatching(/^[a-f0-9]{64}$/),
        resolvedAt: expect.any(Number),
      },
    });
    expect(engine.listAgentKnowledgeFeedback(TEAM, { status: "open" })).toEqual([]);
  });

  test("acknowledges helpful signals without adding them to the human governance queue", async () => {
    const reader = new LocalAgentKnowledge(engine);
    const pageResult = await reader.call("get_page", {
      space: TEAM,
      slug: "concepts/release",
    }) as LocalAgentPageResult;

    const recorded = await engine.submitAgentKnowledgeFeedback(TEAM, {
      idempotencyKey: "windsurf-run-3:feedback-1",
      consumer: "windsurf",
      kind: "helpful",
      target: {
        kind: "page",
        slug: pageResult.page.slug,
        revision: pageResult.page.revision,
      },
    });

    expect(recorded).toMatchObject({
      status: "resolved",
      resolution: {
        kind: "helpful_acknowledged",
        actor: "windsurf",
      },
    });
    expect(engine.listAgentKnowledgeFeedback(TEAM, { status: "open" })).toEqual([]);
  });

  test("uses coverage resolution only for a bounded search miss", async () => {
    const reader = new LocalAgentKnowledge(engine);
    const pageResult = await reader.call("get_page", {
      space: TEAM,
      slug: "concepts/release",
    }) as LocalAgentPageResult;
    const pageFeedback = await engine.submitAgentKnowledgeFeedback(TEAM, {
      idempotencyKey: "copilot-run-4:feedback-page",
      consumer: "copilot",
      kind: "hard_to_reuse",
      target: {
        kind: "page",
        slug: pageResult.page.slug,
        revision: pageResult.page.revision,
      },
      note: "页面结构不便复用。",
    });

    await expect(engine.resolveAgentKnowledgeFeedback(TEAM, pageFeedback.id, {
      actor: "operator",
      kind: "coverage_recorded",
      note: "已经记录检索覆盖计划。",
    })).rejects.toMatchObject({ code: "invalid_input" });

    const searchFeedback = await engine.submitAgentKnowledgeFeedback(TEAM, {
      idempotencyKey: "copilot-run-4:feedback-search",
      consumer: "copilot",
      kind: "not_found",
      target: { kind: "search", query: "灰度发布负责人" },
      note: "没有找到可复用结果。",
    });
    const resolved = await engine.resolveAgentKnowledgeFeedback(TEAM, searchFeedback.id, {
      actor: "operator",
      kind: "coverage_recorded",
      note: "已纳入知识补充清单。",
    });

    expect(resolved).toMatchObject({
      target: { kind: "search", query: "灰度发布负责人" },
      status: "resolved",
      resolution: { kind: "coverage_recorded" },
    });
  });

  test("replays identical submissions idempotently and rejects key reuse", async () => {
    const input = {
      idempotencyKey: "continue-run-9:feedback-1",
      consumer: "continue",
      kind: "not_found" as const,
      target: { kind: "search" as const, query: "发布冻结窗口" },
      note: "没有搜索结果。",
    };

    const first = await engine.submitAgentKnowledgeFeedback(TEAM, input);
    const replay = await engine.submitAgentKnowledgeFeedback(TEAM, input);

    expect(replay.id).toBe(first.id);
    await expect(engine.submitAgentKnowledgeFeedback(TEAM, {
      ...input,
      note: "同一个 key 被用于另一条反馈。",
    })).rejects.toMatchObject({ code: "conflict" });
    expect(engine.listAgentKnowledgeFeedback(TEAM)).toHaveLength(1);
  });

  test("persists feedback across reopen and returns defensive copies", async () => {
    const recorded = await engine.submitAgentKnowledgeFeedback(TEAM, {
      idempotencyKey: "zed-run-1:feedback-1",
      consumer: "zed",
      kind: "not_found",
      target: { kind: "search", query: "应急发布联系人" },
    });
    recorded.target = { kind: "search", query: "被调用方篡改" };
    engine.close();

    engine = new KnowledgeEngine({ dataDir });

    expect(engine.listAgentKnowledgeFeedback(TEAM)).toEqual([
      expect.objectContaining({
        consumer: "zed",
        target: { kind: "search", query: "应急发布联系人" },
      }),
    ]);
  });

  test("keeps records isolated by Space even when Agents reuse an idempotency key", async () => {
    engine.ensureSpace(PERSONAL);
    const input = {
      idempotencyKey: "agent-run-shared:feedback-1",
      consumer: "local-agent",
      kind: "not_found" as const,
      target: { kind: "search" as const, query: "项目负责人" },
    };

    await engine.submitAgentKnowledgeFeedback(TEAM, input);
    await engine.submitAgentKnowledgeFeedback(PERSONAL, input);

    expect(engine.listAgentKnowledgeFeedback(TEAM)).toHaveLength(1);
    expect(engine.listAgentKnowledgeFeedback(PERSONAL)).toHaveLength(1);
    expect(engine.listAgentKnowledgeFeedback(TEAM)[0]?.space).toBe(TEAM);
    expect(engine.listAgentKnowledgeFeedback(PERSONAL)[0]?.space).toBe(PERSONAL);
  });

  test("fails closed on an unsafe persistence target without committing feedback", async () => {
    const feedbackPath = join(
      dataDir,
      "workspaces",
      spaceToDir(TEAM),
      "governance",
      "agent-consumption-feedback.json",
    );
    mkdirSync(feedbackPath, { recursive: true });

    await expect(engine.submitAgentKnowledgeFeedback(TEAM, {
      idempotencyKey: "unsafe-run:feedback-1",
      consumer: "unsafe-agent",
      kind: "not_found",
      target: { kind: "search", query: "不存在" },
    })).rejects.toMatchObject({ code: "corrupt_state" });

    rmSync(feedbackPath, { recursive: true, force: true });
    expect(engine.listAgentKnowledgeFeedback(TEAM)).toEqual([]);
  });

  test("rejects oversized externally supplied feedback fields", async () => {
    await expect(engine.submitAgentKnowledgeFeedback(TEAM, {
      idempotencyKey: "bounded-run:feedback-1",
      consumer: "bounded-agent",
      kind: "not_found",
      target: { kind: "search", query: "甲".repeat(501) },
    })).rejects.toMatchObject({ code: "invalid_input" });

    expect(engine.listAgentKnowledgeFeedback(TEAM)).toEqual([]);
  });

  test("summarizes open governance backlog without exposing notes or queries", async () => {
    await engine.submitAgentKnowledgeFeedback(TEAM, {
      idempotencyKey: "summary-run:feedback-1",
      consumer: "summary-agent",
      kind: "not_found",
      target: { kind: "search", query: "私密检索词" },
      note: "私密反馈说明",
    });
    await engine.submitAgentKnowledgeFeedback(TEAM, {
      idempotencyKey: "summary-run:feedback-2",
      consumer: "summary-agent",
      kind: "helpful",
      target: { kind: "search", query: "另一个私密检索词" },
    });

    const summary = engine.agentKnowledgeFeedbackSummary(TEAM);

    expect(summary).toEqual({
      total: 2,
      open: 1,
      resolved: 1,
      byKind: {
        helpful: 1,
        not_found: 1,
        incorrect: 0,
        stale: 0,
        conflicting: 0,
        hard_to_reuse: 0,
      },
    });
    expect(JSON.stringify(summary)).not.toContain("私密");
  });
});
