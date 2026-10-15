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

test("keeps the model caption in the snapshot answer without repeating it in the process card", () => {
  const answer = "完成更新。";
  const output = `> 本次模型：Codex · \`gpt-5.6-sol\`（本次运行配置）\n\n${answer}`;
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
