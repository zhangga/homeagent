import { describe, expect, test } from "bun:test";
import type { LarkProvisioningSession, LarkSetupStatus } from "@homeagent/shared";
import { restartingView, setupLayout, setupView } from "./setup-view.ts";
import type { SetupSnapshot, SetupStep } from "./setup.ts";

const providers = [
  { id: "codex" as const, name: "Codex", bin: "codex", available: true, detail: "0.144.1" },
  { id: "claude" as const, name: "Claude Code", bin: "claude", available: false, detail: "未安装" },
];

function snapshot(current: SetupStep): SetupSnapshot {
  const order: SetupStep[] = ["ai", "feishu", "activate", "done"];
  return {
    current,
    completed: order.slice(0, order.indexOf(current)),
    selectedProviderReady: current !== "ai",
    larkReady: ["activate", "done"].includes(current),
    runtimeReady: current === "done",
  };
}

const lark: LarkSetupStatus = {
  state: "unconfigured",
  verified: false,
  message: "尚未配置",
};

const idle: LarkProvisioningSession = {
  state: "idle",
  brand: "feishu",
  message: "尚未开始",
};

function render(current: SetupStep, overrides: Partial<Parameters<typeof setupView>[0]> = {}): string {
  return String(setupLayout(setupView({
    snapshot: snapshot(current),
    providers,
    models: { codex: ["gpt-5.4-mini"] },
    lark,
    provisioning: idle,
    runtime: { ready: false, consumers: [] },
    groups: [],
    restartRequired: false,
    restartable: true,
    codex: {
      enabled: false,
      canInstall: false,
      installed: false,
      installing: false,
      login: { state: "idle", message: "尚未连接" },
    },
    ...overrides,
  })));
}

