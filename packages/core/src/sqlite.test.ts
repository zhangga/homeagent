import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpaceIndex } from "./sqlite.ts";
import type { Page, RawEntry } from "@homeagent/shared";

let dir: string;
let idx: SpaceIndex;

function page(slug: string, title: string, content: string, extra: Partial<Page> = {}): Page {
  return {
    slug,
    type: "entity",
    title,
    summary: content.slice(0, 40),
    aliases: [],
    tags: [],
    sources: [],
    links: [],
    content,
    updatedAt: Date.now(),
    contentHash: "h",
    ...extra,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hb-sqlite-"));
  idx = new SpaceIndex(join(dir, "test.db"));
});

afterEach(() => {
  idx.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("SpaceIndex pages + search", () => {
  test("upsert then get", () => {
    const p = page("entities/alice", "Alice", "Alice 负责后端服务");
    idx.upsertPage(p);
    const got = idx.getPage("entities/alice");
    expect(got?.title).toBe("Alice");
    expect(idx.countPages()).toBe(1);
  });

  test("two-character Chinese query matches (the trigram failure case)", () => {
    idx.upsertPage(page("entities/alice", "Alice", "Alice 负责后端服务的开发工作"));
    idx.upsertPage(page("entities/bob", "Bob", "Bob 主要做前端界面设计"));
    // These 2-char queries return ZERO rows under the trigram tokenizer.
    expect(idx.search("后端").map((h) => h.slug)).toEqual(["entities/alice"]);
    expect(idx.search("服务").map((h) => h.slug)).toEqual(["entities/alice"]);
    expect(idx.search("前端").map((h) => h.slug)).toEqual(["entities/bob"]);
  });

  test("ascii search is case-insensitive", () => {
    idx.upsertPage(page("entities/alice", "Alice", "runs the API gateway"));
    expect(idx.search("api").map((h) => h.slug)).toEqual(["entities/alice"]);
  });

  test("upsert updates existing row and reindexes fts", () => {
    idx.upsertPage(page("entities/x", "X", "旧内容关于数据库"));
    idx.upsertPage(page("entities/x", "X", "新内容关于缓存"));
    expect(idx.search("缓存").length).toBe(1);
    expect(idx.search("数据").length).toBe(0);
    expect(idx.countPages()).toBe(1);
  });

  test("delete removes page and fts entry", () => {
    idx.upsertPage(page("entities/x", "X", "关于缓存的内容"));
    idx.deletePage("entities/x");
    expect(idx.getPage("entities/x")).toBeNull();
    expect(idx.search("缓存").length).toBe(0);
  });

  test("listPages filters by type", () => {
    idx.upsertPage(page("entities/a", "A", "aaa", { type: "entity" }));
    idx.upsertPage(page("concepts/c", "C", "ccc", { type: "concept" }));
    expect(idx.listPages("entity").map((r) => r.slug)).toEqual(["entities/a"]);
    expect(idx.listPages().length).toBe(2);
  });
});

describe("SpaceIndex raw capture", () => {
  const raw = (content: string): RawEntry => ({
    space: "team/oc_1",
    source: "message",
    author: "ou_a",
    chatId: "oc_1",
    content,
  });

  test("insert then list pending", () => {
    const id = idx.insertRaw(raw("hello"));
    expect(typeof id).toBe("string");
    const pending = idx.listRaw({ onlyPending: true });
    expect(pending.length).toBe(1);
    expect(pending[0]!.content).toBe("hello");
    expect(pending[0]!.ingested).toBe(false);
  });

  test("markIngested flips the flag", () => {
    const id = idx.insertRaw(raw("hi"));
    idx.markIngested([id]);
    expect(idx.countRaw(true)).toBe(0);
    expect(idx.countRaw(false)).toBe(1);
    expect(idx.getRaw(id)?.ingested).toBe(true);
  });

  test("attachments roundtrip through json", () => {
    const id = idx.insertRaw({
      ...raw("with image"),
      attachments: [{ kind: "image", ref: "img_key_1", name: "a.png" }],
    });
    const rec = idx.getRaw(id);
    expect(rec?.attachments?.[0]?.kind).toBe("image");
    expect(rec?.attachments?.[0]?.ref).toBe("img_key_1");
  });

  test("findRecentRawsByChat is scoped, bounded, and newest first", () => {
    idx.insertRaw({ ...raw("old"), messageId: "om_old", createdAt: 100 });
    idx.insertRaw({ ...raw("new"), messageId: "om_new", createdAt: 300 });
    idx.insertRaw({
      ...raw("other chat"),
      chatId: "oc_other",
      messageId: "om_other",
      createdAt: 400,
    });
    idx.insertRaw({ ...raw("future"), messageId: "om_future", createdAt: 500 });

    expect(idx.findRecentRawsByChat("oc_1", 400, 2).map((record) => record.content))
      .toEqual(["new", "old"]);
  });

  test("legacy message rows remain visible only through explicit Agent-history fallback", () => {
    const path = join(dir, "legacy.db");
    const database = new Database(path, { create: true });
    database.run(`
      CREATE TABLE raw (
        id TEXT PRIMARY KEY,
        space TEXT NOT NULL,
        source TEXT NOT NULL,
        author TEXT,
        chat_id TEXT,
        message_id TEXT,
        content TEXT NOT NULL,
        attachments_json TEXT NOT NULL DEFAULT '[]',
        created INTEGER NOT NULL,
        ingested INTEGER NOT NULL DEFAULT 0
      )
    `);
    database.query(`
      INSERT INTO raw
        (id, space, source, author, chat_id, message_id, content, created)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "legacy-message",
      "team/oc_1",
      "message",
      "ou_a",
      "oc_1",
      "om_legacy",
      "@HomeAgent legacy chat",
      100,
    );
    database.close();

    const migrated = new SpaceIndex(path);
    expect(migrated.listAgentChatRaws("agent_current", {
      includeLegacy: false,
      limit: 10,
    })).toEqual([]);
    expect(migrated.listAgentChatRaws("agent_current", {
      includeLegacy: true,
      limit: 10,
    })).toEqual([
      expect.objectContaining({
        id: "legacy-message",
        content: "@HomeAgent legacy chat",
      }),
    ]);
    expect(migrated.getRaw("legacy-message")?.agentResponse).toBeUndefined();
    expect(migrated.recordAgentResponse(
      "oc_1",
      "om_legacy",
      "这是升级后保存的回复。",
      200,
    )).toBeTrue();
    expect(migrated.getRaw("legacy-message")).toEqual(expect.objectContaining({
      agentResponse: "这是升级后保存的回复。",
      agentRespondedAt: 200,
    }));
    migrated.close();
  });
});

describe("SpaceIndex rebuild", () => {
  test("rebuildFromPages replaces all rows", () => {
    idx.upsertPage(page("entities/old", "Old", "旧的"));
    idx.rebuildFromPages([page("entities/new", "New", "新的关于测试")]);
    expect(idx.getPage("entities/old")).toBeNull();
    expect(idx.getPage("entities/new")).not.toBeNull();
    expect(idx.search("测试").length).toBe(1);
  });
});
