import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  homeAgentFeishuAvatarPath,
  resolveRuntimePaths,
} from "./runtime-paths.ts";

describe("resolveRuntimePaths", () => {
  test("resolves mutable data and bundled executables outside the repository", () => {
    const home = "/Users/example";
    const appRoot = resolve("/Applications/HomeAgent.app");
    const resourceDir = join(appRoot, "Contents", "Resources");
    const paths = resolveRuntimePaths({
      execPath: "/Applications/HomeAgent.app/Contents/MacOS/homeagent",
      homeDir: home,
      env: {},
    });

    expect(paths).toEqual({
      bundled: true,
      appRoot,
      resourceDir,
      brandAssetDir: join(resourceDir, "brand"),
      dataDir: resolve(home, "Library", "Application Support", "HomeAgent"),
      logDir: resolve(home, "Library", "Logs", "HomeAgent"),
      larkBin: join(resourceDir, "bin", "lark-cli"),
      attachmentHelper: join(resourceDir, "bin", "attachment-extract"),
    });
  });

  test("recognizes the native launcher marker after it execs the bundled Bun runtime", () => {
    const paths = resolveRuntimePaths({
      execPath: "/Applications/HomeAgent.app/Contents/Resources/bin/bun",
      homeDir: "/Users/example",
      env: { HOMEAGENT_BUNDLED_APP_ROOT: "/Applications/HomeAgent.app" },
    });

    expect(paths.bundled).toBe(true);
    expect(paths.appRoot).toBe(resolve("/Applications/HomeAgent.app"));
    expect(paths.larkBin).toBe(join(paths.resourceDir, "bin", "lark-cli"));
  });

  test("keeps source mode repository-local while honoring executable and data overrides", () => {
    const repoRoot = resolve("/work/homeagent");
    const dataDir = resolve("/var/tmp/homeagent-data");
    const paths = resolveRuntimePaths({
      execPath: "/opt/bun/bin/bun",
      homeDir: "/Users/example",
      repoRoot,
      env: {
        HOMEAGENT_DATA_DIR: "/var/tmp/homeagent-data",
        HOMEAGENT_LARK_BIN: "/opt/lark/bin/lark-cli",
      },
    });

    expect(paths).toEqual({
      bundled: false,
      appRoot: repoRoot,
      resourceDir: join(repoRoot, "packages", "orchestrator", "src"),
      brandAssetDir: join(repoRoot, "assets", "brand"),
      dataDir,
      logDir: join(dataDir, "logs"),
      larkBin: "/opt/lark/bin/lark-cli",
      attachmentHelper: undefined,
    });
  });

  test("uses the npm command shim by default on Windows source runs", () => {
    const paths = resolveRuntimePaths({
      execPath: "C:\\tools\\bun.exe",
      homeDir: "C:\\Users\\example",
      repoRoot: "C:\\work\\homeagent",
      platform: "win32",
      env: {},
    });

    expect(paths.bundled).toBe(false);
    expect(paths.larkBin).toBe("lark-cli.cmd");
  });

  test("accepts pre-rename runtime overrides", () => {
    const paths = resolveRuntimePaths({
      execPath: "/opt/bun/bin/bun",
      homeDir: "/Users/example",
      repoRoot: "/work/homeagent",
      env: {
        HOMEBRAIN_DATA_DIR: "/var/tmp/legacy-data",
        HOMEBRAIN_LOG_DIR: "/var/tmp/legacy-logs",
        HOMEBRAIN_LARK_BIN: "/opt/legacy/lark-cli",
      },
    });

    expect(paths.dataDir).toBe(resolve("/var/tmp/legacy-data"));
    expect(paths.logDir).toBe(resolve("/var/tmp/legacy-logs"));
    expect(paths.larkBin).toBe("/opt/legacy/lark-cli");
  });

  test("forms the Feishu avatar path from the fixed repository-owned filename", () => {
    const repoRoot = resolve("/work/homeagent");
    const source = resolveRuntimePaths({
      execPath: "/opt/bun/bin/bun",
      repoRoot,
      env: {
        HOMEAGENT_BRAND_ASSET_DIR: "/tmp/request-controlled-assets",
      },
    });

    expect(source.brandAssetDir).toBe(join(repoRoot, "assets", "brand"));
    expect(homeAgentFeishuAvatarPath(source)).toBe(
      join(repoRoot, "assets", "brand", "homeagent-feishu-avatar-512.png"),
    );
  });

  test("uses the persisted pointer unless an external environment override is active", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "homeagent-runtime-paths-"));
    try {
      const configured = resolve(join(repoRoot, "external-data"));
      const overridden = resolve(join(repoRoot, "environment-data"));
      mkdirSync(join(repoRoot, ".homeagent"), { recursive: true });
      writeFileSync(join(repoRoot, ".homeagent", "runtime.json"), JSON.stringify({
        version: 1,
        dataDir: configured,
      }));

      expect(resolveRuntimePaths({ repoRoot, env: {} }).dataDir).toBe(configured);
      expect(resolveRuntimePaths({
        repoRoot,
        env: { HOMEAGENT_DATA_DIR: overridden },
      }).dataDir).toBe(overridden);
      expect(resolveRuntimePaths({
        repoRoot,
        env: {
          HOMEAGENT_DATA_DIR: overridden,
          HOMEAGENT_SERVICE_MANAGED: "1",
        },
      }).dataDir).toBe(configured);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
