import { expect, test } from "bun:test";
import type { RunEvent } from "@homeagent/shared";
import { buildLiveReplyCard, liveReplySnapshot } from "./feishu-live-card.ts";

const events = [
  { schemaVersion: 1 as const, runId: "chat_run_card", seq: 1, at: 100, kind: "run.queued" as const, visibility: "public" as const, title: "请求已进入队列" },
  { schemaVersion: 1 as const, runId: "chat_run_card", seq: 2, at: 110, kind: "tool.started" as const, visibility: "public" as const, title: "工具开始执行", tool: { type: "web-search" as const, status: "running" as const } },
  { schemaVersion: 1 as const, runId: "chat_run_card", seq: 3, at: 120, kind: "assistant.snapshot" as const, visibility: "public" as const, title: "正在生成回答", delta: "阶段性答案" },
];

test("builds a bounded Card 2.0 live snapshot", () => {
  const snapshot = liveReplySnapshot("chat_run_card", events, "http://127.0.0.1:3000/chats/runs/chat_run_card");
  expect(snapshot.state).toBe("queued");
  expect(snapshot.answerPreview).toBeUndefined();
  expect(snapshot.commentary).toEqual(["阶段性答案"]);
  expect(snapshot.toolCallCount).toBe(1);
  expect(snapshot.steps).toHaveLength(3);
  const card = buildLiveReplyCard(snapshot);
  expect(card.schema).toBe("2.0");
  expect((card.config as { streaming_mode: boolean }).streaming_mode).toBeTrue();
  expect(JSON.stringify(card)).toContain("查看详细执行");
  expect(JSON.stringify(card)).toContain("已调用 1 次工具");
  expect(JSON.stringify(card)).not.toContain("private query");
});

test("keeps the Run terminal state after delivery events", () => {
  const snapshot = liveReplySnapshot("chat_run_card", [
    ...events,
    { schemaVersion: 1 as const, runId: "chat_run_card", seq: 4, at: 130, kind: "run.succeeded" as const, visibility: "public" as const, status: "succeeded" as const, title: "执行完成", delta: "最终答案" },
    { schemaVersion: 1 as const, runId: "chat_run_card", seq: 5, at: 140, kind: "delivery.started" as const, visibility: "public" as const, phase: "delivery" as const, status: "running" as const, title: "正在更新飞书回复" },
  ]);
  expect(snapshot.state).toBe("succeeded");
  expect(snapshot.answerPreview).toBe("最终答案");
  const card = buildLiveReplyCard(snapshot);
  expect((card.config as { streaming_mode: boolean }).streaming_mode).toBeFalse();
});

test("keeps a large answer exclusively in the final reply instead of the process card", () => {
  const snapshot = liveReplySnapshot("chat_run_card", [{
    schemaVersion: 1 as const,
    runId: "chat_run_card",
    seq: 1,
    at: 100,
    kind: "run.succeeded" as const,
    visibility: "public" as const,
    status: "succeeded" as const,
    title: "执行完成",
    delta: "回".repeat(8_000),
  }]);
  const card = JSON.stringify(buildLiveReplyCard(snapshot));
  expect(card).not.toContain("回".repeat(8_000));
  expect(Buffer.byteLength(card, "utf8")).toBeLessThan(30 * 1024);
});


test("preserves line breaks while stripping unsafe control characters", () => {
  const snapshot = liveReplySnapshot("chat_run_card", [{
    schemaVersion: 1 as const,
    runId: "chat_run_card",
    seq: 1,
    at: 100,
    kind: "assistant.snapshot" as const,
    visibility: "public" as const,
    title: "answer",
    delta: "第一行\n第二行\u0000",
  }]);
  expect(snapshot.commentary).toEqual(["第一行\n第二行"]);
});

function event(seq: number, kind: RunEvent["kind"], data: Partial<RunEvent> = {}): RunEvent {
  return { schemaVersion: 1, runId: "chat_run_card", seq, at: seq * 10, kind, visibility: "public", title: kind, ...data };
}

test("shows a completed no-tool reasoning summary without hiding it or repeating the answer", () => {
  const answer = "> 本次模型：Codex · CLI 默认（未返回具体型号）\n\n当前会话未返回具体型号。";
  const snapshot = liveReplySnapshot("chat_run_card", [
    event(1, "run.started"),
    event(2, "assistant.snapshot", { title: "思考摘要", phase: "provider", delta: "需要依据会话返回的信息说明型号，无法确认时明确说明。" }),
    event(3, "assistant.snapshot", { phase: "answer", delta: "当前会话未返回具体型号。" }),
    event(4, "run.succeeded", { delta: answer }),
  ]);
  const card = JSON.stringify(buildLiveReplyCard(snapshot));
  expect(card).toContain("需要依据会话返回的信息说明型号");
  expect(card).toContain('"expanded":true');
  expect(card).not.toContain("当前状态");
  expect(card).not.toContain("最新阶段");
  expect(card).not.toContain("已调用 0 次工具");
  expect(card).not.toContain("当前会话未返回具体型号。");
});

