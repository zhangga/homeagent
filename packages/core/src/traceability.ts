import type {
  KnowledgeEvidenceFreshness,
  Page,
  RawAdmission,
  RawSource,
  SpaceId,
} from "@homeagent/shared";
import type { SpaceStore } from "./space.ts";

export interface KnowledgeEvidenceSource {
  id: string;
  source: RawSource;
  admission: RawAdmission;
  createdAt: number;
  author?: string;
  chatId?: string;
  messageId?: string;
  workItemId?: string;
  workActionId?: string;
}

export interface KnowledgePageTrace {
  space: SpaceId;
  page: Page;
  /** Total Raw ids referenced by the authoritative Knowledge page. */
  sourceCount: number;
  /** Bounded, metadata-only Raw evidence; message bodies are never copied here. */
  sources: KnowledgeEvidenceSource[];
  missingSourceIds: string[];
  latestEvidenceAt?: number;
  freshness: KnowledgeEvidenceFreshness;
  /** True only when every referenced Raw exists and remains admitted. */
  complete: boolean;
  truncated: boolean;
}

export const RECENT_EVIDENCE_MAX_AGE_DAYS = 90;
export const AGING_EVIDENCE_MAX_AGE_DAYS = 365;
export const MAX_KNOWLEDGE_TRACE_SOURCES = 100;
const DAY_MS = 24 * 60 * 60 * 1_000;

function clonePage(page: Page): Page {
  return {
    ...page,
    aliases: [...page.aliases],
    tags: [...page.tags],
    sources: [...page.sources],
    links: [...page.links],
  };
}

export function evidenceFreshness(
  latestEvidenceAt: number | undefined,
  complete: boolean,
  now = Date.now(),
): KnowledgeEvidenceFreshness {
  if (!complete || latestEvidenceAt === undefined) return "unknown";
  const ageDays = Math.max(0, (now - latestEvidenceAt) / DAY_MS);
  if (ageDays <= RECENT_EVIDENCE_MAX_AGE_DAYS) return "recent";
  if (ageDays <= AGING_EVIDENCE_MAX_AGE_DAYS) return "aging";
  return "stale";
}

/**
 * Resolve a Knowledge page's provenance from the Raw journal projection.
 * This is a read-only derived view: Raw and Markdown remain authoritative.
 */
export function buildKnowledgePageTrace(
  store: SpaceStore,
  page: Page,
  now = Date.now(),
): KnowledgePageTrace {
  const sources: KnowledgeEvidenceSource[] = [];
  const missingSourceIds: string[] = [];
  let latestEvidenceAt: number | undefined;
  let complete = page.sources.length > 0;

  for (const sourceId of page.sources) {
    const raw = store.index().getRaw(sourceId);
    if (!raw) {
      complete = false;
      if (missingSourceIds.length < MAX_KNOWLEDGE_TRACE_SOURCES) {
        missingSourceIds.push(sourceId);
      }
      continue;
    }
    if (raw.admission !== "ready") complete = false;
    latestEvidenceAt = latestEvidenceAt === undefined
      ? raw.createdAt
      : Math.max(latestEvidenceAt, raw.createdAt);
    if (sources.length >= MAX_KNOWLEDGE_TRACE_SOURCES) continue;
    sources.push({
      id: raw.id,
      source: raw.source,
      admission: raw.admission,
      createdAt: raw.createdAt,
      ...(raw.author ? { author: raw.author } : {}),
      ...(raw.chatId ? { chatId: raw.chatId } : {}),
      ...(raw.messageId ? { messageId: raw.messageId } : {}),
      ...(raw.workItemId ? { workItemId: raw.workItemId } : {}),
      ...(raw.workActionId ? { workActionId: raw.workActionId } : {}),
    });
  }

  return {
    space: store.space,
    page: clonePage(page),
    sourceCount: page.sources.length,
    sources,
    missingSourceIds,
    ...(latestEvidenceAt === undefined ? {} : { latestEvidenceAt }),
    freshness: evidenceFreshness(latestEvidenceAt, complete, now),
    complete,
    truncated: page.sources.length > MAX_KNOWLEDGE_TRACE_SOURCES,
  };
}
