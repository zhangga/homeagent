import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeLlm, KnowledgeEngine, SkillCatalog, type LlmClient } from "@homeagent/core";
import { CliConnector, type Connector, type InboundMessage } from "@homeagent/connectors";
import { Orchestrator } from "@homeagent/orchestrator";
import { WorkContinuationScheduler } from "./work-continuation-scheduler.ts";
import { chatWorkNotification } from "./chat-work-notification.ts";

test("a chat goal saves executable steps and continues through accepted WorkActions", async () => {
  const root = mkdtempSync(join(tmpdir(), "ha-chat-plan-"));
  const planner = new FakeLlm();
  planner.onJSON(() => ({ kind: "plan", steps: [
    { instruction: "收集本周项目进展", doneWhen: "列出进展及其来源" },
    { instruction: "找出项目阻塞项", doneWhen: "列出阻塞及待解决问题" },
    { instruction: "生成本周项目周报", doneWhen: "周报包含进展、阻塞和下一步" },
  ] }));
  let executions = 0;
  const engine = new KnowledgeEngine({ dataDir: root, skillCatalog: new SkillCatalog({ roots: [] }),
    runProvider: async () => { executions++; return JSON.stringify({ version: 1, outcome: "completed",
      result: `第 ${executions} 步已完成`, blockers: [], checks: [{ name: "本步完成标准", status: "passed" }] }); } });
  const transport = new CliConnector();
  const connector: Connector = { name: "feishu", start: h => transport.start(h), stop: () => transport.stop(),
    reply: reply => transport.reply(reply), notice: (chat, text, options) => transport.notice(chat, text, options) };
  const runtime = new Orchestrator({ engine, connector, llm: planner });
  const scheduler = new WorkContinuationScheduler(engine);
  const space = "team/oc_planning" as const;
  try {
    engine.ensureSpace(space, { chatId: "oc_planning" });
    engine.feishuBindings.connect({ spaceId: space, chatId: "oc_planning", boundAppId: "cli_fixture",
      responseMode: "mentions_only", replyInThread: true });
    await runtime.start();
    await transport.inject({ kind: "message", chatType: "group", chatId: "oc_planning", senderId: "ou_fixture",
      eventId: "plan", messageId: "plan", mentionsBot: true, createdAt: Date.now(),
      text: "整理本周项目进展，找出阻塞项，生成周报" });
    const item = engine.workItems.list(space)[0]!;
    expect(item.nextActions).toHaveLength(3);
    expect(item.nextActions[0]).toContain("列出进展及其来源");
    expect(item.runbook).toContain("生成本周项目周报");
    expect(engine.workContinuations.policyFor(item.id, space).autoContinue).toBe(true);
    expect(transport.sent.at(-1)?.markdown).toContain("工作计划");
    expect(transport.sent.at(-1)?.markdown).not.toContain("未调用");
    expect(executions).toBe(0);
    for (let step = 0; step < 3; step++) {
      expect(await scheduler.tick("chat-goal-test")).toEqual([item.id]);
      expect(executions).toBe(step + 1);
      expect(engine.workItems.get(item.id)?.nextActions).toHaveLength(2 - step);
    }
    expect(engine.workItems.get(item.id)?.phase).toBe("completed");
    expect(engine.workContinuations.list(item.id).every(action => action.status === "succeeded")).toBe(true);
  } finally { await runtime.stop(); engine.close(); rmSync(root, { recursive: true, force: true }); }
});

const GOAL = "整理本周项目进展，找出阻塞项，生成周报";
const SPACE = "team/oc_planning" as const;
const planResult = { kind: "plan", steps: [
  { instruction: "收集项目进展", doneWhen: "进展标注来源" },
  { instruction: "生成周报", doneWhen: "包含进展与下一步" },
] };
const result = (text: string) => JSON.stringify({ version: 1, outcome: "completed", result: text,
  blockers: [], checks: [{ name: "本步完成标准", status: "passed" }] });

