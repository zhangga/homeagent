import { describe, expect, test } from "bun:test";
import type { LocalAgentKnowledgeCaller } from "./mcp.ts";
import { runFeedbackCli } from "./feedback-cli.ts";

describe("homeagent feedback CLI", () => {
  test("submits bounded search feedback and prints the durable record as JSON", async () => {
    const submissions: unknown[] = [];
    const caller: LocalAgentKnowledgeCaller = {
      call: async () => ({ spaces: [], totalSpaces: 0, truncated: false }),
      submitFeedback: async (space, input) => {
        submissions.push({ space, input });
        return {
          id: "agent_feedback_cli",
          idempotencyKey: input.idempotencyKey,
          space,
          consumer: input.consumer,
          kind: input.kind,
          target: input.target,
          status: "open",
          createdAt: 1_777_000_000_000,
        };
      },
    };
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runFeedbackCli([
      "--space",
      "team/oc_cli",
      "--idempotency-key",
      "cli-run-1:feedback-1",
      "--consumer",
      "cli-agent",
      "--kind",
      "not_found",
      "--query",
      "发布负责人",
      "--note",
      "没有找到结果。",
    ], {
      caller,
      write: (line) => stdout.push(line),
      writeError: (line) => stderr.push(line),
    });

    expect(code).toBe(0);
    expect(submissions).toEqual([{
      space: "team/oc_cli",
      input: {
        idempotencyKey: "cli-run-1:feedback-1",
        consumer: "cli-agent",
        kind: "not_found",
        target: { kind: "search", query: "发布负责人" },
        note: "没有找到结果。",
      },
    }]);
    expect(JSON.parse(stdout.join(""))).toEqual(expect.objectContaining({
      id: "agent_feedback_cli",
      status: "open",
    }));
    expect(stderr).toEqual([]);
  });
});
