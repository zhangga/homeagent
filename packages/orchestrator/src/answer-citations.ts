import {
  chatRawSourceUrl, knowledgePageRevision, MAX_KNOWLEDGE_TRACE_SOURCES, rawExcerpt, rawSourceText,
  type AnswerTrace, type KnowledgeEngine,
} from "@homeagent/core";
import type { SpaceId } from "@homeagent/shared";
import type { InboundMessage } from "@homeagent/connectors";

export function citationNumber(text: string): number | undefined {
  const match = text.trim().replace(/^@\S+\s+/u, "").match(/^(?:查看|看)\s*依据\s*(\d+)[。！]?$/u);
  return match ? Number(match[1]) : undefined;
}

function markdownText(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;")
    .replace(/[\\`*_\[\]~]/gu, "\\$&");
}

export function citationTitle(value: string): string {
  return markdownText(value.replace(/\s+/gu, " ").trim());
}

const shanghaiDate = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });
export function citationDate(at: number): string {
  const date = new Date(at);
  return Number.isFinite(date.getTime()) ? shanghaiDate.format(date) : "日期未知";
}

/** No public host is required: only a URL recorded with a real source is linked. */
function markdownUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const source = new URL(url);
  if ([...source.searchParams.keys()].some(key => /^(?:(?:access|refresh|tenant_access|app_access)[_-]?)?token$|^(?:app[_-]?secret|authorization[_-]?code|code)$/iu.test(key))) return undefined;
  return url.replace(/[()<>]/gu, char => `%${char.charCodeAt(0).toString(16)}`);
}

interface CitationSources {
  link?: string;
  excerpts: string[];
  count: number;
}

function citationSources(engine: KnowledgeEngine, space: SpaceId, trace: AnswerTrace, index: number, linksOnly: boolean): CitationSources {
  const citation = trace.citations[index];
  const unavailable: CitationSources = { excerpts: [], count: 0 };
  if (!citation || !trace.spaces.includes(space) || !engine.registry.has(space)) return unavailable;
  const matches = trace.retrievalPages?.filter(page => page.slug === citation.slug && (!citation.space || page.space === citation.space));
  const original = matches?.length === 1 ? matches[0] : undefined;
  // A shared Feishu reply may only expand evidence belonging to this group. Never search other spaces by title or slug.
  if (!original?.revision || original.space !== space) return unavailable;
  const store = engine.registry.store(space).index();
  const page = store.getPage(original.slug);
  if (!page || knowledgePageRevision(page) !== original.revision) return unavailable;
  let link: string | undefined;
  const excerpts: string[] = [];
  for (const id of page.sources.slice(0, MAX_KNOWLEDGE_TRACE_SOURCES)) {
    const raw = store.getRaw(id);
    if (!raw || raw.admission !== "ready" || (raw.chatId && raw.messageId && store.getMessageRetraction(raw.chatId, raw.messageId))) continue;
    const source = rawSourceText(raw);
    const url = markdownUrl(source.documentUrl ?? chatRawSourceUrl(raw));
    link ??= url;
    if (linksOnly) {
      if (url) break;
      continue;
    }
    if (!source.content.trim()) continue;
    const excerpt = rawExcerpt(source.content, trace.question, [], 480);
    const day = citationDate(raw.createdAt);
    const quote = markdownText(excerpt.content.trim()).split(/\r?\n/u).map(line => `> ${line}`).join("\n");
    excerpts.push(`${day}${url ? ` · [打开来源](${url})` : ""}\n${quote}${excerpt.truncated ? "\n（原文节选）" : ""}`);
    if (excerpts.length === 3) break;
  }
  return { link, excerpts, count: page.sources.length };
}

export function citationSourceLinks(engine: KnowledgeEngine, space: SpaceId, trace: AnswerTrace): Array<string | undefined> {
  return trace.citations.map((_, index) => citationSources(engine, space, trace, index, true).link);
}

export function citationReply(engine: KnowledgeEngine, space: SpaceId, msg: InboundMessage, number: number, appId: string, bindingId?: string, directOnly = false): string | undefined {
  const requestAnswer = "请回复要核对的那条 HomeAgent 回答，再发送「看依据 1」。";
  if (!msg.parentMessageId && !msg.rootMessageId) return directOnly ? undefined : requestAnswer;
  const runs = engine.chatRuns.list(space, ["succeeded"]).filter(run => run.chatId === msg.chatId && run.delivery.status === "sent");
  const direct = runs.filter(run => !!msg.parentMessageId && run.delivery.messageId === msg.parentMessageId);
  if (directOnly && direct.length !== 1) return undefined;
  if (direct.length > 1) return requestAnswer;
  const candidates = (direct.length ? direct : runs).filter(run => {
    const inputId = run.sourceInputId ?? run.dispatchKey;
    const original = inputId ? engine.workDispatch.get(inputId) : undefined;
    if (!original || original.space !== space || original.connector !== "feishu" || original.appId !== appId
      || original.bindingId !== bindingId || original.message.chatId !== msg.chatId) return false;
    const root = original.message.rootMessageId ?? original.message.messageId;
    if (msg.parentMessageId && run.delivery.messageId === msg.parentMessageId) return !msg.rootMessageId || msg.rootMessageId === root || msg.rootMessageId === run.delivery.messageId;
    return !!msg.rootMessageId && msg.rootMessageId === root;
  });
  if (directOnly && candidates.length !== 1) return undefined;
  const traces = candidates.flatMap(run => {
    const trace = run.traceId ? engine.answerTrace(run.traceId) : undefined;
    return trace?.source === "knowledge" && trace.citations.length ? [trace] : [];
  });
  if (!traces.length && direct.length && candidates.length) return "这条回答没有可核验的知识依据。";
  if (traces.length !== 1) return requestAnswer;
  const trace = traces[0]!;
  const citation = trace.citations[number - 1];
  if (!citation) return `这条回答有 ${trace.citations.length} 项依据，请选其中的编号。`;
  const { excerpts, count } = citationSources(engine, space, trace, number - 1, false);
  if (!excerpts.length) return "目前无法核验这项依据。原版本或可见来源已不可用，你可以重新提问获取当前依据。";
  return [`依据 ${number} · ${citationTitle(citation.title)}`, ...excerpts,
    ...(count > excerpts.length ? [`本页共引用 ${count} 条来源，此处展示其中 ${excerpts.length} 条可读摘录。`] : [])].join("\n\n");
}
