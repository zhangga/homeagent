/**
 * Bounded lark-cli application setup for the local management UI.
 *
 * App Secret is deliberately absent from argv and is sent only over stdin to
 * `config init --app-secret-stdin`. This module does not persist credentials;
 * lark-cli owns its application profile and token storage.
 */
import type {
  LarkCapabilityState,
  LarkChatSummary,
  LarkProvisioningSession,
  LarkSetupInput,
  LarkSetupStatus,
} from "@homeagent/shared";
import { runFeishuCommandResult } from "./feishu.ts";
import {
  sdkLarkAppRegistrar,
  type LarkAppRegistrar,
} from "./lark-app-registration.ts";

export interface LarkSetupCommand {
  argv: string[];
  stdin?: string;
  timeoutMs: number;
}

export interface LarkSetupCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface LarkSetupCommandRunner {
  run(command: LarkSetupCommand): Promise<LarkSetupCommandResult>;
}

export interface LarkCliSetupOptions {
  larkBin?: string;
  runner?: LarkSetupCommandRunner;
  registrar?: LarkAppRegistrar;
  urlWaitMs?: number;
  provisioningTtlMs?: number;
  eventVerificationPollMs?: number;
}

const NO_NOTIFIER_ENV = {
  LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
  LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
};
const MAX_SETUP_DIAGNOSTIC_BYTES = 64 * 1_024;

