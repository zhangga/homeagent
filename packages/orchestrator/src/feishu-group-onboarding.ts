import { logger, teamSpace, type LarkChatSummary } from "@homeagent/shared";
import type {
  FeishuGroupBinding,
  KnowledgeEngine,
} from "@homeagent/core";
import type {
  BotAddedEvent,
  Connector,
  InboundMessage,
} from "@homeagent/connectors";

const log = logger.child("orchestrator:feishu-onboarding");
const ACTIVATION_COMMAND = "启用群聊";
export const FEISHU_GROUP_CONFIRMATION_PROMPT = [
  "我已加入本群，但目前不会读取或记录群消息。",
  "请群主或管理员在群内发送“@HomeAgent 启用群聊”。",
].join("\n");

export type FeishuOnboardingNotice =
  | "confirmation_required"
  | "administrator_required"
  | "verification_unavailable"
  | "activation_succeeded"
  | "activation_already_active"
  | "activation_failed";

export interface FeishuGroupAdministrationPort {
  getBotChat(chatId: string): Promise<LarkChatSummary | undefined>;
  isChatAdministrator(chatId: string, userId: string): Promise<boolean>;
  sendOnboardingNotice(
    chatId: string,
    notice: FeishuOnboardingNotice,
    replyToMessageId?: string,
  ): Promise<void>;
}

export interface FeishuGroupOnboardingOptions {
  engine: KnowledgeEngine;
  port: FeishuGroupAdministrationPort;
  activeAppId?: string;
}

const ONBOARDING_MESSAGES: Record<FeishuOnboardingNotice, string> = {
  confirmation_required: FEISHU_GROUP_CONFIRMATION_PROMPT,
  administrator_required: "请由本群群主或管理员发送 `@HomeAgent 启用群聊`。",
  verification_unavailable: "暂时无法验证群管理员身份，请稍后重试。",
  activation_succeeded: "本群已启用。默认仅响应 @HomeAgent 的消息，并在线程内回复。",
  activation_already_active: "本群已经启用，无需重复操作。",
  activation_failed: "群聊启用失败，请稍后重试或前往 HomeAgent Integrations 查看状态。",
};

export function connectorFeishuGroupAdministrationPort(
  connector: Connector,
): FeishuGroupAdministrationPort {
  return {
    getBotChat: async (chatId) => {
      if (!connector.getBotChat) {
        throw new Error("Bot group lookup is unavailable");
      }
      return connector.getBotChat(chatId);
    },
    isChatAdministrator: async (chatId, userId) => {
      if (!connector.checkChatAdministrator) {
        throw new Error("Group administrator lookup is unavailable");
      }
      return connector.checkChatAdministrator(chatId, userId);
    },
    sendOnboardingNotice: async (chatId, notice, replyToMessageId) => {
      const markdown = ONBOARDING_MESSAGES[notice];
      if (replyToMessageId) {
        await connector.reply({
          chatId,
          replyToMessageId,
          markdown,
          inThread: true,
        });
        return;
      }
      await connector.notice(chatId, markdown);
    },
  };
}

export function isFeishuGroupActivationCommand(
  message: InboundMessage,
): boolean {
  if (message.chatType !== "group" || !message.mentionsBot) return false;
  const text = message.text
    .trim()
    .replace(/^(?:@\S+(?:\s+|$))+/u, "")
    .trim();
  return text === ACTIVATION_COMMAND;
}

export class FeishuGroupOnboardingService {
  private readonly engine: KnowledgeEngine;
  private readonly port: FeishuGroupAdministrationPort;
  private readonly activeAppId?: string;

  constructor(options: FeishuGroupOnboardingOptions) {
    this.engine = options.engine;
    this.port = options.port;
    this.activeAppId = options.activeAppId;
  }

  async handleBotAdded(event: BotAddedEvent): Promise<void> {
    const binding = this.engine.feishuBindings.registerPending({
      chatId: event.chatId,
      spaceId: teamSpace(event.chatId),
      boundAppId: this.activeAppId,
    });
    if (
      binding.state !== "pending_confirmation"
      || binding.confirmationPrompt
    ) {
      return;
    }
    await this.sendConfirmationPrompt(binding);
  }

