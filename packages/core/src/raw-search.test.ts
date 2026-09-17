import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpaceIndex } from "./sqlite.ts";

const space = "team/oc_search" as const;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() { const dir = mkdtempSync(join(tmpdir(), "ha-raw-search-")); roots.push(dir); return { db: join(dir, "index.db"), rawDir: join(dir, "raw") }; }

test("Raw FTS finds Chinese text before Dream, bounds queries, and follows deletion and admission", () => {
  const { db } = fixture(); const index = new SpaceIndex(db);
  try {
    const id = index.insertRaw({ space, source: "manual", content: "国际服更新后 150—200ms 长帧 198 条。", chatId: "oc_source", messageId: "om_one" });
    const held = index.insertRaw({ space, source: "task", admission: "held", workActionId: "action_one", content: "国际服长帧待验收数据" });
    expect(index.searchRaw("长帧").map(raw => raw.id)).toEqual([id]);
    expect(index.searchRaw("长帧", 0)).toEqual([]);
    expect(index.searchRaw("长帧", Infinity)).toEqual([]);
    expect(index.searchRaw("!!!")).toEqual([]);
    expect(index.searchRaw('长帧" OR *')).toHaveLength(1);
    index.promoteRawAdmission(held, "action_one");
    expect(index.searchRaw("长帧")).toHaveLength(2);
    index.deleteRaw(held);
    index.recordMessageRetraction({ chatId: "oc_source", messageId: "om_one", originalAuthor: "ou_one", retractedBy: "ou_one" });
    expect(index.searchRaw("长帧")).toEqual([]);
    index.deleteRaw(id);
    expect(index.searchRaw("长帧")).toEqual([]);
  } finally { index.close(); }
});

test("Raw search backfills existing SQLite records and rebuilds from the authoritative journal", () => {
  const { db, rawDir } = fixture(); let index = new SpaceIndex(db);
  const id = index.insertRaw({ space, source: "manual", content: "国际服长帧 198 条" }); index.close();
  const legacy = new Database(db); legacy.run("DROP TABLE raw_fts"); legacy.close();
  index = new SpaceIndex(db, { rawDir, space });
  expect(index.searchRaw("长帧")[0]?.id).toBe(id); index.close();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(db + suffix, { force: true });
  index = new SpaceIndex(db, { rawDir, space });
  try { expect(index.searchRaw("长帧")[0]?.id).toBe(id); } finally { index.close(); }
});

test("failed Raw FTS insertion rolls back the SQL row and is recovered from the committed journal", () => {
  const { db, rawDir } = fixture(); let index = new SpaceIndex(db, { rawDir, space });
  const fault = new Database(db);
  // An invalid FTS table makes projection insertion fail after the journal commit.
  fault.run("DROP TABLE raw_fts"); fault.run("CREATE TABLE raw_fts (id TEXT, body TEXT CHECK(body = 'reject-all'))"); fault.close();
  expect(() => index.insertRaw({ space, source: "manual", content: "长帧可恢复证据" })).toThrow();
  expect(index.listRaw()).toHaveLength(0); index.close();
  const repair = new Database(db); repair.run("DROP TABLE raw_fts"); repair.close();
  index = new SpaceIndex(db, { rawDir, space });
  try { expect(index.searchRaw("长帧")).toHaveLength(1); } finally { index.close(); }
});

test("retention counts only deleted Raw and removes its FTS entry in the same operation", () => {
  const { db } = fixture(); const index = new SpaceIndex(db);
  try {
    const id = index.insertRaw({ space, source: "message", content: "过期长帧记录", createdAt: 100 });
    index.markIngested([id]);
    expect(index.deleteExpiredRawMessages(200)).toBe(1);
    expect(index.searchRaw("长帧")).toEqual([]);
    expect(index.countRaw()).toBe(0);
  } finally { index.close(); }
});