test("interleaves public updates with tools and keeps more than six updates", () => {
  const history: RunEvent[] = [event(1, "run.started")];
  for (let index = 0; index < 10; index++) {
    history.push(event(history.length + 1, "assistant.snapshot", { delta: `第 ${index + 1} 步：核对构建进度。` }));
    history.push(event(history.length + 1, "tool.started", { tool: { type: "web-search", status: "running" } }));
    history.push(event(history.length + 1, "tool.completed", { tool: { type: "web-search", status: "completed" } }));
  }
  history.push(event(history.length + 1, "assistant.snapshot", { delta: "构建并更新完成。" }));
  history.push(event(history.length + 1, "run.succeeded", { delta: "构建并更新完成。" }));
  history.push(event(history.length + 1, "assistant.snapshot", { visibility: "operator", delta: "PRIVATE_OPERATOR_TEXT" }));
  const snapshot = liveReplySnapshot("chat_run_card", history);
  expect(snapshot.commentary).toHaveLength(10);
  expect(snapshot.toolCallCount).toBe(10);
  const card = JSON.stringify(buildLiveReplyCard(snapshot));
  expect(card.indexOf("第 1 步")).toBeLessThan(card.indexOf("网络查询"));
  expect(card.indexOf("网络查询")).toBeLessThan(card.indexOf("第 2 步"));
  expect(card).toContain("第 10 步");
  expect(card).not.toContain("构建并更新完成。");
  expect(card).not.toContain("PRIVATE_OPERATOR_TEXT");
  expect(card).toContain('"expanded":true');
});

test("coalesces deltas and repeated snapshots without losing later repeated steps", () => {
  const snapshot = liveReplySnapshot("chat_run_card", [
    event(1, "assistant.delta", { delta: "正在" }),
    event(2, "assistant.delta", { delta: "查询" }),
    event(3, "assistant.snapshot", { delta: "正在查询" }),
    event(4, "assistant.snapshot", { delta: "正在查询" }),
    event(5, "tool.completed", { tool: { type: "file-change", status: "completed" } }),
    event(6, "assistant.snapshot", { delta: "正在查询" }),
  ]);
  expect(snapshot.commentary).toEqual(["正在查询", "正在查询"]);
  expect(snapshot.steps.map(step => step.kind)).toEqual(["commentary", "tool", "commentary"]);
  expect(snapshot.toolCallCount).toBe(1);
});

test("retains failed tool progress and explicitly bounds a large combined card", () => {
  const history = Array.from({ length: 80 }, (_, index) => event(index + 1, "assistant.snapshot", {
    delta: `步骤 ${index}：${"进展😀\n".repeat(600)}`,
  }));
  history.push(event(81, "tool.completed", { tool: { type: "command", status: "failed" } }));
  history.push(event(82, "run.failed", { status: "failed" }));
  const snapshot = liveReplySnapshot("chat_run_card", history);
  const card = JSON.stringify(buildLiveReplyCard({ ...snapshot, answerPreview: "回".repeat(8_000) }));
  expect(snapshot.commentary).toHaveLength(80);
  expect(card).toContain("失败");
  expect(card).toContain("较早的");
  expect(Buffer.byteLength(card, "utf8")).toBeLessThanOrEqual(30 * 1024);
});

test.each(["", "> 推理等级：`xhigh`（本次运行配置）\n"])("keeps model/reasoning captions in the answer without repeating them in the process card: %s", reasoningCaption => {
  const answer = "完成更新。";
  const output = `> 本次模型：Codex · \`gpt-5.6-sol\`（本次运行配置）\n${reasoningCaption}\n${answer}`;
  const snapshot = liveReplySnapshot("chat_run_card", [
    event(1, "assistant.snapshot", { delta: "先检查，再更新。" }),
    event(2, "tool.completed", { tool: { type: "command", status: "completed" } }),
    event(3, "assistant.snapshot", { delta: answer }),
    event(4, "phase.started", { title: "会话模型已确认", detail: "gpt-5.6-sol" }),
    event(5, "run.succeeded", { delta: output }),
  ]);
  expect(snapshot.commentary).toEqual(["先检查，再更新。"]);
  const card = JSON.stringify(buildLiveReplyCard(snapshot));
  expect(snapshot.answerPreview).toBe(output);
  expect(card).not.toContain("本次模型：Codex");
  expect(card).not.toContain(answer);
});

