import { createHash } from "node:crypto";
import type { SpaceIndex } from "@homeagent/core";
import type { PageRef, SpaceId } from "@homeagent/shared";
import { html } from "hono/html";

export type CitedPage = Pick<PageRef, "slug" | "title">;
export interface MaterialSources {
  slot: number;
  identity: string;
  name: string;
  rawIds: string[];
  total?: number;
  expansionBudget?: number;
}

export const materialBatchPattern = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu;

export function localImportRawId(space: SpaceId, batch: string, slot: number, identity: string, part: number) {
  return "local-import-" + createHash("sha256").update(JSON.stringify([space, batch, slot, identity, part])).digest("hex");
}

export function materialSourcesQuery(batch: string, files: MaterialSources[], immediate = false) {
  const query = new URLSearchParams({ materialBatch: batch });
  if (immediate) query.set("distill", "1");
  for (const file of files) {
    const partial = file.total !== undefined && file.rawIds.length < file.total ? `.${file.total}.${file.expansionBudget}` : "";
    query.append("file", `${file.slot}.${file.identity}${partial}`);
  }
  return query;
}

/** Uploads commit contiguous parts per file. Use the same identities after a retry or service restart. */
export function readMaterialSources(space: SpaceId, index: SpaceIndex, batch: string, files: string[]): MaterialSources[] {
  if (!materialBatchPattern.test(batch) || files.length > 20) return [];
  const result: MaterialSources[] = [];
  const slots = new Set<number>();
  for (const value of files) {
    const match = /^(\d|1\d)\.([a-f0-9]{64})(?:\.([1-9]\d{0,6})\.(\d{1,9}))?$/u.exec(value);
    if (!match) return [];
    const slot = Number(match[1]);
    if (slots.has(slot)) return [];
    slots.add(slot);
    const identity = match[2]!;
    const rawIds: string[] = [];
    let name = "";
    // Most files have one part. Larger ZIPs use batches of indexed lookups.
    for (let width = 2; ; width = 128) {
      const ids = Array.from({ length: width }, (_, offset) => localImportRawId(space, batch, slot, identity, rawIds.length + offset));
      const names = index.importedFileNames(ids);
      for (const id of ids) {
        if (!names.has(id)) break;
        if (!rawIds.length) name = names.get(id)!;
        rawIds.push(id);
      }
      if (names.size < width) break;
    }
    const total = match[3] ? Number(match[3]) : undefined;
    if (rawIds.length || total) result.push({ slot, identity, name: name || `第 ${slot + 1} 份资料`, rawIds,
      ...(total ? { total, expansionBudget: Number(match[4]) } : {}) });
  }
  return result;
}

export function citedPageList(spaceUrl: string, pages: CitedPage[], empty: string) {
  return pages.length ? html`<ul>${pages.map(page => html`<li><a href="${spaceUrl}/pages/${encodeURIComponent(page.slug)}">${page.title}</a></li>`)}</ul>`
    : html`<p class="muted">${empty}</p>`;
}

export function importedPagesView(spaceUrl: string, files: MaterialSources[], citations: CitedPage[][]) {
  return html`<section class="card" aria-label="本次导入的关联知识页"><h2>本次导入的关联知识页</h2>
    ${files.map((file, index) => html`<h3>${file.name}</h3>
      ${citedPageList(spaceUrl, citations[index]!, "目前没有知识页引用这份资料。")}
      ${file.rawIds.length ? html`<a href="${spaceUrl}/raw/${encodeURIComponent(file.rawIds[0]!)}">查看原始条目</a>` : ""}`)}
  </section>`;
}
