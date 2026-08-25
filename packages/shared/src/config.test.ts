import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, readSettings, saveSettings, resetConfig } from "./config.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hb-config-"));
  process.env.HOMEAGENT_DATA_DIR = dir;
  process.env.ANTHROPIC_BASE_URL = "http://localhost:0";
  process.env.ANTHROPIC_AUTH_TOKEN = "test-token";
  resetConfig();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.HOMEAGENT_DATA_DIR;
  resetConfig();
});

describe("editable settings overlay", () => {
  test("local CLI runtime starts without legacy gateway credentials", () => {
    const cfg = loadConfig({
      HOMEAGENT_DATA_DIR: dir,
    });
    expect(cfg.gatewayBaseUrl).toBe("");
    expect(cfg.gatewayToken).toBe("");
  });

  test("defaults apply when no settings.json exists", () => {
    const cfg = loadConfig();
    expect(cfg.model).toBe("claude-sonnet-5");
    expect(cfg.dreamHour).toBe(3);
    expect(cfg.dailyBudgetUsd).toBe(5);
    expect(cfg.defaultProvider).toBe("claude");
    expect(cfg.defaultModel).toBe("");
    expect(cfg.rawRetentionDays).toBe(90);
    expect(cfg.chatTimeoutMinutes).toBe(10);
    expect(cfg.webHost).toBe("127.0.0.1");
    expect(cfg.webAdminToken).toBeUndefined();
    expect(cfg.agentReadToken).toBeUndefined();
    expect(cfg.agentFeedbackToken).toBeUndefined();
  });

  test("web exposure settings are env-only", () => {
    const cfg = loadConfig({
      ...process.env,
      HOMEAGENT_WEB_HOST: "0.0.0.0",
      HOMEAGENT_WEB_ADMIN_TOKEN: "admin-secret",
      HOMEAGENT_AGENT_READ_TOKEN: "agent-read-secret",
      HOMEAGENT_AGENT_FEEDBACK_TOKEN: "agent-feedback-secret",
      HOMEAGENT_RAW_RETENTION_DAYS: "45",
    });
    expect(cfg.webHost).toBe("0.0.0.0");
    expect(cfg.webAdminToken).toBe("admin-secret");
    expect(cfg.agentReadToken).toBe("agent-read-secret");
    expect(cfg.agentFeedbackToken).toBe("agent-feedback-secret");
    expect(cfg.rawRetentionDays).toBe(45);
    expect(readSettings(dir)).toEqual({});
  });

  test("reads legacy environment settings while preferring HomeAgent values", () => {
    const legacy = loadConfig({
      HOMEBRAIN_DATA_DIR: dir,
      HOMEBRAIN_WEB_PORT: "4100",
      HOMEBRAIN_DEFAULT_PROVIDER: "codex",
    });
    expect(legacy.dataDir).toBe(dir);
    expect(legacy.webPort).toBe(4100);
    expect(legacy.defaultProvider).toBe("codex");

    const canonical = loadConfig({
      HOMEAGENT_DATA_DIR: dir,
      HOMEBRAIN_DATA_DIR: "/legacy-data",
      HOMEAGENT_WEB_PORT: "4200",
      HOMEBRAIN_WEB_PORT: "4100",
    });
    expect(canonical.dataDir).toBe(dir);
    expect(canonical.webPort).toBe(4200);
  });

  test("default provider/model overlay from settings.json", () => {
    saveSettings({ defaultProvider: "trae-cli", defaultModel: "openrouter-3o" }, dir);
    const cfg = loadConfig();
    expect(cfg.defaultProvider).toBe("trae-cli");
    expect(cfg.defaultModel).toBe("openrouter-3o");
  });

  test("canonicalizes the GPT-5.6 alias to the explicit Sol model id", () => {
    const path = join(dir, "config", "settings.json");
    mkdirSync(join(dir, "config"), { recursive: true });
    writeFileSync(path, JSON.stringify({ defaultProvider: "codex", defaultModel: "gpt-5.6" }));

    expect(loadConfig().defaultModel).toBe("gpt-5.6-sol");
    expect(readSettings(dir).defaultModel).toBe("gpt-5.6-sol");
    expect(JSON.parse(readFileSync(path, "utf8")).defaultModel).toBe("gpt-5.6-sol");

    rmSync(path);
    expect(
      loadConfig({
        ...process.env,
        HOMEAGENT_DEFAULT_PROVIDER: "codex",
        HOMEAGENT_DEFAULT_MODEL: "gpt-5.6",
      }).defaultModel,
    ).toBe("gpt-5.6-sol");
  });

  test("saveSettings writes config/settings.json and overlays it", () => {
    saveSettings({
      model: "claude-opus-4-8",
      dreamHour: 5,
      dailyBudgetUsd: 12,
      rawRetentionDays: 30,
      chatTimeoutMinutes: 25,
    }, dir);
    const path = join(dir, "config", "settings.json");
    expect(existsSync(path)).toBe(true);
    const raw = JSON.parse(readFileSync(path, "utf8"));
    expect(raw.model).toBe("claude-opus-4-8");

    const cfg = loadConfig();
    expect(cfg.model).toBe("claude-opus-4-8");
    expect(cfg.dreamHour).toBe(5);
    expect(cfg.dailyBudgetUsd).toBe(12);
    expect(cfg.rawRetentionDays).toBe(30);
    expect(cfg.chatTimeoutMinutes).toBe(25);
  });

  test("persisted settings win over env defaults", () => {
    process.env.HOMEAGENT_LLM_MODEL = "claude-haiku-4-5-20251001";
    resetConfig();
    expect(loadConfig().model).toBe("claude-haiku-4-5-20251001");
    saveSettings({ model: "claude-sonnet-5" }, dir);
    expect(loadConfig().model).toBe("claude-sonnet-5");
    delete process.env.HOMEAGENT_LLM_MODEL;
  });

  test("saveSettings merges (does not clobber unrelated keys)", () => {
    saveSettings({ model: "claude-opus-4-8" }, dir);
    saveSettings({ dreamHour: 7 }, dir);
    const persisted = readSettings(dir);
    expect(persisted.model).toBe("claude-opus-4-8");
    expect(persisted.dreamHour).toBe(7);
  });

  test("persists onboarding completion independently of editable setup choices", () => {
    saveSettings({ onboardingStartedAt: 1_783_000_000_000, onboardingCompletedAt: 1_784_000_000_000 }, dir);
    const cfg = loadConfig();
    expect(cfg.onboardingStartedAt).toBe(1_783_000_000_000);
    expect(cfg.onboardingCompletedAt).toBe(1_784_000_000_000);
    expect(readSettings(dir).onboardingStartedAt).toBe(1_783_000_000_000);
    expect(readSettings(dir).onboardingCompletedAt).toBe(1_784_000_000_000);
  });

  test("feishu bot identity is exposed on config and editable", () => {
    saveSettings({ feishuBotName: "homeagent", feishuBotOpenId: "ou_x" }, dir);
    const cfg = loadConfig();
    expect(cfg.feishuBotName).toBe("homeagent");
    expect(cfg.feishuBotOpenId).toBe("ou_x");
  });

  test("persists the locally disabled Feishu app without clearing its identity", () => {
    saveSettings({
      feishuBotName: "homeagent",
      feishuBotOpenId: "ou_x",
      feishuConnectionDisabledAppId: "cli_disabled",
    }, dir);

    const cfg = loadConfig();
    expect(cfg.feishuConnectionDisabledAppId).toBe("cli_disabled");
    expect(cfg.feishuBotName).toBe("homeagent");
    expect(cfg.feishuBotOpenId).toBe("ou_x");

    saveSettings({ feishuConnectionDisabledAppId: "" }, dir);
    expect(loadConfig().feishuConnectionDisabledAppId).toBeUndefined();
  });

  test("persists external sharing progress for the current Feishu app", () => {
    saveSettings({
      feishuExternalSharingAppId: "cli_external",
      feishuExternalSharingStartedAt: 100,
      feishuExternalSharingVerifiedAt: 200,
      feishuExternalSharingVerifiedChatId: "oc_external",
      feishuExternalSharingSkippedAppId: "",
    }, dir);

    const cfg = loadConfig();
    expect(cfg.feishuExternalSharingAppId).toBe("cli_external");
    expect(cfg.feishuExternalSharingStartedAt).toBe(100);
    expect(cfg.feishuExternalSharingVerifiedAt).toBe(200);
    expect(cfg.feishuExternalSharingVerifiedChatId).toBe("oc_external");
    expect(cfg.feishuExternalSharingSkippedAppId).toBeUndefined();
  });

  test("readSettings tolerates a corrupt file", () => {
    saveSettings({ model: "claude-sonnet-5" }, dir);
    // corrupt it
    const path = join(dir, "config", "settings.json");
    require("node:fs").writeFileSync(path, "{ not json", "utf8");
    expect(readSettings(dir)).toEqual({});
  });
});
