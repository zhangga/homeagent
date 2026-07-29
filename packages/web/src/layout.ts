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
  button.secondary, .btn.secondary { background:#f3f4f6; color:#374151; border:1px solid var(--border); }
  button.danger { background:var(--danger); }
  .actions { display:flex; gap:8px; align-items:center; }
  .inline-form { display:inline; }
  form.stack { display:block; }

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
  @media (max-width:720px) {
    .integration-row { grid-template-columns:1fr; gap:12px; }
    .integration-actions { justify-content:flex-start; }
    .connection-pill { min-width:0; width:100%; }
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
    <style>${raw(STYLE)}</style>
  </head>
  <body>
    <nav class="rail">
      <div class="brand">${brandMark({
        variant: "dark",
        size: 28,
        decorative: true,
      })}homeagent</div>
      ${navLinks}
      <div class="spacer"></div>
      <div class="foot">管理后台 · 内网自用</div>
    </nav>
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
