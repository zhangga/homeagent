import type { PublicRunTool, RunEvent } from "@homeagent/shared";
import type { LiveReplySnapshot, LiveReplyStep } from "./connector.ts";

const TERMINAL = new Set(["succeeded", "failed", "cancelled", "timed_out"]);
const MAX_CARD_BYTES = 30 * 1024;
const MAX_CARD_ELEMENTS = 200;
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

function countToolCall(runningTools: Map<string, number>, type: string, started: boolean): number {
  const running = runningTools.get(type) ?? 0;
  if (started) {
    runningTools.set(type, running + 1);
    return 1;
  }
  if (running > 0) {
    runningTools.set(type, running - 1);
    return 0;
  }
  // Some providers report only the completed event for a tool.
  return 1;
}

function toolResult(tool: PublicRunTool | undefined): string | undefined {
  const evidence = tool?.lark;
  if (!evidence || tool?.status === "running") return undefined;
  const label = new Map([
    ["chat-list", "群列表查询"], ["chat-search", "群搜索"], ["chat-messages-list", "群消息查询"],
    ["messages-search", "消息搜索"], ["messages-mget", "消息读取"], ["threads-messages-list", "话题消息查询"],
    ["auth-status", "飞书授权状态查询"],
  ]).get(evidence.operation);
  if (!label) return undefined;
  if (tool?.status === "failed" || evidence.ok === false) return `${label}未成功，尚未取得可核验结果。`;
  if (evidence.ok !== true) return undefined;
  const count = evidence.count;
  if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0 && count <= 1_000_000) {
    return `${label}返回 ${count} 条结果${evidence.hasMore === true ? "，仍有后续分页" : ""}。`;
  }
  return `${label}已返回${evidence.hasMore === true ? "，仍有后续分页" : ""}。`;
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
      const kind = event.phase === "provider" || event.title === "执行进展" ? "summary" : "commentary";
      if (previous?.kind === kind && previous.title === text) continue;
      const step: LiveReplyStep = { seq: event.seq, title: text, kind };
      steps.push(step);
      if (event.kind === "assistant.delta") deltaStep = step;
      continue;
    }
    deltaStep = undefined;
    if (event.kind === "tool.started" || event.kind === "tool.completed") {
      const type = event.tool?.type ?? "other";
      const started = event.kind === "tool.started";
      toolCallCount += countToolCall(runningTools, type, started);
      const result = started ? undefined : toolResult(event.tool);
      steps.push({ seq: event.seq, title: TOOL_LABELS[type], kind: "tool",
        status: started ? "running" : event.tool?.lark?.ok === false ? "failed" : event.tool?.status ?? "unknown",
        ...(result ? { result } : {}),
      });
    } else if (!event.kind.startsWith("delivery.") && event.kind !== "run.succeeded") {
      steps.push({ seq: event.seq, title: bound(event.title, 120), kind: "status", status: event.status });
    }
  }
  // The final assistant message is calibrated by run.succeeded; keep one answer.
  if (answer) {
    const lastMessage = steps.findLastIndex(step => step.kind === "commentary");
    const message = steps[lastMessage]?.title;
    const body = bound(answer.replace(/^> 本次模型：[^\n]{1,300}\n(?:> 推理等级：[^\n]{1,300}\n)?\n/u, ""), 4_000);
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

interface ProcessRow {
  content: string;
  toolCallCount?: number;
  running?: boolean;
  failed?: boolean;
  result?: string;
  toolLabel?: string;
  toolRunning?: boolean;
}

function processRows(steps: LiveReplyStep[]): ProcessRow[] {
  const statuses: Record<string, string> = { running: "执行中", completed: "已完成", failed: "失败", unknown: "已结束" };
  const runningTools = new Map<string, number>();
  let toolCallCount = 0;
  return steps.map(step => {
    const title = bound(step.title, step.kind === "commentary" || step.kind === "summary" ? 4_000 : 120);
    if (step.kind !== "tool") {
      return { content: step.kind === "commentary" || step.kind === "summary" ? title : `> ${title}` };
    }
    toolCallCount += countToolCall(runningTools, title, step.status === "running");
    return {
      content: `${step.status === "failed" ? "✗" : step.status === "running" ? "◷" : "✓"} ${title} · ${statuses[step.status ?? "unknown"] ?? "已结束"}`,
      toolCallCount,
      running: [...runningTools.values()].some(count => count > 0),
      failed: step.status === "failed",
      result: bound(step.result, 4_000) || undefined,
      toolLabel: title,
      toolRunning: step.status === "running",
    };
  });
}

function processElements(rows: ProcessRow[]): Record<string, unknown>[] {
  const elements: Record<string, unknown>[] = [];
  let tools: ProcessRow[] = [];
  const flushTools = () => {
    const last = tools.at(-1);
    if (!last) return;
    const failed = tools.some(row => row.failed);
    const status = `${last.running ? " · 执行中" : ""}${failed ? " · 包含失败" : ""}`;
    const results = tools.flatMap(row => row.result ? [row.result] : []);
    if (results.length) elements.push({ tag: "markdown", content: results.join("\n\n"), text_size: "normal" });
    // Show the latest state once per invocation instead of a start/end transcript.
    const details: ProcessRow[] = [];
    const pending = new Map<string, number[]>();
    for (const row of tools) {
      const key = row.toolLabel ?? "";
      const positions = pending.get(key) ?? [];
      const position = row.toolRunning ? undefined : positions.shift();
      if (position === undefined) {
        if (row.toolRunning) positions.push(details.length);
        details.push(row);
      } else details[position] = row;
      pending.set(key, positions);
    }
    elements.push({
      tag: "collapsible_panel", expanded: false, padding: "0px", vertical_spacing: "4px",
      header: {
        title: { tag: "markdown", content: `<font color='${failed ? "red" : "grey"}'>已调用 ${last.toolCallCount} 次工具${status}</font>` },
        width: "auto", icon_position: "follow_text", padding: "0px",
      },
      elements: [{ tag: "markdown", content: details.map(row => row.content).join("\n"), text_size: "notation" }],
    });
    tools = [];
  };
  for (const row of rows) {
    if (row.toolCallCount !== undefined) tools.push(row);
    else {
      flushTools();
      elements.push({ tag: "markdown", content: row.content, text_size: "normal" });
    }
  }
  flushTools();
  return elements;
}

function cardElementCount(value: unknown): number {
  if (!value || typeof value !== "object") return 0;
  return ("tag" in value ? 1 : 0) + Object.values(value).reduce<number>((sum, item) => sum + cardElementCount(item), 0);
}

function omissionNotice(count: number): Record<string, unknown> {
  return { tag: "markdown", content: `较早的 ${count} 条过程记录未在卡片内展开，可在管理后台查看。`, text_size: "notation" };
}

export function buildLiveReplyCard(snapshot: LiveReplySnapshot): Record<string, unknown> {
  const labels: Record<LiveReplySnapshot["state"], string> = {
    queued: "排队中", running: "执行中", waiting: "等待处理", succeeded: "已完成",
    failed: "执行失败", cancelled: "已取消", timed_out: "已超时",
  };
  const stateTitle = snapshot.state === "succeeded" ? "任务已完成" : labels[snapshot.state];
  const processPanel: Record<string, unknown> = {
    tag: "collapsible_panel", expanded: true, padding: "0px", vertical_spacing: "8px",
    header: {
      title: { tag: "plain_text", content: stateTitle },
      width: "auto", icon_position: "follow_text", padding: "0px",
    },
    elements: [],
  };
  const elements: Record<string, unknown>[] = [processPanel];
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
  // Lifecycle labels are useful while waiting, but must not obscure the actual
  // summaries and tool activity once a successful turn has completed.
  const hasActivity = snapshot.steps.some(step => step.kind === "commentary" || step.kind === "summary" || step.kind === "tool");
  const processSteps = snapshot.steps.filter(step => step.kind !== "status"
    || (snapshot.state !== "succeeded" && (!hasActivity || ["failed", "cancelled", "timed_out"].includes(step.status ?? ""))));
  const empty = isLiveReplyTerminal(snapshot) ? "本次调用未返回可展示的过程摘要。" : "正在准备执行…";
  const rows = processRows(processSteps);
  let retained: Record<string, unknown>[] = rows.length
    ? [omissionNotice(rows.length)] : [{ tag: "markdown", content: empty, text_size: "normal" }];
  processPanel.elements = retained;
  // Apply both platform limits to the complete payload, including nested panels
  // and the omission notice. Count totals before trimming a suffix of the journal.
  for (let index = rows.length - 1; index >= 0; index--) {
    const candidate = processElements(rows.slice(index));
    if (index > 0) candidate.unshift(omissionNotice(index));
    processPanel.elements = candidate;
    if (Buffer.byteLength(JSON.stringify(card), "utf8") > MAX_CARD_BYTES || cardElementCount(card) > MAX_CARD_ELEMENTS) break;
    retained = candidate;
  }
  processPanel.elements = retained;
  return card;
}

export function isLiveReplyTerminal(snapshot: LiveReplySnapshot): boolean {
  return TERMINAL.has(snapshot.state);
}
