import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliConnector, FeishuConnector, type Connector, type OutboundReply } from "@homeagent/connectors";
import { FakeLlm, KnowledgeEngine, parseSpaceArchive, SkillCatalog, replyFileIntent } from "@homeagent/core";
import { Orchestrator } from "./runtime.ts";

test("outbound upload uses bot binary input, then one Markdown post containing the uploaded attachment", async () => {
  const calls: { args: string[]; bytes?: Uint8Array; text?: string }[] = [];
  const connector = new FeishuConnector({ runCommand: async (args, options) => {
    calls.push({ args, bytes: options?.stdinBytes, text: options?.stdin });
    return args.includes("files") ? '{"ok":true,"data":{"file_key":"file_verified"}}' : '{"ok":true,"data":{"message_id":"om_final"}}';
  } });
  const bytes = Uint8Array.from([0, 255, 128, 100]);
  const key = await connector.uploadReplyFile("周报.pdf", bytes);
  await connector.reply({ chatId: "oc_test", replyToMessageId: "om_root", markdown: "周报已生成。", inThread: true, idempotencyKey: "final", attachmentKey: key });
  expect(calls[0]!.args).toEqual(["lark-cli", "im", "files", "create", "--as", "bot", "--file", "file=-",
    "--data", '{"file_type":"stream","file_name":"周报.pdf"}', "--json"]);
  expect(calls[0]!.bytes).toEqual(bytes);
  expect(calls[1]!.args).toContain("--attachment");
  expect(calls[1]!.args).toContain("file_verified");
  expect(calls[1]!.args).toContain("--reply-in-thread");
  expect(calls[1]!.args).toContain("om_root");
  expect(calls[1]!.text).toBe("周报已生成。");
});

