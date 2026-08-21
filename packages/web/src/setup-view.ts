import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import type { LarkProvisioningSession, LarkSetupStatus } from "@homeagent/shared";
import type { SpaceMeta } from "@homeagent/core";
import {
  providerSupportsOrdinaryCompletion,
  type CodexLoginSession,
  type DetectedProvider,
} from "@homeagent/llm";
import type { FeishuRuntimeStatus } from "./integrations.ts";
import type { SetupSnapshot, SetupStep } from "./setup.ts";
import {
  feishuProvisioningPollScript,
  isFeishuProvisioningActive,
  isFeishuProvisioningFailure,
} from "./feishu-provisioning-view.ts";
import { brandMark } from "./brand-mark.ts";
import { safeLarkVerificationUrl } from "./verification-url.ts";

export interface SetupViewInput {
  snapshot: SetupSnapshot;
  providers: DetectedProvider[];
  models: Record<string, string[]>;
  lark: LarkSetupStatus;
  provisioning: LarkProvisioningSession;
  runtime: FeishuRuntimeStatus;
  groups: SpaceMeta[];
  restartRequired: boolean;
  restartable: boolean;
  codex: {
    enabled: boolean;
    canInstall: boolean;
    installed: boolean;
    installing: boolean;
    installError?: string;
    login: CodexLoginSession;
  };
  flashMsg?: string;
}

const STEP_LABELS = {
  ai: "连接 AI",
  feishu: "创建机器人",
  activate: "激活监听",
  done: "开始使用",
} as const satisfies Record<SetupStep, string>;