const VERIFICATION_URL =
  /https:\/\/(?:open\.feishu\.cn|open\.larksuite\.com)\/page\/(?:cli|launcher)\?[^\s<>'"]+/;
const URL_WAIT_MS = 15_000;
const PROVISIONING_TTL_MS = 10 * 60_000;
const FAILED_MESSAGE = "飞书应用创建未完成，请重试";
const EXPIRED_MESSAGE = "飞书应用创建已过期，请重试";
const INCOMPLETE_AUTHORIZATION_MESSAGE = "飞书授权未完整生效，请在当前创建流程中补齐";
const REQUIRED_EVENT_KEYS = [
  "im.message.receive_v1",
  "im.chat.member.bot.added_v1",
] as const;

export const bunLarkSetupRunner: LarkSetupCommandRunner = {
  async run(command): Promise<LarkSetupCommandResult> {
    try {
      return await runFeishuCommandResult(command.argv, {
        stdin: command.stdin,
        env: NO_NOTIFIER_ENV,
        timeoutMs: command.timeoutMs,
        terminationGraceMs: 250,
        maxCapturedBytes: MAX_SETUP_DIAGNOSTIC_BYTES,
      });
    } catch (error) {
      const stderr = String(error);
      return {
        code: stderr.includes("timed out") ? 124 : 1,
        stdout: "",
        stderr,
      };
    }
  },
};

export class LarkCliSetup {
  private readonly larkBin: string;
  private readonly runner: LarkSetupCommandRunner;
  private readonly registrar: LarkAppRegistrar;
  private readonly urlWaitMs: number;
  private readonly provisioningTtlMs: number;
  private readonly eventVerificationPollMs: number;
  private provisioningGeneration = 0;
  private provisioningAbort?: AbortController;
  private provisioning: LarkProvisioningSession = {
    state: "idle",
    brand: "feishu",
    message: "尚未开始创建飞书应用",
  };

  constructor(opts: LarkCliSetupOptions = {}) {
    this.larkBin = opts.larkBin ?? "lark-cli";
    this.runner = opts.runner ?? bunLarkSetupRunner;
    this.registrar = opts.registrar ?? sdkLarkAppRegistrar;
    this.urlWaitMs = opts.urlWaitMs ?? URL_WAIT_MS;
    this.provisioningTtlMs = opts.provisioningTtlMs ?? PROVISIONING_TTL_MS;
    this.eventVerificationPollMs = opts.eventVerificationPollMs ?? 3_000;
  }

  async startAutomatic(brand: "feishu" | "lark"): Promise<LarkProvisioningSession> {
    if (
      this.provisioning.state === "starting" ||
      this.provisioning.state === "waiting_for_user" ||
      this.provisioning.state === "verifying"
    ) {
      return this.provisioningStatus();
    }

    const generation = ++this.provisioningGeneration;
    this.provisioningAbort?.abort();

    const controller = new AbortController();
    this.provisioningAbort = controller;
    const startedAt = Date.now();
    this.provisioning = {
      state: "starting",
      brand,
      startedAt,
      expiresAt: startedAt + this.provisioningTtlMs,
      message: "正在启动飞书应用创建",
    };

    let resolveUrl!: () => void;
    const urlReady = new Promise<void>((resolve) => {
      resolveUrl = resolve;
    });
    const ttlTimer = setTimeout(() => {
      if (
        this.provisioningGeneration === generation &&
        (this.provisioning.state === "starting" ||
          this.provisioning.state === "waiting_for_user" ||
          this.provisioning.state === "verifying")
      ) {
        this.provisioning = {
          ...this.provisioning,
          state: "expired",
          message: EXPIRED_MESSAGE,
        };
        controller.abort();
      }
    }, this.provisioningTtlMs);
    (ttlTimer as unknown as { unref?: () => void }).unref?.();

    const handledRegistration = this.registrar.register({
      brand,
      signal: controller.signal,
      onVerificationUrl: ({ url, expiresInSeconds }) => {
        const verificationUrl = exactVerificationUrl(url);
        if (
          !verificationUrl ||
          this.provisioningGeneration !== generation ||
          this.provisioning.state !== "starting"
        ) {
          return;
        }
        this.provisioning = {
          ...this.provisioning,
          state: "waiting_for_user",
          verificationUrl,
          expiresAt: Math.min(
            this.provisioning.expiresAt ?? Number.POSITIVE_INFINITY,
            Date.now() + expiresInSeconds * 1000,
          ),
          message: "请在飞书页面确认创建和完整授权",
        };
        resolveUrl();
      },
    }).then(async (result) => {
      if (this.provisioningGeneration !== generation) return;
      this.provisioning = {
        ...this.provisioning,
        state: "verifying",
        brand: result.brand,
        message: "正在验证飞书机器人和授权",
      };
      const status = await this.configure({
        appId: result.appId,
        appSecret: result.appSecret,
        brand: result.brand,
      });
      if (this.provisioningGeneration !== generation) return;
      const eventVerification = status.state === "ready" && status.verified
        ? await this.verifyRequiredEvents()
        : { ready: false };
      if (this.provisioningGeneration !== generation) return;
      if (status.state === "ready" && status.verified && eventVerification.ready) {
        this.provisioning = {
          ...this.provisioning,
          state: "ready",
          message: "飞书机器人已连接",
        };
        return;
      }
      if (
        status.state === "ready" &&
        status.verified &&
        eventVerification.repairUrl
      ) {
        this.provisioning = {
          ...this.provisioning,
          state: "waiting_for_user",
          verificationUrl: eventVerification.repairUrl,
          message: "请在飞书确认完整权限和事件订阅",
        };
        const repaired = await this.pollRequiredEventsUntilReady(
          generation,
          controller.signal,
        );
        if (this.provisioningGeneration !== generation || controller.signal.aborted) return;
        this.provisioning = repaired
          ? {
              ...this.provisioning,
              state: "ready",
              message: "飞书机器人已连接",
            }
          : {
              ...this.provisioning,
              state: "failed",
              message: INCOMPLETE_AUTHORIZATION_MESSAGE,
            };
        return;
      }
      this.provisioning = {
        ...this.provisioning,
        state: "failed",
        message: status.state === "ready" && status.verified
          ? INCOMPLETE_AUTHORIZATION_MESSAGE
          : FAILED_MESSAGE,
      };
    }).catch((error: unknown) => {
      if (
        this.provisioningGeneration === generation &&
        this.provisioning.state !== "expired"
      ) {
        const expired = controller.signal.aborted || registrationErrorCode(error) === "expired_token";
        this.provisioning = {
          ...this.provisioning,
          state: expired ? "expired" : "failed",
          message: expired ? EXPIRED_MESSAGE : FAILED_MESSAGE,
        };
      }
    }).finally(() => {
      clearTimeout(ttlTimer);
      if (this.provisioningAbort === controller) this.provisioningAbort = undefined;
    });

    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      deadlineTimer = setTimeout(resolve, this.urlWaitMs);
    });
    await Promise.race([urlReady, handledRegistration, deadline]);
    if (deadlineTimer) clearTimeout(deadlineTimer);
    if (
      this.provisioningGeneration === generation &&
      this.provisioning.state === "starting"
    ) {
      this.provisioning = {
        ...this.provisioning,
        state: "failed",
        message: FAILED_MESSAGE,
      };
      controller.abort();
    }
    return this.provisioningStatus();
  }

  provisioningStatus(): LarkProvisioningSession {
    return { ...this.provisioning };
  }

  async listBotChats(): Promise<LarkChatSummary[]> {
    const chats = new Map<string, LarkChatSummary>();
    const seenTokens = new Set<string>();
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_CHAT_LIST_PAGES; page += 1) {
      const argv = [
        this.larkBin,
        "im",
        "+chat-list",
        "--as",
        "bot",
        "--page-size",
        "100",
        ...(pageToken ? ["--page-token", pageToken] : []),
        "--json",
      ];
      let result: LarkSetupCommandResult;
      try {
        result = await this.runner.run({ argv, timeoutMs: 15_000 });
      } catch {
        throw new Error("Unable to list Feishu groups");
      }
      if (result.code !== 0) throw new Error("Unable to list Feishu groups");
      const root = parseStructuredRoot(
        result.stdout,
        "Unable to list Feishu groups",
      );
      const rawChats = root.chats === null ? [] : root.chats;
      if (!Array.isArray(rawChats)) {
        throw new Error("Unable to list Feishu groups");
      }
      for (const rawChat of rawChats) {
        const chat = parseChatSummary(rawChat);
        const previous = chats.get(chat.chatId);
        if (previous && JSON.stringify(previous) !== JSON.stringify(chat)) {
          throw new Error("Unable to list Feishu groups");
        }
        chats.set(chat.chatId, chat);
      }
      if (root.has_more !== true) {
        return [...chats.values()].sort(compareChats);
      }
      const nextToken = stringValue(root.page_token ?? root.pageToken);
      if (!nextToken || seenTokens.has(nextToken)) {
        throw new Error("Unable to list Feishu groups");
      }
      seenTokens.add(nextToken);
      pageToken = nextToken;
    }
    throw new Error("Unable to list Feishu groups");
  }

  async chatIsExternal(chatId: string): Promise<boolean> {
    try {
      return (await this.getBotChat(chatId))?.external === true;
    } catch {
      return false;
    }
  }

  async getBotChat(chatId: string): Promise<LarkChatSummary | undefined> {
    const normalizedChatId = chatId.trim();
    if (!normalizedChatId) return undefined;
    let result: LarkSetupCommandResult;
    try {
      result = await this.runner.run({
        argv: [
          this.larkBin,
          "im",
          "chats",
          "get",
          "--chat-id",
          normalizedChatId,
          "--as",
          "bot",
          "--json",
        ],
        timeoutMs: 15_000,
      });
    } catch {
      throw new Error("Unable to verify Feishu group");
    }
    if (result.code !== 0) return undefined;
    const root = parseStructuredRoot(
      result.stdout,
      "Unable to verify Feishu group",
    );
    return parseChatSummary(
      root,
      "Unable to verify Feishu group",
      normalizedChatId,
    );
  }

  async fullGroupMessageCapability(): Promise<LarkCapabilityState> {
    let result: LarkSetupCommandResult;
    try {
      result = await this.runner.run({
        argv: [
          this.larkBin,
          "auth",
          "check",
          "--scope",
          FULL_GROUP_MESSAGE_SCOPE,
          "--json",
        ],
        timeoutMs: 15_000,
      });
    } catch {
      return "unknown";
    }
    let root: Record<string, unknown>;
    try {
      root = parseStructuredRoot(result.stdout, "Invalid capability output");
    } catch {
      return "unknown";
    }
    const missing = stringArray(root.missing);
    const granted = stringArray(root.granted ?? root.scopes);
    if (missing?.includes(FULL_GROUP_MESSAGE_SCOPE)) return "unavailable";
    if (
      result.code === 0
      && (
        granted?.includes(FULL_GROUP_MESSAGE_SCOPE)
        || (root.ok === true && missing?.length === 0)
      )
    ) {
      return "available";
    }
    return "unknown";
  }

  private async verifyRequiredEvents(): Promise<{
    ready: boolean;
    repairUrl?: string;
  }> {
    for (const key of REQUIRED_EVENT_KEYS) {
      let result: LarkSetupCommandResult;
      try {
        result = await this.runner.run({
          argv: [
            this.larkBin,
            "event",
            "consume",
            key,
            "--as",
            "bot",
            "--timeout",
            "1s",
          ],
          timeoutMs: 5_000,
        });
      } catch {
        return { ready: false };
      }
      if (result.code !== 0) {
        const repairUrl = `${result.stdout}\n${result.stderr}`.match(VERIFICATION_URL)?.[0];
        return { ready: false, ...(repairUrl ? { repairUrl } : {}) };
      }
    }
    return { ready: true };
  }

  private async pollRequiredEventsUntilReady(
    generation: number,
    signal: AbortSignal,
  ): Promise<boolean> {
    while (this.provisioningGeneration === generation && !signal.aborted) {
      await Bun.sleep(this.eventVerificationPollMs);
      if (this.provisioningGeneration !== generation || signal.aborted) return false;
      const verification = await this.verifyRequiredEvents();
      if (verification.ready) return true;
      if (verification.repairUrl) {
        this.provisioning = {
          ...this.provisioning,
          verificationUrl: verification.repairUrl,
        };
      }
    }
    return false;
  }

  async status(): Promise<LarkSetupStatus> {
    let result: LarkSetupCommandResult;
    try {
      result = await this.runner.run({
        argv: [this.larkBin, "auth", "status", "--json", "--verify"],
        timeoutMs: 15_000,
      });
    } catch {
      return {
        state: "unavailable",
        verified: false,
        message: "lark-cli 未安装、不可执行或连接超时",
      };
    }

    if (result.code !== 0) {
      return {
        state: /not configured|config init|missing app/i.test(`${result.stdout}\n${result.stderr}`)
          ? "unconfigured"
          : "invalid",
        verified: false,
        message: result.code === 124 ? "连接验证超时" : "lark-cli 应用配置无效或无法验证",
      };
    }

    try {
      const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
      const root = isRecord(parsed.data) ? parsed.data : parsed;
      const identities = isRecord(root.identities) ? root.identities : {};
      const bot = isRecord(identities.bot) ? identities.bot : {};
      const appId = stringValue(root.appId);
      const brandValue = stringValue(root.brand);
      const brand = brandValue === "lark" ? "lark" : brandValue === "feishu" ? "feishu" : undefined;
      const botName = stringValue(bot.appName);
      const botOpenId = stringValue(bot.openId);
      const verified = bot.verified === true && bot.available !== false;
      const ready = verified && bot.status === "ready" && Boolean(botName && botOpenId);
      return {
        state: ready ? "ready" : appId ? "invalid" : "unconfigured",
        verified,
        ...(appId ? { appId } : {}),
        ...(brand ? { brand } : {}),
        ...(botName ? { botName } : {}),
        ...(botOpenId ? { botOpenId } : {}),
        message: stringValue(bot.message) ?? (ready ? "Bot identity: ready" : "Bot 身份尚未就绪"),
      };
    } catch {
      return {
        state: "invalid",
        verified: false,
        message: "lark-cli 返回了无法识别的状态",
      };
    }
  }

  async configure(input: LarkSetupInput): Promise<LarkSetupStatus> {
    const appId = input.appId.trim();
    const appSecret = input.appSecret;
    const brand = input.brand === "lark" ? "lark" : "feishu";
    if (!appId || !appSecret) throw new Error("App ID and App Secret are required");

    let result: LarkSetupCommandResult;
    try {
      result = await this.runner.run({
        argv: [
          this.larkBin,
          "config",
          "init",
          "--app-id",
          appId,
          "--app-secret-stdin",
          "--brand",
          brand,
        ],
        stdin: `${appSecret}\n`,
        timeoutMs: 30_000,
      });
    } catch {
      throw new Error("lark-cli is unavailable");
    }
    if (result.code !== 0) {
      throw new Error(`lark-cli configuration failed (${result.code})`);
    }

    const status = await this.status();
    if (status.state !== "ready" || !status.verified) {
      throw new Error("lark-cli bot verification failed");
    }
    return status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function exactVerificationUrl(value: string): string | undefined {
  const match = value.match(VERIFICATION_URL)?.[0];
  return match === value ? match : undefined;
}

function registrationErrorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

const MAX_CHAT_LIST_PAGES = 100;
const FULL_GROUP_MESSAGE_SCOPE = "im:message.group_msg";

function parseStructuredRoot(
  stdout: string,
  publicError: string,
): Record<string, unknown> {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    const root = isRecord(parsed) && isRecord(parsed.data)
      ? parsed.data
      : parsed;
    if (!isRecord(root)) throw new Error(publicError);
    return root;
  } catch {
    throw new Error(publicError);
  }
}

function parseChatSummary(
  value: unknown,
  publicError = "Unable to list Feishu groups",
  fallbackChatId?: string,
): LarkChatSummary {
  if (!isRecord(value)) throw new Error(publicError);
  const chatId = stringValue(value.chat_id ?? value.chatId) ?? fallbackChatId;
  if (!chatId) throw new Error(publicError);
  const description = stringValue(value.description);
  const ownerId = stringValue(value.owner_id ?? value.ownerId);
  return {
    chatId,
    name: stringValue(value.name) ?? "",
    ...(description ? { description } : {}),
    ...(typeof value.external === "boolean"
      ? { external: value.external }
      : {}),
    ...(ownerId ? { ownerId } : {}),
  };
}

function compareChats(left: LarkChatSummary, right: LarkChatSummary): number {
  return left.name.localeCompare(right.name) || left.chatId.localeCompare(right.chatId);
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return undefined;
  }
  return value.map((item) => item.trim()).filter(Boolean);
}
