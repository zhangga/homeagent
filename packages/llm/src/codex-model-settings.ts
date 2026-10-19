import { canonicalModelId, publicModelId } from "@homeagent/shared";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  CODEX_REASONING_EFFORTS,
  codexReasoningEffortsForModel,
  type CodexReasoningEffort,
} from "./providers.ts";

export interface CodexModelSettings {
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
}

// Same bounded read budget as the console authentication cache. Only the two
// model preferences cross into HomeAgent; no config file is passed to Codex.
const MAX_CONFIG_BYTES = 1024 * 1024;

/** Read current user defaults, independently of HomeAgent's isolated CODEX_HOME. */
export function readLocalCodexModelSettings(
  environment: NodeJS.ProcessEnv = process.env,
  userHome = homedir(),
): CodexModelSettings {
  const home = resolve(environment.CODEX_HOME?.trim() || join(userHome, ".codex"));
  const path = join(home, "config.toml");
  try {
    const directory = lstatSync(home);
    const file = lstatSync(path);
    const samePath = (left: string, right: string) => process.platform === "win32"
      ? left.toLowerCase() === right.toLowerCase()
      : left === right;
    if (!directory.isDirectory() || directory.isSymbolicLink()
      || !file.isFile() || file.isSymbolicLink() || file.size > MAX_CONFIG_BYTES
      || !samePath(realpathSync(home), home) || !samePath(realpathSync(path), path)) return {};
    const text = readFileSync(path, "utf8");
    if (Buffer.byteLength(text, "utf8") > MAX_CONFIG_BYTES) return {};
    const parsed: unknown = Bun.TOML.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const model = "model" in parsed ? publicModelId(parsed.model) : undefined;
    const rawEffort = "model_reasoning_effort" in parsed ? parsed.model_reasoning_effort : undefined;
    const reasoningEffort = CODEX_REASONING_EFFORTS.find(effort => effort === rawEffort);
    return {
      ...(model ? { model: canonicalModelId(model) } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
    };
  } catch {
    // Missing, unreadable or invalid personal config preserves CLI defaults.
    // Parse errors may contain credentials from unrelated settings: never log them.
    return {};
  }
}

/** Resolve before creating a Run/client; frozen plans must never reread local settings. */
export function resolveCodexModelSettings(
  explicit: CodexModelSettings,
  local = readLocalCodexModelSettings(),
): CodexModelSettings {
  const model = canonicalModelId(explicit.model || local.model || "") || undefined;
  const effort = explicit.reasoningEffort ?? local.reasoningEffort;
  const supported = codexReasoningEffortsForModel(model);
  return {
    model,
    // New model ids can be inherited before HomeAgent's curated catalog updates.
    reasoningEffort: effort && (supported.length === 0 || supported.includes(effort))
      ? effort
      : undefined,
  };
}
