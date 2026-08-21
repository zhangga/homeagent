import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
import { KnowledgeEngine, FakeLlm, SkillCatalog } from "@homeagent/core";
import { createWebApp } from "./app.ts";
import { FeishuIntegrationService } from "./feishu-integration-service.ts";
import type { LarkSetupPort } from "./integrations.ts";

let dir: string;
let engine: KnowledgeEngine;
let app: Hono;
let fake: FakeLlm;
let skillRoot: string;
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
  skillRoot = join(dir, "skills");
  mkdirSync(skillRoot, { recursive: true });
  engine = new KnowledgeEngine({
    dataDir: dir,
    llm: fake,
    skillCatalog: new SkillCatalog({
      roots: [{
        kind: "shared-agents",
        path: skillRoot,
        providerIds: ["claude", "codex", "trae-cli"],
      }],
    }),
  });
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

  test("fresh bundled setup makes managed Codex the zero-terminal primary path", async () => {
    const fresh = createWebApp({
      engine,
      detectProviders: async () => [],
      providerModels: async () => ({ codex: ["gpt-5.6-luna"] }),
      codexSetup: {
        canInstall: true,
        isInstalled: () => false,
        install: async () => {},
        startDeviceLogin: async () => ({ state: "idle", message: "尚未连接" }),
        deviceLoginStatus: () => ({ state: "idle", message: "尚未连接" }),
        cancelDeviceLogin: () => ({ state: "cancelled", message: "已取消" }),
      },
    });

    const response = await fresh.request("/setup");
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("安装并连接 ChatGPT");
    expect(body).toContain('action="/setup/ai/codex/install"');
    expect(body).toContain("高级选项");
    expect(body).toContain("Claude Code");
    expect(body.indexOf("安装并连接 ChatGPT")).toBeLessThan(
      body.indexOf("Claude Code"),
    );
    expect(body).not.toContain("先连接 Claude Code 或 Codex");
    expect(body).not.toContain("npm install");
  });

  test("installed but disconnected Codex stays on the ChatGPT connection step", async () => {
    let loginStarts = 0;
    const installed = createWebApp({
      engine,
      detectProviders: async () => [{
        id: "codex",
        name: "Codex",
        bin: "/managed/codex",
        available: false,
        detail: "ChatGPT 尚未连接",
      }],
      providerModels: async () => ({ codex: ["gpt-5.4"] }),
      codexSetup: {
        canInstall: true,
        isInstalled: () => true,
        install: async () => {},
        startDeviceLogin: async () => {
          loginStarts += 1;
          return { state: "waiting_for_user", message: "等待确认" };
        },
        deviceLoginStatus: () => ({ state: "idle", message: "尚未连接" }),
        cancelDeviceLogin: () => ({ state: "cancelled", message: "已取消" }),
      },
    });

    const page = await installed.request("/setup");
    expect(page.status).toBe(200);
    const body = await page.text();
    expect(body).toContain("Codex 已安装，尚未连接 ChatGPT");
    expect(body).toContain('action="/setup/ai/codex/login"');
    expect(body).toContain("连接 ChatGPT");
    expect(body).not.toContain('<option value="codex"');
    expect(body).not.toContain("安装并连接 ChatGPT");

    const premature = await installed.request("/setup/ai", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "provider=codex&model=gpt-5.4",
    });
    expect(premature.status).toBe(302);
    expect(decodeURIComponent(premature.headers.get("location") ?? ""))
      .toContain("ChatGPT 尚未连接");
    expect(readSettings(dir).defaultProvider).toBeUndefined();

    const connect = await installed.request("/setup/ai/codex/login", { method: "POST" });
    expect(connect.status).toBe(302);
    expect(loginStarts).toBe(1);
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
    expect(detailBody).toContain("状态：待提炼");
    expect(detailBody).toContain("重新提炼这条记录");

    engine.registry.store(SPACE).index().markIngested([rawId]);
    const ingestedDetail = await app.request(
      `/spaces/${encodeURIComponent(SPACE)}/raw/${encodeURIComponent(rawId)}`,
    );
    const ingestedDetailBody = await ingestedDetail.text();
    expect(ingestedDetailBody).toContain("状态：已提炼");
    expect(ingestedDetailBody).toContain("重新提炼这条记录");
  });

  test("shows each Raw admission state in the Raw list", async () => {
    const readyPendingId = await engine.remember({
      space: SPACE,
      source: "manual",
      content: "列表状态：普通待提炼",
    });
    const readyIngestedId = await engine.remember({
      space: SPACE,
      source: "manual",
      content: "列表状态：普通已提炼",
    });
    engine.registry.store(SPACE).index().markIngested([readyIngestedId]);
    const heldId = await engine.remember({
      space: SPACE,
      source: "task",
      admission: "held",
      workActionId: "wa_web_held",
      content: "列表状态：动作待验收",
    });
    const excludedId = await engine.remember({
      space: SPACE,
      source: "task",
      admission: "held",
      workActionId: "wa_web_excluded",
      content: "列表状态：动作已排除",
    });
    engine.registry.store(SPACE).index().excludeRawAdmission(
      excludedId,
      "wa_web_excluded",
    );

    const response = await app.request(`/spaces/${encodeURIComponent(SPACE)}/raw`);
    const body = await response.text();
    const rowFor = (rawId: string) => {
      const linkAt = body.indexOf(`/raw/${rawId}`);
      expect(linkAt).toBeGreaterThan(-1);
      return body.slice(body.lastIndexOf("<tr", linkAt), body.indexOf("</tr>", linkAt));
    };

    expect(rowFor(readyIngestedId)).toContain("已提炼");
    expect(rowFor(readyPendingId)).toContain("待提炼");
    expect(rowFor(heldId)).toContain("待动作验收");
    expect(rowFor(excludedId)).toContain("已排除");
  });

  test("shows a held WorkAction Raw as awaiting acceptance and refuses redistillation", async () => {
    const rawId = await engine.remember({
      space: SPACE,
      source: "task",
      admission: "held",
      workActionId: "wa_web_detail_held",
      content: "候选动作产物，尚未验收。",
    });

    const response = await app.request(
      `/spaces/${encodeURIComponent(SPACE)}/raw/${encodeURIComponent(rawId)}`,
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("状态：待动作验收");
    expect(body).not.toContain("重新提炼这条记录");
    expect(body).not.toContain(`/raw/${rawId}/redistill`);

    const redistill = await app.request(
      `/spaces/${encodeURIComponent(SPACE)}/raw/${encodeURIComponent(rawId)}/redistill`,
      { method: "POST" },
    );
    expect([302, 303]).toContain(redistill.status);
    const location = decodeURIComponent(redistill.headers.get("location") ?? "");
    expect(location).toContain("重新提炼失败");
    expect(location).toContain("尚未通过动作验收");
  });

  test("shows an excluded WorkAction Raw as excluded and refuses a direct redistill post", async () => {
    const actionId = "wa_web_detail_excluded";
    const rawId = await engine.remember({
      space: SPACE,
      source: "task",
      admission: "held",
      workActionId: actionId,
      content: "已拒绝的动作产物。",
    });
    engine.registry.store(SPACE).index().excludeRawAdmission(rawId, actionId);

    const detail = await app.request(
      `/spaces/${encodeURIComponent(SPACE)}/raw/${encodeURIComponent(rawId)}`,
    );
    const body = await detail.text();
    expect(body).toContain("状态：已排除");
    expect(body).not.toContain("重新提炼这条记录");
    expect(body).not.toContain(`/raw/${rawId}/redistill`);

    const response = await app.request(
      `/spaces/${encodeURIComponent(SPACE)}/raw/${encodeURIComponent(rawId)}/redistill`,
      { method: "POST" },
    );
    expect([302, 303]).toContain(response.status);
    const location = decodeURIComponent(response.headers.get("location") ?? "");
    expect(location).toContain("重新提炼失败");
    expect(location).toContain("已被动作验收排除");
    expect((await engine.getSpaceGovernance(SPACE)).audit).not.toContainEqual(
      expect.objectContaining({ action: "raw_redistilled", target: rawId }),
    );
  });

  test("shows the Agent response associated with a raw Chat message", async () => {
    const rawId = await engine.remember({
      space: SPACE,
      source: "message",
      agentId: "agent_chat",
      chatId: "oc_product",
      messageId: "om_agent_response",
      content: "请总结一下发布状态",
    });
    await engine.recordAgentResponse(SPACE, {
      chatId: "oc_product",
      messageId: "om_agent_response",
      response: "发布已完成，当前没有阻塞项。",
      respondedAt: 1_785_414_242_024,
    });

    const detail = await app.request(
      `/spaces/${encodeURIComponent(SPACE)}/raw/${encodeURIComponent(rawId)}`,
    );
    const detailBody = await detail.text();

    expect(detailBody).toContain("Agent 回复");
    expect(detailBody).toContain("发布已完成，当前没有阻塞项。");
    expect(detailBody).toContain("回复时间");
  });

  test("explains why a legacy raw Chat message has no Agent response", async () => {
    const rawId = await engine.remember({
      space: SPACE,
      source: "message",
      agentHandled: true,
      chatId: "oc_product",
      messageId: "om_legacy_chat",
      content: "hi",
    });

    const detail = await app.request(
      `/spaces/${encodeURIComponent(SPACE)}/raw/${encodeURIComponent(rawId)}`,
    );
    const detailBody = await detail.text();

    expect(detailBody).toContain("Agent 回复");
    expect(detailBody).toContain("旧记录的历史回复无法从本地补回");
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

  test("accepts Codex as the ordinary setup AI", async () => {
    const codexSetup = createWebApp({
      engine,
      detectProviders: async () => [{
        id: "codex",
        name: "Codex",
        bin: "codex",
        available: true,
        detail: "ready",
      }],
      providerModels: async () => ({ codex: ["gpt-5.4"] }),
    });

    const response = await codexSetup.request("/setup/ai", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "provider=codex&model=gpt-5.4",
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/setup");
    expect(readSettings(dir)).toEqual(expect.objectContaining({
      defaultProvider: "codex",
      defaultModel: "gpt-5.4",
    }));
  });

  test("connects managed Codex without changing the default until the user selects it", async () => {
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
    expect(readSettings(dir).defaultProvider).not.toBe("codex");
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

  test("allows setup to finish as soon as the Bot runtime is ready", async () => {
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

  test("shows setup as ready without requiring an active group binding", async () => {
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
    expect(await (await setupApp.request("/setup")).text()).toContain("一切就绪");
    await engine.remember({
      space: SPACE,
      source: "task",
      content: "不是飞书消息",
      createdAt: startedAt + 1,
    });
    expect(await (await setupApp.request("/setup")).text()).toContain("一切就绪");
    await engine.remember({
      space: SPACE,
      source: "message",
      content: "来自本次设置的飞书消息",
      createdAt: startedAt + 2,
    });
    expect(await (await setupApp.request("/setup")).text()).toContain("一切就绪");
    engine.feishuBindings.connect({
      chatId: "oc_web",
      spaceId: SPACE,
      boundAppId: "cli_current",
      responseMode: "mentions_only",
      replyInThread: true,
    });
    expect(await (await setupApp.request("/setup")).text()).toContain("一切就绪");
  });

  test("keeps external sharing optional in Integrations and verifies a real external group", async () => {
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

    const onboarding = await (await setupApp.request("/setup")).text();
    expect(onboarding).not.toContain("发布对外共享版本");
    const guide = await (await setupApp.request("/integrations")).text();
    expect(guide).toContain("开始对外共享验证");
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
    await setupApp.request("/integrations");

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

  test("space detail offers an accessible local-material import workflow", async () => {
    const res = await app.request(`/spaces/${encodeURIComponent(SPACE)}`);
    expect(res.status).toBe(200);
    const body = await res.text();

    expect(body).toContain("导入本地资料");
    expect(body).toContain(`action="/spaces/${encodeURIComponent(SPACE)}/materials"`);
    expect(body).toContain('enctype="multipart/form-data"');
    expect(body).toContain('name="material"');
    expect(body).toContain('accept=".txt,.md,.markdown,.csv,.json,.log"');
    expect(body).toContain("multiple required");
    expect(body).toContain('name="distillNow"');
    expect(body).toContain("单个文件不超过 20 MiB");
    expect(body).toContain("未勾选时由夜间提炼兜底");
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

  test("quality workbench prefers exact retrieval provenance for an ambiguous slug", async () => {
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
      answer: "请查看个人空间中的 Alice。",
      citations: [{ slug: "entities/alice", title: "Alice", space: personal }],
      retrievalPages: [{
        space: personal,
        slug: "entities/alice",
        contentHash: "personal-alice-hash",
      }],
      latencyMs: 60,
    });
    engine.recordAnswerFeedback(trace.id, SPACE, "citation_error", "核对精确来源");

    const body = await (await app.request("/quality")).text();
    expect(body).toContain(
      `/spaces/${encodeURIComponent(personal)}/pages/${encodeURIComponent("entities/alice")}`,
    );
    expect(body).not.toContain(
      `/spaces/${encodeURIComponent(SPACE)}/pages/${encodeURIComponent("entities/alice")}`,
    );
    expect(body).not.toContain("同名引用，候选空间");
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
  test("imports a local UTF-8 material into the selected space as pending Raw", async () => {
    const form = new FormData();
    form.set(
      "material",
      new File(
        ["# 架构说明\n\n项目代号是北极星，发布前必须完成双人复核。"],
        "architecture.md",
        { type: "text/markdown" },
      ),
    );

    const imported = await app.request(
      `/spaces/${encodeURIComponent(SPACE)}/materials`,
      { method: "POST", body: form },
    );

    expect([302, 303]).toContain(imported.status);
    const location = imported.headers.get("location") ?? "";
    expect(decodeURIComponent(location)).toContain("资料已导入，等待提炼");
    expect(location).toContain(`/spaces/${encodeURIComponent(SPACE)}/raw/`);

    const detail = await app.request(location);
    expect(detail.status).toBe(200);
    const body = await detail.text();
    expect(body).toContain("architecture.md");
    expect(body).toContain("项目代号是北极星");
    expect(body).toContain("状态：待提炼");
  });

  test("rejects an unsupported local material without creating Raw", async () => {
    const before = await (await app.request(`/spaces/${encodeURIComponent(SPACE)}`)).text();
    expect(before).toContain("原始条目（1）");
    const form = new FormData();
    form.set(
      "material",
      new File(["not really a document"], "payload.exe", {
        type: "application/octet-stream",
      }),
    );

    const rejected = await app.request(
      `/spaces/${encodeURIComponent(SPACE)}/materials`,
      { method: "POST", body: form },
    );

    expect([302, 303]).toContain(rejected.status);
    expect(decodeURIComponent(rejected.headers.get("location") ?? ""))
      .toContain("导入失败：不支持 .exe 文件");
    const after = await (await app.request(`/spaces/${encodeURIComponent(SPACE)}`)).text();
    expect(after).toContain("原始条目（1）");
  });

  test("rejects a non-UTF-8 local material without creating Raw", async () => {
    const form = new FormData();
    form.set(
      "material",
      new File([new Uint8Array([0xff, 0xfe, 0xfd])], "broken.txt", {
        type: "text/plain",
      }),
    );

    const rejected = await app.request(
      `/spaces/${encodeURIComponent(SPACE)}/materials`,
      { method: "POST", body: form },
    );

    expect([302, 303]).toContain(rejected.status);
    expect(decodeURIComponent(rejected.headers.get("location") ?? ""))
      .toContain("导入失败：文件不是有效的 UTF-8 文本");
    const after = await (await app.request(`/spaces/${encodeURIComponent(SPACE)}`)).text();
    expect(after).toContain("原始条目（1）");
  });

  test("rejects a local material larger than 20 MiB before creating Raw", async () => {
    const form = new FormData();
    form.set(
      "material",
      new File([new Uint8Array(20 * 1024 * 1024 + 1)], "oversized.txt", {
        type: "text/plain",
      }),
    );

    const rejected = await app.request(
      `/spaces/${encodeURIComponent(SPACE)}/materials`,
      { method: "POST", body: form },
    );

    expect([302, 303]).toContain(rejected.status);
    expect(decodeURIComponent(rejected.headers.get("location") ?? ""))
      .toContain("导入失败：单个文件不能超过 20 MiB");
    const after = await (await app.request(`/spaces/${encodeURIComponent(SPACE)}`)).text();
    expect(after).toContain("原始条目（1）");
  });

  test("immediately distills only the material imported by that request", async () => {
    let importedRawId = "";
    fake.onJSON((opts) => {
      expect(opts.prompt).not.toContain("一条原始消息");
      importedRawId = engine.registry.store(SPACE).index().listRaw({})
        .find((raw) => raw.content.includes("release-notes.md"))?.id ?? "";
      expect(importedRawId).not.toBe("");
      const jsonCall = fake.calls.filter((call) => call.kind === "json").length;
      if (jsonCall === 1) {
        return {
          operations: [{
            type: "concept",
            name: "release-gate",
            title: "发布门禁",
            rawIds: [importedRawId],
          }],
          skippedRawIds: [],
        };
      }
      return {
        title: "发布门禁",
        summary: "发布必须通过回归测试",
        aliases: [],
        tags: ["release"],
        links: [],
        content: "# 发布门禁\n\n发布必须通过回归测试。",
      };
    });
    const form = new FormData();
    form.set(
      "material",
      new File(["发布必须通过回归测试。"], "release-notes.md", {
        type: "text/markdown",
      }),
    );
    form.set("distillNow", "on");

    const imported = await app.request(
      `/spaces/${encodeURIComponent(SPACE)}/materials`,
      { method: "POST", body: form },
    );

    expect([302, 303]).toContain(imported.status);
    expect(decodeURIComponent(imported.headers.get("location") ?? ""))
      .toContain("资料已导入并完成提炼：写入 1 个知识页");
    expect(await engine.getPage(SPACE, "concepts/release-gate")).toEqual(
      expect.objectContaining({ sources: [importedRawId] }),
    );
    expect(engine.registry.store(SPACE).index().countRaw(true)).toBe(1);
  });

  test("imports multiple local materials in one request", async () => {
    const form = new FormData();
    form.append("material", new File(["Alpha 决策"], "alpha.md", { type: "text/markdown" }));
    form.append("material", new File(["Beta 纪要"], "beta.txt", { type: "text/plain" }));

    const imported = await app.request(
      `/spaces/${encodeURIComponent(SPACE)}/materials`,
      { method: "POST", body: form },
    );

    expect([302, 303]).toContain(imported.status);
    expect(decodeURIComponent(imported.headers.get("location") ?? ""))
      .toContain("已导入 2 份资料，等待提炼");
    const rawList = await (await app.request(`/spaces/${encodeURIComponent(SPACE)}/raw`)).text();
    expect(rawList).toContain("alpha.md");
    expect(rawList).toContain("beta.txt");
  });

  test("rejects an empty local material without creating Raw", async () => {
    const form = new FormData();
    form.set("material", new File(["  \n"], "empty.md", { type: "text/markdown" }));

    const rejected = await app.request(
      `/spaces/${encodeURIComponent(SPACE)}/materials`,
      { method: "POST", body: form },
    );

    expect([302, 303]).toContain(rejected.status);
    expect(decodeURIComponent(rejected.headers.get("location") ?? ""))
      .toContain("导入失败：empty.md 没有可提炼的文本");
    const after = await (await app.request(`/spaces/${encodeURIComponent(SPACE)}`)).text();
    expect(after).toContain("原始条目（1）");
  });

  test("bounds long local material text while retaining a visible truncation notice", async () => {
    const form = new FormData();
    form.set(
      "material",
      new File([`${"甲".repeat(200_000)}TAIL_MARKER`], "long-notes.md", {
        type: "text/markdown",
      }),
    );

    const imported = await app.request(
      `/spaces/${encodeURIComponent(SPACE)}/materials`,
      { method: "POST", body: form },
    );

    const detail = await app.request(imported.headers.get("location") ?? "");
    const body = await detail.text();
    expect(body).toContain("正文超过限制，仅保留前 200000 个字符");
    expect(body).not.toContain("TAIL_MARKER");
  });

  test("rejects more than 20 local materials in one request", async () => {
    const form = new FormData();
    for (let i = 0; i < 21; i += 1) {
      form.append("material", new File([`资料 ${i}`], `note-${i}.md`, {
        type: "text/markdown",
      }));
    }

    const rejected = await app.request(
      `/spaces/${encodeURIComponent(SPACE)}/materials`,
      { method: "POST", body: form },
    );

    expect([302, 303]).toContain(rejected.status);
    expect(decodeURIComponent(rejected.headers.get("location") ?? ""))
      .toContain("导入失败：一次最多选择 20 份资料");
    const after = await (await app.request(`/spaces/${encodeURIComponent(SPACE)}`)).text();
    expect(after).toContain("原始条目（1）");
  });

  test("data governance exports, deletes, and restores a complete space", async () => {
    const governance = await app.request("/governance");
    expect(governance.status).toBe(200);
    const governanceBody = await governance.text();
    expect(governanceBody).toContain("数据治理");
    expect(governanceBody).toContain("原始消息保留");
    expect(governanceBody).toContain("homeagent.space v1–v16");
    expect(governanceBody).toContain("v16 包含 WorkAction Raw");

    const exported = await app.request(`/spaces/${encodeURIComponent(SPACE)}/export`);
    expect(exported.status).toBe(200);
    expect(exported.headers.get("content-disposition")).toContain("attachment");
    const archiveText = await exported.text();
    expect(JSON.parse(archiveText)).toEqual(
      expect.objectContaining({
        format: "homeagent.space",
        version: 16,
        agentRevisions: [],
        learning: { plans: [], sources: [], sessions: [] },
        governanceAudit: [],
        taskRuns: [],
        chatRuns: [],
        workItems: [],
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
    expect(body).toContain('href="/skills"');
    expect(body).toContain("飞书连接");
    expect(body).toContain("设置");
  });

  test("Skills inventory shows local metadata and reverse Agent usage without leaking files", async () => {
    mkdirSync(join(skillRoot, "review"), { recursive: true });
    writeFileSync(
      join(skillRoot, "review", "SKILL.md"),
      [
        "---",
        "name: review",
        "description: Review important changes.",
        "---",
        "PRIVATE_SKILL_BODY",
      ].join("\n"),
      "utf8",
    );
    engine.skillCatalog.refresh();
    const agent = engine.agents.create({
      name: "Review Agent",
      provider: "claude",
      visibility: "Team",
      skills: [{
        kind: "source",
        sourceKey: "shared-agents:review",
        name: "review",
      }],
    });

    const response = await app.request("/skills");
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("共享 Skills");
    expect(body).toContain("Provider 自带能力不重复展示");
    expect(body).toContain("review");
    expect(body).toContain("共享 · review");
    expect(body).toContain("Review Agent");
    expect(body).toContain(`/agents/${encodeURIComponent(agent.id)}`);
    expect(body).not.toContain(skillRoot);
    expect(body).not.toContain("PRIVATE_SKILL_BODY");
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

  test("Agent editor saves drafts, publishes explicitly, and rolls back as a new revision", async () => {
    const created = engine.agents.create({
      name: "Lifecycle Agent",
      instruction: "release one",
      provider: "claude",
    });
    const releaseOne = created.publishedRevisionId!;
    const editorBody = new URLSearchParams({
      name: created.name,
      instruction: "release two",
      provider: "codex",
      model: "gpt-5.6-sol",
      visibility: "Team",
      permission: "read-only",
      expectedHeadRevisionId: releaseOne,
    });
    editorBody.set("agentAction", "draft");

    const savedDraft = await app.request(`/agents/${encodeURIComponent(created.id)}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: editorBody.toString(),
    });
    expect([302, 303]).toContain(savedDraft.status);
    expect(engine.agents.get(created.id)).toEqual(expect.objectContaining({
      instruction: "release one",
      provider: "claude",
      publishedRevisionId: releaseOne,
    }));
    expect(engine.agents.getDraft(created.id)?.snapshot).toEqual(expect.objectContaining({
      instruction: "release two",
      provider: "codex",
    }));

    const draftPage = await (await app.request(`/agents/${encodeURIComponent(created.id)}`)).text();
    expect(draftPage).toContain("release two");
    expect(draftPage).toContain("有未发布草稿");
    expect(draftPage).toContain('name="agentAction" value="draft"');
    expect(draftPage).toContain('name="agentAction"');
    expect(draftPage).toContain('value="publish"');
    const firstDraft = engine.agents.getDraft(created.id)!;
    expect(draftPage).toContain(`name="expectedHeadRevisionId" value="${firstDraft.id}"`);

    editorBody.set("agentAction", "publish");
    editorBody.set("expectedHeadRevisionId", firstDraft.id);
    const published = await app.request(`/agents/${encodeURIComponent(created.id)}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: editorBody.toString(),
    });
    expect([302, 303]).toContain(published.status);
    expect(engine.agents.get(created.id)).toEqual(expect.objectContaining({
      instruction: "release two",
      provider: "codex",
    }));

    const publishedHead = engine.agents.listRevisions(created.id)[0]!.id;
    const publishedPage = await (
      await app.request(`/agents/${encodeURIComponent(created.id)}`)
    ).text();
    for (const historicalDraft of engine.agents.listRevisions(created.id)
      .filter((revision) => revision.source === "draft")) {
      expect(publishedPage).not.toContain(
        `/revisions/${encodeURIComponent(historicalDraft.id)}/rollback`,
      );
    }
    const staleRollback = await app.request(
      `/agents/${encodeURIComponent(created.id)}/revisions/${encodeURIComponent(releaseOne)}/rollback`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ expectedHeadRevisionId: firstDraft.id }).toString(),
      },
    );
    expect(staleRollback.status).toBe(409);
    const staleRollbackPage = await staleRollback.text();
    expect(staleRollbackPage).toContain("Agent 版本已变化");
    expect(staleRollbackPage).toContain(
      `name="expectedHeadRevisionId" value="${firstDraft.id}"`,
    );
    expect(engine.agents.get(created.id)?.publishedRevisionId).toBe(publishedHead);

    const rollback = await app.request(
      `/agents/${encodeURIComponent(created.id)}/revisions/${encodeURIComponent(releaseOne)}/rollback`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ expectedHeadRevisionId: publishedHead }).toString(),
      },
    );
    expect([302, 303]).toContain(rollback.status);
    const rolledBack = engine.agents.get(created.id)!;
    expect(rolledBack).toEqual(expect.objectContaining({
      instruction: "release one",
      provider: "claude",
    }));
    expect(engine.agents.listRevisions(created.id)[0]).toMatchObject({
      source: "rollback",
      basedOnRevisionId: releaseOne,
      id: rolledBack.publishedRevisionId,
    });
  });

  test("Agent lifecycle rejects stale browser mutations and draft rollback", async () => {
    const created = engine.agents.create({
      name: "Concurrent Agent",
      instruction: "release one",
    });
    const releaseOne = created.publishedRevisionId!;
    const bypass = await app.request(`/agents/${encodeURIComponent(created.id)}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        name: created.name,
        instruction: "direct publish bypass",
        provider: created.provider,
        visibility: created.visibility,
        permission: created.permission,
        expectedHeadRevisionId: releaseOne,
      }).toString(),
    });
    expect(bypass.status).toBe(409);
    expect(engine.agents.get(created.id)?.instruction).toBe("release one");

    const first = new URLSearchParams({
      name: created.name,
      instruction: "draft A",
      provider: created.provider,
      visibility: created.visibility,
      permission: created.permission,
      agentAction: "draft",
      expectedHeadRevisionId: releaseOne,
    });
    const saved = await app.request(`/agents/${encodeURIComponent(created.id)}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: first.toString(),
    });
    expect([302, 303]).toContain(saved.status);
    const draft = engine.agents.getDraft(created.id)!;

    const stale = new URLSearchParams(first);
    stale.set("instruction", "stale draft B");
    const staleResponse = await app.request(`/agents/${encodeURIComponent(created.id)}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: stale.toString(),
    });
    expect(staleResponse.status).toBe(409);
    const stalePage = await staleResponse.text();
    expect(stalePage).toContain("Agent 版本已变化");
    expect(stalePage).toContain(
      `name="expectedHeadRevisionId" value="${releaseOne}"`,
    );
    expect(stalePage).not.toContain(
      `name="expectedHeadRevisionId" value="${draft.id}"`,
    );
    expect(engine.agents.getDraft(created.id)?.snapshot.instruction).toBe("draft A");

    const draftRollback = await app.request(
      `/agents/${encodeURIComponent(created.id)}/revisions/${encodeURIComponent(draft.id)}/rollback`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ expectedHeadRevisionId: draft.id }).toString(),
      },
    );
    expect(draftRollback.status).toBe(404);
    expect(engine.agents.get(created.id)?.publishedRevisionId).toBe(releaseOne);
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
        agentAction: "publish",
        expectedHeadRevisionId: created.publishedRevisionId!,
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
        agentAction: "publish",
        expectedHeadRevisionId: created.publishedRevisionId!,
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

  test("Skill catalog refresh degrades to a safe Agent-page warning", async () => {
    engine.skillCatalog.refresh = () => {
      throw new Error("C:\\private\\skill-root failed");
    };

    const response = await app.request("/agent-skills/refresh", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ returnTo: "/agents/new" }).toString(),
    });

    expect([302, 303]).toContain(response.status);
    expect(decodeURIComponent(response.headers.get("location") ?? "")).toContain(
      "Skill 目录刷新失败",
    );
    expect(response.headers.get("location")).not.toContain("private");
  });

  test("Skill catalog refresh returns to the standalone inventory", async () => {
    const response = await app.request("/agent-skills/refresh", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ returnTo: "/skills" }).toString(),
    });

    expect([302, 303]).toContain(response.status);
    expect(response.headers.get("location")).toStartWith("/skills?ok=");
    const page = await app.request(response.headers.get("location")!);
    expect(await page.text()).toContain("Skill 目录已刷新");
  });

  test("agent editor explains shared Chat and Task execution boundaries", async () => {
    const body = await (await app.request("/agents/new")).text();
    expect(body).toContain("Workdir");
    expect(body).toContain("Permission");
    expect(body).toContain("Skills");
    expect(body).toContain("Permission 同时影响普通聊天和任务");
    expect(body).toContain("提炼和后台学习不启用 Skills");
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
    const editorBody = body.slice(
      body.indexOf('data-pane="agent-editor"'),
      body.indexOf('data-pane="agent-inspector"'),
    );
    const inspectorBody = body.slice(body.indexOf('data-pane="agent-inspector"'));
    expect(editorBody).toContain("Recent runs");
    expect(inspectorBody).toContain(">Agent 设置<");
    expect(inspectorBody).toContain('id="agent-provider"');
    expect(inspectorBody).toContain('form="agent-editor-form"');

    const mobileList = await app.request("/agents?view=list");
    expect(mobileList.status).toBe(200);
    const mobileListBody = await mobileList.text();
    expect(mobileListBody).toContain("首选助手");
    expect(mobileListBody).toContain("选择一个 Agent");
  });

  test("agent Recent runs includes durable Chat records attributed to that Agent", async () => {
    const selected = engine.agents.create({ name: "Chat Agent", provider: "claude" });
    engine.updateSpaceMeta(SPACE, { agentId: selected.id, name: "Product chat" });
    const rawId = await engine.remember({
      space: SPACE,
      source: "message",
      author: "ou_product",
      chatId: "oc_web",
      messageId: "om_agent_chat",
      content: "@HomeAgent summarize the release status",
      agentId: selected.id,
      createdAt: 1_785_414_241_024,
    });

    const body = await (
      await app.request(`/agents/${encodeURIComponent(selected.id)}`)
    ).text();
    const editorBody = body.slice(
      body.indexOf('data-pane="agent-editor"'),
      body.indexOf('data-pane="agent-inspector"'),
    );

    expect(editorBody).toContain("Recent runs");
    expect(editorBody).toContain("Chat");
    expect(editorBody).toContain("summarize the release status");
    expect(editorBody).toContain(
      `/spaces/${encodeURIComponent(SPACE)}/raw/${encodeURIComponent(rawId)}`,
    );
  });

  test("shows Chat Run diagnostics and delegates a text retry", async () => {
    const selected = engine.agents.create({ name: "Retry Chat Agent", provider: "claude" });
    engine.updateSpaceMeta(SPACE, { agentId: selected.id });
    const run = engine.chatRuns.start({
      space: SPACE,
      chatId: "oc_web",
      messageId: "om_retry",
      author: "ou_retry",
      input: "请继续分析",
      trigger: "message",
      agentId: selected.id,
      provider: "claude",
      model: "sonnet",
    });
    engine.chatRuns.fail(run.id, {
      finishedAt: run.startedAt,
      error: {
        kind: "authentication",
        message: "Provider authentication expired",
      },
    });
    let retriedRunId: string | undefined;
    const retryApp = createWebApp({
      engine,
      onChatRunRetry: async (runId) => {
        retriedRunId = runId;
        return engine.chatRuns.get(runId)!;
      },
    });

    const detail = await retryApp.request(`/chats/runs/${encodeURIComponent(run.id)}`);
    const body = await detail.text();
    expect(detail.status).toBe(200);
    expect(body).toContain("Chat Run 详情");
    expect(body).toContain("鉴权失败");
    expect(body).toContain("Provider authentication expired");
    expect(body).toContain(`/chats/runs/${encodeURIComponent(run.id)}/retry`);

    const retry = await retryApp.request(
      `/chats/runs/${encodeURIComponent(run.id)}/retry`,
      { method: "POST" },
    );
    expect([302, 303]).toContain(retry.status);
    expect(retriedRunId).toBe(run.id);
  });

  test("shows honest Chat usage and creates a durable evaluation rerun", async () => {
    const sourceTrace = engine.quality.recordTrace({
      spaces: [SPACE],
      question: "What changed?",
      outcome: "succeeded",
      source: "general",
      answer: "Original answer",
      citations: [],
      latencyMs: 10,
    });
    const run = engine.chatRuns.start({
      space: SPACE,
      chatId: "oc_web",
      messageId: "om_evaluate",
      author: "ou_evaluate",
      input: "What changed?",
      trigger: "message",
      provider: "claude",
      model: "sonnet",
      skillEvidence: { requested: [], resolved: [], skipped: [] },
      executionPlan: {
        version: 1,
        instruction: "Use the frozen evaluator persona.",
        provider: "claude",
        model: "sonnet",
      },
    });
    engine.chatRuns.begin(run.id, run.startedAt);
    engine.chatRuns.succeed(run.id, {
      finishedAt: run.startedAt,
      output: "Original answer",
      traceId: sourceTrace.id,
      usage: {
        calls: 1,
        knownTokenCalls: 1,
        unknownTokenCalls: 0,
        knownCostCalls: 1,
        unknownCostCalls: 0,
        inputTokens: 41,
        outputTokens: 7,
        costUsd: 0.006,
        costBasis: "reported",
        sources: ["claude-json"],
      },
    });
    fake.onJSON(() => ({ slugs: [], relevant: false }));
    fake.queueText("Candidate answer");

    const detail = await app.request(`/chats/runs/${encodeURIComponent(run.id)}`);
    const body = await detail.text();
    expect(body).toContain("调用 1 次");
    expect(body).toContain("$0.006000");
    expect(body).toContain(`/chats/runs/${encodeURIComponent(run.id)}/evaluate`);

    const response = await app.request(
      `/chats/runs/${encodeURIComponent(run.id)}/evaluate`,
      { method: "POST" },
    );

    expect([302, 303]).toContain(response.status);
    expect(engine.quality.rerunsForChatRun(run.id)).toEqual([
      expect.objectContaining({ status: "completed", candidateTraceId: expect.any(String) }),
    ]);
    expect(engine.chatRuns.list(SPACE)).toHaveLength(1);
  });

  test("shows queued Chat position and delegates cancellation", async () => {
    const run = engine.chatRuns.start({
      space: SPACE,
      chatId: "oc_web",
      messageId: "om_queued",
      author: "ou_queued",
      input: "queued request",
      trigger: "message",
    });
    let release!: () => void;
    const blocker = engine.runScheduler.schedule({
      id: "blocking_run",
      priority: "manual",
      layers: [{ key: "test:global", limit: 1 }],
      execute: () => new Promise<void>((resolve) => {
        release = resolve;
      }),
    });
    const queued = engine.runScheduler.schedule({
      id: run.id,
      priority: "interactive",
      layers: [{ key: "test:global", limit: 1 }],
      execute: async () => undefined,
    });
    void queued.catch(() => undefined);
    const queuedApp = createWebApp({
      engine,
      onChatRunCancel: (runId) => {
        const cancelled = engine.runScheduler.cancel(runId);
        if (cancelled) {
          engine.chatRuns.cancel(runId, {
            finishedAt: Date.now(),
            error: { kind: "cancelled", message: "cancelled by test" },
          });
        }
        return cancelled;
      },
    });

    const detail = await queuedApp.request(`/chats/runs/${encodeURIComponent(run.id)}`);
    const body = await detail.text();
    expect(body).toContain("排队中");
    expect(body).toContain("第 1 位");
    expect(body).toContain(`/chats/runs/${encodeURIComponent(run.id)}/cancel`);

    const cancelled = await queuedApp.request(
      `/chats/runs/${encodeURIComponent(run.id)}/cancel`,
      { method: "POST" },
    );
    expect([302, 303]).toContain(cancelled.status);
    expect(engine.chatRuns.get(run.id)?.status).toBe("cancelled");

    release();
    await blocker;
  });

  test("Chat history remains with the Agent that handled it after a space is rebound", async () => {
    const original = engine.agents.create({ name: "Original Agent", provider: "claude" });
    const replacement = engine.agents.create({ name: "Replacement Agent", provider: "claude" });
    engine.updateSpaceMeta(SPACE, { agentId: original.id, name: "Product chat" });
    await engine.remember({
      space: SPACE,
      source: "message",
      chatId: "oc_web",
      messageId: "om_before_rebind",
      content: "@HomeAgent keep this with the original Agent",
      agentId: original.id,
      createdAt: 1_785_414_241_024,
    });
    engine.updateSpaceMeta(SPACE, { agentId: replacement.id });

    const originalBody = await (
      await app.request(`/agents/${encodeURIComponent(original.id)}`)
    ).text();
    const replacementBody = await (
      await app.request(`/agents/${encodeURIComponent(replacement.id)}`)
    ).text();

    expect(originalBody).toContain("keep this with the original Agent");
    expect(replacementBody).not.toContain("keep this with the original Agent");
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
        agentAction: "publish",
        expectedHeadRevisionId: created.publishedRevisionId!,
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
    expect(created?.skills).toEqual([
      { kind: "legacy-name", name: "code-review" },
      { kind: "legacy-name", name: "summarize" },
    ]);
  });

  test("creating an Agent persists the exact Skill source selected by the catalog form", async () => {
    mkdirSync(join(skillRoot, "review"), { recursive: true });
    writeFileSync(
      join(skillRoot, "review", "SKILL.md"),
      ["---", "name: review", "description: Review.", "---"].join("\n"),
      "utf8",
    );
    engine.skillCatalog.refresh();
    const form = new URLSearchParams({
      name: "Skill Agent",
      provider: "claude",
      permission: "read-only",
      skillSelectorPresent: "1",
      skillSourceKeys: "shared-agents:review",
    });

    const response = await app.request("/agents", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });

    expect([302, 303]).toContain(response.status);
    expect(engine.agents.list().find((item) => item.name === "Skill Agent")?.skills).toEqual([{
      kind: "source",
      sourceKey: "shared-agents:review",
      name: "review",
    }]);
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
    const edit = new URLSearchParams({
      name: "Renamed",
      instruction: "x",
      model: "sonnet",
      visibility: "Team",
      agentAction: "publish",
      expectedHeadRevisionId: created.publishedRevisionId!,
    });
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

  test("integration discovery requests in-group confirmation without activating locally", async () => {
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
    const prompts: string[] = [];
    const service = new FeishuIntegrationService({
      engine,
      larkSetup,
      sendConfirmationPrompt: async (chatId) => {
        prompts.push(chatId);
      },
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
    expect(page).toContain("请求群管理员确认");
    expect(page).toContain("New product group");
    expect(page).not.toContain("Already connected");
    expect(page).not.toContain('name="responseMode"');

    const response = await integrationApp.request(
      "/integrations/groups/connect",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          chatId: "oc_new",
        }).toString(),
      },
    );

    expect([302, 303]).toContain(response.status);
    expect(engine.feishuBindings.getByChatId("oc_new")).toMatchObject({
      state: "pending_confirmation",
      responseMode: "mentions_only",
      replyInThread: true,
    });
    expect(engine.registry.has("team/oc_new")).toBeFalse();
    expect(prompts).toEqual(["oc_new"]);

    const pending = await (await integrationApp.request("/integrations")).text();
    expect(pending).toContain("FEISHU CONTROL CENTER");
    expect(pending).toContain("New product group");
    expect(pending).toContain("等待群管理员确认");
    expect(pending).toContain("@HomeAgent 启用群聊");
    expect(pending).toContain(
      'action="/integrations/groups/team%2Foc_new/confirmation"',
    );
    expect(pending).toContain(
      'action="/integrations/groups/team%2Foc_new/ignore"',
    );
    expect(pending).toContain('data-space-id="team/oc_new"');
    expect(pending).toContain('data-feishu-stage="waiting_confirmation"');
    expect(pending).toContain("data-feishu-closure");

    const resend = await integrationApp.request(
      `/integrations/groups/${encodeURIComponent("team/oc_new")}/confirmation`,
      { method: "POST" },
    );
    expect([302, 303]).toContain(resend.status);
    expect(prompts).toEqual(["oc_new", "oc_new"]);

    const ignore = await integrationApp.request(
      `/integrations/groups/${encodeURIComponent("team/oc_new")}/ignore`,
      { method: "POST" },
    );
    expect([302, 303]).toContain(ignore.status);
    expect(engine.feishuBindings.getByChatId("oc_new")?.state)
      .toBe("disconnected");

    engine.ensureSpace("team/oc_new", { chatId: "oc_new" });
    engine.updateSpaceMeta("team/oc_new", { name: "New product group" });
    engine.feishuBindings.connect({
      chatId: "oc_new",
      spaceId: "team/oc_new",
      boundAppId: "cli_current",
      responseMode: "mentions_only",
      replyInThread: true,
    });
    const integrations = await (await integrationApp.request("/integrations")).text();
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

  test("failed confirmation delivery returns to the pending integration card", async () => {
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
      getBotChat: async (chatId: string) => ({
        chatId,
        name: "Prompt failure group",
      }),
    };
    const service = new FeishuIntegrationService({
      engine,
      larkSetup,
      sendConfirmationPrompt: async () => {
        throw new Error("raw transport detail");
      },
    });
    const integrationApp = createWebApp({
      engine,
      larkSetup,
      feishuIntegration: service,
      detectProviders: async () => [],
      providerModels: async () => ({}),
    });

    const response = await integrationApp.request(
      "/integrations/groups/connect",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ chatId: "oc_prompt_failed" }).toString(),
      },
    );

    expect([302, 303]).toContain(response.status);
    expect(response.headers.get("location")).toStartWith("/integrations?ok=");
    expect(response.headers.get("location")).not.toContain(
      "raw%20transport%20detail",
    );
    expect(engine.feishuBindings.getByChatId("oc_prompt_failed")).toMatchObject({
      state: "pending_confirmation",
      confirmationPrompt: {
        status: "failed",
        lastError: "Confirmation prompt delivery failed",
      },
    });
    expect(engine.registry.has("team/oc_prompt_failed")).toBeFalse();
  });

  test("integration control center explains missing group permission and offers safe recovery", async () => {
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
      fullGroupMessageCapability: async () => "unavailable" as const,
    };
    const integrationApp = createWebApp({
      engine,
      larkSetup,
      feishuIntegration: new FeishuIntegrationService({
        engine,
        larkSetup,
        runtimeStatus: () => ({ ready: true, consumers: [] }),
      }),
    });

    const page = await (await integrationApp.request("/integrations")).text();

    expect(page).toContain("缺少完整群消息权限");
    expect(page).toContain("打开飞书应用并检查权限");
    expect(page).toContain('href="https://open.feishu.cn/app/cli_current"');
    expect(page).toContain("重新检查权限");
  });

  test("integration control center manual setup can switch between Feishu and Lark", async () => {
    const configured: Array<{
      appId: string;
      appSecret: string;
      brand: "feishu" | "lark";
    }> = [];
    const larkSetup: LarkSetupPort = {
      status: async () => ({
        state: "ready",
        verified: true,
        appId: "cli_current",
        brand: "feishu",
        botName: "HomeAgent",
        botOpenId: "ou_bot",
        message: "ready",
      }),
      configure: async (input) => {
        configured.push(input);
        return {
          state: "ready",
          verified: true,
          appId: input.appId,
          brand: input.brand,
          botName: "Lark Agent",
          botOpenId: "ou_lark",
          message: "ready",
        };
      },
      fullGroupMessageCapability: async () => "available",
    };
    const integrationApp = createWebApp({
      engine,
      larkSetup,
      feishuIntegration: new FeishuIntegrationService({
        engine,
        larkSetup,
      }),
    });

    const page = await (await integrationApp.request("/integrations")).text();
    expect(page).toContain('<select name="brand">');
    expect(page).toContain('<option value="feishu" selected>飞书</option>');
    expect(page).toContain('<option value="lark">Lark</option>');

    const response = await integrationApp.request("/integrations/bot/setup", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        appId: "cli_lark",
        appSecret: "lark-secret",
        brand: "lark",
      }).toString(),
    });

    expect([302, 303]).toContain(response.status);
    expect(configured).toEqual([{
      appId: "cli_lark",
      appSecret: "lark-secret",
      brand: "lark",
    }]);
  });

  test("integration control center explains unknown permission and failed consumers without leaking errors", async () => {
    const larkSetup: LarkSetupPort = {
      status: async () => ({
        state: "ready",
        verified: true,
        appId: "cli_current",
        brand: "feishu",
        botName: "HomeAgent",
        botOpenId: "ou_bot",
        message: "private status detail",
      }),
      configure: async () => {
        throw new Error("not used");
      },
      fullGroupMessageCapability: async () => "unknown",
    };
    const integrationApp = createWebApp({
      engine,
      larkSetup,
      feishuIntegration: new FeishuIntegrationService({
        engine,
        larkSetup,
        activeIdentity: () => ({
          botName: "HomeAgent",
          botOpenId: "ou_bot",
        }),
        runtimeStatus: () => ({
          ready: false,
          consumers: [{
            key: "im.message.receive_v1",
            state: "failed",
            lastError: "private consumer error",
          }],
        }),
      }),
    });

    const page = await (await integrationApp.request("/integrations")).text();

    expect(page).toContain("权限检测失败");
    expect(page).toContain("重新检查权限");
    expect(page).toContain("消息监听异常");
    expect(page).toContain("前往运行状态恢复");
    expect(page).not.toContain("private status detail");
    expect(page).not.toContain("private consumer error");
  });

  test("integration control center links a changed Bot identity to runtime restart", async () => {
    const larkSetup: LarkSetupPort = {
      status: async () => ({
        state: "ready",
        verified: true,
        appId: "cli_current",
        brand: "feishu",
        botName: "New Bot",
        botOpenId: "ou_new",
        message: "ready",
      }),
      configure: async () => {
        throw new Error("not used");
      },
      fullGroupMessageCapability: async () => "available",
    };
    const integrationApp = createWebApp({
      engine,
      larkSetup,
      feishuIntegration: new FeishuIntegrationService({
        engine,
        larkSetup,
        activeIdentity: () => ({
          botName: "Old Bot",
          botOpenId: "ou_old",
        }),
        runtimeStatus: () => ({ ready: true, consumers: [] }),
      }),
    });

    const page = await (await integrationApp.request("/integrations")).text();

    expect(page).toContain("需要重启");
    expect(page).toContain("前往运行状态重启");
    expect(page).toContain('href="/health"');
  });

  test("integration progress endpoint returns bounded uncached closure state", async () => {
    const larkSetup: LarkSetupPort = {
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
      fullGroupMessageCapability: async () => "available",
    };
    const integrationApp = createWebApp({
      engine,
      larkSetup,
      feishuIntegration: new FeishuIntegrationService({
        engine,
        larkSetup,
        activeIdentity: () => ({
          botName: "HomeAgent",
          botOpenId: "ou_bot",
        }),
        runtimeStatus: () => ({ ready: true, consumers: [] }),
      }),
    });

    const response = await integrationApp.request("/integrations/progress");

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      version: 1,
      bot: { stage: "ready" },
      groups: [{
        spaceId: SPACE,
        stage: "ready_to_test",
      }],
      nextAction: {
        kind: "test_group",
        spaceId: SPACE,
      },
    });
  });

  test("explicit Bot verification invalidates cached integration progress probes", async () => {
    let botOpenId = "ou_old";
    let statusReads = 0;
    const larkSetup: LarkSetupPort = {
      status: async () => {
        statusReads += 1;
        return {
          state: "ready",
          verified: true,
          appId: "cli_current",
          brand: "feishu",
          botName: "HomeAgent",
          botOpenId,
          message: "ready",
        };
      },
      configure: async () => {
        throw new Error("not used");
      },
      fullGroupMessageCapability: async () => "available",
    };
    const service = new FeishuIntegrationService({
      engine,
      larkSetup,
      activeIdentity: () => ({
        botName: "HomeAgent",
        botOpenId,
      }),
      runtimeStatus: () => ({ ready: true, consumers: [] }),
    });
    const integrationApp = createWebApp({
      engine,
      larkSetup,
      feishuIntegration: service,
    });

    expect(
      ((await (await integrationApp.request("/integrations/progress")).json()) as {
        bot: { stage: string };
      }).bot.stage,
    ).toBe("ready");
    botOpenId = "ou_new";

    const verification = await integrationApp.request(
      "/integrations/bot/verify",
      { method: "POST" },
    );
    expect([302, 303]).toContain(verification.status);

    const refreshed = (await (
      await integrationApp.request("/integrations/progress")
    ).json()) as { bot: { stage: string } };
    expect(refreshed.bot.stage).toBe("ready");
    expect(statusReads).toBe(3);
  });

  test("integration progress is protected and returns a fixed unavailable response", async () => {
    const larkSetup: LarkSetupPort = {
      status: async () => {
        throw new Error("private CLI output TOKEN");
      },
      configure: async () => {
        throw new Error("not used");
      },
      fullGroupMessageCapability: async () => "unknown",
    };
    const secureApp = createWebApp({
      engine,
      adminToken: "admin-secret",
      larkSetup,
      feishuIntegration: new FeishuIntegrationService({
        engine,
        larkSetup,
      }),
    });

    expect(
      (await secureApp.request("/integrations/progress")).status,
    ).toBe(401);
    const response = await secureApp.request("/integrations/progress", {
      headers: { authorization: "Bearer admin-secret" },
    });

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      error: "temporarily_unavailable",
      retryAfterMs: 10_000,
    });
    expect(text).not.toContain("private");
    expect(text).not.toContain("TOKEN");
  });

  test("connection closure prioritizes an unconfigured Bot before group work", async () => {
    const larkSetup: LarkSetupPort = {
      status: async () => ({
        state: "unconfigured",
        verified: false,
        brand: "feishu",
        message: "not configured",
      }),
      configure: async () => {
        throw new Error("not used");
      },
      fullGroupMessageCapability: async () => "unknown",
      listBotChats: async () => [],
    };
    const integrationApp = createWebApp({
      engine,
      larkSetup,
      feishuIntegration: new FeishuIntegrationService({
        engine,
        larkSetup,
      }),
    });

    const page = await (await integrationApp.request("/integrations")).text();

    expect(page).toContain('data-feishu-next-action="connect_bot"');
    expect(page).toContain("连接飞书 Bot");
    expect(page).toContain('href="#feishu-bot"');
    expect(page).toContain('id="feishu-bot"');
  });

  test("connection closure offers explicit verification for an invalid Bot", async () => {
    const larkSetup: LarkSetupPort = {
      status: async () => ({
        state: "invalid",
        verified: false,
        appId: "cli_current",
        brand: "feishu",
        message: "invalid",
      }),
      configure: async () => {
        throw new Error("not used");
      },
      fullGroupMessageCapability: async () => "unknown",
      listBotChats: async () => [],
    };
    const integrationApp = createWebApp({
      engine,
      larkSetup,
      feishuIntegration: new FeishuIntegrationService({
        engine,
        larkSetup,
      }),
    });

    const page = await (await integrationApp.request("/integrations")).text();

    expect(page).toContain('data-feishu-next-action="verify_bot"');
    expect(page).toContain("验证飞书 Bot");
    expect(page).toContain(
      '<form method="post" action="/integrations/bot/verify"',
    );
  });

  test("connection closure routes a changed Bot identity through restart", async () => {
    const larkSetup: LarkSetupPort = {
      status: async () => ({
        state: "ready",
        verified: true,
        appId: "cli_current",
        brand: "feishu",
        botName: "HomeAgent",
        botOpenId: "ou_new",
        message: "ready",
      }),
      configure: async () => {
        throw new Error("not used");
      },
      fullGroupMessageCapability: async () => "available",
      listBotChats: async () => [],
    };
    const integrationApp = createWebApp({
      engine,
      larkSetup,
      feishuIntegration: new FeishuIntegrationService({
        engine,
        larkSetup,
        activeIdentity: () => ({
          botName: "HomeAgent",
          botOpenId: "ou_old",
        }),
        runtimeStatus: () => ({ ready: true, consumers: [] }),
      }),
    });

    const page = await (await integrationApp.request("/integrations")).text();

    expect(page).toContain('data-feishu-next-action="restart_runtime"');
    expect(page).toContain("重启并加载新 Bot");
    expect(page).toContain('data-feishu-action="restart_runtime"');
    expect(page).toContain('href="/health"');
  });

  test("connection closure points an active untested group to its explicit test action", async () => {
    const larkSetup: LarkSetupPort = {
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
      fullGroupMessageCapability: async () => "available",
      listBotChats: async () => [],
    };
    const integrationApp = createWebApp({
      engine,
      larkSetup,
      feishuIntegration: new FeishuIntegrationService({
        engine,
        larkSetup,
        activeIdentity: () => ({
          botName: "HomeAgent",
          botOpenId: "ou_bot",
        }),
        runtimeStatus: () => ({ ready: true, consumers: [] }),
      }),
    });

    const page = await (await integrationApp.request("/integrations")).text();

    expect(page.match(/data-feishu-progress-root\r?\n/g)?.length).toBe(1);
    expect(page).toContain('data-feishu-next-action="test_group"');
    expect(page).toContain(`data-next-space="${SPACE}"`);
    expect(page).toContain(`data-space-id="${SPACE}"`);
    expect(page).toContain("data-feishu-revision=");
    expect(page).toContain('data-poll-after="5000"');
    expect(page).toContain("data-feishu-title");
    expect(page).toContain("data-feishu-description");
    expect(page).toContain("data-feishu-refresh-warning");
    expect(page).toContain("发送测试消息");
    expect(page).toContain('data-feishu-action="test_group"');
    expect(page).toContain(
      'data-feishu-action="test_group" data-feishu-scroll-group',
    );
    expect(page).not.toContain('href="#feishu-group-');
    for (const action of [
      "connect_bot",
      "verify_bot",
      "restart_runtime",
      "recover_runtime",
      "connect_group",
      "reconnect_group",
      "wait_for_confirmation",
      "none",
    ]) {
      expect(page).toContain(`data-feishu-action="${action}"`);
    }
    expect(page).toContain('fetch("/integrations/progress"');
    expect(page).toContain(
      `formaction="/integrations/groups/${encodeURIComponent(SPACE)}/test"`,
    );
  });

  test("connection closure waits for administrator confirmation without auto-testing", async () => {
    engine.feishuBindings.disconnect(SPACE);
    engine.feishuBindings.requestConfirmation({
      chatId: "oc_web",
      spaceId: SPACE,
      boundAppId: "cli_current",
    });
    const larkSetup: LarkSetupPort = {
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
      fullGroupMessageCapability: async () => "available",
      listBotChats: async () => [],
    };
    const integrationApp = createWebApp({
      engine,
      larkSetup,
      feishuIntegration: new FeishuIntegrationService({
        engine,
        larkSetup,
        activeIdentity: () => ({
          botName: "HomeAgent",
          botOpenId: "ou_bot",
        }),
        runtimeStatus: () => ({ ready: true, consumers: [] }),
      }),
    });

    const page = await (await integrationApp.request("/integrations")).text();

    expect(page).toContain(
      'data-feishu-next-action="wait_for_confirmation"',
    );
    expect(page).toContain("等待群管理员确认");
    expect(page).toContain(
      'data-feishu-action="wait_for_confirmation"',
    );
    expect(page).toContain('data-feishu-stage="waiting_confirmation"');
    expect(page).toContain("data-feishu-group-stage");
    expect(page).toContain("data-feishu-group-completed");
    expect(page).toContain("data-feishu-group-health");
    expect(page).toContain("data-feishu-group-test");
    expect(page).not.toContain("发送一条测试消息，成功后该群即完成连接");
  });

  test("connection closure points a stale group binding to reconnection", async () => {
    engine.feishuBindings.markAppNeedsReconnect("cli_current");
    const larkSetup: LarkSetupPort = {
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
      fullGroupMessageCapability: async () => "available",
      listBotChats: async () => [],
    };
    const integrationApp = createWebApp({
      engine,
      larkSetup,
      feishuIntegration: new FeishuIntegrationService({
        engine,
        larkSetup,
        activeIdentity: () => ({
          botName: "HomeAgent",
          botOpenId: "ou_bot",
        }),
        runtimeStatus: () => ({ ready: true, consumers: [] }),
      }),
    });

    const page = await (await integrationApp.request("/integrations")).text();

    expect(page).toContain('data-feishu-next-action="reconnect_group"');
    expect(page).toContain("重新连接");
    expect(page).toContain('data-feishu-action="reconnect_group"');
    expect(page).toContain('data-feishu-stage="needs_reconnect"');
  });

  test("connection closure asks for a group after the Bot is ready", async () => {
    engine.feishuBindings.disconnect(SPACE);
    const larkSetup: LarkSetupPort = {
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
      fullGroupMessageCapability: async () => "available",
      listBotChats: async () => [],
    };
    const integrationApp = createWebApp({
      engine,
      larkSetup,
      feishuIntegration: new FeishuIntegrationService({
        engine,
        larkSetup,
        activeIdentity: () => ({
          botName: "HomeAgent",
          botOpenId: "ou_bot",
        }),
        runtimeStatus: () => ({ ready: true, consumers: [] }),
      }),
    });

    const page = await (await integrationApp.request("/integrations")).text();

    expect(page).toContain('data-feishu-next-action="connect_group"');
    expect(page).toContain("连接一个群聊");
    expect(page).toContain('data-feishu-action="connect_group"');
    expect(page).toContain('href="/integrations/groups/connect"');
  });

  test("connection closure preserves group completion while runtime is currently unhealthy", async () => {
    engine.feishuBindings.recordTest(SPACE, {
      status: "succeeded",
      at: 1_785_420_000_000,
    });
    const larkSetup: LarkSetupPort = {
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
      fullGroupMessageCapability: async () => "available",
      listBotChats: async () => [],
    };
    const integrationApp = createWebApp({
      engine,
      larkSetup,
      feishuIntegration: new FeishuIntegrationService({
        engine,
        larkSetup,
        activeIdentity: () => ({
          botName: "HomeAgent",
          botOpenId: "ou_bot",
        }),
        runtimeStatus: () => ({
          ready: false,
          consumers: [{
            key: "im.message.receive_v1",
            state: "failed",
            lastError: "private runtime detail",
          }],
        }),
      }),
    });

    const page = await (await integrationApp.request("/integrations")).text();

    expect(page).toContain('data-feishu-next-action="recover_runtime"');
    expect(page).toContain("恢复飞书消息监听");
    expect(page).toContain('data-feishu-action="recover_runtime"');
    expect(page).toContain('href="/health"');
    expect(page).toContain('data-feishu-stage="complete"');
    expect(page).toContain('data-completed-at="1785420000000"');
    expect(page).toContain("连接已验证");
    expect(page).toContain("当前运行异常");
    expect(page).not.toContain("private runtime detail");
  });

  test("connection closure completes a mention-only group without full-message permission", async () => {
    engine.feishuBindings.updatePolicy(SPACE, {
      responseMode: "mentions_only",
    });
    engine.feishuBindings.recordTest(SPACE, {
      status: "succeeded",
      at: 1_785_420_100_000,
    });
    const larkSetup: LarkSetupPort = {
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
      fullGroupMessageCapability: async () => "unavailable",
      listBotChats: async () => [],
    };
    const integrationApp = createWebApp({
      engine,
      larkSetup,
      feishuIntegration: new FeishuIntegrationService({
        engine,
        larkSetup,
        activeIdentity: () => ({
          botName: "HomeAgent",
          botOpenId: "ou_bot",
        }),
        runtimeStatus: () => ({ ready: true, consumers: [] }),
      }),
    });

    const page = await (await integrationApp.request("/integrations")).text();
    const groupStart = page.indexOf(`data-space-id="${SPACE}"`);
    const groupCard = page.slice(
      groupStart,
      page.indexOf("</article>", groupStart),
    );

    expect(page).toContain('data-feishu-next-action="none"');
    expect(page).toContain("飞书连接已完成");
    expect(page).toContain('data-feishu-stage="complete"');
    expect(page).toContain("仅 @ 消息可用");
    expect(groupCard).not.toContain("当前能力受限");
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
    expect(view).toContain('<label for="chat-timeout-minutes">聊天最长回答时间</label>');
    expect(view).toContain('name="chatTimeoutMinutes" value="10"');
    expect(view).toContain('data-settings-form');
    expect(view).toContain('type="reset"');
    expect(view).toContain("取消");
    expect(view).toContain("保存更改");
    expect(view).toContain("<legend>数据目录</legend>");
    expect(view).toContain("<code>.obsidian</code>");
    expect(view).toContain("若目标已有 <code>.git</code>，则直接沿用");
    expect(view).toContain('role="status"');
    expect(view).toContain('aria-live="polite"');
  });

  test("settings keeps task-only providers out of the ordinary default", async () => {
    const view = await (await app.request("/settings")).text();
    expect(view).toContain('value="trae-cli"  disabled');
    expect(view).toContain("仅用于显式任务");

    const response = await app.request("/settings", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        defaultProvider: "trae-cli",
        defaultModel: "openrouter-3o",
        dailyBudgetUsd: "5",
        dreamHour: "3",
        webPort: "3000",
        rawRetentionDays: "90",
      }).toString(),
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("默认 Provider 必须支持安全的普通对话");
    expect(readSettings(dir)).toEqual({});
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

  test("settings POST rejects a chat timeout outside 1 through 60 minutes", async () => {
    const response = await app.request("/settings", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        defaultProvider: "claude",
        defaultModel: "",
        dailyBudgetUsd: "5",
        chatTimeoutMinutes: "61",
        dreamHour: "3",
        webPort: "3000",
        rawRetentionDays: "90",
      }).toString(),
    });

    expect(response.status).toBe(400);
    const view = await response.text();
    expect(view).toContain("聊天最长回答时间必须是 1 到 60 的整数");
    expect(view).toContain('name="chatTimeoutMinutes" value="61"');
    expect(readSettings(dir)).toEqual({});
  });

  test("settings POST persists default provider/model + config and reflects it back", async () => {
    const form = new URLSearchParams({
      defaultProvider: "claude",
      defaultModel: "sonnet",
      dailyBudgetUsd: "12",
      chatTimeoutMinutes: "25",
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
    expect(view).toContain("sonnet");
    expect(view).toContain('value="claude" selected');
    // dreamHour value is rendered in the number input
    expect(view).toContain('value="5"');
    expect(view).toContain('name="rawRetentionDays"');
    expect(view).toContain('value="30"');
    expect(view).toContain('name="chatTimeoutMinutes" value="25"');
    expect(readSettings(dir).chatTimeoutMinutes).toBe(25);
  });

  test("settings schedules a confirmed external data-directory migration", async () => {
    let scheduled: { destination: string; initializeGit: boolean } | undefined;
    const migrationApp = createWebApp({
      engine,
      dataDirectory: {
        status: () => ({
          currentPath: dir,
          available: true,
          lockedByEnvironment: false,
          gitAvailable: true,
          gitRepository: false,
          restartable: false,
        }),
        scheduleMigration: (input) => {
          scheduled = input;
        },
      },
    });
    const destination = join(dir, "..", "external-homeagent-data");
    const response = await migrationApp.request("/settings/data-directory", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        dataDirectory: destination,
        initializeGit: "on",
        confirmMigration: "on",
      }).toString(),
    });

    expect([302, 303]).toContain(response.status);
    expect(scheduled).toEqual({ destination, initializeGit: true });
    expect(response.headers.get("location")).toContain("%E8%BF%81%E7%A7%BB%E5%B7%B2%E5%AE%89%E6%8E%92");
  });

  test("settings refuses an unconfirmed data-directory migration", async () => {
    let scheduled = false;
    const migrationApp = createWebApp({
      engine,
      dataDirectory: {
        status: () => ({
          currentPath: dir,
          available: true,
          lockedByEnvironment: false,
          gitAvailable: true,
          gitRepository: false,
          restartable: false,
        }),
        scheduleMigration: () => {
          scheduled = true;
        },
      },
    });
    const response = await migrationApp.request("/settings/data-directory", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ dataDirectory: join(dir, "next") }).toString(),
    });

    expect([302, 303]).toContain(response.status);
    expect(scheduled).toBeFalse();
  });

  test("work context: create, edit, and render the current item", async () => {
    const create = new URLSearchParams({
      title: "推进知识治理",
      space: SPACE,
      brief: "把验收证据集中到一个工作上下文。",
      runbook: "1. 跑回归\n2. 检查归档",
    });
    const createdResponse = await app.request("/work", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: create.toString(),
    });

    expect([302, 303]).toContain(createdResponse.status);
    const item = engine.workItems.list(SPACE)[0]!;
    expect(item.active).toBe(true);

    const update = new URLSearchParams({
      title: item.title,
      brief: item.brief,
      runbook: item.runbook,
      phase: "blocked",
      summary: "回归完成，等待审批。",
      blockers: "生产审批",
      nextActions: "申请审批\n准备灰度",
    });
    const updatedResponse = await app.request(`/work/${encodeURIComponent(item.id)}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: update.toString(),
    });
    expect([302, 303]).toContain(updatedResponse.status);

    const view = await (await app.request(`/work/${encodeURIComponent(item.id)}`)).text();
    expect(view).toContain("回归完成，等待审批");
    expect(view).toContain("生产审批");
    expect(view).toContain("当前工作项");
  });

  test("work context: opt in, continue, cancel, and retry controls are rendered", async () => {
    const agent = engine.agents.create({
      name: "工作续跑助手",
      permission: "write",
      workdir: dir,
    });
    engine.registry.updateMeta(SPACE, { agentId: agent.id });
    const item = engine.workItems.create({
      space: SPACE,
      title: "推进灰度发布",
      nextActions: ["更新灰度环境配置"],
    });

    const policyResponse = await app.request(`/work/${encodeURIComponent(item.id)}/continuation`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ autoContinue: "on" }).toString(),
    });
    expect([302, 303]).toContain(policyResponse.status);
    expect(engine.workContinuations.policyFor(item.id, SPACE).autoContinue).toBe(true);

    const continueResponse = await app.request(`/work/${encodeURIComponent(item.id)}/continue`, {
      method: "POST",
    });
    expect([302, 303]).toContain(continueResponse.status);
    const action = engine.workContinuations.list(item.id)[0]!;
    let view = await (await app.request(`/work/${encodeURIComponent(item.id)}`)).text();
    expect(view).toContain("更新灰度环境配置");
    expect(view).toContain("等待审批");
    expect(view).toContain(`/work/actions/${encodeURIComponent(action.id)}/cancel`);
    expect(view).toContain(`name="runId" value="${action.taskRunIds.at(-1)}"`);
    expect(view).toContain(`name="attempt" value="${action.attempt}"`);
    expect(view).toContain('name="autoContinue" checked');

    const cancelResponse = await app.request(`/work/actions/${encodeURIComponent(action.id)}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        runId: action.taskRunIds.at(-1)!,
        attempt: String(action.attempt),
      }).toString(),
    });
    expect([302, 303]).toContain(cancelResponse.status);
    view = await (await app.request(`/work/${encodeURIComponent(item.id)}`)).text();
    expect(view).toContain("已取消");
    expect(view).toContain(`/work/actions/${encodeURIComponent(action.id)}/retry`);
    expect(view).toContain(`name="runId" value="${action.taskRunIds.at(-1)}"`);
    expect(view).toContain(`name="attempt" value="${action.attempt}"`);
  });

  test("work context: stale retry and cancel forms cannot mutate a newer attempt", async () => {
    const agent = engine.agents.create({
      name: "旧表单防重放助手",
      permission: "write",
      workdir: dir,
    });
    engine.registry.updateMeta(SPACE, { agentId: agent.id });
    const item = engine.workItems.create({
      space: SPACE,
      title: "拒绝旧动作表单",
      nextActions: ["更新灰度环境配置"],
    });
    const first = engine.startWorkContinuation(item.id);
    const actionId = first.run.workActionId!;
    const firstAction = engine.workContinuations.get(actionId)!;
    const staleState = {
      runId: first.run.id,
      attempt: String(firstAction.attempt),
    };

    const firstView = await (await app.request(`/work/${encodeURIComponent(item.id)}`)).text();
    expect(firstView).toContain(`name="runId" value="${staleState.runId}"`);
    expect(firstView).toContain(`name="attempt" value="${staleState.attempt}"`);
    await app.request(`/work/actions/${encodeURIComponent(actionId)}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(staleState).toString(),
    });

    const retryView = await (await app.request(`/work/${encodeURIComponent(item.id)}`)).text();
    expect(retryView).toContain(`/work/actions/${encodeURIComponent(actionId)}/retry`);
    expect(retryView).toContain(`name="runId" value="${staleState.runId}"`);
    expect(retryView).toContain(`name="attempt" value="${staleState.attempt}"`);
    await app.request(`/work/actions/${encodeURIComponent(actionId)}/retry`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(staleState).toString(),
    });
    const secondAction = engine.workContinuations.get(actionId)!;
    const secondRunId = secondAction.taskRunIds.at(-1)!;
    expect(secondAction).toEqual(expect.objectContaining({
      status: "awaiting_approval",
      attempt: 2,
      taskRunIds: [first.run.id, secondRunId],
    }));

    const staleCancel = await app.request(`/work/actions/${encodeURIComponent(actionId)}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(staleState).toString(),
    });
    expect(decodeURIComponent(staleCancel.headers.get("location") ?? "")).toContain("取消失败");
    expect(engine.workContinuations.get(actionId)).toEqual(expect.objectContaining({
      status: "awaiting_approval",
      attempt: 2,
      taskRunIds: [first.run.id, secondRunId],
    }));
    expect(engine.getTaskRun(secondRunId)?.status).toBe("awaiting_approval");

    engine.rejectTaskRun(secondRunId, "operator", "结束第二次尝试");
    expect(engine.workContinuations.get(actionId)?.status).toBe("cancelled");
    const staleRetry = await app.request(`/work/actions/${encodeURIComponent(actionId)}/retry`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(staleState).toString(),
    });
    expect(decodeURIComponent(staleRetry.headers.get("location") ?? "")).toContain("重试失败");
    expect(engine.workContinuations.get(actionId)).toEqual(expect.objectContaining({
      status: "cancelled",
      attempt: 2,
      taskRunIds: [first.run.id, secondRunId],
    }));
  });

  test("work action acceptance is visible on Work and Run pages and rejects stale forms", async () => {
    engine.close();
    engine = new KnowledgeEngine({
      dataDir: dir,
      runProvider: async () => "配置已更新，并完成核对",
    });
    engine.ensureSpace(SPACE);
    const agent = engine.agents.create({
      name: "工作验收助手",
      permission: "write",
      workdir: dir,
    });
    engine.registry.updateMeta(SPACE, { agentId: agent.id });
    const item = engine.workItems.create({
      space: SPACE,
      title: "验收灰度变更",
      nextActions: ["更新灰度环境配置"],
    });
    app = createWebApp({ engine });
    const pending = engine.startWorkContinuation(item.id);
    const report = await engine.approveTaskRun(pending.run.id, "operator").completion;
    const actionId = pending.run.workActionId!;

    const workView = await (await app.request(`/work/${encodeURIComponent(item.id)}`)).text();
    expect(workView).toContain("工作动作验收 · 待验收");
    expect(workView).toContain("配置已更新，并完成核对");
    expect(workView).toContain("执行输出已归档");
    expect(workView).toContain(`/work/actions/${encodeURIComponent(actionId)}/accept`);
    expect(workView).toContain(`/work/actions/${encodeURIComponent(actionId)}/reject`);
    expect(workView).toContain(`name="runId" value="${pending.run.id}"`);
    expect(workView).toContain("自动续跑已暂停在验收门");

    const runView = await (await app.request(`/tasks/runs/${encodeURIComponent(pending.run.id)}`)).text();
    expect(runView).toContain("工作动作验收 · 待验收");
    expect(runView).toContain(`/work/${encodeURIComponent(item.id)}`);
    expect(runView).not.toContain(`href="/tasks/${encodeURIComponent(actionId)}"`);

    const stale = await app.request(`/work/actions/${encodeURIComponent(actionId)}/accept`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ runId: "run_stale" }).toString(),
    });
    expect([302, 303]).toContain(stale.status);
    expect(engine.workContinuations.get(actionId)?.status).toBe("awaiting_acceptance");

    const accepted = await app.request(`/work/actions/${encodeURIComponent(actionId)}/accept`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ runId: pending.run.id }).toString(),
    });
    expect([302, 303]).toContain(accepted.status);
    expect(engine.workContinuations.get(actionId)).toEqual(expect.objectContaining({
      status: "succeeded",
      checkpoint: expect.objectContaining({ rawId: report.rawId, taskRunId: pending.run.id }),
    }));
    expect(engine.workItems.get(item.id)?.nextActions).toEqual([]);
    const acceptedView = await (await app.request(`/work/${encodeURIComponent(item.id)}`)).text();
    expect(acceptedView).toContain("工作动作验收 · 已接受");
    expect(acceptedView).toContain("local-admin");
  });

  test("work action rejection requires a reason and exposes the retry boundary", async () => {
    engine.close();
    engine = new KnowledgeEngine({
      dataDir: dir,
      runProvider: async () => "变更命令执行完成",
    });
    engine.ensureSpace(SPACE);
    const agent = engine.agents.create({
      name: "工作驳回助手",
      permission: "write",
      workdir: dir,
    });
    engine.registry.updateMeta(SPACE, { agentId: agent.id });
    const item = engine.workItems.create({
      space: SPACE,
      title: "复核灰度变更",
      nextActions: ["更新灰度环境配置"],
    });
    app = createWebApp({ engine });
    const pending = engine.startWorkContinuation(item.id);
    await engine.approveTaskRun(pending.run.id, "operator").completion;
    const actionId = pending.run.workActionId!;

    await app.request(`/work/actions/${encodeURIComponent(actionId)}/reject`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ runId: pending.run.id, reason: "" }).toString(),
    });
    expect(engine.workContinuations.get(actionId)?.status).toBe("awaiting_acceptance");

    await app.request(`/work/actions/${encodeURIComponent(actionId)}/reject`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        runId: pending.run.id,
        reason: "缺少变更后的环境截图",
      }).toString(),
    });
    const view = await (await app.request(`/work/${encodeURIComponent(item.id)}`)).text();
    expect(view).toContain("工作动作验收 · 已驳回");
    expect(view).toContain("缺少变更后的环境截图");
    expect(view).toContain(`/work/actions/${encodeURIComponent(actionId)}/retry`);
    expect(engine.workItems.get(item.id)?.nextActions).toEqual(["更新灰度环境配置"]);
  });

  test("abandoning a stale blocked action exposes Continue and starts the new WorkItem head", async () => {
    engine.close();
    engine = new KnowledgeEngine({
      dataDir: dir,
      runProvider: async () => "旧发布动作已经执行",
    });
    engine.ensureSpace(SPACE);
    const agent = engine.agents.create({
      name: "动作放弃表单助手",
      permission: "write",
      workdir: dir,
    });
    engine.registry.updateMeta(SPACE, { agentId: agent.id });
    const item = engine.workItems.create({
      space: SPACE,
      title: "放弃受阻发布动作",
      nextActions: ["更新灰度环境配置"],
    });
    app = createWebApp({ engine });
    const pending = engine.startWorkContinuation(item.id);
    await engine.approveTaskRun(pending.run.id, "operator").completion;
    const actionId = pending.run.workActionId!;
    const blocked = engine.rejectWorkAction(
      actionId,
      pending.run.id,
      "local-admin",
      "旧发布方案不再适用",
    );
    const staleToken = {
      runId: pending.run.id,
      attempt: String(blocked.attempt),
    };
    engine.workItems.update(item.id, { nextActions: ["执行新的发布步骤"] });

    const blockedView = await (await app.request(`/work/${encodeURIComponent(item.id)}`)).text();
    expect(blockedView).toContain(`/work/actions/${encodeURIComponent(actionId)}/abandon`);
    expect(blockedView).toContain("放弃受阻动作");
    expect(blockedView).toContain(`name="runId" value="${staleToken.runId}"`);
    expect(blockedView).toContain(`name="attempt" value="${staleToken.attempt}"`);
    expect(blockedView).not.toContain(`/work/actions/${encodeURIComponent(actionId)}/retry`);

    const abandoned = await app.request(`/work/actions/${encodeURIComponent(actionId)}/abandon`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(staleToken).toString(),
    });
    expect([302, 303]).toContain(abandoned.status);
    expect(decodeURIComponent(abandoned.headers.get("location") ?? "")).toContain("已放弃受阻动作");
    expect(engine.workContinuations.get(actionId)?.status).toBe("cancelled");
    expect(engine.workItems.get(item.id)).toEqual(expect.objectContaining({
      phase: "active",
      blockers: [],
      actionBlockers: {},
      nextActions: ["执行新的发布步骤"],
    }));

    const releasedView = await (await app.request(`/work/${encodeURIComponent(item.id)}`)).text();
    expect(releasedView).toContain("继续一次");
    expect(releasedView).toContain(`/work/${encodeURIComponent(item.id)}/continue`);
    expect(releasedView).not.toContain(`/work/actions/${encodeURIComponent(actionId)}/retry`);

    const continued = await app.request(`/work/${encodeURIComponent(item.id)}/continue`, {
      method: "POST",
    });
    expect([302, 303]).toContain(continued.status);
    const nextAction = engine.workContinuations.list(item.id)
      .find((candidate) => candidate.id !== actionId)!;
    expect(nextAction).toEqual(expect.objectContaining({
      instruction: "执行新的发布步骤",
      status: "awaiting_approval",
    }));

    const staleAbandon = await app.request(`/work/actions/${encodeURIComponent(actionId)}/abandon`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(staleToken).toString(),
    });
    expect(decodeURIComponent(staleAbandon.headers.get("location") ?? "")).toContain("放弃失败");
    expect(engine.workContinuations.get(actionId)?.status).toBe("cancelled");
    expect(engine.workContinuations.get(nextAction.id)).toEqual(expect.objectContaining({
      status: "awaiting_approval",
      instruction: "执行新的发布步骤",
    }));
    expect(engine.getTaskRun(nextAction.taskRunIds.at(-1)!)?.status).toBe("awaiting_approval");
  });

  test("a stale abandon token cannot mutate a newer attempt of the same WorkAction", async () => {
    engine.close();
    engine = new KnowledgeEngine({
      dataDir: dir,
      runProvider: async () => "待复核的动作结果",
    });
    engine.ensureSpace(SPACE);
    const agent = engine.agents.create({
      name: "放弃防重放助手",
      permission: "write",
      workdir: dir,
    });
    engine.registry.updateMeta(SPACE, { agentId: agent.id });
    const item = engine.workItems.create({
      space: SPACE,
      title: "拒绝旧放弃表单",
      nextActions: ["更新灰度环境配置"],
    });
    app = createWebApp({ engine });
    const first = engine.startWorkContinuation(item.id);
    await engine.approveTaskRun(first.run.id, "operator").completion;
    const actionId = first.run.workActionId!;
    const rejected = engine.rejectWorkAction(
      actionId,
      first.run.id,
      "local-admin",
      "需要修正后重试",
    );
    const staleToken = {
      runId: first.run.id,
      attempt: String(rejected.attempt),
    };
    const retried = engine.retryWorkAction(actionId, {
      runId: staleToken.runId,
      attempt: Number(staleToken.attempt),
    });

    const staleAbandon = await app.request(`/work/actions/${encodeURIComponent(actionId)}/abandon`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(staleToken).toString(),
    });

    expect(decodeURIComponent(staleAbandon.headers.get("location") ?? "")).toContain("放弃失败");
    expect(engine.workContinuations.get(actionId)).toEqual(expect.objectContaining({
      status: "awaiting_approval",
      attempt: 2,
      taskRunIds: [first.run.id, retried.run.id],
    }));
    expect(engine.getTaskRun(retried.run.id)?.status).toBe("awaiting_approval");
  });

  test("tasks: nav + create + edit + list rendering", async () => {
    const home = await (await app.request("/tasks")).text();
    expect(home).toContain("任务");
    expect(home).toContain("新建任务");
    expect(home).toContain('name="timeoutMinutes" value="12"');
    expect(home).toContain('<option value="weekly"');
    expect(home).toContain('name="dayOfWeek"');

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

  test("tasks: create and render a weekly schedule", async () => {
    const form = new URLSearchParams({
      name: "每周AI",
      space: SPACE,
      topic: "总结本周 AI 进展",
      cadence: "weekly",
      dayOfWeek: "5",
      hour: "17",
      timeoutMinutes: "12",
    });
    form.append("enabled", "on");
    const res = await app.request("/tasks", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    expect([302, 303]).toContain(res.status);

    const created = engine.tasks.list().find((task) => task.name === "每周AI");
    expect(created).toEqual(expect.objectContaining({
      cadence: "weekly",
      dayOfWeek: 5,
      hour: 17,
    }));

    const editor = await (await app.request(`/tasks/${encodeURIComponent(created!.id)}`)).text();
    expect(editor).toContain("每周五 17:00");
    expect(editor).toContain('<option value="5" selected>周五</option>');
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

  test("tasks: create rejects a well-formed space missing from the registry", async () => {
    const response = await app.request("/tasks", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        name: "orphan-space-task",
        space: "team/oc_missing_registry",
        topic: "must not be scheduled",
      }).toString(),
    });

    expect([302, 303]).toContain(response.status);
    expect(decodeURIComponent(response.headers.get("location") ?? ""))
      .toContain("创建失败：请选择有效空间");
    const tasksPage = await (await app.request("/tasks")).text();
    expect(tasksPage).not.toContain("orphan-space-task");
  });

  test("tasks: manual run redirects to a durable run detail and fires onTaskRun", async () => {
    // make the fake client return research text
    fake.onText(() => "研究结果：要点若干");
    mkdirSync(join(skillRoot, "review"), { recursive: true });
    writeFileSync(
      join(skillRoot, "review", "SKILL.md"),
      ["---", "name: review", "description: Review.", "---"].join("\n"),
      "utf8",
    );
    engine.skillCatalog.refresh();
    const agent = engine.agents.create({
      name: "Task Agent",
      provider: "claude",
      visibility: "Team",
      skills: [{
        kind: "source",
        sourceKey: "shared-agents:review",
        name: "review",
      }],
    });
    engine.updateSpaceMeta(SPACE, { agentId: agent.id });
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
    expect(detail).toContain("Skill 解析");
    expect(detail).toContain("review");
    expect(detail).toContain("shared-agents:review");
    // captured into the space as a task raw entry
    expect(engine.registry.store(SPACE).index().listRaw({}).some((r) => r.source === "task")).toBe(true);
  });

  test("tasks: write execution shows its frozen approval request and runs once after approval", async () => {
    let providerCalls = 0;
    const isolatedDir = join(dir, "web-approval");
    const isolatedEngine = new KnowledgeEngine({
      dataDir: isolatedDir,
      runProvider: async (_provider, input) => {
        providerCalls += 1;
        expect(input.prompt).toContain("dangerous original topic");
        expect(input.prompt).not.toContain("harmless current topic");
        return "approved web output";
      },
    });
    isolatedEngine.ensureSpace(SPACE);
    const agent = isolatedEngine.agents.create({
      name: "Web Writer",
      instruction: "frozen admin instruction",
      provider: "claude",
      permission: "write",
      workdir: isolatedDir,
    });
    isolatedEngine.updateSpaceMeta(SPACE, { agentId: agent.id });
    const task = isolatedEngine.tasks.create({
      name: "approve-me",
      space: SPACE,
      topic: "dangerous original topic",
      distillOnRun: false,
    })!;
    const isolatedApp = createWebApp({ engine: isolatedEngine });

    const startResponse = await isolatedApp.request(
      `/tasks/${encodeURIComponent(task.id)}/run`,
      { method: "POST" },
    );
    const run = isolatedEngine.listTaskRuns(task.id)[0]!;
    expect(run.status).toBe("awaiting_approval");
    expect(providerCalls).toBe(0);
    expect(decodeURIComponent(startResponse.headers.get("location") ?? ""))
      .toContain("已提交审批");
    const otherSpace: SpaceId = "team/oc_web_approval_other";
    isolatedEngine.ensureSpace(otherSpace);
    const moveResponse = await isolatedApp.request(
      `/tasks/${encodeURIComponent(task.id)}`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          name: task.name,
          space: otherSpace,
          topic: task.topic,
          cadence: task.cadence,
          hour: String(task.hour),
          timeoutMinutes: String(task.timeoutMinutes),
        }).toString(),
      },
    );
    expect([302, 303]).toContain(moveResponse.status);
    expect(decodeURIComponent(moveResponse.headers.get("location") ?? ""))
      .toContain("已有运行历史");
    expect(isolatedEngine.tasks.get(task.id)?.space).toBe(SPACE);
    isolatedEngine.tasks.update(task.id, { topic: "harmless current topic" });

    const detail = await (
      await isolatedApp.request(`/tasks/runs/${encodeURIComponent(run.id)}`)
    ).text();
    expect(detail).toContain("待审批");
    expect(detail).toContain("高权限执行审批");
    expect(detail).toContain("write");
    expect(detail).toContain(realpathSync(isolatedDir));
    expect(detail).toContain("冻结任务主题");
    expect(detail).toContain("dangerous original topic");
    expect(detail).toContain("frozen admin instruction");
    expect(detail).toContain("审批截止");
    expect(detail).toContain(`/tasks/runs/${encodeURIComponent(run.id)}/approve`);
    expect(detail).toContain(`/tasks/runs/${encodeURIComponent(run.id)}/reject`);

    const approved = await isolatedApp.request(
      `/tasks/runs/${encodeURIComponent(run.id)}/approve`,
      { method: "POST" },
    );
    expect([302, 303]).toContain(approved.status);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (isolatedEngine.getTaskRun(run.id)?.status === "succeeded") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(providerCalls).toBe(1);
    expect(isolatedEngine.getTaskRun(run.id)).toEqual(expect.objectContaining({
      status: "succeeded",
      approval: expect.objectContaining({
        status: "approved",
        decidedBy: "local-admin",
      }),
    }));

    await isolatedApp.request(
      `/tasks/runs/${encodeURIComponent(run.id)}/approve`,
      { method: "POST" },
    );
    expect(providerCalls).toBe(1);
    isolatedEngine.close();
  });

  test("tasks: expired approval is explicit and no longer actionable", async () => {
    engine.ensureSpace(SPACE);
    const task = engine.tasks.create({
      name: "expired web approval",
      space: SPACE,
      topic: "show the closed approval window",
      distillOnRun: false,
    })!;
    const run = engine.taskRuns.start({
      task,
      trigger: "manual",
      distill: false,
      startedAt: 100,
      approvalRequired: true,
      executionPlan: {
        version: 1,
        instruction: "Expired request.",
        provider: "codex",
        execution: { permission: "write", workdir: dir, skills: [] },
      },
    });
    engine.expireTaskRunApprovals(run.approval!.expiresAt!);

    const body = await (
      await app.request(`/tasks/runs/${encodeURIComponent(run.id)}`)
    ).text();
    expect(body).toContain("审批已过期");
    expect(body).toContain("审批截止");
    expect(body).not.toContain(`/tasks/runs/${encodeURIComponent(run.id)}/approve`);
    expect(body).not.toContain(`/tasks/runs/${encodeURIComponent(run.id)}/reject`);
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

  test("tasks: automatic retry state is visible and can be cancelled", async () => {
    const isolatedEngine = new KnowledgeEngine({
      dataDir: join(dir, "automatic-retry-view"),
      runProvider: async () => {
        throw new Error("provider overloaded (503)");
      },
    });
    isolatedEngine.ensureSpace(SPACE);
    const task = isolatedEngine.tasks.create({
      name: "visible automatic retry",
      space: SPACE,
      topic: "show the retry state",
      distillOnRun: false,
    })!;
    const report = await isolatedEngine.runTask(task.id, { trigger: "scheduled" });
    const run = isolatedEngine.getTaskRun(report.runId)!;
    const isolatedApp = createWebApp({ engine: isolatedEngine });

    const body = await (
      await isolatedApp.request(`/tasks/runs/${encodeURIComponent(run.id)}`)
    ).text();
    expect(body).toContain("等待自动重试");
    expect(body).toContain("Provider · overloaded");
    expect(body).toContain("取消自动重试");
    expect(body).toContain(`/tasks/runs/${encodeURIComponent(run.id)}/cancel`);

    const cancelled = await isolatedApp.request(
      `/tasks/runs/${encodeURIComponent(run.id)}/cancel`,
      { method: "POST" },
    );
    expect([302, 303]).toContain(cancelled.status);
    expect(decodeURIComponent(cancelled.headers.get("location") ?? ""))
      .toContain("已取消自动重试");
    expect(isolatedEngine.getTaskRun(run.id)?.retry?.status).toBe("exhausted");
    isolatedEngine.close();
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
