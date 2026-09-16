import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { KnowledgeEngine } from "./engine.ts";
import { SkillCatalog } from "./skill-catalog.ts";
import { RawJournal } from "./raw-journal.ts";
import { parseSpaceArchive } from "./governance.ts";
import * as durable from "./durable-file.ts";
import { chatRawImportId, chatRawSourceScope, createChatRawCapture, isChatRawScopeSkip, MAX_CHAT_IMPORT_BYTES, MAX_CHAT_IMPORT_MESSAGES, MAX_CHAT_IMPORT_TEXT, parseChatRawImport, readChatRawCapture, requestsChatRawImport, resolveChatRawImportRequest } from "./chat-raw-import.ts";

const space = "team/oc_capture" as const;
let dir: string;
const engines: KnowledgeEngine[] = [];
beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), "ha-chat-import-"))); });
afterEach(() => { for (const engine of engines.splice(0)) engine.close(); rmSync(dir, { recursive: true, force: true }); });
function manifest() {
  return { version: 1, chatId: "oc_capture", startAt: 1000, endAt: 2000,
    mainComplete: true, threadsComplete: true, olderThreadsScanned: false, failedMessageIds: ["om_failed"],
    messages: [{ messageId: "om_source", createdAt: 1500, author: "ou_sender", text: "已热更，等待玩家回归验证。",
      threadId: "omt_source", rootMessageId: "om_root", url: "https://applink.feishu.cn/client/message/open?messageId=om_source",
      attachments: [{ kind: "file", ref: "file_large", name: "2GB日志.zip", sizeBytes: 2 * 1024 ** 3 }] }] };
}
function fixture(input = "飞书群：本群 提炼最近一周，并记录相关的原始数据") {
  const dataDir = join(dir, "data"), workdir = join(dir, "work"); mkdirSync(workdir);
  const engine = new KnowledgeEngine({ dataDir, skillCatalog: new SkillCatalog({ roots: [] }), runProvider: async () => { throw new Error("No provider calls expected"); } });
  engines.push(engine);
  engine.ensureSpace(space, { chatId: "oc_capture" });
  engine.feishuBindings.connect({ spaceId: space, chatId: "oc_capture", boundAppId: "fixture", responseMode: "mentions_only", replyInThread: true });
  const agent = engine.agents.create({ provider: "codex" });
  engine.registry.updateMeta(space, { agentId: agent.id });
  const draft = engine.agents.saveDraft(agent.id, { executionMode: "local-full-access", permission: "full", workdir })!;
  engine.localExecution.release(agent.id, draft.id, draft.id, { termsVersion: 1, source: "local-operator", taskExecutionEnabled: false,
    expectedScopeFingerprint: engine.localExecution.preview(agent.id, draft.id).fingerprint });
  const plan = engine.agentRunExecutionSnapshot(space).executionPlan;
  const run = engine.chatRuns.start({ space, chatId: "oc_capture", agentId: agent.id, input, trigger: "message", executionPlan: plan });
  engine.chatRuns.begin(run.id);
  const capture = engine.prepareChatRawImport(run.id)!;
  const file = JSON.parse(capture.instruction.match(/写入 ("[^\n]+?");/u)?.[1] ?? capture.instruction.match(/写入 ("[^\n]+?")；/u)?.[1] ?? '""') as string;
  expect(file).not.toBe("");
  return { engine, capture, file, run, agent, dataDir, workdir };
}

test("recognizes explicit preservation requests, not ordinary queries or source instructions", () => {
  expect(requestsChatRawImport("飞书群 PST 提炼最近一周，并记录相关的原始数据")).toBe(true);
  expect(requestsChatRawImport("查询飞书群最近一周的内容")).toBe(false);
  expect(requestsChatRawImport("查询飞书群原始记录，不要保存")).toBe(false);
  expect(requestsChatRawImport("查询飞书群 PST 最近一周聊天记录")).toBe(false);
  expect(requestsChatRawImport("查询飞书群 PST 最近一周原始记录，不保存")).toBe(false);
  expect(requestsChatRawImport("飞书群：PST 提炼下最近一周主要的内容，并记录下相关的原始数据")).toBe(true);
});