test("explains an absent summary without inventing a process or showing a zero-tool counter", () => {
  const snapshot = liveReplySnapshot("chat_run_card", [
    event(1, "run.started"),
    event(2, "assistant.snapshot", { delta: "简短回答" }),
    event(3, "run.succeeded", { delta: "简短回答" }),
  ]);
  const card = JSON.stringify(buildLiveReplyCard(snapshot));
  expect(card).toContain("本次调用未返回可展示的过程摘要。");
  expect(card).not.toContain("已调用 0 次工具");
  expect(card).not.toContain("简短回答");
});

function processPanel(snapshot: ReturnType<typeof liveReplySnapshot>) {
  const card = buildLiveReplyCard(snapshot);
  return (card.body as { elements: Array<{
    tag: string;
    expanded: boolean;
    header: { title: { content: string }; width?: string; icon_position?: string };
    elements: Array<{ tag: string; content?: string; expanded?: boolean; header?: { title: { content: string } } }>;
  }> }).elements[0]!;
}

test("renders Mew-style progress paragraphs with compact expandable tool activity", () => {
  const snapshot = liveReplySnapshot("chat_run_card", [
    event(1, "assistant.snapshot", { delta: "先检查环境和创建参数。" }),
    event(2, "tool.started", { tool: { type: "file-read", status: "running" } }),
    event(3, "tool.completed", { tool: { type: "file-read", status: "completed" } }),
    event(4, "tool.started", { tool: { type: "command", status: "running" } }),
    event(5, "tool.completed", { tool: { type: "command", status: "completed" } }),
    event(6, "assistant.snapshot", { delta: "环境可用，继续验证连接。" }),
    event(7, "tool.completed", { tool: { type: "web-search", status: "completed" } }),
    event(8, "run.succeeded", { delta: "已创建并验证。" }),
  ]);
  const panel = processPanel(snapshot);
  expect(panel.header.title.content).toBe("任务已完成");
  expect(panel.header.width).toBe("auto");
  expect(panel.header.icon_position).toBe("follow_text");
  expect(panel.expanded).toBeTrue();
  expect(panel.elements.map(element => element.tag)).toEqual([
    "markdown", "collapsible_panel", "markdown", "collapsible_panel",
  ]);
  expect(panel.elements[0]?.content).toBe("先检查环境和创建参数。");
  expect(panel.elements[1]?.expanded).toBeFalse();
  expect(panel.elements[1]?.header?.title.content).toContain("已调用 2 次工具");
  expect(panel.elements[2]?.content).toBe("环境可用，继续验证连接。");
  expect(panel.elements[3]?.header?.title.content).toContain("已调用 3 次工具");
  expect(JSON.stringify(panel.elements[1])).toContain("读取文件");
  expect(JSON.stringify(panel.elements[1])).toContain("命令执行");
  expect(JSON.stringify(panel)).not.toContain("已创建并验证。");
});

test("does not double-count tools that finish after an intervening progress paragraph", () => {
  const panel = processPanel(liveReplySnapshot("chat_run_card", [
    event(1, "tool.started", { tool: { type: "command", status: "running" } }),
    event(2, "tool.started", { tool: { type: "command", status: "running" } }),
    event(3, "assistant.snapshot", { delta: "等待两项检查完成。" }),
    event(4, "tool.completed", { tool: { type: "command", status: "completed" } }),
    event(5, "tool.completed", { tool: { type: "command", status: "failed" } }),
    event(6, "run.failed", { title: "检查失败", status: "failed" }),
  ]));
  const groups = panel.elements.filter(element => element.tag === "collapsible_panel");
  expect(groups).toHaveLength(2);
  expect(groups[0]?.header?.title.content).toContain("已调用 2 次工具");
  expect(groups[0]?.header?.title.content).toContain("执行中");
  expect(groups[1]?.header?.title.content).toContain("已调用 2 次工具");
  expect(groups[1]?.header?.title.content).toContain("失败");
  expect(groups[1]?.header?.title.content).not.toContain("执行中");
  expect(JSON.stringify(panel)).toContain("检查失败");
});

function cardElementCount(value: unknown): number {
  if (!value || typeof value !== "object") return 0;
  return ("tag" in value ? 1 : 0) + Object.values(value).reduce<number>((sum, item) => sum + cardElementCount(item), 0);
}

