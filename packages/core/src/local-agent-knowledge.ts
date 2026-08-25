import {
  isSpaceId,
  type KnowledgeEvidenceFreshness,
  type Page,
  type RawAdmission,
  type RawSource,
  type SpaceId,
} from "@homeagent/shared";
import { createHash } from "node:crypto";
import { isKnowledgeContentRef } from "./digest.ts";
import type { KnowledgeEngine } from "./engine.ts";

export type LocalAgentKnowledgeToolName =
  | "list_spaces"
  | "get_overview"
  | "list_maps"
  | "search_knowledge"
  | "get_page"
  | "get_page_trace";

export const LOCAL_AGENT_KNOWLEDGE_TOOL_NAMES = [
  "list_spaces",
  "get_overview",
  "list_maps",
  "search_knowledge",
  "get_page",
  "get_page_trace",
] as const satisfies readonly LocalAgentKnowledgeToolName[];

export function isLocalAgentKnowledgeToolName(value: unknown): value is LocalAgentKnowledgeToolName {
  return typeof value === "string"
    && (LOCAL_AGENT_KNOWLEDGE_TOOL_NAMES as readonly string[]).includes(value);
}

export interface LocalAgentSpaceSummary {
  space: SpaceId;
  kind: "personal" | "team";
  name?: string;
  pageCount: number;
}

export interface LocalAgentSpaceList {
  spaces: LocalAgentSpaceSummary[];
  totalSpaces: number;
  truncated: boolean;
}

export interface LocalAgentKnowledgePage {
  space: SpaceId;
  slug: string;
  revision: string;
  type: Page["type"];
  title: string;
  summary: string;
  aliases: string[];
  tags: string[];
  links: string[];
  content: string;
  contentTruncated: boolean;
  updatedAt: number;
}

export interface LocalAgentPageResult {
  page: LocalAgentKnowledgePage;
  evidence?: LocalAgentEvidenceSummary;
}

export interface LocalAgentEvidenceSummary {
  sourceCount: number;
  latestEvidenceAt?: number;
  freshness: KnowledgeEvidenceFreshness;
  complete: boolean;
}

export interface LocalAgentEvidenceSource {
  rawId: string;
  source: RawSource;
  admission: RawAdmission;
  createdAt: number;
  author?: string;
}

export interface LocalAgentPageTrace {
  space: SpaceId;
  slug: string;
  title: string;
  sourceCount: number;
  sources: LocalAgentEvidenceSource[];
  missingSourceIds: string[];
  latestEvidenceAt?: number;
  freshness: KnowledgeEvidenceFreshness;
  complete: boolean;
  truncated: boolean;
}

export interface LocalAgentPageTraceResult {
  trace: LocalAgentPageTrace;
}

export interface LocalAgentKnowledgeMap {
  space: SpaceId;
  slug: string;
  title: string;
  summary: string;
  tags: string[];
}

export interface LocalAgentMapList {
  maps: LocalAgentKnowledgeMap[];
  totalMaps: number;
  truncated: boolean;
}

export interface LocalAgentSearchHit {
  space: SpaceId;
  slug: string;
  title: string;
  type: Page["type"];
  snippet: string;
}

export interface LocalAgentSearchResult {
  hits: LocalAgentSearchHit[];
  truncated: boolean;
}

export type LocalAgentKnowledgeResult =
  | LocalAgentSpaceList
  | LocalAgentPageResult
  | LocalAgentMapList
  | LocalAgentSearchResult
  | LocalAgentPageTraceResult;

export type LocalAgentKnowledgeErrorCode = "invalid_input" | "not_found";

export class LocalAgentKnowledgeError extends Error {
  constructor(
    readonly code: LocalAgentKnowledgeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LocalAgentKnowledgeError";
  }
}

const DEFAULT_SPACE_LIMIT = 50;
const MAX_SPACE_LIMIT = 100;
const DEFAULT_MAP_LIMIT = 24;
const MAX_MAP_LIMIT = 100;
const DEFAULT_SEARCH_LIMIT = 8;
const MAX_SEARCH_LIMIT = 20;
const SEARCH_SCAN_LIMIT = 100;
const MAX_OUTPUT_PAGE_CONTENT_CHARACTERS = 200_000;
const MAX_OUTPUT_TITLE_CHARACTERS = 500;
const MAX_OUTPUT_SUMMARY_CHARACTERS = 2_000;
const MAX_OUTPUT_SLUG_CHARACTERS = 300;
const MAX_OUTPUT_NAME_CHARACTERS = 200;
const MAX_OUTPUT_ALIAS_CHARACTERS = 200;
const MAX_OUTPUT_TAG_CHARACTERS = 100;
const MAX_OUTPUT_LINK_CHARACTERS = 300;
const MAX_OUTPUT_SNIPPET_CHARACTERS = 2_000;
const MAX_OUTPUT_RAW_ID_CHARACTERS = 300;
const MAX_OUTPUT_AUTHOR_CHARACTERS = 500;
const MAX_OUTPUT_ALIASES = 100;
const MAX_OUTPUT_TAGS = 100;
const MAX_OUTPUT_LINKS = 200;

