import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AI_GENERATION_MAX_TOKENS } from "@homeagent/shared";
import { DreamExtractionCache, extractionDigest, MAX_EXTRACTION_CACHE_BYTES, removeDreamExtractionsForRaw } from "./dream-extraction-cache.ts";
import { SpaceStore } from "./space.ts";
import * as durable from "./durable-file.ts";

let dir: string;
let store: SpaceStore;
const key = extractionDigest("cache-test");
const input = () => ({ key, rawIds: ["raw-a", "raw-b"], groups: [1, 2], create: true, reuse: true });
const note = () => ({ title: "Title", summary: "Summary", content: "Complete evidence", links: ["concepts/related"], aliases: ["Alias"], tags: ["Tag"] });
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ha-extraction-cache-"));
  store = new SpaceStore("team/oc_cache", dir); store.ensure();
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
function root() { return join(store.root, ".dream-extractions"); }
function path() { return join(root(), key); }

test("complete notes and original groups survive reopen without retaining mutable input or output", () => {
  const proposed = input();
  const cached = DreamExtractionCache.open(store, proposed)!;
  const original = note(); cached.put(0, original);
  original.links.push("bad"); original.content = "bad";
  proposed.rawIds.push("bad"); proposed.groups.push(4);
  cached.groups.push(99);
  cached.get(0)!.aliases!.push("bad");
  store.close(); store = new SpaceStore("team/oc_cache", dir);
  const reopened = DreamExtractionCache.open(store, { ...input(), groups: [2, 1] })!;
  expect(reopened.groups).toEqual([1, 2]);
  expect(reopened.get(0)).toEqual(note());
  expect(reopened.get(1)).toBeUndefined();
  reopened.complete(); expect(existsSync(path())).toBe(false);
});

test("invalid plans fail before writing and both accepted fragment and Raw limits survive reopening", () => {
  for (const invalid of [
    { key: "../escape" }, { rawIds: [] }, { rawIds: ["same", "same"] }, { rawIds: ["x".repeat(241)] },
    { rawIds: Array.from({ length: 41 }, (_, i) => `raw-${i}`) },
    { groups: [] }, { groups: [0] }, { groups: [1.5] }, { groups: [10_001] },
  ]) expect(() => DreamExtractionCache.open(store, { ...input(), ...invalid })).toThrow("Invalid extraction cache plan");
  expect(existsSync(root())).toBe(false);
  const maximum = { ...input(), rawIds: Array.from({ length: 40 }, (_, i) => String(i).padEnd(240, "x")), groups: Array.from({ length: 10_000 }, () => 1) };
  const cached = DreamExtractionCache.open(store, maximum)!;
  cached.put(9_999, note());
  expect(DreamExtractionCache.open(store, maximum)!.get(9_999)).toEqual(note());
  expect(() => cached.get(-1)).toThrow();
  expect(() => cached.put(10_000, note())).toThrow();
});

test("bounded notes reject excess and keep the prior result intact", () => {
  const cached = DreamExtractionCache.open(store, input())!;
  const maximum = { ...note(), summary: "x".repeat(1_000), aliases: Array.from({ length: 64 }, () => "x".repeat(200)), tags: Array.from({ length: 64 }, () => "x".repeat(200)) };
  cached.put(0, maximum);
  expect(cached.get(0)).toEqual(maximum);
  for (const invalid of [
    { summary: "x".repeat(1_001) }, { content: " " }, { content: "x".repeat(AI_GENERATION_MAX_TOKENS * 16 + 1) },
    { links: ["x".repeat(AI_GENERATION_MAX_TOKENS * 16 + 1)] },
    { aliases: Array.from({ length: 65 }, () => "x") }, { tags: ["x".repeat(201)] },
  ]) expect(() => cached.put(0, { ...note(), ...invalid })).toThrow("Invalid extraction cache result");
  expect(() => cached.put(0, { ...note(), content: "文".repeat(AI_GENERATION_MAX_TOKENS * 16) })).toThrow("too large");
  expect(cached.get(0)).toEqual(maximum);
});

test("malformed, oversized and foreign note records become misses without exposing their content", () => {
  const cached = DreamExtractionCache.open(store, input())!;
  cached.put(0, note());
  const file = join(path(), readdirSync(path()).find(name => name !== "plan.json")!);
  const original = JSON.parse(readFileSync(file, "utf8"));
  for (const value of [null, {}, { ...original, space: "team/oc_foreign" }, { ...original, plan: "0".repeat(64) },
    { ...original, note: undefined }, { ...original, note: { ...note(), aliases: ["x".repeat(201)] }, digest: extractionDigest({ ...note(), aliases: ["x".repeat(201)] }) }]) {
    writeFileSync(file, JSON.stringify(value)); expect(cached.get(0)).toBeUndefined();
  }
  writeFileSync(file, "{".repeat(MAX_EXTRACTION_CACHE_BYTES + 1));
  expect(cached.get(0)).toBeUndefined();
});

test("a failed atomic replacement preserves the last committed note and removes its temporary file", () => {
  const cached = DreamExtractionCache.open(store, input())!;
  cached.put(0, note());
  const failure = spyOn(durable, "durableRenameSync").mockImplementation(() => { throw new Error("rename failed"); });
  try { expect(() => cached.put(0, { ...note(), content: "Replacement" })).toThrow("rename failed"); }
  finally { failure.mockRestore(); }
  expect(DreamExtractionCache.open(store, input())!.get(0)).toEqual(note());
  expect(readdirSync(path()).filter(name => name.endsWith(".tmp"))).toEqual([]);
});

test("copied cross-Space checkpoints are never reused", () => {
  const cached = DreamExtractionCache.open(store, input())!; cached.put(0, note());
  const other = new SpaceStore("team/oc_other", dir); other.ensure();
  try {
    cpSync(root(), join(other.root, ".dream-extractions"), { recursive: true });
    expect(DreamExtractionCache.open(other, { ...input(), create: false })).toBeUndefined();
    expect(DreamExtractionCache.open(other, input())!.get(0)).toBeUndefined();
  } finally { other.close(); }
});

test("cache paths reject junctions without reading or changing the linked directory", () => {
  const outside = join(dir, "outside"); mkdirSync(outside);
  writeFileSync(join(outside, "keep"), "untouched");
  symlinkSync(outside, root(), process.platform === "win32" ? "junction" : "dir");
  expect(() => DreamExtractionCache.open(store, input())).toThrow("Invalid local state path");
  expect(() => removeDreamExtractionsForRaw(store, new Set(["raw-a"]))).toThrow("Invalid local state path");
  expect(readFileSync(join(outside, "keep"), "utf8")).toBe("untouched");
});

test("Raw cleanup removes dependent and corrupt plans and keeps unrelated evidence", () => {
  DreamExtractionCache.open(store, input())!.put(0, note());
  const unrelated = DreamExtractionCache.open(store, { ...input(), key: extractionDigest("other"), rawIds: ["unrelated"] })!;
  unrelated.put(0, note());
  const corrupt = DreamExtractionCache.open(store, { ...input(), key: extractionDigest("corrupt") })!;
  corrupt.put(0, note());
  writeFileSync(join(root(), extractionDigest("corrupt"), "plan.json"), "{broken");
  removeDreamExtractionsForRaw(store, new Set(["raw-a"]));
  expect(readdirSync(root())).toEqual([extractionDigest("other")]);
  expect(unrelated.get(0)).toEqual(note());
});
