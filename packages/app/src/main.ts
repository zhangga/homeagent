/**
 * homeagent production entrypoint. Assembles the full system over one shared
 * KnowledgeEngine:
 *   - the feishu connector + orchestrator (inbound events -> knowledge + replies)
 *   - the read-only web backend (Bun.serve + Hono)
 *   - the dream-cycle scheduler (nightly + startup catch-up)
 * and shuts everything down gracefully on SIGINT/SIGTERM (propagating SIGTERM to
 * the lark-cli consumers — never kill -9).
 */
import {
  assertSafeWebBinding,
  config,
  logger,
  saveSettings,
  type LarkSetupStatus,
} from "@homeagent/shared";
import { accessSync, constants, statSync } from "node:fs";
import { join } from "node:path";
import { KnowledgeEngine } from "@homeagent/core";
import { CodexProviderSetup, CodexReleaseInstaller } from "@homeagent/llm";
import { FeishuConnector, LarkCliSetup } from "@homeagent/connectors";
import {
  Orchestrator,
  createNativeExtractor,
  extractAttachmentText,
} from "@homeagent/orchestrator";
import { createWebApp, FeishuIntegrationService } from "@homeagent/web";
import { Scheduler } from "./scheduler.ts";
import { TaskScheduler } from "./task-scheduler.ts";
import { LearningScheduler, learningNotification } from "./learning-scheduler.ts";
import { ReminderScheduler } from "./reminder-scheduler.ts";
import { createSystemHealthReporter } from "./health.ts";
import {
  homeAgentFeishuAvatarPath,
  resolveRuntimePaths,
} from "./runtime-paths.ts";
import { launchDesktop } from "./desktop.ts";
import { createDefaultService, runServiceCli } from "./service-cli.ts";
import {
  acquireProcessLock,
  runtimeServiceStatus,
  startServiceLogMaintenance,
  type ProcessLock,
} from "./service.ts";

const log = logger.child("app");

