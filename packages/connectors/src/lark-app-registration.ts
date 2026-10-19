import {
  registerApp,
  type AppAddons,
} from "@larksuiteoapi/node-sdk";

/**
 * Additive permissions used by HomeAgent's current Feishu runtime.
 *
 * Keep this list aligned with FeishuConnector commands. The sensitive
 * im:message.group_msg scope is required for resolving quoted group messages
 * and downloading group-message attachments, as well as activity-level
 * participation in messages that do not mention the bot.
 */
export const HOMEAGENT_FEISHU_ADDONS: AppAddons = {
  preset: true,
  scopes: {
    tenant: [
      "application:bot.basic_info:read",
      "im:chat.members:bot_access",
      "im:chat:read",
      "im:message.group_at_msg.include_bot:readonly",
      "im:message.group_at_msg:readonly",
      "im:message.group_msg",
      "im:message.p2p_msg:readonly",
      "im:message.reactions:write_only",
      "im:message:readonly",
      "im:message:send_as_bot",
      "im:resource",
      "drive:drive.metadata:readonly",
      "docx:document:readonly",
      "wiki:node:read",
    ],
    user: ["offline_access"],
  },
  events: {
    items: {
      tenant: ["im.message.receive_v1", "im.chat.member.bot.added_v1"],
    },
  },
  callbacks: { items: ["card.action.trigger"] },
};

export interface LarkAppRegistrationInput {
  brand: "feishu" | "lark";
  signal: AbortSignal;
  onVerificationUrl(info: { url: string; expiresInSeconds: number }): void;
}

export interface LarkAppRegistrationResult {
  appId: string;
  appSecret: string;
  brand: "feishu" | "lark";
}

export interface LarkAppRegistrar {
  register(input: LarkAppRegistrationInput): Promise<LarkAppRegistrationResult>;
}

export function createLarkAppRegistrar(
  register: typeof registerApp = registerApp,
): LarkAppRegistrar {
  return {
    async register(input): Promise<LarkAppRegistrationResult> {
      const result = await register({
        domain: "accounts.feishu.cn",
        larkDomain: "accounts.larksuite.com",
        source: "homeagent",
        signal: input.signal,
        createOnly: true,
        appPreset: {
          name: "HomeAgent",
          desc: "把飞书群聊沉淀为可检索、可复用的团队知识",
        },
        addons: HOMEAGENT_FEISHU_ADDONS,
        onQRCodeReady(info) {
          input.onVerificationUrl({
            url: info.url,
            expiresInSeconds: info.expireIn,
          });
        },
      });
      const resultBrand = result.user_info?.tenant_brand;
      return {
        appId: result.client_id,
        appSecret: result.client_secret,
        brand: resultBrand === "feishu" || resultBrand === "lark"
          ? resultBrand
          : input.brand,
      };
    },
  };
}

export const sdkLarkAppRegistrar = createLarkAppRegistrar();
