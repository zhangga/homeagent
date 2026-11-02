import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MATERIAL_PART_CHARACTERS, MAX_MATERIAL_BYTES, type RawEntry } from "@homeagent/shared";
import { KnowledgeEngine } from "./engine.ts";
import { RawJournal } from "./raw-journal.ts";
import { SkillCatalog } from "./skill-catalog.ts";

const space = "team/oc_report" as const;
const entry: RawEntry = { space, source: "message", chatId: "oc_report", messageId: "om_report", author: "bot_report",
  content: "工作周报：完成 49 个事项，共 63 条记录。", createdAt: 1793577600000 };
let root: string;
const engines: KnowledgeEngine[] = [];
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "ha-message-text-")); });
afterEach(() => { for (const engine of engines.splice(0)) engine.close(); rmSync(root, { recursive: true, force: true }); });
function openEngine(): KnowledgeEngine {
  const engine = new KnowledgeEngine({ dataDir: root, skillCatalog: new SkillCatalog({ roots: [] }) });
  engines.push(engine);
  return engine;
}

test("message text retries are idempotent, edits and Spaces remain distinct, and reopened state is preserved", async () => {
  const engine = openEngine();
  const input = structuredClone(entry);
  const pending = engine.rememberMessageText(input);
  input.content = "caller mutation";
  const id = await pending;
  expect(await engine.rememberMessageText(entry)).toBe(id);
  const edited = await engine.rememberMessageText({ ...entry, content: `${entry.content}\n新增事项。` });
  expect(edited).not.toBe(id);
  const personal = await engine.rememberMessageText({ ...entry, space: "personal/ou_fixture" });
  expect(personal).not.toBe(id);
  expect(engine.registry.store(space).index().countRaw()).toBe(2);
  engine.close();
  const reopened = openEngine();
  expect(await reopened.rememberMessageText(entry)).toBe(id);
  expect(reopened.registry.store(space).index().getRaw(id)).toEqual(expect.objectContaining({
    content: entry.content, author: entry.author, createdAt: entry.createdAt, admission: "ready", agentHandled: false,
  }));
  expect(reopened.registry.store(space).index().countRaw()).toBe(2);
});

test("a journal commit followed by projection failure is repaired without a duplicate, including after reopen", async () => {
  const engine = openEngine();
  engine.ensureSpace(space);
  const store = engine.registry.store(space);
  const db = new Database(store.dbPath);
  try {
    db.exec("CREATE TRIGGER fail_message BEFORE INSERT ON raw BEGIN SELECT RAISE(FAIL, 'private fixture diagnostic'); END");
    await expect(engine.rememberMessageText(entry)).rejects.toThrow();
    const journal = new RawJournal(join(store.root, "raw"), space);
    expect(journal.listRaw()).toHaveLength(1);
    const id = journal.listRaw()[0]!.id;
    db.exec("DROP TRIGGER fail_message");
    expect(await engine.rememberMessageText(entry)).toBe(id);
    expect(new RawJournal(join(store.root, "raw"), space).listRaw()).toHaveLength(1);
    engine.close();
    const reopened = openEngine();
    expect(await reopened.rememberMessageText(entry)).toBe(id);
    expect(reopened.registry.store(space).index().countRaw()).toBe(1);
  } finally { db.close(); }
});

test("message text validation retains existing material limits and never promotes excluded or retracted evidence", async () => {
  const engine = openEngine();
  for (const invalid of [
    { ...entry, source: "doc" as const }, { ...entry, chatId: "" }, { ...entry, messageId: "" },
    { ...entry, content: "x".repeat(MAX_MATERIAL_BYTES + 1) },
    { ...entry, attachments: [{ kind: "file" as const, ref: "file" }] },
    { ...entry, admission: "held" as const },
  ]) await expect(engine.rememberMessageText(invalid)).rejects.toThrow();
  engine.ensureSpace(space);
  expect(engine.registry.store(space).index().countRaw()).toBe(0);
  const bounded = await engine.rememberMessageText({ ...entry, content: "x".repeat(MATERIAL_PART_CHARACTERS) });
  expect(engine.registry.store(space).index().getRaw(bounded)?.content).toHaveLength(MATERIAL_PART_CHARACTERS);
  const id = await engine.rememberMessageText(entry);
  const journal = new RawJournal(join(engine.registry.store(space).root, "raw"), space);
  journal.replaceMany([{ ...journal.getRaw(id)!, admission: "excluded" }]);
  engine.close();
  const reopened = openEngine();
  expect(await reopened.rememberMessageText(entry)).toBe(id);
  expect(reopened.registry.store(space).index().getRaw(id)?.admission).toBe("excluded");
  await reopened.retractMessage(space, { chatId: entry.chatId!, messageId: entry.messageId!, requestedBy: entry.author! });
  expect(await reopened.rememberMessageText(entry)).toBe(`retracted:${entry.messageId}`);
  expect(reopened.registry.store(space).index().findRawsByMessageId(entry.messageId!, entry.chatId!)).toHaveLength(0);
});
