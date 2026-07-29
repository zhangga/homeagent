/**
 * Server-rendered HTML shell for the management backend. We use Hono's `html`
 * tagged-template helper rather than JSX: it needs no transform config,
 * auto-escapes interpolations (XSS-safe by default), and keeps views as plain
 * functions. Layout mirrors mew's structure: a dark left nav rail with the main
 * sections (Spaces/Knowledge, Agents, Tasks, Integrations, Governance, AI Quality, Health,
 * Logs, Settings), and a
 * content area. Unlike the previous read-only viewer, forms here mutate — every
 * mutating form POSTs and re-renders.
 */
import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import { brandMark } from "./brand-mark.ts";

const STYLE = `
  :root {
    --fg:#1a1a1a; --muted:#6b7280; --bg:#fafafa; --card:#fff; --border:#e5e7eb;
    --accent:#2563eb; --accent-soft:#eef2ff; --nav-bg:#111317; --nav-fg:#c7cbd1;
    --nav-fg-active:#fff; --nav-active:#1f232b; --ok:#16a34a; --ok-soft:#dcfce7;
    --warn:#92400e; --warn-soft:#fef3c7; --danger:#dc2626;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { font-family: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
         margin:0; color:var(--fg); background:var(--bg); line-height:1.5; display:flex; }
  a { color:var(--accent); text-decoration:none; }
  a:hover { text-decoration:underline; }

  /* left nav rail */
  nav.rail { width:220px; min-width:220px; background:var(--nav-bg); color:var(--nav-fg);
             min-height:100vh; display:flex; flex-direction:column; padding:14px 10px; }
  nav.rail .brand { display:flex; align-items:center; gap:10px; color:#fff; font-weight:700;
                    font-size:16px; padding:8px 12px 16px; }
  nav.rail a { display:flex; align-items:center; gap:10px; color:var(--nav-fg);
               padding:8px 12px; border-radius:8px; font-size:14px; margin-bottom:2px; }
  nav.rail a:hover { background:var(--nav-active); text-decoration:none; }
  nav.rail a.active { background:var(--nav-active); color:var(--nav-fg-active); font-weight:600; }
  nav.rail .ico { width:18px; text-align:center; opacity:.9; }
  nav.rail .spacer { flex:1; }
  nav.rail .foot { font-size:12px; color:#6b7280; padding:8px 12px; }
  .mobile-bar, .nav-close, .nav-scrim { display:none; }

  /* content */
  .content { flex:1; min-width:0; }
  main { max-width: 920px; margin: 0 auto; padding: 28px 24px 60px; }
  .crumbs { color:var(--muted); font-size:13px; margin-bottom:14px; }
  h1 { font-size:22px; margin:0 0 4px; }
  .subtitle { color:var(--muted); font-size:14px; margin:0 0 20px; }
  h2 { font-size:16px; margin:26px 0 10px; }

  table { width:100%; border-collapse:collapse; background:var(--card); border:1px solid var(--border); border-radius:10px; overflow:hidden; }
  th, td { text-align:left; padding:9px 13px; border-bottom:1px solid var(--border); font-size:14px; vertical-align:top; }
  th { background:#f4f4f5; color:var(--muted); font-weight:600; }
  tr:last-child td { border-bottom:none; }

  .card { background:var(--card); border:1px solid var(--border); border-radius:10px; padding:16px 18px; margin-bottom:14px; }
  .row { display:flex; align-items:center; justify-content:space-between; gap:16px; }
  .row + .row { border-top:1px solid var(--border); padding-top:14px; margin-top:14px; }
  .integration-card { padding:0; overflow:hidden; }
  .integration-row { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:24px; align-items:center; padding:18px 20px; }
  .integration-row + .integration-row { border-top:1px solid var(--border); }
  .connection-pill { min-width:220px; display:flex; align-items:center; justify-content:space-between; gap:12px;
    padding:9px 12px; border:1px solid var(--border); border-radius:8px; background:#fff; color:#374151; font-size:13px; }
  .connection-pill .dot { flex:0 0 auto; margin-right:0; }
  .integration-actions { display:flex; align-items:center; justify-content:flex-end; flex-wrap:wrap; gap:8px; }
  .integration-detail { padding:0 20px 18px; }
  .muted { color:var(--muted); font-size:13px; }
  .tag { display:inline-block; background:var(--accent-soft); color:var(--accent); border-radius:5px; padding:1px 8px; font-size:12px; margin-right:4px; }
  .dot { display:inline-block; width:8px; height:8px; border-radius:50%; background:var(--ok); margin-right:6px; vertical-align:middle; }
  pre { background:#0f172a; color:#e2e8f0; padding:14px; border-radius:10px; overflow:auto; font-size:13px; }
  .contentbox { background:var(--card); border:1px solid var(--border); border-radius:10px; padding:16px; white-space:pre-wrap; font-family:ui-monospace, monospace; font-size:13px; }

  /* forms */
  .grid2 { display:grid; grid-template-columns:1fr 1fr; gap:14px 20px; }
  .field { display:flex; flex-direction:column; gap:5px; margin-bottom:14px; }
  .field label { font-size:13px; font-weight:600; color:#374151; }
  .field .hint { font-size:12px; color:var(--muted); font-weight:400; }
  input[type=text], input[type=password], input[type=number], select, textarea {
    width:100%; padding:8px 11px; border:1px solid var(--border); border-radius:8px; font-size:14px; background:#fff; font-family:inherit; }
  textarea { min-height:96px; resize:vertical; }
  input:focus, select:focus, textarea:focus { outline:none; border-color:var(--accent); box-shadow:0 0 0 3px var(--accent-soft); }
  button, .btn { background:var(--accent); color:#fff; border:none; border-radius:8px; padding:8px 16px; font-size:14px; cursor:pointer; }
  button:hover { filter:brightness(.95); }
  button:disabled { cursor:not-allowed; opacity:.45; filter:none; }
  button.secondary, .btn.secondary { background:#f3f4f6; color:#374151; border:1px solid var(--border); }
  button.danger { background:var(--danger); }
  .actions { display:flex; gap:8px; align-items:center; }
  .inline-form { display:inline; }
  form.stack { display:block; }
  .settings-form { display:grid; gap:16px; }
  .settings-section { margin:0; padding:18px; border:1px solid var(--border); border-radius:10px; background:var(--card); }
  .settings-section legend { padding:0 6px; margin-left:-6px; font-size:16px; font-weight:700; color:var(--fg); }
  .settings-section-description { margin:0 0 16px; color:var(--muted); font-size:13px; }
  .settings-section .field { margin-bottom:0; }
  .field-help { min-height:18px; margin:0; color:var(--muted); font-size:12px; font-weight:400; }
  .field-error { margin:0; color:#b91c1c; font-size:12px; font-weight:600; }
  [aria-invalid="true"] { border-color:#dc2626 !important; }
  .form-error-summary { padding:12px 14px; border:1px solid #fecaca; border-radius:8px;
                        background:#fef2f2; color:#991b1b; font-size:13px; }
  .form-error-summary:focus { outline:3px solid #fee2e2; outline-offset:2px; }
  .form-error-summary ul { margin:6px 0 0; padding-left:20px; }
  .form-error-summary a { color:#991b1b; text-decoration:underline; }
  .input-with-unit { display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:stretch; }
  .input-with-unit input { border-radius:8px 0 0 8px; }
  .input-unit { display:flex; align-items:center; padding:0 11px; border:1px solid var(--border); border-left:0;
                border-radius:0 8px 8px 0; background:#f8fafc; color:var(--muted); font-size:12px; white-space:nowrap; }
  .field-label-row { min-height:20px; display:flex; align-items:center; justify-content:space-between; gap:8px; }
  .effect-badge { display:inline-flex; align-items:center; min-height:20px; padding:1px 8px; border-radius:999px;
                  background:var(--warn-soft); color:var(--warn); font-size:11px; font-weight:600; }
  .settings-actions { justify-content:flex-end; padding-top:2px; }

  /* two-pane (agents) */
  .split { display:grid; grid-template-columns:240px 1fr; gap:20px; align-items:start; }
  .listcol .item { display:block; padding:10px 12px; border:1px solid var(--border); border-radius:9px; margin-bottom:8px; background:var(--card); }
  .listcol .item.active { border-color:var(--accent); box-shadow:0 0 0 2px var(--accent-soft); }
  .listcol .item .name { font-weight:600; font-size:14px; color:var(--fg); }
  .listcol .item .sub { font-size:12px; color:var(--muted); }

  .badge { font-size:12px; padding:2px 8px; border-radius:10px; }
  .badge.knowledge { background:var(--ok-soft); color:#166534; }
  .badge.general { background:var(--warn-soft); color:var(--warn); }
  .badge.ok { background:var(--ok-soft); color:#166534; }
  .badge.degraded { background:var(--warn-soft); color:var(--warn); }
  .badge.down { background:#fee2e2; color:#991b1b; }
  .empty { color:var(--muted); padding:22px; text-align:center; }
  .flash { background:var(--ok-soft); color:#166534; border:1px solid #bbf7d0; border-radius:8px; padding:9px 13px; margin-bottom:16px; font-size:14px; }
  .health-alert { background:#fee2e2; color:#991b1b; border:1px solid #fecaca; border-radius:8px; padding:9px 13px; margin-bottom:16px; font-size:14px; }

  /* toggle switch */
  .switch { position:relative; display:inline-block; width:40px; height:22px; }
  .switch input { opacity:0; width:0; height:0; }
  .switch .slider { position:absolute; cursor:pointer; inset:0; background:#cbd5e1; border-radius:22px; transition:.15s; }
  .switch .slider:before { content:""; position:absolute; height:16px; width:16px; left:3px; top:3px; background:#fff; border-radius:50%; transition:.15s; }
  .switch input:checked + .slider { background:var(--accent); }
  .switch input:checked + .slider:before { transform:translateX(18px); }
  .toggle-row { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:8px 0; }
  @media (max-width:900px) {
    body { display:block; overflow-x:hidden; }
    nav.rail { width:100%; min-width:0; min-height:auto; }
    html.js .mobile-bar { position:sticky; top:0; z-index:60; min-height:56px; display:flex; align-items:center;
                          justify-content:space-between; gap:16px; padding:8px 16px; background:var(--nav-bg); color:#fff; }
    .mobile-brand { display:flex; align-items:center; gap:8px; font-weight:700; }
    .mobile-nav-toggle { min-height:40px; padding:7px 12px; border:1px solid #374151; background:#1f232b; }
    html.js nav.rail { position:fixed; inset:0 auto 0 0; z-index:80; width:min(280px, 86vw); min-width:0;
                       min-height:100dvh; transform:translateX(-100%); transition:transform .2s ease-out;
                       box-shadow:12px 0 32px rgba(0,0,0,.22); }
    html.js body.nav-open nav.rail { transform:translateX(0); }
    html.js .nav-close { min-height:40px; display:block; margin:0 12px 12px; border:1px solid #374151; background:#1f232b; }
    html.js .nav-scrim { position:fixed; inset:0; z-index:70; width:100%; height:100%; padding:0; border:0;
                         border-radius:0; background:rgba(15,23,42,.52); }
    html.js .nav-scrim:not([hidden]) { display:block; }
    body.nav-open { overflow:hidden; }
    .content { width:100%; }
    main { width:100%; padding:24px 20px 56px; }
  }
  @media (max-width:720px) {
    main { padding:20px 16px 48px; }
    .grid2 { grid-template-columns:1fr; gap:16px; }
    input[type=text], input[type=password], input[type=number], select, textarea, button, .btn { min-height:44px; }
    .settings-section { padding:16px; }
    .settings-actions { display:grid; grid-template-columns:1fr 1fr; }
    .integration-row { grid-template-columns:1fr; gap:12px; }
    .integration-actions { justify-content:flex-start; }
    .connection-pill { min-width:0; width:100%; }
  }
  @media (prefers-reduced-motion:reduce) {
    html.js nav.rail { transition:none; }
  }
`;

