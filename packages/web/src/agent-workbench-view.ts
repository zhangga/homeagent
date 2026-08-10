import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import { codexReasoningEffortsForModel } from "@homeagent/llm";
import {
  reasoningEffortsForEditor,
  type AgentFieldErrors,
  type AgentWorkbenchView,
} from "./agent-workbench.ts";

const STATUS_LABELS = {
  awaiting_approval: "待审批",
  queued: "排队中",
  running: "运行中",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消",
  timed_out: "已超时",
  recorded: "已记录",
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
  .agent-workbench.is-create {
    grid-template-columns:var(--agent-list-width) minmax(520px, 1fr);
  }
  .agent-visually-hidden {
    position:absolute;
    width:1px;
    height:1px;
    padding:0;
    margin:-1px;
    overflow:hidden;
    clip:rect(0, 0, 0, 0);
    white-space:nowrap;
    border:0;
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
  .agent-create-name-wrap, .agent-edit-name-wrap { min-width:0; width:min(420px, 44vw); }
  .agent-create-name, .agent-edit-name {
    width:100%;
    min-height:34px;
    border:1px solid transparent;
    border-radius:7px;
    padding:6px 9px;
    background:transparent;
    color:#242420;
    font-size:14px;
    font-weight:650;
  }
  .agent-create-name:hover, .agent-edit-name:hover { border-color:#e0e0da; background:#fafaf7; }
  .agent-create-name:focus, .agent-edit-name:focus {
    border-color:#777771;
    outline:0;
    background:#fff;
    box-shadow:0 0 0 3px #efefeb;
  }
  .agent-create-name[aria-invalid="true"], .agent-edit-name[aria-invalid="true"] { border-color:#c95c51; }
  .agent-create-name-wrap .agent-field-error, .agent-edit-name-wrap .agent-field-error {
    margin:3px 9px 6px;
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
  .agent-editor-context { max-width:960px; padding-top:30px; }
  .agent-context-section { padding-bottom:28px; }
  .agent-context-heading {
    display:flex;
    align-items:baseline;
    justify-content:space-between;
    gap:18px;
    margin-bottom:8px;
  }
  .agent-context-label { color:#353530; font-size:12px; font-weight:700; }
  .agent-context-heading .agent-field-hint { margin:0; }
  .agent-context-section .agent-field-control textarea { min-height:150px; }
  .is-create .agent-editor-scroll { max-width:1080px; padding-top:28px; }
  .agent-create-intro {
    display:flex;
    align-items:flex-start;
    justify-content:space-between;
    gap:22px;
  }
  .agent-create-readiness {
    display:inline-flex;
    flex:0 0 auto;
    align-items:center;
    gap:7px;
    margin-top:2px;
    padding:5px 9px;
    border:1px solid #c7dfd1;
    border-radius:999px;
    background:#f0faf4;
    color:#216844;
    font-size:11px;
    font-weight:650;
  }
  .agent-create-readiness.unavailable {
    border-color:#e3d2b5;
    background:#fff8eb;
    color:#85530c;
  }
  .agent-create-form { display:block; }
  .agent-create-instruction { margin-bottom:22px; }
  .agent-create-instruction .agent-field-control textarea { min-height:132px; }
  .agent-create-core-grid {
    display:grid;
    grid-template-columns:minmax(0, 1fr) minmax(0, 1fr);
    gap:18px 20px;
  }
  .agent-create-field {
    display:block;
    margin:0;
  }
  .agent-create-field .agent-field-label {
    display:flex;
    align-items:baseline;
    justify-content:space-between;
    gap:12px;
    margin:0 0 7px;
    padding:0;
  }
  .agent-create-field .agent-field-label small {
    display:inline;
    margin:0;
    text-align:right;
  }
  .agent-task-execution {
    margin-top:26px;
    overflow:hidden;
    border:1px solid #dcdcd6;
    border-radius:10px;
    background:#f7f7f3;
  }
  .agent-task-execution summary {
    display:flex;
    align-items:center;
    justify-content:space-between;
    gap:18px;
    padding:14px 16px;
    cursor:pointer;
    color:#34342f;
    font-size:13px;
    font-weight:680;
    list-style:none;
  }
  .agent-task-execution summary::-webkit-details-marker { display:none; }
  .agent-task-execution summary::after {
    content:"+";
    color:#777771;
    font-size:18px;
    font-weight:400;
  }
  .agent-task-execution[open] summary::after { content:"−"; }
  .agent-task-summary-copy { display:flex; align-items:baseline; gap:9px; }
  .agent-task-summary-copy small { color:#85857f; font-size:11px; font-weight:400; }
  .agent-task-fields {
    display:grid;
    grid-template-columns:minmax(0, 1fr) minmax(0, 1fr);
    gap:18px 20px;
    padding:18px 16px 20px;
    border-top:1px solid #deded8;
    background:#fff;
  }
  .agent-task-fields .agent-create-field:last-child { grid-column:1 / -1; }
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
  .agent-property-field { display:grid; gap:6px; margin:0 0 14px; }
  .agent-property-field:last-child { margin-bottom:0; }
  .agent-property-label {
    display:flex;
    align-items:baseline;
    justify-content:space-between;
    gap:8px;
    color:#55554f;
    font-size:11px;
    font-weight:620;
  }
  .agent-property-hint { color:#92928b; font-size:9.5px; font-weight:400; }
  .agent-property-control input,
  .agent-property-control select {
    width:100%;
    min-height:34px;
    border:1px solid #d5d5cf;
    border-radius:7px;
    padding:6px 9px;
    background:#fff;
    color:#282824;
    font-size:12px;
    box-shadow:0 1px 1px rgba(20,20,16,.02);
  }
  .agent-property-control input:focus,
  .agent-property-control select:focus {
    border-color:#777771;
    outline:0;
    box-shadow:0 0 0 3px #e8e8e3;
  }
  .agent-property-control [aria-invalid="true"] { border-color:#c95c51; }
  .agent-property-control .agent-field-error { margin-top:5px; font-size:11px; }
  .agent-binding {
    display:block;
    margin:0 -8px 3px;
    padding:8px;
    border-radius:7px;
    color:inherit;
  }
  .agent-binding-title { color:#33332f; font-size:12px; font-weight:620; }
  .agent-binding-meta {
    margin-top:3px;
    color:#85857f;
    font-size:10.5px;
    line-height:1.4;
    overflow-wrap:anywhere;
  }
  .agent-recent-runs { padding-top:22px; border-top:1px solid #e9e9e4; }
  .agent-runs-heading { display:flex; align-items:center; justify-content:space-between; margin-bottom:10px; }
  .agent-runs-heading h2 {
    display:flex;
    align-items:baseline;
    gap:7px;
    margin:0;
    color:#353530;
    font-size:12px;
    font-weight:700;
  }
  .agent-run-list { overflow:hidden; border:1px solid #dfdfda; border-radius:9px; background:#fff; }
  .agent-run-item { display:flex; min-width:0; border-bottom:1px solid #eeeeea; }
  .agent-run-item:last-child { border-bottom:0; }
  .agent-run-link {
    display:grid;
    min-width:0;
    flex:1 1 auto;
    grid-template-columns:18px minmax(0, 1fr) auto 12px;
    align-items:center;
    gap:10px;
    padding:10px 11px;
    color:inherit;
  }
  .agent-run-link:hover { background:#fafaf7; text-decoration:none; }
  .agent-run-link:focus-visible {
    position:relative;
    z-index:1;
    outline:2px solid #74746e;
    outline-offset:-2px;
  }
  .agent-run-icon {
    display:inline-flex;
    width:16px;
    height:16px;
    align-items:center;
    justify-content:center;
    border:1px solid #b8b8b1;
    border-radius:50%;
    color:#777771;
    font-size:10px;
    font-weight:750;
  }
  .agent-run-item.succeeded .agent-run-icon {
    border-color:#84c5a4;
    background:#eff9f3;
    color:#21845a;
  }
  .agent-run-item.recorded .agent-run-icon {
    border-color:#9eb7d1;
    background:#f1f6fb;
    color:#426b94;
  }
  .agent-run-item.running .agent-run-icon {
    border-color:#d6a85f;
    background:#fff8eb;
    color:#9a620d;
  }
  .agent-run-item.failed .agent-run-icon,
  .agent-run-item.timed_out .agent-run-icon {
    border-color:#dc9b94;
    background:#fff3f1;
    color:#b34237;
  }
  .agent-run-copy { display:block; min-width:0; }
  .agent-run-primary,
  .agent-run-secondary {
    display:block;
    overflow:hidden;
    text-overflow:ellipsis;
    white-space:nowrap;
  }
  .agent-run-primary { color:#30302c; font-size:12px; font-weight:630; }
  .agent-run-item.failed .agent-run-primary,
  .agent-run-item.timed_out .agent-run-primary { color:#a63d34; }
  .agent-run-secondary { margin-top:2px; color:#8a8a83; font-size:10.5px; }
  .agent-run-status-text { color:#666660; font-weight:620; }
  .agent-run-time { color:#898983; font-size:10.5px; white-space:nowrap; }
  .agent-run-open { color:#aaa9a2; font-size:11px; }
  .agent-run-item > form {
    display:flex;
    flex:0 0 auto;
    align-items:center;
    padding:7px 10px 7px 0;
  }
  .agent-run-retry {
    min-height:30px;
    padding:4px 9px;
    border:1px solid #d9b8b4;
    border-radius:6px;
    background:#fff;
    color:#a63d34;
    font-size:11px;
    font-weight:620;
  }
  .agent-run-retry:hover { background:#fff3f1; filter:none; }
  .agent-runs-empty {
    padding:18px;
    border:1px dashed #d8d8d2;
    border-radius:9px;
    color:#8b8b84;
    font-size:12px;
    text-align:center;
  }
  .agent-load-more {
    display:block;
    margin-top:10px;
    padding:8px;
    color:#666660;
    font-size:11px;
    text-align:center;
  }
  .agent-load-more:hover { color:#252520; text-decoration:underline; }
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
    .agent-create-name-wrap, .agent-edit-name-wrap { width:min(48vw, 320px); }
    .agent-create-intro { display:block; }
    .agent-create-readiness { margin-top:14px; }
    .agent-create-core-grid, .agent-task-fields { grid-template-columns:1fr; }
    .agent-task-fields .agent-create-field:last-child { grid-column:auto; }
    .agent-field { grid-template-columns:1fr; gap:7px; }
    .agent-field-label { padding-top:0; }
    .agent-field-control textarea { min-height:190px; }
    .agent-context-section .agent-field-control textarea { min-height:140px; }
    .agent-run-link { min-height:44px; padding:10px 9px; }
    .agent-run-retry { min-height:40px; }
    .agent-resizer { display:none; }
  }
  .agent-skill-selector {
    margin:20px 0;
    overflow:hidden;
    border:1px solid #dddcd4;
    border-radius:12px;
    background:
      linear-gradient(135deg, rgba(228,242,235,.62), transparent 42%),
      #fbfbf8;
  }
  .agent-create-form > .agent-skill-selector { margin:8px 0 22px; }
  .agent-skill-summary {
    display:flex;
    align-items:center;
    gap:14px;
    padding:16px 18px;
    cursor:pointer;
    list-style:none;
  }
  .agent-skill-summary::-webkit-details-marker { display:none; }
  .agent-skill-summary:hover { background:rgba(255,255,255,.52); }
  .agent-skill-summary:focus-visible { outline:2px solid #287956; outline-offset:-2px; }
  .agent-skill-summary::after {
    width:7px;
    height:7px;
    flex:0 0 auto;
    border-right:1.5px solid #77776f;
    border-bottom:1.5px solid #77776f;
    content:"";
    transform:rotate(45deg) translate(-2px, 2px);
    transition:transform .16s ease;
  }
  .agent-skill-selector[open] > .agent-skill-summary::after {
    transform:rotate(225deg) translate(-1px, 1px);
  }
  .agent-skill-summary-copy { min-width:0; flex:1; }
  .agent-skill-summary h3 { margin:0; font-size:14px; letter-spacing:-.01em; }
  .agent-skill-summary p {
    max-width:620px;
    margin:5px 0 0;
    color:#71716b;
    font-size:12px;
    line-height:1.55;
  }
  .agent-skill-pinned-count {
    flex:0 0 auto;
    padding:3px 8px;
    border:1px solid #c8d9cf;
    border-radius:999px;
    background:#f1f8f4;
    color:#2d684c;
    font-size:10px;
    font-weight:700;
    white-space:nowrap;
  }
  .agent-skill-panel {
    padding:0 18px 18px;
    border-top:1px solid rgba(214,216,208,.72);
    background:rgba(255,255,255,.38);
  }
  .agent-skill-refresh {
    flex:0 0 auto;
    padding:7px 10px;
    border:1px solid #cbc9be;
    border-radius:7px;
    background:#fff;
    color:#383832;
    font-size:12px;
  }
  .agent-skill-toolbar {
    display:flex;
    align-items:center;
    gap:10px;
    margin-top:16px;
  }
  .agent-skill-toolbar input {
    min-width:0;
    flex:1;
    height:36px;
    border:1px solid #d7d5ca;
    border-radius:8px;
    background:#fff;
  }
  .agent-skill-toolbar > span { color:#85847d; font-size:11px; white-space:nowrap; }
  .agent-skill-chips {
    display:flex;
    flex-wrap:wrap;
    gap:7px;
    margin:12px 0;
  }
  .agent-skill-chip {
    display:inline-flex;
    align-items:center;
    gap:6px;
    max-width:100%;
    padding:5px 7px 5px 9px;
    border:1px solid #bcd5c7;
    border-radius:999px;
    background:#edf7f1;
    color:#24573e;
    font-size:11px;
  }
  .agent-skill-chip.missing, .agent-skill-chip.legacy {
    border-color:#e0c38f;
    background:#fff7e7;
    color:#76500d;
  }
  .agent-skill-chip.provider-native {
    border-color:#cfd9e2;
    background:#f3f6f8;
    color:#536675;
  }
  .agent-skill-chip input { width:13px; height:13px; margin:0; }
  .agent-skill-chip span {
    overflow:hidden;
    font-weight:670;
    text-overflow:ellipsis;
    white-space:nowrap;
  }
  .agent-skill-chip small { color:inherit; opacity:.72; }
  .agent-skill-chip button {
    width:20px;
    height:20px;
    padding:0;
    border:0;
    border-radius:50%;
    background:transparent;
    color:inherit;
    font-size:16px;
    line-height:20px;
  }
  .agent-skill-list {
    max-height:310px;
    overflow:auto;
    border:1px solid #dfded6;
    border-radius:9px;
    background:#fff;
  }
  .agent-skill-row {
    display:grid;
    grid-template-columns:18px minmax(0,1fr);
    gap:10px;
    padding:12px;
    border-bottom:1px solid #ecebe5;
    cursor:pointer;
  }
  .agent-skill-row:last-child { border-bottom:0; }
  .agent-skill-row:hover { background:#f7faf7; }
  .agent-skill-row:has(input:focus-visible) { outline:2px solid #287956; outline-offset:-2px; }
  .agent-skill-row input { width:16px; height:16px; margin:2px 0 0; accent-color:#287956; }
  .agent-skill-row-copy { min-width:0; }
  .agent-skill-title-line { display:flex; align-items:center; gap:9px; min-width:0; }
  .agent-skill-title-line strong {
    overflow:hidden;
    color:#292923;
    font-size:13px;
    text-overflow:ellipsis;
    white-space:nowrap;
  }
  .agent-skill-status {
    margin-left:auto;
    color:#27704f;
    font-size:10px;
    white-space:nowrap;
  }
  .status-invalid .agent-skill-status,
  .status-incompatible .agent-skill-status,
  .status-shadowed .agent-skill-status { color:#9a6205; }
  .agent-skill-description {
    display:block;
    margin-top:3px;
    overflow:hidden;
    color:#6f6e67;
    font-size:11px;
    line-height:1.45;
    text-overflow:ellipsis;
    white-space:nowrap;
  }
  .agent-skill-meta { display:flex; flex-wrap:wrap; gap:5px; margin-top:7px; align-items:center; }
  .agent-skill-meta code {
    max-width:100%;
    overflow:hidden;
    padding:2px 5px;
    border-radius:4px;
    background:#f0f0eb;
    color:#66665f;
    font-size:9px;
    text-overflow:ellipsis;
    white-space:nowrap;
  }
  .agent-skill-row details, .agent-skill-scan-diagnostics { margin-top:8px; color:#74736d; font-size:10px; }
  .agent-skill-row details p, .agent-skill-scan-diagnostics p { margin:5px 0; overflow-wrap:anywhere; }
  .agent-skill-empty, .agent-skill-empty-selection {
    display:flex;
    flex-direction:column;
    gap:4px;
    margin:0;
    padding:20px;
    color:#77766f;
    font-size:11px;
    text-align:center;
  }
  .agent-skill-empty-selection { padding:11px 0; text-align:left; }
  @media (max-width:540px) {
    body:has(main.agent-page) nav.rail { display:none; }
    .agent-title-text { max-width:28vw; }
    .agent-run-secondary { display:none; }
    .agent-run-link { grid-template-columns:18px minmax(0, 1fr) auto 12px; gap:8px; }
    .agent-run-time { font-size:10px; }
    .agent-skill-summary { align-items:flex-start; }
    .agent-skill-pinned-count { margin-left:auto; }
    .agent-skill-toolbar { align-items:stretch; flex-wrap:wrap; }
    .agent-skill-toolbar input { flex-basis:100%; }
    .agent-skill-status { display:block; margin-left:0; }
    .agent-skill-title-line { align-items:flex-start; flex-direction:column; gap:3px; }
  }
  @media (prefers-reduced-motion:reduce) {
    .agent-inspector-pane, .agent-inspector-overlay, .agent-skill-summary::after {
      transition:none;
    }
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

  const selectedProvider = providerOptions.find((provider) => provider.id === values.provider);
  const taskExecutionOpen = Boolean(view.errors.permission || view.errors.workdir);
  const skillSelector = html`
    <details class="agent-skill-selector" ${view.errors.skills ? "open" : ""}>
      <summary class="agent-skill-summary">
        <div class="agent-skill-summary-copy">
          <h3 id="agent-skills-heading">共享 Skills</h3>
          <p>只列出可跨 Provider 分配的共享能力；当前 Provider 自带的 Skills 无需再次固定。</p>
        </div>
        <span class="agent-skill-pinned-count" id="agent-skill-pinned-count">
          ${view.skillCatalog.selected.length} 个已固定
        </span>
      </summary>
      <div class="agent-skill-panel">
        <input type="hidden" name="skillSelectorPresent" value="1" form="agent-editor-form" />
        <div class="agent-skill-toolbar">
          <label class="agent-visually-hidden" for="agent-skill-search">搜索 Skills</label>
          <input
            id="agent-skill-search"
            type="search"
            placeholder="搜索共享 Skill"
            autocomplete="off"
          />
          <span>${view.skillCatalog.rows.length} 个共享能力</span>
          <button
            class="agent-skill-refresh"
            type="submit"
            form="agent-skill-refresh-form"
          >刷新目录</button>
        </div>
      <div
        class="agent-skill-chips"
        id="agent-skill-chips"
        aria-label="已固定的 Skills"
        ${view.skillCatalog.selected.length === 0 ? "hidden" : ""}
      >
          ${view.skillCatalog.selected.map((selection) => html`
            <label class="agent-skill-chip ${selection.status}">
              ${selection.status === "missing" || selection.status === "provider-native" ? html`
                <input
                  type="checkbox"
                  name="skillSourceKeys"
                  value="${selection.sourceKey ?? ""}"
                  form="agent-editor-form"
                  checked
                />
              ` : selection.status === "legacy" ? html`
                <input
                  type="checkbox"
                  name="legacySkillNames"
                  value="${selection.name}"
                  form="agent-editor-form"
                  checked
                />
              ` : ""}
              <span>${selection.name}</span>
              <small>${selection.statusLabel}</small>
              ${selection.status === "selected" ? html`
                <button
                  type="button"
                  aria-label="移除 ${selection.name}"
                  data-remove-skill="${selection.sourceKey ?? ""}"
                >×</button>
              ` : ""}
            </label>
          `)}
      </div>
      <p
        class="agent-skill-empty-selection"
        id="agent-skill-empty-selection"
        ${view.skillCatalog.selected.length > 0 ? "hidden" : ""}
      >未固定共享 Skill；当前 Provider 自带的能力仍可按其默认规则使用。</p>
      <div
        class="agent-skill-list"
        id="agent-skills"
        aria-invalid="${skillsAttrs.invalid}"
        aria-describedby="${skillsAttrs.describedBy}"
      >
        ${view.skillCatalog.rows.length > 0
          ? view.skillCatalog.rows.map((row) => html`
              <label
                class="agent-skill-row status-${row.status}"
                data-skill-row
                data-skill-search="${`${row.name} ${row.description} ${row.sourceLabel}`.toLowerCase()}"
                data-skill-name="${row.name}"
                data-skill-providers="${row.providerIds.join(",")}"
                data-skill-base-status="${row.status}"
              >
                <input
                  type="checkbox"
                  name="skillSourceKeys"
                  value="${row.sourceKey}"
                  form="agent-editor-form"
                  ${row.selected ? "checked" : ""}
                  ${row.status === "invalid" ? "disabled" : ""}
                />
                <span class="agent-skill-row-copy">
                  <span class="agent-skill-title-line">
                    <strong>${row.name}</strong>
                    <span class="agent-skill-status">${row.statusLabel}</span>
                  </span>
                  <span class="agent-skill-description">${row.description || "未提供说明"}</span>
                  <span class="agent-skill-meta">
                    <code>${row.sourceLabel}</code>
                    ${row.sourceCount > 1 ? html`<span>${row.sourceCount} 个同内容来源</span>` : ""}
                  </span>
                  ${row.diagnostics.length > 0 ? html`
                    <details>
                      <summary>查看诊断</summary>
                      ${row.diagnostics.map((diagnostic) => html`<p>${diagnostic}</p>`)}
                    </details>
                  ` : ""}
                </span>
              </label>
            `)
          : html`
              <div class="agent-skill-empty">
                <strong>尚未发现共享 Skill</strong>
                <span>请将共享能力安装到 ~/.agents/skills，然后刷新目录。</span>
              </div>
            `}
      </div>
      ${errorFor(view.errors, "skills")}
      ${view.skillCatalog.diagnostics.length > 0 ? html`
        <details class="agent-skill-scan-diagnostics">
          <summary>扫描诊断（${view.skillCatalog.diagnostics.length}）</summary>
          ${view.skillCatalog.diagnostics.map((diagnostic) => html`<p>${diagnostic}</p>`)}
        </details>
      ` : ""}
      </div>
    </details>
  `;

  const createEditor = html`
    <div class="agent-pane-header agent-editor-header">
      <div class="agent-editor-heading">
        <a class="agent-mobile-back" href="/agents?view=list" aria-label="返回 Agent 列表">返回</a>
        <div class="agent-create-name-wrap">
          <label class="agent-visually-hidden" for="agent-name">Agent 名称</label>
          <input
            class="agent-create-name"
            id="agent-name"
            name="name"
            form="agent-editor-form"
            type="text"
            value="${values.name}"
            maxlength="100"
            required
            aria-invalid="${nameAttrs.invalid}"
            aria-describedby="${nameAttrs.describedBy}"
            aria-label="Agent 名称"
            autocomplete="off"
            data-name-mode="${view.automaticName ? "automatic" : "manual"}"
          />
          ${errorFor(view.errors, "name")}
        </div>
        <span class="agent-save-state" id="agent-save-state">未保存</span>
      </div>
      <div class="agent-editor-actions">
        <a class="agent-secondary" href="${cancelHref}">取消</a>
        <button class="agent-primary" type="submit" form="agent-editor-form">
          创建 Agent
        </button>
      </div>
    </div>
    <div class="agent-editor-scroll">
      <div class="agent-form-intro agent-create-intro">
        <div>
          <h1>创建 Agent</h1>
          <p>配置回答人格，以及研究任务使用的本地 CLI。</p>
        </div>
        <div class="agent-create-readiness ${selectedProvider?.available ? "" : "unavailable"}">
          <span class="agent-status-mark ${selectedProvider?.available ? "ready" : "unavailable"}" aria-hidden="true"></span>
          <span data-provider-readiness>
            ${selectedProvider?.name ?? values.provider} · ${selectedProvider?.available ? "CLI 就绪" : "CLI 不可用"}
          </span>
        </div>
      </div>
      ${view.flash ? html`<div class="agent-flash" role="status">${view.flash}</div>` : ""}
      ${view.formError ? html`<div class="agent-form-alert" role="alert">${view.formError}</div>` : ""}
      <form method="post" action="${formAction}" id="agent-editor-form" class="agent-create-form stack">
        <div class="agent-field agent-create-field agent-create-instruction">
          <label class="agent-field-label" for="agent-instruction">
            Instruction
            <small>可选 · 注入回答与研究任务</small>
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

        <div class="agent-create-core-grid">
          <div class="agent-field agent-create-field">
            <label class="agent-field-label" for="agent-provider">
              Provider
              <small>本机可用 CLI</small>
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
          <div class="agent-field agent-create-field">
            <label class="agent-field-label" for="agent-model">
              Model
              <small>可继承默认配置</small>
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
          <div class="agent-field agent-create-field">
            <label class="agent-field-label" for="agent-visibility">
              Visibility
              <small>限制可绑定空间</small>
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
          <div class="agent-field agent-create-field">
            <label class="agent-field-label" for="agent-reasoning-effort">
              推理强度
              <small>仅 Codex</small>
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
        </div>

        ${skillSelector}

        <details class="agent-task-execution" ${taskExecutionOpen ? "open" : ""}>
          <summary>
            <span class="agent-task-summary-copy">
              任务执行
              <small>仅影响研究任务</small>
            </span>
          </summary>
          <div class="agent-task-fields">
            <div class="agent-field agent-create-field">
              <label class="agent-field-label" for="agent-permission">
                Permission
                <small>本地 CLI 沙箱</small>
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
            <div class="agent-field agent-create-field">
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
          </div>
        </details>
      </form>
    </div>
  `;

  const editOrEmptyEditor = hasEditor ? html`
    <div class="agent-pane-header agent-editor-header">
      <div class="agent-editor-heading">
        <a class="agent-mobile-back" href="/agents?view=list" aria-label="返回 Agent 列表">返回</a>
        <div class="agent-edit-name-wrap">
          <label class="agent-visually-hidden" for="agent-name">Agent 名称</label>
          <input
            class="agent-edit-name"
            id="agent-name"
            name="name"
            type="text"
            form="agent-editor-form"
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
        <span class="agent-save-state" id="agent-save-state">未保存</span>
        ${isEditing && view.revision
          ? html`<span class="agent-count">线上 v${view.revision.history.find((item) => item.published)?.number ?? "—"}</span>
              ${view.revision.draftRevisionId ? html`<span class="badge general">有未发布草稿</span>` : ""}`
          : ""}
      </div>
      <div class="agent-editor-actions">
        <button type="button" class="agent-secondary agent-inspector-toggle" data-inspector-toggle>
          详情
        </button>
        <a class="agent-secondary" href="${cancelHref}">取消</a>
        ${isEditing ? html`
          <button class="agent-secondary" type="submit" form="agent-editor-form" name="agentAction" value="draft">保存草稿</button>
          <button
            class="agent-primary"
            type="submit"
            form="agent-editor-form"
            name="agentAction"
            value="publish"
          >发布</button>
        ` : html`<button class="agent-primary" type="submit" form="agent-editor-form">创建 Agent</button>`}
      </div>
    </div>
    <div class="agent-editor-scroll agent-editor-context">
      ${view.flash ? html`<div class="agent-flash" role="status">${view.flash}</div>` : ""}
      ${view.formError ? html`<div class="agent-form-alert" role="alert">${view.formError}</div>` : ""}
      <form method="post" action="${formAction}" id="agent-editor-form" class="agent-context-form">
        ${isEditing && view.revision?.headRevisionId
          ? html`<input type="hidden" name="expectedHeadRevisionId" value="${view.revision.headRevisionId}" />`
          : ""}
        <section class="agent-context-section" aria-labelledby="agent-instruction-label">
          <div class="agent-context-heading">
            <label class="agent-context-label" id="agent-instruction-label" for="agent-instruction">Instruction</label>
            <span class="agent-field-hint"><span id="agent-instruction-count">${values.instruction.length}</span> / 20,000</span>
          </div>
          <div class="agent-field-control">
            <textarea
              id="agent-instruction"
              name="instruction"
              maxlength="20000"
              aria-invalid="${instructionAttrs.invalid}"
              aria-describedby="${instructionAttrs.describedBy}"
              placeholder="描述这个 Agent 的职责、判断原则和表达方式"
            >${values.instruction}</textarea>
            ${errorFor(view.errors, "instruction")}
          </div>
        </section>
      </form>
      ${skillSelector}
      ${view.inspector ? html`
      <section class="agent-recent-runs" aria-labelledby="agent-recent-runs-heading">
        <div class="agent-runs-heading">
          <h2 id="agent-recent-runs-heading">
            Recent runs
            <span class="agent-count">${view.inspector!.runTotal}</span>
          </h2>
        </div>
        ${view.inspector!.runs.length > 0
          ? html`
            <div class="agent-run-list" aria-label="Recent runs">
              ${view.inspector!.runs.map((run) => html`
                <div class="agent-run-item ${run.status}">
                  <a
                    class="agent-run-link"
                    href="${run.href}"
                    aria-label="${STATUS_LABELS[run.status]}：${run.taskName}，${run.space}，${run.provider} / ${run.model}"
                  >
                    <span class="agent-run-icon" aria-hidden="true">
                      ${run.status === "recorded"
                        ? "◆"
                        : run.status === "awaiting_approval"
                        ? "?"
                        : run.status === "succeeded"
                        ? "✓"
                        : run.status === "running" || run.status === "queued"
                          ? "…"
                          : run.status === "timed_out"
                            ? "!"
                            : run.status === "cancelled"
                              ? "–"
                              : "×"}
                    </span>
                    <span class="agent-run-copy">
                      <span class="agent-run-primary">
                        ${run.kind === "chat"
                          ? html`Chat · ${run.topic}`
                          : run.retryable && run.error
                            ? run.error
                            : run.taskName}
                      </span>
                      <span class="agent-run-secondary">
                        <span class="agent-run-status-text">${STATUS_LABELS[run.status]}</span>
                        ${run.kind === "chat" && run.deliveryStatus === "failed"
                          ? " · 投递失败"
                          : run.kind === "chat"
                            && run.status === "succeeded"
                            && run.deliveryStatus === "pending"
                            ? " · 待投递"
                            : ""}
                        ${run.status === "queued"
                          ? html` · 队列第 ${run.queuePosition ?? "—"} 位${
                              run.queueReason ? ` · 等待 ${run.queueReason}` : ""
                            }`
                          : ""}
                        · ${run.retryable && run.error ? html`${run.taskName} · ` : ""}
                        ${run.space} · ${run.provider} / ${run.model}
                      </span>
                    </span>
                    <time class="agent-run-time" datetime="${new Date(run.startedAt).toISOString()}">
                      ${formatTime(run.startedAt)}
                    </time>
                    <span class="agent-run-open" aria-hidden="true">↗</span>
                  </a>
                  ${run.retryable ? html`
                    <form method="post" action="${run.kind === "chat"
                      ? `/chats/runs/${encodeURIComponent(run.id)}/retry`
                      : `/tasks/runs/${encodeURIComponent(run.id)}/retry`}">
                      <button
                        type="submit"
                        class="agent-run-retry"
                        aria-label="${run.kind === "chat" ? "重试 Chat" : "重试任务"}：${run.taskName}"
                      >重试</button>
                    </form>
                  ` : ""}
                </div>
              `)}
            </div>
          `
          : html`<div class="agent-runs-empty">还没有由此 Agent 处理的 Chat 或研究任务</div>`}
        ${view.inspector!.hasMoreRuns ? html`
          <a
            class="agent-load-more"
            href="/agents/${encodeURIComponent(view.selected!.id)}?runs=${Math.min(100, view.inspector!.runLimit + 20)}"
          >加载更多（${view.inspector!.runs.length} / ${view.inspector!.runTotal}）</a>
        ` : ""}
      </section>
      ` : ""}
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

  const editor = view.mode === "create" ? createEditor : editOrEmptyEditor;

  const inspector = view.inspector ? html`
    <div class="agent-pane-header">
      <h2 class="agent-pane-title">Agent 设置</h2>
      <button type="button" class="agent-icon-button agent-inspector-toggle" data-inspector-toggle aria-label="关闭详情">×</button>
    </div>
    <div class="agent-inspector-content">
      <section class="agent-inspector-section agent-properties-section">
        <h3 class="agent-inspector-label">Execution</h3>
        <div class="agent-property-field">
          <label class="agent-property-label" for="agent-provider">Provider</label>
          <div class="agent-property-control">
            <select
              id="agent-provider"
              name="provider"
              form="agent-editor-form"
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
        <div class="agent-property-field">
          <label class="agent-property-label" for="agent-model">Model</label>
          <div class="agent-property-control">
            <select
              id="agent-model"
              name="model"
              form="agent-editor-form"
              aria-invalid="${modelAttrs.invalid}"
              aria-describedby="${modelAttrs.describedBy}"
            >
              <option value="" ${values.model === "" ? "selected" : ""}>使用默认模型</option>
              ${modelOptions}
            </select>
            ${errorFor(view.errors, "model")}
          </div>
        </div>
        <div class="agent-property-field">
          <label class="agent-property-label" for="agent-reasoning-effort">
            推理强度
            <span class="agent-property-hint">仅 Codex</span>
          </label>
          <div class="agent-property-control">
            <select
              id="agent-reasoning-effort"
              name="reasoningEffort"
              form="agent-editor-form"
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
        <div class="agent-property-field">
          <label class="agent-property-label" for="agent-permission">Permission</label>
          <div class="agent-property-control">
            <select
              id="agent-permission"
              name="permission"
              form="agent-editor-form"
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
      </section>
      <section class="agent-inspector-section agent-properties-section">
        <h3 class="agent-inspector-label">Scope & tools</h3>
        <div class="agent-property-field">
          <label class="agent-property-label" for="agent-visibility">Visibility</label>
          <div class="agent-property-control">
            <select
              id="agent-visibility"
              name="visibility"
              form="agent-editor-form"
              aria-invalid="${visibilityAttrs.invalid}"
              aria-describedby="${visibilityAttrs.describedBy}"
            >
              <option value="Team" ${values.visibility === "Team" ? "selected" : ""}>Team</option>
              <option value="Personal" ${values.visibility === "Personal" ? "selected" : ""}>Personal</option>
            </select>
            ${errorFor(view.errors, "visibility")}
          </div>
        </div>
        <div class="agent-property-field">
          <label class="agent-property-label" for="agent-workdir">Workdir</label>
          <div class="agent-property-control">
            <input
              id="agent-workdir"
              name="workdir"
              type="text"
              form="agent-editor-form"
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
      </section>
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
      ${isEditing && view.revision ? html`
        <section class="agent-inspector-section">
          <h3 class="agent-inspector-label">发布历史 <span>${view.revision.history.length}</span></h3>
          ${view.revision.history.map((revision) => html`
            <div class="agent-binding">
              <div class="agent-binding-title">
                v${revision.number} · ${revision.published ? "线上" : revision.draft ? "草稿" : revision.source}
              </div>
              <div class="agent-binding-meta">
                ${revision.provider} / ${revision.model} · ${PERMISSION_LABELS[revision.permission] ?? revision.permission}
                · ${formatTime(revision.createdAt)}
              </div>
              ${!revision.published && revision.source !== "draft" ? html`
                <form
                  method="post"
                  action="/agents/${encodeURIComponent(view.selected!.id)}/revisions/${encodeURIComponent(revision.id)}/rollback"
                  onsubmit="return confirm('将此历史版本重新发布为一个新版本？')"
                >
                  ${view.revision?.headRevisionId
                    ? html`<input type="hidden" name="expectedHeadRevisionId" value="${view.revision.headRevisionId}" />`
                    : ""}
                  <button type="submit" class="agent-secondary">回滚到此版本</button>
                </form>
              ` : ""}
            </div>
          `)}
        </section>
      ` : ""}
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
      aria-label="调整 Agent 设置面板宽度"
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
  const generatedNames = scriptJson(view.generatedNames);
  const inheritedCodexModel = view.defaults.provider === "codex" ? view.defaults.model : "";
  const reasoningCatalog = scriptJson(Object.fromEntries(
    [...new Set(["", ...(view.models.codex ?? []), ...(values.model ? [values.model] : [])])]
      .map((model) => [
        model,
        codexReasoningEffortsForModel(model || inheritedCodexModel || undefined),
      ]),
  ));
  const reasoningLabels = scriptJson(REASONING_LABELS);
  const workbenchClasses = [
    "agent-workbench",
    hasEditor ? "has-editor" : "",
    view.mode === "create" ? "is-create" : "",
  ].filter(Boolean).join(" ");

  const script = raw(`<script>
(function () {
  var root = document.querySelector('.agent-workbench');
  if (!root) return;
  var form = document.getElementById('agent-editor-form');
  var saveState = document.getElementById('agent-save-state');
  var instruction = document.getElementById('agent-instruction');
  var instructionCount = document.getElementById('agent-instruction-count');
  var nameInput = document.getElementById('agent-name');
  var provider = document.getElementById('agent-provider');
  var model = document.getElementById('agent-model');
  var reasoning = document.getElementById('agent-reasoning-effort');
  var providerReadiness = document.querySelector('[data-provider-readiness]');
  var nameIsAutomatic = !!nameInput && nameInput.dataset.nameMode === 'automatic';
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
    Array.from(form.elements).forEach(function (control) {
      control.addEventListener('input', markDirty);
      control.addEventListener('change', markDirty);
    });
    form.addEventListener('submit', function () { dirty = false; });
  }
  if (nameInput) {
    nameInput.addEventListener('input', function () {
      nameIsAutomatic = false;
      nameInput.dataset.nameMode = 'manual';
      markDirty();
    });
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
  var GENERATED_NAMES = ${generatedNames};
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
      if (nameInput && nameIsAutomatic && GENERATED_NAMES[provider.value]) {
        nameInput.value = GENERATED_NAMES[provider.value];
      }
      if (providerReadiness) {
        var selectedOption = provider.options[provider.selectedIndex];
        var readinessText = selectedOption ? selectedOption.textContent.trim() : provider.value;
        var ready = readinessText.indexOf('CLI 就绪') !== -1;
        providerReadiness.textContent = readinessText;
        var readinessContainer = providerReadiness.closest('.agent-create-readiness');
        if (readinessContainer) readinessContainer.classList.toggle('unavailable', !ready);
        var readinessMark = readinessContainer
          ? readinessContainer.querySelector('.agent-status-mark')
          : null;
        if (readinessMark) {
          readinessMark.classList.toggle('ready', ready);
          readinessMark.classList.toggle('unavailable', !ready);
        }
      }
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

  var skillSearch = document.getElementById('agent-skill-search');
  var skillRows = Array.from(document.querySelectorAll('[data-skill-row]'));
  if (skillSearch) {
    skillSearch.addEventListener('input', function () {
      var query = skillSearch.value.trim().toLowerCase();
      skillRows.forEach(function (row) {
        row.hidden = !!query && String(row.dataset.skillSearch || '').indexOf(query) === -1;
      });
    });
  }
  var skillChips = document.getElementById('agent-skill-chips');
  var emptySkillSelection = document.getElementById('agent-skill-empty-selection');
  var skillPinnedCount = document.getElementById('agent-skill-pinned-count');
  function syncSelectedSkillChips() {
    if (!skillChips || !emptySkillSelection) return;
    skillChips.querySelectorAll('.agent-skill-chip.selected').forEach(function (chip) {
      chip.remove();
    });
    var activeCount = 0;
    skillChips.querySelectorAll(
      '.agent-skill-chip.missing, .agent-skill-chip.legacy, .agent-skill-chip.provider-native',
    )
      .forEach(function (chip) {
        var checkbox = chip.querySelector('input[type="checkbox"]');
        chip.hidden = !checkbox || !checkbox.checked;
        if (!chip.hidden) activeCount += 1;
      });
    skillRows.forEach(function (row) {
      var checkbox = row.querySelector('input[name="skillSourceKeys"]');
      if (!checkbox || !checkbox.checked) return;
      activeCount += 1;
      var chip = document.createElement('label');
      chip.className = 'agent-skill-chip selected';
      var name = document.createElement('span');
      name.textContent = row.dataset.skillName || checkbox.value;
      var status = document.createElement('small');
      status.textContent = '已固定';
      var remove = document.createElement('button');
      remove.type = 'button';
      remove.setAttribute('aria-label', '移除 ' + name.textContent);
      remove.dataset.removeSkill = checkbox.value;
      remove.textContent = '×';
      chip.append(name, status, remove);
      skillChips.appendChild(chip);
    });
    skillChips.hidden = activeCount === 0;
    emptySkillSelection.hidden = activeCount > 0;
    if (skillPinnedCount) skillPinnedCount.textContent = activeCount + ' 个已固定';
  }
  if (skillChips) {
    skillChips.addEventListener('click', function (event) {
      var button = event.target.closest('[data-remove-skill]');
      if (!button) return;
      var sourceKey = button.dataset.removeSkill;
      var checkbox = skillRows
        .map(function (row) { return row.querySelector('input[name="skillSourceKeys"]'); })
        .find(function (input) { return input && input.value === sourceKey; });
      if (checkbox) {
        checkbox.checked = false;
        checkbox.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
  }
  document.querySelectorAll(
    'input[name="skillSourceKeys"], input[name="legacySkillNames"]',
  ).forEach(function (checkbox) {
    checkbox.addEventListener('change', function () {
      syncSelectedSkillChips();
      markDirty();
    });
  });
  syncSelectedSkillChips();
  function syncSkillCompatibility() {
    if (!provider) return;
    skillRows.forEach(function (row) {
      var base = row.dataset.skillBaseStatus;
      if (base === 'invalid') return;
      var providers = String(row.dataset.skillProviders || '').split(',');
      var compatible = providers.indexOf(provider.value) !== -1;
      row.classList.toggle('status-incompatible', !compatible);
      var status = row.querySelector('.agent-skill-status');
      if (status) {
        status.textContent = compatible
          ? (base === 'shadowed' ? '被更高优先级来源遮蔽' : '可用于当前 Provider')
          : '与当前 Provider 不兼容';
      }
    });
  }
  if (provider) provider.addEventListener('change', syncSkillCompatibility);
  syncSkillCompatibility();

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
  var firstInvalid = document.querySelector('[aria-invalid="true"]');
  if (firstInvalid && typeof firstInvalid.focus === 'function') {
    if (inspector && inspector.contains(firstInvalid) && window.innerWidth < 1180) {
      setInspectorOpen(true, document.querySelector('[data-inspector-toggle]'));
    }
    firstInvalid.focus();
  }
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
    <form id="agent-skill-refresh-form" method="post" action="/agent-skills/refresh" hidden>
      <input type="hidden" name="returnTo" value="${cancelHref}" />
    </form>
    <div class="${workbenchClasses}">
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
      ${view.mode === "create" ? "" : html`
        <aside class="agent-pane agent-inspector-pane" id="agent-inspector" data-pane="agent-inspector" aria-label="Agent 设置">
          ${inspector}
        </aside>
        <button class="agent-inspector-overlay" type="button" aria-label="关闭详情"></button>
      `}
    </div>
    ${script}
  `;
}
