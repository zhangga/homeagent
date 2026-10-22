import { tokenize } from "./tokenize.ts";

const SEPARATOR = "\n…[另一处原文，非连续]…\n";
interface Span { start: number; end: number }
interface MatchBucket { first: number; last: number; terms: Map<string, number> }
export interface RawExcerpt {
  content: string;
  /** Original contiguous fragments; validation must never quote across separators. */
  fragments: string[];
  truncated: boolean;
}

function windowAt(content: string, at: number, length: number, budget: number): Span {
  let start = Math.max(0, Math.min(at - Math.floor((budget - length) / 2), content.length - budget));
  let end = Math.min(content.length, start + budget);
  if (start > 0 && content.charCodeAt(start) >= 0xdc00 && content.charCodeAt(start) <= 0xdfff) start += 1;
  if (end < content.length && content.charCodeAt(end - 1) >= 0xd800 && content.charCodeAt(end - 1) <= 0xdbff) end -= 1;
  return { start, end };
}

/** Locate matches in the whole stored body, then bound only the model's context. */
export function rawExcerpt(content: string, query: string, phrases: string[], budget: number): RawExcerpt {
  if (content.length <= budget) return { content, fragments: [content], truncated: false };
  const terms = new Map<string, number>();
  for (const phrase of phrases) {
    const term = phrase.toLowerCase();
    if (terms.size < 64 && term && term.length <= 4000) terms.set(term, 4 + Math.min(term.length, 32));
  }
  for (const term of new Set(tokenize(query))) if (terms.size < 64 && !terms.has(term)) terms.set(term, term.length > 2 ? 3 : 1);
  const lower = content.toLowerCase();
  const width = Math.min(4000, Math.max(2000, Math.floor(budget / 3)));
  // Buckets bound memory by source length rather than by the number of repeated matches.
  const buckets = new Map<number, MatchBucket>();
  const add = (at: number, length: number, term: string, weight: number) => {
    const key = Math.floor(at / width);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.first = Math.min(bucket.first, at);
      bucket.last = Math.max(bucket.last, at + length);
      bucket.terms.set(term, weight);
    } else buckets.set(key, { first: at, last: at + length, terms: new Map([[term, weight]]) });
  };
  for (const [term, weight] of terms) {
    if (lower.length !== content.length) {
      const pattern = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "giu");
      for (const match of content.matchAll(pattern)) add(match.index, match[0].length, term, weight);
    } else {
      for (let at = lower.indexOf(term); at >= 0; at = lower.indexOf(term, at + 1)) add(at, term.length, term, weight);
    }
  }
  let first = Infinity; let last = -Infinity;
  for (const bucket of buckets.values()) { first = Math.min(first, bucket.first); last = Math.max(last, bucket.first); }
  const proposals = [...buckets.values()].map(bucket => ({
    bucket, score: [...bucket.terms.values()].reduce((sum, value) => sum + value, 0),
    edge: Number(bucket.first === first || bucket.first === last),
  })).sort((a, b) => b.score - a.score || b.edge - a.edge || a.bucket.first - b.bucket.first);
  const spans: Span[] = [];
  let remaining = budget;
  for (const { bucket } of proposals) {
    const at = Math.floor((bucket.first + bucket.last) / 2);
    if (spans.some(span => bucket.first >= span.start && bucket.last <= span.end)) continue;
    const available = remaining - (spans.length > 0 ? SEPARATOR.length : 0);
    if (available <= 0) break;
    const span = windowAt(content, at, 0, Math.min(width, available));
    for (const previous of spans) {
      if (at >= previous.end) span.start = Math.max(span.start, previous.end);
      if (at <= previous.start) span.end = Math.min(span.end, previous.start);
    }
    if (span.end <= span.start) continue;
    remaining -= span.end - span.start + (spans.length > 0 ? SEPARATOR.length : 0);
    spans.push(span);
  }
  if (spans.length === 0) spans.push(windowAt(content, 0, 0, budget));
  const fragments = spans.sort((a, b) => a.start - b.start).map(span => content.slice(span.start, span.end));
  return { content: fragments.join(SEPARATOR), fragments, truncated: true };
}
