import { describe, expect, test } from "bun:test";
import {
  HOMEAGENT_FEISHU_ADDONS,
  createLarkAppRegistrar,
} from "./lark-app-registration.ts";

describe("HomeAgent Feishu app registration", () => {
  test("requests every runtime permission, message event and approval callback during initial creation", () => {
    expect(HOMEAGENT_FEISHU_ADDONS).toEqual({
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
    });
  });

  test("creates a new app with explicit addons and keeps credentials off the URL callback", async () => {
    const secret = "sdk-secret-must-stay-internal";
    let captured: Record<string, unknown> | undefined;
    const verificationPayloads: Array<{ url: string; expiresInSeconds: number }> = [];
    const fakeRegisterApp = async (options: Record<string, unknown>) => {
      captured = options;
      const onQRCodeReady = options.onQRCodeReady as (info: {
        url: string;
        expireIn: number;
      }) => void;
      onQRCodeReady({
        url: "https://open.feishu.cn/page/launcher?user_code=SAFE",
        expireIn: 600,
      });
      return {
        client_id: "cli_created",
        client_secret: secret,
        user_info: { tenant_brand: "feishu" as const },
      };
    };
    const registrar = createLarkAppRegistrar(fakeRegisterApp as never);
    const controller = new AbortController();

    const result = await registrar.register({
      brand: "feishu",
      signal: controller.signal,
      onVerificationUrl: (info) => verificationPayloads.push(info),
    });

    expect(captured).toMatchObject({
      domain: "accounts.feishu.cn",
      larkDomain: "accounts.larksuite.com",
      source: "homeagent",
      signal: controller.signal,
      createOnly: true,
      addons: HOMEAGENT_FEISHU_ADDONS,
      appPreset: {
        name: "HomeAgent",
        desc: "把飞书群聊沉淀为可检索、可复用的团队知识",
      },
    });
    expect(verificationPayloads).toEqual([
      {
        url: "https://open.feishu.cn/page/launcher?user_code=SAFE",
        expiresInSeconds: 600,
      },
    ]);
    expect(JSON.stringify(verificationPayloads)).not.toContain(secret);
    expect(result).toEqual({
      appId: "cli_created",
      appSecret: secret,
      brand: "feishu",
    });
  });

  test("uses the requested brand when the registration result omits tenant brand", async () => {
    const registrar = createLarkAppRegistrar((async (options: Record<string, unknown>) => {
      const onQRCodeReady = options.onQRCodeReady as (info: {
        url: string;
        expireIn: number;
      }) => void;
      onQRCodeReady({
        url: "https://open.larksuite.com/page/launcher?user_code=SAFE",
        expireIn: 600,
      });
      return { client_id: "cli_lark", client_secret: "secret" };
    }) as never);

    const result = await registrar.register({
      brand: "lark",
      signal: new AbortController().signal,
      onVerificationUrl: () => {},
    });

    expect(result.brand).toBe("lark");
  });
});
