import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { KnowledgeEngine } from "./engine.ts";
import { SkillCatalog } from "./skill-catalog.ts";
import { RawJournal } from "./raw-journal.ts";
import { parseSpaceArchive } from "./governance.ts";
import { createDocumentCapture, readDocumentCapture, resolveDocumentImportRequest } from "./chat-document-import.ts";
import { MAX_MATERIAL_BYTES, MATERIAL_PART_CHARACTERS, type SpaceId } from "@homeagent/shared";
import { MAX_CHAT_IMPORT_BYTES, MAX_CHAT_IMPORT_MESSAGES } from "./chat-raw-import.ts";

const url = "https://aws.amazon.com/cn/blogs/gametech/compiling-unreal-engine-5-dedicated-servers-for-aws-graviton-ec2-instances/";
const space = "team/oc_documents" as const;
let root: string;
const engines: KnowledgeEngine[] = [];
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), "ha-document-import-"))); });
afterEach(() => { for (const engine of engines.splice(0)) engine.close(); rmSync(root, { recursive: true, force: true }); });

function fixture(input = `@HomeAgent 记录下这个文档的完整内容：${url}`, personal = false) {
  const dataDir = join(root, "data"), workdir = join(root, "work"); mkdirSync(workdir);
  const engine = new KnowledgeEngine({ dataDir, skillCatalog: new SkillCatalog({ roots: [] }), runProvider: async () => { throw new Error("No live provider"); } });
  engines.push(engine);
  const target: SpaceId = personal ? "personal/ou_fixture" : space;
  const chatId = personal ? "oc_dm" : "oc_documents";
  engine.ensureSpace(target, { chatId });
  if (!personal) engine.feishuBindings.connect({ spaceId: target, chatId, boundAppId: "fixture", responseMode: "mentions_only", replyInThread: true });
  const agent = engine.agents.create({ provider: "codex", visibility: personal ? "Personal" : "Team" }); engine.registry.updateMeta(target, { agentId: agent.id });
  const draft = engine.agents.saveDraft(agent.id, { permission: "full", executionMode: "local-full-access", workdir })!;
  engine.localExecution.release(agent.id, draft.id, draft.id, { termsVersion: 1, source: "local-operator", taskExecutionEnabled: false,
    expectedScopeFingerprint: engine.localExecution.preview(agent.id, draft.id).fingerprint });
  const run = engine.chatRuns.start({ space: target, chatId, messageId: "om_document", author: "ou_fixture", agentId: agent.id,
    input, trigger: "message", executionPlan: engine.agentRunExecutionSnapshot(target).executionPlan });
  engine.chatRuns.begin(run.id);
  const capture = engine.prepareChatDocumentImport(run.id)!;
  const file = JSON.parse(capture.instruction.match(/写入 ("[^\n]+?")；/u)![1]!) as string;
  const manifest = (body = "完整原文。", files: Array<{ path: string; kind?: string }> = [], complete = true) => {
    writeFileSync(join(workdir, "article.md"), body);
    writeFileSync(file, JSON.stringify({ version: 1, documents: [{ url, title: "UE5 / Graviton", complete, contentPath: "article.md", files }] }));
  };
  return { engine, dataDir, workdir, capture, file, manifest, run, agent, target };
}

test("recognizes the original request without requiring Raw terminology and honors query-only intent", () => {
  expect(resolveDocumentImportRequest([`记录下这个文档的完整内容：[${url}](${url})`])).toEqual([url]);
  for (const text of ["阅读这个网页", "总结这个文档", "查询这篇文章记录了哪些问题", "阅读这篇文章的记录", "记录完整内容，不要入库", "只保存本地文件", "只保存总结"]) {
    expect(resolveDocumentImportRequest([`${text} ${url}`])).toEqual([]);
  }
  expect(resolveDocumentImportRequest([`记录完整内容 ${url}`, "继续补全"])).toEqual([url]);
  expect(resolveDocumentImportRequest([`记录完整内容 ${url}`, "谢谢"])).toEqual([]);
  expect(resolveDocumentImportRequest([`记录完整内容 ${url}`, "不要入库", "继续"])).toEqual([]);
  expect(resolveDocumentImportRequest([`记录完整内容 ${url}`, "记录下飞书群 PST 最近一周聊天原文"])).toEqual([]);
  expect(resolveDocumentImportRequest([`阅读这篇文章 ${url}`, "把这个文档保存到知识库"])).toEqual([url]);
  expect(resolveDocumentImportRequest(["保存这篇文档：[文章](https://example.com/article_(part_1))"]))
    .toEqual(["https://example.com/article_(part_1)"]);
});

