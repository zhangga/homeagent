/**
 * Central configuration. Resolved from environment variables and then overlaid
 * with an editable settings file (data/config/settings.json) written by the
 * management backend. Precedence: settings.json (admin's explicit choice) wins
 * over env defaults for the editable subset; host-injected secrets
 * (ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN) are optional, env-only, and never
 * persisted. They are validated lazily by the legacy gateway client; the main
 * homeagent runtime uses local agent CLIs and does not need them.
 *
 * Model IDs are the gateway's real identifiers (verified against /v1/models):
 * haiku is used for cheap structured judgments, the default (sonnet) for ask, and a
 * heavy tier (opus) reserved for expensive distillation when warranted.
 */
import { resolve, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { brandedEnv } from "./brand.ts";
import {
  AI_MAX_CONFIGURABLE_TIMEOUT_MINUTES,
  AI_OPERATION_TIMEOUT_MINUTES,
} from "./ai-limits.ts";

export const DEFAULT_CHAT_TIMEOUT_MINUTES = AI_OPERATION_TIMEOUT_MINUTES;
export const MIN_CHAT_TIMEOUT_MINUTES = AI_OPERATION_TIMEOUT_MINUTES;
export const MAX_CHAT_TIMEOUT_MINUTES = AI_MAX_CONFIGURABLE_TIMEOUT_MINUTES;

export interface Config {
  gatewayBaseUrl: string;
  gatewayToken: string;
  dataDir: string;
  /** default model for ask/distill */
  model: string;
  /** cheap model for short structured judgments */
  modelFast: string;
  /** heavy model reserved for complex synthesis (opt-in) */
  modelHeavy: string;
  /** observe-only daily cost reference; never gates Provider calls */
  dailyBudgetUsd: number;
  /** maximum provider runtime for an interactive chat answer */
  chatTimeoutMinutes: number;
  /** management backend bind address; loopback by default */
  webHost: string;
  webPort: number;
  /** env-only credential required when webHost is not loopback */
  webAdminToken?: string;
  /** env-only credential limited to the local Agent read-only API */
  agentReadToken?: string;
  /** env-only credential limited to local Agent feedback submission */
  agentFeedbackToken?: string;
  /** local hour (Asia/Shanghai) for the nightly dream cycle */
  dreamHour: number;
  /** days to retain distilled raw messages; 0 keeps them forever */
  rawRetentionDays: number;
  /**
   * Default local agent CLI (provider id: claude / codex / trae-cli) used when a
   * space's agent doesn't specify one. All LLM work (ask + dream) runs through a
   * CLI; there is no network-API fallback.
   */
  defaultProvider: string;
  /** default model passed to the default CLI (empty => the CLI's own default) */
  defaultModel: string;
  /** feishu bot display name, for precise @-mention detection (optional) */
  feishuBotName?: string;
  /** feishu bot open_id, for precise @-mention detection (optional) */
  feishuBotOpenId?: string;
  /** configured app intentionally disabled inside HomeAgent */
  feishuConnectionDisabledAppId?: string;
  /** app id whose external-sharing publishing flow is being tracked */
  feishuExternalSharingAppId?: string;
  /** timestamp after which an external-group message may verify sharing */
  feishuExternalSharingStartedAt?: number;
  /** timestamp when a real external-group message verified sharing */
  feishuExternalSharingVerifiedAt?: number;
  /** external chat that verified sharing for the tracked app */
  feishuExternalSharingVerifiedChatId?: string;
  /** current app explicitly kept internal-only by the administrator */
  feishuExternalSharingSkippedAppId?: string;
  /** timestamp recorded after the guided first-run setup is completed */
  onboardingCompletedAt?: number;
  /** timestamp used to require a real message received during this setup run */
  onboardingStartedAt?: number;
}

/**
 * The subset of Config the management backend may edit and persist. Secrets and
 * dataDir are intentionally excluded.
 */
export interface PersistedSettings {
  model?: string;
  modelFast?: string;
  modelHeavy?: string;
  dailyBudgetUsd?: number;
  chatTimeoutMinutes?: number;
  webPort?: number;
  dreamHour?: number;
  rawRetentionDays?: number;
  defaultProvider?: string;
  defaultModel?: string;
  feishuBotName?: string;
  feishuBotOpenId?: string;
  feishuConnectionDisabledAppId?: string;
  feishuExternalSharingAppId?: string;
  feishuExternalSharingStartedAt?: number;
  feishuExternalSharingVerifiedAt?: number;
  feishuExternalSharingVerifiedChatId?: string;
  feishuExternalSharingSkippedAppId?: string;
  onboardingCompletedAt?: number;
  onboardingStartedAt?: number;
}

export const EDITABLE_KEYS: (keyof PersistedSettings)[] = [
  "model",
  "modelFast",
  "modelHeavy",
  "dailyBudgetUsd",
  "chatTimeoutMinutes",
  "webPort",
  "dreamHour",
  "rawRetentionDays",
  "defaultProvider",
  "defaultModel",
  "feishuBotName",
  "feishuBotOpenId",
  "feishuConnectionDisabledAppId",
  "feishuExternalSharingAppId",
  "feishuExternalSharingStartedAt",
  "feishuExternalSharingVerifiedAt",
  "feishuExternalSharingVerifiedChatId",
  "feishuExternalSharingSkippedAppId",
  "onboardingCompletedAt",
  "onboardingStartedAt",
];

function num(env: NodeJS.ProcessEnv, suffix: string, fallback: number): number {
  const raw = brandedEnv(env, suffix);
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`env HOMEAGENT_${suffix} must be a number, got ${raw}`);
  }
  return n;
}

