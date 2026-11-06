import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeLlm, KnowledgeEngine, SkillCatalog, parseSpaceArchive, type LlmClient } from "@homeagent/core";
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
const blockedResult = (text = "原资料不可读，可使用目标中的备用资料") => JSON.stringify({ version: 1, outcome: "blocked", result: text,
  blockers: [text], checks: [{ name: "读取资料", status: "failed" }] });

test("M3 delegates sequential steps to published workers with frozen revisions and individual approvals", async () => {
  const workers: string[] = [], called: string[] = [];
  const planner = new FakeLlm().onJSON(() => ({ kind: "plan", steps: workers.map((agentId, i) => ({
    instruction: ["调研测试数据", "撰写摘要", "检查摘要"][i], doneWhen: "结果符合测试数据", agentId,
  })) }));
  const f = await fixture({ full: true, planner, runner: async (_provider, input) => {
    const permit = input.acquireExecutionPermit!(); const unregister = permit.register(() => {}); permit.release(); unregister();
    called.push(input.system ?? ""); return result("总数20，完成率60%，阻塞占比15%");
  } });
  try {
    const workdir = f.engine.agentForSpace(SPACE)!.workdir;
    for (const name of ["研究", "写作", "审查"]) {
      const agent = f.engine.agents.create({ name, provider: "codex", visibility: "Team", instruction: `专业${name}初版` });
      const draft = f.engine.agents.saveDraft(agent.id, { executionMode: "local-full-access", permission: "full", workdir })!;
      f.engine.localExecution.release(agent.id, draft.id, draft.id, { termsVersion: 1, source: "local-operator",
        taskExecutionEnabled: true, expectedScopeFingerprint: f.engine.localExecution.preview(agent.id, draft.id).fingerprint });
      workers.push(agent.id);
    }
    await f.send("m3-workers");
    const item = f.engine.workItems.list(SPACE)[0]!;
    const revisions = workers.map(id => f.engine.agents.get(id)!.publishedRevisionId);
    await f.reopen();
    for (let i = 0; i < 3; i++) {
      await new WorkContinuationScheduler(f.engine).wake(item.id);
      const run = f.engine.listTaskRuns().find(run => run.status === "awaiting_approval")!;
      expect(run.agentId).toBe(workers[i]);
      expect(run.executionPlan?.agentRevisionId).toBe(revisions[i]);
      expect(called).toHaveLength(i);
      await f.engine.approveTaskRun(run.id, "local-operator").completion;
      expect(f.engine.workContinuations.get(run.workActionId!)?.status).toBe("awaiting_acceptance");
      expect(f.engine.listDueWorkContinuations()).toEqual([]);
      f.engine.acceptWorkAction(run.workActionId!, run.id, "local-operator");
    }
    expect(f.engine.workItems.get(item.id)?.phase).toBe("completed");
    expect(called).toHaveLength(3);
  } finally { await f.close(); }
});

test("M3 runs independent children concurrently and aggregates only after both human acceptances", async () => {
  const entered: string[] = []; const release = Promise.withResolvers<void>();
  const planner = new FakeLlm().onJSON(() => ({ kind: "plan", children: [
    { key: "a", title: "独立研究A", goal: "计算A的总数", steps: [{ instruction: "研究A", doneWhen: "A合计20" }] },
    { key: "b", title: "独立研究B", goal: "计算B的总数", steps: [{ instruction: "研究B", doneWhen: "B合计10" }] },
  ], steps: [{ instruction: "比较A与B", doneWhen: "引用两个已验收成果", dependsOn: ["a", "b"] }] }));
  const f = await fixture({ full: true, planner, runner: async (_provider, input) => {
    const permit = input.acquireExecutionPermit!(); const unregister = permit.register(() => {}); permit.release();
    try { entered.push(input.prompt); if (entered.length <= 2) await release.promise;
      return result(entered.length <= 2 ? input.prompt.includes("研究A") ? "A合计20" : "B合计10" : "A20，B10，相差10");
    } finally { unregister(); }
  } });
  try {
    await f.send("m3-parallel", "分别研究A、B，独立并行执行，然后比较汇总");
    const parent = f.engine.workItems.list(SPACE).find(item => !item.parentWorkItemId)!;
    const children = f.engine.workItems.list(SPACE).filter(item => item.parentWorkItemId === parent.id);
    expect(children).toHaveLength(2);
    expect(f.engine.listDueWorkContinuations().map(item => item.id).sort()).toEqual(children.map(item => item.id).sort());
    await new WorkContinuationScheduler(f.engine).tick("m3-children");
    const runs = f.engine.listTaskRuns();
    expect(runs).toHaveLength(2);
    expect(runs.every(run => run.status === "awaiting_approval")).toBe(true);
    const pending = runs.map(run => f.engine.approveTaskRun(run.id, "local-operator").completion);
    for (let i = 0; i < 200 && entered.length < 2; i++) await Bun.sleep(10);
    expect(entered).toHaveLength(2);
    expect(f.engine.listTaskRuns().filter(run => run.status === "running")).toHaveLength(2);
    release.resolve(); await Promise.all(pending);
    expect(f.engine.listDueWorkContinuations()).toEqual([]);
    f.engine.acceptWorkAction(runs[0]!.workActionId!, runs[0]!.id, "local-operator");
    expect(f.engine.listDueWorkContinuations()).toEqual([]);
    await f.reopen();
    f.engine.acceptWorkAction(runs[1]!.workActionId!, runs[1]!.id, "local-operator");
    expect(f.engine.listDueWorkContinuations().map(item => item.id)).toEqual([parent.id]);
    await new WorkContinuationScheduler(f.engine).wake(parent.id);
    const aggregate = f.engine.listTaskRuns().find(run => run.workItemId === parent.id)!;
    expect(aggregate.topic).toContain("A合计20"); expect(aggregate.topic).toContain("B合计10");
    await f.engine.approveTaskRun(aggregate.id, "local-operator").completion;
    f.engine.acceptWorkAction(aggregate.workActionId!, aggregate.id, "local-operator");
    await f.runtime.processWorkEvents();
    expect(f.engine.workItems.get(parent.id)?.phase).toBe("completed");
    expect(f.transport.sent.filter(reply => reply.markdown.includes("全部步骤已验收"))).toHaveLength(1);
    expect(f.transport.sent.at(-1)?.replyToMessageId).toBe("m3-parallel");
  } finally { release.resolve(); await f.close(); }
});

