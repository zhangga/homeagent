import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeEngine, knowledgePageRevision } from "@homeagent/core";
import type { Page, SpaceId } from "@homeagent/shared";
import { createWebApp } from "./app.ts";

const SPACE: SpaceId = "team/oc_local_agent_api";

function page(): Page {
  return {
    slug: "concepts/release",
    type: "concept",
    title: "发布流程",
    summary: "发布前的检查流程。",
    aliases: [],
    tags: ["发布"],
    sources: [],
    links: [],
    content: "# 发布流程\n\n发布前必须完成回归。\n",
    updatedAt: Date.now(),
    contentHash: "release-hash",
  };
}

describe("local Agent read-only JSON API", () => {
  let dataDir: string;
  let engine: KnowledgeEngine;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "homeagent-agent-api-"));
    engine = new KnowledgeEngine({ dataDir });
    engine.ensureSpace(SPACE);
    await engine.upsertPage(SPACE, page());
  });

  afterEach(() => {
    engine.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("serves the bounded core query contract from the running HomeAgent process", async () => {
    const app = createWebApp({ engine });

    const response = await app.request("http://127.0.0.1/api/agent/v1/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tool: "search_knowledge",
        arguments: { space: SPACE, query: "发布", limit: 8 },
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      result: {
        hits: [expect.objectContaining({
          space: SPACE,
          slug: "concepts/release",
          title: "发布流程",
        })],
        truncated: false,
      },
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("accepts a dedicated read token only on the Agent API", async () => {
    const app = createWebApp({
      engine,
      adminToken: "admin-secret",
      agentReadToken: "agent-read-secret",
    });
    const authorization = { authorization: "Bearer agent-read-secret" };

    const query = await app.request("http://127.0.0.1/api/agent/v1/query", {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({ tool: "list_spaces", arguments: {} }),
    });
    const management = await app.request("http://127.0.0.1/", {
      headers: authorization,
    });

    expect(query.status).toBe(200);
    expect(management.status).toBe(401);
  });

  test("uses a separate feedback token that cannot read knowledge or open management", async () => {
    const app = createWebApp({
      engine,
      adminToken: "admin-secret",
      agentReadToken: "agent-read-secret",
      agentFeedbackToken: "agent-feedback-secret",
    });
    const revision = knowledgePageRevision((await engine.getPage(SPACE, "concepts/release"))!);
    const feedbackAuthorization = { authorization: "Bearer agent-feedback-secret" };

    const feedback = await app.request("http://127.0.0.1/api/agent/v1/feedback", {
      method: "POST",
      headers: { ...feedbackAuthorization, "content-type": "application/json" },
      body: JSON.stringify({
        space: SPACE,
        idempotencyKey: "external-agent-run-1:feedback-1",
        consumer: "external-agent",
        kind: "incorrect",
        target: { kind: "page", slug: "concepts/release", revision },
        note: "要求已经变化。",
      }),
    });
    const query = await app.request("http://127.0.0.1/api/agent/v1/query", {
      method: "POST",
      headers: { ...feedbackAuthorization, "content-type": "application/json" },
      body: JSON.stringify({ tool: "list_spaces", arguments: {} }),
    });
    const management = await app.request("http://127.0.0.1/", {
      headers: feedbackAuthorization,
    });
    const readTokenWrite = await app.request("http://127.0.0.1/api/agent/v1/feedback", {
      method: "POST",
      headers: {
        authorization: "Bearer agent-read-secret",
        "content-type": "application/json",
      },
      body: "{}",
    });

    expect(feedback.status).toBe(200);
    expect(await feedback.json()).toEqual({
      ok: true,
      feedback: expect.objectContaining({
        space: SPACE,
        consumer: "external-agent",
        status: "open",
      }),
    });
    expect(engine.listAgentKnowledgeFeedback(SPACE)).toHaveLength(1);
    expect(query.status).toBe(401);
    expect(management.status).toBe(401);
    expect(readTokenWrite.status).toBe(401);
  });

  test("refuses to reuse a read or management credential as the feedback token", () => {
    expect(() => createWebApp({
      engine,
      adminToken: "admin-secret",
      agentReadToken: "shared-secret",
      agentFeedbackToken: "shared-secret",
    })).toThrow(/feedback token must be distinct/);
    expect(() => createWebApp({
      engine,
      adminToken: "admin-secret",
      agentFeedbackToken: "admin-secret",
    })).toThrow(/feedback token must be distinct/);
  });

  test("rejects undeclared tools and oversized requests without changing knowledge", async () => {
    const app = createWebApp({ engine });
    const before = await engine.getPage(SPACE, "concepts/release");

    const unknownTool = await app.request("http://127.0.0.1/api/agent/v1/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tool: "delete_page",
        arguments: { space: SPACE, slug: "concepts/release" },
      }),
    });
    const oversized = await app.request("http://127.0.0.1/api/agent/v1/query", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(65 * 1024),
      },
      body: "{}",
    });
    const streamedOversized = await app.request("http://127.0.0.1/api/agent/v1/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tool: "search_knowledge",
        arguments: { space: SPACE, query: "甲".repeat(65 * 1024) },
      }),
    });

    expect(unknownTool.status).toBe(400);
    expect(await unknownTool.json()).toEqual({
      ok: false,
      error: { code: "invalid_input", message: "invalid query request" },
    });
    expect(oversized.status).toBe(413);
    expect(streamedOversized.status).toBe(413);
    expect(await engine.getPage(SPACE, "concepts/release")).toEqual(before);
  });
});
