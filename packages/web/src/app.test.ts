import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import {
  readSettings,
  resetConfig,
  saveSettings,
  type Page,
  type SpaceId,
  type SystemHealthSnapshot,
} from "@homeagent/shared";
import { KnowledgeEngine, FakeLlm } from "@homeagent/core";
import { createWebApp } from "./app.ts";
import { FeishuIntegrationService } from "./feishu-integration-service.ts";

let dir: string;
let engine: KnowledgeEngine;
let app: Hono;
let fake: FakeLlm;
const SPACE: SpaceId = "team/oc_web";

function page(slug: string, title: string, content: string): Page {
  return {
    slug,
    type: "entity",
    title,
    summary: content.slice(0, 30),
    aliases: ["爱丽丝"],
    tags: ["team"],
    sources: ["raw-1"],
    links: [],
    content,
    updatedAt: Date.now(),
    contentHash: "h",
  };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "hb-web-"));
  process.env.HOMEAGENT_DATA_DIR = dir;
  resetConfig();
  fake = new FakeLlm();
  engine = new KnowledgeEngine({ dataDir: dir, llm: fake });
  await engine.upsertPage(SPACE, page("entities/alice", "Alice", "Alice 负责后端服务。"));
  await engine.remember({ space: SPACE, source: "message", content: "一条原始消息" });
  engine.feishuBindings.connect({
    chatId: "oc_web",
    spaceId: SPACE,
    boundAppId: "cli_current",
    responseMode: "smart",
    participationLevel: "balanced",
    replyInThread: true,
  });
  app = createWebApp({
    engine,
    // deterministic + fast: don't spawn real CLIs
    detectProviders: async () => [
      { id: "claude", name: "Claude Code", bin: "claude", available: true, detail: "2.x" },
      { id: "codex", name: "Codex", bin: "codex", available: false, detail: "node not found" },
      { id: "trae-cli", name: "TRAE CLI", bin: "trae-cli", available: true, detail: "0.2" },
    ],
    providerModels: async () => ({
      claude: ["sonnet", "opus"],
      codex: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"],
      "trae-cli": ["openrouter-3o"],
    }),
  });
});

afterEach(() => {
  engine.close();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.HOMEAGENT_DATA_DIR;
  resetConfig();
});