test("M3 replans a blocked worker child without repeating an accepted sibling", async () => {
  let workerId = "", aCalls = 0, bCalls = 0;
  const planner = new FakeLlm().onJSON(call => JSON.parse(call.prompt ?? "{}").recoveryContext
    ? { kind: "plan", reason: "改用授权备用数据", steps: [{ instruction: "读取A备用数据", doneWhen: "A合计20" }] }
    : { kind: "plan", children: [
      { key: "a", title: "研究A", goal: "读取A或备用数据", steps: [{ instruction: "读取A主数据", doneWhen: "A合计20", agentId: workerId }] },
      { key: "b", title: "研究B", goal: "读取B", steps: [{ instruction: "读取B数据", doneWhen: "B合计10" }] },
    ], steps: [{ instruction: "汇总结果", doneWhen: "有A和B成果", dependsOn: ["a", "b"] }] });
  const f = await fixture({ planner, runner: async (_provider, input) => {
    if (input.prompt.includes("# 工作项\n研究A")) return ++aCalls === 1 ? blockedResult("A主数据不可读") : result("A合计20");
    if (input.prompt.includes("# 工作项\n研究B")) { bCalls++; return result("B合计10"); }
    return result("合计30");
  } });
  try {
    workerId = f.engine.agents.create({ name: "研究专业Agent", visibility: "Team", provider: "codex" }).id;
    await f.send("m3-recover", "分别研究A和B，遇阻可用备用数据，最后汇总");
    const parent = f.engine.workItems.list(SPACE).find(item => !item.parentWorkItemId)!;
    await new WorkContinuationScheduler(f.engine).tick("m3-children");
    const b = f.engine.workItems.list(SPACE).find(item => item.title === "研究B")!;
    const accepted = [...b.completedActionIds!];
    await f.runtime.processWorkEvents();
    const a = f.engine.workItems.list(SPACE).find(item => item.title === "研究A")!;
    expect(f.engine.getWorkPlanView(a.id)?.remaining[0]?.worker?.agentId).toBe(workerId);
    await f.reopen();
    await new WorkContinuationScheduler(f.engine).wake(a.id);
    expect(f.engine.workItems.get(b.id)?.completedActionIds).toEqual(accepted);
    expect(bCalls).toBe(1); expect(aCalls).toBe(2);
    await new WorkContinuationScheduler(f.engine).wake(parent.id);
    await f.runtime.processWorkEvents();
    expect(f.engine.workItems.get(parent.id)?.phase).toBe("completed");
    expect(f.transport.sent.filter(reply => reply.markdown.includes("全部步骤已验收"))).toHaveLength(1);
  } finally { await f.close(); }
});

test("M3 parent pause and cancellation preserve unrelated work and cancel each child approval", async () => {
  const planner = new FakeLlm().onJSON(() => ({ kind: "plan", children: ["a", "b"].map(key => ({ key, title: key, goal: key,
    steps: [{ instruction: `研究${key}`, doneWhen: "标注来源" }] })), steps: [{ instruction: "汇总", doneWhen: "包含两项结果" }] }));
  const f = await fixture({ full: true, planner });
  try {
    await f.send("m3-control", "分别研究A和B，然后汇总");
    const parent = f.engine.workItems.list(SPACE).find(item => !item.parentWorkItemId)!;
    f.engine.workItems.update(parent.id, { active: false });
    expect(f.engine.listDueWorkContinuations()).toEqual([]);
    f.engine.workItems.update(parent.id, { active: true });
    await new WorkContinuationScheduler(f.engine).wake(parent.id);
    expect(f.engine.listTaskRuns().filter(run => run.status === "awaiting_approval")).toHaveLength(2);
    const unrelated = f.engine.workItems.create({ space: SPACE, title: "其他事项", nextActions: ["自己的工作"] });
    await f.send("m3-cancel", "取消", { parentMessageId: "m3-control" });
    expect(f.engine.listTaskRuns().every(run => run.status === "cancelled")).toBe(true);
    expect(f.engine.workItems.get(unrelated.id)?.active).toBe(true);
    await f.reopen();
    expect(f.engine.workItems.get(parent.id)?.childCancellation?.status).toBe("applied");
    expect(f.engine.listDueWorkContinuations()).toEqual([]);
  } finally { await f.close(); }
});

test("M3 an answer in the original topic resumes the child that requested missing facts", async () => {
  let calls = 0;
  const planner = new FakeLlm().onJSON(call => {
    const context = JSON.parse(call.prompt ?? "{}");
    if (context.recoveryContext) return { kind: "wait", reason: "缺少数量", question: "A已完成多少项？" };
    if (context.revisionContext) return { kind: "plan", steps: [{ instruction: "采用A已完成12项", doneWhen: "结果包含12项" }] };
    return { kind: "plan", children: [{ key: "a", title: "统计A", goal: "统计A的完成数量", steps: [{ instruction: "查询A数量", doneWhen: "有真实数量" }] }],
      steps: [{ instruction: "汇总A", doneWhen: "有数量", dependsOn: ["a"] }] };
  });
  const f = await fixture({ planner, runner: async () => ++calls === 1 ? blockedResult("缺少A完成数量") : result("A已完成12项") });
  try {
    await f.send("m3-facts", "请新建独立事项「汇总A」，分别分析A，然后汇总");
    const parent = f.engine.workItems.list(SPACE).find(item => !item.parentWorkItemId)!;
    await new WorkContinuationScheduler(f.engine).wake(parent.id);
    await f.runtime.processWorkEvents();
    const child = f.engine.workItems.list(SPACE).find(item => item.parentWorkItemId === parent.id)!;
    expect(f.engine.workAwaitsRecoveryInput(child.id)).toBe(true);
    await f.send("m3-facts-reply", "A已完成12项", { parentMessageId: "m3-facts" });
    expect(f.engine.workDispatch.list(SPACE).find(input => input.message.messageId === "m3-facts-reply")?.workItemId).toBe(child.id);
    await new WorkContinuationScheduler(f.engine).wake(child.id);
    await new WorkContinuationScheduler(f.engine).wake(parent.id);
    expect(f.engine.workItems.get(parent.id)?.phase).toBe("completed");
    expect(f.engine.chatWorkPlanSource(child.id)?.message.messageId).toBe("m3-facts");
  } finally { await f.close(); }
});

test("M3 child recovery waits for its original-topic receipt before continuing", async () => {
  let offline = true;
  const planner = new FakeLlm().onJSON(call => JSON.parse(call.prompt ?? "{}").recoveryContext
    ? { kind: "plan", reason: "改用备用资料", steps: [{ instruction: "读取备用资料", doneWhen: "有真实数据" }] }
    : { kind: "plan", children: [{ key: "a", title: "研究A", goal: "读取A或备用资料", steps: [{ instruction: "读取A", doneWhen: "有真实数据" }] }],
      steps: [{ instruction: "汇总A", doneWhen: "引用已验收成果" }] });
  const f = await fixture({ planner, runner: async () => blockedResult(), reply: async reply => {
    if (offline && reply.markdown.includes("已根据阻塞修订")) throw new Error("fixture offline");
  } });
  try {
    await f.send("m3-receipt", "请新建独立事项「资料汇总」，分别调研A并汇总");
    const child = f.engine.workItems.list(SPACE).find(item => item.parentWorkItemId)!;
    await new WorkContinuationScheduler(f.engine).wake(child.id);
    await f.runtime.processWorkEvents();
    expect(f.engine.listDueWorkContinuations()).toEqual([]);
    expect(() => f.engine.startWorkContinuation(child.id)).toThrow("receipt");
    await f.reopen(); offline = false;
    const notice = f.engine.workEvents.list().find(notice => notice.kind === "replanned")!;
    f.engine.workEvents.save({ ...notice, nextAttemptAt: 0 });
    await f.runtime.processWorkEvents();
    expect(f.engine.listDueWorkContinuations().map(item => item.id)).toEqual([child.id]);
  } finally { await f.close(); }
});