function nonnegativeInt(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(36_500, Math.trunc(value)));
}

function chatTimeoutMinutes(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(
    MIN_CHAT_TIMEOUT_MINUTES,
    Math.min(MAX_CHAT_TIMEOUT_MINUTES, Math.trunc(value)),
  );
}

function settingsPath(dataDir: string): string {
  return join(dataDir, "config", "settings.json");
}

/** Prefer explicit model IDs over historical routing aliases in persisted config. */
export function canonicalModelId(model: string): string {
  const value = model.trim();
  return value === "gpt-5.6" ? "gpt-5.6-sol" : value;
}

/** Read the persisted editable settings, tolerating a missing/corrupt file. */
export function readSettings(dataDir: string): PersistedSettings {
  const path = settingsPath(dataDir);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as PersistedSettings;
    if (!parsed || typeof parsed !== "object") return {};
    if (parsed.defaultModel !== undefined) {
      const model = canonicalModelId(parsed.defaultModel);
      if (model !== parsed.defaultModel) {
        parsed.defaultModel = model;
        try {
          writeFileSync(path, JSON.stringify(parsed, null, 2), "utf8");
        } catch {
          // A read-only deployment can still use the canonical in-memory value.
        }
      }
    }
    return parsed;
  } catch {
    return {};
  }
}

let cached: Config | undefined;

