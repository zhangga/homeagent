import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { brandedEnv } from "@homeagent/shared";
import {
  configuredRuntimeDataDir,
  runtimeDataSettingsPath,
} from "./runtime-data.ts";

export interface RuntimePaths {
  bundled: boolean;
  appRoot: string;
  resourceDir: string;
  brandAssetDir: string;
  dataDir: string;
  logDir: string;
  larkBin: string;
  attachmentHelper?: string;
}

export function resolveRuntimePaths(input: {
  execPath?: string;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  repoRoot?: string;
  platform?: NodeJS.Platform;
} = {}): RuntimePaths {
  const execPath = input.execPath ?? process.execPath;
  const home = input.homeDir ?? homedir();
  const env = input.env ?? process.env;
  const explicitAppRoot = brandedEnv(env, "BUNDLED_APP_ROOT")?.trim();
  const marker = ".app/Contents/MacOS/";
  const markerAt = execPath.indexOf(marker);
  const bundled = Boolean(explicitAppRoot) || markerAt >= 0;
  const appRoot = bundled
    ? resolve(explicitAppRoot || execPath.slice(0, markerAt + 4))
    : resolve(input.repoRoot ?? join(import.meta.dir, "../../.."));
  const resourceDir = bundled
    ? join(appRoot, "Contents", "Resources")
    : join(appRoot, "packages", "orchestrator", "src");
  const brandAssetDir = bundled
    ? join(resourceDir, "brand")
    : join(appRoot, "assets", "brand");
  const settingsPath = runtimeDataSettingsPath({
    bundled,
    appRoot,
    homeDir: home,
    platform: input.platform ?? process.platform,
    env,
  });
  const configuredDataDir = configuredRuntimeDataDir(settingsPath);
  const environmentDataDir = brandedEnv(env, "DATA_DIR");
  const managedService = env.HOMEAGENT_SERVICE_MANAGED === "1";
  const dataDir = resolve(
    (managedService ? configuredDataDir ?? environmentDataDir : environmentDataDir ?? configuredDataDir) ??
      (bundled
        ? join(home, "Library", "Application Support", "HomeAgent")
        : join(appRoot, "data")),
  );
  const logDir = resolve(
    brandedEnv(env, "LOG_DIR")
      ?? (bundled ? join(home, "Library", "Logs", "HomeAgent") : join(dataDir, "logs")),
  );

  return {
    bundled,
    appRoot,
    resourceDir,
    brandAssetDir,
    dataDir,
    logDir,
    larkBin:
      brandedEnv(env, "LARK_BIN") ??
      (bundled
        ? join(resourceDir, "bin", "lark-cli")
        : (input.platform ?? process.platform) === "win32"
          ? "lark-cli.cmd"
          : "lark-cli"),
    attachmentHelper: bundled
      ? join(resourceDir, "bin", "attachment-extract")
      : undefined,
  };
}

export const HOMEAGENT_FEISHU_AVATAR_FILENAME =
  "homeagent-feishu-avatar-512.png";

export function homeAgentFeishuAvatarPath(
  paths: Pick<RuntimePaths, "brandAssetDir">,
): string {
  return join(paths.brandAssetDir, HOMEAGENT_FEISHU_AVATAR_FILENAME);
}