const SETUP_STYLE = `
  :root {
    --paper:#f3efe4; --paper-deep:#e7dfcf; --ink:#17231e; --muted:#69756d;
    --moss:#2f684c; --moss-dark:#204936; --moss-soft:#dce9de; --sun:#e7b94f;
    --line:rgba(23,35,30,.14); --white:rgba(255,255,255,.68); --danger:#9d3b32;
  }
  * { box-sizing:border-box; }
  html { min-height:100%; background:var(--paper); }
  body { margin:0; min-height:100vh; color:var(--ink); background:
    radial-gradient(circle at 82% 8%, rgba(231,185,79,.2), transparent 30rem),
    radial-gradient(circle at 8% 88%, rgba(47,104,76,.1), transparent 26rem),
    linear-gradient(135deg,var(--paper),#f8f5ed 58%,var(--paper-deep));
    font-family:"Avenir Next","PingFang SC",sans-serif; }
  body:before { content:""; position:fixed; inset:0; pointer-events:none; opacity:.22;
    background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 180 180' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='.08'/%3E%3C/svg%3E"); }
  a { color:var(--moss-dark); }
  .shell { position:relative; width:min(1040px,calc(100% - 36px)); min-height:100vh; margin:auto;
    display:grid; grid-template-columns:260px minmax(0,680px); gap:74px; align-items:center; padding:54px 0; }
  .brand { position:absolute; top:28px; left:0; display:flex; align-items:center; gap:10px;
    color:var(--ink); font-weight:700; letter-spacing:.02em; text-decoration:none; }
  .brand:hover { text-decoration:none; }
  .brand .homeagent-brand-mark { flex:0 0 auto; }
  .progress { align-self:center; }
  .progress-kicker { color:var(--moss); font-size:12px; font-weight:700; letter-spacing:.16em;
    text-transform:uppercase; margin-bottom:26px; }
  .step { position:relative; display:grid; grid-template-columns:28px 1fr; gap:12px; min-height:58px;
    color:var(--muted); font-size:13px; }
  .step:not(:last-child):after { content:""; position:absolute; left:13px; top:27px; bottom:-3px;
    width:1px; background:var(--line); }
  .node { position:relative; z-index:1; width:28px; height:28px; display:grid; place-items:center;
    border:1px solid var(--line); border-radius:50%; background:var(--paper); font-size:11px; }
  .step.done .node { background:var(--moss); color:white; border-color:var(--moss); }
  .step.current { color:var(--ink); font-weight:700; }
  .step.current .node { border-color:var(--moss); box-shadow:0 0 0 5px rgba(47,104,76,.1); }
  .step-label { padding-top:4px; }
  .stage { position:relative; background:var(--white); border:1px solid rgba(255,255,255,.75);
    border-radius:28px; padding:clamp(28px,5vw,58px); box-shadow:0 30px 90px rgba(38,48,40,.12);
    backdrop-filter:blur(18px); animation:arrive .36s ease-out both; }
  .eyebrow { color:var(--moss); font-size:12px; font-weight:800; letter-spacing:.14em;
    text-transform:uppercase; margin-bottom:18px; }
  .setup-title { margin:0; max-width:600px; font-family:"Iowan Old Style","Songti SC",serif;
    font-size:clamp(2.35rem,5.6vw,4.7rem); line-height:.98; letter-spacing:-.035em; font-weight:600; }
  .lede { max-width:560px; margin:22px 0 30px; color:var(--muted); font-size:16px; line-height:1.75; }
  .flash { padding:11px 14px; border-radius:12px; background:var(--moss-soft); color:var(--moss-dark);
    font-size:13px; margin-bottom:22px; }
  .field { display:flex; flex-direction:column; gap:7px; margin:0 0 16px; }
  .field label { font-size:13px; font-weight:700; }
  select,input { width:100%; border:1px solid var(--line); background:rgba(255,255,255,.72);
    border-radius:12px; padding:12px 14px; color:var(--ink); font:inherit; }
  select:focus,input:focus { outline:3px solid rgba(47,104,76,.15); border-color:var(--moss); }
  button,.button { appearance:none; display:inline-flex; align-items:center; justify-content:center; gap:8px;
    border:0; border-radius:999px; padding:13px 21px; font:700 14px/1 "Avenir Next","PingFang SC",sans-serif;
    cursor:pointer; text-decoration:none; transition:transform .18s ease,box-shadow .18s ease,background .18s ease; }
  button:hover,.button:hover { transform:translateY(-1px); text-decoration:none; }
  .primary-action { background:var(--moss); color:#fff; box-shadow:0 10px 24px rgba(47,104,76,.22); }
  .primary-action:hover { background:var(--moss-dark); }
  .secondary-action { color:var(--ink); background:transparent; border:1px solid var(--line); box-shadow:none; }
  .actions { display:flex; align-items:center; flex-wrap:wrap; gap:10px; margin-top:24px; }
  .choice-grid { display:grid; grid-template-columns:1fr 1fr; gap:12px; margin:20px 0; }
  .choice { border:1px solid var(--line); border-radius:16px; padding:16px; background:rgba(255,255,255,.48); }
  .choice strong { display:block; margin-bottom:4px; }
  .choice small,.muted { color:var(--muted); font-size:12px; }
  .consent { display:grid; grid-template-columns:20px 1fr; gap:10px; align-items:start; color:var(--muted);
    font-size:12px; line-height:1.6; }
  .consent input { width:18px; height:18px; margin:1px 0 0; accent-color:var(--moss); }
  .command { margin-top:10px; padding:10px; border-radius:9px; background:var(--ink); color:#e9efe9;
    overflow:auto; font:11px/1.45 ui-monospace,SFMono-Regular,monospace; user-select:all; }
  details { margin-top:28px; padding-top:18px; border-top:1px solid var(--line); }
  summary { cursor:pointer; color:var(--muted); font-size:13px; }
  .waiting { padding:18px; border-radius:16px; background:var(--moss-soft); }
  .waiting strong { display:block; margin-bottom:6px; }
  .status-list { display:grid; gap:9px; margin:20px 0; }
  .status-row { display:flex; justify-content:space-between; gap:18px; padding:12px 0; border-bottom:1px solid var(--line); }
  .status-row span:last-child { color:var(--muted); font-size:13px; text-align:right; }
  .bot-token { display:inline-flex; align-items:center; gap:9px; padding:8px 12px; border:1px solid var(--line);
    background:rgba(255,255,255,.55); border-radius:999px; font-size:13px; }
  @keyframes arrive { from { opacity:0; transform:translateY(14px); } to { opacity:1; transform:none; } }
  @media (max-width:760px) {
    .shell { display:block; width:min(100% - 24px,680px); padding:86px 0 24px; }
    .progress { margin-bottom:22px; display:flex; overflow:auto; gap:6px; }
    .progress-kicker { display:none; }
    .step { min-height:0; display:flex; align-items:center; white-space:nowrap; }
    .step:not(:last-child):after { display:none; }
    .step-label { display:none; }
    .step.current .step-label { display:block; padding:0 8px 0 0; }
    .stage { border-radius:22px; }
    .choice-grid { grid-template-columns:1fr; }
  }
  @media (prefers-reduced-motion:reduce) { * { animation:none!important; transition:none!important; } }
`;