export interface Crumb {
  label: string;
  href?: string;
}

/** The nav sections; `active` matches one of these keys. */
const NAV: { key: string; label: string; href: string; ico: string }[] = [
  { key: "spaces", label: "空间 / 知识", href: "/", ico: "🗂" },
  { key: "agents", label: "Agents", href: "/agents", ico: "🤖" },
  { key: "tasks", label: "任务", href: "/tasks", ico: "⏰" },
  { key: "learning", label: "学习", href: "/learning", ico: "📖" },
  { key: "reminders", label: "提醒", href: "/reminders", ico: "🔔" },
  { key: "integrations", label: "飞书连接", href: "/integrations", ico: "🔌" },
  { key: "governance", label: "数据治理", href: "/governance", ico: "🛡" },
  { key: "quality", label: "AI 质量", href: "/quality", ico: "🎯" },
  { key: "health", label: "运行状态", href: "/health", ico: "🩺" },
  { key: "logs", label: "调用日志", href: "/logs", ico: "📋" },
  { key: "settings", label: "设置", href: "/settings", ico: "⚙️" },
];

/** Page shell with the dark left nav rail and a breadcrumb trail. */
export function layout(
  title: string,
  crumbs: Crumb[],
  body: HtmlEscapedString | Promise<HtmlEscapedString>,
  active?: string,
): HtmlEscapedString | Promise<HtmlEscapedString> {
  const trail = crumbs.map((c, i) => {
    const sep = i > 0 ? " / " : "";
    return c.href
      ? html`${raw(sep)}<a href="${c.href}">${c.label}</a>`
      : html`${raw(sep)}<span>${c.label}</span>`;
  });
  const navLinks = NAV.map(
    (n) => html`<a href="${n.href}" class="${n.key === active ? "active" : ""}"
      ><span class="ico">${raw(n.ico)}</span>${n.label}</a
    >`,
  );
  return html`<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title} · homeagent</title>
    <script>document.documentElement.classList.add("js");</script>
    <style>${raw(STYLE)}</style>
  </head>
  <body>
    <header class="mobile-bar">
      <span class="mobile-brand">${brandMark({
        variant: "dark",
        size: 24,
        decorative: true,
      })}homeagent</span>
      <button type="button" class="mobile-nav-toggle" data-nav-toggle
        aria-controls="primary-navigation" aria-expanded="false">导航</button>
    </header>
    <nav class="rail" id="primary-navigation" aria-label="主导航">
      <div class="brand">${brandMark({
        variant: "dark",
        size: 28,
        decorative: true,
      })}homeagent</div>
      <button type="button" class="nav-close" data-nav-close>关闭导航</button>
      ${navLinks}
      <div class="spacer"></div>
      <div class="foot">管理后台 · 内网自用</div>
    </nav>
    <button type="button" class="nav-scrim" data-nav-scrim hidden aria-label="关闭主导航"></button>
    <div class="content">
      <main class="${active === "agents" ? "agent-page" : ""}">
        <div class="crumbs">${trail}</div>
        <div id="runtime-health-alert" class="health-alert" hidden>
          运行状态异常，部分能力可能不可用。<a href="/health">查看详情</a>
        </div>
        ${body}
      </main>
    </div>
    <script>
      (function () {
        var query = window.matchMedia("(max-width: 900px)");
        var body = document.body;
        var nav = document.getElementById("primary-navigation");
        var content = document.querySelector(".content");
        var toggle = document.querySelector("[data-nav-toggle]");
        var closeButton = document.querySelector("[data-nav-close]");
        var scrim = document.querySelector("[data-nav-scrim]");
        if (!nav || !content || !toggle || !closeButton || !scrim) return;

        function setClosedState(returnFocus) {
          body.classList.remove("nav-open");
          toggle.setAttribute("aria-expanded", "false");
          scrim.hidden = true;
          content.inert = false;
          if (query.matches) {
            nav.inert = true;
            nav.setAttribute("aria-hidden", "true");
          } else {
            nav.inert = false;
            nav.removeAttribute("aria-hidden");
          }
          if (returnFocus) toggle.focus();
        }

        function openNavigation() {
          if (!query.matches) return;
          body.classList.add("nav-open");
          toggle.setAttribute("aria-expanded", "true");
          scrim.hidden = false;
          content.inert = true;
          nav.inert = false;
          nav.removeAttribute("aria-hidden");
          closeButton.focus();
        }

        toggle.addEventListener("click", openNavigation);
        closeButton.addEventListener("click", function () { setClosedState(true); });
        scrim.addEventListener("click", function () { setClosedState(true); });
        document.addEventListener("keydown", function (event) {
          if (event.key === "Escape" && body.classList.contains("nav-open")) {
            setClosedState(true);
          }
        });
        query.addEventListener("change", function () { setClosedState(false); });
        setClosedState(false);
      })();

      fetch("/readyz", { cache: "no-store" })
        .then(function (response) {
          if (!response.ok) document.getElementById("runtime-health-alert").hidden = false;
        })
        .catch(function () {
          document.getElementById("runtime-health-alert").hidden = false;
        });
    </script>
  </body>
</html>`;
}
