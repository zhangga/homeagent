import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpaceIndex } from "./sqlite.ts";
import { chatRawImportId, parseChatRawImport } from "./chat-raw-import.ts";

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

test("Raw filters run before limiting candidates, including metadata-only file queries", () => {
  const { db } = fixture(); const index = new SpaceIndex(db);
  try {
    const wanted = index.insertRaw({ space, source: "message", author: "小王", chatId: "oc_source", content: "发布结论：已验收", createdAt: 200,
      attachments: [{ kind: "file", ref: "file_report", name: "发布说明.md" }] });
    index.insertRaw({ space, source: "message", author: "小王", chatId: "oc_source", content: "发布结论：旧消息", createdAt: 199 });
    index.insertRaw({ space, source: "message", author: "小王", chatId: "oc_source", content: "发布结论：区间之外", createdAt: 300 });
    for (let i = 0; i < 30; i++) index.insertRaw({ space, source: "manual", author: "其他人", chatId: "oc_other", content: "发布结论 发布结论", createdAt: 250 });
    expect(index.searchRaw("发布结论", 1, { from: 200, to: 300, author: "小王", chatId: "oc_source", source: "message" }).map(raw => raw.id)).toEqual([wanted]);
    expect(index.searchRaw("", 20, { fileName: "发布说明.md" }).map(raw => raw.id)).toEqual([wanted]);
    expect(index.searchRaw("", 20, { author: "小王", from: 200, to: 300 }).map(raw => raw.id)).toEqual([wanted]);
    expect(index.searchRaw("", 20)).toEqual([]);
    expect(index.searchRaw("!!!", 20, { author: "小王" })).toEqual([]);
    expect(index.searchRaw("发布结论", 20, { author: "小王' OR 1=1 --" })).toEqual([]);
    expect(() => index.searchRaw("发布", 20, { author: "a".repeat(513) })).toThrow("Invalid Raw search filters");
    expect(index.searchRaw("发布", 20, { author: "a".repeat(512) })).toEqual([]);
    expect(() => index.searchRaw("发布", 20, { from: NaN })).toThrow("Invalid Raw search filters");
    expect(() => index.searchRaw("发布", 20, { from: 300, to: 200 })).toThrow("Invalid Raw search filters");
  } finally { index.close(); }
});

test("source-name projection backfills legacy databases and rebuilds from the Raw journal", () => {
  const { db, rawDir } = fixture();
  let index = new SpaceIndex(db, { rawDir, space });
  const parsed = parseChatRawImport(JSON.stringify({ version: 1, chatId: "oc_source", chatName: "ＰＳＴ 专项", startAt: 100, endAt: 300,
    mainComplete: true, threadsComplete: true, olderThreadsScanned: true, failedMessageIds: [],
    messages: [{ messageId: "om_source", createdAt: 200, text: "发布结论：来自指定群" }] }), space, "oc_search", { requestedName: "PST专项" });
  const id = chatRawImportId(space, "oc_source", "om_source");
  index.captureImportedRaw(id, parsed.entries[0]!);
  index.insertRaw({ space, source: "manual", content: "发布结论：正文提到了 PST 专项，但它不是来源群。" });
  expect(index.searchRaw("发布结论", 20, { chatName: "pst专项" }).map(raw => raw.id)).toEqual([id]);
  index.close();
  const legacy = new Database(db); legacy.run("ALTER TABLE raw DROP COLUMN source_chat_name"); legacy.close();
  index = new SpaceIndex(db);
  expect(index.searchRaw("发布结论", 20, { chatName: "PST 专项" }).map(raw => raw.id)).toEqual([id]);
  index.close();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(db + suffix, { force: true });
  index = new SpaceIndex(db, { rawDir, space });
  try { expect(index.searchRaw("", 20, { chatName: "ＰＳＴ专项" }).map(raw => raw.id)).toEqual([id]); } finally { index.close(); }
});

test("metadata-only Raw searches still exclude held, rejected and retracted evidence", () => {
  const { db } = fixture(); const index = new SpaceIndex(db);
  try {
    index.insertRaw({ space, source: "task", author: "小王", admission: "held", workActionId: "held", content: "发布结论：未验收" });
    const rejected = index.insertRaw({ space, source: "task", author: "小王", admission: "held", workActionId: "rejected", content: "发布结论：已驳回" });
    index.excludeRawAdmission(rejected, "rejected");
    index.insertRaw({ space, source: "message", author: "小王", chatId: "oc_source", messageId: "om_retracted", content: "发布结论：已撤回" });
    index.recordMessageRetraction({ chatId: "oc_source", messageId: "om_retracted", originalAuthor: "小王", retractedBy: "小王" });
    expect(index.searchRaw("", 20, { author: "小王" })).toEqual([]);
    expect(index.searchRaw("发布结论", 20, { author: "小王" })).toEqual([]);
  } finally { index.close(); }
});
