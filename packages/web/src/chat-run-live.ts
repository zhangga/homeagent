export const chatAnswerModelCaption = /^> 本次模型：[^\r\n]+(?:\r?\n> 推理等级：[^\r\n]+)?\r?\n\r?\n/u;

/** The event journal owns the timeline. Durable Run state owns the answer, delivery and available actions. */
export function chatRunLiveScript(): string {
  return String.raw`(() => {
    const root = document.getElementById("live-run");
    const list = document.getElementById("live-run-events");
    const summary = document.getElementById("live-run-summary");
    if (!root || !list || !summary) return;
    const runId = root.dataset.runId;
    const pagePath = "/chats/runs/" + encodeURIComponent(runId);
    let lastSeq = 0;
    let lastMessage;
    let deltaMessage;
    let source;
    let toolCount = 0;
    let stateLabel = "执行中";
    const runningTools = new Map();
    const terminal = new Set(["run.succeeded", "run.failed", "run.cancelled", "run.timed_out"]);
    const labels = { command: "命令执行", "file-read": "读取文件", "file-change": "修改文件", mcp: "外部工具", "web-search": "网络查询", other: "工具调用" };
    const statuses = { running: "执行中", completed: "已完成", failed: "失败", unknown: "已结束" };
    const endpoint = "/api/chats/runs/" + encodeURIComponent(runId) + "/snapshot";
    const readSnapshot = () => fetch(endpoint, { credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(10000) })
      .then(response => response.ok ? response.json() : Promise.reject(new Error("snapshot failed")));
    const setAnswer = text => {
      if (!text) return;
      const answer = document.getElementById("live-run-answer");
      const content = text.replace(${chatAnswerModelCaption}, "");
      answer.textContent = content;
      answer.style.display = "block";
      const body = content.trim();
      const message = lastMessage?.textContent.trim();
      const hasLaterTool = lastMessage && Array.from(list.children).slice(Array.from(list.children).indexOf(lastMessage) + 1)
        .some(node => node.className.split(" ").includes("run-tool"));
      if (message && body && !hasLaterTool && (body.startsWith(message) || message.startsWith(body))) {
        lastMessage.remove();
        lastMessage = undefined;
      }
    };
    const render = event => {
      if (!event || event.seq <= lastSeq) return;
      lastSeq = event.seq;
      if (list.children.length === 1 && list.firstElementChild?.classList.contains("muted")) list.textContent = "";
      if (event.kind === "assistant.snapshot" || event.kind === "assistant.delta") {
        if (event.visibility !== "public" || !event.delta) return;
        if (deltaMessage) {
          deltaMessage.textContent = event.kind === "assistant.snapshot" ? event.delta : deltaMessage.textContent + event.delta;
          if (event.kind === "assistant.snapshot") deltaMessage = undefined;
          return;
        }
        if (list.lastElementChild === lastMessage && lastMessage?.textContent === event.delta) return;
        const item = document.createElement("li");
        item.className = "run-note" + (event.phase === "provider" ? " run-summary" : "");
        item.textContent = event.delta;
        list.appendChild(item);
        if (event.phase !== "provider") lastMessage = item;
        if (event.kind === "assistant.delta") deltaMessage = item;
        return;
      }
      deltaMessage = undefined;
      const item = document.createElement("li");
      if (event.kind === "tool.started" || event.kind === "tool.completed") {
        const type = event.tool?.type || "other";
        const running = runningTools.get(type) || 0;
        if (event.kind === "tool.started") { toolCount++; runningTools.set(type, running + 1); }
        else if (running > 0) runningTools.set(type, running - 1);
        else toolCount++;
        const status = event.tool?.status || "unknown";
        item.className = "run-tool" + (status === "failed" ? " run-tool-failed" : "");
        item.textContent = (labels[type] || "工具调用") + " · " + (statuses[status] || "已结束");
      } else {
        item.className = "run-status";
        item.textContent = event.title + (event.detail ? " · " + event.detail : "");
      }
      list.appendChild(item);
      if (terminal.has(event.kind)) {
        stateLabel = { "run.succeeded": "已完成", "run.failed": "执行失败", "run.cancelled": "已取消", "run.timed_out": "已超时" }[event.kind];
        if (event.kind === "run.succeeded") setAnswer(event.delta);
      }
      summary.textContent = stateLabel + " · 已调用 " + toolCount + " 次工具";
    };
    const runLabels = { queued: "排队中", running: "执行中", succeeded: "已完成", failed: "执行失败", cancelled: "已取消", timed_out: "已超时" };
    let stopped = false, reading = false, checking = false, progressUnavailable = false, timer;
    async function readProgress() {
      if (reading || stopped) return;
      reading = true;
      try {
        const snapshot = await readSnapshot();
        if (stopped) return;
        stateLabel = runLabels[snapshot.run?.status] || "等待进度";
        for (const event of snapshot.events || []) render(event);
        if (!lastSeq) {
          const empty = document.createElement("li");
          empty.className = "muted";
          empty.textContent = "这次运行尚无公开过程记录。";
          list.textContent = "";
          list.appendChild(empty);
        }
        summary.textContent = stateLabel + (lastSeq ? " · 已调用 " + toolCount + " 次工具" : "");
        setAnswer(snapshot.run?.output);
        if (!["queued", "running"].includes(snapshot.run?.status)) {
          source?.close();
          source = undefined;
        } else if (!source) {
          source = new EventSource("/api/chats/runs/" + encodeURIComponent(runId) + "/events?after=" + lastSeq);
          source.onmessage = message => {
            let event;
            try { event = JSON.parse(message.data); } catch { return; }
            render(event);
            if (terminal.has(event.kind)) {
              source?.close();
              source = undefined;
              // Terminal deltas are bounded. Read the complete saved answer.
              void readProgress();
            }
            if (terminal.has(event.kind) || event.kind === "run.started" || event.kind.startsWith("delivery.")) schedule(0);
          };
        }
        progressUnavailable = false;
      } catch {
        progressUnavailable = true;
        summary.textContent = "暂时无法读取执行轨迹，正在重连。";
        schedule(8000);
      } finally {
        reading = false;
      }
    }

    function schedule(delay) {
      clearTimeout(timer);
      if (!stopped && !document.hidden) timer = setTimeout(check, delay);
    }
    function stateChanged(state) {
      return root.dataset.runStatus !== state.status || root.dataset.deliveryStatus !== state.delivery.status
        || root.dataset.deliveryAttempts !== String(state.delivery.attempts)
        || root.dataset.cancelRequested !== (state.cancelRequested ? "1" : "0")
        || root.dataset.deliveryActive !== (state.deliveryActive ? "1" : "0");
    }
    async function refreshSections() {
      const response = await fetch(pagePath, { cache: "no-store", signal: AbortSignal.timeout(10000) });
      if (!response.ok || response.redirected) throw new Error();
      const page = new DOMParser().parseFromString(await response.text(), "text/html");
      const next = page.getElementById("live-run");
      if (next?.dataset.runId !== runId) throw new Error();
      const ids = ["chat-run-overview", "chat-run-details"];
      const replacements = ids.map(id => [document.getElementById(id), page.getElementById(id)]);
      if (replacements.some(([old, fresh]) => !old || !fresh)) throw new Error();
      if (stopped || document.hidden) return;
      const opened = [...root.querySelectorAll("details[open][id]")].map(el => el.id);
      const focus = document.activeElement;
      const focusedId = root.contains(focus) && focus.id;
      for (const [old, fresh] of replacements) old.replaceWith(fresh);
      for (const id of opened) {
        const details = document.getElementById(id);
        if (details) details.open = true;
      }
      if (focusedId && !focus.isConnected) document.getElementById(focusedId)?.focus({ preventScroll: true });
      Object.assign(root.dataset, next.dataset);
    }
    async function check() {
      if (checking || stopped || document.hidden) return;
      checking = true;
      let delay;
      try {
        const response = await fetch(pagePath + "/status", { cache: "no-store", signal: AbortSignal.timeout(10000) });
        if (!response.ok || response.redirected) throw new Error();
        const state = await response.json();
        if (stopped || document.hidden) return;
        const changed = stateChanged(state);
        if (changed) await refreshSections();
        if (changed || progressUnavailable || (!source && root.dataset.terminal === "0")) await readProgress();
        if (root.dataset.terminal === "0" || root.dataset.deliveryStatus === "pending" || root.dataset.deliveryActive === "1") delay = 3000;
        else if (progressUnavailable || (root.dataset.runStatus === "succeeded" && root.dataset.deliveryStatus === "failed")) delay = 8000;
      } catch {
        delay = 8000;
      } finally {
        checking = false;
        if (delay !== undefined) schedule(delay);
      }
    }
    document.addEventListener("visibilitychange", () => schedule(0));
    window.addEventListener("pagehide", () => {
      stopped = true;
      clearTimeout(timer);
      source?.close();
      source = undefined;
    });
    window.addEventListener("pageshow", event => {
      if (event.persisted) {
        stopped = false;
        void readProgress();
        schedule(0);
      }
    });
    void readProgress();
    schedule(0);
  })();`;
}