test("M2 replans a business blocker, preserves accepted evidence and completes the original topic", async () => {
  let calls = 0, recoveries = 0;
  const planner = new FakeLlm().onJSON(call => {
    const context = JSON.parse(call.prompt ?? "{}");
    if (!context.recoveryContext) return planResult;
    recoveries++;
    expect(context.recoveryContext.prepared.accepted[0]?.result).toBe("已汇总20项");
    return { kind: "plan", reason: "改用用户已指定的备用资料", steps: [
      { instruction: "根据备用资料和已验收汇总生成摘要", doneWhen: "摘要包含完成率60%和阻塞占比15%" },
    ] };
  });
  const f = await fixture({ planner, runner: async () => ++calls === 1 ? result("已汇总20项")
    : calls === 2 ? blockedResult() : result("完成率60%，阻塞占比15%") });
  try {
    await f.send("m2-recovery");
    const item = f.engine.workItems.list(SPACE)[0]!;
    const scheduler = new WorkContinuationScheduler(f.engine);
    await scheduler.wake(item.id);
    const accepted = f.engine.workContinuations.list(item.id)[0]!;
    await scheduler.wake(item.id);
    expect(f.engine.workItems.get(item.id)?.phase).toBe("blocked");
    await f.runtime.processWorkEvents();
    expect(recoveries).toBe(1);
    expect(f.engine.getWorkPlanView(item.id)?.current.source.kind).toBe("recovery");
    expect(f.engine.workContinuations.get(accepted.id)?.checkpoint).toEqual(accepted.checkpoint);
    await scheduler.wake(item.id);
    await f.runtime.processWorkEvents();
    expect(calls).toBe(3);
    expect(f.engine.workItems.get(item.id)?.phase).toBe("completed");
    expect(f.transport.sent.filter(reply => reply.markdown.includes("全部步骤已验收"))).toHaveLength(1);
    const archive = await f.engine.exportSpace(SPACE);
    expect(archive.version).toBe(24);
    expect(parseSpaceArchive(archive).workPlans.at(-1)?.source.kind).toBe("recovery");
    expect(() => parseSpaceArchive({ ...archive, version: 22 })).toThrow("v23");
    expect(JSON.stringify(archive)).not.toContain("sourceInputId");
    expect(JSON.stringify(archive)).not.toContain("workEvents");
    const targetRoot = mkdtempSync(join(tmpdir(), "ha-m2-archive-"));
    const target = new KnowledgeEngine({ dataDir: targetRoot, skillCatalog: new SkillCatalog({ roots: [] }) });
    try {
      await target.restoreSpace(archive);
      expect(target.getWorkPlanView(item.id)?.current.source.kind).toBe("recovery");
      expect(target.workEvents.list()).toEqual([]);
      expect(target.workEvents.listRecoveries()).toEqual([]);
    } finally { target.close(); rmSync(targetRoot, { recursive: true, force: true }); }
    await f.reopen();
    await f.runtime.processWorkEvents();
    expect(recoveries).toBe(1);
  } finally { await f.close(); }
});

test("M2 sends completion to the original topic only after final human acceptance and never repeats after restart", async () => {
  const f = await fixture({ full: true, runner: async (_provider, input) => {
    const permit = input.acquireExecutionPermit!();
    const unregister = permit.register(() => {}); permit.release(); unregister();
    return result("总数20，完成率60%，阻塞占比15%。");
  } });
  try {
    await f.send("m2-completion");
    const item = f.engine.workItems.list(SPACE)[0]!;
    for (let index = 0; index < 2; index++) {
      await new WorkContinuationScheduler(f.engine).wake(item.id);
      const run = f.engine.listTaskRuns().find(run => run.status === "awaiting_approval")!;
      await f.engine.approveTaskRun(run.id, "local-operator").completion;
      await f.runtime.processWorkEvents();
      expect(f.transport.sent.filter(reply => reply.markdown.includes("全部步骤已验收"))).toHaveLength(0);
      f.engine.acceptWorkAction(run.workActionId!, run.id, "local-operator");
    }
    await f.runtime.processWorkEvents();
    await f.runtime.processWorkEvents();
    const notices = f.transport.sent.filter(reply => reply.markdown.includes("全部步骤已验收"));
    expect(notices).toHaveLength(1);
    expect(notices[0]?.replyToMessageId).toBe("m2-completion");
    expect(notices[0]?.markdown).toContain("完成率60%");
    await f.reopen();
    await f.runtime.processWorkEvents();
    expect(f.transport.sent.filter(reply => reply.markdown.includes("全部步骤已验收"))).toHaveLength(1);
  } finally { await f.close(); }
});

test("M2 asks once for missing facts, waits across restart and resumes with a plain factual reply", async () => {
  let recoveries = 0, calls = 0;
  const planner = new FakeLlm().onJSON(call => {
    const context = JSON.parse(call.prompt ?? "{}");
    if (context.recoveryContext) { recoveries++; return { kind: "wait", reason: "缺少完成项目数量", question: "本周已完成多少项？" }; }
    if (context.revisionContext) {
      expect(context.revisionContext.blocked.report.blockers).toEqual(["缺少完成项目数量"]);
      return { kind: "plan", steps: [{ instruction: "使用已完成12项生成摘要", doneWhen: "包含12项" }] };
    }
    return planResult;
  });
  const f = await fixture({ planner, runner: async () => ++calls === 1 ? blockedResult("缺少完成项目数量") : result("已完成12项") });
  try {
    await f.send("m2-wait");
    const item = f.engine.workItems.list(SPACE)[0]!;
    await new WorkContinuationScheduler(f.engine).wake(item.id);
    await f.runtime.processWorkEvents();
    await f.runtime.processWorkEvents();
    await f.reopen();
    await f.runtime.processWorkEvents();
    expect(recoveries).toBe(1);
    expect(f.transport.sent.filter(reply => reply.markdown.includes("本周已完成多少项？"))).toHaveLength(1);
    expect(f.engine.listDueWorkContinuations()).toEqual([]);
    await f.send("m2-facts", "已完成12项", { parentMessageId: "m2-wait" });
    expect(f.engine.getWorkPlanView(item.id)?.remaining[0]?.instruction).toBe("使用已完成12项生成摘要");
    await new WorkContinuationScheduler(f.engine).wake(item.id);
    await f.runtime.processWorkEvents();
    expect(f.engine.workItems.get(item.id)?.phase).toBe("completed");
    expect(calls).toBe(2);
  } finally { await f.close(); }
});

test("M2 repeated blocker facts do not create a planning loop or re-admit failed evidence", async () => {
  let recoveries = 0;
  const planner = new FakeLlm().onJSON(call => JSON.parse(call.prompt ?? "{}").recoveryContext
    ? (recoveries++, { kind: "plan", reason: "尝试目标中已有的备用资料", steps: [{ instruction: "读取备用资料", doneWhen: "取得真实数据" }] }) : planResult);
  const f = await fixture({ planner, runner: async () => blockedResult("两个授权来源均无数据") });
  try {
    await f.send("m2-repeat");
    const item = f.engine.workItems.list(SPACE)[0]!;
    for (let i = 0; i < 2; i++) {
      await new WorkContinuationScheduler(f.engine).wake(item.id);
      await f.runtime.processWorkEvents();
    }
    await f.reopen();
    await f.runtime.processWorkEvents();
    expect(recoveries).toBe(1);
    expect(f.engine.workItems.get(item.id)?.phase).toBe("blocked");
    expect(f.engine.workContinuations.list(item.id).filter(action => action.status === "succeeded")).toEqual([]);
    for (const run of f.engine.listTaskRuns()) {
      expect(f.engine.registry.store(SPACE).index().getRaw(run.rawId!)?.admission).toBe("excluded");
    }
  } finally { await f.close(); }
});

test("M2 provider failures are left for explicit retry and never trigger recovery planning", async () => {
  let calls = 0, recoveries = 0;
  const planner = new FakeLlm().onJSON(call => {
    if (JSON.parse(call.prompt ?? "{}").recoveryContext) recoveries++;
    return planResult;
  });
  const f = await fixture({ planner, runner: async () => { calls++; throw new Error("provider fixture failure"); } });
  try {
    await f.send("m2-provider-fail");
    const item = f.engine.workItems.list(SPACE)[0]!;
    await new WorkContinuationScheduler(f.engine).wake(item.id);
    await f.runtime.processWorkEvents();
    await f.reopen();
    await f.runtime.processWorkEvents();
    expect(recoveries).toBe(0);
    expect(calls).toBe(1);
    expect(f.engine.workEvents.listRecoveries()).toEqual([]);
  } finally { await f.close(); }
});

