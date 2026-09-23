import { html, raw } from "hono/html";
import type { DreamRunSnapshot, DreamStage, DreamTrigger } from "@homeagent/core";

const STAGES: Record<DreamStage, string> = {
  queued: "等待执行", preparing: "准备资料与计划", analyzing: "分析资料，规划知识页",
  generating: "生成与合并知识页", saving: "保存提炼结果", indexing: "更新知识地图与索引",
};
const TRIGGERS: Record<DreamTrigger, string> = {
  manual: "手动提炼", scheduled: "自动提炼", import: "资料导入",
  redistill: "重新提炼", retry: "失败重试", task: "任务结果提炼",
};

function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

function time(at: number): string {
  return new Date(at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
}

export function dreamRunsFragment(runs: DreamRunSnapshot[], now = Date.now()) {
  const active = runs.filter((run) => run.finishedAt === undefined).length;
  return html`<div class="dream-summary" data-dream-active="${active}">
    <strong>${active > 0 ? `${active} 个任务正在运行或排队` : "当前没有正在执行的提炼任务"}</strong>
    <span class="muted">${runs.length} 条运行记录 · 最近检查 ${time(now)}</span>
  </div>
  ${runs.length === 0 ? html`<div class="empty">提炼开始后会在这里显示阶段、来源和耗时。仅保留本次服务启动后的运行信息。</div>` : runs.map((run) => {
    const active = run.finishedAt === undefined;
    const waiting = run.status === "running" && (run.stage === "analyzing" || run.stage === "generating");
    const enc = encodeURIComponent(run.space);
    const status = { queued: "排队中", running: "运行中", completed: "已完成", failed: "未完成", cancelled: "已取消" }[run.status];
    const stage = active ? STAGES[run.stage] : status;
    const endedAt = run.finishedAt ?? now;
    const knownPlan = run.pagesTotal !== undefined;
    return html`<article class="dream-run ${active ? "dream-active" : ""}" data-dream-run="${run.id}">
      <header class="dream-run-head">
        <div><span class="dream-trigger">${TRIGGERS[run.trigger]}</span>
          ${run.batch ? html`<span class="muted"> · 第 ${run.batch.index} / ${run.batch.total} 批</span>` : ""}
          <h3><a href="/spaces/${enc}">${run.space}</a></h3></div>
        <span class="badge ${run.status === "failed" ? "down" : run.status === "completed" ? "ok" : "general"}">${status}</span>
      </header>
      <div class="dream-stage"><span class="dream-stage-mark" aria-hidden="true"></span><strong>${stage}</strong></div>
      ${run.page ? html`<div class="dream-current">当前知识页：<strong>${run.page.title}</strong>
        <span class="muted">（第 ${run.page.index}${run.pagesTotal ? ` / ${run.pagesTotal}` : ""} 页）</span></div>` : ""}
      ${run.chunk ? html`<div class="dream-current">来源分段：第 <strong>${run.chunk.index} / ${run.chunk.total}</strong> 段
        <span class="muted"> · 分段结果会合并为完整知识页</span></div>` : ""}
      ${waiting ? html`<p class="dream-wait">正在等待模型返回${run.stage === "analyzing" ? "分析计划" : "这一段的生成结果"}，包括 Provider 准备与自动重试。
        当前步骤已用 ${duration(now - run.stageStartedAt)}；模型返回前不会增加完成数量。</p>` : ""}
      ${run.status === "queued" ? html`<p class="dream-wait">正在等待本空间前面的写入或提炼工作完成。</p>` : ""}
      <dl class="dream-metrics">
        <div><dt>本批资料</dt><dd>${run.rawCount ?? "—"}<small> 条 Raw</small></dd></div>
        <div><dt>知识页进度</dt><dd>${knownPlan ? `${run.pagesCompleted ?? 0} / ${run.pagesTotal}` : "尚未生成计划"}</dd></div>
        <div><dt>已写入 / 失败</dt><dd>${run.pagesWritten ?? 0} / ${run.pagesFailed ?? 0}<small> 页</small></dd></div>
        <div><dt>${run.status === "queued" ? "已等待" : "执行耗时"}</dt><dd>${duration(endedAt - (run.startedAt ?? run.queuedAt))}</dd></div>
      </dl>
      ${knownPlan && run.pagesTotal! > 0 ? html`<progress class="dream-progress" max="${run.pagesTotal}" value="${run.pagesCompleted ?? 0}" aria-label="已处理知识页"></progress>` : ""}
      <div class="dream-times muted">${run.startedAt ? `开始于 ${time(run.startedAt)}` : `排队于 ${time(run.queuedAt)}`}
        · ${active ? `最近进展在 ${duration(now - run.updatedAt)}前` : `结束于 ${time(run.finishedAt!)}`}</div>
      ${run.status === "completed" ? html`<p class="muted">已处理 ${run.processedRaw ?? 0} 条 Raw，其中 ${run.skippedRaw ?? 0} 条无需生成知识页。</p>` : ""}
      ${run.status === "failed" ? html`<p class="dream-error">本轮有 ${run.errorCount} 项错误，未完成的资料会保留。
        <a href="/spaces/${enc}/quarantine">查看提炼失败记录</a> · <a href="/spaces/${enc}/raw">查看原始条目</a></p>` : ""}
      ${(run.sources?.length ?? 0) > 0 ? html`<details data-dream-details="${run.id}">
        <summary id="${run.id}-sources">${active ? "当前阶段的来源" : "最近处理的来源"}（${run.sourceCount ?? run.sources!.length} 条）</summary>
        <ul class="dream-sources">${run.sources!.map((source) => html`<li><a href="/spaces/${enc}/raw/${encodeURIComponent(source.id)}">${source.name}</a><span class="muted">${source.id}</span></li>`)}</ul>
        ${(run.sourceCount ?? 0) > run.sources!.length ? html`<p class="muted">此处显示前 ${run.sources!.length} 条，可进入空间查看全部原始条目。</p>` : ""}
      </details>` : ""}
    </article>`;
  })}`;
}

export function dreamRunsPanel(runs: DreamRunSnapshot[]) {
  return html`<section id="dream-runs" aria-labelledby="dream-runs-title">
    <div class="dream-panel-head"><div><h2 id="dream-runs-title">提炼任务</h2><p class="muted">查看正在做什么，以及最近完成的提炼。保留当前运行与最近 50 条结束记录，服务重启后清空。</p></div>
      <a class="btn secondary" href="/health#dream-runs" data-dream-refresh>刷新</a></div>
    <p class="muted" id="dream-poll-status" role="status">正在自动更新</p>
    <div id="dream-runs-content">${dreamRunsFragment(runs)}</div>
  </section><style>${raw(DREAM_STYLE)}</style><script>${raw(DREAM_POLL_SCRIPT)}</script>`;
}

const DREAM_STYLE = `
  #dream-runs { margin:24px 0 32px; scroll-margin-top:20px; }
  .dream-panel-head { display:flex; gap:20px; align-items:center; justify-content:space-between; }
  .dream-panel-head h2 { font-size:20px; margin:0; }
  .dream-panel-head p { max-width:570px; margin:6px 0; }
  .dream-panel-head .btn { white-space:nowrap; }
  .dream-summary { display:flex; flex-wrap:wrap; gap:8px 20px; justify-content:space-between; padding:12px 0; }
  .dream-run { background:var(--card); border:1px solid var(--border); padding:20px; margin:0 0 14px; border-radius:10px; }
  .dream-active { border-left:4px solid var(--accent); padding-left:17px; }
  .dream-run-head { display:flex; justify-content:space-between; align-items:center; gap:12px; }
  .dream-trigger { font-size:12px; font-weight:600; color:var(--muted); }
  .dream-run h3 { margin:3px 0 15px; font-size:16px; overflow-wrap:anywhere; }
  .dream-stage { display:flex; align-items:center; gap:8px; margin:2px 0 12px; }
  .dream-stage-mark { width:8px; height:8px; background:var(--muted); border-radius:50%; flex-shrink:0; }
  .dream-active .dream-stage-mark { background:var(--accent); }
  .dream-current { margin:5px 0; font-size:14px; overflow-wrap:anywhere; }
  .dream-wait { background:var(--accent-soft); color:#374151; padding:10px 12px; border-radius:6px; font-size:13px; }
  .dream-metrics { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:16px; margin:18px 0 10px; }
  .dream-metrics dt { font-size:12px; color:var(--muted); }
  .dream-metrics dd { margin:4px 0; font-weight:600; font-size:16px; font-variant-numeric:tabular-nums; }
  .dream-metrics small { font-weight:400; font-size:12px; color:var(--muted); }
  .dream-progress { display:block; width:100%; height:5px; accent-color:var(--accent); margin:12px 0; }
  .dream-times { margin:10px 0; }
  .dream-run details { border-top:1px solid var(--border); padding-top:12px; margin-top:14px; }
  .dream-run summary { cursor:pointer; font-size:13px; }
  .dream-sources { list-style:none; padding:0; margin:8px 0 0; max-height:230px; overflow:auto; }
  .dream-sources li { display:flex; flex-direction:column; padding:7px 0; overflow-wrap:anywhere; font-size:14px; }
  .dream-sources .muted { font-size:11px; }
  .dream-error { color:var(--danger); font-size:13px; }
  @media(max-width:600px) { .dream-metrics { grid-template-columns:repeat(2,minmax(0,1fr)); } .dream-run { padding:14px; } }
`;

// Server-rendered, escaped fragments keep browser code free of model or source HTML.
const DREAM_POLL_SCRIPT = `
(() => {
  const content = document.getElementById('dream-runs-content');
  const status = document.getElementById('dream-poll-status');
  const button = document.querySelector('[data-dream-refresh]');
  if (!content || !status || !button) return;
  let timer, busy = false, stopped = false;
  async function refresh() {
    if (busy || stopped) return;
    clearTimeout(timer);
    busy = true;
    let delay = 3000;
    try {
      const response = await fetch('/health/dream-runs', { cache:'no-store', signal:AbortSignal.timeout(10000) });
      if (!response.ok || response.redirected) throw new Error('unavailable');
      const markup = await response.text();
      if (!markup.includes('data-dream-active=')) throw new Error('invalid response');
      const open = [...content.querySelectorAll('details[open]')].map(node => node.dataset.dreamDetails);
      const focused = content.contains(document.activeElement) ? document.activeElement.id : null;
      const scroll = new Map([...content.querySelectorAll('[data-dream-details]')].map(node => [node.dataset.dreamDetails, node.querySelector('ul')?.scrollTop]));
      content.innerHTML = markup;
      content.querySelectorAll('[data-dream-details]').forEach(node => {
        node.open = open.includes(node.dataset.dreamDetails);
        const list = node.querySelector('ul');
        if (list) list.scrollTop = scroll.get(node.dataset.dreamDetails) || 0;
      });
      if (focused) document.getElementById(focused)?.focus({ preventScroll:true });
      const active = Number(content.querySelector('[data-dream-active]')?.dataset.dreamActive || 0);
      delay = active ? 3000 : 10000;
      status.textContent = active ? '每 3 秒自动更新；耗时不代表模型已返回新内容。' : '每 10 秒自动检查新任务。';
    } catch {
      delay = 10000;
      status.textContent = '暂时无法更新，正在显示上次结果；10 秒后重试。';
    } finally {
      busy = false;
      if (!stopped) timer = setTimeout(refresh, delay);
    }
  }
  button.addEventListener('click', event => { event.preventDefault(); refresh(); });
  window.addEventListener('pagehide', () => { stopped = true; clearTimeout(timer); });
  window.addEventListener('pageshow', event => { if (event.persisted) { stopped = false; refresh(); } });
  timer = setTimeout(refresh, 3000);
})();
`;
