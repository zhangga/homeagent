import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page, SpaceId } from "@homeagent/shared";
import { SpaceStore } from "./space.ts";
import { SpaceIndex } from "./sqlite.ts";

const SPACE: SpaceId = "team/oc_readable_raw";
const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ha-readable-raw-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("readable Raw journal", () => {
  test("persists current Raw state as daily JSONL and rebuilds a deleted SQLite projection", () => {
    const dataDir = tempDir();
    const store = new SpaceStore(SPACE, dataDir);
    store.ensure();
    const index = store.index();
    const createdAt = Date.UTC(2026, 7, 20, 8, 30);
    const rawId = index.insertRaw({
      space: SPACE,
      source: "message",
      author: "ou_owner",
      chatId: "oc_readable_raw",
      messageId: "om_iris",
      content: "UE 5.8 Iris 已支持按连接并行 Tick。",
      createdAt,
    });
    expect(index.attributeRawToAgent(rawId, "agent_codex")).toBeTrue();
    expect(index.recordAgentResponse(
      "oc_readable_raw",
      "om_iris",
      "好的，我记下了。",
      createdAt + 1,
    )).toBeTrue();
    index.markIngested([rawId]);
    const page: Page = {
      slug: "concepts/iris",
      type: "concept",
      title: "Iris parallel tick",
      summary: "UE 5.8 networking",
      aliases: [],
      tags: ["UE"],
      sources: [rawId],
      links: [],
      content: "# Iris parallel tick\n\nUE 5.8 supports per-connection parallel tick.\n",
      updatedAt: createdAt + 2,
      contentHash: "iris-hash",
    };
    store.writePage(page);

    const journalPath = join(
      store.root,
      "raw",
      "records",
      "2026",
      "08",
      "20.jsonl",
    );
    expect(existsSync(journalPath)).toBeTrue();
    const records = readFileSync(journalPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records).toEqual([
      expect.objectContaining({
        id: rawId,
        createdAtIso: "2026-08-20T08:30:00.000Z",
        content: "UE 5.8 Iris 已支持按连接并行 Tick。",
        ingested: true,
        agentId: "agent_codex",
        agentResponse: "好的，我记下了。",
      }),
    ]);

    store.close();
    rmSync(store.dbPath, { force: true });
    rmSync(`${store.dbPath}-wal`, { force: true });
    rmSync(`${store.dbPath}-shm`, { force: true });

    const reopened = new SpaceStore(SPACE, dataDir);
    reopened.ensure();
    expect(reopened.index().getRaw(rawId)).toEqual(expect.objectContaining({
      id: rawId,
      content: "UE 5.8 Iris 已支持按连接并行 Tick。",
      ingested: true,
      agentId: "agent_codex",
      agentResponse: "好的，我记下了。",
    }));
    expect(reopened.index().getPage(page.slug)).toEqual(page);
    reopened.close();
  });

  test("backfills a legacy SQLite-only Raw store on first open", () => {
    const dataDir = tempDir();
    const store = new SpaceStore(SPACE, dataDir);
    mkdirSync(store.root, { recursive: true });
    const legacy = new SpaceIndex(store.dbPath);
    const rawId = legacy.insertRaw({
      space: SPACE,
      source: "message",
      content: "legacy SQLite-only message",
      createdAt: Date.UTC(2025, 0, 2, 3, 4),
    });
    legacy.close();

    store.ensure();
    const journalPath = join(
      store.root,
      "raw",
      "records",
      "2025",
      "01",
      "02.jsonl",
    );
    expect(readFileSync(journalPath, "utf8")).toContain("legacy SQLite-only message");
    expect(store.index().getRaw(rawId)?.content).toBe("legacy SQLite-only message");
    store.close();
  });

  test("fails closed when an authoritative JSONL record is corrupt", () => {
    const dataDir = tempDir();
    const store = new SpaceStore(SPACE, dataDir);
    store.ensure();
    store.index().insertRaw({
      space: SPACE,
      source: "message",
      content: "must not silently disappear",
      createdAt: Date.UTC(2026, 7, 20),
    });
    const journalPath = join(
      store.root,
      "raw",
      "records",
      "2026",
      "08",
      "20.jsonl",
    );
    store.close();
    writeFileSync(journalPath, "{broken-json\n", "utf8");

    const reopened = new SpaceStore(SPACE, dataDir);
    expect(() => reopened.ensure()).toThrow("invalid Raw journal JSON");
    reopened.close();
  });
});
