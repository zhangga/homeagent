import type { PageRef } from "@homeagent/shared";
import { isKnowledgeContentRef } from "./digest.ts";
import type { SpaceStore } from "./space.ts";

// Match the existing ask catalog's page count; also bound metadata per prompt.
const CATALOG_PAGES = 60;
const CATALOG_CHARACTERS = 24_000;
const SEARCH_WINDOW_CHARACTERS = 2_000;

function normalized(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

export function dreamCatalogLine(ref: PageRef): string {
  const aliases = ref.aliases.join("、");
  const tags = ref.tags.join("、");
  return `- ${ref.slug} (${ref.type})：${ref.title}｜${ref.summary}`
    + (aliases ? `｜别名：${aliases}` : "") + (tags ? `｜主题：${tags}` : "");
}

export interface DreamCatalogEntry { ref: PageRef; line: string }

function* entries(refs: Iterable<PageRef>): Generator<DreamCatalogEntry, void> {
  for (const ref of refs) {
    const line = dreamCatalogLine(ref);
    if (line.length + 1 <= CATALOG_CHARACTERS) { yield { ref, line }; continue; }
    const prefix = `- ${ref.slug} (${ref.type})［目录元数据分段］：`;
    const size = CATALOG_CHARACTERS - prefix.length - 1;
    if (size <= 1) throw new Error("Dream catalog page identity exceeds prompt budget");
    for (let start = 0; start < line.length;) {
      let end = Math.min(start + size, line.length);
      if (end < line.length && line.charCodeAt(end - 1) >= 0xd800 && line.charCodeAt(end - 1) <= 0xdbff) end--;
      yield { ref, line: prefix + line.slice(start, end) };
      start = end;
    }
  }
}

/** Prompt batches, not a cap on the pages that may be considered. */
export function* dreamCatalogBatches<T>(items: Iterable<T>, line: (item: T) => string): Generator<T[], void> {
  let batch: T[] = [];
  let characters = 0;
  for (const item of items) {
    const size = line(item).length + 1;
    if (batch.length && (batch.length >= CATALOG_PAGES || characters + size > CATALOG_CHARACTERS)) {
      yield batch;
      batch = [];
      characters = 0;
    }
    batch.push(item);
    characters += size;
  }
  if (batch.length) yield batch;
}

/** One Space's metadata snapshot, augmented only by this cycle's planned pages. */
export class DreamCatalog {
  private readonly refs: PageRef[];
  private readonly bySlug: Map<string, PageRef>;
  private readonly content = new Map<string, PageRef>();
  private readonly mapLinks = new Map<string, string[]>();

  constructor(private readonly store: SpaceStore) {
    this.refs = store.index().listPages();
    this.bySlug = new Map(this.refs.map(ref => [ref.slug, ref]));
    for (const ref of this.refs) if (isKnowledgeContentRef(ref)) this.content.set(ref.slug, ref);
  }

  get size(): number { return this.content.size; }

  get complete(): boolean {
    return this.content.size <= CATALOG_PAGES
      && [...this.content.values()].reduce((sum, ref) => sum + dreamCatalogLine(ref).length + 1, 0) <= CATALOG_CHARACTERS;
  }

  get(slug: string): PageRef | undefined { return this.content.get(slug); }

  prompt(texts: string[]): string {
    const first = dreamCatalogBatches(entries(this.candidates(texts)), entry => entry.line).next();
    return first.done ? "" : first.value.map(entry => entry.line).join("\n");
  }

  remember(ref: PageRef): void {
    if (this.bySlug.has(ref.slug)) return;
    this.refs.push(ref);
    this.bySlug.set(ref.slug, ref);
    this.content.set(ref.slug, ref);
  }

  candidates(texts: string[]): PageRef[] {
    if (this.complete) return [...this.content.values()];
    const queries = texts.map(normalized);
    const direct: PageRef[] = [];
    const matchedMaps: string[] = [];
    for (const ref of this.refs) {
      if (![ref.slug, ref.title, ...ref.aliases].some(value => {
        const key = normalized(value).trim();
        return key && queries.some(query => query.includes(key));
      })) continue;
      if (isKnowledgeContentRef(ref)) direct.push(ref);
      else if (ref.type === "map") matchedMaps.push(ref.slug);
    }
    const hits = new Map<string, number>();
    // Traverse the whole source, including its tail, without oversized FTS expressions.
    for (const query of queries) {
      for (let start = 0; start < query.length; start += SEARCH_WINDOW_CHARACTERS) {
        for (const hit of this.store.index().search(query.slice(Math.max(0, start - 100), start + SEARCH_WINDOW_CHARACTERS), CATALOG_PAGES)) {
          hits.set(hit.slug, Math.min(hits.get(hit.slug) ?? Infinity, hit.score));
        }
      }
    }
    const ranked = [...hits].sort((a, b) => a[1] - b[1]).map(([slug]) => this.bySlug.get(slug)).filter((ref): ref is PageRef => !!ref);
    const candidates = new Map(direct.map(ref => [ref.slug, ref]));
    for (const ref of ranked) if (isKnowledgeContentRef(ref)) candidates.set(ref.slug, ref);
    const maps = [...matchedMaps, ...ranked.filter(ref => ref.type === "map").map(ref => ref.slug)];
    const visited = new Set<string>();
    for (let i = 0; i < maps.length; i++) {
      const slug = maps[i]!;
      if (visited.has(slug)) continue;
      visited.add(slug);
      let links = this.mapLinks.get(slug);
      if (!links) { links = this.store.index().getPage(slug)?.links ?? []; this.mapLinks.set(slug, links); }
      for (const link of links) {
        const ref = this.bySlug.get(link);
        if (ref?.type === "map") maps.push(link);
        else if (ref && isKnowledgeContentRef(ref)) candidates.set(link, ref);
      }
    }
    const first = dreamCatalogBatches(candidates.values(), dreamCatalogLine).next();
    return first.done ? [] : first.value;
  }

  /** Prefer fresh title/reason matches, then examine every remaining content page. */
  *reuseBatches(texts: string[]): Generator<DreamCatalogEntry[], void> {
    const preferred = this.candidates(texts);
    const seen = new Set(preferred.map(ref => ref.slug));
    const refs = [...preferred, ...[...this.content.values()].filter(ref => !seen.has(ref.slug))];
    yield* dreamCatalogBatches(entries(refs), entry => entry.line);
  }
}
