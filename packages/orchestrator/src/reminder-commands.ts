/** Natural-language reminder commands handled before ordinary knowledge capture. */
import type { KnowledgeEngine } from "@homeagent/core";
import type { InboundMessage } from "@homeagent/connectors";
import type { SpaceId } from "@homeagent/shared";

const UNIT_MS: Record<string, number> = {
  分钟: 60_000,
  小时: 3600_000,
  天: 86400_000,
};
const SHANGHAI_OFFSET_MS = 8 * 3600_000;
const WEEKDAY: Record<string, number> = {
  日: 0,
  天: 0,
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
};

export interface ReminderDraft {
  title: string;
  triggerAt: number;
  repeatEveryMs?: number;
  untilConfirmed: boolean;
}

function cleanMessage(text: string): string {
  return text.trim().replace(/^(?:@\S+\s*)+/u, "").trim();
}

function reminderTitle(text: string): string {
  const after = text.match(/提醒(?:下)?我\s*(.+?)(?:[，,]\s*如果|$)/u)?.[1]?.trim();
  if (after) return after.replace(/^是否/u, "").replace(/[。.!！]+$/u, "").trim();
  return "未命名提醒";
}

function localClock(text: string): { hour: number; minute: number } | undefined {
  const exact = text.match(/(上午|中午|下午|傍晚|晚上|凌晨)?\s*(\d{1,2})\s*[点时](?:\s*(半|\d{1,2})\s*分?)?/u);
  if (exact) {
    const period = exact[1] ?? "";
    let hour = Number(exact[2]);
    const minute = exact[3] === "半" ? 30 : Number(exact[3] ?? 0);
    if (["下午", "傍晚", "晚上"].includes(period) && hour < 12) hour += 12;
    if (period === "凌晨" && hour === 12) hour = 0;
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) return { hour, minute };
    return undefined;
  }
  // An explicit but unsupported clock must not be replaced by a period default.
  // Let the model fallback interpret it and ask the user to confirm instead.
  if (/[零〇一二两三四五六七八九十百]+\s*[点时]/u.test(text)) return undefined;
  if (text.includes("中午")) return { hour: 12, minute: 0 };
  if (text.includes("下午")) return { hour: 15, minute: 0 };
  if (text.includes("傍晚")) return { hour: 18, minute: 0 };
  if (text.includes("晚上")) return { hour: 20, minute: 0 };
  if (text.includes("凌晨")) return { hour: 0, minute: 0 };
  // “上午” without a clock is intentionally made explicit in the confirmation.
  return { hour: 9, minute: 0 };
}

function shanghaiCalendarInstant(text: string, now: number): number | undefined {
  const shifted = new Date(now + SHANGHAI_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth();
  const day = shifted.getUTCDate();
  const currentWeekday = shifted.getUTCDay();
  const clock = localClock(text);
  if (!clock) return undefined;
  const { hour, minute } = clock;
  let dayOffset: number | undefined;

  if (text.includes("后天")) dayOffset = 2;
  else if (text.includes("明天")) dayOffset = 1;
  else if (text.includes("今天")) dayOffset = 0;

  const weekday = text.match(/(下周|本周|这周|周|星期)([一二三四五六日天])/u);
  if (weekday) {
    const target = WEEKDAY[weekday[2] ?? ""];
    if (target === undefined) return undefined;
    const prefix = weekday[1];
    if (prefix === "下周") {
      const currentMondayIndex = (currentWeekday + 6) % 7;
      const targetMondayIndex = (target + 6) % 7;
      dayOffset = 7 - currentMondayIndex + targetMondayIndex;
    } else if (prefix === "本周" || prefix === "这周") {
      const currentMondayIndex = (currentWeekday + 6) % 7;
      const targetMondayIndex = (target + 6) % 7;
      dayOffset = targetMondayIndex - currentMondayIndex;
    } else {
      dayOffset = (target - currentWeekday + 7) % 7;
    }
  }

  const explicitDate = text.match(/(?:(\d{4})年)?\s*(\d{1,2})月\s*(\d{1,2})[日号]/u);
  if (explicitDate) {
    const explicitYear = Number(explicitDate[1] ?? year);
    const explicitMonth = Number(explicitDate[2]) - 1;
    const explicitDay = Number(explicitDate[3]);
    const calendarDate = new Date(Date.UTC(explicitYear, explicitMonth, explicitDay));
    if (
      calendarDate.getUTCFullYear() !== explicitYear
      || calendarDate.getUTCMonth() !== explicitMonth
      || calendarDate.getUTCDate() !== explicitDay
    ) {
      return undefined;
    }
    return Date.UTC(explicitYear, explicitMonth, explicitDay, hour, minute) - SHANGHAI_OFFSET_MS;
  }

  if (dayOffset === undefined) return undefined;
  let instant = Date.UTC(year, month, day + dayOffset, hour, minute) - SHANGHAI_OFFSET_MS;
  if (weekday && ["周", "星期"].includes(weekday[1] ?? "") && instant <= now) {
    instant += 7 * 86400_000;
  }
  return instant;
}

function durationMs(amount: string | undefined, unit: string | undefined): number | undefined {
  const count = Number(amount);
  const unitMs = UNIT_MS[unit ?? ""];
  if (!Number.isFinite(count) || count <= 0 || !unitMs) return undefined;
  return count * unitMs;
}

/** Parse common Chinese relative/calendar reminder expressions without an LLM round trip. */
export function parseReminderRequest(text: string, now = Date.now()): ReminderDraft | undefined {
  const normalized = cleanMessage(text);
  if (!normalized.includes("提醒")) return undefined;
  const delay = normalized.match(/(\d+)\s*(分钟|小时|天)后/u);
  const delayMs = durationMs(delay?.[1], delay?.[2]);
  let triggerAt = delayMs ? now + delayMs : shanghaiCalendarInstant(normalized, now);
  if (!triggerAt) return undefined;

  const advance = normalized.match(/提前\s*(\d+)\s*(分钟|小时|天)/u);
  const advanceMs = durationMs(advance?.[1], advance?.[2]);
  if (advanceMs) triggerAt -= advanceMs;
  if (triggerAt <= now) return undefined;

  const repeat = normalized.match(/每隔\s*(\d+)\s*(分钟|小时|天)/u);
  const repeatEveryMs = durationMs(repeat?.[1], repeat?.[2]);
  const untilConfirmed = Boolean(repeatEveryMs && /直到.+(?:确认|回复|完成)/u.test(normalized));
  return {
    title: reminderTitle(normalized),
    triggerAt,
    repeatEveryMs,
    untilConfirmed,
  };
}

export function formatReminderTime(at: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(at));
}

