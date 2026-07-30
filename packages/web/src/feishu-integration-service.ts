import type {
  Agent,
  FeishuGroupBinding,
  FeishuGroupBindingState,
  FeishuResponseMode,
  GroupParticipationLevel,
  KnowledgeEngine,
  SpaceMeta,
} from "@homeagent/core";
import { agentVisibleInSpace } from "@homeagent/core";
import {
  teamSpace,
  type LarkBotIdentity,
  type LarkCapabilityState,
  type LarkChatSummary,
  type LarkSetupStatus,
  type SpaceId,
} from "@homeagent/shared";
import type { FeishuRuntimeStatus, LarkSetupPort } from "./integrations.ts";

export type FeishuIntegrationErrorCode =
  | "bot_not_ready"
  | "chat_not_visible"
  | "storage_conflict"
  | "capability_required"
  | "binding_not_found"
  | "invalid_input"
  | "test_failed"
  | "prompt_failed"
  | "operation_unavailable";

export class FeishuIntegrationError extends Error {
  constructor(
    readonly code: FeishuIntegrationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "FeishuIntegrationError";
  }
}

export interface RequestFeishuGroupConfirmationInput {
  chatId: string;
}

export interface UpdateFeishuGroupInput {
  spaceId: SpaceId;
  name?: string;
  agentId?: string;
  responseMode: FeishuResponseMode;
  participationLevel?: GroupParticipationLevel;
  replyInThread: boolean;
}

export interface FeishuIntegrationServiceOptions {
  engine: KnowledgeEngine;
  larkSetup: LarkSetupPort;
  sendTestMessage?: (chatId: string, text: string) => Promise<void>;
  sendConfirmationPrompt?: (chatId: string) => Promise<void>;
  activeIdentity?: () => LarkBotIdentity | undefined;
  runtimeStatus?: () => FeishuRuntimeStatus | undefined;
  persistConnectionDisabledAppId?: (appId: string) => Promise<void> | void;
  disableRuntime?: () => Promise<void> | void;
}

export interface FeishuGroupIntegrationView {
  binding: FeishuGroupBinding;
  space?: SpaceMeta;
  chat?: LarkChatSummary;
  state: FeishuGroupBindingState;
  degraded: boolean;
}

export interface FeishuIntegrationSnapshot {
  bot: LarkSetupStatus;
  activeIdentity?: LarkBotIdentity;
  runtime?: FeishuRuntimeStatus;
  capability: LarkCapabilityState;
  restartRequired: boolean;
  groups: FeishuGroupIntegrationView[];
  agents: Agent[];
}

export class FeishuIntegrationService {
  private readonly engine: KnowledgeEngine;
  private readonly larkSetup: LarkSetupPort;
  private readonly sendTestMessage?: (chatId: string, text: string) => Promise<void>;
  private readonly sendConfirmationPrompt?: (chatId: string) => Promise<void>;
  private readonly activeIdentity: () => LarkBotIdentity | undefined;
  private readonly runtimeStatus: () => FeishuRuntimeStatus | undefined;
  private readonly persistConnectionDisabledAppId?: (
    appId: string,
  ) => Promise<void> | void;
  private readonly disableRuntime?: () => Promise<void> | void;

  constructor(opts: FeishuIntegrationServiceOptions) {
    this.engine = opts.engine;
    this.larkSetup = opts.larkSetup;
    this.sendTestMessage = opts.sendTestMessage;
    this.sendConfirmationPrompt = opts.sendConfirmationPrompt;
    this.activeIdentity = opts.activeIdentity ?? (() => undefined);
    this.runtimeStatus = opts.runtimeStatus ?? (() => undefined);
    this.persistConnectionDisabledAppId =
      opts.persistConnectionDisabledAppId;
    this.disableRuntime = opts.disableRuntime;
  }

  async snapshot(): Promise<FeishuIntegrationSnapshot> {
    const [bot, capability, chats] = await Promise.all([
      this.larkSetup.status(),
      this.larkSetup.fullGroupMessageCapability?.() ?? Promise.resolve("unknown" as const),
      this.larkSetup.listBotChats
        ? this.larkSetup.listBotChats().catch(() => [])
        : Promise.resolve([]),
    ]);
    const activeIdentity = this.activeIdentity();
    const runtime = this.runtimeStatus();
    const chatsById = new Map(chats.map((chat) => [chat.chatId, chat]));
    const groups = this.engine.feishuBindings.list().map((binding) => {
      const state: FeishuGroupBindingState =
        (binding.state === "active" || binding.state === "pending_confirmation")
          && bot.appId
          && binding.boundAppId !== bot.appId
          ? "needs_reconnect"
          : binding.state;
      return {
        binding,
        space: this.engine.registry.get(binding.spaceId),
        chat: chatsById.get(binding.chatId),
        state,
        degraded: binding.responseMode !== "mentions_only"
          && capability !== "available",
      };
    });
    return {
      bot,
      ...(activeIdentity ? { activeIdentity } : {}),
      ...(runtime ? { runtime } : {}),
      capability,
      restartRequired: bot.state === "ready"
        && (!activeIdentity
          || activeIdentity.botOpenId !== bot.botOpenId),
      groups,
      agents: this.engine.agents.list().filter(
        (agent) => agent.visibility === "Team",
      ),
    };
  }

