import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import type {
  Agent,
  SkillCatalogEntry,
  SkillCatalogSnapshot,
  SkillRootKind,
} from "@homeagent/core";

type InventoryStatus = "available" | "duplicate" | "conflict" | "invalid";

export interface SkillInventoryAgentView {
  id: string;
  name: string;
  provider: string;
}

export interface SkillInventoryRow {
  key: string;
  name: string;
  description: string;
  sourceLabels: string[];
  providerIds: string[];
  status: InventoryStatus;
  statusLabel: string;
  usedBy: SkillInventoryAgentView[];
  diagnostics: string[];
}

export interface SkillInventoryView {
  rows: SkillInventoryRow[];
  sourceCount: number;
  agentCount: number;
  issueCount: number;
  diagnostics: string[];
  refreshedAt?: number;
}

const STATUS_LABELS: Record<InventoryStatus, string> = {
  available: "可用",
  duplicate: "同内容多来源",
  conflict: "同名内容冲突",
  invalid: "配置无效",
};

function sourceLabel(rootKind: SkillRootKind, relativeDir: string): string {
  return `${rootKind} · ${relativeDir}`;
}

function agentsUsingEntry(
  entry: SkillCatalogEntry,
  agents: readonly Agent[],
): SkillInventoryAgentView[] {
  const sourceKeys = new Set(entry.sources.map((source) => source.sourceKey));
  return agents
    .filter((agent) => agent.skills.some((binding) =>
      binding.kind === "source" && sourceKeys.has(binding.sourceKey)
    ))
    .map((agent) => ({
      id: agent.id,
      name: agent.name,
      provider: agent.provider,
    }));
}

export function buildSkillInventory(
  snapshot: SkillCatalogSnapshot | undefined,
  agents: readonly Agent[],
): SkillInventoryView {
  if (!snapshot) {
    return {
      rows: [],
      sourceCount: 0,
      agentCount: 0,
      issueCount: 0,
      diagnostics: ["暂时无法读取本机 Skill 目录；Agent 仍可按 Provider 默认规则运行。"],
    };
  }
  const hashesByName = new Map<string, Set<string>>();
  for (const entry of snapshot.entries) {
    const key = entry.name.toLowerCase();
    const hashes = hashesByName.get(key) ?? new Set<string>();
    hashes.add(entry.skillFileHash);
    hashesByName.set(key, hashes);
  }
  const rows = snapshot.entries.map((entry): SkillInventoryRow => {
    const conflict = (hashesByName.get(entry.name.toLowerCase())?.size ?? 0) > 1;
    const allInvalid = entry.sources.every((source) => source.status !== "available");
    const status: InventoryStatus = allInvalid
      ? "invalid"
      : conflict
        ? "conflict"
        : entry.sources.length > 1
          ? "duplicate"
          : "available";
    return {
      key: entry.key,
      name: entry.name || "未命名 Skill",
      description: entry.description,
      sourceLabels: entry.sources.map((source) =>
        sourceLabel(source.rootKind, source.relativeDir)
      ),
      providerIds: [...new Set(entry.sources.flatMap((source) => source.providerIds))].sort(),
      status,
      statusLabel: STATUS_LABELS[status],
      usedBy: agentsUsingEntry(entry, agents),
      diagnostics: entry.sources.flatMap((source) =>
        source.diagnostics.map((diagnostic) =>
          `${sourceLabel(source.rootKind, source.relativeDir)}：${diagnostic.message}`
        )
      ),
    };
  }).sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
  const usedAgentIds = new Set(rows.flatMap((row) => row.usedBy.map((agent) => agent.id)));
  return {
    rows,
    sourceCount: snapshot.sources.length,
    agentCount: usedAgentIds.size,
    issueCount: rows.filter((row) => row.status === "conflict" || row.status === "invalid").length,
    diagnostics: snapshot.diagnostics.map((diagnostic) =>
      `${diagnostic.rootKind}：${diagnostic.message}`
    ),
    refreshedAt: snapshot.refreshedAt,
  };
}

