/**
 * homeagent production entrypoint. Assembles the full system over one shared
 * KnowledgeEngine:
 *   - the feishu connector + orchestrator (inbound events -> knowledge + replies)
 *   - the read-only web backend (Bun.serve + Hono)
 *   - the dream-cycle scheduler (nightly + startup catch-up)
 *   - the Wiki Maintenance scheduler (weekly + startup catch-up)
 * and shuts everything down gracefully on SIGINT/SIGTERM (propagating SIGTERM to
 * the lark-cli consumers — never kill -9).
 */
import {
  assertSafeWebBinding,
  brandedEnv,
  config,
  logger,
  saveSettings,
  type LarkSetupStatus,
} from "@homeagent/shared";
import { join } from "node:path";
import { KnowledgeEngine, type TaskRun } from "@homeagent/core";
import {
  ByteTechArticleFetcher,
  FeishuConnector,
  LarkCliSetup,
  isByteTechArticleUrl,
} from "@homeagent/connectors";
import {
  FEISHU_GROUP_CONFIRMATION_PROMPT,
  Orchestrator,
  createNativeExtractor,
  extractAttachmentText,
} from "@homeagent/orchestrator";
import { createWebApp, FeishuIntegrationService } from "@homeagent/web";
import { Scheduler } from "./scheduler.ts";
import { MaintenanceScheduler } from "./maintenance-scheduler.ts";
import {
  formatTaskApprovalNotification,
  formatTaskRunNotification,
  TaskScheduler,
} from "./task-scheduler.ts";
import { LearningScheduler, learningNotification } from "./learning-scheduler.ts";
import { ReminderScheduler } from "./reminder-scheduler.ts";
import { WorkContinuationScheduler } from "./work-continuation-scheduler.ts";
import { createSystemHealthReporter } from "./health.ts";
import {
  homeAgentFeishuAvatarPath,
  resolveRuntimePaths,
  type RuntimePaths,
} from "./runtime-paths.ts";
import { launchDesktop } from "./desktop.ts";
import { createDefaultService, runServiceCli } from "./service-cli.ts";
import {
  applyPendingDataDirectoryMigration,
  dataDirectoryWasUninitialized,
  dataDirectoryIsGitRepository,
  ensureDataGitIgnoreForRepository,
  gitIsAvailable,
  readRuntimeDataSettings,
  runtimeDataSettingsPath,
  scheduleDataDirectoryMigration,
} from "./runtime-data.ts";
import {
  acquireProcessLock,
  runtimeServiceStatus,
  startServiceLogMaintenance,
  type ProcessLock,
} from "./service.ts";
import { LocalAgentApiClient, localAgentApiBaseUrl } from "./local-agent-client.ts";
import { runKnowledgeMcpStdio } from "./mcp.ts";
import { createCodexSetupPort } from "./codex-setup.ts";
import { runKnowledgeCli } from "./knowledge-cli.ts";
import { runFeedbackCli } from "./feedback-cli.ts";

const log = logger.child("app");

export function configureRuntimeEnvironment(
  paths: Pick<RuntimePaths, "bundled" | "dataDir" | "logDir">,
  environment: NodeJS.ProcessEnv = process.env,
): void {
  environment.HOMEAGENT_DATA_DIR = paths.dataDir;
  if (paths.bundled) environment.HOMEAGENT_LOG_DIR ??= paths.logDir;
}

export interface FeishuStartupPreparation {
  status: LarkSetupStatus;
  migrated: number;
  locallyDisabled: boolean;
  consumersEnabled: boolean;
}

