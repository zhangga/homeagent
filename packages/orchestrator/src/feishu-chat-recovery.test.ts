import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildLiveReplyCard, CliConnector, type CardActionEvent, type Connector, type InboundMessage, type LiveReplySnapshot } from "@homeagent/connectors";
import { FakeLlm, KnowledgeEngine, SkillCatalog } from "@homeagent/core";
import { resetConfig } from "@homeagent/shared";
import { Orchestrator } from "./runtime.ts";

const space = "team/oc_recovery";
const question = "怎样核对这次值班交接？";
let dir: string;
let engine: KnowledgeEngine;
let transport: CliConnector;
let connector: Connector;
let runtime: Orchestrator;
let cards: LiveReplySnapshot[];
let calls: { question: string; instruction: string }[];
let failAnswer: boolean;
let failSend: boolean;

function message(messageId: string, text: string, patch: Partial<InboundMessage> = {}): InboundMessage {
  return { kind: "message", eventId: messageId, messageId, chatId: "oc_recovery", senderId: "ou_owner", chatType: "group",
    rootMessageId: "om_root", mentionsBot: true, createdAt: Date.now(), text, ...patch };
}

function click(runId: string, messageId: string, operation: "retry" | "resend", attempts: number, eventId: string): CardActionEvent {
  return { kind: "card_action", actionTag: "button", chatId: "oc_recovery", operatorId: "ou_owner", eventId, messageId,
    createdAt: Date.now(), actionValue: { action: "homeagent.chat-recovery", operation, runId, attempts } };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "ha-chat-recovery-"));
  process.env.HOMEAGENT_DATA_DIR = dir;
  resetConfig();
  const fake = new FakeLlm();
  engine = new KnowledgeEngine({ dataDir: dir, llm: fake, skillCatalog: new SkillCatalog({ roots: [] }) });
  engine.ensureSpace(space, { chatId: "oc_recovery" });
  engine.feishuBindings.connect({ spaceId: space, chatId: "oc_recovery", boundAppId: "cli_test", responseMode: "mentions_only", replyInThread: true });
  const agent = engine.agents.create({ name: "原助手", visibility: "Team", provider: "claude", instruction: "按首次交接说明核对。" });
  engine.updateSpaceMeta(space, { agentId: agent.id });
  calls = []; cards = []; failAnswer = false; failSend = false;
  engine.askWithExecutionPlan = async (_spaces, question, plan) => {
    calls.push({ question, instruction: plan.instruction });
    if (failAnswer) throw new Error("model unavailable");
    return { answer: "交接结果已核对。", source: "general", citations: [] };
  };
  transport = new CliConnector();
  connector = {
    name: "feishu", start: handler => transport.start(handler), stop: () => transport.stop(),
    notice: (chat, text) => transport.notice(chat, text),
    reply: async out => {
      if (failSend && out.idempotencyKey?.endsWith(":final")) throw new Error("fake delivery failure");
      await transport.reply(out);
      return { messageId: `om_reply_${transport.sent.length}` };
    },
    createLiveReply: async (_out, snap) => ({ messageId: `om_card_${snap.runId}`, revision: snap.seq }),
    updateLiveReply: async (handle, snap) => { cards.push(snap); return { ...handle, revision: snap.seq }; },
    finalizeLiveReply: async (_handle, snap) => { cards.push(snap); },
  };
  runtime = new Orchestrator({ engine, connector, activeFeishuAppId: "cli_test", llm: fake });
  await runtime.start();
});

afterEach(async () => {
  await runtime?.stop(); engine.close();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.HOMEAGENT_DATA_DIR;
  resetConfig();
});

