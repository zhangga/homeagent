import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import { codexReasoningEffortsForModel } from "@homeagent/llm";
import {
  reasoningEffortsForEditor,
  type AgentFieldErrors,
  type AgentWorkbenchView,
} from "./agent-workbench.ts";

const STATUS_LABELS = {
  running: "运行中",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消",
  timed_out: "已超时",
} as const;

const PERMISSION_LABELS: Record<string, string> = {
  "read-only": "只读",
  write: "工作区可写",
  full: "完全访问",
};

const REASONING_LABELS: Record<string, string> = {
  none: "无",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "超高",
  max: "最大",
};

const AGENT_STYLE = `
  main.agent-page {
    max-width:none;
    margin:0;
    padding:0;
    height:100vh;
    overflow:hidden;
  }
  main.agent-page > .crumbs { display:none; }
  main.agent-page > #runtime-health-alert {
    position:fixed;
    z-index:80;
    top:12px;
    left:50%;
    transform:translateX(-50%);
    margin:0;
  }
  .agent-workbench {
    --agent-list-width:244px;
    --agent-inspector-width:324px;
    display:grid;
    grid-template-columns:var(--agent-list-width) minmax(420px, 1fr) var(--agent-inspector-width);
    height:100vh;
    min-height:560px;
    overflow:hidden;
    background:#f7f7f5;
    color:#20201d;
  }
  .agent-pane { min-width:0; height:100%; overflow:auto; background:#fff; }
  .agent-list-pane, .agent-inspector-pane { background:#f5f5f2; }
  .agent-list-pane { position:relative; border-right:1px solid #deded9; }
  .agent-editor-pane { position:relative; background:#fff; }
  .agent-inspector-pane { position:relative; border-left:1px solid #deded9; }
  .agent-pane-header {
    position:sticky;
    top:0;
    z-index:10;
    display:flex;
    align-items:center;
    justify-content:space-between;
    min-height:58px;
    padding:0 18px;
    border-bottom:1px solid #e6e6e1;
    background:rgba(255,255,255,.94);
    backdrop-filter:blur(12px);
  }
  .agent-list-pane .agent-pane-header,
  .agent-inspector-pane .agent-pane-header { background:rgba(245,245,242,.95); }
  .agent-pane-title { margin:0; font-size:15px; line-height:1.2; font-weight:680; letter-spacing:-.01em; }
  .agent-count { color:#85857f; font-size:12px; font-variant-numeric:tabular-nums; }
  .agent-icon-button {
    display:inline-flex;
    align-items:center;
    justify-content:center;
    width:30px;
    height:30px;
    padding:0;
    border:1px solid #d9d9d3;
    border-radius:7px;
    background:#fff;
    color:#262622;
    font-size:20px;
    line-height:1;
  }
  .agent-icon-button:hover { background:#efefeb; filter:none; text-decoration:none; }
  .agent-list { padding:8px; }
  .agent-list-item {
    display:block;
    margin:2px 0;
    padding:11px 10px;
    border:1px solid transparent;
    border-radius:8px;
    color:inherit;
  }
  .agent-list-item:hover { background:#ecece8; text-decoration:none; }
  .agent-list-item.active {
    border-color:#d2d2cc;
    background:#fff;
    box-shadow:0 1px 2px rgba(20,20,16,.04);
  }
  .agent-list-name-row { display:flex; align-items:center; gap:7px; min-width:0; }
  .agent-list-name {
    overflow:hidden;
    flex:1;
    color:#252520;
    font-size:13px;
    font-weight:640;
    text-overflow:ellipsis;
    white-space:nowrap;
  }
  .agent-status-mark {
    width:7px;
    height:7px;
    flex:0 0 auto;
    border-radius:50%;
    background:#aaa9a2;
  }
  .agent-status-mark.ready { background:#21845a; }
  .agent-status-mark.running {
    background:#b66d08;
    box-shadow:0 0 0 3px #f8e9cf;
  }
  .agent-list-meta {
    display:flex;
    gap:5px;
    margin:5px 0 0 14px;
    overflow:hidden;
    color:#777771;
    font-size:11px;
    white-space:nowrap;
  }
  .agent-list-meta span { overflow:hidden; text-overflow:ellipsis; }
  .agent-list-meta span + span::before { content:"·"; margin-right:5px; color:#b1b1aa; }
  .agent-empty-list { padding:28px 18px; color:#85857f; font-size:13px; text-align:center; }
  .agent-resizer {
    position:absolute;
    z-index:30;
    top:0;
    bottom:0;
    width:7px;
    cursor:col-resize;
  }
  .agent-resizer::after {
    position:absolute;
    top:0;
    bottom:0;
    left:3px;
    width:1px;
    background:transparent;
    content:"";
  }
  .agent-resizer:hover::after, .agent-resizer.dragging::after { background:#9a9a93; }
  .agent-resizer-list { right:0; }
  .agent-resizer-inspector { left:0; }

  .agent-editor-header { padding:0 26px; }
  .agent-editor-heading { display:flex; min-width:0; align-items:center; gap:10px; }
  .agent-mobile-back { display:none; color:#4e4e49; font-size:13px; }
  .agent-title-text {
    max-width:min(440px, 42vw);
    overflow:hidden;
    font-size:14px;
    font-weight:650;
    text-overflow:ellipsis;
    white-space:nowrap;
  }
  .agent-save-state {
    display:none;
    padding:2px 7px;
    border-radius:999px;
    background:#f6e8cf;
    color:#865510;
    font-size:11px;
  }
  .agent-save-state.visible { display:inline-block; }
  .agent-editor-actions { display:flex; align-items:center; gap:8px; }
  .agent-inspector-toggle { display:none; }
  .agent-primary, .agent-secondary, .agent-danger {
    min-height:32px;
    border-radius:7px;
    padding:6px 13px;
    font-size:13px;
    font-weight:620;
  }
  .agent-primary { background:#242420; color:#fff; }
  .agent-primary:hover { filter:none; background:#090908; }
  .agent-secondary { border:1px solid #d8d8d2; background:#fff; color:#33332f; }
  .agent-secondary:hover { filter:none; background:#f2f2ee; text-decoration:none; }
  .agent-danger { border:1px solid #e1c6c2; background:#fff; color:#a7372c; }
  .agent-danger:hover { filter:none; background:#fff2f0; }
  .agent-editor-scroll { max-width:820px; margin:0 auto; padding:34px 46px 96px; }
  .agent-form-intro { margin-bottom:30px; }
  .agent-form-intro h1 {
    margin:0;
    font-size:26px;
    line-height:1.25;
    font-weight:680;
    letter-spacing:-.025em;
  }
  .agent-form-intro p { max-width:620px; margin:8px 0 0; color:#777771; font-size:13px; }
  .agent-form-section { padding:25px 0 28px; border-top:1px solid #e9e9e4; }
  .agent-form-section:first-of-type { border-top:0; padding-top:0; }
  .agent-section-heading { margin:0 0 17px; font-size:12px; font-weight:700; letter-spacing:.06em; text-transform:uppercase; color:#777771; }
  .agent-field { display:grid; grid-template-columns:164px minmax(0, 1fr); gap:24px; align-items:start; margin-bottom:18px; }
  .agent-field:last-child { margin-bottom:0; }
  .agent-field-label { padding-top:8px; color:#353530; font-size:13px; font-weight:620; }
  .agent-field-label small { display:block; margin-top:3px; color:#92928b; font-size:11px; font-weight:400; line-height:1.35; }
  .agent-field-control input,
  .agent-field-control select,
  .agent-field-control textarea {
    width:100%;
    border:1px solid #d8d8d2;
    border-radius:7px;
    background:#fff;
    color:#242420;
    box-shadow:0 1px 1px rgba(20,20,16,.02);
    font-size:13px;
  }
  .agent-field-control input, .agent-field-control select { min-height:36px; padding:7px 10px; }
  .agent-field-control textarea {
    min-height:220px;
    padding:12px;
    resize:vertical;
    line-height:1.65;
  }
  .agent-field-control input:focus,
  .agent-field-control select:focus,
  .agent-field-control textarea:focus {
    border-color:#777771;
    outline:0;
    box-shadow:0 0 0 3px #efefeb;
  }
  .agent-field-control [aria-invalid="true"] { border-color:#c95c51; }
  .agent-field-hint { margin:6px 1px 0; color:#8a8a84; font-size:11px; }
  .agent-field-error { margin:6px 1px 0; color:#b33b31; font-size:12px; }
  .agent-form-alert {
    margin:0 0 22px;
    padding:10px 12px;
    border:1px solid #ecc9c4;
    border-radius:7px;
    background:#fff4f2;
    color:#96372e;
    font-size:13px;
  }
  .agent-flash {
    margin:0 0 22px;
    padding:10px 12px;
    border:1px solid #bcdcc9;
    border-radius:7px;
    background:#f0faf4;
    color:#216844;
    font-size:13px;
  }
  .agent-empty-editor {
    display:flex;
    height:100%;
    min-height:420px;
    align-items:center;
    justify-content:center;
    padding:36px;
    text-align:center;
  }
  .agent-empty-editor h1 { margin:0 0 8px; font-size:21px; }
  .agent-empty-editor p { margin:0 0 18px; color:#7c7c76; font-size:13px; }

  .agent-inspector-content { padding:6px 18px 34px; }
  .agent-inspector-section { padding:19px 0; border-bottom:1px solid #e2e2dd; }
  .agent-inspector-section:last-child { border-bottom:0; }
  .agent-inspector-label {
    display:flex;
    align-items:center;
    justify-content:space-between;
    margin:0 0 11px;
    color:#75756f;
    font-size:11px;
    font-weight:700;
    letter-spacing:.06em;
    text-transform:uppercase;
  }
  .agent-provider-state { display:flex; align-items:flex-start; gap:10px; }
  .agent-provider-state .agent-status-mark { margin-top:6px; }
  .agent-provider-name { font-size:13px; font-weight:650; }
  .agent-provider-detail { margin-top:2px; color:#85857f; font-size:11px; overflow-wrap:anywhere; }
  .agent-binding, .agent-run {
    display:block;
    margin:0 -8px 3px;
    padding:8px;
    border-radius:7px;
    color:inherit;
  }
  .agent-run:hover { background:#ebebe7; }
  .agent-run-title:hover { text-decoration:underline; }
  .agent-binding-title, .agent-run-title { color:#33332f; font-size:12px; font-weight:620; }
  .agent-binding-meta, .agent-run-meta { margin-top:3px; color:#85857f; font-size:10.5px; line-height:1.4; overflow-wrap:anywhere; }
  .agent-run-row { display:flex; align-items:center; justify-content:space-between; gap:8px; }
  .agent-run-status {
    flex:0 0 auto;
    padding:1px 6px;
    border-radius:999px;
    background:#e8e8e3;
    color:#64645f;
    font-size:10px;
  }
  .agent-run-status.running { background:#f8e8cf; color:#85530c; }
  .agent-run-status.succeeded { background:#dff1e6; color:#246947; }
  .agent-run-status.failed, .agent-run-status.timed_out { background:#f7dfdc; color:#9c382f; }
  .agent-run-actions { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-top:5px; }
  .agent-run-retry {
    padding:2px 7px;
    border:1px solid #d8d8d2;
    border-radius:5px;
    background:#fff;
    color:#55554f;
    font-size:10px;
  }
  .agent-run-retry:hover { background:#f3f3ef; filter:none; }
  .agent-load-more {
    display:block;
    margin-top:8px;
    padding:6px 8px;
    border:1px solid #d8d8d2;
    border-radius:6px;
    color:#55554f;
    font-size:11px;
    text-align:center;
  }
  .agent-load-more:hover { background:#ebebe7; text-decoration:none; }
  .agent-inspector-empty { padding:4px 0; color:#989891; font-size:12px; }
  .agent-delete-note { margin:0 0 10px; color:#8b8b85; font-size:11px; }
  .agent-inspector-overlay { display:none; }

  @media (max-width:1179px) {
    body:has(main.agent-page) nav.rail { width:64px; min-width:64px; }
    body:has(main.agent-page) nav.rail .brand {
      overflow:hidden;
      width:36px;
      font-size:0;
      white-space:nowrap;
    }
    body:has(main.agent-page) nav.rail .brand::after { content:"H"; font-size:16px; }
    body:has(main.agent-page) nav.rail a { justify-content:center; font-size:0; }
    body:has(main.agent-page) nav.rail .ico { font-size:16px; }
    body:has(main.agent-page) nav.rail .foot { display:none; }
    .agent-workbench { grid-template-columns:var(--agent-list-width) minmax(420px, 1fr); }
    .agent-inspector-toggle { display:inline-flex; }
    .agent-inspector-pane {
      position:fixed;
      z-index:61;
      top:0;
      right:0;
      width:min(360px, calc(100vw - 40px));
      transform:translateX(102%);
      box-shadow:-18px 0 46px rgba(24,24,20,.15);
      transition:transform .18s ease;
    }
    .agent-inspector-pane.open { transform:translateX(0); }
    .agent-inspector-overlay {
      position:fixed;
      z-index:60;
      inset:0;
      display:block;
      border:0;
      border-radius:0;
      background:rgba(20,20,18,.18);
      opacity:0;
      pointer-events:none;
      transition:opacity .18s ease;
    }
    .agent-inspector-overlay.open { opacity:1; pointer-events:auto; }
    .agent-resizer-inspector { display:none; }
  }
  @media (max-width:759px) {
    main.agent-page { height:auto; min-height:100vh; overflow:visible; }
    .agent-workbench { display:block; min-height:100vh; height:auto; }
    .agent-pane { height:auto; min-height:100vh; overflow:visible; }
    .agent-workbench.has-editor .agent-list-pane { display:none; }
    .agent-workbench:not(.has-editor) .agent-editor-pane { display:none; }
    .agent-list-pane { border-right:0; }
    .agent-editor-header { padding:0 14px; }
    .agent-mobile-back { display:inline; }
    .agent-title-text { max-width:42vw; }
    .agent-editor-actions a.agent-secondary { display:none; }
    .agent-editor-actions { gap:5px; }
    .agent-editor-actions button { padding-right:9px; padding-left:9px; }
    .agent-editor-scroll { padding:26px 18px 90px; }
    .agent-field { grid-template-columns:1fr; gap:7px; }
    .agent-field-label { padding-top:0; }
    .agent-field-control textarea { min-height:190px; }
    .agent-resizer { display:none; }
  }
  @media (max-width:540px) {
    body:has(main.agent-page) nav.rail { display:none; }
    .agent-title-text { max-width:28vw; }
  }
  @media (prefers-reduced-motion:reduce) {
    .agent-inspector-pane, .agent-inspector-overlay { transition:none; }
  }
`;