export const REMINDER_TIME_CLARIFICATION =
  "我尝试理解后仍没有识别到具体时间，所以还没有创建提醒。请换一种说法，例如：“明天上午 9 点提醒我喝水”。";

/** True after deterministic reminder controls have declined to handle reminder-bearing text. */
export function needsReminderInference(text: string): boolean {
  return cleanMessage(text).includes("提醒");
}

/** Persist a previously parsed or explicitly confirmed reminder draft. */
export function scheduleReminderDraft(
  engine: KnowledgeEngine,
  msg: Pick<InboundMessage, "chatId" | "senderId" | "messageId">,
  space: SpaceId,
  draft: ReminderDraft,
  now = Date.now(),
): string {
  engine.ensureSpace(space, { chatId: msg.chatId });
  const reminder = engine.reminders.create({
    ...draft,
    space,
    chatId: msg.chatId,
    creatorId: msg.senderId,
    sourceMessageId: msg.messageId,
  }, now);
  if (!reminder) return "提醒创建失败，请稍后重试。";
  return `✅ 已创建提醒：${reminder.title}\n时间：${formatReminderTime(reminder.triggerAt)}`;
}

function isReminderListQuery(text: string): boolean {
  const normalized = cleanMessage(text);
  if (/^\/remind(?:er)?s?(?:\s+list)?\s*$/iu.test(normalized)) return true;
  return /(?:最近一周|未来一周|未来7天|本周|这周|今天|明天).*(?:安排|提醒|计划)/u.test(normalized);
}

function reminderRange(text: string, now: number): { from: number; to: number; label: string } {
  const normalized = cleanMessage(text);
  const shifted = new Date(now + SHANGHAI_OFFSET_MS);
  const startOfLocalDay = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
  ) - SHANGHAI_OFFSET_MS;
  if (normalized.includes("明天")) {
    return {
      from: startOfLocalDay + 86400_000,
      to: startOfLocalDay + 2 * 86400_000 - 1,
      label: "明天的安排",
    };
  }
  if (normalized.includes("今天")) {
    return { from: now, to: startOfLocalDay + 86400_000 - 1, label: "今天的安排" };
  }
  if (normalized.includes("本周") || normalized.includes("这周")) {
    const daysUntilNextMonday = 8 - (shifted.getUTCDay() || 7);
    return {
      from: now,
      to: startOfLocalDay + daysUntilNextMonday * 86400_000 - 1,
      label: "本周剩余安排",
    };
  }
  return { from: now, to: now + 7 * 86400_000, label: "未来 7 天的安排" };
}

