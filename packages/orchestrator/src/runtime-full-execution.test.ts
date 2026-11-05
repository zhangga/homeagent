import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeEngine, SkillCatalog, FakeLlm } from "@homeagent/core";
import { CliConnector, type Connector, type InboundMessage } from "@homeagent/connectors";
import type { NativeSessionRequest } from "@homeagent/llm";
import { Orchestrator } from "./runtime.ts";

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !check(); i++) await Bun.sleep(5);
  expect(check()).toBe(true);
}

test("one full Agent runs independent group items concurrently while item and topic follow-ups wait for delivery", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ha-full-concurrent-")));
  const workdir = join(root, "work");
  mkdirSync(workdir);
  const research = Promise.withResolvers<void>();
  const report = Promise.withResolvers<void>();
  const third = Promise.withResolvers<void>();
  const delivery = Promise.withResolvers<void>();
  const reaction = Promise.withResolvers<void>();
  const removedReactions: string[] = [];
  const calls: Array<{ topic: string; native?: NativeSessionRequest }> = [];
  const researchSession = "11111111-2222-4333-8444-555555555555";
  const engine = new KnowledgeEngine({
    dataDir: join(root, "data"), skillCatalog: new SkillCatalog({ roots: [] }),
    runProvider: async (_provider, input) => {
      const permit = input.acquireExecutionPermit!();
      const unregister = permit.register(() => {});
      permit.release();
      try {
        expect(input.execution?.permission).toBe("full");
        expect(input.execution?.executionMode).toBe("local-full-access");
        expect(input.execution?.workdir).toBe(workdir);
        const topic = input.prompt.includes("独立接口检查") ? "third"
          : input.prompt.includes("另一个主题") ? "topic-followup"
          : input.prompt.includes("补充平台分类") ? "item-followup"
          : input.prompt.includes("项目周报") ? "report" : "research";
        calls.push({ topic, native: input.nativeSession });
        if (topic === "research") await research.promise;
        if (topic === "report") await report.promise;
        if (topic === "third") await third.promise;
        return {
          text: `offline ${topic} done`,
          nativeSessionId: topic === "research" ? researchSession : "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
          usage: { costBasis: "unavailable", source: "legacy-text" },
        };
      } finally { unregister(); }
    },
  });
  const transport = new CliConnector();
  const connector: Connector = {
    name: "feishu", start: handler => transport.start(handler), stop: () => transport.stop(),
    notice: (chatId, text, options) => transport.notice(chatId, text, options),
    addReaction: async messageId => { await reaction.promise; return `thinking_${messageId}`; },
    removeReaction: async messageId => { removedReactions.push(messageId); },
    reply: async reply => {
      if (reply.replyToMessageId === "research" && reply.idempotencyKey?.endsWith(":final")) await delivery.promise;
      return transport.reply(reply);
    },
  };
  const classifier = new FakeLlm();
  classifier.onJSON(() => ({ slugs: [], relevant: false }));
  const runtime = new Orchestrator({ engine, connector, llm: classifier });
  const pending: Promise<void>[] = [];
  const space = "team/oc_parallel" as const;
  const send = (id: string, text: string, rootMessageId?: string) => {
    const message: InboundMessage = { kind: "message", eventId: id, chatType: "group",
      chatId: "oc_parallel", senderId: "ou_fixture", messageId: id, text, mentionsBot: true,
      createdAt: Date.now(), ...(rootMessageId ? { rootMessageId, threadId: "omt_research" } : {}) };
    const completion = transport.inject(message);
    pending.push(completion);
    return completion;
  };
  try {
    engine.ensureSpace(space, { chatId: "oc_parallel" });
    engine.feishuBindings.connect({ spaceId: space, chatId: "oc_parallel", boundAppId: "cli_fixture", responseMode: "mentions_only", replyInThread: true });
    const agent = engine.agents.create({ name: "全权限助理", provider: "codex", visibility: "Team" });
    engine.updateSpaceMeta(space, { agentId: agent.id });
    const draft = engine.agents.saveDraft(agent.id, { executionMode: "local-full-access", permission: "full", workdir })!;
    engine.localExecution.release(agent.id, draft.id, draft.id, {
      termsVersion: 1, source: "local-operator", taskExecutionEnabled: false,
      expectedScopeFingerprint: engine.localExecution.preview(agent.id, draft.id).fingerprint,
    });
    const revisionId = engine.agents.get(agent.id)!.publishedRevisionId;
    const cancelledItem = engine.workItems.create({ space, title: "调研技术方案" });
    engine.workItems.update(cancelledItem.id, { active: false });
    await runtime.start();
    const first = send("research", "调研技术方案");
    await until(() => {
      const failed = engine.chatRuns.list(space).find(run => run.status === "failed");
      if (failed) throw new Error(failed.error?.message ?? "fixture run failed");
      return calls.length === 1;
    });
    const second = send("report", "整理项目周报");
    await until(() => calls.length === 2);
    const original = engine.chatRuns.list(space).find(run => run.messageId === "research")!;
    expect(original.workItemId).not.toBe(cancelledItem.id);
    expect(engine.workItems.get(cancelledItem.id)?.active).toBe(false);
    expect(engine.chatRuns.list(space).filter(run => run.status === "running")).toHaveLength(2);
    expect(engine.chatRuns.list(space).every(run => run.agentId === agent.id
      && run.executionPlan?.agentRevisionId === revisionId
      && run.execution?.executionMode === "local-full-access")).toBe(true);

    const thirdRun = send("third", "分析独立接口检查");
    await until(() => engine.chatRuns.list(space).some(run => run.messageId === "third" && run.status === "queued"));
    expect(calls).toHaveLength(2);
    await send("item-followup", "补充平台分类，调研技术方案");
    expect(engine.workDispatch.list(space).find(input => input.message.messageId === "item-followup")?.state).toBe("waiting");
    const topicRun = send("topic-followup", "另外分析另一个主题", "research");
    await until(() => engine.workDispatch.list(space).some(input => input.message.messageId === "topic-followup"));
    expect(calls).toHaveLength(2);

    report.resolve();
    await second;
    await until(() => calls.length === 3);
    expect(calls[2]?.topic).toBe("third");
    expect(engine.chatRuns.get(original.id)?.status).toBe("running");
    research.resolve();
    await until(() => engine.chatRuns.get(original.id)?.status === "succeeded");
    expect(engine.chatRuns.get(original.id)?.delivery.status).toBe("pending");
    expect(calls).toHaveLength(3);
    delivery.resolve();
    await first;
    third.resolve();
    await Promise.all([thirdRun, topicRun]);
    runtime.flushWorkInputs();
    await until(() => engine.workDispatch.list(space).find(input => input.message.messageId === "item-followup")?.state === "settled");
    expect(calls.find(call => call.topic === "topic-followup")?.native).toEqual({ mode: "fork", id: researchSession });
    const followups = engine.chatRuns.list(space);
    expect(followups.find(run => run.messageId === "item-followup")?.workItemId).toBe(original.workItemId);
    expect(followups.find(run => run.messageId === "topic-followup")?.workItemId).not.toBe(original.workItemId);
    expect(followups).toHaveLength(5);
    expect(followups.every(run => run.status === "succeeded" && run.delivery.status === "sent")).toBe(true);
    expect(removedReactions).toEqual([]);
    reaction.resolve();
    await until(() => removedReactions.length === 5);
    expect(removedReactions.sort()).toEqual(["item-followup", "report", "research", "third", "topic-followup"]);
  } finally {
    research.resolve(); report.resolve(); third.resolve(); delivery.resolve(); reaction.resolve();
    await Promise.allSettled(pending);
    await runtime.stop();
    engine.close();
    rmSync(root, { recursive: true, force: true });
  }
});

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