function errorFor(
  errors: AgentFieldErrors,
  field: keyof AgentFieldErrors,
): HtmlEscapedString | Promise<HtmlEscapedString> | "" {
  const message = errors[field];
  return message
    ? html`<p class="agent-field-error" id="agent-${field}-error">${message}</p>`
    : "";
}

function invalidAttrs(errors: AgentFieldErrors, field: keyof AgentFieldErrors): {
  invalid: string;
  describedBy: string;
} {
  return errors[field]
    ? { invalid: "true", describedBy: `agent-${field}-error` }
    : { invalid: "false", describedBy: "" };
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(timestamp);
}

function scriptJson(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

export function agentWorkbenchView(
  view: AgentWorkbenchView,
): HtmlEscapedString | Promise<HtmlEscapedString> {
  const values = view.editor;
  const isEditing = view.mode === "edit" && view.selected;
  const hasEditor = view.mode !== "empty";
  const formAction = isEditing
    ? `/agents/${encodeURIComponent(view.selected!.id)}`
    : "/agents";
  const cancelHref = isEditing
    ? `/agents/${encodeURIComponent(view.selected!.id)}`
    : "/agents";

  const listItems = view.list.map((agent) => html`
    <a
      class="agent-list-item ${agent.selected ? "active" : ""}"
      href="/agents/${encodeURIComponent(agent.id)}"
      aria-current="${agent.selected ? "page" : "false"}"
    >
      <div class="agent-list-name-row">
        <span class="agent-status-mark ${agent.running ? "running" : agent.readiness}" aria-hidden="true"></span>
        <span class="agent-list-name">${agent.name}</span>
      </div>
      <div class="agent-list-meta">
        <span>${agent.running ? "任务运行中" : agent.readinessLabel}</span>
        <span>${agent.providerName}</span>
        <span>${agent.modelLabel}</span>
      </div>
    </a>
  `);

  const providerOptions = [...view.providers];
  if (values.provider && !providerOptions.some((provider) => provider.id === values.provider)) {
    providerOptions.push({
      id: values.provider as never,
      name: values.provider,
      bin: values.provider,
      available: false,
      detail: "未检测到此 CLI",
    });
  }
  const selectedProviderModels = view.models[values.provider] ?? [];
  const modelOptions = selectedProviderModels.map((model) => html`
    <option value="${model}" ${model === values.model ? "selected" : ""}>${model}</option>
  `);
  if (values.model && !selectedProviderModels.includes(values.model)) {
    modelOptions.push(html`<option value="${values.model}" selected>${values.model}（已保存）</option>`);
  }
  const reasoningEfforts = reasoningEffortsForEditor(values, view.defaults);
  const reasoningOptions = reasoningEfforts.map((effort) => html`
    <option value="${effort}" ${effort === values.reasoningEffort ? "selected" : ""}>
      ${REASONING_LABELS[effort] ?? effort}
    </option>
  `);

  const nameAttrs = invalidAttrs(view.errors, "name");
  const instructionAttrs = invalidAttrs(view.errors, "instruction");
  const providerAttrs = invalidAttrs(view.errors, "provider");
  const modelAttrs = invalidAttrs(view.errors, "model");
  const reasoningAttrs = invalidAttrs(view.errors, "reasoningEffort");
  const visibilityAttrs = invalidAttrs(view.errors, "visibility");
  const permissionAttrs = invalidAttrs(view.errors, "permission");
  const workdirAttrs = invalidAttrs(view.errors, "workdir");
  const skillsAttrs = invalidAttrs(view.errors, "skills");

  const editor = hasEditor ? html`
    <div class="agent-pane-header agent-editor-header">
      <div class="agent-editor-heading">
        <a class="agent-mobile-back" href="/agents?view=list" aria-label="返回 Agent 列表">返回</a>
        <span class="agent-title-text">${isEditing ? view.selected!.name : "新建 Agent"}</span>
        <span class="agent-save-state" id="agent-save-state">未保存</span>
      </div>
      <div class="agent-editor-actions">
        <button type="button" class="agent-secondary agent-inspector-toggle" data-inspector-toggle>
          详情
        </button>
        <a class="agent-secondary" href="${cancelHref}">取消</a>
        <button class="agent-primary" type="submit" form="agent-editor-form">
          ${isEditing ? "保存更改" : "创建 Agent"}
        </button>
      </div>
    </div>
    <div class="agent-editor-scroll">
      <div class="agent-form-intro">
        <h1>${isEditing ? view.selected!.name : "创建 Agent"}</h1>
        <p>配置回答人格和本地 CLI。任务执行权限仅影响研究任务，不改变普通问答、提炼或学习流程。</p>
      </div>
      ${view.flash ? html`<div class="agent-flash" role="status">${view.flash}</div>` : ""}
      ${view.formError ? html`<div class="agent-form-alert" role="alert">${view.formError}</div>` : ""}
      <form method="post" action="${formAction}" id="agent-editor-form" class="stack">
        <section class="agent-form-section" aria-labelledby="agent-section-identity">
          <h2 class="agent-section-heading" id="agent-section-identity">Identity</h2>
          <div class="agent-field">
            <label class="agent-field-label" for="agent-name">名称</label>
            <div class="agent-field-control">
              <input
                id="agent-name"
                name="name"
                type="text"
                value="${values.name}"
                placeholder="例如：研究助手"
                maxlength="100"
                required
                aria-invalid="${nameAttrs.invalid}"
                aria-describedby="${nameAttrs.describedBy}"
                autocomplete="off"
              />
              ${errorFor(view.errors, "name")}
            </div>
          </div>
          <div class="agent-field">
            <label class="agent-field-label" for="agent-instruction">
              Instruction
              <small>注入回答与研究任务的角色指令</small>
            </label>
            <div class="agent-field-control">
              <textarea
                id="agent-instruction"
                name="instruction"
                maxlength="20000"
                aria-invalid="${instructionAttrs.invalid}"
                aria-describedby="${instructionAttrs.describedBy}"
                placeholder="描述这个 Agent 的职责、判断原则和表达方式"
              >${values.instruction}</textarea>
              <p class="agent-field-hint"><span id="agent-instruction-count">${values.instruction.length}</span> / 20,000</p>
              ${errorFor(view.errors, "instruction")}
            </div>
          </div>
        </section>

        <section class="agent-form-section" aria-labelledby="agent-section-model">
          <h2 class="agent-section-heading" id="agent-section-model">Model</h2>
          <div class="agent-field">
            <label class="agent-field-label" for="agent-provider">
              Provider
              <small>只显示本机支持的 CLI</small>
            </label>
            <div class="agent-field-control">
              <select
                id="agent-provider"
                name="provider"
                aria-invalid="${providerAttrs.invalid}"
                aria-describedby="${providerAttrs.describedBy}"
              >
                ${providerOptions.map((provider) => html`
                  <option
                    value="${provider.id}"
                    ${provider.id === values.provider ? "selected" : ""}
                    ${!provider.available && provider.id !== values.provider ? "disabled" : ""}
                  >
                    ${provider.name} · ${provider.available ? "CLI 就绪" : `不可用：${provider.detail}`}
                  </option>
                `)}
              </select>
              ${errorFor(view.errors, "provider")}
            </div>
          </div>
          <div class="agent-field">
            <label class="agent-field-label" for="agent-model">
              Model
              <small>留空时继承适用的默认配置</small>
            </label>
            <div class="agent-field-control">
              <select
                id="agent-model"
                name="model"
                aria-invalid="${modelAttrs.invalid}"
                aria-describedby="${modelAttrs.describedBy}"
              >
                <option value="" ${values.model === "" ? "selected" : ""}>使用默认模型</option>
                ${modelOptions}
              </select>
              ${errorFor(view.errors, "model")}
            </div>
          </div>
          <div class="agent-field">
            <label class="agent-field-label" for="agent-reasoning-effort">
              推理强度
              <small>仅 Codex；可用档位随模型变化</small>
            </label>
            <div class="agent-field-control">
              <select
                id="agent-reasoning-effort"
                name="reasoningEffort"
                ${values.provider !== "codex" ? "disabled" : ""}
                aria-invalid="${reasoningAttrs.invalid}"
                aria-describedby="${reasoningAttrs.describedBy}"
              >
                <option value="" ${values.reasoningEffort === "" ? "selected" : ""}>继承 Codex 默认配置</option>
                ${reasoningOptions}
              </select>
              ${errorFor(view.errors, "reasoningEffort")}
            </div>
          </div>
        </section>

        <section class="agent-form-section" aria-labelledby="agent-section-access">
          <h2 class="agent-section-heading" id="agent-section-access">Access</h2>
          <div class="agent-field">
            <label class="agent-field-label" for="agent-visibility">
              Visibility
              <small>限制可绑定的空间类型</small>
            </label>
            <div class="agent-field-control">
              <select
                id="agent-visibility"
                name="visibility"
                aria-invalid="${visibilityAttrs.invalid}"
                aria-describedby="${visibilityAttrs.describedBy}"
              >
                <option value="Team" ${values.visibility === "Team" ? "selected" : ""}>Team</option>
                <option value="Personal" ${values.visibility === "Personal" ? "selected" : ""}>Personal</option>
              </select>
              ${errorFor(view.errors, "visibility")}
            </div>
          </div>
          <div class="agent-field">
            <label class="agent-field-label" for="agent-permission">
              Permission
              <small>仅影响研究任务的本地 CLI</small>
            </label>
            <div class="agent-field-control">
              <select
                id="agent-permission"
                name="permission"
                aria-invalid="${permissionAttrs.invalid}"
                aria-describedby="${permissionAttrs.describedBy}"
              >
                ${Object.entries(PERMISSION_LABELS).map(([permission, label]) => html`
                  <option value="${permission}" ${values.permission === permission ? "selected" : ""}>${label}</option>
                `)}
              </select>
              ${errorFor(view.errors, "permission")}
            </div>
          </div>
          <div class="agent-field">
            <label class="agent-field-label" for="agent-workdir">
              Workdir
              <small>可写与完全访问权限必填</small>
            </label>
            <div class="agent-field-control">
              <input
                id="agent-workdir"
                name="workdir"
                type="text"
                value="${values.workdir}"
                maxlength="2048"
                placeholder="~/work/project"
                aria-invalid="${workdirAttrs.invalid}"
                aria-describedby="${workdirAttrs.describedBy}"
                autocomplete="off"
              />
              ${errorFor(view.errors, "workdir")}
            </div>
          </div>
          <div class="agent-field">
            <label class="agent-field-label" for="agent-skills">
              Skills
              <small>逗号或换行分隔，任务启动前加载</small>
            </label>
            <div class="agent-field-control">
              <input
                id="agent-skills"
                name="skills"
                type="text"
                value="${values.skills}"
                maxlength="4000"
                placeholder="code-review, web-search"
                aria-invalid="${skillsAttrs.invalid}"
                aria-describedby="${skillsAttrs.describedBy}"
                autocomplete="off"
              />
              ${errorFor(view.errors, "skills")}
            </div>
          </div>
        </section>
      </form>
    </div>
  ` : html`
    <div class="agent-empty-editor">
      <div>
        <h1>${view.list.length > 0 ? "选择一个 Agent" : "还没有 Agent"}</h1>
        <p>${view.list.length > 0
          ? "从左侧列表选择要查看或编辑的 Agent。"
          : "创建一个 Agent，为空间配置专属指令和本地 CLI。"}</p>
        ${view.list.length > 0
          ? ""
          : html`<a class="agent-primary btn" href="/agents/new">创建第一个 Agent</a>`}
      </div>
    </div>
  `;

  const inspector = view.inspector ? html`
    <div class="agent-pane-header">
      <h2 class="agent-pane-title">运行与绑定</h2>
      <button type="button" class="agent-icon-button agent-inspector-toggle" data-inspector-toggle aria-label="关闭详情">×</button>
    </div>
    <div class="agent-inspector-content">
      <section class="agent-inspector-section">
        <h3 class="agent-inspector-label">Provider status</h3>
        <div class="agent-provider-state">
          <span class="agent-status-mark ${view.inspector.provider.available ? "ready" : "unavailable"}" aria-hidden="true"></span>
          <div>
            <div class="agent-provider-name">${view.inspector.provider.name} · ${view.inspector.provider.statusLabel}</div>
            <div class="agent-provider-detail">${view.inspector.provider.detail}</div>
          </div>
        </div>
      </section>
      <section class="agent-inspector-section">
        <h3 class="agent-inspector-label">
          Bindings
          <span>${view.inspector.bindings.length}</span>
        </h3>
        ${view.inspector.bindings.length > 0
          ? view.inspector.bindings.map((binding) => html`
              <div class="agent-binding">
                <div class="agent-binding-title">${binding.label}</div>
                <div class="agent-binding-meta">${binding.typeLabel} · ${binding.detail}</div>
              </div>
            `)
          : html`<div class="agent-inspector-empty">尚未绑定任何空间</div>`}
      </section>
      <section class="agent-inspector-section">
        <h3 class="agent-inspector-label">
          Recent task runs
          <span>${view.inspector.runTotal}</span>
        </h3>
        ${view.inspector.runs.length > 0
          ? view.inspector.runs.map((run) => html`
              <div class="agent-run">
                <div class="agent-run-row">
                  <a class="agent-run-title" href="/tasks/runs/${encodeURIComponent(run.id)}">${run.taskName}</a>
                  <span class="agent-run-status ${run.status}">${STATUS_LABELS[run.status]}</span>
                </div>
                <div class="agent-run-meta">${formatTime(run.startedAt)} · ${run.provider} / ${run.model}</div>
                <div class="agent-run-meta">${run.space}</div>
                <div class="agent-run-actions">
                  <a class="agent-run-meta" href="/tasks/runs/${encodeURIComponent(run.id)}">查看详情</a>
                  ${run.retryable ? html`
                    <form method="post" action="/tasks/runs/${encodeURIComponent(run.id)}/retry">
                      <button type="submit" class="agent-run-retry">重试</button>
                    </form>
                  ` : ""}
                </div>
              </div>
            `)
          : html`<div class="agent-inspector-empty">还没有由此 Agent 执行的研究任务</div>`}
        ${view.inspector.hasMoreRuns ? html`
          <a
            class="agent-load-more"
            href="/agents/${encodeURIComponent(view.selected!.id)}?runs=${Math.min(100, view.inspector.runLimit + 20)}"
          >加载更多（${view.inspector.runs.length} / ${view.inspector.runTotal}）</a>
        ` : ""}
      </section>
      ${isEditing ? html`
        <section class="agent-inspector-section">
          <h3 class="agent-inspector-label">Danger zone</h3>
          <p class="agent-delete-note">删除前会解除 ${view.inspector.bindings.length} 个空间绑定，绑定将回退到默认 AI。</p>
          <form
            id="agent-delete-form"
            method="post"
            action="/agents/${encodeURIComponent(view.selected!.id)}/delete"
            data-agent-name="${view.selected!.name}"
            data-binding-count="${view.inspector.bindings.length}"
          >
            <button type="submit" class="agent-danger">删除 Agent</button>
          </form>
        </section>
      ` : ""}
    </div>
    <div
      class="agent-resizer agent-resizer-inspector"
      data-resize="inspector"
      role="separator"
      tabindex="0"
      aria-label="调整运行与绑定面板宽度"
      aria-orientation="vertical"
      aria-valuemin="260"
      aria-valuemax="420"
      aria-valuenow="324"
    ></div>
  ` : html`
    <div class="agent-pane-header">
      <h2 class="agent-pane-title">创建说明</h2>
    </div>
    <div class="agent-inspector-content">
      <section class="agent-inspector-section">
        <h3 class="agent-inspector-label">Provider status</h3>
        <div class="agent-inspector-empty">保存后显示 CLI 状态、空间绑定与最近任务运行。</div>
      </section>
    </div>
  `;

  const modelCatalog = scriptJson(view.models);
  const inheritedCodexModel = view.defaults.provider === "codex" ? view.defaults.model : "";
  const reasoningCatalog = scriptJson(Object.fromEntries(
    [...new Set(["", ...(view.models.codex ?? []), ...(values.model ? [values.model] : [])])]
      .map((model) => [
        model,
        codexReasoningEffortsForModel(model || inheritedCodexModel || undefined),
      ]),
  ));
  const reasoningLabels = scriptJson(REASONING_LABELS);

  const script = raw(`<script>
(function () {
  var root = document.querySelector('.agent-workbench');
  if (!root) return;
  var form = document.getElementById('agent-editor-form');
  var saveState = document.getElementById('agent-save-state');
  var instruction = document.getElementById('agent-instruction');
  var instructionCount = document.getElementById('agent-instruction-count');
  var provider = document.getElementById('agent-provider');
  var model = document.getElementById('agent-model');
  var reasoning = document.getElementById('agent-reasoning-effort');
  var initial = form ? new FormData(form) : null;
  var initialText = initial ? new URLSearchParams(Array.from(initial.entries()).map(function (entry) {
    return [entry[0], String(entry[1])];
  })).toString() : '';
  var dirty = false;
  function markDirty() {
    if (!form) return;
    var current = new FormData(form);
    var currentText = new URLSearchParams(Array.from(current.entries()).map(function (entry) {
      return [entry[0], String(entry[1])];
    })).toString();
    dirty = currentText !== initialText;
    if (saveState) saveState.classList.toggle('visible', dirty);
  }
  if (form) {
    form.addEventListener('input', markDirty);
    form.addEventListener('change', markDirty);
    form.addEventListener('submit', function () { dirty = false; });
  }
  window.addEventListener('beforeunload', function (event) {
    if (!dirty) return;
    event.preventDefault();
    event.returnValue = '';
  });
  if (instruction && instructionCount) {
    instruction.addEventListener('input', function () {
      instructionCount.textContent = String(instruction.value.length);
    });
  }

  var MODELS = ${modelCatalog};
  var REASONING = ${reasoningCatalog};
  var REASONING_LABELS = ${reasoningLabels};
  function syncReasoning() {
    if (!provider || !model || !reasoning) return;
    var previous = reasoning.value;
    reasoning.disabled = provider.value !== 'codex';
    reasoning.replaceChildren();
    var inherited = document.createElement('option');
    inherited.value = '';
    inherited.textContent = '继承 Codex 默认配置';
    reasoning.appendChild(inherited);
    if (reasoning.disabled) return;
    (REASONING[model.value] || []).forEach(function (effort) {
      var option = document.createElement('option');
      option.value = effort;
      option.textContent = REASONING_LABELS[effort] || effort;
      option.selected = effort === previous;
      reasoning.appendChild(option);
    });
  }
  if (provider && model) {
    provider.addEventListener('change', function () {
      var previous = model.value;
      model.replaceChildren();
      var inherited = document.createElement('option');
      inherited.value = '';
      inherited.textContent = '使用默认模型';
      model.appendChild(inherited);
      (MODELS[provider.value] || []).forEach(function (modelId) {
        var option = document.createElement('option');
        option.value = modelId;
        option.textContent = modelId;
        option.selected = modelId === previous;
        model.appendChild(option);
      });
      syncReasoning();
      markDirty();
    });
    model.addEventListener('change', syncReasoning);
    syncReasoning();
  }

  var inspector = document.getElementById('agent-inspector');
  var overlay = document.querySelector('.agent-inspector-overlay');
  var inspectorTrigger = null;
  function setInspectorOpen(open, trigger) {
    if (!inspector || !overlay) return;
    inspector.classList.toggle('open', open);
    overlay.classList.toggle('open', open);
    document.querySelectorAll('[data-inspector-toggle]').forEach(function (item) {
      item.setAttribute('aria-expanded', String(open));
    });
    document.body.style.overflow = open && window.innerWidth < 1180 ? 'hidden' : '';
    if (open) {
      inspectorTrigger = trigger || document.activeElement;
      var first = inspector.querySelector('button, a, input, select, textarea, [tabindex="0"]');
      if (first) first.focus();
    } else if (inspectorTrigger && typeof inspectorTrigger.focus === 'function') {
      inspectorTrigger.focus();
      inspectorTrigger = null;
    }
  }
  document.querySelectorAll('[data-inspector-toggle]').forEach(function (button) {
    button.setAttribute('aria-expanded', 'false');
    button.addEventListener('click', function () {
      var open = !inspector.classList.contains('open');
      setInspectorOpen(open, button);
    });
  });
  if (overlay) overlay.addEventListener('click', function () { setInspectorOpen(false); });
  document.addEventListener('keydown', function (event) {
    if (!inspector || !inspector.classList.contains('open') || window.innerWidth >= 1180) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      setInspectorOpen(false);
      return;
    }
    if (event.key !== 'Tab') return;
    var focusable = Array.from(inspector.querySelectorAll(
      'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]'
    )).filter(function (item) { return item.getClientRects().length > 0; });
    if (!focusable.length) return;
    var first = focusable[0];
    var last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  function setupResize(handle, variable, storageKey, startValue, min, max, invert) {
    if (!handle) return;
    function setWidth(value) {
      var next = Math.min(max, Math.max(min, value));
      root.style.setProperty(variable, next + 'px');
      handle.setAttribute('aria-valuenow', String(Math.round(next)));
      return next;
    }
    handle.addEventListener('keydown', function (event) {
      if (window.innerWidth < 1180 || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
      event.preventDefault();
      var current = parseFloat(getComputedStyle(root).getPropertyValue(variable)) || startValue;
      var direction = event.key === 'ArrowRight' ? 1 : -1;
      var next = setWidth(current + direction * (invert ? -10 : 10));
      try { localStorage.setItem(storageKey, next + 'px'); } catch (_) {}
    });
    handle.addEventListener('pointerdown', function (event) {
      if (window.innerWidth < 1180) return;
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      handle.classList.add('dragging');
      var startX = event.clientX;
      var style = getComputedStyle(root);
      var current = parseFloat(style.getPropertyValue(variable)) || startValue;
      function move(moveEvent) {
        var delta = (moveEvent.clientX - startX) * (invert ? -1 : 1);
        setWidth(current + delta);
      }
      function done() {
        handle.classList.remove('dragging');
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', done);
        try {
          localStorage.setItem(storageKey, root.style.getPropertyValue(variable));
        } catch (_) {}
      }
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', done);
    });
  }
  var LIST_WIDTH_KEY = 'homeagent.agents.workbench.v1.list-width';
  var INSPECTOR_WIDTH_KEY = 'homeagent.agents.workbench.v1.inspector-width';
  try {
    var listWidth = localStorage.getItem(LIST_WIDTH_KEY);
    var inspectorWidth = localStorage.getItem(INSPECTOR_WIDTH_KEY);
    if (listWidth) root.style.setProperty('--agent-list-width', listWidth);
    if (inspectorWidth) root.style.setProperty('--agent-inspector-width', inspectorWidth);
  } catch (_) {}
  setupResize(document.querySelector('[data-resize="list"]'), '--agent-list-width', LIST_WIDTH_KEY, 244, 200, 360, false);
  setupResize(document.querySelector('[data-resize="inspector"]'), '--agent-inspector-width', INSPECTOR_WIDTH_KEY, 324, 260, 420, true);

  var deleteForm = document.getElementById('agent-delete-form');
  if (deleteForm) {
    deleteForm.addEventListener('submit', function (event) {
      var name = deleteForm.dataset.agentName || '该 Agent';
      var count = deleteForm.dataset.bindingCount || '0';
      if (!window.confirm('删除 Agent「' + name + '」？将解除 ' + count + ' 个空间绑定并回退到默认 AI。')) {
        event.preventDefault();
        return;
      }
      dirty = false;
    });
  }
})();
</script>`);

  return html`
    <style>${raw(AGENT_STYLE)}</style>
    <div class="agent-workbench ${hasEditor ? "has-editor" : ""}">
      <aside class="agent-pane agent-list-pane" data-pane="agent-list" aria-label="Agent 列表">
        <div class="agent-pane-header">
          <div>
            <h1 class="agent-pane-title">Agents</h1>
            <span class="agent-count">${view.list.length} 个</span>
          </div>
          <a class="agent-icon-button" href="/agents/new" aria-label="新建 Agent">+</a>
        </div>
        <nav class="agent-list" aria-label="选择 Agent">
          ${listItems.length > 0
            ? listItems
            : html`<div class="agent-empty-list">还没有 Agent</div>`}
        </nav>
        <div
          class="agent-resizer agent-resizer-list"
          data-resize="list"
          role="separator"
          tabindex="0"
          aria-label="调整 Agent 列表宽度"
          aria-orientation="vertical"
          aria-valuemin="200"
          aria-valuemax="360"
          aria-valuenow="244"
        ></div>
      </aside>
      <section class="agent-pane agent-editor-pane" data-pane="agent-editor">${editor}</section>
      <aside class="agent-pane agent-inspector-pane" id="agent-inspector" data-pane="agent-inspector" aria-label="Agent 运行与绑定">
        ${inspector}
      </aside>
      <button class="agent-inspector-overlay" type="button" aria-label="关闭详情"></button>
    </div>
    ${script}
  `;
}
