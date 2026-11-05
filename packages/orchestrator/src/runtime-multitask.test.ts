import { expect, test, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeLlm, KnowledgeEngine, SkillCatalog, type LlmClient } from "@homeagent/core";
import { CliConnector, FeishuConnector, type Connector, type ProcHandle, type InboundMessage } from "@homeagent/connectors";
import { Orchestrator } from "./runtime.ts";

class MessageProcess implements ProcHandle {
  private output!: ReadableStreamDefaultController<Uint8Array>;
  private diagnostics!: ReadableStreamDefaultController<Uint8Array>;
  private finish!: (code: number) => void;
  stdout = new ReadableStream<Uint8Array>({ start: c => { this.output = c; } });
  stderr = new ReadableStream<Uint8Array>({ start: c => { this.diagnostics = c; } });
  exited = new Promise<number>(resolve => { this.finish = resolve; });
  ready(): void { this.diagnostics.enqueue(new TextEncoder().encode("[event] ready\n")); }
  message(id: string, content: string): void {
    this.output.enqueue(new TextEncoder().encode(JSON.stringify({ chat_id: "oc_dm", chat_type: "p2p",
      message_id: id, event_id: id, sender_id: "ou_me", content }) + "\n"));
  }
  kill(): void { this.finish(0); try { this.output.close(); this.diagnostics.close(); } catch {} }
}