const STYLE = `
  .skill-inventory { --skill-ink:#1f2924; --skill-muted:#69756f; --skill-line:#dfe7e2;
    --skill-mint:#e8f4ed; --skill-mint-strong:#247351; --skill-amber:#fff3d6;
    color:var(--skill-ink); }
  .skill-visually-hidden { position:absolute; width:1px; height:1px; padding:0; margin:-1px;
    overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }
  .skill-inventory-head { display:flex; align-items:flex-end; justify-content:space-between;
    gap:24px; margin-bottom:18px; }
  .skill-inventory-head h1 { font-size:28px; letter-spacing:-.035em; }
  .skill-inventory-kicker { margin:0 0 5px; color:var(--skill-mint-strong); font-size:11px;
    font-weight:800; letter-spacing:.14em; text-transform:uppercase; }
  .skill-inventory-head .subtitle { max-width:650px; margin:6px 0 0; }
  .skill-refresh { flex:0 0 auto; }
  .skill-policy { display:grid; grid-template-columns:auto minmax(0,1fr); gap:14px;
    padding:15px 17px; margin-bottom:16px; border:1px solid #bdd7c8; border-radius:11px;
    background:linear-gradient(120deg,#f4faf6 0%,#e9f5ee 100%); }
  .skill-policy-mark { width:34px; height:34px; display:grid; place-items:center; border-radius:8px;
    background:#1f6f4d; color:#fff; font-weight:800; }
  .skill-policy strong { display:block; margin-bottom:3px; }
  .skill-policy p { margin:0; color:#4e6559; font-size:13px; }
  .skill-metrics { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:9px;
    margin-bottom:16px; }
  .skill-metric { padding:12px 14px; border:1px solid var(--skill-line); border-radius:9px;
    background:#fff; }
  .skill-metric span { display:block; color:var(--skill-muted); font-size:10px;
    letter-spacing:.08em; text-transform:uppercase; }
  .skill-metric strong { display:block; margin-top:2px; font:700 22px/1.15 ui-monospace,
    "SFMono-Regular",Consolas,monospace; }
  .skill-controls { display:grid; grid-template-columns:minmax(220px,1fr) 180px; gap:10px;
    margin-bottom:12px; }
  .skill-controls input, .skill-controls select { min-height:40px; }
  .skill-ledger { overflow:hidden; border:1px solid var(--skill-line); border-radius:11px;
    background:#fff; }
  .skill-ledger-head { display:grid; grid-template-columns:minmax(180px,1.3fr) minmax(180px,1fr)
    145px 120px; gap:14px; padding:9px 15px; border-bottom:1px solid var(--skill-line);
    background:#f5f7f5; color:#68736e; font-size:10px; font-weight:800;
    letter-spacing:.09em; text-transform:uppercase; }
  .skill-row { display:grid; grid-template-columns:minmax(180px,1.3fr) minmax(180px,1fr)
    145px 120px; gap:14px; align-items:start; padding:14px 15px;
    border-bottom:1px solid #edf1ee; }
  .skill-row:last-child { border-bottom:0; }
  .skill-row:hover { background:#fafcfb; }
  .skill-name { min-width:0; }
  .skill-name strong { display:block; overflow-wrap:anywhere; font-size:14px; }
  .skill-name p { margin:4px 0 0; color:var(--skill-muted); font-size:12px;
    display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2; overflow:hidden; }
  .skill-source-list { display:grid; gap:4px; min-width:0; }
  .skill-source-list code { overflow-wrap:anywhere; color:#52645b; background:#f1f5f2;
    border-radius:4px; padding:2px 5px; font-size:10px; }
  .skill-providers { display:flex; flex-wrap:wrap; gap:4px; }
  .skill-provider { padding:2px 6px; border-radius:999px; background:#eaf0ed; color:#446052;
    font-size:9px; font-weight:800; text-transform:uppercase; }
  .skill-status { display:inline-flex; width:max-content; padding:3px 7px; border-radius:999px;
    background:var(--skill-mint); color:var(--skill-mint-strong); font-size:10px; font-weight:800; }
  .skill-status.conflict, .skill-status.invalid { background:var(--skill-amber); color:#91620a; }
  .skill-used { grid-column:1 / -1; display:flex; align-items:center; flex-wrap:wrap; gap:6px;
    margin-top:-3px; color:var(--skill-muted); font-size:11px; }
  .skill-agent-link { display:inline-flex; gap:5px; align-items:center; padding:3px 7px;
    border:1px solid #d9e4dd; border-radius:6px; background:#fbfdfc; color:#276649; }
  .skill-diagnostics { grid-column:1 / -1; color:#80651f; font-size:11px; }
  .skill-diagnostics summary { cursor:pointer; }
  .skill-diagnostics p { margin:4px 0 0; overflow-wrap:anywhere; }
  .skill-empty { padding:42px 24px; text-align:center; color:var(--skill-muted); }
  .skill-catalog-diagnostics { margin-top:12px; padding:11px 14px; border:1px solid #ead7aa;
    border-radius:9px; background:#fffaf0; color:#765d21; font-size:11px; }
  .skill-catalog-diagnostics p { margin:5px 0 0; overflow-wrap:anywhere; }
  @media (max-width:800px) {
    .skill-inventory-head { align-items:stretch; flex-direction:column; }
    .skill-refresh { align-self:flex-start; }
    .skill-metrics { grid-template-columns:repeat(2,minmax(0,1fr)); }
    .skill-controls { grid-template-columns:1fr; }
    .skill-ledger-head { display:none; }
    .skill-row { grid-template-columns:1fr; gap:9px; }
    .skill-used, .skill-diagnostics { grid-column:1; }
  }
`;

