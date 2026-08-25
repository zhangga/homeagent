import { describe, expect, test } from "bun:test";
import { LocalAgentApiClient } from "./local-agent-client.ts";

describe("local Agent API client", () => {
  test("sends the read token only in the fixed local Authorization header", async () => {
    let requestedUrl = "";
    let requestedInit: RequestInit | undefined;
    const client = new LocalAgentApiClient({
      baseUrl: "http://127.0.0.1:3000",
      token: "agent-read-secret",
      fetch: async (input, init) => {
        requestedUrl = String(input);
        requestedInit = init;
        return Response.json({
          ok: true,
          result: { spaces: [], totalSpaces: 0, truncated: false },
        });
      },
    });

    const result = await client.call("list_spaces", { limit: 10 });

    expect(result).toEqual({ spaces: [], totalSpaces: 0, truncated: false });
    expect(requestedUrl).toBe("http://127.0.0.1:3000/api/agent/v1/query");
    expect(requestedUrl).not.toContain("agent-read-secret");
    expect(new Headers(requestedInit?.headers).get("authorization"))
      .toBe("Bearer agent-read-secret");
    expect(requestedInit).toEqual(expect.objectContaining({
      method: "POST",
      redirect: "error",
      body: JSON.stringify({ tool: "list_spaces", arguments: { limit: 10 } }),
    }));
  });

  test("cancels an undeclared oversized response while it is being read", async () => {
    let pullCount = 0;
    let cancelled = false;
    const responseBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        pullCount += 1;
        if (pullCount === 1) {
          controller.enqueue(new Uint8Array(2 * 1024 * 1024));
        } else if (pullCount === 2) {
          controller.enqueue(new Uint8Array([0x20]));
        } else {
          controller.close();
        }
      },
      cancel() {
        cancelled = true;
      },
    }, { highWaterMark: 0 });
    const client = new LocalAgentApiClient({
      baseUrl: "http://127.0.0.1:3000",
      fetch: async () => new Response(responseBody),
    });

    await expect(client.call("list_spaces")).rejects.toMatchObject({
      name: "LocalAgentApiError",
      code: "unavailable",
      message: "HomeAgent knowledge response is too large",
    });
    expect(cancelled).toBe(true);
  });

  test("submits feedback with its dedicated token instead of the read token", async () => {
    let requestedUrl = "";
    let requestedInit: RequestInit | undefined;
    const client = new LocalAgentApiClient({
      baseUrl: "http://127.0.0.1:3000",
      token: "agent-read-secret",
      feedbackToken: "agent-feedback-secret",
      fetch: async (input, init) => {
        requestedUrl = String(input);
        requestedInit = init;
        return Response.json({
          ok: true,
          feedback: {
            id: "agent_feedback_1",
            idempotencyKey: "run-1:feedback-1",
            space: "team/oc_feedback",
            consumer: "external-agent",
            kind: "not_found",
            target: { kind: "search", query: "发布负责人" },
            status: "open",
            createdAt: 1_777_000_000_000,
          },
        });
      },
    });

    const result = await client.submitFeedback("team/oc_feedback", {
      idempotencyKey: "run-1:feedback-1",
      consumer: "external-agent",
      kind: "not_found",
      target: { kind: "search", query: "发布负责人" },
    });

    expect(result.id).toBe("agent_feedback_1");
    expect(requestedUrl).toBe("http://127.0.0.1:3000/api/agent/v1/feedback");
    expect(new Headers(requestedInit?.headers).get("authorization"))
      .toBe("Bearer agent-feedback-secret");
    expect(new Headers(requestedInit?.headers).get("authorization"))
      .not.toContain("agent-read-secret");
  });
});
