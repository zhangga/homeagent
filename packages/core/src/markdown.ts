/**
 * Page <-> markdown serialization (plan §2.1: Obsidian-compatible pages).
 *
 * Each wiki page is a markdown file with a YAML frontmatter block carrying the
 * structured metadata; the body below `---` is the human/LLM-readable content.
 * We hand-roll a tiny frontmatter reader/writer rather than pull a YAML library:
 * the schema is fixed and shallow (scalars + string arrays), so a focused
 * implementation is smaller, dependency-free, and fully under our control.
 *
 * The markdown file is the source of truth; the SQLite index is a rebuildable
 * projection of it (plan §2.1 ".index.db can be rebuilt from md").
 */
import type { Page, PageType } from "@homeagent/shared";

const FIELD_KEYS = [
  "slug",
  "type",
  "title",
  "summary",
  "aliases",
  "tags",
  "sources",
  "links",
  "updated",
  "contentHash",
] as const;

function yamlScalar(v: string): string {
  // Quote when the value could confuse the reader (leading/trailing space,
  // special leading chars, or contains a colon+space or a hash).
  if (v === "" || /^[\s]|[\s]$|:\s|#|^[-?&*!|>%@`"']/.test(v)) {
    return JSON.stringify(v);
  }
  return v;
}

function yamlList(items: string[]): string {
  if (items.length === 0) return "[]";
  return "[" + items.map((i) => JSON.stringify(i)).join(", ") + "]";
}

/** Serialize a Page to a markdown document with frontmatter. */
export function pageToMarkdown(page: Page): string {
  const fm: string[] = [
    "---",
    `slug: ${yamlScalar(page.slug)}`,
    `type: ${page.type}`,
    `title: ${yamlScalar(page.title)}`,
    `summary: ${yamlScalar(page.summary)}`,
    `aliases: ${yamlList(page.aliases)}`,
    `tags: ${yamlList(page.tags)}`,
    `sources: ${yamlList(page.sources)}`,
    `links: ${yamlList(page.links)}`,
    `updated: ${page.updatedAt}`,
    `contentHash: ${yamlScalar(page.contentHash)}`,
    "---",
    "",
  ];
  return fm.join("\n") + page.content.replace(/\s+$/, "") + "\n";
}

function parseScalar(raw: string): string {
  const t = raw.trim();
  if (t.startsWith('"') || t.startsWith("'")) {
    try {
      return JSON.parse(t.startsWith("'") ? `"${t.slice(1, -1)}"` : t) as string;
    } catch {
      return t.replace(/^['"]|['"]$/g, "");
    }
  }
  return t;
}

function parseList(raw: string): string[] {
  const t = raw.trim();
  if (t === "[]" || t === "") return [];
  if (t.startsWith("[") && t.endsWith("]")) {
    try {
      const arr = JSON.parse(t) as unknown[];
      return arr.map((x) => String(x));
    } catch {
      // fall through to manual split
    }
    return t
      .slice(1, -1)
      .split(",")
      .map((s) => parseScalar(s))
      .filter((s) => s !== "");
  }
  return [parseScalar(t)];
}

const PAGE_TYPES: PageType[] = [
  "index",
  "overview",
  "log",
  "glossary",
  "map",
  "entity",
  "concept",
  "source",
  "analysis",
];

/**
 * Parse a markdown document (frontmatter + body) back into a Page. Throws if the
 * frontmatter is missing or malformed — callers treat that as a corrupt page.
 */
export function markdownToPage(md: string): Page {
  if (!md.startsWith("---")) {
    throw new Error("page markdown missing frontmatter opener");
  }
  const end = md.indexOf("\n---", 3);
  if (end === -1) throw new Error("page markdown missing frontmatter closer");
  const header = md.slice(3, end).trim();
  // body starts after the closing '---' line
  const afterCloser = md.indexOf("\n", end + 1);
  const body = afterCloser === -1 ? "" : md.slice(afterCloser + 1);

  const fields: Record<string, string> = {};
  for (const line of header.split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1);
    fields[key] = val;
  }

  const typeRaw = parseScalar(fields.type ?? "");
  const type = (PAGE_TYPES as string[]).includes(typeRaw) ? (typeRaw as PageType) : "concept";
  const updated = Number(parseScalar(fields.updated ?? "0"));

  const page: Page = {
    slug: parseScalar(fields.slug ?? ""),
    type,
    title: parseScalar(fields.title ?? ""),
    summary: parseScalar(fields.summary ?? ""),
    aliases: parseList(fields.aliases ?? "[]"),
    tags: parseList(fields.tags ?? "[]"),
    sources: parseList(fields.sources ?? "[]"),
    links: parseList(fields.links ?? "[]"),
    content: body.replace(/\s+$/, "") + "\n",
    updatedAt: Number.isFinite(updated) ? updated : 0,
    contentHash: parseScalar(fields.contentHash ?? ""),
  };
  if (!page.slug) throw new Error("page markdown missing slug");
  return page;
}

/** Keys recognized in frontmatter (exported for tests/tools). */
export const PAGE_FIELD_KEYS = FIELD_KEYS;
