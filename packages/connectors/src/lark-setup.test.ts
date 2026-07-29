import { describe, expect, test } from "bun:test";
import {
  LarkCliSetup,
  type LarkSetupCommand,
  type LarkSetupCommandRunner,
} from "./lark-setup.ts";
import type {
  LarkAppRegistrar,
  LarkAppRegistrationResult,
} from "./lark-app-registration.ts";

async function waitForProvisioningState(
  setup: LarkCliSetup,
  state: ReturnType<LarkCliSetup["provisioningStatus"]>["state"],
): Promise<ReturnType<LarkCliSetup["provisioningStatus"]>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const session = setup.provisioningStatus();
    if (session.state === state) return session;
    await Bun.sleep(1);
  }
  throw new Error(`Provisioning did not reach ${state}`);
}

async function waitForProvisioningUrl(
  setup: LarkCliSetup,
  url: string,
): Promise<ReturnType<LarkCliSetup["provisioningStatus"]>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const session = setup.provisioningStatus();
    if (session.verificationUrl === url) return session;
    await Bun.sleep(1);
  }
  throw new Error(`Provisioning did not expose ${url}`);
}

describe("LarkCliSetup", () => {
  test("lists Bot-visible chats with only safe public fields", async () => {
    const calls: LarkSetupCommand[] = [];
    const setup = new LarkCliSetup({
      runner: {
        async run(command) {
          calls.push(command);
          return {
            code: 0,
            stdout: JSON.stringify({
              data: {
                chats: [{
                  chat_id: "oc_product",
                  name: "Product",
                  description: "Planning",
                  external: false,
                  owner_id: "ou_owner",
                  tenant_key: "private",
                }],
                has_more: false,
                _notice: { update_available: true },
              },
            }),
            stderr: "",
          };
        },
      },
    });

    expect(await setup.listBotChats()).toEqual([{
      chatId: "oc_product",
      name: "Product",
      description: "Planning",
      external: false,
      ownerId: "ou_owner",
    }]);
    expect(calls).toEqual([{
      argv: [
        "lark-cli",
        "im",
        "+chat-list",
        "--as",
        "bot",
        "--page-size",
        "100",
        "--json",
      ],
      timeoutMs: 15_000,
    }]);
  });

  test("paginates Bot chats and normalizes null chats to an empty page", async () => {
    const calls: LarkSetupCommand[] = [];
    const responses = [
      {
        code: 0,
        stdout: JSON.stringify({
          data: {
            chats: [{ chat_id: "oc_z", name: "Zulu" }],
            has_more: true,
            page_token: "next-page",
          },
        }),
        stderr: "",
      },
      {
        code: 0,
        stdout: JSON.stringify({
          data: { chats: null, has_more: false },
        }),
        stderr: "",
      },
    ];
    const setup = new LarkCliSetup({
      runner: {
        async run(command) {
          calls.push(command);
          return responses.shift()!;
        },
      },
    });

    expect(await setup.listBotChats()).toEqual([
      { chatId: "oc_z", name: "Zulu" },
    ]);
    expect(calls[1]?.argv).toEqual([
      "lark-cli",
      "im",
      "+chat-list",
      "--as",
      "bot",
      "--page-size",
      "100",
      "--page-token",
      "next-page",
      "--json",
    ]);
  });

  test("gets one Bot chat for membership verification", async () => {
    const calls: LarkSetupCommand[] = [];
    const setup = new LarkCliSetup({
      runner: {
        async run(command) {
          calls.push(command);
          return {
            code: 0,
            stdout: JSON.stringify({
              data: {
                chat_id: "oc_product",
                name: "Product",
                external: true,
                tenant_key: "private",
              },
            }),
            stderr: "",
          };
        },
      },
    });

    expect(await setup.getBotChat(" oc_product ")).toEqual({
      chatId: "oc_product",
      name: "Product",
      external: true,
    });
    expect(calls).toEqual([{
      argv: [
        "lark-cli",
        "im",
        "chats",
        "get",
        "--chat-id",
        "oc_product",
        "--as",
        "bot",
        "--json",
      ],
      timeoutMs: 15_000,
    }]);
  });

  test("checks full group-message capability through structured auth output", async () => {
    const calls: LarkSetupCommand[] = [];
    const setup = new LarkCliSetup({
      runner: {
        async run(command) {
          calls.push(command);
          return {
            code: 0,
            stdout: JSON.stringify({
              ok: true,
              granted: ["im:message.group_msg"],
              missing: [],
              _notice: { latest_version: "private" },
            }),
            stderr: "",
          };
        },
      },
    });

    expect(await setup.fullGroupMessageCapability()).toBe("available");
    expect(calls).toEqual([{
      argv: [
        "lark-cli",
        "auth",
        "check",
        "--scope",
        "im:message.group_msg",
        "--json",
      ],
      timeoutMs: 15_000,
    }]);
  });

  test("maps missing capability conservatively and treats ambiguity as unknown", async () => {
    const unavailable = new LarkCliSetup({
      runner: {
        async run() {
          return {
            code: 1,
            stdout: JSON.stringify({
              missing: ["im:message.group_msg"],
              suggestion: "private repair diagnostic",
            }),
            stderr: "private",
          };
        },
      },
    });
    const malformed = new LarkCliSetup({
      runner: {
        async run() {
          return { code: 124, stdout: "not-json", stderr: "private timeout" };
        },
      },
    });
    const ambiguous = new LarkCliSetup({
      runner: {
        async run() {
          return { code: 0, stdout: JSON.stringify({ ok: true }), stderr: "" };
        },
      },
    });

    expect(await unavailable.fullGroupMessageCapability()).toBe("unavailable");
    expect(await malformed.fullGroupMessageCapability()).toBe("unknown");
    expect(await ambiguous.fullGroupMessageCapability()).toBe("unknown");
  });

  test("rejects repeated pagination tokens and conflicting duplicate chats safely", async () => {
    let page = 0;
    const repeated = new LarkCliSetup({
      runner: {
        async run() {
          page += 1;
          return {
            code: 0,
            stdout: JSON.stringify({
              chats: [],
              has_more: true,
              page_token: "repeated",
            }),
            stderr: "",
          };
        },
      },
    });
    const duplicate = new LarkCliSetup({
      runner: {
        async run() {
          return {
            code: 0,
            stdout: JSON.stringify({
              chats: [
                { chat_id: "oc_same", name: "First" },
                {
                  chat_id: "oc_same",
                  name: "Second",
                  secret: "private-diagnostic",
                },
              ],
              has_more: false,
            }),
            stderr: "",
          };
        },
      },
    });

    await expect(repeated.listBotChats()).rejects.toThrow(
      "Unable to list Feishu groups",
    );
    expect(page).toBe(2);
    let duplicateError = "";
    try {
      await duplicate.listBotChats();
    } catch (error) {
      duplicateError = String(error);
    }
    expect(duplicateError).toContain("Unable to list Feishu groups");
    expect(duplicateError).not.toContain("private-diagnostic");
  });

  test("detects external chats through the read-only bot API", async () => {
    const calls: LarkSetupCommand[] = [];
    const setup = new LarkCliSetup({
      runner: {
        async run(command) {
          calls.push(command);
          return {
            code: 0,
            stdout: JSON.stringify({ ok: true, data: { external: true } }),
            stderr: "",
          };
        },
      },
    });

    expect(await setup.chatIsExternal(" oc_external ")).toBeTrue();
    expect(calls).toEqual([{
      argv: [
        "lark-cli",
        "im",
        "chats",
        "get",
        "--chat-id",
        "oc_external",
        "--as",
        "bot",
        "--json",
      ],
      timeoutMs: 15_000,
    }]);
  });

  test("fails closed when external chat status cannot be trusted", async () => {
    let calls = 0;
    const setup = new LarkCliSetup({
      runner: {
        async run() {
          calls += 1;
          return { code: 1, stdout: "not-json", stderr: "private diagnostic" };
        },
      },
    });

    expect(await setup.chatIsExternal("oc_unknown")).toBeFalse();
    expect(await setup.chatIsExternal("  ")).toBeFalse();
    expect(calls).toBe(1);
  });

  test("creates through the official SDK and hands credentials to lark-cli through stdin", async () => {
    const secret = "sdk-secret-never-rendered";
    let resolveRegistration!: (result: LarkAppRegistrationResult) => void;
    const registration = new Promise<LarkAppRegistrationResult>((resolve) => {
      resolveRegistration = resolve;
    });
    let registrationSignal: AbortSignal | undefined;
    const registrar: LarkAppRegistrar = {
      register(input) {
        registrationSignal = input.signal;
        input.onVerificationUrl({
          url: "https://open.feishu.cn/page/launcher?user_code=SDK-SAFE",
          expiresInSeconds: 600,
        });
        return registration;
      },
    };
    const calls: LarkSetupCommand[] = [];
    const runner: LarkSetupCommandRunner = {
      async run(command) {
        calls.push(command);
        if (command.argv.includes("config")) {
          return { code: 0, stdout: "configured", stderr: "" };
        }
        if (command.argv.includes("event")) {
          return { code: 0, stdout: "", stderr: "reason: timeout" };
        }
        return {
          code: 0,
          stdout: JSON.stringify({
            appId: "cli_sdk",
            brand: "feishu",
            identities: {
              bot: {
                status: "ready",
                available: true,
                verified: true,
                openId: "ou_sdk",
                appName: "HomeAgent",
              },
            },
          }),
          stderr: "",
        };
      },
    };
    const setup = new LarkCliSetup({ runner, registrar });

    const waiting = await setup.startAutomatic("feishu");
    const duplicate = await setup.startAutomatic("feishu");

    expect(waiting.state).toBe("waiting_for_user");
    expect(waiting.verificationUrl).toBe(
      "https://open.feishu.cn/page/launcher?user_code=SDK-SAFE",
    );
    expect(duplicate.startedAt).toBe(waiting.startedAt);
    expect(registrationSignal?.aborted).toBeFalse();

    resolveRegistration({
      appId: "cli_sdk",
      appSecret: secret,
      brand: "feishu",
    });

    const ready = await waitForProvisioningState(setup, "ready");
    expect(calls[0]).toEqual({
      argv: [
        "lark-cli",
        "config",
        "init",
        "--app-id",
        "cli_sdk",
        "--app-secret-stdin",
        "--brand",
        "feishu",
      ],
      stdin: `${secret}\n`,
      timeoutMs: 30_000,
    });
    expect(calls[0]?.argv.join(" ")).not.toContain(secret);
    expect(calls.slice(2).map((call) => call.argv)).toEqual([
      [
        "lark-cli",
        "event",
        "consume",
        "im.message.receive_v1",
        "--as",
        "bot",
        "--timeout",
        "1s",
      ],
      [
        "lark-cli",
        "event",
        "consume",
        "im.chat.member.bot.added_v1",
        "--as",
        "bot",
        "--timeout",
        "1s",
      ],
    ]);
    expect(ready.message).toBe("飞书机器人已连接");
    expect(JSON.stringify(ready)).not.toContain(secret);
  });

  test("keeps creation active on the official repair page until missing events are authorized", async () => {
    const rawDiagnostic = "private-cli-diagnostic-must-not-render";
    const repairUrl = "https://open.feishu.cn/page/launcher?clientID=cli_sdk&addons=SAFE";
    let resolveRegistration!: (result: LarkAppRegistrationResult) => void;
    const registration = new Promise<LarkAppRegistrationResult>((resolve) => {
      resolveRegistration = resolve;
    });
    const registrar: LarkAppRegistrar = {
      register(input) {
        input.onVerificationUrl({
          url: "https://open.feishu.cn/page/launcher?user_code=CREATE",
          expiresInSeconds: 600,
        });
        return registration;
      },
    };
    let botAddedAttempts = 0;
    let resolveRepairedProbe!: (result: {
      code: number;
      stdout: string;
      stderr: string;
    }) => void;
    const repairedProbe = new Promise<{
      code: number;
      stdout: string;
      stderr: string;
    }>((resolve) => {
      resolveRepairedProbe = resolve;
    });
    const runner: LarkSetupCommandRunner = {
      async run(command) {
        if (command.argv.includes("config")) {
          return { code: 0, stdout: "configured", stderr: "" };
        }
        if (command.argv.includes("auth")) {
          return {
            code: 0,
            stdout: JSON.stringify({
              appId: "cli_sdk",
              brand: "feishu",
              identities: {
                bot: {
                  status: "ready",
                  available: true,
                  verified: true,
                  openId: "ou_sdk",
                  appName: "HomeAgent",
                },
              },
            }),
            stderr: "",
          };
        }
        if (command.argv.includes("im.message.receive_v1")) {
          return { code: 0, stdout: "", stderr: "reason: timeout" };
        }
        botAddedAttempts += 1;
        if (botAddedAttempts === 1) {
          return {
            code: 2,
            stdout: "",
            stderr: `${rawDiagnostic}\n{\"hint\":\"subscribe by scanning: ${repairUrl}\"}`,
          };
        }
        return repairedProbe;
      },
    };
    const setup = new LarkCliSetup({
      runner,
      registrar,
      eventVerificationPollMs: 1,
    });

    await setup.startAutomatic("feishu");
    resolveRegistration({
      appId: "cli_sdk",
      appSecret: "secret",
      brand: "feishu",
    });

    const repair = await waitForProvisioningUrl(setup, repairUrl);
    expect(repair.state).toBe("waiting_for_user");
    expect(repair.message).toBe("请在飞书确认完整权限和事件订阅");
    expect(JSON.stringify(repair)).not.toContain(rawDiagnostic);

    resolveRepairedProbe({ code: 0, stdout: "", stderr: "reason: timeout" });
    const ready = await waitForProvisioningState(setup, "ready");
    expect(ready.message).toBe("飞书机器人已连接");
    expect(botAddedAttempts).toBe(2);
  });

  test("rejects an untrusted SDK verification URL without exposing it", async () => {
    const untrustedUrl = "https://attacker.example/page/launcher?token=private";
    let aborted = false;
    const registrar: LarkAppRegistrar = {
      register(input) {
        input.signal.addEventListener("abort", () => {
          aborted = true;
        });
        input.onVerificationUrl({ url: untrustedUrl, expiresInSeconds: 600 });
        return new Promise<LarkAppRegistrationResult>(() => {});
      },
    };
    const setup = new LarkCliSetup({ registrar, urlWaitMs: 1 });

    const session = await setup.startAutomatic("feishu");

    expect(session.state).toBe("failed");
    expect(session.verificationUrl).toBeUndefined();
    expect(JSON.stringify(session)).not.toContain("attacker.example");
    expect(aborted).toBeTrue();
  });

  test("maps an expired SDK authorization to a safe expired session", async () => {
    const secretDiagnostic = "expired-device-code-must-not-render";
    const registrar: LarkAppRegistrar = {
      async register(input) {
        input.onVerificationUrl({
          url: "https://open.feishu.cn/page/launcher?user_code=EXPIRE",
          expiresInSeconds: 600,
        });
        throw { code: "expired_token", description: secretDiagnostic };
      },
    };
    const setup = new LarkCliSetup({ registrar });

    await setup.startAutomatic("feishu");
    const session = await waitForProvisioningState(setup, "expired");

    expect(session.message).toBe("飞书应用创建已过期，请重试");
    expect(JSON.stringify(session)).not.toContain(secretDiagnostic);
  });

  test("expires and aborts an SDK registration that outlives the session", async () => {
    let aborted = false;
    const registrar: LarkAppRegistrar = {
      register(input) {
        input.signal.addEventListener("abort", () => {
          aborted = true;
        });
        input.onVerificationUrl({
          url: "https://open.feishu.cn/page/launcher?user_code=WAIT",
          expiresInSeconds: 600,
        });
        return new Promise<LarkAppRegistrationResult>(() => {});
      },
    };
    const setup = new LarkCliSetup({ registrar, provisioningTtlMs: 5 });

    const waiting = await setup.startAutomatic("feishu");
    expect(waiting.state).toBe("waiting_for_user");
    const expired = await waitForProvisioningState(setup, "expired");

    expect(expired.message).toBe("飞书应用创建已过期，请重试");
    expect(aborted).toBeTrue();
  });

  test("maps SDK startup failures to the fixed public error", async () => {
    const secret = "private-sdk-detail";
    const registrar: LarkAppRegistrar = {
      async register() {
        throw new Error(`registration failed: ${secret}`);
      },
    };
    const setup = new LarkCliSetup({ registrar });

    const session = await setup.startAutomatic("feishu");

    expect(session.state).toBe("failed");
    expect(session.message).toBe("飞书应用创建未完成，请重试");
    expect(JSON.stringify(session)).not.toContain(secret);
  });

  test("configures through stdin and returns the verified bot identity", async () => {
    const calls: LarkSetupCommand[] = [];
    const responses = [
      { code: 0, stdout: "configuration saved", stderr: "" },
      {
        code: 0,
        stdout: JSON.stringify({
          appId: "cli_new",
          brand: "feishu",
          verified: true,
          identities: {
            bot: {
              status: "ready",
              available: true,
              verified: true,
              openId: "ou_new",
              appName: "新机器人",
              message: "Bot identity: ready",
            },
          },
        }),
        stderr: "",
      },
    ];
    const runner: LarkSetupCommandRunner = {
      run: async (command) => {
        calls.push(command);
        return responses.shift()!;
      },
    };
    const setup = new LarkCliSetup({ runner });

    const status = await setup.configure({
      appId: "cli_new",
      appSecret: "top-secret-value",
      brand: "feishu",
    });

    expect(calls[0]?.argv).toEqual([
      "lark-cli",
      "config",
      "init",
      "--app-id",
      "cli_new",
      "--app-secret-stdin",
      "--brand",
      "feishu",
    ]);
    expect(calls[0]?.stdin).toBe("top-secret-value\n");
    expect(calls[0]?.argv.join(" ")).not.toContain("top-secret-value");
    expect(calls[1]?.argv).toEqual([
      "lark-cli",
      "auth",
      "status",
      "--json",
      "--verify",
    ]);
    expect(status).toEqual({
      state: "ready",
      verified: true,
      appId: "cli_new",
      brand: "feishu",
      botName: "新机器人",
      botOpenId: "ou_new",
      message: "Bot identity: ready",
    });
  });

  test("configuration failures never include the App Secret in the surfaced error", async () => {
    const secret = "never-render-this-secret";
    const runner: LarkSetupCommandRunner = {
      run: async () => ({
        code: 1,
        stdout: "",
        stderr: `invalid credential: ${secret}`,
      }),
    };
    const setup = new LarkCliSetup({ runner });

    let message = "";
    try {
      await setup.configure({ appId: "cli_bad", appSecret: secret, brand: "feishu" });
    } catch (error) {
      message = String(error);
    }

    expect(message).toContain("configuration failed");
    expect(message).not.toContain(secret);
  });
});
