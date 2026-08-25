import { describe, expect, test } from "bun:test";
import { handleMcpLine, KnowledgeMcpServer } from "./mcp.ts";
import { LocalAgentApiError } from "./local-agent-client.ts";

describe("HomeAgent local knowledge MCP server", () => {
  test("negotiates the current protocol and advertises only deterministic read-only tools", async () => {
    const server = new KnowledgeMcpServer({
      call: async () => ({ spaces: [], totalSpaces: 0, truncated: false }),
    });

    const initialized = await server.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
      },
    });
    const notification = await server.handle({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    const listed = await server.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });

    expect(initialized).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: expect.objectContaining({
        protocolVersion: "2025-11-25",
        capabilities: { tools: { listChanged: false } },
        serverInfo: expect.objectContaining({ name: "homeagent-knowledge" }),
      }),
    });
    expect(notification).toBeNull();
    expect(listed).toEqual({
      jsonrpc: "2.0",
      id: 2,
      result: {
        tools: expect.arrayContaining([
          expect.objectContaining({ name: "list_spaces" }),
          expect.objectContaining({ name: "get_overview" }),
          expect.objectContaining({ name: "list_maps" }),
          expect.objectContaining({ name: "search_knowledge" }),
          expect.objectContaining({ name: "get_page" }),
          expect.objectContaining({ name: "get_page_trace" }),
        ]),
      },
    });
    const tools = (listed as { result: { tools: Array<{ annotations: Record<string, boolean> }> } })
      .result.tools;
    expect(tools).toHaveLength(6);
    expect(tools.every((tool) => tool.annotations.readOnlyHint === true)).toBeTrue();
    expect(tools.every((tool) => tool.annotations.destructiveHint === false)).toBeTrue();
    expect(tools.every((tool) => tool.annotations.openWorldHint === false)).toBeTrue();
  });

  test("returns the same bounded JSON as MCP text and structured content", async () => {
    const calls: Array<{ tool: string; args?: Record<string, unknown> }> = [];
    const server = new KnowledgeMcpServer({
      call: async (tool, args) => {
        calls.push({ tool, args });
        return {
          hits: [{
            space: "team/oc_mcp",
            slug: "concepts/release",
            title: "发布流程",
            type: "concept",
            snippet: "发布前完成回归",
          }],
          truncated: false,
        };
      },
    });
    await server.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
      },
    });
    await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" });

    const response = await server.handle({
      jsonrpc: "2.0",
      id: "call-1",
      method: "tools/call",
      params: {
        name: "search_knowledge",
        arguments: { space: "team/oc_mcp", query: "发布", limit: 8 },
      },
    });

    expect(calls).toEqual([{
      tool: "search_knowledge",
      args: { space: "team/oc_mcp", query: "发布", limit: 8 },
    }]);
    expect(response).toEqual({
      jsonrpc: "2.0",
      id: "call-1",
      result: {
        content: [{
          type: "text",
          text: JSON.stringify({
            hits: [{
              space: "team/oc_mcp",
              slug: "concepts/release",
              title: "发布流程",
              type: "concept",
              snippet: "发布前完成回归",
            }],
            truncated: false,
          }),
        }],
        structuredContent: {
          hits: [{
            space: "team/oc_mcp",
            slug: "concepts/release",
            title: "发布流程",
            type: "concept",
            snippet: "发布前完成回归",
          }],
          truncated: false,
        },
        isError: false,
      },
    });
  });

  test("optionally advertises and submits idempotent non-destructive feedback", async () => {
    const submissions: unknown[] = [];
    const server = new KnowledgeMcpServer({
      call: async () => ({ spaces: [], totalSpaces: 0, truncated: false }),
      submitFeedback: async (space, input) => {
        submissions.push({ space, input });
        return {
          id: "agent_feedback_mcp",
          idempotencyKey: input.idempotencyKey,
          space,
          consumer: input.consumer,
          kind: input.kind,
          target: input.target,
          status: "open",
          createdAt: 1_777_000_000_000,
        };
      },
    }, { feedbackEnabled: true });
    await server.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
      },
    });
    await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" });

    const listed = await server.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    const called = await server.handle({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "submit_knowledge_feedback",
        arguments: {
          space: "team/oc_mcp",
          idempotencyKey: "mcp-run-1:feedback-1",
          consumer: "mcp-agent",
          kind: "not_found",
          target: { kind: "search", query: "发布负责人" },
          note: "没有命中。",
        },
      },
    });

    const tools = (listed as {
      result: { tools: Array<{ name: string; annotations: Record<string, boolean> }> };
    }).result.tools;
    expect(tools).toHaveLength(7);
    expect(tools.find((tool) => tool.name === "submit_knowledge_feedback")?.annotations)
      .toEqual({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
    expect(submissions).toEqual([{
      space: "team/oc_mcp",
      input: {
        idempotencyKey: "mcp-run-1:feedback-1",
        consumer: "mcp-agent",
        kind: "not_found",
        target: { kind: "search", query: "发布负责人" },
        note: "没有命中。",
      },
    }]);
    expect(called).toEqual({
      jsonrpc: "2.0",
      id: 3,
      result: expect.objectContaining({ isError: false }),
    });
  });

  test("frames each stdio line as one JSON-RPC message and bounds malformed input", async () => {
    const server = new KnowledgeMcpServer({
      call: async () => ({ spaces: [], totalSpaces: 0, truncated: false }),
    });

    const malformed = await handleMcpLine(server, "{not-json");
    const oversized = await handleMcpLine(server, `{"x":"${"x".repeat(1024 * 1024)}"}`);

    expect(JSON.parse(malformed!)).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
    expect(JSON.parse(oversized!)).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Message too large" },
    });
    expect(malformed).not.toContain("\n");
    expect(oversized).not.toContain("x".repeat(100));
  });

  test("returns safe query failures as model-correctable tool errors", async () => {
    const server = new KnowledgeMcpServer({
      call: async () => {
        throw new LocalAgentApiError("not_found", "page not found");
      },
    });
    await server.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
      },
    });
    await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" });

    const response = await server.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "get_page",
        arguments: { space: "team/oc_mcp", slug: "concepts/missing" },
      },
    });

    expect(response).toEqual({
      jsonrpc: "2.0",
      id: 2,
      result: {
        content: [{ type: "text", text: "page not found" }],
        isError: true,
      },
    });
  });
});