function boundedLimit(value: unknown, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > maximum) {
    throw new LocalAgentKnowledgeError(
      "invalid_input",
      `limit must be an integer between 1 and ${maximum}`,
    );
  }
  return value;
}

function outputString(value: string, maximum: number): string {
  return value.length <= maximum ? value : value.slice(0, maximum);
}

function outputStrings(values: string[], itemLimit: number, characterLimit: number): string[] {
  return values.slice(0, itemLimit).map((value) => outputString(value, characterLimit));
}

export function knowledgePageRevision(page: Page): string {
  return createHash("sha256").update(JSON.stringify([
    page.slug,
    page.type,
    page.title,
    page.summary,
    page.aliases,
    page.tags,
    page.sources,
    page.links,
    page.content,
    page.updatedAt,
    page.contentHash,
  ])).digest("hex");
}

function safePage(space: SpaceId, page: Page): LocalAgentKnowledgePage {
  return {
    space,
    slug: outputString(page.slug, MAX_OUTPUT_SLUG_CHARACTERS),
    revision: knowledgePageRevision(page),
    type: page.type,
    title: outputString(page.title, MAX_OUTPUT_TITLE_CHARACTERS),
    summary: outputString(page.summary, MAX_OUTPUT_SUMMARY_CHARACTERS),
    aliases: outputStrings(
      page.aliases,
      MAX_OUTPUT_ALIASES,
      MAX_OUTPUT_ALIAS_CHARACTERS,
    ),
    tags: outputStrings(page.tags, MAX_OUTPUT_TAGS, MAX_OUTPUT_TAG_CHARACTERS),
    links: outputStrings(page.links, MAX_OUTPUT_LINKS, MAX_OUTPUT_LINK_CHARACTERS),
    content: outputString(page.content, MAX_OUTPUT_PAGE_CONTENT_CHARACTERS),
    contentTruncated: page.content.length > MAX_OUTPUT_PAGE_CONTENT_CHARACTERS,
    updatedAt: page.updatedAt,
  };
}

function boundedString(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string") {
    throw new LocalAgentKnowledgeError("invalid_input", `${name} must be a string`);
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximum) {
    throw new LocalAgentKnowledgeError(
      "invalid_input",
      `${name} must contain between 1 and ${maximum} characters`,
    );
  }
  return normalized;
}

function safeSlug(value: unknown): string {
  const slug = boundedString(value, "slug", 300);
  const segments = slug.split("/");
  if (
    slug.startsWith("/")
    || slug.includes("\\")
    || segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new LocalAgentKnowledgeError("invalid_input", "slug is unsafe");
  }
  return slug;
}

function assertExpectedArguments(
  tool: LocalAgentKnowledgeToolName,
  args: Record<string, unknown>,
): void {
  const allowed = {
    list_spaces: ["limit"],
    get_overview: ["space"],
    list_maps: ["space", "limit"],
    search_knowledge: ["space", "query", "limit"],
    get_page: ["space", "slug"],
    get_page_trace: ["space", "slug"],
  }[tool] as readonly string[];
  if (Object.keys(args).some((key) => !allowed.includes(key))) {
    throw new LocalAgentKnowledgeError("invalid_input", "unexpected arguments");
  }
}

/**
 * Stable, read-only knowledge surface for local Agents. It deliberately hides
 * registry bindings and all mutation methods behind a small, bounded API.
 */
export class LocalAgentKnowledge {
  constructor(private readonly engine: KnowledgeEngine) {}