test("M2 human rejection produces a correction with its own full-access approval", async () => {
  let executions = 0;
  const planner = new FakeLlm().onJSON(call => {
    const context = JSON.parse(call.prompt ?? "{}");
    if (!context.recoveryContext) return planResult;
    expect(context.recoveryContext.rejection).toBe("摘要缺少阻塞占比");
    return { kind: "plan", reason: "根据验收意见补齐占比", steps: [{ instruction: "修正摘要", doneWhen: "包含阻塞占比15%" }] };
  });
  const f = await fixture({ full: true, planner, runner: async (_provider, input) => {
    const permit = input.acquireExecutionPermit!(); const unregister = permit.register(() => {}); permit.release(); unregister();
    executions++; return result("总数20，完成率60%，阻塞占比15%");
  } });
  try {
    await f.send("m2-reject");
    const item = f.engine.workItems.list(SPACE)[0]!;
    await new WorkContinuationScheduler(f.engine).wake(item.id);
    const first = f.engine.listTaskRuns()[0]!;
    await f.engine.approveTaskRun(first.id, "local-operator").completion;
    f.engine.rejectWorkAction(first.workActionId!, first.id, "local-operator", "摘要缺少阻塞占比");
    await f.runtime.processWorkEvents();
    await new WorkContinuationScheduler(f.engine).wake(item.id);
    const next = f.engine.listTaskRuns().find(run => run.id !== first.id)!;
    expect(next.status).toBe("awaiting_approval");
    expect(next.approval?.status).toBe("pending");
    expect(executions).toBe(1);
    expect(f.engine.registry.store(SPACE).index().getRaw(first.rawId ?? f.engine.taskRuns.get(first.id)!.rawId!)?.admission).toBe("excluded");
    await f.engine.approveTaskRun(next.id, "local-operator").completion;
    await f.runtime.processWorkEvents();
    expect(f.transport.sent.some(reply => reply.markdown.includes("全部步骤已验收"))).toBe(false);
    f.engine.acceptWorkAction(next.workActionId!, next.id, "local-operator");
    await f.runtime.processWorkEvents();
    expect(f.engine.workItems.get(item.id)?.phase).toBe("completed");
  } finally { await f.close(); }
});

test("M2 saves a paused planner decision and commits it after resume without another model call", async () => {
  let resolve!: () => void, began!: () => void, recoveries = 0;
  const gate = new Promise<void>(r => { resolve = r; });
  const started = new Promise<void>(r => { began = r; });
  const fake = new FakeLlm().onJSON(call => JSON.parse(call.prompt ?? "{}").recoveryContext
    ? { kind: "plan", reason: "改用备用资料", steps: [{ instruction: "读取备用资料", doneWhen: "核对数据" }] } : planResult);
  const planner: LlmClient = { complete: opts => fake.complete(opts), async completeJSON(opts) {
    if (JSON.parse(opts.prompt ?? "{}").recoveryContext) { recoveries++; began(); await gate; }
    return fake.completeJSON(opts);
  } };
  const f = await fixture({ planner, runner: async () => blockedResult() });
  try {
    await f.send("m2-pause");
    const item = f.engine.workItems.list(SPACE)[0]!;
    await new WorkContinuationScheduler(f.engine).wake(item.id);
    const processing = f.runtime.processWorkEvents();
    await started;
    f.engine.workItems.update(item.id, { active: false });
    resolve();
    await processing;
    expect(f.engine.getWorkPlanView(item.id)?.current.revision).toBe(1);
    expect(f.engine.workEvents.listRecoveries()[0]?.status).toBe("decided");
    await f.reopen();
    f.engine.workItems.update(item.id, { active: true });
    await f.runtime.processWorkEvents();
    expect(f.engine.getWorkPlanView(item.id)?.current.revision).toBe(2);
    expect(recoveries).toBe(1);
  } finally { resolve(); await f.close(); }
});

test("M2 recovers the committed plan when retiring the old blocked action fails", async () => {
  let recoveries = 0;
  const planner = new FakeLlm().onJSON(call => JSON.parse(call.prompt ?? "{}").recoveryContext
    ? (recoveries++, { kind: "plan", reason: "改用备用资料", steps: [{ instruction: "读取备用资料", doneWhen: "取得真实数据" }] }) : planResult);
  const f = await fixture({ planner, runner: async () => blockedResult() });
  try {
    await f.send("m2-commit-crash");
    const item = f.engine.workItems.list(SPACE)[0]!;
    await new WorkContinuationScheduler(f.engine).wake(item.id);
    const old = f.engine.workContinuations.list(item.id)[0]!;
    const fail = spyOn(f.engine, "abandonWorkAction").mockImplementationOnce(() => { throw new Error("injected retirement failure"); });
    await f.runtime.processWorkEvents();
    fail.mockRestore();
    expect(f.engine.getWorkPlanView(item.id)?.current.revision).toBe(2);
    expect(f.engine.workEvents.listRecoveries()[0]?.status).toBe("decided");
    expect(f.engine.listDueWorkContinuations()).toEqual([]);
    await f.reopen();
    await f.runtime.processWorkEvents();
    expect(f.engine.workContinuations.get(old.id)?.status).toBe("cancelled");
    expect(f.engine.workItems.get(item.id)?.blockers).toEqual([]);
    expect(f.engine.listDueWorkContinuations().map(item => item.id)).toContain(item.id);
    expect(recoveries).toBe(1);
  } finally { await f.close(); }
});

test("M2 retains a remote completion receipt through local persistence failure", async () => {
  let sends = 0;
  const f = await fixture({ reply: async reply => { if (reply.markdown.includes("全部步骤已验收")) sends++; return { messageId: "remote-receipt" }; } });
  try {
    await f.send("m2-receipt");
    const item = f.engine.workItems.list(SPACE)[0]!;
    const scheduler = new WorkContinuationScheduler(f.engine);
    await scheduler.wake(item.id); await scheduler.wake(item.id);
    const save = f.engine.workEvents.save.bind(f.engine.workEvents);
    let failed = false;
    const fail = spyOn(f.engine.workEvents, "save").mockImplementation(notice => {
      if (notice.kind === "completion" && notice.status === "sent" && !failed) { failed = true; throw new Error("injected receipt failure"); }
      return save(notice);
    });
    await f.runtime.processWorkEvents();
    expect(f.engine.workEvents.list().find(notice => notice.kind === "completion")?.status).toBe("failed");
    await f.runtime.processWorkEvents();
    fail.mockRestore();
    expect(sends).toBe(1);
    expect(f.engine.workEvents.list().find(notice => notice.kind === "completion")?.messageId).toBe("remote-receipt");
  } finally { await f.close(); }
});

test("M2 leaves an interrupted planner failed and does not replay it after restart", async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let recoveries = 0;
  const fake = new FakeLlm().onJSON(call => JSON.parse(call.prompt ?? "{}").recoveryContext
    ? { kind: "wait", reason: "缺数据", question: "数据在哪？" } : planResult);
  const planner: LlmClient = { complete: opts => fake.complete(opts), async completeJSON(opts) {
    if (JSON.parse(opts.prompt ?? "{}").recoveryContext) { recoveries++; entered.resolve(); await release.promise; }
    return fake.completeJSON(opts);
  } };
  const f = await fixture({ planner, runner: async () => blockedResult() });
  try {
    await f.send("m2-stop");
    const item = f.engine.workItems.list(SPACE)[0]!;
    await new WorkContinuationScheduler(f.engine).wake(item.id);
    const processing = f.runtime.processWorkEvents();
    await entered.promise;
    await f.runtime.stop();
    await processing;
    release.resolve();
    await f.reopen();
    await f.runtime.processWorkEvents();
    expect(recoveries).toBe(1);
    expect(f.engine.workEvents.listRecoveries()[0]?.status).toBe("failed");
    expect(f.engine.getWorkPlanView(item.id)?.current.revision).toBe(1);
  } finally { release.resolve(); await f.close(); }
});