function formatReminderList(
  engine: KnowledgeEngine,
  space: SpaceId,
  actorId: string,
  text: string,
  now: number,
): string {
  const range = reminderRange(text, now);
  const reminders = engine.reminders.upcoming(space, range.from, range.to, actorId);
  if (reminders.length === 0) return `🗓 ${range.label}：暂无提醒。`;
  return [
    `🗓 ${range.label}：`,
    ...reminders.map((reminder, index) =>
      `${index + 1}. ${formatReminderTime(reminder.nextTriggerAt)} · ${reminder.title}`
      + (reminder.untilConfirmed ? "（重复提醒，直到确认）" : "")
    ),
  ].join("\n");
}

function matchingOwnedReminder(
  engine: KnowledgeEngine,
  space: SpaceId,
  actorId: string,
  text: string,
): ReturnType<KnowledgeEngine["reminders"]["get"]> {
  const raw = cleanMessage(text).replace(/[。.!！]+$/u, "").trim();
  const query = raw
    .replace(/^把/u, "")
    .replace(/^(?:我已?|已经)?(?:确认|完成|办好|收到)(?:了)?/u, "")
    .replace(/^(?:请)?(?:取消|删除|不要再)/u, "")
    .replace(/(?:的)?提醒(?:我)?.*$/u, "")
    .replace(/[。.!！]+$/u, "")
    .trim();
  const candidates = engine.reminders.list().filter(
    (reminder) => reminder.space === space
      && reminder.creatorId === actorId
      && reminder.status === "scheduled",
  );
  if (!query && candidates.length === 1) return candidates[0];
  const exactRaw = candidates.filter((reminder) => reminder.title === raw);
  if (exactRaw.length === 1) return exactRaw[0];
  const exactQuery = candidates.filter((reminder) => reminder.title === query);
  if (exactQuery.length === 1) return exactQuery[0];
  const partial = candidates.filter(
    (reminder) => reminder.title.includes(query) || query.includes(reminder.title),
  );
  return partial.length === 1 ? partial[0] : undefined;
}

function isReminderCompletion(text: string): boolean {
  return /^(?:我已?|已经)?(?:确认|完成|办好|收到)(?:了)?/u.test(cleanMessage(text));
}

function isReminderCancellation(text: string): boolean {
  return /^(?:请)?(?:取消|删除|不要再).*(?:提醒|安排)/u.test(cleanMessage(text));
}

function snoozeDuration(text: string): number | undefined {
  const normalized = cleanMessage(text);
  if (!/(?:延后|推迟|稍后)/u.test(normalized)) return undefined;
  const parsed = normalized.match(/(?:延后|推迟|稍后)\s*(\d+)\s*(分钟|小时|天)/u);
  return durationMs(parsed?.[1], parsed?.[2]);
}

/** Pure preflight used to authorize group reminder governance before any mutation/model call. */
export function isReminderAutomationMessage(text: string): boolean {
  return isReminderListQuery(text)
    || snoozeDuration(text) !== undefined
    || isReminderCancellation(text)
    || isReminderCompletion(text)
    || needsReminderInference(text);
}

/** Return null when the message is not a reminder control message. */
export function handleReminderMessage(
  engine: KnowledgeEngine,
  msg: InboundMessage,
  space: SpaceId,
  now = Date.now(),
): string | null {
  if (isReminderListQuery(msg.text)) {
    return formatReminderList(engine, space, msg.senderId, msg.text, now);
  }
  const snoozeMs = snoozeDuration(msg.text);
  if (snoozeMs) {
    const reminder = matchingOwnedReminder(engine, space, msg.senderId, msg.text);
    if (!reminder) return "没有找到与你这句话匹配的待处理提醒。";
    const snoozed = engine.reminders.snooze(reminder.id, msg.senderId, now + snoozeMs, now);
    if (!snoozed) return "提醒延后失败，请稍后重试。";
    return `✅ 已延后提醒：${reminder.title}\n新时间：${formatReminderTime(snoozed.nextTriggerAt)}`;
  }
  if (isReminderCancellation(msg.text)) {
    const reminder = matchingOwnedReminder(engine, space, msg.senderId, msg.text);
    if (!reminder) return "没有找到与你这句话匹配的待处理提醒。";
    engine.reminders.cancel(reminder.id, msg.senderId, now);
    return `✅ 已取消提醒：${reminder.title}`;
  }
  const draft = parseReminderRequest(msg.text, now);
  if (draft) {
    return scheduleReminderDraft(engine, msg, space, draft, now);
  }
  if (isReminderCompletion(msg.text)) {
    const reminder = matchingOwnedReminder(engine, space, msg.senderId, msg.text);
    if (!reminder) return "没有找到与你这句话匹配的待处理提醒。";
    engine.reminders.complete(reminder.id, msg.senderId, now);
    return `✅ 已完成提醒：${reminder.title}`;
  }
  return null;
}
