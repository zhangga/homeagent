/**
 * Dream cycle: the nightly distillation that turns raw captures into wiki pages
 * (plan §2.3). Two-step chain-of-thought, mirroring llm_wiki's design (borrowed,
 * reimplemented — not copied):
 *
 *   Step 1 (analyze): given the space purpose/schema, the current page index,
 *     and a batch of pending raw entries, the LLM decides which entries are
 *     worth distilling and plans page operations (create/update). Pure noise is
 *     reported as skipped and never becomes a page (plan Q7).
 *   Step 2 (generate): short inputs produce a page directly. Long inputs first
 *     yield independent evidence notes, then merge into the existing page once.
 *     Fragments feeding multiple pages are extracted together once per cycle.
 *     Independent extractions run with bounded concurrency and retain source order.
 *     Notes remain verbatim in source-detail sections; oversized merge inputs use
 *     a reduced overview. Intermediate pages are never replayed.
 *
 * Robustness (plan R3): JSON mode via forced tool-use + schema validation +
 * retries + bad-page quarantine. Provenance: each page records the raw ids it
 * was distilled from. Incremental cache: a page is not regenerated when its
 * source set is unchanged (unless force).
 *
 * After distillation the deterministic topic maps plus index/glossary/overview
 * are refreshed and a log entry is appended.
 */
import type { DreamModels, DreamReport, Page, RawRecord } from "@homeagent/shared";
import { chatRawEntryUpdatedAt, isChatSourceSnapshot } from "./chat-raw-import.ts";
import { dreamSourceRefs, type DreamProgress } from "./dream-progress.ts";
import {
  AI_DREAM_EXTRACTION_CONCURRENCY,
  AI_GENERATION_MAX_TOKENS,
  AI_ROUTING_MAX_TOKENS,
  logger,
} from "@homeagent/shared";
import type { SpaceStore } from "./space.ts";
import type {
  DreamOptions,
  QuarantinedDreamOperation,
  QuarantineRecord,
} from "./types.ts";
import { gatewayClient, type LlmClient } from "./llm.ts";
import { canonicalSlug } from "./slug.ts";
import { refreshDigest } from "./digest.ts";
import { DreamCatalog, dreamCatalogBatches } from "./dream-catalog.ts";
import { PAGE_UPDATE_CHARACTERS, updateLargePage, type GeneratedPage } from "./dream-page-update.ts";
import { DreamExtractionCache, extractionDigest } from "./dream-extraction-cache.ts";
import { DreamExecution, dreamMetricsLog } from "./dream-execution.ts";
import {
  removeQuarantineRecordsCoveredBy,
  writeQuarantineRecord,
} from "./quarantine.ts";

const log = logger.child("dream");

/** Max pending Raw entries analyzed in one stable prompt batch. */
const DEFAULT_MAX_ENTRIES = 40;
const MAX_ANALYZE_SOURCE_CHARACTERS = 48_000;
const MAX_GENERATE_SOURCE_CHARACTERS = 48_000;

// ---- step 1: analyze -------------------------------------------------------

interface PlannedOp {
  type: "entity" | "concept" | "source" | "analysis";
  name: string;
  title: string;
  rawIds: string[];
  reason?: string;
  /** Selected by the planner's input groups, never accepted from model output. */
  sourceFragments?: SourceFragment[];
}

interface AnalyzeResult {
  operations: PlannedOp[];
  skippedRawIds: string[];
}

const ANALYZE_SCHEMA = {
  type: "object",
  properties: {
    operations: {
      type: "array",
      description: "Pages to create or update from the worthwhile raw entries.",
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["entity", "concept", "source", "analysis"] },
          name: { type: "string", description: "short identifier used for the page slug" },
          title: { type: "string", description: "human-readable page title" },
          rawIds: {
            type: "array",
            items: { type: "string" },
            description: "ids of the raw entries feeding this page",
          },
          reason: { type: "string" },
        },
        required: ["type", "name", "title", "rawIds"],
      },
    },
    skippedRawIds: {
      type: "array",
      items: { type: "string" },
      description: "ids of raw entries that are noise / not worth a page",
    },
  },
  required: ["operations", "skippedRawIds"],
} as const;

function validateAnalyze(raw: unknown): AnalyzeResult {
  const o = raw as Record<string, unknown>;
  if (!o || !Array.isArray(o.operations) || !Array.isArray(o.skippedRawIds)) {
    throw new Error("analyze result missing operations/skippedRawIds");
  }
  const operations: PlannedOp[] = [];
  for (const item of o.operations as Record<string, unknown>[]) {
    if (!item || typeof item.name !== "string" || typeof item.title !== "string") continue;
    const type = item.type as PlannedOp["type"];
    if (!["entity", "concept", "source", "analysis"].includes(type)) continue;
    const rawIds = Array.isArray(item.rawIds) ? (item.rawIds as unknown[]).map(String) : [];
    if (rawIds.length === 0) continue;
    operations.push({
      type,
      name: item.name,
      title: item.title,
      rawIds,
      reason: typeof item.reason === "string" ? item.reason : undefined,
    });
  }
  return { operations, skippedRawIds: (o.skippedRawIds as unknown[]).map(String) };
}

function analyzePrompt(store: SpaceStore, batch: SourceFragment[], catalog: DreamCatalog): string {
  const index = catalog.prompt(batch.map(fragment => fragment.content));
  const entries = batch
    .map(({ raw: r, content, part, totalParts }) => {
      const meta = [r.source, r.author ? `by ${r.author}` : ""].filter(Boolean).join(" ");
      return `<entry id="${r.id}"${totalParts > 1 ? ` part="${part}/${totalParts}"` : ""} ${meta ? `meta="${meta}"` : ""}>\n${content}\n</entry>`;
    })
    .join("\n\n");
  return [
    "你是一个团队/家庭知识库的提炼助手。以下是本空间的意图与页类型规则：",
    "",
    "## 空间意图",
    store.purpose().trim(),
    "",
    "## 页类型规则",
    store.schema().trim(),
    "",
    catalog.complete ? "## 现有知识页（用于判断新建还是更新）" : "## 现有知识页候选目录（用于判断新建还是更新）",
    index || (catalog.size === 0 ? "（暂无）" : "（本段未直接命中候选；不代表空间没有知识页）"),
    "",
    "## 待提炼的原始条目",
    entries,
    "",
    "任务：判断哪些条目值得沉淀为知识页。",
    "- 纯寒暄、无信息量的噪声条目，放入 skippedRawIds，不要建页。",
    "- 值得沉淀的，规划成对页面的 create/update 操作；若与现有页相关请复用其 name/slug 以更新。",
    "- 每个操作的 rawIds 必须来自上面条目的真实 id。",
    "- 带 part 的条目是完整来源的一段；仅规划本段实际出现的知识，后续会合并同一知识页的计划。",
    ...(!catalog.complete ? ["- 候选目录不是全库。优先复用相关候选；拟新建时填写清楚 title 和 reason 中的主题、对象与用途，系统将补查其他旧页。"] : []),
  ].join("\n");
}

function reuseOperationLine(item: { id: string; op: PlannedOp }): string {
  return JSON.stringify({ operation: item.id, type: item.op.type, name: item.op.name.slice(0, 240),
    title: item.op.title.slice(0, 255), reason: (item.op.reason ?? "").slice(0, 1_000) });
}