test("M2 a late recovery decision cannot replace a user's newer plan", async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const fake = new FakeLlm().onJSON(call => JSON.parse(call.prompt ?? "{}").recoveryContext
    ? { kind: "plan", reason: "使用备用资料", steps: [{ instruction: "旧的自动修订", doneWhen: "旧标准" }] } : planResult);
  const planner: LlmClient = { complete: opts => fake.complete(opts), async completeJSON(opts) {
    if (JSON.parse(opts.prompt ?? "{}").recoveryContext) { entered.resolve(); await release.promise; }
    return fake.completeJSON(opts);
  } };
  const f = await fixture({ planner, runner: async () => blockedResult() });
  try {
    await f.send("m2-stale");
    const item = f.engine.workItems.list(SPACE)[0]!;
    await new WorkContinuationScheduler(f.engine).wake(item.id);
    const processing = f.runtime.processWorkEvents(); await entered.promise;
    const prepared = f.engine.prepareWorkPlanRevision(item.id, { kind: "manual", id: "manual_new_facts" });
    f.engine.commitWorkPlanRevision(prepared, [{ instruction: "用户已确认的新方案", doneWhen: "按新资料完成" }]);
    release.resolve(); await processing;
    expect(f.engine.getWorkPlanView(item.id)?.remaining[0]?.instruction).toBe("用户已确认的新方案");
    expect(f.engine.workEvents.listRecoveries()[0]?.status).toBe("obsolete");
  } finally { release.resolve(); await f.close(); }
});

test("M2 does not block an independent item while another item is replanning", async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const fake = new FakeLlm().onJSON(call => JSON.parse(call.prompt ?? "{}").recoveryContext
    ? { kind: "wait", reason: "缺数据", question: "数据在哪？" } : planResult);
  const planner: LlmClient = { complete: opts => fake.complete(opts), async completeJSON(opts) {
    if (JSON.parse(opts.prompt ?? "{}").recoveryContext) { entered.resolve(); await release.promise; }
    return fake.completeJSON(opts);
  } };
  let executions = 0;
  const f = await fixture({ planner, runner: async () => ++executions === 1 ? blockedResult() : result("第二个事项的独立成果") });
  try {
    await f.send("m2-parallel-a", "新建独立事项「A」，分步整理资料并生成摘要");
    const first = f.engine.workItems.list(SPACE)[0]!;
    await new WorkContinuationScheduler(f.engine).wake(first.id);
    const processing = f.runtime.processWorkEvents(); await entered.promise;
    await f.send("m2-parallel-b", "新建独立事项「B」，分步汇总测试数据并生成周报");
    const second = f.engine.workItems.list(SPACE).find(item => item.id !== first.id)!;
    await new WorkContinuationScheduler(f.engine).wake(second.id);
    expect(f.engine.workItems.get(second.id)?.completedActionIds).toHaveLength(1);
    expect(f.engine.workItems.get(first.id)?.phase).toBe("blocked");
    release.resolve(); await processing;
  } finally { release.resolve(); await f.close(); }
});

test("M2 pending recovery receipts gate continuation and retry the same delivery identity after restart", async () => {
  let offline = true, calls = 0;
  const keys: string[] = [];
  const planner = new FakeLlm().onJSON(call => JSON.parse(call.prompt ?? "{}").recoveryContext
    ? { kind: "plan", reason: "改用备用资料", steps: [{ instruction: "读取备用资料", doneWhen: "取得真实数据" }] } : planResult);
  const f = await fixture({ planner, runner: async () => { calls++; return blockedResult(); }, reply: async reply => {
    if (reply.markdown.includes("已根据阻塞修订")) { keys.push(reply.idempotencyKey!); if (offline) throw new Error("fixture offline"); }
  } });
  try {
    await f.send("m2-delivery");
    const item = f.engine.workItems.list(SPACE)[0]!;
    await new WorkContinuationScheduler(f.engine).wake(item.id);
    await f.runtime.processWorkEvents();
    expect(f.engine.listDueWorkContinuations()).toEqual([]);
    expect(() => f.engine.startWorkContinuation(item.id)).toThrow("receipt");
    await f.reopen(); offline = false;
    const retryAt = f.engine.workEvents.list().find(notice => notice.kind === "replanned")!.nextAttemptAt!;
    const clock = spyOn(Date, "now").mockReturnValue(retryAt);
    try { await f.runtime.processWorkEvents(); } finally { clock.mockRestore(); }
    expect(new Set(keys).size).toBe(1);
    expect(keys).toHaveLength(2);
    expect(f.engine.listDueWorkContinuations().map(item => item.id)).toContain(item.id);
    expect(calls).toBe(1);
  } finally { await f.close(); }
});

test("M2 a planner cannot disguise unchanged failed work as an automatic retry", async () => {
  let executions = 0;
  const planner = new FakeLlm().onJSON(call => JSON.parse(call.prompt ?? "{}").recoveryContext
    ? { ...planResult, reason: "再试一次原步骤" } : planResult);
  const f = await fixture({ planner, runner: async () => { executions++; return blockedResult(); } });
  try {
    await f.send("m2-unchanged");
    const item = f.engine.workItems.list(SPACE)[0]!;
    await new WorkContinuationScheduler(f.engine).wake(item.id);
    await f.runtime.processWorkEvents();
    await new WorkContinuationScheduler(f.engine).wake(item.id);
    await f.runtime.processWorkEvents();
    expect(executions).toBe(1);
    expect(f.engine.getWorkPlanView(item.id)?.current.revision).toBe(1);
    expect(f.engine.workEvents.listRecoveries()[0]?.status).toBe("failed");
  } finally { await f.close(); }
});

test("M2 uncertain external effects are available to a verification step as unaccepted evidence", async () => {
  let executions = 0;
  const prompts: string[] = [];
  const planner = new FakeLlm().onJSON(call => {
    if (!JSON.parse(call.prompt ?? "{}").recoveryContext) return planResult;
    expect(call.system).toContain("首步必须使用该系统实际查询能力核对已有结果");
    expect(call.prompt).toContain("提交回执丢失，单号fixture-42是否已生效未知");
    return { kind: "plan", reason: "先核对提交结果", steps: [{ instruction: "查询单号fixture-42的实际状态，不重新提交", doneWhen: "确认已有提交的状态" }] };
  });
  const f = await fixture({ planner, runner: async (_provider, input) => {
    prompts.push(input.prompt);
    return ++executions === 1 ? blockedResult("提交回执丢失，单号fixture-42是否已生效未知") : result("已查询，fixture-42已生效，没有重复提交");
  } });
  try {
    await f.send("m2-uncertain");
    const item = f.engine.workItems.list(SPACE)[0]!;
    await new WorkContinuationScheduler(f.engine).wake(item.id);
    await f.runtime.processWorkEvents();
    await new WorkContinuationScheduler(f.engine).wake(item.id);
    expect(prompts[1]).toContain("未通过验收，不代表操作成功");
    expect(prompts[1]).toContain("单号fixture-42是否已生效未知");
    expect(prompts[1]).toContain("查询单号fixture-42的实际状态，不重新提交");
    expect(f.engine.workItems.get(item.id)?.phase).toBe("completed");
  } finally { await f.close(); }
});

