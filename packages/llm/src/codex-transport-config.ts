import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/**
 * Transport-only slice of the user's ambient `~/.codex/config.toml`.
 *
 * Only active model-provider routing (`model_provider`, its matching
 * `[model_providers.<id>]` entry, `openai_base_url`, and `model_catalog_json`)
 * crosses into HomeAgent's isolated Codex launches. Ambient rules, hooks,
 * notify commands, plugins, Skills, MCP servers, and sessions remain excluded.
 * Secret values travel only via child process env and are never placed in argv.
 */
export interface CodexTransportConfig {
  /** Codex `-c key=value` overrides (never contains credential values). */
  args: string[];
  /** Extra env vars for the Codex host process only (never model shell tools). */
  env: Record<string, string>;
  /** True when a custom provider is configured with self-contained non-OpenAI auth. */
  selfContainedAuth: boolean;
}

const EMPTY_CONFIG: CodexTransportConfig = {
  args: [],
  env: {},
  selfContainedAuth: false,
};

const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_MODEL_CATALOG_BYTES = 16 * 1024 * 1024;
const MAX_MAP_ENTRIES = 32;
const MAX_AUTH_ARGS = 32;
const PROVIDER_ID_RE = /^[A-Za-z0-9_-]{1,128}$/u;
const WIRE_API_RE = /^[A-Za-z0-9_-]{1,64}$/u;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const HTTP_HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,128}$/u;
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/u;
const SENSITIVE_HEADER_RE = /(?:authorization|auth|api[-_]?key|token|secret|cookie|password)/iu;
const SENSITIVE_QUERY_PARAM_RE = /(?:^|[_-])(?:key|api[_-]?key|token|secret|auth|password)$/iu;

const FORBIDDEN_ENV_NAMES = new Set([
  "PATH",
  "PATHEXT",
  "COMSPEC",
  "SYSTEMROOT",
  "WINDIR",
  "SYSTEMDRIVE",
  "USERNAME",
  "USERDOMAIN",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "HOME",
  "SHELL",
  "USER",
  "LOGNAME",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "PROGRAMDATA",
  "LOCALAPPDATA",
  "APPDATA",
  "TEMP",
  "TMP",
  "TMPDIR",
  "POWERSHELL",
  "PWSH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NO_COLOR",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "LARKSUITE_CLI_PROFILE",
  "NODE_OPTIONS",
  "NODE_EXTRA_CA_CERTS",
  "BUN_OPTIONS",
]);

const FORBIDDEN_ENV_PREFIXES = [
  "LD_",
  "DYLD_",
  "HOMEAGENT_",
  "HOMEBRAIN_",
  "PYTHON",
  "BASH_FUNC_",
] as const;

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedCleanString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength || CONTROL_CHAR_RE.test(trimmed)) return undefined;
  return trimmed;
}

function validHttpUrl(value: unknown): string | undefined {
  const text = boundedCleanString(value, 2048);
  if (!text) return undefined;
  try {
    const parsed = new URL(text);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    if (parsed.username || parsed.password) return undefined;
    return text;
  } catch {
    return undefined;
  }
}

function allowedEnvName(value: unknown): string | undefined {
  if (typeof value !== "string" || !ENV_NAME_RE.test(value)) return undefined;
  const upper = value.toUpperCase();
  if (FORBIDDEN_ENV_NAMES.has(upper)) return undefined;
  if (FORBIDDEN_ENV_PREFIXES.some(prefix => upper.startsWith(prefix))) return undefined;
  return value;
}

function lookupEnvValue(source: NodeJS.ProcessEnv, name: string): string | undefined {
  const direct = source[name];
  if (typeof direct === "string" && direct.length > 0) return direct;
  if (process.platform === "win32") {
    const target = name.toUpperCase();
    for (const [key, value] of Object.entries(source)) {
      if (key.toUpperCase() === target && typeof value === "string" && value.length > 0) {
        return value;
      }
    }
  }
  return undefined;
}

function nonNegativeInt(value: unknown, max: number): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max
    ? value
    : undefined;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlInlineStringTable(entries: Record<string, string>): string {
  return `{${Object.entries(entries).map(([k, v]) => `${tomlString(k)}=${tomlString(v)}`).join(",")}}`;
}

function resolveValidCatalogPath(raw: unknown, ambientHome: string): string | undefined {
  const text = boundedCleanString(raw, 4096);
  if (!text) return undefined;
  const candidate = isAbsolute(text) ? resolve(text) : resolve(ambientHome, text);
  try {
    const meta = lstatSync(candidate);
    if (!meta.isFile() || meta.isSymbolicLink() || meta.size <= 0 || meta.size > MAX_MODEL_CATALOG_BYTES) {
      return undefined;
    }
    const canonical = realpathSync(candidate);
    if (!samePath(canonical, candidate)) return undefined;
    return canonical;
  } catch {
    return undefined;
  }
}