export function setupLayout(body: HtmlEscapedString | Promise<HtmlEscapedString>): HtmlEscapedString | Promise<HtmlEscapedString> {
  return html`<!doctype html>
  <html lang="zh-CN">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width,initial-scale=1" />
      <title>开始使用 · homeagent</title>
      <style>${raw(SETUP_STYLE)}</style>
    </head>
    <body>${body}</body>
  </html>`;
}

function safeCodexVerificationUrl(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) {
      return undefined;
    }
    if (!["auth.openai.com", "chatgpt.com"].includes(parsed.hostname)) return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function progress(snapshot: SetupSnapshot): HtmlEscapedString | Promise<HtmlEscapedString> {
  const steps = (Object.keys(STEP_LABELS) as Array<keyof typeof STEP_LABELS>).map((step, index) => {
    const done = snapshot.completed.includes(step);
    const current = snapshot.current === step;
    return html`<div class="step ${done ? "done" : ""} ${current ? "current" : ""}">
      <span class="node">${done ? "✓" : index + 1}</span><span class="step-label">${STEP_LABELS[step]}</span>
    </div>`;
  });
  return html`<aside class="progress" aria-label="设置进度">
    <div class="progress-kicker">Your memory, awake</div>${steps}
  </aside>`;
}

function managedCodexSetup(
  input: SetupViewInput,
  primary = false,
): HtmlEscapedString | Promise<HtmlEscapedString> | string {
  if (!input.codex.enabled) return "";
  const needsInstall = input.codex.canInstall && !input.codex.installed;
  const error = input.codex.installError
    || (["failed", "expired", "cancelled"].includes(input.codex.login.state)
      ? input.codex.login.message
      : undefined);
  const repair = error && input.codex.canInstall && input.codex.installed
    ? html`<div class="actions"><form method="post" action="/setup/ai/codex/install">
        <label class="consent"><input type="checkbox" name="consent" value="on" required />
          <span>允许重新下载并校验 OpenAI 官方 Codex，替换 HomeAgent 专用目录中的现有文件。</span></label>
        <button class="secondary-action">重新安装 Codex</button>
      </form></div>`
    : "";
  const action = html`<form method="post" action="${needsInstall ? "/setup/ai/codex/install" : "/setup/ai/codex/login"}">
    ${needsInstall ? html`<label class="consent"><input type="checkbox" name="consent" value="on" required />
      <span>允许 HomeAgent 下载并校验 OpenAI 官方 Codex，将它安装在本机 HomeAgent 专用目录。不会修改系统级软件。</span></label>` : ""}
    <div class="actions"><button class="${primary ? "primary-action" : "secondary-action"}">${needsInstall ? "安装并连接 ChatGPT" : "连接 ChatGPT"}</button></div>
  </form>`;
  const content = html`<p class="muted">HomeAgent 会使用 OpenAI 官方 Codex 连接 ChatGPT。连接后可用于普通问答和显式任务；普通会话使用临时只读模式，并从绑定 Agent 的 Workdir 读取上下文。</p>
    ${error ? html`<div class="flash">${error}</div>` : ""}
    ${action}
    ${repair}
  `;
  return primary
    ? content
    : html`<details><summary>连接 ChatGPT</summary>${content}</details>`;
}

function advancedProviderSetup(taskOnlyAvailable: DetectedProvider[]): HtmlEscapedString | Promise<HtmlEscapedString> {
  return html`<details><summary>高级选项：使用其他本机 Provider</summary>
    <p class="muted">如果你已经自行安装并登录 Claude Code，可以重新检测并把它用于普通问答、提炼和学习；HomeAgent 不会在首次设置中代为安装 Claude。</p>
    ${taskOnlyAvailable.length > 0 ? html`<p class="muted">已检测到 ${taskOnlyAvailable.map((provider) => provider.name).join("、")}，但它目前只能用于显式任务。</p>` : ""}
    <form method="post" action="/setup/providers/refresh" class="actions"><button class="secondary-action">重新检测本机 Provider</button></form>
  </details>`;
}