test("M2 retracting the original source retires queued recovery without leaving a governance blocker", async () => {
  const f = await fixture({ runner: async () => blockedResult() });
  try {
    await f.send("m2-retracted");
    const item = f.engine.workItems.list(SPACE)[0]!;
    await new WorkContinuationScheduler(f.engine).wake(item.id);
    const [event] = f.engine.prepareWorkRecoveries("冻结的规划指令");
    expect(event?.status).toBe("queued");
    f.engine.workDispatch.removeByMessage(SPACE, "oc_planning", "m2-retracted");
    await f.runtime.processWorkEvents();
    expect(f.engine.workEvents.getRecovery(event!.id)?.status).toBe("obsolete");
    expect(f.engine.workEvents.hasActive(SPACE)).toBe(false);
    expect(f.engine.getWorkPlanView(item.id)?.current.revision).toBe(1);
  } finally { await f.close(); }
});

test("an in-flight supplement revises only remaining work after the current result is accepted", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  const prompts: string[] = [];
  const planner = new FakeLlm().onJSON(call => JSON.parse(call.prompt ?? "{}").revisionContext
    ? { kind: "plan", steps: [{ instruction: "生成包含阻塞原因的周报", doneWhen: "摘要不超过100字" }] }
    : planResult);
  const f = await fixture({ planner, runner: async (_provider, input) => {
    prompts.push(input.prompt);
    if (prompts.length === 1) { began(); await gate; }
    return result(prompts.length === 1 ? "已完成12项、进行中5项、阻塞3项，总数20" : "总数20，阻塞原因是资料待补齐。");
  } });
  try {
    await f.send("m1-goal");
    const item = f.engine.workItems.list(SPACE)[0]!;
    const scheduler = new WorkContinuationScheduler(f.engine);
    const first = scheduler.tick("m1-first");
    await started;
    await f.send("m1-supplement", "周报请增加阻塞原因，摘要限制100字", { parentMessageId: "m1-goal" });
    expect(prompts).toHaveLength(1);
    release();
    await first;
    const accepted = f.engine.workContinuations.list(item.id).find(action => action.status === "succeeded")!;
    f.runtime.flushWorkInputs();
    await f.send("m1-supplement", "周报请增加阻塞原因，摘要限制100字", { parentMessageId: "m1-goal" });
    const view = f.engine.getWorkPlanView(item.id)!;
    expect(view.current.revision).toBe(2);
    expect(view.remaining.map(step => step.instruction)).toEqual(["生成包含阻塞原因的周报"]);
    expect(f.engine.workContinuations.get(accepted.id)?.checkpoint).toEqual(accepted.checkpoint);
    await scheduler.tick("m1-second");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("摘要不超过100字");
    expect(prompts[1]).toContain("总数20");
    expect(f.engine.workItems.get(item.id)?.phase).toBe("completed");
    expect(chatWorkNotification(f.engine, f.engine.listTaskRuns().find(run => run.id !== accepted.checkpoint?.taskRunId)!)?.replyToMessageId).toBe("m1-goal");
  } finally { release(); await f.close(); }
});

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
    isChatAdministrator: async () => true,
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

test.each([false, true])("a revision preserves an unchanged approval or replaces only the changed pending step (%s)", async changedFirst => {
  const planner = new FakeLlm().onJSON(call => JSON.parse(call.prompt ?? "{}").revisionContext
    ? { kind: "plan", steps: [changedFirst ? { instruction: "收集各部门进展", doneWhen: "按部门分组" } : planResult.steps[0],
      { instruction: "生成短周报", doneWhen: "100字以内" }] } : planResult);
  const f = await fixture({ planner, full: true });
  try {
    await f.send("pending-plan");
    const item = f.engine.workItems.list(SPACE)[0]!;
    const scheduler = new WorkContinuationScheduler(f.engine);
    await scheduler.wake(item.id);
    const original = f.engine.listTaskRuns()[0]!;
    await f.send("pending-change", changedFirst ? "第一步改成按部门收集进展，周报限制100字" : "周报限制100字，第一步保持原样", { parentMessageId: "pending-plan" });
    expect(f.engine.getWorkPlanView(item.id)?.current.revision).toBe(2);
    expect(f.engine.getTaskRun(original.id)?.status).toBe(changedFirst ? "cancelled" : "awaiting_approval");
    if (changedFirst) {
      await scheduler.wake(item.id);
      const next = f.engine.listTaskRuns().find(run => run.id !== original.id)!;
      expect(next.status).toBe("awaiting_approval");
      expect(next.approval?.status).toBe("pending");
      expect(next.workActionId).not.toBe(original.workActionId);
    } else expect(f.engine.listTaskRuns()).toHaveLength(1);
    expect(f.prompts).toHaveLength(0);
  } finally { await f.close(); }
});

test("approval during replanning refreshes the snapshot without losing the supplement", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let revisions = 0;
  const fake = new FakeLlm().onJSON(call => JSON.parse(call.prompt ?? "{}").revisionContext
    ? { kind: "plan", steps: [planResult.steps[0], { instruction: "生成短周报", doneWhen: "100字以内" }] } : planResult);
  const planner: LlmClient = { complete: opts => fake.complete(opts), async completeJSON(opts) {
    if (JSON.parse(opts.prompt ?? "{}").revisionContext && ++revisions === 1) { entered.resolve(); await release.promise; }
    return fake.completeJSON(opts);
  } };
  const f = await fixture({ planner, full: true, runner: async (_provider, input) => {
    const permit = input.acquireExecutionPermit!();
    const unregister = permit.register(() => {}); permit.release(); unregister();
    return result("20项真实测试数据");
  } });
  try {
    await f.send("racing-plan");
    const item = f.engine.workItems.list(SPACE)[0]!;
    await new WorkContinuationScheduler(f.engine).wake(item.id);
    const run = f.engine.listTaskRuns()[0]!;
    const revised = f.send("racing-change", "周报改成100字以内", { parentMessageId: "racing-plan" });
    await entered.promise;
    const approved = f.engine.approveTaskRun(run.id, "local-operator");
    release.resolve();
    await revised;
    await approved.completion;
    expect(f.engine.workContinuations.get(run.workActionId!)?.status).toBe("awaiting_acceptance");
    f.engine.acceptWorkAction(run.workActionId!, run.id, "local-operator");
    expect(f.engine.getWorkPlanView(item.id)?.remaining.map(step => step.instruction)).toEqual(["生成短周报"]);
    expect(f.engine.workItems.get(item.id)?.completedActionIds).toEqual([run.workActionId!]);
    expect(f.engine.listTaskRuns()).toHaveLength(1);
  } finally { release.resolve(); await f.close(); }
});

test("a concurrent manual plan edit cannot be overwritten by a late model revision", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let revisions = 0;
  const fake = new FakeLlm().onJSON(call => {
    const context = JSON.parse(call.prompt ?? "{}").revisionContext;
    return context ? { kind: "plan", steps: [{ instruction: context.goal.includes("风险") ? "生成包含风险的短周报" : "生成短周报", doneWhen: "100字以内" }] } : planResult;
  });
  const planner: LlmClient = { complete: opts => fake.complete(opts), async completeJSON(opts) {
    if (JSON.parse(opts.prompt ?? "{}").revisionContext && ++revisions === 1) { entered.resolve(); await release.promise; }
    return fake.completeJSON(opts);
  } };
  const f = await fixture({ planner });
  try {
    await f.send("manual-race");
    const item = f.engine.workItems.list(SPACE)[0]!;
    const revised = f.send("manual-race-change", "摘要限制100字", { parentMessageId: "manual-race" });
    void revised.catch(() => {});
    await entered.promise;
    f.engine.updateWorkItem(item.id, { brief: "周报必须包含风险" }, item.planRef!.revision);
    release.resolve();
    await revised;
    expect(f.engine.getWorkPlanView(item.id)?.remaining[0]?.instruction).toBe("生成包含风险的短周报");
    expect(f.engine.getWorkPlanView(item.id)?.current.revision).toBe(3);
  } finally { release.resolve(); await f.close(); }
});