  async listConnectionCandidates(): Promise<LarkChatSummary[]> {
    const status = await this.larkSetup.status();
    if (status.state !== "ready" || !status.verified || !status.appId) {
      throw new FeishuIntegrationError(
        "bot_not_ready",
        "Feishu Bot is not ready",
      );
    }
    if (!this.larkSetup.listBotChats) {
      throw new FeishuIntegrationError(
        "bot_not_ready",
        "Feishu group discovery is unavailable",
      );
    }
    const chats = await this.larkSetup.listBotChats();
    return chats.filter((chat) => {
      const binding = this.engine.feishuBindings.getByChatId(chat.chatId);
      return !binding
        || (
          binding.boundAppId !== status.appId
          || (
            binding.state !== "active"
            && binding.state !== "pending_confirmation"
          )
        );
    });
  }

  async requestGroupConfirmation(
    input: RequestFeishuGroupConfirmationInput,
  ): Promise<void> {
    const chatId = input.chatId.trim();
    if (!chatId) {
      throw new FeishuIntegrationError("invalid_input", "Invalid group");
    }
    const status = await this.larkSetup.status();
    if (status.state !== "ready" || !status.verified || !status.appId) {
      throw new FeishuIntegrationError(
        "bot_not_ready",
        "Feishu Bot is not ready",
      );
    }
    const chat = await this.larkSetup.getBotChat?.(chatId);
    if (!chat || chat.chatId !== chatId) {
      throw new FeishuIntegrationError(
        "chat_not_visible",
        "The Bot cannot access this group",
      );
    }
    const spaceId = teamSpace(chatId);
    const binding = this.engine.feishuBindings.requestConfirmation({
      chatId,
      spaceId,
      boundAppId: status.appId,
    });
    if (binding.state === "active") return;
    await this.deliverConfirmationPrompt(chatId);
  }

  async resendGroupConfirmation(spaceId: SpaceId): Promise<void> {
    const binding = this.engine.feishuBindings.getBySpace(spaceId);
    if (!binding || binding.state !== "pending_confirmation") {
      throw new FeishuIntegrationError(
        "binding_not_found",
        "Pending Feishu group binding was not found",
      );
    }
    const status = await this.larkSetup.status();
    if (
      status.state !== "ready"
      || !status.verified
      || !status.appId
      || binding.boundAppId !== status.appId
    ) {
      throw new FeishuIntegrationError(
        "bot_not_ready",
        "Feishu Bot is not ready",
      );
    }
    const chat = await this.larkSetup.getBotChat?.(binding.chatId);
    if (!chat || chat.chatId !== binding.chatId) {
      throw new FeishuIntegrationError(
        "chat_not_visible",
        "The Bot cannot access this group",
      );
    }
    await this.deliverConfirmationPrompt(binding.chatId);
  }

  async updateGroup(input: UpdateFeishuGroupInput): Promise<void> {
    const binding = this.engine.feishuBindings.getBySpace(input.spaceId);
    if (!binding) {
      throw new FeishuIntegrationError(
        "binding_not_found",
        "Feishu group binding was not found",
      );
    }
    validatePolicy(input);
    const name = input.name?.trim() ?? "";
    if (name.length > 100) {
      throw new FeishuIntegrationError("invalid_input", "Group name is too long");
    }
    const agentId = input.agentId?.trim() || undefined;
    if (agentId) {
      const agent = this.engine.agents.get(agentId);
      if (!agent || !agentVisibleInSpace(agent, input.spaceId)) {
        throw new FeishuIntegrationError(
          "invalid_input",
          "Agent is not available for this group",
        );
      }
    }
    if (
      input.responseMode !== "mentions_only"
      && input.responseMode !== binding.responseMode
    ) {
      await this.requireFullGroupMessageCapability();
    }
    const participationLevel = normalizedParticipation(input);
    this.engine.feishuBindings.updatePolicy(input.spaceId, {
      responseMode: input.responseMode,
      participationLevel,
      replyInThread: input.replyInThread,
    });
    this.engine.updateSpaceMeta(input.spaceId, {
      name,
      agentId: agentId ?? "",
    });
  }

