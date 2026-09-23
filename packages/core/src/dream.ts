/**
 * Dream cycle: the nightly distillation that turns raw captures into wiki pages
 * (plan §2.3). Two-step chain-of-thought, mirroring llm_wiki's design (borrowed,
 * reimplemented — not copied):
 *
 *   Step 1 (analyze): given the space purpose/schema, the current page index,
 *     and a batch of pending raw entries, the LLM decides which entries are
 *     worth distilling and plans page operations (create/update). Pure noise is
 *     reported as skipped and never becomes a page (plan Q7).
 *   Step 2 (generate): for each planned page, the LLM writes the whole page
 *     (llm_wiki's whole-page paradigm — never fragments), given any existing
 *     page content to merge and the contributing raw entries.
 *
 * Robustness (plan R3): JSON mode via forced tool-use + schema validation +
 * retries + bad-page quarantine. Provenance: each page records the raw ids it
 * was distilled from. Incremental cache: a page is not regenerated when its
 * source set is unchanged (unless force).
 *
 * After distillation the deterministic topic maps plus index/glossary/overview
 * are refreshed and a log entry is appended.
 */
import type { DreamReport, Page, RawRecord } from "@homeagent/shared";
import { isChatSourceSnapshot } from "./chat-raw-import.ts";
import { dreamSourceRefs, type DreamProgress } from "./dream-progress.ts";
import {
  AI_GENERATION_MAX_TOKENS,
  AI_ROUTING_MAX_TOKENS,
  config,
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
import { isKnowledgeContentRef, refreshDigest } from "./digest.ts";
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

function planningExcerpt(content: string, maxCharacters: number): string {
  if (content.length <= maxCharacters) return content;
  const marker = "\n…[仅规划阶段截取；生成阶段会处理完整来源]…\n";
  const available = Math.max(0, maxCharacters - marker.length);
  const head = Math.ceil(available / 2);
  const tail = Math.floor(available / 2);
  return `${content.slice(0, head)}${marker}${content.slice(content.length - tail)}`;
}

function analyzePrompt(store: SpaceStore, batch: RawRecord[]): string {
  const index = store
    .index()
    .listPages()
    .filter(isKnowledgeContentRef)
    .map((r) => `- ${r.slug} (${r.type})：${r.title}｜${r.summary}`)
    .join("\n");
  const perEntryBudget = Math.max(
    64,
    Math.floor(MAX_ANALYZE_SOURCE_CHARACTERS / Math.max(1, batch.length)),
  );
  const entries = batch
    .map((r) => {
      const meta = [r.source, r.author ? `by ${r.author}` : ""].filter(Boolean).join(" ");
      return `<entry id="${r.id}" ${meta ? `meta="${meta}"` : ""}>\n${planningExcerpt(r.content, perEntryBudget)}\n</entry>`;
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
    "## 现有知识页（用于判断新建还是更新）",
    index || "（暂无）",
    "",
    "## 待提炼的原始条目",
    entries,
    "",
    "任务：判断哪些条目值得沉淀为知识页。",
    "- 纯寒暄、无信息量的噪声条目，放入 skippedRawIds，不要建页。",
    "- 值得沉淀的，规划成对页面的 create/update 操作；若与现有页相关请复用其 name/slug 以更新。",
    "- 每个操作的 rawIds 必须来自上面条目的真实 id。",
  ].join("\n");
}

async function analyze(
  client: LlmClient,
  store: SpaceStore,
  batch: RawRecord[],
  model: string | undefined,
): Promise<AnalyzeResult> {
  const { value } = await client.completeJSON<AnalyzeResult>({
    model,
    system: "你严格按 schema 输出结构化结果，不要输出多余文本。",
    prompt: analyzePrompt(store, batch),
    schema: ANALYZE_SCHEMA as unknown as Record<string, unknown>,
    validate: validateAnalyze,
    maxTokens: AI_ROUTING_MAX_TOKENS,
    purpose: "distill",
    space: store.space,
  });
  return value;
}

// ---- step 2: generate ------------------------------------------------------

interface GeneratedPage {
  title: string;
  summary: string;
  aliases?: string[];
  tags?: string[];
  links: string[];
  content: string;
}

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
}

function splitSourceFragments(sources: RawRecord[]): SourceFragment[] {
  return sources.flatMap((raw) => {
    const totalParts = Math.max(1, Math.ceil(raw.content.length / MAX_GENERATE_SOURCE_CHARACTERS));
    return Array.from({ length: totalParts }, (_, index) => ({
      raw,
      content: raw.content.slice(
        index * MAX_GENERATE_SOURCE_CHARACTERS,
        (index + 1) * MAX_GENERATE_SOURCE_CHARACTERS,
      ),
      part: index + 1,
      totalParts,
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
): string {
  const src = sources
    .map((fragment) => {
      const part = fragment.totalParts > 1
        ? ` part="${fragment.part}/${fragment.totalParts}"`
        : "";
      const type = isChatSourceSnapshot(fragment.raw) ? "chat-source-snapshot" : fragment.raw.source;
      return `<source id="${fragment.raw.id}" type="${type}"${part}>\n${fragment.content}\n</source>`;
    })
    .join("\n\n");
  const parts = [
    `请为知识页「${op.title}」(slug: ${slug}, 类型: ${op.type}) 生成完整内容。`,
    "",
    "## 空间页类型规则",
    store.schema().trim(),
    "",
  ];
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
    "## 相关原始来源",
    src,
    "",
    "要求：",
    "- content 为完整 markdown 正文（整页，不要分片）。",
    "- 用 [[slug]] 形式链接到相关页面（若知道其 slug）。",
    "- summary 用一句话概括。",
    "- aliases 只填写来源或既有页面明确支持的别名、简称与常见用户问法，用于检索本页。",
    "- tags 只填写来源或既有页面明确支持的主题、场景与职责。",
    "- aliases 与 tags 要输出更新后的完整集合；已不再受当前来源支持的旧项应删除，无内容时输出空数组。",
    "- 不要为了提高检索召回而臆造同义词、职责或场景。",
    "- 只根据来源与既有内容写，不要臆造。",
  );
  return parts.join("\n");
}

/** sha256 of the material a page is built from — the incremental-cache key. */
function sourceHash(sources: RawRecord[], existing: Page | null): string {
  const h = new Bun.CryptoHasher("sha256");
  for (const r of [...sources].sort((a, b) => a.id.localeCompare(b.id))) {
    h.update(r.id + "\u0000" + r.content + "\u0000");
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
): Promise<GeneratedPage> {
  const groups = groupSourceFragments(splitSourceFragments(sources));
  let current = existing;
  let final: GeneratedPage | undefined;
  for (const [index, group] of groups.entries()) {
    onProgress?.({
      stage: "generating", page: { slug, title: op.title.slice(0, 255), index: pageIndex },
      chunk: { index: index + 1, total: groups.length },
      sources: dreamSourceRefs(group.map((fragment) => fragment.raw)), sourceCount: group.length,
    });
    const { value } = await client.completeJSON<GeneratedPage>({
      model,
      system: "你严格按 schema 输出结构化结果，content 为完整 markdown 正文。",
      prompt: generatePrompt(store, op, slug, current, group),
      schema: GENERATE_SCHEMA as unknown as Record<string, unknown>,
      validate: validateGenerate,
      maxTokens: AI_GENERATION_MAX_TOKENS,
      purpose: "distill",
      space: store.space,
    });
    final = {
      ...value,
      aliases: resolveSearchMetadata(current?.aliases, value.aliases),
      tags: resolveSearchMetadata(current?.tags, value.tags),
    };
    current = {
      slug,
      type: op.type,
      title: final.title,
      summary: final.summary,
      aliases: final.aliases ?? [],
      tags: final.tags ?? [],
      sources: [...new Set([...(current?.sources ?? []), ...group.map((item) => item.raw.id)])],
      links: final.links,
      content: final.content,
      updatedAt: Date.now(),
      contentHash: "",
    };
  }
  if (!final) throw new Error("knowledge page generation has no source content");
  return final;
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
  opts: { model?: string; allowMissingExistingSources?: boolean } = {},
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
  const client = deps.client ?? gatewayClient;
  const model = opts.model ?? config().model;
  try {
    const generated = await generate(client, store, op, slug, existing, sources, model);
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
    return page;
  } catch (error) {
    removeQuarantineRecordsCoveredBy(store, slug, availableRawIds);
    quarantine(store, slug, error, sources, op, existing);
    store.index().markIngested([...availableRawIds]);
    throw error;
  }
}

/** Retry exactly the generate operation captured by a quarantine record. */
export async function retryQuarantinedDreamOperation(
  store: SpaceStore,
  record: QuarantineRecord,
  opts: { model?: string } = {},
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
  };
  const client = deps.client ?? gatewayClient;
  const model = opts.model ?? config().model;
  try {
    deps.onProgress?.({ stage: "preparing", rawCount: sources.length, pagesTotal: 1,
      sources: dreamSourceRefs(sources), sourceCount: sources.length });
    const generated = await generate(
      client,
      store,
      op,
      record.slug,
      existing,
      sources,
      model,
      deps.onProgress,
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
      contentHash: sourceHash(sources, existing),
    };
    deps.onProgress?.({ stage: "saving", page: { slug: record.slug, title: operation.title.slice(0, 255), index: 1 } });
    store.writePage(page);
    try {
      deps.onProgress?.({ stage: "indexing" });
      refreshDigest(store);
    } catch (error) {
      if (existing) store.writePage(existing);
      else store.deletePage(record.slug);
      refreshDigest(store);
      throw error;
    }
    store.index().markIngested(operation.rawIds);
    report.processedRawIds = [...operation.rawIds];
    report.distilled = operation.rawIds.length;
    report.pagesWritten = 1;
    deps.onProgress?.({ stage: "indexing", pagesCompleted: 1, pagesWritten: 1, processedRaw: sources.length });
  } catch (error) {
    quarantine(store, record.slug, error, sources, op, existing);
    store.index().markIngested(operation.rawIds);
    report.processedRawIds = [...operation.rawIds];
    report.pagesQuarantined = 1;
    report.errors.push(`generate ${record.slug} failed: ${String(error)}`);
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
  const line = `- ${new Date(report.finishedAt).toISOString()}: examined=${report.examined} distilled=${report.distilled} skipped=${report.skipped} written=${report.pagesWritten} quarantined=${report.pagesQuarantined}`;
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
  const client = deps.client ?? gatewayClient;
  const model = opts.model ?? config().model;
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
    deps.onProgress?.({ stage: "analyzing", rawCount: batch.length,
      sources: dreamSourceRefs(batch), sourceCount: batch.length });
    plan = await analyze(client, store, batch, model);
    throwIfAborted();
  } catch (err) {
    throwIfAborted();
    errors.push(`analyze failed: ${String(err)}`);
    report.finishedAt = Date.now();
    return report;
  }

  const ingestedIds = new Set<string>(plan.skippedRawIds.filter((id) => rawById.has(id)));
  report.skipped = ingestedIds.size;
  deps.onProgress?.({ stage: "preparing", pagesTotal: plan.operations.length,
    pagesCompleted: 0, skippedRaw: report.skipped });

  for (const [operationIndex, op] of plan.operations.entries()) {
    throwIfAborted();
    const slug = canonicalSlug(op.type, op.name);
    const sources = op.rawIds.map((id) => rawById.get(id)).filter((r): r is RawRecord => !!r);
    if (sources.length === 0) {
      deps.onProgress?.({ stage: "preparing", pagesCompleted: operationIndex + 1 });
      continue;
    }
    const existing = idx.getPage(slug);
    const hash = sourceHash(sources, existing);

    if (isCacheHit(existing, hash, force)) {
      // Unchanged source set — keep the page, mark its raw ingested.
      for (const s of sources) ingestedIds.add(s.id);
      report.distilled += sources.length;
      deps.onProgress?.({ stage: "preparing", pagesCompleted: operationIndex + 1 });
      continue;
    }

    try {
      const gen = await generate(client, store, op, slug, existing, sources, model, deps.onProgress, operationIndex + 1);
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
      deps.onProgress?.({ stage: "saving", page: { slug, title: op.title.slice(0, 255), index: operationIndex + 1 } });
      store.writePage(page);
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
    deps.onProgress?.({ stage: "preparing", pagesCompleted: operationIndex + 1,
      pagesWritten: report.pagesWritten, pagesFailed: report.pagesQuarantined });
  }

  throwIfAborted();
  deps.onProgress?.({ stage: "saving" });
  idx.markIngested([...ingestedIds]);
  report.processedRawIds = [...ingestedIds];

  // Refresh the deterministic map pages and append a log line.
  if (report.pagesWritten > 0) {
    try {
      deps.onProgress?.({ stage: "indexing", processedRaw: ingestedIds.size });
      refreshDigest(store);
    } catch (err) {
      errors.push(`digest failed: ${String(err)}`);
    }
  }
  report.finishedAt = Date.now();
  try {
    appendLog(store, report);
  } catch (err) {
    errors.push(`log failed: ${String(err)}`);
  }
  return report;
}
