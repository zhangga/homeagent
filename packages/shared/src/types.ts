/**
 * Core domain vocabulary shared across all homeagent packages.
 * Pure data shapes only — no behavior, no dependencies.
 */

/**
 * A space is a knowledge boundary. Every piece of knowledge belongs to exactly
 * one space. Retrieval vision is the union of a user's personal space and the
 * team spaces they belong to.
 *
 *   personal/<open_id>   one per person (private chat knowledge)
 *   team/<chat_id>       one per feishu group
 */
export type SpaceId = `personal/${string}` | `team/${string}`;

export type SpaceKind = "personal" | "team";

/** Where a raw entry originated. */
export type RawSource = "message" | "doc" | "manual" | "task" | "learning";

/** Whether a captured Raw input may enter knowledge distillation. */
export type RawAdmission = "ready" | "held" | "excluded";

/** A single attachment reference captured but (in MVP) not distilled. */
export interface Attachment {
  kind: "image" | "pdf" | "audio" | "file";
  /** local path or feishu file key */
  ref: string;
  name?: string;
}

/**
 * A raw, unprocessed knowledge input. Captured cheaply (no LLM) by remember().
 * The dream cycle later decides whether it is worth distilling into wiki pages.
 */
export interface RawEntry {
  space: SpaceId;
  source: RawSource;
  /** Knowledge admission state; ordinary captures default to ready. */
  admission?: RawAdmission;
  /** Ongoing work context that produced this input, when one is active. */
  workItemId?: string;
  /** WorkAction whose candidate output produced this input, when applicable. */
  workActionId?: string;
  /** Agent that handled this inbound message, when it triggered an Agent response. */
  agentId?: string;
  /**
   * Whether this message entered a response path. Undefined denotes a legacy
   * record created before Agent Chat attribution was available.
   */
  agentHandled?: boolean;
  /** Markdown sent by the Agent in response to this inbound message. */
  agentResponse?: string;
  /** Epoch ms when the Agent response was delivered. */
  agentRespondedAt?: number;
  /** open_id of the author when known */
  author?: string;
  chatId?: string;
  messageId?: string;
  /** plain-text body: message text or fetched doc markdown */
  content: string;
  attachments?: Attachment[];
  /** epoch ms; defaults to now when omitted */
  createdAt?: number;
}

/** A persisted raw row, as read back from storage. */
export interface RawRecord extends RawEntry {
  id: string;
  createdAt: number;
  ingested: boolean;
  admission: RawAdmission;
}

/** The category of a wiki page. Mirrors llm_wiki's whole-page taxonomy. */
export type PageType =
  | "index"
  | "overview"
  | "log"
  | "glossary"
  | "map"
  | "entity"
  | "concept"
  | "source"
  | "analysis";

/**
 * A wiki page. Content pages are distilled from admitted Raw; map and singleton
 * pages are generated navigation. Markdown frontmatter projects these fields.
 */
export interface Page {
  /** stable url-safe id, unique within a space, e.g. "entities/alice" */
  slug: string;
  type: PageType;
  title: string;
  summary: string;
  aliases: string[];
  tags: string[];
  /** raw entry ids this page was distilled from (provenance) */
  sources: string[];
  /** slugs of other pages this page links to ([[wikilinks]]) */
  links: string[];
  /** full markdown body */
  content: string;
  /** epoch ms */
  updatedAt: number;
  /** sha256 of the source material used to build this page (incremental cache) */
  contentHash: string;
}

/** A lightweight page reference for indexes/routing (no full content). */
export interface PageRef {
  slug: string;
  type: PageType;
  title: string;
  summary: string;
  aliases: string[];
  tags: string[];
}

/** A full-text search hit. */
export interface Hit {
  slug: string;
  title: string;
  type: PageType;
  snippet: string;
  /** bm25-derived score; lower is a better match in SQLite fts5 */
  score: number;
}

/** A citation attached to an answer, pointing at a wiki page. */
export type KnowledgeEvidenceFreshness = "recent" | "aging" | "stale" | "unknown";

export interface CitationEvidence {
  sourceCount: number;
  latestSourceAt?: number;
  freshness: KnowledgeEvidenceFreshness;
  complete: boolean;
}

export interface Citation {
  slug: string;
  title: string;
  /** Exact source only when the same slug exists in more than one queried space. */
  space?: SpaceId;
  /** Derived at answer time from Page -> Raw provenance; Raw ids remain private. */
  evidence?: CitationEvidence;
}

export type SkillWarningCode =
  | "missing_source"
  | "invalid_skill"
  | "provider_incompatible"
  | "ambiguous_legacy_name"
  | "shadowed_source"
  | "invalid_invocation_name"
  | "no_tools_context";

/** Presentation-safe warning for an Agent Skill that could not be loaded. */
export interface SkillWarningView {
  name: string;
  code: SkillWarningCode;
  message: string;
}

/**
 * The result of ask(). `source` distinguishes a grounded answer (from the
 * knowledge base, with citations) from a general fallback answer (model's own
 * knowledge, explicitly flagged as not in the knowledge base).
 */
export interface AskResult {
  answer: string;
  source: "knowledge" | "general";
  /** Non-KB context boundary used for the answer; never contains the actual path. */
  context?: "agent-workdir" | "message-source";
  citations: Citation[];
  /** Durable local quality trace used for explicit answer feedback. */
  traceId?: string;
  /** notable gaps the knowledge base did not cover, if any */
  gaps?: string[];
  /** Agent Skills skipped for this call; the base Agent still ran. */
  skillWarnings?: SkillWarningView[];
}

/** Summary of one dream-cycle run. */
export interface DreamReport {
  space: SpaceId;
  /** raw entries examined this run */
  examined: number;
  /** raw ids successfully handled (distilled, skipped, cached, or quarantined) */
  processedRawIds: string[];
  /** raw entries judged worth distilling */
  distilled: number;
  /** raw entries skipped as noise */
  skipped: number;
  /** pages created or updated */
  pagesWritten: number;
  /** pages that failed schema validation and were quarantined */
  pagesQuarantined: number;
  startedAt: number;
  finishedAt: number;
  errors: string[];
  /** Agent Skills skipped for this cycle; the base Agent still ran. */
  skillWarnings?: SkillWarningView[];
}

/** Health probe result for the knowledge layer. */
export interface HealthReport {
  ok: boolean;
  spaces: number;
  details?: Record<string, unknown>;
}

export type ComponentHealthStatus = "ok" | "degraded" | "down";

export interface ComponentHealth {
  status: ComponentHealthStatus;
  summary: string;
  details?: Record<string, unknown>;
}

/** Process-level health snapshot consumed by probes and the management UI. */
export interface SystemHealthSnapshot {
  status: ComponentHealthStatus;
  /** whether the process can safely receive and handle new work */
  ready: boolean;
  checkedAt: number;
  components: Record<string, ComponentHealth>;
}
