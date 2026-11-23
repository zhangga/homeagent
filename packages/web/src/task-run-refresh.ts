import type { TaskRun } from "@homeagent/core";

/** The fields that can change the Run's displayed state after the page is rendered. */
export function taskRunRefreshState(run: TaskRun) {
  const { status, notification, retry } = run;
  return {
    status,
    notification: notification && {
      status: notification.status, attempts: notification.attempts, nextAttemptAt: notification.nextAttemptAt,
    },
    retry: retry && {
      status: retry.status, nextAttemptAt: retry.nextAttemptAt, claimedByRunId: retry.claimedByRunId,
    },
  };
}

/** Reload the result when this Run changes state. Keep the current view intact while it is unchanged. */
export function taskRunRefreshScript(): string {
  return `(() => {
    const panel = document.querySelector('[data-task-run-snapshot]');
    if (!panel) return;
    let timer, busy = false, suspended = false;
    function schedule(delay) {
      clearTimeout(timer);
      if (!suspended && !document.hidden) timer = setTimeout(check, delay);
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
        const state = await response.json();
        if (typeof state.status !== 'string') throw new Error();
        if (JSON.stringify(state) !== panel.dataset.taskRunSnapshot && !suspended && !document.hidden) {
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
    window.addEventListener('pagehide', () => { suspended = true; clearTimeout(timer); });
    window.addEventListener('pageshow', event => { if (event.persisted) { suspended = false; schedule(0); } });
    schedule(2000);
  })();`;
}
