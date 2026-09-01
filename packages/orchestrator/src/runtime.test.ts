import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderRunError, type JSONOptions } from "@homeagent/llm";
import {
  AI_OPERATION_TIMEOUT_MS,
  resetConfig,
  saveSettings,
  type SpaceId,
} from "@homeagent/shared";
import { KnowledgeEngine, FakeLlm, type AgentInput, type LlmClient } from "@homeagent/core";
import { CliConnector, type Connector } from "@homeagent/connectors";
import { Orchestrator } from "./runtime.ts";

let dir: string;
let engine: KnowledgeEngine;
let connector: CliConnector;
let orch: Orchestrator;
let fake: FakeLlm;
const cliOnlyRuntimes: Array<{
  engine: KnowledgeEngine;
  connector: CliConnector;
  orchestrator: Orchestrator;
}> = [];

function grantGroupAdministrator(): void {
  (connector as CliConnector & Connector).isChatAdministrator = async () => true;
}

/**
 * One fake serves participation, routing, and synthesis by inspecting each
 * call's schema/prompt.
 */
function makeFake(): FakeLlm {
  const f = new FakeLlm();
  f.onJSON((call: JSONOptions<unknown>) => {
    const props = (call.schema as { properties?: Record<string, unknown> }).properties ?? {};
    if ("participationScore" in props) {
      const prompt = String(call.prompt ?? "");
      return {
        participationScore: /谁负责后端服务/.test(prompt) && !/@Alice/.test(prompt) ? 95 : 10,
        disruptionRisk: /谁负责后端服务/.test(prompt) && !/@Alice/.test(prompt) ? 10 : 80,
        reason: "测试中的群聊参与判断",
      };
    }
    if ("triggerAt" in props) {
      const prompt = String(call.prompt ?? "");
      if (/@agent 7\.22日上午七点半/u.test(prompt)) {
        return {
          resolved: true,
          title: "购买8.5日北京去苏州的火车票",
          triggerAt: "2099-07-22T07:30:00+08:00",
          untilConfirmed: false,
        };
      }
      return { resolved: false, title: "", triggerAt: "", untilConfirmed: false };
    }
    if ("steps" in props) {
      return {
        name: "Rust 异步",
        steps: [
          { title: "Future", objective: "理解 Future" },
          { title: "运行时", objective: "理解运行时" },
        ],
      };
    }
    if ("mastery" in props) {
      return {
        feedback: "## 回应点评\n理解正确\n\n## 需要澄清\n无\n\n## 今日总结\n掌握重点\n\n## 下一步\n继续应用",
        mastery: "ready",
        nextFocus: "进入下一个知识点",
        learningRecord: {
          title: "原则支持稳定决策",
          summary: "原则帮助学习者在不同情境中稳定地做出决策。",
          evidence: "学习者能够用自己的话说明原则的实际作用。",
          implications: [],
        },
      };
    }
    if ("relevant" in props) {
      // route: pick the alice page when the question mentions 后端
      const prompt = String(call.prompt ?? "");
      if (/后端/.test(prompt)) return { slugs: ["entities/alice"], relevant: true };
      return { slugs: [], relevant: false };
    }
    if ("grounded" in props) {
      return {
        answer: "后端由 [[entities/alice|Alice]] 负责。",
        grounded: true,
        usedSlugs: ["entities/alice"],
        gaps: [],
      };
    }
    throw new Error("unexpected schema");
  });
  f.onText((opts) => String(opts.prompt).includes("## 学习者回答")
    ? "## 回应点评\n理解正确\n\n## 今日总结\n掌握重点"
    : "这不在知识库记录中，以下是我的一般性回答：暂无更多信息。");
  return f;
}

function makeCliOnlyRuntime(
  cliEngine: KnowledgeEngine,
  space: SpaceId,
  agentInput?: AgentInput,
  runtimeOptions: { chatAnswerTimeoutMs?: number } = {},
) {
  cliEngine.ensureSpace(space);
  if (space.startsWith("team/")) {
    const chatId = space.slice("team/".length);
    cliEngine.feishuBindings.connect({
      chatId,
      spaceId: space,
      responseMode: "smart",
      participationLevel: "balanced",
      replyInThread: true,
    });
  }
  if (agentInput) {
    const agent = cliEngine.agents.create({
      ...agentInput,
      visibility: agentInput.visibility ?? (space.startsWith("personal/") ? "Personal" : "Team"),
    });
    cliEngine.registry.updateMeta(space, { agentId: agent.id });
  }
  const cliConnector = new CliConnector({
    groupChatId: "oc_team",
    p2pChatId: "oc_dm",
    userId: "ou_me",
  });
  const cliOrch = new Orchestrator({
    engine: cliEngine,
    connector: cliConnector,
    ...runtimeOptions,
  });
  const runtime = { engine: cliEngine, connector: cliConnector, orchestrator: cliOrch };
  cliOnlyRuntimes.push(runtime);
  return runtime;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hb-orch-"));
  process.env.HOMEAGENT_DATA_DIR = dir;
  resetConfig();
  fake = makeFake();
  engine = new KnowledgeEngine({ dataDir: dir, llm: fake });
  engine.feishuBindings.connect({
    chatId: "oc_team",
    spaceId: "team/oc_team",
    responseMode: "smart",
    participationLevel: "balanced",
    replyInThread: true,
  });
  connector = new CliConnector({ groupChatId: "oc_team", p2pChatId: "oc_dm", userId: "ou_me" });
  orch = new Orchestrator({ engine, connector, llm: fake });
});

afterEach(async () => {
  for (const runtime of cliOnlyRuntimes.splice(0)) {
    await runtime.orchestrator.stop();
    runtime.engine.close();
  }
  await orch.stop();
  engine.close();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.HOMEAGENT_DATA_DIR;
  resetConfig();
});

