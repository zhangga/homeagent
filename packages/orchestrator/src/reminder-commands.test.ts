import { describe, expect, test } from "bun:test";
import { parseReminderRequest } from "./reminder-commands.ts";

const NOW = new Date("2026-07-15T12:00:00+08:00").getTime(); // Wednesday

describe("parseReminderRequest", () => {
  test("distinguishes a dated instruction from questions about existing reminders", () => {
    expect(parseReminderRequest("明天上午 9 点提醒一下我查看会议安排", NOW)?.title).toBe("查看会议安排");
    for (const question of ["明天有哪些提醒？", "明天会提醒我什么？", "查看明天提醒我的事项"]) {
      expect(parseReminderRequest(question, NOW)).toBeUndefined();
    }
  });

  test("resolves a weekday period in Asia/Shanghai with an explicit displayed default", () => {
    expect(parseReminderRequest("@agent 周日上午提醒我去茶饼斋", NOW)).toEqual({
      title: "去茶饼斋",
      triggerAt: new Date("2026-07-19T09:00:00+08:00").getTime(),
      untilConfirmed: false,
    });
  });

  test("supports advance notice and repetition until confirmation", () => {
    expect(parseReminderRequest(
      "@agent 我下周六定了大同旅游的酒店，提前2天提醒下我是否确认去大同，如果我没给你回复，就每隔3小时再提醒下我，直到你收到了我的确认",
      NOW,
    )).toEqual({
      title: "确认去大同",
      triggerAt: new Date("2026-07-23T09:00:00+08:00").getTime(),
      repeatEveryMs: 3 * 3600_000,
      untilConfirmed: true,
    });
  });

  test("a bare weekday that already passed today resolves to next week", () => {
    const sundayNoon = new Date("2026-07-19T12:00:00+08:00").getTime();
    expect(parseReminderRequest("周日上午提醒我去茶饼斋", sundayNoon)?.triggerAt).toBe(
      new Date("2026-07-26T09:00:00+08:00").getTime(),
    );
  });

  test("resolves this-week weekdays on a Monday-based calendar", () => {
    expect(parseReminderRequest("本周日上午提醒我去茶饼斋", NOW)?.triggerAt).toBe(
      new Date("2026-07-19T09:00:00+08:00").getTime(),
    );

    const sundayNoon = new Date("2026-07-19T12:00:00+08:00").getTime();
    expect(parseReminderRequest("本周一上午提醒我开会", sundayNoon)).toBeUndefined();
  });

  test("does not silently replace an unsupported explicit clock with a period default", () => {
    expect(parseReminderRequest("7月22日上午七点半提醒我买票", NOW)).toBeUndefined();
    expect(parseReminderRequest("7月22日上午25点提醒我买票", NOW)).toBeUndefined();
  });

  test("rejects an impossible calendar date instead of rolling it into another month", () => {
    expect(parseReminderRequest("9月31日上午9点提醒我买票", NOW)).toBeUndefined();
  });
});