export function loadConfig(env = process.env): Config {
  const dataDir = resolve(brandedEnv(env, "DATA_DIR") ?? "./data");
  const persisted = readSettings(dataDir);

  const base: Config = {
    gatewayBaseUrl: (env.ANTHROPIC_BASE_URL ?? "").replace(/\/+$/, ""),
    gatewayToken: env.ANTHROPIC_AUTH_TOKEN ?? "",
    dataDir,
    model: brandedEnv(env, "LLM_MODEL") ?? "claude-sonnet-5",
    modelFast: brandedEnv(env, "LLM_MODEL_FAST") ?? "claude-haiku-4-5-20251001",
    modelHeavy: brandedEnv(env, "LLM_MODEL_HEAVY") ?? "claude-opus-4-8",
    dailyBudgetUsd: num(env, "DAILY_BUDGET_USD", 5),
    chatTimeoutMinutes: chatTimeoutMinutes(
      num(env, "CHAT_TIMEOUT_MINUTES", DEFAULT_CHAT_TIMEOUT_MINUTES),
      DEFAULT_CHAT_TIMEOUT_MINUTES,
    ),
    webHost: brandedEnv(env, "WEB_HOST")?.trim() || "127.0.0.1",
    webPort: num(env, "WEB_PORT", 3000),
    webAdminToken: brandedEnv(env, "WEB_ADMIN_TOKEN")?.trim() || undefined,
    agentReadToken: brandedEnv(env, "AGENT_READ_TOKEN")?.trim() || undefined,
    agentFeedbackToken: brandedEnv(env, "AGENT_FEEDBACK_TOKEN")?.trim() || undefined,
    dreamHour: num(env, "DREAM_HOUR", 3),
    rawRetentionDays: nonnegativeInt(num(env, "RAW_RETENTION_DAYS", 90), 90),
    defaultProvider: brandedEnv(env, "DEFAULT_PROVIDER") || "claude",
    defaultModel: brandedEnv(env, "DEFAULT_MODEL") || "",
    feishuBotName: brandedEnv(env, "FEISHU_BOT_NAME") || undefined,
    feishuBotOpenId: brandedEnv(env, "FEISHU_BOT_OPEN_ID") || undefined,
    feishuConnectionDisabledAppId: undefined,
    feishuExternalSharingAppId: undefined,
    feishuExternalSharingStartedAt: undefined,
    feishuExternalSharingVerifiedAt: undefined,
    feishuExternalSharingVerifiedChatId: undefined,
    feishuExternalSharingSkippedAppId: undefined,
    onboardingCompletedAt: undefined,
    onboardingStartedAt: undefined,
  };

  // Overlay persisted editable settings (admin's explicit choices win).
  if (persisted.model) base.model = persisted.model;
  if (persisted.modelFast) base.modelFast = persisted.modelFast;
  if (persisted.modelHeavy) base.modelHeavy = persisted.modelHeavy;
  if (typeof persisted.dailyBudgetUsd === "number") base.dailyBudgetUsd = persisted.dailyBudgetUsd;
  if (typeof persisted.chatTimeoutMinutes === "number") {
    base.chatTimeoutMinutes = chatTimeoutMinutes(
      persisted.chatTimeoutMinutes,
      base.chatTimeoutMinutes,
    );
  }
  if (typeof persisted.webPort === "number") base.webPort = persisted.webPort;
  if (typeof persisted.dreamHour === "number") base.dreamHour = persisted.dreamHour;
  if (typeof persisted.rawRetentionDays === "number") {
    base.rawRetentionDays = nonnegativeInt(persisted.rawRetentionDays, base.rawRetentionDays);
  }
  if (persisted.defaultProvider) base.defaultProvider = persisted.defaultProvider;
  if (persisted.defaultModel !== undefined) base.defaultModel = persisted.defaultModel;
  if (persisted.feishuBotName !== undefined) base.feishuBotName = persisted.feishuBotName || undefined;
  if (persisted.feishuBotOpenId !== undefined) base.feishuBotOpenId = persisted.feishuBotOpenId || undefined;
  if (persisted.feishuConnectionDisabledAppId !== undefined) {
    base.feishuConnectionDisabledAppId =
      persisted.feishuConnectionDisabledAppId || undefined;
  }
  if (persisted.feishuExternalSharingAppId !== undefined) {
    base.feishuExternalSharingAppId = persisted.feishuExternalSharingAppId || undefined;
  }
  if (
    typeof persisted.feishuExternalSharingStartedAt === "number"
    && Number.isFinite(persisted.feishuExternalSharingStartedAt)
  ) {
    base.feishuExternalSharingStartedAt = persisted.feishuExternalSharingStartedAt;
  }
  if (
    typeof persisted.feishuExternalSharingVerifiedAt === "number"
    && Number.isFinite(persisted.feishuExternalSharingVerifiedAt)
  ) {
    base.feishuExternalSharingVerifiedAt = persisted.feishuExternalSharingVerifiedAt;
  }
  if (persisted.feishuExternalSharingVerifiedChatId !== undefined) {
    base.feishuExternalSharingVerifiedChatId = persisted.feishuExternalSharingVerifiedChatId || undefined;
  }
  if (persisted.feishuExternalSharingSkippedAppId !== undefined) {
    base.feishuExternalSharingSkippedAppId = persisted.feishuExternalSharingSkippedAppId || undefined;
  }
  if (typeof persisted.onboardingCompletedAt === "number" && Number.isFinite(persisted.onboardingCompletedAt)) {
    base.onboardingCompletedAt = persisted.onboardingCompletedAt;
  }
  if (typeof persisted.onboardingStartedAt === "number" && Number.isFinite(persisted.onboardingStartedAt)) {
    base.onboardingStartedAt = persisted.onboardingStartedAt;
  }

  base.defaultModel = canonicalModelId(base.defaultModel);

  return base;
}

/** Memoized config for the running process. */
export function config(): Config {
  if (!cached) cached = loadConfig();
  return cached;
}

/**
 * Persist a patch to data/config/settings.json and clear the memoized config so
 * the next config() reflects it. Unknown keys are ignored. Runtime consumers
 * that read config() lazily (ask, dream, scheduler) pick the change up; those
 * that snapshot at startup (feishu bot identity, web port) need a restart.
 */
export function saveSettings(patch: PersistedSettings, dataDir = config().dataDir): PersistedSettings {
  const current = readSettings(dataDir);
  const next: PersistedSettings = { ...current };
  for (const key of EDITABLE_KEYS) {
    if (patch[key] !== undefined) {
      // Empty strings clear optional string fields; keep numbers as-is.
      (next as Record<string, unknown>)[key] = patch[key];
    }
  }
  if (next.defaultModel !== undefined) next.defaultModel = canonicalModelId(next.defaultModel);
  mkdirSync(join(dataDir, "config"), { recursive: true });
  writeFileSync(settingsPath(dataDir), JSON.stringify(next, null, 2), "utf8");
  resetConfig();
  return next;
}

/** Test/rebind helper: clears the memoized config. */
export function resetConfig(): void {
  cached = undefined;
}
