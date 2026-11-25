import { html, raw } from "hono/html";
import { materialDreamRevision, type KnowledgeEngine } from "@homeagent/core";
import type { SpaceId } from "@homeagent/shared";
import { importedPagesView, materialSourcesQuery, type MaterialSources } from "./material-citations.ts";

export async function materialProgressView(engine: KnowledgeEngine, space: SpaceId, batch: string, files: MaterialSources[]) {
  const base = `/spaces/${encodeURIComponent(space)}`;
  const query = materialSourcesQuery(batch, files, true);
  const ids = new Set(files.flatMap(file => file.rawIds));
  const index = engine.registry.store(space).index();
  const pendingIds = new Set(index.pendingImportIds([...ids]));
  const pending = pendingIds.size;
  const batchRuns = engine.listDreamRuns(space).filter(run => run.materialImport?.batch === batch);
  const runs = batchRuns.filter(run => run.materialImport!.rawIds.some(id => ids.has(id)));
  const active = runs.find(run => run.status === "running") ?? runs.find(run => run.status === "queued");
  const failed = !active && (await engine.listQuarantines(space)).some(record => record.rawIds.some(id => ids.has(id)));
  const status = active?.status === "running" ? "正在提炼" : active ? "已排队，等待提炼"
    : failed || (pending && runs.some(run => run.status === "failed")) ? "提炼失败"
    : pending ? "等待提炼" : ids.size ? "提炼已完成" : "等待资料写入";
  const completeFiles = files.filter(file => file.rawIds.length && (file.total === undefined || file.total === file.rawIds.length));
  const canRetry = completeFiles.some(file => file.rawIds.some(id => pendingIds.has(id))) && !batchRuns.some(run => !run.finishedAt);
  const tracked = new Set(runs.flatMap(run => run.materialImport!.rawIds));
  const showTotal = runs.length && [...ids].every(id => tracked.has(id)) && !active;
  const pages = index.knowledgePagesForRawGroups(files.map(file => file.rawIds));
  return html`<div data-material-progress data-active="${active ? "true" : "false"}"
      data-endpoint="${base}/materials/progress?${query}" data-reopen="${base}?${query}">
    <section class="card"><h2>本次资料提炼</h2>
      <p role="status"><strong>${status}</strong> · ${ids.size - pending}/${ids.size} 条原始记录已处理</p>
      ${showTotal ? html`<p>本批次累计写入 ${runs.reduce((sum, run) => sum + (run.pagesWritten ?? 0), 0)} 页次</p>` : ""}
      ${active?.batch && active.batch.total > 1 ? html`<p>第 ${active.batch.index}/${active.batch.total} 批</p>` : ""}
      ${failed ? html`<p><a href="${base}/quarantine">查看提炼失败记录并重试</a></p>` : ""}
      ${canRetry ? html`<form method="post" action="${base}/materials/distill?${query}">
        <input type="hidden" name="after" value="${materialDreamRevision(batchRuns)}" />
        <button type="submit" class="secondary">提炼剩余资料</button></form>` : ""}
      <a href="${base}?${query}">查看最新提炼结果</a>
    </section>
    ${importedPagesView(base, files.filter(file => file.rawIds.length), pages.filter((_, i) => files[i]!.rawIds.length))}
  </div>`;
}

export const materialProgressScript = html`<script>${raw(`(() => {
  let timer;
  let running = false;
  function rememberReceipt() {
    const recent = document.querySelector('[data-material-recent]');
    const imported = document.querySelector('[data-material-results] [data-material-history]')
      || document.querySelector('[data-material-history]');
    const reopen = imported?.href || document.querySelector('[data-material-progress]')?.dataset.reopen;
    const current = reopen ? new URL(reopen, location.href) : null;
    const space = recent?.dataset.materialRecent || current?.pathname;
    if (!space) return;
    try {
      const key = 'homeagent:material-receipt:' + space;
      if (current && current.origin === location.origin && current.pathname === space)
        localStorage.setItem(key, current.pathname + current.search);
      const saved = localStorage.getItem(key);
      if (!saved || !recent) return;
      const target = new URL(saved, location.href);
      if (target.origin === location.origin && target.pathname === space && target.searchParams.has('materialBatch')) {
        recent.href = target.href;
        recent.hidden = false;
      }
    } catch {}
  }
  function schedule() {
    clearTimeout(timer);
    if (!running && !document.hidden && document.querySelector('[data-material-progress][data-active="true"]'))
      timer = setTimeout(refresh, 2500);
  }
  async function refresh() {
    const panel = document.querySelector('[data-material-progress][data-active="true"]');
    if (!panel || running || document.hidden) return;
    running = true;
    try {
      const response = await fetch(panel.dataset.endpoint, {cache:'no-store'});
      if (!response.ok || response.redirected) return;
      const next = new DOMParser().parseFromString(await response.text(), 'text/html').querySelector('[data-material-progress]');
      if (next && panel.isConnected) panel.replaceWith(next);
    } catch {} finally { running = false; schedule(); }
  }
  document.addEventListener('visibilitychange', schedule);
  document.addEventListener('material-receipt', () => { rememberReceipt(); schedule(); });
  rememberReceipt();
  schedule();
})()`)}</script>`;