  async handleMessage(message: InboundMessage): Promise<boolean> {
    if (!isFeishuGroupActivationCommand(message)) return false;

    let binding = this.engine.feishuBindings.getByChatId(message.chatId);
    if (binding?.state === "disconnected") return true;
    if (
      binding?.state === "active"
      && this.matchesActiveApp(binding)
    ) {
      await this.safeNotice(
        message.chatId,
        "activation_already_active",
        message.messageId,
      );
      return true;
    }

    let chat: LarkChatSummary | undefined;
    if (
      !binding
      || binding.state === "needs_reconnect"
      || !this.matchesActiveApp(binding)
    ) {
      chat = await this.verifiedChat(
        message.chatId,
        message.messageId,
      );
      if (!chat) return true;
      binding = this.engine.feishuBindings.registerPending({
        chatId: message.chatId,
        spaceId: teamSpace(message.chatId),
        boundAppId: this.activeAppId,
      });
    }

    if (
      binding.state !== "pending_confirmation"
      || !this.matchesActiveApp(binding)
    ) {
      await this.safeNotice(
        message.chatId,
        "activation_failed",
        message.messageId,
      );
      return true;
    }

    let administrator: boolean;
    try {
      administrator = await this.port.isChatAdministrator(
        message.chatId,
        message.senderId,
      );
    } catch {
      log.warn("group administrator verification unavailable", {
        chatId: message.chatId,
      });
      await this.safeNotice(
        message.chatId,
        "verification_unavailable",
        message.messageId,
      );
      return true;
    }
    if (!administrator) {
      await this.safeNotice(
        message.chatId,
        "administrator_required",
        message.messageId,
      );
      return true;
    }

    chat ??= await this.verifiedChat(message.chatId, message.messageId);
    if (!chat) return true;

    const spaceId = teamSpace(message.chatId);
    const spaceExisted = this.engine.registry.has(spaceId);
    try {
      if (this.engine.registry.storageConflict(spaceId)) {
        throw new Error("Group workspace path is already in use");
      }
      this.engine.ensureSpace(spaceId, { chatId: message.chatId });
      if (chat.name.trim()) {
        this.engine.updateSpaceMeta(spaceId, { name: chat.name.trim() });
      }
      this.engine.feishuBindings.connect({
        chatId: message.chatId,
        spaceId,
        boundAppId: this.activeAppId,
        responseMode: "mentions_only",
        participationLevel: undefined,
        replyInThread: true,
      });
    } catch {
      if (!spaceExisted && this.engine.registry.has(spaceId)) {
        this.engine.registry.remove(spaceId);
      }
      log.warn("group activation failed", {
        chatId: message.chatId,
      });
      await this.safeNotice(
        message.chatId,
        "activation_failed",
        message.messageId,
      );
      return true;
    }

    await this.safeNotice(
      message.chatId,
      "activation_succeeded",
      message.messageId,
    );
    return true;
  }

  private matchesActiveApp(binding: FeishuGroupBinding): boolean {
    return this.activeAppId === undefined
      || binding.boundAppId === this.activeAppId;
  }

  private async sendConfirmationPrompt(
    binding: FeishuGroupBinding,
  ): Promise<void> {
    const attemptedAt = Date.now();
    this.engine.feishuBindings.recordConfirmationPrompt(binding.chatId, {
      status: "attempting",
      at: attemptedAt,
    });
    try {
      await this.port.sendOnboardingNotice(
        binding.chatId,
        "confirmation_required",
      );
      this.engine.feishuBindings.recordConfirmationPrompt(binding.chatId, {
        status: "sent",
        at: attemptedAt,
      });
    } catch {
      this.engine.feishuBindings.recordConfirmationPrompt(binding.chatId, {
        status: "failed",
        at: attemptedAt,
        error: "Confirmation prompt delivery failed",
      });
      log.warn("group confirmation prompt failed", {
        chatId: binding.chatId,
      });
    }
  }

  private async verifiedChat(
    chatId: string,
    replyToMessageId: string,
  ): Promise<LarkChatSummary | undefined> {
    try {
      const chat = await this.port.getBotChat(chatId);
      if (chat?.chatId === chatId) return chat;
      await this.safeNotice(chatId, "activation_failed", replyToMessageId);
      return undefined;
    } catch {
      log.warn("group membership verification unavailable", {
        chatId,
      });
      await this.safeNotice(
        chatId,
        "verification_unavailable",
        replyToMessageId,
      );
      return undefined;
    }
  }

  private async safeNotice(
    chatId: string,
    notice: FeishuOnboardingNotice,
    replyToMessageId?: string,
  ): Promise<void> {
    try {
      await this.port.sendOnboardingNotice(
        chatId,
        notice,
        replyToMessageId,
      );
    } catch {
      log.warn("group onboarding reply failed", {
        chatId,
        notice,
      });
    }
  }
}