test.each([false, true])("preserves all long body parts, code and 41 image originals in one Space: personal=%s", async personal => {
  const f = fixture(undefined, personal);
  const body = "开头\n" + "正文".repeat(MATERIAL_PART_CHARACTERS) + "\n```sh\ncompile-server\n```\n末尾清理。";
  const files = Array.from({ length: 41 }, (_, index) => ({ path: `image-${index}.png`, kind: "image" }));
  files.forEach((file, index) => writeFileSync(join(f.workdir, file.path), new Uint8Array([137, 80, index])));
  f.manifest(body, files);
  expect(await f.capture.finish()).toContain("文档原文入库：新增 3 条");
  const raws = f.engine.registry.store(f.target).index().listRaw({});
  expect(raws).toHaveLength(3);
  expect(raws.every(raw => raw.space === f.target && raw.source === "doc" && raw.admission === "ready")).toBe(true);
  raws.sort((a, b) => JSON.parse(a.content.match(/<!-- (.+) -->/u)![1]!).part - JSON.parse(b.content.match(/<!-- (.+) -->/u)![1]!).part);
  const joined = raws.map(raw => raw.content.slice(raw.content.indexOf(" -->\n\n") + 6)).join("");
  expect(joined).toBe(body);
  expect(raws[0]?.attachments).toHaveLength(42);
  const original = f.engine.getRawSource(f.target, raws[0]!.id, 0)!;
  expect(readFileSync(original.path, "utf8")).toBe(body);
  expect(await f.capture.finish()).toContain("新增 0 条，重复跳过 3 条");
  f.engine.close();
  // The archive is owned by Raw, independent of Agent workspace cleanup.
  rmSync(f.workdir, { recursive: true });
  const reopened = new KnowledgeEngine({ dataDir: f.dataDir, skillCatalog: new SkillCatalog({ roots: [] }) }); engines.push(reopened);
  expect(reopened.registry.store(f.target).index().listRaw({})).toHaveLength(3);
  expect(readFileSync(reopened.getRawSource(f.target, raws[0]!.id, 0)!.path, "utf8")).toBe(body);
});

test("rejects an invalid later artifact before writing any Raw or source file", async () => {
  const f = fixture();
  f.manifest("valid", [{ path: "missing.png", kind: "image" }]);
  expect(await f.capture.finish()).toContain("入库未完成：已确认新增 0 条");
  expect(f.engine.registry.store(space).index().listRaw({})).toHaveLength(0);
  const sources = join(f.engine.registry.store(space).root, "raw", "sources");
  expect(!existsSync(sources) || readdirSync(sources).length === 0).toBe(true);
});

test("partial journal failure reports confirmed progress and retry does not duplicate committed parts", async () => {
  const f = fixture(); f.manifest("文".repeat(MATERIAL_PART_CHARACTERS + 10));
  const insert = RawJournal.prototype.insert;
  let calls = 0;
  const mocked = spyOn(RawJournal.prototype, "insert").mockImplementation(function (this: RawJournal, entry) {
    if (++calls === 2) throw new Error("fixture disk failure");
    return insert.call(this, entry);
  });
  try { expect(await f.capture.finish()).toContain("入库未完成：已确认新增 1 条"); }
  finally { mocked.mockRestore(); }
  expect(await f.capture.finish()).toContain("新增 1 条，重复跳过 1 条");
  expect(f.engine.registry.store(space).index().listRaw({})).toHaveLength(2);
});

test("repairs a failed SQLite projection from the committed journal and preserves original files", async () => {
  const f = fixture(); f.manifest();
  const db = new Database(join(f.engine.registry.store(space).root, ".index.db"));
  try {
    db.exec("CREATE TRIGGER fail_document_import BEFORE INSERT ON raw BEGIN SELECT RAISE(FAIL, 'fixture projection failure'); END");
    expect(await f.capture.finish()).toContain("入库未完成：已确认新增 0 条");
    db.exec("DROP TRIGGER fail_document_import");
    expect(await f.capture.finish()).toContain("新增 0 条，重复跳过 1 条");
    const raws = f.engine.registry.store(space).index().listRaw({});
    expect(raws).toHaveLength(1);
    expect(readFileSync(f.engine.getRawSource(space, raws[0]!.id, 0)!.path, "utf8")).toBe("完整原文。");
  } finally { db.close(); }
});

test.each(["cancel", "binding", "agent", "workdir"])("rechecks the owning Run and frozen environment before capture: %s", async change => {
  const f = fixture(); f.manifest();
  if (change === "cancel") f.engine.chatRuns.cancel(f.run.id, { finishedAt: Date.now(), error: { kind: "cancelled", message: "fixture cancellation" } });
  if (change === "binding") f.engine.feishuBindings.disconnect(space);
  if (change === "agent") f.engine.registry.updateMeta(space, { agentId: "" });
  if (change === "workdir") { rmSync(f.workdir, { recursive: true }); mkdirSync(f.workdir); }
  expect(await f.capture.finish()).toContain("入库未完成");
  expect(f.engine.registry.store(space).index().listRaw({})).toHaveLength(0);
});

