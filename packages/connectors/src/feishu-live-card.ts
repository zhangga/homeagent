import type { RunEvent } from "@homeagent/shared";
import type { LiveReplySnapshot } from "./connector.ts";

const TERMINAL = new Set(["succeeded", "failed", "cancelled", "timed_out"]);

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
  const steps = events
    .filter(event => event.visibility === "public" && !event.kind.startsWith("assistant."))
    .slice(-8)
    .map(event => ({ seq: event.seq, title: bound(event.title, 120), status: event.status ?? event.tool?.status }));
  const commentary = events
    .filter(event => event.visibility === "public" && event.kind === "assistant.snapshot")
    .map(event => bound(event.delta, 1_200))
    .filter(Boolean)
    .slice(-6);
  const toolCallCount = events.filter(event => event.kind === "tool.started").length;
  const answer = [...events].reverse().find(event => event.kind === "run.succeeded" || event.kind === "assistant.snapshot")?.delta;
  return {
    runId,
    seq: last?.seq ?? 0,
    state,
    phase: last?.phase,
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
  const templates: Record<LiveReplySnapshot["state"], string> = {
    queued: "blue", running: "blue", waiting: "yellow", succeeded: "green",
    failed: "red", cancelled: "grey", timed_out: "orange",
  };
  const statusBackground = snapshot.state === "succeeded" ? "green-50"
    : snapshot.state === "failed" ? "red-50"
    : snapshot.state === "timed_out" ? "orange-50"
    : snapshot.state === "cancelled" ? "grey-50" : "blue-50";
  const stepText = snapshot.steps.length
    ? snapshot.steps.map(step => `- ${step.title}`).join("\n")
    : "- 正在准备执行";
  const elements: Record<string, unknown>[] = [
    {
      tag: "column_set", flex_mode: "none", margin: "0px 0px 12px 0px",
      columns: [{
        tag: "column", width: "weighted", weight: 1, background_style: statusBackground,
        padding: "12px", vertical_spacing: "4px",
        elements: [{ tag: "markdown", content: `**当前状态**\n${labels[snapshot.state]}` }],
      }, {
        tag: "column", width: "weighted", weight: 1, background_style: "grey-50",
        padding: "12px", vertical_spacing: "4px",
        elements: [{ tag: "markdown", content: `**最新阶段**\n${bound(snapshot.phase, 80) || "处理中"}` }],
      }],
    },
    { tag: "markdown", content: `**执行步骤**\n${stepText}`, text_size: "normal", margin: "0px 0px 12px 0px" },
  ];
  if (snapshot.commentary.length) {
    elements.push({
      tag: "markdown",
      content: `**分析与执行**\n${snapshot.commentary.join("\n\n")}`,
      text_size: "normal",
      margin: "0px 0px 12px 0px",
    });
  }
  if (snapshot.toolCallCount > 0) {
    elements.push({
      tag: "markdown",
      content: `已调用 ${snapshot.toolCallCount} 次工具`,
      text_size: "notation",
      margin: "0px 0px 12px 0px",
    });
  }
  if (snapshot.answerPreview) {
    elements.push({ tag: "markdown", content: `**回答预览**\n${snapshot.answerPreview}`, text_size: "normal", margin: "0px 0px 12px 0px" });
  }
  if (snapshot.detailUrl) {
    elements.push({
      tag: "button", type: "primary_filled", width: "fill", text: { tag: "plain_text", content: "查看详细执行" },
      behaviors: [{ type: "open_url", default_url: snapshot.detailUrl }],
    });
  }
  return {
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
    header: {
      title: { tag: "plain_text", content: "HomeAgent 执行进度" },
      subtitle: { tag: "plain_text", content: `Run ${snapshot.runId.slice(-8)}` },
      template: templates[snapshot.state],
      icon: { tag: "standard_icon", token: "myai_colorful" },
      text_tag_list: [{ tag: "text_tag", text: { tag: "plain_text", content: labels[snapshot.state] }, color: templates[snapshot.state] }],
    },
    body: { direction: "vertical", padding: "12px 12px 20px 12px", vertical_spacing: "8px", elements },
  };
}

export function isLiveReplyTerminal(snapshot: LiveReplySnapshot): boolean {
  return TERMINAL.has(snapshot.state);
}
