import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeLlm, KnowledgeEngine, SkillCatalog } from "@homeagent/core";
import { CliConnector, type Connector } from "@homeagent/connectors";
import { Orchestrator } from "./runtime.ts";

test.each(["valid", "external", "invalid", "missing"] as const)("Feishu Chat appends actual Raw import receipt before durable delivery: %s", async (artifact) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ha-raw-import-flow-")));
  const workdir = join(root, "work"); mkdirSync(workdir);
  const space = "team/oc_capture" as const;
  let finalCalls = 0;
  const engine = new KnowledgeEngine({ dataDir: join(root, "data"), skillCatalog: new SkillCatalog({ roots: [] }),
    runProvider: async (_provider, input) => {
      if (!input.nativeSession) return JSON.stringify({ relevant: false, slugs: [] });
      finalCalls++;
      expect(input.prompt).toContain("本轮聊天原文自动入库交接");
      expect(input.prompt).toContain("不得为了入库使用 --download-resources");
      expect(input.prompt).toContain("+messages-mget");
      expect(input.prompt).toContain("+messages-search");
      expect(input.prompt).toContain("--page-all 达到上限不等于完整");
      expect(input.prompt).toContain("尚无已提交的增量基线");
      expect(input.prompt).toContain("不得用当前群替换目标群");
      expect(input.prompt).toContain('"requestedName":"PST"');
      const file = JSON.parse(input.prompt.match(/写入 ("[^\n]+?")；/u)![1]!) as string;
      if (artifact !== "missing") writeFileSync(file, JSON.stringify({
        version: 1, chatId: artifact === "external" ? "oc_pst" : "oc_capture", chatName: artifact === "invalid" ? "测试 AI" : "PST", startAt: 100, endAt: 200,
        mainComplete: true, threadsComplete: true, olderThreadsScanned: false, failedMessageIds: [],
        messages: [{ messageId: "om_evidence", author: "ou_source", createdAt: 150, text: "故障已定位，等待回归验证。",
          attachments: [{ kind: "file", ref: "file_huge", sizeBytes: 5 * 1024 ** 3 }] }],
      }));
      return { text: "已提交聊天原文，等待 HomeAgent 入库校验。", nativeSessionId: "11111111-2222-4333-8444-555555555555",
        usage: { costBasis: "unavailable", source: "legacy-text" } };
    } });
  const transport = new CliConnector({ groupChatId: "oc_capture", userId: "ou_fixture" });
  const connector: Connector = { name: "feishu", start: handler => transport.start(handler), stop: () => transport.stop(),
    reply: async out => {
      const raws = engine.registry.store(space).index().findRawsByMessageId("om_evidence", artifact === "external" ? "oc_pst" : "oc_capture");
      expect(raws).toHaveLength(artifact === "valid" || artifact === "external" ? 1 : 0);
      if (artifact === "external") { expect(raws[0]?.space).toBe(space); expect(engine.registry.has("team/oc_pst")).toBe(false); }
      const run = engine.chatRuns.list(space)[0]!;
      expect(run.status).toBe("succeeded");
      expect(run.output).toBe(out.markdown);
      return transport.reply(out);
    }, notice: (chat, text, options) => transport.notice(chat, text, options) };
  const classifier = new FakeLlm(); classifier.onJSON(() => ({ relevant: false, slugs: [] }));
  const runtime = new Orchestrator({ engine, connector, llm: classifier });
  try {
    engine.ensureSpace(space, { chatId: "oc_capture" });
    engine.feishuBindings.connect({ spaceId: space, chatId: "oc_capture", boundAppId: "fixture", responseMode: "mentions_only", replyInThread: true });
    const agent = engine.agents.create({ provider: "codex" });
    engine.registry.updateMeta(space, { agentId: agent.id });
    const draft = engine.agents.saveDraft(agent.id, { permission: "full", executionMode: "local-full-access", workdir })!;
    engine.localExecution.release(agent.id, draft.id, draft.id, { termsVersion: 1, source: "local-operator", taskExecutionEnabled: false,
      expectedScopeFingerprint: engine.localExecution.preview(agent.id, draft.id).fingerprint });
    await runtime.start();
    await transport.inject({ kind: "message", eventId: "evt_capture", chatType: "group", chatId: "oc_capture", senderId: "ou_fixture",
      text: "@agent 飞书群 PST 提炼最近一周主要内容，并记录相关的原始数据", messageId: "om_request", mentionsBot: true, createdAt: 200 });
    expect(finalCalls).toBe(1);
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]!.markdown).toContain(artifact === "valid" || artifact === "external" ? "原始记录入库：新增 1 条" : "原始记录入库未完成");
    expect(engine.chatRuns.list(space)[0]!.delivery.status).toBe("sent");
  } finally { await runtime.stop(); engine.close(); rmSync(root, { recursive: true, force: true }); }
});

