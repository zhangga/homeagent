import { describe, expect, test } from "bun:test";
import type { LocalAgentKnowledgeCaller } from "./mcp.ts";
import { runKnowledgeCli } from "./knowledge-cli.ts";

describe("homeagent knowledge CLI", () => {
  test("maps bounded flags to the shared read-only caller and prints JSON", async () => {
    const calls: Array<{ tool: string; args?: Record<string, unknown> }> = [];
    const caller: LocalAgentKnowledgeCaller = {
      call: async (tool, args) => {
        calls.push({ tool, args });
        return { hits: [], truncated: false };
      },
    };
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runKnowledgeCli([
      "search_knowledge",
      "--space",
      "team/oc_cli",
      "--query",
      "发布流程",
      "--limit",
      "8",
    ], {
      caller,
      write: (line) => stdout.push(line),
      writeError: (line) => stderr.push(line),
    });

    expect(code).toBe(0);
    expect(calls).toEqual([{
      tool: "search_knowledge",
      args: { space: "team/oc_cli", query: "发布流程", limit: 8 },
    }]);
    expect(JSON.parse(stdout.join(""))).toEqual({ hits: [], truncated: false });
    expect(stderr).toEqual([]);
  });
});
