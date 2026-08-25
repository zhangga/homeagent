import type { RawAdmission, SpaceId } from "@homeagent/shared";
import type { SpaceStore } from "./space.ts";
import { isKnowledgeContentRef } from "./digest.ts";
import { buildKnowledgePageTrace } from "./traceability.ts";

export type WikiMaintenanceIssueKind =
  | "broken_link"
  | "orphan_page"
  | "duplicate_identity"
  | "oversized_page"
  | "untraceable_page"
  | "stale_evidence"
  | "missing_source"
  | "inadmissible_source";

export interface WikiMaintenanceOptions {
  /** Report content pages larger than this many Markdown characters. */
  maxPageCharacters?: number;
  /** Maximum number of content pages loaded whole during one cycle. */
  maxPages?: number;
  /** Maximum number of issue details returned by one cycle. */
  maxIssues?: number;
}

export interface WikiMaintenanceIssue {
  kind: WikiMaintenanceIssueKind;
  pageSlug: string;
  targetSlug?: string;
  sourceId?: string;
  sourceAdmission?: RawAdmission;
  evidenceAt?: number;
  message: string;
}

export interface WikiMaintenanceReport {
  space: SpaceId;
  totalPages: number;
  scannedPages: number;
  issues: WikiMaintenanceIssue[];
  truncated: boolean;
  startedAt: number;
  finishedAt: number;
}

const DEFAULT_MAX_PAGE_CHARACTERS = 50_000;
const DEFAULT_MAX_PAGES = 5_000;
const DEFAULT_MAX_ISSUES = 500;

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  const requested = value === undefined || !Number.isFinite(value)
    ? fallback
    : Math.trunc(value);
  return Math.max(1, Math.min(maximum, requested));
}

function normalizedIdentity(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase();
}

/** Read-only deterministic inspection of the current Knowledge pages in one Space. */
export function runWikiMaintenanceCycle(
  store: SpaceStore,
  options: WikiMaintenanceOptions = {},
): WikiMaintenanceReport {
  const startedAt = Date.now();
  const pageCharacterLimit = boundedInteger(
    options.maxPageCharacters,
    DEFAULT_MAX_PAGE_CHARACTERS,
    1_000_000,
  );
  const pageLimit = boundedInteger(options.maxPages, DEFAULT_MAX_PAGES, 50_000);
  const issueLimit = boundedInteger(options.maxIssues, DEFAULT_MAX_ISSUES, 5_000);
  const index = store.index();
  const allRefs = index.listPages();
  const refs = allRefs.filter(isKnowledgeContentRef);
  const knownSlugs = new Set(allRefs.map((page) => page.slug));
  const selectedRefs = refs.slice().sort((a, b) => a.slug.localeCompare(b.slug)).slice(0, pageLimit);
  const contentPages = selectedRefs
    .map((ref) => index.getPage(ref.slug))
    .filter((page) => page !== null);
  const issues: WikiMaintenanceIssue[] = [];
  let issuesTruncated = false;
  const addIssue = (issue: WikiMaintenanceIssue): boolean => {
    if (issues.length >= issueLimit) {
      issuesTruncated = true;
      return false;
    }
    issues.push(issue);
    return true;
  };
  const incomingLinks = new Map<string, number>(
    contentPages.map((page) => [page.slug, 0]),
  );
  const identityToSlugs = new Map<string, Set<string>>();

  for (const page of contentPages) {
    for (const identity of new Set([page.title, ...page.aliases].map(normalizedIdentity))) {
      if (!identity) continue;
      const slugs = identityToSlugs.get(identity) ?? new Set<string>();
      slugs.add(page.slug);
      identityToSlugs.set(identity, slugs);
    }
    for (const targetSlug of page.links) {
      if (incomingLinks.has(targetSlug)) {
        incomingLinks.set(targetSlug, (incomingLinks.get(targetSlug) ?? 0) + 1);
      }
    }
  }

  for (const [identity, slugSet] of identityToSlugs) {
    const slugs = [...slugSet].sort();
    if (slugs.length < 2) continue;
    for (let left = 0; left < slugs.length - 1; left += 1) {
      for (let right = left + 1; right < slugs.length; right += 1) {
        if (!addIssue({
          kind: "duplicate_identity",
          pageSlug: slugs[left]!,
          targetSlug: slugs[right]!,
          message: `知识页共享标题或别名：${identity}`,
        })) break;
      }
      if (issuesTruncated) break;
    }
    if (issuesTruncated) break;
  }

  pageChecks: for (const page of contentPages) {
    if (issuesTruncated) break;
    for (const targetSlug of page.links) {
      if (knownSlugs.has(targetSlug)) continue;
      if (!addIssue({
        kind: "broken_link",
        pageSlug: page.slug,
        targetSlug,
        message: `知识页链接的目标不存在：${targetSlug}`,
      })) break pageChecks;
    }
    if (refs.length <= pageLimit && (incomingLinks.get(page.slug) ?? 0) === 0) {
      if (!addIssue({
        kind: "orphan_page",
        pageSlug: page.slug,
        message: "知识页没有来自其他内容页的链接。",
      })) break;
    }
    if (page.content.length > pageCharacterLimit) {
      if (!addIssue({
        kind: "oversized_page",
        pageSlug: page.slug,
        message: `知识页正文超过 ${pageCharacterLimit} 个字符。`,
      })) break;
    }
    if (page.sources.length === 0) {
      if (!addIssue({
        kind: "untraceable_page",
        pageSlug: page.slug,
        message: "知识页没有可追溯的 Raw 来源。",
      })) break;
    }
    const trace = page.sources.length > 0
      ? buildKnowledgePageTrace(store, page, startedAt)
      : undefined;
    if (trace?.freshness === "stale" && trace.latestEvidenceAt !== undefined) {
      if (!addIssue({
        kind: "stale_evidence",
        pageSlug: page.slug,
        evidenceAt: trace.latestEvidenceAt,
        message: "知识页的最新完整 Raw 证据已超过 365 天。",
      })) break;
    }
    for (const sourceId of page.sources) {
      const source = index.getRaw(sourceId);
      if (!source) {
        if (!addIssue({
          kind: "missing_source",
          pageSlug: page.slug,
          sourceId,
          message: `知识页引用的 Raw 已不可用：${sourceId}`,
        })) break pageChecks;
      } else if (source.admission !== "ready") {
        if (!addIssue({
          kind: "inadmissible_source",
          pageSlug: page.slug,
          sourceId,
          sourceAdmission: source.admission,
          message: `知识页引用了不可采纳的 ${source.admission} Raw：${sourceId}`,
        })) break pageChecks;
      }
    }
  }

  return {
    space: store.space,
    totalPages: refs.length,
    scannedPages: contentPages.length,
    issues,
    truncated: refs.length > pageLimit || issuesTruncated,
    startedAt,
    finishedAt: Date.now(),
  };
}
