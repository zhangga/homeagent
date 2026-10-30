import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DreamExtractionCache, extractionDigest } from "./dream-extraction-cache.ts";
import * as checkpoints from "./dream-extraction-cache.ts";
import { KnowledgeEngine } from "./engine.ts";
import { SkillCatalog } from "./skill-catalog.ts";
import { FakeLlm } from "./testing.ts";

const SPACE = "team/oc_checkpoint_lifecycle";
let dir: string;
let engine: KnowledgeEngine;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ha-checkpoint-lifecycle-"));
  engine = new KnowledgeEngine({ dataDir: dir, skillCatalog: new SkillCatalog({ roots: [] }), llm: new FakeLlm() });
});
afterEach(() => { engine.close(); rmSync(dir, { recursive: true, force: true }); });
async function seed(createdAt = Date.now()) {
  const id = await engine.remember({ space: SPACE, source: "message", chatId: "oc_checkpoint_lifecycle", messageId: "om_checkpoint", author: "ou_owner", content: "Original Raw", createdAt });
  const store = engine.registry.store(SPACE);
  const key = extractionDigest(id);
  const cache = DreamExtractionCache.open(store, { key, rawIds: [id], groups: [1], create: true, reuse: true })!;
  cache.put(0, { title: "Title", summary: "Summary", content: "CHECKPOINT_PRIVATE_EVIDENCE", links: [] });
  return { id, store, path: join(store.root, ".dream-extractions", key) };
}
test("message retraction removes cached evidence before Raw and leaves no derived copy", async () => {
  const { id, store, path } = await seed();
  expect((await engine.retractMessage(SPACE, { chatId: "oc_checkpoint_lifecycle", messageId: "om_checkpoint", requestedBy: "ou_owner" })).status).toBe("retracted");
  expect(store.index().getRaw(id)).toBeNull();
  expect(existsSync(path)).toBe(false);
});
test("retention removes extraction checkpoints for expired Raw", async () => {
  const now = Date.now();
  const { id, store, path } = await seed(now - 3 * 86_400_000);
  store.index().markIngested([id]);
  expect((await engine.pruneRawMessages(1, now)).deleted).toBe(1);
  expect(existsSync(path)).toBe(false);
  expect(store.index().getRaw(id)).toBeNull();
});
test("failed checkpoint removal prevents Raw deletion and remains retryable", async () => {
  const { id, store, path } = await seed(Date.now() - 3 * 86_400_000);
  store.index().markIngested([id]);
  const failure = spyOn(checkpoints, "removeDreamExtractionsForRaw").mockImplementation(() => { throw new Error("cleanup failed"); });
  try {
    await expect(engine.retractMessage(SPACE, { chatId: "oc_checkpoint_lifecycle", messageId: "om_checkpoint", requestedBy: "ou_owner" })).rejects.toThrow("cleanup failed");
    await expect(engine.pruneRawMessages(1)).rejects.toThrow("cleanup failed");
  } finally { failure.mockRestore(); }
  expect(store.index().getRaw(id)).not.toBeNull();
  expect(existsSync(path)).toBe(true);
});
test("Space archives include authoritative Raw without local extraction checkpoints", async () => {
  const { id } = await seed();
  const archive = await engine.exportSpace(SPACE);
  expect(JSON.stringify(archive)).toContain(id);
  expect(JSON.stringify(archive)).not.toContain("CHECKPOINT_PRIVATE_EVIDENCE");
  expect(JSON.stringify(archive)).not.toContain(".dream-extractions");
});
