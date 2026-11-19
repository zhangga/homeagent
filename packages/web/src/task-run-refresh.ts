/** Reload the result when this Run changes state. Keep the current view intact while it is unchanged. */
export function taskRunRefreshScript(): string {
  return `(() => {
    const panel = document.querySelector('[data-task-run-status]');
    if (!panel) return;
    let timer, busy = false;
    function schedule(delay) {
      clearTimeout(timer);
      if (!document.hidden) timer = setTimeout(check, delay);
    }
    async function check() {
      if (busy || document.hidden) return;
      busy = true;
      let next = 3000;
      try {
        const response = await fetch(location.pathname + '/status', {
          cache: 'no-store', signal: AbortSignal.timeout(10000)
        });
        if (!response.ok || response.redirected) throw new Error();
        const { status } = await response.json();
        if (typeof status === 'string' && status !== panel.dataset.taskRunStatus && !document.hidden) {
          location.replace(location.pathname);
          return;
        }
      } catch {
        next = 10000;
      } finally {
        busy = false;
      }
      schedule(next);
    }
    document.addEventListener('visibilitychange', () => schedule(0));
    window.addEventListener('pagehide', () => clearTimeout(timer));
    window.addEventListener('pageshow', event => { if (event.persisted) schedule(0); });
    schedule(2000);
  })();`;
}