test("external source scope comes from the original named-group request", () => {
  expect(chatRawSourceScope("@HomeAgent 飞书群：PST线上应急处理小组 提炼下最近一周主要的内容，并记录下相关的原始数据"))
    .toEqual({ requestedName: "PST线上应急处理小组" });
  expect(chatRawSourceScope("飞书群 PST 提炼最近一周，并保存原始记录")).toEqual({ requestedName: "PST" });
  expect(chatRawSourceScope("飞书群：「PST 线上应急处理小组」提炼最近一周")).toEqual({ requestedName: "PST线上应急处理小组" });
  expect(chatRawSourceScope("本群保存原始记录")).toEqual({});
  expect(chatRawSourceScope("飞书群：本群 提炼并保存原始数据")).toEqual({});
  expect(chatRawSourceScope("查询 oc_pst 并保存原始记录")).toEqual({ requestedChatId: "oc_pst" });
  expect(chatRawSourceScope("查询 oc_one 与 oc_two 并保存原始记录")).toEqual({});
  expect(chatRawSourceScope("不要查 oc_current，飞书群：PST 提炼一周并保存原始记录")).toEqual({ requestedName: "PST" });
  expect(chatRawSourceScope("飞书群最近一周内容，保存原始记录")).toEqual({});
});

test("topic follow-ups retain preservation and source intent while current changes take precedence", () => {
  const first = "飞书群：PST 提炼最近一周，并记录相关原始数据";
  expect(resolveChatRawImportRequest([first, "再提炼最近两周"])).toEqual({ requestedName: "PST" });
  expect(resolveChatRawImportRequest([first, "谢谢", "继续补查"])).toEqual({ requestedName: "PST" });
  expect(resolveChatRawImportRequest([first, "谢谢"])).toBeUndefined();
  expect(resolveChatRawImportRequest(["再提炼最近两周"])).toBeUndefined();
  expect(resolveChatRawImportRequest([first, "飞书群：性能优化群 提炼最近两周"])).toEqual({ requestedName: "性能优化群" });
  expect(resolveChatRawImportRequest([first, "改查本群最近两周"])).toEqual({});
  expect(resolveChatRawImportRequest([first, "提炼最近两周，不要保存原文"])).toBeUndefined();
  expect(resolveChatRawImportRequest([first, "停止自动入库", "继续提炼"])).toBeUndefined();
  expect(resolveChatRawImportRequest([first, "停止自动入库", "继续提炼并保存原始数据"])).toEqual({ requestedName: "PST" });
  expect(resolveChatRawImportRequest(["飞书群：PST 查询最近两周", "把原始记录入库"])).toEqual({ requestedName: "PST" });
});

test("named external source is saved only in the requesting Space with actual provenance", async () => {
  const { engine, capture, file, run } = fixture("飞书群：PST线上应急处理小组 提炼最近一周，并保存原始记录");
  expect(capture.instruction).toContain("不得用当前群替换目标群");
  expect(capture.instruction).toContain("+chat-search");
  expect(capture.instruction).toContain('"requestedName":"PST线上应急处理小组"');
  const external = { ...manifest(), chatId: "oc_pst", chatName: "PST 线上应急处理小组" };
  await engine.remember({ space, source: "message", chatId: "oc_capture", messageId: "om_source", content: "测试群自己的原文", createdAt: 1001 });
  writeFileSync(file, JSON.stringify(external));
  expect(await capture.finish()).toContain("新增 1 条");
  expect(await capture.finish()).toContain("重复跳过 1 条");
  expect(engine.registry.has("team/oc_pst")).toBe(false);
  expect(engine.registry.get(space)?.chatId).toBe("oc_capture");
  const raw = engine.registry.store(space).index().findRawsByMessageId("om_source", "oc_pst")[0]!;
  expect(raw.space).toBe(space);
  expect(raw.chatId).toBe("oc_pst");
  expect(raw.content).toContain('"chatName":"PST 线上应急处理小组"');
  expect(engine.prepareChatRawImport(run.id)!.instruction).toContain('"sourceChatId":"oc_pst"');
  expect(existsSync(join(engine.registry.store(space).root, ".chat-source-progress.json"))).toBe(false);
  writeFileSync(file, JSON.stringify({ ...external, chatName: "测试 AI", chatId: "oc_capture" }));
  expect(await capture.finish()).toContain("入库未完成");
  expect(engine.registry.store(space).index().listRaw()).toHaveLength(2);
  engine.chatRuns.succeed(run.id, { finishedAt: Date.now(), output: "captured" });
  engine.chatRuns.deliverySent(run.id, Date.now());
  const archive = parseSpaceArchive(await engine.exportSpace(space));
  expect(archive.raw.some(record => record.space === space && record.chatId === "oc_pst")).toBe(true);
  expect(JSON.stringify(archive)).not.toContain('"sourceChatId"');
});

