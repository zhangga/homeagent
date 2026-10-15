/** Static browser bootstrap: public progress stays in order, answers have one slot. */
export function chatRunLiveScript(): string {
  return String.raw`(() => {
    const root = document.getElementById("live-run");
    const list = document.getElementById("live-run-events");
    const answer = document.getElementById("live-run-answer");
    const summary = document.getElementById("live-run-summary");
    if (!root || !list || !answer || !summary) return;
    const runId = root.dataset.runId;
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
    const readSnapshot = () => fetch(endpoint, { credentials: "same-origin", cache: "no-store" })
      .then(response => response.ok ? response.json() : Promise.reject(new Error("snapshot failed")));
    const setAnswer = text => {
      if (!text) return;
      answer.textContent = text;
      answer.style.display = "block";
      const body = text.replace(/^> 本次模型：[^\n]{1,300}\n\n/u, "").trim();
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
        source?.close();
        if (event.kind === "run.succeeded") setAnswer(event.delta);
        // The journal bounds deltas; the durable Run owns the complete answer.
        if (source) readSnapshot().then(snapshot => setAnswer(snapshot.run?.output)).catch(() => {});
      }
      summary.textContent = stateLabel + " · 已调用 " + toolCount + " 次工具";
    };
    readSnapshot().then(snapshot => {
      for (const event of snapshot.events || []) render(event);
      if (!(snapshot.events || []).length) {
        const empty = document.createElement("li");
        empty.className = "muted";
        empty.textContent = "这次运行尚无公开过程记录。";
        list.textContent = "";
        list.appendChild(empty);
        summary.textContent = { queued: "排队中", running: "执行中", succeeded: "已完成", failed: "执行失败", cancelled: "已取消", timed_out: "已超时" }[snapshot.run?.status] || "等待进度";
      }
      setAnswer(snapshot.run?.output);
      if (["succeeded", "failed", "cancelled", "timed_out"].includes(snapshot.run?.status)) return;
      source = new EventSource("/api/chats/runs/" + encodeURIComponent(runId) + "/events?after=" + lastSeq);
      source.onmessage = message => { try { render(JSON.parse(message.data)); } catch {} };
    }).catch(() => {
      summary.textContent = "实时连接不可用，可刷新页面查看持久化状态。";
    });
  })();`;
}
