import { expect, test } from "bun:test";
import type { ChatRun } from "@homeagent/core";
import { providerPreparationFailure, ProviderPreparationError } from "@homeagent/llm";
import { chatRunView } from "./views.ts";

const run: ChatRun = {
  id: "audit-run", space: "team/audit", input: "query", trigger: "message",
  priority: "interactive", status: "succeeded", delivery: { status: "sent", attempts: 1 },
  queuedAt: 100, startedAt: 100, finishedAt: 200,
};
test("Chat Run shows missing legacy evidence honestly and displays only redacted metadata", async () => {
  expect(String(await chatRunView(run))).toContain("未记录执行证据");
  const rendered = String(await chatRunView({ ...run, executionEvidence: {
    truncated: true,
    calls: [{ source: "codex-jsonl", truncated: false, events: [{
      kind: "command", status: "completed", exitCode: 0,
      lark: { operation: "chat-search", requestedIdentity: "user", reportedIdentity: "user", ok: true, count: 1, hasMore: false },
    }] }],
  } }));
  expect(rendered).toContain("执行证据");
  expect(rendered).toContain("chat-search");
  expect(rendered).toContain("显式身份：user");
  expect(rendered).toContain("CLI 报告身份：user");
  expect(rendered).toContain("已截断");
  expect(rendered).toContain("不证明业务任务已完成");
});

test("Chat Run explains preparation failure even without Provider output", async () => {
  const failure = providerPreparationFailure(new ProviderPreparationError({ stage: "native-session", reason: "protected-root-readable", exitCode: 75 }));
  const rendered = String(await chatRunView({ ...run, status: "failed", executionEvidence: {
    calls: [], truncated: false, preparationFailure: failure,
  } }));
  expect(rendered).toContain("受保护数据目录仍可读取");
  expect(rendered).toContain("退出码 75");
  expect(rendered).toContain("protected-root-readable");
});
