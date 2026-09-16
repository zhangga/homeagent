import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeEngine, SkillCatalog, FakeLlm } from "@homeagent/core";
import { CliConnector, type Connector } from "@homeagent/connectors";
import type { NativeSessionRequest } from "@homeagent/llm";
import { Orchestrator } from "./runtime.ts";

test("confirmed full Feishu topics use real Engine start/sent/fork gates; failure and revocation never advance the chain", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ha-full-topic-")));
  const workdir = join(root, "work"); mkdirSync(workdir);
  const requests: Array<NativeSessionRequest | undefined> = [];
  const ids = ["11111111-2222-4333-8444-555555555555", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    "99999999-8888-4777-8666-555555555555", "12345678-1234-4234-8234-123456789abc"] as const;
  const engine = new KnowledgeEngine({ dataDir: join(root, "data"), skillCatalog: new SkillCatalog({ roots: [] }),
    runProvider: async (_provider, input) => {
      const permit = input.acquireExecutionPermit!();
      const unregister = permit.register(() => {}); permit.release();
      try {
        expect(input.execution?.executionMode).toBe("local-full-access");
        requests.push(input.nativeSession);
        if (requests.length === 3) throw new Error("offline model failure");
        return { text: `offline answer ${requests.length}`, nativeSessionId: ids[requests.length - 1],
          usage: { costBasis: "unavailable", source: "legacy-text" } };
      } finally { unregister(); }
    } });
  const transport = new CliConnector({ groupChatId: "oc_full", p2pChatId: "oc_dm", userId: "ou_fixture" });
  const feishu: Connector = { name: "feishu", start: event => transport.start(event), stop: () => transport.stop(),
    reply: reply => transport.reply(reply), notice: (chatId, text, options) => transport.notice(chatId, text, options) };
  const classifier = new FakeLlm();
  classifier.onJSON(() => ({ slugs: [], relevant: false }));
  const orch = new Orchestrator({ engine, connector: feishu, llm: classifier });
  try {
    const space = "team/oc_full" as const;
    await engine.ensureSpace(space, { chatId: "oc_full" });
    engine.feishuBindings.connect({ spaceId: space, chatId: "oc_full", boundAppId: "cli_fixture", responseMode: "mentions_only", replyInThread: true });
    const agent = engine.agents.create({ provider: "codex" });
    engine.registry.updateMeta(space, { agentId: agent.id });
    const draft = engine.agents.saveDraft(agent.id, { executionMode: "local-full-access", permission: "full", workdir })!;
    engine.localExecution.release(agent.id, draft.id, draft.id, { termsVersion: 1, source: "local-operator", taskExecutionEnabled: false,
      expectedScopeFingerprint: engine.localExecution.preview(agent.id, draft.id).fingerprint });
    await orch.start();
    const send = (index: number) => transport.inject({ kind: "message", eventId: `full-event-${index}`, chatType: "group",
      chatId: "oc_full", senderId: "ou_fixture", text: "@agent 这个方案你怎么看？", mentionsBot: true,
      messageId: `om_full_${index}`, ...(index ? { rootMessageId: "om_full_0", threadId: "omt_full" } : {}), createdAt: 100 + index });
    for (let index = 0; index < 4; index++) await send(index);
    expect(requests).toEqual([{ mode: "start" }, { mode: "fork", id: ids[0] }, { mode: "fork", id: ids[1] }, { mode: "fork", id: ids[1] }]);
    const successful = engine.chatRuns.list(space).filter(run => run.status === "succeeded");
    expect(successful).toHaveLength(3);
    expect(successful.every(run => run.delivery.status === "sent")).toBe(true);
    engine.agents.revokeLocalExecutionGrants(agent.id, engine.agents.get(agent.id)!.publishedRevisionId!);
    await send(4);
    expect(requests).toHaveLength(4);
    expect(engine.chatRuns.list(space)[0]?.status).toBe("failed");
    expect(transport.sent).toHaveLength(5);
  } finally { await orch.stop(); engine.close(); rmSync(root, { recursive: true, force: true }); }
});
