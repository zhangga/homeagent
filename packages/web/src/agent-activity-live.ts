/** Update only activity projections; editor forms and their dirty state stay in place. */
export function agentActivityLiveScript(): string {
  return `(() => {
  const root = document.getElementById('agent-activity');
  const overview = document.getElementById('agent-activity-overview');
  const summary = document.getElementById('agent-activity-summary');
  if (!root || !overview || !summary) return;
  let timer, busy = false, stopped = false, controller, failures = 0;
  function schedule(delay) {
    clearTimeout(timer);
    if (!stopped && !document.hidden) timer = setTimeout(refresh, delay);
  }
  function replace(target, markup) {
    if (!target || typeof markup !== 'string' || target.innerHTML === markup || target.contains(document.activeElement)) return;
    const open = target.querySelector('details')?.open;
    const scroll = [...target.querySelectorAll('.agent-activity-runs')].map(node => node.scrollTop);
    target.innerHTML = markup;
    const details = target.querySelector('details');
    if (details && open) details.open = true;
    target.querySelectorAll('.agent-activity-runs').forEach((node, index) => { node.scrollTop = scroll[index] || 0; });
  }
  async function refresh() {
    if (busy || stopped || document.hidden) return;
    clearTimeout(timer);
    busy = true;
    controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    let delay = 5000;
    try {
      const response = await fetch(root.dataset.agentActivityUrl, { cache:'no-store', credentials:'same-origin', signal:controller.signal });
      if (!response.ok || response.redirected) throw new Error('unavailable');
      const snapshot = await response.json();
      if (stopped) return;
      replace(overview, snapshot.overviewHtml);
      replace(document.getElementById('agent-recent-runs'), snapshot.recentHtml);
      for (const agent of snapshot.agents) {
        const item = [...document.querySelectorAll('[data-agent-id]')].find(node => node.dataset.agentId === agent.id);
        if (!item) continue;
        item.dataset.agentActive = String(agent.running || agent.queued);
        const label = item.querySelector('[data-agent-status]');
        const mark = item.querySelector('.agent-status-mark');
        if (label) label.textContent = agent.running ? '任务运行中' : agent.queued ? '任务排队中' : item.dataset.agentIdleLabel;
        if (mark) mark.className = 'agent-status-mark ' + (agent.running ? 'running' : agent.queued ? 'queued' : item.dataset.agentIdleState);
      }
      summary.textContent = snapshot.summary;
      failures = 0;
      delay = snapshot.activeCount ? 3000 : 5000;
    } catch (_) {
      if (!stopped) summary.textContent = '状态更新失败，正在重试；当前显示上次取得的记录。';
      delay = Math.min(30000, 5000 * 2 ** failures++);
    } finally {
      clearTimeout(timeout);
      busy = false;
      schedule(delay);
    }
  }
  document.addEventListener('visibilitychange', () => {
    clearTimeout(timer);
    if (!document.hidden) refresh();
  });
  window.addEventListener('pagehide', () => { stopped = true; clearTimeout(timer); controller?.abort(); });
  schedule(3000);
})();`;
}