function aiStep(input: SetupViewInput): HtmlEscapedString | Promise<HtmlEscapedString> {
  const available = input.providers.filter(
    (provider) => provider.available && providerSupportsOrdinaryCompletion(provider.id),
  );
  const taskOnlyAvailable = input.providers.filter(
    (provider) => provider.available && !providerSupportsOrdinaryCompletion(provider.id),
  );
  const codexUrl = safeCodexVerificationUrl(input.codex.login.verificationUrl);
  const codexWaiting = input.codex.installing
    || ["starting", "waiting_for_user", "verifying"].includes(input.codex.login.state);
  if (input.codex.enabled && codexWaiting) {
    const title = input.codex.installing
      ? "正在准备 Codex…"
      : input.codex.login.state === "verifying"
        ? "正在确认 ChatGPT 登录…"
        : "请在浏览器中确认登录";
    return html`<div class="eyebrow">01 · AI</div><h1 class="setup-title">正在准备 Codex</h1>
      <p class="lede">登录授权由 OpenAI 页面处理，HomeAgent 不会接触你的密码。登录后可用于普通问答和显式任务。</p>
      <div class="waiting"><strong>${title}</strong>
        <span class="muted">${input.codex.installing ? "正在下载并校验 OpenAI 官方 Codex" : input.codex.login.message}</span>
        ${input.codex.login.userCode ? html`<div class="command">${input.codex.login.userCode}</div>` : ""}
        ${codexUrl ? html`<div class="actions"><a class="button primary-action" href="${codexUrl}" target="_blank" rel="noreferrer">打开 OpenAI 并确认</a></div>` : ""}
      </div>${codexPollScript()}`;
  }
  if (available.length === 0) {
    if (input.codex.enabled && input.codex.canInstall) {
      return html`<div class="eyebrow">01 · AI</div><h1 class="setup-title">用 ChatGPT 唤醒 HomeAgent</h1>
        ${input.codex.installed
          ? html`<p class="lede">Codex 已安装，尚未连接 ChatGPT。无需打开终端，点击下方按钮后在 OpenAI 官方页面完成登录。</p>`
          : html`<p class="lede">无需打开终端。HomeAgent 会在你确认后下载并校验 OpenAI 官方 Codex，再打开官方页面完成 ChatGPT 登录。</p>`}
        ${managedCodexSetup(input, true)}
        ${advancedProviderSetup(taskOnlyAvailable)}`;
    }
    return html`<div class="eyebrow">01 · AI</div><h1 class="setup-title">先连接 Claude Code 或 Codex</h1>
      <p class="lede">安装并登录任一可用 AI 后回来重新检测。Claude 使用严格 no-tools 模式；Codex 普通会话使用临时只读模式。</p>
      <div class="choice-grid"><div class="choice"><strong>Claude Code</strong><small>普通问答、提炼和学习使用严格 no-tools 模式</small><div class="command">npm install -g @anthropic-ai/claude-code && claude auth login</div></div></div>
      ${taskOnlyAvailable.length > 0 ? html`<p class="muted">已检测到 ${taskOnlyAvailable.map((provider) => provider.name).join("、")}，但它目前只能用于显式任务。</p>` : ""}
      <form method="post" action="/setup/providers/refresh" class="actions"><button class="primary-action">重新检测</button></form>
      ${managedCodexSetup(input)}`;
  }
  return html`<div class="eyebrow">01 · AI</div><h1 class="setup-title">先连接一个 AI</h1>
    <p class="lede">检测到本机已有可用的 AI。它负责理解消息、整理知识和回答问题，账号仍由你自己掌控。</p>
    ${available.some((provider) => provider.id === "codex")
      ? html`<p class="muted">Codex 普通会话使用临时只读模式，以绑定 Agent 的 Workdir 作为上下文目录，不加载本机 Skills、用户配置或规则。</p>`
      : ""}
    ${providerChoice(input, available)}`;
}

function providerChoice(
  input: SetupViewInput,
  available: DetectedProvider[],
): HtmlEscapedString | Promise<HtmlEscapedString> {
  const options = available.map((provider) => html`<option value="${provider.id}" data-models="${JSON.stringify(input.models[provider.id] ?? [])}">${provider.name} · ${provider.detail}</option>`);
  const first = available[0]!;
  const modelOptions = (input.models[first.id] ?? []).map((model) => html`<option value="${model}">${model}</option>`);
  return html`<form method="post" action="/setup/ai">
      <div class="field"><label for="provider">使用哪个 AI</label><select id="provider" name="provider">${options}</select></div>
      <div class="field"><label for="model">模型 <span class="muted">可稍后修改</span></label><select id="model" name="model"><option value="">使用 AI 默认模型</option>${modelOptions}</select></div>
      <div class="actions"><button class="primary-action">使用这个 AI</button></div>
    </form>
    <script>
      (function () {
        var provider = document.getElementById("provider");
        var model = document.getElementById("model");
        function syncModels() {
          var selected = provider.options[provider.selectedIndex];
          var values = [];
          try { values = JSON.parse(selected.dataset.models || "[]"); } catch (_) {}
          model.replaceChildren(new Option("使用 AI 默认模型", ""));
          values.forEach(function (value) { model.add(new Option(value, value)); });
        }
        provider.addEventListener("change", syncModels);
      })();
    </script>`;
}

