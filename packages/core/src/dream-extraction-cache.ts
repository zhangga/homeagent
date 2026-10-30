/** Disposable, per-Space extraction checkpoints. Raw and Wiki remain authoritative. */
import { lstatSync, readFileSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { AI_GENERATION_MAX_TOKENS } from "@homeagent/shared";
import type { SpaceStore } from "./space.ts";
import type { GeneratedPage } from "./dream-page-update.ts";
import { assertLocalStatePath, writeAtomicStateFile } from "./durable-file.ts";

const HASH = /^[a-f0-9]{64}$/u;
const MAX_FRAGMENTS = 10_000; // Matches the existing frozen-source recovery envelope.
const MAX_PLAN_BYTES = 128 * 1024;
export const MAX_EXTRACTION_CACHE_BYTES = AI_GENERATION_MAX_TOKENS * 16 + 16_384;
const MAX_NOTE_CHARACTERS = AI_GENERATION_MAX_TOKENS * 16;

interface Plan {
  version: 1;
  space: string;
  key: string;
  rawIds: string[];
  fragmentCount: number;
  groups: number[];
}

export function extractionDigest(value: unknown): string {
  return new Bun.CryptoHasher("sha256").update(JSON.stringify(value) ?? "undefined").digest("hex");
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function strings(value: unknown, count: number, length: number): value is string[] {
  return Array.isArray(value) && value.length <= count
    && value.every(item => typeof item === "string" && item.length <= length);
}

function plan(value: unknown): Plan | undefined {
  if (!object(value) || value.version !== 1 || typeof value.space !== "string" || value.space.length > 240
    || typeof value.key !== "string" || !HASH.test(value.key)
    || !strings(value.rawIds, 40, 240) || !value.rawIds.length || value.rawIds.some(id => !id)
    || new Set(value.rawIds).size !== value.rawIds.length
    || typeof value.fragmentCount !== "number" || !Number.isSafeInteger(value.fragmentCount)
    || value.fragmentCount < 1 || value.fragmentCount > MAX_FRAGMENTS
    || !Array.isArray(value.groups) || !value.groups.length || value.groups.length > MAX_FRAGMENTS
    || !value.groups.every((size: unknown) => typeof size === "number" && Number.isSafeInteger(size) && size > 0 && size <= MAX_FRAGMENTS)
    || value.groups.reduce((sum: number, size: number) => sum + size, 0) !== value.fragmentCount) return undefined;
  return { version: 1, space: value.space, key: value.key, rawIds: [...value.rawIds],
    fragmentCount: value.fragmentCount, groups: [...value.groups] };
}

function note(value: unknown): GeneratedPage | undefined {
  if (!object(value) || typeof value.title !== "string" || value.title.length > MAX_NOTE_CHARACTERS
    || typeof value.summary !== "string" || value.summary.length > 1_000
    || typeof value.content !== "string" || !value.content.trim() || value.content.length > MAX_NOTE_CHARACTERS
    || !strings(value.links, MAX_NOTE_CHARACTERS, MAX_NOTE_CHARACTERS)
    || (value.aliases !== undefined && !strings(value.aliases, 64, 200))
    || (value.tags !== undefined && !strings(value.tags, 64, 200))) return undefined;
  return { title: value.title, summary: value.summary, content: value.content, links: [...value.links],
    ...(value.aliases === undefined ? {} : { aliases: [...value.aliases] }),
    ...(value.tags === undefined ? {} : { tags: [...value.tags] }) };
}

function checked(store: SpaceStore, path: string): string {
  assertLocalStatePath(resolve(store.root, "../.."), path);
  return path;
}

function read(store: SpaceStore, path: string, maximumBytes: number): unknown {
  checked(store, path);
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) throw new Error("Invalid extraction cache file");
    if (stat.size > maximumBytes) return undefined;
    try { return JSON.parse(readFileSync(path, "utf8")); } catch (error) {
      if (error instanceof SyntaxError) return undefined;
      throw error;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function directory(store: SpaceStore): string { return join(store.root, ".dream-extractions"); }

function removeDirectory(store: SpaceStore, path: string): void {
  checked(store, path);
  let entries: string[];
  try { entries = readdirSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  // Validate every direct child before deleting anything; never follow nested links.
  const files = entries.map(name => checked(store, join(path, name)));
  for (const file of files) if (!lstatSync(file).isFile()) throw new Error("Invalid extraction cache file");
  for (const file of files) unlinkSync(file);
  rmdirSync(path);
}

export class DreamExtractionCache {
  private constructor(private readonly store: SpaceStore, private readonly frozen: Plan, private readonly path: string) {}

  /** Reopen the original grouping, including shared groups that differ from a single-page retry. */
  static open(store: SpaceStore, input: { key: string; rawIds: string[]; groups: number[]; create: boolean; reuse: boolean }): DreamExtractionCache | undefined {
    const proposed = plan({ version: 1, space: store.space, key: input.key, rawIds: input.rawIds,
      fragmentCount: input.groups.reduce((sum, size) => sum + size, 0), groups: input.groups });
    if (!proposed) throw new Error("Invalid extraction cache plan");
    const path = checked(store, join(directory(store), proposed.key));
    if (!input.reuse) removeDirectory(store, path);
    const file = join(path, "plan.json");
    const existing = plan(read(store, file, MAX_PLAN_BYTES));
    if (input.reuse && existing?.space === store.space && existing.key === proposed.key
      && existing.fragmentCount === proposed.fragmentCount && JSON.stringify(existing.rawIds) === JSON.stringify(proposed.rawIds)) {
      return new DreamExtractionCache(store, existing, path);
    }
    if (!input.create) return undefined;
    const contents = JSON.stringify(proposed);
    if (Buffer.byteLength(contents) > MAX_PLAN_BYTES) throw new Error("Extraction cache plan is too large");
    checked(store, file);
    writeAtomicStateFile(file, contents);
    return new DreamExtractionCache(store, proposed, path);
  }

  get groups(): number[] { return [...this.frozen.groups]; }

  private groupKey(index: number): string {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.frozen.groups.length) throw new Error("Invalid extraction cache group");
    return extractionDigest([this.frozen.key, this.frozen.groups, index]);
  }

  get(index: number): GeneratedPage | undefined {
    const key = this.groupKey(index);
    const stored = read(this.store, join(this.path, `${key}.json`), MAX_EXTRACTION_CACHE_BYTES);
    if (!object(stored) || stored.version !== 1 || stored.space !== this.store.space || stored.plan !== this.frozen.key
      || stored.key !== key || stored.digest !== extractionDigest(stored.note)) return undefined;
    return note(stored.note);
  }

  put(index: number, value: GeneratedPage): void {
    const validated = note(value);
    if (!validated) throw new Error("Invalid extraction cache result");
    const key = this.groupKey(index);
    const contents = JSON.stringify({ version: 1, space: this.store.space, plan: this.frozen.key,
      key, digest: extractionDigest(validated), note: validated });
    if (Buffer.byteLength(contents) > MAX_EXTRACTION_CACHE_BYTES) throw new Error("Extraction cache result is too large");
    const path = checked(this.store, join(this.path, `${key}.json`));
    writeAtomicStateFile(path, contents);
  }

  complete(): void { removeDirectory(this.store, this.path); }
}

/** Remove derived copies before committing a Raw retraction or retention deletion. */
export function removeDreamExtractionsForRaw(store: SpaceStore, rawIds: ReadonlySet<string>): void {
  const root = checked(store, directory(store));
  let entries: string[];
  try { entries = readdirSync(root); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const key of entries.filter(name => HASH.test(name))) {
    const path = checked(store, join(root, key));
    const stored = plan(read(store, join(path, "plan.json"), MAX_PLAN_BYTES));
    if (!stored || stored.space !== store.space || stored.key !== key || stored.rawIds.some(id => rawIds.has(id))) {
      removeDirectory(store, path);
    }
  }
}
