/**
 * The management web backend. A Hono app over the same KnowledgeEngine the
 * orchestrator uses. Structured like mew: Spaces/Knowledge, Agents,
 * Integrations, Logs, Settings. Unlike the previous read-only viewer this app
 * mutates state — it creates/edits Agents, binds per-group settings, and edits
 * global settings — via POST forms. It shares one engine instance in production
 * so edits are seen immediately by the orchestrator and scheduler.
 *
 * Authentication is optional for loopback-only use and mandatory at the
 * production entrypoint for non-local binding. All dynamic values render
 * through hono/html (auto-escaped); redirects use the PRG pattern with a ?ok=
 * flash so a refresh doesn't re-POST.
 */
import { Hono } from "hono";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  accessSync,
  constants as fsConstants,
  readdirSync,
  readFileSync,
  existsSync,
  statSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  config,
  logger,
  saveSettings,
  MAX_CHAT_TIMEOUT_MINUTES,
  MIN_CHAT_TIMEOUT_MINUTES,
  isSpaceId,
  isLoopbackHost,
  type LarkBotIdentity,
  type LarkProvisioningSession,
  type LarkSetupStatus,
  type SpaceId,
  type PersistedSettings,
  type SystemHealthSnapshot,
} from "@homeagent/shared";
import {
  detectProviders,
  providerSupportsOrdinaryCompletion,
  providerModels,
  type CodexLoginSession,
  type DetectedProvider,
} from "@homeagent/llm";
import {
  isGroupParticipationLevel,
  isAnswerFeedbackKind,
  NEGATIVE_ANSWER_FEEDBACK_KINDS,
  TaskAlreadyRunningError,
  type FeishuResponseMode,
  type GroupParticipationLevel,
  type Agent,
  type ChatRun,
  type KnowledgeEngine,
  type TaskRun,
  type WorkItemPhase,
} from "@homeagent/core";
import { layout } from "./layout.ts";
import { agentWorkbenchView } from "./agent-workbench-view.ts";
import { buildSkillInventory, skillInventoryView } from "./skill-inventory-view.ts";
import {
  agentInputForEditor,
  buildAgentWorkbench,
  editorValuesFor,
  validateAgentEditor,
  type AgentEditorValues,
  type AgentFieldErrors,
  type AgentWorkbenchMode,
} from "./agent-workbench.ts";
import type { CodexSetupPort, FeishuRuntimeStatus, LarkSetupPort } from "./integrations.ts";
import type { FeishuIntegrationService } from "./feishu-integration-service.ts";
import { FeishuIntegrationError } from "./feishu-integration-service.ts";
import { buildSetupSnapshot } from "./setup.ts";
import { localMaterialRawContent, prepareLocalMaterials } from "./local-materials.ts";
import { restartingView, setupLayout, setupView } from "./setup-view.ts";
import {
  resolveExternalSharingState,
  type FeishuExternalSharingStatus,
} from "./external-sharing.ts";
import {
  askView,
  integrationsView,
  learningView,
  healthView,
  feishuGroupConnectView,
  governanceView,
  logsView,
  pageView,
  qualityView,
  quarantineView,
  rawGovernanceDetailView,
  rawListView,
  remindersView,
  settingsView,
  type SettingsFieldErrors,
  type SettingsFormValues,
  spaceDetailView,
  spaceGovernanceView,
  spaceListView,
  chatRunView,
  taskRunView,
  tasksView,
  workItemsView,
} from "./views.ts";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const LOCAL_GOVERNANCE_ACTOR = "local-admin";
const log = logger.child("web");

export interface WebOptions {
  engine: KnowledgeEngine;
  /** Fixed local HomeAgent avatar file; request data never selects this path. */
  brandAvatarPath?: string;
  /** protects all management routes; liveness/readiness probes remain public */
  adminToken?: string;
  /** process-level health reporter; production wires all runtime components */
  health?: () => Promise<SystemHealthSnapshot>;
  /** injected for tests; defaults to probing local CLIs. */
  detectProviders?: () => Promise<DetectedProvider[]>;
  /** injected for tests; defaults to the live gateway + curated CLI catalog. */
  providerModels?: () => Promise<Record<string, string[]>>;
  /** Configure and verify the local lark-cli application without persisting its secret. */
  larkSetup?: LarkSetupPort;
  feishuIntegration?: FeishuIntegrationService;
  /** App-managed Codex installation and ChatGPT authorization. */
  codexSetup?: CodexSetupPort;
  /** Send the setup wizard's explicit test message to a Feishu chat. */
  onIntegrationTest?: (chatId: string, text: string) => Promise<void>;
  /** Current event-consumer readiness, used to verify event subscriptions. */
  feishuRuntime?: () => FeishuRuntimeStatus;
  /** Bot identity snapshotted by the currently running connector. */
  activeFeishuIdentity?: LarkBotIdentity;
  /**
   * Optional hook invoked after a manual task run (backend "立即运行"), so the
   * app can push a summary to feishu. main.ts wires this to connector.notice;
   * unset (tests / no connector) => run still writes to the KB, just no push.
   */
  onTaskRun?: (taskId: string, run: TaskRun) => void | Promise<void>;
  /** Retry a durable text Chat Run through the live orchestrator/connector. */
  onChatRunRetry?: (runId: string) => Promise<ChatRun>;
  /** Cancel a queued or running Chat Run through the live orchestrator. */
  onChatRunCancel?: (runId: string) => boolean;
  /** Gracefully terminate a launchd-managed process so KeepAlive can restart it. */
  onServiceRestart?: () => void;
  /** Persistent bootstrap storage used to move the data root on a safe restart. */
  dataDirectory?: DataDirectoryPort;
}

export interface DataDirectoryStatus {
  currentPath: string;
  available: boolean;
  lockedByEnvironment: boolean;
  gitAvailable: boolean;
  gitRepository: boolean;
  restartable: boolean;
  migrationError?: string;
  pendingMigration?: {
    destination: string;
    initializeGit: boolean;
    requestedAt: number;
  };
  lastMigration?: {
    source: string;
    destination: string;
    completedAt: number;
    gitInitialized: boolean;
  };
}

export interface DataDirectoryPort {
  status: () => DataDirectoryStatus | Promise<DataDirectoryStatus>;
  scheduleMigration: (input: {
    destination: string;
    initializeGit: boolean;
  }) => void | Promise<void>;
}

/** Read a checkbox from a parsed form body (present => true). */
function checkbox(body: Record<string, unknown>, name: string): boolean {
  const v = body[name];
  return v === "on" || v === "true" || v === "1";
}

function str(body: Record<string, unknown>, name: string): string {
  const v = body[name];
  return typeof v === "string" ? v : "";
}

function parseSettingsForm(body: Record<string, unknown>): {
  values: SettingsFormValues;
  errors: SettingsFieldErrors;
  patch?: PersistedSettings;
} {
  const values: SettingsFormValues = {
    defaultProvider: str(body, "defaultProvider"),
    defaultModel: str(body, "defaultModel"),
    dailyBudgetUsd: str(body, "dailyBudgetUsd"),
    chatTimeoutMinutes:
      str(body, "chatTimeoutMinutes") || String(config().chatTimeoutMinutes),
    dreamHour: str(body, "dreamHour"),
    rawRetentionDays: str(body, "rawRetentionDays"),
    webPort: str(body, "webPort"),
  };
  const errors: SettingsFieldErrors = {};
  const budget = Number(values.dailyBudgetUsd);
  if (values.dailyBudgetUsd.trim() === "" || !Number.isFinite(budget)) {
    errors.dailyBudgetUsd = "每日预算必须是有效数字";
  } else if (budget < 0) {
    errors.dailyBudgetUsd = "每日预算不能小于 0";
  }
  const chatTimeoutMinutes = Number(values.chatTimeoutMinutes);
  if (
    values.chatTimeoutMinutes.trim() === ""
    || !Number.isInteger(chatTimeoutMinutes)
    || chatTimeoutMinutes < MIN_CHAT_TIMEOUT_MINUTES
    || chatTimeoutMinutes > MAX_CHAT_TIMEOUT_MINUTES
  ) {
    errors.chatTimeoutMinutes = `聊天最长回答时间必须是 ${MIN_CHAT_TIMEOUT_MINUTES} 到 ${MAX_CHAT_TIMEOUT_MINUTES} 的整数`;
  }
  const hour = Number(values.dreamHour);
  if (
    values.dreamHour.trim() === ""
    || !Number.isInteger(hour)
    || hour < 0
    || hour > 23
  ) {
    errors.dreamHour = "提炼时刻必须是 0 到 23 的整数";
  }
  const retentionDays = Number(values.rawRetentionDays);
  if (
    values.rawRetentionDays.trim() === ""
    || !Number.isInteger(retentionDays)
    || retentionDays < 0
    || retentionDays > 36_500
  ) {
    errors.rawRetentionDays = "保留天数必须是 0 到 36500 的整数";
  }
  const port = Number(values.webPort);
  if (
    values.webPort.trim() === ""
    || !Number.isInteger(port)
    || port < 1
    || port > 65_535
  ) {
    errors.webPort = "后台端口必须是 1 到 65535 的整数";
  }
  if (Object.keys(errors).length > 0) return { values, errors };

  const patch: PersistedSettings = {
    defaultProvider: values.defaultProvider,
    defaultModel: values.defaultModel,
    dailyBudgetUsd: budget,
    chatTimeoutMinutes,
    dreamHour: hour,
    rawRetentionDays: retentionDays,
    webPort: port,
  };
  return { values, errors, patch };
}

function parseGroupParticipationLevel(body: Record<string, unknown>): GroupParticipationLevel {
  const value = str(body, "participationLevel");
  return isGroupParticipationLevel(value) ? value : "balanced";
}

function agentRunLimit(raw: string | undefined): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 20;
  return Math.min(100, Math.max(20, Math.ceil(parsed / 20) * 20));
}

function parseFeishuResponseMode(
  body: Record<string, unknown>,
): FeishuResponseMode {
  const value = str(body, "responseMode");
  return value === "smart" || value === "all_messages"
    ? value
    : "mentions_only";
}

function feishuIntegrationMessage(error: unknown): string {
  if (!(error instanceof FeishuIntegrationError)) {
    return "操作失败：飞书连接暂时不可用";
  }
  switch (error.code) {
    case "bot_not_ready":
      return "操作失败：请先连接并验证飞书 Bot";
    case "chat_not_visible":
      return "连接失败：Bot 已不在该群，或无权读取群信息";
    case "capability_required":
      return "保存失败：当前应用缺少完整群消息权限，请改用仅 @ 回复或补齐权限";
    case "binding_not_found":
      return "操作失败：没有找到该群连接";
    case "test_failed":
      return "测试失败：请检查发送权限、Bot 群成员状态和运行状态";
    case "prompt_failed":
      return "确认提示发送失败：待确认状态已保留，请稍后重试";
    case "storage_conflict":
      return "连接失败：群空间路径与现有空间冲突";
    case "invalid_input":
      return "保存失败：群配置无效";
    case "operation_unavailable":
    default:
      return "操作失败：当前运行方式不支持此操作";
  }
}

function equalSecret(candidate: string, expected: string): boolean {
  const candidateHash = createHash("sha256").update(candidate).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(candidateHash, expectedHash);
}

function isAuthorized(header: string | undefined, token: string): boolean {
  if (!header) return false;
  const separator = header.indexOf(" ");
  if (separator <= 0) return false;
  const scheme = header.slice(0, separator).toLowerCase();
  const credential = header.slice(separator + 1).trim();
  if (scheme === "bearer") return equalSecret(credential, token);
  if (scheme !== "basic") return false;
  try {
    const decoded = Buffer.from(credential, "base64").toString("utf8");
    const colon = decoded.indexOf(":");
    return colon >= 0 && equalSecret(decoded.slice(colon + 1), token);
  } catch {
    return false;
  }
}

function isCrossSiteMutation(request: Request): boolean {
  if (!MUTATING_METHODS.has(request.method.toUpperCase())) {
    return false;
  }
  if (request.headers.get("sec-fetch-site")?.toLowerCase() === "cross-site") return true;
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    const expectedHost = request.headers.get("x-forwarded-host")
      ?? request.headers.get("host")
      ?? new URL(request.url).host;
    return new URL(origin).host !== expectedHost.split(",", 1)[0]!.trim();
  } catch {
    return true;
  }
}

function requestHostname(request: Request): string {
  const host = request.headers.get("host") ?? new URL(request.url).host;
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return "";
  }
}