export function isUsableManagedExecutable(path: string): boolean {
  try {
    const info = statSync(path);
    if (!info.isFile() || info.size === 0) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
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

async function run(cfg: ReturnType<typeof config>, processLock: ProcessLock): Promise<void> {
  const runtimePaths = resolveRuntimePaths();
  const stopLogMaintenance = startServiceLogMaintenance(cfg.dataDir);
  log.info("starting homeagent", {
    dataDir: cfg.dataDir,
    model: cfg.model,
    webHost: cfg.webHost,
    webPort: cfg.webPort,
  });

  const engine = new KnowledgeEngine({ recoverInterruptedTaskRuns: true });
  const larkSetup = new LarkCliSetup({ larkBin: runtimePaths.larkBin });
  const feishuStartup = await prepareFeishuStartup(
    engine,
    larkSetup,
    cfg.feishuConnectionDisabledAppId,
  );

  // 1. feishu connector + orchestrator
  const connector = new FeishuConnector({ larkBin: runtimePaths.larkBin });
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
    docFetcher: (link) => connector.fetchDoc(link),
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
    await connector.notice(chatId, text);
  };

  // Push a task's summary to its space-bound feishu chat (shared by the task
  // scheduler and the backend's manual "run now").
  const notifyTaskDone = async (space: string, name: string, summary?: string) => {
    const chatId = engine.registry.get(space as never)?.chatId;
    if (!chatId) throw new Error(`task space has no bound Feishu chat: ${space}`);
    if (!summary) throw new Error(`task run has no notification summary: ${name}`);
    await sendFeishuNotice(
      space,
      chatId,
      `🔎 任务「${name}」已完成：\n\n${summary}`,
    );
  };

  let scheduler: Scheduler | undefined;
  let taskScheduler: TaskScheduler | undefined;
  let learningScheduler: LearningScheduler | undefined;
  let reminderScheduler: ReminderScheduler | undefined;
  const reportHealth = createSystemHealthReporter({
    engine,
    connectorHealth: () => connector.health(),
    feishuLocallyDisabled: () => feishuLocallyDisabled,
    dreamSchedulerHealth: () => scheduler?.health(),
    taskSchedulerHealth: () => taskScheduler?.health(),
    reminderSchedulerHealth: () => reminderScheduler?.health(),
    learningSchedulerHealth: () => learningScheduler?.health(),
    runtimeHealth: () => orchestrator.health(),
    serviceHealth: () => runtimeServiceStatus({ startedAt: processLock.startedAt }),
  });

  // 2. management web backend
  const managedCodexBin = join(runtimePaths.dataDir, "bin", "codex");
  const codexProviderSetup = runtimePaths.bundled
    ? new CodexProviderSetup({ codexBin: managedCodexBin })
    : undefined;
  const codexInstaller = runtimePaths.bundled
    ? new CodexReleaseInstaller({ dataDir: runtimePaths.dataDir })
    : undefined;
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
    health: reportHealth,
    larkSetup,
    codexSetup: codexProviderSetup && codexInstaller
      ? {
          canInstall: true,
          isInstalled: () => isUsableManagedExecutable(managedCodexBin),
          install: async (consented) => {
            await codexInstaller.installAfterConsent(consented);
          },
          startDeviceLogin: () => codexProviderSetup.startDeviceLogin(),
          deviceLoginStatus: () => codexProviderSetup.deviceLoginStatus(),
          cancelDeviceLogin: () => codexProviderSetup.cancelDeviceLogin(),
        }
      : undefined,
    feishuRuntime: () => connector.health(),
    activeFeishuIdentity: feishuOutboundEnabled && cfg.feishuBotName && cfg.feishuBotOpenId
      ? { botName: cfg.feishuBotName, botOpenId: cfg.feishuBotOpenId }
      : undefined,
    feishuIntegration,
    onIntegrationTest: async (chatId, text) =>
      sendFeishuNotice(`team/${chatId}`, chatId, text),
    onTaskRun: async (_taskId, run) => {
      await notifyTaskDone(run.space, run.taskName, run.summary);
    },
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

  // 4. task scheduler (research tasks). On completion, push a summary to the
  // task's space-bound feishu chat when the task opts in.
  taskScheduler = new TaskScheduler(engine, {
    notify: async (_task, run) => {
      await notifyTaskDone(run.space, run.taskName, run.summary);
    },
  });
  await taskScheduler.start();
  log.info("task scheduler started");

  // 5. guided-learning scheduler. A prepared lesson remains retryable until
  // Feishu accepts it; an accepted lesson then waits for the learner's answer.
  learningScheduler = new LearningScheduler(engine, {
    notify: async (plan, _source, session) => {
      await sendFeishuNotice(
        plan.space,
        plan.chatId,
        learningNotification(plan, session),
      );
    },
    followUp: async (plan, _session, message) => {
      await sendFeishuNotice(plan.space, plan.chatId, message);
    },
  });
  await learningScheduler.start();
  log.info("learning scheduler started");

  // 6. user reminder scheduler. Delivery state advances only after Feishu
  // accepts the outbound message, so transient failures remain retryable.
  reminderScheduler = new ReminderScheduler(engine, {
    notify: async (reminder, message) => {
      await sendFeishuNotice(reminder.space, reminder.chatId, message);
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

export async function serve(): Promise<void> {
  const cfg = config();
  assertSafeWebBinding(cfg.webHost, cfg.webAdminToken);
  const processLock = acquireProcessLock({ dataDir: cfg.dataDir });
  try {
    await run(cfg, processLock);
  } catch (err) {
    processLock.release();
    throw err;
  }
}

export type AppCommand = "serve" | "desktop" | "service" | "doctor" | "unknown";

export function selectAppCommand(args: string[], bundled: boolean): AppCommand {
  const command = args[0];
  if (!command) return bundled ? "desktop" : "serve";
  if (["serve", "desktop", "service", "doctor"].includes(command)) return command as AppCommand;
  return "unknown";
}

export async function runEntrypoint(args = process.argv.slice(2)): Promise<number> {
  const paths = resolveRuntimePaths();
  if (paths.bundled) {
    process.env.HOMEAGENT_DATA_DIR ??= paths.dataDir;
    process.env.HOMEAGENT_LOG_DIR ??= paths.logDir;
    process.env.HOMEAGENT_CODEX_BIN ??= join(paths.dataDir, "bin", "codex");
  }
  const command = selectAppCommand(args, paths.bundled);
  if (command === "serve") {
    await serve();
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
  process.stderr.write("Usage: homeagent <serve|desktop|service|doctor>\n");
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