test("external scope cannot be granted by submitted metadata or by a mismatched source ID", () => {
  const external = { ...manifest(), chatId: "oc_pst", chatName: "PST" };
  expect(() => parseChatRawImport(JSON.stringify(external), space, "oc_capture")).toThrow();
  expect(() => parseChatRawImport(JSON.stringify(external), space, "oc_capture", { requestedChatId: "oc_another" })).toThrow();
  expect(() => parseChatRawImport(JSON.stringify(external), space, "oc_capture", { requestedName: "另一群" })).toThrow();
  expect(() => parseChatRawImport(JSON.stringify({ ...external, chatName: undefined }), space, "oc_capture", { requestedName: "PST" })).toThrow();
  expect(parseChatRawImport(JSON.stringify(external), space, "oc_capture", { requestedChatId: "oc_pst" }).entries[0]?.space).toBe(space);
});

test("scope skip reports a disposition without writing Raw or advancing progress", async () => {
  const { engine, capture, file } = fixture();
  const status = { version: 1, status: "source-outside-current-space", chatId: "oc_other" };
  writeFileSync(file, JSON.stringify(status));
  expect(await capture.finish()).toContain("目标群未匹配本轮请求确定的来源范围");
  expect(engine.registry.store(space).index().listRaw()).toHaveLength(0);
  expect(existsSync(join(engine.registry.store(space).root, ".chat-source-progress.json"))).toBe(false);
  expect(() => isChatRawScopeSkip(JSON.stringify({ ...status, messages: [] }), "oc_capture")).toThrow();
  expect(() => isChatRawScopeSkip(JSON.stringify({ ...status, chatId: "oc_capture" }), "oc_capture")).toThrow();
});

test("parses text and thread provenance while retaining huge attachments as references only", () => {
  const parsed = parseChatRawImport(JSON.stringify(manifest()), space, "oc_capture");
  const entry = parsed.entries[0]!;
  expect(entry.source).toBe("manual");
  expect(entry.createdAt).toBe(1500);
  expect(entry.content).toContain("omt_source");
  expect(entry.content).toContain("2147483648");
  expect(entry.content).toEndWith("已热更，等待玩家回归验证。");
  expect(entry.attachments).toEqual([{ kind: "file", ref: "file_large", name: "2GB日志.zip" }]);
  expect(parsed.excluded).toBe(1);
  expect(parsed.incomplete).toBe(true);
});

test("text-only messages may omit attachments and missing bodies do not block valid Raw", async () => {
  const { engine, capture, file } = fixture();
  const base = manifest();
  const messages = Array.from({ length: 182 }, (_, i) => ({ messageId: `om_${i}`, createdAt: 1500, text: `正文 ${i}`,
    ...(i < 36 ? { attachments: Array.from({ length: i < 7 ? 2 : 1 }, (_, j) => ({ kind: "file", ref: `file_${i}_${j}` })) } : {}) }));
  writeFileSync(file, JSON.stringify({ ...base, messages, threadsComplete: false,
    failedMessageIds: Array.from({ length: 7 }, (_, i) => `om_retracted_${i}`) }));
  const receipt = await capture.finish();
  expect(receipt).toContain("新增 182 条");
  expect(receipt).toContain("未收录 7 条");
  expect(receipt).toContain("未推进增量起点");
  const raws = engine.registry.store(space).index().listRaw();
  expect(raws).toHaveLength(182);
  expect(raws.flatMap(raw => raw.attachments ?? [])).toHaveLength(43);
  expect(raws.filter(raw => !raw.attachments?.length)).toHaveLength(146);
  expect(await capture.finish()).toContain("重复跳过 182 条");
});

