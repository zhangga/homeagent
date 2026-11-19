import { expect, test } from "bun:test";
import type { WorkItem } from "@homeagent/core";
import type { WorkAttention } from "./work-attention.ts";
import { workIndexView } from "./views.ts";

function item(id: string): WorkItem {
  return {
    id, space: "team/ops", title: id, phase: "active", active: true,
    brief: "", summary: "", runbook: "", nextActions: ["校对周报"], blockers: [],
    rawIds: [], pageSlugs: [], chatRunIds: [], taskRunIds: [], createdAt: 1, updatedAt: 1,
  };
}

test("the work list promotes items that need a decision and retains both direct actions and item details", async () => {
  const items = ["ordinary", "live", "gate", "blocked", "review", "queue"].map(item);
  const states = new Map<string, WorkAttention>([
    ["live", { kind: "running", href: "/tasks/runs/live" }],
    ["gate", { kind: "awaiting_approval", href: "/tasks/runs/gate" }],
    ["blocked", { kind: "blocked", description: "缺少 <预算> 数据", href: "/work/blocked#work-next-action" }],
    ["review", { kind: "awaiting_acceptance", href: "/work/review#acceptance-action-report" }],
    ["queue", { kind: "queued", href: "/work/queue#work-next-action" }],
  ]);
  const body = String(await workIndexView(items, [], undefined, states));
  expect([...body.matchAll(/data-work-item="([^"]+)"/g)].map(match => match[1]))
    .toEqual(["gate", "blocked", "review", "live", "queue", "ordinary"]);
  for (const entry of items) expect(body).toContain(`href="/work/${entry.id}"`);
  for (const state of states.values()) expect(body).toContain(`href="${state.href}"`);
  expect(body).toContain("缺少 &lt;预算&gt; 数据");
  expect(body).toContain("下一步 · 校对周报");
  expect(body).toContain('href="/work?new=1"');
});

test("an active work phase on its own has no approval, report or Run shortcut", async () => {
  const body = String(await workIndexView([item("independent")], []));
  expect(body).toContain('data-work-state="normal"');
  expect(body).toContain("推进中");
  expect(body).not.toContain("处理审批");
  expect(body).not.toContain("查看报告");
  expect(body).not.toContain("/tasks/runs/");
});