test("only the original asker in the original topic can retry; duplicate card and message use one frozen child", async () => {
  failAnswer = true;
  await transport.inject(message("om_question", question));
  const failed = engine.chatRuns.list(space)[0]!;
  expect(failed.status).toBe("failed");
  const cardId = failed.delivery.liveReply!.messageId;
  const callback = click(failed.id, cardId, "retry", failed.delivery.attempts, "event_click");
  expect(transport.sent.at(-1)?.markdown).toContain("重试这次");
  expect(cards.some(card => JSON.stringify(buildLiveReplyCard(card)).includes("homeagent.chat-recovery"))).toBe(true);
  failAnswer = false;
  const replacement = engine.agents.create({ name: "新助手", visibility: "Team", provider: "claude", instruction: "以后改用的新说明。" });
  engine.updateSpaceMeta(space, { agentId: replacement.id });
  await transport.inject({ ...callback, operatorId: "ou_other", eventId: "intruder" });
  await transport.inject({ ...callback, messageId: "om_forwarded", eventId: "forwarded" });
  await transport.inject(message("om_wrong_topic", "重试这次", { rootMessageId: "om_elsewhere", parentMessageId: cardId }));
  expect(calls).toHaveLength(1);
  const command = message("om_retry", "重试这次", { parentMessageId: failed.delivery.messageId, mentionsBot: false });
  await Promise.all([transport.inject(command), transport.inject(callback), transport.inject(command), runtime.retryChatRun(failed.id)]);
  expect(calls).toHaveLength(2);
  expect(calls[1]).toEqual(calls[0]!);
  const [child] = engine.chatRuns.list(space).filter(run => run.retryOf === failed.id);
  expect(child?.executionPlan).toEqual(failed.executionPlan);
  expect(child?.delivery.status).toBe("sent");
  expect(engine.registry.store(space).index().findRawsByMessageId("om_retry", "oc_recovery")).toEqual([]);
  await transport.inject(callback);
  expect(calls).toHaveLength(2);
});

test("reply and card resend the exact stored answer once, and decline an uncertain delivery", async () => {
  failSend = true;
  await expect(transport.inject(message("om_question", question))).rejects.toThrow("fake delivery failure");
  const failed = engine.chatRuns.list(space)[0]!;
  expect(failed.delivery.status).toBe("failed");
  expect(calls).toHaveLength(1);
  failSend = false;
  const cardId = failed.delivery.liveReply!.messageId;
  await transport.inject(message("om_wrong_action", "重试这次", { parentMessageId: cardId }));
  expect(transport.sent.at(-1)?.markdown).toContain("已保存");
  await Promise.all([
    transport.inject(click(failed.id, cardId, "resend", failed.delivery.attempts, "event_resend")),
    transport.inject(message("om_resend", "补发回答", { parentMessageId: cardId })),
  ]);
  expect(transport.sent.filter(out => out.idempotencyKey === `${failed.id}:final`).map(out => out.markdown)).toEqual([failed.output!]);
  expect(engine.chatRuns.get(failed.id)?.delivery.status).toBe("sent");
  expect(calls).toHaveLength(1);

  failSend = true;
  await expect(transport.inject(message("om_second", "如何处理第二次交接？"))).rejects.toThrow();
  const second = engine.chatRuns.list(space).find(run => run.messageId === "om_second")!;
  engine.chatRuns.startDeliveryAttempt(second.id, Date.now());
  failSend = false;
  await transport.inject(message("om_uncertain", "补发回答", { parentMessageId: second.messageId }));
  expect(transport.sent.at(-1)?.markdown).toContain("待确认");
  expect(engine.chatRuns.get(second.id)?.delivery.status).toBe("pending");
  expect(transport.sent.some(out => out.idempotencyKey === `${second.id}:final`)).toBe(false);
});

test("a later attempt can be retried from its own failure and a fresh topic command follows one conversation", async () => {
  failAnswer = true;
  await transport.inject(message("om_question", question));
  const first = engine.chatRuns.list(space)[0]!;
  await transport.inject(message("om_again", "重试这次", { parentMessageId: first.delivery.messageId, mentionsBot: false }));
  const second = engine.chatRuns.list(space).find(run => run.retryOf === first.id)!;
  expect(second.status).toBe("failed");
  await transport.inject(click(second.id, second.delivery.liveReply!.messageId, "retry", second.delivery.attempts, "click_second"));
  const third = engine.chatRuns.list(space).find(run => run.retryOf === second.id)!;
  expect(third.status).toBe("failed");
  await transport.inject(message("om_quoted_child", "重试这次", { parentMessageId: third.delivery.messageId }));
  const fourth = engine.chatRuns.list(space).find(run => run.retryOf === third.id)!;
  expect(fourth.status).toBe("failed");
  failAnswer = false;
  await transport.inject(message("om_topic_only", "重试这次", { mentionsBot: false }));
  expect(engine.chatRuns.list(space).find(run => run.retryOf === fourth.id)?.status).toBe("succeeded");
  expect(calls).toHaveLength(5);
}, 20_000);