test("stored Raw lookup uses host evidence and returns a native answer without an import receipt", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ha-stored-raw-flow-")));
  const workdir = join(root, "work"); mkdirSync(workdir);
  const space = "team/oc_capture" as const;
  const body = "国际服更新后 150—200ms 长帧 198 条，200ms 以上 4 条。";
  let finalCalls = 0;
  const engine = new KnowledgeEngine({ dataDir: join(root, "data"), skillCatalog: new SkillCatalog({ roots: [] }),
    runProvider: async (_provider, input) => {
      if (!input.nativeSession) return JSON.stringify({ relevant: false, slugs: [] });
      finalCalls++;
      expect(input.prompt).toContain(body);
      expect(input.prompt).not.toContain("本轮聊天原文自动入库交接");
      expect(input.system).toContain("不调用 Skill、命令或网络");
      const candidates = JSON.parse(input.prompt.split("已入库 Raw 候选（JSON 数据）：\n")[1]!);
      const evidence = candidates.find((candidate: { content: string }) => candidate.content === body);
      expect(evidence).toBeDefined();
      return { text: JSON.stringify({ matches: [{ key: evidence.key, quote: body }] }), nativeSessionId: "11111111-2222-4333-8444-555555555559",
        usage: { costBasis: "unavailable", source: "legacy-text" } };
    } });
  const transport = new CliConnector({ groupChatId: "oc_capture", userId: "ou_fixture" });
  const connector: Connector = { name: "feishu", start: handler => transport.start(handler), stop: () => transport.stop(),
    reply: out => transport.reply(out), notice: (chat, text, options) => transport.notice(chat, text, options) };
  const classifier = new FakeLlm(); classifier.onJSON(() => ({ relevant: false, slugs: [] }));
  const runtime = new Orchestrator({ engine, connector, llm: classifier });
  try {
    engine.ensureSpace(space, { chatId: "oc_capture" });
    engine.feishuBindings.connect({ spaceId: space, chatId: "oc_capture", boundAppId: "fixture", responseMode: "mentions_only", replyInThread: true });
    const id = engine.registry.store(space).index().insertRaw({ space, source: "manual", chatId: "oc_pst", messageId: "om_report", content: body, createdAt: 150 });
    const agent = engine.agents.create({ provider: "codex" });
    engine.registry.updateMeta(space, { agentId: agent.id });
    const draft = engine.agents.saveDraft(agent.id, { permission: "full", executionMode: "local-full-access", workdir })!;
    engine.localExecution.release(agent.id, draft.id, draft.id, { termsVersion: 1, source: "local-operator", taskExecutionEnabled: false,
      expectedScopeFingerprint: engine.localExecution.preview(agent.id, draft.id).fingerprint });
    await runtime.start();
    await transport.inject({ kind: "message", eventId: "evt_raw_lookup", chatType: "group", chatId: "oc_capture", senderId: "ou_fixture",
      text: "@HomeAgent 只使用当前群 HomeAgent 知识库中已入库的 Raw，不调用飞书 Skill、不重新拉取群消息、不读取 D:\\Client 下的文件。查询「PST 高峰期拉扯卡顿专项」中关于“国际服更新后 150—200ms 长帧”的记录，给出原文摘录、来源群、消息时间和对应 Raw ID。查不到请明确说明。",
      messageId: "om_lookup", mentionsBot: true, createdAt: 200 });
    expect(finalCalls).toBe(1);
    expect(transport.sent[0]?.markdown).toContain(id);
    expect(transport.sent[0]?.markdown).toContain(body);
    expect(transport.sent[0]?.markdown).not.toContain("原始记录入库");
    expect(engine.chatRuns.list(space)[0]?.delivery.status).toBe("sent");
    expect(engine.registry.store(space).index().findRawsByMessageId("om_report", "oc_pst")).toHaveLength(1);
  } finally { await runtime.stop(); engine.close(); rmSync(root, { recursive: true, force: true }); }
});