function formatRefreshTime(value?: number): string {
  if (!value) return "尚未完成扫描";
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function skillInventoryView(
  view: SkillInventoryView,
  flash?: string,
): HtmlEscapedString | Promise<HtmlEscapedString> {
  return html`
    <style>${raw(STYLE)}</style>
    <section class="skill-inventory">
      ${flash ? html`<div class="flash" role="status">${flash}</div>` : ""}
      <header class="skill-inventory-head">
        <div>
          <p class="skill-inventory-kicker">Local capability ledger</p>
          <h1>本机 Skills</h1>
          <p class="subtitle">审计本机 Provider 可发现的能力、来源冲突，以及哪些 Agent 已固定使用。</p>
        </div>
        <form class="skill-refresh" method="post" action="/agent-skills/refresh">
          <input type="hidden" name="returnTo" value="/skills" />
          <button type="submit">刷新目录</button>
        </form>
      </header>

      <div class="skill-policy">
        <div class="skill-policy-mark" aria-hidden="true">↳</div>
        <div>
          <strong>全局继承是默认行为，Pinned 是显式保证</strong>
          <p>Agent 未固定 Skill 时，仍可由 Codex、Claude 或 TRAE 按自身规则使用本机全局 Skills；Pinned Skills 会由 HomeAgent 在调用时显式加载。</p>
        </div>
      </div>

      <div class="skill-metrics" aria-label="Skill 目录摘要">
        <div class="skill-metric"><span>能力版本</span><strong>${view.rows.length}</strong></div>
        <div class="skill-metric"><span>本机来源</span><strong>${view.sourceCount}</strong></div>
        <div class="skill-metric"><span>关联 Agents</span><strong>${view.agentCount}</strong></div>
        <div class="skill-metric"><span>待处理问题</span><strong>${view.issueCount}</strong></div>
      </div>

      <div class="skill-controls">
        <label class="skill-visually-hidden" for="skill-inventory-search">搜索 Skills</label>
        <input id="skill-inventory-search" type="search"
          placeholder="搜索名称、说明、来源或 Agent" autocomplete="off" />
        <label class="skill-visually-hidden" for="skill-inventory-status">筛选状态</label>
        <select id="skill-inventory-status">
          <option value="">全部状态</option>
          <option value="available">可用</option>
          <option value="duplicate">同内容多来源</option>
          <option value="conflict">同名内容冲突</option>
          <option value="invalid">配置无效</option>
        </select>
      </div>

      <div class="skill-ledger">
        <div class="skill-ledger-head" aria-hidden="true">
          <span>Skill</span><span>来源</span><span>Provider</span><span>状态</span>
        </div>
        ${view.rows.length > 0 ? view.rows.map((row) => html`
          <article class="skill-row"
            data-skill-inventory-row
            data-skill-status="${row.status}"
            data-skill-search="${[
              row.name,
              row.description,
              ...row.sourceLabels,
              ...row.providerIds,
              ...row.usedBy.map((agent) => agent.name),
            ].join(" ").toLowerCase()}">
            <div class="skill-name">
              <strong>${row.name}</strong>
              <p>${row.description || "未提供说明"}</p>
            </div>
            <div class="skill-source-list">
              ${row.sourceLabels.map((label) => html`<code>${label}</code>`)}
            </div>
            <div class="skill-providers">
              ${row.providerIds.map((provider) => html`<span class="skill-provider">${provider}</span>`)}
            </div>
            <span class="skill-status ${row.status}">${row.statusLabel}</span>
            <div class="skill-used">
              <span>Used by Agents</span>
              ${row.usedBy.length > 0
                ? row.usedBy.map((agent) => html`
                    <a class="skill-agent-link" href="/agents/${encodeURIComponent(agent.id)}">
                      ${agent.name}<small>${agent.provider}</small>
                    </a>
                  `)
                : html`<span>尚未固定到 Agent</span>`}
            </div>
            ${row.diagnostics.length > 0 ? html`
              <details class="skill-diagnostics">
                <summary>查看诊断</summary>
                ${row.diagnostics.map((diagnostic) => html`<p>${diagnostic}</p>`)}
              </details>
            ` : ""}
          </article>
        `) : html`
          <div class="skill-empty">
            <strong>尚未发现本机 Skill</strong>
            <p>确认本机 CLI 的 Skill 目录存在，然后刷新目录。</p>
          </div>
        `}
      </div>

      <p class="muted">最近扫描：${formatRefreshTime(view.refreshedAt)}</p>
      ${view.diagnostics.length > 0 ? html`
        <details class="skill-catalog-diagnostics">
          <summary>扫描诊断（${view.diagnostics.length}）</summary>
          ${view.diagnostics.map((diagnostic) => html`<p>${diagnostic}</p>`)}
        </details>
      ` : ""}
    </section>
    <script>
      (function () {
        var search = document.getElementById('skill-inventory-search');
        var status = document.getElementById('skill-inventory-status');
        var rows = Array.from(document.querySelectorAll('[data-skill-inventory-row]'));
        function filterRows() {
          var query = search ? search.value.trim().toLowerCase() : '';
          var selectedStatus = status ? status.value : '';
          rows.forEach(function (row) {
            var matchesQuery = !query
              || String(row.dataset.skillSearch || '').indexOf(query) !== -1;
            var matchesStatus = !selectedStatus
              || row.dataset.skillStatus === selectedStatus;
            row.hidden = !matchesQuery || !matchesStatus;
          });
        }
        if (search) search.addEventListener('input', filterRows);
        if (status) status.addEventListener('change', filterRows);
      })();
    </script>
  `;
}
