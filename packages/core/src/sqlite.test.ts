import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpaceIndex } from "./sqlite.ts";
import type { Page, RawEntry, RawRecord } from "@homeagent/shared";

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

  test("page writes cannot cite held or excluded WorkAction Raw", () => {
    const rawId = idx.insertRaw({
      space: "team/oc_1",
      source: "task",
      workActionId: "action-page-admission",
      admission: "held",
      content: "candidate evidence",
    });
    const candidate = page("entities/candidate", "Candidate", "must stay hidden", {
      sources: [rawId],
    });

    expect(() => idx.upsertPage(candidate)).toThrow("not admitted");
    expect(idx.getPage(candidate.slug)).toBeNull();
    expect(idx.excludeRawAdmission(rawId, "action-page-admission")).toBe(true);
    expect(() => idx.upsertPage(candidate)).toThrow("not admitted");
    expect(idx.getPage(candidate.slug)).toBeNull();
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
    expect(pending[0]!.admission).toBe("ready");
  });

  test("raw listings order equal creation times by durable id", () => {
    const records = [
      { id: "raw-c", content: "third by id" },
      { id: "raw-a", content: "first by id" },
      { id: "raw-b", content: "second by id" },
    ].map(({ id, content }) => ({
      ...raw(content),
      id,
      createdAt: 100,
      ingested: false,
      admission: "ready" as const,
    } satisfies RawRecord));
    for (const record of records) idx.restoreRaw(record);

    expect(idx.listRaw().map((record) => record.id)).toEqual([
      "raw-a",
      "raw-b",
      "raw-c",
    ]);
    expect(idx.listRaw({ limit: 2 }).map((record) => record.id)).toEqual([
      "raw-a",
      "raw-b",
    ]);
    expect(idx.listRawByIds(["raw-c", "raw-a", "raw-b"]).map((record) => record.id))
      .toEqual(["raw-a", "raw-b", "raw-c"]);
    expect(idx.listRawByIds(
      ["raw-c", "raw-a", "raw-b"],
      { limit: 2 },
    ).map((record) => record.id)).toEqual(["raw-a", "raw-b"]);
  });

  test("raw listing limit zero returns no records consistently", () => {
    const ids = [idx.insertRaw(raw("first")), idx.insertRaw(raw("second"))];

    expect(idx.listRaw({ limit: 0 })).toEqual([]);
    expect(idx.listRawByIds(ids, { limit: 0 })).toEqual([]);
  });

  test("held WorkAction raw remains auditable but is not pending for distillation", () => {
    const id = idx.insertRaw({
      ...raw("candidate result"),
      source: "task",
      workActionId: "action-1",
      admission: "held",
    });

    expect(idx.listRaw({ onlyPending: true })).toEqual([]);
    expect(idx.getRaw(id)).toEqual(expect.objectContaining({
      admission: "held",
      workActionId: "action-1",
    }));
    expect(idx.listRaw()).toEqual([
      expect.objectContaining({ id, admission: "held", workActionId: "action-1" }),
    ]);
  });

  test("listRaw can require admission independently from ingestion", () => {
    const readyId = idx.insertRaw(raw("already distilled"));
    idx.markIngested([readyId]);
    idx.insertRaw({
      ...raw("held candidate"),
      source: "task",
      workActionId: "action-held-list",
      admission: "held",
    });

    expect(idx.listRaw({ onlyAdmitted: true }).map((record) => record.id)).toEqual([readyId]);
    expect(idx.listRaw({ onlyPending: true })).toEqual([]);
  });

  test("new WorkAction raw must start as a held task owned by an action", () => {
    expect(() => idx.insertRaw({
      ...raw("wrong source"),
      workActionId: "action-invalid-source",
      admission: "held",
    })).toThrow();
    expect(() => idx.insertRaw({
      ...raw("already admitted"),
      source: "task",
      workActionId: "action-invalid-ready",
      admission: "ready",
    })).toThrow();
    expect(() => idx.insertRaw({
      ...raw("owner missing"),
      source: "task",
      admission: "held",
    })).toThrow();
    expect(() => idx.insertRaw({
      ...raw("born excluded"),
      source: "task",
      workActionId: "action-invalid-excluded",
      admission: "excluded",
    })).toThrow();
    expect(idx.countRaw()).toBe(0);
  });

  test("promoting held raw admits it exactly once and remains idempotent", () => {
    const id = idx.insertRaw({
      ...raw("accepted candidate"),
      source: "task",
      workActionId: "action-accept",
      admission: "held",
    });

    expect(idx.promoteRawAdmission(id, "action-accept")).toBeTrue();
    expect(idx.promoteRawAdmission(id, "action-accept")).toBeTrue();
    expect(idx.excludeRawAdmission(id, "action-accept")).toBeFalse();
    expect(idx.getRaw(id)?.admission).toBe("ready");
    expect(idx.listRaw({ onlyPending: true }).map((record) => record.id)).toEqual([id]);
  });

  test("excluding held raw is owner-bound, idempotent, and terminal", () => {
    const id = idx.insertRaw({
      ...raw("rejected candidate"),
      source: "task",
      workActionId: "action-reject",
      admission: "held",
    });

    expect(idx.excludeRawAdmission(id, "different-action")).toBeFalse();
    expect(idx.getRaw(id)?.admission).toBe("held");
    expect(idx.excludeRawAdmission(id, "action-reject")).toBeTrue();
    expect(idx.excludeRawAdmission(id, "action-reject")).toBeTrue();
    expect(idx.promoteRawAdmission(id, "action-reject")).toBeFalse();
    expect(idx.getRaw(id)?.admission).toBe("excluded");
    expect(idx.listRaw({ onlyPending: true })).toEqual([]);
  });

  test("listRawByIds can require admission independently from ingestion", () => {
    const readyId = idx.insertRaw({
      ...raw("already distilled but admitted"),
      createdAt: 100,
    });
    idx.markIngested([readyId]);
    const heldId = idx.insertRaw({
      ...raw("held"),
      source: "task",
      workActionId: "action-held",
      admission: "held",
      createdAt: 200,
    });
    const excludedId = idx.insertRaw({
      ...raw("excluded"),
      source: "task",
      workActionId: "action-excluded",
      admission: "held",
      createdAt: 300,
    });
    expect(idx.excludeRawAdmission(excludedId, "action-excluded")).toBeTrue();

    const ids = [readyId, heldId, excludedId];
    expect(idx.listRawByIds(ids).map((record) => record.id)).toEqual(ids);
    expect(idx.listRawByIds(ids, { onlyAdmitted: true }).map((record) => record.id))
      .toEqual([readyId]);
    expect(idx.listRawByIds(ids, { onlyPending: true, onlyAdmitted: true })).toEqual([]);
  });

  test("pending and admission counts keep held and excluded raw distinct", () => {
    idx.insertRaw(raw("ready"));
    idx.insertRaw({
      ...raw("held"),
      source: "task",
      workActionId: "action-held-count",
      admission: "held",
    });
    const excludedId = idx.insertRaw({
      ...raw("excluded"),
      source: "task",
      workActionId: "action-excluded-count",
      admission: "held",
    });
    expect(idx.excludeRawAdmission(excludedId, "action-excluded-count")).toBeTrue();

    expect(idx.countRaw(true)).toBe(1);
    expect(idx.countRawByAdmission("ready")).toBe(1);
    expect(idx.countRawByAdmission("held")).toBe(1);
    expect(idx.countRawByAdmission("excluded")).toBe(1);
  });

  test("startup reconciliation can bind a legacy task raw to its WorkAction", () => {
    const id = idx.insertRaw({ ...raw("legacy candidate"), source: "task" });

    expect(idx.reconcileWorkActionRawAdmission(id, "action-legacy", "held")).toBeTrue();
    expect(idx.reconcileWorkActionRawAdmission(id, "action-legacy", "held")).toBeTrue();
    expect(idx.getRaw(id)).toEqual(expect.objectContaining({
      workActionId: "action-legacy",
      admission: "held",
    }));
    expect(idx.listRaw({ onlyPending: true })).toEqual([]);
  });

  test("startup reconciliation cannot steal another action or bind non-task raw", () => {
    const taskId = idx.insertRaw({
      ...raw("owned candidate"),
      source: "task",
      workActionId: "action-owner",
      admission: "held",
    });
    const messageId = idx.insertRaw(raw("ordinary message"));

    expect(idx.reconcileWorkActionRawAdmission(
      taskId,
      "action-intruder",
      "excluded",
    )).toBeFalse();
    expect(idx.reconcileWorkActionRawAdmission(
      messageId,
      "action-intruder",
      "held",
    )).toBeFalse();
    expect(idx.getRaw(taskId)).toEqual(expect.objectContaining({
      workActionId: "action-owner",
      admission: "held",
    }));
    expect(idx.getRaw(messageId)).toEqual(expect.objectContaining({ admission: "ready" }));
  });

  test("listRawsByWorkAction finds orphan candidates in stable order", () => {
    const second = idx.insertRaw({
      ...raw("second candidate"),
      source: "task",
      workActionId: "action-orphan",
      admission: "held",
      createdAt: 100,
    });
    const first = idx.insertRaw({
      ...raw("first candidate"),
      source: "task",
      workActionId: "action-orphan",
      admission: "held",
      createdAt: 100,
    });
    idx.insertRaw({
      ...raw("different action"),
      source: "task",
      workActionId: "action-other",
      admission: "held",
      createdAt: 50,
    });

    expect(idx.listRawsByWorkAction("action-orphan").map((record) => record.id))
      .toEqual([first, second].sort());
    expect(idx.listRawsByWorkAction("  ")).toEqual([]);
  });

  test("restoreRaw preserves WorkAction admission provenance", () => {
    idx.restoreRaw({
      id: "raw-archive-1",
      space: "team/oc_1",
      source: "task",
      workItemId: "work-1",
      workActionId: "action-archive-1",
      content: "archived rejected result",
      createdAt: 123,
      ingested: false,
      admission: "excluded",
    });

    expect(idx.getRaw("raw-archive-1")).toEqual(expect.objectContaining({
      workItemId: "work-1",
      workActionId: "action-archive-1",
      admission: "excluded",
    }));
    expect(idx.listRaw({ onlyPending: true })).toEqual([]);
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
    expect(migrated.getRaw("legacy-message")).toEqual(expect.objectContaining({
      admission: "ready",
    }));
    expect(migrated.getRaw("legacy-message")?.workActionId).toBeUndefined();
    expect(migrated.listRaw({ onlyPending: true }).map((record) => record.id))
      .toEqual(["legacy-message"]);
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
