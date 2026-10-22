import type { RawSource } from "@homeagent/shared";
import type { RawSearchFilters } from "./sqlite.ts";

const DAY = 86_400_000;
const SHANGHAI_OFFSET = 8 * 3_600_000;
const QUOTED = /[「“"《]([^」”"》\n]+)[」”"》]/gu;
const DATE = /\b(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?/gu;
const REQUEST_WORDS = /\bRaw\s*ID\b|\bRaw\b|HomeAgent|只使用|仅使用|只用|仅用|已(?:经)?(?:入库|收录|保存)|知识库(?:中|里|内)?|查找|查询|检索|查阅|查一下|找一下|找出|帮我找|核验|摘录|给出|提供|看看|请|原始记录|原始消息|聊天记录|原文|原话|消息时间|对应|关于|相关|记录|关键词\s*[:：]?|的/giu;

export interface RawQueryPlan {
  query: string;
  phrases: string[];
  filters: RawSearchFilters;
  conditions: string[];
}

function localDay(now: number): number { return Math.floor((now + SHANGHAI_OFFSET) / DAY) * DAY - SHANGHAI_OFFSET; }
function dateLabel(at: number): string { return new Date(at + SHANGHAI_OFFSET).toISOString().slice(0, 10); }
function maskQuoted(text: string): string { return text.replace(QUOTED, value => " ".repeat(value.length)); }
function erase(text: string, at: number, length: number): string { return text.slice(0, at) + " ".repeat(length) + text.slice(at + length); }
function quotedRanges(text: string): Array<{ start: number; end: number }> {
  return [...text.matchAll(QUOTED)].map(match => ({ start: match.index, end: match.index + match[0].length }));
}

function calendarDate(year: number, month: number, day: number): number {
  const at = Date.UTC(year, month - 1, day);
  const date = new Date(at);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) throw new Error("查询日期无效");
  return at - SHANGHAI_OFFSET;
}

function count(value: string): number {
  if (/^\d+$/u.test(value)) return Number(value);
  const digits: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  let total = 0; let current = 0;
  for (const character of value) {
    if (character === "十" || character === "百") { total += (current || 1) * (character === "十" ? 10 : 100); current = 0; }
    else current = digits[character] ?? 0;
  }
  return total + current;
}

/** Deterministic, local-only planning; filters come solely from this user's query. */
export function planRawQuery(question: string, now = Date.now()): RawQueryPlan {
  let text = question;
  const filters: RawSearchFilters = {};
  const conditions: string[] = [];
  const selector = (labels: string, accept: (value: string) => void) => {
    const pattern = new RegExp(`(?:${labels})\\s*[:：]\\s*(?:[「“"《]([^」”"》\\n]+)[」”"》]|([^\\s，,；;。]+))`, "gu");
    const ranges = quotedRanges(text);
    text = text.replace(pattern, (match: string, quoted: string | undefined, plain: string | undefined, at: number) => {
      if (ranges.some(range => at >= range.start && at < range.end)) return match;
      accept((quoted ?? plain ?? "").trim());
      return " ";
    });
  };
  selector("作者|发送者|发言人", value => { filters.author = value; });
  selector("来源群聊|来源群|群聊|群ID|群 ID", value => {
    if (/^oc_[a-zA-Z0-9_-]+$/u.test(value)) filters.chatId = value;
    else filters.chatName = value;
  });
  selector("文件名|来源文件", value => { filters.fileName = value; });
  selector("来源类型", value => {
    const sources: Record<string, RawSource> = { message: "message", 消息: "message", doc: "doc", 文档: "doc", manual: "manual", 手动导入: "manual", task: "task", 任务: "task", learning: "learning", 学习: "learning" };
    const source = sources[value];
    if (!source) throw new Error("查询来源类型无效");
    filters.source = source;
  });
  const keywords: string[] = [];
  const keywordRanges = quotedRanges(text);
  text = text.replace(/(?:关键词|关键字)\s*[:：]\s*(?:[「“"《]([^」”"》\n]+)[」”"》]|([^，,；;。\n]+))/gu,
    (match: string, quoted: string | undefined, plain: string | undefined, at: number) => {
      if (keywordRanges.some(range => at >= range.start && at < range.end)) return match;
      keywords.push((quoted ?? plain ?? "").trim());
      return " ";
    });

  // Quoted topics may contain dates or names that are part of a title rather than a filter.
  const unquoted = maskQuoted(text);
  const dates = [...unquoted.matchAll(DATE)];
  if (dates.length > 0) {
    const first = dates[0]!;
    const last = dates.at(-1)!;
    filters.from = calendarDate(Number(first[1]), Number(first[2]), Number(first[3]));
    filters.to = dates.length === 1 && /以来|至今/u.test(unquoted)
      ? now + 1 : calendarDate(Number(last[1]), Number(last[2]), Number(last[3])) + DAY;
    if (filters.to <= filters.from) throw new Error("查询时间范围无效");
    for (const date of dates) text = erase(text, date.index, date[0].length);
    const connectors = maskQuoted(text).matchAll(/(?:^|[，,；;\s])(?:时间\s*[:：]?|从|自|以来|至今|至|到|之间)(?=$|[，,；;\s])/gu);
    for (const connector of connectors) text = erase(text, connector.index, connector[0].length);
  } else {
    const relative = unquoted.match(/(?:最近|过去|近)\s*([一二两三四五六七八九十百\d]+)\s*(天|日|周|星期|个月|月)|上个月|本月|这个月|上周|上星期|本周|这周|今天|昨天|前天/u);
    if (relative) {
      const day = localDay(now);
      const date = new Date(day + SHANGHAI_OFFSET);
      if (relative[1] && relative[2]) {
        const amount = count(relative[1]);
        if (!Number.isSafeInteger(amount) || amount < 1) throw new Error("查询时间范围无效");
        if (/月/u.test(relative[2])) {
          const first = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - amount, 1));
          const finalDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
          filters.from = calendarDate(first.getUTCFullYear(), first.getUTCMonth() + 1, Math.min(date.getUTCDate(), finalDay)) + (now - day);
        } else filters.from = now - amount * (/周|星期/u.test(relative[2]) ? 7 : 1) * DAY;
        filters.to = now + 1;
      } else if (/月/u.test(relative[0])) {
        const month = date.getUTCMonth() - (relative[0] === "上个月" ? 1 : 0);
        filters.from = Date.UTC(date.getUTCFullYear(), month, 1) - SHANGHAI_OFFSET;
        filters.to = Date.UTC(date.getUTCFullYear(), month + 1, 1) - SHANGHAI_OFFSET;
      } else if (/周|星期/u.test(relative[0])) {
        const monday = day - ((date.getUTCDay() + 6) % 7) * DAY;
        filters.from = monday - (/^上/u.test(relative[0]) ? 7 * DAY : 0);
        filters.to = filters.from + 7 * DAY;
      } else {
        filters.from = day - (relative[0] === "前天" ? 2 : relative[0] === "昨天" ? 1 : 0) * DAY;
        filters.to = filters.from + DAY;
      }
      if (!Number.isSafeInteger(filters.from) || !Number.isFinite(new Date(filters.from).getTime())) throw new Error("查询时间范围无效");
      text = erase(text, relative.index!, relative[0].length);
    }
  }

  const natural = maskQuoted(text).replace(REQUEST_WORDS, value => " ".repeat(value.length))
    .match(/(?:^|[\s，,；;：:])(@?[\p{L}\p{N}_-]+?)(?:在)?\s*(?:说过|说的|发过|发的|发送的|写的|提到过|提到的)\s*(?:的)?/u);
  if (!filters.author && natural) {
    const author = natural[1]!.replace(/^@/u, "");
    if (!/^(?:我|你|他|她|我们|你们|他们|大家|有人|谁|谁都|之前|以前|曾经)$/u.test(author)) filters.author = author;
    const prefix = natural[0].indexOf(natural[1]!);
    text = erase(text, natural.index! + prefix, natural[0].length - prefix);
  }
  const phrases = [...new Set([...keywords, ...[...text.matchAll(QUOTED)].map(match => match[1]!.trim())].filter(Boolean))];
  const query = (phrases.length > 0 ? phrases.join(" ") : text.replace(REQUEST_WORDS, " ")
    .replace(/[，,。；;：:？！?!]/gu, " ").replace(/(?:^|\s)(?:在|里|中|从|内|本地|当前群|本群)(?=\s|$)/gu, " "))
    .replace(/\s+/gu, " ").trim().slice(0, 4000);
  if (filters.from !== undefined && filters.to !== undefined) conditions.push(`北京时间 ${dateLabel(filters.from)} 至 ${dateLabel(filters.to - 1)}`);
  if (filters.author) conditions.push(`作者：${filters.author}`);
  if (filters.chatId || filters.chatName) conditions.push(`来源群：${filters.chatId ?? filters.chatName}`);
  if (filters.fileName) conditions.push(`文件名：${filters.fileName}`);
  if (filters.source) conditions.push(`来源类型：${filters.source}`);
  return { query, phrases: phrases.length > 0 ? phrases : query.split(" ").filter(Boolean), filters, conditions };
}
