import { AI_GENERATION_MAX_TOKENS, AI_ROUTING_MAX_TOKENS, type Page, type SpaceId } from "@homeagent/shared";
import type { LlmClient } from "./llm.ts";
import { tokenize } from "./tokenize.ts";

export interface GeneratedPage {
  title: string;
  summary: string;
  aliases?: string[];
  tags?: string[];
  links: string[];
  content: string;
}

export const PAGE_UPDATE_CHARACTERS = 48_000;
const BLOCK_CHARACTERS = PAGE_UPDATE_CHARACTERS / 6;
const CATALOG_CHARACTERS = PAGE_UPDATE_CHARACTERS / 2;
// Same byte-scale envelope as the Provider final artifact, not a shorter token budget.
const MAX_PATCH_CHARACTERS = AI_GENERATION_MAX_TOKENS * 16;
const DETAIL_NOTICE = "> 以下保留全部分段提炼证据，可能包含历史版本；当前结论及纠错以上方主文为准。";

interface MessageVersion { chatId: string; messageId: string; updatedAt?: number; createdAt?: number }
export interface PageBlock {
  id: string;
  heading: string;
  readonly: boolean;
  content: string;
  versions: MessageVersion[];
}

/** Exact slices of the frozen Markdown; ids are derived, never a second durable store. */
export function pageBlocks(content: string): PageBlock[] {
  const sections: Array<{ start: number; heading: string; readonly: boolean; versions: MessageVersion[] }> = [];
  let heading = "正文";
  let historical = false;
  let versions: MessageVersion[] = [];
  let fence: { marker: string; length: number } | undefined;
  for (const match of content.matchAll(/[^\n]*(?:\n|$)/gu)) {
    if (!match[0]) continue;
    const line = match[0].replace(/\r?\n$/u, "");
    const at = match.index;
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (fence) {
      if (delimiter && delimiter[1]![0] === fence.marker && delimiter[1]!.length >= fence.length && !delimiter[2]!.trim()) fence = undefined;
    } else if (delimiter) {
      fence = { marker: delimiter[1]![0]!, length: delimiter[1]!.length };
    } else {
      const title = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line);
      if (title) {
        heading = title[2]!;
        if (title[1] === "##" && heading === "来源分段详情"
          && content.slice(at + match[0].length).trimStart().startsWith(DETAIL_NOTICE)) historical = true;
        if (historical && /^来源分段 \d+$/u.test(heading)) versions = [];
        sections.push({ start: at, heading, readonly: historical, versions });
      }
      if (historical && line.startsWith("来源元数据：")) {
        try {
          const metadata: unknown = JSON.parse(line.slice("来源元数据：".length));
          if (Array.isArray(metadata)) for (const item of metadata) {
            if (item && typeof item === "object" && typeof item.chatId === "string" && typeof item.messageId === "string") {
              versions.push({ chatId: item.chatId, messageId: item.messageId,
                ...(typeof item.updatedAt === "number" ? { updatedAt: item.updatedAt } : {}),
                ...(typeof item.createdAt === "number" ? { createdAt: item.createdAt } : {}) });
            }
          }
        } catch { /* Legacy prose remains readable even without structured metadata. */ }
      }
    }
    if (sections.length === 0) sections.push({ start: 0, heading, readonly: historical, versions });
  }
  const blocks: PageBlock[] = [];
  for (const [index, section] of sections.entries()) {
    const limit = sections[index + 1]?.start ?? content.length;
    for (let start = section.start; start < limit;) {
      let end = Math.min(start + BLOCK_CHARACTERS, limit);
      if (end < limit) {
        const paragraph = content.lastIndexOf("\n\n", end - 2);
        const newline = content.lastIndexOf("\n", end - 1);
        const boundary = paragraph >= start + BLOCK_CHARACTERS / 2 ? paragraph + 2 : newline + 1;
        if (boundary > start + BLOCK_CHARACTERS / 2) end = boundary;
        if (content.charCodeAt(end - 1) >= 0xd800 && content.charCodeAt(end - 1) <= 0xdbff) end--;
      }
      const body = content.slice(start, end);
      const hash = new Bun.CryptoHasher("sha256").update(body).digest("hex").slice(0, 16);
      blocks.push({ id: `block-${blocks.length + 1}-${hash}`, heading: section.heading,
        readonly: section.readonly, content: body, versions: section.versions });
      start = end;
    }
  }
  return blocks;
}

function* batches<T>(items: T[], size: (item: T) => number, limit: number): Generator<T[], void> {
  let batch: T[] = [];
  let length = 0;
  for (const item of items) {
    const next = size(item);
    if (batch.length && length + next > limit) { yield batch; batch = []; length = 0; }
    batch.push(item);
    length += next;
  }
  if (batch.length) yield batch;
}

function preview(block: PageBlock, terms: Set<string>): string {
  const words = tokenize(block.content);
  const keyword = words.find(word => terms.has(word) && word.length > 1);
  const at = keyword ? block.content.toLowerCase().indexOf(keyword) : -1;
  return [block.content.slice(0, 180), at > 180 ? block.content.slice(Math.max(0, at - 80), at + 160) : "", block.content.slice(-120)]
    .filter(Boolean).join(" … ");
}

