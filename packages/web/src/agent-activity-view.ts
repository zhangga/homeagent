import { html, raw } from "hono/html";
import type { AgentActivity, AgentActivityEntry } from "./agent-activity.ts";
import { agentActivityLiveScript } from "./agent-activity-live.ts";

const STATUS = {
  awaiting_approval: "待审批", queued: "排队中", running: "运行中", succeeded: "已完成",
  failed: "失败", cancelled: "已取消", timed_out: "已超时",
} as const;

function activityRow(run: AgentActivityEntry) {
  return html`<a class="agent-activity-row" href="${run.href}">
    <span class="agent-activity-state ${run.status}">${STATUS[run.status]}</span>
    <span class="agent-activity-copy"><strong>${run.kind === "chat" ? "Chat" : "任务"} · ${run.title}</strong>
      <small>${run.agentLabel} · ${run.space} · ${run.provider} / ${run.model}</small></span>
  </a>`;
}

export function agentActivityOverview(activity: AgentActivity) {
  return html`${activity.activeRuns.length
    ? html`<div class="agent-activity-runs">${activity.activeRuns.map(activityRow)}</div>`
    : html`<p class="agent-field-hint">新的 Chat 或研究任务开始后会自动显示在这里。</p>`}
    ${activity.defaultRuns.length ? html`<details id="agent-default-history">
      <summary>默认 Agent 最近记录（${activity.defaultRuns.length}）</summary>
      <div class="agent-activity-runs">${activity.defaultRuns.map(activityRow)}</div>
    </details>` : ""}`;
}

export function agentActivityPanel(activity: AgentActivity, url: string) {
  return html`<section id="agent-activity" data-agent-activity-url="${url}" aria-labelledby="agent-activity-title">
    <h2 id="agent-activity-title">运行动态</h2>
    <p id="agent-activity-summary" role="status" aria-atomic="true">${activity.summary}</p>
    <p class="agent-field-hint">所有空间的 Chat 与研究任务，包含默认（全局）Agent。状态自动更新。</p>
    <div id="agent-activity-overview">${agentActivityOverview(activity)}</div>
  </section><style>${raw(ACTIVITY_STYLE)}</style><script>${raw(agentActivityLiveScript())}</script>`;
}

const ACTIVITY_STYLE = `
  #agent-activity { margin:18px 24px; padding:16px; border:1px solid #deded9; border-radius:9px; background:#fafaf8; }
  #agent-activity h2 { margin:0 0 8px; font-size:15px; }
  #agent-activity-summary { margin:0 0 6px; font-size:13px; color:#42423c; }
  .agent-activity-runs { max-height:280px; overflow:auto; }
  .agent-activity-row { display:flex; gap:12px; align-items:center; padding:12px 0; color:inherit; border-top:1px solid #e6e6e1; min-width:0; }
  .agent-activity-row:hover { background:#f1f1ed; text-decoration:none; }
  .agent-activity-row:focus-visible { outline:2px solid #74746e; outline-offset:2px; }
  .agent-activity-state { flex-shrink:0; font-size:12px; color:#55554f; }
  .agent-activity-state.running { color:#875200; }
  .agent-activity-state.failed,.agent-activity-state.timed_out { color:#a3342d; }
  .agent-activity-state.succeeded { color:#216844; }
  .agent-activity-copy { min-width:0; }
  .agent-activity-copy strong { display:block; font-size:13px; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .agent-activity-copy small { display:block; margin-top:4px; font-size:12px; color:#62625b; overflow-wrap:anywhere; }
  #agent-default-history { margin-top:10px; font-size:13px; }
  #agent-default-history summary { cursor:pointer; padding:8px 0; }
  @media(max-width:700px) { #agent-activity { margin:14px 12px; padding:12px; } }
`;
