import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_MATERIAL_BYTES, MAX_MATERIAL_EXPANDED_BYTES, MAX_MATERIAL_FILES } from "@homeagent/shared";
import { KnowledgeEngine } from "./engine.ts";
import { SkillCatalog } from "./skill-catalog.ts";
import { RawJournal } from "./raw-journal.ts";
import type { RawSourceCapture } from "./raw-source-files.ts";

const space = "personal/ou_documents" as const;
let root: string;
const engines: KnowledgeEngine[] = [];
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), "ha-document-images-"))); });
afterEach(() => { for (const engine of engines) engine.close(); engines.length = 0; rmSync(root, { recursive: true, force: true }); });
function engineAt(path = root) {
  const engine = new KnowledgeEngine({ dataDir: path, skillCatalog: new SkillCatalog({ roots: [] }) });
  engines.push(engine);
  return engine;
}
function image(index: number): RawSourceCapture {
  return { attachment: { kind: "image", ref: `image_${index}`, name: `figure-${index}.png` }, bytes: new Uint8Array([137, 80, 78, 71, index]) };
}

test("one article retains forty-one exact image originals across reopen, projection rebuild and export/restore", async () => {
  const engine = engineAt();
  const id = await engine.rememberFiles({ space, source: "doc", content: '# article\n<img ref="image_0"/>' }, Array.from({ length: 41 }, (_, i) => image(i)));
  const store = engine.registry.store(space);
  expect(store.index().getRaw(id)?.attachments).toHaveLength(41);
  engine.close();
  rmSync(store.dbPath);
  const reopened = engineAt();
  const archive = await reopened.exportSpace(space);
  expect(archive.sourceFiles).toHaveLength(41);
  const restored = engineAt(join(root, "restored"));
  await restored.restoreSpace(archive);
  for (let i = 0; i < 41; i++) {
    expect(new Uint8Array(readFileSync(restored.getRawSource(space, id, i)!.path))).toEqual(new Uint8Array([137, 80, 78, 71, i]));
  }
  expect(restored.getRawSource("personal/ou_other", id, 0)).toBeNull();
});

test("validates every original before writing and captures caller-owned metadata/bytes", async () => {
  const engine = engineAt();
  engine.ensureSpace(space);
  await expect(engine.rememberFiles({ space, source: "doc", content: "article" }, [image(1),
    { attachment: { kind: "image", ref: "missing" }, localPath: join(root, "missing.png") }])).rejects.toThrow();
  expect(readdirSync(engine.registry.store(space).rawSourcesDir)).toHaveLength(0);
  expect(engine.registry.store(space).index().countRaw()).toBe(0);
  const bytes = Buffer.from([1, 2, 3]);
  const attachment = { kind: "image" as const, ref: "original" };
  const pending = engine.rememberFiles({ space, source: "doc", content: "article" }, [{ attachment, bytes }]);
  bytes.fill(9); attachment.ref = "mutated";
  const id = await pending;
  expect(engine.registry.store(space).index().getRaw(id)?.attachments?.[0]?.ref).toBe("original");
  expect(new Uint8Array(readFileSync(engine.getRawSource(space, id, 0)!.path))).toEqual(new Uint8Array([1, 2, 3]));
});

test("failed source persistence rolls back unreferenced files while preserving earlier originals", async () => {
  const engine = engineAt();
  const id = await engine.rememberFile({ space, source: "manual", content: "earlier" }, image(1));
  const files = engine.registry.store(space).rawSourceFiles;
  const write = files.write.bind(files);
  let calls = 0;
  const failure = spyOn(files, "write").mockImplementation(bytes => {
    if (++calls === 3) throw new Error("fixture storage failure");
    return write(bytes);
  });
  try {
    await expect(engine.rememberFiles({ space, source: "doc", content: "article" }, [image(1), image(2), image(3)])).rejects.toThrow("fixture storage failure");
  } finally { failure.mockRestore(); }
  expect(readdirSync(engine.registry.store(space).rawSourcesDir)).toHaveLength(1);
  expect(engine.getRawSource(space, id, 0)?.sizeBytes).toBe(5);
  expect(engine.registry.store(space).index().countRaw()).toBe(1);
});

test("projection failure never deletes images referenced by the committed Raw journal", async () => {
  const engine = engineAt();
  engine.ensureSpace(space);
  const store = engine.registry.store(space);
  const db = new Database(store.dbPath);
  try {
    db.exec("CREATE TRIGGER fail_images BEFORE INSERT ON raw BEGIN SELECT RAISE(FAIL, 'fixture projection failure'); END");
    await expect(engine.rememberFiles({ space, source: "doc", content: "article" }, [image(1), image(2)])).rejects.toThrow();
    const raws = new RawJournal(join(store.root, "raw"), space).listRaw();
    expect(raws).toHaveLength(1);
    expect(readdirSync(store.rawSourcesDir)).toHaveLength(2);
    db.exec("DROP TRIGGER fail_images");
    engine.close();
    const reopened = engineAt();
    expect(reopened.registry.store(space).index().getRaw(raws[0]!.id)?.attachments).toHaveLength(2);
    expect(reopened.getRawSource(space, raws[0]!.id, 1)?.sizeBytes).toBe(5);
  } finally { db.close(); }
});

test("enforces existing file and reference budgets without writing a partial Raw", async () => {
  const engine = engineAt();
  engine.ensureSpace(space);
  const entry = { space, source: "doc" as const, content: "article" };
  await expect(engine.rememberFiles(entry, Array.from({ length: MAX_MATERIAL_FILES + 1 }, () => image(1)))).rejects.toThrow();
  await expect(engine.rememberFiles(entry, [{ attachment: { kind: "image", ref: "large" }, bytes: new Uint8Array(MAX_MATERIAL_BYTES + 1) }])).rejects.toThrow();
  const full = new Uint8Array(MAX_MATERIAL_BYTES);
  await expect(engine.rememberFiles(entry, Array.from({ length: MAX_MATERIAL_EXPANDED_BYTES / MAX_MATERIAL_BYTES + 1 }, () =>
    ({ attachment: { kind: "image" as const, ref: "large-batch" }, bytes: full })))).rejects.toThrow();
  await expect(engine.rememberFiles(entry, [{ attachment: { kind: "image", ref: "forged", sourceDigest: "a".repeat(64) }, bytes: new Uint8Array() }])).rejects.toThrow();
  await expect(engine.rememberFiles(entry, [{ attachment: { kind: "image", ref: "x".repeat(2049) }, bytes: new Uint8Array() }])).rejects.toThrow();
  expect(engine.registry.store(space).index().countRaw()).toBe(0);
  expect(readdirSync(engine.registry.store(space).rawSourcesDir)).toHaveLength(0);
  const id = await engine.rememberFiles(entry, Array.from({ length: MAX_MATERIAL_FILES }, () => image(1)));
  expect(engine.registry.store(space).index().getRaw(id)?.attachments).toHaveLength(MAX_MATERIAL_FILES);
});
