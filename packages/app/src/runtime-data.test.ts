import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dataMigrationBackupPath } from "./data-migration.ts";
import {
  applyPendingDataDirectoryMigration,
  DATA_GITIGNORE,
  dataDirectoryWasUninitialized,
  readRuntimeDataSettings,
  runtimeDataSettingsPath,
  scheduleDataDirectoryMigration,
} from "./runtime-data.ts";

describe("runtime data directory settings", () => {
  let root: string;
  let source: string;
  let destination: string;
  let settingsPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "homeagent-runtime-data-"));
    source = join(root, "source-data");
    destination = join(root, "external-data");
    settingsPath = join(root, "bootstrap", "runtime.json");
    mkdirSync(join(source, "workspaces", "personal"), { recursive: true });
    writeFileSync(join(source, "workspaces", "personal", "memory.md"), "可靠迁移", "utf8");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("uses a repo-local pointer for source runs and platform config for packaged runs", () => {
    expect(runtimeDataSettingsPath({
      bundled: false,
      appRoot: join(root, "checkout"),
      homeDir: join(root, "home"),
      platform: "win32",
      env: {},
    })).toBe(join(root, "checkout", ".homeagent", "runtime.json"));

    expect(runtimeDataSettingsPath({
      bundled: true,
      appRoot: join(root, "HomeAgent.app"),
      homeDir: join(root, "home"),
      platform: "darwin",
      env: {},
    })).toBe(join(root, "home", "Library", "Preferences", "HomeAgent", "runtime.json"));
  });

  test("recognizes missing and launchd-prepared roots as uninitialized", () => {
    const missing = join(root, "missing-data");
    expect(dataDirectoryWasUninitialized(missing)).toBeTrue();

    const runtimeOnly = join(root, "runtime-only");
    mkdirSync(join(runtimeOnly, "logs"), { recursive: true });
    mkdirSync(join(runtimeOnly, "run"), { recursive: true });
    writeFileSync(join(runtimeOnly, "logs", "service.stdout.log"), "", "utf8");
    writeFileSync(join(runtimeOnly, "AGENTS.md"), "# Local guide\n", "utf8");
    expect(dataDirectoryWasUninitialized(runtimeOnly)).toBeTrue();

    mkdirSync(join(runtimeOnly, "config"));
    expect(dataDirectoryWasUninitialized(runtimeOnly)).toBeFalse();
    expect(dataDirectoryWasUninitialized(source)).toBeFalse();
  });

  test("schedules an absolute empty destination without touching either data tree", () => {
    const pending = scheduleDataDirectoryMigration({
      settingsPath,
      currentDataDir: source,
      destinationDir: destination,
      initializeGit: true,
      now: () => 123,
    });

    expect(pending).toEqual({
      source,
      destination,
      initializeGit: true,
      requestedAt: 123,
    });
    expect(existsSync(destination)).toBeFalse();
    expect(readRuntimeDataSettings(settingsPath).pendingMigration).toEqual(pending);
    expect(readFileSync(join(source, "workspaces", "personal", "memory.md"), "utf8"))
      .toBe("可靠迁移");
  });

  test("rejects relative, overlapping, and non-empty destinations", () => {
    expect(() => scheduleDataDirectoryMigration({
      settingsPath,
      currentDataDir: source,
      destinationDir: "relative-data",
    })).toThrow("绝对路径");
    expect(() => scheduleDataDirectoryMigration({
      settingsPath,
      currentDataDir: source,
      destinationDir: join(source, "nested"),
    })).toThrow("不能相同");
    mkdirSync(destination);
    writeFileSync(join(destination, "occupied"), "x", "utf8");
    expect(() => scheduleDataDirectoryMigration({
      settingsPath,
      currentDataDir: source,
      destinationDir: destination,
    })).toThrow("仅包含支持的 Git、Obsidian、AGENTS.md 元数据");
  });

  test("adopts an existing Git and Obsidian directory while preserving its metadata", () => {
    mkdirSync(join(destination, ".git", "objects"), { recursive: true });
    mkdirSync(join(destination, ".obsidian"), { recursive: true });
    writeFileSync(join(destination, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");
    writeFileSync(join(destination, ".obsidian", "app.json"), "{}", "utf8");
    writeFileSync(join(destination, ".gitignore"), "private-notes/\n", "utf8");
    writeFileSync(join(destination, "AGENTS.md"), "# 自定义数据仓库规则\n", "utf8");

    scheduleDataDirectoryMigration({
      settingsPath,
      currentDataDir: source,
      destinationDir: destination,
    });
    const result = applyPendingDataDirectoryMigration({ settingsPath, now: () => 456 });

    expect(result).toMatchObject({ state: "completed", source, destination });
    expect(readFileSync(join(destination, ".git", "HEAD"), "utf8"))
      .toBe("ref: refs/heads/main\n");
    expect(readFileSync(join(destination, ".obsidian", "app.json"), "utf8")).toBe("{}");
    expect(readFileSync(join(destination, "AGENTS.md"), "utf8"))
      .toBe("# 自定义数据仓库规则\n");
    const gitignore = readFileSync(join(destination, ".gitignore"), "utf8");
    expect(gitignore).toStartWith("private-notes/\n");
    expect(gitignore).toContain(DATA_GITIGNORE);
    expect(readFileSync(join(destination, "workspaces", "personal", "memory.md"), "utf8"))
      .toBe("可靠迁移");
    expect(existsSync(dataMigrationBackupPath(destination))).toBeFalse();
  });

  test("rejects unsupported destination content and metadata name conflicts", () => {
    mkdirSync(destination);
    writeFileSync(join(destination, "README.md"), "existing notes", "utf8");
    expect(() => scheduleDataDirectoryMigration({
      settingsPath,
      currentDataDir: source,
      destinationDir: destination,
    })).toThrow("仅包含支持的 Git、Obsidian、AGENTS.md 元数据");

    rmSync(destination, { recursive: true, force: true });
    mkdirSync(join(destination, ".obsidian"), { recursive: true });
    mkdirSync(join(source, ".obsidian"), { recursive: true });
    expect(() => scheduleDataDirectoryMigration({
      settingsPath,
      currentDataDir: source,
      destinationDir: destination,
    })).toThrow("同名冲突");
  });

  test("restores a pre-switch metadata backup before retrying an interrupted migration", () => {
    mkdirSync(join(destination, ".git"), { recursive: true });
    writeFileSync(join(destination, ".git", "HEAD"), "preserved", "utf8");
    scheduleDataDirectoryMigration({
      settingsPath,
      currentDataDir: source,
      destinationDir: destination,
    });
    const backup = dataMigrationBackupPath(destination);
    renameSync(destination, backup);

    const result = applyPendingDataDirectoryMigration({ settingsPath, now: () => 789 });

    expect(result).toMatchObject({ state: "completed", destination });
    expect(readFileSync(join(destination, ".git", "HEAD"), "utf8")).toBe("preserved");
    expect(existsSync(backup)).toBeFalse();
  });

  test("copies on startup, initializes Git in staging, and switches the pointer", () => {
    scheduleDataDirectoryMigration({
      settingsPath,
      currentDataDir: source,
      destinationDir: destination,
      initializeGit: true,
      now: () => 123,
    });

    const result = applyPendingDataDirectoryMigration({
      settingsPath,
      now: () => 456,
      gitRunner: (directory) => {
        mkdirSync(join(directory, ".git"));
        return { code: 0 };
      },
    });

    expect(result).toEqual({
      state: "completed",
      source,
      destination,
      gitInitialized: true,
    });
    expect(readFileSync(join(destination, "workspaces", "personal", "memory.md"), "utf8"))
      .toBe("可靠迁移");
    expect(readFileSync(join(source, "workspaces", "personal", "memory.md"), "utf8"))
      .toBe("可靠迁移");
    expect(readFileSync(join(destination, ".gitignore"), "utf8")).toBe(DATA_GITIGNORE);
    expect(existsSync(join(destination, ".git"))).toBeTrue();
    expect(readRuntimeDataSettings(settingsPath)).toMatchObject({
      dataDir: destination,
      lastMigration: {
        source,
        destination,
        initializeGit: true,
        completedAt: 456,
      },
    });
    expect(readRuntimeDataSettings(settingsPath).pendingMigration).toBeUndefined();
  });

  test("migration seeds agent guides for the repository and verified Spaces", () => {
    const workspace = join(source, "workspaces", "team__oc_migrated");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, ".spaceid"), "team/oc_migrated", "utf8");

    scheduleDataDirectoryMigration({
      settingsPath,
      currentDataDir: source,
      destinationDir: destination,
    });
    expect(applyPendingDataDirectoryMigration({ settingsPath }).state).toBe("completed");

    expect(readFileSync(join(destination, "AGENTS.md"), "utf8")).toContain("默认只读");
    expect(readFileSync(
      join(destination, "workspaces", "team__oc_migrated", "AGENTS.md"),
      "utf8",
    )).toContain("当前 Space");
  });

  test("keeps the source selected and removes staging when Git initialization fails", () => {
    scheduleDataDirectoryMigration({
      settingsPath,
      currentDataDir: source,
      destinationDir: destination,
      initializeGit: true,
    });

    const result = applyPendingDataDirectoryMigration({
      settingsPath,
      gitRunner: () => ({ code: 1, stderr: "git unavailable" }),
    });

    expect(result).toMatchObject({ state: "failed", source, destination });
    expect(existsSync(destination)).toBeFalse();
    expect(readRuntimeDataSettings(settingsPath)).toMatchObject({
      dataDir: source,
      migrationError: "Git 初始化失败：git unavailable",
    });
    expect(readRuntimeDataSettings(settingsPath).pendingMigration).toBeUndefined();
  });
});