test.each(["immediate", "followup", "immediate-uncertain", "followup-uncertain", "immediate-truncated"])("original Feishu topic delivers the verified report without regenerating it: %s", async scenario => {
  const immediate = scenario.startsWith("immediate");
  const uncertain = scenario.endsWith("-uncertain");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ha-feishu-file-")));
  const workdir = join(root, "work"); mkdirSync(workdir);
  const dataDir = join(root, "data");
  const space = "team/oc_reports" as const;
  const chatId = "oc_reports";
  let calls = 0, uploads = 0, failSend = immediate && !uncertain;
  const sent: OutboundReply[] = [];
  const attempts: OutboundReply[] = [];
  let artifact = "";
  const open = () => {
    const engine = new KnowledgeEngine({ dataDir, skillCatalog: new SkillCatalog({ roots: [] }), runProvider: async (_provider, input) => {
      if (!input.nativeSession) return JSON.stringify({ relevant: false, slugs: [] });
      const marker = input.prompt.match(/专属目录 ("[^\n]+?") 中/u);
      if (!marker) throw new Error("Missing artifact instruction");
      const directory = JSON.parse(marker[1]!) as string;
      mkdirSync(directory);
      artifact = join(directory, "周报.md");
      writeFileSync(artifact, "正文\n第二行");
      writeFileSync(join(workdir, "周报.md"), "正文\n第二行");
      calls++;
      return { text: (scenario.endsWith("truncated") ? "很长的正文".repeat(22_000) : "") + `已完成[周报](<${join(workdir, "周报.md")}>)。`, nativeSessionId: "11111111-2222-4333-8444-555555555556",
        usage: { costBasis: "unavailable", source: "legacy-text" } };
    } });
    const transport = new CliConnector();
    const connector: Connector = { name: "feishu", start: h => transport.start(h), stop: () => transport.stop(), notice: async () => {},
      uploadReplyFile: async (name, bytes) => { expect(name).toBe("周报.md"); expect(new TextDecoder().decode(bytes)).toBe("正文\n第二行"); uploads++; return "file_report"; },
      reply: async out => {
        attempts.push(out);
        if (failSend && out.attachmentKey) { failSend = false; throw new Error("fake network"); }
        sent.push(out); return { messageId: `om_result_${out.replyToMessageId}` };
      } };
    const runtime = new Orchestrator({ engine, connector, llm: new FakeLlm() });
    return { engine, transport, runtime };
  };
  let app = open();
  const send = (text: string, id: string, sender = "ou_author", rootId = "om_question", parent?: string) =>
    app.transport.inject({ kind: "message", eventId: id, messageId: id, chatId, chatType: "group", senderId: sender,
      mentionsBot: true, text, createdAt: Date.now(), rootMessageId: rootId, parentMessageId: parent });
  try {
    app.engine.ensureSpace(space, { chatId });
    app.engine.feishuBindings.connect({ chatId, spaceId: space, boundAppId: "fixture", responseMode: "mentions_only", replyInThread: true });
    const agent = app.engine.agents.create({ provider: "codex" });
    app.engine.registry.updateMeta(space, { agentId: agent.id });
    const draft = app.engine.agents.saveDraft(agent.id, { permission: "full", executionMode: "local-full-access", workdir })!;
    app.engine.localExecution.release(agent.id, draft.id, draft.id, { termsVersion: 1, source: "local-operator", taskExecutionEnabled: false,
      expectedScopeFingerprint: app.engine.localExecution.preview(agent.id, draft.id).fingerprint });
    await app.runtime.start();
    if (immediate && uncertain) spyOn(app.engine.chatRuns, "deliverySent").mockImplementationOnce(() => { throw new Error("failed receipt commit"); });
    await send(immediate ? "@HomeAgent 生成周报.md，作为附件发到本群" : "@HomeAgent 生成周报.md", "om_question").catch(error => {
      if (!immediate) throw error;
    });
    const run = app.engine.chatRuns.list(space)[0]!;
    expect(run.status).toBe("succeeded");
    expect(run.delivery.replyFile?.name).toBe("周报.md");
    expect(uploads).toBe(immediate ? 1 : 0);
    expect(run.delivery.status).toBe(immediate ? uncertain ? "pending" : "failed" : "sent");
    if (immediate && uncertain) {
      await expect(app.engine.exportSpace(space)).rejects.toThrow("delivering chat responses");
    } else {
      const archive = await app.engine.exportSpace(space);
      expect(JSON.stringify(archive.chatRuns)).not.toContain(".homeagent-delivery-");
      expect(JSON.stringify(archive.chatRuns)).not.toContain("file_report");
      expect(archive.chatRuns[0]?.delivery.attachmentUnavailable).toBe(immediate ? true : undefined);
      if (scenario === "immediate") {
        expect(() => parseSpaceArchive({ ...archive, version: 24 })).toThrow("requires archive v25");
        const restored = new KnowledgeEngine({ dataDir: join(root, "restored"), skillCatalog: new SkillCatalog({ roots: [] }) });
        try {
          await restored.restoreSpace(archive);
          expect(restored.chatRuns.get(run.id)?.delivery.attachmentUnavailable).toBe(true);
          const local = new Orchestrator({ engine: restored, connector: new CliConnector() });
          try { await expect(local.retryChatRun(run.id)).rejects.toThrow("原回答需要的附件"); }
          finally { await local.stop(); }
          expect(restored.chatRuns.deliverySent(run.id, Date.now())).toBeUndefined();
        } finally { restored.close(); }
      }
    }
    await app.runtime.stop(); app.engine.close(); app = open(); await app.runtime.start();
    if (immediate) {
      writeFileSync(artifact, "本地后来改过");
      if (scenario.endsWith("truncated")) {
        await send("@HomeAgent 把刚生成的周报发到本群", "om_file_only", "ou_author", "om_question", "om_question");
        expect(sent.at(-1)?.attachmentKey).toBe("file_report");
        expect(sent.at(-1)?.markdown).toContain("仅补发文件");
        expect(app.engine.chatRuns.get(run.id)?.delivery.status).toBe("failed");
      } else if (uncertain) {
        await app.runtime.retryChatRun(run.id);
        await send("@HomeAgent 把刚生成的周报发到本群", "om_again", "ou_author", "om_question", "om_question");
        expect(sent.at(-1)?.markdown).toContain("待核实");
        expect(attempts.filter(call => call.attachmentKey)).toHaveLength(1);
      } else {
        await Promise.all([
          app.runtime.retryChatRun(run.id),
          send("@HomeAgent 把刚生成的周报发到本群", "om_concurrent", "ou_author", "om_question", "om_question"),
        ]);
        expect(sent.find(call => call.attachmentKey)?.attachmentKey).toBe("file_report");
        expect(attempts.filter(call => call.attachmentKey).map(call => call.idempotencyKey)).toEqual([`${run.id}:final`, `${run.id}:final`]);
      }
    } else {
      const topicHeads = () => JSON.parse(readFileSync(join(dataDir, "config", "chat-runs.json"), "utf8")).topicNativeSessions;
      const originalHeads = topicHeads();
      expect(Object.keys(originalHeads)).toHaveLength(1);
      await send("@HomeAgent 把刚生成的周报.md发到本群", "om_other", "ou_other");
      await send("@HomeAgent 把刚生成的周报.md发到本群", "om_wrong_topic", "ou_author", "om_other_topic");
      await send("@HomeAgent 把刚生成的机密.txt发到本群", "om_wrong_file");
      const other = app.engine.chatRuns.start({ space, chatId, messageId: "om_b_question", author: "ou_b", input: "群话题提问", trigger: "message" });
      app.engine.chatRuns.succeed(other.id, { output: "其他用户的回答", finishedAt: Date.now() });
      app.engine.chatRuns.deliverySent(other.id, Date.now(), "om_b_answer");
      for (const parent of ["om_b_question", "om_b_answer"]) await send("@HomeAgent 把刚生成的文件发到本群", `control_${parent}`, "ou_author", "om_question", parent);
      expect(uploads).toBe(0);
      const followup = "@HomeAgent 把刚生成的周报.md发到本群";
      if (uncertain) spyOn(app.engine.chatRuns, "markReplyFileDelivered").mockImplementationOnce(() => { throw new Error("failed file delivery commit"); });
      await send(followup, "om_followup", "ou_author", "om_question", "om_result_om_question");
      expect(sent.find(out => out.attachmentKey)?.attachmentKey).toBe("file_report");
      await send(followup, "om_followup", "ou_author", "om_question", "om_result_om_question");
      await send(followup, "om_repeat", "ou_author", "om_question", "om_result_om_question");
      expect(sent.at(-1)?.markdown).toContain(uncertain ? "待核实" : "已作为附件送达");
      expect(topicHeads()).toEqual(originalHeads);
    }
    expect(sent.filter(call => call.attachmentKey)).toHaveLength(1);
    expect(sent.find(call => call.attachmentKey)?.inThread).toBe(true);
    expect(uploads).toBe(1); expect(calls).toBe(1);
  } finally { await app.runtime.stop(); app.engine.close(); rmSync(root, { recursive: true, force: true }); }
});

test("file requests do not turn local-only or different-destination requests into delivery", () => {
  expect(replyFileIntent("生成报告，不要发送")).toBe("make");
  expect(replyFileIntent("生成报告，发给张三")).toBe("make");
  expect(replyFileIntent("生成报告，作为附件发送给张三")).toBe("make");
  expect(replyFileIntent("把刚生成的报告发到当前私聊", "p2p")).toBe("send");
  expect(replyFileIntent("把刚生成的报告私聊发给我", "group")).toBeUndefined();
  expect(replyFileIntent("生成报告，作为附件发给我")).toBe("make-and-send");
  expect(replyFileIntent("把刚生成的报告发送到本群")).toBe("send");
  for (const text of ["请阅读这个文件，然后把结论发给我", "分析这份报告，把摘要发给我", "请把这个文件的链接发给我", "根据报告在群里发言"]) {
    expect(replyFileIntent(text)).toBeUndefined();
  }
});
