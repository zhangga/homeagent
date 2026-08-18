import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeLlm, KnowledgeEngine } from "@homeagent/core";
import { createSystemHealthReporter } from "./health.ts";

const loopHealth = {
  started: true,
  running: false,
  lastSuccessAt: 1_783_932_000_000,
};

describe("system health reporter", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test("is ready only when storage, required CLIs, Feishu consumers, and schedulers are healthy", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hb-health-"));
    dirs.push(dir);
    const engine = new KnowledgeEngine({ dataDir: dir, runProvider: async () => "ok" });
    engine.ensureSpace("team/oc_health", { chatId: "oc_health" });
    engine.reminders.create({
      title: "私密体检预约",
      space: "team/oc_health",
      chatId: "oc_health_private",
      creatorId: "ou_private",
      triggerAt: 1_783_932_100_000,
    }, 1_783_932_000_000);
    engine.learning.create({
      name: "私密阅读计划",
      space: "team/oc_health",
      chatId: "oc_health_private",
      creatorId: "ou_private",
      sourceTitle: "private-book.md",
      sourceContent: "private content",
      sourceRawIds: ["raw_private"],
      sourceMessageId: "om_private",
    }, 1_783_932_000_000);

    const reportHealth = createSystemHealthReporter({
      engine,
      connectorHealth: () => ({
        name: "feishu",
        ready: true,
        lastEventAt: 1_783_932_000_000,
        consumers: [
          { key: "im.message.receive_v1", state: "ready", attempts: 0 },
          { key: "im.chat.member.bot.added_v1", state: "ready", attempts: 0 },
        ],
      }),
      dreamSchedulerHealth: () => loopHealth,
      taskSchedulerHealth: () => loopHealth,
      reminderSchedulerHealth: () => loopHealth,
      learningSchedulerHealth: () => loopHealth,
      serviceHealth: () => ({
        managed: true,
        pid: 7788,
        startedAt: 1_783_931_000_000,
      }),
      detectProviders: async () => [
        { id: "codex", name: "Codex", bin: "codex", available: true, detail: "1.0" },
      ],
      requiredProviderIds: () => ["codex"],
      now: () => 1_783_932_000_000,
    });

    const snapshot = await reportHealth();
    expect(snapshot.ready).toBe(true);
    expect(snapshot.status).toBe("ok");
    expect(snapshot.components.reminders?.summary).toBe("1 个待提醒，1 个提醒记录");
    expect(snapshot.components.learning?.summary).toBe("1 个进行中，0 个等待回答");
    expect(JSON.stringify(snapshot)).not.toContain("私密体检预约");
    expect(JSON.stringify(snapshot)).not.toContain("oc_health_private");
    expect(JSON.stringify(snapshot)).not.toContain("私密阅读计划");
    expect(snapshot.components).toEqual(
      expect.objectContaining({
        knowledge: expect.objectContaining({ status: "ok" }),
        providers: expect.objectContaining({ status: "ok" }),
        feishu: expect.objectContaining({ status: "ok" }),
        dreamCycles: expect.objectContaining({ status: "ok" }),
        tasks: expect.objectContaining({ status: "ok" }),
        reminders: expect.objectContaining({ status: "ok" }),
        learning: expect.objectContaining({ status: "ok" }),
        dreamScheduler: expect.objectContaining({ status: "ok" }),
        taskScheduler: expect.objectContaining({ status: "ok" }),
        reminderScheduler: expect.objectContaining({ status: "ok" }),
        learningScheduler: expect.objectContaining({ status: "ok" }),
        service: expect.objectContaining({
          status: "ok",
          details: expect.objectContaining({ managed: true, pid: 7788 }),
        }),
      }),
    );
    engine.close();
  });

  test("manual foreground runtime is visible but does not make readiness fail", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hb-health-service-"));
    dirs.push(dir);
    const engine = new KnowledgeEngine({ dataDir: dir, runProvider: async () => "ok" });
    const reportHealth = createSystemHealthReporter({
      engine,
      connectorHealth: () => ({
        name: "feishu",
        ready: true,
        consumers: [
          { key: "im.message.receive_v1", state: "ready", attempts: 0 },
          { key: "im.chat.member.bot.added_v1", state: "ready", attempts: 0 },
        ],
      }),
      dreamSchedulerHealth: () => loopHealth,
      taskSchedulerHealth: () => loopHealth,
      serviceHealth: () => ({ managed: false, pid: 8899, startedAt: 1_783_931_000_000 }),
      detectProviders: async () => [
        { id: "claude", name: "Claude", bin: "claude", available: true, detail: "2.0" },
      ],
      requiredProviderIds: () => ["claude"],
    });

    const snapshot = await reportHealth();
    expect(snapshot.ready).toBe(true);
    expect(snapshot.status).toBe("degraded");
    expect(snapshot.components.service).toEqual(expect.objectContaining({
      status: "degraded",
      summary: "当前为终端前台运行（PID 8899）",
    }));
    engine.close();
  });

  test("reports an intentional HomeAgent-local Feishu disable distinctly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hb-health-feishu-disabled-"));
    dirs.push(dir);
    const engine = new KnowledgeEngine({ dataDir: dir, runProvider: async () => "ok" });
    const reportHealth = createSystemHealthReporter({
      engine,
      connectorHealth: () => ({
        name: "feishu",
        ready: false,
        consumers: [],
      }),
      feishuLocallyDisabled: () => true,
      dreamSchedulerHealth: () => loopHealth,
      taskSchedulerHealth: () => loopHealth,
      detectProviders: async () => [
        { id: "codex", name: "Codex", bin: "codex", available: true, detail: "1.0" },
      ],
      requiredProviderIds: () => ["codex"],
    });

    const snapshot = await reportHealth();

    expect(snapshot.components.feishu).toMatchObject({
      status: "degraded",
      summary: "飞书连接已在 HomeAgent 中停用",
      details: { locallyDisabled: true },
    });
    engine.close();
  });

  test("AI runtime health distinguishes normal, backlog, and recent answer failures", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hb-health-ai-runtime-"));
    dirs.push(dir);
    const engine = new KnowledgeEngine({ dataDir: dir, runProvider: async () => "ok" });
    const runtime = {
      queue: {
        key: "main",
        queued: 0,
        running: 0,
        pending: 0,
        maxPending: 0,
        completed: 100,
        failed: 0,
        averageWaitMs: 30,
        maxWaitMs: 120,
        averageDurationMs: 500,
        maxDurationMs: 2000,
      },
      runs: {
        queued: 0,
        running: 0,
        completed: 10,
        failed: 0,
        cancelled: 0,
        timedOut: 0,
        limited: 0,
        averageWaitMs: 0,
        maxWaitMs: 0,
      },
      events: {
        total: 100,
        completed: 100,
        failed: 0,
        averageLatencyMs: 500,
        maxLatencyMs: 2000,
      },
      answers: {
        total: 10,
        succeeded: 10,
        failed: 0,
        timedOut: 0,
        averageLatencyMs: 800,
        maxLatencyMs: 2500,
        recent: {
          sampleSize: 10,
          succeeded: 10,
          failed: 0,
          timedOut: 0,
          failureRate: 0,
          errorRate: 0,
          timeoutRate: 0,
        },
      },
      proactiveParticipation: {
        evaluated: 20,
        responded: 4,
        skipped: 16,
        model: 18,
        guard: 1,
        fallback: 1,
      },
    };
    const reportHealth = createSystemHealthReporter({
      engine,
      connectorHealth: () => ({
        name: "feishu",
        ready: true,
        consumers: [
          { key: "im.message.receive_v1", state: "ready", attempts: 0 },
          { key: "im.chat.member.bot.added_v1", state: "ready", attempts: 0 },
        ],
      }),
      dreamSchedulerHealth: () => loopHealth,
      taskSchedulerHealth: () => loopHealth,
      runtimeHealth: () => runtime,
      detectProviders: async () => [
        { id: "codex", name: "Codex", bin: "codex", available: true, detail: "1.0" },
      ],
      requiredProviderIds: () => ["codex"],
    });

    const normal = await reportHealth();
    expect(normal.ready).toBe(true);
    expect(normal.components.aiRuntime).toEqual(expect.objectContaining({
      status: "ok",
      details: expect.objectContaining({ answerFailureRate: 0 }),
    }));

    Object.assign(runtime.queue, {
      queued: 11,
      running: 1,
      pending: 12,
      maxPending: 18,
      averageWaitMs: 300,
      maxWaitMs: 1200,
    });
    const backlog = await reportHealth();
    expect(backlog.ready).toBe(true);
    expect(backlog.status).toBe("degraded");
    expect(backlog.components.aiRuntime).toEqual(expect.objectContaining({
      status: "degraded",
      details: expect.objectContaining({
        queue: expect.objectContaining({ pending: 12 }),
        answerFailureRate: 0,
      }),
    }));

    Object.assign(runtime.queue, {
      queued: 0,
      running: 0,
      pending: 0,
    });
    Object.assign(runtime.answers, {
      succeeded: 7,
      failed: 2,
      timedOut: 1,
      recent: {
        sampleSize: 10,
        succeeded: 7,
        failed: 2,
        timedOut: 1,
        failureRate: 0.3,
        errorRate: 0.2,
        timeoutRate: 0.1,
      },
    });
    const failures = await reportHealth();
    expect(failures.ready).toBe(true);
    expect(failures.status).toBe("degraded");
    expect(failures.components.aiRuntime).toEqual(expect.objectContaining({
      status: "degraded",
      details: expect.objectContaining({
        queue: expect.objectContaining({ pending: 0 }),
        answerFailureRate: 0.3,
        answerErrorRate: 0.2,
        answerTimeoutRate: 0.1,
      }),
    }));
    engine.close();
  });

  test("negative answer feedback degrades quality health without exposing answer content", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hb-health-ai-quality-"));
    dirs.push(dir);
    const engine = new KnowledgeEngine({ dataDir: dir, runProvider: async () => "ok" });
    for (let index = 0; index < 5; index += 1) {
      const trace = engine.quality.recordTrace({
        spaces: ["team/oc_health"],
        question: `private question ${index}`,
        outcome: "succeeded",
        source: "general",
        answer: `private answer ${index}`,
        citations: [],
        latencyMs: 10,
      });
      engine.quality.recordFeedback(
        trace.id,
        index < 2 ? "unhelpful" : index === 2 ? "citation_error" : "helpful",
      );
    }
    const reportHealth = createSystemHealthReporter({
      engine,
      connectorHealth: () => ({
        name: "feishu",
        ready: true,
        consumers: [
          { key: "im.message.receive_v1", state: "ready", attempts: 0 },
          { key: "im.chat.member.bot.added_v1", state: "ready", attempts: 0 },
        ],
      }),
      dreamSchedulerHealth: () => loopHealth,
      taskSchedulerHealth: () => loopHealth,
      detectProviders: async () => [
        { id: "codex", name: "Codex", bin: "codex", available: true, detail: "1.0" },
      ],
      requiredProviderIds: () => ["codex"],
    });

    const snapshot = await reportHealth();
    expect(snapshot.ready).toBe(true);
    expect(snapshot.components.aiQuality).toEqual(expect.objectContaining({
      status: "degraded",
      details: expect.objectContaining({
        feedback: expect.objectContaining({ total: 5, helpful: 2 }),
      }),
    }));
    expect(JSON.stringify(snapshot)).not.toContain("private question");
    expect(JSON.stringify(snapshot)).not.toContain("private answer");
    engine.close();
  });

  test("quarantined distillations degrade knowledge health without blocking readiness", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hb-health-quarantine-"));
    dirs.push(dir);
    const llm = new FakeLlm();
    const engine = new KnowledgeEngine({ dataDir: dir, llm });
    const space = "team/oc_health" as const;
    const rawId = await engine.remember({ space, source: "message", content: "will quarantine" });
    llm.queueJSON({
      operations: [{ type: "concept", name: "bad", title: "Bad", rawIds: [rawId] }],
      skippedRawIds: [],
    });
    llm.queueJSON({ title: "Bad", summary: "", content: "" });
    await engine.runDreamCycle(space);
    const reportHealth = createSystemHealthReporter({
      engine,
      connectorHealth: () => ({
        name: "feishu",
        ready: true,
        consumers: [
          { key: "im.message.receive_v1", state: "ready", attempts: 0 },
          { key: "im.chat.member.bot.added_v1", state: "ready", attempts: 0 },
        ],
      }),
      dreamSchedulerHealth: () => loopHealth,
      taskSchedulerHealth: () => loopHealth,
      detectProviders: async () => [
        { id: "codex", name: "Codex", bin: "codex", available: true, detail: "1.0" },
      ],
      requiredProviderIds: () => ["codex"],
    });

    const snapshot = await reportHealth();
    expect(snapshot.ready).toBe(true);
    expect(snapshot.status).toBe("degraded");
    expect(snapshot.components.knowledge).toEqual(expect.objectContaining({
      status: "degraded",
      summary: "1 个空间，0 条待提炼，1 条提炼失败待恢复",
    }));
    expect(snapshot.components.knowledge?.details?.quarantined).toBe(1);
    engine.close();
  });

  test("is ready when Codex is the ordinary provider", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hb-health-ordinary-provider-"));
    dirs.push(dir);
    const engine = new KnowledgeEngine({ dataDir: dir, runProvider: async () => "ok" });
    const reportHealth = createSystemHealthReporter({
      engine,
      connectorHealth: () => ({
        name: "feishu",
        ready: true,
        consumers: [
          { key: "im.message.receive_v1", state: "ready", attempts: 0 },
          { key: "im.chat.member.bot.added_v1", state: "ready", attempts: 0 },
        ],
      }),
      dreamSchedulerHealth: () => loopHealth,
      taskSchedulerHealth: () => loopHealth,
      detectProviders: async () => [
        { id: "codex", name: "Codex", bin: "codex", available: true, detail: "1.0" },
      ],
      requiredProviderIds: () => ["codex"],
      ordinaryProviderId: () => "codex",
    });

    const snapshot = await reportHealth();
    engine.close();
    expect(snapshot.ready).toBe(true);
    expect(snapshot.components.providers).toEqual(expect.objectContaining({
      status: "ok",
      details: expect.objectContaining({
        ordinaryProvider: "codex",
        unavailable: [],
        noToolsUnsupported: [],
      }),
    }));
  });

  test("reports an unavailable no-tools ordinary provider separately", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hb-health-ordinary-unavailable-"));
    dirs.push(dir);
    const engine = new KnowledgeEngine({ dataDir: dir, runProvider: async () => "ok" });
    const reportHealth = createSystemHealthReporter({
      engine,
      connectorHealth: () => ({
        name: "feishu",
        ready: true,
        consumers: [
          { key: "im.message.receive_v1", state: "ready", attempts: 0 },
          { key: "im.chat.member.bot.added_v1", state: "ready", attempts: 0 },
        ],
      }),
      dreamSchedulerHealth: () => loopHealth,
      taskSchedulerHealth: () => loopHealth,
      detectProviders: async () => [
        { id: "claude", name: "Claude", bin: "claude", available: false, detail: "missing" },
      ],
      requiredProviderIds: () => [],
      ordinaryProviderId: () => "claude",
    });

    const snapshot = await reportHealth();
    engine.close();
    expect(snapshot.ready).toBe(false);
    expect(snapshot.components.providers).toEqual(expect.objectContaining({
      status: "down",
      details: expect.objectContaining({
        ordinaryProvider: "claude",
        unavailable: ["claude"],
        noToolsUnsupported: [],
      }),
    }));
  });

  test("is ready when the ordinary provider is available and supports no-tools", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hb-health-ordinary-ready-"));
    dirs.push(dir);
    const engine = new KnowledgeEngine({ dataDir: dir, runProvider: async () => "ok" });
    const reportHealth = createSystemHealthReporter({
      engine,
      connectorHealth: () => ({
        name: "feishu",
        ready: true,
        consumers: [
          { key: "im.message.receive_v1", state: "ready", attempts: 0 },
          { key: "im.chat.member.bot.added_v1", state: "ready", attempts: 0 },
        ],
      }),
      dreamSchedulerHealth: () => loopHealth,
      taskSchedulerHealth: () => loopHealth,
      detectProviders: async () => [
        { id: "claude", name: "Claude", bin: "claude", available: true, detail: "2.0" },
      ],
      requiredProviderIds: () => [],
      ordinaryProviderId: () => "claude",
    });

    const snapshot = await reportHealth();
    expect(snapshot.ready).toBe(true);
    expect(snapshot.components.providers).toEqual(expect.objectContaining({
      status: "ok",
      details: expect.objectContaining({
        ordinaryProvider: "claude",
        unavailable: [],
        noToolsUnsupported: [],
      }),
    }));
    engine.close();
  });

  test("is not ready when a bound TRAE Agent cannot run restricted ordinary calls", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hb-health-space-ordinary-provider-"));
    dirs.push(dir);
    const engine = new KnowledgeEngine({ dataDir: dir, runProvider: async () => "ok" });
    const space = "team/oc_health" as const;
    engine.ensureSpace(space, { chatId: "oc_health" });
    const agent = engine.agents.create({ name: "Task-only Agent", provider: "trae-cli" });
    engine.updateSpaceMeta(space, { agentId: agent.id });
    const reportHealth = createSystemHealthReporter({
      engine,
      connectorHealth: () => ({
        name: "feishu",
        ready: true,
        consumers: [
          { key: "im.message.receive_v1", state: "ready", attempts: 0 },
          { key: "im.chat.member.bot.added_v1", state: "ready", attempts: 0 },
        ],
      }),
      dreamSchedulerHealth: () => loopHealth,
      taskSchedulerHealth: () => loopHealth,
      detectProviders: async () => [
        { id: "claude", name: "Claude", bin: "claude", available: true, detail: "2.0" },
        { id: "trae-cli", name: "TRAE", bin: "trae-cli", available: true, detail: "1.0" },
      ],
      requiredProviderIds: () => ["claude", "trae-cli"],
      ordinaryProviderId: () => "claude",
      ordinaryProviderIds: () => ["claude", "trae-cli"],
    });

    const snapshot = await reportHealth();
    engine.close();
    expect(snapshot.ready).toBe(false);
    expect(snapshot.components.providers).toEqual(expect.objectContaining({
      status: "down",
      details: expect.objectContaining({
        ordinaryProviders: ["claude", "trae-cli"],
        noToolsUnsupported: ["trae-cli"],
      }),
    }));
  });

  test("a caller-controlled task timeout degrades the task without taking provider readiness down", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hb-health-task-timeout-"));
    dirs.push(dir);
    const engine = new KnowledgeEngine({
      dataDir: dir,
      runProvider: async (_provider, _input, _timeoutMs, signal) =>
        new Promise<string>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    });
    const space = "team/oc_health" as const;
    engine.ensureSpace(space, { chatId: "oc_health" });
    const agent = engine.agents.create({ name: "Codex", provider: "codex" });
    engine.registry.updateMeta(space, { agentId: agent.id });
    const task = engine.tasks.create({
      name: "background timeout",
      space,
      topic: "probe",
      distillOnRun: false,
    })!;
    await engine.runTask(task.id, { timeoutMs: 10 });

    const reportHealth = createSystemHealthReporter({
      engine,
      connectorHealth: () => ({
        name: "feishu",
        ready: true,
        consumers: [
          { key: "im.message.receive_v1", state: "ready", attempts: 0 },
          { key: "im.chat.member.bot.added_v1", state: "ready", attempts: 0 },
        ],
      }),
      dreamSchedulerHealth: () => loopHealth,
      taskSchedulerHealth: () => loopHealth,
      detectProviders: async () => [
        { id: "codex", name: "Codex", bin: "codex", available: true, detail: "1.0" },
      ],
      requiredProviderIds: () => ["codex"],
    });

    const snapshot = await reportHealth();
    expect(snapshot.ready).toBe(true);
    expect(snapshot.status).toBe("degraded");
    expect(snapshot.components.providers).toEqual(expect.objectContaining({ status: "ok" }));
    expect(snapshot.components.tasks).toEqual(expect.objectContaining({
      status: "degraded",
      summary: "1 个任务最近执行失败",
    }));
    engine.close();
  });

  test("a transient provider timeout degrades the provider without taking readiness down", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hb-health-provider-timeout-"));
    dirs.push(dir);
    const engine = new KnowledgeEngine({
      dataDir: dir,
      runProvider: async () => {
        throw new Error("provider codex timed out after 30000ms");
      },
    });
    const space = "team/oc_health" as const;
    engine.ensureSpace(space, { chatId: "oc_health" });
    const agent = engine.agents.create({ name: "Codex", provider: "codex" });
    engine.registry.updateMeta(space, { agentId: agent.id });
    await expect(engine.llmClientForSpace(space, 30_000).complete({
      prompt: "判断群消息是否值得主动回答",
      purpose: "classify",
    })).rejects.toThrow("timed out");

    const reportHealth = createSystemHealthReporter({
      engine,
      connectorHealth: () => ({
        name: "feishu",
        ready: true,
        consumers: [
          { key: "im.message.receive_v1", state: "ready", attempts: 0 },
          { key: "im.chat.member.bot.added_v1", state: "ready", attempts: 0 },
        ],
      }),
      dreamSchedulerHealth: () => loopHealth,
      taskSchedulerHealth: () => loopHealth,
      detectProviders: async () => [
        { id: "codex", name: "Codex", bin: "codex", available: true, detail: "1.0" },
      ],
      requiredProviderIds: () => ["codex"],
    });

    const snapshot = await reportHealth();
    expect(snapshot.ready).toBe(true);
    expect(snapshot.status).toBe("degraded");
    expect(snapshot.components.providers).toEqual(expect.objectContaining({
      status: "degraded",
      summary: "CLI 最近执行超时：codex",
    }));
    engine.close();
  });

  test("is not ready when an installed CLI most recently failed at runtime", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hb-health-provider-"));
    dirs.push(dir);
    const engine = new KnowledgeEngine({
      dataDir: dir,
      runProvider: async () => {
        throw new Error("authentication expired");
      },
    });
    const space = "team/oc_health" as const;
    engine.ensureSpace(space, { chatId: "oc_health" });
    const agent = engine.agents.create({ name: "Codex", provider: "codex" });
    engine.registry.updateMeta(space, { agentId: agent.id });
    const task = engine.tasks.create({
      name: "probe",
      space,
      topic: "probe",
      distillOnRun: false,
    })!;
    await engine.runTask(task.id);

    const reportHealth = createSystemHealthReporter({
      engine,
      connectorHealth: () => ({
        name: "feishu",
        ready: true,
        consumers: [
          { key: "im.message.receive_v1", state: "ready", attempts: 0 },
          { key: "im.chat.member.bot.added_v1", state: "ready", attempts: 0 },
        ],
      }),
      dreamSchedulerHealth: () => loopHealth,
      taskSchedulerHealth: () => loopHealth,
      detectProviders: async () => [
        { id: "codex", name: "Codex", bin: "codex", available: true, detail: "1.0" },
      ],
      requiredProviderIds: () => ["codex"],
    });

    const snapshot = await reportHealth();
    expect(snapshot.ready).toBe(false);
    expect(snapshot.components.providers).toEqual(
      expect.objectContaining({ status: "down", summary: "CLI 最近执行失败：codex" }),
    );
    expect(snapshot.components.tasks).toEqual(
      expect.objectContaining({ status: "degraded", summary: "1 个任务最近执行失败" }),
    );
    engine.close();
  });

  test("is not ready when a scheduler's latest tick failed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hb-health-scheduler-"));
    dirs.push(dir);
    const engine = new KnowledgeEngine({ dataDir: dir, runProvider: async () => "ok" });
    engine.ensureSpace("team/oc_health", { chatId: "oc_health" });
    const reportHealth = createSystemHealthReporter({
      engine,
      connectorHealth: () => ({
        name: "feishu",
        ready: true,
        consumers: [
          { key: "im.message.receive_v1", state: "ready", attempts: 0 },
          { key: "im.chat.member.bot.added_v1", state: "ready", attempts: 0 },
        ],
      }),
      dreamSchedulerHealth: () => ({
        ...loopHealth,
        lastStatus: "error",
        lastFailureAt: loopHealth.lastSuccessAt,
        lastError: "database locked",
      }),
      taskSchedulerHealth: () => loopHealth,
      detectProviders: async () => [
        { id: "codex", name: "Codex", bin: "codex", available: true, detail: "1.0" },
      ],
      requiredProviderIds: () => ["codex"],
    });

    const snapshot = await reportHealth();
    expect(snapshot.ready).toBe(false);
    expect(snapshot.components.dreamScheduler).toEqual(
      expect.objectContaining({ status: "degraded" }),
    );
    engine.close();
  });

  test("isolates failures from each component probe", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hb-health-isolation-"));
    dirs.push(dir);
    const engine = new KnowledgeEngine({ dataDir: dir, runProvider: async () => "ok" });
    engine.ensureSpace("team/oc_health", { chatId: "oc_health" });
    const reportHealth = createSystemHealthReporter({
      engine,
      connectorHealth: () => {
        throw new Error("connector probe failed");
      },
      dreamSchedulerHealth: () => {
        throw new Error("dream scheduler probe failed");
      },
      taskSchedulerHealth: () => {
        throw new Error("task scheduler probe failed");
      },
      detectProviders: async () => [],
      requiredProviderIds: () => {
        throw new Error("provider config failed");
      },
    });

    const snapshot = await reportHealth();
    expect(snapshot.ready).toBe(false);
    expect(snapshot.components).toEqual(
      expect.objectContaining({
        knowledge: expect.objectContaining({ status: "ok" }),
        feishu: expect.objectContaining({ status: "down" }),
        providers: expect.objectContaining({ status: "down" }),
        dreamScheduler: expect.objectContaining({ status: "down" }),
        taskScheduler: expect.objectContaining({ status: "down" }),
      }),
    );
    engine.close();
  });
});
