import { expect, test } from "bun:test";
import type { Agent, ChatRun } from "@homeagent/core";
import { buildAgentActivity } from "./agent-activity.ts";
import { agentActivityOverview } from "./agent-activity-view.ts";

const agent: Agent = {
  id: "agent_named", name: "已配置助手", instruction: "", provider: "codex", model: "", reasoningEffort: "",
  visibility: "Team", permission: "read-only", skills: [], createdAt: 1, updatedAt: 1,
};

function chat(id: string, status: ChatRun["status"], startedAt: number, agentId?: string): ChatRun {
  return {
    id, status, startedAt, queuedAt: startedAt, agentId, space: "personal/ou_activity",
    input: "私聊任务", trigger: "message", priority: "interactive", delivery: { status: "pending", attempts: 0 },
  };
}

test("old active Chats remain visible independently of the recent-history limit and selected Agent", () => {
  const runs = [chat("active", "running", 1, agent.id),
    ...Array.from({ length: 120 }, (_, index) => chat(`done_${index}`, "succeeded", index + 2, agent.id))];
  const activity = buildAgentActivity([agent], [], runs);
  expect(activity.activeRuns.map((run) => run.id)).toEqual(["active"]);
  expect(activity.agents).toEqual([{ id: agent.id, running: true, queued: false }]);
  expect(activity.defaultRuns).toHaveLength(0);
});

test("default recent history is bounded, retains frozen ownership and escapes message previews", async () => {
  const runs = Array.from({ length: 25 }, (_, index) => chat(`done_${index}`, "succeeded", index));
  runs.push({ ...chat("deleted", "running", 100, "agent_deleted"), input: "<img src=x onerror=alert(1)>" + "文".repeat(300) });
  const activity = buildAgentActivity([agent], [], runs);
  expect(activity.defaultRuns).toHaveLength(20);
  expect(activity.defaultRuns[0]?.id).toBe("done_24");
  expect(activity.activeRuns[0]?.agentLabel).toBe("已删除的 Agent");
  expect(activity.activeRuns[0]?.title).toHaveLength(200);
  expect(activity.agents[0]?.running).toBe(false);
  expect(activity.activeRuns[0]?.space).toBe("personal/ou_activity");
  const html = String(await agentActivityOverview(activity));
  expect(html).toContain("&lt;img");
  expect(html).not.toContain("<img");
  expect(html).toContain("默认 Agent 最近记录（20）");
});