test("bounds files, message counts, text, metadata and attachments before any capture", () => {
  const base = manifest();
  const invalid = [
    { ...base, chatId: "oc_other" }, { ...base, version: 2 }, { ...base, mainComplete: "true" },
    { ...base, endAt: 999 }, { ...base, messages: [...base.messages, ...base.messages] },
    { ...base, endAt: 253_402_300_800_000 },
    { ...base, failedMessageIds: ["om_source"] },
    ...[{ text: "a".repeat(MAX_CHAT_IMPORT_TEXT + 1) }, { createdAt: 3000 }, { author: "a".repeat(513) },
      { attachments: Array(33).fill(base.messages[0]!.attachments[0]) }, { url: "file:///secret" },
      { text: "[Failed to parse message]" }].map(change => ({ ...base, messages: [{ ...base.messages[0], ...change }] })),
    { ...base, messages: Array(MAX_CHAT_IMPORT_MESSAGES + 1).fill(base.messages[0]) },
  ];
  for (const value of invalid) expect(() => parseChatRawImport(JSON.stringify(value), space, "oc_capture")).toThrow();
  expect(() => parseChatRawImport(" ".repeat(MAX_CHAT_IMPORT_BYTES + 1), space, "oc_capture")).toThrow();
  expect(() => parseChatRawImport(JSON.stringify(base), "personal/ou_requester", "oc_capture")).toThrow();
  expect(parseChatRawImport(JSON.stringify({ ...base, messages: [{ ...base.messages[0], text: "a".repeat(MAX_CHAT_IMPORT_TEXT) }] }), space, "oc_capture").entries).toHaveLength(1);
});

test("capture reads only the host-chosen file and rejects oversized files and links", () => {
  const capture = createChatRawCapture(dir, "oc_capture");
  writeFileSync(capture.file, JSON.stringify(manifest()));
  expect(readChatRawCapture(capture)).toContain("om_source");
  const outside = join(dir, "other.json"); writeFileSync(outside, "private");
  expect(() => readChatRawCapture({ ...capture, file: outside })).toThrow();
  rmSync(capture.file);
  linkSync(outside, capture.file);
  expect(() => readChatRawCapture(capture)).toThrow();
  rmSync(capture.file);
  symlinkSync(outside, capture.file, "file");
  expect(() => readChatRawCapture(capture)).toThrow();
  rmSync(capture.file);
  writeFileSync(capture.file, Buffer.alloc(MAX_CHAT_IMPORT_BYTES + 1));
  expect(() => readChatRawCapture(capture)).toThrow();
});

test("imports through Raw journal, deduplicates retries and reopens without attachment downloads", async () => {
  const { engine, capture, file, dataDir, run } = fixture();
  writeFileSync(file, JSON.stringify(manifest()));
  expect(await capture.finish()).toContain("新增 1 条");
  expect(await capture.finish()).toContain("重复跳过 1 条");
  const records = engine.registry.store(space).index().listRaw();
  expect(records).toHaveLength(1);
  expect(records[0]?.admission).toBe("ready");
  expect(records[0]?.ingested).toBe(false);
  const sources = engine.registry.store(space).rawSourceFiles.root;
  expect(!existsSync(sources) || readdirSync(sources).length === 0).toBe(true);
  engine.chatRuns.succeed(run.id, { finishedAt: Date.now(), output: "captured" });
  engine.chatRuns.deliverySent(run.id, Date.now());
  engine.close(); engines.splice(engines.indexOf(engine), 1);
  const reopened = new KnowledgeEngine({ dataDir, skillCatalog: new SkillCatalog({ roots: [] }) }); engines.push(reopened);
  expect(reopened.registry.store(space).index().listRaw()).toEqual(records);
  const archive = await reopened.exportSpace(space);
  expect(archive.raw).toHaveLength(1);
  expect(JSON.stringify(archive)).not.toContain('"retryStartAt"');
  const progressFile = join(reopened.registry.store(space).root, ".chat-source-progress.json");
  expect(JSON.parse(readFileSync(progressFile, "utf8")).retryStartAt).toBe(1000);
  expect((await reopened.deleteSpace(space)).status).toBe("deleted");
  expect(existsSync(progressFile)).toBe(false);
});

