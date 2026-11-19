import type { KnowledgeEngine } from "@homeagent/core";

/** Seed real reminder transitions. The offline fixture deliberately leaves the delivery scheduler stopped. */
export function seedReminderBrowserSamples(engine: KnowledgeEngine) {
  const minute = 60_000;
  const morning = new Date();
  morning.setUTCDate(morning.getUTCDate() + 1);
  morning.setUTCHours(1, 0, 0, 0); // 09:00 Shanghai
  const at = (minutes: number) => morning.getTime() + minutes * minute;
  const space = "team/oc_reminder_browser";
  const creatorId = "ou_browser_coordinator";
  engine.ensureSpace(space);
  engine.updateSpaceMeta(space, { name: "项目协作组" });
  const create = (title: string, scheduledMinutes: number, createdMinutes: number, repeatMinutes?: number) => {
    const result = engine.reminders.create({ title, space, creatorId, chatId: "oc_reminder_browser",
      triggerAt: at(scheduledMinutes), ...(repeatMinutes && { repeatEveryMs: repeatMinutes * minute, untilConfirmed: true }) },
      at(createdMinutes));
    if (!result) throw new Error("Could not create offline reminder");
    return result;
  };
  // Created first, originally due first, then postponed to last.
  const quote = create("跟进供应商的替代报价", -3100, -4500);
  engine.reminders.snooze(quote.id, creatorId, at(450), at(-2900));
  create("把设计评审材料发给项目组", 270, -4000);
  const handoff = create("确认值班交接清单", -2970, -3900, 90);
  engine.reminders.markNotified(handoff.id, at(-2970));
  engine.reminders.snooze(handoff.id, creatorId, at(0), at(-2880));
  const completed = create("归档上次发布的验收记录", -2400, -6000);
  engine.reminders.complete(completed.id, creatorId, at(-2520));
  const cancelled = create("预订周会会议室", -2750, -5800);
  engine.reminders.cancel(cancelled.id, creatorId, at(-2640));
}