test("held final results and queued supplements survive restart without completing or replaying accepted work", async () => {
  const planner = new FakeLlm().onJSON(call => JSON.parse(call.prompt ?? "{}").revisionContext
    ? { kind: "plan", steps: [{ instruction: "生成短摘要", doneWhen: "100字以内" }] }
    : { kind: "plan", steps: [planResult.steps[0]] });
  let executions = 0;
  const f = await fixture({ planner, full: true, runner: async (_provider, input) => {
    const permit = input.acquireExecutionPermit!();
    const unregister = permit.register(() => {}); permit.release(); unregister();
    executions++;
    return result("已完成12项，进行中5项，阻塞3项，总数20");
  } });
  try {
    await f.send("held-goal");
    const item = f.engine.workItems.list(SPACE)[0]!;
    await new WorkContinuationScheduler(f.engine).wake(item.id);
    const first = f.engine.listTaskRuns()[0]!;
    await f.engine.approveTaskRun(first.id, "local-operator").completion;
    await f.send("held-change", "增加100字以内的摘要", { parentMessageId: "held-goal" });
    expect(f.engine.workDispatch.list(SPACE).find(input => input.message.messageId === "held-change")?.state).toBe("waiting");
    await f.reopen();
    expect(executions).toBe(1);
    expect(f.engine.workContinuations.get(first.workActionId!)?.status).toBe("awaiting_acceptance");
    f.engine.acceptWorkAction(first.workActionId!, first.id, "local-operator");
    expect(f.engine.workItems.get(item.id)?.phase).toBe("active");
    f.runtime.flushWorkInputs();
    await f.send("held-change", "增加100字以内的摘要", { parentMessageId: "held-goal" });
    expect(f.engine.getWorkPlanView(item.id)?.current.acceptedActionIds).toEqual([first.workActionId!]);
    await new WorkContinuationScheduler(f.engine).wake(item.id);
    const second = f.engine.listTaskRuns().find(run => run.id !== first.id)!;
    expect(second.status).toBe("awaiting_approval");
    await f.engine.approveTaskRun(second.id, "local-operator").completion;
    f.engine.acceptWorkAction(second.workActionId!, second.id, "local-operator");
    expect(f.engine.workItems.get(item.id)?.phase).toBe("completed");
    expect(executions).toBe(2);
    await f.reopen();
    expect(f.engine.workItems.get(item.id)?.completedActionIds).toHaveLength(2);
    expect(await new WorkContinuationScheduler(f.engine).tick("already-complete")).toEqual([]);
    expect(executions).toBe(2);
  } finally { await f.close(); }
});

test.each(["paused", "disabled"])("revisions preserve the user's continuation choice: %s", async mode => {
  const planner = new FakeLlm().onJSON(call => JSON.parse(call.prompt ?? "{}").revisionContext
    ? { kind: "plan", steps: [{ instruction: "生成短摘要", doneWhen: "100字以内" }] } : planResult);
  const f = await fixture({ planner });
  try {
    await f.send("choice-goal");
    const item = f.engine.workItems.list(SPACE)[0]!;
    await new WorkContinuationScheduler(f.engine).wake(item.id);
    if (mode === "paused") await f.send("choice-pause", "暂停", { parentMessageId: "choice-goal" });
    else f.engine.configureWorkContinuation(item.id, false);
    await f.send("choice-change", "周报改成100字以内的摘要", { parentMessageId: "choice-goal" });
    expect(f.engine.getWorkPlanView(item.id)?.current.revision).toBe(2);
    await f.reopen();
    expect(f.engine.listDueWorkContinuations()).toEqual([]);
    expect(f.prompts).toHaveLength(1);
    expect(f.engine.workItems.get(item.id)?.completedActionIds).toHaveLength(1);
  } finally { await f.close(); }
});

test.each([false, true])("a completed item accepts new work while respecting a later pause (%s)", async paused => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const fake = new FakeLlm().onJSON(call => ({ kind: "plan", steps: JSON.parse(call.prompt ?? "{}").revisionContext
    ? [{ instruction: "生成短摘要", doneWhen: "100字以内" }] : [planResult.steps[0]] }));
  const planner: LlmClient = { complete: opts => fake.complete(opts), async completeJSON(opts) {
    if (JSON.parse(opts.prompt ?? "{}").revisionContext) { entered.resolve(); await release.promise; }
    return fake.completeJSON(opts);
  } };
  const f = await fixture({ planner });
  try {
    await f.send("completed-goal");
    const item = f.engine.workItems.list(SPACE)[0]!;
    await new WorkContinuationScheduler(f.engine).wake(item.id);
    expect(f.engine.workItems.get(item.id)?.phase).toBe("completed");
    const pending = f.send("completed-change", "再做一份摘要，限制100字", { parentMessageId: "completed-goal" });
    await entered.promise;
    if (paused) await f.send("completed-pause", "暂停", { parentMessageId: "completed-goal" });
    release.resolve(); await pending;
    expect(f.engine.getWorkPlanView(item.id)?.remaining).toHaveLength(1);
    expect(f.engine.workItems.get(item.id)?.active).toBe(!paused);
    expect(f.engine.listDueWorkContinuations().length).toBe(paused ? 0 : 1);
  } finally { release.resolve(); await f.close(); }
});

test("failed revision delivery reuses its revision after restart and keeps the original result destination", async () => {
  let deliveries = 0;
  const planner = new FakeLlm().onJSON(call => JSON.parse(call.prompt ?? "{}").revisionContext
    ? { kind: "plan", steps: [{ instruction: "生成短摘要", doneWhen: "100字以内" }] } : planResult);
  const f = await fixture({ planner, reply: async () => { if (++deliveries === 2) throw new Error("offline receipt"); } });
  try {
    await f.send("revised-receipt-goal");
    const item = f.engine.workItems.list(SPACE)[0]!;
    await new WorkContinuationScheduler(f.engine).wake(item.id);
    await f.send("revised-receipt-change", "周报改成100字以内摘要", { parentMessageId: "revised-receipt-goal" }).catch(() => {});
    const revised = f.engine.workItems.get(item.id)!;
    expect(revised.planRef?.revision).toBe(2);
    expect(f.engine.listDueWorkContinuations()).toEqual([]);
    await f.reopen();
    await f.runtime.retryChatRun(revised.planDelivery!.runId);
    expect(f.engine.workItems.get(item.id)?.planRef).toEqual(revised.planRef);
    expect(planner.calls).toHaveLength(2);
    await new WorkContinuationScheduler(f.engine).wake(item.id);
    expect(f.prompts).toHaveLength(2);
    expect(chatWorkNotification(f.engine, f.engine.listTaskRuns()[0]!)?.replyToMessageId).toBe("revised-receipt-goal");
  } finally { await f.close(); }
});