/** Resolve the user's ambient Codex home directory (independent of HomeAgent's isolated CODEX_HOME). */
export function ambientCodexHome(
  source: NodeJS.ProcessEnv = process.env,
  userHome = homedir(),
): string {
  return resolve(source.CODEX_HOME?.trim() || join(userHome, ".codex"));
}

/** Read only active model-provider transport settings from the user's ambient `~/.codex/config.toml`. */
export function readLocalCodexTransportConfig(
  source: NodeJS.ProcessEnv = process.env,
  userHome = homedir(),
): CodexTransportConfig {
  const home = ambientCodexHome(source, userHome);
  const path = join(home, "config.toml");
  let parsed: Record<string, unknown>;
  try {
    const directory = lstatSync(home);
    const file = lstatSync(path);
    if (
      !directory.isDirectory()
      || directory.isSymbolicLink()
      || !file.isFile()
      || file.isSymbolicLink()
      || file.size > MAX_CONFIG_BYTES
      || !samePath(realpathSync(home), home)
      || !samePath(realpathSync(path), path)
    ) {
      return { ...EMPTY_CONFIG, args: [], env: {} };
    }
    const text = readFileSync(path, "utf8");
    if (Buffer.byteLength(text, "utf8") > MAX_CONFIG_BYTES) {
      return { ...EMPTY_CONFIG, args: [], env: {} };
    }
    const raw: unknown = Bun.TOML.parse(text);
    if (!isPlainObject(raw)) return { ...EMPTY_CONFIG, args: [], env: {} };
    parsed = raw;
  } catch {
    // Missing, unreadable, or invalid personal config falls back cleanly.
    // Never log parse errors: personal config may contain credentials.
    return { ...EMPTY_CONFIG, args: [], env: {} };
  }

  const args: string[] = [];
  const env: Record<string, string> = {};
  let selfContainedAuth = false;

  const openaiBaseUrl = validHttpUrl(parsed.openai_base_url);
  if (openaiBaseUrl) {
    args.push("-c", `openai_base_url=${tomlString(openaiBaseUrl)}`);
  }

  const catalogPath = resolveValidCatalogPath(parsed.model_catalog_json, home);
  if (catalogPath) {
    args.push("-c", `model_catalog_json=${tomlString(catalogPath)}`);
  }

  const modelProvider = typeof parsed.model_provider === "string" && PROVIDER_ID_RE.test(parsed.model_provider)
    ? parsed.model_provider
    : undefined;
  const providersMap = isPlainObject(parsed.model_providers) ? parsed.model_providers : undefined;
  const providerTable = modelProvider && providersMap && Object.hasOwn(providersMap, modelProvider)
    ? providersMap[modelProvider]
    : undefined;

  if (modelProvider && isPlainObject(providerTable)) {
    const tableFields: string[] = [];
    let hasCredentialSource = false;

    const name = boundedCleanString(providerTable.name, 200);
    if (name) tableFields.push(`name=${tomlString(name)}`);

    const baseUrl = validHttpUrl(providerTable.base_url);
    if (baseUrl) tableFields.push(`base_url=${tomlString(baseUrl)}`);

    const wireApi = typeof providerTable.wire_api === "string" && WIRE_API_RE.test(providerTable.wire_api)
      ? providerTable.wire_api
      : undefined;
    if (wireApi) tableFields.push(`wire_api=${tomlString(wireApi)}`);

    // Never place inline bearer tokens in argv; route them through a synthetic env_key instead.
    const bearerToken = boundedCleanString(providerTable.experimental_bearer_token, 4096);
    if (bearerToken) {
      const syntheticKey = "HOMEAGENT_CODEX_PROVIDER_BEARER_TOKEN";
      tableFields.push(`env_key=${tomlString(syntheticKey)}`);
      env[syntheticKey] = bearerToken;
      hasCredentialSource = true;
    } else {
      const envKey = allowedEnvName(providerTable.env_key);
      if (envKey) {
        tableFields.push(`env_key=${tomlString(envKey)}`);
        const value = lookupEnvValue(source, envKey);
        if (value !== undefined) {
          env[envKey] = value;
          hasCredentialSource = true;
        }
      }
    }

    const safeHeaders: Record<string, string> = {};
    const envHeaders: Record<string, string> = {};
    if (isPlainObject(providerTable.env_http_headers)) {
      let count = 0;
      for (const [header, rawEnvName] of Object.entries(providerTable.env_http_headers)) {
        if (count >= MAX_MAP_ENTRIES) break;
        if (!HTTP_HEADER_NAME_RE.test(header)) continue;
        const envName = allowedEnvName(rawEnvName);
        if (!envName) continue;
        envHeaders[header] = envName;
        count += 1;
        const value = lookupEnvValue(source, envName);
        if (value !== undefined) {
          env[envName] = value;
          hasCredentialSource = true;
        }
      }
    }
    if (isPlainObject(providerTable.http_headers)) {
      let safeCount = 0;
      let syntheticIndex = 0;
      for (const [header, rawValue] of Object.entries(providerTable.http_headers)) {
        if (safeCount + syntheticIndex >= MAX_MAP_ENTRIES) break;
        if (!HTTP_HEADER_NAME_RE.test(header)) continue;
        const value = boundedCleanString(rawValue, 4096);
        if (!value) continue;
        if (SENSITIVE_HEADER_RE.test(header)) {
          if (Object.hasOwn(envHeaders, header)) continue;
          const syntheticKey = `HOMEAGENT_CODEX_HEADER_${syntheticIndex}`;
          syntheticIndex += 1;
          envHeaders[header] = syntheticKey;
          env[syntheticKey] = value;
          hasCredentialSource = true;
        } else {
          safeHeaders[header] = value;
          safeCount += 1;
        }
      }
    }
    if (Object.keys(safeHeaders).length > 0) {
      tableFields.push(`http_headers=${tomlInlineStringTable(safeHeaders)}`);
    }
    if (Object.keys(envHeaders).length > 0) {
      tableFields.push(`env_http_headers=${tomlInlineStringTable(envHeaders)}`);
    }

    if (isPlainObject(providerTable.query_params)) {
      const safeParams: Record<string, string> = {};
      let count = 0;
      for (const [param, rawValue] of Object.entries(providerTable.query_params)) {
        if (count >= MAX_MAP_ENTRIES) break;
        if (!boundedCleanString(param, 128) || SENSITIVE_QUERY_PARAM_RE.test(param)) continue;
        const value = boundedCleanString(rawValue, 1024);
        if (!value) continue;
        safeParams[param] = value;
        count += 1;
      }
      if (Object.keys(safeParams).length > 0) {
        tableFields.push(`query_params=${tomlInlineStringTable(safeParams)}`);
      }
    }

    if (typeof providerTable.requires_openai_auth === "boolean") {
      tableFields.push(`requires_openai_auth=${providerTable.requires_openai_auth}`);
    }
    if (typeof providerTable.supports_websockets === "boolean") {
      tableFields.push(`supports_websockets=${providerTable.supports_websockets}`);
    }
    const requestMaxRetries = nonNegativeInt(providerTable.request_max_retries, 100);
    if (requestMaxRetries !== undefined) {
      tableFields.push(`request_max_retries=${requestMaxRetries}`);
    }
    const streamMaxRetries = nonNegativeInt(providerTable.stream_max_retries, 100);
    if (streamMaxRetries !== undefined) {
      tableFields.push(`stream_max_retries=${streamMaxRetries}`);
    }
    const streamIdleTimeoutMs = nonNegativeInt(providerTable.stream_idle_timeout_ms, 3_600_000);
    if (streamIdleTimeoutMs !== undefined) {
      tableFields.push(`stream_idle_timeout_ms=${streamIdleTimeoutMs}`);
    }
    const wsTimeoutMs = nonNegativeInt(providerTable.websocket_connect_timeout_ms, 3_600_000);
    if (wsTimeoutMs !== undefined) {
      tableFields.push(`websocket_connect_timeout_ms=${wsTimeoutMs}`);
    }

    if (isPlainObject(providerTable.auth)) {
      const command = boundedCleanString(providerTable.auth.command, 1024);
      if (command) {
        const authFields: string[] = [`command=${tomlString(command)}`];
        if (Array.isArray(providerTable.auth.args)) {
          const authArgs: string[] = [];
          for (const rawArg of providerTable.auth.args.slice(0, MAX_AUTH_ARGS)) {
            const arg = boundedCleanString(rawArg, 1024);
            if (arg !== undefined) authArgs.push(tomlString(arg));
          }
          authFields.push(`args=[${authArgs.join(",")}]`);
        }
        const authTimeout = nonNegativeInt(providerTable.auth.timeout_ms, 600_000);
        if (authTimeout !== undefined) authFields.push(`timeout_ms=${authTimeout}`);
        const refreshInterval = nonNegativeInt(providerTable.auth.refresh_interval_ms, 86_400_000);
        if (refreshInterval !== undefined) authFields.push(`refresh_interval_ms=${refreshInterval}`);
        tableFields.push(`auth={${authFields.join(",")}}`);
        hasCredentialSource = true;
      }
    }

    if (tableFields.length > 0) {
      args.push("-c", `model_provider=${tomlString(modelProvider)}`);
      args.push("-c", `model_providers.${modelProvider}={${tableFields.join(",")}}`);
      selfContainedAuth =
        modelProvider !== "openai"
        && providerTable.requires_openai_auth !== true
        && hasCredentialSource;
    }
  } else if (modelProvider && modelProvider !== "openai") {
    args.push("-c", `model_provider=${tomlString(modelProvider)}`);
  }

  return { args, env, selfContainedAuth };
}
