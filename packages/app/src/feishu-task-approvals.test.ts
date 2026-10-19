import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeEngine, SkillCatalog, type TaskRun } from "@homeagent/core";
import type { CardActionEvent, Connector, NoticeOptions, OutboundReply } from "@homeagent/connectors";
import { FeishuTaskApprovals } from "./feishu-task-approvals.ts";

class FakeCards implements Connector {
  readonly name = "fake-cards";
  cards: { chatId: string; body: string; key?: string }[] = [];
  updates: { messageId: string; body: string }[] = [];
  replies: OutboundReply[] = [];
  notices: string[] = [];
  administrator = true;
  failUpdate = false;
  failSend = false;
  checkRole?: () => void;
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async reply(reply: OutboundReply): Promise<void> { this.replies.push(reply); }
  async notice(_chatId: string, body: string): Promise<void> { this.notices.push(body); }
  async noticeCard(chatId: string, card: Record<string, unknown>, opts?: NoticeOptions): Promise<void> {
    this.cards.push({ chatId, body: JSON.stringify(card), key: opts?.idempotencyKey });
    if (this.failSend) throw new Error("simulated delivery failure after acceptance");
  }
  async updateCard(messageId: string, card: Record<string, unknown>): Promise<void> {
    this.updates.push({ messageId, body: JSON.stringify(card) });
    if (this.failUpdate) throw new Error("simulated card update failure");
  }
  async isChatAdministrator(): Promise<boolean> { this.checkRole?.(); return this.administrator; }
}

let root: string;
let engine: KnowledgeEngine;
let connector: FakeCards;
let service: FeishuTaskApprovals;
let providerCalls: number;
let completionNotices: number;
let active: boolean;
let now: number;

function openEngine(): KnowledgeEngine {
  return new KnowledgeEngine({ dataDir: join(root, "data"), skillCatalog: new SkillCatalog({ roots: [] }),
    runProvider: async () => {
      providerCalls++;
      expect(engine.listTaskRuns()[0]?.approval).toEqual(expect.objectContaining({ status: "approved", decidedBy: "feishu:ou_owner" }));
      return "研究已完成。";
    } });
}
function openService(transport: Connector = connector): FeishuTaskApprovals {
  return new FeishuTaskApprovals({ engine, connector: transport, now: () => now,
    assertDeliveryAllowed: () => { if (!active) throw new Error("inactive binding"); },
    notifyCompleted: async () => { completionNotices++; } });
}
async function pending(permission: "write" | "full" = "write"): Promise<TaskRun> {
  const agent = engine.agents.create({ name: "高权限周报", provider: "claude", model: "sonnet", permission,
    workdir: join(root, "workdir"), visibility: "Team" });
  engine.registry.updateMeta("team/oc_team", { agentId: agent.id });
  const task = engine.tasks.create({ name: "每周总结工作进度", space: "team/oc_team", topic: "整理本周工作",
    notify: true, distillOnRun: false })!;
  const started = engine.startTaskRun(task.id, { distill: false });
  await started.completion;
  expect(started.run.status).toBe("awaiting_approval");
  return started.run;
}
async function notify(run: TaskRun, attemptedAt?: number): Promise<void> {
  await engine.deliverTaskRunApprovalNotification(run.id, (current, key) => service.notify(current, key), { attemptedAt });
}
function click(run: TaskRun, decision: "approve" | "reject" = "approve", eventId = "evt_approval_1"): CardActionEvent {
  return { kind: "card_action", eventId, chatId: "oc_team", messageId: "om_approval", operatorId: "ou_owner",
    actionTag: "button", actionValue: { action: "homeagent.task-approval", runId: run.id,
      requestedAt: run.approval!.requestedAt, decision }, createdAt: now };
}
async function waitForCompletion(): Promise<void> {
  for (let i = 0; i < 400 && completionNotices === 0; i++) await Bun.sleep(5);
  expect(completionNotices).toBe(1);
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ha-card-task-approval-")));
  mkdirSync(join(root, "workdir"));
  providerCalls = 0; completionNotices = 0; active = true; now = Date.now();
  engine = openEngine();
  engine.ensureSpace("team/oc_team", { chatId: "oc_team" });
  connector = new FakeCards();
  service = openService();
});
afterEach(() => { engine.close(); rmSync(root, { recursive: true, force: true }); });