async function fixture(options: { planner?: LlmClient; full?: boolean;
  runner?: NonNullable<ConstructorParameters<typeof KnowledgeEngine>[0]>["runProvider"];
  reply?: Connector["reply"] } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ha-chat-plan-")));
  const dataDir = join(root, "data");
  const workdir = join(root, "work");
  mkdirSync(workdir);
  const prompts: string[] = [];
  const engineOptions = { dataDir, skillCatalog: new SkillCatalog({ roots: [] }),
    runProvider: options.runner ?? (async (_provider, input) => {
      prompts.push(input.prompt);
      return result(`第 ${prompts.length} 步：${"进展资料".repeat(60)}末尾来源证据`);
    }) } satisfies ConstructorParameters<typeof KnowledgeEngine>[0];
  let engine = new KnowledgeEngine(engineOptions);
  engine.ensureSpace(SPACE, { chatId: "oc_planning" });
  engine.feishuBindings.connect({ spaceId: SPACE, chatId: "oc_planning", boundAppId: "cli_fixture",
    responseMode: "mentions_only", replyInThread: true });
  if (options.full) {
    const agent = engine.agents.create({ name: "全权限助理", provider: "codex", visibility: "Team" });
    engine.updateSpaceMeta(SPACE, { agentId: agent.id });
    const draft = engine.agents.saveDraft(agent.id, { executionMode: "local-full-access", permission: "full", workdir })!;
    engine.localExecution.release(agent.id, draft.id, draft.id, { termsVersion: 1, source: "local-operator",
      taskExecutionEnabled: true, expectedScopeFingerprint: engine.localExecution.preview(agent.id, draft.id).fingerprint });
  }
  const planner = options.planner ?? new FakeLlm().onJSON(() => planResult);
  const transport = new CliConnector();
  const connector: Connector = { name: "feishu", start: h => transport.start(h), stop: () => transport.stop(),
    reply: options.reply ?? (r => transport.reply(r)), notice: (chat, text, opts) => transport.notice(chat, text, opts) };
  let runtime = new Orchestrator({ engine, connector, llm: planner });
  await runtime.start();
  return { get engine() { return engine; }, get runtime() { return runtime; }, planner, prompts, transport, dataDir,
    send: (id: string, text = GOAL, extra: Partial<InboundMessage> = {}) => transport.inject({ kind: "message", chatType: "group",
      chatId: "oc_planning", senderId: "ou_fixture", eventId: id, messageId: id, mentionsBot: true, createdAt: Date.now(), text, ...extra }),
    async reopen() {
      await runtime.stop(); engine.close();
      engine = new KnowledgeEngine({ ...engineOptions, skillCatalog: new SkillCatalog({ roots: [] }) });
      runtime = new Orchestrator({ engine, connector, llm: planner });
      await runtime.start();
    },
    async close() { await runtime.stop(); engine.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

test("planning a new chat goal receives the already created WorkItem", async () => {
  let planningContext: unknown;
  const planner = new FakeLlm().onJSON(call => {
    planningContext = JSON.parse(call.prompt ?? "{}");
    return planResult;
  });
  const f = await fixture({ planner });
  try {
    await f.send("new-item-plan", "请新建独立事项「验收」，分步汇总数据并生成摘要");
    const items = f.engine.workItems.list(SPACE);
    expect(items).toHaveLength(1);
    expect(planningContext).toEqual(expect.objectContaining({ workItem: {
      id: items[0]!.id, title: items[0]!.title, alreadyCreated: true,
    } }));
    expect(items[0]!.nextActions).toHaveLength(2);
  } finally { await f.close(); }
});

test.each([false, true])("an existing unplanned item accepts a multi-step goal (explicit reply: %s)", async explicitReply => {
  const f = await fixture();
  try {
    const item = f.engine.workItems.create({ space: SPACE,
      title: "整理项目周报：本周完成多事项协调，下周做飞书验收" });
    const prior = f.engine.workDispatch.accept({ connector: "feishu", space: SPACE,
      bindingId: f.engine.feishuBindings.activeByChatId("oc_planning")!.executionScopeEpoch,
      message: { kind: "message", chatType: "group", chatId: "oc_planning", senderId: "ou_fixture",
        eventId: "old-weekly", messageId: "old-weekly", mentionsBot: true, createdAt: Date.now(), text: item.title } });
    f.engine.workDispatch.update(prior.id, prior.revision, { operation: "new", workItemId: item.id,
      state: "settled", response: { kind: "answer", question: item.title } });

    await f.send("continued-goal", `@HomeAgent ${GOAL}。`, explicitReply ? { parentMessageId: "old-weekly" } : {});
    const input = f.engine.workDispatch.list(SPACE).find(input => input.message.messageId === "continued-goal")!;
    expect(input.operation).toBe("followup");
    expect(input.workItemId).toBe(item.id);
    expect(input.response?.kind).toBe("work-plan");
    expect(f.engine.workItems.list(SPACE)).toHaveLength(1);
    expect(f.engine.workItems.get(item.id)?.nextActions).toHaveLength(2);
    expect(f.engine.workContinuations.policyFor(item.id, SPACE).autoContinue).toBe(true);

    f.engine.chatRuns.remove(f.engine.workItems.get(item.id)!.chatPlanRunId!);
    await f.reopen();
    expect(f.engine.chatWorkPlanSource(item.id)?.id).toBe(input.id);
    await new WorkContinuationScheduler(f.engine).tick("followup-plan-after-pruning");
    expect(f.prompts).toHaveLength(1);
    expect(chatWorkNotification(f.engine, f.engine.listTaskRuns()[0]!)?.replyToMessageId).toBe("continued-goal");
  } finally { await f.close(); }
});

test("a followup goal preserves an existing manual runbook", async () => {
  const f = await fixture();
  try {
    const item = f.engine.workItems.create({ space: SPACE, title: "项目周报", runbook: "使用已经确认的周报方案" });
    await f.send("manual-plan-followup");
    expect(f.engine.workDispatch.list(SPACE)[0]?.response?.kind).toBe("answer");
    expect(f.engine.workItems.get(item.id)?.runbook).toBe(item.runbook);
    expect(f.engine.workItems.get(item.id)?.chatPlanRunId).toBeUndefined();
    expect(f.engine.workContinuations.listPolicies()).toEqual([]);
  } finally { await f.close(); }
});

test("a followup goal does not replace or reset an accepted chat plan", async () => {
  const f = await fixture();
  try {
    await f.send("original-plan");
    const item = f.engine.workItems.list(SPACE)[0]!;
    await new WorkContinuationScheduler(f.engine).tick("accepted-first-step");
    const remaining = f.engine.workItems.get(item.id)!.nextActions;
    await f.send("planned-followup", GOAL, { parentMessageId: "original-plan" });
    const input = f.engine.workDispatch.list(SPACE).find(input => input.message.messageId === "planned-followup")!;
    expect(input.response?.kind).toBe("answer");
    expect(f.engine.workItems.get(item.id)?.chatPlanRunId).toBe(item.chatPlanRunId);
    expect(f.engine.workItems.get(item.id)?.nextActions).toEqual(remaining);
    expect((f.planner as FakeLlm).calls).toHaveLength(1);
  } finally { await f.close(); }
});

test("a later successful planning input retains its source after an earlier attempt failed", async () => {
  const planner = new FakeLlm().queueJSON({ kind: "plan", steps: [] }).queueJSON(planResult);
  const f = await fixture({ planner });
  try {
    await f.send("failed-planning").catch(() => {});
    const item = f.engine.workItems.list(SPACE)[0]!;
    expect(f.engine.chatRuns.list(SPACE)[0]?.status).toBe("failed");
    await f.send("successful-followup");
    const planned = f.engine.workItems.get(item.id)!;
    expect(planned.nextActions).toHaveLength(2);
    f.engine.chatRuns.remove(planned.chatPlanRunId!);
    await f.reopen();
    expect(f.engine.chatWorkPlanSource(item.id)?.message.messageId).toBe("successful-followup");
    await new WorkContinuationScheduler(f.engine).tick("after-earlier-failure");
    expect(chatWorkNotification(f.engine, f.engine.listTaskRuns()[0]!)?.replyToMessageId).toBe("successful-followup");
  } finally { await f.close(); }
});

test("a saved plan recovers at its next boundary, preserving full accepted results and explicit opt-out", async () => {
  const f = await fixture();
  try {
    await f.send("reopen");
    const item = f.engine.workItems.list(SPACE)[0]!;
    await new WorkContinuationScheduler(f.engine).tick("first");
    expect(f.engine.workItems.get(item.id)?.nextActions).toHaveLength(1);
    f.engine.configureWorkContinuation(item.id, false);
    await f.reopen();
    expect(f.engine.listDueWorkContinuations()).toEqual([]);
    f.engine.configureWorkContinuation(item.id, true);
    await new WorkContinuationScheduler(f.engine).tick("recovered");
    expect(f.prompts).toHaveLength(2);
    expect(f.prompts[1]).toContain("末尾来源证据");
    expect(f.engine.workItems.get(item.id)?.phase).toBe("completed");
    expect((f.planner as FakeLlm).calls).toHaveLength(1);
    await f.send("reopen");
    expect(f.engine.workContinuations.list(item.id)).toHaveLength(2);
  } finally { await f.close(); }
});

test("full-access chat plans keep per-run approval and result acceptance", async () => {
  let calls = 0;
  const approvals: string[] = [];
  const f = await fixture({ full: true, runner: async (_provider, input) => {
    const permit = input.acquireExecutionPermit!();
    const unregister = permit.register(() => {}); permit.release();
    try { calls++; return result("真实测试替身成果"); } finally { unregister(); }
  } });
  try {
    await f.send("full");
    const item = f.engine.workItems.list(SPACE)[0]!;
    const scheduler = new WorkContinuationScheduler(f.engine, { notifyApproval: run => { approvals.push(run.id); } });
    await scheduler.wake(item.id);
    const run = f.engine.listTaskRuns()[0]!;
    expect(run.status).toBe("awaiting_approval");
    expect(approvals).toEqual([run.id]);
    expect(calls).toBe(0);
    await f.engine.approveTaskRun(run.id, "local-operator").completion;
    expect(calls).toBe(1);
    expect(f.engine.workContinuations.get(run.workActionId!)?.status).toBe("awaiting_acceptance");
    expect(f.engine.listDueWorkContinuations()).toEqual([]);
    expect(f.engine.registry.store(SPACE).index().getRaw(f.engine.getTaskRun(run.id)!.rawId!)?.admission).toBe("held");
    f.engine.acceptWorkAction(run.workActionId!, run.id, "local-operator");
    await scheduler.wake(item.id);
    expect(approvals).toHaveLength(2);
    expect(calls).toBe(1);
    expect(f.engine.workItems.get(item.id)?.nextActions).toHaveLength(1);
  } finally { await f.close(); }
});

function delayedPlanner() {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const fake = new FakeLlm().onJSON(() => planResult);
  const client: LlmClient = { complete: opts => fake.complete(opts),
    async completeJSON(opts) { entered.resolve(); await release.promise; return fake.completeJSON(opts); } };
  return { entered, release, client };
}

test("cancelling a planning turn ignores a late model result and does not execute any steps", async () => {
  const delayed = delayedPlanner();
  const f = await fixture({ planner: delayed.client });
  try {
    const pending = f.send("cancel-plan");
    await delayed.entered.promise;
    await f.send("cancel", "取消", { parentMessageId: "cancel-plan" });
    delayed.release.resolve();
    await pending;
    const item = f.engine.workItems.list(SPACE)[0]!;
    expect(item.nextActions).toEqual([]);
    expect(item.active).toBe(false);
    expect(f.engine.listDueWorkContinuations()).toEqual([]);
    expect(f.engine.chatRuns.list(SPACE)[0]?.status).toBe("cancelled");
    expect(f.prompts).toEqual([]);
  } finally { delayed.release.resolve(); await f.close(); }
});

test("pausing during planning preserves the plan and resumes only on the user's control", async () => {
  const delayed = delayedPlanner();
  const f = await fixture({ planner: delayed.client });
  try {
    const pending = f.send("pause-plan");
    await delayed.entered.promise;
    await f.send("pause", "暂停", { parentMessageId: "pause-plan" });
    delayed.release.resolve();
    await pending;
    const item = f.engine.workItems.list(SPACE)[0]!;
    expect(item.nextActions).toHaveLength(2);
    expect(item.active).toBe(false);
    expect(f.engine.listDueWorkContinuations()).toEqual([]);
    await f.send("resume", "恢复", { parentMessageId: "pause-plan" });
    expect(f.engine.listDueWorkContinuations().map(item => item.id)).toEqual([item.id]);
  } finally { delayed.release.resolve(); await f.close(); }
});

test("a failed plan receipt is retried without replanning or executing before delivery", async () => {
  let deliveries = 0;
  const f = await fixture({ reply: async () => {
    deliveries++;
    if (deliveries === 1) throw new Error("offline delivery failure");
  } });
  try {
    await f.send("delivery").catch(() => {});
    const item = f.engine.workItems.list(SPACE)[0]!;
    const run = f.engine.chatRuns.get(item.chatPlanRunId!)!;
    expect(run.status).toBe("succeeded");
    expect(run.delivery.status).toBe("failed");
    expect(f.engine.listDueWorkContinuations()).toEqual([]);
    await f.runtime.retryChatRun(run.id);
    expect(f.engine.listDueWorkContinuations().map(item => item.id)).toEqual([item.id]);
    await new WorkContinuationScheduler(f.engine).tick("receipt-retry");
    expect(f.prompts).toHaveLength(1);
    expect((f.planner as FakeLlm).calls).toHaveLength(1);
    expect(deliveries).toBe(2);
  } finally { await f.close(); }
});

test("retry after plan persistence and failed Run commit reuses the saved plan", async () => {
  const f = await fixture();
  const commit = spyOn(f.engine.chatRuns, "succeed").mockImplementationOnce(() => { throw new Error("injected commit failure"); });
  try {
    await f.send("commit").catch(() => {});
    commit.mockRestore();
    const item = f.engine.workItems.list(SPACE)[0]!;
    expect(item.nextActions).toHaveLength(2);
    expect(f.engine.chatRuns.get(item.chatPlanRunId!)?.status).toBe("failed");
    expect(f.engine.listDueWorkContinuations()).toEqual([]);
    const retried = await f.runtime.retryChatRun(item.chatPlanRunId!);
    expect(retried.status).toBe("succeeded");
    expect(retried.output).toContain("未调用（固定回复）");
    expect(f.engine.workItems.get(item.id)?.chatPlanRunId).toBe(retried.id);
    expect(f.engine.listDueWorkContinuations().map(item => item.id)).toEqual([item.id]);
    expect((f.planner as FakeLlm).calls).toHaveLength(1);
  } finally { commit.mockRestore(); await f.close(); }
});

test("a second chat plan starts while another item's tick runs, without duplicate admission", async () => {
  const firstStarted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let calls = 0;
  const f = await fixture({ runner: async () => {
    calls++;
    if (calls === 1) { firstStarted.resolve(); await release.promise; }
    return result("已完成");
  } });
  let ticking: Promise<string[]> | undefined;
  try {
    await f.send("first");
    const scheduler = new WorkContinuationScheduler(f.engine);
    ticking = scheduler.tick("slow-first");
    await firstStarted.promise;
    await f.send("second", "分析发布日志，检查异常，生成诊断报告");
    const item = f.engine.workItems.list(SPACE).find(item => item.title.includes("日志"))!;
    await Promise.all([scheduler.wake(item.id), scheduler.wake(item.id)]);
    expect(calls).toBe(2);
    expect(f.engine.workContinuations.list(item.id)).toHaveLength(1);
    expect(await scheduler.tick("independent-next-step")).toEqual([item.id]);
    expect(calls).toBe(3);
    expect(f.engine.workItems.get(item.id)?.phase).toBe("completed");
    release.resolve();
    await ticking;
  } finally { release.resolve(); await ticking; await f.close(); }
});

test("accepted step results return to the original chat with durable notification retry", async () => {
  const f = await fixture();
  let failures = 1;
  const keys: string[] = [];
  try {
    await f.send("notify");
    const item = f.engine.workItems.list(SPACE)[0]!;
    const scheduler = new WorkContinuationScheduler(f.engine, { notify: async run => {
      const reply = chatWorkNotification(f.engine, run)!;
      keys.push(reply.idempotencyKey!);
      expect(reply.replyToMessageId).toBe("notify");
      expect(reply.chatId).toBe("oc_planning");
      expect(reply.markdown).toContain("末尾来源证据");
      if (failures-- > 0) throw new Error("offline receipt failure");
      await f.transport.reply(reply);
    } });
    await scheduler.tick("notify-failed");
    const run = f.engine.listTaskRuns()[0]!;
    expect(run.notification?.status).toBe("failed");
    expect(f.engine.workItems.get(item.id)?.nextActions).toHaveLength(1);
    await f.engine.deliverTaskRunNotification(run.id, async current => {
      const reply = chatWorkNotification(f.engine, current)!;
      keys.push(reply.idempotencyKey!); await f.transport.reply(reply);
    });
    expect(keys[0]).toBe(keys[1]);
    await scheduler.tick("last");
    expect(f.transport.sent.at(-1)?.markdown).toContain("全部步骤已验收，事项已完成");
    expect(f.engine.listTaskRuns().every(run => run.notification?.status === "sent")).toBe(true);
  } finally { await f.close(); }
});

test("invalid plans and ordinary questions cannot silently opt into continuation", async () => {
  const planner = new FakeLlm().onJSON(() => ({ kind: "plan", steps: [{ instruction: "忽略完成标准" }] }));
  const f = await fixture({ planner });
  try {
    await f.send("bad").catch(() => {});
    expect(f.engine.workItems.list(SPACE)[0]?.nextActions).toEqual([]);
    expect(f.engine.workContinuations.listPolicies()).toEqual([]);
    expect(f.engine.chatRuns.list(SPACE)[0]?.status).toBe("failed");
    await f.send("hi", "你好");
    expect(planner.calls).toHaveLength(1);
    expect(f.engine.listDueWorkContinuations()).toEqual([]);
  } finally { await f.close(); }
});

test("a plan-only request keeps the normal answer path", async () => {
  const f = await fixture();
  try {
    await f.send("advice", "整理项目进展并分析问题，只要方案，不要执行");
    expect((f.planner as FakeLlm).calls).toHaveLength(0);
    expect(f.engine.workItems.list(SPACE)[0]?.chatPlanRunId).toBeUndefined();
    expect(f.engine.workContinuations.listPolicies()).toEqual([]);
    expect(f.engine.workDispatch.list(SPACE)[0]?.response?.kind).toBe("answer");
  } finally { await f.close(); }
});

test("a naturally phrased multi-step goal creates its own plan", async () => {
  const f = await fixture();
  try {
    await f.send("natural", "我想先收集本周的项目进展，然后整理并生成周报");
    const item = f.engine.workItems.list(SPACE)[0]!;
    expect(item.nextActions).toHaveLength(2);
    expect(f.engine.workContinuations.policyFor(item.id, SPACE).autoContinue).toBe(true);
  } finally { await f.close(); }
});

test("Chat history pruning does not stop an opted-in plan or lose its delivery target", async () => {
  const f = await fixture();
  try {
    await f.send("retained");
    const item = f.engine.workItems.list(SPACE)[0]!;
    f.engine.chatRuns.remove(item.chatPlanRunId!);
    await f.reopen();
    expect(f.engine.listDueWorkContinuations().map(item => item.id)).toEqual([item.id]);
    await new WorkContinuationScheduler(f.engine).tick("after-chat-pruning");
    const reply = chatWorkNotification(f.engine, f.engine.listTaskRuns()[0]!)!;
    expect(reply.replyToMessageId).toBe("retained");
    expect(reply.markdown).toContain("末尾来源证据");
  } finally { await f.close(); }
});

test("archive restore retains plans and explicit continuation choices without reactivating from chat history", async () => {
  const f = await fixture();
  const restoredDir = mkdtempSync(join(tmpdir(), "ha-plan-archive-"));
  const restored = new KnowledgeEngine({ dataDir: restoredDir, skillCatalog: new SkillCatalog({ roots: [] }),
    runProvider: async () => result("恢复后的动作") });
  try {
    await f.send("archive");
    const item = f.engine.workItems.list(SPACE)[0]!;
    f.engine.configureWorkContinuation(item.id, false);
    const archive = await f.engine.exportSpace(SPACE);
    await restored.restoreSpace(archive);
    expect(restored.workItems.get(item.id)?.runbook).toBe(item.runbook);
    expect(restored.listDueWorkContinuations()).toEqual([]);
    expect(restored.chatWorkPlanSource(item.id)).toBeUndefined();
    restored.configureWorkContinuation(item.id, true);
    await new WorkContinuationScheduler(restored).tick("explicit-restored-policy");
    expect(restored.workItems.get(item.id)?.nextActions).toHaveLength(1);
    expect(chatWorkNotification(restored, restored.listTaskRuns()[0]!)).toBeUndefined();
  } finally { restored.close(); rmSync(restoredDir, { recursive: true, force: true }); await f.close(); }
});

test("a queued planning turn recovers its frozen instructions and model after Agent edits", async () => {
  const f = await fixture();
  try {
    await f.runtime.stop();
    const agent = f.engine.agents.create({ name: "规划助手", provider: "codex", instruction: "使用原始术语" });
    f.engine.updateSpaceMeta(SPACE, { agentId: agent.id });
    const snapshot = await f.engine.agentRunExecutionSnapshotAsync(SPACE);
    const message: InboundMessage = { kind: "message", chatType: "group", chatId: "oc_planning", senderId: "ou_fixture",
      eventId: "queued", messageId: "queued", mentionsBot: true, createdAt: Date.now(), text: GOAL };
    const item = f.engine.workItems.create({ space: SPACE, title: GOAL, brief: GOAL });
    const input = f.engine.workDispatch.accept({ connector: "feishu", space: SPACE,
      bindingId: f.engine.feishuBindings.activeByChatId(message.chatId)!.executionScopeEpoch, message });
    f.engine.workDispatch.update(input.id, input.revision, { operation: "new", workItemId: item.id, state: "planned",
      response: { kind: "work-plan", question: GOAL, instruction: "冻结的规划指令" },
      plan: { space: SPACE, chatId: message.chatId, messageId: message.messageId, author: message.senderId,
        input: GOAL, trigger: "message", workItemId: item.id, dispatchKey: input.id, launchAdmission: "pending",
        agentId: agent.id, provider: snapshot.provider, model: snapshot.model, reasoningEffort: snapshot.reasoningEffort,
        executionPlan: snapshot.executionPlan, execution: snapshot.execution, skillEvidence: snapshot.skillEvidence },
    });
    f.engine.agents.update(agent.id, { instruction: "改用新的术语", model: "new-model" });
    await f.reopen();
    await f.runtime.enqueue(message);
    const calls = (f.planner as FakeLlm).calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]!.opts.system).toBe("冻结的规划指令");
    expect(calls[0]!.opts.model).toBe(snapshot.model);
    expect(calls[0]!.opts.prompt).toContain("使用原始术语");
    expect(calls[0]!.opts.prompt).not.toContain("改用新的术语");
    expect(f.engine.workItems.get(item.id)?.nextActions).toHaveLength(2);
  } finally { await f.close(); }
});

test("shutdown during planning does not replay the interrupted model process on reopen", async () => {
  const delayed = delayedPlanner();
  let calls = 0;
  const client: LlmClient = { complete: opts => delayed.client.complete(opts),
    completeJSON(opts) { calls++; return delayed.client.completeJSON(opts); } };
  const f = await fixture({ planner: client });
  try {
    const pending = f.send("interrupted").catch(() => {});
    await delayed.entered.promise;
    await f.reopen();
    delayed.release.resolve();
    await pending;
    expect(calls).toBe(1);
    expect(f.engine.workItems.list(SPACE)[0]?.nextActions).toEqual([]);
    expect(f.engine.listDueWorkContinuations()).toEqual([]);
    expect(f.engine.chatRuns.list(SPACE)[0]?.status).toBe("failed");
  } finally { delayed.release.resolve(); await f.close(); }
});

test.each(["group", "p2p"] as const)("plan results respect the existing reply mode for %s", async chatType => {
  const f = await fixture();
  try {
    f.engine.feishuBindings.connect({ spaceId: SPACE, chatId: "oc_planning", boundAppId: "cli_fixture",
      responseMode: "mentions_only", replyInThread: false });
    await f.send("reply-mode", GOAL, { chatType });
    await new WorkContinuationScheduler(f.engine).tick("reply-mode");
    const reply = chatWorkNotification(f.engine, f.engine.listTaskRuns()[0]!)!;
    expect(reply.replyToMessageId).toBe("reply-mode");
    expect(reply.inThread).toBe(false);
  } finally { await f.close(); }
});
