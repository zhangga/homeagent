import { expect, test } from "bun:test";
import type { Reminder } from "@homeagent/core";
import { remindersView } from "./views.ts";

function reminder(id: string, changes: Partial<Reminder> = {}): Reminder {
  return {
    id, title: id, space: "team/ops", creatorId: "ou_creator", chatId: "oc_ops",
    triggerAt: 100, nextTriggerAt: 100, createdAt: 1, updatedAt: 1,
    status: "scheduled", untilConfirmed: false, ...changes,
  };
}

function rows(body: string) {
  return new Map([...body.matchAll(/<li\b[^>]*\bdata-reminder-id="([^"]+)"[^>]*>([\s\S]*?)<\/li>/gu)]
    .map(match => [match[1]!, match[2]!]));
}

test("scheduled reminders use the actual next trigger after a snooze or a repeat and retain their controls", async () => {
  const delayed = reminder("later", { triggerAt: 10, nextTriggerAt: 500 });
  const repeat = reminder("repeating", { title: "核对 <轮值表>", triggerAt: 5, nextTriggerAt: 300,
    repeatEveryMs: 1_800_000, untilConfirmed: true });
  const next = reminder("next", { triggerAt: 200, nextTriggerAt: 200 });
  const input = [delayed, repeat, next];
  const body = String(await remindersView(input));
  const rendered = rows(body);
  expect([...rendered.keys()]).toEqual(["next", "repeating", "later"]);
  expect(input.map(item => item.id)).toEqual(["later", "repeating", "next"]);
  expect(rendered.get("repeating")).toContain("核对 &lt;轮值表&gt;");
  expect(rendered.get("repeating")).toMatch(/30\s*分钟|半小时/u);
  expect(rendered.get("repeating")).toContain("直到确认");
  for (const item of input) {
    const row = rendered.get(item.id)!;
    expect(row).toContain(`datetime="${new Date(item.nextTriggerAt).toISOString()}"`);
    expect(row).toContain(`action="/reminders/${item.id}/complete"`);
    expect(row).toContain(`action="/reminders/${item.id}/cancel"`);
    expect(row).toContain(item.space);
    expect(row).toContain(item.creatorId);
  }
  expect(body).not.toContain('id="reminders-history"');
});

test("history starts folded and shows each outcome's own timestamp, including older incomplete records", async () => {
  const items = [
    reminder("no-cancel-time", { status: "cancelled", completedAt: 800, updatedAt: 900, nextTriggerAt: 999 }),
    reminder("complete", { status: "completed", completedAt: 0, cancelledAt: 899, repeatEveryMs: 60_000, untilConfirmed: true }),
    reminder("cancel", { status: "cancelled", cancelledAt: 500 }),
    reminder("live"),
  ];
  const body = String(await remindersView(items));
  const opening = body.match(/<details\b[^>]*\bid="reminders-history"[^>]*>/u)?.[0];
  expect(opening).toBeDefined();
  expect(opening).not.toMatch(/\sopen\b/u);
  const all = rows(body);
  expect([...all.keys()]).toEqual(["live", "cancel", "complete", "no-cancel-time"]);
  expect(all.get("complete")).toContain('datetime="1970-01-01T00:00:00.000Z"');
  const completed = all.get("complete")!;
  const metadata = completed.indexOf("<details");
  expect(completed.slice(0, metadata)).not.toContain("直到确认");
  expect(completed.slice(metadata)).toContain("原重复规则");
  expect(completed.slice(metadata)).toMatch(/1\s*分钟/u);
  expect(all.get("cancel")).toContain('datetime="1970-01-01T00:00:00.500Z"');
  expect(all.get("no-cancel-time")).toContain("未记录");
  for (const id of ["complete", "cancel", "no-cancel-time"]) {
    expect(all.get(id)).not.toContain("<form");
    expect(all.get(id)).not.toContain("下次提醒");
  }
});

test("the empty page keeps Feishu creation guidance and omits empty history", async () => {
  const body = String(await remindersView([]));
  expect(body).toContain("飞书");
  expect(body).not.toContain('id="reminders-history"');
  expect(rows(body).size).toBe(0);
});

test("a history-only list stays readable when an old timestamp is outside the displayable date range", async () => {
  const body = String(await remindersView([reminder("old", { status: "completed", completedAt: Number.MAX_VALUE })]));
  expect(body).toContain("当前没有待提醒");
  const row = rows(body).get("old");
  expect(row).toContain("时间无效");
  expect(row).not.toContain("<form");
});