test("approval notification uses the original stable delivery key and the exact frozen Run", async () => {
  const run = await pending();
  await notify(run);
  expect(providerCalls).toBe(0);
  expect(connector.cards).toHaveLength(1);
  expect(connector.cards[0]).toEqual(expect.objectContaining({ chatId: "oc_team", key: `ha-appr-${run.id}` }));
  expect(connector.cards[0]?.body).toContain(run.id);
  expect(connector.cards[0]?.body).toContain('"decision":"approve"');
  expect(connector.cards[0]?.body).toContain('"decision":"reject"');
  expect(engine.getTaskRun(run.id)?.approvalNotification?.status).toBe("sent");
});

test.each(["write", "full"] as const)("positive approval is durable before execution and repeated clicks do not rerun %s", async permission => {
  const run = await pending(permission);
  await notify(run);
  await Promise.all([service.handle(click(run)), service.handle(click(run, "approve", "evt_duplicate"))]);
  await waitForCompletion();
  expect(providerCalls).toBe(1);
  expect(engine.getTaskRun(run.id)?.status).toBe("succeeded");
  for (const update of connector.updates) {
    expect(update.body).toContain("审批已通过");
    expect(update.body).not.toContain('"tag":"button"');
  }
});

test("rejection persists across restart and a stale approval click never executes the task", async () => {
  const run = await pending(); await notify(run);
  await service.handle(click(run, "reject"));
  expect(engine.getTaskRun(run.id)?.approval).toEqual(expect.objectContaining({ status: "rejected", decidedBy: "feishu:ou_owner" }));
  engine.close(); engine = openEngine(); service = openService();
  await service.handle(click(run));
  expect(providerCalls).toBe(0);
  expect(connector.updates.at(-1)?.body).toContain("审批已拒绝");
});

test("a pending card remains actionable after restart and an approved card cannot execute again after reopening", async () => {
  const run = await pending(); await notify(run);
  engine.close(); engine = openEngine(); service = openService();
  expect(engine.getTaskRun(run.id)?.approval?.status).toBe("pending");
  await service.handle(click(run));
  await waitForCompletion();
  engine.close(); engine = openEngine(); service = openService();
  await service.handle(click(run, "approve", "evt_after_restart"));
  expect(providerCalls).toBe(1);
  expect(engine.getTaskRun(run.id)?.status).toBe("succeeded");
  expect(connector.updates.at(-1)?.body).toContain("审批已通过");
});

test("an expired notification becomes a non-actionable expired card", async () => {
  const run = await pending(); await notify(run);
  now = run.approval!.expiresAt!;
  await service.handle(click(run));
  expect(engine.getTaskRun(run.id)?.approval?.status).toBe("expired");
  expect(providerCalls).toBe(0);
  expect(connector.updates.at(-1)?.body).toContain("审批已过期");
  expect(connector.updates.at(-1)?.body).not.toContain('"tag":"button"');
});

test("ordinary members and callbacks from other chats or requests cannot approve the Run", async () => {
  const run = await pending(); await notify(run);
  connector.administrator = false;
  await service.handle(click(run));
  expect(connector.replies[0]?.markdown).toContain("只有群主或群管理员");
  connector.administrator = true;
  await service.handle({ ...click(run), chatId: "oc_other" });
  await service.handle({ ...click(run), actionValue: { ...click(run).actionValue, requestedAt: 0 } });
  expect(engine.getTaskRun(run.id)?.approval?.status).toBe("pending");
  expect(providerCalls).toBe(0);
  expect(connector.updates).toHaveLength(0);
});

