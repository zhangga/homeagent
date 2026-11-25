import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import { citedPageList, materialSourcesQuery, type CitedPage, type MaterialSources } from "./material-citations.ts";

export interface MaterialReceipt extends MaterialSources {
  expansionBudget: number;
  total: number;
}

export function materialReceiptView(spaceUrl: string, batch: string, rows: MaterialReceipt[], message: string, distillNow: boolean,
  citations: CitedPage[][], progress?: HtmlEscapedString) {
  const query = materialSourcesQuery(batch, rows, distillNow);
  return html`<section class="card" data-material-receipt aria-label="资料导入回执">
    <h3>资料导入回执</h3>
    <p data-material-count>已导入 ${rows.filter(row => row.rawIds.length === row.total).length} 份资料，共 ${rows.length} 份。</p>
    ${message ? html`<p data-material-detail>${message}</p>` : ""}
    <ul>${rows.map((row, index) => html`<li data-material-row="${row.slot}" data-complete="${String(row.rawIds.length === row.total)}">
      <strong>${row.name}</strong> · ${row.rawIds.length === row.total ? "已导入" : `写入未完成，已确认 ${row.rawIds.length}/${row.total} 条原始记录`}
      ${row.rawIds.length ? html`<a href="${spaceUrl}/raw/${encodeURIComponent(row.rawIds[0]!)}">查看原始条目</a>
        <div>引用这份资料的知识页${citedPageList(spaceUrl, citations[index]!, "目前没有知识页引用这份资料。")}</div>` : ""}
      ${row.rawIds.length < row.total ? html`<form data-material-retry method="post" action="${spaceUrl}/materials" enctype="multipart/form-data">
        <input type="hidden" name="materialBatch" value="${batch}" />
        ${query.getAll("file").map(value => html`<input type="hidden" name="materialReturn" value="${value}" />`)}
        <input type="hidden" name="materialSlot" value="${row.slot}" />
        <input type="hidden" name="materialIdentity" value="${row.identity}" />
        <input type="hidden" name="materialBudget" value="${row.expansionBudget}" />
        ${distillNow ? html`<input type="hidden" name="distillNow" value="on" />` : ""}
        <label>重新选择原文件 <input type="file" name="material" required /></label>
        <button type="submit">重试此文件</button>
      </form>` : ""}
    </li>`)}</ul>
    <a data-material-history href="${spaceUrl}?${query}">查看最新关联页</a> · <a href="${spaceUrl}">返回空间</a>
    ${progress ?? ""}
  </section>`;
}

// Retain browser File objects only while this page is open. The native retry
// forms still work without scripting and after the browser discards a file.
export const materialUploadScript = html`<script>${raw(`{
  const initial = document.querySelector('.space-upload');
  const result = document.querySelector('[data-material-results]');
  const status = document.querySelector('[data-material-status]');
  let files = [];
  async function submit(event) {
    const form = event.target;
    const retry = form.matches('[data-material-retry]');
    if (!retry && form !== initial) return;
    event.preventDefault();
    const data = new FormData(form);
    const slot = Number(data.get('materialSlot'));
    if (retry && files[slot]) data.set('material', files[slot]);
    if (!retry) files = data.getAll('material');
    const button = form.querySelector('button[type=submit]');
    if (button.disabled) return;
    button.disabled = true;
    status.textContent = '正在导入…';
    try {
      const response = await fetch(form.action, { method: 'POST', body: data, headers: { 'X-Material-Receipt': 'fragment' } });
      if (response.redirected) {
        initial.dataset.finished = 'true';
        location.assign(response.url);
        return;
      }
      if (!response.ok) throw Error();
      const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
      const receipt = doc.querySelector('[data-material-receipt]');
      if (!receipt) throw Error();
      initial.hidden = true;
      result.replaceChildren(receipt);
      const historyLink = receipt.querySelector('[data-material-history]');
      if (historyLink) history.replaceState(null, '', historyLink.href);
      result.querySelectorAll('[data-material-retry]').forEach(function (next) {
        if (files[Number(next.elements.materialSlot.value)]) {
          next.elements.material.required = false;
          next.elements.material.closest('label').hidden = true;
        }
      });
      status.textContent = '导入回执已更新';
      document.dispatchEvent(new Event('material-receipt'));
    } catch {
      status.textContent = '未收到导入回执。可以重新提交，已写入的分段会按本次导入核对。';
    } finally { button.disabled = false; }
  }
  if (initial && result && status) {
    initial.addEventListener('submit', submit);
    result.addEventListener('submit', submit);
    // Returning to a completed single-file upload starts a new import.
    window.addEventListener('pageshow', function (event) {
      if (event.persisted && initial.dataset.finished) location.reload();
    });
  }
}`)}</script>`;
