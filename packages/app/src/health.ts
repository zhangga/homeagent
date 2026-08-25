/**
 * Process-level health aggregation. Domain packages expose their own snapshots;
 * this module turns them into one deployment/readiness contract without
 * reaching into their private state.
 */
import { config, type ComponentHealth, type SystemHealthSnapshot } from "@homeagent/shared";
import type { ConnectorHealth } from "@homeagent/connectors";
import type { KnowledgeEngine } from "@homeagent/core";
import type { OrchestratorHealth } from "@homeagent/orchestrator";
import {
  detectProviders as detectLocalProviders,
  isCliProvider,
  providerSupportsOrdinaryCompletion,
  type DetectedProvider,
} from "@homeagent/llm";
import type { RuntimeLoopHealth } from "./scheduler.ts";
import type { RuntimeServiceStatus } from "./service.ts";

export interface SystemHealthSources {
  engine: KnowledgeEngine;
  connectorHealth: () => ConnectorHealth;
  feishuLocallyDisabled?: () => boolean;
  dreamSchedulerHealth: () => RuntimeLoopHealth | undefined;
  maintenanceSchedulerHealth?: () => RuntimeLoopHealth | undefined;
  taskSchedulerHealth: () => RuntimeLoopHealth | undefined;
  workContinuationSchedulerHealth?: () => RuntimeLoopHealth | undefined;
  reminderSchedulerHealth?: () => RuntimeLoopHealth | undefined;
  learningSchedulerHealth?: () => RuntimeLoopHealth | undefined;
  runtimeHealth?: () => OrchestratorHealth;
  serviceHealth?: () => RuntimeServiceStatus;
  detectProviders?: () => Promise<DetectedProvider[]>;
  requiredProviderIds?: () => string[];
  ordinaryProviderId?: () => string;
  ordinaryProviderIds?: () => string[];
  now?: () => number;
  providerProbeTtlMs?: number;
}

function requiredProvidersFor(engine: KnowledgeEngine): string[] {
  const ids = new Set<string>();
  const defaultProvider = config().defaultProvider;
  if (isCliProvider(defaultProvider)) ids.add(defaultProvider);
  for (const meta of engine.registry.list()) {
    const provider = engine.agentForSpace(meta.id)?.provider;
    if (provider && isCliProvider(provider)) ids.add(provider);
  }
  return [...ids].sort();
}

function loopComponent(label: string, health?: RuntimeLoopHealth): ComponentHealth {
  if (!health?.started) {
    return {
      status: "down",
      summary: `${label}未启动`,
      details: health ? { ...health } : undefined,
    };
  }
  const latestRunFailed = health.lastStatus === "error";
  return {
    status: latestRunFailed ? "degraded" : "ok",
    summary: latestRunFailed
      ? `${label}最近一次执行失败`
      : health.running
        ? `${label}运行中`
        : `${label}正常`,
    details: { ...health },
  };
}

function probeLoopComponent(
  label: string,
  probe: () => RuntimeLoopHealth | undefined,
): { health?: RuntimeLoopHealth; component: ComponentHealth } {
  try {
    const health = probe();
    return { health, component: loopComponent(label, health) };
  } catch (err) {
    return {
      component: {
        status: "down",
        summary: `${label}状态检查失败`,
        details: { error: String(err) },
      },
    };
  }
}