test("an unmentioned recovery phrase in an unrelated group topic keeps ordinary passive behavior", async () => {
  const unrelated = { rootMessageId: "om_colleague_thread", senderId: "ou_colleague", mentionsBot: false };
  await transport.inject(message("om_no_runs", "重试这次", unrelated));
  expect(transport.sent).toHaveLength(0);
  expect(calls).toHaveLength(0);
  failAnswer = true;
  await transport.inject(message("om_question", question));
  const sent = transport.sent.length;
  await transport.inject(message("om_other_root", "补发回答", { ...unrelated, parentMessageId: "om_colleague_reply" }));
  expect(transport.sent).toHaveLength(sent);
  expect(calls).toHaveLength(1);
  const received = engine.workDispatch.list(space).filter(input => input.message.senderId === "ou_colleague");
  expect(received.map(input => input.operation)).toEqual(["chat", "chat"]);
});

test("reconnecting a group invalidates original recovery controls; Task callbacks stay separate", async () => {
  failAnswer = true;
  await transport.inject(message("om_question", question));
  const original = engine.chatRuns.list(space)[0]!;
  const card = click(original.id, original.delivery.liveReply!.messageId, "retry", original.delivery.attempts, "old_binding");
  engine.feishuBindings.disconnect(space);
  engine.feishuBindings.connect({ spaceId: space, chatId: "oc_recovery", boundAppId: "cli_test", responseMode: "mentions_only", replyInThread: true });
  await transport.inject(card);
  await transport.inject(message("om_old", "重试这次", { parentMessageId: original.delivery.messageId }));
  expect(calls).toHaveLength(1);
  expect(engine.chatRuns.list(space)).toHaveLength(1);
  await transport.inject({ ...card, eventId: "task_button", actionValue: { action: "homeagent.task-approval" } });
  expect(calls).toHaveLength(1);
});

test("a quoted work plan or unrelated Task receipt cannot retry an ordinary question in the same topic", async () => {
  failAnswer = true;
  await transport.inject(message("om_question", question));
  const ordinary = engine.chatRuns.list(space)[0]!;
  await expect(transport.inject(message("om_plan", "整理本周项目进展，找出阻塞项，生成周报"))).rejects.toThrow("FakeLlm");
  const work = engine.chatRuns.list(space).find(run => run.messageId === "om_plan")!;
  expect(engine.workDispatch.get(work.dispatchKey!)?.response?.kind).toBe("work-plan");
  for (const parentMessageId of [work.delivery.liveReply!.messageId, "om_task_receipt"]) {
    await transport.inject(message(`om_retry_${parentMessageId}`, "重试这次", { parentMessageId, mentionsBot: false }));
    expect(transport.sent.at(-1)?.markdown).toContain("原提问人");
  }
  expect(engine.chatRuns.list(space).some(run => run.retryOf === work.id || run.retryOf === ordinary.id)).toBe(false);
});

test("restart of a dispatched input does not send the answer again when the external outcome was not recorded", async () => {
  await runtime.stop();
  const original = message("om_interrupted", question);
  const intake = engine.workDispatch.accept({ connector: "feishu", appId: "cli_test", space, message: original,
    bindingId: engine.feishuBindings.activeByChatId(original.chatId)!.executionScopeEpoch });
  const plan = { dispatchKey: intake.id, launchAdmission: "pending" as const, space: intake.space,
    chatId: original.chatId, messageId: original.messageId, author: original.senderId, input: original.text,
    trigger: "message" as const, executionPlan: { version: 1 as const, instruction: "冻结的交接规则" } };
  const prepared = engine.workDispatch.update(intake.id, intake.revision, { state: "planned", plan,
    operation: "chat", response: { kind: "answer", question: original.text } });
  const run = engine.chatRuns.start(plan);
  engine.workDispatch.update(prepared.id, prepared.revision, { state: "dispatched", runId: run.id });
  engine.chatRuns.admit(run.id);
  engine.chatRuns.begin(run.id);
  engine.chatRuns.succeed(run.id, { finishedAt: Date.now(), output: "已生成的原回答。" });
  engine.chatRuns.startDeliveryAttempt(run.id, Date.now());
  engine.close();
  const fake = new FakeLlm();
  engine = new KnowledgeEngine({ dataDir: dir, llm: fake, skillCatalog: new SkillCatalog({ roots: [] }) });
  runtime = new Orchestrator({ engine, connector, activeFeishuAppId: "cli_test", llm: fake });
  await runtime.start();
  await transport.inject(original);
  expect(transport.sent).toHaveLength(0);
  expect(engine.workDispatch.get(intake.id)?.state).toBe("settled");
  expect(engine.chatRuns.get(run.id)?.delivery).toMatchObject({ status: "pending", attempts: 1 });
});
