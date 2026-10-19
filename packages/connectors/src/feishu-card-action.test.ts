import { expect, test } from "bun:test";
import { normalizeCardAction } from "./feishu-normalize.ts";

const callback = { type: "card.action.trigger", event_id: "evt_card_1", chat_id: "oc_team", message_id: "om_card",
  operator_id: "ou_owner", timestamp: "1792368000000", action_tag: "button", action_value: JSON.stringify({
    action: "homeagent.task-approval", runId: "run_approval", requestedAt: 100, decision: "approve",
  }), token: "PRIVATE_UPDATE_TOKEN", card_content: "PRIVATE_CARD_BODY" };

test("normalizes the installed CLI callback schema and discards callback secrets/card content", () => {
  const event = normalizeCardAction(callback);
  expect(event).toEqual({ kind: "card_action", eventId: "evt_card_1", chatId: "oc_team", messageId: "om_card",
    operatorId: "ou_owner", actionTag: "button", createdAt: 1792368000000,
    actionValue: { action: "homeagent.task-approval", runId: "run_approval", requestedAt: 100, decision: "approve" } });
  expect(JSON.stringify(event)).not.toContain("PRIVATE");
});

test("rejects incomplete, malformed and unbounded callbacks before application dispatch", () => {
  for (const patch of [
    { operator_id: "" }, { chat_id: "oc_team\nother" }, { message_id: "om_" + "x".repeat(257) },
    { event_id: "e".repeat(257) }, { timestamp: "invalid" }, { action_tag: "input" },
    { action_value: "not JSON" }, { action_value: "[]" }, { action_value: "null" },
    { action_value: "x".repeat(2049) },
    { action_value: JSON.stringify(Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, i]))) },
  ]) expect(normalizeCardAction({ ...callback, ...patch })).toBeNull();
});