/** Build a cached async reporter suitable for /readyz and the management UI. */
export function createSystemHealthReporter(
  sources: SystemHealthSources,
): () => Promise<SystemHealthSnapshot> {
  const detect = sources.detectProviders ?? detectLocalProviders;
  const requiredProviderIds =
    sources.requiredProviderIds ?? (() => requiredProvidersFor(sources.engine));
  const now = sources.now ?? Date.now;
  const ttl = sources.providerProbeTtlMs ?? 60_000;
  let providerCache: DetectedProvider[] | undefined;
  let providerCacheAt = 0;

  const providers = async (): Promise<DetectedProvider[]> => {
    const at = now();
    if (!providerCache || at - providerCacheAt >= ttl) {
      providerCache = await detect();
      providerCacheAt = at;
    }
    return providerCache;
  };

  return async () => {
    const checkedAt = now();
    const components: Record<string, ComponentHealth> = {};

    let core;
    try {
      core = await sources.engine.health();
      const spaces = (core.details?.spaces as Array<Record<string, unknown>> | undefined) ?? [];
      const pending = spaces.reduce(
        (sum, space) => sum + (typeof space.pendingRaw === "number" ? space.pendingRaw : 0),
        0,
      );
      const heldRaw = spaces.reduce(
        (sum, space) => sum + (typeof space.heldRaw === "number" ? space.heldRaw : 0),
        0,
      );
      const excludedRaw = spaces.reduce(
        (sum, space) => sum + (typeof space.excludedRaw === "number" ? space.excludedRaw : 0),
        0,
      );
      const quarantined = spaces.reduce(
        (sum, space) => sum + (typeof space.quarantined === "number" ? space.quarantined : 0),
        0,
      );
      components.knowledge = {
        status: core.ok ? quarantined > 0 ? "degraded" : "ok" : "down",
        summary: `${core.spaces} 个空间，${pending} 条待提炼${heldRaw > 0 ? `，${heldRaw} 条待验收` : ""}${excludedRaw > 0 ? `，${excludedRaw} 条已排除` : ""}${quarantined > 0 ? `，${quarantined} 条提炼失败待恢复` : ""}`,
        details: { ...core.details, heldRaw, excludedRaw, quarantined },
      };
    } catch (err) {
      core = { ok: false, spaces: 0, details: { error: String(err) } };
      components.knowledge = {
        status: "down",
        summary: "知识存储检查失败",
        details: core.details,
      };
    }

    try {
      const quality = sources.engine.qualitySnapshot();
      const agentKnowledgeFeedback = (
        core.details?.agentKnowledgeFeedback as Record<string, unknown> | undefined
      ) ?? {};
      const openAgentFeedback = typeof agentKnowledgeFeedback.open === "number"
        ? agentKnowledgeFeedback.open
        : 0;
      const negativeFeedback = quality.feedback.unhelpful + quality.feedback.citationError;
      const negativeRate = quality.feedback.total === 0
        ? 0
        : negativeFeedback / quality.feedback.total;
      const degraded = (quality.feedback.total >= 5 && negativeRate >= 0.3)
        || openAgentFeedback >= 5;
      const answerSummary = quality.feedback.total === 0
        ? `${quality.answers.total} 次回答，暂无人工反馈`
        : `${quality.feedback.total} 条反馈，${quality.feedback.helpful} 条有帮助，${negativeFeedback} 条需改进`;
      components.aiQuality = {
        status: degraded ? "degraded" : "ok",
        summary: `${answerSummary}，${openAgentFeedback} 条 Agent 知识反馈待处理`,
        details: {
          ...quality,
          negativeFeedbackRate: negativeRate,
          agentKnowledgeFeedback,
        },
      };
    } catch (err) {
      components.aiQuality = {
        status: "degraded",
        summary: "AI 质量反馈状态检查失败",
        details: { error: String(err) },
      };
    }

    if (sources.runtimeHealth) {
      try {
        const runtime = sources.runtimeHealth();
        const answerFailureRate = runtime.answers.recent.failureRate;
        const answerErrorRate = runtime.answers.recent.errorRate;
        const answerTimeoutRate = runtime.answers.recent.timeoutRate;
        const degraded =
          runtime.queue.pending >= 10
          || runtime.runs.queued >= 10
          || (runtime.answers.recent.sampleSize >= 5 && answerFailureRate >= 0.2);
        components.aiRuntime = {
          status: degraded ? "degraded" : "ok",
          summary: `${runtime.answers.succeeded}/${runtime.answers.total} 次回答成功，${runtime.answers.timedOut} 次超时，Run 排队 ${runtime.runs.queued}`,
          details: {
            ...runtime,
            answerFailureRate,
            answerErrorRate,
            answerTimeoutRate,
          },
        };
      } catch (err) {
        components.aiRuntime = {
          status: "degraded",
          summary: "AI 运行指标检查失败",
          details: { error: String(err) },
        };
      }
    }

    let connector: ConnectorHealth;
    try {
      connector = sources.connectorHealth();
      let locallyDisabled = false;
      try {
        locallyDisabled = sources.feishuLocallyDisabled?.() === true;
      } catch {
        // Connector health remains authoritative if the optional flag fails.
      }
      const failedConsumers = connector.consumers.filter((consumer) => consumer.state === "failed");
      const pendingConsumers = connector.consumers.filter((consumer) => consumer.state !== "ready");
      components.feishu = {
        status: locallyDisabled
          ? "degraded"
          : connector.ready
            ? "ok"
            : failedConsumers.length > 0
              ? "down"
              : "degraded",
        summary: locallyDisabled
          ? "飞书连接已在 HomeAgent 中停用"
          : connector.ready
            ? "飞书事件消费者已就绪"
            : `未就绪：${pendingConsumers.map((consumer) => consumer.key).join("、") || "尚未启动"}`,
        details: { ...connector, ...(locallyDisabled ? { locallyDisabled: true } : {}) },
      };
    } catch (err) {
      connector = { name: "feishu", ready: false, consumers: [] };
      components.feishu = {
        status: "down",
        summary: "飞书事件消费者状态检查失败",
        details: { error: String(err) },
      };
    }

    let detected: DetectedProvider[] = [];
    const providerErrors: string[] = [];
    try {
      detected = await providers();
    } catch (err) {
      providerErrors.push(`CLI 探测：${String(err)}`);
    }
    let required: string[] = [];
    let ordinaryProvider: string | undefined;
    const ordinaryProviders = new Set<string>();
    try {
      required = [...new Set(requiredProviderIds())].sort();
    } catch (err) {
      providerErrors.push(`必需 CLI 配置：${String(err)}`);
    }
    if (sources.ordinaryProviderId) {
      try {
        ordinaryProvider = sources.ordinaryProviderId();
        ordinaryProviders.add(ordinaryProvider);
        required = [...new Set([...required, ordinaryProvider])].sort();
      } catch (err) {
        providerErrors.push(`普通对话 CLI 配置：${String(err)}`);
      }
    }
    if (sources.ordinaryProviderIds) {
      try {
        for (const provider of sources.ordinaryProviderIds()) {
          if (provider) ordinaryProviders.add(provider);
        }
        required = [...new Set([...required, ...ordinaryProviders])].sort();
      } catch (err) {
        providerErrors.push(`空间普通对话 CLI 配置：${String(err)}`);
      }
    }
    const detectedById = new Map<string, DetectedProvider>(
      detected.map((provider) => [provider.id, provider]),
    );
    const unavailable = required.filter((id) => !detectedById.get(id)?.available);
    const ordinaryProviderList = [...ordinaryProviders].sort();
    const noToolsUnsupported = ordinaryProviderList.filter(
      (provider) => !providerSupportsOrdinaryCompletion(provider),
    );
    const providerRuns =
      (core.details?.providerRuns as Array<Record<string, unknown>> | undefined) ?? [];
    const latestRuntimeFailures = providerRuns.filter(
      (run) => required.includes(String(run.provider)) && run.lastStatus === "error",
    );
    const latestRuntimeTimeouts = providerRuns.filter(
      (run) => required.includes(String(run.provider)) && run.lastStatus === "timeout",
    );
    const providerReady =
      providerErrors.length === 0
      && required.length > 0
      && unavailable.length === 0
      && noToolsUnsupported.length === 0
      && latestRuntimeFailures.length === 0;
    components.providers = {
      status: providerReady ? latestRuntimeTimeouts.length > 0 ? "degraded" : "ok" : "down",
      summary: providerReady
        ? latestRuntimeTimeouts.length > 0
          ? `CLI 最近执行超时：${latestRuntimeTimeouts.map((run) => run.provider).join("、")}`
          : `必需 CLI 可用：${required.join("、")}`
        : providerErrors.length > 0
          ? "CLI 状态检查失败"
          : unavailable.length > 0
            ? `CLI 不可用：${unavailable.join("、")}`
            : noToolsUnsupported.length > 0
              ? `普通对话 CLI 不支持 no-tools：${noToolsUnsupported.join("、")}`
              : latestRuntimeFailures.length > 0
                ? `CLI 最近执行失败：${latestRuntimeFailures.map((run) => run.provider).join("、")}`
                : "未配置可用 CLI",
      details: {
        required,
        ...(ordinaryProvider ? { ordinaryProvider } : {}),
        ordinaryProviders: ordinaryProviderList,
        unavailable,
        noToolsUnsupported,
        detected,
        providerRuns,
        ...(providerErrors.length > 0 ? { errors: providerErrors } : {}),
      },
    };

    const dreamCycles =
      (core.details?.dreamCycles as Array<Record<string, unknown>> | undefined) ?? [];
    const runningDreams = dreamCycles.filter((cycle) => cycle.running === true);
    const failedDreams = dreamCycles.filter((cycle) => cycle.lastStatus === "error");
    components.dreamCycles = {
      status: failedDreams.length > 0 ? "degraded" : "ok",
      summary: runningDreams.length > 0
        ? `${runningDreams.length} 个 Dream Cycle 运行中`
        : failedDreams.length > 0
          ? `${failedDreams.length} 个空间最近提炼失败`
          : "Dream Cycle 无近期失败",
      details: { runs: dreamCycles },
    };

    const maintenanceCycles =
      (core.details?.maintenanceCycles as Array<Record<string, unknown>> | undefined) ?? [];
    const runningMaintenance = maintenanceCycles.filter((cycle) => cycle.running === true);
    const failedMaintenance = maintenanceCycles.filter((cycle) => cycle.lastStatus === "error");
    const maintenanceIssueCount = maintenanceCycles.reduce(
      (sum, cycle) => sum + (
        typeof cycle.lastIssueCount === "number" ? cycle.lastIssueCount : 0
      ),
      0,
    );
    const truncatedMaintenance = maintenanceCycles.filter(
      (cycle) => cycle.lastTruncated === true,
    );
    components.maintenanceCycles = {
      status: failedMaintenance.length > 0
        || maintenanceIssueCount > 0
        || truncatedMaintenance.length > 0
        ? "degraded"
        : "ok",
      summary: runningMaintenance.length > 0
        ? `${runningMaintenance.length} 个 Wiki Maintenance cycle 运行中`
        : failedMaintenance.length > 0
          ? `${failedMaintenance.length} 个空间最近维护检查失败`
          : maintenanceIssueCount > 0
            ? `Wiki Maintenance 最近发现 ${maintenanceIssueCount} 项问题`
            : truncatedMaintenance.length > 0
              ? `${truncatedMaintenance.length} 个空间的维护报告被截断`
              : "Wiki Maintenance 无近期问题",
      details: { runs: maintenanceCycles },
    };

    const tasks = (core.details?.tasks as Array<Record<string, unknown>> | undefined) ?? [];
    const runningTasks = tasks.filter((task) => task.running === true);
    const failedTasks = tasks.filter((task) => task.lastStatus === "error");
    components.tasks = {
      status: failedTasks.length > 0 ? "degraded" : "ok",
      summary: runningTasks.length > 0
        ? `${runningTasks.length} 个任务运行中`
        : failedTasks.length > 0
          ? `${failedTasks.length} 个任务最近执行失败`
          : `${tasks.length} 个任务，无近期失败`,
      details: { tasks },
    };

    const reminders = (core.details?.reminders as Record<string, unknown> | undefined) ?? {};
    const scheduledReminders = typeof reminders.scheduled === "number" ? reminders.scheduled : 0;
    const totalReminders = typeof reminders.total === "number" ? reminders.total : 0;
    components.reminders = {
      status: "ok",
      summary: `${scheduledReminders} 个待提醒，${totalReminders} 个提醒记录`,
      details: { counts: reminders },
    };

    const learning = (core.details?.learning as Record<string, unknown> | undefined) ?? {};
    const activeLearning = typeof learning.active === "number" ? learning.active : 0;
    const awaitingLearning = typeof learning.awaitingReply === "number" ? learning.awaitingReply : 0;
    components.learning = {
      status: "ok",
      summary: `${activeLearning} 个进行中，${awaitingLearning} 个等待回答`,
      details: { counts: learning },
    };

    const dreamLoop = probeLoopComponent("Dream Cycle 调度器", sources.dreamSchedulerHealth);
    const maintenanceLoop = sources.maintenanceSchedulerHealth
      ? probeLoopComponent("Wiki Maintenance 调度器", sources.maintenanceSchedulerHealth)
      : undefined;
    const taskLoop = probeLoopComponent("任务调度器", sources.taskSchedulerHealth);
    const dreamHealth = dreamLoop.health;
    const taskHealth = taskLoop.health;
    if (
      dreamHealth?.lastStatus !== "error"
      && dreamHealth?.lastBacklogLimited === true
      && typeof dreamHealth.lastPendingRaw === "number"
      && dreamHealth.lastPendingRaw > 0
    ) {
      const processed = typeof dreamHealth.lastProcessedRaw === "number"
        ? dreamHealth.lastProcessedRaw
        : 0;
      dreamLoop.component.status = "degraded";
      dreamLoop.component.summary = `本轮已处理 ${processed} 条 Raw，仍有 ${dreamHealth.lastPendingRaw} 条提炼积压，将在下一轮继续`;
    }
    components.dreamScheduler = dreamLoop.component;
    if (maintenanceLoop) components.maintenanceScheduler = maintenanceLoop.component;
    components.taskScheduler = taskLoop.component;
    const workContinuationLoop = sources.workContinuationSchedulerHealth
      ? probeLoopComponent("工作续跑调度器", sources.workContinuationSchedulerHealth)
      : undefined;
    if (workContinuationLoop) {
      components.workContinuationScheduler = workContinuationLoop.component;
    }
    const reminderLoop = sources.reminderSchedulerHealth
      ? probeLoopComponent("提醒调度器", sources.reminderSchedulerHealth)
      : undefined;
    if (reminderLoop) components.reminderScheduler = reminderLoop.component;
    const learningLoop = sources.learningSchedulerHealth
      ? probeLoopComponent("学习调度器", sources.learningSchedulerHealth)
      : undefined;
    if (learningLoop) components.learningScheduler = learningLoop.component;

    if (sources.serviceHealth) {
      try {
        const service = sources.serviceHealth();
        components.service = {
          status: service.managed ? "ok" : "degraded",
          summary: service.managed
            ? `LaunchAgent 托管运行（PID ${service.pid}）`
            : `当前为终端前台运行（PID ${service.pid}）`,
          details: { ...service },
        };
      } catch (err) {
        components.service = {
          status: "down",
          summary: "后台服务状态检查失败",
          details: { error: String(err) },
        };
      }
    }

    const ready =
      core.ok &&
      connector.ready &&
      providerReady &&
      dreamHealth?.started === true &&
      dreamHealth.lastStatus !== "error" &&
      (!maintenanceLoop || (
        maintenanceLoop.health?.started === true
        && maintenanceLoop.health.lastStatus !== "error"
      )) &&
      taskHealth?.started === true &&
      taskHealth.lastStatus !== "error" &&
      (!workContinuationLoop || (
        workContinuationLoop.health?.started === true
        && workContinuationLoop.health.lastStatus !== "error"
      )) &&
      (!reminderLoop || (
        reminderLoop.health?.started === true
        && reminderLoop.health.lastStatus !== "error"
      )) &&
      (!learningLoop || (
        learningLoop.health?.started === true
        && learningLoop.health.lastStatus !== "error"
      ));
    const statuses = Object.values(components).map((component) => component.status);
    const status = !ready || statuses.includes("down")
      ? "down"
      : statuses.includes("degraded")
        ? "degraded"
        : "ok";

    return { status, ready, checkedAt, components };
  };
}