export async function prepareFeishuStartup(
  engine: KnowledgeEngine,
  setup: { status(): Promise<LarkSetupStatus> },
  disabledAppId?: string,
): Promise<FeishuStartupPreparation> {
  const status = await setup.status();
  const currentAppId =
    status.state === "ready" && status.verified ? status.appId : undefined;
  const migrated = engine.feishuBindings.migrateLegacy(
    engine.registry.list(),
    currentAppId,
  );
  // Older development builds persisted this fake chat alongside real Feishu
  // bindings. Exact `oc_demo` can never identify a real Feishu group, so remove
  // it from whichever runtime data directory is active during startup.
  engine.feishuBindings.removeByChatId("oc_demo");
  if (currentAppId) {
    engine.feishuBindings.markMismatchedAppNeedsReconnect(currentAppId);
  }
  const locallyDisabled = Boolean(
    currentAppId && disabledAppId === currentAppId,
  );
  if (locallyDisabled && currentAppId) {
    engine.feishuBindings.markAppNeedsReconnect(currentAppId);
  }
  return {
    status,
    migrated,
    locallyDisabled,
    consumersEnabled: Boolean(currentAppId) && !locallyDisabled,
  };
}

function teamBindingIsInactive(
  engine: KnowledgeEngine,
  space: string,
  chatId: string,
  activeAppId?: string,
): boolean {
  const binding = engine.feishuBindings.getBySpace(space as `team/${string}`);
  return !binding
    || binding.state !== "active"
    || binding.chatId !== chatId
    || (activeAppId !== undefined && binding.boundAppId !== activeAppId);
}