  async disconnectGroup(spaceId: SpaceId): Promise<void> {
    const binding = this.engine.feishuBindings.disconnect(spaceId);
    if (!binding) {
      throw new FeishuIntegrationError(
        "binding_not_found",
        "Feishu group binding was not found",
      );
    }
  }

  async testGroup(spaceId: SpaceId): Promise<void> {
    const binding = this.engine.feishuBindings.getBySpace(spaceId);
    if (!binding) {
      throw new FeishuIntegrationError(
        "binding_not_found",
        "Feishu group binding was not found",
      );
    }
    try {
      const status = await this.larkSetup.status();
      if (
        status.state !== "ready"
        || !status.verified
        || !status.appId
        || binding.state !== "active"
        || binding.boundAppId !== status.appId
      ) {
        throw new Error("Bot or binding is not active");
      }
      const chat = await this.larkSetup.getBotChat?.(binding.chatId);
      if (!chat || chat.chatId !== binding.chatId || !this.sendTestMessage) {
        throw new Error("Group is no longer visible");
      }
      await this.sendTestMessage(
        binding.chatId,
        "✅ HomeAgent 飞书群连接测试成功。",
      );
      this.engine.feishuBindings.recordTest(spaceId, {
        status: "succeeded",
      });
    } catch {
      this.engine.feishuBindings.recordTest(spaceId, {
        status: "failed",
        error: "Connection test failed",
      });
      throw new FeishuIntegrationError(
        "test_failed",
        "Feishu group connection test failed",
      );
    }
  }

  async disconnectBot(): Promise<void> {
    const status = await this.larkSetup.status();
    if (status.state !== "ready" || !status.appId) {
      throw new FeishuIntegrationError(
        "bot_not_ready",
        "Feishu Bot is not configured",
      );
    }
    if (!this.persistConnectionDisabledAppId || !this.disableRuntime) {
      throw new FeishuIntegrationError(
        "operation_unavailable",
        "Runtime disconnect is unavailable",
      );
    }
    await this.persistConnectionDisabledAppId(status.appId);
    try {
      this.engine.feishuBindings.markAppNeedsReconnect(status.appId);
    } finally {
      await this.disableRuntime();
    }
  }

  private async requireFullGroupMessageCapability(): Promise<void> {
    const capability =
      await this.larkSetup.fullGroupMessageCapability?.() ?? "unknown";
    if (capability !== "available") {
      throw new FeishuIntegrationError(
        "capability_required",
        "Full group-message permission is required",
      );
    }
  }

  private async deliverConfirmationPrompt(chatId: string): Promise<void> {
    const attemptedAt = Date.now();
    this.engine.feishuBindings.recordConfirmationPrompt(chatId, {
      status: "attempting",
      at: attemptedAt,
    });
    try {
      if (!this.sendConfirmationPrompt) {
        throw new Error("Confirmation prompt delivery is unavailable");
      }
      await this.sendConfirmationPrompt(chatId);
      this.engine.feishuBindings.recordConfirmationPrompt(chatId, {
        status: "sent",
        at: attemptedAt,
      });
    } catch {
      this.engine.feishuBindings.recordConfirmationPrompt(chatId, {
        status: "failed",
        at: attemptedAt,
        error: "Confirmation prompt delivery failed",
      });
      throw new FeishuIntegrationError(
        "prompt_failed",
        "Feishu confirmation prompt delivery failed",
      );
    }
  }
}

function normalizedParticipation(
  input: Pick<
    UpdateFeishuGroupInput,
    "responseMode" | "participationLevel"
  >,
): GroupParticipationLevel | undefined {
  if (input.responseMode !== "smart") return undefined;
  return input.participationLevel ?? "balanced";
}

const RESPONSE_MODES: FeishuResponseMode[] = [
  "mentions_only",
  "smart",
  "all_messages",
];
const PARTICIPATION_LEVELS: GroupParticipationLevel[] = [
  "reserved",
  "balanced",
  "active",
];

function validatePolicy(
  input: Pick<
    UpdateFeishuGroupInput,
    "responseMode" | "participationLevel" | "replyInThread"
  >,
): void {
  if (
    !RESPONSE_MODES.includes(input.responseMode)
    || (input.participationLevel !== undefined
      && !PARTICIPATION_LEVELS.includes(input.participationLevel))
    || typeof input.replyInThread !== "boolean"
  ) {
    throw new FeishuIntegrationError(
      "invalid_input",
      "Invalid Feishu response policy",
    );
  }
}