test("records incomplete capture honestly instead of claiming the whole source was archived", async () => {
  const f = fixture(); f.manifest("实际取得的部分正文。", [], false);
  expect(await f.capture.finish()).toContain("来源交接不完整");
  expect(f.engine.registry.store(space).index().listRaw({})[0]?.content).toContain('"complete":false');
});

test("already synchronized sources keep their original document ingestion path", async () => {
  const f = fixture();
  await f.engine.remember({ space, source: "doc", chatId: "oc_documents", messageId: "om_document", content: `# 来源资料：${url}\n\n已同步正文。` });
  expect(f.engine.prepareChatDocumentImport(f.run.id)).toBeUndefined();
});

test("document Raw and original bytes round-trip through the existing Space archive schema", async () => {
  const f = fixture(); f.manifest();
  await f.capture.finish();
  f.engine.chatRuns.succeed(f.run.id, { finishedAt: Date.now(), output: "文档已交接" });
  f.engine.chatRuns.deliverySent(f.run.id, Date.now());
  const archive = parseSpaceArchive(await f.engine.exportSpace(space));
  expect(archive.raw).toHaveLength(1);
  expect(archive.raw[0]?.source).toBe("doc");
  expect(archive.sourceFiles).toHaveLength(1);
  expect(Buffer.from(archive.sourceFiles[0]!.contentBase64, "base64").toString("utf8")).toBe("完整原文。");
});

test("a fresh Run after restart deduplicates the same request and source version", async () => {
  const f = fixture(); f.manifest(); await f.capture.finish();
  f.engine.chatRuns.succeed(f.run.id, { finishedAt: Date.now(), output: "已收录" });
  f.engine.chatRuns.deliverySent(f.run.id, Date.now()); f.engine.close();
  const reopened = new KnowledgeEngine({ dataDir: f.dataDir, skillCatalog: new SkillCatalog({ roots: [] }) }); engines.push(reopened);
  const retry = reopened.chatRuns.start({ space, chatId: "oc_documents", messageId: "om_document", agentId: f.agent.id,
    input: f.run.input, trigger: "message", executionPlan: reopened.agentRunExecutionSnapshot(space).executionPlan });
  reopened.chatRuns.begin(retry.id);
  const capture = reopened.prepareChatDocumentImport(retry.id)!;
  const path = JSON.parse(capture.instruction.match(/写入 ("[^\n]+?")；/u)![1]!) as string;
  writeFileSync(path, readFileSync(f.file));
  expect(await capture.finish()).toContain("新增 0 条，重复跳过 1 条");
  expect(reopened.registry.store(space).index().listRaw({})).toHaveLength(1);
});

test("validates source scope, manifest limits, file limits and path aliases", () => {
  const workdir = join(root, "work"); mkdirSync(workdir);
  const capture = createDocumentCapture(workdir, [url]);
  writeFileSync(join(workdir, "article.md"), "正文。");
  const doc = { url, title: "标题", complete: true, contentPath: "article.md", files: [] };
  const write = (value: unknown) => writeFileSync(capture.file, JSON.stringify(value));
  write({ version: 1, documents: [doc] }); expect(readDocumentCapture(capture)[0]?.content).toBe("正文。");
  write({ version: 1, documents: [{ ...doc, files: Array.from({ length: MAX_CHAT_IMPORT_MESSAGES - 1 }, () => ({ path: "article.md" })) }] });
  expect(readDocumentCapture(capture)[0]?.files).toHaveLength(1);
  for (const replacement of [{ url: "https://other.example/article" }, { contentPath: "../outside.md" },
    { files: Array.from({ length: MAX_CHAT_IMPORT_MESSAGES }, () => ({ path: "article.md" })) }, { complete: "yes" }]) {
    write({ version: 1, documents: [{ ...doc, ...replacement }] }); expect(() => readDocumentCapture(capture)).toThrow();
  }
  writeFileSync(capture.file, " ".repeat(MAX_CHAT_IMPORT_BYTES + 1)); expect(() => readDocumentCapture(capture)).toThrow();
  writeFileSync(join(workdir, "article.md"), Buffer.alloc(MAX_MATERIAL_BYTES, 97));
  write({ version: 1, documents: [doc] }); expect(readDocumentCapture(capture)[0]?.content.length).toBe(MAX_MATERIAL_BYTES);
  writeFileSync(join(workdir, "article.md"), Buffer.alloc(MAX_MATERIAL_BYTES + 1));
  write({ version: 1, documents: [doc] }); expect(() => readDocumentCapture(capture)).toThrow();
  writeFileSync(join(workdir, "article.md"), "原件"); linkSync(join(workdir, "article.md"), join(workdir, "alias.md"));
  expect(() => readDocumentCapture(capture)).toThrow();
});