async function reusePlannedPages(
  client: LlmClient, store: SpaceStore, catalog: DreamCatalog, operations: PlannedOp[], model: string | undefined, signal?: AbortSignal,
): Promise<PlannedOp[]> {
  if (catalog.complete) return operations;
  const resolved = new Map<PlannedOp, PlannedOp>();
  const novel = operations.map((op, index) => ({ id: `op-${index + 1}`, op }))
    .filter(({ op }) => !catalog.get(canonicalSlug(op.type, op.name)));
  for (const operationBatch of dreamCatalogBatches(novel, reuseOperationLine)) {
    let pending = operationBatch;
    for (const pages of catalog.reuseBatches(pending.map(({ op }) => `${op.name}\n${op.title}\n${op.reason ?? ""}`))) {
      if (signal?.aborted) throw signal.reason ?? new Error("distillation cancelled");
      const ids = new Set(pending.map(item => item.id));
      const pagesBySlug = new Map(pages.map(({ ref }) => [ref.slug, ref]));
      const { value } = await client.completeJSON<Array<{ operation: string; slug: string }>>({
        model, space: store.space, purpose: "distill", maxTokens: AI_ROUTING_MAX_TOKENS,
        system: "你严格按 schema 输出结构化结果，核对新建知识页是否应复用旧页。",
        prompt: ["## 新建页面复用检查", "## 拟新建页面", ...pending.map(reuseOperationLine), "",
          "## 本空间已有页面（本批）", ...pages.map(page => page.line), "",
          "逐项判断是否与本批某个旧页描述同一知识主题、对象与用途；同义表达和别名也应复用。",
          "只在应合并更新而非仅相关时返回 operation 和已有页 slug；每个 operation 最多匹配一个旧页。",
          "无对应旧页的 operation 不放入 matches；后续会继续检查剩余目录，不在这里创建页面。"].join("\n"),
        schema: { type: "object", properties: { matches: { type: "array", maxItems: pending.length,
          items: { type: "object", properties: { operation: { type: "string", enum: [...ids] },
            slug: { type: "string", enum: [...pagesBySlug.keys()] } }, required: ["operation", "slug"] } } }, required: ["matches"] },
        validate(raw) {
          if (!raw || typeof raw !== "object" || !("matches" in raw) || !Array.isArray(raw.matches)
            || raw.matches.length > pending.length) throw new Error("invalid Dream catalog matches");
          const seen = new Set<string>();
          const matches: Array<{ operation: string; slug: string }> = [];
          for (const match of raw.matches) {
            if (!match || typeof match !== "object" || typeof match.operation !== "string" || typeof match.slug !== "string"
              || !ids.has(match.operation) || seen.has(match.operation) || !pagesBySlug.has(match.slug)) {
              throw new Error("invalid Dream catalog match identity");
            }
            seen.add(match.operation);
            matches.push({ operation: match.operation, slug: match.slug });
          }
          return matches;
        },
      });
      if (signal?.aborted) throw signal.reason ?? new Error("distillation cancelled");
      for (const match of value) {
        const item = pending.find(item => item.id === match.operation)!;
        const page = pagesBySlug.get(match.slug)!;
        const type = page.type;
        if (type !== "entity" && type !== "concept" && type !== "source" && type !== "analysis") throw new Error("invalid Dream catalog page type");
        resolved.set(item.op, { ...item.op, type, name: page.slug, title: page.title });
      }
      pending = pending.filter(item => !resolved.has(item.op));
      if (pending.length === 0) break;
    }
  }
  return operations.map(op => resolved.get(op) ?? op);
}

async function analyze(
  client: LlmClient,
  store: SpaceStore,
  batch: RawRecord[],
  model: string | undefined,
  onProgress?: (progress: DreamProgress) => void,
  signal?: AbortSignal,
): Promise<AnalyzeResult> {
  const groups = groupSourceFragments(splitSourceFragments(batch, MAX_ANALYZE_SOURCE_CHARACTERS));
  const catalog = new DreamCatalog(store);
  const operations = new Map<string, PlannedOp>();
  const skipped = new Map<string, number>();
  const appearances = new Map<string, number>();
  const classified = new Map<string, number>();
  for (const [index, group] of groups.entries()) {
    if (signal?.aborted) throw signal.reason ?? new Error("distillation cancelled");
    const ids = new Set(group.map(fragment => fragment.raw.id));
    for (const id of ids) appearances.set(id, (appearances.get(id) ?? 0) + 1);
    onProgress?.({ stage: "analyzing", rawCount: batch.length, sources: dreamSourceRefs(group.map(fragment => fragment.raw)),
      sourceCount: batch.length, chunk: { index: index + 1, total: groups.length } });
    const { value } = await client.completeJSON<AnalyzeResult>({
      model,
      system: "你严格按 schema 输出结构化结果，不要输出多余文本。",
      prompt: analyzePrompt(store, group, catalog),
      schema: ANALYZE_SCHEMA as unknown as Record<string, unknown>,
      validate: validateAnalyze,
      maxTokens: AI_ROUTING_MAX_TOKENS,
      purpose: "distill",
      space: store.space,
    });
    const validOperations = value.operations.map(op => ({ ...op, rawIds: [...new Set(op.rawIds.filter(id => ids.has(id)))] }))
      .filter(op => op.rawIds.length > 0);
    const planned = await reusePlannedPages(client, store, catalog, validOperations, model, signal);
    for (const op of planned) {
      const rawIds = [...new Set(op.rawIds.filter(id => ids.has(id)))];
      if (rawIds.length === 0) continue;
      const key = canonicalSlug(op.type, op.name);
      const previous = operations.get(key);
      const sourceFragments = group.filter(fragment => rawIds.includes(fragment.raw.id));
      operations.set(key, previous
        ? { ...previous, rawIds: [...new Set([...previous.rawIds, ...rawIds])],
          sourceFragments: [...new Set([...previous.sourceFragments!, ...sourceFragments])] }
        : { ...op, rawIds, sourceFragments });
      catalog.remember({ slug: key, type: op.type, title: op.title, summary: op.reason ?? "本轮已规划的知识页",
        aliases: [], tags: [] });
    }
    for (const id of new Set(value.skippedRawIds.filter(id => ids.has(id)))) skipped.set(id, (skipped.get(id) ?? 0) + 1);
    const classifiedIds = new Set([...value.operations.flatMap(op => op.rawIds), ...value.skippedRawIds]);
    for (const id of ids) if (classifiedIds.has(id)) classified.set(id, (classified.get(id) ?? 0) + 1);
  }
  const used = new Set([...operations.values()].flatMap(op => op.rawIds));
  // Do not generate/consume a partial Raw while its other fragments are unclassified.
  const incomplete = batch.filter(raw => used.has(raw.id) && classified.get(raw.id) !== appearances.get(raw.id));
  if (incomplete.length > 0) throw new Error(`${incomplete.length} 条 Raw 仍有未分类的来源分段，保留待提炼`);
  return { operations: [...operations.values()], skippedRawIds: batch
    .filter(raw => !used.has(raw.id) && skipped.get(raw.id) === appearances.get(raw.id)).map(raw => raw.id) };
}

// ---- step 2: generate ------------------------------------------------------

const MAX_SEARCH_METADATA_ITEMS = 64;
const MAX_SEARCH_METADATA_VALUE_CHARACTERS = 200;

function normalizeSearchMetadata(values: unknown[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const item = String(value).trim().slice(0, MAX_SEARCH_METADATA_VALUE_CHARACTERS);
    if (!item || seen.has(item)) continue;
    seen.add(item);
    normalized.push(item);
    if (normalized.length >= MAX_SEARCH_METADATA_ITEMS) break;
  }
  return normalized;
}

const GENERATE_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    summary: { type: "string", description: "one-sentence summary" },
    aliases: { type: "array", items: { type: "string" } },
    tags: { type: "array", items: { type: "string" } },
    links: {
      type: "array",
      items: { type: "string" },
      description: "slugs of related pages to link ([[wikilinks]])",
    },
    content: { type: "string", description: "full markdown body of the page" },
  },
  required: ["title", "summary", "content"],
} as const;