test("bounds a long compact timeline by the platform element limit as well as bytes", () => {
  const history: RunEvent[] = [];
  for (let index = 0; index < 100; index++) {
    history.push(event(history.length + 1, "assistant.snapshot", { delta: `步骤 ${index}。` }));
    history.push(event(history.length + 1, "tool.completed", { tool: { type: "command", status: "completed" } }));
  }
  history.push(event(history.length + 1, "run.succeeded", { delta: "结束。" }));
  const card = buildLiveReplyCard(liveReplySnapshot("chat_run_card", history));
  expect(cardElementCount(card)).toBeLessThanOrEqual(200);
  expect(Buffer.byteLength(JSON.stringify(card), "utf8")).toBeLessThanOrEqual(30 * 1024);
  expect(JSON.stringify(card)).toContain("较早的");
  expect(JSON.stringify(card)).toContain("步骤 99。");
  expect(JSON.stringify(card)).toContain("已调用 100 次工具");
});

test("retains recent tool details and the true total when a single group exceeds the card budget", () => {
  const history = Array.from({ length: 1_000 }, (_, index) => event(index + 1, "tool.completed", {
    tool: { type: index === 999 ? "web-search" : "command", status: "completed" },
  }));
  history.push(event(1_001, "run.succeeded", { delta: "结束。" }));
  const card = buildLiveReplyCard(liveReplySnapshot("chat_run_card", history));
  expect(Buffer.byteLength(JSON.stringify(card), "utf8")).toBeLessThanOrEqual(30 * 1024);
  expect(JSON.stringify(card)).toContain("较早的");
  expect(JSON.stringify(card)).toContain("网络查询");
  expect(JSON.stringify(card)).toContain("已调用 1000 次工具");
});

test("shows verified execution results above compact tool details while running", () => {
  const snapshot = liveReplySnapshot("chat_run_card", [
    event(1, "run.queued", { title: "请求已进入队列" }),
    event(2, "run.started", { title: "开始执行" }),
    event(3, "phase.completed", { title: "Provider 执行完成" }),
    event(4, "assistant.snapshot", { delta: "已确认目标群，开始读取消息。" }),
    event(5, "tool.started", { tool: { type: "command", status: "running" } }),
    event(6, "tool.completed", { tool: { type: "command", status: "completed", exitCode: 0,
      lark: { operation: "chat-messages-list", requestedIdentity: "user", ok: true, count: 28, hasMore: true } } }),
    event(7, "assistant.snapshot", { delta: "已取得本页 28 条消息，还需要继续翻页。" }),
  ]);
  const panel = processPanel(snapshot);
  expect(panel.elements.some(element => element.tag === "markdown" && element.content?.includes("群消息查询返回 28 条结果，仍有后续分页"))).toBe(true);
  expect(panel.elements.some(element => element.tag === "markdown" && element.content?.includes("已取得本页 28 条消息"))).toBe(true);
  expect(JSON.stringify(panel)).not.toContain("请求已进入队列");
  expect(JSON.stringify(panel)).not.toContain("Provider 执行完成");
  const details = panel.elements.find(element => element.tag === "collapsible_panel");
  expect(JSON.stringify(details)).not.toContain("◷ 命令执行");
  expect(JSON.stringify(details)).toContain("✓ 命令执行");
  expect(snapshot.toolCallCount).toBe(1);
});

test("zero results and failed queries stay factual without revealing raw output or claiming success", () => {
  const snapshot = liveReplySnapshot("chat_run_card", [
    event(1, "tool.completed", { tool: { type: "command", status: "completed",
      lark: { operation: "chat-search", requestedIdentity: "user", ok: true, count: 0 } } }),
    event(2, "tool.completed", { tool: { type: "command", status: "failed", exitCode: 1,
      lark: { operation: "messages-search", requestedIdentity: "user", ok: false, count: 10 } } }),
  ]);
  const card = JSON.stringify(buildLiveReplyCard(snapshot));
  expect(card).toContain("群搜索返回 0 条结果");
  expect(card).toContain("消息搜索未成功");
  expect(card).not.toContain("返回 10 条结果");
});

test("an explicit execution update remains visible when the final answer starts with the same result", () => {
  const snapshot = liveReplySnapshot("chat_run_card", [
    event(1, "assistant.snapshot", { title: "执行进展", phase: "answer", delta: "已核对 28 条记录。" }),
    event(2, "assistant.snapshot", { phase: "answer", delta: "已核对 28 条记录。负责人是 Alice。" }),
    event(3, "run.succeeded", { delta: "已核对 28 条记录。负责人是 Alice。" }),
  ]);
  expect(snapshot.commentary).toEqual(["已核对 28 条记录。"]);
  const card = JSON.stringify(buildLiveReplyCard(snapshot));
  expect(card).toContain("已核对 28 条记录。");
  expect(card).not.toContain("负责人是 Alice。");
});