test("invalid later messages cause zero writes, and existing/retracted messages are skipped", async () => {
  const { engine, capture, file } = fixture();
  const base = manifest();
  writeFileSync(file, JSON.stringify({ ...base, messages: [...base.messages, { ...base.messages[0], messageId: "om_bad", createdAt: -1 }] }));
  expect(await capture.finish()).toContain("入库未完成");
  expect(engine.registry.store(space).index().listRaw()).toHaveLength(0);
  await engine.remember({ space, source: "message", chatId: "oc_capture", messageId: "om_source", content: "监听已收录原文", createdAt: 1500 });
  writeFileSync(file, JSON.stringify(base));
  expect(await capture.finish()).toContain("重复跳过 1 条");
  engine.registry.store(space).index().recordMessageRetraction({ chatId: "oc_capture", messageId: "om_source", originalAuthor: "ou_sender", retractedBy: "ou_sender" });
  expect(await capture.finish()).toContain("未收录 2 条");
});

test.each(["cancel", "revoke", "binding", "workdir"] as const)("rechecks authorization before import: %s", async (change) => {
  const { engine, capture, file, run, agent, workdir } = fixture();
  writeFileSync(file, JSON.stringify(manifest()));
  if (change === "cancel") engine.chatRuns.cancel(run.id, { finishedAt: Date.now(), error: { kind: "cancelled", message: "cancelled" } });
  if (change === "revoke") engine.agents.revokeLocalExecutionGrants(agent.id, engine.agents.get(agent.id)!.publishedRevisionId!);
  if (change === "binding") engine.feishuBindings.updatePolicy(space, { responseMode: "all_messages" });
  if (change === "workdir") { rmSync(file); rmdirSync(workdir); }
  expect(await capture.finish()).toContain("入库未完成");
  expect(engine.registry.store(space).index().listRaw()).toHaveLength(0);
});

test("persistence failure preserves earlier entries and retries without duplicate Raw", async () => {
  const { engine, capture, file } = fixture();
  const base = manifest();
  writeFileSync(file, JSON.stringify({ ...base, messages: [...base.messages, { ...base.messages[0], messageId: "om_second" }] }));
  const original = RawJournal.prototype.insert;
  let calls = 0;
  const failure = spyOn(RawJournal.prototype, "insert").mockImplementation(function (this: RawJournal, record) {
    if (++calls === 2) throw new Error("private persistence failure");
    return original.call(this, record);
  });
  try { expect(await capture.finish()).toContain("已确认新增 1 条"); } finally { failure.mockRestore(); }
  const pending = JSON.parse(readFileSync(join(engine.registry.store(space).root, ".chat-source-progress.json"), "utf8"));
  expect(pending.retryStartAt).toBe(1000);
  expect(pending.coveredThrough).toBeUndefined();
  expect(await capture.finish()).toContain("新增 1 条，重复跳过 1 条");
  expect(engine.registry.store(space).index().listRaw()).toHaveLength(2);
});

test("complete capture commits progress, later incomplete windows retain the retry boundary", async () => {
  const { engine, capture, file, run } = fixture();
  const complete = { ...manifest(), failedMessageIds: [], olderThreadsScanned: true };
  writeFileSync(file, JSON.stringify(complete));
  expect(await capture.finish()).toContain("1970-01-01T00:00:02.000Z");
  const next = engine.prepareChatRawImport(run.id)!;
  expect(next.instruction).toContain('"retryStartAt":2000');
  expect(next.instruction).toContain("+messages-mget");
  expect(next.instruction).toContain("+messages-search");
  expect(next.instruction).toContain("不设关键词过滤");
  const later = { ...complete, startAt: 2000, endAt: 4000, messages: [], threadsComplete: false };
  writeFileSync(file, JSON.stringify(later));
  expect(await capture.finish()).toContain("未推进增量起点");
  expect(engine.prepareChatRawImport(run.id)!.instruction).toContain('"pendingThrough":4000');
  writeFileSync(file, JSON.stringify({ ...later, threadsComplete: true }));
  expect(await capture.finish()).toContain("1970-01-01T00:00:04.000Z");
});