function validateGenerate(raw: unknown): GeneratedPage {
  const o = raw as Record<string, unknown>;
  if (!o || typeof o.title !== "string" || typeof o.content !== "string") {
    throw new Error("generated page missing title/content");
  }
  if (o.content.trim().length === 0) throw new Error("generated page has empty content");
  return {
    title: o.title,
    summary: typeof o.summary === "string" ? o.summary : "",
    aliases: Array.isArray(o.aliases) ? normalizeSearchMetadata(o.aliases) : undefined,
    tags: Array.isArray(o.tags) ? normalizeSearchMetadata(o.tags) : undefined,
    links: Array.isArray(o.links) ? (o.links as unknown[]).map(String) : [],
    content: o.content,
  };
}

function resolveSearchMetadata(existing: string[] | undefined, generated: string[] | undefined): string[] {
  return generated === undefined ? normalizeSearchMetadata(existing ?? []) : generated;
}

interface SourceFragment {
  raw: RawRecord;
  content: string;
  part: number;
  totalParts: number;
  start: number;
  end: number;
}

function splitText(content: string, characters = MAX_GENERATE_SOURCE_CHARACTERS): Array<{ content: string; start: number; end: number }> {
  const chunks: Array<{ content: string; start: number; end: number }> = [];
  for (let start = 0; start < content.length;) {
    let end = Math.min(start + characters, content.length);
    if (end < content.length && content.charCodeAt(end - 1) >= 0xd800 && content.charCodeAt(end - 1) <= 0xdbff) end -= 1;
    chunks.push({ content: content.slice(start, end), start, end });
    start = end;
  }
  return chunks.length > 0 ? chunks : [{ content: "", start: 0, end: 0 }];
}

function splitSourceFragments(sources: RawRecord[], characters = MAX_GENERATE_SOURCE_CHARACTERS): SourceFragment[] {
  return sources.flatMap((raw) => {
    const chunks = splitText(raw.content, characters);
    return chunks.map((chunk, index) => ({
      raw,
      ...chunk,
      part: index + 1,
      totalParts: chunks.length,
    }));
  });
}