async function run(
  cfg: ReturnType<typeof config>,
  processLock: ProcessLock,
  options: { dataDirectoryWasUninitializedAtStartup?: boolean } = {},
): Promise<void> {
  const runtimePaths = resolveRuntimePaths();
  const runtimeSettingsPath = runtimeDataSettingsPath({
    bundled: runtimePaths.bundled,
    appRoot: runtimePaths.appRoot,
  });
  const stopLogMaintenance = startServiceLogMaintenance(cfg.dataDir);
  log.info("starting homeagent", {
    dataDir: cfg.dataDir,
    model: cfg.model,
    webHost: cfg.webHost,
    webPort: cfg.webPort,
  });
  // Provider-native rollouts and authentication live below the data root but
  // must never enter a user-initialized knowledge Git repository.
  ensureDataGitIgnoreForRepository(cfg.dataDir);

  const engine = new KnowledgeEngine({
    recoverInterruptedTaskRuns: true,
    recoverInterruptedChatRuns: true,
  });
  const larkSetup = new LarkCliSetup({ larkBin: runtimePaths.larkBin });
  const feishuStartup = await prepareFeishuStartup(
    engine,
    larkSetup,
    cfg.feishuConnectionDisabledAppId,
  );

  // 1. feishu connector + orchestrator
  const connector = new FeishuConnector({ larkBin: runtimePaths.larkBin });
  const byteTechArticleFetcher = new ByteTechArticleFetcher({
    bin: brandedEnv(process.env, "BYTEDCLI_BIN"),
  });
  const nativeAttachmentExtractor = createNativeExtractor({
    attachmentHelper: runtimePaths.attachmentHelper,
  });
  const orchestrator = new Orchestrator({
    engine,
    connector,
    activeFeishuAppId:
      feishuStartup.status.state === "ready" && feishuStartup.status.verified
        ? feishuStartup.status.appId
        : undefined,
    docFetcher: (link) => isByteTechArticleUrl(link)
      ? byteTechArticleFetcher.fetch(link)
      : connector.fetchDoc(link),
    attachmentExtractor: (attachment) =>
      extractAttachmentText(attachment, nativeAttachmentExtractor),
  });
  let feishuOutboundEnabled = feishuStartup.consumersEnabled;
  let feishuLocallyDisabled = feishuStartup.locallyDisabled;
  if (feishuStartup.consumersEnabled) {
    await orchestrator.start();
    log.info("orchestrator live; listening for feishu events", {
      migratedBindings: feishuStartup.migrated,
    });
  } else {
    log.info("feishu event consumers not started", {
      reason: feishuStartup.locallyDisabled
        ? "locally_disabled"
        : feishuStartup.status.state,
      migratedBindings: feishuStartup.migrated,
    });
  }

  const sendFeishuNotice = async (
    space: string | undefined,
    chatId: string,
    text: string,
    idempotencyKey?: string,
  ): Promise<void> => {
    if (!feishuOutboundEnabled) {
      throw new Error("Feishu delivery is disabled until restart");
    }
    if (
      space?.startsWith("team/")
      && teamBindingIsInactive(
        engine,
        space,
        chatId,
        feishuStartup.status.state === "ready" && feishuStartup.status.verified
          ? feishuStartup.status.appId
          : undefined,
      )
    ) {
      throw new Error(`Feishu group is not connected: ${space}`);
    }
    await connector.notice(chatId, text, { idempotencyKey });
  };

  // Push a task's summary to its space-bound feishu chat (shared by the task
  // scheduler and the backend's manual "run now").
  const notifyTaskDone = async (run: TaskRun) => {
    const chatId = engine.registry.get(run.space)?.chatId;
    if (!chatId) throw new Error(`task space has no bound Feishu chat: ${run.space}`);
    await sendFeishuNotice(
      run.space,
      chatId,
      formatTaskRunNotification(run),
      `ha-done-${run.id}`,
    );
  };

  const notifyTaskApproval = async (run: TaskRun, deliveryKey: string) => {
    const chatId = engine.registry.get(run.space)?.chatId;
    if (!chatId) throw new Error(`task space has no bound Feishu chat: ${run.space}`);
    await sendFeishuNotice(
      run.space,
      chatId,
      formatTaskApprovalNotification(run),
      deliveryKey,
    );
  };

  for (const resumed of engine.resumeQueuedTaskRuns()) {
    void resumed.completion.then(async (report) => {
      if (!report.ok) return;
      const run = engine.getTaskRun(report.runId);
      if (run?.notification) await notifyTaskDone(run);
    }).catch((err) => {
      log.warn("resumed task completion hook failed", {
        runId: resumed.run.id,
        err: String(err),
      });
    });
  }

  let scheduler: Scheduler | undefined;
  let maintenanceScheduler: MaintenanceScheduler | undefined;
  let taskScheduler: TaskScheduler | undefined;
  let workContinuationScheduler: WorkContinuationScheduler | undefined;
  let learningScheduler: LearningScheduler | undefined;
  let reminderScheduler: ReminderScheduler | undefined;
  const reportHealth = createSystemHealthReporter({
    engine,
    connectorHealth: () => connector.health(),
    feishuLocallyDisabled: () => feishuLocallyDisabled,
    dreamSchedulerHealth: () => scheduler?.health(),
    maintenanceSchedulerHealth: () => maintenanceScheduler?.health(),
    taskSchedulerHealth: () => taskScheduler?.health(),
    workContinuationSchedulerHealth: () => workContinuationScheduler?.health(),
    reminderSchedulerHealth: () => reminderScheduler?.health(),
    learningSchedulerHealth: () => learningScheduler?.health(),
    runtimeHealth: () => orchestrator.health(),
    serviceHealth: () => runtimeServiceStatus({ startedAt: processLock.startedAt }),
    ordinaryProviderId: () => config().defaultProvider,
    ordinaryProviderIds: () => {
      const providers = new Set<string>([config().defaultProvider]);
      for (const space of engine.registry.list()) {
        const provider = engine.agentForSpace(space.id)?.provider;
        if (provider) providers.add(provider);
      }
      return [...providers].sort();
    },
  });

  // 2. management web backend
  const codexBin = brandedEnv(process.env, "CODEX_BIN")?.trim() || "codex";
  const codexSetup = createCodexSetupPort({ codexBin });
  const feishuIntegration = new FeishuIntegrationService({
    engine,
    larkSetup,
    activeIdentity: () =>
      feishuOutboundEnabled && cfg.feishuBotName && cfg.feishuBotOpenId
        ? { botName: cfg.feishuBotName, botOpenId: cfg.feishuBotOpenId }
        : undefined,
    runtimeStatus: () => connector.health(),
    sendTestMessage: (chatId, text) =>
      sendFeishuNotice(`team/${chatId}`, chatId, text),
    sendConfirmationPrompt: (chatId) =>
      connector.notice(chatId, FEISHU_GROUP_CONFIRMATION_PROMPT),
    persistConnectionDisabledAppId: (appId) => {
      saveSettings({ feishuConnectionDisabledAppId: appId }, cfg.dataDir);
    },
    disableRuntime: async () => {
      feishuOutboundEnabled = false;
      feishuLocallyDisabled = true;
      await orchestrator.stop();
    },
  });
  const app = createWebApp({
    engine,
    brandAvatarPath: homeAgentFeishuAvatarPath(runtimePaths),
    adminToken: cfg.webAdminToken,
    agentReadToken: cfg.agentReadToken,
    agentFeedbackToken: cfg.agentFeedbackToken,
    health: reportHealth,
    larkSetup,
    codexSetup,
    feishuRuntime: () => connector.health(),
    activeFeishuIdentity: feishuOutboundEnabled && cfg.feishuBotName && cfg.feishuBotOpenId
      ? { botName: cfg.feishuBotName, botOpenId: cfg.feishuBotOpenId }
      : undefined,
    feishuIntegration,
    onIntegrationTest: async (chatId, text) =>
      sendFeishuNotice(`team/${chatId}`, chatId, text),
    onTaskRun: async (_taskId, run) => {
      await notifyTaskDone(run);
    },
    onChatRunRetry: async (runId) => {
      if (!feishuOutboundEnabled) {
        throw new Error("Feishu delivery is disabled until restart");
      }
      return orchestrator.retryChatRun(runId);
    },
    onChatRunCancel: (runId) => orchestrator.cancelChatRun(runId),
    dataDirectory: {
      status: () => {
        const runtimeSettings = readRuntimeDataSettings(runtimeSettingsPath);
        const lastMigration = runtimeSettings.lastMigration;
        const pendingMigration = runtimeSettings.pendingMigration;
        return {
          currentPath: cfg.dataDir,
          available: true,
          lockedByEnvironment: process.env.HOMEAGENT_DATA_DIR_LOCKED === "1",
          gitAvailable: gitIsAvailable(),
          gitRepository: dataDirectoryIsGitRepository(cfg.dataDir),
          restartable: process.env.HOMEAGENT_SERVICE_MANAGED === "1",
          migrationError: runtimeSettings.migrationError,
          pendingMigration: pendingMigration
            ? {
                destination: pendingMigration.destination,
                initializeGit: pendingMigration.initializeGit,
                requestedAt: pendingMigration.requestedAt,
              }
            : undefined,
          lastMigration: lastMigration
            ? {
                source: lastMigration.source,
                destination: lastMigration.destination,
                completedAt: lastMigration.completedAt,
                gitInitialized: lastMigration.initializeGit,
              }
            : undefined,
        };
      },
      scheduleMigration: ({ destination, initializeGit }) => {
        if (process.env.HOMEAGENT_DATA_DIR_LOCKED === "1") {
          throw new Error("当前目录由 HOMEAGENT_DATA_DIR 环境变量固定");
        }
        if (initializeGit && !gitIsAvailable()) {
          throw new Error("当前系统未找到 Git，无法初始化仓库");
        }
        scheduleDataDirectoryMigration({
          settingsPath: runtimeSettingsPath,
          currentDataDir: cfg.dataDir,
          destinationDir: destination,
          initializeGit,
        });
      },
    },
    dataDirectoryWasUninitializedAtStartup: options.dataDirectoryWasUninitializedAtStartup,
    onServiceRestart: () => {
      setTimeout(() => process.kill(process.pid, "SIGTERM"), 250);
    },
  });
  // Local CLI providers routinely take longer than Bun's 10-second default.
  const server = Bun.serve({
    hostname: cfg.webHost,
    port: cfg.webPort,
    fetch: app.fetch,
    idleTimeout: 120,
  });
  log.info("web backend live", { url: `http://${cfg.webHost}:${server.port}` });

  // 3. dream-cycle scheduler (runs an immediate catch-up pass)
  scheduler = new Scheduler(engine);
  await scheduler.start();
  log.info("scheduler started (nightly + catch-up)");

  // 4. deterministic Wiki inspection is independent from pending Raw and LLM providers.
  maintenanceScheduler = new MaintenanceScheduler(engine);
  await maintenanceScheduler.start();
  log.info("Wiki Maintenance scheduler started (weekly + catch-up)");

  // 5. opted-in WorkItems continue one durable action boundary per tick.
  workContinuationScheduler = new WorkContinuationScheduler(engine);
  await workContinuationScheduler.start();
  log.info("work continuation scheduler started");

  // 6. task scheduler (research tasks). On completion, push a summary to the
  // task's space-bound feishu chat when the task opts in.
  taskScheduler = new TaskScheduler(engine, {
    notify: async (_task, run) => {
      await notifyTaskDone(run);
    },
    notifyApproval: async (_task, run, deliveryKey) => {
      await notifyTaskApproval(run, deliveryKey);
    },
  });
  await taskScheduler.start();
  log.info("task scheduler started");

  // 7. guided-learning scheduler. A prepared lesson remains retryable until
  // Feishu accepts it; an accepted lesson then waits for the learner's answer.
  learningScheduler = new LearningScheduler(engine, {
    notify: async (plan, _source, session, skillWarnings, deliveryKey) => {
      await sendFeishuNotice(
        plan.space,
        plan.chatId,
        learningNotification(plan, session, skillWarnings),
        deliveryKey,
      );
    },
    followUp: async (plan, _session, message, deliveryKey) => {
      await sendFeishuNotice(plan.space, plan.chatId, message, deliveryKey);
    },
  });
  await learningScheduler.start();
  log.info("learning scheduler started");

  // 8. user reminder scheduler. Delivery state advances only after Feishu
  // accepts the outbound message, so transient failures remain retryable.
  reminderScheduler = new ReminderScheduler(engine, {
    notify: async (reminder, message, deliveryKey) => {
      await sendFeishuNotice(reminder.space, reminder.chatId, message, deliveryKey);
    },
  });
  await reminderScheduler.start();
  log.info("reminder scheduler started");

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutting down", { signal });
    const contain = (label: string, action: () => void) => {
      try {
        action();
      } catch (err) {
        log.error(`${label} shutdown failed`, { err: String(err) });
      }
    };
    contain("dream scheduler", () => scheduler.stop());
    contain("Wiki Maintenance scheduler", () => maintenanceScheduler.stop());
    contain("work continuation scheduler", () => workContinuationScheduler.stop());
    contain("task scheduler", () => taskScheduler.stop());
    contain("learning scheduler", () => learningScheduler.stop());
    contain("reminder scheduler", () => reminderScheduler.stop());
    contain("web server", () => server.stop(true));
    try {
      await orchestrator.stop();
    } catch (err) {
      log.error("orchestrator shutdown failed", { err: String(err) });
    }
    contain("knowledge engine", () => engine.close());
    stopLogMaintenance();
    processLock.release();
    log.info("shutdown complete");
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // Keep the process alive; connectors + scheduler run in the background.
  await new Promise<void>(() => {});
}