test("checkpoint commit failure after Raw persistence retains gap and retry repairs it", async () => {
  const { engine, capture, file } = fixture();
  writeFileSync(file, JSON.stringify({ ...manifest(), failedMessageIds: [], olderThreadsScanned: true }));
  const original = durable.writeAtomicStateFile;
  let calls = 0;
  const failure = spyOn(durable, "writeAtomicStateFile").mockImplementation((path, content) => {
    if (++calls === 2) throw new Error("simulated checkpoint commit failure");
    original(path, content);
  });
  try { expect(await capture.finish()).toContain("已确认新增 1 条"); }
  finally { failure.mockRestore(); }
  const progressFile = join(engine.registry.store(space).root, ".chat-source-progress.json");
  expect(JSON.parse(readFileSync(progressFile, "utf8")).coveredThrough).toBeUndefined();
  expect(await capture.finish()).toContain("重复跳过 1 条");
  expect(JSON.parse(readFileSync(progressFile, "utf8")).coveredThrough).toBe(2000);
});

test("edited snapshots are immutable, deduplicated, and stale rereads do not replace newer evidence", async () => {
  const { engine, capture, file } = fixture();
  const base = manifest();
  writeFileSync(file, JSON.stringify(base));
  await capture.finish();
  const edited = { ...base, messages: [{ ...base.messages[0], text: "已验证恢复。", updatedAt: 1900 }] };
  writeFileSync(file, JSON.stringify(edited));
  expect(await capture.finish()).toContain("含 1 条编辑版本");
  expect(await capture.finish()).toContain("重复跳过 1 条");
  const records = engine.registry.store(space).index().findRawsByMessageId("om_source", "oc_capture");
  expect(records).toHaveLength(2);
  expect(records.some(r => r.content.endsWith("已热更，等待玩家回归验证。"))).toBe(true);
  expect(records.some(r => r.content.endsWith("已验证恢复。"))).toBe(true);
  writeFileSync(file, JSON.stringify({ ...edited, messages: [{ ...edited.messages[0], text: "同一编辑时间但正文冲突" }] }));
  expect(await capture.finish()).toContain("入库未完成");
  writeFileSync(file, JSON.stringify({ ...edited, messages: [{ ...edited.messages[0], updatedAt: 1800, text: "旧版本" }] }));
  expect(await capture.finish()).toContain("重复跳过 1 条");
  expect(engine.registry.store(space).index().findRawsByMessageId("om_source", "oc_capture")).toHaveLength(2);
});

test("edited source predating the window is accepted only with a valid in-window edit time", () => {
  const base = manifest();
  const edited = { ...base, messages: [{ ...base.messages[0], createdAt: 500, updatedAt: 1500 }] };
  expect(parseChatRawImport(JSON.stringify(edited), space, "oc_capture").entries).toHaveLength(1);
  for (const updatedAt of [400, 999, 2001]) {
    expect(() => parseChatRawImport(JSON.stringify({ ...edited, messages: [{ ...edited.messages[0], updatedAt }] }), space, "oc_capture")).toThrow();
  }
});

test("refuses to write the journal through a replaced records ancestor", async () => {
  const { engine, capture, file } = fixture();
  writeFileSync(file, JSON.stringify(manifest()));
  const records = join(engine.registry.store(space).root, "raw", "records");
  mkdirSync(records, { recursive: true });
  const escaped = join(dir, "outside"); mkdirSync(escaped);
  const year = join(records, "1970");
  symlinkSync(escaped, year, process.platform === "win32" ? "junction" : "dir");
  expect(await capture.finish()).toContain("入库未完成");
  expect(readdirSync(escaped)).toEqual([]);
});

test("repairs a projection failure from the committed journal on retry", async () => {
  const { engine, capture, file } = fixture();
  writeFileSync(file, JSON.stringify(manifest()));
  const store = engine.registry.store(space);
  const databaseFile = join(store.root, ".index.db");
  const db = new Database(databaseFile);
  try {
    db.exec("CREATE TRIGGER fail_import BEFORE INSERT ON raw BEGIN SELECT RAISE(FAIL, 'private projection failure'); END");
    expect(await capture.finish()).toContain("入库未完成");
    db.exec("DROP TRIGGER fail_import");
    expect(await capture.finish()).toContain("重复跳过 1 条");
    expect(store.index().getRaw(chatRawImportId(space, "oc_capture", "om_source"))).not.toBeNull();
  } finally { db.close(); }
});