test("two queued amendments compose in source order and keep accepted work", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const contexts: string[] = [];
  const planner = new FakeLlm().onJSON(call => {
    const input = JSON.parse(call.prompt ?? "{}");
    if (!input.revisionContext) return planResult;
    contexts.push(input.revisionContext.goal);
    return { kind: "plan", steps: [{ instruction: input.goal.includes("风险") ? "生成包含风险的摘要" : "生成摘要", doneWhen: "100字以内" }] };
  });
  const f = await fixture({ planner, runner: async () => { entered.resolve(); await release.promise; return result("总数20"); } });
  let execution: Promise<void> | undefined;
  try {
    await f.send("ordered-goal");
    const item = f.engine.workItems.list(SPACE)[0]!;
    execution = new WorkContinuationScheduler(f.engine).wake(item.id);
    await entered.promise;
    await f.send("ordered-first", "摘要限制100字", { parentMessageId: "ordered-goal" });
    await f.send("ordered-second", "摘要增加风险", { parentMessageId: "ordered-goal" });
    release.resolve(); await execution;
    f.runtime.flushWorkInputs();
    await f.send("ordered-first", "摘要限制100字", { parentMessageId: "ordered-goal" });
    f.runtime.flushWorkInputs();
    await f.send("ordered-second", "摘要增加风险", { parentMessageId: "ordered-goal" });
    expect(contexts).toHaveLength(2);
    expect(contexts[1]).toContain("摘要限制100字");
    expect(f.engine.getWorkPlanView(item.id)?.current.revision).toBe(3);
    expect(f.engine.getWorkPlanView(item.id)?.remaining[0]?.instruction).toBe("生成包含风险的摘要");
    expect(f.engine.workItems.get(item.id)?.completedActionIds).toHaveLength(1);
    expect(f.engine.listTaskRuns()).toHaveLength(1);
  } finally { release.resolve(); await execution; await f.close(); }
});

test("identically worded steps keep separate identities and are each consumed once", async () => {
  const f = await fixture({ planner: new FakeLlm().onJSON(() => ({ kind: "plan", steps: [planResult.steps[0], planResult.steps[0]] })) });
  try {
    await f.send("identical-goal");
    const item = f.engine.workItems.list(SPACE)[0]!;
    expect(new Set(item.nextStepIds).size).toBe(2);
    const scheduler = new WorkContinuationScheduler(f.engine);
    await scheduler.wake(item.id);
    await f.reopen();
    await new WorkContinuationScheduler(f.engine).wake(item.id);
    expect(f.prompts).toHaveLength(2);
    expect(new Set(f.engine.workContinuations.list(item.id).map(action => action.planStep?.stepId)).size).toBe(2);
    expect(f.engine.workItems.get(item.id)?.phase).toBe("completed");
  } finally { await f.close(); }
});

test("restart repairs an accepted structured step after projection failure without running it again", async () => {
  const f = await fixture();
  try {
    await f.send("projection-goal");
    const item = f.engine.workItems.list(SPACE)[0]!;
    const projection = spyOn(f.engine.workItems, "applyActionCheckpoint").mockImplementation(() => { throw new Error("injected projection failure"); });
    let failed: unknown;
    try { await new WorkContinuationScheduler(f.engine).wake(item.id); }
    catch (error) { failed = error; }
    finally { projection.mockRestore(); }
    expect(String(failed)).toContain("projection failure");
    expect(f.engine.workContinuations.list(item.id)[0]?.status).toBe("succeeded");
    expect(f.engine.workItems.get(item.id)?.nextActions).toHaveLength(2);
    await f.reopen();
    expect(f.engine.workItems.get(item.id)?.nextActions).toHaveLength(1);
    expect(f.engine.workItems.get(item.id)?.completedActionIds).toHaveLength(1);
    expect(f.prompts).toHaveLength(1);
    await new WorkContinuationScheduler(f.engine).wake(item.id);
    expect(f.prompts).toHaveLength(2);
    expect(f.engine.workItems.get(item.id)?.phase).toBe("completed");
  } finally { await f.close(); }
});

test("manual edits preserve an in-flight step and stale forms cannot restore accepted steps", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const f = await fixture({ runner: async () => { entered.resolve(); await release.promise; return result("汇总已完成"); } });
  let execution: Promise<string[]> | undefined;
  try {
    await f.send("manual-running");
    const item = f.engine.workItems.list(SPACE)[0]!;
    execution = new WorkContinuationScheduler(f.engine).tick("manual-running");
    await entered.promise;
    f.engine.updateWorkItem(item.id, { nextActions: [item.nextActions[0]!, "生成100字摘要"] });
    const editing = f.engine.getWorkPlanView(item.id)!;
    const displayed = f.engine.workItems.get(item.id)!;
    expect(editing.current.revision).toBe(2);
    release.resolve(); await execution;
    expect(f.engine.workItems.get(item.id)?.nextActions).toEqual(["生成100字摘要"]);
    expect(() => f.engine.updateWorkItem(item.id, { nextActions: displayed.nextActions }, editing.current.revision,
      editing.progressToken)).toThrow("进展已更新");
    expect(f.engine.workItems.get(item.id)?.completedActionIds).toHaveLength(1);
  } finally { release.resolve(); await execution; await f.close(); }
});

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
    expect(f.transport.sent.at(-1)?.markdown).toContain("本步已通过验收");
    await f.runtime.processWorkEvents();
    expect(f.transport.sent.at(-1)?.markdown).toContain("全部步骤已验收，事项已完成");
    expect(f.transport.sent.filter(reply => reply.markdown.includes("全部步骤已验收"))).toHaveLength(1);
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

test("v23 archives restore revised plans with accepted evidence and reject broken graphs before mutation", async () => {
  const planner = new FakeLlm().onJSON(call => JSON.parse(call.prompt ?? "{}").revisionContext
    ? { kind: "plan", steps: [{ instruction: "生成短摘要", doneWhen: "100字以内" }] } : planResult);
  const f = await fixture({ planner });
  const targetDir = mkdtempSync(join(tmpdir(), "ha-revised-archive-"));
  const target = new KnowledgeEngine({ dataDir: targetDir, skillCatalog: new SkillCatalog({ roots: [] }) });
  try {
    await f.send("archive-revised-goal");
    const item = f.engine.workItems.list(SPACE)[0]!;
    await new WorkContinuationScheduler(f.engine).wake(item.id);
    const accepted = f.engine.workContinuations.list(item.id)[0]!;
    await f.send("archive-revised-change", "周报改成100字以内的摘要", { parentMessageId: "archive-revised-goal" });
    const archive = await f.engine.exportSpace(SPACE);
    expect(archive.version).toBe(24);
    expect(archive.workPlans).toHaveLength(2);
    expect(archive.workItems[0]?.planDelivery).toBeUndefined();
    const missing = structuredClone(archive);
    missing.workPlans.shift();
    await expect(target.restoreSpace(missing)).rejects.toThrow();
    expect(target.registry.has(SPACE)).toBe(false);
    expect(target.workItems.list()).toEqual([]);
    const forged = structuredClone(archive);
    forged.workActions[0]!.planStep!.stepId = "step_00000000000000000000000000000000";
    expect(() => parseSpaceArchive(forged)).toThrow();
    const wrongSource = structuredClone(archive);
    const revisionSource = wrongSource.chatRuns.find(run => run.id === wrongSource.workPlans[1]!.source.id)!;
    delete revisionSource.workItemId;
    expect(() => parseSpaceArchive(wrongSource)).toThrow("revision source");
    await target.restoreSpace(archive);
    expect(target.getWorkPlanView(item.id)?.history.map(plan => plan.revision)).toEqual([2, 1]);
    expect(target.workItems.get(item.id)?.completedActionIds).toEqual([accepted.id]);
    expect(target.workContinuations.get(accepted.id)?.checkpoint).toEqual(accepted.checkpoint);
    expect(target.getWorkPlanView(item.id)?.remaining.map(step => step.instruction)).toEqual(["生成短摘要"]);
    await target.deleteSpace(SPACE);
    expect(target.workItems.plans.snapshot(item.id)).toEqual([]);
    await target.restoreSpace(archive);
    expect(target.getWorkPlanView(item.id)?.history).toHaveLength(2);
  } finally { target.close(); rmSync(targetDir, { recursive: true, force: true }); await f.close(); }
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
