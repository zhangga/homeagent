import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLocalCodexTransportConfig } from "./codex-transport-config.ts";

test("reads only active model_provider transport config and forwards its declared env_key", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ha-codex-transport-")));
  const home = join(root, "codex");
  const catalog = join(home, "catalog.json");
  try {
    mkdirSync(home, { recursive: true });
    writeFileSync(catalog, '{"models":[]}\n', "utf8");
    writeFileSync(join(home, "config.toml"), [
      'model_provider = "apirouter"',
      'model = "gpt-6.2-sol"',
      `model_catalog_json = ${JSON.stringify(catalog)}`,
      'notify = ["notify.exe", "turn-ended"]',
      "",
      "[hooks.state]",
      'enabled = true',
      "",
      "[model_providers.apirouter]",
      'name = "apirouter"',
      'base_url = "https://api.gameaigc.cn/v1"',
      'wire_api = "responses"',
      'env_key = "APIROUTER_API_KEY"',
      "requires_openai_auth = true",
      "",
      "[model_providers.unused_other]",
      'name = "other"',
      'base_url = "https://unused.example/v1"',
      'env_key = "UNUSED_SECRET_KEY"',
    ].join("\n"), "utf8");

    const transport = readLocalCodexTransportConfig({
      CODEX_HOME: home,
      APIROUTER_API_KEY: "secret-router-key",
      UNUSED_SECRET_KEY: "should-not-forward",
    });

    expect(transport.args).toEqual([
      "-c", `model_catalog_json=${JSON.stringify(catalog)}`,
      "-c", 'model_provider="apirouter"',
      "-c", 'model_providers.apirouter={name="apirouter",base_url="https://api.gameaigc.cn/v1",wire_api="responses",env_key="APIROUTER_API_KEY",requires_openai_auth=true}',
    ]);
    expect(transport.args.join(" ")).not.toContain("secret-router-key");
    expect(transport.args.join(" ")).not.toContain("notify.exe");
    expect(transport.args.join(" ")).not.toContain("unused_other");
    expect(transport.env).toEqual({ APIROUTER_API_KEY: "secret-router-key" });
    expect(transport.selfContainedAuth).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("keeps inline bearer tokens and sensitive headers out of argv via synthetic env vars", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ha-codex-transport-secrets-")));
  const home = join(root, "codex");
  try {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.toml"), [
      'model_provider = "magpie"',
      "",
      "[model_providers.magpie]",
      'name = "magpie"',
      'base_url = "http://127.0.0.1:3425/v1"',
      'wire_api = "responses"',
      'experimental_bearer_token = "inline-secret-token"',
      'http_headers = { "x-openai-actor-authorization" = "secret-actor", "x-client-name" = "homeagent" }',
      'env_http_headers = { "x-extra-key" = "CUSTOM_HEADER_KEY" }',
      'query_params = { "api-version" = "2025-04-01", "api_key" = "leaked-query-secret" }',
      "supports_websockets = false",
      "requires_openai_auth = false",
      "request_max_retries = 2",
      "stream_max_retries = 3",
      "stream_idle_timeout_ms = 60000",
    ].join("\n"), "utf8");

    const transport = readLocalCodexTransportConfig({
      CODEX_HOME: home,
      CUSTOM_HEADER_KEY: "env-header-secret",
    });

    const joined = transport.args.join(" ");
    expect(joined).not.toContain("inline-secret-token");
    expect(joined).not.toContain("secret-actor");
    expect(joined).not.toContain("env-header-secret");
    expect(joined).not.toContain("leaked-query-secret");
    expect(joined).toContain('env_key="HOMEAGENT_CODEX_PROVIDER_BEARER_TOKEN"');
    expect(joined).toContain('http_headers={"x-client-name"="homeagent"}');
    expect(joined).toContain('"x-openai-actor-authorization"="HOMEAGENT_CODEX_HEADER_0"');
    expect(joined).toContain('"x-extra-key"="CUSTOM_HEADER_KEY"');
    expect(joined).toContain('query_params={"api-version"="2025-04-01"}');
    expect(joined).toContain("supports_websockets=false");
    expect(joined).toContain("requires_openai_auth=false");
    expect(transport.env).toEqual({
      HOMEAGENT_CODEX_PROVIDER_BEARER_TOKEN: "inline-secret-token",
      CUSTOM_HEADER_KEY: "env-header-secret",
      HOMEAGENT_CODEX_HEADER_0: "secret-actor",
    });
    expect(transport.selfContainedAuth).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("supports command-based provider auth helpers and top-level openai_base_url", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ha-codex-transport-auth-cmd-")));
  const home = join(root, "codex");
  try {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.toml"), [
      'openai_base_url = "https://proxy.example/v1"',
      'model_provider = "unified_local"',
      "",
      "[model_providers.unified_local]",
      'name = "OpenAI"',
      'base_url = "http://127.0.0.1:8317/v1"',
      'wire_api = "responses"',
      "supports_websockets = false",
      "",
      "[model_providers.unified_local.auth]",
      'command = "powershell.exe"',
      'args = ["-NoProfile", "-File", "helper.ps1"]',
      "refresh_interval_ms = 0",
    ].join("\n"), "utf8");

    const transport = readLocalCodexTransportConfig({ CODEX_HOME: home });
    expect(transport.args).toEqual([
      "-c", 'openai_base_url="https://proxy.example/v1"',
      "-c", 'model_provider="unified_local"',
      "-c", 'model_providers.unified_local={name="OpenAI",base_url="http://127.0.0.1:8317/v1",wire_api="responses",supports_websockets=false,auth={command="powershell.exe",args=["-NoProfile","-File","helper.ps1"],refresh_interval_ms=0}}',
    ]);
    expect(transport.env).toEqual({});
    expect(transport.selfContainedAuth).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects forbidden env names, symlinks, invalid URLs, and unparseable configs", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ha-codex-transport-guard-")));
  const home = join(root, "codex");
  try {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.toml"), [
      'model_provider = "bad"',
      "[model_providers.bad]",
      'base_url = "https://user:pass@example.com/v1"',
      'env_key = "HOMEAGENT_FEISHU_APP_SECRET"',
      'env_http_headers = { "x-path" = "PATH", "x-preload" = "LD_PRELOAD" }',
    ].join("\n"), "utf8");

    const guarded = readLocalCodexTransportConfig({
      CODEX_HOME: home,
      HOMEAGENT_FEISHU_APP_SECRET: "feishu-secret",
      LD_PRELOAD: "/tmp/evil.so",
    });
    expect(guarded.args).toEqual([]);
    expect(guarded.env).toEqual({});
    expect(guarded.selfContainedAuth).toBe(false);

    writeFileSync(join(home, "config.toml"), 'model_provider = "openai"\n', "utf8");
    expect(readLocalCodexTransportConfig({ CODEX_HOME: home })).toEqual({
      args: [],
      env: {},
      selfContainedAuth: false,
    });

    writeFileSync(join(home, "config.toml"), 'model_provider = "UNCLOSED', "utf8");
    expect(readLocalCodexTransportConfig({ CODEX_HOME: home })).toEqual({
      args: [],
      env: {},
      selfContainedAuth: false,
    });

    if (process.platform !== "win32") {
      const external = join(root, "external.toml");
      writeFileSync(external, 'model_provider = "apirouter"\n[model_providers.apirouter]\nbase_url = "https://example.com/v1"\n', "utf8");
      rmSync(join(home, "config.toml"));
      symlinkSync(external, join(home, "config.toml"));
      expect(readLocalCodexTransportConfig({ CODEX_HOME: home })).toEqual({
        args: [],
        env: {},
        selfContainedAuth: false,
      });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