function groupSourceFragments(fragments: SourceFragment[]): SourceFragment[][] {
  const groups: SourceFragment[][] = [];
  let current: SourceFragment[] = [];
  let currentCharacters = 0;
  for (const fragment of fragments) {
    if (
      current.length > 0
      && currentCharacters + fragment.content.length > MAX_GENERATE_SOURCE_CHARACTERS
    ) {
      groups.push(current);
      current = [];
      currentCharacters = 0;
    }
    current.push(fragment);
    currentCharacters += fragment.content.length;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function generatePrompt(
  store: SpaceStore,
  op: PlannedOp,
  slug: string,
  existing: Page | null,
  sources: SourceFragment[],
  evidence?: string,
  extractOnly = false,
  sharedTargets?: Array<{ slug: string; op: PlannedOp }>,
  partialUpdate = false,
): string {
  const src = evidence ? "" : sources
    .map((fragment) => {
      const part = fragment.totalParts > 1
        ? ` part="${fragment.part}/${fragment.totalParts}"`
        : "";
      const type = isChatSourceSnapshot(fragment.raw) ? "chat-source-snapshot" : fragment.raw.source;
      return `<source id="${fragment.raw.id}" type="${type}"${part}>\n${fragment.content}\n</source>`;
    })
    .join("\n\n");
  const parts = [
    sharedTargets
      ? "请一次阅读当前来源分段，为每个目标知识页分别提取相关知识。"
      : partialUpdate ? `请为知识页「${op.title}」(slug: ${slug}, 类型: ${op.type}) 更新受新来源影响的内容块。`
      : extractOnly
      ? `请为知识页「${op.title}」(slug: ${slug}, 类型: ${op.type}) 提取当前来源分段中的相关知识。`
      : `请为知识页「${op.title}」(slug: ${slug}, 类型: ${op.type}) 生成完整内容。`,
    "",
    "## 空间页类型规则",
    store.schema().trim(),
    "",
  ];
  if (sharedTargets) parts.push(
    "## 多页共享提取",
    ...sharedTargets.map(({ slug: targetSlug, op: target }) => JSON.stringify({ slug: targetSlug, title: target.title, type: target.type })),
    "- pages 必须恰好包含上述每个 slug 一次，不得遗漏、重复或新增目标页。",
    "- 每项的 content、summary、aliases、tags、links 仅属于该目标页；不要混入其他目标页的专属知识。",
    "- 所有目标页均已规划使用本组来源；逐页保留相关的全部细节，不要因同时提取多个页面而缩写或遗漏。",
    `来源 metadata：${evidenceSources(sources)}`,
    "",
  );
  if (existing) {
    parts.push(
      "## 该页现有内容（请在此基础上合并更新，不要丢失既有信息）",
      existing.content.trim(),
      "",
      "## 现有检索元数据",
      `aliases: ${JSON.stringify(existing.aliases)}`,
      `tags: ${JSON.stringify(existing.tags)}`,
      "",
    );
  }
  if (sources.some((source) => source.raw.source === "manual" && !isChatSourceSnapshot(source.raw))) {
    parts.push(
      "## 人工纠错规则",
      "标记为 type=\"manual\" 的来源是管理员明确提交的纠错，若与旧内容或更早来源冲突，以人工纠错为准，并移除被纠正的错误说法。",
      "",
    );
  }
  if (sources.some((source) => isChatSourceSnapshot(source.raw))) {
    parts.push("## 群消息版本规则",
      "type=\"chat-source-snapshot\" 是 Agent 查询所得的消息快照，不是管理员人工纠错。对同一群、同一 messageId，按来源 metadata 的 updatedAt（缺失时 createdAt）区分版本；最新版本用于描述当前消息，旧版本只用于变更历史。不得把同一消息的多个版本计为多起事件，也不能让旧版本覆盖较新的已知内容。", "");
  }
  parts.push(
    evidence ? "## 分段提炼结果" : "## 相关原始来源",
    evidence ?? src,
    "",
    "要求：",
    partialUpdate ? "- 按局部更新契约返回内容块修改，不输出整页；其余内容由系统保留。"
      : extractOnly
      ? "- content 只写本段与目标页有关的独立知识片段，不要生成或重写整页，不要复述其他分段。"
      : evidence
        ? "- content 为完整主文，组织导读、当前结论与既有知识的更新；来源分段详情由系统完整附加。"
        : "- content 为完整 markdown 正文（整页，不要分片）。",
    "- 用 [[slug]] 形式链接到相关页面（若知道其 slug）。",
    "- summary 用一句话概括。",
    "- aliases 只填写来源或既有页面明确支持的别名、简称与常见用户问法，用于检索本页。",
    "- tags 只填写来源或既有页面明确支持的主题、场景与职责。",
    "- aliases 与 tags 要输出更新后的完整集合；已不再受当前来源支持的旧项应删除，无内容时输出空数组。",
    "- 不要为了提高检索召回而臆造同义词、职责或场景。",
    "- 只根据来源与既有内容写，不要臆造。",
  );
  if (extractOnly) parts.push(
    "## 来源分段提取",
    "- 保留本段相关的全部事实、数字、条件、例外、结论、操作步骤、代码和版本差异，不要只给泛泛摘要。",
    "- summary 用一句话说明本段贡献，最多 1000 字符；content 不因 summary 而省略细节。",
    "- 不要补写前文、重复页标题或预测后续分段；既有知识会在最后统一合并。",
  );
  if (evidence) parts.push(
    "- 上方材料来自全部来源分段，完整提炼细节将由系统逐字附加为来源分段详情，不要在主文重复抄写。",
    "- 主文负责组织主题、当前结论和既有知识的更新；详情是来源证据，可能含旧版本，以主文和上述版本/纠错规则为准。",
  );
  return parts.join("\n");
}

const MAX_EVIDENCE_SUMMARY_CHARACTERS = 1_000;
const EXTRACT_SCHEMA = {
  ...GENERATE_SCHEMA,
  properties: {
    ...GENERATE_SCHEMA.properties,
    summary: { type: "string", maxLength: MAX_EVIDENCE_SUMMARY_CHARACTERS },
    content: { type: "string", description: "only the knowledge contributed by this source group; never a whole page" },
  },
};
const EXTRACT_SYSTEM = "你严格按 schema 输出结构化结果，只提取当前来源分段的知识，不重写整页。";
const SHARED_EXTRACT_SYSTEM = "你严格按 schema 输出结构化结果，一次读取来源，为每个目标页分别提取知识，不重写整页。";
const OVERVIEW_SCHEMA = {
  type: "object",
  properties: { summary: { type: "string", minLength: 1, maxLength: MAX_EVIDENCE_SUMMARY_CHARACTERS } },
  required: ["summary"],
};

function validateEvidence(raw: unknown): GeneratedPage {
  const note = validateGenerate(raw);
  if (note.summary.length > MAX_EVIDENCE_SUMMARY_CHARACTERS) throw new Error("source evidence summary is too long");
  return note;
}

function evidenceSources(group: SourceFragment[]): string {
  return JSON.stringify(group.map(({ raw, part, totalParts }) => ({
    rawId: raw.id, type: isChatSourceSnapshot(raw) ? "chat-source-snapshot" : raw.source,
    createdAt: raw.createdAt, part, totalParts,
    ...(isChatSourceSnapshot(raw) ? { chatId: raw.chatId, messageId: raw.messageId, updatedAt: chatRawEntryUpdatedAt(raw) } : {}),
  })));
}

interface SharedExtraction {
  sources: SourceFragment[];
  targets: Array<{ slug: string; op: PlannedOp }>;
  result?: Promise<Map<string, GeneratedPage>>;
  failure?: { error: unknown };
}

/** Group only identical target sets, so every note has exactly these sources. */
function sharedExtractions(operations: PlannedOp[], batch: RawRecord[]): Map<SourceFragment, SharedExtraction> {
  // analyze() shares the same fragment objects between all matching operations.
  const targetsBySource = new Map<SourceFragment, SharedExtraction["targets"]>();
  for (const op of operations) {
    const target = { slug: canonicalSlug(op.type, op.name), op };
    for (const fragment of op.sourceFragments ?? []) {
      const targets = targetsBySource.get(fragment) ?? [];
      targets.push(target);
      targetsBySource.set(fragment, targets);
    }
  }
  const rawOrder = new Map(batch.map((raw, index) => [raw.id, index]));
  const fragments = [...targetsBySource.keys()].sort((a, b) => rawOrder.get(a.raw.id)! - rawOrder.get(b.raw.id)! || a.start - b.start);
  const shared = new Map<SourceFragment, SharedExtraction>();
  let current: SharedExtraction | undefined;
  let currentCharacters = 0;
  for (const fragment of fragments) {
    const targets = targetsBySource.get(fragment)!;
    if (targets.length < 2) {
      current = undefined;
      continue;
    }
    if (!current || currentCharacters + fragment.content.length > MAX_GENERATE_SOURCE_CHARACTERS
      || targets.length !== current.targets.length || targets.some((target, index) => target.slug !== current!.targets[index]!.slug)) {
      current = { sources: [], targets };
      currentCharacters = 0;
    }
    current.sources.push(fragment);
    currentCharacters += fragment.content.length;
    shared.set(fragment, current);
  }
  return shared;
}

function generationSteps(fragments: SourceFragment[], shared: Map<SourceFragment, SharedExtraction>): Array<{
  sources: SourceFragment[]; shared?: SharedExtraction;
}> {
  const steps: Array<{ sources: SourceFragment[]; shared?: SharedExtraction }> = [];
  const seen = new Set<SharedExtraction>();
  let privateSources: SourceFragment[] = [];
  const flush = () => {
    steps.push(...groupSourceFragments(privateSources).map(sources => ({ sources })));
    privateSources = [];
  };
  for (const fragment of fragments) {
    const extraction = shared.get(fragment);
    if (!extraction) privateSources.push(fragment);
    else {
      flush();
      if (!seen.has(extraction)) steps.push({ sources: extraction.sources, shared: extraction });
      seen.add(extraction);
    }
  }
  flush();
  return steps;
}

type ExtractionStep = ReturnType<typeof generationSteps>[number];
interface ExtractionPlan { steps: ExtractionStep[]; cache?: DreamExtractionCache }

/** A cache failure may cost another extraction, but must not lose usable evidence. */
function tryExtractionCache<T>(action: () => T): T | undefined {
  try { return action(); }
  catch { log.warn("Dream extraction checkpoint unavailable; continuing from Raw"); return undefined; }
}

function sameFragments(a: SourceFragment[], b: SourceFragment[]): boolean {
  return a.length === b.length && a.every((source, index) => source === b[index]);
}

/** Keep each page's original group boundaries, even when retrying a shared result alone. */
class ExtractionSession {
  private readonly plans = new Map<PlannedOp, ExtractionPlan>();
  constructor(
    readonly client: LlmClient,
    private readonly store: SpaceStore,
    readonly model: string | undefined,
    private readonly sources: RawRecord[],
    private readonly shared = new Map<SourceFragment, SharedExtraction>(),
    private readonly reuse = true,
    readonly reusedExtraction: () => void = () => {},
  ) {}

  forOperation(op: PlannedOp): ExtractionPlan {
    const prior = this.plans.get(op);
    if (prior) return prior;
    const fragments = op.sourceFragments ?? splitSourceFragments(this.sources.filter(raw => op.rawIds.includes(raw.id)));
    const original = generationSteps(fragments, this.shared);
    const create = original.length > 1 || original.some(step => step.shared);
    const cache = tryExtractionCache(() => {
      const identity = this.client.cacheIdentity;
      if (!identity) return undefined;
      const slug = canonicalSlug(op.type, op.name);
      // Hash the actual extraction rules, target, provider configuration and every
      // frozen source range. No Raw text or provider configuration enters filenames.
      const key = extractionDigest({ version: 1, space: this.store.space, identity, model: this.model,
        purpose: this.store.purpose(), schema: EXTRACT_SCHEMA, systems: [EXTRACT_SYSTEM, SHARED_EXTRACT_SYSTEM],
        maxTokens: AI_GENERATION_MAX_TOKENS, groupCharacters: MAX_GENERATE_SOURCE_CHARACTERS,
        sharedRules: generatePrompt(this.store, op, slug, null, [], undefined, true, [{ slug, op }]),
        fragments: fragments.map(fragment => [fragment.start, fragment.end, evidenceSources([fragment]),
          extractionDigest(generatePrompt(this.store, op, slug, null, [fragment], undefined, true))]),
      });
      return DreamExtractionCache.open(this.store, { key, rawIds: [...new Set(fragments.map(fragment => fragment.raw.id))],
        groups: original.map(step => step.sources.length), create, reuse: this.reuse });
    });
    let steps = original;
    if (cache) {
      let offset = 0;
      steps = cache.groups.map(size => {
        const sources = fragments.slice(offset, offset += size);
        const shared = this.shared.get(sources[0]!);
        return { sources, ...(shared && sameFragments(shared.sources, sources) ? { shared } : {}) };
      });
      // A malformed grouping cannot bypass the normal input budget.
      if (steps.some(step => step.sources.reduce((size, source) => size + source.content.length, 0) > MAX_GENERATE_SOURCE_CHARACTERS)) {
        tryExtractionCache(() => cache.complete());
        const result = { steps: original };
        this.plans.set(op, result);
        return result;
      }
    }
    const result = { steps, ...(cache ? { cache } : {}) };
    this.plans.set(op, result);
    return result;
  }

  load(op: PlannedOp, index: number): GeneratedPage | undefined {
    return tryExtractionCache(() => this.forOperation(op).cache?.get(index));
  }
  save(op: PlannedOp, index: number, note: GeneratedPage): void {
    tryExtractionCache(() => this.forOperation(op).cache?.put(index, note));
  }
  complete(op: PlannedOp): void {
    tryExtractionCache(() => this.plans.get(op)?.cache?.complete());
  }
}

async function extractShared(
  client: LlmClient, store: SpaceStore, extraction: SharedExtraction, model: string | undefined,
  session: ExtractionSession,
): Promise<Map<string, GeneratedPage>> {
  // Retain failures too: a sibling page must not repeat the same failed call.
  extraction.result ??= (async () => {
    const notes = new Map<string, GeneratedPage>();
    const pending = extraction.targets.flatMap(target => {
      const index = session.forOperation(target.op).steps.findIndex(step => sameFragments(step.sources, extraction.sources));
      if (index < 0) return [];
      const cached = session.load(target.op, index);
      if (cached) { notes.set(target.slug, cached); return []; }
      return [{ ...target, index }];
    });
    if (!pending.length) return notes;
    const slugs = pending.map(target => target.slug);
    const first = pending[0]!;
    const { value } = await client.completeJSON<Map<string, GeneratedPage>>({
      model, purpose: "distill", space: store.space, maxTokens: AI_GENERATION_MAX_TOKENS,
      system: SHARED_EXTRACT_SYSTEM,
      prompt: generatePrompt(store, first.op, first.slug, null, extraction.sources, undefined, true, pending),
      schema: {
        type: "object",
        properties: { pages: { type: "array", minItems: slugs.length, maxItems: slugs.length,
          items: { ...EXTRACT_SCHEMA, properties: { ...EXTRACT_SCHEMA.properties, slug: { type: "string", enum: slugs } },
            required: [...EXTRACT_SCHEMA.required, "slug"] } } },
        required: ["pages"],
      },
      validate(raw) {
        if (!raw || typeof raw !== "object" || !("pages" in raw) || !Array.isArray(raw.pages)
          || raw.pages.length !== slugs.length) throw new Error("shared extraction missing planned pages");
        const notes = new Map<string, GeneratedPage>();
        for (const page of raw.pages) {
          if (!page || typeof page !== "object" || typeof page.slug !== "string"
            || !slugs.includes(page.slug) || notes.has(page.slug)) throw new Error("shared extraction has invalid page identity");
          notes.set(page.slug, validateEvidence(page));
        }
        return notes;
      },
    });
    for (const target of pending) {
      const note = value.get(target.slug)!;
      session.save(target.op, target.index, note);
      notes.set(target.slug, note);
    }
    return notes;
  })();
  try { return await extraction.result; }
  catch (error) {
    extraction.failure = { error };
    throw error;
  }
}

/** Reduce only navigation text. The evidence bodies are retained unchanged. */
async function evidenceForMerge(
  client: LlmClient, notes: GeneratedPage[], groups: SourceFragment[][], model: string | undefined, store: SpaceStore,
  signal?: AbortSignal,
): Promise<string> {
  const full = notes.map((note, index) => `### 分段 ${index + 1}\n来源：${evidenceSources(groups[index]!)}\n${note.content}`).join("\n\n");
  if (full.length <= MAX_GENERATE_SOURCE_CHARACTERS) return full;
  let overview = notes.map((note, index) => `分段 ${index + 1}（来源：${evidenceSources(groups[index]!)}）：${note.summary || note.title}`).join("\n");
  while (overview.length > MAX_GENERATE_SOURCE_CHARACTERS) {
    const reduced: string[] = [];
    // Reuse the same Unicode-safe partitioning and source budget as Raw input.
    for (const fragment of splitText(overview)) {
      if (signal?.aborted) throw signal.reason ?? new Error("distillation cancelled");
      const { value } = await client.completeJSON<{ summary: string }>({
        model, purpose: "distill", space: store.space, maxTokens: AI_GENERATION_MAX_TOKENS,
        system: "你严格按 schema 输出结构化结果。",
        prompt: `## 分段提炼导读压缩\n将下列小节导读归纳为主题导航，保留纠错和版本变化提示。原始知识片段会完整附加，不需要重写正文。\n${fragment.content}`,
        schema: OVERVIEW_SCHEMA,
        validate(raw) {
          if (!raw || typeof raw !== "object" || !("summary" in raw)
            || typeof raw.summary !== "string" || !raw.summary.trim()
            || raw.summary.length > MAX_EVIDENCE_SUMMARY_CHARACTERS) throw new Error("invalid evidence overview");
          return { summary: raw.summary };
        },
      });
      reduced.push(value.summary);
    }
    overview = reduced.join("\n");
  }
  return overview;
}

/** sha256 of the material a page is built from — the incremental-cache key. */
function sourceHash(sources: RawRecord[], existing: Page | null, fragments?: SourceFragment[]): string {
  const h = new Bun.CryptoHasher("sha256");
  if (fragments) {
    h.update("source-fragments:v1\u0000");
    for (const fragment of fragments) {
      h.update(JSON.stringify([fragment.raw.id, fragment.start, fragment.end]) + "\u0000" + fragment.content + "\u0000");
    }
  } else {
    for (const r of [...sources].sort((a, b) => a.id.localeCompare(b.id))) {
      h.update(r.id + "\u0000" + r.content + "\u0000");
    }
  }
  // Fold in the prior page identity so an update off a changed base re-runs.
  if (existing) h.update("base:" + existing.slug);
  return h.digest("hex");
}

/** Whether Step 2 can be skipped because the source set is unchanged. */
export function isCacheHit(existing: Page | null, hash: string, force: boolean): boolean {
  if (force || !existing) return false;
  return existing.contentHash === hash;
}

async function generate(
  client: LlmClient,
  store: SpaceStore,
  op: PlannedOp,
  slug: string,
  existing: Page | null,
  sources: RawRecord[],
  model: string | undefined,
  onProgress?: (progress: DreamProgress) => void,
  pageIndex = 1,
  signal?: AbortSignal,
  session = new ExtractionSession(client, store, model, sources),
): Promise<GeneratedPage> {
  const partialUpdate = existing !== null && existing.content.length > PAGE_UPDATE_CHARACTERS && op.sourceFragments !== undefined;
  const completePage = async (group: SourceFragment[], evidence?: string): Promise<GeneratedPage> => {
    if (partialUpdate && existing) return updateLargePage({
      page: existing, client, model, space: store.space, signal,
      prompt: generatePrompt(store, op, slug, null, group, evidence, false, undefined, true)
        + `\n\n来源 metadata：${evidenceSources(group)}`,
      query: evidence ?? group.map(fragment => fragment.content).join("\n"),
      reviewAll: group.some(fragment => fragment.raw.source === "manual"),
      versions: group.filter(fragment => isChatSourceSnapshot(fragment.raw)).map(fragment => fragment.raw),
      validate: validateGenerate,
    });
    const { value } = await client.completeJSON<GeneratedPage>({ model,
      system: "你严格按 schema 输出结构化结果，content 为完整 markdown 正文。",
      prompt: generatePrompt(store, op, slug, existing, group, evidence),
      schema: GENERATE_SCHEMA, validate: validateGenerate, maxTokens: AI_GENERATION_MAX_TOKENS, purpose: "distill", space: store.space });
    return value;
  };
  const { steps, cache } = session.forOperation(op);
  const groups = steps.map(step => step.sources);
  const extractOnly = !!cache || steps.length > 1 || steps.some(step => step.shared);
  // A previous page may already have observed a shared failure. Do not start
  // more work for a page whose required evidence is known to be unavailable.
  const failedShared = steps.find((step, index) => step.shared?.failure && !session.load(op, index))?.shared?.failure;
  if (failedShared) throw failedShared.error;
  const notes: GeneratedPage[] = [];
  let reused = 0;
  const extractStep = async (index: number): Promise<GeneratedPage> => {
    const step = steps[index]!;
    const group = step.sources;
    const cached = session.load(op, index);
    if (cached) { reused++; session.reusedExtraction(); return cached; }
    if (step.shared) {
      const extracted = await extractShared(session.client, store, step.shared, session.model, session);
      return extracted.get(slug)!;
    }
    if (!extractOnly) return completePage(group);
    const { value } = await session.client.completeJSON<GeneratedPage>({
      model: session.model,
      system: EXTRACT_SYSTEM,
      prompt: generatePrompt(store, op, slug, null, group, undefined, true),
      schema: EXTRACT_SCHEMA,
      validate: validateEvidence,
      maxTokens: AI_GENERATION_MAX_TOKENS,
      purpose: "distill",
      space: store.space,
    });
    session.save(op, index, value);
    return value;
  };
  const throwIfAborted = () => {
    if (signal?.aborted) throw signal.reason ?? new Error("distillation cancelled");
  };
  let next = 0;
  let completed = 0;
  let failed = false;
  let failure: unknown;
  const active = new Set<number>();
  const progress = () => {
    const first = active.values().next().value;
    const currentSources = first === undefined ? sources
      : [...new Set([...active].flatMap(index => steps[index]!.sources.map(fragment => fragment.raw)))];
    onProgress?.({
      stage: extractOnly ? "extracting" : "generating", page: { slug, title: op.title.slice(0, 255), index: pageIndex },
      ...(first === undefined ? {} : { chunk: { index: first + 1, total: steps.length } }),
      ...(extractOnly ? { extraction: { active: active.size, completed, total: steps.length, reused } } : {}),
      sources: dreamSourceRefs(currentSources), sourceCount: currentSources.length,
    });
  };
  const worker = async () => {
    try {
      while (!failed && next < steps.length) {
        throwIfAborted();
        const index = next++;
        active.add(index);
        try {
          progress();
          throwIfAborted();
          const note = await extractStep(index);
          throwIfAborted();
          // Completion order must never change evidence order or provenance.
          notes[index] = note;
          completed++;
        } finally {
          active.delete(index);
          progress();
        }
      }
    } catch (error) {
      if (!failed) { failed = true; failure = error; }
    }
  };
  // Drain started calls before merge, quarantine, cancellation or releasing the
  // Space serializer. Successful shared results remain reusable by sibling pages.
  await Promise.all(Array.from({ length: Math.min(extractOnly ? AI_DREAM_EXTRACTION_CONCURRENCY : 1, steps.length) }, worker));
  throwIfAborted();
  if (failed) throw failure;
  let final = notes[0];
  if (!final) throw new Error("knowledge page generation has no source content");
  if (extractOnly) {
    onProgress?.({ stage: "generating", page: { slug, title: op.title.slice(0, 255), index: pageIndex },
      sources: dreamSourceRefs(sources), sourceCount: sources.length });
    let evidence = await evidenceForMerge(client, notes, groups, model, store, signal);
    const aliases = normalizeSearchMetadata(notes.flatMap(note => note.aliases ?? []));
    const tags = normalizeSearchMetadata(notes.flatMap(note => note.tags ?? []));
    evidence += `\n\n分段中有来源支持的检索元数据候选（仍需按当前事实校正）：\naliases: ${JSON.stringify(aliases)}\ntags: ${JSON.stringify(tags)}`;
    if (signal?.aborted) throw signal.reason ?? new Error("distillation cancelled");
    final = await completePage(groups.flat(), evidence);
    final = { ...final,
      // Do not recursively summarize away facts to satisfy a final prompt budget.
      // These are source evidence, rather than a second set of current conclusions.
      content: `${final.content.trimEnd()}\n\n## 来源分段详情\n\n> 以下保留全部分段提炼证据，可能包含历史版本；当前结论及纠错以上方主文为准。\n\n${notes.map((note, index) => {
        const refs = groups[index]!.map(fragment => `${fragment.raw.id}（${fragment.part}/${fragment.totalParts}）`).join("、");
        return `### 来源分段 ${index + 1}\n\n来源 Raw：${refs}\n\n来源元数据：${evidenceSources(groups[index]!)}\n\n${note.content}`;
      }).join("\n\n")}`,
      links: [...new Set([...final.links, ...notes.flatMap(note => note.links)])],
    };
  }
  if (partialUpdate && pageBaseHash(store.index().getPage(slug)) !== pageBaseHash(existing)) throw new Error("knowledge page changed during local update");
  return { ...final,
    aliases: resolveSearchMetadata(existing?.aliases, final.aliases),
    tags: resolveSearchMetadata(existing?.tags, final.tags),
  };
}

function pageBaseHash(page: Page | null): string | null {
  if (!page) return null;
  const h = new Bun.CryptoHasher("sha256");
  h.update(JSON.stringify({
    slug: page.slug,
    type: page.type,
    title: page.title,
    summary: page.summary,
    aliases: page.aliases,
    tags: page.tags,
    sources: page.sources,
    links: page.links,
    content: page.content,
    contentHash: page.contentHash,
  }));
  return h.digest("hex");
}

function legacyQuarantineOperation(
  record: QuarantineRecord,
  existing: Page | null,
): QuarantinedDreamOperation {
  const [folder, name, ...extra] = record.slug.split("/");
  const type = folder === "entities"
    ? "entity"
    : folder === "concepts"
      ? "concept"
      : folder === "sources"
        ? "source"
        : folder === "analysis"
          ? "analysis"
          : undefined;
  if (!type || !name || extra.length > 0 || canonicalSlug(type, name) !== record.slug) {
    throw new Error("legacy quarantine record has no safe fixed Knowledge page target");
  }
  return {
    type,
    name,
    title: existing?.title || name,
    rawIds: [...record.rawIds],
    basePageHash: pageBaseHash(existing),
  };
}

// ---- quarantine ------------------------------------------------------------

function quarantine(
  store: SpaceStore,
  slug: string,
  err: unknown,
  sources: RawRecord[],
  op: PlannedOp,
  existing: Page | null,
): void {
  const operation: QuarantinedDreamOperation = {
    type: op.type,
    name: op.name,
    title: op.title,
    rawIds: sources.map((source) => source.id),
    basePageHash: pageBaseHash(existing),
    ...(op.sourceFragments ? { sourceFragments: op.sourceFragments.map(fragment => ({
      rawId: fragment.raw.id, start: fragment.start, end: fragment.end,
      part: fragment.part, totalParts: fragment.totalParts,
      contentHash: new Bun.CryptoHasher("sha256").update(fragment.content).digest("hex"),
    })) } : {}),
  };
  writeQuarantineRecord(store, {
    slug,
    error: String(err),
    rawIds: operation.rawIds,
    createdAt: Date.now(),
    operation,
  });
  log.warn("quarantined bad page", { space: store.space, slug, err: String(err) });
}

export async function regeneratePageFromSources(
  store: SpaceStore,
  slug: string,
  extraRawIds: string[] = [],
  opts: { model?: string; models?: DreamModels; allowMissingExistingSources?: boolean } = {},
  deps: DreamDeps = {},
): Promise<Page> {
  const existing = store.index().getPage(slug);
  if (!existing) throw new Error(`unknown knowledge page: ${slug}`);
  if (!["entity", "concept", "source", "analysis"].includes(existing.type)) {
    throw new Error(`knowledge page cannot be regenerated manually: ${slug}`);
  }
  const rawIds = [...new Set([...existing.sources, ...extraRawIds])];
  if (rawIds.length === 0) throw new Error("知识页没有可用于重新生成的原始来源");
  const sources = store.index().listRawByIds(rawIds, { onlyPending: false });
  const nonAdmitted = sources.find((source) => source.admission !== "ready");
  if (nonAdmitted) {
    throw new Error(nonAdmitted.admission === "held"
      ? "知识页原始来源尚未通过动作验收，不能用于重新生成"
      : "知识页原始来源已被动作验收排除，不能用于重新生成");
  }
  const availableRawIds = new Set(sources.map((source) => source.id));
  if (extraRawIds.some((rawId) => !availableRawIds.has(rawId))) {
    throw new Error("新增的人工来源不存在，无法安全重新生成");
  }
  if (
    !opts.allowMissingExistingSources
    && existing.sources.some((rawId) => !availableRawIds.has(rawId))
  ) {
    throw new Error("知识页的部分原始来源已不存在，无法安全重新生成");
  }
  if (sources.length === 0) throw new Error("知识页没有仍可读取的原始来源");
  const op: PlannedOp = {
    type: existing.type as PlannedOp["type"],
    name: slug.split("/").at(-1) ?? slug,
    title: existing.title,
    rawIds,
  };
  const execution = new DreamExecution(deps.client ?? gatewayClient, opts, deps.onProgress);
  const { client, model } = execution.phase("merge");
  const extracting = execution.phase("extraction");
  const session = new ExtractionSession(extracting.client, store, extracting.model, sources, undefined, false, () => execution.reusedExtraction());
  try {
    execution.progress({ stage: "preparing", rawCount: sources.length, pagesTotal: 1, sources: dreamSourceRefs(sources), sourceCount: sources.length });
    const generated = await generate(client, store, op, slug, existing, sources, model, execution.progress, 1, undefined, session);
    const page: Page = {
      slug,
      type: op.type,
      title: generated.title,
      summary: generated.summary,
      aliases: resolveSearchMetadata(existing.aliases, generated.aliases),
      tags: resolveSearchMetadata(existing.tags, generated.tags),
      sources: rawIds,
      links: generated.links,
      content: `${generated.content.trimEnd()}\n`,
      updatedAt: Date.now(),
      contentHash: sourceHash(sources, existing),
    };
    store.writePage(page);
    try {
      refreshDigest(store);
    } catch (error) {
      store.writePage(existing);
      refreshDigest(store);
      throw error;
    }
    store.index().markIngested([...availableRawIds]);
    removeQuarantineRecordsCoveredBy(store, slug, availableRawIds);
    session.complete(op);
    execution.progress({ stage: "indexing", pagesCompleted: 1, pagesWritten: 1, processedRaw: sources.length });
    return page;
  } catch (error) {
    removeQuarantineRecordsCoveredBy(store, slug, availableRawIds);
    quarantine(store, slug, error, sources, op, existing);
    store.index().markIngested([...availableRawIds]);
    throw error;
  } finally {
    execution.flush();
  }
}

/** Retry exactly the generate operation captured by a quarantine record. */
export async function retryQuarantinedDreamOperation(
  store: SpaceStore,
  record: QuarantineRecord,
  opts: { model?: string; models?: DreamModels } = {},
  deps: DreamDeps = {},
): Promise<DreamReport> {
  const startedAt = Date.now();
  const report: DreamReport = {
    space: store.space,
    examined: record.rawIds.length,
    processedRawIds: [],
    distilled: 0,
    skipped: 0,
    pagesWritten: 0,
    pagesQuarantined: 0,
    startedAt,
    finishedAt: startedAt,
    errors: [],
  };
  const existing = store.index().getPage(record.slug);
  const operation = record.operation ?? legacyQuarantineOperation(record, existing);
  if (canonicalSlug(operation.type, operation.name) !== record.slug) {
    throw new Error("quarantine operation does not match its Knowledge page slug");
  }
  if (
    operation.rawIds.length !== record.rawIds.length
    || operation.rawIds.some((rawId, index) => rawId !== record.rawIds[index])
  ) {
    throw new Error("quarantine operation does not match its Raw sources");
  }
  const sources = store.index().listRawByIds(operation.rawIds, {
    onlyPending: false,
    onlyAdmitted: true,
  });
  if (sources.length !== operation.rawIds.length) {
    throw new Error("quarantine operation Raw sources are unavailable");
  }
  if (pageBaseHash(existing) !== operation.basePageHash) {
    throw new Error("quarantine operation Knowledge page base has changed");
  }
  const op: PlannedOp = {
    type: operation.type,
    name: operation.name,
    title: operation.title,
    rawIds: [...operation.rawIds],
    ...(operation.sourceFragments ? { sourceFragments: operation.sourceFragments.map(fragment => {
      const raw = sources.find(source => source.id === fragment.rawId);
      if (!raw || fragment.end > raw.content.length) throw new Error("quarantine source fragment is unavailable");
      const content = raw.content.slice(fragment.start, fragment.end);
      if (new Bun.CryptoHasher("sha256").update(content).digest("hex") !== fragment.contentHash) {
        throw new Error("quarantine source fragment has changed");
      }
      return { ...fragment, raw, content };
    }) } : {}),
  };
  const execution = new DreamExecution(deps.client ?? gatewayClient, opts, deps.onProgress);
  const { client, model } = execution.phase("merge");
  const extracting = execution.phase("extraction");
  const session = new ExtractionSession(extracting.client, store, extracting.model, sources, undefined, true, () => execution.reusedExtraction());
  try {
    execution.progress({ stage: "preparing", rawCount: sources.length, pagesTotal: 1,
      sources: dreamSourceRefs(sources), sourceCount: sources.length });
    const generated = await generate(
      client,
      store,
      op,
      record.slug,
      existing,
      sources,
      model,
      execution.progress,
      1,
      undefined,
      session,
    );
    const page: Page = {
      slug: record.slug,
      type: operation.type,
      title: generated.title,
      summary: generated.summary,
      aliases: resolveSearchMetadata(existing?.aliases, generated.aliases),
      tags: resolveSearchMetadata(existing?.tags, generated.tags),
      sources: [...new Set([...(existing?.sources ?? []), ...operation.rawIds])],
      links: generated.links,
      content: `${generated.content.trimEnd()}\n`,
      updatedAt: Date.now(),
      contentHash: sourceHash(sources, existing, op.sourceFragments),
    };
    execution.progress({ stage: "saving", page: { slug: record.slug, title: operation.title.slice(0, 255), index: 1 } });
    store.writePage(page);
    try {
      execution.progress({ stage: "indexing" });
      refreshDigest(store);
    } catch (error) {
      if (existing) store.writePage(existing);
      else store.deletePage(record.slug);
      refreshDigest(store);
      throw error;
    }
    store.index().markIngested(operation.rawIds);
    session.complete(op);
    report.processedRawIds = [...operation.rawIds];
    report.distilled = operation.rawIds.length;
    report.pagesWritten = 1;
    execution.progress({ stage: "indexing", pagesCompleted: 1, pagesWritten: 1, processedRaw: sources.length });
  } catch (error) {
    quarantine(store, record.slug, error, sources, op, existing);
    store.index().markIngested(operation.rawIds);
    report.processedRawIds = [...operation.rawIds];
    report.pagesQuarantined = 1;
    report.errors.push(`generate ${record.slug} failed: ${String(error)}`);
  } finally {
    report.metrics = execution.snapshot();
    execution.flush();
  }
  report.finishedAt = Date.now();
  try {
    appendLog(store, report);
  } catch (error) {
    report.errors.push(`log failed: ${String(error)}`);
  }
  return report;
}

function appendLog(store: SpaceStore, report: DreamReport): void {
  const line = `- ${new Date(report.finishedAt).toISOString()}: examined=${report.examined} distilled=${report.distilled} skipped=${report.skipped} written=${report.pagesWritten} quarantined=${report.pagesQuarantined}`
    + (report.metrics ? dreamMetricsLog(report.metrics) : "");
  const existing = store.index().getPage("log");
  const header = "# Log\n\n提炼历史记录（自动生成）。\n\n";
  const body = (existing ? existing.content.replace(/^# Log[\s\S]*?\n\n[\s\S]*?\n\n/, "") : "") + line + "\n";
  const content = header + body.split("\n").slice(-200).join("\n");
  store.writePage({
    slug: "log",
    type: "log",
    title: "Log",
    summary: "提炼历史",
    aliases: [],
    tags: [],
    sources: [],
    links: [],
    content,
    updatedAt: report.finishedAt,
    contentHash: "",
  });
}

// ---- orchestration ---------------------------------------------------------

export interface DreamDeps {
  client?: LlmClient;
  onProgress?: (progress: DreamProgress) => void;
}

export async function runDreamCycle(
  store: SpaceStore,
  opts: DreamOptions = {},
  deps: DreamDeps = {},
): Promise<DreamReport> {
  const execution = new DreamExecution(deps.client ?? gatewayClient, opts, deps.onProgress);
  try {
    const report = await executeDreamCycle(store, opts, execution);
    report.metrics = execution.snapshot();
    return report;
  } finally { execution.flush(); }
}

async function executeDreamCycle(store: SpaceStore, opts: DreamOptions, execution: DreamExecution): Promise<DreamReport> {
  const { client, model } = execution.phase("merge");
  const planning = execution.phase("planning");
  const extracting = execution.phase("extraction");
  const force = opts.force ?? false;
  const startedAt = Date.now();
  const errors: string[] = [];
  const throwIfAborted = () => {
    if (!opts.signal?.aborted) return;
    throw opts.signal.reason instanceof Error
      ? opts.signal.reason
      : new Error(opts.signal.reason ? String(opts.signal.reason) : "distillation cancelled");
  };

  const idx = store.index();
  const batch =
    opts.rawIds === undefined
      ? idx.listRaw({
          onlyPending: !force,
          onlyAdmitted: true,
          limit: opts.maxEntries ?? DEFAULT_MAX_ENTRIES,
        })
      : idx.listRawByIds(opts.rawIds, {
          onlyPending: !force,
          // `force` may replay an already-ingested Raw, but it must never
          // bypass the independent WorkAction knowledge-admission decision.
          onlyAdmitted: true,
          limit: opts.maxEntries,
        });

  const report: DreamReport = {
    space: store.space,
    examined: batch.length,
    processedRawIds: [],
    distilled: 0,
    skipped: 0,
    pagesWritten: 0,
    pagesQuarantined: 0,
    startedAt,
    finishedAt: startedAt,
    errors,
  };

  if (batch.length === 0) {
    report.finishedAt = Date.now();
    return report;
  }

  const rawById = new Map(batch.map((r) => [r.id, r]));

  let plan: AnalyzeResult;
  try {
    throwIfAborted();
    execution.progress({ stage: "analyzing", rawCount: batch.length,
      sources: dreamSourceRefs(batch), sourceCount: batch.length });
    plan = await analyze(planning.client, store, batch, planning.model, execution.progress, opts.signal);
    throwIfAborted();
  } catch (err) {
    throwIfAborted();
    errors.push(`analyze failed: ${String(err)}`);
    report.finishedAt = Date.now();
    return report;
  }

  const ingestedIds = new Set<string>(plan.skippedRawIds.filter((id) => rawById.has(id)));
  report.skipped = ingestedIds.size;
  execution.progress({ stage: "preparing", pagesTotal: plan.operations.length,
    pagesCompleted: 0, skippedRaw: report.skipped });

  const prepared = plan.operations.map(op => {
    const slug = canonicalSlug(op.type, op.name);
    const sources = op.rawIds.map(id => rawById.get(id)).filter((raw): raw is RawRecord => !!raw);
    const existing = idx.getPage(slug);
    const hash = sourceHash(sources, existing, op.sourceFragments);
    return { op, slug, sources, existing, hash, cached: isCacheHit(existing, hash, force) };
  });
  const shared = sharedExtractions(prepared.filter(page => page.sources.length > 0 && !page.cached).map(page => page.op), batch);
  const session = new ExtractionSession(extracting.client, store, extracting.model, batch, shared, !force, () => execution.reusedExtraction());
  const completedOperations: PlannedOp[] = [];

  for (const [operationIndex, { op, slug, sources, existing, hash, cached }] of prepared.entries()) {
    throwIfAborted();
    if (sources.length === 0) {
      execution.progress({ stage: "preparing", pagesCompleted: operationIndex + 1 });
      continue;
    }
    if (cached) {
      // Unchanged source set — keep the page, mark its raw ingested.
      for (const s of sources) ingestedIds.add(s.id);
      report.distilled += sources.length;
      session.forOperation(op);
      completedOperations.push(op);
      execution.progress({ stage: "preparing", pagesCompleted: operationIndex + 1 });
      continue;
    }

    try {
      const gen = await generate(client, store, op, slug, existing, sources, model, execution.progress, operationIndex + 1, opts.signal, session);
      throwIfAborted();
      const mergedSources = [...new Set([...(existing?.sources ?? []), ...sources.map((s) => s.id)])];
      const page: Page = {
        slug,
        type: op.type,
        title: gen.title,
        summary: gen.summary,
        aliases: resolveSearchMetadata(existing?.aliases, gen.aliases),
        tags: resolveSearchMetadata(existing?.tags, gen.tags),
        sources: mergedSources,
        links: gen.links,
        content: gen.content.trimEnd() + "\n",
        updatedAt: Date.now(),
        contentHash: hash,
      };
      execution.progress({ stage: "saving", page: { slug, title: op.title.slice(0, 255), index: operationIndex + 1 } });
      store.writePage(page);
      completedOperations.push(op);
      report.pagesWritten += 1;
      report.distilled += sources.length;
      for (const s of sources) ingestedIds.add(s.id);
    } catch (err) {
      throwIfAborted();
      report.pagesQuarantined += 1;
      quarantine(store, slug, err, sources, op, existing);
      // Mark contributing raw ingested so a permanently-bad entry does not
      // re-trigger the same failure (and cost) every cycle; it is preserved in
      // the quarantine record.
      for (const s of sources) ingestedIds.add(s.id);
      errors.push(`generate ${slug} failed: ${String(err)}`);
    }
    execution.progress({ stage: "preparing", pagesCompleted: operationIndex + 1,
      pagesWritten: report.pagesWritten, pagesFailed: report.pagesQuarantined });
  }

  throwIfAborted();
  execution.progress({ stage: "saving" });
  idx.markIngested([...ingestedIds]);
  for (const op of completedOperations) session.complete(op);
  report.processedRawIds = [...ingestedIds];

  // Refresh the deterministic map pages and append a log line.
  if (report.pagesWritten > 0) {
    try {
      execution.progress({ stage: "indexing", processedRaw: ingestedIds.size });
      refreshDigest(store);
    } catch (err) {
      errors.push(`digest failed: ${String(err)}`);
    }
  }
  report.finishedAt = Date.now();
  report.metrics = execution.snapshot();
  try {
    appendLog(store, report);
  } catch (err) {
    errors.push(`log failed: ${String(err)}`);
  }
  return report;
}
