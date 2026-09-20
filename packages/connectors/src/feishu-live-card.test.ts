import { expect, test } from "bun:test";
import { buildLiveReplyCard, liveReplySnapshot } from "./feishu-live-card.ts";

const events = [
  { schemaVersion: 1 as const, runId: "chat_run_card", seq: 1, at: 100, kind: "run.queued" as const, visibility: "public" as const, title: "请求已进入队列" },
  { schemaVersion: 1 as const, runId: "chat_run_card", seq: 2, at: 110, kind: "tool.started" as const, visibility: "public" as const, title: "工具开始执行", tool: { type: "web-search" as const, status: "running" as const } },
  { schemaVersion: 1 as const, runId: "chat_run_card", seq: 3, at: 120, kind: "assistant.snapshot" as const, visibility: "public" as const, title: "正在生成回答", delta: "阶段性答案" },
];

test("builds a bounded Card 2.0 live snapshot", () => {
  const snapshot = liveReplySnapshot("chat_run_card", events, "http://127.0.0.1:3000/chats/runs/chat_run_card");
  expect(snapshot.state).toBe("queued");
  expect(snapshot.answerPreview).toBe("阶段性答案");
  expect(snapshot.commentary).toEqual(["阶段性答案"]);
  expect(snapshot.toolCallCount).toBe(1);
  expect(snapshot.steps).toHaveLength(2);
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

test("keeps the largest supported answer preview under the Feishu card limit", () => {
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
  expect(Buffer.byteLength(JSON.stringify(buildLiveReplyCard(snapshot)), "utf8")).toBeLessThan(30 * 1024);
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
  expect(snapshot.answerPreview).toBe("第一行\n第二行");
});