export async function serve(
  options: { dataDirectoryWasUninitializedAtStartup?: boolean } = {},
): Promise<void> {
  const cfg = config();
  assertSafeWebBinding(cfg.webHost, cfg.webAdminToken);
  const processLock = acquireProcessLock({ dataDir: cfg.dataDir });
  try {
    await run(cfg, processLock, options);
  } catch (err) {
    processLock.release();
    throw err;
  }
}

export type AppCommand =
  | "serve"
  | "desktop"
  | "service"
  | "doctor"
  | "mcp"
  | "knowledge"
  | "feedback"
  | "unknown";

export function selectAppCommand(args: string[], bundled: boolean): AppCommand {
  const command = args[0];
  if (!command) return bundled ? "desktop" : "serve";
  if (["serve", "desktop", "service", "doctor", "mcp", "knowledge", "feedback"].includes(command)) {
    return command as AppCommand;
  }
  return "unknown";
}

export async function runEntrypoint(args = process.argv.slice(2)): Promise<number> {
  let paths = resolveRuntimePaths();
  const command = selectAppCommand(args, paths.bundled);
  const dataDirectoryWasUninitializedAtStartup = command === "serve"
    && dataDirectoryWasUninitialized(paths.dataDir);
  const externalDataDirectory = brandedEnv(process.env, "DATA_DIR") !== undefined
    && process.env.HOMEAGENT_SERVICE_MANAGED !== "1";
  if (command === "serve" && !externalDataDirectory) {
    const settingsPath = runtimeDataSettingsPath({
      bundled: paths.bundled,
      appRoot: paths.appRoot,
    });
    const migration = applyPendingDataDirectoryMigration({ settingsPath });
    if (migration.state === "completed") {
      log.info("data directory migration completed", {
        source: migration.source,
        destination: migration.destination,
        gitInitialized: migration.gitInitialized,
      });
    } else if (migration.state === "failed") {
      log.error("data directory migration failed; keeping the previous directory", {
        source: migration.source,
        destination: migration.destination,
        error: migration.error,
      });
    }
    paths = resolveRuntimePaths();
  }
  process.env.HOMEAGENT_DATA_DIR_LOCKED = externalDataDirectory ? "1" : "0";
  configureRuntimeEnvironment(paths);
  if (command === "mcp" || command === "knowledge" || command === "feedback") {
    const cfg = config();
    const client = new LocalAgentApiClient({
      baseUrl: localAgentApiBaseUrl(cfg),
      token: cfg.agentReadToken ?? cfg.webAdminToken,
      feedbackToken: cfg.agentFeedbackToken,
    });
    if (command === "mcp") {
      await runKnowledgeMcpStdio(client, {
        feedbackEnabled: !cfg.webAdminToken || Boolean(cfg.agentFeedbackToken),
      });
      return 0;
    }
    if (command === "knowledge") {
      return runKnowledgeCli(args.slice(1), { caller: client });
    }
    return runFeedbackCli(args.slice(1), { caller: client });
  }
  if (command === "serve") {
    await serve({ dataDirectoryWasUninitializedAtStartup });
    return 0;
  }
  if (command === "desktop") {
    const service = createDefaultService();
    if (paths.bundled) {
      const { prepareLegacyDataMigration } = await import("./data-migration.ts");
      const migration = await prepareLegacyDataMigration({
        destinationDir: paths.dataDir,
        beforeCopy: () => service.retireLegacyService(),
      });
      if (migration === "exit") return 0;
    }
    const result = await launchDesktop({
      service,
      port: config().webPort,
    });
    return result.action === "failed" ? 1 : 0;
  }
  if (command === "service") {
    return runServiceCli(args.slice(1), { service: createDefaultService() });
  }
  if (command === "doctor") {
    const { runDoctorCli } = await import("./doctor.ts");
    return runDoctorCli(args.slice(1));
  }
  process.stderr.write("Usage: homeagent <serve|desktop|service|doctor|mcp|knowledge>\n");
  return 2;
}

if (import.meta.main) {
  runEntrypoint().then(
    (code) => { process.exitCode = code; },
    (err) => {
      log.error("fatal", { err: String(err) });
      process.exitCode = 1;
    },
  );
}