test.each([
  "@agent 飞书群：PST 提炼最近一周，并保存原始数据。首轮专用标记",
  "@HomeAgent 飞书群：PST高峰期拉扯卡顿专项\n提炼下最近两周的主要内容，记录相关信息",
])("same-topic follow-up after restart imports to data with a fresh handoff and retained source: %s", async (firstRequest) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ha-topic-raw-followup-")));
  const workdir = join(root, "work"); mkdirSync(workdir);
  const dataDir = join(root, "data");
  const space = "team/oc_capture" as const;
  const sourceName = firstRequest.includes("PST高峰期") ? "PST高峰期拉扯卡顿专项" : "PST";
  const files: string[] = [];
  let finalCalls = 0;
  const sessions = ["11111111-2222-4333-8444-555555555551", "11111111-2222-4333-8444-555555555552", "11111111-2222-4333-8444-555555555553"] as const;
  const createEngine = () => new KnowledgeEngine({ dataDir, skillCatalog: new SkillCatalog({ roots: [] }),
    runProvider: async (_provider, input) => {
      if (!input.nativeSession) return JSON.stringify({ relevant: false, slugs: [] });
      const turn = finalCalls++;
      if (turn < 2) {
        expect(input.nativeSession).toEqual(turn === 0 ? { mode: "start" } : { mode: "fork", id: sessions[0] });
        expect(input.prompt).toContain(JSON.stringify({ requestedName: sourceName }));
        expect(input.prompt).toContain("无需寻找或调用其他 HomeAgent 入库接口");
        expect(input.prompt).toContain("不把本次查询截止时间直接称作下次增量起点");
        if (turn === 1) {
          expect(input.prompt).toContain("最近两周");
          expect(input.prompt).not.toContain("首轮专用标记");
        }
        const file = JSON.parse(input.prompt.match(/写入 ("[^\n]+?")；/u)![1]!) as string;
        files.push(file);
        writeFileSync(file, JSON.stringify({ version: 1, chatId: "oc_pst", chatName: sourceName, startAt: 100, endAt: 200,
          mainComplete: true, threadsComplete: false, olderThreadsScanned: true, failedMessageIds: ["om_retracted"],
          messages: [{ messageId: `om_source_${turn}`, createdAt: 150, text: `真实查询正文 ${turn}` }] }));
      } else {
        expect(input.nativeSession).toEqual({ mode: "start" });
        expect(input.prompt).not.toContain("本轮聊天原文自动入库交接");
      }
      return { text: "已完成本轮查询。", nativeSessionId: sessions[turn]!, usage: { costBasis: "unavailable", source: "legacy-text" } };
    } });
  let engine = createEngine();
  const transport = new CliConnector({ groupChatId: "oc_capture", userId: "ou_fixture" });
  const connector: Connector = { name: "feishu", start: handler => transport.start(handler), stop: () => transport.stop(),
    reply: out => transport.reply(out), notice: (chat, text, options) => transport.notice(chat, text, options) };
  const classifier = new FakeLlm(); classifier.onJSON(() => ({ relevant: false, slugs: [] }));
  let runtime = new Orchestrator({ engine, connector, llm: classifier });
  try {
    engine.ensureSpace(space, { chatId: "oc_capture" });
    engine.feishuBindings.connect({ spaceId: space, chatId: "oc_capture", boundAppId: "fixture", responseMode: "mentions_only", replyInThread: true });
    const agent = engine.agents.create({ provider: "codex" });
    engine.registry.updateMeta(space, { agentId: agent.id });
    const draft = engine.agents.saveDraft(agent.id, { permission: "full", executionMode: "local-full-access", workdir })!;
    engine.localExecution.release(agent.id, draft.id, draft.id, { termsVersion: 1, source: "local-operator", taskExecutionEnabled: false,
      expectedScopeFingerprint: engine.localExecution.preview(agent.id, draft.id).fingerprint });
    await runtime.start();
    await transport.inject({ kind: "message", eventId: "evt_first", chatType: "group", chatId: "oc_capture", senderId: "ou_fixture",
      text: firstRequest, messageId: "om_first", mentionsBot: true, createdAt: 200 });
    await runtime.stop(); engine.close();
    engine = createEngine();
    runtime = new Orchestrator({ engine, connector, llm: classifier });
    await runtime.start();
    await transport.inject({ kind: "message", eventId: "evt_followup", chatType: "group", chatId: "oc_capture", senderId: "ou_fixture",
      text: "@agent 再提炼最近两周", messageId: "om_second", rootMessageId: "om_first", mentionsBot: true, createdAt: 300 });
    expect(finalCalls).toBe(2);
    expect(files).toHaveLength(2); expect(files[0]).not.toBe(files[1]);
    for (const file of files) expect(existsSync(file)).toBe(true);
    const store = engine.registry.store(space);
    expect(store.root.startsWith(dataDir)).toBe(true);
    expect(existsSync(join(store.root, "raw", "records", "1970", "01", "01.jsonl"))).toBe(true);
    expect(store.index().findRawsByMessageId("om_source_1", "oc_pst")).toHaveLength(1);
    expect(engine.registry.has("team/oc_pst")).toBe(false);
    expect(transport.sent.at(-1)?.markdown).toContain("原始记录入库：新增 1 条");
    expect(transport.sent.at(-1)?.markdown).toContain("未推进增量起点");
    await transport.inject({ kind: "message", eventId: "evt_new_topic", chatType: "group", chatId: "oc_capture", senderId: "ou_fixture",
      text: "@agent 再提炼最近两周", messageId: "om_new_topic", mentionsBot: true, createdAt: 400 });
    expect(finalCalls).toBe(3);
    expect(transport.sent.at(-1)?.markdown).not.toContain("原始记录入库：");
  } finally { await runtime.stop(); engine.close(); rmSync(root, { recursive: true, force: true }); }
});
