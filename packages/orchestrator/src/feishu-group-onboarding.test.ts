import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeEngine } from "@homeagent/core";
import type {
  BotAddedEvent,
  InboundMessage,
} from "@homeagent/connectors";
import {
  FeishuGroupOnboardingService,
  isFeishuGroupActivationCommand,
  type FeishuGroupAdministrationPort,
  type FeishuOnboardingNotice,
} from "./feishu-group-onboarding.ts";

let dataDir: string;
let engine: KnowledgeEngine;
let notices: Array<{
  chatId: string;
  notice: FeishuOnboardingNotice;
  replyToMessageId?: string;
}>;
let administrator = true;
let administratorError: Error | undefined;
let chatVisible = true;
let port: FeishuGroupAdministrationPort;
let service: FeishuGroupOnboardingService;

function botAdded(eventId = "ev_added"): BotAddedEvent {
  return {
    kind: "bot_added",
    eventId,
    chatId: "oc_product",
    createdAt: 1_785_000_000_000,
  };
}

function command(
  text = "@HomeAgent 启用群聊",
  overrides: Partial<InboundMessage> = {},
): InboundMessage {
  return {
    kind: "message",
    eventId: "ev_command",
    chatType: "group",
    chatId: "oc_product",
    senderId: "ou_admin",
    text,
    messageId: "om_command",
    mentionsBot: true,
    createdAt: 1_785_000_000_100,
    ...overrides,
  };
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "homeagent-group-onboarding-"));
  engine = new KnowledgeEngine({ dataDir });
  notices = [];
  administrator = true;
  administratorError = undefined;
  chatVisible = true;
  port = {
    getBotChat: async (chatId) =>
      chatVisible ? { chatId, name: "Product" } : undefined,
    isChatAdministrator: async () => {
      if (administratorError) throw administratorError;
      return administrator;
    },
    sendOnboardingNotice: async (chatId, notice, replyToMessageId) => {
      notices.push({ chatId, notice, replyToMessageId });
    },
  };
  service = new FeishuGroupOnboardingService({
    engine,
    port,
    activeAppId: "cli_current",
  });
});

afterEach(() => {
  engine.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("Feishu group activation command", () => {
  test("requires a Bot mention and exact command text", () => {
    expect(isFeishuGroupActivationCommand(command())).toBeTrue();
    expect(isFeishuGroupActivationCommand(command(
      "  @HomeAgent   启用群聊  ",
    ))).toBeTrue();
    expect(isFeishuGroupActivationCommand(command(
      "@HomeAgent 请启用群聊",
    ))).toBeFalse();
    expect(isFeishuGroupActivationCommand(command(
      "启用群聊",
      { mentionsBot: false },
    ))).toBeFalse();
    expect(isFeishuGroupActivationCommand(command(
      "@HomeAgent 启用群聊",
      { chatType: "p2p" },
    ))).toBeFalse();
  });
});

describe("FeishuGroupOnboardingService", () => {
  test("bot-added creates one pending binding and prompt but no space", async () => {
    await service.handleBotAdded(botAdded());
    await service.handleBotAdded(botAdded("ev_duplicate"));

    expect(engine.feishuBindings.getByChatId("oc_product")).toMatchObject({
      state: "pending_confirmation",
      boundAppId: "cli_current",
      responseMode: "mentions_only",
      replyInThread: true,
      confirmationPrompt: {
        status: "sent",
      },
    });
    expect(engine.registry.has("team/oc_product")).toBeFalse();
    expect(notices).toEqual([{
      chatId: "oc_product",
      notice: "confirmation_required",
      replyToMessageId: undefined,
    }]);
  });

  test("a failed automatic prompt is persisted and not retried by duplicate events", async () => {
    let attempts = 0;
    port.sendOnboardingNotice = async () => {
      attempts += 1;
      throw new Error("private transport detail");
    };

    await service.handleBotAdded(botAdded());
    await service.handleBotAdded(botAdded("ev_duplicate"));

    const prompt = engine.feishuBindings.getByChatId("oc_product")
      ?.confirmationPrompt;
    expect(attempts).toBe(1);
    expect(prompt).toMatchObject({
      status: "failed",
      lastError: "Confirmation prompt delivery failed",
    });
    expect(prompt?.lastError).not.toContain("private transport detail");
  });

  test("an administrator activates the group with safe defaults", async () => {
    await service.handleBotAdded(botAdded());
    notices.length = 0;

    expect(await service.handleMessage(command())).toBeTrue();

    expect(engine.registry.get("team/oc_product")).toMatchObject({
      chatId: "oc_product",
      name: "Product",
    });
    expect(engine.feishuBindings.getByChatId("oc_product")).toMatchObject({
      state: "active",
      boundAppId: "cli_current",
      responseMode: "mentions_only",
      participationLevel: undefined,
      replyInThread: true,
    });
    expect(notices).toEqual([{
      chatId: "oc_product",
      notice: "activation_succeeded",
      replyToMessageId: "om_command",
    }]);
  });

  test("an ordinary member cannot activate or create a space", async () => {
    administrator = false;
    await service.handleBotAdded(botAdded());
    notices.length = 0;

    expect(await service.handleMessage(command())).toBeTrue();

    expect(engine.registry.has("team/oc_product")).toBeFalse();
    expect(engine.feishuBindings.getByChatId("oc_product")?.state)
      .toBe("pending_confirmation");
    expect(notices).toEqual([{
      chatId: "oc_product",
      notice: "administrator_required",
      replyToMessageId: "om_command",
    }]);
  });

  test("activation failure removes a newly-created empty group space", async () => {
    await service.handleBotAdded(botAdded());
    notices.length = 0;
    const connect = engine.feishuBindings.connect;
    engine.feishuBindings.connect = () => {
      throw new Error("binding persistence unavailable");
    };

    try {
      expect(await service.handleMessage(command())).toBeTrue();
    } finally {
      engine.feishuBindings.connect = connect;
    }

    expect(engine.registry.has("team/oc_product")).toBeFalse();
    expect(engine.feishuBindings.getByChatId("oc_product")?.state)
      .toBe("pending_confirmation");
    expect(notices).toEqual([{
      chatId: "oc_product",
      notice: "activation_failed",
      replyToMessageId: "om_command",
    }]);
  });

  test("administrator lookup failure fails closed", async () => {
    administratorError = new Error("network unavailable");
    await service.handleBotAdded(botAdded());
    notices.length = 0;

    expect(await service.handleMessage(command())).toBeTrue();

    expect(engine.registry.has("team/oc_product")).toBeFalse();
    expect(engine.feishuBindings.getByChatId("oc_product")?.state)
      .toBe("pending_confirmation");
    expect(notices).toEqual([{
      chatId: "oc_product",
      notice: "verification_unavailable",
      replyToMessageId: "om_command",
    }]);
  });

  test("an authorized command recovers when bot-added was missed", async () => {
    expect(await service.handleMessage(command())).toBeTrue();

    expect(engine.registry.has("team/oc_product")).toBeTrue();
    expect(engine.feishuBindings.getByChatId("oc_product")?.state)
      .toBe("active");
  });

  test("local disconnect blocks events and commands until locally reopened", async () => {
    await service.handleBotAdded(botAdded());
    engine.feishuBindings.disconnect("team/oc_product");
    notices.length = 0;

    await service.handleBotAdded(botAdded("ev_readded"));
    expect(await service.handleMessage(command())).toBeTrue();

    expect(engine.registry.has("team/oc_product")).toBeFalse();
    expect(engine.feishuBindings.getByChatId("oc_product")?.state)
      .toBe("disconnected");
    expect(notices).toEqual([]);
  });
});
