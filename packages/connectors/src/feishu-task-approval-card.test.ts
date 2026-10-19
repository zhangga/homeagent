import { expect, test } from "bun:test";
import { buildTaskApprovalCard, type TaskApprovalCardSnapshot } from "./feishu-task-approval-card.ts";

const pending: TaskApprovalCardSnapshot = { runId: "run_approval", taskName: "每周总结工作进度", topic: "总结本周工作",
  requestedAt: Date.parse("2026-10-19T01:00:00Z"), expiresAt: Date.parse("2026-10-20T01:00:00Z"),
  state: "pending", permission: "full", provider: "codex", model: "gpt-6.1-sol", reasoningEffort: "xhigh",
  workdir: "C:\\work\\weekly", timeoutMs: 360 * 60_000, personal: false };

test("approval card presents the frozen request and two callback buttons", () => {
  const card = buildTaskApprovalCard(pending);
  const body = JSON.stringify(card);
  expect(card.schema).toBe("2.0");
  expect(body).toContain("每周总结工作进度");
  expect(body).toContain("full");
  expect(body).toContain("xhigh");
  expect(body).toContain("09:00:00");
  expect(body).toContain("北京时间");
  expect(body).toContain("群主或群管理员");
  expect(body).toContain('"content":"通过审批"');
  expect(body).toContain('"content":"拒绝"');
  expect(body).toContain('"behaviors":[{"type":"callback"');
  for (const decision of ["approve", "reject"]) expect(body).toContain(JSON.stringify({
    action: "homeagent.task-approval", runId: pending.runId, requestedAt: pending.requestedAt, decision,
  }));
  expect(body).not.toContain('"confirm"');
  expect(body).not.toContain("localhost");
});

test.each(["approved", "rejected", "expired", "unavailable"] as const)("terminal approval cards remove all actionable buttons: %s", state => {
  const body = JSON.stringify(buildTaskApprovalCard({ ...pending, state, decisionBy: "feishu:ou_owner" }));
  expect(body).not.toContain('"tag":"button"');
  expect(body).not.toContain('"type":"callback"');
  expect(body).toContain("feishu:ou&#95;owner");
});

test("bounds dynamic text within Feishu's card budget and escapes untrusted markup", () => {
  const card = buildTaskApprovalCard({ ...pending, taskName: "<at id=all></at>".repeat(100),
    topic: "中".repeat(100_000), workdir: "<&`*_".repeat(1000), model: "模型".repeat(500) });
  const body = JSON.stringify(card);
  expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(30 * 1024);
  expect(JSON.stringify(card.body)).not.toContain("<at id=all>");
  expect(body).toContain("主题预览");
});