function codexPollScript(): HtmlEscapedString | Promise<HtmlEscapedString> {
  return html`<script>
    (function poll() {
      fetch("/setup/ai/codex/session", { cache: "no-store" }).then(function (response) { return response.json(); })
        .then(function (session) {
          if (["ready", "failed", "expired", "cancelled"].includes(session.state)) location.reload();
          else setTimeout(poll, 1200);
        }).catch(function () { setTimeout(poll, 2200); });
    })();
  </script>`;
}

function feishuStep(input: SetupViewInput): HtmlEscapedString | Promise<HtmlEscapedString> {
  const url = safeLarkVerificationUrl(input.provisioning.verificationUrl);
  const waiting = isFeishuProvisioningActive(input.provisioning.state);
  const failure = isFeishuProvisioningFailure(input.provisioning.state)
    ? html`<div class="flash">${input.provisioning.message}</div>`
    : "";
  const primary = waiting
    ? html`<div class="waiting"><strong>${input.provisioning.state === "verifying" ? "正在确认机器人…" : "等待你在飞书确认"}</strong>
        <span class="muted">${input.provisioning.message}</span>
        ${url ? html`<div class="actions"><a class="button primary-action" href="${url}" target="_blank" rel="noreferrer">打开飞书并确认</a></div>` : ""}
      </div>${feishuProvisioningPollScript()}`
    : html`<form method="post" action="/setup/feishu/automatic">
        <input type="hidden" name="brand" value="feishu" />
        <div class="actions"><button class="primary-action">一键创建飞书机器人</button></div>
      </form>`;
  return html`<div class="eyebrow">02 · Feishu</div><h1 class="setup-title">让记忆住进飞书</h1>
    <p class="lede">HomeAgent 会通过飞书官方流程创建专属机器人。首次确认会一次申请消息收发、群消息读取、附件与表情、群信息，以及接收消息和机器人入群事件。企业管理员可能需要在这次创建确认中批准“接收群内全部消息”敏感权限；创建完成后不需要进入开放平台逐项配置。凭据由系统钥匙串保管。</p>
    ${failure}${primary}
    <details><summary>手动输入 App ID</summary>
      <p class="muted">仅用于接入已经存在的企业自建应用。请先确认应用已开通所需权限，并核对消息与机器人入群事件订阅。</p>
      <form method="post" action="/integrations/bot/setup">
        <input type="hidden" name="returnTo" value="/setup" />
        <div class="field"><label>应用平台</label><select name="brand"><option value="feishu">飞书</option><option value="lark"${input.lark.brand === "lark" ? " selected" : ""}>Lark</option></select></div>
        <div class="field"><label>App ID</label><input name="appId" required autocomplete="off" /></div>
        <div class="field"><label>App Secret</label><input type="password" name="appSecret" required autocomplete="new-password" /></div>
        <div class="actions"><button class="secondary-action">验证已有应用</button></div>
      </form>
    </details>`;
}

function consumerLabel(key: string): string {
  if (key === "im.message.receive_v1") return "接收飞书消息";
  if (key === "im.chat.member.bot.added_v1") return "感知机器人加入群聊";
  return "飞书连接";
}