test("a binding revoked during the role lookup prevents approval", async () => {
  const run = await pending(); await notify(run);
  connector.checkRole = () => { active = false; };
  await service.handle(click(run));
  expect(providerCalls).toBe(0);
  expect(engine.getTaskRun(run.id)?.approval?.status).toBe("pending");
});

test("personal approval belongs to the space owner and needs no group administrator lookup", async () => {
  engine.ensureSpace("personal/ou_owner", { chatId: "oc_personal" });
  const agent = engine.agents.create({ name: "个人周报", provider: "claude", model: "sonnet", permission: "write",
    workdir: join(root, "workdir"), visibility: "Personal" });
  engine.registry.updateMeta("personal/ou_owner", { agentId: agent.id });
  const task = engine.tasks.create({ name: "个人周报", space: "personal/ou_owner", topic: "总结工作",
    notify: true, distillOnRun: false })!;
  const started = engine.startTaskRun(task.id, { distill: false });
  await started.completion;
  const run = started.run;
  await notify(run);
  connector.administrator = false;
  const event = { ...click(run), chatId: "oc_personal" };
  await service.handle({ ...event, operatorId: "ou_other" });
  expect(providerCalls).toBe(0);
  expect(connector.replies[0]?.markdown).toContain("只有本人");
  await service.handle(event);
  await waitForCompletion();
  expect(providerCalls).toBe(1);
});

test("card update failure after approval reports the committed result without repeating execution", async () => {
  const run = await pending(); await notify(run);
  connector.failUpdate = true;
  await service.handle(click(run));
  await waitForCompletion();
  await service.handle(click(run, "approve", "evt_retry_update"));
  expect(providerCalls).toBe(1);
  expect(connector.replies.every(reply => reply.markdown.includes("审批已通过"))).toBe(true);
  expect(engine.getTaskRun(run.id)?.approval?.status).toBe("approved");
});

test("approval persistence failure keeps buttons pending and allows a later explicit click", async () => {
  const run = await pending(); await notify(run);
  const failure = spyOn(engine.taskRuns, "approve").mockImplementationOnce(() => { throw new Error("disk failure"); });
  try { await service.handle(click(run)); } finally { failure.mockRestore(); }
  expect(providerCalls).toBe(0);
  expect(connector.updates.at(-1)?.body).toContain("通过审批");
  expect(engine.getTaskRun(run.id)?.approval?.status).toBe("pending");
  await service.handle(click(run, "approve", "evt_retry_decision")); await waitForCompletion();
  expect(providerCalls).toBe(1);
});

test("a delivery failure after card acceptance reuses the same key on retry", async () => {
  const run = await pending();
  connector.failSend = true;
  await expect(notify(run)).rejects.toThrow("simulated delivery");
  connector.failSend = false;
  await notify(run, engine.getTaskRun(run.id)?.approvalNotification?.nextAttemptAt);
  expect(connector.cards).toHaveLength(2);
  expect(connector.cards[0]?.key).toBe(connector.cards[1]?.key);
  expect(engine.getTaskRun(run.id)?.approvalNotification).toEqual(expect.objectContaining({ status: "sent", attempts: 2 }));
});

test("a real callback can approve an accepted card whose send receipt was lost", async () => {
  const run = await pending();
  connector.failSend = true;
  await expect(notify(run)).rejects.toThrow("simulated delivery");
  expect(engine.getTaskRun(run.id)?.approvalNotification?.status).toBe("failed");
  connector.failSend = false;
  await service.handle(click(run));
  await waitForCompletion();
  expect(engine.getTaskRun(run.id)?.approval?.status).toBe("approved");
  expect(providerCalls).toBe(1);
});

test("transports without cards retain the existing text approval workflow", async () => {
  const run = await pending();
  const legacy: Connector = { name: "legacy", start: async () => {}, stop: async () => {}, reply: async () => {},
    notice: async (_chatId, message) => { connector.notices.push(message); } };
  service = openService(legacy);
  await notify(run);
  expect(connector.notices[0]).toContain("请前往 HomeAgent 管理后台");
  expect(engine.getTaskRun(run.id)?.approvalNotification?.status).toBe("sent");
});