describe("web backend (read-only)", () => {
  test("serves only the injected HomeAgent Feishu avatar with manual-upload guidance", async () => {
    const avatarPath = join(dir, "homeagent-feishu-avatar-512.png");
    const avatarBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
    writeFileSync(avatarPath, avatarBytes);
    writeFileSync(join(dir, "request-controlled.png"), new Uint8Array([9, 9, 9]));
    const avatarApp = createWebApp({ engine, brandAvatarPath: avatarPath });

    const download = await avatarApp.request(
      "/brand/homeagent-feishu-avatar.png?filename=request-controlled.png",
    );
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("image/png");
    expect(download.headers.get("content-disposition")).toBe(
      'attachment; filename="HomeAgent-Feishu-Avatar.png"',
    );
    expect(download.headers.get("cache-control")).toBe("no-store");
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(avatarBytes);

    const integrations = await (
      await avatarApp.request("/integrations")
    ).text();
    expect(integrations).toContain(
      'href="/brand/homeagent-feishu-avatar.png"',
    );
    expect(integrations).toContain("手动上传");
    expect(integrations).toContain("不会自动修改当前飞书应用");
  });

  test("reports a missing local avatar without leaking its absolute path", async () => {
    const missingPath = join(dir, "missing-private-avatar.png");
    const missingAvatarApp = createWebApp({
      engine,
      brandAvatarPath: missingPath,
    });

    const download = await missingAvatarApp.request(
      "/brand/homeagent-feishu-avatar.png",
    );
    expect(download.status).not.toBe(200);
    const body = await download.text();
    expect(body).toContain("HomeAgent Feishu avatar is unavailable");
    expect(body).not.toContain(missingPath);

    const integrations = await (
      await missingAvatarApp.request("/integrations")
    ).text();
    expect(integrations).toContain("本地头像资源不可用");
    expect(integrations).not.toContain(
      'href="/brand/homeagent-feishu-avatar.png"',
    );
    expect(integrations).not.toContain(missingPath);
  });

  test("health endpoints distinguish liveness from readiness", async () => {
    const snapshot: SystemHealthSnapshot = {
      status: "degraded",
      ready: false,
      checkedAt: 1_783_932_000_000,
      components: {
        feishu: {
          status: "down",
          summary: "消息消费者未就绪",
        },
      },
    };
    const healthApp = createWebApp({
      engine,
      health: async () => snapshot,
    });

    const live = await healthApp.request("/healthz");
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual(
      expect.objectContaining({ status: "ok", checkedAt: expect.any(Number) }),
    );

    const ready = await healthApp.request("/readyz");
    expect(ready.status).toBe(503);
    expect(await ready.json()).toEqual(snapshot);
  });

  test("fresh installs redirect the dashboard to guided setup", async () => {
    await engine.deleteSpace(SPACE);
    const fresh = createWebApp({
      engine,
      detectProviders: async () => [],
      providerModels: async () => ({}),
      larkSetup: {
        status: async () => ({ state: "unconfigured", verified: false, message: "missing" }),
        configure: async () => { throw new Error("unused"); },
      },
    });

    const response = await fresh.request("/");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/setup");
    expect((await fresh.request("/setup")).status).toBe(200);
  });

  test("edits and resets space rules from the knowledge governance page", async () => {
    const initial = await app.request(`/spaces/${encodeURIComponent(SPACE)}/governance`);
    expect(initial.status).toBe(200);
    expect(await initial.text()).toContain("空间规则与治理记录");

    const update = await app.request(
      `/spaces/${encodeURIComponent(SPACE)}/governance/rules`,
      {
        method: "POST",
        body: new URLSearchParams({
          purpose: "# 产品空间\n\n只沉淀产品决策。",
          schema: "# 产品规则\n\n- analysis: 产品决策",
        }),
      },
    );
    expect([302, 303]).toContain(update.status);

    const updated = await app.request(`/spaces/${encodeURIComponent(SPACE)}/governance`);
    const updatedBody = await updated.text();
    expect(updatedBody).toContain("只沉淀产品决策");
    expect(updatedBody).toContain("更新空间规则");

    const reset = await app.request(
      `/spaces/${encodeURIComponent(SPACE)}/governance/rules/reset`,
      {
        method: "POST",
        body: new URLSearchParams({ target: "purpose" }),
      },
    );
    expect([302, 303]).toContain(reset.status);
    expect((await engine.getSpaceGovernance(SPACE)).purpose).toContain(
      "这是一个 homeagent 知识空间",
    );
  });

  test("shows the full raw record and its derived knowledge pages", async () => {
    const rawId = await engine.remember({
      space: SPACE,
      source: "doc",
      author: "ou_owner",
      content: "完整原始内容：Alice 负责结算系统，并维护值班手册。",
      attachments: [{ kind: "file", ref: "file-key", name: "值班手册.md" }],
    });
    await engine.upsertPage(SPACE, {
      ...page("entities/alice-settlement", "Alice 与结算系统", "Alice 负责结算系统。"),
      sources: [rawId],
    });

    const listing = await app.request(`/spaces/${encodeURIComponent(SPACE)}/raw`);
    const listingBody = await listing.text();
    expect(listingBody).toContain(`/raw/${rawId}`);

    const detail = await app.request(
      `/spaces/${encodeURIComponent(SPACE)}/raw/${encodeURIComponent(rawId)}`,
    );
    expect(detail.status).toBe(200);
    const detailBody = await detail.text();
    expect(detailBody).toContain("完整原始内容：Alice 负责结算系统");
    expect(detailBody).toContain("值班手册.md");
    expect(detailBody).toContain("Alice 与结算系统");
    expect(detailBody).toContain("重新提炼这条记录");
  });

  test("redistills one raw record from its detail page", async () => {
    const rawId = await engine.remember({
      space: SPACE,
      source: "manual",
      content: "结算系统负责人是 Bob。",
    });
    fake.queueJSON({
      operations: [
        {
          type: "concept",
          name: "settlement-owner",
          title: "结算系统负责人",
          rawIds: [rawId],
        },
      ],
      skippedRawIds: [],
    });
    fake.queueJSON({
      title: "结算系统负责人",
      summary: "Bob 负责结算系统",
      aliases: [],
      tags: [],
      links: [],
      content: "# 结算系统负责人\n\nBob 负责结算系统。",
    });

    const response = await app.request(
      `/spaces/${encodeURIComponent(SPACE)}/raw/${encodeURIComponent(rawId)}/redistill`,
      { method: "POST" },
    );

    expect([302, 303]).toContain(response.status);
    expect(await engine.getPage(SPACE, "concepts/settlement-owner")).not.toBeNull();
    expect((await engine.getSpaceGovernance(SPACE)).audit.at(-1)).toEqual(
      expect.objectContaining({ action: "raw_redistilled", rawIds: [rawId] }),
    );
  });

  test("regenerates a knowledge page from its detail screen", async () => {
    const rawId = await engine.remember({
      space: SPACE,
      source: "message",
      content: "值班负责人是 Alice。",
    });
    engine.registry.store(SPACE).index().markIngested([rawId]);
    await engine.upsertPage(SPACE, {
      ...page("concepts/oncall-owner", "值班负责人", "旧内容"),
      sources: [rawId],
    });

    const detail = await app.request(
      `/spaces/${encodeURIComponent(SPACE)}/pages/${encodeURIComponent("concepts/oncall-owner")}`,
    );
    const detailBody = await detail.text();
    expect(detailBody).toContain("重新生成知识页");
    expect(detailBody).toContain("提交人工纠错");
    expect(detailBody).toContain(`/raw/${rawId}`);

    fake.queueJSON({
      title: "值班负责人",
      summary: "Alice 负责值班",
      aliases: [],
      tags: [],
      links: [],
      content: "# 值班负责人\n\nAlice 负责值班。",
    });
    const response = await app.request(
      `/spaces/${encodeURIComponent(SPACE)}/pages/regenerate`,
      {
        method: "POST",
        body: new URLSearchParams({ slug: "concepts/oncall-owner" }),
      },
    );

    expect([302, 303]).toContain(response.status);
    expect((await engine.getPage(SPACE, "concepts/oncall-owner"))?.content).toContain(
      "Alice 负责值班",
    );
  });

  test("submits an auditable correction from the knowledge page", async () => {
    const rawId = await engine.remember({
      space: SPACE,
      source: "message",
      content: "支付负责人是 Alice。",
    });
    engine.registry.store(SPACE).index().markIngested([rawId]);
    await engine.upsertPage(SPACE, {
      ...page("concepts/payment-owner", "支付负责人", "Alice 负责支付。"),
      sources: [rawId],
    });
    fake.queueJSON({
      title: "支付负责人",
      summary: "Bob 负责支付",
      aliases: [],
      tags: [],
      links: [],
      content: "# 支付负责人\n\nBob 负责支付。",
    });

    const response = await app.request(
      `/spaces/${encodeURIComponent(SPACE)}/pages/correct`,
      {
        method: "POST",
        body: new URLSearchParams({
          slug: "concepts/payment-owner",
          correction: "支付负责人已经改为 Bob。",
        }),
      },
    );

    expect([302, 303]).toContain(response.status);
    expect((await engine.getPage(SPACE, "concepts/payment-owner"))?.content).toContain(
      "Bob 负责支付",
    );
    expect(
      engine.registry.store(SPACE).index().listRaw({}).some(
        (raw) => raw.source === "manual" && raw.content.includes("已经改为 Bob"),
      ),
    ).toBe(true);
    expect((await engine.getSpaceGovernance(SPACE)).audit.at(-1)?.action).toBe(
      "correction_submitted",
    );
  });

  test("deletes a knowledge page while preserving its raw source", async () => {
    const rawId = await engine.remember({
      space: SPACE,
      source: "message",
      content: "临时项目代号是 Atlas。",
    });
    await engine.upsertPage(SPACE, {
      ...page("concepts/temporary-code", "临时代号", "Atlas"),
      sources: [rawId],
    });

    const response = await app.request(
      `/spaces/${encodeURIComponent(SPACE)}/pages/delete`,
      {
        method: "POST",
        body: new URLSearchParams({ slug: "concepts/temporary-code" }),
      },
    );

    expect([302, 303]).toContain(response.status);
    expect(await engine.getPage(SPACE, "concepts/temporary-code")).toBeNull();
    expect(engine.registry.store(SPACE).index().getRaw(rawId)).not.toBeNull();
    expect((await engine.getSpaceGovernance(SPACE)).audit.at(-1)?.action).toBe(
      "page_deleted",
    );
  });

  test("an imported space does not hide an unconfigured production connection", async () => {
    const unconfigured = createWebApp({
      engine,
      larkSetup: {
        status: async () => ({ state: "unconfigured", verified: false, message: "missing" }),
        configure: async () => { throw new Error("unused"); },
      },
    });
    const response = await unconfigured.request("/");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/setup");
  });

  test("starts automatic Feishu setup and exposes a pollable safe session", async () => {
    let starts = 0;
    const session = {
      state: "waiting_for_user" as const,
      brand: "feishu" as const,
      verificationUrl: "https://open.feishu.cn/page/cli?user_code=x",
      message: "等待确认",
    };
    const setupApp = createWebApp({
      engine,
      detectProviders: async () => [],
      providerModels: async () => ({}),
      larkSetup: {
        status: async () => ({ state: "unconfigured", verified: false, message: "missing" }),
        configure: async () => { throw new Error("unused"); },
        startAutomatic: async () => { starts += 1; return session; },
        provisioningStatus: () => session,
      },
    });

    const start = await setupApp.request("/setup/feishu/automatic", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "brand=feishu",
    });
    expect(start.status).toBe(302);
    expect(starts).toBe(1);
    const poll = await setupApp.request("/setup/feishu/session");
    expect(await poll.json()).toEqual(session);
  });

  test("starts official one-click Feishu creation from Integrations", async () => {
    let starts = 0;
    const session = {
      state: "waiting_for_user" as const,
      brand: "feishu" as const,
      verificationUrl: "https://open.feishu.cn/page/cli?user_code=SAFE",
      message: "请在飞书页面完成授权",
    };
    const setupApp = createWebApp({
      engine,
      detectProviders: async () => [],
      providerModels: async () => ({}),
      larkSetup: {
        status: async () => ({ state: "unconfigured", verified: false, message: "never-render-this-secret" }),
        configure: async () => { throw new Error("unused"); },
        startAutomatic: async () => { starts += 1; return session; },
        provisioningStatus: () => session,
      },
    });

    const response = await setupApp.request("/setup/feishu/automatic", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "brand=feishu&returnTo=%2Fintegrations",
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toStartWith("/integrations?ok=");
    expect(starts).toBe(1);
    const page = await (await setupApp.request("/integrations")).text();
    expect(page).toContain("请在飞书页面完成授权");
    expect(page).toContain("打开飞书并确认");
    expect(page).toContain("SAFE");
    expect(page).toContain("首次确认会申请完整权限");
    expect(page).toContain("/setup/feishu/session");
    expect(page).not.toContain("never-render-this-secret");
  });

  test("recovers the verified bot identity after an automatic session is lost on restart", async () => {
    const idleSession = {
      state: "idle" as const,
      brand: "feishu" as const,
      message: "尚未开始",
    };
    const setupApp = createWebApp({
      engine,
      detectProviders: async () => [],
      providerModels: async () => ({}),
      larkSetup: {
        status: async () => ({
          state: "ready",
          verified: true,
          brand: "feishu",
          appId: "cli_ready",
          botName: "HomeAgent",
          botOpenId: "ou_ready",
          message: "ready",
        }),
        configure: async () => { throw new Error("unused"); },
        provisioningStatus: () => idleSession,
      },
    });

    const response = await setupApp.request("/setup");
    expect(response.status).toBe(200);
    expect(readSettings(dir)).toEqual(expect.objectContaining({
      feishuBotName: "HomeAgent",
      feishuBotOpenId: "ou_ready",
    }));
  });

  test("rejects a model that belongs to a different AI provider", async () => {
    const response = await app.request("/setup/ai", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "provider=claude&model=gpt-5.4",
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("%E6%89%80%E9%80%89%E6%A8%A1%E5%9E%8B");
    expect(readSettings(dir).defaultModel).toBeUndefined();
  });

  test("connects managed Codex without exposing installer or login output", async () => {
    let installed = false;
    let installCalls = 0;
    let loginStarts = 0;
    let session: import("@homeagent/llm").CodexLoginSession = {
      state: "idle",
      message: "尚未连接",
    };
    const managed = createWebApp({
      engine,
      detectProviders: async () => [
        {
          id: "codex",
          name: "Codex",
          bin: "/managed/codex",
          available: installed,
          detail: installed ? "ready" : "missing",
        },
      ],
      providerModels: async () => ({ codex: ["gpt-5.4"] }),
      codexSetup: {
        canInstall: true,
        isInstalled: () => installed,
        install: async (consented) => {
          expect(consented).toBeTrue();
          installCalls += 1;
          installed = true;
        },
        startDeviceLogin: async () => {
          loginStarts += 1;
          session = {
            state: "waiting_for_user",
            verificationUrl: "https://auth.openai.com/device",
            userCode: "SAFE-CODE",
            message: "等待确认",
          };
          return session;
        },
        deviceLoginStatus: () => session,
        cancelDeviceLogin: () => ({ state: "cancelled", message: "已取消" }),
      },
    });

    const refused = await managed.request("/setup/ai/codex/install", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "",
    });
    expect(refused.headers.get("location")).toContain("%E9%9C%80%E8%A6%81%E7%A1%AE%E8%AE%A4");
    expect(installCalls).toBe(0);

    await managed.request("/setup/ai/codex/install", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "consent=on",
    });
    await Bun.sleep(0);
    expect(installCalls).toBe(1);
    expect(loginStarts).toBe(1);
    expect(await (await managed.request("/setup/ai/codex/session")).json()).toEqual(session);

    session = { state: "ready", message: "ChatGPT 已连接" };
    expect((await managed.request("/setup/ai/codex/session")).status).toBe(200);
    expect(readSettings(dir)).toEqual(expect.objectContaining({
      defaultProvider: "codex",
      defaultModel: "",
    }));
  });

  test("sanitizes managed Codex installation failures", async () => {
    const secret = "raw download URL and token";
    const broken = createWebApp({
      engine,
      detectProviders: async () => [],
      providerModels: async () => ({}),
      codexSetup: {
        canInstall: true,
        isInstalled: () => false,
        install: async () => { throw new Error(secret); },
        startDeviceLogin: async () => ({ state: "failed", message: "失败" }),
        deviceLoginStatus: () => ({ state: "idle", message: "尚未连接" }),
        cancelDeviceLogin: () => ({ state: "cancelled", message: "已取消" }),
      },
    });
    await broken.request("/setup/ai/codex/install", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "consent=on",
    });
    await Bun.sleep(0);
    const result = JSON.stringify(await (await broken.request("/setup/ai/codex/session")).json());
    expect(result).toContain("Codex 安装未完成");
    expect(result).not.toContain(secret);
  });

  test("does not finish setup before AI, bot identity, and runtime are ready", async () => {
    const response = await app.request("/setup/finish", { method: "POST" });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("/setup?ok=");
    expect(readSettings(dir).onboardingCompletedAt).toBeUndefined();
  });

  test("allows an explicitly private-only finish after the connection is ready", async () => {
    saveSettings({ defaultProvider: "claude", onboardingStartedAt: Date.now() + 1_000 });
    const ready = createWebApp({
      engine,
      detectProviders: async () => [
        { id: "claude", name: "Claude Code", bin: "claude", available: true, detail: "ready" },
      ],
      providerModels: async () => ({ claude: ["sonnet"] }),
      larkSetup: {
        status: async () => ({
          state: "ready",
          verified: true,
          botName: "HomeAgent",
          botOpenId: "ou_ready",
          message: "ready",
        }),
        configure: async () => { throw new Error("unused"); },
      },
      activeFeishuIdentity: { botName: "HomeAgent", botOpenId: "ou_ready" },
      feishuRuntime: () => ({ ready: true, consumers: [] }),
    });
    const response = await ready.request("/setup/finish", { method: "POST" });
    expect(response.headers.get("location")).toBe("/");
    expect(readSettings(dir).onboardingCompletedAt).toEqual(expect.any(Number));
  });

  test("finishes group setup only after an explicit active binding", async () => {
    const startedAt = Date.now() + 1_000;
    saveSettings({
      onboardingStartedAt: startedAt,
      feishuBotName: "HomeAgent",
      feishuBotOpenId: "ou_ready",
    });
    const setupApp = createWebApp({
      engine,
      detectProviders: async () => [
        { id: "claude", name: "Claude Code", bin: "claude", available: true, detail: "ready" },
      ],
      providerModels: async () => ({ claude: ["sonnet"] }),
      larkSetup: {
        status: async () => ({
          state: "ready",
          verified: true,
          botName: "HomeAgent",
          botOpenId: "ou_ready",
          message: "ready",
        }),
        configure: async () => { throw new Error("unused"); },
      },
      activeFeishuIdentity: { botName: "HomeAgent", botOpenId: "ou_ready" },
      feishuRuntime: () => ({ ready: true, consumers: [] }),
    });

    engine.feishuBindings.disconnect(SPACE);
    expect(await (await setupApp.request("/setup")).text()).toContain("明确连接第一个群聊");
    await engine.remember({
      space: SPACE,
      source: "task",
      content: "不是飞书消息",
      createdAt: startedAt + 1,
    });
    expect(await (await setupApp.request("/setup")).text()).toContain("明确连接第一个群聊");
    await engine.remember({
      space: SPACE,
      source: "message",
      content: "来自本次设置的飞书消息",
      createdAt: startedAt + 2,
    });
    expect(await (await setupApp.request("/setup")).text()).toContain("明确连接第一个群聊");
    engine.feishuBindings.connect({
      chatId: "oc_web",
      spaceId: SPACE,
      boundAppId: "cli_current",
      responseMode: "mentions_only",
      replyInThread: true,
    });
    expect(await (await setupApp.request("/setup")).text()).toContain("一切就绪");
  });

  test("guides and verifies external sharing with a new external-group message", async () => {
    saveSettings({ defaultProvider: "claude" });
    const checkedChats: string[] = [];
    const setupApp = createWebApp({
      engine,
      detectProviders: async () => [
        { id: "claude", name: "Claude Code", bin: "claude", available: true, detail: "ready" },
      ],
      providerModels: async () => ({ claude: ["sonnet"] }),
      larkSetup: {
        status: async () => ({
          state: "ready",
          verified: true,
          appId: "cli_external",
          brand: "feishu",
          botName: "HomeAgent",
          botOpenId: "ou_ready",
          message: "ready",
        }),
        configure: async () => { throw new Error("unused"); },
        chatIsExternal: async (chatId) => {
          checkedChats.push(chatId);
          return chatId === "oc_external";
        },
      },
      activeFeishuIdentity: { botName: "HomeAgent", botOpenId: "ou_ready" },
      feishuRuntime: () => ({ ready: true, consumers: [] }),
    });

    const guide = await (await setupApp.request("/setup")).text();
    expect(guide).toContain("发布对外共享版本");
    expect(guide).toContain("https://open.feishu.cn/app/cli_external");

    const start = await setupApp.request("/setup/feishu/external-sharing/start", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "returnTo=%2Fsetup",
    });
    expect(start.headers.get("location")).toStartWith("/setup?ok=");
    const started = readSettings(dir);
    expect(started.feishuExternalSharingAppId).toBe("cli_external");
    expect(started.feishuExternalSharingStartedAt).toEqual(expect.any(Number));

    await engine.remember({
      space: SPACE,
      source: "message",
      chatId: "oc_external",
      content: "@HomeAgent 对外共享测试",
      createdAt: started.feishuExternalSharingStartedAt! + 1,
    });
    await setupApp.request("/setup");

    expect(checkedChats).toContain("oc_external");
    expect(readSettings(dir)).toEqual(expect.objectContaining({
      feishuExternalSharingVerifiedAt: expect.any(Number),
      feishuExternalSharingVerifiedChatId: "oc_external",
    }));
    const integrations = await (await setupApp.request("/integrations")).text();
    expect(integrations).toContain("对外共享已验证");
  });

  test("can explicitly keep the current Feishu app internal-only", async () => {
    const setupApp = createWebApp({
      engine,
      larkSetup: {
        status: async () => ({
          state: "ready",
          verified: true,
          appId: "cli_internal",
          brand: "feishu",
          botName: "HomeAgent",
          botOpenId: "ou_ready",
          message: "ready",
        }),
        configure: async () => { throw new Error("unused"); },
      },
    });

    const response = await setupApp.request("/setup/feishu/external-sharing/skip", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "returnTo=%2Fintegrations",
    });
    expect(response.headers.get("location")).toStartWith("/integrations?ok=");
    expect(readSettings(dir).feishuExternalSharingSkippedAppId).toBe("cli_internal");
    const integrations = await (await setupApp.request("/integrations")).text();
    expect(integrations).toContain("https://open.feishu.cn/app/cli_internal");
    expect(integrations).toContain("允许机器人被添加到外部群中使用");
    expect(integrations).toContain("允许外部用户与机器人单聊");
  });

  test("admin token protects management routes but leaves probes public", async () => {
    const secureApp = createWebApp({ engine, adminToken: "admin-secret" });

    expect((await secureApp.request("/healthz")).status).toBe(200);
    expect((await secureApp.request("/readyz")).status).toBe(200);

    const denied = await secureApp.request("/");
    expect(denied.status).toBe(401);
    expect(denied.headers.get("www-authenticate")).toContain("Basic");

    const basic = Buffer.from("homeagent:admin-secret").toString("base64");
    expect((await secureApp.request("/", { headers: { authorization: `Basic ${basic}` } })).status).toBe(200);
    expect((await secureApp.request("/governance", {
      headers: { authorization: "Bearer admin-secret" },
    })).status).toBe(200);
    expect((await secureApp.request("/", {
      headers: { authorization: "Bearer wrong" },
    })).status).toBe(401);

    expect((await secureApp.request("/governance/prune", {
      method: "POST",
      headers: {
        authorization: `Basic ${basic}`,
        origin: "https://attacker.example",
        "sec-fetch-site": "cross-site",
      },
    })).status).toBe(403);
    expect((await secureApp.request("/governance/prune", {
      method: "POST",
      headers: {
        authorization: `Basic ${basic}`,
        origin: "http://localhost",
        "sec-fetch-site": "same-origin",
      },
    })).status).toBe(302);

    expect((await app.request("/governance/prune", {
      method: "POST",
      headers: {
        origin: "https://attacker.example",
        "sec-fetch-site": "cross-site",
      },
    })).status).toBe(403);
    expect((await app.request("/", {
      headers: { host: "attacker.example" },
    })).status).toBe(403);
  });

  test("health routes degrade safely when the reporter itself fails", async () => {
    const healthApp = createWebApp({
      engine,
      health: async () => {
        throw new Error("health aggregation failed");
      },
    });

    const live = await healthApp.request("/healthz");
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual(
      expect.objectContaining({ status: "ok", checkedAt: expect.any(Number) }),
    );

    expect((await healthApp.request("/readyz")).status).toBe(503);
    expect((await healthApp.request("/health")).status).toBe(200);
  });

  test("liveness does not wait for readiness aggregation", async () => {
    const healthApp = createWebApp({
      engine,
      health: () => new Promise<SystemHealthSnapshot>(() => {}),
    });

    const live = await Promise.race([
      healthApp.request("/healthz"),
      Bun.sleep(50).then(() => {
        throw new Error("liveness timed out");
      }),
    ]);
    expect(live.status).toBe(200);
  });

  test("management backend renders component failures and a global readiness alert", async () => {
    const snapshot: SystemHealthSnapshot = {
      status: "down",
      ready: false,
      checkedAt: 1_783_932_000_000,
      components: {
        feishu: {
          status: "down",
          summary: "消息消费者未就绪",
          details: { lastEventAt: 1_783_931_000_000 },
        },
      },
    };
    const healthApp = createWebApp({ engine, health: async () => snapshot });

    const page = await healthApp.request("/health");
    expect(page.status).toBe(200);
    const healthBody = await page.text();
    expect(healthBody).toContain("运行状态");
    expect(healthBody).toContain("消息消费者未就绪");

    const homeBody = await (await healthApp.request("/")).text();
    expect(homeBody).toContain("runtime-health-alert");
    expect(homeBody).toContain("/readyz");
  });

  test("managed service status exposes a guarded restart action", async () => {
    let restarts = 0;
    const snapshot: SystemHealthSnapshot = {
      status: "ok",
      ready: true,
      checkedAt: 1_783_932_000_000,
      components: {
        service: {
          status: "ok",
          summary: "LaunchAgent 托管运行（PID 7788）",
          details: { managed: true, pid: 7788, startedAt: 1_783_931_000_000 },
        },
      },
    };
    const managedApp = createWebApp({
      engine,
      health: async () => snapshot,
      onServiceRestart: () => { restarts += 1; },
    });

    const page = await managedApp.request("/health");
    const body = await page.text();
    expect(body).toContain("后台服务");
    expect(body).toContain("PID 7788");
    expect(body).toContain('action="/service/restart"');

    const restart = await managedApp.request("/service/restart", { method: "POST" });
    expect(restart.status).toBe(302);
    expect(restarts).toBe(1);

    const manualApp = createWebApp({
      engine,
      health: async () => ({
        ...snapshot,
        components: {
          service: { ...snapshot.components.service!, details: { managed: false, pid: 7788 } },
        },
      }),
      onServiceRestart: () => { restarts += 1; },
    });
    expect((await manualApp.request("/service/restart", { method: "POST" })).status).toBe(409);
    expect(restarts).toBe(1);
  });

  test("home lists spaces", async () => {
    const res = await app.request("/");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("team/oc_web");
    expect(body).toContain("homeagent");
  });

  test("space detail shows knowledge pages", async () => {
    const res = await app.request(`/spaces/${encodeURIComponent(SPACE)}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Alice");
    expect(body).toContain("知识页");
  });

  test("page view shows full content and metadata", async () => {
    const res = await app.request(`/spaces/${encodeURIComponent(SPACE)}/pages/${encodeURIComponent("entities/alice")}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Alice 负责后端服务");
    expect(body).toContain("爱丽丝"); // alias
    expect(body).toContain("raw-1"); // provenance
  });

  test("raw list shows captured entries", async () => {
    const res = await app.request(`/spaces/${encodeURIComponent(SPACE)}/raw`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("一条原始消息");
  });

  test("ask box renders a knowledge answer", async () => {
    // script routing + synthesis
    fake.onJSON((call) => {
      const props = (call.schema as { properties?: Record<string, unknown> }).properties ?? {};
      if ("relevant" in props) return { slugs: ["entities/alice"], relevant: true };
      if ("grounded" in props)
        return { answer: "后端由 Alice 负责。", grounded: true, usedSlugs: ["entities/alice"], gaps: [] };
      return {};
    });
    const res = await app.request(`/spaces/${encodeURIComponent(SPACE)}/ask?q=${encodeURIComponent("谁负责后端？")}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("后端由 Alice 负责");
    expect(body).toContain("知识库"); // source badge
    expect(body).toContain('value="helpful"');
    expect(body).toContain('value="unhelpful"');
    expect(body).toContain('value="citation_error"');
  });

  test("all ask feedback kinds are recorded and return to the rated answer", async () => {
    fake.onJSON((call) => {
      const props = (call.schema as { properties?: Record<string, unknown> }).properties ?? {};
      if ("relevant" in props) return { slugs: ["entities/alice"], relevant: true };
      return {
        answer: "后端由 Alice 负责。",
        grounded: true,
        usedSlugs: ["entities/alice"],
        gaps: [],
      };
    });
    for (const kind of ["helpful", "unhelpful", "citation_error"] as const) {
      const question = `谁负责后端？${kind}`;
      const ask = await app.request(
        `/spaces/${encodeURIComponent(SPACE)}/ask?q=${encodeURIComponent(question)}`,
      );
      const body = await ask.text();
      const traceId = body.match(/name="traceId" value="([^"]+)"/)?.[1];
      expect(traceId).toStartWith("answer_");
      const callsAfterAsk = fake.calls.length;

      const response = await app.request(`/spaces/${encodeURIComponent(SPACE)}/ask/feedback`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ traceId: traceId!, kind }),
      });
      expect(response.status).toBe(302);
      const location = response.headers.get("location")!;
      expect(location).toContain(`traceId=${encodeURIComponent(traceId!)}`);
      expect(engine.quality.feedbackFor(traceId!)).toEqual(
        expect.objectContaining({ kind }),
      );

      const returned = await app.request(location);
      const returnedBody = await returned.text();
      expect(returnedBody).toContain("后端由 Alice 负责");
      expect(returnedBody).toContain("本回答的反馈已记录");
      expect(fake.calls.length).toBe(callsAfterAsk);
    }
  });

  test("ask feedback rejects invalid, unknown, and cross-space traces", async () => {
    const invalid = await app.request(`/spaces/${encodeURIComponent(SPACE)}/ask/feedback`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ traceId: "answer_missing", kind: "invalid" }),
    });
    expect(invalid.status).toBe(400);

    const unknown = await app.request(`/spaces/${encodeURIComponent(SPACE)}/ask/feedback`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ traceId: "answer_missing", kind: "helpful" }),
    });
    expect(unknown.status).toBe(404);

    const trace = engine.quality.recordTrace({
      spaces: [SPACE],
      question: "cross space",
      outcome: "succeeded",
      source: "general",
      answer: "answer",
      citations: [],
      latencyMs: 1,
    });
    const other = "team/oc_other" as const;
    engine.ensureSpace(other);
    const crossSpace = await app.request(`/spaces/${encodeURIComponent(other)}/ask/feedback`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ traceId: trace.id, kind: "helpful" }),
    });
    expect(crossSpace.status).toBe(404);
  });

  test("quality workbench lists negative feedback with answer and citation context", async () => {
    const negative = engine.quality.recordTrace({
      spaces: [SPACE],
      question: "线上故障该找谁？",
      outcome: "succeeded",
      source: "knowledge",
      answer: "请联系 Alice。",
      citations: [{ slug: "entities/alice", title: "Alice" }],
      latencyMs: 80,
      createdAt: 1000,
    });
    engine.recordAnswerFeedback(
      negative.id,
      SPACE,
      "citation_error",
      "引用页面没有值班信息",
    );
    const helpful = engine.quality.recordTrace({
      spaces: [SPACE],
      question: "这条回答很好吗？",
      outcome: "succeeded",
      source: "general",
      answer: "很好。",
      citations: [],
      latencyMs: 20,
      createdAt: 2000,
    });
    engine.recordAnswerFeedback(helpful.id, SPACE, "helpful");

    const response = await app.request("/quality");
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("AI 质量反馈");
    expect(body).toContain("线上故障该找谁？");
    expect(body).toContain("请联系 Alice。");
    expect(body).toContain("引用有误");
    expect(body).toContain("引用页面没有值班信息");
    expect(body).toContain(
      `/spaces/${encodeURIComponent(SPACE)}/pages/${encodeURIComponent("entities/alice")}`,
    );
    expect(body).not.toContain("这条回答很好吗？");
  });

  test("quality workbench promotes one negative feedback into a calibration case", async () => {
    const trace = engine.quality.recordTrace({
      spaces: [SPACE],
      question: "谁负责线上值班？",
      outcome: "succeeded",
      source: "knowledge",
      answer: "请联系 Alice。",
      citations: [{ slug: "entities/alice", title: "Alice" }],
      latencyMs: 80,
    });
    engine.recordAnswerFeedback(trace.id, SPACE, "unhelpful", "缺少值班范围");

    const before = await (await app.request("/quality")).text();
    expect(before).toContain(`action="/quality/${encodeURIComponent(trace.id)}/promote"`);
    expect(before).toContain("加入待校准评测集");

    const invalid = await app.request(`/quality/${encodeURIComponent(trace.id)}/promote`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ curatorNote: "   " }),
    });
    expect(invalid.status).toBe(400);
    expect(engine.qualityEvaluationCases()).toEqual([]);

    const promoted = await app.request(`/quality/${encodeURIComponent(trace.id)}/promote`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ curatorNote: "补充值班范围后重跑" }),
    });
    expect(promoted.status).toBe(302);
    expect(engine.qualityEvaluationCases()).toEqual([
      expect.objectContaining({
        traceId: trace.id,
        curatorNote: "补充值班范围后重跑",
      }),
    ]);

    const after = await (await app.request(promoted.headers.get("location")!)).text();
    expect(after).toContain("已加入待校准评测集");
    expect(after).toContain("补充值班范围后重跑");
    const duplicate = await app.request(`/quality/${encodeURIComponent(trace.id)}/promote`, {
      method: "POST",
      body: new URLSearchParams({ curatorNote: "重复加入" }),
    });
    expect(duplicate.status).toBe(409);
  });

  test("quality workbench resolves feedback and keeps it in review history", async () => {
    const trace = engine.quality.recordTrace({
      spaces: [SPACE],
      question: "发布失败后重试几次？",
      outcome: "succeeded",
      source: "knowledge",
      answer: "重试一次。",
      citations: [{ slug: "entities/alice", title: "Alice" }],
      latencyMs: 50,
    });
    engine.recordAnswerFeedback(trace.id, SPACE, "unhelpful", "次数错误");

    const before = await (await app.request("/quality")).text();
    expect(before).toContain(`action="/quality/${encodeURIComponent(trace.id)}/resolve"`);

    const invalid = await app.request(`/quality/${encodeURIComponent(trace.id)}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ resolutionNote: "   " }),
    });
    expect(invalid.status).toBe(400);
    expect(engine.answerFeedbackReviews({ status: "open" })).toHaveLength(1);

    const resolved = await app.request(`/quality/${encodeURIComponent(trace.id)}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ resolutionNote: "发布策略页已改为重试两次" }),
    });
    expect(resolved.status).toBe(302);
    expect(engine.answerFeedbackReviews({ status: "resolved" })).toEqual([
      expect.objectContaining({
        trace: expect.objectContaining({ id: trace.id }),
        feedback: expect.objectContaining({ resolutionNote: "发布策略页已改为重试两次" }),
      }),
    ]);

    const openPage = await (await app.request(resolved.headers.get("location")!)).text();
    expect(openPage).not.toContain("发布失败后重试几次？");
    const history = await (await app.request("/quality?status=resolved")).text();
    expect(history).toContain("发布失败后重试几次？");
    expect(history).toContain("已解决");
    expect(history).toContain("发布策略页已改为重试两次");
    expect(history).not.toContain(`action="/quality/${encodeURIComponent(trace.id)}/resolve"`);

    const duplicate = await app.request(`/quality/${encodeURIComponent(trace.id)}/resolve`, {
      method: "POST",
      body: new URLSearchParams({ resolutionNote: "重复处理" }),
    });
    expect(duplicate.status).toBe(409);
  });

  test("quality workbench links citations to the space that owns the page", async () => {
    const personal = "personal/ou_quality" as const;
    await engine.upsertPage(
      personal,
      page("entities/bob", "Bob", "Bob 负责线上值班。"),
    );
    const trace = engine.quality.recordTrace({
      spaces: [SPACE, personal],
      question: "线上值班找谁？",
      outcome: "succeeded",
      source: "knowledge",
      answer: "请联系 Bob。",
      citations: [{ slug: "entities/bob", title: "Bob" }],
      latencyMs: 60,
    });
    engine.recordAnswerFeedback(trace.id, SPACE, "citation_error", "核对引用");

    const body = await (await app.request("/quality")).text();
    expect(body).toContain(
      `/spaces/${encodeURIComponent(personal)}/pages/${encodeURIComponent("entities/bob")}`,
    );
    expect(body).not.toContain(
      `/spaces/${encodeURIComponent(SPACE)}/pages/${encodeURIComponent("entities/bob")}`,
    );
  });

  test("quality workbench shows every candidate space for an ambiguous legacy citation", async () => {
    const personal = "personal/ou_quality" as const;
    await engine.upsertPage(
      personal,
      page("entities/alice", "Alice（个人）", "个人空间中的 Alice。"),
    );
    const trace = engine.quality.recordTrace({
      spaces: [SPACE, personal],
      question: "这里的 Alice 是谁？",
      outcome: "succeeded",
      source: "knowledge",
      answer: "请查看 Alice。",
      citations: [{ slug: "entities/alice", title: "Alice" }],
      latencyMs: 60,
    });
    engine.recordAnswerFeedback(trace.id, SPACE, "citation_error", "同名页面需人工确认");

    const body = await (await app.request("/quality")).text();
    expect(body).toContain(
      `/spaces/${encodeURIComponent(SPACE)}/pages/${encodeURIComponent("entities/alice")}`,
    );
    expect(body).toContain(
      `/spaces/${encodeURIComponent(personal)}/pages/${encodeURIComponent("entities/alice")}`,
    );
    expect(body).toContain("同名引用，候选空间");
  });

  test("quality workbench exports calibration cases as local JSON", async () => {
    const trace = engine.quality.recordTrace({
      spaces: [SPACE],
      question: "线上故障该找谁？",
      outcome: "succeeded",
      source: "knowledge",
      answer: "请联系 Alice。",
      citations: [{ slug: "entities/alice", title: "Alice" }],
      latencyMs: 80,
    });
    engine.recordAnswerFeedback(trace.id, SPACE, "citation_error", "页面缺少值班依据");
    engine.promoteAnswerFeedback(trace.id, "确认正确引用后加入固定集");

    const page = await (await app.request("/quality")).text();
    expect(page).toContain("1 条待校准评测案例");
    expect(page).toContain('href="/quality/evaluation-cases.json"');

    const response = await app.request("/quality/evaluation-cases.json");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain(
      "homeagent-quality-evaluation-candidates.json",
    );
    expect(await response.json()).toEqual({
      version: "homeagent.quality-evaluation-candidates.v1",
      exportedAt: expect.any(Number),
      cases: [
        expect.objectContaining({
          traceId: trace.id,
          question: "线上故障该找谁？",
          feedbackKind: "citation_error",
          curatorNote: "确认正确引用后加入固定集",
        }),
      ],
    });
  });

  test("dream POST triggers a cycle and redirects", async () => {
    fake.queueJSON({ operations: [], skippedRawIds: [] });
    const res = await app.request(`/spaces/${encodeURIComponent(SPACE)}/dream`, { method: "POST" });
    expect([302, 303]).toContain(res.status);
  });

  test("quarantine page lists a failure and retries only its sources", async () => {
    const rawId = await engine.remember({
      space: SPACE,
      source: "message",
      content: "后台恢复测试",
    });
    fake.queueJSON({
      operations: [{ type: "concept", name: "web-retry", title: "Web Retry", rawIds: [rawId] }],
      skippedRawIds: [],
    });
    fake.queueJSON({ title: "Web Retry", summary: "", content: "" });
    await engine.runDreamCycle(SPACE, { rawIds: [rawId] });
    const record = (await engine.listQuarantines(SPACE))[0]!;

    const spacePage = await app.request(`/spaces/${encodeURIComponent(SPACE)}`);
    expect(await spacePage.text()).toContain("提炼失败（1）");

    const page = await app.request(`/spaces/${encodeURIComponent(SPACE)}/quarantine`);
    expect(page.status).toBe(200);
    const body = await page.text();
    expect(body).toContain("提炼失败恢复");
    expect(body).toContain("concepts/web-retry");
    expect(body).toContain("generated page has empty content");
    expect(body).toContain("1 条原始来源");

    fake.queueJSON({
      operations: [{ type: "concept", name: "web-retry", title: "Web Retry", rawIds: [rawId] }],
      skippedRawIds: [],
    });
    fake.queueJSON({
      title: "Web Retry",
      summary: "后台恢复成功",
      aliases: [],
      tags: [],
      links: [],
      content: "# Web Retry\n\n后台恢复成功。\n",
    });
    const retry = await app.request(
      `/spaces/${encodeURIComponent(SPACE)}/quarantine/${encodeURIComponent(record.id)}/retry`,
      { method: "POST" },
    );
    expect([302, 303]).toContain(retry.status);
    expect(decodeURIComponent(retry.headers.get("location") ?? "")).toContain("恢复成功");
    expect(await engine.listQuarantines(SPACE)).toEqual([]);
    expect(await engine.getPage(SPACE, "concepts/web-retry")).not.toBeNull();
  });

  test("quarantine page retries the current failure snapshot in one batch", async () => {
    const first = await engine.remember({ space: SPACE, source: "message", content: "批量失败一" });
    const second = await engine.remember({ space: SPACE, source: "message", content: "批量失败二" });
    fake.queueJSON({
      operations: [
        { type: "concept", name: "web-batch-one", title: "Batch One", rawIds: [first] },
        { type: "concept", name: "web-batch-two", title: "Batch Two", rawIds: [second] },
      ],
      skippedRawIds: [],
    });
    fake.queueJSON({ title: "Batch One", summary: "", content: "" });
    fake.queueJSON({ title: "Batch Two", summary: "", content: "" });
    await engine.runDreamCycle(SPACE, { rawIds: [first, second] });
    expect(await engine.listQuarantines(SPACE)).toHaveLength(2);

    fake.onJSON((options) => {
      const rawIds = [first, second].filter((id) => options.prompt?.includes(id));
      return { operations: [], skippedRawIds: rawIds };
    });
    const retry = await app.request(`/spaces/${encodeURIComponent(SPACE)}/quarantine/retry-all`, {
      method: "POST",
    });

    expect([302, 303]).toContain(retry.status);
    expect(decodeURIComponent(retry.headers.get("location") ?? "")).toContain(
      "已重试 2 条：恢复成功 2 条，仍失败 0 条",
    );
    expect(await engine.listQuarantines(SPACE)).toEqual([]);
  });

  test("quarantine retry rejects an unsafe or unknown record id", async () => {
    const response = await app.request(
      `/spaces/${encodeURIComponent(SPACE)}/quarantine/${encodeURIComponent("../../settings.json")}/retry`,
      { method: "POST" },
    );
    expect(response.status).toBe(404);

    const malformedEncoding = await app.request(
      `/spaces/${encodeURIComponent(SPACE)}/quarantine/%25/retry`,
      { method: "POST" },
    );
    expect(malformedEncoding.status).toBe(404);
  });

  test("unknown space is 404", async () => {
    const res = await app.request(`/spaces/${encodeURIComponent("team/nope")}`);
    expect(res.status).toBe(404);
  });

  test("logs page renders", async () => {
    const res = await app.request("/logs");
    expect(res.status).toBe(200);
  });
});

describe("management backend (read-write)", () => {
  test("data governance exports, deletes, and restores a complete space", async () => {
    const governance = await app.request("/governance");
    expect(governance.status).toBe(200);
    const governanceBody = await governance.text();
    expect(governanceBody).toContain("数据治理");
    expect(governanceBody).toContain("原始消息保留");
    expect(governanceBody).toContain("homeagent.space v1/v2/v3/v4/v5/v6");

    const exported = await app.request(`/spaces/${encodeURIComponent(SPACE)}/export`);
    expect(exported.status).toBe(200);
    expect(exported.headers.get("content-disposition")).toContain("attachment");
    const archiveText = await exported.text();
    expect(JSON.parse(archiveText)).toEqual(
      expect.objectContaining({
        format: "homeagent.space",
        version: 6,
        learning: { plans: [], sources: [], sessions: [] },
        governanceAudit: [],
        taskRuns: [],
      }),
    );

    const deleted = await app.request(`/spaces/${encodeURIComponent(SPACE)}/delete`, {
      method: "POST",
    });
    expect([302, 303]).toContain(deleted.status);
    expect(engine.registry.has(SPACE)).toBe(false);

    const form = new FormData();
    form.set("archive", new File([archiveText], "space.json", { type: "application/json" }));
    const restored = await app.request("/governance/restore", { method: "POST", body: form });
    expect([302, 303]).toContain(restored.status);
    expect(engine.registry.has(SPACE)).toBe(true);
    expect(await engine.getPage(SPACE, "entities/alice")).not.toBeNull();

    const pruned = await app.request("/governance/prune", { method: "POST" });
    expect([302, 303]).toContain(pruned.status);
  });

  test("data governance rejects an unsafe archive without changing spaces", async () => {
    const form = new FormData();
    form.set(
      "archive",
      new File(
        [
          JSON.stringify({
            format: "homeagent.space",
            version: 1,
            exportedAt: 1,
            space: { id: "team/unsafe", createdAt: 1 },
            purpose: "x",
            schema: "x",
            pages: [{ slug: "../../outside", type: "concept" }],
            raw: [],
            retractions: [],
            tasks: [],
          }),
        ],
        "unsafe.json",
        { type: "application/json" },
      ),
    );

    const res = await app.request("/governance/restore", { method: "POST", body: form });
    expect([302, 303]).toContain(res.status);
    expect(decodeURIComponent(res.headers.get("location") ?? "")).toContain("恢复失败");
    expect(engine.registry.has("team/unsafe")).toBe(false);
  });

  test("nav rail exposes the mew-style sections", async () => {
    const body = await (await app.request("/")).text();
    expect(body).toContain("Agents");
    expect(body).toContain("飞书连接");
    expect(body).toContain("设置");
  });

  test("creating an agent via POST persists and redirects to its editor", async () => {
    const form = new URLSearchParams({ name: "知识助手", instruction: "简洁作答", model: "", provider: "claude", visibility: "Team" });
    const res = await app.request("/agents", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    expect([302, 303]).toContain(res.status);
    const agents = engine.agents.list();
    expect(agents.length).toBe(1);
    expect(agents[0]!.name).toBe("知识助手");
    // the agent editor renders the saved instruction
    const view = await (await app.request(`/agents/${encodeURIComponent(agents[0]!.id)}`)).text();
    expect(view).toContain("简洁作答");
  });

  test("creating a Codex agent persists its exact model and reasoning effort", async () => {
    const form = new URLSearchParams({
      name: "深度助手",
      provider: "codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
    });
    const response = await app.request("/agents", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });

    expect([302, 303]).toContain(response.status);
    const agent = engine.agents.list().find((item) => item.name === "深度助手");
    expect(agent?.model).toBe("gpt-5.6-sol");
    expect(agent?.reasoningEffort).toBe("high");

    const view = await (await app.request(`/agents/${encodeURIComponent(agent!.id)}`)).text();
    expect(view).toContain('name="reasoningEffort"');
    expect(view).toContain('value="high" selected');
    expect(view).toContain("仅 Codex");
  });

  test("switching away from Codex clears the disabled reasoning field", async () => {
    const created = engine.agents.create({
      name: "切换 Provider",
      provider: "codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
    });

    const response = await app.request(`/agents/${encodeURIComponent(created.id)}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        name: created.name,
        provider: "claude",
        model: "sonnet",
        visibility: "Team",
        permission: "read-only",
      }).toString(),
    });

    expect([302, 303]).toContain(response.status);
    expect(engine.agents.get(created.id)).toEqual(expect.objectContaining({
      provider: "claude",
      model: "sonnet",
      reasoningEffort: "",
    }));
  });

  test("rejects a reasoning effort unsupported by the selected Codex model", async () => {
    const form = new URLSearchParams({
      name: "旧模型助手",
      provider: "codex",
      model: "gpt-5.5",
      reasoningEffort: "max",
    });
    const response = await app.request("/agents", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });

    expect(response.status).toBe(422);
    expect(engine.agents.list().find((item) => item.name === "旧模型助手")).toBeUndefined();
    const body = await response.text();
    expect(body).toContain("模型 gpt-5.5 不支持该推理强度");
    expect(body).toContain("旧模型助手");
  });

  test("uses the inherited global Codex model to offer reasoning efforts", async () => {
    saveSettings({ defaultProvider: "codex", defaultModel: "gpt-5.6-sol" }, dir);
    const form = new URLSearchParams({
      name: "继承 Sol",
      provider: "codex",
      model: "",
      reasoningEffort: "max",
    });
    const response = await app.request("/agents", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });

    expect([302, 303]).toContain(response.status);
    const agent = engine.agents.list().find((item) => item.name === "继承 Sol");
    expect(agent?.reasoningEffort).toBe("max");
    const view = await (await app.request(`/agents/${encodeURIComponent(agent!.id)}`)).text();
    expect(view).toContain('value="max" selected');
  });

  test("does not offer inherited reasoning efforts to an unknown custom model", async () => {
    saveSettings({ defaultProvider: "codex", defaultModel: "gpt-5.6-sol" }, dir);
    const response = await app.request("/agents", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        name: "自定义模型",
        provider: "codex",
        model: "gpt-5.6-custom",
        reasoningEffort: "max",
      }).toString(),
    });

    expect(response.status).toBe(422);
    expect(engine.agents.list().find((item) => item.name === "自定义模型")).toBeUndefined();
    const view = await response.text();
    expect(view).toContain("模型 gpt-5.6-custom 不支持该推理强度");
    expect(view).toContain('"gpt-5.6-custom":[]');
  });

  test("an existing custom model survives an unrelated edit", async () => {
    const created = engine.agents.create({
      name: "旧自定义模型",
      provider: "codex",
      model: "codex-custom",
    });
    const response = await app.request(`/agents/${encodeURIComponent(created.id)}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        name: "旧自定义模型（已改名）",
        provider: "codex",
        model: "codex-custom",
        visibility: "Team",
        permission: "read-only",
      }).toString(),
    });

    expect([302, 303]).toContain(response.status);
    expect(engine.agents.get(created.id)).toEqual(expect.objectContaining({
      name: "旧自定义模型（已改名）",
      model: "codex-custom",
    }));
  });

  test("new Agent page suggests the next provider-specific name without persisting it", async () => {
    engine.agents.create({ name: "Claude Code Agent", provider: "claude" });
    engine.agents.create({ name: "Claude Code Agent (2)", provider: "claude" });

    const response = await app.request("/agents/new");
    expect(response.status).toBe(200);
    const body = await response.text();

    expect(body).toContain('class="agent-workbench has-editor is-create"');
    expect(body).toContain('value="Claude Code Agent (3)"');
    expect(body).toContain('data-name-mode="automatic"');
    expect(body).not.toContain('data-pane="agent-inspector"');
    expect(engine.agents.list()).toHaveLength(2);
  });

  test("agents page shows detected providers; unavailable ones are disabled", async () => {
    const body = await (await app.request("/agents/new")).text();
    expect(body).toContain("Claude Code");
    expect(body).toContain("TRAE CLI");
    // codex is unavailable in the stub -> rendered disabled with reason
    expect(body).toContain("不可用");
    expect(body).toContain("node not found");
  });

  test("agents page embeds a per-provider model catalog for the Model dropdown", async () => {
    const body = await (await app.request("/agents/new")).text();
    // the client-side catalog carries each provider's models (mew: model list
    // changes with provider)
    expect(body).toContain("openrouter-3o"); // trae-cli
    expect(body).toContain("gpt-5.5"); // codex
    expect(body).toContain("sonnet"); // claude
    expect(body).toContain("agent-provider"); // the wired <select> ids
    expect(body).toContain("agent-model");
  });

  test("agent editor explains the active task-execution boundaries", async () => {
    const body = await (await app.request("/agents/new")).text();
    expect(body).toContain("Workdir");
    expect(body).toContain("Permission");
    expect(body).toContain("Skills");
    expect(body).toContain("仅影响研究任务");
    expect(body).toContain("可写与完全访问权限必填");
    expect(body).not.toContain("Device");
    expect(body).not.toContain("Repositories");
  });

  test("agents index selects the first Agent and the editor shows its bindings", async () => {
    const first = engine.agents.create({ name: "首选助手", provider: "claude" });
    engine.updateSpaceMeta(SPACE, { agentId: first.id, name: "产品讨论群" });

    const index = await app.request("/agents");
    expect([302, 303]).toContain(index.status);
    expect(index.headers.get("location")).toBe(`/agents/${encodeURIComponent(first.id)}`);

    const body = await (await app.request(index.headers.get("location")!)).text();
    expect(body).toContain('data-pane="agent-list"');
    expect(body).toContain('data-pane="agent-editor"');
    expect(body).toContain('data-pane="agent-inspector"');
    expect(body).toContain("产品讨论群");
    expect(body).toContain("CLI 就绪");

    const mobileList = await app.request("/agents?view=list");
    expect(mobileList.status).toBe(200);
    const mobileListBody = await mobileList.text();
    expect(mobileListBody).toContain("首选助手");
    expect(mobileListBody).toContain("选择一个 Agent");
  });

  test("an incompatible visibility change is rejected with preserved field values", async () => {
    const created = engine.agents.create({
      name: "团队助手",
      provider: "claude",
      visibility: "Team",
    });
    engine.updateSpaceMeta(SPACE, { agentId: created.id });

    const response = await app.request(`/agents/${encodeURIComponent(created.id)}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        name: "团队助手（改名）",
        provider: "claude",
        visibility: "Personal",
        permission: "read-only",
      }).toString(),
    });

    expect(response.status).toBe(409);
    expect(engine.agents.get(created.id)?.visibility).toBe("Team");
    const body = await response.text();
    expect(body).toContain("当前绑定与新的 Visibility 不兼容");
    expect(body).toContain("团队助手（改名）");
    expect(body).toContain('value="Personal" selected');
  });

  test("creating an agent persists task execution fields (workdir/permission/skills)", async () => {
    const form = new URLSearchParams({
      name: "任务助手",
      provider: "claude",
      permission: "write",
      workdir: dir,
      skills: "code-review, summarize",
    });
    const res = await app.request("/agents", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    expect([302, 303]).toContain(res.status);
    const created = engine.agents.list().find((a) => a.name === "任务助手");
    expect(created?.permission).toBe("write");
    expect(created?.workdir).toBe(dir);
    expect(created?.skills).toEqual(["code-review", "summarize"]);
  });

  test("agent validation rejects a missing Workdir before persistence", async () => {
    const missing = join(dir, "missing-workdir");
    const response = await app.request("/agents", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        name: "无效目录助手",
        provider: "claude",
        permission: "write",
        workdir: missing,
      }).toString(),
    });

    expect(response.status).toBe(422);
    expect(engine.agents.list().find((item) => item.name === "无效目录助手"))
      .toBeUndefined();
    const body = await response.text();
    expect(body).toContain("Workdir 不存在");
    expect(body).toContain('value="无效目录助手"');
    expect(body).toContain(`value="${missing}"`);
    expect(body).toContain('data-name-mode="manual"');
    expect(body).toContain('<details class="agent-task-execution" open>');
  });

  test("creating an agent with a local CLI provider persists that provider", async () => {
    const form = new URLSearchParams({ name: "海盗", instruction: "Arrr", model: "", provider: "claude", visibility: "Team" });
    const res = await app.request("/agents", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    expect([302, 303]).toContain(res.status);
    const created = engine.agents.list().find((a) => a.name === "海盗");
    expect(created?.provider).toBe("claude");
  });

  test("editing then deleting an agent works", async () => {
    const created = engine.agents.create({ name: "Temp", model: "" });
    const edit = new URLSearchParams({ name: "Renamed", instruction: "x", model: "sonnet", visibility: "Team" });
    const r1 = await app.request(`/agents/${encodeURIComponent(created.id)}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: edit.toString(),
    });
    expect([302, 303]).toContain(r1.status);
    expect(engine.agents.get(created.id)?.name).toBe("Renamed");

    const r2 = await app.request(`/agents/${encodeURIComponent(created.id)}/delete`, { method: "POST" });
    expect([302, 303]).toContain(r2.status);
    expect(engine.agents.has(created.id)).toBe(false);
  });

  test("deleting an Agent clears its bindings before falling back to the default AI", async () => {
    const created = engine.agents.create({ name: "待删除", provider: "claude" });
    engine.updateSpaceMeta(SPACE, { agentId: created.id });

    const response = await app.request(
      `/agents/${encodeURIComponent(created.id)}/delete`,
      { method: "POST" },
    );

    expect([302, 303]).toContain(response.status);
    expect(engine.agents.has(created.id)).toBe(false);
    expect(engine.registry.get(SPACE)?.agentId).toBeUndefined();
    expect(decodeURIComponent(response.headers.get("location") ?? ""))
      .toContain("已解除 1 个空间绑定");
  });

  test("integrations lists team groups and binds per-group settings", async () => {
    const agent = engine.agents.create({ name: "群助手", model: "" });
    engine.agents.create({ name: "仅个人可见助手", model: "", visibility: "Personal" });
    const listing = await (await app.request("/integrations")).text();
    expect(listing).toContain("飞书连接");
    expect(listing).toContain('action="/setup/feishu/automatic"');
    expect(listing).toContain("已连接群聊");
    expect(listing).toContain(SPACE); // the seeded team space
    expect(listing).toContain('action="/integrations/groups/team%2Foc_web"');
    expect(listing).toContain("群助手");
    expect(listing).not.toContain("仅个人可见助手");
    expect(listing).toContain('name="participationLevel"');
    expect(listing).toContain("稳重");
    expect(listing).toContain("均衡");
    expect(listing).toContain("积极");
    expect(listing).toContain("活跃度越高");
    expect(listing).toContain("敏感权限已在创建时申请");
    expect(listing).toContain("若企业尚未批准");

    const form = new URLSearchParams({
      name: "研发群",
      agentId: agent.id,
      participationLevel: "active",
    });
    form.append("replyInThread", "on");
    const res = await app.request(`/integrations/groups/${encodeURIComponent(SPACE)}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    expect([302, 303]).toContain(res.status);
    const meta = engine.registry.get(SPACE);
    expect(meta?.name).toBe("研发群");
    expect(meta?.agentId).toBe(agent.id);
    expect(meta?.replyInThread).toBe(true);
    expect(meta?.participationLevel).toBe("active");
    expect(meta?.mentionsOnly).toBe(true);
  });

  test("integration connection page discovers and explicitly connects a Bot-visible group", async () => {
    const larkSetup = {
      status: async () => ({
        state: "ready" as const,
        verified: true,
        appId: "cli_current",
        brand: "feishu" as const,
        botName: "HomeAgent",
        botOpenId: "ou_bot",
        message: "ready",
      }),
      configure: async () => {
        throw new Error("not used");
      },
      listBotChats: async () => [
        { chatId: "oc_web", name: "Already connected" },
        { chatId: "oc_new", name: "New product group" },
      ],
      getBotChat: async (chatId: string) => ({
        chatId,
        name: "New product group",
      }),
      fullGroupMessageCapability: async () => "available" as const,
    };
    const service = new FeishuIntegrationService({
      engine,
      larkSetup,
    });
    const integrationApp = createWebApp({
      engine,
      larkSetup,
      feishuIntegration: service,
      detectProviders: async () => [],
      providerModels: async () => ({}),
    });

    const page = await (await integrationApp.request(
      "/integrations/groups/connect",
    )).text();
    expect(page).toContain("连接飞书群");
    expect(page).toContain("New product group");
    expect(page).not.toContain("Already connected");

    const response = await integrationApp.request(
      "/integrations/groups/connect",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          chatId: "oc_new",
          responseMode: "smart",
          participationLevel: "balanced",
          replyInThread: "on",
        }).toString(),
      },
    );

    expect([302, 303]).toContain(response.status);
    expect(engine.feishuBindings.activeByChatId("oc_new")).toMatchObject({
      responseMode: "smart",
      replyInThread: true,
    });

    const integrations = await (await integrationApp.request("/integrations")).text();
    expect(integrations).toContain("FEISHU CONTROL CENTER");
    expect(integrations).toContain("New product group");
    expect(integrations).toContain('name="responseMode"');
    expect(integrations).toContain(
      'formaction="/integrations/groups/team%2Foc_new/disconnect"',
    );

    const update = await integrationApp.request(
      `/integrations/groups/${encodeURIComponent("team/oc_new")}`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          name: "Renamed group",
          responseMode: "all_messages",
          participationLevel: "balanced",
        }).toString(),
      },
    );
    expect([302, 303]).toContain(update.status);
    expect(engine.feishuBindings.activeByChatId("oc_new")).toMatchObject({
      responseMode: "all_messages",
      replyInThread: false,
    });
    expect(engine.registry.get("team/oc_new")?.name).toBe("Renamed group");

    const disconnect = await integrationApp.request(
      `/integrations/groups/${encodeURIComponent("team/oc_new")}/disconnect`,
      { method: "POST" },
    );
    expect([302, 303]).toContain(disconnect.status);
    expect(engine.feishuBindings.getByChatId("oc_new")?.state)
      .toBe("disconnected");
    expect(engine.registry.has("team/oc_new")).toBeTrue();
  });

  test("Bot disconnect is local and verification clears the disable marker", async () => {
    const larkSetup = {
      status: async () => ({
        state: "ready" as const,
        verified: true,
        appId: "cli_current",
        brand: "feishu" as const,
        botName: "HomeAgent",
        botOpenId: "ou_bot",
        message: "ready",
      }),
      configure: async () => {
        throw new Error("not used");
      },
      fullGroupMessageCapability: async () => "available" as const,
    };
    let disabled = 0;
    const service = new FeishuIntegrationService({
      engine,
      larkSetup,
      persistConnectionDisabledAppId: (appId) => {
        saveSettings({ feishuConnectionDisabledAppId: appId }, dir);
      },
      disableRuntime: () => {
        disabled += 1;
      },
    });
    const integrationApp = createWebApp({
      engine,
      larkSetup,
      feishuIntegration: service,
    });

    const disconnect = await integrationApp.request(
      "/integrations/bot/disconnect",
      { method: "POST" },
    );
    expect([302, 303]).toContain(disconnect.status);
    expect(disabled).toBe(1);
    expect(readSettings(dir).feishuConnectionDisabledAppId)
      .toBe("cli_current");
    expect(engine.feishuBindings.getByChatId("oc_web")?.state)
      .toBe("needs_reconnect");

    const verify = await integrationApp.request(
      "/integrations/bot/verify",
      { method: "POST" },
    );
    expect([302, 303]).toContain(verify.status);
    expect(readSettings(dir).feishuConnectionDisabledAppId).toBe("");
    expect(readSettings(dir)).toMatchObject({
      feishuBotName: "HomeAgent",
      feishuBotOpenId: "ou_bot",
    });
  });

  test("a Personal Agent cannot be bound to a team integration", async () => {
    const personal = engine.agents.create({
      name: "个人助手",
      visibility: "Personal",
    });

    const response = await app.request(`/integrations/groups/${encodeURIComponent(SPACE)}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        name: "研发群",
        agentId: personal.id,
      }).toString(),
    });

    expect([302, 303]).toContain(response.status);
    expect(response.headers.get("location")).toContain("Agent%20Visibility");
    expect(engine.registry.get(SPACE)?.agentId).toBeUndefined();
  });

  test("a personal space can bind only a Personal Agent from its detail page", async () => {
    const personalSpace = "personal/ou_web" as const;
    engine.ensureSpace(personalSpace);
    const team = engine.agents.create({ name: "仅群可见助手", visibility: "Team" });
    const personal = engine.agents.create({ name: "仅个人可见助手", visibility: "Personal" });

    const detail = await (await app.request(`/spaces/${encodeURIComponent(personalSpace)}`)).text();
    expect(detail).toContain("个人空间 Agent");
    expect(detail).toContain(personal.name);
    expect(detail).not.toContain(team.name);

    const bound = await app.request(`/spaces/${encodeURIComponent(personalSpace)}/agent`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ agentId: personal.id }).toString(),
    });
    expect([302, 303]).toContain(bound.status);
    expect(engine.agentForSpace(personalSpace)?.id).toBe(personal.id);

    const rejected = await app.request(`/spaces/${encodeURIComponent(personalSpace)}/agent`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ agentId: team.id }).toString(),
    });
    expect([302, 303]).toContain(rejected.status);
    expect(rejected.headers.get("location")).toContain("Visibility");
    expect(engine.agentForSpace(personalSpace)?.id).toBe(personal.id);
  });

  test("integration page makes official one-click creation the primary bot action", async () => {
    const idle = {
      state: "idle" as const,
      brand: "feishu" as const,
      message: "尚未开始创建飞书应用",
    };
    const setupApp = createWebApp({
      engine,
      detectProviders: async () => [],
      providerModels: async () => ({}),
      larkSetup: {
        status: async () => ({ state: "unconfigured", verified: false, message: "missing" }),
        configure: async () => { throw new Error("unused"); },
        startAutomatic: async () => idle,
        provisioningStatus: () => idle,
      },
    });

    const page = await (await setupApp.request("/integrations")).text();
    expect(page).toContain("飞书机器人");
    expect(page).toContain("一键创建并连接");
    expect(page).toContain('action="/setup/feishu/automatic"');
    expect(page).toContain('name="returnTo" value="/integrations"');
    expect(page.indexOf("一键创建并连接")).toBeLessThan(page.indexOf("手动连接已有应用"));
    expect(page).toContain("飞书群聊");
    expect(page).toContain("首次确认会申请完整权限");
    expect(page).toContain("群消息读取、附件、表情");
    expect(page).toContain("两条事件订阅");
    expect(page).toContain("无需事后进入开放平台补配置");
    expect(page).toContain("企业管理员可能需要在这次确认中批准敏感权限");
  });

  test("manual existing-app setup offers Lark and preserves that brand when configuring", async () => {
    const configured: { appId: string; appSecret: string; brand: string }[] = [];
    const setupApp = createWebApp({
      engine,
      detectProviders: async () => [],
      providerModels: async () => ({}),
      larkSetup: {
        status: async () => ({ state: "unconfigured", verified: false, brand: "lark", message: "missing" }),
        configure: async (input) => {
          configured.push(input);
          return {
            state: "ready",
            verified: true,
            appId: input.appId,
            brand: input.brand,
            botName: "Lark Bot",
            botOpenId: "ou_lark",
            message: "Bot identity: ready",
          };
        },
      },
    });

    const page = await (await setupApp.request("/integrations")).text();
    expect(page).toContain('<select name="brand">');
    expect(page).toContain('<option value="feishu">飞书</option>');
    expect(page).toContain('<option value="lark" selected>Lark</option>');

    const response = await setupApp.request("/integrations/bot/setup", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        appId: "cli_lark",
        appSecret: "lark-secret",
        brand: "lark",
      }).toString(),
    });

    expect([302, 303]).toContain(response.status);
    expect(configured).toEqual([
      { appId: "cli_lark", appSecret: "lark-secret", brand: "lark" },
    ]);
  });

  test("integration page shows a safe retry after Feishu creation fails", async () => {
    const failed = {
      state: "failed" as const,
      brand: "feishu" as const,
      verificationUrl: "https://attacker.example/page/launcher?user_code=LEAK",
      message: "创建失败，请重试",
    };
    const setupApp = createWebApp({
      engine,
      detectProviders: async () => [],
      providerModels: async () => ({}),
      larkSetup: {
        status: async () => ({ state: "unconfigured", verified: false, message: "raw-status-secret" }),
        configure: async () => { throw new Error("unused"); },
        startAutomatic: async () => failed,
        provisioningStatus: () => failed,
      },
    });

    const page = await (await setupApp.request("/integrations")).text();
    expect(page).toContain("创建失败，请重试");
    expect(page).toContain("一键创建并连接");
    expect(page).not.toContain("attacker.example");
    expect(page).not.toContain("LEAK");
    expect(page).not.toContain("raw-status-secret");
  });

  test("integration setup verifies app credentials and discovers the bot identity", async () => {
    const configured: { appId: string; appSecret: string; brand: string }[] = [];
    const setupApp = createWebApp({
      engine,
      detectProviders: async () => [],
      providerModels: async () => ({}),
      larkSetup: {
        status: async () => ({
          state: "ready",
          verified: true,
          appId: "cli_new",
          brand: "feishu",
          botName: "新机器人",
          botOpenId: "ou_new",
          message: "Bot identity: ready",
        }),
        configure: async (input) => {
          configured.push(input);
          return {
            state: "ready",
            verified: true,
            appId: input.appId,
            brand: input.brand,
            botName: "新机器人",
            botOpenId: "ou_new",
            message: "Bot identity: ready",
          };
        },
      },
    });

    const form = new URLSearchParams({
      appId: "cli_new",
      appSecret: "top-secret-value",
      brand: "feishu",
    });
    const response = await setupApp.request("/integrations/bot/setup", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });

    expect([302, 303]).toContain(response.status);
    expect(configured).toEqual([
      { appId: "cli_new", appSecret: "top-secret-value", brand: "feishu" },
    ]);
    expect(readSettings(dir)).toEqual(
      expect.objectContaining({ feishuBotName: "新机器人", feishuBotOpenId: "ou_new" }),
    );
    expect(JSON.stringify(readSettings(dir))).not.toContain("top-secret-value");

    const page = await (await setupApp.request("/integrations")).text();
    expect(page).toContain("创建并切换机器人");
    expect(page).toContain("新机器人");
    expect(page).toContain("ou_new");
    expect(page).toContain('<span class="muted">待启用</span>');
    expect(page).not.toContain("⌄");
    expect(page).not.toContain("top-secret-value");
  });

  test("integration setup sends a real test message to a bound group", async () => {
    const sent: { chatId: string; text: string }[] = [];
    const setupApp = createWebApp({
      engine,
      detectProviders: async () => [],
      providerModels: async () => ({}),
      onIntegrationTest: async (chatId, text) => {
        sent.push({ chatId, text });
      },
    });

    const response = await setupApp.request(
      `/integrations/groups/${encodeURIComponent(SPACE)}/test`,
      { method: "POST" },
    );

    expect([302, 303]).toContain(response.status);
    expect(sent).toEqual([
      {
        chatId: "oc_web",
        text: expect.stringContaining("配置测试成功"),
      },
    ]);
    expect(response.headers.get("location")).toContain(encodeURIComponent("测试消息已发送"));
  });

  test("integration setup can re-verify an existing lark-cli profile without a secret", async () => {
    const setupApp = createWebApp({
      engine,
      detectProviders: async () => [],
      providerModels: async () => ({}),
      larkSetup: {
        status: async () => ({
          state: "ready",
          verified: true,
          appId: "cli_existing",
          brand: "feishu",
          botName: "现有机器人",
          botOpenId: "ou_existing",
          message: "Bot identity: ready",
        }),
        configure: async () => {
          throw new Error("not expected");
        },
      },
    });

    const response = await setupApp.request("/integrations/bot/verify", { method: "POST" });

    expect([302, 303]).toContain(response.status);
    expect(readSettings(dir)).toEqual(
      expect.objectContaining({
        feishuBotName: "现有机器人",
        feishuBotOpenId: "ou_existing",
      }),
    );
    expect(response.headers.get("location")).toContain(encodeURIComponent("Bot 身份已同步"));
  });

  test("integration setup shows whether required Feishu event consumers are ready", async () => {
    const setupApp = createWebApp({
      engine,
      detectProviders: async () => [],
      providerModels: async () => ({}),
      feishuRuntime: () => ({
        ready: true,
        consumers: [
          { key: "im.message.receive_v1", state: "ready" },
          { key: "im.chat.member.bot.added_v1", state: "ready" },
        ],
      }),
    });

    const page = await (await setupApp.request("/integrations")).text();

    expect(page).toContain("消息监听已就绪");
    expect(page).toContain("首次确认会申请完整权限");
    expect(page).toContain("手动连接已有应用时仍需自行确认权限");
    expect(page).toContain("若一键创建未完成，请回到上方重试");
    expect(page).toContain("只有手动应用缺少配置时，才需要在对应开发者后台补齐权限和事件订阅");
    expect(page).not.toContain("权限和事件订阅会由飞书自动配置");
    expect(page).not.toContain("im.message.receive_v1");
    expect(page).not.toContain("im.chat.member.bot.added_v1");
  });

  test("integration setup surfaces failed Feishu consumers with a recovery action", async () => {
    const setupApp = createWebApp({
      engine,
      detectProviders: async () => [],
      providerModels: async () => ({}),
      feishuRuntime: () => ({
        ready: true,
        consumers: [
          { key: "im.message.receive_v1", state: "failed", lastError: "raw secret" },
          { key: "im.chat.member.bot.added_v1", state: "ready" },
        ],
      }),
    });

    const page = await (await setupApp.request("/integrations")).text();

    expect(page).toContain("消息监听异常");
    expect(page).toContain('href="/health"');
    expect(page).toContain("前往运行状态恢复");
    expect(page).not.toContain("等待连接");
    expect(page).not.toContain("raw secret");
  });

  test("integration setup keeps a restart warning until the active connector uses the new identity", async () => {
    const setupApp = createWebApp({
      engine,
      detectProviders: async () => [],
      providerModels: async () => ({}),
      activeFeishuIdentity: { botName: "旧机器人", botOpenId: "ou_old" },
      larkSetup: {
        status: async () => ({
          state: "ready",
          verified: true,
          appId: "cli_new",
          brand: "feishu",
          botName: "新机器人",
          botOpenId: "ou_new",
          message: "Bot identity: ready",
        }),
        configure: async () => {
          throw new Error("not expected");
        },
      },
      feishuRuntime: () => ({
        ready: true,
        consumers: [
          { key: "im.message.receive_v1", state: "ready" },
          { key: "im.chat.member.bot.added_v1", state: "ready" },
        ],
      }),
    });

    const page = await (await setupApp.request("/integrations")).text();

    expect(page).toContain('<span class="muted">待启用</span>');
    expect(page).not.toContain('<span class="muted">当前</span>');
    expect(page).toContain("需要重启");
    expect(page).toContain('href="/health"');
    expect(page).toContain("前往运行状态重启");
    expect(page).toContain("创建并切换机器人");
    expect(page).not.toContain("消息监听已就绪");
  });

  test("settings page groups fields and exposes an accessible save workflow", async () => {
    const response = await app.request("/settings?ok=已保存设置");
    expect(response.status).toBe(200);
    const view = await response.text();

    expect(view).toContain("<legend>默认 Agent</legend>");
    expect(view).toContain("<legend>运行策略</legend>");
    expect(view).toContain("<legend>数据与系统</legend>");
    expect(view).toContain('<label for="default-provider">默认 Provider</label>');
    expect(view).toContain('aria-describedby="default-provider-help"');
    expect(view).toContain('<label for="dream-hour">提炼时刻</label>');
    expect(view).toContain('<option value="3" selected>03:00</option>');
    expect(view).toContain('data-settings-form');
    expect(view).toContain('type="reset"');
    expect(view).toContain("取消");
    expect(view).toContain("保存更改");
    expect(view).toContain('role="status"');
    expect(view).toContain('aria-live="polite"');
  });

  test("management shell exposes accessible narrow-screen navigation controls", async () => {
    const response = await app.request("/settings");
    expect(response.status).toBe(200);
    const view = await response.text();

    expect(view).toContain('aria-controls="primary-navigation"');
    expect(view).toContain('aria-expanded="false"');
    expect(view).toContain('id="primary-navigation"');
    expect(view).toContain('aria-label="主导航"');
    expect(view).toContain('data-nav-scrim');
    expect(view).toContain("Escape");
  });

  test("settings POST rejects an invalid budget without persisting other fields", async () => {
    const response = await app.request("/settings", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        defaultProvider: "trae-cli",
        defaultModel: "openrouter-3o",
        dailyBudgetUsd: "-1",
        dreamHour: "5",
        webPort: "4000",
        rawRetentionDays: "30",
      }).toString(),
    });

    expect(response.status).toBe(400);
    const view = await response.text();
    expect(view).toContain("每日预算不能小于 0");
    expect(view).toContain('value="-1"');
    expect(view).toContain('aria-invalid="true"');
    expect(view).toContain('value="trae-cli" selected');
    expect(view).toContain('value="4000"');
    expect(readSettings(dir)).toEqual({});
  });

  test("settings POST rejects a distillation hour outside 0 through 23", async () => {
    const response = await app.request("/settings", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        defaultProvider: "claude",
        defaultModel: "sonnet",
        dailyBudgetUsd: "5",
        dreamHour: "24",
        webPort: "3000",
        rawRetentionDays: "90",
      }).toString(),
    });

    expect(response.status).toBe(400);
    const view = await response.text();
    expect(view).toContain("提炼时刻必须是 0 到 23 的整数");
    expect(view).toContain('<option value="24" selected>24（无效值）</option>');
    expect(readSettings(dir)).toEqual({});
  });

  test("settings POST rejects retention above 36500 days", async () => {
    const response = await app.request("/settings", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        defaultProvider: "claude",
        defaultModel: "",
        dailyBudgetUsd: "5",
        dreamHour: "3",
        webPort: "3000",
        rawRetentionDays: "36501",
      }).toString(),
    });

    expect(response.status).toBe(400);
    const view = await response.text();
    expect(view).toContain("保留天数必须是 0 到 36500 的整数");
    expect(view).toContain('value="36501"');
    expect(readSettings(dir)).toEqual({});
  });

  test("settings POST rejects a port outside 1 through 65535", async () => {
    const response = await app.request("/settings", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        defaultProvider: "claude",
        defaultModel: "",
        dailyBudgetUsd: "5",
        dreamHour: "3",
        webPort: "65536",
        rawRetentionDays: "90",
      }).toString(),
    });

    expect(response.status).toBe(400);
    const view = await response.text();
    expect(view).toContain("后台端口必须是 1 到 65535 的整数");
    expect(view).toContain('value="65536"');
    expect(readSettings(dir)).toEqual({});
  });

  test("settings POST persists default provider/model + config and reflects it back", async () => {
    const form = new URLSearchParams({
      defaultProvider: "trae-cli",
      defaultModel: "openrouter-3o",
      dailyBudgetUsd: "12",
      dreamHour: "5",
      webPort: "3000",
      rawRetentionDays: "30",
    });
    const res = await app.request("/settings", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    expect([302, 303]).toContain(res.status);
    const view = await (await app.request("/settings")).text();
    // the saved default provider is selected and its model shows
    expect(view).toContain("openrouter-3o");
    expect(view).toContain('value="trae-cli" selected');
    // dreamHour value is rendered in the number input
    expect(view).toContain('value="5"');
    expect(view).toContain('name="rawRetentionDays"');
    expect(view).toContain('value="30"');
  });

  test("tasks: nav + create + edit + list rendering", async () => {
    const home = await (await app.request("/tasks")).text();
    expect(home).toContain("任务");
    expect(home).toContain("新建任务");
    expect(home).toContain('name="timeoutMinutes" value="12"');

    const form = new URLSearchParams({
      name: "每日AI",
      space: SPACE,
      topic: "大模型进展",
      cadence: "daily",
      hour: "9",
      timeoutMinutes: "12",
    });
    form.append("enabled", "on");
    form.append("notify", "on");
    // distillOnRun checkbox omitted => unchecked => false
    const res = await app.request("/tasks", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    expect([302, 303]).toContain(res.status);
    const created = engine.tasks.list().find((t) => t.name === "每日AI");
    expect(created?.space).toBe(SPACE);
    expect(created?.cadence).toBe("daily");
    expect(created?.hour).toBe(9);
    expect(created?.enabled).toBe(true);
    expect(created?.distillOnRun).toBe(false); // omitted checkbox
    expect(created?.timeoutMinutes).toBe(12);

    // editor renders the task + the distill toggle
    const editor = await (await app.request(`/tasks/${encodeURIComponent(created!.id)}`)).text();
    expect(editor).toContain("大模型进展");
    expect(editor).toContain("立即运行");
    expect(editor).toContain("完成后立即提炼");
    expect(editor).toContain('name="timeoutMinutes"');
    expect(editor).toContain('value="12"');
  });

  test("tasks: create with invalid space is rejected with a flash", async () => {
    const form = new URLSearchParams({ name: "bad", space: "not-a-space", topic: "x" });
    const res = await app.request("/tasks", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    expect([302, 303]).toContain(res.status);
    expect(res.headers.get("location")).toContain("ok=");
    expect(engine.tasks.list().length).toBe(0);
  });

  test("tasks: manual run redirects to a durable run detail and fires onTaskRun", async () => {
    // make the fake client return research text
    fake.onText(() => "研究结果：要点若干");
    let ranId: string | undefined;
    const app2 = createWebApp({
      engine,
      detectProviders: async () => [],
      providerModels: async () => ({}),
      onTaskRun: (id) => { ranId = id; },
    });
    const task = engine.tasks.create({ name: "run-me", space: SPACE, topic: "x" })!;
    const res = await app2.request(`/tasks/${encodeURIComponent(task.id)}/run`, { method: "POST" });
    expect([302, 303]).toContain(res.status);
    const location = res.headers.get("location")!;
    expect(location).toMatch(/^\/tasks\/runs\/run_/);
    await new Promise((r) => setTimeout(r, 20));
    expect(engine.tasks.get(task.id)?.lastStatus).toBe("ok");
    expect(ranId).toBe(task.id);
    const run = engine.listTaskRuns(task.id)[0]!;
    expect(location).toContain(run.id);
    const detail = await (await app2.request(location)).text();
    expect(detail).toContain("运行详情");
    expect(detail).toContain("研究结果：要点若干");
    // captured into the space as a task raw entry
    expect(engine.registry.store(SPACE).index().listRaw({}).some((r) => r.source === "task")).toBe(true);
  });

  test("tasks: failed run is visible in history and can be retried", async () => {
    let attempts = 0;
    fake.onText(() => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary task failure");
      return "重试成功后的完整输出";
    });
    const task = engine.tasks.create({
      name: "retry-me",
      space: SPACE,
      topic: "x",
      distillOnRun: false,
    })!;

    const failedResponse = await app.request(`/tasks/${encodeURIComponent(task.id)}/run`, { method: "POST" });
    const failedLocation = failedResponse.headers.get("location")!;
    await new Promise((resolve) => setTimeout(resolve, 20));

    const taskPage = await (await app.request(`/tasks/${encodeURIComponent(task.id)}`)).text();
    const failedRun = engine.listTaskRuns(task.id)[0]!;
    expect(taskPage).toContain("运行历史");
    expect(taskPage).toContain(failedRun.id);

    const failedPage = await (await app.request(failedLocation)).text();
    expect(failedPage).toContain("temporary task failure");
    expect(failedPage).toContain("重新运行");

    const retryResponse = await app.request(`/tasks/runs/${encodeURIComponent(failedRun.id)}/retry`, { method: "POST" });
    const retryLocation = retryResponse.headers.get("location")!;
    expect(retryLocation).toMatch(/^\/tasks\/runs\/run_/);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const runs = engine.listTaskRuns(task.id);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toEqual(expect.objectContaining({
      status: "succeeded",
      trigger: "retry",
      retryOf: failedRun.id,
    }));
    const retryPage = await (await app.request(retryLocation)).text();
    expect(retryPage).toContain("重试成功后的完整输出");
    expect(retryPage).toContain(failedRun.id);
  });

  test("tasks: a duplicate manual run redirects to the active run", async () => {
    let finish: ((value: string) => void) | undefined;
    const isolatedEngine = new KnowledgeEngine({
      dataDir: join(dir, "duplicate-run"),
      runProvider: async () => new Promise<string>((resolve) => {
        finish = resolve;
      }),
    });
    isolatedEngine.ensureSpace(SPACE);
    const task = isolatedEngine.tasks.create({
      name: "single-flight",
      space: SPACE,
      topic: "x",
      distillOnRun: false,
    })!;
    const active = isolatedEngine.startTaskRun(task.id);
    const isolatedApp = createWebApp({ engine: isolatedEngine });

    const response = await isolatedApp.request(`/tasks/${encodeURIComponent(task.id)}/run`, { method: "POST" });

    expect(response.headers.get("location")).toContain(`/tasks/runs/${active.run.id}`);
    expect(decodeURIComponent(response.headers.get("location")!)).toContain("任务正在运行");
    expect(isolatedEngine.listTaskRuns(task.id)).toHaveLength(1);
    finish?.("完成");
    await active.completion;
    isolatedEngine.close();
  });

  test("tasks: a running task can be cancelled from its detail page", async () => {
    const isolatedEngine = new KnowledgeEngine({
      dataDir: join(dir, "cancel-run"),
      runProvider: async (_provider, _input, _timeoutMs, signal) =>
        new Promise<string>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    });
    isolatedEngine.ensureSpace(SPACE);
    const task = isolatedEngine.tasks.create({
      name: "cancel-me",
      space: SPACE,
      topic: "x",
      distillOnRun: false,
    })!;
    const started = isolatedEngine.startTaskRun(task.id);
    const isolatedApp = createWebApp({ engine: isolatedEngine });

    const runningPage = await (
      await isolatedApp.request(`/tasks/runs/${encodeURIComponent(started.run.id)}`)
    ).text();
    expect(runningPage).toContain("取消运行");

    const response = await isolatedApp.request(
      `/tasks/runs/${encodeURIComponent(started.run.id)}/cancel`,
      { method: "POST" },
    );
    expect(response.headers.get("location")).toContain(`/tasks/runs/${started.run.id}`);
    expect((await started.completion).status).toBe("cancelled");

    const cancelledPage = await (
      await isolatedApp.request(`/tasks/runs/${encodeURIComponent(started.run.id)}`)
    ).text();
    expect(cancelledPage).toContain("已取消");
    expect(cancelledPage).not.toContain("取消运行");
    isolatedEngine.close();
  });

  test("tasks: a failed Feishu notification is visible and manually retryable", async () => {
    fake.onText(() => "等待通知的任务结果");
    let attempts = 0;
    const failingApp = createWebApp({
      engine,
      onTaskRun: async () => {
        attempts += 1;
        throw new Error("Feishu delivery failed");
      },
    });
    const task = engine.tasks.create({
      name: "notify-me",
      space: SPACE,
      topic: "x",
      notify: true,
      distillOnRun: false,
    })!;

    await failingApp.request(`/tasks/${encodeURIComponent(task.id)}/run`, { method: "POST" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const run = engine.listTaskRuns(task.id)[0]!;
    expect(run.notification).toEqual(expect.objectContaining({
      status: "failed",
      attempts: 1,
      error: "Error: Feishu delivery failed",
    }));
    const failedPage = await (
      await failingApp.request(`/tasks/runs/${encodeURIComponent(run.id)}`)
    ).text();
    expect(failedPage).toContain("通知失败");
    expect(failedPage).toContain("重试通知");

    const retryApp = createWebApp({
      engine,
      onTaskRun: async () => {
        attempts += 1;
      },
    });
    const retryResponse = await retryApp.request(
      `/tasks/runs/${encodeURIComponent(run.id)}/notification/retry`,
      { method: "POST" },
    );

    expect(retryResponse.headers.get("location")).toContain(`/tasks/runs/${run.id}`);
    expect(attempts).toBe(2);
    expect(engine.getTaskRun(run.id)?.notification).toEqual(expect.objectContaining({
      status: "sent",
      attempts: 2,
    }));
  });

  test("tasks: delete removes it", async () => {
    fake.onText(() => "删除前运行");
    const task = engine.tasks.create({ name: "del", space: SPACE, topic: "x" })!;
    await engine.runTask(task.id, { distill: false });
    expect(engine.listTaskRuns(task.id)).toHaveLength(1);
    const res = await app.request(`/tasks/${encodeURIComponent(task.id)}/delete`, { method: "POST" });
    expect([302, 303]).toContain(res.status);
    expect(engine.tasks.has(task.id)).toBe(false);
    expect(engine.listTaskRuns(task.id)).toEqual([]);
  });

  test("learning: nav, list, detail, and administrative controls reflect durable state", async () => {
    const empty = await (await app.request("/learning")).text();
    expect(empty).toContain("发送 /learn topic &lt;主题&gt;");
    const plan = engine.learning.create({
      name: "读《原则》",
      space: SPACE,
      creatorId: "ou_reader",
      chatId: "oc_web",
      sourceTitle: "principles.md",
      sourceContent: "# 第一章\n\n书籍正文",
      sourceRawIds: ["raw_book"],
      sourceMessageId: "om_book",
      hour: 8,
      dailyCharacters: 800,
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

    const list = await (await app.request("/learning")).text();
    expect(list).toContain("学习计划");
    expect(list).toContain("读《原则》");
    expect(list).toContain("principles.md");
    expect(list).toContain("0%");
    expect(list).toContain('href="/learning"');

    const detail = await (await app.request(`/learning/${encodeURIComponent(plan.id)}`)).text();
    expect(detail).toContain("principles.md");
    expect(detail).toContain("ou_reader");
    expect(detail).toContain("oc_web");
    expect(detail).toContain("等待回答");
    expect(detail).toContain('name="dailyCharacters"');
    expect(detail).not.toContain('name="actorId"');

    const updated = await app.request(`/learning/${encodeURIComponent(plan.id)}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ hour: "10", dailyCharacters: "1200" }).toString(),
    });
    expect([302, 303]).toContain(updated.status);
    expect(engine.learning.get(plan.id)).toEqual(expect.objectContaining({
      hour: 10,
      dailyCharacters: 1200,
    }));

    const malformed = await app.request(`/learning/${encodeURIComponent(plan.id)}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ hour: "not-a-number", dailyCharacters: "1200" }).toString(),
    });
    expect(malformed.headers.get("location")).toContain("%E4%BF%9D%E5%AD%98%E5%A4%B1%E8%B4%A5");
    expect(engine.learning.get(plan.id)?.hour).toBe(10);

    await app.request(`/learning/${encodeURIComponent(plan.id)}/pause`, { method: "POST" });
    expect(engine.learning.get(plan.id)?.status).toBe("paused");
    await app.request(`/learning/${encodeURIComponent(plan.id)}/resume`, { method: "POST" });
    expect(engine.learning.get(plan.id)?.status).toBe("active");
    const removed = await app.request(`/learning/${encodeURIComponent(plan.id)}/delete`, {
      method: "POST",
    });
    expect([302, 303]).toContain(removed.status);
    expect(engine.learning.has(plan.id)).toBe(false);
  });

  test("learning: topic detail shows its route, materials, and adaptive focus", async () => {
    const plan = engine.learning.createTopic({
      name: "Rust 异步",
      topic: "Rust 异步编程",
      space: SPACE,
      creatorId: "ou_reader",
      chatId: "oc_web",
      assessmentQuestions: [
        "做过哪些异步项目？",
        "如何解释 Future？",
        "每天能投入多久？",
      ],
      route: [
        { title: "Future", objective: "理解 Future" },
        { title: "运行时", objective: "理解运行时" },
      ],
    }, 1);
    const assessingBody = await (await app.request(
      `/learning/${encodeURIComponent(plan.id)}`,
    )).text();
    expect(assessingBody).toContain("先画出你的知识地形");
    expect(assessingBody).toContain("做过哪些异步项目？");
    const assessed = engine.learning.completeAssessment(plan.id, "ou_reader", {
      answers: "写过简单 async/await；知道 Future 需要 poll；每天 40 分钟。",
      profile: {
        level: "intermediate",
        levelRationale: "能解释 Future 的推进机制，但缺少运行时诊断经验",
        goals: ["独立排查异步程序问题"],
        strengths: ["Future 心智模型"],
        gaps: ["Waker", "运行时诊断"],
        preferences: ["代码实验"],
        pace: "intensive",
        dailyMinutes: 40,
        evidence: ["明确说明 Future 需要 poll"],
      },
      route: [
        { title: "Waker", objective: "理解任务唤醒机制" },
        { title: "运行时", objective: "理解运行时调度" },
      ],
      adjustment: "跳过 Future 入门，直接补齐 Waker。",
    }, 2)!;
    engine.learning.addMaterial(plan.id, "ou_reader", {
      title: "async-book.md",
      content: "Future 只有在 poll 时推进。",
      rawIds: ["raw_async"],
      messageId: "om_async",
    }, 3);
    const session = engine.learning.prepareSession(plan.id, {
      startOffset: 0,
      endOffset: 1,
      routeStepId: assessed.route[0]!.id,
      sectionTitle: "Waker",
      excerpt: "[材料1：async-book.md]",
      guide: "## 思考题\nWaker 如何触发重新调度？",
      preparedAt: 4,
    })!;
    engine.learning.markDelivered(session.id, 5);
    engine.learning.completeSession(session.id, {
      learnerReply: "Waker 会通知 executor 任务可以再次 poll",
      feedback: "需要补强",
      mastery: "review",
      nextFocus: "区分唤醒通知和实际 poll",
      completedAt: 6,
    });
    engine.learning.replaceOnlineResources(plan.id, 2, {
      query: "Rust Waker official documentation",
      resources: [{
        title: "Async Book: Wakeups",
        url: "https://rust-lang.github.io/async-book/02_execution/03_wakeups.html",
        publisher: "Rust Project",
        summary: "解释任务唤醒机制。",
        relevance: "补足 Waker 与 executor 协作知识。",
        kind: "documentation",
      }],
    }, 7);

    const body = await (await app.request(`/learning/${encodeURIComponent(plan.id)}`)).text();
    expect(body).toContain("learning-map");
    expect(body).toContain("学习者画像");
    expect(body).toContain("当前判断");
    expect(body).toContain("知识优势");
    expect(body).toContain("待补齐");
    expect(body).toContain("路线已迭代");
    expect(body).toContain("主题学习");
    expect(body).toContain("Rust 异步编程");
    expect(body).toContain("async-book.md");
    expect(body).toContain("Waker");
    expect(body).toContain("理解运行时");
    expect(body).toContain("下一课重点：区分唤醒通知和实际 poll");
    expect(body).toContain("联网推荐资料");
    expect(body).toContain("Async Book: Wakeups");
    expect(body).toContain("https://rust-lang.github.io/async-book/02_execution/03_wakeups.html");
    expect(body).toContain('rel="noreferrer noopener"');

    const updated = await app.request(`/learning/${encodeURIComponent(plan.id)}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ hour: "11" }).toString(),
    });
    expect([302, 303]).toContain(updated.status);
    expect(engine.learning.get(plan.id)?.hour).toBe(11);
  });

  test("reminders: list and administrative controls reflect durable reminder state", async () => {
    const reminder = engine.reminders.create({
      title: "去茶饼斋",
      space: SPACE,
      chatId: "oc_web",
      creatorId: "ou_me",
      triggerAt: Date.now() + 3600_000,
    })!;

    const page = await (await app.request("/reminders")).text();
    expect(page).toContain("提醒");
    expect(page).toContain("去茶饼斋");
    expect(page).toContain("标记完成");
    expect(page).toContain("取消提醒");

    const response = await app.request(`/reminders/${encodeURIComponent(reminder.id)}/complete`, {
      method: "POST",
    });
    expect([302, 303]).toContain(response.status);
    expect(engine.reminders.get(reminder.id)?.status).toBe("completed");
  });
});
