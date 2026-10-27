import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeLlm, KnowledgeEngine, SkillCatalog } from "@homeagent/core";
import { CliConnector, type Connector } from "@homeagent/connectors";
import { Orchestrator } from "./runtime.ts";

test("a read-only private Chat records a synchronized article without requiring a writable Workdir", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ha-synced-document-")));
  const space = "personal/ou_fixture" as const;
  const url = "https://example.larkoffice.com/wiki/game_workflow";
  const body = "# AI 构建中小型游戏工作流\n\n先验证玩法，再制作正式资产。\n\n末尾测试与迭代。";
  const prompts: string[] = [];
  const engine = new KnowledgeEngine({ dataDir: join(root, "data"), skillCatalog: new SkillCatalog({ roots: [] }),
    runProvider: async (_provider, input) => {
      prompts.push(input.prompt);
      return "已收录本轮同步的文章正文，嵌入表格和媒体的覆盖情况需另行核验。";
    } });
  const transport = new CliConnector({ userId: "ou_fixture" });
  const connector: Connector = { name: "feishu", start: handler => transport.start(handler), stop: () => transport.stop(),
    reply: out => transport.reply(out), notice: (chat, text, options) => transport.notice(chat, text, options) };
  let fetched = 0;
  const runtime = new Orchestrator({ engine, connector, docFetcher: async () => { fetched++; return body; } });
  try {
    engine.ensureSpace(space, { chatId: "oc_dm" });
    const agent = engine.agents.create({ provider: "codex", visibility: "Personal", permission: "read-only" });
    engine.registry.updateMeta(space, { agentId: agent.id });
    await runtime.start();
    await transport.inject({ kind: "message", eventId: "evt_synced", chatType: "p2p", chatId: "oc_dm", senderId: "ou_fixture",
      text: `[AI构建中小型游戏工作流](${url}) 记录下这个文章`, messageId: "om_synced", docLinks: [url], mentionsBot: false, createdAt: 200 });
    const docs = engine.registry.store(space).index().listRaw({}).filter(raw => raw.source === "doc");
    expect(docs).toHaveLength(1);
    expect(docs[0]?.content).toContain(body);
    expect(fetched).toBe(1);
    expect(prompts.join("\n")).toContain(body);
    expect(prompts.join("\n")).not.toContain("需要当前 Agent 已有可写权限与有效 Workdir");
    expect(transport.sent[0]?.markdown).not.toContain("文档原文入库未完成");
    expect(transport.sent[0]?.markdown).toContain("文档原文入库：已确认同步 1 个来源");
    expect(engine.chatRuns.list(space)[0]?.output).toBe(transport.sent[0]?.markdown);
    expect(engine.chatRuns.list(space)[0]?.delivery.status).toBe("sent");
    await runtime.stop();
    engine.close();
    const reopened = new KnowledgeEngine({ dataDir: join(root, "data"), skillCatalog: new SkillCatalog({ roots: [] }) });
    try {
      expect(reopened.registry.store(space).index().listRaw({}).filter(raw => raw.source === "doc")).toHaveLength(1);
      expect(reopened.chatRuns.list(space)[0]?.output).toBe(transport.sent[0]?.markdown);
    } finally { reopened.close(); }
  } finally { await runtime.stop(); engine.close(); rmSync(root, { recursive: true, force: true }); }
});

test.each(["valid", "missing"] as const)("ordinary web document preservation returns a durable ingestion receipt: %s", async artifact => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ha-document-flow-")));
  const workdir = join(root, "work"); mkdirSync(workdir);
  const space = "team/oc_document" as const;
  const url = "https://aws.amazon.com/cn/blogs/gametech/compiling-unreal-engine-5-dedicated-servers-for-aws-graviton-ec2-instances/";
  const body = "# 原始文档\n\n完整正文。\n\n```sh\ncompile-server\n```\n\n![步骤](figure.png)\n\n末尾清理说明。";
  const engine = new KnowledgeEngine({ dataDir: join(root, "data"), skillCatalog: new SkillCatalog({ roots: [] }),
    runProvider: async (_provider, input) => {
      if (!input.nativeSession) return JSON.stringify({ relevant: false, slugs: [] });
      const target = input.prompt.match(/写入 ("[^\n]+?")；/u)?.[1];
      if (artifact === "valid" && target) {
        const file = JSON.parse(target) as string;
        writeFileSync(join(workdir, "article.md"), body);
        writeFileSync(join(workdir, "figure.png"), new Uint8Array([137, 80, 78, 71]));
        writeFileSync(file, JSON.stringify({ version: 1, documents: [{ url, title: "原始文档", complete: true,
          contentPath: "article.md", files: [{ path: "figure.png", kind: "image" }] }] }));
      }
      return { text: "资料已保存本地并提交入库校验。", nativeSessionId: "11111111-2222-4333-8444-555555555557",
        usage: { costBasis: "unavailable", source: "legacy-text" } };
    } });
  const transport = new CliConnector({ groupChatId: "oc_document", userId: "ou_fixture" });
  const connector: Connector = { name: "feishu", start: handler => transport.start(handler), stop: () => transport.stop(),
    reply: out => {
      const docs = engine.registry.store(space).index().listRaw({}).filter(raw => raw.source === "doc");
      expect(docs).toHaveLength(artifact === "valid" ? 1 : 0);
      if (artifact === "valid") {
        expect(docs[0]?.content).toContain(body);
        expect(docs[0]?.attachments?.map(item => item.name)).toEqual(["article.md", "figure.png"]);
        expect(docs[0]?.attachments?.every(item => item.sourceDigest)).toBe(true);
        expect(engine.chatRuns.list(space)[0]?.output).toBe(out.markdown);
      }
      return transport.reply(out);
    }, notice: (chat, text, options) => transport.notice(chat, text, options) };
  const classifier = new FakeLlm(); classifier.onJSON(() => ({ relevant: false, slugs: [] }));
  const runtime = new Orchestrator({ engine, connector, llm: classifier });
  try {
    engine.ensureSpace(space, { chatId: "oc_document" });
    engine.feishuBindings.connect({ spaceId: space, chatId: "oc_document", boundAppId: "fixture", responseMode: "mentions_only", replyInThread: true });
    const agent = engine.agents.create({ provider: "codex" }); engine.registry.updateMeta(space, { agentId: agent.id });
    const draft = engine.agents.saveDraft(agent.id, { permission: "full", executionMode: "local-full-access", workdir })!;
    engine.localExecution.release(agent.id, draft.id, draft.id, { termsVersion: 1, source: "local-operator", taskExecutionEnabled: false,
      expectedScopeFingerprint: engine.localExecution.preview(agent.id, draft.id).fingerprint });
    await runtime.start();
    await transport.inject({ kind: "message", eventId: "evt_document", chatType: "group", chatId: "oc_document", senderId: "ou_fixture",
      text: `@HomeAgent 记录下这个文档的完整内容：${url}`, messageId: "om_document", mentionsBot: true, createdAt: 200 });
    expect(transport.sent[0]?.markdown).toContain(artifact === "valid" ? "文档原文入库：新增 1 条" : "文档原文入库未完成");
    expect(engine.chatRuns.list(space)[0]?.delivery.status).toBe("sent");
  } finally { await runtime.stop(); engine.close(); rmSync(root, { recursive: true, force: true }); }
});
