/**
 * Slug helpers for wiki pages. A content page slug is `<folder>/<name>` where
 * folder groups by type (entities/, concepts/, sources/, analysis/); generated
 * maps live under maps/. Top-level singletons (index/overview/log/glossary)
 * have no folder. Centralizing this keeps the LLM's free-form slug
 * suggestions from producing unsafe or inconsistent paths.
 */
import type { PageType } from "@homeagent/shared";

/** Folder each content type lives in. */
export const TYPE_FOLDER: Record<Exclude<PageType, "index" | "overview" | "log" | "glossary">, string> = {
  map: "maps",
  entity: "entities",
  concept: "concepts",
  source: "sources",
  analysis: "analysis",
};

export const SINGLETON_SLUGS = ["index", "overview", "log", "glossary"] as const;

/** Lowercase, keep CJK + alphanumerics, collapse everything else to a hyphen. */
export function slugifyName(raw: string): string {
  const s = raw
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return s || "untitled";
}

/**
 * Normalize a (possibly LLM-suggested) slug for a given type into the canonical
 * `<folder>/<name>` form. Accepts inputs that already include the folder or
 * that are bare names.
 */
export function canonicalSlug(type: PageType, suggested: string): string {
  if ((SINGLETON_SLUGS as readonly string[]).includes(type)) return type;
  const folder = TYPE_FOLDER[type as keyof typeof TYPE_FOLDER] ?? "concepts";
  // strip any leading folder the model may have added
  const namePart = suggested.includes("/") ? suggested.slice(suggested.lastIndexOf("/") + 1) : suggested;
  return `${folder}/${slugifyName(namePart)}`;
}