interface Patch {
  readBlockIds: string[];
  readNextCatalog: boolean;
  edits: Array<{ id: string; content: string }>;
  append: string;
  metadata: GeneratedPage;
}

export async function updateLargePage(input: {
  page: Page; client: LlmClient; prompt: string; query: string; space: SpaceId; model?: string;
  reviewAll: boolean; versions: Array<{ chatId?: string; messageId?: string }>;
  signal?: AbortSignal; validate: (raw: unknown) => GeneratedPage;
}): Promise<GeneratedPage> {
  const { page, client, signal } = input;
  const cancelled = () => { if (signal?.aborted) throw signal.reason ?? new Error("distillation cancelled"); };
  const blocks = pageBlocks(page.content);
  const byId = new Map(blocks.map(block => [block.id, block]));
  const terms = new Set(tokenize(input.query));
  const catalog = blocks.map(block => ({ id: block.id, heading: block.heading.slice(0, 200), readonly: block.readonly,
    preview: preview(block, terms) }));
  const catalogParts = [...batches(catalog, entry => JSON.stringify(entry).length + 24, CATALOG_CHARACTERS)];
  const selected = new Set<string>();
  const knownVersions = new Map<string, MessageVersion>();
  if (blocks[0] && !blocks[0].readonly) selected.add(blocks[0].id);
  for (const block of blocks) {
    if (!block.readonly && input.reviewAll) selected.add(block.id);
    for (const version of block.versions) {
      if (!input.versions.some(source => source.chatId === version.chatId && source.messageId === version.messageId)) continue;
      selected.add(block.id);
      const key = JSON.stringify([version.chatId, version.messageId]);
      const previous = knownVersions.get(key);
      if (!previous || (version.updatedAt ?? version.createdAt ?? 0) > (previous.updatedAt ?? previous.createdAt ?? 0)) knownVersions.set(key, version);
    }
  }
  for (const part of catalogParts) {
    cancelled();
    const ids = new Set(part.map(entry => entry.id));
    const { value } = await client.completeJSON<string[]>({
      model: input.model, space: input.space, purpose: "distill", maxTokens: AI_ROUTING_MAX_TOKENS,
      system: "你严格按 schema 输出，选择需要核对的旧知识页内容块。",
      prompt: [input.prompt, "", "## 旧页局部更新：选择内容块", "选择与新增事实、纠错、版本差异有关的全部块；目录只是预览，不代表完整事实。",
        "历史来源详情为只读证据，可读取用于核对，当前结论更新主文。后续可追加读取其他块。",
        "## 旧页块目录", ...part.map(entry => JSON.stringify(entry)), "", "## 选择结果", "返回 readBlockIds；本批无相关块可为空。"].join("\n"),
      schema: { type: "object", properties: { readBlockIds: { type: "array", maxItems: ids.size,
        items: { type: "string", enum: [...ids] } } }, required: ["readBlockIds"] },
      validate(raw) { return readIds(raw, ids); },
    });
    for (const id of value) selected.add(id);
  }
  // Additional reads restart only the in-memory patch, always against the same base.
  let catalogIndex = 0;
  for (;;) {
    const groups = [...batches(blocks.filter(block => selected.has(block.id)), block => block.content.length, PAGE_UPDATE_CHARACTERS)];
    if (groups.length === 0) groups.push([]);
    const edits = new Map<string, string>();
    let metadata: GeneratedPage = { ...page };
    let append = "";
    let expanded = false;
    for (const [index, group] of groups.entries()) {
      cancelled();
      const visible = new Map(group.map(block => [block.id, block]));
      const remaining = groups.length - index - 1;
      const { value } = await client.completeJSON<Patch>({
        model: input.model, space: input.space, purpose: "distill", maxTokens: AI_GENERATION_MAX_TOKENS,
        system: "你严格按 schema 输出旧知识页的局部修改，未修改内容由程序逐字保留。",
        prompt: [input.prompt, "", "## 旧页局部更新：提交修改",
          "edits 仅返回当前可见且非只读块的修改后完整文本（包括原有标题、代码围栏、缩进和块末换行）；无变化不返回，明确删除可为空字符串。",
          "程序保留其他所有块。块可能是长章节或长代码的一部分，不得补写或丢弃未显示的上下文。",
          "来源详情只能作为证据，旧版本不得覆盖较新版本；在主文更新结论，不修改历史详情。",
          `已保存同消息的最新版本 metadata：${JSON.stringify([...knownVersions.values()])}`,
          "如需读取目录中的其他块，返回尚未选中的 readBlockIds，并令 edits、append 为空；本轮修改会重新计算。",
          "若需要下一批块目录，令 readNextCatalog=true 且 edits、append 为空；可以同时选择本批目录中的未选块。",
          "本批尚有后续内容块时 append 必须为空；最后一批用 append 添加没有合适旧块的新主文，程序放在历史详情之前。",
          "title、summary、aliases、tags、links 返回更新后的元数据；未受本次证据影响的别名、标签和关联应保留。",
          `后续内容批次数：${remaining}；本轮已选块数：${selected.size}；目录 selected=true 的块已选中，不要重复请求。`,
          `当前元数据：${JSON.stringify({ title: metadata.title, summary: metadata.summary, aliases: metadata.aliases, tags: metadata.tags, links: metadata.links })}`,
          `## 可追加读取的块目录（${catalogIndex + 1}/${catalogParts.length}）`,
          ...(catalogParts[catalogIndex] ?? []).map(entry => JSON.stringify({ ...entry, selected: selected.has(entry.id) })), "",
          "## 当前内容块", ...group.map(block => JSON.stringify(block)), "", "## 修改结果", "输出 readBlockIds、edits、append 和元数据，不输出整页 content。"].join("\n"),
        schema: { type: "object", properties: {
          readBlockIds: { type: "array", maxItems: blocks.length, items: { type: "string" } },
          readNextCatalog: { type: "boolean" },
          edits: { type: "array", maxItems: group.length, items: { type: "object", properties: {
            id: { type: "string" }, content: { type: "string", maxLength: MAX_PATCH_CHARACTERS } }, required: ["id", "content"] } },
          append: { type: "string", maxLength: MAX_PATCH_CHARACTERS }, title: { type: "string" }, summary: { type: "string" },
          aliases: { type: "array", items: { type: "string" } }, tags: { type: "array", items: { type: "string" } },
          links: { type: "array", items: { type: "string" } },
        }, required: ["readBlockIds", "readNextCatalog", "edits", "append", "title", "summary", "aliases", "tags", "links"] },
        validate(raw) {
          const readBlockIds = readIds(raw, new Set(byId.keys()));
          if (!raw || typeof raw !== "object" || !("edits" in raw) || !Array.isArray(raw.edits) || raw.edits.length > group.length
            || !("append" in raw) || typeof raw.append !== "string") throw new Error("invalid page patch");
          const readNextCatalog = "readNextCatalog" in raw && raw.readNextCatalog === true;
          if (readNextCatalog && catalogIndex + 1 >= catalogParts.length) throw new Error("page patch has no further catalog");
          if (!("readNextCatalog" in raw) || typeof raw.readNextCatalog !== "boolean") throw new Error("invalid page catalog request");
          if (readBlockIds.some(id => selected.has(id))) throw new Error("page patch read made no progress");
          if ((readBlockIds.length || readNextCatalog) && (raw.edits.length || raw.append)) throw new Error("page patch mixes reads and edits");
          if (remaining && raw.append) throw new Error("page patch appends before all selected blocks are reviewed");
          const changes: Patch["edits"] = [];
          const seen = new Set<string>();
          let characters = raw.append.length;
          for (const edit of raw.edits) {
            if (!edit || typeof edit !== "object" || typeof edit.id !== "string" || typeof edit.content !== "string"
              || !visible.has(edit.id) || visible.get(edit.id)!.readonly || seen.has(edit.id)) throw new Error("invalid page patch block");
            seen.add(edit.id);
            characters += edit.content.length;
            const original = visible.get(edit.id)!.content;
            const ending = original.match(/(?:\r?\n)+$/u)?.[0] ?? "";
            const content = edit.content && ending && !edit.content.endsWith("\n") ? edit.content + ending : edit.content;
            changes.push({ id: edit.id, content });
          }
          if (characters > MAX_PATCH_CHARACTERS) throw new Error("page patch exceeds output artifact budget");
          return { readBlockIds, readNextCatalog, edits: changes, append: raw.append, metadata: input.validate({ ...raw, content: "metadata validation" }) };
        },
      });
      cancelled();
      if (value.readBlockIds.length || value.readNextCatalog) {
        for (const id of value.readBlockIds) selected.add(id);
        if (value.readNextCatalog) catalogIndex++;
        expanded = true;
        break;
      }
      for (const edit of value.edits) edits.set(edit.id, edit.content);
      metadata = value.metadata;
      append = value.append;
    }
    if (expanded) continue;
    const firstHistory = blocks.findIndex(block => block.readonly);
    const insertion = firstHistory < 0 ? blocks.length : firstHistory;
    const body = blocks.slice(0, insertion).map(block => edits.get(block.id) ?? block.content).join("")
      + (append ? `\n\n${append}\n\n` : "") + blocks.slice(insertion).map(block => block.content).join("");
    if (!body.trim()) throw new Error("page patch produced an empty page");
    return { ...metadata, content: body };
  }
}

function readIds(raw: unknown, allowed: Set<string>): string[] {
  if (!raw || typeof raw !== "object" || !("readBlockIds" in raw) || !Array.isArray(raw.readBlockIds)
    || raw.readBlockIds.length > allowed.size) throw new Error("invalid page block selection");
  const ids = new Set<string>();
  for (const id of raw.readBlockIds) {
    if (typeof id !== "string" || !allowed.has(id) || ids.has(id)) throw new Error("invalid page block identity");
    ids.add(id);
  }
  return [...ids];
}