  async call(
    tool: LocalAgentKnowledgeToolName,
    args: Record<string, unknown> = {},
  ): Promise<LocalAgentKnowledgeResult> {
    assertExpectedArguments(tool, args);
    if (tool === "list_spaces") {
      const limit = boundedLimit(args.limit, DEFAULT_SPACE_LIMIT, MAX_SPACE_LIMIT);
      const meta = this.engine.registry.list().slice().sort((left, right) =>
        left.id.localeCompare(right.id)
      );
      const spaces = await Promise.all(meta.slice(0, limit).map(async (space) => ({
        space: space.id,
        kind: space.id.startsWith("personal/") ? "personal" as const : "team" as const,
        ...(space.name
          ? { name: outputString(space.name, MAX_OUTPUT_NAME_CHARACTERS) }
          : {}),
        pageCount: (await this.engine.listPages(space.id)).filter(isKnowledgeContentRef).length,
      })));
      return {
        spaces,
        totalSpaces: meta.length,
        truncated: meta.length > spaces.length,
      };
    }
    if (tool === "get_overview") {
      const space = this.spaceArgument(args.space);
      const page = await this.engine.getPage(space, "overview");
      if (!page) throw new LocalAgentKnowledgeError("not_found", "overview not found");
      return { page: safePage(space, page) };
    }
    if (tool === "list_maps") {
      const space = this.spaceArgument(args.space);
      const limit = boundedLimit(args.limit, DEFAULT_MAP_LIMIT, MAX_MAP_LIMIT);
      const [index, mapRefs] = await Promise.all([
        this.engine.getPage(space, "index"),
        this.engine.listPages(space, "map"),
      ]);
      const topLevelSlugs = index ? new Set(index.links) : undefined;
      const topLevelMaps = mapRefs
        .filter((map) => !topLevelSlugs || topLevelSlugs.has(map.slug))
        .sort((left, right) => left.slug.localeCompare(right.slug));
      const maps = topLevelMaps.slice(0, limit).map((map) => ({
        space,
        slug: outputString(map.slug, MAX_OUTPUT_SLUG_CHARACTERS),
        title: outputString(map.title, MAX_OUTPUT_TITLE_CHARACTERS),
        summary: outputString(map.summary, MAX_OUTPUT_SUMMARY_CHARACTERS),
        tags: outputStrings(map.tags, MAX_OUTPUT_TAGS, MAX_OUTPUT_TAG_CHARACTERS),
      }));
      return {
        maps,
        totalMaps: topLevelMaps.length,
        truncated: topLevelMaps.length > maps.length,
      };
    }
    if (tool === "search_knowledge") {
      const space = this.spaceArgument(args.space);
      const query = boundedString(args.query, "query", 500);
      const limit = boundedLimit(args.limit, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
      const matches = (await this.engine.search([space], query, { limit: SEARCH_SCAN_LIMIT }))
        .filter(isKnowledgeContentRef);
      const hits = matches.slice(0, limit).map((hit) => ({
        space,
        slug: outputString(hit.slug, MAX_OUTPUT_SLUG_CHARACTERS),
        title: outputString(hit.title, MAX_OUTPUT_TITLE_CHARACTERS),
        type: hit.type,
        snippet: outputString(hit.snippet, MAX_OUTPUT_SNIPPET_CHARACTERS),
      }));
      return { hits, truncated: matches.length > hits.length };
    }
    if (tool === "get_page") {
      const space = this.spaceArgument(args.space);
      const slug = safeSlug(args.slug);
      const trace = await this.engine.getKnowledgePageTrace(space, slug);
      if (!trace) throw new LocalAgentKnowledgeError("not_found", "page not found");
      return {
        page: safePage(space, trace.page),
        ...(isKnowledgeContentRef(trace.page)
          ? {
              evidence: {
                sourceCount: trace.sourceCount,
                ...(trace.latestEvidenceAt === undefined
                  ? {}
                  : { latestEvidenceAt: trace.latestEvidenceAt }),
                freshness: trace.freshness,
                complete: trace.complete,
              },
            }
          : {}),
      };
    }
    if (tool === "get_page_trace") {
      const space = this.spaceArgument(args.space);
      const slug = safeSlug(args.slug);
      const trace = await this.engine.getKnowledgePageTrace(space, slug);
      if (!trace) throw new LocalAgentKnowledgeError("not_found", "page not found");
      if (!isKnowledgeContentRef(trace.page)) {
        throw new LocalAgentKnowledgeError(
          "invalid_input",
          "generated navigation pages have no Raw evidence chain",
        );
      }
      return {
        trace: {
          space,
          slug: outputString(trace.page.slug, MAX_OUTPUT_SLUG_CHARACTERS),
          title: outputString(trace.page.title, MAX_OUTPUT_TITLE_CHARACTERS),
          sourceCount: trace.sourceCount,
          sources: trace.sources.map((source) => ({
            rawId: outputString(source.id, MAX_OUTPUT_RAW_ID_CHARACTERS),
            source: source.source,
            admission: source.admission,
            createdAt: source.createdAt,
            ...(source.author
              ? { author: outputString(source.author, MAX_OUTPUT_AUTHOR_CHARACTERS) }
              : {}),
          })),
          missingSourceIds: trace.missingSourceIds.map((id) =>
            outputString(id, MAX_OUTPUT_RAW_ID_CHARACTERS)
          ),
          ...(trace.latestEvidenceAt === undefined
            ? {}
            : { latestEvidenceAt: trace.latestEvidenceAt }),
          freshness: trace.freshness,
          complete: trace.complete,
          truncated: trace.truncated,
        },
      };
    }
    throw new LocalAgentKnowledgeError("invalid_input", "unknown tool");
  }

  private spaceArgument(value: unknown): SpaceId {
    if (
      typeof value !== "string"
      || value.length > 256
      || !isSpaceId(value)
    ) {
      throw new LocalAgentKnowledgeError("invalid_input", "space must be a valid SpaceId");
    }
    if (!this.engine.registry.has(value)) {
      throw new LocalAgentKnowledgeError("not_found", "Space not found");
    }
    return value;
  }
}