describe("orchestrator trunk (cli connector, no feishu)", () => {
  test("a new Chat Run is attached to the current work item", async () => {
    const workItem = engine.workItems.create({
      space: "team/oc_team",
      title: "跟进群聊结论",
    });
    await orch.start();

    await connector.sendGroup("hello", true);

    const run = engine.chatRuns.list("team/oc_team")[0]!;
    expect(run.workItemId).toBe(workItem.id);
    expect(engine.workItems.get(workItem.id)?.chatRunIds).toContain(run.id);
  });

  test("an unbound group event has no capture, model, or reply side effects", async () => {
    engine.feishuBindings.disconnect("team/oc_team");
    let downloads = 0;
    orch = new Orchestrator({
      engine,
      connector,
      llm: fake,
      attachmentDownloader: async () => {
        downloads += 1;
        return [];
      },
    });
    await orch.start();

    await connector.inject({
      kind: "message",
      eventId: "unbound-file",
      chatType: "group",
      chatId: "oc_team",
      senderId: "ou_me",
      text: "@agent remember this file",
      messageId: "om_unbound",
      messageType: "file",
      mentionsBot: true,
      createdAt: Date.now(),
    });

    expect(engine.registry.has("team/oc_team")).toBeFalse();
    expect(connector.sent).toEqual([]);
    expect(fake.calls).toEqual([]);
    expect(downloads).toBe(0);
  });

  test("a binding for a replaced Bot cannot be consumed by the running Bot", async () => {
    engine.feishuBindings.connect({
      chatId: "oc_team",
      spaceId: "team/oc_team",
      boundAppId: "cli_new",
      responseMode: "mentions_only",
      replyInThread: true,
    });
    orch = new Orchestrator({
      engine,
      connector,
      llm: fake,
      activeFeishuAppId: "cli_old",
    });
    await orch.start();

    await connector.sendGroup("@agent do not consume this", true);

    expect(engine.registry.has("team/oc_team")).toBeFalse();
    expect(connector.sent).toEqual([]);
    expect(fake.calls).toEqual([]);
  });

  test("health reports answer, proactive participation, and queue metrics without content", async () => {
    await engine.upsertPage(
      "team/oc_team",
      {
        slug: "entities/alice",
        type: "entity",
        title: "Alice",
        summary: "Alice 负责后端服务",
        aliases: [],
        tags: [],
        sources: [],
        links: [],
        content: "Alice 负责后端服务。",
        updatedAt: Date.now(),
        contentHash: "health",
      },
    );
    const originalAsk = engine.askWithExecutionPlan.bind(engine);
    engine.askWithExecutionPlan = async (spaces, question, plan, evidence, opts) => {
      await Bun.sleep(5);
      return originalAsk(spaces, question, plan, evidence, opts);
    };
    await orch.start();
    await connector.sendGroup("@agent 谁负责后端服务？", true);
    await connector.sendGroup("Alice 今天更新了后端服务。", false);

    const health = orch.health();
    expect(health.answers).toEqual(expect.objectContaining({
      total: 1,
      succeeded: 1,
      failed: 0,
      recent: expect.objectContaining({ sampleSize: 1, failureRate: 0 }),
    }));
    expect(health.answers.averageLatencyMs).toBeGreaterThanOrEqual(5);
    expect(health.answers.maxLatencyMs).toBeGreaterThanOrEqual(5);
    expect(health.proactiveParticipation).toEqual(expect.objectContaining({
      evaluated: 1,
      skipped: 1,
      model: 1,
    }));
    expect(health.queue).toEqual(expect.objectContaining({
      key: "main",
      pending: 0,
      completed: 2,
    }));
    expect(health.runs).toEqual(expect.objectContaining({
      queued: 0,
      running: 0,
      completed: 1,
      limited: 0,
    }));
    expect(JSON.stringify(health)).not.toContain("Alice 今天更新了后端服务");
    expect(JSON.stringify(health)).not.toContain("oc_team");
  });

  test("health counts an answer provider failure", async () => {
    const failing = new FakeLlm();
    failing.onJSON((call) => {
      const props = (call.schema as { properties?: Record<string, unknown> }).properties ?? {};
      if ("relevant" in props) return { slugs: ["entities/alice"], relevant: true };
      throw new Error("provider failed");
    });
    engine.close();
    engine = new KnowledgeEngine({ dataDir: dir, llm: failing });
    await engine.upsertPage("team/oc_team", {
      slug: "entities/alice",
      type: "entity",
      title: "Alice",
      summary: "Alice 负责后端服务",
      aliases: [],
      tags: [],
      sources: [],
      links: [],
      content: "Alice 负责后端服务。",
      updatedAt: Date.now(),
      contentHash: "health-failure",
    });
    const failureAgent = engine.agents.create({
      name: "Failure diagnostics Agent",
      provider: "claude",
      visibility: "Team",
    });
    engine.updateSpaceMeta("team/oc_team", { agentId: failureAgent.id });
    orch = new Orchestrator({ engine, connector, llm: failing });
    await orch.start();
    await connector.sendGroup("@agent 谁负责后端服务？", true);

    expect(orch.health().answers).toEqual(expect.objectContaining({
      total: 1,
      succeeded: 0,
      failed: 1,
      recent: expect.objectContaining({ sampleSize: 1, failureRate: 1 }),
    }));
    expect(engine.chatRuns.listByAgent(failureAgent.id, 10)).toEqual([
      expect.objectContaining({
        status: "failed",
        error: {
          kind: "unknown",
          message: "provider failed",
        },
        delivery: expect.objectContaining({
          status: "sent",
          attempts: 1,
        }),
      }),
    ]);
  });

  test("a provider failure links its quality trace and usage to the durable Chat Run", async () => {
    const failing = new FakeLlm();
    const providerFailure = () => {
      throw new ProviderRunError("claude", "provider claude exited 1", {
        inputTokens: 60,
        outputTokens: 7,
        costUsd: 0.006,
        costBasis: "reported",
        source: "claude-json",
      });
    };
    failing.onJSON(providerFailure);
    failing.onText(providerFailure);
    engine.close();
    engine = new KnowledgeEngine({ dataDir: dir, llm: failing });
    engine.ensureSpace("team/oc_team", { chatId: "oc_team" });
    const agent = engine.agents.create({
      name: "Failure usage Agent",
      provider: "claude",
      visibility: "Team",
    });
    engine.updateSpaceMeta("team/oc_team", { agentId: agent.id });
    orch = new Orchestrator({ engine, connector, llm: failing });
    await orch.start();

    await connector.sendGroup("@agent diagnose the provider failure", true);

    const run = engine.chatRuns.listByAgent(agent.id, 10)[0]!;
    expect(run).toEqual(expect.objectContaining({
      status: "failed",
      traceId: expect.any(String),
      usage: {
        calls: 1,
        knownTokenCalls: 1,
        unknownTokenCalls: 0,
        knownCostCalls: 1,
        unknownCostCalls: 0,
        inputTokens: 60,
        outputTokens: 7,
        costUsd: 0.006,
        costBasis: "reported",
        sources: ["claude-json"],
      },
    }));
    expect(engine.answerTrace(run.traceId!)).toEqual(expect.objectContaining({
      outcome: "failed",
      usage: run.usage,
    }));
  });

  test("bot-added events do not reopen a locally disconnected group", async () => {
    engine.feishuBindings.disconnect("team/oc_team");
    await orch.start();
    await connector.sendBotAdded();
    expect(connector.notices).toEqual([]);
    expect(engine.registry.has("team/oc_team")).toBe(false);
    expect(engine.feishuBindings.activeByChatId("oc_team")).toBeUndefined();
  });

  test("a new group stays pending until an administrator confirms in-group", async () => {
    const capableConnector = connector as CliConnector & Connector;
    capableConnector.getBotChat = async (chatId) => ({
      chatId,
      name: "Product",
    });
    capableConnector.checkChatAdministrator = async (_chatId, userId) =>
      userId === "ou_admin";
    await orch.start();

    await connector.inject({
      kind: "bot_added",
      eventId: "added-new-group",
      chatId: "oc_product",
      createdAt: Date.now(),
    });
    await connector.inject({
      kind: "message",
      eventId: "pending-ordinary-message",
      chatType: "group",
      chatId: "oc_product",
      senderId: "ou_member",
      text: "do not capture this",
      messageId: "om_pending",
      mentionsBot: false,
      createdAt: Date.now(),
    });

    expect(engine.feishuBindings.getByChatId("oc_product")?.state)
      .toBe("pending_confirmation");
    expect(engine.registry.has("team/oc_product")).toBeFalse();
    expect(connector.notices).toHaveLength(1);
    expect(connector.notices[0]?.markdown).toContain("@HomeAgent 启用群聊");
    expect(connector.notices[0]?.markdown).toContain(
      "请群主或管理员在群内发送“@HomeAgent 启用群聊”。",
    );

    await connector.inject({
      kind: "message",
      eventId: "activate-new-group",
      chatType: "group",
      chatId: "oc_product",
      senderId: "ou_admin",
      text: "@HomeAgent 启用群聊",
      messageId: "om_activate",
      mentionsBot: true,
      createdAt: Date.now(),
    });

    expect(engine.feishuBindings.getByChatId("oc_product")).toMatchObject({
      state: "active",
      responseMode: "mentions_only",
      replyInThread: true,
    });
    expect(engine.registry.get("team/oc_product")).toMatchObject({
      chatId: "oc_product",
      name: "Product",
    });
    expect(connector.sent.at(-1)?.markdown).toContain("本群已启用");
  });

  test("unaddressed group message is captured but gets no reply (Q2)", async () => {
    await orch.start();
    await connector.sendGroup("Alice 负责后端服务，主导架构。", false);
    expect(connector.sent.length).toBe(0); // no reply
    // captured into team space
    const pending = engine.registry.store("team/oc_team").index().countRaw(true);
    expect(pending).toBe(1);
    expect(fake.calls.some((call) =>
      call.kind === "json"
      && String(call.opts.prompt).includes("群消息是否值得机器人主动回答")
    )).toBe(true);
  });

  test("mentions-only captures delivered group messages without classification", async () => {
    engine.feishuBindings.updatePolicy("team/oc_team", {
      responseMode: "mentions_only",
      participationLevel: undefined,
      replyInThread: true,
    });
    await orch.start();

    await connector.sendGroup("ordinary unmentioned update", false);

    expect(engine.registry.store("team/oc_team").index().countRaw(true)).toBe(1);
    expect(connector.sent).toEqual([]);
    expect(fake.calls.some((call) =>
      call.kind === "json"
      && String(call.opts.prompt).includes("群消息是否值得机器人主动回答")
    )).toBeFalse();
  });

  test("all-messages replies to eligible unmentioned messages without classification", async () => {
    engine.feishuBindings.updatePolicy("team/oc_team", {
      responseMode: "all_messages",
      participationLevel: undefined,
      replyInThread: true,
    });
    await orch.start();

    await connector.sendGroup("hello", false);

    expect(connector.sent).toHaveLength(1);
    expect(engine.registry.store("team/oc_team").index().countRaw(true)).toBe(1);
    expect(fake.calls.some((call) =>
      call.kind === "json"
      && String(call.opts.prompt).includes("群消息是否值得机器人主动回答")
    )).toBeFalse();
  });

  test("an addressed Chat is durably attributed to the Agent that handled it", async () => {
    engine.ensureSpace("team/oc_team", { chatId: "oc_team" });
    const agent = engine.agents.create({
      name: "Group Chat Agent",
      provider: "claude",
      visibility: "Team",
    });
    engine.updateSpaceMeta("team/oc_team", { agentId: agent.id });
    await orch.start();

    await connector.sendGroup("@agent what is the release process?", true);

    const chats = engine.listAgentChatRecords(agent.id, 10);
    expect(chats).toEqual([
      expect.objectContaining({
        agentId: agent.id,
        space: "team/oc_team",
        content: "@agent what is the release process?",
      }),
    ]);
    const detail = await engine.getRawGovernanceDetail("team/oc_team", chats[0]!.id);
    expect(detail?.raw).toMatchObject({
      agentResponse: connector.sent[0]!.markdown,
      agentRespondedAt: expect.any(Number),
    });
    expect(engine.chatRuns.listByAgent(agent.id, 10)).toEqual([
      expect.objectContaining({
        rawId: chats[0]!.id,
        agentId: agent.id,
        provider: "claude",
        status: "succeeded",
        output: connector.sent[0]!.markdown,
        usage: {
          calls: 1,
          knownTokenCalls: 0,
          unknownTokenCalls: 1,
          knownCostCalls: 0,
          unknownCostCalls: 1,
          costBasis: "unavailable",
          sources: [],
        },
        delivery: expect.objectContaining({
          status: "sent",
          attempts: 1,
          sentAt: expect.any(Number),
        }),
      }),
    ]);
    expect(engine.listAgentActivityRuns(agent.id, 10)).toEqual([
      expect.objectContaining({
        kind: "chat",
        legacy: false,
        run: expect.objectContaining({ status: "succeeded" }),
        record: expect.objectContaining({ id: chats[0]!.id }),
      }),
    ]);
  });

  test("a failed outbound delivery is not recorded as an Agent response", async () => {
    engine.ensureSpace("team/oc_team", { chatId: "oc_team" });
    const agent = engine.agents.create({
      name: "Delivery-aware Agent",
      provider: "claude",
      visibility: "Team",
    });
    engine.updateSpaceMeta("team/oc_team", { agentId: agent.id });
    const deliver = connector.reply.bind(connector);
    connector.reply = async () => {
      throw new Error("Feishu delivery failed");
    };
    await orch.start();

    await expect(connector.sendGroup("@agent hello", true))
      .rejects.toThrow("Feishu delivery failed");

    const chats = engine.listAgentChatRecords(agent.id, 10);
    expect(chats).toHaveLength(1);
    const detail = await engine.getRawGovernanceDetail("team/oc_team", chats[0]!.id);
    expect(detail?.raw.agentResponse).toBeUndefined();
    expect(detail?.raw.agentRespondedAt).toBeUndefined();
    expect(engine.chatRuns.listByAgent(agent.id, 10)).toEqual([
      expect.objectContaining({
        rawId: chats[0]!.id,
        status: "succeeded",
        delivery: expect.objectContaining({
          status: "failed",
          attempts: 1,
          error: "Feishu delivery failed",
        }),
      }),
    ]);

    const failedDeliveryRun = engine.chatRuns.listByAgent(agent.id, 10)[0]!;
    connector.reply = deliver;
    const retried = await orch.retryChatRun(failedDeliveryRun.id);

    expect(retried).toEqual(expect.objectContaining({
      id: failedDeliveryRun.id,
      status: "succeeded",
      delivery: expect.objectContaining({
        status: "sent",
        attempts: 2,
      }),
    }));
    expect(connector.sent).toHaveLength(1);
  });

  test("an in-flight reply keeps its Chat Run audit and blocks space export or deletion", async () => {
    let markReplyStarted!: () => void;
    let releaseReply!: () => void;
    const replyStarted = new Promise<void>((resolve) => {
      markReplyStarted = resolve;
    });
    const replyGate = new Promise<void>((resolve) => {
      releaseReply = resolve;
    });
    const originalReply = connector.reply.bind(connector);
    connector.reply = async (out) => {
      markReplyStarted();
      await replyGate;
      await originalReply(out);
    };
    await orch.start();

    const handling = connector.sendGroup("hello", true);
    await replyStarted;
    const run = engine.chatRuns.list("team/oc_team")[0]!;
    expect(run).toEqual(expect.objectContaining({
      status: "succeeded",
      delivery: expect.objectContaining({ status: "pending", attempts: 1 }),
    }));

    try {
      expect(await engine.retractMessage("team/oc_team", {
        chatId: "oc_team",
        messageId: "om_cli-1",
        requestedBy: "ou_me",
      })).toEqual(expect.objectContaining({ status: "retracted" }));
      expect(engine.chatRuns.get(run.id)).toEqual(expect.objectContaining({
        delivery: expect.objectContaining({ status: "pending", attempts: 1 }),
      }));
      await expect(engine.exportSpace("team/oc_team"))
        .rejects.toThrow("delivering chat responses");
      await expect(engine.deleteSpace("team/oc_team"))
        .rejects.toThrow("delivering chat responses");
    } finally {
      releaseReply();
      await handling;
    }

    expect(engine.chatRuns.get(run.id)?.delivery.status).toBe("sent");
    expect((await engine.exportSpace("team/oc_team")).chatRuns).toHaveLength(1);
  });

  test("retrying a failed text Chat creates a linked Run with the current execution", async () => {
    engine.ensureSpace("team/oc_team", { chatId: "oc_team" });
    const agent = engine.agents.create({
      name: "Retry Agent",
      provider: "claude",
      visibility: "Team",
    });
    engine.updateSpaceMeta("team/oc_team", { agentId: agent.id });
    const previous = engine.chatRuns.start({
      space: "team/oc_team",
      chatId: "oc_team",
      messageId: "om_retry_source",
      author: "ou_me",
      input: "请重新给出结论",
      trigger: "message",
      agentId: agent.id,
      provider: "claude",
    });
    engine.chatRuns.fail(previous.id, {
      finishedAt: previous.startedAt,
      error: {
        kind: "provider_unavailable",
        message: "Provider unavailable",
      },
    });

    const retried = await orch.retryChatRun(previous.id);

    expect(retried).toEqual(expect.objectContaining({
      id: expect.not.stringMatching(previous.id),
      retryOf: previous.id,
      trigger: "retry",
      agentId: agent.id,
      provider: "claude",
      status: "succeeded",
      delivery: expect.objectContaining({
        status: "sent",
        attempts: 1,
      }),
    }));
    expect(engine.chatRuns.get(previous.id)?.status).toBe("failed");
  });

  test("a queued Chat Run resumes with its immutable execution plan after Agent edits", async () => {
    engine.ensureSpace("team/oc_team", { chatId: "oc_team" });
    const agent = engine.agents.create({
      name: "Queued Chat Agent",
      instruction: "Use the original queued Chat persona.",
      provider: "claude",
      model: "claude-original",
      visibility: "Team",
    });
    engine.updateSpaceMeta("team/oc_team", { agentId: agent.id });
    const queued = engine.chatRuns.start({
      space: "team/oc_team",
      chatId: "oc_team",
      messageId: "om_queued_restart",
      author: "ou_me",
      input: "@agent explain the queued snapshot?",
      trigger: "message",
      agentId: agent.id,
      provider: "claude",
      model: "claude-original",
      executionPlan: {
        version: 1,
        instruction: "Use the original queued Chat persona.",
        provider: "claude",
        model: "claude-original",
      },
    });
    engine.agents.update(agent.id, {
      instruction: "Use the changed live Chat persona.",
      provider: "codex",
      model: "gpt-changed",
    });
    engine.close();

    let providerCall: {
      provider: string;
      system?: string;
      model?: string;
      execution?: unknown;
    } | undefined;
    engine = new KnowledgeEngine({
      dataDir: dir,
      runProvider: async (provider, input) => {
        providerCall = {
          provider,
          system: input.system,
          model: input.model,
          execution: input.execution,
        };
        return "snapshot answer";
      },
    });
    connector = new CliConnector({ groupChatId: "oc_team", p2pChatId: "oc_dm", userId: "ou_me" });
    orch = new Orchestrator({ engine, connector });
    await orch.start();
    await orch.stop();

    expect(engine.chatRuns.get(queued.id)).toEqual(expect.objectContaining({
      id: queued.id,
      status: "succeeded",
      runStartedAt: expect.any(Number),
      delivery: expect.objectContaining({ status: "sent" }),
    }));
    expect(providerCall).toEqual(expect.objectContaining({
      provider: "claude",
      system: expect.stringContaining("Use the original queued Chat persona."),
      model: "claude-original",
      execution: undefined,
    }));
    expect(providerCall?.system).not.toContain("Use the changed live Chat persona.");
  });

  test("a legacy queued Chat Run without an execution plan fails closed on recovery", async () => {
    engine.ensureSpace("team/oc_team", { chatId: "oc_team" });
    const agent = engine.agents.create({
      name: "Legacy Queued Chat Agent",
      provider: "claude",
      visibility: "Team",
    });
    engine.updateSpaceMeta("team/oc_team", { agentId: agent.id });
    const queued = engine.chatRuns.start({
      space: "team/oc_team",
      chatId: "oc_team",
      messageId: "om_legacy_queued_restart",
      author: "ou_me",
      input: "@agent this legacy run must fail closed?",
      trigger: "message",
      agentId: agent.id,
      provider: "claude",
    });
    engine.close();

    let providerCalls = 0;
    engine = new KnowledgeEngine({
      dataDir: dir,
      runProvider: async () => {
        providerCalls += 1;
        return "must not execute";
      },
    });
    connector = new CliConnector({ groupChatId: "oc_team", p2pChatId: "oc_dm", userId: "ou_me" });
    orch = new Orchestrator({ engine, connector });
    await orch.start();
    await orch.stop();

    expect(providerCalls).toBe(0);
    expect(engine.chatRuns.get(queued.id)).toEqual(expect.objectContaining({
      status: "failed",
      error: expect.objectContaining({
        message: expect.stringMatching(/execution plan/i),
      }),
    }));
  });

  test("different chats run concurrently while the provider/model layer queues overflow", async () => {
    const completions: Array<(text: string) => void> = [];
    const blockingLlm: LlmClient = {
      complete: async () => new Promise((resolve) => {
        completions.push((text) => resolve({
          text,
          model: "blocking",
          inputTokens: 1,
          outputTokens: 1,
          costUsd: 0,
        }));
      }),
      completeJSON: (options) => fake.completeJSON(options),
    };
    engine.close();
    engine = new KnowledgeEngine({ dataDir: dir, llm: blockingLlm });
    for (const chatId of ["oc_layer_a", "oc_layer_b", "oc_layer_c"]) {
      engine.feishuBindings.connect({
        chatId,
        spaceId: `team/${chatId}`,
        responseMode: "mentions_only",
        replyInThread: true,
      });
    }
    orch = new Orchestrator({ engine, connector, llm: blockingLlm });
    const send = (chatId: string) => orch.enqueue({
      kind: "message",
      eventId: `event_${chatId}`,
      chatType: "group",
      chatId,
      senderId: "ou_me",
      text: "@agent 请分析",
      messageId: `message_${chatId}`,
      mentionsBot: true,
      createdAt: Date.now(),
    });

    const pending = ["oc_layer_a", "oc_layer_b", "oc_layer_c"].map(send);
    for (let attempt = 0; attempt < 200 && completions.length < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(completions).toHaveLength(2);
    expect(engine.runScheduler.snapshot()).toEqual(expect.objectContaining({
      running: 2,
      queued: 1,
      limited: 1,
    }));
    expect(engine.chatRuns.list().filter((run) => run.status === "queued")).toHaveLength(1);

    completions.shift()!("first");
    for (let attempt = 0; attempt < 200 && completions.length < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(completions).toHaveLength(2);

    completions.splice(0).forEach((resolve, index) => resolve(`answer ${index}`));
    await Promise.all(pending);
    expect(engine.chatRuns.list().every((run) => run.status === "succeeded")).toBeTrue();
  });

  test("a running Chat Run can be cancelled through its provider boundary", async () => {
    const blockingLlm: LlmClient = {
      complete: async () => new Promise(() => undefined),
      completeJSON: (options) => fake.completeJSON(options),
    };
    engine.close();
    engine = new KnowledgeEngine({ dataDir: dir, llm: blockingLlm });
    engine.feishuBindings.connect({
      chatId: "oc_cancel_chat",
      spaceId: "team/oc_cancel_chat",
      responseMode: "mentions_only",
      replyInThread: true,
    });
    orch = new Orchestrator({ engine, connector, llm: blockingLlm });
    const pending = orch.enqueue({
      kind: "message",
      eventId: "event_cancel_chat",
      chatType: "group",
      chatId: "oc_cancel_chat",
      senderId: "ou_me",
      text: "@agent 请分析",
      messageId: "message_cancel_chat",
      mentionsBot: true,
      createdAt: Date.now(),
    });
    let running;
    for (let attempt = 0; attempt < 200 && !running; attempt += 1) {
      running = engine.chatRuns.list().find((run) => run.status === "running");
      if (!running) await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(running).toBeDefined();
    expect(orch.cancelChatRun(running!.id)).toBe(true);
    await pending;
    expect(engine.chatRuns.get(running!.id)).toEqual(expect.objectContaining({
      status: "cancelled",
      error: expect.objectContaining({ kind: "cancelled" }),
    }));
  });

  test("a retry does not duplicate a reply when delivery succeeded before Run persistence failed", async () => {
    engine.ensureSpace("team/oc_team", { chatId: "oc_team" });
    const agent = engine.agents.create({
      name: "Idempotent delivery Agent",
      provider: "claude",
      visibility: "Team",
    });
    engine.updateSpaceMeta("team/oc_team", { agentId: agent.id });
    const persistDelivery = engine.chatRuns.deliverySent.bind(engine.chatRuns);
    engine.chatRuns.deliverySent = () => {
      throw new Error("disk unavailable after delivery");
    };
    await orch.start();

    await connector.sendGroup("@agent hello", true);

    const run = engine.chatRuns.listByAgent(agent.id, 10)[0]!;
    expect(run.delivery.status).toBe("pending");
    expect(connector.sent).toHaveLength(1);

    engine.chatRuns.deliverySent = persistDelivery;
    const retried = await orch.retryChatRun(run.id);

    expect(retried.delivery.status).toBe("sent");
    expect(connector.sent).toHaveLength(1);
  });

  test("a capture-only group message is not shown as an Agent Chat run", async () => {
    engine.ensureSpace("team/oc_team", { chatId: "oc_team" });
    const agent = engine.agents.create({
      name: "Mentions-only Agent",
      provider: "claude",
      visibility: "Team",
    });
    engine.updateSpaceMeta("team/oc_team", { agentId: agent.id });
    engine.feishuBindings.updatePolicy("team/oc_team", {
      responseMode: "mentions_only",
      participationLevel: undefined,
      replyInThread: true,
    });
    await orch.start();

    await connector.sendGroup("ordinary unmentioned update", false);

    expect(connector.sent).toEqual([]);
    expect(engine.listAgentChatRecords(agent.id, 10)).toEqual([]);
  });

  test("an unmentioned group message is captured before participation classification finishes", async () => {
    let markClassificationStarted!: () => void;
    let releaseClassification!: () => void;
    const classificationStarted = new Promise<void>((resolve) => {
      markClassificationStarted = resolve;
    });
    const classificationGate = new Promise<void>((resolve) => {
      releaseClassification = resolve;
    });
    const slowClassifier = {
      async complete() {
        throw new Error("unexpected text completion");
      },
      async completeJSON(opts: JSONOptions<unknown>) {
        markClassificationStarted();
        await classificationGate;
        const raw = {
          participationScore: 10,
          disruptionRisk: 80,
          reason: "普通陈述",
        };
        return {
          value: opts.validate ? opts.validate(raw) : raw,
          result: {
            text: "",
            model: "test",
            inputTokens: 0,
            outputTokens: 0,
            costUsd: 0,
          },
        };
      },
    } as LlmClient;
    orch = new Orchestrator({ engine, connector, llm: slowClassifier });

    await orch.start();
    const sending = connector.sendGroup("Alice 今天更新了后端服务。", false);
    await classificationStarted;
    const queued = connector.sendGroup("Bob 今天更新了客户端。", false);
    await Promise.resolve();
    expect(orch.health().queue).toEqual(expect.objectContaining({
      queued: 1,
      running: 1,
      pending: 2,
      maxPending: 2,
    }));
    const capturedBeforeDecision = engine.registry.has("team/oc_team")
      ? engine.registry.store("team/oc_team").index().countRaw(true)
      : 0;
    releaseClassification();
    await Promise.all([sending, queued]);

    expect(capturedBeforeDecision).toBe(1);
    expect(connector.sent).toHaveLength(0);
  });

  test("an unmentioned group question is proactively answered and still captured", async () => {
    const agent = engine.agents.create({
      name: "Proactive Chat Agent",
      provider: "claude",
      visibility: "Team",
    });
    await engine.upsertPage("team/oc_team", {
      slug: "entities/alice",
      type: "entity",
      title: "Alice",
      summary: "后端负责人",
      aliases: [],
      tags: [],
      sources: [],
      links: [],
      content: "# Alice\nAlice 负责后端服务。\n",
      updatedAt: Date.now(),
      contentHash: "h",
    });
    engine.updateSpaceMeta("team/oc_team", { agentId: agent.id });

    await orch.start();
    await connector.sendGroup("谁负责后端服务", false);

    expect(connector.sent).toHaveLength(1);
    expect(connector.sent[0]!.markdown).toContain("Alice");
    expect(engine.registry.store("team/oc_team").index().countRaw(true)).toBe(1);
    expect(engine.listAgentChatRecords(agent.id, 10)[0]?.agentId).toBe(agent.id);
  });

  test("group participation level progressively answers more optional discussion", async () => {
    engine.askWithExecutionPlan = async (_spaces, text) => ({
      answer: `参与：${text}`,
      source: "general",
      citations: [],
    });
    const scoredParticipation = new FakeLlm().onJSON((opts) => {
      const prompt = String(opts.prompt);
      if (prompt.includes("失败重试策略")) {
        return {
          participationScore: 70,
          disruptionRisk: 30,
          reason: "对讨论有明确补充价值",
        };
      }
      if (prompt.includes("加一点监控")) {
        return {
          participationScore: 45,
          disruptionRisk: 40,
          reason: "属于可选的轻量补充",
        };
      }
      return {
        participationScore: 10,
        disruptionRisk: 80,
        reason: "普通闲聊",
      };
    });
    orch = new Orchestrator({ engine, connector, llm: scoredParticipation });
    engine.ensureSpace("team/oc_team");

    await orch.start();
    await connector.sendGroup("这个方案值得补充失败重试策略", false);
    expect(connector.sent).toHaveLength(1); // defaults to balanced

    engine.feishuBindings.updatePolicy("team/oc_team", {
      responseMode: "smart",
      participationLevel: "reserved",
    });
    await connector.sendGroup("这个方案值得补充失败重试策略", false);
    expect(connector.sent).toHaveLength(1);

    engine.feishuBindings.updatePolicy("team/oc_team", {
      responseMode: "smart",
      participationLevel: "balanced",
    });
    await connector.sendGroup("这个方案值得补充失败重试策略", false);
    expect(connector.sent).toHaveLength(2);

    engine.feishuBindings.updatePolicy("team/oc_team", {
      responseMode: "smart",
      participationLevel: "active",
    });
    await connector.sendGroup("这个改动看起来还可以加一点监控", false);
    expect(connector.sent).toHaveLength(3);
  });

  test("a question addressed to another group member stays silent even if the model says respond", async () => {
    let asked = 0;
    engine.askWithExecutionPlan = async () => {
      asked += 1;
      return { answer: "不应发送", source: "general", citations: [] };
    };
    const overEager = new FakeLlm().onJSON(() => ({
      participationScore: 100,
      disruptionRisk: 0,
      reason: "错误地认为应该参与",
    }));
    orch = new Orchestrator({ engine, connector, llm: overEager });
    engine.ensureSpace("team/oc_team");
    engine.feishuBindings.updatePolicy("team/oc_team", {
      responseMode: "smart",
      participationLevel: "active",
    });

    await orch.start();
    await connector.sendGroup("@Alice 谁负责后端服务？", false);

    expect(asked).toBe(0);
    expect(connector.sent).toHaveLength(0);
    expect(engine.registry.store("team/oc_team").index().countRaw(true)).toBe(1);
  });

  test("an obvious unmentioned question is answered when participation classification fails", async () => {
    let asked = 0;
    engine.askWithExecutionPlan = async () => {
      asked += 1;
      return {
        answer: "小贝儿是张洺汐。",
        source: "knowledge",
        citations: [{ slug: "entities/zhang-ming-xi", title: "张洺汐" }],
      };
    };
    const unavailable = new FakeLlm().onJSON(() => {
      throw new Error("participation model unavailable");
    });
    orch = new Orchestrator({ engine, connector, llm: unavailable });

    await orch.start();
    await connector.sendGroup("小贝儿是谁", false);

    expect(asked).toBe(1);
    expect(connector.sent[0]!.markdown).toContain("小贝儿是张洺汐");
  });

  test("@-mentioned group question answers from knowledge with citations", async () => {
    // seed a page directly so ask has something to route to
    await engine.upsertPage("team/oc_team", {
      slug: "entities/alice",
      type: "entity",
      title: "Alice",
      summary: "后端负责人",
      aliases: [],
      tags: [],
      sources: [],
      links: [],
      content: "# Alice\nAlice 负责后端服务。\n",
      updatedAt: Date.now(),
      contentHash: "h",
    });
    await orch.start();
    await connector.sendGroup("谁负责后端服务？", true);
    expect(connector.sent.length).toBe(1);
    expect(connector.sent[0]!.markdown).toContain("Alice");
    expect(connector.sent[0]!.markdown).toContain("依据");
    expect(connector.sent[0]!.inThread).toBe(true);
  });

  test("group reply placement comes from the active binding", async () => {
    engine.ensureSpace("team/oc_team", { chatId: "oc_team" });
    engine.updateSpaceMeta("team/oc_team", { replyInThread: true });
    engine.feishuBindings.updatePolicy("team/oc_team", {
      responseMode: "mentions_only",
      replyInThread: false,
    });
    await orch.start();

    await connector.sendGroup("hello", true);

    expect(connector.sent).toHaveLength(1);
    expect(connector.sent[0]!.inThread).toBe(false);
  });

  test("disconnecting during answer generation suppresses the outbound reply", async () => {
    let markAsked!: () => void;
    let releaseAnswer!: () => void;
    const asked = new Promise<void>((resolve) => {
      markAsked = resolve;
    });
    const answerGate = new Promise<void>((resolve) => {
      releaseAnswer = resolve;
    });
    engine.askWithExecutionPlan = async () => {
      markAsked();
      await answerGate;
      return {
        answer: "This reply must be suppressed.",
        source: "general",
        citations: [],
      };
    };
    await orch.start();

    const handling = connector.sendGroup("answer this", true);
    await asked;
    engine.feishuBindings.disconnect("team/oc_team");
    releaseAnswer();
    await handling;

    expect(connector.sent).toEqual([]);
  });

  test("retracting an active Chat generation prevents its late provider result from being sent", async () => {
    let markAsked!: () => void;
    let releaseAnswer!: () => void;
    const asked = new Promise<void>((resolve) => {
      markAsked = resolve;
    });
    const answerGate = new Promise<void>((resolve) => {
      releaseAnswer = resolve;
    });
    engine.askWithExecutionPlan = async () => {
      markAsked();
      await answerGate;
      return {
        answer: "This retracted answer must never be delivered.",
        source: "general",
        citations: [],
      };
    };
    await orch.start();

    const handling = connector.sendGroup("answer this", true);
    await asked;
    const active = engine.chatRuns.list("team/oc_team").find(
      (run) => run.status === "running",
    )!;
    expect(await engine.retractMessage("team/oc_team", {
      chatId: "oc_team",
      messageId: "om_cli-1",
      requestedBy: "ou_me",
    })).toEqual(expect.objectContaining({ status: "retracted" }));
    expect(engine.chatRuns.get(active.id)).toBeUndefined();

    releaseAnswer();
    await handling;

    expect(connector.sent).toEqual([]);
  });

  test("a natural-language analysis request reaches conversation without intent classification", async () => {
    let asked = 0;
    engine.askWithExecutionPlan = async () => {
      asked += 1;
      return {
        answer: "这顿晚餐准备得很用心。",
        source: "general",
        citations: [],
      };
    };
    const noClassificationExpected = {
      async complete() {
        throw new Error("unexpected text completion");
      },
      async completeJSON() {
        throw new Error("ordinary conversation must not invoke an intent classifier");
      },
    } as LlmClient;
    orch = new Orchestrator({ engine, connector, llm: noClassificationExpected });

    await orch.start();
    await connector.sendGroup("@agent 分析下这个晚餐的用心程度", true);

    expect(asked).toBe(1);
    expect(connector.sent).toHaveLength(1);
    expect(connector.sent[0]!.markdown).toContain("这顿晚餐准备得很用心");
    expect(connector.sent[0]!.markdown).not.toContain("目前支持");
  });

  test("a contextual request includes the replied message when asking the model", async () => {
    const reactive = connector as CliConnector & Connector;
    reactive.resolveReplyTarget = async () => ({
      messageId: "om_dinner",
      senderId: "ou_other",
      text: "晚餐有三菜一汤，还专门做了对方喜欢的菜。",
      messageType: "text",
    });
    let userMessage = "";
    engine.askWithExecutionPlan = async (_spaces, question) => {
      userMessage = question;
      return {
        answer: "从菜品数量和偏好照顾来看，准备得比较用心。",
        source: "general",
        citations: [],
      };
    };

    await orch.start();
    await connector.sendGroup("@agent 分析下这个晚餐的用心程度", true);

    expect(userMessage).toContain("分析下这个晚餐的用心程度");
    expect(userMessage).toContain("被回复的消息");
    expect(userMessage).toContain("晚餐有三菜一汤");
    expect(connector.sent[0]!.markdown).toContain("准备得比较用心");
  });

  test("a contextual file request includes extracted attachment text before distillation", async () => {
    const messageId = "om_attachment_probe";
    const chatId = "oc_team";
    await engine.remember({
      space: "team/oc_team",
      source: "message",
      author: "ou_me",
      chatId,
      messageId,
      content: '<file key="file_probe" name="attachment-probe.txt"/>',
    });
    await engine.remember({
      space: "team/oc_team",
      source: "message",
      author: "ou_me",
      chatId,
      messageId,
      content: [
        "# 附件：attachment-probe.txt",
        "",
        "测试编号：HA-SOAK-20260717-A",
        "家庭采购清单负责人：小林",
        "复核时间：周日 16:30",
      ].join("\n"),
      attachments: [{ kind: "file", ref: "file_probe", name: "attachment-probe.txt" }],
    });
    const reactive = connector as CliConnector & Connector;
    reactive.resolveReplyTarget = async () => ({
      messageId,
      senderId: "ou_me",
      text: '<file key="file_probe" name="attachment-probe.txt"/>',
      messageType: "file",
    });
    let question = "";
    engine.askWithExecutionPlan = async (_spaces, input) => {
      question = input;
      return {
        answer: "编号 HA-SOAK-20260717-A，负责人小林，复核时间周日 16:30。",
        source: "general",
        citations: [],
      };
    };

    await orch.start();
    await connector.sendGroup(
      "@agent 读取这个文件，告诉我测试编号、负责人和复核时间",
      true,
    );

    expect(question).toContain("被回复的消息");
    expect(question).toContain("HA-SOAK-20260717-A");
    expect(question).toContain("家庭采购清单负责人：小林");
    expect(question).toContain("复核时间：周日 16:30");
  });

  test("proactive participation can use the most recent extracted attachment in the chat", async () => {
    const messageId = "om_recent_attachment";
    const chatId = "oc_team";
    const attachmentCreatedAt = Date.now() - 1_000;
    await engine.remember({
      space: "team/oc_team",
      source: "message",
      author: "ou_me",
      chatId,
      messageId,
      content: '<file key="file_recent" name="attachment-probe.txt"/>',
      createdAt: attachmentCreatedAt,
    });
    await engine.remember({
      space: "team/oc_team",
      source: "message",
      author: "ou_me",
      chatId,
      messageId,
      content: [
        "# 附件：attachment-probe.txt",
        "",
        "家庭采购清单负责人：小林",
      ].join("\n"),
      attachments: [{ kind: "file", ref: "file_recent", name: "attachment-probe.txt" }],
      createdAt: attachmentCreatedAt,
    });
    const proactive = new FakeLlm().onJSON((opts) => {
      const props = (opts.schema as { properties?: Record<string, unknown> }).properties ?? {};
      if ("participationScore" in props) {
        return {
          participationScore: 95,
          disruptionRisk: 5,
          reason: "明确向群体提问",
        };
      }
      throw new Error("unexpected JSON completion");
    });
    orch = new Orchestrator({ engine, connector, llm: proactive });
    let question = "";
    engine.askWithExecutionPlan = async (_spaces, input) => {
      question = input;
      return {
        answer: "负责人是小林。",
        source: "general",
        citations: [],
      };
    };

    await orch.start();
    await connector.sendGroup(
      "最终浸泡主动参与-20260717-C：大家知道刚才附件里的负责人是谁吗？",
      false,
    );

    expect(question).toContain("最近的附件或文档");
    expect(question).toContain("家庭采购清单负责人：小林");
  });

  test("a contextual image request sends the replied image to the answering model", async () => {
    const reactive = connector as CliConnector & Connector;
    reactive.resolveReplyTarget = async () => ({
      messageId: "om_dinner_image",
      senderId: "ou_other",
      text: "【图片】",
      messageType: "image",
    });
    let downloadedMessageId = "";
    let cleaned = false;
    let images: unknown;
    orch = new Orchestrator({
      engine,
      connector,
      attachmentDownloader: async (messageId) => {
        downloadedMessageId = messageId;
        return [{
          attachment: { kind: "image", ref: "img_dinner" },
          localPath: "/tmp/dinner.png",
          sizeBytes: 1_024,
          cleanup: () => {
            cleaned = true;
          },
        }];
      },
    });
    engine.askWithExecutionPlan = async (_spaces, _question, _plan, _evidence, options) => {
      images = (options as { images?: unknown }).images;
      return {
        answer: "从摆盘和菜品搭配看，这顿晚餐准备得很用心。",
        source: "general",
        citations: [],
      };
    };

    await orch.start();
    await connector.sendGroup("@agent 分析一下", true);

    expect(downloadedMessageId).toBe("om_dinner_image");
    expect(images).toEqual([{ path: "/tmp/dinner.png" }]);
    expect(cleaned).toBe(true);
    expect(connector.sent[0]!.markdown).toContain("摆盘和菜品搭配");
  });

  test("an unsupported visual provider gives actionable guidance and still cleans up", async () => {
    const reactive = connector as CliConnector & Connector;
    reactive.resolveReplyTarget = async () => ({
      messageId: "om_dinner_image",
      text: "【图片】",
      messageType: "image",
    });
    let cleaned = false;
    orch = new Orchestrator({
      engine,
      connector,
      attachmentDownloader: async () => [{
        attachment: { kind: "image", ref: "img_dinner" },
        localPath: "/tmp/dinner.png",
        sizeBytes: 1_024,
        cleanup: () => {
          cleaned = true;
        },
      }],
    });
    engine.askWithExecutionPlan = async () => {
      throw new Error("provider claude does not support image inputs");
    };

    await orch.start();
    await connector.sendGroup("@agent 分析下这个晚餐", true);

    expect(connector.sent[0]!.markdown).toContain("当前 Agent 不支持图片输入");
    expect(connector.sent[0]!.markdown).toContain("不会为了图片绕过 no-tools 隔离");
    expect(cleaned).toBe(true);
  });

  test("a failed reply-image download is disclosed to the answering model", async () => {
    const reactive = connector as CliConnector & Connector;
    reactive.resolveReplyTarget = async () => ({
      messageId: "om_missing_image",
      text: "【图片】",
      messageType: "image",
    });
    let question = "";
    let images: unknown;
    orch = new Orchestrator({
      engine,
      connector,
      attachmentDownloader: async () => [],
    });
    engine.askWithExecutionPlan = async (_spaces, input, _plan, _evidence, options) => {
      question = input;
      images = (options as { images?: unknown }).images;
      return {
        answer: "我暂时没能读取这张图片，请重新发送。",
        source: "general",
        citations: [],
      };
    };

    await orch.start();
    await connector.sendGroup("@agent 分析下这个晚餐", true);

    expect(images).toEqual([]);
    expect(question).toContain("图片未能下载");
    expect(question).toContain("不要假设已经看到了图片");
  });

  test("a mentioned Chinese question without punctuation reaches ask directly", async () => {
    let asked = 0;
    engine.askWithExecutionPlan = async (spaces, question) => {
      asked += 1;
      expect(spaces).toEqual(["team/oc_team", "personal/ou_me"]);
      expect(question).toBe("小贝儿是谁");
      return {
        answer: "小贝儿是张洺汐。",
        source: "knowledge",
        citations: [{ slug: "entities/zhang-ming-xi", title: "张洺汐" }],
      };
    };
    await orch.start();
    await connector.sendGroup("@agent 小贝儿是谁", true);

    expect(asked).toBe(1);
    expect(connector.sent[0]!.markdown).toContain("小贝儿是张洺汐");
    expect(connector.sent[0]!.markdown).not.toContain("记下");
  });

  test("p2p message always gets a reply and is captured to personal space", async () => {
    await orch.start();
    await connector.sendP2P("记住：我们的发布流程是先灰度再全量。");
    expect(connector.sent.length).toBe(1);
    expect(connector.sent[0]!.markdown).toContain("记下");
    expect(engine.registry.has("personal/ou_me")).toBe(true);
    expect(engine.registry.store("personal/ou_me").index().countRaw(true)).toBe(1);
  });

  test("a long message with a trailing addressed memory command is captured and acknowledged", async () => {
    engine.askWithExecutionPlan = async () => {
      throw new Error("explicit memory must not reach the answer model");
    };
    const text = [
      "UE 5.8 Iris 已支持按连接并行 Tick。",
      "DS 使用 -nothreading 时会失去多核收益。",
      "@HomeAgent 记住上面的信息",
    ].join("\n");

    await orch.start();
    await connector.sendP2P(text);

    expect(connector.sent).toHaveLength(1);
    expect(connector.sent[0]!.markdown).toContain("记下");
    expect(engine.registry.store("personal/ou_me").index().listRaw({})).toEqual([
      expect.objectContaining({ content: text, admission: "ready" }),
    ]);
  });

  test("an addressed natural-language reminder creates a durable reminder", async () => {
    grantGroupAdministrator();
    const before = Date.now();
    await orch.start();
    await connector.sendGroup("@agent 1小时后提醒我喝水", true);

    const reminders = engine.reminders.list();
    expect(reminders).toHaveLength(1);
    expect(reminders[0]).toEqual(expect.objectContaining({
      title: "喝水",
      space: "team/oc_team",
      chatId: "oc_team",
      creatorId: "ou_me",
      status: "scheduled",
    }));
    expect(reminders[0]!.triggerAt).toBeGreaterThanOrEqual(before + 3600_000);
    expect(reminders[0]!.triggerAt).toBeLessThanOrEqual(Date.now() + 3600_000);
    expect(connector.sent.at(-1)?.markdown).toContain("已创建提醒");
    expect(connector.sent.at(-1)?.markdown).toContain("喝水");
    expect(engine.registry.store("team/oc_team").index().countRaw()).toBe(0);
  });

  test("ordinary group members cannot create direct, repeating, or inferred reminders", async () => {
    const reactive = connector as CliConnector & Connector;
    reactive.isChatAdministrator = async () => false;
    let providerCalls = 0;
    const countingLlm: LlmClient = {
      complete: (options) => fake.complete(options),
      completeJSON: (options) => {
        providerCalls += 1;
        return fake.completeJSON(options);
      },
    };
    orch = new Orchestrator({ engine, connector, llm: countingLlm });
    await orch.start();

    await connector.sendGroup("@agent 1小时后提醒我喝水", true);
    await connector.sendGroup(
      "@agent 1小时后提醒我喝水，每隔1小时重复，直到我回复确认",
      true,
    );
    await connector.sendGroup(
      "7.22日上午七点半提醒我购买8.5日北京去苏州的火车票",
      false,
    );

    expect(providerCalls).toBe(0);
    expect(engine.reminders.list()).toEqual([]);
    expect(connector.sent).toHaveLength(3);
    expect(connector.sent.every((item) => item.markdown.includes("只有群主或群管理员")))
      .toBe(true);
  });

  test("an inferred reminder candidate rechecks group administration before confirmation", async () => {
    const reactive = connector as CliConnector & Connector;
    let administrator = true;
    reactive.isChatAdministrator = async () => administrator;
    let providerCalls = 0;
    const countingLlm: LlmClient = {
      complete: (options) => fake.complete(options),
      completeJSON: (options) => {
        providerCalls += 1;
        return fake.completeJSON(options);
      },
    };
    orch = new Orchestrator({ engine, connector, llm: countingLlm });
    await orch.start();

    await connector.sendGroup(
      "@agent 7.22日上午七点半提醒我购买8.5日北京去苏州的火车票",
      true,
    );
    expect(providerCalls).toBe(1);
    expect(engine.reminders.list()).toEqual([]);

    administrator = false;
    await connector.sendGroup("确认", false);

    expect(providerCalls).toBe(1);
    expect(engine.reminders.list()).toEqual([]);
    expect(connector.sent.at(-1)?.markdown).toContain("只有群主或群管理员");
  });

  test("ordinary group members cannot mutate an existing reminder", async () => {
    const reactive = connector as CliConnector & Connector;
    reactive.isChatAdministrator = async () => false;
    const now = Date.now();
    const reminder = engine.reminders.create({
      title: "去茶饼斋",
      space: "team/oc_team",
      chatId: "oc_team",
      creatorId: "ou_me",
      triggerAt: now + 3600_000,
    }, now)!;
    await orch.start();

    await connector.sendGroup("@agent 取消去茶饼斋的提醒", true);

    expect(engine.reminders.get(reminder.id)?.status).toBe("scheduled");
    expect(connector.sent.at(-1)?.markdown).toContain("只有群主或群管理员");
  });

  test("p2p reminder creation keeps its existing owner authorization behavior", async () => {
    await orch.start();

    await connector.sendP2P("1小时后提醒我喝水");

    expect(engine.reminders.list()).toEqual([
      expect.objectContaining({
        space: "personal/ou_me",
        creatorId: "ou_me",
        title: "喝水",
        status: "scheduled",
      }),
    ]);
  });

  test("asking for the coming week lists scheduled reminders instead of searching the wiki", async () => {
    grantGroupAdministrator();
    const now = Date.now();
    engine.reminders.create({
      title: "去茶饼斋",
      space: "team/oc_team",
      chatId: "oc_team",
      creatorId: "ou_me",
      triggerAt: now + 2 * 3600_000,
    }, now);
    engine.reminders.create({
      title: "他人的私密安排",
      space: "team/oc_team",
      chatId: "oc_team",
      creatorId: "ou_other",
      triggerAt: now + 3 * 3600_000,
    }, now);
    await orch.start();
    await connector.sendGroup("@agent 我最近一周有什么安排吗", true);

    expect(connector.sent.at(-1)?.markdown).toContain("未来 7 天的安排");
    expect(connector.sent.at(-1)?.markdown).toContain("去茶饼斋");
    expect(connector.sent.at(-1)?.markdown).not.toContain("他人的私密安排");
    expect(engine.registry.store("team/oc_team").index().countRaw()).toBe(0);
  });

  test("the creator can confirm a repeating reminder in natural language", async () => {
    grantGroupAdministrator();
    const now = Date.now();
    const reminder = engine.reminders.create({
      title: "确认去大同",
      space: "team/oc_team",
      chatId: "oc_team",
      creatorId: "ou_me",
      triggerAt: now + 3600_000,
      repeatEveryMs: 3 * 3600_000,
      untilConfirmed: true,
    }, now)!;
    await orch.start();
    await connector.sendGroup("@agent 确认去大同", true);

    expect(engine.reminders.get(reminder.id)?.status).toBe("completed");
    expect(connector.sent.at(-1)?.markdown).toContain("已完成提醒");
    expect(connector.sent.at(-1)?.markdown).toContain("确认去大同");
  });

  test("confirmation prefers the exact reminder title over an ambiguous partial match", async () => {
    grantGroupAdministrator();
    const now = Date.now();
    const shorter = engine.reminders.create({
      title: "去大同",
      space: "team/oc_team",
      chatId: "oc_team",
      creatorId: "ou_me",
      triggerAt: now + 1800_000,
    }, now)!;
    const exact = engine.reminders.create({
      title: "确认去大同",
      space: "team/oc_team",
      chatId: "oc_team",
      creatorId: "ou_me",
      triggerAt: now + 3600_000,
      repeatEveryMs: 3 * 3600_000,
      untilConfirmed: true,
    }, now)!;
    await orch.start();
    await connector.sendGroup("@agent 确认去大同", true);

    expect(engine.reminders.get(shorter.id)?.status).toBe("scheduled");
    expect(engine.reminders.get(exact.id)?.status).toBe("completed");
  });

  test("the creator can cancel a scheduled reminder in natural language", async () => {
    grantGroupAdministrator();
    const now = Date.now();
    const reminder = engine.reminders.create({
      title: "去茶饼斋",
      space: "team/oc_team",
      chatId: "oc_team",
      creatorId: "ou_me",
      triggerAt: now + 3600_000,
    }, now)!;
    await orch.start();
    await connector.sendGroup("@agent 取消去茶饼斋的提醒", true);

    expect(engine.reminders.get(reminder.id)?.status).toBe("cancelled");
    expect(connector.sent.at(-1)?.markdown).toContain("已取消提醒：去茶饼斋");
  });

  test("the creator can snooze a scheduled reminder by a duration", async () => {
    grantGroupAdministrator();
    const before = Date.now();
    const reminder = engine.reminders.create({
      title: "去茶饼斋",
      space: "team/oc_team",
      chatId: "oc_team",
      creatorId: "ou_me",
      triggerAt: before + 3600_000,
    }, before)!;
    await orch.start();
    await connector.sendGroup("@agent 把去茶饼斋的提醒延后2小时", true);

    const updated = engine.reminders.get(reminder.id)!;
    expect(updated.nextTriggerAt).toBeGreaterThanOrEqual(before + 2 * 3600_000);
    expect(updated.nextTriggerAt).toBeLessThanOrEqual(Date.now() + 2 * 3600_000);
    expect(connector.sent.at(-1)?.markdown).toContain("已延后提醒：去茶饼斋");
  });

  test("a reminder without a time asks for one instead of pretending it was saved", async () => {
    grantGroupAdministrator();
    await orch.start();
    await connector.sendGroup("@agent 提醒我喝水", true);

    expect(engine.reminders.list()).toEqual([]);
    expect(connector.sent.at(-1)?.markdown).toContain("没有识别到具体时间");
    expect(connector.sent.at(-1)?.markdown).toContain("明天上午 9 点");
  });

  test("asks for confirmation before creating an LLM-inferred reminder", async () => {
    grantGroupAdministrator();
    await orch.start();
    await connector.sendGroup(
      "@agent 7.22日上午七点半提醒我购买8.5日北京去苏州的火车票",
      true,
    );

    expect(engine.reminders.list()).toEqual([]);
    expect(connector.sent.at(-1)?.markdown).toContain("请确认");
    expect(connector.sent.at(-1)?.markdown).toContain("2099");
    expect(connector.sent.at(-1)?.markdown).toContain("购买8.5日北京去苏州的火车票");

    await connector.inject({
      kind: "message",
      eventId: "other-user-confirmation",
      chatType: "group",
      chatId: "oc_team",
      senderId: "ou_other",
      text: "确认",
      messageId: "om_other-confirmation",
      mentionsBot: false,
      createdAt: Date.now(),
    });
    expect(engine.reminders.list()).toEqual([]);

    await connector.sendGroup("确认", false);

    expect(engine.reminders.list()).toEqual([
      expect.objectContaining({
        title: "购买8.5日北京去苏州的火车票",
        triggerAt: new Date("2099-07-22T07:30:00+08:00").getTime(),
        sourceMessageId: "om_cli-1",
        status: "scheduled",
      }),
    ]);
    expect(connector.sent.at(-1)?.markdown).toContain("已创建提醒");
  });

  test("cancels an inferred reminder candidate without creating it", async () => {
    grantGroupAdministrator();
    await orch.start();
    await connector.sendGroup(
      "@agent 7.22日上午七点半提醒我购买8.5日北京去苏州的火车票",
      true,
    );
    await connector.sendGroup("取消", false);

    expect(engine.reminders.list()).toEqual([]);
    expect(connector.sent.at(-1)?.markdown).toContain("已取消创建提醒");
  });

  test("a new unresolved reminder request supersedes an older inferred candidate", async () => {
    grantGroupAdministrator();
    await orch.start();
    await connector.sendGroup(
      "@agent 7.22日上午七点半提醒我购买8.5日北京去苏州的火车票",
      true,
    );
    await connector.sendGroup("@agent 提醒我喝水", true);
    expect(connector.sent.at(-1)?.markdown).toContain("没有识别到具体时间");

    await connector.sendGroup("确认", false);
    expect(engine.reminders.list()).toEqual([]);
  });

  test("replying 别记这条 retracts the source and does not capture the command", async () => {
    const reactive = connector as CliConnector & Connector;
    reactive.resolveReplyTarget = async () => ({
      messageId: "om_cli-1",
      senderId: "ou_me",
    });

    await orch.start();
    await connector.sendGroup("本群测试代号是北极星", false);
    await connector.sendGroup("@小强Bot 别记这条", true);

    expect(connector.sent.at(-1)?.markdown).toContain("已撤回");
    await connector.sendGroup("@小强Bot 别记这条", true);
    expect(connector.sent.at(-1)?.markdown).toContain("已经撤回过了");
    expect(
      await engine.retractMessage("team/oc_team", {
        chatId: "oc_team",
        messageId: "om_cli-1",
        requestedBy: "ou_me",
      }),
    ).toEqual({ status: "already_retracted", affectedPages: [], requeuedSourceIds: [] });
    expect((await engine.runDreamCycle("team/oc_team")).examined).toBe(0);
  });

  test("retraction without a reply target gives actionable guidance", async () => {
    const reactive = connector as CliConnector & Connector;
    reactive.resolveReplyTarget = async () => undefined;
    engine.ensureSpace("team/oc_team", { chatId: "oc_team" });

    await orch.start();
    await connector.sendGroup("别记这条", true);

    expect(connector.sent.at(-1)?.markdown).toContain("请回复要撤回的那条原消息");
    expect((await engine.runDreamCycle("team/oc_team")).examined).toBe(0);
  });

  test("group retraction requires an explicit bot mention even when mentions-only is disabled", async () => {
    const reactive = connector as CliConnector & Connector;
    let resolvedTarget = false;
    reactive.resolveReplyTarget = async () => {
      resolvedTarget = true;
      return { messageId: "om_target", senderId: "ou_me" };
    };
    engine.ensureSpace("team/oc_team", { chatId: "oc_team" });
    engine.feishuBindings.updatePolicy("team/oc_team", {
      responseMode: "all_messages",
      participationLevel: undefined,
    });

    await orch.start();
    await connector.sendGroup("别记这条", false);

    expect(connector.sent.at(-1)?.markdown).toContain("@我");
    expect(resolvedTarget).toBe(false);
    expect(engine.registry.store("team/oc_team").index().countRaw()).toBe(0);
  });

  test("a question containing 撤回 is not mistaken for a retraction command", async () => {
    const reactive = connector as CliConnector & Connector;
    reactive.resolveReplyTarget = async () => {
      throw new Error("should not resolve a reply target for a normal question");
    };

    await orch.start();
    await connector.sendGroup("怎么撤回知识？", true);

    expect(connector.sent.at(-1)?.markdown).not.toContain("请回复要撤回的那条原消息");
    expect((await engine.runDreamCycle("team/oc_team")).examined).toBe(1);
  });

  test("retraction refuses to remove another user's message", async () => {
    const reactive = connector as CliConnector & Connector;
    reactive.resolveReplyTarget = async () => ({ messageId: "om_other", senderId: "ou_other" });

    await orch.start();
    await connector.inject({
      kind: "message",
      eventId: "evt_other",
      chatType: "group",
      chatId: "oc_team",
      senderId: "ou_other",
      text: "别人的知识",
      messageId: "om_other",
      mentionsBot: false,
      createdAt: Date.now(),
    });
    await connector.sendGroup("别记这条", true);

    expect(connector.sent.at(-1)?.markdown).toContain("只有原作者、群主或群管理员可以撤回");
    expect(
      await engine.retractMessage("team/oc_team", {
        chatId: "oc_team",
        messageId: "om_other",
        requestedBy: "ou_other",
      }),
    ).toEqual({ status: "retracted", affectedPages: [], requeuedSourceIds: [] });
    expect((await engine.runDreamCycle("team/oc_team")).examined).toBe(0);
  });

  test("group administrator can retract another user's message", async () => {
    const reactive = connector as CliConnector & Connector;
    reactive.resolveReplyTarget = async () => ({ messageId: "om_other", senderId: "ou_other" });
    reactive.isChatAdministrator = async () => true;

    await orch.start();
    await connector.inject({
      kind: "message",
      eventId: "evt_other",
      chatType: "group",
      chatId: "oc_team",
      senderId: "ou_other",
      text: "群管理员可以治理的知识",
      messageId: "om_other",
      mentionsBot: false,
      createdAt: Date.now(),
    });
    await connector.sendGroup("别记这条", true);

    expect(connector.sent.at(-1)?.markdown).toContain("已撤回");
    expect(
      await engine.retractMessage("team/oc_team", {
        chatId: "oc_team",
        messageId: "om_other",
        requestedBy: "ou_other",
      }),
    ).toEqual({ status: "already_retracted", affectedPages: [], requeuedSourceIds: [] });
  });

  test("retraction finishes rebuilding affected knowledge before confirming", async () => {
    const removedId = await engine.remember({
      space: "team/oc_team",
      source: "message",
      author: "ou_me",
      chatId: "oc_team",
      messageId: "om_remove",
      content: "项目代号是北极星",
    });
    const survivingId = await engine.remember({
      space: "team/oc_team",
      source: "message",
      author: "ou_me",
      chatId: "oc_team",
      messageId: "om_keep",
      content: "项目负责人是 Alice",
    });
    engine.registry.store("team/oc_team").index().markIngested([removedId, survivingId]);
    await engine.upsertPage("team/oc_team", {
      slug: "concepts/project-facts",
      type: "concept",
      title: "项目信息",
      summary: "项目代号与负责人",
      aliases: [],
      tags: [],
      sources: [removedId, survivingId],
      links: [],
      content: "# 项目信息\n项目代号是北极星，负责人是 Alice。\n",
      updatedAt: Date.now(),
      contentHash: "before-retraction",
    });
    // Older unrelated pending entries fill the normal 40-entry dream batch.
    // Retraction rebuild must target the surviving source instead of claiming
    // success after processing this unrelated backlog.
    for (let i = 0; i < 40; i += 1) {
      await engine.remember({
        space: "team/oc_team",
        source: "message",
        author: "ou_me",
        chatId: "oc_team",
        messageId: `om_backlog_${i}`,
        content: `待整理历史消息 ${i}`,
        createdAt: i + 1,
      });
    }
    fake.onJSON((call) => {
      const props = (call.schema as { properties?: Record<string, unknown> }).properties ?? {};
      if ("operations" in props) {
        return {
          operations: [
            {
              type: "concept",
              name: "project-facts",
              title: "项目信息",
              rawIds: [survivingId],
            },
          ],
          skippedRawIds: [],
        };
      }
      return {
        title: "项目信息",
        summary: "项目负责人",
        aliases: [],
        tags: [],
        links: [],
        content: "# 项目信息\n项目负责人是 Alice。",
      };
    });
    const reactive = connector as CliConnector & Connector;
    reactive.resolveReplyTarget = async () => ({ messageId: "om_remove", senderId: "ou_me" });

    await orch.start();
    await connector.sendGroup("别记这条", true);

    expect(connector.sent.at(-1)?.markdown).toContain("已重新提炼");
    const rebuilt = await engine.getPage("team/oc_team", "concepts/project-facts");
    expect(rebuilt?.content).toContain("Alice");
    expect(rebuilt?.content).not.toContain("北极星");
    expect(engine.registry.store("team/oc_team").index().getRaw(survivingId)?.ingested).toBe(true);
  });

  test("shows a transient thinking reaction only for messages that get a reply", async () => {
    const events: string[] = [];
    const reactive = connector as CliConnector & Connector;
    const originalReply = connector.reply.bind(connector);
    reactive.addReaction = async (messageId, emojiType) => {
      events.push(`add:${messageId}:${emojiType}`);
      return "reaction_1";
    };
    reactive.removeReaction = async (messageId, reactionId) => {
      events.push(`remove:${messageId}:${reactionId}`);
    };
    reactive.reply = async (out) => {
      events.push("reply");
      await originalReply(out);
    };

    await orch.start();
    await connector.sendP2P("在吗");
    expect(events).toEqual([
      "add:om_cli-1:THINKING",
      "reply",
      "remove:om_cli-1:reaction_1",
    ]);

    events.length = 0;
    await connector.sendGroup("这条只需要收录", false);
    expect(events).toEqual([]);
  });

  test("shows thinking while a reply-bound attachment is still downloading", async () => {
    const slowPath = join(dir, "slow.txt");
    writeFileSync(slowPath, "x", "utf8");
    const events: string[] = [];
    let markDownloadStarted!: () => void;
    let releaseDownload!: () => void;
    const downloadStarted = new Promise<void>((resolve) => {
      markDownloadStarted = resolve;
    });
    const downloadGate = new Promise<void>((resolve) => {
      releaseDownload = resolve;
    });

    const reactive = connector as CliConnector & Connector;
    const originalReply = connector.reply.bind(connector);
    reactive.addReaction = async (messageId, emojiType) => {
      events.push(`add:${messageId}:${emojiType}`);
      return "reaction_attachment";
    };
    reactive.removeReaction = async (messageId, reactionId) => {
      events.push(`remove:${messageId}:${reactionId}`);
    };
    reactive.reply = async (out) => {
      events.push("reply");
      await originalReply(out);
    };

    orch = new Orchestrator({
      engine,
      connector,
      llm: fake,
      attachmentDownloader: async () => {
        events.push("download:start");
        markDownloadStarted();
        await downloadGate;
        return [{
          attachment: { kind: "file" as const, ref: "file_slow", name: "slow.txt" },
          localPath: slowPath,
          sizeBytes: 1,
          cleanup: () => {
            events.push("cleanup");
          },
        }];
      },
      attachmentExtractor: async () => {
        events.push("extract");
        return "附件内容";
      },
    });
    await orch.start();

    const handling = connector.inject({
      kind: "message",
      eventId: "slow-reply-attachment",
      chatType: "group",
      chatId: "oc_team",
      senderId: "ou_me",
      text: "这个文件是什么？",
      messageId: "om_slow_attachment",
      messageType: "file",
      mentionsBot: true,
      createdAt: Date.now(),
    });
    await downloadStarted;
    const eventsWhileDownloading = [...events];

    releaseDownload();
    await handling;

    expect(eventsWhileDownloading).toEqual([
      "add:om_slow_attachment:THINKING",
      "download:start",
    ]);
    expect(events).toEqual([
      "add:om_slow_attachment:THINKING",
      "download:start",
      "extract",
      "cleanup",
      "reply",
      "remove:om_slow_attachment:reaction_attachment",
    ]);
    expect(connector.sent).toHaveLength(1);
  });

  test("cold-start question appends honest nudge (Q3)", async () => {
    await orch.start();
    // no pages exist -> ask returns general; runtime appends cold-start note
    await connector.sendP2P("公司年会是什么时候？");
    expect(connector.sent.length).toBe(1);
    expect(connector.sent[0]!.markdown).toContain("知识库还是空的");
  });

  test("cold-start Agent-workdir answer is not mislabeled as missing knowledge", async () => {
    engine.askWithExecutionPlan = async () => ({
      answer: "后端由 Alice 负责。",
      source: "general",
      context: "agent-workdir",
      citations: [],
      gaps: ["知识库中暂无相关记录"],
    });
    await orch.start();

    await connector.sendP2P("谁负责后端？");

    expect(connector.sent[0]!.markdown).toBe("后端由 Alice 负责。");
    expect(connector.sent[0]!.markdown).not.toContain("尚缺");
    expect(connector.sent[0]!.markdown).not.toContain("知识库还是空的");
  });

  test("command '重新提炼' triggers a dream cycle", async () => {
    // seed one raw so the dream cycle has something (and won't call LLM on empty)
    await engine.remember({ space: "personal/ou_me", source: "message", content: "x" });
    // queue an analyze result for the triggered dream cycle
    fake.queueJSON({ operations: [], skippedRawIds: [] });
    await orch.start();
    await connector.sendP2P("帮我重新提炼一下知识");
    expect(connector.sent[0]!.markdown).toContain("重新提炼");
    expect(engine.registry.store("personal/ou_me").index().countRaw()).toBe(1);
  });

  test("duplicate eventId is dropped", async () => {
    await orch.start();
    const dup = {
      kind: "message" as const,
      eventId: "dup-1",
      chatType: "p2p" as const,
      chatId: "oc_dm",
      senderId: "ou_me",
      text: "在吗",
      messageId: "om_x",
      mentionsBot: true,
      createdAt: Date.now(),
    };
    await orch.enqueue(dup);
    await orch.enqueue(dup);
    // only one reply for the greeting
    expect(connector.sent.length).toBe(1);
  });

  test("doc links are fetched and remembered as doc entries (Q8)", async () => {
    const fetched: string[] = [];
    const orch2 = new Orchestrator({
      engine,
      connector,
      llm: fake,
      docFetcher: async (link) => {
        fetched.push(link);
        return "# 发布流程\n先灰度再全量。";
      },
    });
    await orch2.start();
    await connector.inject({
      kind: "message",
      eventId: "doc-1",
      chatType: "group",
      chatId: "oc_team",
      senderId: "ou_me",
      text: "见文档 https://x.feishu.cn/docx/abc123",
      messageId: "om_doc",
      mentionsBot: false,
      docLinks: ["https://x.feishu.cn/docx/abc123"],
      createdAt: Date.now(),
    });
    expect(fetched).toEqual(["https://x.feishu.cn/docx/abc123"]);
    // one message raw + one doc raw captured in the team space
    const raws = engine.registry.store("team/oc_team").index().listRaw({});
    expect(raws.some((r) => r.source === "doc")).toBe(true);
    await orch2.stop();
  });

  test("a ByteTech article is remembered and available to the same Chat response", async () => {
    const articleUrl = "https://bytetech.info/articles/7525079282028621867";
    const articleMarkdown = "# Agent 架构\n\n文章核心观点是把记忆与执行证据分开治理。";
    const fetched: string[] = [];
    let answerPrompt = "";
    let answerSystem = "";
    fake.onText((opts) => {
      answerPrompt = String(opts.prompt ?? "");
      answerSystem = String(opts.system ?? "");
      return "我已读完并收录。文章主张把记忆与执行证据分开治理。";
    });
    orch = new Orchestrator({
      engine,
      connector,
      llm: fake,
      docFetcher: async (link) => {
        fetched.push(link);
        return articleMarkdown;
      },
    });
    await orch.start();
    await connector.inject({
      kind: "message",
      eventId: "bytetech-1",
      chatType: "p2p",
      chatId: "oc_dm",
      senderId: "ou_me",
      text: `请充分理解并记下这篇文章：${articleUrl}`,
      messageId: "om_bytetech",
      mentionsBot: true,
      docLinks: [articleUrl],
      createdAt: Date.now(),
    });

    expect(fetched).toEqual([articleUrl]);
    expect(engine.registry.store("personal/ou_me").index().listRaw({})).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "doc",
          messageId: "om_bytetech",
          content: expect.stringContaining(articleMarkdown),
        }),
      ]),
    );
    expect(answerPrompt).toContain(articleMarkdown);
    expect(answerSystem).toContain("当前消息包含已收录的原始来源正文");
    expect(connector.sent.at(-1)?.markdown).toContain("我已读完并收录");
    expect(connector.sent.at(-1)?.markdown).not.toContain("尚缺");
    expect(connector.sent.at(-1)?.markdown).not.toContain("知识库还是空的");
  });

  test("a source fetch failure returns a bounded reply without provider retry or false claims", async () => {
    const articleUrl = "https://bytetech.info/articles/7525079282028621867";
    let providerCalls = 0;
    fake.onText(() => {
      providerCalls += 1;
      return "不应调用";
    });
    orch = new Orchestrator({
      engine,
      connector,
      llm: fake,
      docFetcher: async () => null,
    });
    await orch.start();
    await connector.inject({
      kind: "message",
      eventId: "bytetech-failed-1",
      chatType: "p2p",
      chatId: "oc_dm",
      senderId: "ou_me",
      text: `请充分理解并记下这篇文章：${articleUrl}`,
      messageId: "om_bytetech_failed",
      mentionsBot: true,
      docLinks: [articleUrl],
      createdAt: Date.now(),
    });

    expect(providerCalls).toBe(0);
    expect(connector.sent.at(-1)?.markdown).toContain("未能读取链接正文");
    expect(connector.sent.at(-1)?.markdown).toContain("不能确认已经理解");
    expect(connector.sent.at(-1)?.markdown).not.toContain("bytedcli");
    expect(engine.registry.store("personal/ou_me").index().listRaw({})).toEqual([
      expect.objectContaining({ source: "message", messageId: "om_bytetech_failed" }),
    ]);
  });

  test("attachment text follows message provenance and retraction lifecycle", async () => {
    const attachmentDir = mkdtempSync(join(tmpdir(), "hb-runtime-attachment-"));
    const localPath = join(attachmentDir, "resource.bin");
    writeFileSync(localPath, "项目代号是北极星", "utf8");
    let cleaned = false;
    const attachmentDownloader = async () => [{
      attachment: { kind: "file" as const, ref: "file_1", name: "notes.txt" },
      localPath,
      sizeBytes: 24,
      cleanup: () => {
        cleaned = true;
        rmSync(attachmentDir, { recursive: true, force: true });
      },
    }];

    orch = new Orchestrator({
      engine,
      connector,
      llm: fake,
      attachmentDownloader,
      attachmentExtractor: async () => "项目代号是北极星",
    });
    const reactive = connector as CliConnector & Connector;
    reactive.resolveReplyTarget = async () => ({
      messageId: "om_attachment",
      senderId: "ou_me",
    });
    await orch.start();
    await connector.inject({
      kind: "message",
      eventId: "attachment-1",
      chatType: "group",
      chatId: "oc_team",
      senderId: "ou_me",
      text: "[文件] notes.txt",
      messageId: "om_attachment",
      messageType: "file",
      mentionsBot: false,
      createdAt: 1_700_000_000_000,
    });

    const archive = await engine.exportSpace("team/oc_team");
    expect(archive.raw).toHaveLength(2);
    expect(archive.raw).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: "message",
        author: "ou_me",
        chatId: "oc_team",
        messageId: "om_attachment",
        content: "[文件] notes.txt",
      }),
      expect.objectContaining({
        source: "message",
        author: "ou_me",
        chatId: "oc_team",
        messageId: "om_attachment",
        content: "# 附件：notes.txt\n\n项目代号是北极星",
        attachments: [expect.objectContaining({
          kind: "file",
          ref: "file_1",
          name: "notes.txt",
          sourceDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
          sourceSizeBytes: 24,
        })],
      }),
    ]));
    const attachmentRaw = archive.raw.find((raw) => raw.attachments?.length === 1)!;
    const stored = engine.getRawSource("team/oc_team", attachmentRaw.id, 0);
    expect(stored).toEqual(expect.objectContaining({ name: "notes.txt", sizeBytes: 24 }));
    expect(await Bun.file(stored!.path).text()).toBe("项目代号是北极星");
    expect(cleaned).toBe(true);
    expect(existsSync(attachmentDir)).toBe(false);

    await connector.sendGroup("@小强Bot 别记这条", true);
    const retracted = await engine.exportSpace("team/oc_team");
    expect(retracted.raw.filter((raw) => raw.messageId === "om_attachment")).toEqual([]);
    expect(existsSync(stored!.path)).toBe(false);
  });

  test("an explicit reply request preserves the original file from the replied message", async () => {
    const attachmentDir = mkdtempSync(join(tmpdir(), "hb-runtime-reply-file-"));
    const localPath = join(attachmentDir, "resource.bin");
    const original = new Uint8Array([0, 1, 2, 3, 255]);
    writeFileSync(localPath, original);
    let downloadedMessageId = "";
    const reactive = connector as CliConnector & Connector;
    reactive.resolveReplyTarget = async () => ({
      messageId: "om_original_file",
      senderId: "ou_me",
      messageType: "file",
    });
    orch = new Orchestrator({
      engine,
      connector,
      llm: fake,
      attachmentDownloader: async (messageId) => {
        downloadedMessageId = messageId;
        return [{
          attachment: { kind: "file", ref: "file_original", name: "evidence.bin" },
          localPath,
          sizeBytes: original.byteLength,
          cleanup: () => rmSync(attachmentDir, { recursive: true, force: true }),
        }];
      },
      attachmentExtractor: async () => null,
    });
    await orch.start();

    await connector.inject({
      kind: "message",
      eventId: "remember-original-file",
      chatType: "group",
      chatId: "oc_team",
      senderId: "ou_me",
      text: "@小强Bot 请记录这个原文件",
      messageId: "om_remember_command",
      messageType: "text",
      mentionsBot: true,
      createdAt: Date.now(),
    });

    expect(downloadedMessageId).toBe("om_original_file");
    const raw = (await engine.exportSpace("team/oc_team")).raw.find(
      (entry) => entry.attachments?.[0]?.name === "evidence.bin",
    );
    expect(raw).toBeDefined();
    const stored = engine.getRawSource("team/oc_team", raw!.id, 0);
    expect(new Uint8Array(await Bun.file(stored!.path).arrayBuffer())).toEqual(original);
    expect(existsSync(attachmentDir)).toBe(false);
  });

  test("attachment download failure leaves the original message captured", async () => {
    orch = new Orchestrator({
      engine,
      connector,
      llm: fake,
      attachmentDownloader: async () => {
        throw new Error("download unavailable");
      },
    });
    await orch.start();

    await connector.inject({
      kind: "message",
      eventId: "attachment-download-failure",
      chatType: "group",
      chatId: "oc_team",
      senderId: "ou_me",
      text: "[文件] unavailable.txt",
      messageId: "om_download_failure",
      messageType: "file",
      mentionsBot: false,
      createdAt: Date.now(),
    });

    const archive = await engine.exportSpace("team/oc_team");
    expect(archive.raw).toEqual([
      expect.objectContaining({
        source: "message",
        messageId: "om_download_failure",
        content: "[文件] unavailable.txt",
      }),
    ]);
  });

  test("attachment extraction failure still preserves the original file", async () => {
    const brokenPath = join(dir, "broken.txt");
    writeFileSync(brokenPath, "x", "utf8");
    let cleaned = false;
    orch = new Orchestrator({
      engine,
      connector,
      llm: fake,
      attachmentDownloader: async () => [{
        attachment: { kind: "file", ref: "file_broken", name: "broken.txt" },
        localPath: brokenPath,
        sizeBytes: 1,
        cleanup: () => {
          cleaned = true;
        },
      }],
      attachmentExtractor: async () => {
        throw new Error("extract unavailable");
      },
    });
    await orch.start();

    await connector.inject({
      kind: "message",
      eventId: "attachment-extraction-failure",
      chatType: "group",
      chatId: "oc_team",
      senderId: "ou_me",
      text: "[文件] broken.txt",
      messageId: "om_extraction_failure",
      messageType: "file",
      mentionsBot: false,
      createdAt: Date.now(),
    });

    const archive = await engine.exportSpace("team/oc_team");
    expect(archive.raw).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: "message",
        messageId: "om_extraction_failure",
        content: "[文件] broken.txt",
      }),
      expect.objectContaining({
        source: "message",
        messageId: "om_extraction_failure",
        content: "# 附件：broken.txt\n\n原文件已完整保存，可从原始记录详情下载。",
        attachments: [expect.objectContaining({ sourceDigest: expect.any(String) })],
      }),
    ]));
    expect(archive.sourceFiles).toHaveLength(1);
    expect(cleaned).toBe(true);
  });

  test("attachment cleanup failure does not mask successful ingestion", async () => {
    const cleanupPath = join(dir, "cleanup.txt");
    writeFileSync(cleanupPath, "x", "utf8");
    orch = new Orchestrator({
      engine,
      connector,
      llm: fake,
      attachmentDownloader: async () => [{
        attachment: { kind: "file", ref: "file_cleanup", name: "cleanup.txt" },
        localPath: cleanupPath,
        sizeBytes: 1,
        cleanup: () => {
          throw new Error("cleanup unavailable");
        },
      }],
      attachmentExtractor: async () => "cleanup failures are isolated",
    });
    await orch.start();

    await connector.inject({
      kind: "message",
      eventId: "attachment-cleanup-failure",
      chatType: "group",
      chatId: "oc_team",
      senderId: "ou_me",
      text: "[文件] cleanup.txt",
      messageId: "om_cleanup_failure",
      messageType: "file",
      mentionsBot: false,
      createdAt: Date.now(),
    });

    const archive = await engine.exportSpace("team/oc_team");
    expect(archive.raw).toEqual(expect.arrayContaining([
      expect.objectContaining({
        messageId: "om_cleanup_failure",
        content: "# 附件：cleanup.txt\n\ncleanup failures are isolated",
      }),
    ]));
  });

  test("ordinary text messages do not invoke the attachment downloader", async () => {
    let downloadCalls = 0;
    orch = new Orchestrator({
      engine,
      connector,
      llm: fake,
      attachmentDownloader: async () => {
        downloadCalls += 1;
        return [];
      },
    });
    await orch.start();

    await connector.inject({
      kind: "message",
      eventId: "ordinary-text",
      chatType: "group",
      chatId: "oc_team",
      senderId: "ou_me",
      text: "这是一条普通文本消息",
      messageId: "om_ordinary_text",
      messageType: "text",
      mentionsBot: false,
      createdAt: Date.now(),
    });

    expect(downloadCalls).toBe(0);
    expect((await engine.exportSpace("team/oc_team")).raw).toEqual([
      expect.objectContaining({
        messageId: "om_ordinary_text",
        content: "这是一条普通文本消息",
      }),
    ]);
  });

  test("all-messages mode answers an unaddressed question", async () => {
    // seed a page + the team space, then flip the group to respond-to-all
    await engine.upsertPage("team/oc_team", {
      slug: "entities/alice",
      type: "entity",
      title: "Alice",
      summary: "后端负责人",
      aliases: [],
      tags: [],
      sources: [],
      links: [],
      content: "# Alice\nAlice 负责后端服务。\n",
      updatedAt: Date.now(),
      contentHash: "h",
    });
    engine.feishuBindings.updatePolicy("team/oc_team", {
      responseMode: "all_messages",
      participationLevel: undefined,
    });
    await orch.start();
    // NOT @-mentioned, but the group is set to respond to all messages
    await connector.sendGroup("谁负责后端服务？", false);
    expect(connector.sent.length).toBe(1);
    expect(connector.sent[0]!.markdown).toContain("Alice");
  });

  test("CLI-only runtime bounds the proactive participation decision", async () => {
    let participationTimeout: number | undefined;
    const cliEngine = new KnowledgeEngine({
      dataDir: dir,
      runProvider: async (_id, input, timeoutMs) => {
        if (/群消息是否值得机器人主动回答/.test(input.prompt)) {
          participationTimeout = timeoutMs;
          return JSON.stringify({
            participationScore: 10,
            disruptionRisk: 80,
            reason: "普通陈述",
          });
        }
        throw new Error("unexpected provider call");
      },
    });
    const { connector: cliConnector, orchestrator: cliOrch } = makeCliOnlyRuntime(
      cliEngine,
      "team/oc_team",
      { name: "群助手", provider: "codex" },
    );

    await cliOrch.start();
    await cliConnector.sendGroup("Alice 今天更新了后端服务。", false);

    expect(participationTimeout).toBe(AI_OPERATION_TIMEOUT_MS);
    expect(cliConnector.sent).toHaveLength(0);
  });

  test("CLI-only runtime prefilters an obvious question and uses the space agent for answering", async () => {
    // No injected orchestrator llm: routing and synthesis use the space's
    // CLI-backed client without a separate intent-classification turn.
    let sawInstruction = false;
    let sawLegacyIntentPrompt = false;
    const cliEngine = new KnowledgeEngine({
      dataDir: dir,
      runProvider: async (id, input) => {
        const outputSchema = JSON.stringify(input.outputSchema ?? {});
        if (/像海盗一样说话/.test(input.prompt)) sawInstruction = true;
        if (/relevant/.test(outputSchema)) {
          return JSON.stringify({ slugs: ["entities/alice"], relevant: true });
        }
        if (/grounded/.test(outputSchema)) {
          return JSON.stringify({
            answer: "后端由 [[entities/alice|Alice]] 负责。",
            grounded: true,
            usedSlugs: ["entities/alice"],
            gaps: [],
          });
        }
        if (/intent/.test(outputSchema)) {
          sawLegacyIntentPrompt =
            id === "codex" &&
            input.model === "gpt-5.6-sol" &&
            input.reasoningEffort === "high";
          return JSON.stringify({ intent: "question" });
        }
        return "ok";
      },
    });
    await cliEngine.upsertPage("team/oc_team", {
      slug: "entities/alice",
      type: "entity",
      title: "Alice",
      summary: "后端负责人",
      aliases: [],
      tags: [],
      sources: [],
      links: [],
      content: "# Alice\nAlice 负责后端服务。\n",
      updatedAt: Date.now(),
      contentHash: "h",
    });
    const { connector: cliConnector, orchestrator: cliOrch } = makeCliOnlyRuntime(
      cliEngine,
      "team/oc_team",
      {
        name: "海盗",
        instruction: "像海盗一样说话，Arrr。",
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        provider: "codex",
      },
    );
    await cliOrch.start();
    await cliConnector.sendGroup("谁负责后端服务", true);
    expect(cliConnector.sent[0]!.markdown).toContain("Alice");
    expect(sawLegacyIntentPrompt).toBe(false);
    expect(sawInstruction).toBe(true);
  });

  test("CLI-only runtime handles an explicit distillation control without model classification", async () => {
    let sawLegacyIntentPrompt = false;
    const cliEngine = new KnowledgeEngine({
      dataDir: dir,
      runProvider: async (id, input) => {
        if (/JSON Schema/.test(input.prompt) && /intent/.test(input.prompt)) {
          sawLegacyIntentPrompt = id === "codex";
          return JSON.stringify({ intent: "command" });
        }
        if (/JSON Schema/.test(input.prompt) && /operations/.test(input.prompt)) {
          return JSON.stringify({ operations: [], skippedRawIds: [] });
        }
        return "ok";
      },
    });
    const { connector: cliConnector, orchestrator: cliOrch } = makeCliOnlyRuntime(
      cliEngine,
      "personal/ou_me",
      { name: "本机助手", provider: "codex" },
    );

    await cliOrch.start();
    await cliConnector.sendP2P("帮我重新提炼一下知识");

    expect(cliConnector.sent[0]!.markdown).toContain("开始重新提炼");
    expect(sawLegacyIntentPrompt).toBe(false);
  });

  test("CLI-only runtime lets the space agent respond naturally to an ordinary statement", async () => {
    let sawLegacyIntentPrompt = false;
    let sawConversation = false;
    const cliEngine = new KnowledgeEngine({
      dataDir: dir,
      runProvider: async (id, input) => {
        if (/JSON Schema/.test(input.prompt) && /intent/.test(input.prompt)) {
          sawLegacyIntentPrompt = id === "codex";
          return JSON.stringify({ intent: "remember" });
        }
        sawConversation = id === "codex" && input.prompt.includes("发布流程先灰度再全量");
        return "ok";
      },
    });
    const { connector: cliConnector, orchestrator: cliOrch } = makeCliOnlyRuntime(
      cliEngine,
      "personal/ou_me",
      { name: "本机助手", provider: "codex" },
    );

    await cliOrch.start();
    await cliConnector.sendP2P("发布流程先灰度再全量");

    expect(cliConnector.sent[0]!.markdown).toContain("ok");
    expect(sawLegacyIntentPrompt).toBe(false);
    expect(sawConversation).toBe(true);
  });

  test("CLI-only runtime gives configuration guidance when no local provider can be resolved", async () => {
    saveSettings({ defaultProvider: "gateway" }, dir);
    resetConfig();
    const cliEngine = new KnowledgeEngine({ dataDir: dir });
    const { connector: cliConnector, orchestrator: cliOrch } = makeCliOnlyRuntime(
      cliEngine,
      "personal/ou_me",
    );

    await cliOrch.start();
    await cliConnector.sendP2P("谁负责后端服务");

    expect(cliConnector.sent[0]!.markdown).toContain("回答 Agent 暂时不可用");
  });

  test("CLI-only runtime reports the frozen timeout instead of a hard-coded 120 seconds", async () => {
    saveSettings({ chatTimeoutMinutes: 420 }, dir);
    resetConfig();
    const cliEngine = new KnowledgeEngine({
      dataDir: dir,
      runProvider: async (_id, _input, timeoutMs) => {
        throw new Error(`provider codex timed out after ${timeoutMs}ms`);
      },
    });
    const { connector: cliConnector, orchestrator: cliOrch } = makeCliOnlyRuntime(
      cliEngine,
      "personal/ou_me",
      { name: "快速助手", provider: "codex", model: "gpt-5.6-luna" },
    );

    await cliOrch.start();
    await cliConnector.sendP2P("谁负责后端服务");

    expect(cliConnector.sent[0]!.markdown).toContain("回答超时");
    expect(cliConnector.sent[0]!.markdown).toContain("420 分钟");
    expect(cliConnector.sent[0]!.markdown).not.toContain("120 秒");
    expect(cliConnector.sent[0]!.markdown).toContain("gpt-5.6-luna");
    expect(cliConnector.sent[0]!.markdown).not.toContain("未配置");
  });

  test("CLI-only runtime freezes the configured chat timeout and passes it to the provider", async () => {
    saveSettings({ chatTimeoutMinutes: 420 }, dir);
    resetConfig();
    const providerTimeouts: Array<number | undefined> = [];
    const cliEngine = new KnowledgeEngine({
      dataDir: dir,
      runProvider: async (_id, _input, timeoutMs) => {
        providerTimeouts.push(timeoutMs);
        return "这是一个需要模型回答的问题。";
      },
    });
    const { connector: cliConnector, orchestrator: cliOrch } = makeCliOnlyRuntime(
      cliEngine,
      "personal/ou_me",
      { name: "长回答助手", provider: "codex", model: "gpt-5.6-sol" },
    );

    await cliOrch.start();
    await cliConnector.sendP2P("请解释一个复杂技术方案");

    expect(providerTimeouts).toEqual([420 * 60_000]);
    expect(cliEngine.chatRuns.list()[0]?.timeoutMs).toBe(420 * 60_000);
  });

  test("CLI-only runtime enforces the frozen timeout across the whole answer", async () => {
    const cliEngine = new KnowledgeEngine({
      dataDir: dir,
      runProvider: async (_id, _input, timeoutMs, signal) => {
        expect(timeoutMs).toBe(25);
        return await new Promise<string>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    });
    const { connector: cliConnector, orchestrator: cliOrch } = makeCliOnlyRuntime(
      cliEngine,
      "personal/ou_me",
      { name: "限时助手", provider: "codex", model: "gpt-5.6-sol" },
      { chatAnswerTimeoutMs: 25 },
    );

    await cliOrch.start();
    await cliConnector.sendP2P("请分析这个复杂问题");

    expect(cliConnector.sent[0]!.markdown).toContain("25 毫秒");
    expect(cliEngine.chatRuns.list()[0]).toEqual(expect.objectContaining({
      timeoutMs: 25,
      status: "timed_out",
    }));
  });

  test("CLI-only runtime answers a prefiltered greeting without resolving a provider", async () => {
    saveSettings({ defaultProvider: "gateway" }, dir);
    resetConfig();
    const cliEngine = new KnowledgeEngine({ dataDir: dir });
    const { connector: cliConnector, orchestrator: cliOrch } = makeCliOnlyRuntime(
      cliEngine,
      "personal/ou_me",
    );

    await cliOrch.start();
    await cliConnector.sendP2P("你好");

    expect(cliConnector.sent[0]!.markdown).toContain("我在");
  });

  test("/task new is handled as a control command: creates a task, not captured, replies", async () => {
    const reactive = connector as CliConnector & Connector;
    reactive.isChatAdministrator = async () => true;
    await orch.start();
    // group message WITHOUT @-mention — control commands still respond + are not stored
    await connector.sendGroup("/task new 大模型 Agent 进展", false);
    expect(connector.sent.length).toBe(1);
    expect(connector.sent[0]!.markdown).toContain("已创建");
    // a task now exists in the team space
    const tasks = engine.tasks.list().filter((t) => t.space === "team/oc_team");
    expect(tasks.length).toBe(1);
    expect(tasks[0]!.topic).toBe("大模型 Agent 进展");
    // the control message was NOT captured as knowledge
    expect(engine.registry.store("team/oc_team").index().countRaw()).toBe(0);
  });

  test("ordinary group members cannot create or run filesystem-capable tasks", async () => {
    const reactive = connector as CliConnector & Connector;
    reactive.isChatAdministrator = async () => false;
    await orch.start();

    await connector.sendGroup("/task new 读取本机密钥并汇总", false);

    expect(connector.sent).toHaveLength(1);
    expect(connector.sent[0]!.markdown).toContain("只有群主或群管理员");
    expect(engine.tasks.list()).toHaveLength(0);

    const task = engine.tasks.create({
      name: "existing sensitive task",
      space: "team/oc_team",
      topic: "read local credentials",
      distillOnRun: false,
    })!;
    await connector.sendGroup(`/task run ${task.name}`, true);

    expect(connector.sent).toHaveLength(2);
    expect(connector.sent[1]!.markdown).toContain("只有群主或群管理员");
    expect(engine.listTaskRuns(task.id)).toHaveLength(0);
  });

  test("ordinary group members cannot create learning automations or redistill a space", async () => {
    const reactive = connector as CliConnector & Connector;
    reactive.isChatAdministrator = async () => false;
    let dreamCalls = 0;
    engine.runDreamCycle = async () => {
      dreamCalls += 1;
      throw new Error("must not run");
    };
    await orch.start();

    await connector.sendGroup("/learn topic 读取网页并持续学习", false);
    await connector.sendGroup("帮我重新提炼一下知识", true);

    expect(connector.sent).toHaveLength(2);
    expect(connector.sent[0]!.markdown).toContain("只有群主或群管理员");
    expect(connector.sent[1]!.markdown).toContain("只有群主或群管理员");
    expect(engine.learning.list()).toHaveLength(0);
    expect(dreamCalls).toBe(0);
  });

  test("an addressed /task command is handled before capture and conversation", async () => {
    const reactive = connector as CliConnector & Connector;
    reactive.isChatAdministrator = async () => true;
    await orch.start();

    await connector.sendGroup("@agent /task new 浸泡测试研究-20260717", true);

    expect(connector.sent).toHaveLength(1);
    expect(connector.sent[0]!.markdown).toContain("已创建每日任务");
    expect(engine.tasks.list()).toEqual([
      expect.objectContaining({
        name: "浸泡测试研究-20260717",
        topic: "浸泡测试研究-20260717",
        space: "team/oc_team",
      }),
    ]);
    expect(engine.registry.store("team/oc_team").index().countRaw()).toBe(0);
  });

  test("/task list replies without creating anything", async () => {
    await orch.start();
    await connector.sendP2P("/task");
    expect(connector.sent.length).toBe(1);
    expect(connector.sent[0]!.markdown).toContain("还没有任务");
    expect(engine.tasks.list().length).toBe(0);
  });

  test("/learn new creates a plan from the replied source without capturing the command", async () => {
    await engine.remember({
      space: "team/oc_team",
      source: "message",
      author: "ou_me",
      chatId: "oc_team",
      messageId: "om_book",
      content: "# 附件：principles.md\n\n# 第一章\n\n这是书籍正文。",
    });
    const reactive = connector as CliConnector & Connector;
    reactive.isChatAdministrator = async () => true;
    reactive.resolveReplyTarget = async () => ({ messageId: "om_book", senderId: "ou_me" });

    await orch.start();
    await connector.sendGroup("/learn new 原则", false);

    expect(connector.sent.at(-1)?.markdown).toContain("已创建学习计划「原则」");
    expect(engine.learning.listBySpace("team/oc_team")).toEqual([
      expect.objectContaining({ name: "原则", creatorId: "ou_me" }),
    ]);
    expect(engine.registry.store("team/oc_team").index().countRaw()).toBe(1);
  });

  test("/learn new without a replied source gives guidance and creates nothing", async () => {
    await orch.start();
    await connector.sendP2P("/learn new 原则");

    expect(connector.sent.at(-1)?.markdown).toContain("请回复包含书籍附件或飞书文档的原消息");
    expect(engine.learning.list()).toEqual([]);
    expect(engine.registry.store("personal/ou_me").index().countRaw()).toBe(0);
  });

  test("/learn topic creates an adaptive route without capturing the control message", async () => {
    await orch.start();
    await connector.sendP2P("/learn topic Rust 异步编程");

    expect(connector.sent.at(-1)?.markdown).toContain("已创建主题学习计划「Rust 异步」");
    expect(engine.learning.listBySpace("personal/ou_me")).toEqual([
      expect.objectContaining({ mode: "topic", topic: "Rust 异步编程", routeIndex: 0 }),
    ]);
    expect(engine.registry.store("personal/ou_me").index().countRaw()).toBe(0);
  });

  test("/learn add resolves the replied message and attaches it to the selected plan", async () => {
    const plan = engine.learning.createTopic({
      name: "Rust 异步",
      topic: "Rust 异步编程",
      space: "personal/ou_me",
      creatorId: "ou_me",
      chatId: "oc_dm",
      route: [
        { title: "Future", objective: "理解 Future" },
        { title: "运行时", objective: "理解运行时" },
      ],
    }, 1);
    await engine.remember({
      space: "personal/ou_me",
      source: "message",
      author: "ou_me",
      chatId: "oc_dm",
      messageId: "om_async_source",
      content: "# Async Book\n\nFuture 只有在 poll 时推进。",
    });
    const reactive = connector as CliConnector & Connector;
    reactive.resolveReplyTarget = async () => ({
      messageId: "om_async_source",
      senderId: "ou_me",
    });

    await orch.start();
    await connector.sendP2P("/learn add 1");

    expect(connector.sent.at(-1)?.markdown).toContain("已添加材料「Async Book」");
    expect(engine.learning.source(plan.id)?.materials).toHaveLength(1);
  });

  test("another group member cannot control or answer an owned learning plan", async () => {
    engine.ensureSpace("team/oc_team", { chatId: "oc_team" });
    const plan = engine.learning.create({
      name: "原则",
      space: "team/oc_team",
      creatorId: "ou_owner",
      chatId: "oc_team",
      sourceTitle: "原则",
      sourceContent: "# 第一章\n\n书籍正文",
      sourceRawIds: ["raw_book"],
      sourceMessageId: "om_book",
    }, 1);
    const session = engine.learning.prepareSession(plan.id, {
      startOffset: 0,
      endOffset: plan.sourceLength,
      sectionTitle: "第一章",
      excerpt: "# 第一章\n\n书籍正文",
      guide: "## 思考题\n为什么？",
      preparedAt: 2,
    })!;
    engine.learning.markDelivered(session.id, 3);
    const reactive = connector as CliConnector & Connector;
    reactive.isChatAdministrator = async () => true;
    await orch.start();

    await connector.inject({
      kind: "message",
      eventId: "learning-other-control",
      chatType: "group",
      chatId: "oc_team",
      senderId: "ou_other",
      text: "/learn pause 1",
      messageId: "om_other_control",
      mentionsBot: false,
      createdAt: Date.now(),
    });
    await connector.inject({
      kind: "message",
      eventId: "learning-other-answer",
      chatType: "group",
      chatId: "oc_team",
      senderId: "ou_other",
      text: "学习回答：我的理解",
      messageId: "om_other_answer",
      mentionsBot: true,
      createdAt: Date.now(),
    });

    expect(connector.sent.at(-2)?.markdown).toContain("没找到你的学习计划");
    expect(connector.sent.at(-1)?.markdown).toContain("当前没有等待你回答的学习课程");
    expect(engine.learning.get(plan.id)?.status).toBe("active");
    expect(engine.learning.currentSession(plan.id)?.status).toBe("awaiting_reply");
    expect(engine.registry.store("team/oc_team").index().countRaw()).toBe(0);
  });

  test("an explicit learning answer receives feedback and is not captured as ordinary knowledge", async () => {
    const plan = engine.learning.create({
      name: "原则",
      space: "personal/ou_me",
      creatorId: "ou_me",
      chatId: "oc_dm",
      sourceTitle: "原则",
      sourceContent: "# 第一章\n\n这是书籍正文。",
      sourceRawIds: ["raw_book"],
      sourceMessageId: "om_book",
    }, 1);
    const session = engine.learning.prepareSession(plan.id, {
      startOffset: 0,
      endOffset: plan.sourceLength,
      sectionTitle: "第一章",
      excerpt: "# 第一章\n\n这是书籍正文。",
      guide: "## 思考题\n作者为什么强调原则？",
      preparedAt: 2,
    })!;
    engine.learning.markDelivered(session.id, 3);
    await orch.start();
    await connector.sendP2P("学习回答：原则帮助我稳定地做决策");

    expect(connector.sent.at(-1)?.markdown).toContain("已记录「原则」第 1 课");
    expect(connector.sent.at(-1)?.markdown).toContain("理解正确");
    expect(engine.learning.currentSession(plan.id)).toBeUndefined();
    const raws = engine.registry.store("personal/ou_me").index().listRaw({});
    expect(raws).toHaveLength(1);
    expect(raws[0]).toEqual(expect.objectContaining({ source: "learning" }));
  });

  test("a normal question remains ordinary conversation while a lesson awaits", async () => {
    engine.ensureSpace("personal/ou_me", { chatId: "oc_dm" });
    const plan = engine.learning.create({
      name: "原则",
      space: "personal/ou_me",
      creatorId: "ou_me",
      chatId: "oc_dm",
      sourceTitle: "原则",
      sourceContent: "# 第一章\n\n书籍正文",
      sourceRawIds: ["raw_book"],
      sourceMessageId: "om_book",
    }, 1);
    const session = engine.learning.prepareSession(plan.id, {
      startOffset: 0,
      endOffset: plan.sourceLength,
      sectionTitle: "第一章",
      excerpt: "# 第一章\n\n书籍正文",
      guide: "## 思考题\n为什么？",
      preparedAt: 2,
    })!;
    engine.learning.markDelivered(session.id, 3);

    await orch.start();
    await connector.sendP2P("这章还有例子吗？");

    expect(connector.sent.at(-1)?.markdown).not.toContain("已记录「原则」");
    expect(engine.learning.currentSession(plan.id)?.status).toBe("awaiting_reply");
    expect(engine.registry.store("personal/ou_me").index().listRaw({}))
      .toEqual([expect.objectContaining({ source: "message", content: "这章还有例子吗？" })]);
  });
});
