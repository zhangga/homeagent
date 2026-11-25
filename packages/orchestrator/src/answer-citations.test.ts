import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliConnector, type Connector } from "@homeagent/connectors";
import { FakeLlm, KnowledgeEngine, SkillCatalog } from "@homeagent/core";
import { resetConfig, type Page, type SpaceId } from "@homeagent/shared";
import { Orchestrator } from "./runtime.ts";
import { formatAnswer } from "./format.ts";

test("Feishu numbers duplicate slugs by their actual retrieval identities", () => {
  const result = formatAnswer({ source: "knowledge", citations: [
    { slug: "entities/owner", title: "负责人", space: "team/oc_group" },
    { slug: "entities/owner", title: "负责人", space: "personal/ou_user" },
  ], answer: "[[source-2|乙]]与[[source-1|甲]]，示例 `[[source-2]]`。" }, undefined, {
    links: [], pages: [{ slug: "entities/owner", space: "team/oc_group" }, { slug: "entities/owner", space: "personal/ou_user" }],
  });
  expect(result).toContain("乙〔2〕与甲〔1〕");
  expect(result).toContain("1. 负责人（群空间）");
  expect(result).toContain("2. 负责人（个人空间）");
  expect(result).toContain("`[[source-2]]`");
});

test("Feishu can inspect an exact delivered answer after restart, without replaying the model or disclosing other spaces", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ha-citations-"));
  const previousDataDir = process.env.HOMEAGENT_DATA_DIR;
  process.env.HOMEAGENT_DATA_DIR = dir;
  resetConfig();
  const fake = new FakeLlm();
  fake.onJSON(call => {
    const props = call.schema.properties as Record<string, unknown>;
    if ("relevant" in props) return { slugs: ["concepts/release"], relevant: true };
    if ("grounded" in props) return { answer: "详见 [[concepts/release|发布流程]]。", grounded: true, usedSlugs: ["concepts/release"], gaps: [] };
    throw new Error("unexpected model call");
  });
  const open = () => {
    const engine = new KnowledgeEngine({ dataDir: dir, llm: fake, skillCatalog: new SkillCatalog({ roots: [] }) });
    const transport = new CliConnector();
    const connector: Connector = { name: "feishu", start: h => transport.start(h), stop: () => transport.stop(),
      reply: async out => { await transport.reply(out); return { messageId: `om_answer_${out.replyToMessageId}` }; },
      notice: (chat, text, opts) => transport.notice(chat, text, opts) };
    const runtime = new Orchestrator({ connector, engine, llm: fake });
    return { engine, transport, runtime };
  };
  let app = open();
  let seq = 0;
  const chatId = "oc_release";
  const space: SpaceId = "team/oc_release";
  const inject = async (text: string, messageId: string, parentMessageId?: string, rootMessageId?: string, group = chatId) => {
    await app.transport.inject({ kind: "message", chatId: group, chatType: "group", eventId: messageId, messageId, parentMessageId, rootMessageId,
      senderId: "ou_reader", mentionsBot: text.startsWith("@"), text, createdAt: Date.now() });
    return app.transport.sent.at(-1)?.markdown;
  };
  const inspect = (parent = "om_answer_om_question", root = "om_question", group = chatId, n = 1) =>
    inject(`@HomeAgent 看依据 ${n}`, `om_check_${++seq}`, parent, root, group);
  try {
    for (const chat of [chatId, "oc_other"]) {
      app.engine.ensureSpace(`team/${chat}`, { chatId: chat });
      app.engine.feishuBindings.connect({ chatId: chat, spaceId: `team/${chat}`, responseMode: "mentions_only", replyInThread: true });
    }
    const raw = await app.engine.remember({ space, source: "doc", author: "ou_author", chatId, messageId: "om_doc",
      content: "# 来源资料：https://example.com/release\n\n发布前需要取得值班人签字。", createdAt: Date.UTC(2026, 0, 2, 16, 1) });
    const page: Page = { type: "concept", slug: "concepts/release", title: "发布流程", summary: "发布签字", aliases: [], tags: [],
      links: [], sources: [raw], content: "发布前需要签字。", contentHash: "fixed", updatedAt: 100 };
    await app.engine.upsertPage(space, page);
    await app.runtime.start();
    const answer = await inject("@HomeAgent 发布流程是什么？", "om_question");
    expect(answer).toContain("发布流程〔1〕");
    expect(answer).toContain("1. 发布流程");
    expect(answer).toContain("最新证据：2026-01-03");
    expect(answer).toContain("[打开来源](https://example.com/release)");
    await app.runtime.stop();
    app.engine.close();
    app = open();
    await app.runtime.start();
    const calls = fake.calls.length;
    const evidence = await inspect();
    expect(evidence).toContain("> 发布前需要取得值班人签字。");
    expect(evidence).toContain("2026-01-03");
    expect(await inject("看依据 1", "om_direct_control", "om_answer_om_question", "om_question")).toContain("值班人签字");
    const sent = app.transport.sent.length;
    await inject("看依据 1", "om_unaddressed", "om_other_person", "om_question");
    expect(app.transport.sent.length).toBe(sent);
    await inject("@HomeAgent hi", "om_greeting", "om_question", "om_question");
    expect(await inspect("om_question")).toContain("> 发布前需要取得值班人签字。");
    expect(await inspect("om_answer_om_question", "om_unrelated")).toContain("请回复");
    expect(await inspect("om_answer_om_question", "om_question", "oc_other")).toContain("请回复");
    expect(await inspect("om_answer_om_question", "om_question", chatId, 2)).toContain("1 项依据");
    await app.engine.upsertPage(space, { ...page, title: "改名的页面" });
    expect(await inspect()).toContain("目前无法核验");
    await app.engine.upsertPage(space, page);
    await app.engine.retractMessage(space, { chatId, messageId: "om_doc", requestedBy: "ou_author" });
    expect(await inspect()).not.toContain("值班人签字");
    expect(fake.calls.length).toBe(calls);
  } finally {
    await app.runtime.stop(); app.engine.close();
    rmSync(dir, { recursive: true, force: true });
    if (previousDataDir === undefined) delete process.env.HOMEAGENT_DATA_DIR;
    else process.env.HOMEAGENT_DATA_DIR = previousDataDir;
    resetConfig();
  }
});
