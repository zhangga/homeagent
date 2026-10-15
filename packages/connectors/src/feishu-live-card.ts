import type { RunEvent } from "@homeagent/shared";
import type { LiveReplySnapshot, LiveReplyStep } from "./connector.ts";

const TERMINAL = new Set(["succeeded", "failed", "cancelled", "timed_out"]);
const MAX_CARD_BYTES = 30 * 1024;
const TOOL_LABELS = {
  command: "命令执行", "file-read": "读取文件", "file-change": "修改文件",
  mcp: "外部工具", "web-search": "网络查询", other: "工具调用",
};

function bound(value: string | undefined, limit: number): string {
  return (value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .trim()
    .slice(0, limit);
}

export function liveReplySnapshot(
  runId: string,
  events: RunEvent[],
  detailUrl?: string,
): LiveReplySnapshot {
  const last = events.at(-1);
  const terminal = [...events].reverse().find(event =>
    event.kind === "run.succeeded"
    || event.kind === "run.failed"
    || event.kind === "run.cancelled"
    || event.kind === "run.timed_out");
  const state: LiveReplySnapshot["state"] = terminal?.kind === "run.succeeded" ? "succeeded"
    : terminal?.kind === "run.failed" ? "failed"
    : terminal?.kind === "run.cancelled" ? "cancelled"
    : terminal?.kind === "run.timed_out" ? "timed_out"
    : events.some(event => event.kind === "run.started") ? "running" : "queued";
  const publicEvents = events.filter(event => event.visibility === "public");
  const answer = [...publicEvents].reverse().find(event => event.kind === "run.succeeded")?.delta;
  const steps: LiveReplyStep[] = [];
  let toolCallCount = 0;
  let deltaStep: LiveReplyStep | undefined;
  const runningTools = new Map<string, number>();
  for (const event of publicEvents) {
    if (event.kind === "assistant.delta" || event.kind === "assistant.snapshot") {
      const text = bound(event.delta, 4_000);
      if (!text) continue;
      if (deltaStep) {
        deltaStep.title = event.kind === "assistant.snapshot" ? text : bound(deltaStep.title + text, 4_000);
        if (event.kind === "assistant.snapshot") deltaStep = undefined;
        continue;
      }
      const previous = steps.at(-1);
      const kind = event.phase === "provider" ? "summary" : "commentary";
      if (previous?.kind === kind && previous.title === text) continue;
      const step: LiveReplyStep = { seq: event.seq, title: text, kind };
      steps.push(step);
      if (event.kind === "assistant.delta") deltaStep = step;
      continue;
    }
    deltaStep = undefined;
    if (event.kind === "tool.started" || event.kind === "tool.completed") {
      const type = event.tool?.type ?? "other";
      const running = runningTools.get(type) ?? 0;
      if (event.kind === "tool.started") {
        toolCallCount++;
        runningTools.set(type, running + 1);
      } else if (running > 0) {
        runningTools.set(type, running - 1);
      } else {
        // Some providers report only the completed event for a tool.
        toolCallCount++;
      }
      steps.push({ seq: event.seq, title: TOOL_LABELS[type], kind: "tool", status: event.tool?.status });
    } else if (!event.kind.startsWith("delivery.") && event.kind !== "run.succeeded") {
      steps.push({ seq: event.seq, title: bound(event.title, 120), kind: "status", status: event.status });
    }
  }
  // The final assistant message is calibrated by run.succeeded; keep one answer.
  if (answer) {
    const lastMessage = steps.findLastIndex(step => step.kind === "commentary");
    const message = steps[lastMessage]?.title;
    const body = bound(answer.replace(/^> 本次模型：[^\n]{1,300}\n\n/u, ""), 4_000);
    if (message && body && !steps.slice(lastMessage + 1).some(step => step.kind === "tool")
      && (body.startsWith(message) || message.startsWith(body))) steps.splice(lastMessage, 1);
  }
  const commentary = steps.filter(step => step.kind === "commentary" || step.kind === "summary").map(step => step.title);
  return {
    runId,
    seq: last?.seq ?? 0,
    state,
    phase: publicEvents.at(-1)?.phase,
    steps,
    commentary,
    toolCallCount,
    answerPreview: bound(answer, 8_000) || undefined,
    startedAt: events[0]?.at ?? Date.now(),
    detailUrl,
    canCancel: state === "queued" || state === "running",
    canRetry: state === "failed" || state === "cancelled" || state === "timed_out",
  };
}

export function buildLiveReplyCard(snapshot: LiveReplySnapshot): Record<string, unknown> {
  const labels: Record<LiveReplySnapshot["state"], string> = {
    queued: "排队中", running: "执行中", waiting: "等待处理", succeeded: "已完成",
    failed: "执行失败", cancelled: "已取消", timed_out: "已超时",
  };
  const stateTitle = snapshot.state === "succeeded" ? "任务已完成" : labels[snapshot.state];
  const toolCount = snapshot.toolCallCount > 0 ? ` · 已调用 ${snapshot.toolCallCount} 次工具` : "";
  const processContent: Record<string, unknown> = { tag: "markdown", content: "", text_size: "normal" };
  const elements: Record<string, unknown>[] = [
    {
      tag: "collapsible_panel",
      expanded: true,
      header: { title: { tag: "plain_text", content: `${stateTitle}${toolCount}` } },
      padding: "4px", vertical_spacing: "8px",
      elements: [processContent],
    },
  ];
  if (snapshot.detailUrl) {
    elements.push({
      tag: "button", type: "primary_filled", width: "fill", text: { tag: "plain_text", content: "查看详细执行" },
      behaviors: [{ type: "open_url", default_url: snapshot.detailUrl }],
    });
  }
  const card = {
    schema: "2.0",
    config: {
      update_multi: true,
      streaming_mode: !isLiveReplyTerminal(snapshot),
      streaming_config: {
        print_frequency_ms: { default: 70, android: 70, ios: 70, pc: 70 },
        print_step: { default: 1, android: 1, ios: 1, pc: 1 },
        print_strategy: "fast",
      },
      width_mode: "default",
      enable_forward: isLiveReplyTerminal(snapshot),
      summary: { content: isLiveReplyTerminal(snapshot) ? `HomeAgent · ${labels[snapshot.state]}` : "[生成中...]" },
    },
    body: { direction: "vertical", padding: "12px", vertical_spacing: "8px", elements },
  };
  // CardKit rejects payloads over 30 KiB. Keep recent complete entries and make
  // any omitted history explicit; the durable journal retains the full timeline.
  const budget = Math.max(0, MAX_CARD_BYTES - Buffer.byteLength(JSON.stringify(card), "utf8") - 512);
  const rows: string[] = [];
  let usedBytes = 0;
  const statuses: Record<string, string> = { running: "执行中", completed: "已完成", failed: "失败", unknown: "已结束" };
  // Lifecycle labels are useful while waiting, but must not obscure the actual
  // summaries and tool activity once a successful turn has completed.
  const processSteps = snapshot.state === "succeeded"
    ? snapshot.steps.filter(step => step.kind !== "status") : snapshot.steps;
  for (const step of [...processSteps].reverse()) {
    const row = step.kind === "commentary" || step.kind === "summary" ? bound(step.title, 4_000)
      : step.kind === "tool" ? `> ${step.status === "failed" ? "✗" : step.status === "running" ? "◷" : "✓"} ${bound(step.title, 120)} · ${statuses[step.status ?? "unknown"] ?? "已结束"}`
      : `> ${bound(step.title, 120)}`;
    const bytes = Buffer.byteLength(JSON.stringify(row), "utf8") + 4;
    if (usedBytes + bytes > budget) break;
    rows.unshift(row);
    usedBytes += bytes;
  }
  const omitted = processSteps.length - rows.length;
  const empty = isLiveReplyTerminal(snapshot) ? "本次调用未返回可展示的过程摘要。" : "正在准备执行…";
  processContent.content = `${omitted ? `较早的 ${omitted} 条过程记录未在卡片内展开，可在管理后台查看。\n\n` : ""}${rows.join("\n\n") || (omitted ? "" : empty)}`;
  return card;
}

export function isLiveReplyTerminal(snapshot: LiveReplySnapshot): boolean {
  return TERMINAL.has(snapshot.state);
}
