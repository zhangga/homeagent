import { expect, test } from "bun:test";
import type { WorkItem, WorkInput, WorkRoutingPlan } from "@homeagent/core";
import { FakeLlm } from "@homeagent/core";
import type { InboundMessage } from "@homeagent/connectors";
import { newWorkTitle, routeWork, resolveSupplement, WORK_ROUTING_INSTRUCTION } from "./work-routing.ts";

const message = (text: string): InboundMessage => ({ kind: "message", eventId: "event", chatType: "p2p", chatId: "chat",
  senderId: "user", text, messageId: "message", mentionsBot: true, createdAt: 1 });
const item = (id: string, title: string): WorkItem => ({ id, title, space: "personal/user", brief: "", runbook: "",
  phase: "active", summary: "", blockers: [], nextActions: [], active: true, rawIds: [], pageSlugs: [], chatRunIds: [], taskRunIds: [], createdAt: 1, updatedAt: 1 });
const items = [item("research", "调研技术方案"), item("report", "整理项目周报")];

test("routes new work, named controls and supplements without converting ordinary conversation into controls", () => {
  expect(routeWork(message("请调研技术方案"), [], [], [])).toEqual({ operation: "new" });
  expect(routeWork(message("@助理 请调研技术方案"), [], [], [])).toEqual({ operation: "new" });
  expect(newWorkTitle("@助理 请调研技术方案")).toBe("调研技术方案");
  expect(routeWork(message("取消调研"), items, [], [])).toEqual({ operation: "cancel", workItemId: "research" });
  expect(routeWork(message("周报按项目分组"), items, [], [])).toEqual({ operation: "followup", workItemId: "report" });
  expect(routeWork(message("继续"), [], [], [])).toEqual({ operation: "chat" });
  expect(routeWork(message("取消"), items, [], [])).toEqual({ operation: "clarify", workItemId: undefined });
  expect(routeWork(message("补充国内方案"), items, [], [])).toEqual({ operation: "clarify" });
});

test("ordinal commands use the list actually delivered to this actor, unaffected by live reordering", () => {
  const shown: WorkInput = { version: 1, id: "input", connector: "cli", appId: "", space: "personal/user",
    message: message("事项列表"), state: "settled", sequence: 1, revision: 1, updatedAt: 1,
    presentedItemIds: ["report", "research"], receipt: { text: "list", status: "sent" } };
  expect(routeWork(message("第二个先停"), [...items].reverse(), [], [shown])).toEqual({ operation: "cancel", workItemId: "research" });
  expect(routeWork({ ...message("第二个先停"), senderId: "other" }, items, [], [shown])).toEqual({ operation: "clarify" });
  expect(routeWork(message("第二个先停"), items, [], [{ ...shown, receipt: { status: "pending" } }])).toEqual({ operation: "clarify" });
});

test("a fresh request does not attach to an inactive or completed title match", () => {
  for (const stopped of [{ ...items[0]!, active: false }, { ...items[0]!, phase: "completed" as const }]) {
    expect(routeWork(message("请调研技术方案"), [stopped, items[1]!], [], [])).toEqual({ operation: "new" });
    expect(routeWork(message("继续调研"), [stopped, items[1]!], [], []).workItemId).toBe("research");
    expect(routeWork(message("取消调研"), [stopped, items[1]!], [], []).workItemId).toBe("research");
  }
  expect(routeWork(message("请调研技术方案"), items, [], [])).toEqual({ operation: "followup", workItemId: "research" });
  expect(routeWork(message("补充调研技术方案"), [{ ...items[0]!, active: false }, items[1]!], [], []))
    .toEqual({ operation: "followup", workItemId: "research" });
  const history = [{ ...items[0]!, id: "cancelled", active: false }, ...items];
  expect(routeWork(message("补充调研技术方案"), history, [], [])).toEqual({ operation: "followup", workItemId: "research" });
  expect(routeWork(message("取消调研"), history, [], [])).toEqual({ operation: "cancel", workItemId: "research" });
  const original: WorkInput = { version: 1, id: "original", connector: "cli", appId: "", space: "personal/user",
    message: { ...message("调研技术方案"), messageId: "old-topic" }, workItemId: "cancelled", operation: "new",
    state: "settled", sequence: 1, revision: 1, updatedAt: 1 };
  expect(routeWork({ ...message("请调研技术方案"), parentMessageId: "old-topic" }, history, [], [original]))
    .toEqual({ operation: "followup", workItemId: "cancelled" });
  expect(routeWork({ ...message("请调研技术方案"), rootMessageId: "old-topic" }, history, [], [original]))
    .toEqual({ operation: "followup", workItemId: "cancelled" });
});

test("semantic supplements can select only a frozen existing candidate", async () => {
  const fake = new FakeLlm();
  const plan: WorkRoutingPlan = { version: 1, instruction: WORK_ROUTING_INSTRUCTION, timeoutMs: 21_600_000,
    maxTokens: 8192, candidates: items.map(({ id, title, updatedAt }) => ({ id, title, updatedAt })) };
  fake.onJSON(() => ({ targetId: "report" }));
  expect(await resolveSupplement(fake, plan, "报告增加国内供应商", "personal/user")).toBe("report");
  fake.onJSON(() => ({ targetId: "foreign" }));
  await expect(resolveSupplement(fake, plan, "报告增加国内供应商", "personal/user")).rejects.toThrow("Unknown work route");
});
