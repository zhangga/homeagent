import { html, raw } from "hono/html";

export interface MaterialReceipt {
  name: string;
  slot: number;
  identity: string;
  expansionBudget: number;
  confirmed: number;
  total: number;
  firstId?: string;
}

export function materialReceiptView(spaceUrl: string, batch: string, rows: MaterialReceipt[], message: string, distillNow: boolean) {
  return html`<section class="card" data-material-receipt aria-label="资料导入回执">
    <h3>资料导入回执</h3>
    <p data-material-count>已导入 ${rows.filter(row => row.confirmed === row.total).length} 份资料，共 ${rows.length} 份。</p>
    ${message ? html`<p data-material-detail>${message}</p>` : ""}
    <ul>${rows.map(row => html`<li data-material-row="${row.slot}" data-complete="${String(row.confirmed === row.total)}">
      <strong>${row.name}</strong> · ${row.confirmed === row.total ? "已导入" : `写入未完成，已确认 ${row.confirmed}/${row.total} 条原始记录`}
      ${row.firstId ? html`<a href="${spaceUrl}/raw/${encodeURIComponent(row.firstId)}">查看原始条目</a>` : ""}
      ${row.confirmed < row.total ? html`<form data-material-retry method="post" action="${spaceUrl}/materials" enctype="multipart/form-data">
        <input type="hidden" name="materialBatch" value="${batch}" />
        <input type="hidden" name="materialSlot" value="${row.slot}" />
        <input type="hidden" name="materialIdentity" value="${row.identity}" />
        <input type="hidden" name="materialBudget" value="${row.expansionBudget}" />
        ${distillNow ? html`<input type="hidden" name="distillNow" value="on" />` : ""}
        <label>重新选择原文件 <input type="file" name="material" required /></label>
        <button type="submit">重试此文件</button>
      </form>` : ""}
    </li>`)}</ul>
    <a href="${spaceUrl}">返回空间</a>
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
      if (retry) {
        const row = receipt.querySelector('[data-material-row]');
        if (!row) throw Error();
        const summary = receipt.querySelector('[data-material-detail]');
        if (summary) row.append(summary);
        form.closest('[data-material-row]').replaceWith(row);
        const all = result.querySelectorAll('[data-material-row]').length;
        const done = result.querySelectorAll('[data-material-row][data-complete="true"]').length;
        result.querySelector('[data-material-count]').textContent = '已导入 ' + done + ' 份资料，共 ' + all + ' 份。';
      } else {
        initial.hidden = true;
        result.replaceChildren(receipt);
      }
      result.querySelectorAll('[data-material-retry]').forEach(function (next) {
        if (files[Number(next.elements.materialSlot.value)]) {
          next.elements.material.required = false;
          next.elements.material.closest('label').hidden = true;
        }
      });
      status.textContent = '导入回执已更新';
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