test("the Feishu stream accepts another message while the preceding answer is still running", async () => {
  const dir = mkdtempSync(join(tmpdir(), "homeagent-multitask-"));
  const fake = new FakeLlm();
  fake.onJSON(() => ({ slugs: [], relevant: false }));
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const firstStarted = new Promise<void>(resolve => { started = resolve; });
  fake.onText(() => "研究完成");
  const llm: LlmClient = { completeJSON: options => fake.completeJSON(options),
    complete: async options => { started(); await blocked; return fake.complete(options); } };
  const engine = new KnowledgeEngine({ dataDir: dir, llm, skillCatalog: new SkillCatalog({ roots: [] }) });
  const processes: MessageProcess[] = [];
  const transport = new FeishuConnector({ spawner: { spawn: () => {
    const process = new MessageProcess(); processes.push(process); process.ready(); return process;
  } }, runCommand: async () => "{}" });
  const runtime = new Orchestrator({ engine, connector: transport, llm });
  try {
    await runtime.start();
    const messages = processes[0]!;
    messages.message("om_first", "请研究方案 A");
    await firstStarted;
    messages.message("om_second", "你好");
    for (let i = 0; i < 100 && !engine.chatRuns.list().some(run => run.messageId === "om_second"); i++) {
      await Bun.sleep(5);
    }
    expect(engine.chatRuns.list().some(run => run.messageId === "om_second")).toBe(true);
    expect(engine.chatRuns.list().find(run => run.messageId === "om_first")?.status).toBe("running");
  } finally {
    release();
    await runtime.stop();
    engine.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function message(id: string, text: string, parentMessageId?: string): InboundMessage {
  return { kind: "message", eventId: id, chatType: "p2p", chatId: "oc_dm", senderId: "ou_me",
    text, messageId: id, mentionsBot: true, createdAt: Date.now(), parentMessageId };
}

test("slow Feishu thinking reactions do not delay independent Runs or their delivery", async () => {
  const dir = mkdtempSync(join(tmpdir(), "homeagent-slow-reaction-"));
  const add = Promise.withResolvers<void>();
  const remove = Promise.withResolvers<void>();
  const fake = new FakeLlm();
  fake.onJSON(() => ({ slugs: [], relevant: false }));
  fake.onText(() => "离线事项完成");
  const engine = new KnowledgeEngine({ dataDir: dir, llm: fake, skillCatalog: new SkillCatalog({ roots: [] }) });
  const processes: MessageProcess[] = [];
  const adding: string[] = [];
  const removing: string[] = [];
  const transport = new FeishuConnector({ spawner: { spawn: () => {
    const process = new MessageProcess(); processes.push(process); process.ready(); return process;
  } }, runCommand: async cmd => {
    if (cmd.includes("reactions")) {
      const messageId = cmd[cmd.indexOf("--message-id") + 1]!;
      if (cmd.includes("create")) {
        adding.push(messageId);
        await add.promise;
        return JSON.stringify({ data: { reaction_id: `reaction_${messageId}` } });
      }
      removing.push(messageId);
      await remove.promise;
    }
    return "{}";
  } });
  const runtime = new Orchestrator({ engine, connector: transport, llm: fake });
  try {
    await runtime.start();
    processes[0]!.message("om_research", "调研技术方案");
    processes[0]!.message("om_report", "整理项目周报");
    await until(() => adding.length === 2);
    // Neither external reaction request has returned, but both user requests
    // must already execute and deliver through the real Feishu intake path.
    await until(() => engine.chatRuns.list().filter(run => run.delivery.status === "sent").length === 2);
    expect(engine.chatRuns.list().every(run => run.status === "succeeded")).toBe(true);
    expect(engine.workDispatch.list().every(input => input.state === "settled")).toBe(true);
    expect(removing).toEqual([]);
    add.resolve();
    await until(() => removing.length === 2);
    expect(removing.sort()).toEqual(["om_report", "om_research"]);
    expect(engine.workDispatch.list().every(input => input.state === "settled")).toBe(true);
  } finally {
    add.resolve(); remove.resolve();
    await runtime.stop();
    engine.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

async function until(check: () => boolean, attempts = 200): Promise<void> {
  for (let i = 0; i < attempts && !check(); i++) await Bun.sleep(5);
  expect(check()).toBe(true);
}

test.each([false, true])("restart reroutes a fresh post-cancellation request without reviving older or explicit follow-ups (write fault: %s)", async writeFault => {
  const dir = mkdtempSync(join(tmpdir(), "homeagent-stale-wait-"));
  const fake = new FakeLlm();
  fake.onJSON(() => ({ slugs: [], relevant: false }));
  fake.onText(() => "调研完成");
  let engine = new KnowledgeEngine({ dataDir: dir, llm: fake, skillCatalog: new SkillCatalog({ roots: [] }) });
  engine.ensureSpace("personal/ou_me");
  const old = engine.workItems.create({ space: "personal/ou_me", title: "调研技术方案" });
  const accept = (id: string, text: string, parent?: string) => engine.workDispatch.accept({ connector: "cli",
    space: "personal/ou_me", message: message(id, text, parent) });
  const before = accept("before-cancel", "调研技术方案");
  engine.workDispatch.update(before.id, before.revision, { operation: "followup", workItemId: old.id, state: "waiting" });
  const cancel = accept("cancel", "取消调研");
  engine.workDispatch.update(cancel.id, cancel.revision, { operation: "cancel", workItemId: old.id, state: "settled" });
  engine.workItems.update(old.id, { active: false });
  const fresh = accept("after-cancel", "调研技术方案");
  engine.workDispatch.update(fresh.id, fresh.revision, { operation: "followup", workItemId: old.id, state: "waiting", receipt: { status: "sent", text: "旧版等待回执" } });
  const explicit = accept("explicit-reply", "调研技术方案", "before-cancel");
  engine.workDispatch.update(explicit.id, explicit.revision, { operation: "followup", workItemId: old.id, state: "waiting" });
  engine.close();
  engine = new KnowledgeEngine({ dataDir: dir, llm: fake, skillCatalog: new SkillCatalog({ roots: [] }) });
  const connector = new CliConnector();
  const runtime = new Orchestrator({ engine, connector, llm: fake });
  try {
    await runtime.start();
    if (writeFault) {
      const fault = spyOn(engine.workDispatch, "update").mockImplementationOnce(() => { throw new Error("injected repair write failure"); });
      try { runtime.flushWorkInputs(); }
      finally { fault.mockRestore(); }
      expect(engine.workDispatch.get(fresh.id)?.state).toBe("waiting");
      expect(engine.chatRuns.list()).toHaveLength(0);
    }
    runtime.flushWorkInputs();
    await until(() => engine.workDispatch.get(fresh.id)?.state === "settled");
    const run = engine.chatRuns.list()[0]!;
    expect(run.messageId).toBe("after-cancel");
    expect(run.workItemId).not.toBe(old.id);
    expect(run.status).toBe("succeeded");
    expect(run.delivery.status).toBe("sent");
    expect(engine.workItems.get(old.id)?.active).toBe(false);
    expect(engine.workDispatch.get(before.id)?.state).toBe("waiting");
    expect(engine.workDispatch.get(explicit.id)?.state).toBe("waiting");
    runtime.flushWorkInputs();
    expect(engine.chatRuns.list()).toHaveLength(1);
  } finally { await runtime.stop(); engine.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("cancellation settles before a late thinking reaction and shutdown drains its cleanup", async () => {
  const dir = mkdtempSync(join(tmpdir(), "homeagent-cancel-reaction-"));
  const add = Promise.withResolvers<string>();
  const remove = Promise.withResolvers<void>();
  const fake = new FakeLlm();
  fake.onJSON(() => ({ slugs: [], relevant: false }));
  const llm: LlmClient = { completeJSON: options => fake.completeJSON(options),
    complete: async () => new Promise(() => {}) };
  const engine = new KnowledgeEngine({ dataDir: dir, llm, skillCatalog: new SkillCatalog({ roots: [] }) });
  const transport = new CliConnector();
  const removed: Array<[string, string]> = [];
  const connector: Connector = { name: "feishu", start: handler => transport.start(handler), stop: () => transport.stop(),
    reply: reply => transport.reply(reply), notice: (chatId, text, options) => transport.notice(chatId, text, options),
    addReaction: () => add.promise,
    removeReaction: async (messageId, reactionId) => { removed.push([messageId, reactionId]); await remove.promise; } };
  const runtime = new Orchestrator({ engine, connector, llm });
  try {
    await runtime.start();
    const pending = transport.inject(message("cancel-reaction", "调研技术方案"));
    await until(() => engine.chatRuns.list().some(run => run.status === "running"));
    const run = engine.chatRuns.list()[0]!;
    expect(runtime.cancelChatRun(run.id)).toBe(true);
    await pending;
    expect(engine.chatRuns.get(run.id)?.status).toBe("cancelled");
    expect(engine.chatRuns.get(run.id)?.delivery.status).toBe("sent");
    expect(engine.workDispatch.list()[0]?.state).toBe("settled");
    let stopped = false;
    const stopping = runtime.stop().then(() => { stopped = true; });
    add.resolve("thinking_cancelled");
    await until(() => removed.length === 1);
    expect(stopped).toBe(false);
    expect(removed).toEqual([["cancel-reaction", "thinking_cancelled"]]);
    remove.resolve();
    await stopping;
    expect(stopped).toBe(true);
  } finally {
    add.resolve("thinking_cancelled"); remove.resolve();
    await runtime.stop();
    engine.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("waiting input drains while an interactive transport is still inside start", async () => {
  const dir = mkdtempSync(join(tmpdir(), "homeagent-interactive-loop-"));
  const fake = new FakeLlm();
  fake.onJSON(() => ({ slugs: [], relevant: false }));
  fake.onText(() => "已完成");
  const engine = new KnowledgeEngine({ dataDir: dir, llm: fake, skillCatalog: new SkillCatalog({ roots: [] }) });
  engine.ensureSpace("personal/ou_me");
  const item = engine.workItems.create({ space: "personal/ou_me", title: "周报" });
  const input = engine.workDispatch.accept({ connector: "cli", space: "personal/ou_me", message: message("waiting", "补充周报") });
  engine.workDispatch.update(input.id, input.revision, { state: "waiting", operation: "followup", workItemId: item.id });
  let finishStart!: () => void;
  const interactive = new Promise<void>(resolve => { finishStart = resolve; });
  const cli = new CliConnector();
  const runtime = new Orchestrator({ engine, llm: fake, connector: { name: "cli",
    start: async handler => { await cli.start(handler); await interactive; }, stop: async () => { finishStart(); await cli.stop(); },
    reply: out => cli.reply(out), notice: (id, text) => cli.notice(id, text),
  } });
  const starting = runtime.start();
  try {
    await until(() => engine.workDispatch.get(input.id)?.state === "settled", 600);
    expect(engine.chatRuns.list()[0]?.status).toBe("succeeded");
  } finally { finishStart(); await starting; await runtime.stop(); engine.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("shutdown retains the queued static response and restart does not substitute a model call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "homeagent-stop-"));
  const fake = new FakeLlm();
  fake.onJSON(() => ({ slugs: [], relevant: false }));
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  fake.onText(() => "已完成");
  const llm: LlmClient = { completeJSON: options => fake.completeJSON(options),
    complete: async options => { await blocked; return fake.complete(options); } };
  let engine = new KnowledgeEngine({ dataDir: dir, llm, runConcurrency: { global: 1 }, skillCatalog: new SkillCatalog({ roots: [] }) });
  let connector = new CliConnector();
  let runtime = new Orchestrator({ engine, connector, llm });
  const pending: Promise<void>[] = [];
  try {
    await runtime.start();
    pending.push(connector.inject(message("running", "研究一个方案")));
    await until(() => engine.chatRuns.list().some(run => run.status === "running"));
    pending.push(connector.inject(message("queued", "你好")));
    // Attach rejection handlers before stopping deferred work.
    const completions = Promise.allSettled(pending);
    await until(() => engine.chatRuns.list().some(run => run.messageId === "queued" && run.status === "queued"));
    const queued = engine.chatRuns.list().find(run => run.messageId === "queued")!;
    await runtime.stop();
    await completions;
    expect(engine.chatRuns.get(queued.id)?.status).toBe("queued");
    expect(engine.chatRuns.list().find(run => run.messageId === "running")?.status).toBe("failed");
    engine.close();
    engine = new KnowledgeEngine({ dataDir: dir, llm: fake, recoverInterruptedChatRuns: true, skillCatalog: new SkillCatalog({ roots: [] }) });
    engine.askWithExecutionPlan = async () => { throw new Error("A frozen greeting must not invoke a Provider"); };
    connector = new CliConnector();
    runtime = new Orchestrator({ engine, connector, llm: fake });
    await runtime.start();
    await until(() => engine.chatRuns.get(queued.id)?.delivery.status === "sent");
    expect(engine.chatRuns.get(queued.id)?.status).toBe("succeeded");
    expect(connector.sent).toHaveLength(1);
  } finally { release(); await runtime.stop(); await Promise.allSettled(pending); engine.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("a message retracted while queued never launches its frozen Provider call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "homeagent-queued-retraction-"));
  const fake = new FakeLlm();
  fake.onJSON(() => ({ slugs: [], relevant: false }));
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  fake.onText(() => "已完成");
  const llm: LlmClient = { completeJSON: options => fake.completeJSON(options),
    complete: async options => { calls++; await blocked; return fake.complete(options); } };
  const engine = new KnowledgeEngine({ dataDir: dir, llm, runConcurrency: { global: 1 }, skillCatalog: new SkillCatalog({ roots: [] }) });
  const connector = new CliConnector();
  const runtime = new Orchestrator({ engine, connector, llm });
  const pending: Promise<void>[] = [];
  try {
    await runtime.start();
    pending.push(connector.inject(message("first", "研究方案 A")));
    await until(() => calls === 1);
    pending.push(connector.inject(message("retracted", "整理另一个项目")));
    await until(() => engine.chatRuns.list().some(run => run.messageId === "retracted" && run.status === "queued"));
    await engine.retractMessage("personal/ou_me", { chatId: "oc_dm", messageId: "retracted", requestedBy: "ou_me" });
    release();
    await Promise.all(pending);
    expect(calls).toBe(1);
    expect(engine.chatRuns.list().find(run => run.messageId === "retracted")).toBeUndefined();
    expect(engine.workDispatch.list().some(input => input.message.messageId === "retracted")).toBe(false);
    await connector.inject(message("retracted", "整理另一个项目"));
    expect(calls).toBe(1);
    expect(engine.workDispatch.list().some(input => input.message.messageId === "retracted")).toBe(false);
  } finally { release(); await Promise.allSettled(pending); await runtime.stop(); engine.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("replying to a real final receipt routes to its item after the default focus changes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "homeagent-receipt-route-"));
  const fake = new FakeLlm();
  fake.onJSON(() => ({ slugs: [], relevant: false }));
  fake.onText(() => "已完成");
  const engine = new KnowledgeEngine({ dataDir: dir, llm: fake, skillCatalog: new SkillCatalog({ roots: [] }) });
  const cli = new CliConnector();
  const runtime = new Orchestrator({ engine, llm: fake, connector: {
    name: "cli", start: handler => cli.start(handler), stop: () => cli.stop(), notice: (id, text) => cli.notice(id, text),
    reply: async out => { await cli.reply(out); return { messageId: `sent_${out.replyToMessageId}` }; },
  } });
  try {
    await runtime.start();
    await cli.inject(message("research", "研究技术方案"));
    const research = engine.chatRuns.list().find(run => run.messageId === "research")!;
    expect(research.delivery.messageId).toBe("sent_research");
    await cli.inject(message("report", "整理项目周报"));
    expect(engine.workItems.currentForSpace("personal/ou_me")?.id).not.toBe(research.workItemId);
    await cli.inject(message("supplement", "加上国内方案", research.delivery.messageId));
    expect(engine.chatRuns.list().find(run => run.messageId === "supplement")?.workItemId).toBe(research.workItemId);
  } finally { await runtime.stop(); engine.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("two independent items run together, status and cancellation bypass them, supplements wait for the next boundary", async () => {
  const dir = mkdtempSync(join(tmpdir(), "homeagent-multitask-"));
  const fake = new FakeLlm();
  fake.onJSON(() => ({ slugs: [], relevant: false }));
  fake.onText(() => "研究完成");
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const llm: LlmClient = { completeJSON: options => fake.completeJSON(options),
    complete: async options => { calls++; await blocked; return fake.complete(options); } };
  const engine = new KnowledgeEngine({ dataDir: dir, llm, skillCatalog: new SkillCatalog({ roots: [] }) });
  const connector = new CliConnector();
  const runtime = new Orchestrator({ engine, connector, llm });
  let first: Promise<void> | undefined;
  let second: Promise<void> | undefined;
  try {
    await runtime.start();
    first = connector.inject(message("research", "调研技术方案"));
    second = connector.inject(message("report", "整理项目周报"));
    await until(() => calls === 2);
    expect(engine.workItems.list().filter(item => item.active)).toHaveLength(2);
    const report = engine.chatRuns.list().find(run => run.messageId === "report")!;
    const frozen = structuredClone(report.executionPlan);
    await connector.inject(message("status", "现在做到哪了"));
    expect(connector.sent.at(-1)?.markdown).toContain("执行中");
    expect(calls).toBe(2);
    await connector.inject(message("supplement", "周报按项目分组", "report"));
    expect(engine.workDispatch.list().find(input => input.message.messageId === "supplement")?.state).toBe("waiting");
    expect(engine.chatRuns.get(report.id)?.input).toBe("整理项目周报");
    expect(engine.chatRuns.get(report.id)?.executionPlan).toEqual(frozen);
    await connector.inject(message("pause", "暂停周报"));
    await connector.inject(message("cancel", "取消调研"));
    await first;
    expect(engine.chatRuns.list().find(run => run.messageId === "research")?.status).toBe("cancelled");
    expect(engine.chatRuns.get(report.id)?.status).toBe("running");
    release();
    await second;
    runtime.flushWorkInputs();
    expect(calls).toBe(2);
    await connector.inject(message("resume", "继续周报"));
    await until(() => engine.chatRuns.list().some(run => run.messageId === "supplement" && run.status === "succeeded"));
    expect(calls).toBe(3);
    expect(engine.chatRuns.list().find(run => run.messageId === "supplement")?.workItemId).toBe(report.workItemId);
    expect(engine.chatRuns.list().find(run => run.messageId === "research")?.status).toBe("cancelled");
  } finally {
    release();
    await Promise.allSettled([first, second]);
    await runtime.stop(); engine.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test("durable inputs survive restart, while interrupted preparation is not replayed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "homeagent-multitask-"));
  const fake = new FakeLlm();
  let engine = new KnowledgeEngine({ dataDir: dir, llm: fake, skillCatalog: new SkillCatalog({ roots: [] }) });
  const saved = engine.workDispatch.accept({ connector: "cli", space: "personal/ou_me", message: message("saved", "你好") });
  const interrupted = engine.workDispatch.accept({ connector: "cli", space: "personal/ou_me", message: message("interrupted", "请研究方案") });
  engine.workDispatch.update(interrupted.id, interrupted.revision, { state: "preparing" });
  engine.close();
  engine = new KnowledgeEngine({ dataDir: dir, llm: fake, skillCatalog: new SkillCatalog({ roots: [] }) });
  const runtime = new Orchestrator({ engine, connector: new CliConnector(), llm: fake });
  try {
    await runtime.start();
    await until(() => engine.workDispatch.get(saved.id)?.state === "settled");
    expect(engine.chatRuns.list()).toHaveLength(1);
    expect(engine.chatRuns.list()[0]?.messageId).toBe("saved");
    expect(engine.workDispatch.get(interrupted.id)?.state).toBe("interrupted");
  } finally { await runtime.stop(); engine.close(); rmSync(dir, { recursive: true, force: true }); }
});

test.each(["run", "association", "admission"] as const)("restart completes a partial %s commit using the frozen plan exactly once", async cut => {
  const dir = mkdtempSync(join(tmpdir(), "homeagent-admission-"));
  const fake = new FakeLlm();
  let engine = new KnowledgeEngine({ dataDir: dir, llm: fake, skillCatalog: new SkillCatalog({ roots: [] }) });
  let runtime = new Orchestrator({ engine, connector: new CliConnector(), llm: fake });
  const fault = cut === "run" ? spyOn(engine.chatRuns, "start") : cut === "association"
    ? spyOn(engine.workItems, "attachChatRun") : spyOn(engine.chatRuns, "admit");
  fault.mockImplementationOnce(() => { throw new Error("injected commit failure"); });
  try {
    const text = "请研究" + "长资料".repeat(35_000);
    await expect(runtime.enqueue(message("durable", text))).rejects.toThrow("injected commit failure");
    const input = engine.workDispatch.list()[0]!;
    expect(input.plan).toBeDefined();
    expect(engine.chatRuns.list().every(run => run.status === "queued" && run.launchAdmission === "pending")).toBe(true);
    fault.mockRestore();
    await runtime.stop(); engine.close();
    engine = new KnowledgeEngine({ dataDir: dir, llm: fake, skillCatalog: new SkillCatalog({ roots: [] }), recoverInterruptedChatRuns: true });
    let calls = 0;
    engine.agentRunExecutionSnapshot = () => { throw new Error("Must use frozen plan"); };
    engine.askWithExecutionPlan = async (_spaces, question, plan) => {
      calls++;
      expect(question).toBe(text);
      expect(plan).toEqual(input.plan!.executionPlan!);
      return { answer: "已完成", source: "general", citations: [] };
    };
    runtime = new Orchestrator({ engine, connector: new CliConnector(), llm: fake });
    await runtime.start();
    await until(() => engine.workDispatch.get(input.id)?.state === "settled");
    expect(calls).toBe(1);
    expect(engine.chatRuns.list()).toHaveLength(1);
    expect(engine.chatRuns.list()[0]?.status).toBe("succeeded");
    await runtime.enqueue(message("durable", "changed duplicate"));
    expect(calls).toBe(1);
  } finally { fault.mockRestore(); await runtime.stop(); engine.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("a slow source cannot reorder topic turns; another topic proceeds and the next turn forks only after delivery", async () => {
  const dir = mkdtempSync(join(tmpdir(), "homeagent-topic-order-"));
  const fake = new FakeLlm();
  const engine = new KnowledgeEngine({ dataDir: dir, llm: fake, skillCatalog: new SkillCatalog({ roots: [] }) });
  engine.ensureSpace("team/oc_group");
  const agent = engine.agents.create({ name: "主题助手", provider: "codex", permission: "read-only", visibility: "Team" });
  engine.updateSpaceMeta("team/oc_group", { agentId: agent.id });
  engine.feishuBindings.connect({ chatId: "oc_group", spaceId: "team/oc_group", responseMode: "mentions_only", replyInThread: true });
  const cli = new CliConnector();
  let releaseSource!: () => void;
  const source = new Promise<void>(resolve => { releaseSource = resolve; });
  let releaseDelivery!: () => void;
  const delivery = new Promise<void>(resolve => { releaseDelivery = resolve; });
  const calls: { question: string; native: unknown; spaces: unknown }[] = [];
  const rootSession = "11111111-2222-4333-8444-555555555555";
  const supplementSession = "22222222-2222-4333-8444-555555555555";
  engine.askWithExecutionPlan = async (spaces, question, _plan, _skills, opts) => {
    calls.push({ question, native: opts?.nativeSession, spaces });
    return { answer: "已完成", source: "general", citations: [], nativeSessionId: question.includes("方案")
      ? rootSession : question.includes("补充") ? supplementSession : question.includes("周报")
        ? "33333333-2222-4333-8444-555555555555" : "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" };
  };
  const runtime = new Orchestrator({ engine, llm: fake, connector: { name: "feishu", start: handler => cli.start(handler),
    stop: () => cli.stop(), notice: (id, text) => cli.notice(id, text), reply: async out => {
      if (out.replyToMessageId === "slow" && out.idempotencyKey?.endsWith(":final")) await delivery;
      await cli.reply(out);
    } }, docFetcher: async () => { await source; return "# 已完整读取的资料"; } });
  const group = (id: string, text: string, root?: string): InboundMessage => ({ ...message(id, text), chatType: "group", chatId: "oc_group", rootMessageId: root });
  let pending: Promise<void>[] = [];
  try {
    await runtime.start();
    pending.push(cli.inject({ ...group("slow", "调研技术方案"), docLinks: ["https://example.com/document"] }));
    pending.push(cli.inject(group("supplement", "补充国内例子", "slow")));
    pending.push(cli.inject(group("next", "再整理周报", "slow")));
    pending.push(cli.inject(group("independent", "设计其他事项")));
    await until(() => calls.length === 1);
    expect(calls[0]?.question).toContain("其他事项");
    releaseSource();
    await until(() => calls.length === 2);
    expect(calls[1]?.native).toEqual({ mode: "start" });
    expect(engine.chatRuns.list().some(run => run.messageId === "next")).toBe(false);
    releaseDelivery();
    await Promise.all(pending);
    await cli.inject({ ...group("denied", "取消调研", "slow"), senderId: "ou_other" });
    expect(cli.sent.at(-1)?.markdown).toContain("请由事项发起人或群管理员操作");
    runtime.flushWorkInputs();
    await until(() => calls.length >= 3);
    await until(() => engine.workDispatch.list().find(input => input.message.messageId === "supplement")?.state === "settled");
    runtime.flushWorkInputs();
    await until(() => calls.length === 4);
    await until(() => engine.workDispatch.list().find(input => input.message.messageId === "next")?.state === "settled");
    expect(engine.chatRuns.list().find(run => run.messageId === "next")?.status).toBe("succeeded");
    expect(calls[2]?.question).toContain("补充国内例子");
    expect(calls[3]?.question).toContain("再整理周报");
    expect(calls[2]?.native).toEqual({ mode: "fork", id: rootSession });
    expect(calls[3]?.native).toEqual({ mode: "fork", id: supplementSession });
    expect(calls.every(call => JSON.stringify(call.spaces) === JSON.stringify(["team/oc_group"]))).toBe(true);
  } finally { releaseSource(); releaseDelivery(); await Promise.allSettled(pending); await runtime.stop(); engine.close(); rmSync(dir, { recursive: true, force: true }); }
});