function activateStep(input: SetupViewInput): HtmlEscapedString | Promise<HtmlEscapedString> {
  const failed = input.runtime.consumers.some((consumer) => consumer.state === "failed");
  const rows = input.runtime.consumers.length
    ? input.runtime.consumers.map((consumer) => html`<div class="status-row"><span>${consumerLabel(consumer.key)}</span><span>${consumer.state === "ready" ? "已就绪" : consumer.state === "failed" ? "连接异常" : "正在连接"}</span></div>`)
    : html`<div class="status-row"><span>飞书消息连接</span><span>等待服务重启</span></div>`;
  const failureNotice = html`<div class="waiting">
    <strong>消息监听异常</strong>
    <span class="muted">可能与 HomeAgent 服务进程、网络连接、飞书应用权限或企业审批有关。请重新检查连接，或前往<a href="/health">运行状态</a>查看安全诊断详情。</span>
  </div>`;
  const action = input.restartRequired
    ? input.restartable
      ? html`<form method="post" action="/setup/restart" class="actions"><button class="primary-action">激活消息监听</button></form>`
      : html`<div class="waiting"><strong>需要重启 HomeAgent</strong><span class="muted">请在启动它的终端按 Ctrl+C，然后重新运行 bun start。</span></div>`
    : failed
      ? input.restartable
        ? html`${failureNotice}<form method="post" action="/setup/restart" class="actions"><button class="primary-action">重新检查连接</button></form>`
        : failureNotice
      : html`<div class="waiting"><strong>正在建立消息连接…</strong><span class="muted">通常只需几秒，不需要再次重启。</span></div>
          <script>setTimeout(function () { location.reload(); }, 2000);</script>`;
  return html`<div class="eyebrow">03 · Activate</div><h1 class="setup-title">让机器人开始接收消息</h1>
    <p class="lede">机器人身份已经确认。最后重启一次后台服务，让新的消息通道正式接管。</p>
    <div class="status-list">${rows}</div>${action}
    <details><summary>如果重启后仍未就绪</summary><p class="muted">请先在运行状态确认服务进程和消息消费者状态，再检查网络连接、飞书应用权限以及企业是否有待审批授权。HomeAgent 会保留当前进度，不必重新创建机器人。</p></details>`;
}

function doneStep(input: SetupViewInput): HtmlEscapedString | Promise<HtmlEscapedString> {
  const botName = input.lark.botName ?? "HomeAgent";
  return html`<div class="eyebrow">04 · Ready</div><h1 class="setup-title">一切就绪，记忆开始生长</h1>
    <p class="lede">机器人和消息监听已经就绪。现在可以进入 HomeAgent；群聊连接不再阻塞首次设置。</p>
    <div class="bot-token"><span>●</span><strong>${botName}</strong></div>
    <div class="status-list">
      <div class="status-row"><span>1. 加入群聊</span><span>把机器人加入飞书群聊</span></div>
      <div class="status-row"><span>2. 管理员确认</span><span>@${botName} 启用群聊</span></div>
      <div class="status-row"><span>3. 开始使用</span><span>默认仅响应 @机器人，并在线程内回复</span></div>
    </div>
    <p class="muted">确认前不会读取或记录群消息。之后也可以在 Integrations 查看待确认状态或重新发送提示。</p>
    ${input.groups.length ? html`<p class="muted">当前已有 ${input.groups.length} 个已启用群聊空间。</p>` : ""}
    <form method="post" action="/setup/finish" class="actions"><button class="primary-action">进入 HomeAgent</button></form>`;
}

function setupBrand(): HtmlEscapedString | Promise<HtmlEscapedString> {
  return html`<a class="brand" href="/">${brandMark({
    variant: "full",
    size: 29,
    decorative: true,
  })}homeagent</a>`;
}

export function setupView(input: SetupViewInput): HtmlEscapedString | Promise<HtmlEscapedString> {
  const content = input.snapshot.current === "ai" ? aiStep(input)
    : input.snapshot.current === "feishu" ? feishuStep(input)
      : input.snapshot.current === "activate" ? activateStep(input)
        : doneStep(input);
  return html`<div class="shell">
    ${setupBrand()}
    ${progress(input.snapshot)}
    <main class="stage">${input.flashMsg ? html`<div class="flash">${input.flashMsg}</div>` : ""}${content}</main>
  </div>`;
}

export function restartingView(instanceId: string): HtmlEscapedString | Promise<HtmlEscapedString> {
  return setupLayout(html`<div class="shell">${setupBrand()}
    <aside class="progress"><div class="progress-kicker">Applying connection</div></aside>
    <main class="stage"><div class="eyebrow">03 · Activate</div><h1 class="setup-title">正在唤醒机器人</h1>
      <p class="lede">服务会短暂离线，然后自动回到这里。请不要关闭这个页面。</p><div id="restart-status" data-instance="${instanceId}" class="waiting"><strong>重新连接中…</strong></div>
    </main></div><script>
      (function () {
        var oldInstance = document.getElementById("restart-status").dataset.instance;
        function poll() { fetch("/healthz", { cache:"no-store" }).then(function (r) {
          return r.ok ? r.json() : null;
        }).then(function (health) {
          if (health && health.instanceId && health.instanceId !== oldInstance) location.href="/setup";
          else setTimeout(poll,1000);
        }).catch(function () { setTimeout(poll,1000); }); }
        setTimeout(poll,500);
      })();
    </script>`);
}
