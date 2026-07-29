import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeEngine } from "@homeagent/core";
import {
  FeishuIntegrationError,
  FeishuIntegrationService,
} from "./feishu-integration-service.ts";
import type { LarkSetupPort } from "./integrations.ts";

let dataDir: string;
let engine: KnowledgeEngine;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "homeagent-feishu-service-"));
  engine = new KnowledgeEngine({ dataDir });
});

afterEach(() => {
  engine.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function setupPort(
  overrides: Partial<LarkSetupPort> = {},
): LarkSetupPort {
  return {
    status: async () => ({
      state: "ready",
      verified: true,
      appId: "cli_current",
      brand: "feishu",
      botName: "HomeAgent",
      botOpenId: "ou_bot",
      message: "ready",
    }),
    configure: async () => {
      throw new Error("not used");
    },
    getBotChat: async () => undefined,
    fullGroupMessageCapability: async () => "available",
    listBotChats: async () => [],
    ...overrides,
  };
}

describe("FeishuIntegrationService", () => {
  test("membership failure leaves no binding or knowledge space", async () => {
    const service = new FeishuIntegrationService({
      engine,
      larkSetup: setupPort(),
    });

    let error: unknown;
    try {
      await service.connectGroup({
        chatId: "oc_product",
        responseMode: "mentions_only",
        replyInThread: true,
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(FeishuIntegrationError);
    expect((error as FeishuIntegrationError).code).toBe("chat_not_visible");
    expect(engine.registry.has("team/oc_product")).toBeFalse();
    expect(engine.feishuBindings.list()).toEqual([]);
  });

  test("candidate discovery excludes active bindings and includes reconnectable groups", async () => {
    for (const chatId of ["oc_active", "oc_disconnected", "oc_reconnect"]) {
      engine.feishuBindings.connect({
        chatId,
        spaceId: `team/${chatId}`,
        boundAppId: "cli_current",
        responseMode: "mentions_only",
        replyInThread: true,
      });
    }
    engine.feishuBindings.disconnect("team/oc_disconnected");
    engine.feishuBindings.markAppNeedsReconnect("cli_current");
    engine.feishuBindings.connect({
      chatId: "oc_active",
      spaceId: "team/oc_active",
      boundAppId: "cli_current",
      responseMode: "mentions_only",
      replyInThread: true,
    });
    const service = new FeishuIntegrationService({
      engine,
      larkSetup: setupPort({
        listBotChats: async () => [
          { chatId: "oc_active", name: "Active" },
          { chatId: "oc_disconnected", name: "Disconnected" },
          { chatId: "oc_new", name: "New" },
          { chatId: "oc_reconnect", name: "Reconnect" },
        ],
      }),
    });

    expect(await service.listConnectionCandidates()).toEqual([
      { chatId: "oc_disconnected", name: "Disconnected" },
      { chatId: "oc_new", name: "New" },
      { chatId: "oc_reconnect", name: "Reconnect" },
    ]);
  });

  test("updates group metadata and writes reply policy only to the binding", async () => {
    const spaceId = "team/oc_product" as const;
    engine.ensureSpace(spaceId, { chatId: "oc_product" });
    engine.updateSpaceMeta(spaceId, {
      mentionsOnly: true,
      replyInThread: true,
    });
    engine.feishuBindings.connect({
      chatId: "oc_product",
      spaceId,
      boundAppId: "cli_current",
      responseMode: "mentions_only",
      replyInThread: true,
    });
    const agent = engine.agents.create({
      name: "Product Agent",
      visibility: "Team",
    });
    const service = new FeishuIntegrationService({
      engine,
      larkSetup: setupPort(),
    });

    await service.updateGroup({
      spaceId,
      name: "Product",
      agentId: agent.id,
      responseMode: "all_messages",
      replyInThread: false,
    });

    expect(engine.feishuBindings.getBySpace(spaceId)).toMatchObject({
      responseMode: "all_messages",
      participationLevel: undefined,
      replyInThread: false,
    });
    expect(engine.registry.get(spaceId)).toMatchObject({
      name: "Product",
      agentId: agent.id,
      mentionsOnly: true,
      replyInThread: true,
    });
  });

  test("disconnecting a group preserves its workspace and captured knowledge", async () => {
    const spaceId = "team/oc_product" as const;
    engine.ensureSpace(spaceId, { chatId: "oc_product" });
    engine.feishuBindings.connect({
      chatId: "oc_product",
      spaceId,
      boundAppId: "cli_current",
      responseMode: "mentions_only",
      replyInThread: true,
    });
    const rawId = await engine.remember({
      space: spaceId,
      source: "message",
      content: "Keep this product decision.",
    });
    const service = new FeishuIntegrationService({
      engine,
      larkSetup: setupPort(),
    });

    await service.disconnectGroup(spaceId);

    expect(engine.feishuBindings.getBySpace(spaceId)?.state).toBe("disconnected");
    expect(engine.registry.has(spaceId)).toBeTrue();
    expect(await engine.getRawGovernanceDetail(spaceId, rawId)).not.toBeNull();
  });

  test("connection tests persist bounded status without changing binding state", async () => {
    const spaceId = "team/oc_product" as const;
    engine.ensureSpace(spaceId, { chatId: "oc_product" });
    engine.feishuBindings.connect({
      chatId: "oc_product",
      spaceId,
      boundAppId: "cli_current",
      responseMode: "mentions_only",
      replyInThread: true,
    });
    let fail = false;
    const service = new FeishuIntegrationService({
      engine,
      larkSetup: setupPort({
        getBotChat: async () => ({ chatId: "oc_product", name: "Product" }),
      }),
      sendTestMessage: async () => {
        if (fail) throw new Error(`private ${"x".repeat(1_000)}`);
      },
    });

    await service.testGroup(spaceId);
    expect(engine.feishuBindings.getBySpace(spaceId)).toMatchObject({
      state: "active",
      lastTestStatus: "succeeded",
    });

    fail = true;
    await expect(service.testGroup(spaceId)).rejects.toMatchObject({
      code: "test_failed",
    });
    const failed = engine.feishuBindings.getBySpace(spaceId);
    expect(failed).toMatchObject({
      state: "active",
      lastTestStatus: "failed",
    });
    expect(failed?.lastError).not.toContain("private");
  });

  test("snapshot combines Bot, runtime, capability, bindings, metadata, and Team Agents", async () => {
    const spaceId = "team/oc_product" as const;
    engine.ensureSpace(spaceId, { chatId: "oc_product" });
    engine.updateSpaceMeta(spaceId, { name: "Product" });
    engine.feishuBindings.connect({
      chatId: "oc_product",
      spaceId,
      boundAppId: "cli_old",
      responseMode: "smart",
      participationLevel: "balanced",
      replyInThread: true,
    });
    const teamAgent = engine.agents.create({
      name: "Team Agent",
      visibility: "Team",
    });
    engine.agents.create({ name: "Personal Agent", visibility: "Personal" });
    const runtime = {
      ready: true,
      consumers: [{ key: "messages", state: "ready" }],
    };
    const service = new FeishuIntegrationService({
      engine,
      larkSetup: setupPort({
        fullGroupMessageCapability: async () => "unavailable",
      }),
      activeIdentity: () => ({ botName: "Old Bot", botOpenId: "ou_old" }),
      runtimeStatus: () => runtime,
    });

    const snapshot = await service.snapshot();

    expect(snapshot).toMatchObject({
      bot: { appId: "cli_current", botName: "HomeAgent" },
      activeIdentity: { botName: "Old Bot", botOpenId: "ou_old" },
      runtime,
      capability: "unavailable",
      restartRequired: true,
      agents: [{ id: teamAgent.id, name: "Team Agent" }],
      groups: [{
        state: "needs_reconnect",
        degraded: true,
        space: { id: spaceId, name: "Product" },
        binding: {
          chatId: "oc_product",
          boundAppId: "cli_old",
          responseMode: "smart",
        },
      }],
    });
    expect(engine.feishuBindings.getBySpace(spaceId)?.state).toBe("active");
  });

  test("disconnecting the Bot records a local disable and marks its bindings", async () => {
    engine.feishuBindings.connect({
      chatId: "oc_product",
      spaceId: "team/oc_product",
      boundAppId: "cli_current",
      responseMode: "mentions_only",
      replyInThread: true,
    });
    engine.feishuBindings.connect({
      chatId: "oc_other",
      spaceId: "team/oc_other",
      boundAppId: "cli_other",
      responseMode: "mentions_only",
      replyInThread: true,
    });
    const persisted: string[] = [];
    let disabled = 0;
    const service = new FeishuIntegrationService({
      engine,
      larkSetup: setupPort(),
      persistConnectionDisabledAppId: async (appId) => {
        persisted.push(appId);
      },
      disableRuntime: async () => {
        disabled += 1;
      },
    });

    await service.disconnectBot();

    expect(persisted).toEqual(["cli_current"]);
    expect(disabled).toBe(1);
    expect(engine.feishuBindings.getByChatId("oc_product")?.state)
      .toBe("needs_reconnect");
    expect(engine.feishuBindings.getByChatId("oc_other")?.state).toBe("active");
  });

  test("connect rereads membership and reconnect preserves existing knowledge", async () => {
    let verifiedBeforeWrite = false;
    const service = new FeishuIntegrationService({
      engine,
      larkSetup: setupPort({
        getBotChat: async (chatId) => {
          verifiedBeforeWrite = !engine.registry.has(`team/${chatId}`)
            && engine.feishuBindings.getByChatId(chatId) === undefined;
          return { chatId, name: "Product" };
        },
      }),
    });
    await service.connectGroup({
      chatId: "oc_product",
      responseMode: "mentions_only",
      replyInThread: true,
    });
    expect(verifiedBeforeWrite).toBeTrue();
    const original = engine.feishuBindings.getByChatId("oc_product")!;
    const rawId = await engine.remember({
      space: original.spaceId,
      source: "message",
      content: "Persistent decision",
    });
    engine.feishuBindings.disconnect(original.spaceId);

    const reconnect = new FeishuIntegrationService({
      engine,
      larkSetup: setupPort({
        status: async () => ({
          state: "ready",
          verified: true,
          appId: "cli_new",
          brand: "feishu",
          botName: "New Bot",
          botOpenId: "ou_new",
          message: "ready",
        }),
        getBotChat: async (chatId) => ({ chatId, name: "Product" }),
      }),
    });
    await reconnect.connectGroup({
      chatId: "oc_product",
      responseMode: "mentions_only",
      replyInThread: false,
    });

    expect(engine.feishuBindings.getByChatId("oc_product")).toMatchObject({
      state: "active",
      boundAppId: "cli_new",
      createdAt: original.createdAt,
    });
    expect(await engine.getRawGovernanceDetail(original.spaceId, rawId))
      .not.toBeNull();
  });

  test("a failed binding write rolls back only a newly created workspace", async () => {
    const service = new FeishuIntegrationService({
      engine,
      larkSetup: setupPort({
        getBotChat: async (chatId) => ({ chatId, name: "Product" }),
      }),
    });
    const originalConnect = engine.feishuBindings.connect.bind(
      engine.feishuBindings,
    );
    engine.feishuBindings.connect = () => {
      throw new Error("forced binding failure");
    };

    await expect(service.connectGroup({
      chatId: "oc_new",
      responseMode: "mentions_only",
      replyInThread: true,
    })).rejects.toThrow("forced binding failure");
    expect(engine.registry.has("team/oc_new")).toBeFalse();

    engine.ensureSpace("team/oc_existing", { chatId: "oc_existing" });
    await expect(service.connectGroup({
      chatId: "oc_existing",
      responseMode: "mentions_only",
      replyInThread: true,
    })).rejects.toThrow("forced binding failure");
    expect(engine.registry.has("team/oc_existing")).toBeTrue();
    engine.feishuBindings.connect = originalConnect;
  });

  test("mentions-only bypasses full-message permission while smart fails closed", async () => {
    let membershipReads = 0;
    const service = new FeishuIntegrationService({
      engine,
      larkSetup: setupPort({
        fullGroupMessageCapability: async () => "unknown",
        getBotChat: async (chatId) => {
          membershipReads += 1;
          return { chatId, name: "Product" };
        },
      }),
    });

    await expect(service.connectGroup({
      chatId: "oc_smart",
      responseMode: "smart",
      replyInThread: true,
    })).rejects.toMatchObject({ code: "capability_required" });
    expect(membershipReads).toBe(0);
    expect(engine.registry.has("team/oc_smart")).toBeFalse();

    await service.connectGroup({
      chatId: "oc_mentions",
      responseMode: "mentions_only",
      replyInThread: true,
    });
    expect(membershipReads).toBe(1);
    expect(engine.feishuBindings.activeByChatId("oc_mentions")).toBeDefined();

    engine.ensureSpace("team/oc_degraded", { chatId: "oc_degraded" });
    engine.feishuBindings.connect({
      chatId: "oc_degraded",
      spaceId: "team/oc_degraded",
      boundAppId: "cli_current",
      responseMode: "smart",
      participationLevel: "balanced",
      replyInThread: true,
    });
    engine.feishuBindings.disconnect("team/oc_degraded");
    await service.connectGroup({
      chatId: "oc_degraded",
      responseMode: "smart",
      participationLevel: "balanced",
      replyInThread: true,
    });
    expect(membershipReads).toBe(2);
    expect(engine.feishuBindings.activeByChatId("oc_degraded")).toMatchObject({
      responseMode: "smart",
      participationLevel: "balanced",
    });
  });

  test("invalid Agent visibility changes neither metadata nor binding policy", async () => {
    const spaceId = "team/oc_product" as const;
    engine.ensureSpace(spaceId, { chatId: "oc_product" });
    engine.updateSpaceMeta(spaceId, { name: "Before" });
    const binding = engine.feishuBindings.connect({
      chatId: "oc_product",
      spaceId,
      boundAppId: "cli_current",
      responseMode: "mentions_only",
      replyInThread: true,
    });
    const personalAgent = engine.agents.create({
      name: "Personal",
      visibility: "Personal",
    });
    const service = new FeishuIntegrationService({
      engine,
      larkSetup: setupPort(),
    });

    await expect(service.updateGroup({
      spaceId,
      name: "After",
      agentId: personalAgent.id,
      responseMode: "all_messages",
      replyInThread: false,
    })).rejects.toMatchObject({ code: "invalid_input" });

    expect(engine.feishuBindings.getBySpace(spaceId)).toEqual(binding);
    expect(engine.registry.get(spaceId)?.name).toBe("Before");
  });
});