function isReadableBrandAvatar(path?: string): boolean {
  if (!path || !isAbsolute(path)) return false;
  try {
    accessSync(path, fsConstants.R_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function createWebApp(opts: WebOptions): Hono {
  const { engine } = opts;
  const app = new Hono();
  const instanceId = randomUUID();

  if (opts.adminToken) {
    const token = opts.adminToken;
    app.use("*", async (c, next) => {
      if (c.req.path === "/healthz" || c.req.path === "/readyz") return next();
      if (isAuthorized(c.req.header("authorization"), token)) return next();
      c.header("www-authenticate", 'Basic realm="homeagent", charset="UTF-8"');
      return c.text("Unauthorized", 401);
    });
  } else {
    app.use("*", async (c, next) => {
      if (!isLoopbackHost(requestHostname(c.req.raw))) return c.text("Forbidden", 403);
      return next();
    });
  }
  app.use("*", async (c, next) => {
    if (isCrossSiteMutation(c.req.raw)) return c.text("Forbidden", 403);
    return next();
  });

  app.get("/brand/homeagent-feishu-avatar.png", (c) => {
    if (!isReadableBrandAvatar(opts.brandAvatarPath)) {
      return c.text("HomeAgent Feishu avatar is unavailable.", 404);
    }
    try {
      const bytes = readFileSync(opts.brandAvatarPath!);
      return new Response(bytes, {
        headers: {
          "cache-control": "no-store",
          "content-disposition":
            'attachment; filename="HomeAgent-Feishu-Avatar.png"',
          "content-type": "image/png",
          "x-content-type-options": "nosniff",
        },
      });
    } catch {
      return c.text("HomeAgent Feishu avatar is unavailable.", 404);
    }
  });

  // Detect local agent CLIs once, lazily, then cache (probing spawns processes).
  const detect = opts.detectProviders ?? detectProviders;
  const listModels = opts.providerModels ?? providerModels;
  const reportHealth =
    opts.health ??
    (async (): Promise<SystemHealthSnapshot> => {
      const core = await engine.health();
      return {
        status: core.ok ? "ok" : "down",
        ready: core.ok,
        checkedAt: Date.now(),
        components: {
          knowledge: {
            status: core.ok ? "ok" : "down",
            summary: core.ok ? "知识引擎可用" : "知识引擎不可用",
            details: core.details,
          },
        },
      };
    });
  const getHealth = async (): Promise<SystemHealthSnapshot> => {
    try {
      return await reportHealth();
    } catch (err) {
      return {
        status: "down",
        ready: false,
        checkedAt: Date.now(),
        components: {
          healthReporter: {
            status: "down",
            summary: "运行状态聚合失败",
            details: { error: String(err) },
          },
        },
      };
    }
  };
  let providerCache: DetectedProvider[] | null = null;
  let modelCache: Record<string, string[]> | null = null;
  let codexInstalling = false;
  let codexInstallError: string | undefined;
  const getProviders = async (): Promise<DetectedProvider[]> => {
    if (!providerCache) providerCache = await detect();
    return providerCache;
  };
  // Model catalog: gateway list is fetched live from /v1/models (cached here so
  // we don't hit it on every render); CLI lists are curated.
  const getModels = async (): Promise<Record<string, string[]>> => {
    if (!modelCache) modelCache = await listModels();
    return modelCache;
  };
  const agentValuesFromBody = (
    body: Record<string, unknown>,
    fallback: AgentEditorValues,
  ): AgentEditorValues => {
    type TextField = Exclude<
      keyof AgentEditorValues,
      "skillSourceKeys" | "legacySkillNames"
    >;
    const value = (name: TextField): string => (
      typeof body[name] === "string" ? body[name] : fallback[name]
    );
    const list = (name: "skillSourceKeys" | "legacySkillNames"): string[] => {
      const raw = body[name];
      return (Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [])
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean);
    };
    const catalogSelector = body.skillSelectorPresent === "1";
    return {
      name: value("name"),
      instruction: value("instruction"),
      provider: value("provider"),
      model: value("model"),
      // Non-Codex editors disable this select, so browsers intentionally omit it.
      reasoningEffort: typeof body.reasoningEffort === "string"
        ? body.reasoningEffort
        : "",
      visibility: value("visibility"),
      permission: value("permission"),
      workdir: value("workdir"),
      skills: value("skills"),
      ...(catalogSelector
        ? {
            skillSourceKeys: list("skillSourceKeys"),
            legacySkillNames: list("legacySkillNames"),
          }
        : {}),
    };
  };
  const renderAgentWorkbench = async (input: {
    mode: AgentWorkbenchMode;
    selected?: Agent | null;
    values?: AgentEditorValues;
    errors?: AgentFieldErrors;
    flash?: string;
    formError?: string;
    runLimit?: number;
    expectedHeadRevisionId?: string;
  }) => {
    const agents = engine.agents.list();
    const selected = input.selected ?? null;
    const providers = await getProviders();
    const models = await getModels();
    let catalog;
    try {
      catalog = engine.skillCatalog.current();
    } catch {
      catalog = undefined;
    }
    const cfg = config();
    const runLimit = input.runLimit ?? 20;
    const allRuns = selected ? engine.listAgentRuns(selected.id, 100) : [];
    const activityRuns = selected
      ? engine.listAgentActivityRuns(selected.id, 100)
      : [];
    return agentWorkbenchView(buildAgentWorkbench({
      agents,
      mode: input.mode,
      selected,
      providers,
      models,
      defaults: { provider: cfg.defaultProvider, model: cfg.defaultModel },
      bindings: selected ? engine.agentBindings(selected.id) : [],
      runs: allRuns,
      activityRuns,
      runTotal: activityRuns.length,
      runLimit,
      listRuns: engine.listTaskRuns(),
      values: input.values,
      errors: input.errors,
      flash: input.flash,
      formError: input.formError,
      catalog,
      revisions: selected ? engine.agents.listRevisions(selected.id) : [],
      draft: selected ? engine.agents.getDraft(selected.id) : undefined,
      expectedHeadRevisionId: input.expectedHeadRevisionId,
    }));
  };
  const idleCodexLogin = (): CodexLoginSession => ({
    state: "idle",
    message: "尚未连接 ChatGPT",
  });
  const getCodexLogin = (): CodexLoginSession => {
    try {
      return opts.codexSetup?.deviceLoginStatus() ?? idleCodexLogin();
    } catch {
      return { state: "failed", message: "无法读取 ChatGPT 登录状态，请重试" };
    }
  };
  const isCodexInstalled = (): boolean => {
    try {
      return opts.codexSetup?.isInstalled() ?? false;
    } catch {
      return false;
    }
  };
  const persistReadyCodex = (session: CodexLoginSession): void => {
    if (session.state !== "ready") return;
    // Refresh provider discovery so first-run setup can offer the newly logged-in
    // Codex for ordinary conversations and explicit Agent tasks.
    providerCache = null;
  };
  const startCodexLogin = (): void => {
    if (!opts.codexSetup) return;
    codexInstallError = undefined;
    void opts.codexSetup.startDeviceLogin().then(persistReadyCodex).catch(() => {
      codexInstallError = "ChatGPT 登录未完成，请重试";
    });
  };
  const getLarkStatus = async (): Promise<LarkSetupStatus> => {
    if (!opts.larkSetup) {
      return {
        state: "unavailable",
        verified: false,
        message: "当前运行方式未接入 lark-cli 配置服务",
      };
    }
    try {
      return await opts.larkSetup.status();
    } catch {
      return {
        state: "invalid",
        verified: false,
        message: "无法读取 lark-cli 连接状态",
      };
    }
  };
  const getFeishuRuntime = (): FeishuRuntimeStatus | undefined => {
    try {
      return opts.feishuRuntime?.();
    } catch {
      return { ready: false, consumers: [] };
    }
  };
  const persistVerifiedBot = (status: LarkSetupStatus): boolean => {
    const identity = verifiedBotIdentity(status);
    if (!identity) return false;
    saveSettings({
      feishuBotName: identity.botName,
      feishuBotOpenId: identity.botOpenId,
      feishuConnectionDisabledAppId: "",
    });
    return true;
  };
  const idleProvisioning = (): LarkProvisioningSession => ({
    state: "idle",
    brand: "feishu",
    message: opts.larkSetup ? "尚未开始创建飞书应用" : "未检测到飞书配置组件",
  });
  const getProvisioning = (): LarkProvisioningSession => {
    try {
      return opts.larkSetup?.provisioningStatus?.() ?? idleProvisioning();
    } catch {
      return {
        state: "failed",
        brand: "feishu",
        message: "无法读取飞书应用创建状态，请重试",
      };
    }
  };
  const getExternalSharing = async (
    status: LarkSetupStatus,
  ): Promise<FeishuExternalSharingStatus> => {
    if (
      status.state !== "ready"
      || !status.verified
      || !status.appId
      || status.brand === "lark"
    ) {
      return { state: "skipped" };
    }
    let sharing = resolveExternalSharingState(config(), status.appId);
    if (
      sharing.state === "awaiting_external_message"
      && sharing.startedAt
      && opts.larkSetup?.chatIsExternal
    ) {
      const candidates = new Map<string, string | undefined>();
      for (const meta of engine.registry.list().filter((entry) => entry.id.startsWith("team/"))) {
        const messages = engine.registry.store(meta.id).index().listRaw({}).filter(
          (entry) => entry.source === "message" && entry.createdAt >= sharing.startedAt!,
        );
        for (const entry of messages) {
          const chatId = entry.chatId ?? meta.chatId ?? meta.id.slice("team/".length);
          if (chatId) candidates.set(chatId, meta.name);
        }
      }
      for (const [chatId, groupName] of candidates) {
        let external = false;
        try {
          external = await opts.larkSetup.chatIsExternal(chatId);
        } catch {
          external = false;
        }
        if (!external) continue;
        saveSettings({
          feishuExternalSharingVerifiedAt: Date.now(),
          feishuExternalSharingVerifiedChatId: chatId,
        });
        sharing = {
          ...resolveExternalSharingState(config(), status.appId),
          ...(groupName ? { verifiedGroupName: groupName } : {}),
        };
        break;
      }
    }
    if (sharing.state === "verified" && !sharing.verifiedGroupName && sharing.verifiedChatId) {
      const group = engine.registry.list().find((meta) =>
        meta.chatId === sharing.verifiedChatId
        || meta.id === `team/${sharing.verifiedChatId}`
      );
      if (group?.name) sharing = { ...sharing, verifiedGroupName: group.name };
    }
    return sharing;
  };
  const integrationIdentityState = (status: LarkSetupStatus) => {
    const setupIdentity = verifiedBotIdentity(status);
    const activeIdentity = opts.activeFeishuIdentity;
    const restartRequired = Boolean(setupIdentity) && (
      !activeIdentity
      || activeIdentity.botName !== setupIdentity!.botName
      || activeIdentity.botOpenId !== setupIdentity!.botOpenId
    );
    return { setupIdentity, restartRequired };
  };
  const getSetupContext = async () => {
    let lark = await getLarkStatus();
    const provisioning = getProvisioning();
    const codexLogin = getCodexLogin();
    persistReadyCodex(codexLogin);
    const before = config();
    const identity = verifiedBotIdentity(lark);
    if (
      identity
      && (before.feishuBotName !== identity.botName || before.feishuBotOpenId !== identity.botOpenId)
    ) {
      persistVerifiedBot(lark);
      lark = await getLarkStatus();
    }
    let cfg = config();
    if (!cfg.onboardingCompletedAt && !cfg.onboardingStartedAt) {
      saveSettings({ onboardingStartedAt: Date.now() });
      cfg = config();
    }
    const providers = await getProviders();
    const runtime = getFeishuRuntime() ?? { ready: false, consumers: [] };
    const activeBindings = engine.feishuBindings.list().filter(
      (binding) => binding.state === "active",
    );
    const groups = activeBindings
      .map((binding) => engine.registry.get(binding.spaceId))
      .filter((meta): meta is NonNullable<typeof meta> => meta !== undefined);
    const { restartRequired } = integrationIdentityState(lark);
    const health = await getHealth();
    const restartable = health.components.service?.details?.managed === true
      && opts.onServiceRestart !== undefined;
    return {
      snapshot: buildSetupSnapshot({
        defaultProvider: cfg.defaultProvider,
        providers,
        lark,
        runtime,
        restartRequired,
      }),
      providers,
      lark,
      provisioning,
      runtime,
      groups,
      restartRequired,
      restartable,
      codex: {
        enabled: opts.codexSetup !== undefined,
        canInstall: opts.codexSetup?.canInstall ?? false,
        installed: isCodexInstalled(),
        installing: codexInstalling,
        ...(codexInstallError ? { installError: codexInstallError } : {}),
        login: codexLogin,
      },
    };
  };

  const parseSpace = (raw: string): SpaceId | null => {
    const decoded = decodeURIComponent(raw);
    return isSpaceId(decoded) ? decoded : null;
  };

  // ---- health probes ------------------------------------------------------

  app.get("/healthz", async (c) => {
    c.header("cache-control", "no-store");
    return c.json({ status: "ok", checkedAt: Date.now(), instanceId, pid: process.pid });
  });

  app.get("/readyz", async (c) => {
    c.header("cache-control", "no-store");
    const snapshot = await getHealth();
    return snapshot.ready ? c.json(snapshot) : c.json(snapshot, 503);
  });

  app.get("/health", async (c) => {
    return c.html(
      await layout(
        "运行状态",
        [{ label: "运行状态" }],
        await healthView(
          await getHealth(),
          c.req.query("ok") ?? undefined,
          opts.onServiceRestart !== undefined,
        ),
        "health",
      ),
    );
  });

  app.post("/service/restart", async (c) => {
    const snapshot = await getHealth();
    const managed = snapshot.components.service?.details?.managed === true;
    if (!managed || !opts.onServiceRestart) return c.text("Service restart unavailable", 409);
    opts.onServiceRestart();
    return c.redirect(`/health?ok=${encodeURIComponent("已请求后台服务安全重启")}`);
  });

  app.get("/quality", async (c) => {
    const status = c.req.query("status") === "resolved" ? "resolved" : "open";
    const reviews = engine.answerFeedbackReviews({
      status,
      kinds: NEGATIVE_ANSWER_FEEDBACK_KINDS,
    }).reverse();
    const reviewItems = await Promise.all(reviews.map(async (review) => ({
      review,
      citations: await Promise.all(review.trace.citations.map(async (citation) => {
        const spaces: SpaceId[] = [];
        const retrievalSpaces = review.trace.retrievalPages
          ?.filter((page) => page.slug === citation.slug)
          .map((page) => page.space) ?? [];
        const candidates = citation.space
          ? [citation.space]
          : retrievalSpaces.length > 0
            ? [...new Set(retrievalSpaces)]
            : review.trace.spaces;
        for (const space of candidates) {
          if (await engine.getPage(space, citation.slug)) spaces.push(space);
        }
        return { citation, spaces };
      })),
    })));
    return c.html(
      await layout(
        "AI 质量反馈",
        [{ label: "AI 质量反馈" }],
        await qualityView(
          reviewItems,
          engine.qualitySnapshot(),
          status,
          engine.qualityEvaluationCases().length,
          c.req.query("ok") ?? undefined,
        ),
        "quality",
      ),
    );
  });

  app.get("/quality/evaluation-cases.json", (c) => {
    c.header("cache-control", "no-store");
    c.header(
      "content-disposition",
      'attachment; filename="homeagent-quality-evaluation-candidates.json"',
    );
    return c.json({
      version: "homeagent.quality-evaluation-candidates.v1",
      exportedAt: Date.now(),
      cases: engine.qualityEvaluationCases(),
    });
  });

  app.post("/quality/:traceId/promote", async (c) => {
    const traceId = c.req.param("traceId");
    const review = engine.answerFeedbackReviews().find((item) => item.trace.id === traceId);
    if (!review) return c.notFound();
    const body = await c.req.parseBody();
    const curatorNote = str(body, "curatorNote").trim();
    if (!curatorNote) return c.text("Calibration note is required", 400);
    const evaluationCase = engine.promoteAnswerFeedback(
      traceId,
      curatorNote,
    );
    if (!evaluationCase) return c.text("Feedback cannot be promoted", 409);
    return c.redirect(
      `/quality?ok=${encodeURIComponent("已加入待校准评测集，等待人工确认标准答案")}`,
    );
  });

  app.post("/quality/:traceId/resolve", async (c) => {
    const traceId = c.req.param("traceId");
    const review = engine.answerFeedbackReviews().find((item) => item.trace.id === traceId);
    if (!review) return c.notFound();
    const body = await c.req.parseBody();
    const resolutionNote = str(body, "resolutionNote").trim();
    if (!resolutionNote) return c.text("Resolution note is required", 400);
    const feedback = engine.resolveAnswerFeedback(
      traceId,
      resolutionNote,
    );
    if (!feedback) return c.text("Feedback already resolved", 409);
    return c.redirect(`/quality?ok=${encodeURIComponent("反馈已标记为解决")}`);
  });

  // ---- guided first-run setup --------------------------------------------

  app.get("/setup", async (c) => {
    const setup = await getSetupContext();
    return c.html(
      await setupLayout(
        await setupView({
          ...setup,
          models: await getModels(),
          flashMsg: c.req.query("ok") ?? undefined,
        }),
      ),
    );
  });

  app.post("/setup/providers/refresh", (c) => {
    providerCache = null;
    return c.redirect("/setup");
  });

  app.post("/setup/ai/codex/install", async (c) => {
    if (!opts.codexSetup?.canInstall) {
      return c.redirect(`/setup?ok=${encodeURIComponent("当前运行方式不支持自动安装 Codex")}`);
    }
    const body = await c.req.parseBody();
    if (!checkbox(body, "consent")) {
      return c.redirect(`/setup?ok=${encodeURIComponent("需要确认后才能安装 Codex")}`);
    }
    if (!codexInstalling) {
      codexInstalling = true;
      codexInstallError = undefined;
      void opts.codexSetup.install(true).then(() => {
        codexInstalling = false;
        providerCache = null;
        startCodexLogin();
      }).catch(() => {
        codexInstalling = false;
        codexInstallError = "Codex 安装未完成，请重试";
      });
    }
    return c.redirect(`/setup?ok=${encodeURIComponent("正在准备 Codex")}`);
  });

  app.post("/setup/ai/codex/login", (c) => {
    if (!opts.codexSetup) {
      return c.redirect(`/setup?ok=${encodeURIComponent("当前运行方式未接入 ChatGPT 登录")}`);
    }
    startCodexLogin();
    return c.redirect(`/setup?ok=${encodeURIComponent("正在打开 ChatGPT 登录")}`);
  });

  app.get("/setup/ai/codex/session", (c) => {
    c.header("cache-control", "no-store");
    if (codexInstalling) {
      return c.json({ state: "installing", message: "正在下载并校验 OpenAI 官方 Codex" });
    }
    if (codexInstallError) return c.json({ state: "failed", message: codexInstallError });
    const session = getCodexLogin();
    persistReadyCodex(session);
    return c.json(session);
  });

  app.post("/setup/ai/codex/cancel", (c) => {
    opts.codexSetup?.cancelDeviceLogin();
    return c.redirect("/setup");
  });

  app.post("/setup/ai", async (c) => {
    const body = await c.req.parseBody();
    const provider = str(body, "provider");
    const selectedProvider = (await getProviders()).find(
      (candidate) => candidate.id === provider,
    );
    if (!selectedProvider?.available) {
      if (provider === "codex" && isCodexInstalled()) {
        return c.redirect(
          `/setup?ok=${encodeURIComponent("ChatGPT 尚未连接，请先完成登录")}`,
        );
      }
      return c.redirect(`/setup?ok=${encodeURIComponent("所选 AI 尚未安装或无法运行")}`);
    }
    if (!providerSupportsOrdinaryCompletion(provider)) {
      return c.redirect(`/setup?ok=${encodeURIComponent("所选 AI 无法安全关闭工具，只能用于显式任务")}`);
    }
    const model = str(body, "model");
    const models = await getModels();
    if (model && !(models[provider] ?? []).includes(model)) {
      return c.redirect(`/setup?ok=${encodeURIComponent("所选模型不属于这个 AI，请重新选择")}`);
    }
    saveSettings({ defaultProvider: provider, defaultModel: model });
    return c.redirect("/setup");
  });

  app.post("/setup/feishu/automatic", async (c) => {
    const body = await c.req.parseBody();
    const returnTo = str(body, "returnTo") === "/integrations" ? "/integrations" : "/setup";
    if (!opts.larkSetup?.startAutomatic) {
      return c.redirect(`${returnTo}?ok=${encodeURIComponent("当前版本未检测到一键创建组件，请使用已有应用连接")}`);
    }
    const brand = str(body, "brand") === "lark" ? "lark" : "feishu";
    try {
      const session = await opts.larkSetup.startAutomatic(brand);
      return c.redirect(`${returnTo}?ok=${encodeURIComponent(session.message)}`);
    } catch {
      return c.redirect(`${returnTo}?ok=${encodeURIComponent("无法启动飞书应用创建，请检查网络后重试")}`);
    }
  });

  app.get("/setup/feishu/session", async (c) => {
    c.header("cache-control", "no-store");
    const session = getProvisioning();
    if (session.state === "ready") {
      const status = await getLarkStatus();
      persistVerifiedBot(status);
    }
    return c.json(session);
  });

  app.post("/setup/feishu/external-sharing/start", async (c) => {
    const body = await c.req.parseBody();
    const returnTo = str(body, "returnTo") === "/integrations" ? "/integrations" : "/setup";
    const status = await getLarkStatus();
    if (
      status.state !== "ready"
      || !status.verified
      || !status.appId
      || status.brand === "lark"
    ) {
      return c.redirect(`${returnTo}?ok=${encodeURIComponent("请先完成飞书机器人连接，再配置对外共享")}`);
    }
    saveSettings({
      feishuExternalSharingAppId: status.appId,
      feishuExternalSharingStartedAt: Date.now(),
      feishuExternalSharingVerifiedAt: 0,
      feishuExternalSharingVerifiedChatId: "",
      feishuExternalSharingSkippedAppId: "",
    });
    return c.redirect(`${returnTo}?ok=${encodeURIComponent("已开始验证；如提示需要重启，请先激活消息监听")}`);
  });

  app.post("/setup/feishu/external-sharing/skip", async (c) => {
    const body = await c.req.parseBody();
    const returnTo = str(body, "returnTo") === "/integrations" ? "/integrations" : "/setup";
    const status = await getLarkStatus();
    if (
      status.state !== "ready"
      || !status.verified
      || !status.appId
      || status.brand === "lark"
    ) {
      return c.redirect(`${returnTo}?ok=${encodeURIComponent("请先完成飞书机器人连接")}`);
    }
    saveSettings({
      feishuExternalSharingAppId: "",
      feishuExternalSharingStartedAt: 0,
      feishuExternalSharingVerifiedAt: 0,
      feishuExternalSharingVerifiedChatId: "",
      feishuExternalSharingSkippedAppId: status.appId,
    });
    return c.redirect(`${returnTo}?ok=${encodeURIComponent("当前机器人将暂时仅供企业内部使用")}`);
  });

  app.post("/setup/restart", async (c) => {
    const snapshot = await getHealth();
    const managed = snapshot.components.service?.details?.managed === true;
    if (!managed || !opts.onServiceRestart) {
      return c.redirect(`/setup?ok=${encodeURIComponent("当前为终端运行，请停止后重新执行 bun start")}`);
    }
    opts.onServiceRestart();
    return c.html(await restartingView(instanceId));
  });

  app.post("/setup/finish", async (c) => {
    const setup = await getSetupContext();
    if (setup.snapshot.current !== "done") {
      return c.redirect(`/setup?ok=${encodeURIComponent("请先完成 AI、飞书机器人和消息监听设置")}`);
    }
    saveSettings({ onboardingCompletedAt: Date.now() });
    return c.redirect("/");
  });

  // ---- data governance ---------------------------------------------------

  app.get("/governance", async (c) => {
    const spaces = engine.registry.list().map((meta) => {
      const index = engine.registry.store(meta.id).index();
      return {
        meta,
        pages: index.countPages(),
        raw: index.countRaw(),
        pending: index.countRaw(true),
        tasks: engine.tasks.list().filter((task) => task.space === meta.id).length,
        learning: engine.learning.listBySpace(meta.id).length,
      };
    });
    return c.html(
      await layout(
        "数据治理",
        [{ label: "数据治理" }],
        await governanceView(spaces, config().rawRetentionDays, c.req.query("ok") ?? undefined),
        "governance",
      ),
    );
  });

  app.get("/spaces/:space/export", async (c) => {
    const space = parseSpace(c.req.param("space"));
    if (!space || !engine.registry.has(space)) return c.notFound();
    const archive = await engine.exportSpace(space);
    const filename = `${space.replace(/[^a-zA-Z0-9._-]+/g, "-")}.homeagent.json`;
    c.header("content-type", "application/json; charset=utf-8");
    c.header("content-disposition", `attachment; filename="${filename}"`);
    c.header("cache-control", "no-store");
    return c.body(JSON.stringify(archive, null, 2));
  });

  app.post("/spaces/:space/delete", async (c) => {
    const space = parseSpace(c.req.param("space"));
    if (!space) return c.notFound();
    try {
      const result = await engine.deleteSpace(space);
      const message = result.status === "deleted"
        ? `已删除 ${space}：${result.pagesDeleted} 个知识页、${result.rawDeleted} 条原始记录、${result.tasksDeleted} 个任务、${result.workItemsDeleted} 个工作项、${result.remindersDeleted} 个提醒、${result.learningPlansDeleted} 个学习计划`
        : `空间不存在：${space}`;
      return c.redirect(`/governance?ok=${encodeURIComponent(message)}`);
    } catch (err) {
      return c.redirect(`/governance?ok=${encodeURIComponent(`删除失败：${String(err)}`)}`);
    }
  });

  app.post("/governance/restore", async (c) => {
    try {
      const body = await c.req.parseBody();
      const upload = body.archive;
      if (!upload || typeof upload === "string") throw new Error("请选择 JSON 归档文件");
      if (upload.size > 50 * 1024 * 1024) throw new Error("归档文件不能超过 50 MB");
      const archive = JSON.parse(await upload.text()) as unknown;
      const restoredSpace = await engine.restoreSpace(archive);
      return c.redirect(`/governance?ok=${encodeURIComponent(`已恢复空间 ${restoredSpace}`)}`);
    } catch (err) {
      return c.redirect(`/governance?ok=${encodeURIComponent(`恢复失败：${String(err)}`)}`);
    }
  });

  app.post("/governance/prune", async (c) => {
    try {
      const report = await engine.pruneRawMessages(config().rawRetentionDays);
      const message = report.retentionDays === 0
        ? "原始消息保留为永久，未执行清理"
        : `已清理 ${report.deleted} 条超过 ${report.retentionDays} 天的已提炼消息`;
      return c.redirect(`/governance?ok=${encodeURIComponent(message)}`);
    } catch (err) {
      return c.redirect(`/governance?ok=${encodeURIComponent(`清理失败：${String(err)}`)}`);
    }
  });

  // ---- spaces / knowledge --------------------------------------------------

  app.get("/", async (c) => {
    if (!config().onboardingCompletedAt) {
      const emptyInstall = engine.registry.list().length === 0 && engine.agents.list().length === 0;
      const larkUnconfigured = opts.larkSetup
        ? !verifiedBotIdentity(await getLarkStatus())
        : false;
      if (emptyInstall || larkUnconfigured) return c.redirect("/setup");
    }
    const spaces = engine.registry.list().map((meta) => {
      const idx = engine.registry.store(meta.id).index();
      return { meta, pages: idx.countPages(), pending: idx.countRaw(true) };
    });
    return c.html(await layout("空间", [{ label: "空间 / 知识" }], await spaceListView(spaces), "spaces"));
  });

  app.get("/spaces/:space", async (c) => {
    const space = parseSpace(c.req.param("space"));
    if (!space || !engine.registry.has(space)) return c.notFound();
    const pages = await engine.listPages(space);
    const rawCount = engine.registry.store(space).index().countRaw();
    const quarantineCount = (await engine.listQuarantines(space)).length;
    const meta = engine.registry.get(space);
    return c.html(
      await layout(
        space,
        [{ label: "空间 / 知识", href: "/" }, { label: space }],
        await spaceDetailView(
          space,
          pages,
          rawCount,
          quarantineCount,
          meta,
          engine.agents.list(),
          c.req.query("ok") ?? undefined,
        ),
        "spaces",
      ),
    );
  });

  app.post("/spaces/:space/agent", async (c) => {
    const space = parseSpace(c.req.param("space"));
    if (!space || !engine.registry.has(space)) return c.notFound();
    const body = await c.req.parseBody();
    const agentId = str(body, "agentId");
    try {
      engine.updateSpaceMeta(space, { agentId });
    } catch {
      return c.redirect(`/spaces/${encodeURIComponent(space)}?ok=${encodeURIComponent("保存失败：Agent Visibility 与空间类型不匹配")}`);
    }
    return c.redirect(`/spaces/${encodeURIComponent(space)}?ok=${encodeURIComponent("已保存空间 Agent")}`);
  });

  app.post("/spaces/:space/materials", async (c) => {
    const space = parseSpace(c.req.param("space"));
    if (!space || !engine.registry.has(space)) return c.notFound();
    const body = await c.req.parseBody({ all: true });
    let materials;
    try {
      materials = await prepareLocalMaterials(body.material);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "无法读取资料文件";
      return c.redirect(
        `/spaces/${encodeURIComponent(space)}?ok=${encodeURIComponent(`导入失败：${reason}`)}`,
      );
    }
    const rawIds: string[] = [];
    for (const material of materials) {
      rawIds.push(await engine.remember({
        space,
        source: "manual",
        author: LOCAL_GOVERNANCE_ACTOR,
        content: localMaterialRawContent(material),
        attachments: [{
          kind: "file",
          ref: `sha256:${material.digest}`,
          name: material.name,
        }],
      }));
    }
    let message = rawIds.length === 1
      ? "资料已导入，等待提炼"
      : `已导入 ${rawIds.length} 份资料，等待提炼`;
    if (checkbox(body, "distillNow")) {
      try {
        const model = engine.agentForSpace(space)?.model || undefined;
        const report = await engine.runDreamCycle(space, { rawIds, model });
        message = report.errors.length === 0
          ? `${rawIds.length === 1 ? "资料" : `${rawIds.length} 份资料`}已导入并完成提炼：写入 ${report.pagesWritten} 个知识页`
          : `${rawIds.length === 1 ? "资料" : `${rawIds.length} 份资料`}已导入，但立即提炼未完成：${report.errors.join("; ")}`;
      } catch (error) {
        const reason = (error instanceof Error ? error.message : String(error)).slice(0, 500);
        message = `${rawIds.length === 1 ? "资料" : `${rawIds.length} 份资料`}已导入，但立即提炼失败：${reason}`;
      }
    }
    const destination = rawIds.length === 1
      ? `/spaces/${encodeURIComponent(space)}/raw/${encodeURIComponent(rawIds[0]!)}`
      : `/spaces/${encodeURIComponent(space)}`;
    return c.redirect(
      `${destination}?ok=${encodeURIComponent(message)}`,
    );
  });

  app.get("/spaces/:space/governance", async (c) => {
    const space = parseSpace(c.req.param("space"));
    if (!space || !engine.registry.has(space)) return c.notFound();
    return c.html(
      await layout(
        `空间规则与治理记录 · ${space}`,
        [
          { label: "空间 / 知识", href: "/" },
          { label: space, href: `/spaces/${encodeURIComponent(space)}` },
          { label: "空间规则与治理记录" },
        ],
        await spaceGovernanceView(
          space,
          await engine.getSpaceGovernance(space),
          c.req.query("ok") ?? undefined,
        ),
        "spaces",
      ),
    );
  });

  app.post("/spaces/:space/governance/rules", async (c) => {
    const space = parseSpace(c.req.param("space"));
    if (!space || !engine.registry.has(space)) return c.notFound();
    try {
      const body = await c.req.parseBody();
      await engine.updateSpaceRules(
        space,
        {
          purpose: str(body, "purpose"),
          schema: str(body, "schema"),
        },
        LOCAL_GOVERNANCE_ACTOR,
      );
      return c.redirect(
        `/spaces/${encodeURIComponent(space)}/governance?ok=${encodeURIComponent("空间规则已保存")}`,
      );
    } catch (error) {
      return c.redirect(
        `/spaces/${encodeURIComponent(space)}/governance?ok=${encodeURIComponent(`保存失败：${String(error)}`)}`,
      );
    }
  });

  app.post("/spaces/:space/governance/rules/reset", async (c) => {
    const space = parseSpace(c.req.param("space"));
    if (!space || !engine.registry.has(space)) return c.notFound();
    const body = await c.req.parseBody();
    const target = str(body, "target");
    if (target !== "purpose" && target !== "schema") return c.notFound();
    try {
      await engine.resetSpaceRule(space, target, LOCAL_GOVERNANCE_ACTOR);
      return c.redirect(
        `/spaces/${encodeURIComponent(space)}/governance?ok=${encodeURIComponent(`已恢复默认 ${target}`)}`,
      );
    } catch (error) {
      return c.redirect(
        `/spaces/${encodeURIComponent(space)}/governance?ok=${encodeURIComponent(`恢复失败：${String(error)}`)}`,
      );
    }
  });

  app.post("/spaces/:space/pages/regenerate", async (c) => {
    const space = parseSpace(c.req.param("space"));
    if (!space || !engine.registry.has(space)) return c.notFound();
    const body = await c.req.parseBody();
    const slug = str(body, "slug");
    const model = engine.agentForSpace(space)?.model || undefined;
    try {
      const result = await engine.regenerateKnowledgePage(
        space,
        slug,
        LOCAL_GOVERNANCE_ACTOR,
        model,
      );
      if (result.status === "not_found") return c.notFound();
      const message = result.status === "regenerated"
        ? "知识页已重新生成"
        : `重新生成失败：${result.reason ?? "请查看提炼失败记录"}`;
      return c.redirect(
        `/spaces/${encodeURIComponent(space)}/pages/${encodeURIComponent(slug)}?ok=${encodeURIComponent(message)}`,
      );
    } catch (error) {
      return c.redirect(
        `/spaces/${encodeURIComponent(space)}/pages/${encodeURIComponent(slug)}?ok=${encodeURIComponent(`重新生成失败：${String(error)}`)}`,
      );
    }
  });

  app.post("/spaces/:space/pages/correct", async (c) => {
    const space = parseSpace(c.req.param("space"));
    if (!space || !engine.registry.has(space)) return c.notFound();
    const body = await c.req.parseBody();
    const slug = str(body, "slug");
    const correction = str(body, "correction");
    const model = engine.agentForSpace(space)?.model || undefined;
    try {
      const result = await engine.submitKnowledgeCorrection(
        space,
        slug,
        correction,
        LOCAL_GOVERNANCE_ACTOR,
        model,
      );
      if (result.status === "not_found") return c.notFound();
      const message = result.status === "regenerated"
        ? "人工纠错已保存，知识页已重新生成"
        : `纠错已保存，但重新生成失败：${result.reason ?? "请查看提炼失败记录"}`;
      return c.redirect(
        `/spaces/${encodeURIComponent(space)}/pages/${encodeURIComponent(slug)}?ok=${encodeURIComponent(message)}`,
      );
    } catch (error) {
      return c.redirect(
        `/spaces/${encodeURIComponent(space)}/pages/${encodeURIComponent(slug)}?ok=${encodeURIComponent(`提交纠错失败：${String(error)}`)}`,
      );
    }
  });

  app.post("/spaces/:space/pages/delete", async (c) => {
    const space = parseSpace(c.req.param("space"));
    if (!space || !engine.registry.has(space)) return c.notFound();
    const body = await c.req.parseBody();
    const slug = str(body, "slug");
    try {
      const result = await engine.deleteKnowledgePage(
        space,
        slug,
        LOCAL_GOVERNANCE_ACTOR,
      );
      if (result.status === "not_found") return c.notFound();
      return c.redirect(
        `/spaces/${encodeURIComponent(space)}?ok=${encodeURIComponent("知识页已删除，原始来源仍保留")}`,
      );
    } catch (error) {
      return c.redirect(
        `/spaces/${encodeURIComponent(space)}/pages/${encodeURIComponent(slug)}?ok=${encodeURIComponent(`删除失败：${String(error)}`)}`,
      );
    }
  });

  app.get("/spaces/:space/pages/:slug{.+}", async (c) => {
    const space = parseSpace(c.req.param("space"));
    if (!space || !engine.registry.has(space)) return c.notFound();
    const slug = decodeURIComponent(c.req.param("slug"));
    const page = await engine.getPage(space, slug);
    if (!page) return c.notFound();
    return c.html(
      await layout(
        page.title,
        [{ label: "空间 / 知识", href: "/" }, { label: space, href: `/spaces/${encodeURIComponent(space)}` }, { label: page.title }],
        await pageView(space, page, c.req.query("ok") ?? undefined),
        "spaces",
      ),
    );
  });

  app.get("/spaces/:space/raw", async (c) => {
    const space = parseSpace(c.req.param("space"));
    if (!space || !engine.registry.has(space)) return c.notFound();
    const raws = engine.registry.store(space).index().listRaw({ limit: 300 });
    return c.html(
      await layout(
        `原始条目 · ${space}`,
        [{ label: "空间 / 知识", href: "/" }, { label: space, href: `/spaces/${encodeURIComponent(space)}` }, { label: "原始条目" }],
        await rawListView(space, raws.reverse()),
        "spaces",
      ),
    );
  });

  app.get("/spaces/:space/raw/:id", async (c) => {
    const space = parseSpace(c.req.param("space"));
    if (!space || !engine.registry.has(space)) return c.notFound();
    const detail = await engine.getRawGovernanceDetail(space, c.req.param("id"));
    if (!detail) return c.notFound();
    return c.html(
      await layout(
        `原始记录 · ${space}`,
        [
          { label: "空间 / 知识", href: "/" },
          { label: space, href: `/spaces/${encodeURIComponent(space)}` },
          { label: "原始条目", href: `/spaces/${encodeURIComponent(space)}/raw` },
          { label: detail.raw.id },
        ],
        await rawGovernanceDetailView(
          space,
          detail,
          c.req.query("ok") ?? undefined,
        ),
        "spaces",
      ),
    );
  });

  app.post("/spaces/:space/raw/:id/redistill", async (c) => {
    const space = parseSpace(c.req.param("space"));
    if (!space || !engine.registry.has(space)) return c.notFound();
    const rawId = c.req.param("id");
    const model = engine.agentForSpace(space)?.model || undefined;
    try {
      const report = await engine.redistillRaw(
        space,
        rawId,
        LOCAL_GOVERNANCE_ACTOR,
        model,
      );
      const message = report.errors.length === 0
        ? `重新提炼完成：写入 ${report.pagesWritten} 个知识页`
        : `重新提炼未完全成功：${report.errors.join("; ")}`;
      return c.redirect(
        `/spaces/${encodeURIComponent(space)}/raw/${encodeURIComponent(rawId)}?ok=${encodeURIComponent(message)}`,
      );
    } catch (error) {
      if (!(await engine.getRawGovernanceDetail(space, rawId))) return c.notFound();
      return c.redirect(
        `/spaces/${encodeURIComponent(space)}/raw/${encodeURIComponent(rawId)}?ok=${encodeURIComponent(`重新提炼失败：${String(error)}`)}`,
      );
    }
  });

  app.get("/spaces/:space/quarantine", async (c) => {
    const space = parseSpace(c.req.param("space"));
    if (!space || !engine.registry.has(space)) return c.notFound();
    return c.html(
      await layout(
        `提炼失败恢复 · ${space}`,
        [{ label: "空间 / 知识", href: "/" }, { label: space, href: `/spaces/${encodeURIComponent(space)}` }, { label: "提炼失败恢复" }],
        await quarantineView(space, await engine.listQuarantines(space), c.req.query("ok") ?? undefined),
        "spaces",
      ),
    );
  });

  app.post("/spaces/:space/quarantine/retry-all", async (c) => {
    const space = parseSpace(c.req.param("space"));
    if (!space || !engine.registry.has(space)) return c.notFound();
    const model = engine.agentForSpace(space)?.model || undefined;
    const result = await engine.retryQuarantines(space, model);
    const message = result.total === 0
      ? "当前没有待恢复的提炼失败"
      : `已重试 ${result.total} 条：恢复成功 ${result.recovered} 条，仍失败 ${result.failed} 条`;
    return c.redirect(`/spaces/${encodeURIComponent(space)}/quarantine?ok=${encodeURIComponent(message)}`);
  });

  app.post("/spaces/:space/quarantine/:id/retry", async (c) => {
    const space = parseSpace(c.req.param("space"));
    if (!space || !engine.registry.has(space)) return c.notFound();
    const id = c.req.param("id");
    const model = engine.agentForSpace(space)?.model || undefined;
    const result = await engine.retryQuarantine(space, id, model);
    if (result.status === "not_found") return c.notFound();
    const message = result.status === "recovered"
      ? "提炼失败恢复成功"
      : `重试失败：${result.reason ?? "请查看最新隔离记录"}`;
    return c.redirect(`/spaces/${encodeURIComponent(space)}/quarantine?ok=${encodeURIComponent(message)}`);
  });

  app.get("/spaces/:space/ask", async (c) => {
    const space = parseSpace(c.req.param("space"));
    if (!space || !engine.registry.has(space)) return c.notFound();
    let q = c.req.query("q") ?? null;
    const traceId = c.req.query("traceId");
    // The engine routes to the space's agent CLI (or the default). We pass
    // model/instruction so the test box reflects what the group would get.
    const agent = engine.agentForSpace(space);
    let result = null;
    let feedbackRecorded = false;
    if (traceId) {
      const trace = engine.answerTrace(traceId);
      if (
        !trace
        || !trace.spaces.includes(space)
        || trace.outcome !== "succeeded"
        || !trace.source
        || trace.answer === undefined
      ) return c.notFound();
      q = trace.question;
      result = {
        answer: trace.answer,
        source: trace.source,
        citations: trace.citations,
        traceId: trace.id,
      };
      feedbackRecorded = engine.quality.feedbackFor(trace.id) !== undefined;
    } else if (q && q.trim()) {
      try {
        result = await engine.ask([space], q, {
          model: agent?.model || undefined,
          instruction: agent?.instruction || undefined,
        });
      } catch {
        result = {
          answer: "⚠️ 无法作答：本空间没有可用的回答 Agent。请在 Integrations 指定 Agent 或在设置里配置默认 CLI。",
          source: "general" as const,
          citations: [],
        };
      }
    }
    return c.html(
      await layout(
        `问答测试 · ${space}`,
        [{ label: "空间 / 知识", href: "/" }, { label: space, href: `/spaces/${encodeURIComponent(space)}` }, { label: "问答测试" }],
        await askView(
          space,
          q,
          result,
          c.req.query("ok") ?? undefined,
          feedbackRecorded,
        ),
        "spaces",
      ),
    );
  });

  app.post("/spaces/:space/ask/feedback", async (c) => {
    const space = parseSpace(c.req.param("space"));
    if (!space || !engine.registry.has(space)) return c.notFound();
    const body = await c.req.parseBody();
    const traceId = str(body, "traceId").trim();
    const kind = str(body, "kind").trim();
    if (!traceId || !isAnswerFeedbackKind(kind)) {
      return c.text("Invalid answer feedback", 400);
    }
    const trace = engine.answerTrace(traceId);
    if (!trace || !trace.spaces.includes(space)) return c.notFound();
    const feedback = engine.recordAnswerFeedback(traceId, space, kind);
    if (!feedback) return c.text("Feedback already recorded", 409);
    const params = new URLSearchParams({
      traceId,
      ok: "感谢反馈，已记录到本机质量闭环",
    });
    return c.redirect(`/spaces/${encodeURIComponent(space)}/ask?${params.toString()}`);
  });

  app.post("/spaces/:space/dream", async (c) => {
    const space = parseSpace(c.req.param("space"));
    if (!space || !engine.registry.has(space)) return c.notFound();
    // Per-space agent model, if assigned. Fire-and-forget.
    const model = engine.agentForSpace(space)?.model || undefined;
    void engine.runDreamCycle(space, { model }).catch(() => {});
    return c.redirect(`/spaces/${encodeURIComponent(space)}`);
  });

  // ---- Skills --------------------------------------------------------------

  app.get("/skills", async (c) => {
    let catalog;
    try {
      catalog = engine.skillCatalog.current();
    } catch {
      catalog = undefined;
    }
    return c.html(
      await layout(
        "Skills",
        [{ label: "Skills" }],
        skillInventoryView(
          buildSkillInventory(catalog, engine.agents.list()),
          c.req.query("ok") ?? undefined,
        ),
        "skills",
      ),
    );
  });

  // ---- Agents --------------------------------------------------------------

  app.post("/agent-skills/refresh", async (c) => {
    const body = await c.req.parseBody();
    const requested = typeof body.returnTo === "string" ? body.returnTo : "/agents";
    const returnTo = (requested.startsWith("/agents") || requested === "/skills")
      && !requested.startsWith("//")
      && !/[\r\n]/u.test(requested)
      ? requested
      : "/agents";
    const separator = returnTo.includes("?") ? "&" : "?";
    try {
      engine.skillCatalog.refresh();
    } catch {
      return c.redirect(
        `${returnTo}${separator}ok=${encodeURIComponent("Skill 目录刷新失败；继续使用上次目录")}`,
      );
    }
    return c.redirect(
      `${returnTo}${separator}ok=${encodeURIComponent("Skill 目录已刷新")}`,
    );
  });

  app.get("/agents", async (c) => {
    const agents = engine.agents.list();
    const ok = c.req.query("ok") ?? undefined;
    if (agents[0] && c.req.query("view") !== "list") {
      const query = ok ? `?ok=${encodeURIComponent(ok)}` : "";
      return c.redirect(`/agents/${encodeURIComponent(agents[0].id)}${query}`);
    }
    return c.html(
      await layout(
        "Agents",
        [{ label: "Agents" }],
        await renderAgentWorkbench({ mode: "empty", flash: ok }),
        "agents",
      ),
    );
  });

  app.get("/agents/new", async (c) => {
    return c.html(
      await layout(
        "新建 Agent",
        [{ label: "Agents", href: "/agents" }, { label: "新建" }],
        await renderAgentWorkbench({
          mode: "create",
          flash: c.req.query("ok") ?? undefined,
        }),
        "agents",
      ),
    );
  });

  app.get("/agents/:id", async (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const agent = engine.agents.get(id);
    if (!agent) return c.notFound();
    const ok = c.req.query("ok") ?? undefined;
    return c.html(
      await layout(
        agent.name,
        [{ label: "Agents", href: "/agents" }, { label: agent.name }],
        await renderAgentWorkbench({
          mode: "edit",
          selected: agent,
          flash: ok,
          runLimit: agentRunLimit(c.req.query("runs")),
        }),
        "agents",
      ),
    );
  });

  app.post("/agents", async (c) => {
    const body = await c.req.parseBody({ all: true });
    const cfg = config();
    const providers = await getProviders();
    const values = agentValuesFromBody(
      body,
      editorValuesFor(
        null,
        providers,
        { provider: cfg.defaultProvider, model: cfg.defaultModel },
      ),
    );
    const catalog = engine.skillCatalog.current();
    const validation = validateAgentEditor(values, {
      providers,
      models: await getModels(),
      defaults: { provider: cfg.defaultProvider, model: cfg.defaultModel },
      current: null,
      catalog,
    });
    if (!validation.ok) {
      return c.html(
        await layout(
          "新建 Agent",
          [{ label: "Agents", href: "/agents" }, { label: "新建" }],
          await renderAgentWorkbench({
            mode: "create",
            values,
            errors: validation.errors,
            formError: "请修正标记的字段后再创建。",
          }),
          "agents",
        ),
        422,
      );
    }
    const agent = engine.agents.create(agentInputForEditor(values, catalog, null));
    return c.redirect(
      `/agents/${encodeURIComponent(agent.id)}?ok=${encodeURIComponent("已创建")}`,
    );
  });

  app.post("/agents/:id", async (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const current = engine.agents.get(id);
    if (!current) return c.notFound();
    const body = await c.req.parseBody({ all: true });
    const cfg = config();
    const providers = await getProviders();
    const values = agentValuesFromBody(
      body,
      editorValuesFor(
        current,
        providers,
        { provider: cfg.defaultProvider, model: cfg.defaultModel },
      ),
    );
    const catalog = engine.skillCatalog.current();
    const validation = validateAgentEditor(values, {
      providers,
      models: await getModels(),
      defaults: { provider: cfg.defaultProvider, model: cfg.defaultModel },
      current,
      catalog,
    });
    if (!validation.ok) {
      return c.html(
        await layout(
          current.name,
          [{ label: "Agents", href: "/agents" }, { label: current.name }],
          await renderAgentWorkbench({
            mode: "edit",
            selected: engine.agents.get(id) ?? current,
            values,
            errors: validation.errors,
            formError: "请修正标记的字段后再保存。",
          }),
          "agents",
        ),
        422,
      );
    }
    const action = str(body, "agentAction");
    const expectedHeadRevisionId = str(body, "expectedHeadRevisionId") || undefined;
    let successMessage = "已保存并发布";
    try {
      const input = agentInputForEditor(values, catalog, current);
      if (action !== "draft" && action !== "publish") {
        throw new Error("未知的 Agent 生命周期操作，请刷新后重试");
      }
      if (!expectedHeadRevisionId) {
        throw new Error("缺少 Agent 版本校验信息，请刷新后重试");
      }
      if (action === "draft") {
        engine.saveAgentDraft(id, input, expectedHeadRevisionId);
        successMessage = "草稿已保存，线上版本未变化";
      } else if (action === "publish") {
        const draft = engine.saveAgentDraft(id, input, expectedHeadRevisionId);
        if (!draft || !engine.releaseAgent(id, draft.id, draft.id)) {
          throw new Error("没有可发布的 Agent 草稿");
        }
        successMessage = "新版本已发布";
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "保存失败";
      const visibilityConflict = message.includes("解除") || message.includes("绑定");
      return c.html(
        await layout(
          current.name,
          [{ label: "Agents", href: "/agents" }, { label: current.name }],
          await renderAgentWorkbench({
            mode: "edit",
            selected: engine.agents.get(id) ?? current,
            values,
            errors: visibilityConflict ? { visibility: message } : {},
            formError: visibilityConflict ? "当前绑定与新的 Visibility 不兼容。" : message,
            expectedHeadRevisionId: message.includes("版本已变化")
              ? expectedHeadRevisionId
              : undefined,
          }),
          "agents",
        ),
        409,
      );
    }
    return c.redirect(
      `/agents/${encodeURIComponent(id)}?ok=${encodeURIComponent(successMessage)}`,
    );
  });

  app.post("/agents/:id/revisions/:revisionId/rollback", async (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const revisionId = decodeURIComponent(c.req.param("revisionId"));
    const current = engine.agents.get(id);
    if (!current) return c.notFound();
    const body = await c.req.parseBody({ all: true });
    const expectedHeadRevisionId = str(body, "expectedHeadRevisionId") || undefined;
    try {
      if (!expectedHeadRevisionId) {
        throw new Error("缺少 Agent 版本校验信息，请刷新后重试");
      }
      const rolledBack = engine.rollbackAgent(id, revisionId, expectedHeadRevisionId);
      if (!rolledBack) return c.notFound();
      return c.redirect(
        `/agents/${encodeURIComponent(id)}?ok=${encodeURIComponent("历史版本已作为新版本发布")}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "回滚失败";
      return c.html(
        await layout(
          current.name,
          [{ label: "Agents", href: "/agents" }, { label: current.name }],
          await renderAgentWorkbench({
            mode: "edit",
            selected: engine.agents.get(id) ?? current,
            formError: message,
            expectedHeadRevisionId: message.includes("版本已变化")
              ? expectedHeadRevisionId
              : undefined,
          }),
          "agents",
        ),
        409,
      );
    }
  });

  app.post("/agents/:id/delete", async (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const current = engine.agents.get(id);
    if (!current) return c.notFound();
    try {
      const result = engine.removeAgentAndUnbind(id)!;
      const suffix = result.bindings.length > 0
        ? `，已解除 ${result.bindings.length} 个空间绑定`
        : "";
      return c.redirect(`/agents?ok=${encodeURIComponent(`已删除${suffix}`)}`);
    } catch (error) {
      const message = error instanceof Error && error.message.includes("awaiting approval")
        ? "删除失败：此 Agent 仍有待审批任务，请先批准、拒绝或撤销申请。"
        : "删除失败：配置暂时无法保存，Agent 已保留，请重试。";
      return c.html(
        await layout(
          current.name,
          [{ label: "Agents", href: "/agents" }, { label: current.name }],
          await renderAgentWorkbench({
            mode: "edit",
            selected: current,
            formError: message,
          }),
          "agents",
        ),
        500,
      );
    }
  });

  // ---- Chat Runs -----------------------------------------------------------

  app.get("/chats/runs/:runId", async (c) => {
    const runId = decodeURIComponent(c.req.param("runId"));
    const run = engine.chatRuns.get(runId);
    if (!run) return c.notFound();
    const ok = c.req.query("ok") ?? undefined;
    return c.html(
      await layout(
        "Chat Run 详情",
        [
          ...(run.agentId
            ? [{
                label: "Agents",
                href: `/agents/${encodeURIComponent(run.agentId)}`,
              }]
            : []),
          { label: "Chat Run 详情" },
        ],
        await chatRunView(
          run,
          ok,
          engine.runScheduler.queueInfo(run.id),
          engine.quality.rerunsForChatRun(run.id),
        ),
        "agents",
      ),
    );
  });

  app.post("/chats/runs/:runId/retry", async (c) => {
    const runId = decodeURIComponent(c.req.param("runId"));
    if (!engine.chatRuns.get(runId)) return c.notFound();
    if (!opts.onChatRunRetry) {
      return c.redirect(
        `/chats/runs/${encodeURIComponent(runId)}?ok=${encodeURIComponent("飞书重试通道未配置")}`,
      );
    }
    try {
      const retried = await opts.onChatRunRetry(runId);
      const message = retried.id === runId ? "投递已重试" : "文本回答已重试";
      return c.redirect(
        `/chats/runs/${encodeURIComponent(retried.id)}?ok=${encodeURIComponent(message)}`,
      );
    } catch (err) {
      log.warn("chat run retry failed", { runId, err: String(err) });
      return c.redirect(
        `/chats/runs/${encodeURIComponent(runId)}?ok=${encodeURIComponent("重试失败，请查看错误后再试")}`,
      );
    }
  });

  app.post("/chats/runs/:runId/evaluate", async (c) => {
    const runId = decodeURIComponent(c.req.param("runId"));
    if (!engine.chatRuns.get(runId)) return c.notFound();
    try {
      const rerun = await engine.rerunChatRunForEvaluation(runId);
      return c.redirect(
        `/chats/runs/${encodeURIComponent(runId)}?ok=${encodeURIComponent(`重新评测已完成：${rerun.candidateTraceId}`)}`,
      );
    } catch (error) {
      log.warn("chat evaluation rerun failed", { runId, err: String(error) });
      return c.redirect(
        `/chats/runs/${encodeURIComponent(runId)}?ok=${encodeURIComponent("重新评测失败，请查看运行状态后重试")}`,
      );
    }
  });

  app.post("/chats/runs/:runId/cancel", async (c) => {
    const runId = decodeURIComponent(c.req.param("runId"));
    if (!engine.chatRuns.get(runId)) return c.notFound();
    const cancelled = opts.onChatRunCancel?.(runId) ?? false;
    const message = cancelled ? "已发送取消请求" : "该运行已结束，无法取消";
    return c.redirect(
      `/chats/runs/${encodeURIComponent(runId)}?ok=${encodeURIComponent(message)}`,
    );
  });

  // ---- Work context -------------------------------------------------------

  const workList = (value: string): string[] => value
    .split(/\r?\n/u)
    .map((item) => item.trim())
    .filter(Boolean);

  app.get("/work", async (c) => {
    const ok = c.req.query("ok") ?? undefined;
    return c.html(await layout(
      "工作上下文",
      [{ label: "工作上下文" }],
      await workItemsView(engine.workItems.list(), null, engine.registry.list(), [], undefined, ok),
      "work",
    ));
  });

  app.get("/work/:id", async (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const item = engine.workItems.get(id);
    if (!item) return c.notFound();
    const ok = c.req.query("ok") ?? undefined;
    return c.html(await layout(
      item.title,
      [{ label: "工作上下文", href: "/work" }, { label: item.title }],
      await workItemsView(
        engine.workItems.list(),
        item,
        engine.registry.list(),
        engine.workContinuations.list(item.id),
        engine.workContinuations.policyFor(item.id, item.space),
        ok,
      ),
      "work",
    ));
  });

  app.post("/work", async (c) => {
    const body = await c.req.parseBody();
    const space = str(body, "space").trim();
    if (!isSpaceId(space) || !engine.registry.has(space)) {
      return c.redirect(`/work?ok=${encodeURIComponent("创建失败：请选择有效空间")}`);
    }
    try {
      const item = engine.workItems.create({
        title: str(body, "title"),
        space,
        brief: str(body, "brief"),
        runbook: str(body, "runbook"),
        phase: (str(body, "phase") || "active") as WorkItemPhase,
      });
      return c.redirect(`/work/${encodeURIComponent(item.id)}?ok=${encodeURIComponent("已创建并设为当前工作项")}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "创建失败";
      return c.redirect(`/work?ok=${encodeURIComponent(`创建失败：${message}`)}`);
    }
  });

  app.post("/work/:id", async (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    if (!engine.workItems.get(id)) return c.notFound();
    const body = await c.req.parseBody();
    try {
      engine.workItems.update(id, {
        title: str(body, "title"),
        brief: str(body, "brief"),
        runbook: str(body, "runbook"),
        phase: str(body, "phase") as WorkItemPhase,
        summary: str(body, "summary"),
        blockers: workList(str(body, "blockers")),
        nextActions: workList(str(body, "nextActions")),
      });
      return c.redirect(`/work/${encodeURIComponent(id)}?ok=${encodeURIComponent("工作上下文已保存")}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "保存失败";
      return c.redirect(`/work/${encodeURIComponent(id)}?ok=${encodeURIComponent(`保存失败：${message}`)}`);
    }
  });

  app.post("/work/:id/activate", async (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    if (!engine.workItems.get(id)) return c.notFound();
    try {
      engine.workItems.activate(id);
      return c.redirect(`/work/${encodeURIComponent(id)}?ok=${encodeURIComponent("已设为当前工作项")}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "切换失败";
      return c.redirect(`/work/${encodeURIComponent(id)}?ok=${encodeURIComponent(`切换失败：${message}`)}`);
    }
  });

  app.post("/work/:id/continuation", async (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    if (!engine.workItems.get(id)) return c.notFound();
    const body = await c.req.parseBody();
    try {
      engine.configureWorkContinuation(id, str(body, "autoContinue") === "on");
      return c.redirect(`/work/${encodeURIComponent(id)}?ok=${encodeURIComponent("自动续跑设置已保存")}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "保存失败";
      return c.redirect(`/work/${encodeURIComponent(id)}?ok=${encodeURIComponent(`保存失败：${message}`)}`);
    }
  });

  app.post("/work/:id/continue", async (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    if (!engine.workItems.get(id)) return c.notFound();
    try {
      const started = engine.startWorkContinuation(id);
      const message = started.state === "awaiting_approval"
        ? "动作已冻结，等待审批"
        : "动作已进入执行队列";
      return c.redirect(`/work/${encodeURIComponent(id)}?ok=${encodeURIComponent(message)}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "继续失败";
      return c.redirect(`/work/${encodeURIComponent(id)}?ok=${encodeURIComponent(`继续失败：${message}`)}`);
    }
  });

  app.post("/work/actions/:actionId/cancel", async (c) => {
    const actionId = decodeURIComponent(c.req.param("actionId"));
    const action = engine.workContinuations.get(actionId);
    if (!action) return c.notFound();
    const body = await c.req.parseBody();
    try {
      const attempt = Number(str(body, "attempt"));
      if (!Number.isInteger(attempt) || attempt < 1) {
        throw new Error("动作尝试次数无效");
      }
      const cancelled = engine.cancelWorkAction(actionId, {
        runId: str(body, "runId") || null,
        attempt,
      });
      const message = cancelled ? "当前动作已取消" : "动作已经结束，无法取消";
      return c.redirect(`/work/${encodeURIComponent(action.workItemId)}?ok=${encodeURIComponent(message)}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "取消失败";
      return c.redirect(`/work/${encodeURIComponent(action.workItemId)}?ok=${encodeURIComponent(`取消失败：${message}`)}`);
    }
  });

  app.post("/work/actions/:actionId/retry", async (c) => {
    const actionId = decodeURIComponent(c.req.param("actionId"));
    const action = engine.workContinuations.get(actionId);
    if (!action) return c.notFound();
    const body = await c.req.parseBody();
    try {
      const attempt = Number(str(body, "attempt"));
      if (!Number.isInteger(attempt) || attempt < 1) {
        throw new Error("动作尝试次数无效");
      }
      const started = engine.retryWorkAction(actionId, {
        runId: str(body, "runId") || null,
        attempt,
      });
      const message = started.state === "awaiting_approval"
        ? "重试已冻结，等待审批"
        : "重试已进入执行队列";
      return c.redirect(`/work/${encodeURIComponent(action.workItemId)}?ok=${encodeURIComponent(message)}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "重试失败";
      return c.redirect(`/work/${encodeURIComponent(action.workItemId)}?ok=${encodeURIComponent(`重试失败：${message}`)}`);
    }
  });

  app.post("/work/actions/:actionId/abandon", async (c) => {
    const actionId = decodeURIComponent(c.req.param("actionId"));
    const action = engine.workContinuations.get(actionId);
    if (!action) return c.notFound();
    const body = await c.req.parseBody();
    try {
      const attempt = Number(str(body, "attempt"));
      if (!Number.isInteger(attempt) || attempt < 1) {
        throw new Error("动作尝试次数无效");
      }
      engine.abandonWorkAction(actionId, {
        runId: str(body, "runId") || null,
        attempt,
      });
      return c.redirect(`/work/${encodeURIComponent(action.workItemId)}?ok=${encodeURIComponent("已放弃受阻动作，可按新的下一步继续")}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "放弃失败";
      return c.redirect(`/work/${encodeURIComponent(action.workItemId)}?ok=${encodeURIComponent(`放弃失败：${message}`)}`);
    }
  });

  app.post("/work/actions/:actionId/accept", async (c) => {
    const actionId = decodeURIComponent(c.req.param("actionId"));
    const action = engine.workContinuations.get(actionId);
    if (!action) return c.notFound();
    const body = await c.req.parseBody();
    try {
      const runId = str(body, "runId");
      if (!runId) throw new Error("待验收 Run 不能为空");
      engine.acceptWorkAction(actionId, runId, "local-admin");
      return c.redirect(`/work/${encodeURIComponent(action.workItemId)}?ok=${encodeURIComponent("验收已接受，checkpoint 已写入")}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "接受失败";
      return c.redirect(`/work/${encodeURIComponent(action.workItemId)}?ok=${encodeURIComponent(`接受失败：${message}`)}`);
    }
  });

  app.post("/work/actions/:actionId/reject", async (c) => {
    const actionId = decodeURIComponent(c.req.param("actionId"));
    const action = engine.workContinuations.get(actionId);
    if (!action) return c.notFound();
    const body = await c.req.parseBody();
    try {
      const runId = str(body, "runId");
      const reason = str(body, "reason");
      if (!runId) throw new Error("待验收 Run 不能为空");
      if (!reason) throw new Error("驳回原因不能为空");
      if (reason.length > 2_000) throw new Error("驳回原因不能超过 2000 个字符");
      engine.rejectWorkAction(actionId, runId, "local-admin", reason);
      return c.redirect(`/work/${encodeURIComponent(action.workItemId)}?ok=${encodeURIComponent("结果已驳回，动作边界已保留")}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "驳回失败";
      return c.redirect(`/work/${encodeURIComponent(action.workItemId)}?ok=${encodeURIComponent(`驳回失败：${message}`)}`);
    }
  });

  // ---- Tasks ---------------------------------------------------------------

  const deliverTaskRunNotification = async (runId: string): Promise<void> => {
    if (!opts.onTaskRun) return;
    if (!engine.getTaskRun(runId)?.notification) return;
    await engine.deliverTaskRunNotification(
      runId,
      (run) => opts.onTaskRun!(run.taskId, run),
    );
  };

  const observeTaskRunCompletion = (started: ReturnType<KnowledgeEngine["startTaskRun"]>): void => {
    if (started.state !== "scheduled") return;
    void started.completion
      .then(async (report) => {
        if (report.ok && opts.onTaskRun) {
          await deliverTaskRunNotification(report.runId);
        }
      })
      .catch((err) => {
        log.warn("task completion hook failed", {
          runId: started.run.id,
          err: String(err),
        });
      });
  };

  app.get("/tasks", async (c) => {
    const ok = c.req.query("ok") ?? undefined;
    return c.html(
      await layout("任务", [{ label: "任务" }], await tasksView(engine.tasks.list(), null, engine.registry.list(), [], ok), "tasks"),
    );
  });

  app.get("/tasks/runs/:runId", async (c) => {
    const runId = decodeURIComponent(c.req.param("runId"));
    const run = engine.getTaskRun(runId);
    if (!run) return c.notFound();
    const ok = c.req.query("ok") ?? undefined;
    const action = run.workActionId
      ? engine.workContinuations.get(run.workActionId)
      : undefined;
    const item = action && run.workItemId === action.workItemId
      ? engine.workItems.get(action.workItemId)
      : undefined;
    const workContext = action && item && action.space === run.space
      ? { action, item }
      : undefined;
    const managedTask = engine.tasks.get(run.taskId);
    return c.html(
      await layout(
        "运行详情",
        workContext
          ? [
              { label: "工作上下文", href: "/work" },
              { label: workContext.item.title, href: `/work/${encodeURIComponent(workContext.item.id)}` },
              { label: "运行详情" },
            ]
          : [
              { label: "任务", href: "/tasks" },
              { label: run.taskName, href: `/tasks/${encodeURIComponent(run.taskId)}` },
              { label: "运行详情" },
            ],
        await taskRunView(
          run,
          managedTask,
          ok,
          engine.runScheduler.queueInfo(run.id),
          workContext,
        ),
        workContext ? "work" : "tasks",
      ),
    );
  });

  app.get("/tasks/:id", async (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const task = engine.tasks.get(id);
    if (!task) return c.notFound();
    const ok = c.req.query("ok") ?? undefined;
    return c.html(
      await layout(
        task.name,
        [{ label: "任务", href: "/tasks" }, { label: task.name }],
        await tasksView(engine.tasks.list(), task, engine.registry.list(), engine.listTaskRuns(task.id), ok),
        "tasks",
      ),
    );
  });

  app.post("/tasks", async (c) => {
    const body = await c.req.parseBody();
    const space = str(body, "space").trim();
    if (!isSpaceId(space) || !engine.registry.has(space)) {
      return c.redirect(`/tasks?ok=${encodeURIComponent("创建失败：请选择有效空间")}`);
    }
    const timeoutMinutes = str(body, "timeoutMinutes");
    const task = engine.tasks.create({
      name: str(body, "name"),
      space,
      topic: str(body, "topic"),
      cadence: str(body, "cadence"),
      hour: Number(str(body, "hour")),
      dayOfWeek: Number(str(body, "dayOfWeek")),
      enabled: checkbox(body, "enabled"),
      notify: checkbox(body, "notify"),
      distillOnRun: checkbox(body, "distillOnRun"),
      timeoutMinutes: timeoutMinutes ? Number(timeoutMinutes) : undefined,
    });
    if (!task) return c.redirect(`/tasks?ok=${encodeURIComponent("创建失败：请选择有效空间")}`);
    return c.redirect(`/tasks/${encodeURIComponent(task.id)}?ok=${encodeURIComponent("已创建")}`);
  });

  app.post("/tasks/:id", async (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    if (!engine.tasks.has(id)) return c.notFound();
    const body = await c.req.parseBody();
    const timeoutMinutes = str(body, "timeoutMinutes");
    try {
      engine.updateTask(id, {
        name: str(body, "name"),
        space: str(body, "space"),
        topic: str(body, "topic"),
        cadence: str(body, "cadence"),
        hour: Number(str(body, "hour")),
        dayOfWeek: Number(str(body, "dayOfWeek")),
        enabled: checkbox(body, "enabled"),
        notify: checkbox(body, "notify"),
        distillOnRun: checkbox(body, "distillOnRun"),
        timeoutMinutes: timeoutMinutes ? Number(timeoutMinutes) : undefined,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "保存失败";
      return c.redirect(
        `/tasks/${encodeURIComponent(id)}?ok=${encodeURIComponent(`保存失败：${message}`)}`,
      );
    }
    return c.redirect(`/tasks/${encodeURIComponent(id)}?ok=${encodeURIComponent("已保存")}`);
  });

  app.post("/tasks/:id/delete", async (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    try {
      engine.removeTask(id);
    } catch (err) {
      if (err instanceof TaskAlreadyRunningError) {
        return c.redirect(`/tasks/runs/${encodeURIComponent(err.runId)}?ok=${encodeURIComponent("任务正在运行")}`);
      }
      log.error("task delete failed", { taskId: id, err: String(err) });
      return c.redirect(`/tasks/${encodeURIComponent(id)}?ok=${encodeURIComponent("任务删除失败")}`);
    }
    return c.redirect(`/tasks?ok=${encodeURIComponent("已删除")}`);
  });

  app.post("/tasks/:id/run", async (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    if (!engine.tasks.has(id)) return c.notFound();
    try {
      const started = engine.startTaskRun(id, { trigger: "manual" });
      observeTaskRunCompletion(started);
      const message = started.state === "awaiting_approval"
        ? "高权限任务已提交审批"
        : "任务已开始，可刷新查看最新状态";
      return c.redirect(`/tasks/runs/${encodeURIComponent(started.run.id)}?ok=${encodeURIComponent(message)}`);
    } catch (err) {
      if (err instanceof TaskAlreadyRunningError) {
        return c.redirect(`/tasks/runs/${encodeURIComponent(err.runId)}?ok=${encodeURIComponent("任务正在运行")}`);
      }
      log.error("manual task start failed", { taskId: id, err: String(err) });
      return c.redirect(`/tasks/${encodeURIComponent(id)}?ok=${encodeURIComponent("任务启动失败，请稍后重试")}`);
    }
  });

  app.post("/tasks/runs/:runId/retry", async (c) => {
    const runId = decodeURIComponent(c.req.param("runId"));
    const previous = engine.getTaskRun(runId);
    if (!previous) return c.notFound();
    try {
      const started = engine.retryTaskRun(runId);
      observeTaskRunCompletion(started);
      const message = started.state === "awaiting_approval"
        ? "重试已重新提交审批"
        : "重试已开始";
      return c.redirect(`/tasks/runs/${encodeURIComponent(started.run.id)}?ok=${encodeURIComponent(message)}`);
    } catch (err) {
      if (err instanceof TaskAlreadyRunningError) {
        return c.redirect(`/tasks/runs/${encodeURIComponent(err.runId)}?ok=${encodeURIComponent("任务正在运行")}`);
      }
      log.error("task retry failed", { runId, err: String(err) });
      return c.redirect(`/tasks/runs/${encodeURIComponent(runId)}?ok=${encodeURIComponent("重试启动失败，请稍后再试")}`);
    }
  });

  app.post("/tasks/runs/:runId/cancel", async (c) => {
    const runId = decodeURIComponent(c.req.param("runId"));
    const run = engine.getTaskRun(runId);
    if (!run) return c.notFound();
    const cancelled = engine.cancelTaskRun(runId);
    const message = cancelled
      ? run.retry?.status === "waiting"
        ? "已取消自动重试"
        : run.status === "awaiting_approval"
          ? "已撤销审批申请"
          : "已发送取消请求"
      : "该运行已结束，无法取消";
    return c.redirect(`/tasks/runs/${encodeURIComponent(runId)}?ok=${encodeURIComponent(message)}`);
  });

  app.post("/tasks/runs/:runId/approve", async (c) => {
    const runId = decodeURIComponent(c.req.param("runId"));
    if (!engine.getTaskRun(runId)) return c.notFound();
    try {
      const started = engine.approveTaskRun(runId, LOCAL_GOVERNANCE_ACTOR);
      observeTaskRunCompletion(started);
      return c.redirect(
        `/tasks/runs/${encodeURIComponent(runId)}?ok=${encodeURIComponent("已批准，任务开始排队执行")}`,
      );
    } catch (err) {
      log.warn("task approval failed", { runId, err: String(err) });
      return c.redirect(
        `/tasks/runs/${encodeURIComponent(runId)}?ok=${encodeURIComponent("审批状态已变化，请刷新确认")}`,
      );
    }
  });

  app.post("/tasks/runs/:runId/reject", async (c) => {
    const runId = decodeURIComponent(c.req.param("runId"));
    if (!engine.getTaskRun(runId)) return c.notFound();
    try {
      engine.rejectTaskRun(runId, LOCAL_GOVERNANCE_ACTOR);
      return c.redirect(
        `/tasks/runs/${encodeURIComponent(runId)}?ok=${encodeURIComponent("已拒绝高权限执行申请")}`,
      );
    } catch (err) {
      log.warn("task rejection failed", { runId, err: String(err) });
      return c.redirect(
        `/tasks/runs/${encodeURIComponent(runId)}?ok=${encodeURIComponent("审批状态已变化，请刷新确认")}`,
      );
    }
  });

  app.post("/tasks/runs/:runId/notification/retry", async (c) => {
    const runId = decodeURIComponent(c.req.param("runId"));
    const run = engine.getTaskRun(runId);
    if (!run) return c.notFound();
    if (!opts.onTaskRun) {
      return c.redirect(
        `/tasks/runs/${encodeURIComponent(runId)}?ok=${encodeURIComponent("通知通道未配置")}`,
      );
    }
    try {
      await deliverTaskRunNotification(runId);
      return c.redirect(
        `/tasks/runs/${encodeURIComponent(runId)}?ok=${encodeURIComponent("通知已发送")}`,
      );
    } catch (err) {
      log.warn("manual task notification retry failed", { runId, err: String(err) });
      return c.redirect(
        `/tasks/runs/${encodeURIComponent(runId)}?ok=${encodeURIComponent("通知发送失败，已保留重试状态")}`,
      );
    }
  });

  // ---- Guided learning ----------------------------------------------------

  app.get("/learning", async (c) => {
    const ok = c.req.query("ok") ?? undefined;
    const plans = engine.learning.list();
    const sources = Object.fromEntries(
      plans.flatMap((plan) => {
        const source = engine.learning.source(plan.id);
        return source ? [[plan.id, source] as const] : [];
      }),
    );
    return c.html(
      await layout(
        "学习计划",
        [{ label: "学习计划" }],
        await learningView(plans, null, sources, [], ok),
        "learning",
      ),
    );
  });

  app.get("/learning/:id", async (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const plan = engine.learning.get(id);
    if (!plan) return c.notFound();
    const ok = c.req.query("ok") ?? undefined;
    const plans = engine.learning.list();
    const sources = Object.fromEntries(
      plans.flatMap((candidate) => {
        const source = engine.learning.source(candidate.id);
        return source ? [[candidate.id, source] as const] : [];
      }),
    );
    return c.html(
      await layout(
        plan.name,
        [{ label: "学习计划", href: "/learning" }, { label: plan.name }],
        await learningView(
          plans,
          plan,
          sources,
          engine.learning.sessionsForPlan(id),
          ok,
        ),
        "learning",
      ),
    );
  });

  app.post("/learning/:id", async (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const plan = engine.learning.get(id);
    if (!plan) return c.notFound();
    const body = await c.req.parseBody();
    const hourText = str(body, "hour").trim();
    const dailyCharactersText = str(body, "dailyCharacters").trim();
    const hour = Number(hourText);
    const dailyCharacters = Number(dailyCharactersText);
    if (
      !hourText || !Number.isFinite(hour)
      || (plan.mode === "reading" && (
        !dailyCharactersText || !Number.isFinite(dailyCharacters)
      ))
    ) {
      return c.redirect(
        `/learning/${encodeURIComponent(id)}?ok=${encodeURIComponent("保存失败：请输入有效数字")}`,
      );
    }
    engine.learning.update(id, undefined, {
      hour,
      dailyCharacters: plan.mode === "reading" ? dailyCharacters : undefined,
    });
    return c.redirect(`/learning/${encodeURIComponent(id)}?ok=${encodeURIComponent("已保存")}`);
  });

  app.post("/learning/:id/pause", async (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    if (!engine.learning.has(id)) return c.notFound();
    engine.learning.pause(id);
    return c.redirect(`/learning/${encodeURIComponent(id)}?ok=${encodeURIComponent("已暂停")}`);
  });

  app.post("/learning/:id/resume", async (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    if (!engine.learning.has(id)) return c.notFound();
    engine.learning.resume(id);
    return c.redirect(`/learning/${encodeURIComponent(id)}?ok=${encodeURIComponent("已恢复")}`);
  });

  app.post("/learning/:id/delete", async (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    if (!engine.learning.has(id)) return c.notFound();
    engine.learning.remove(id);
    return c.redirect(`/learning?ok=${encodeURIComponent("已删除")}`);
  });

  // ---- Reminders -----------------------------------------------------------

  app.get("/reminders", async (c) => {
    const ok = c.req.query("ok") ?? undefined;
    return c.html(
      await layout(
        "提醒",
        [{ label: "提醒" }],
        await remindersView(engine.reminders.list(), ok),
        "reminders",
      ),
    );
  });

  app.post("/reminders/:id/complete", async (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const reminder = engine.reminders.get(id);
    if (!reminder) return c.notFound();
    engine.reminders.complete(id, reminder.creatorId);
    return c.redirect(`/reminders?ok=${encodeURIComponent("已标记完成")}`);
  });

  app.post("/reminders/:id/cancel", async (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const reminder = engine.reminders.get(id);
    if (!reminder) return c.notFound();
    engine.reminders.cancel(id, reminder.creatorId);
    return c.redirect(`/reminders?ok=${encodeURIComponent("已取消")}`);
  });

  // ---- Integrations --------------------------------------------------------

  app.get("/integrations", async (c) => {
    const cfg = config();
    const groups = engine.registry.list().filter((m) => m.id.startsWith("team/"));
    const agents = engine.agents.list();
    const ok = c.req.query("ok") ?? undefined;
    const setupStatus = await getLarkStatus();
    const { restartRequired } = integrationIdentityState(setupStatus);
    const externalSharing = await getExternalSharing(setupStatus);
    let integration;
    if (opts.feishuIntegration) {
      try {
        integration = await opts.feishuIntegration.snapshot();
      } catch {
        log.warn("failed to build Feishu integration snapshot");
      }
    }
    return c.html(
      await layout(
        "Integrations",
        [{ label: "Integrations" }],
        await integrationsView({
          botName: cfg.feishuBotName ?? "",
          botOpenId: cfg.feishuBotOpenId ?? "",
          setup: setupStatus,
          provisioning: getProvisioning(),
          restartRequired,
          runtime: getFeishuRuntime(),
          externalSharing,
          groups,
          agents,
          integration,
          brandAvatarAvailable: isReadableBrandAvatar(opts.brandAvatarPath),
          flashMsg: ok,
        }),
        "integrations",
      ),
    );
  });

  app.get("/integrations/progress", async (c) => {
    c.header("cache-control", "no-store");
    if (!opts.feishuIntegration) {
      return c.json(
        { error: "temporarily_unavailable", retryAfterMs: 10_000 },
        503,
      );
    }
    try {
      return c.json(await opts.feishuIntegration.progress());
    } catch {
      return c.json(
        { error: "temporarily_unavailable", retryAfterMs: 10_000 },
        503,
      );
    }
  });

  app.post("/integrations/bot/setup", async (c) => {
    const body = await c.req.parseBody();
    const returnTo = str(body, "returnTo") === "/setup" ? "/setup" : "/integrations";
    if (!opts.larkSetup) {
      return c.redirect(`${returnTo}?ok=${encodeURIComponent("配置失败：当前运行方式未接入 lark-cli")}`);
    }
    const appId = str(body, "appId").trim();
    const appSecret = str(body, "appSecret");
    const brand = str(body, "brand") === "lark" ? "lark" : "feishu";
    if (!appId || !appSecret) {
      return c.redirect(`${returnTo}?ok=${encodeURIComponent("配置失败：App ID 和 App Secret 均为必填")}`);
    }
    try {
      const status = await opts.larkSetup.configure({ appId, appSecret, brand });
      if (!persistVerifiedBot(status)) {
        return c.redirect(`${returnTo}?ok=${encodeURIComponent("配置失败：应用凭据未能验证 Bot 身份")}`);
      }
      return c.redirect(`${returnTo}?ok=${encodeURIComponent("连接已验证，Bot 身份已自动保存；重启服务后消息监听使用新应用")}`);
    } catch {
      // Deliberately avoid echoing the exception: CLI errors can include input
      // context, while App Secret must never be rendered back to the browser.
      return c.redirect(`${returnTo}?ok=${encodeURIComponent("配置失败：请检查 App ID、App Secret 和网络后重试")}`);
    }
  });

  app.post("/integrations/bot/verify", async (c) => {
    const status = await getLarkStatus();
    opts.feishuIntegration?.invalidateProgressProbes();
    if (!persistVerifiedBot(status)) {
      return c.redirect(`/integrations?ok=${encodeURIComponent("验证失败：lark-cli Bot 身份尚未就绪")}`);
    }
    return c.redirect(`/integrations?ok=${encodeURIComponent("连接已验证，Bot 身份已同步；身份变更需重启服务")}`);
  });

  app.post("/integrations/bot", async (c) => {
    const body = await c.req.parseBody();
    saveSettings({
      feishuBotName: str(body, "feishuBotName"),
      feishuBotOpenId: str(body, "feishuBotOpenId"),
    });
    return c.redirect(`/integrations?ok=${encodeURIComponent("已保存 Bot 身份（重启后生效）")}`);
  });

  app.get("/integrations/groups/connect", async (c) => {
    if (!opts.feishuIntegration) {
      return c.redirect(`/integrations?ok=${encodeURIComponent("群发现不可用：请先完成飞书 Bot 连接")}`);
    }
    try {
      const candidates =
        await opts.feishuIntegration.listConnectionCandidates();
      return c.html(
        await layout(
          "连接飞书群",
          [
            { label: "Integrations", href: "/integrations" },
            { label: "连接飞书群" },
          ],
          await feishuGroupConnectView({
            candidates,
            flashMsg: c.req.query("ok") ?? undefined,
          }),
          "integrations",
        ),
      );
    } catch (error) {
      return c.redirect(
        `/integrations?ok=${encodeURIComponent(feishuIntegrationMessage(error))}`,
      );
    }
  });

  app.post("/integrations/groups/connect", async (c) => {
    if (!opts.feishuIntegration) {
      return c.redirect(`/integrations?ok=${encodeURIComponent("群连接不可用：当前运行方式未接入飞书管理组件")}`);
    }
    const body = await c.req.parseBody();
    try {
      await opts.feishuIntegration.requestGroupConfirmation({
        chatId: str(body, "chatId"),
      });
      return c.redirect(
        `/integrations?ok=${encodeURIComponent("已发送确认提示；群主或管理员确认前不会收录消息")}`,
      );
    } catch (error) {
      const target = error instanceof FeishuIntegrationError
          && error.code === "prompt_failed"
        ? "/integrations"
        : "/integrations/groups/connect";
      return c.redirect(
        `${target}?ok=${encodeURIComponent(feishuIntegrationMessage(error))}`,
      );
    }
  });

  app.post("/integrations/groups/:space/confirmation", async (c) => {
    const space = parseSpace(c.req.param("space"));
    if (!space || !space.startsWith("team/")) return c.notFound();
    if (!opts.feishuIntegration) {
      return c.redirect(
        `/integrations?ok=${encodeURIComponent("确认提示不可用：当前运行方式未接入飞书管理组件")}`,
      );
    }
    try {
      await opts.feishuIntegration.resendGroupConfirmation(space);
      return c.redirect(
        `/integrations?ok=${encodeURIComponent("确认提示已重新发送")}`,
      );
    } catch (error) {
      return c.redirect(
        `/integrations?ok=${encodeURIComponent(feishuIntegrationMessage(error))}`,
      );
    }
  });

  app.post("/integrations/groups/:space/ignore", async (c) => {
    const space = parseSpace(c.req.param("space"));
    if (!space || !space.startsWith("team/")) return c.notFound();
    if (!opts.feishuIntegration) {
      return c.redirect(
        `/integrations?ok=${encodeURIComponent("忽略失败：当前运行方式未接入飞书管理组件")}`,
      );
    }
    try {
      await opts.feishuIntegration.disconnectGroup(space);
      return c.redirect(
        `/integrations?ok=${encodeURIComponent("已忽略该群；重新加入不会自动启用")}`,
      );
    } catch (error) {
      return c.redirect(
        `/integrations?ok=${encodeURIComponent(feishuIntegrationMessage(error))}`,
      );
    }
  });

  app.post("/integrations/groups/:space", async (c) => {
    const space = parseSpace(c.req.param("space"));
    if (!space || !engine.registry.has(space)) return c.notFound();
    const body = await c.req.parseBody();
    const agentId = str(body, "agentId");
    if (opts.feishuIntegration && space.startsWith("team/")) {
      try {
        await opts.feishuIntegration.updateGroup({
          spaceId: space,
          name: str(body, "name"),
          agentId,
          responseMode: parseFeishuResponseMode(body),
          participationLevel: parseGroupParticipationLevel(body),
          replyInThread: checkbox(body, "replyInThread"),
        });
        return c.redirect(
          `/integrations?ok=${encodeURIComponent("已保存群设置")}`,
        );
      } catch (error) {
        return c.redirect(
          `/integrations?ok=${encodeURIComponent(feishuIntegrationMessage(error))}`,
        );
      }
    }
    try {
      engine.updateSpaceMeta(space, {
        name: str(body, "name"),
        agentId,
        replyInThread: checkbox(body, "replyInThread"),
        participationLevel: parseGroupParticipationLevel(body),
        // A saved three-level policy supersedes the legacy respond-all switch.
        mentionsOnly: true,
      });
    } catch {
      return c.redirect(`/integrations?ok=${encodeURIComponent("保存失败：Agent Visibility 与空间类型不匹配")}`);
    }
    return c.redirect(`/integrations?ok=${encodeURIComponent("已保存群设置")}`);
  });

  app.post("/integrations/groups/:space/test", async (c) => {
    const space = parseSpace(c.req.param("space"));
    if (!space || !space.startsWith("team/") || !engine.registry.has(space)) return c.notFound();
    if (opts.feishuIntegration) {
      try {
        await opts.feishuIntegration.testGroup(space);
        return c.redirect(
          `/integrations?ok=${encodeURIComponent("测试消息已发送，请到目标群确认")}`,
        );
      } catch (error) {
        return c.redirect(
          `/integrations?ok=${encodeURIComponent(feishuIntegrationMessage(error))}`,
        );
      }
    }
    if (!opts.onIntegrationTest) {
      return c.redirect(`/integrations?ok=${encodeURIComponent("测试失败：当前运行方式未连接飞书发送通道")}`);
    }
    const meta = engine.registry.get(space);
    const chatId = meta?.chatId ?? space.slice("team/".length);
    if (!chatId) {
      return c.redirect(`/integrations?ok=${encodeURIComponent("测试失败：该群没有可用的 chat_id")}`);
    }
    try {
      await opts.onIntegrationTest(
        chatId,
        "✅ homeagent 配置测试成功：机器人发送通道可用。现在可以在群里 @我 提问。",
      );
      return c.redirect(`/integrations?ok=${encodeURIComponent("测试消息已发送，请到目标群确认")}`);
    } catch {
      return c.redirect(`/integrations?ok=${encodeURIComponent("测试失败：请检查发送消息权限、机器人可用范围和群成员状态")}`);
    }
  });

  app.post("/integrations/groups/:space/disconnect", async (c) => {
    const space = parseSpace(c.req.param("space"));
    if (!space || !space.startsWith("team/")) return c.notFound();
    if (!opts.feishuIntegration) {
      return c.redirect(
        `/integrations?ok=${encodeURIComponent("断开失败：当前运行方式未接入飞书管理组件")}`,
      );
    }
    try {
      await opts.feishuIntegration.disconnectGroup(space);
      return c.redirect(
        `/integrations?ok=${encodeURIComponent("群聊已断开；已有知识和自动化数据均已保留")}`,
      );
    } catch (error) {
      return c.redirect(
        `/integrations?ok=${encodeURIComponent(feishuIntegrationMessage(error))}`,
      );
    }
  });

  app.post("/integrations/bot/disconnect", async (c) => {
    if (!opts.feishuIntegration) {
      return c.redirect(
        `/integrations?ok=${encodeURIComponent("停用失败：当前运行方式未接入飞书管理组件")}`,
      );
    }
    try {
      await opts.feishuIntegration.disconnectBot();
      return c.redirect(
        `/integrations?ok=${encodeURIComponent("Bot 已在 HomeAgent 中停用；凭据和知识均已保留")}`,
      );
    } catch (error) {
      return c.redirect(
        `/integrations?ok=${encodeURIComponent(feishuIntegrationMessage(error))}`,
      );
    }
  });

  // ---- Settings ------------------------------------------------------------

  app.get("/settings", async (c) => {
    const cfg = config();
    const ok = c.req.query("ok") ?? undefined;
    const dataDirectory = opts.dataDirectory
      ? await opts.dataDirectory.status()
      : {
          currentPath: cfg.dataDir,
          available: false,
          lockedByEnvironment: false,
          gitAvailable: false,
          gitRepository: false,
          restartable: false,
        };
    return c.html(
      await layout(
        "设置",
        [{ label: "设置" }],
        await settingsView(
          {
            defaultProvider: cfg.defaultProvider,
            defaultModel: cfg.defaultModel,
            dailyBudgetUsd: cfg.dailyBudgetUsd,
            chatTimeoutMinutes: cfg.chatTimeoutMinutes,
            dreamHour: cfg.dreamHour,
            rawRetentionDays: cfg.rawRetentionDays,
            webPort: cfg.webPort,
            dataDir: cfg.dataDir,
          },
          await getProviders(),
          await getModels(),
          ok,
          undefined,
          {},
          dataDirectory,
        ),
        "settings",
      ),
    );
  });

  app.post("/settings", async (c) => {
    const body = await c.req.parseBody();
    const parsed = parseSettingsForm(body);
    const providers = await getProviders();
    if (parsed.patch) {
      const selectedProvider = providers.find(
        (provider) => provider.id === parsed.values.defaultProvider,
      );
      if (!selectedProvider?.available) {
        parsed.errors.defaultProvider = "默认 Provider 尚未安装或无法运行";
        parsed.patch = undefined;
      } else if (!providerSupportsOrdinaryCompletion(selectedProvider.id)) {
        parsed.errors.defaultProvider = "默认 Provider 必须支持安全的普通对话；该 CLI 仅用于显式任务";
        parsed.patch = undefined;
      }
    }
    if (!parsed.patch) {
      const cfg = config();
      return c.html(
        await layout(
          "设置",
          [{ label: "设置" }],
          await settingsView(
            {
              defaultProvider: cfg.defaultProvider,
              defaultModel: cfg.defaultModel,
              dailyBudgetUsd: cfg.dailyBudgetUsd,
              chatTimeoutMinutes: cfg.chatTimeoutMinutes,
              dreamHour: cfg.dreamHour,
              rawRetentionDays: cfg.rawRetentionDays,
              webPort: cfg.webPort,
              dataDir: cfg.dataDir,
            },
            providers,
            await getModels(),
            undefined,
            parsed.values,
            parsed.errors,
            opts.dataDirectory
              ? await opts.dataDirectory.status()
              : {
                  currentPath: cfg.dataDir,
                  available: false,
                  lockedByEnvironment: false,
                  gitAvailable: false,
                  gitRepository: false,
                  restartable: false,
                },
          ),
          "settings",
        ),
        400,
      );
    }
    saveSettings(parsed.patch);
    return c.redirect(`/settings?ok=${encodeURIComponent("已保存设置")}`);
  });

  app.post("/settings/data-directory", async (c) => {
    if (!opts.dataDirectory) return c.text("Data directory migration unavailable", 409);
    const body = await c.req.parseBody();
    if (!checkbox(body, "confirmMigration")) {
      return c.redirect(`/settings?ok=${encodeURIComponent("迁移未安排：请确认旧目录会被保留")}`);
    }
    try {
      await opts.dataDirectory.scheduleMigration({
        destination: str(body, "dataDirectory"),
        initializeGit: checkbox(body, "initializeGit"),
      });
      const status = await opts.dataDirectory.status();
      if (status.restartable && opts.onServiceRestart) {
        opts.onServiceRestart();
        return c.html(await restartingView(instanceId, {
          destination: "/settings",
          title: "正在迁移数据目录",
          message: "服务会安全停止，在重新启动时复制并校验数据，然后自动回到设置页。",
        }));
      }
      return c.redirect(`/settings?ok=${encodeURIComponent("迁移已安排；请停止并重新启动 HomeAgent 以完成迁移")}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.redirect(`/settings?ok=${encodeURIComponent(`迁移未安排：${message}`)}`);
    }
  });

  // ---- logs ----------------------------------------------------------------

  app.get("/logs", async (c) => {
    const logs = readLogs();
    return c.html(await layout("调用日志", [{ label: "调用日志" }], await logsView(logs), "logs"));
  });

  return app;
}

function verifiedBotIdentity(status: LarkSetupStatus): LarkBotIdentity | undefined {
  if (status.state !== "ready" || !status.verified || !status.botName || !status.botOpenId) {
    return undefined;
  }
  return { botName: status.botName, botOpenId: status.botOpenId };
}

/** Read the last few days of LLM call logs from data/logs/*.jsonl. */
function readLogs(): { day: string; lines: string[] }[] {
  const dir = join(config().dataDir, "logs");
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => f.startsWith("llm-") && f.endsWith(".jsonl"))
    .sort()
    .reverse()
    .slice(0, 3);
  return files.map((f) => {
    const day = f.replace(/^llm-|\.jsonl$/g, "");
    const lines = readFileSync(join(dir, f), "utf8").trim().split("\n").slice(-200);
    return { day, lines };
  });
}