describe("guided setup view", () => {
  test("offers Codex for ordinary conversations with automatic Skills", () => {
    const body = render("ai");

    expect(body).toContain('<option value="codex"');
    expect(body).toContain("Codex 普通聊天和任务会自动获得全部兼容 Skills");
    expect(body).not.toContain("Codex 只能用于显式任务");
  });

  test("AI step offers one detected-provider choice and one primary submit", () => {
    const body = render("ai", {
      providers: [{
        id: "claude",
        name: "Claude Code",
        bin: "claude",
        available: true,
        detail: "ready",
      }],
      models: { claude: ["sonnet"] },
    });
    expect(body).toContain("先连接一个 AI");
    expect(body).toContain("Claude Code");
    expect(body).toContain("使用这个 AI");
    expect((body.match(/class="primary-action"/g) ?? []).length).toBe(1);
  });

  test("managed Codex is the zero-terminal primary path for a fresh install", () => {
    const install = render("ai", {
      providers: [],
      codex: {
        enabled: true,
        canInstall: true,
        installed: false,
        installing: false,
        login: { state: "idle", message: "尚未连接" },
      },
    });
    expect(install).toContain("用 ChatGPT 唤醒 HomeAgent");
    expect(install).toContain("无需打开终端");
    expect(install).toContain("安装并连接 ChatGPT");
    expect(install).toContain("普通聊天和任务");
    expect(install).toContain("自动获得全部兼容 Skills");
    expect(install).toContain('name="consent"');
    expect(install).toContain("高级选项：使用其他本机 Provider");
    expect(install).toContain("Claude Code");
    expect(install).not.toContain("npm install");

    const waiting = render("ai", {
      providers: [],
      codex: {
        enabled: true,
        canInstall: true,
        installed: true,
        installing: false,
        login: {
          state: "waiting_for_user",
          verificationUrl: "https://auth.openai.com/device",
          userCode: "SAFE-CODE",
          message: "等待确认",
        },
      },
    });
    expect(waiting).toContain("https://auth.openai.com/device");
    expect(waiting).toContain("SAFE-CODE");
    expect(waiting).toContain("/setup/ai/codex/session");
    expect(waiting).toContain("正在准备 Codex");
    expect(waiting).toContain("登录后可用于普通聊天和任务");
    expect(waiting).toContain("自动获得全部兼容 Skills");

    const repair = render("ai", {
      providers: [],
      codex: {
        enabled: true,
        canInstall: true,
        installed: true,
        installing: false,
        login: { state: "failed", message: "ChatGPT 登录未完成，请重试" },
      },
    });
    expect(repair).toContain("重新安装 Codex");
    expect(repair).toContain("替换 HomeAgent 专用目录");
  });

  test("Feishu step makes one-click provisioning primary and manual credentials secondary", () => {
    const body = render("feishu");
    expect(body.indexOf("一键创建飞书机器人")).toBeLessThan(body.indexOf("手动输入 App ID"));
    expect(body).toContain('action="/setup/feishu/automatic"');
    expect(body).toContain("通过飞书官方流程创建专属机器人");
    expect(body).toContain("首次确认会一次申请");
    expect(body).toContain("群消息读取");
    expect(body).toContain("附件与表情");
    expect(body).toContain("接收消息和机器人入群事件");
    expect(body).toContain("企业管理员可能需要在这次创建确认中批准");
    expect(body).toContain("创建完成后不需要进入开放平台逐项配置");
    expect(body).toContain("请先确认应用已开通所需权限，并核对消息与机器人入群事件订阅");
    expect(body).toContain('<select name="brand">');
    expect(body).toContain('<option value="feishu">飞书</option>');
    expect(body).toContain('<option value="lark">Lark</option>');
  });

  test("keeps external sharing out of the onboarding navigation", () => {
    const body = render("activate");

    expect(body).not.toContain("发布对外共享");
  });

  test("manual existing-app setup preselects the configured Lark brand", () => {
    const body = render("feishu", {
      lark: { state: "unconfigured", verified: false, brand: "lark", message: "尚未配置" },
    });

    expect(body).toContain('<option value="lark" selected>Lark</option>');
    expect(body).not.toContain('<option value="feishu" selected>飞书</option>');
  });

  test("waiting provisioning renders the safe URL and polling", () => {
    const body = render("feishu", {
      provisioning: {
        state: "waiting_for_user",
        brand: "feishu",
        verificationUrl: "https://open.feishu.cn/page/launcher?user_code=safe",
        message: "请完成授权",
      },
    });
    expect(body).toContain("https://open.feishu.cn/page/launcher?user_code=safe");
    expect(body).toContain("/setup/feishu/session");
  });

  test("incomplete authorization stays inside the same creation flow", () => {
    const body = render("feishu", {
      provisioning: {
        state: "waiting_for_user",
        brand: "feishu",
        verificationUrl: "https://open.feishu.cn/page/launcher?clientID=cli_safe&addons=SAFE",
        message: "请在飞书确认完整权限和事件订阅",
      },
    });

    expect(body).toContain("请在飞书确认完整权限和事件订阅");
    expect(body).toContain("打开飞书并确认");
    expect(body).not.toContain("进入飞书开放平台");
  });

  test("activation and completion are written in user language", () => {
    const activation = render("activate", {
      lark: { state: "ready", verified: true, botName: "小脑", botOpenId: "ou_bot", message: "ready" },
      restartRequired: true,
      runtime: { ready: false, consumers: [{ key: "im.message.receive_v1", state: "starting" }] },
    });
    expect(activation).toContain("让机器人开始接收消息");
    expect(activation).toContain("接收飞书消息");
    expect(activation).toContain("激活消息监听");

    const runtimeFailure = render("activate", {
      lark: { state: "ready", verified: true, botName: "小脑", botOpenId: "ou_bot", message: "ready" },
      runtime: { ready: false, consumers: [{ key: "im.message.receive_v1", state: "failed", lastError: "raw secret" }] },
    });
    expect(runtimeFailure).toContain("消息监听异常");
    expect(runtimeFailure).toContain("服务进程");
    expect(runtimeFailure).toContain("网络连接");
    expect(runtimeFailure).toContain("应用权限");
    expect(runtimeFailure).toContain("企业审批");
    expect(runtimeFailure).not.toContain("连接还没有通过企业确认");
    expect(runtimeFailure).not.toContain("进入飞书开放平台手动创建");
    expect(runtimeFailure).not.toContain("raw secret");
    expect(runtimeFailure).toContain('action="/setup/restart"');
    expect(runtimeFailure).toContain('href="/health"');

    const done = render("done", {
      lark: { state: "ready", verified: true, botName: "小脑", botOpenId: "ou_bot", message: "ready" },
    });
    expect(done).toContain("小脑");
    expect(done).toContain("@小脑 启用群聊");
    expect(done).toContain("确认前不会读取或记录群消息");
  });

  test("failed provisioning explains the failure without exposing CLI output", () => {
    const body = render("feishu", {
      provisioning: { state: "failed", brand: "feishu", message: "飞书应用创建未完成，请重试" },
    });
    expect(body).toContain("飞书应用创建未完成，请重试");
  });

  test("restart page waits for a different process instance", () => {
    const body = String(restartingView("old-process"));
    expect(body).toContain('data-instance="old-process"');
    expect(body).toContain("health.instanceId !== oldInstance");
  });

  test("done step enters the knowledge dashboard", () => {
    const body = render("done");
    expect(body).toContain("一切就绪");
    expect(body).toContain("把机器人加入飞书群聊");
    expect(body).toContain("@HomeAgent 启用群聊");
    expect(body).toContain('action="/setup/finish"');
  });
});
