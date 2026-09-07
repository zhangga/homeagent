import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  confirmDataMigration,
  dataMigrationBackupPath,
  planDataMigration,
  type MigrationDirectoryEntry,
} from "./data-migration.ts";
import { ensureDataRepositoryAgentGuides } from "@homeagent/core";

const RUNTIME_SETTINGS_VERSION = 1 as const;

export interface PendingDataDirectoryMigration {
  source: string;
  destination: string;
  initializeGit: boolean;
  requestedAt: number;
}

export interface CompletedDataDirectoryMigration {
  source: string;
  destination: string;
  initializeGit: boolean;
  completedAt: number;
}

export interface RuntimeDataSettings {
  version: typeof RUNTIME_SETTINGS_VERSION;
  dataDir?: string;
  pendingMigration?: PendingDataDirectoryMigration;
  lastMigration?: CompletedDataDirectoryMigration;
  migrationError?: string;
}

export interface RuntimeSettingsPathOptions {
  bundled: boolean;
  appRoot: string;
  homeDir?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

export interface ScheduleDataDirectoryMigrationOptions {
  settingsPath: string;
  currentDataDir: string;
  destinationDir: string;
  initializeGit?: boolean;
  now?: () => number;
}

export type ApplyPendingDataDirectoryMigrationResult =
  | { state: "not-needed" }
  | { state: "completed"; source: string; destination: string; gitInitialized: boolean }
  | { state: "failed"; source: string; destination: string; error: string };

export const DATA_GITIGNORE = `# HomeAgent runtime-only and rebuildable files
/run/
/logs/
/bin/
/provider-state/
**/.index.db
**/.index.db-shm
**/.index.db-wal
**/*.tmp-*
/migration-v*.json
`;

const FIRST_RUN_IGNORED_ROOT_ENTRIES = new Set([
  ".DS_Store",
  ".git",
  ".gitattributes",
  ".gitignore",
  ".obsidian",
  "AGENTS.md",
  "bin",
  "logs",
  "run",
]);

/**
 * launchd prepares log files before the app starts, so mere directory
 * existence cannot distinguish a fresh install from an initialized data root.
 */
export function dataDirectoryWasUninitialized(directory: string): boolean {
  if (!existsSync(directory)) return true;
  try {
    if (!statSync(directory).isDirectory()) return false;
    return readdirSync(directory).every((entry) => FIRST_RUN_IGNORED_ROOT_ENTRIES.has(entry));
  } catch {
    // Fail closed: an unreadable directory must not be treated as a fresh one.
    return false;
  }
}

/** Root metadata that can be safely preserved when adopting an existing repository. */
export function isSupportedDestinationMetadata(entry: MigrationDirectoryEntry): boolean {
  switch (entry.name) {
    case ".git":
      return entry.kind === "directory";
    case ".obsidian":
      return entry.kind === "directory";
    case ".gitignore":
    case ".gitattributes":
    case ".DS_Store":
    case "AGENTS.md":
      return entry.kind === "file";
    default:
      return false;
  }
}

/**
 * The pointer must live outside the movable data tree. Source checkouts keep it
 * repo-local; packaged installs keep it in the user's platform config area.
 */
export function runtimeDataSettingsPath(options: RuntimeSettingsPathOptions): string {
  const env = options.env ?? process.env;
  const explicit = env.HOMEAGENT_RUNTIME_CONFIG?.trim();
  if (explicit) return resolve(expandHome(explicit, options.homeDir ?? homedir()));
  if (!options.bundled) return join(resolve(options.appRoot), ".homeagent", "runtime.json");

  const home = options.homeDir ?? homedir();
  const platform = options.platform ?? process.platform;
  if (platform === "darwin") {
    return join(home, "Library", "Preferences", "HomeAgent", "runtime.json");
  }
  if (platform === "win32") {
    const appData = env.APPDATA?.trim() || join(home, "AppData", "Roaming");
    return join(appData, "HomeAgent", "runtime.json");
  }
  const configHome = env.XDG_CONFIG_HOME?.trim() || join(home, ".config");
  return join(configHome, "homeagent", "runtime.json");
}

export function readRuntimeDataSettings(path: string): RuntimeDataSettings {
  if (!existsSync(path)) return { version: RUNTIME_SETTINGS_VERSION };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (!raw || raw.version !== RUNTIME_SETTINGS_VERSION) {
      return { version: RUNTIME_SETTINGS_VERSION };
    }
    const settings: RuntimeDataSettings = { version: RUNTIME_SETTINGS_VERSION };
    if (typeof raw.dataDir === "string" && isAbsolute(raw.dataDir)) {
      settings.dataDir = resolve(raw.dataDir);
    }
    const pending = parsePending(raw.pendingMigration);
    if (pending) settings.pendingMigration = pending;
    const completed = parseCompleted(raw.lastMigration);
    if (completed) settings.lastMigration = completed;
    if (typeof raw.migrationError === "string" && raw.migrationError.trim()) {
      settings.migrationError = raw.migrationError;
    }
    return settings;
  } catch {
    return { version: RUNTIME_SETTINGS_VERSION };
  }
}

export function configuredRuntimeDataDir(settingsPath: string): string | undefined {
  const settings = readRuntimeDataSettings(settingsPath);
  return settings.pendingMigration?.source ?? settings.dataDir;
}

export function scheduleDataDirectoryMigration(
  options: ScheduleDataDirectoryMigrationOptions,
): PendingDataDirectoryMigration {
  const source = resolve(options.currentDataDir);
  const destinationInput = options.destinationDir.trim();
  if (!destinationInput) throw new Error("请输入新的数据目录");
  const expandedDestination = expandHome(destinationInput, homedir());
  if (!isAbsolute(expandedDestination)) throw new Error("数据目录必须是绝对路径");
  const destination = resolve(expandedDestination);

  const current = readRuntimeDataSettings(options.settingsPath);
  if (current.pendingMigration) throw new Error("已有待执行的数据迁移");
  const plan = planDataMigration({
    sourceDir: source,
    destinationDir: destination,
    allowDestinationEntry: isSupportedDestinationMetadata,
  });
  if (plan.state !== "needs-confirmation") throw new Error(migrationPlanMessage(plan.reason));
  assertWritableDestination(destination);

  const pending: PendingDataDirectoryMigration = {
    source,
    destination,
    initializeGit: options.initializeGit === true,
    requestedAt: (options.now ?? Date.now)(),
  };
  writeRuntimeDataSettings(options.settingsPath, {
    ...current,
    dataDir: source,
    pendingMigration: pending,
    migrationError: undefined,
  });
  return pending;
}

/** Execute a scheduled copy before any engine, scheduler, or process lock opens. */
export function applyPendingDataDirectoryMigration(input: {
  settingsPath: string;
  now?: () => number;
  gitRunner?: (directory: string) => { code: number; stderr?: string };
}): ApplyPendingDataDirectoryMigrationResult {
  const current = readRuntimeDataSettings(input.settingsPath);
  const pending = current.pendingMigration;
  if (!pending) return { state: "not-needed" };

  try {
    if (recoverInterruptedDestinationSwap(pending)) {
      return completePendingMigration(current, pending, input.settingsPath, input.now);
    }
    const destinationAlreadyGit = dataDirectoryIsGitRepository(pending.destination);
    confirmDataMigration({
      sourceDir: pending.source,
      destinationDir: pending.destination,
      now: input.now,
      allowDestinationEntry: isSupportedDestinationMetadata,
      prepareStaging: (staging) => {
        ensureDataRepositoryAgentGuides(staging);
        if (pending.initializeGit) {
          initializeGitRepository(staging, input.gitRunner);
        } else if (destinationAlreadyGit) {
          ensureDataGitIgnore(staging);
        }
      },
    });
    return completePendingMigration(current, pending, input.settingsPath, input.now);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeRuntimeDataSettings(input.settingsPath, {
      ...current,
      dataDir: pending.source,
      pendingMigration: undefined,
      migrationError: message,
    });
    return {
      state: "failed",
      source: pending.source,
      destination: pending.destination,
      error: message,
    };
  }
}

function completePendingMigration(
  current: RuntimeDataSettings,
  pending: PendingDataDirectoryMigration,
  settingsPath: string,
  now?: () => number,
): ApplyPendingDataDirectoryMigrationResult {
  const completedAt = (now ?? Date.now)();
  writeRuntimeDataSettings(settingsPath, {
    ...current,
    dataDir: pending.destination,
    pendingMigration: undefined,
    migrationError: undefined,
    lastMigration: {
      source: pending.source,
      destination: pending.destination,
      initializeGit: pending.initializeGit,
      completedAt,
    },
  });
  return {
    state: "completed",
    source: pending.source,
    destination: pending.destination,
    gitInitialized: pending.initializeGit,
  };
}

function recoverInterruptedDestinationSwap(pending: PendingDataDirectoryMigration): boolean {
  const backup = dataMigrationBackupPath(pending.destination);
  const destinationExists = existsSync(pending.destination);
  const backupExists = existsSync(backup);
  if (destinationExists && completedMigrationMatches(pending)) {
    if (backupExists) {
      try {
        rmSync(backup, { recursive: true, force: true });
      } catch {
        // The committed destination is authoritative; the backup may be removed manually.
      }
    }
    return true;
  }
  if (!destinationExists && backupExists) {
    renameSync(backup, pending.destination);
    return false;
  }
  if (destinationExists && backupExists) {
    throw new Error("检测到未完成的目标目录切换，请保留目录并检查 migration backup");
  }
  return false;
}

function completedMigrationMatches(pending: PendingDataDirectoryMigration): boolean {
  try {
    const record = JSON.parse(
      readFileSync(join(pending.destination, "migration-v2.json"), "utf8"),
    ) as Record<string, unknown>;
    return record.result === "completed"
      && typeof record.source === "string"
      && typeof record.destination === "string"
      && resolve(record.source) === pending.source
      && resolve(record.destination) === pending.destination;
  } catch {
    return false;
  }
}

export function gitIsAvailable(): boolean {
  return Bun.which("git") !== null;
}

export function dataDirectoryIsGitRepository(directory: string): boolean {
  try {
    const metadata = lstatSync(join(directory, ".git"));
    return !metadata.isSymbolicLink() && (metadata.isDirectory() || metadata.isFile());
  } catch {
    return false;
  }
}

function initializeGitRepository(
  directory: string,
  runner: (directory: string) => { code: number; stderr?: string } = defaultGitRunner,
): void {
  ensureDataGitIgnore(directory);
  const result = runner(directory);
  if (result.code !== 0) {
    throw new Error(`Git 初始化失败：${result.stderr?.trim() || `exit ${result.code}`}`);
  }
}

function defaultGitRunner(directory: string): { code: number; stderr: string } {
  const result = Bun.spawnSync(["git", "init", "--quiet"], {
    cwd: directory,
    stdout: "ignore",
    stderr: "pipe",
  });
  return {
    code: result.exitCode,
    stderr: result.stderr.toString("utf8"),
  };
}

export interface EnsureDataGitIgnoreOptions {
  /** Test seam after the durable temporary file is ready but before replacement. */
  beforeReplace?: (temporaryPath: string) => void;
}

function sameFilesystemPath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function canonicalDataDirectory(directory: string): string {
  const requested = resolve(directory);
  mkdirSync(requested, { recursive: true, mode: 0o700 });
  const metadata = lstatSync(requested);
  const canonical = realpathSync(requested);
  if (
    metadata.isSymbolicLink()
    || !metadata.isDirectory()
    || !sameFilesystemPath(requested, canonical)
  ) {
    throw new Error("HomeAgent data directory must be a canonical directory");
  }
  return canonical;
}

interface ValidatedGitIgnore {
  contents: string;
  identity: {
    dev: number;
    ino: number;
    size: number;
    mtimeMs: number;
    ctimeMs: number;
    mode: number;
  };
}

function validatedGitIgnore(path: string, directory: string): ValidatedGitIgnore | undefined {
  if (!existsSync(path)) return undefined;
  const before = lstatSync(path);
  const canonical = realpathSync(path);
  if (
    before.isSymbolicLink()
    || !before.isFile()
    || !sameFilesystemPath(dirname(canonical), directory)
    || !sameFilesystemPath(canonical, path)
  ) {
    throw new Error("HomeAgent data .gitignore must be a regular file");
  }
  const existing = readFileSync(path, "utf8");
  const after = lstatSync(path);
  if (
    after.isSymbolicLink()
    || !after.isFile()
    || before.dev !== after.dev
    || before.ino !== after.ino
    || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs
    || before.ctimeMs !== after.ctimeMs
    || before.mode !== after.mode
  ) {
    throw new Error("HomeAgent data .gitignore changed while it was being read");
  }
  return {
    contents: existing,
    identity: {
      dev: after.dev,
      ino: after.ino,
      size: after.size,
      mtimeMs: after.mtimeMs,
      ctimeMs: after.ctimeMs,
      mode: after.mode,
    },
  };
}

function sameGitIgnoreIdentity(
  left: ValidatedGitIgnore | undefined,
  right: ValidatedGitIgnore | undefined,
): boolean {
  if (!left || !right) return left === right;
  return left.identity.dev === right.identity.dev
    && left.identity.ino === right.identity.ino
    && left.identity.size === right.identity.size
    && left.identity.mtimeMs === right.identity.mtimeMs
    && left.identity.ctimeMs === right.identity.ctimeMs
    && left.identity.mode === right.identity.mode;
}

function syncDirectory(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(directory, "r");
    fsyncSync(descriptor);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform !== "win32" || !["EPERM", "EINVAL", "EBADF"].includes(code ?? "")) {
      throw error;
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function ensureDataGitIgnore(
  directory: string,
  options: EnsureDataGitIgnoreOptions = {},
): void {
  const canonicalDirectory = canonicalDataDirectory(directory);
  const path = join(canonicalDirectory, ".gitignore");
  const initial = validatedGitIgnore(path, canonicalDirectory);
  const existing = initial?.contents;
  const requiredLines = DATA_GITIGNORE.trimEnd().split("\n");
  const existingLines = new Set((existing ?? "").split(/\r?\n/u));
  const missingLines = requiredLines.filter((line) => !existingLines.has(line));
  if (existing !== undefined && missingLines.length === 0) return;
  const hasMarker = existingLines.has(requiredLines[0]!);
  const addition = existing === undefined
    ? DATA_GITIGNORE.trimEnd()
    : hasMarker
    ? missingLines.filter((line) => line !== requiredLines[0]).join("\n")
    : DATA_GITIGNORE.trimEnd();
  if (!addition) return;
  const contents = existing === undefined
    ? `${addition}\n`
    : `${existing.trimEnd()}\n\n${addition}\n`;
  const temporaryPath = join(
    canonicalDirectory,
    `.gitignore.tmp-${process.pid}-${randomUUID()}`,
  );
  let temporaryExists = false;
  try {
    writeFileSync(temporaryPath, contents, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    temporaryExists = true;
    chmodSync(temporaryPath, initial ? initial.identity.mode & 0o777 : 0o600);
    const descriptor = openSync(temporaryPath, "r+");
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    options.beforeReplace?.(temporaryPath);
    const current = validatedGitIgnore(path, canonicalDirectory);
    if (!sameGitIgnoreIdentity(initial, current)) {
      throw new Error("HomeAgent data .gitignore changed before replacement");
    }
    renameSync(temporaryPath, path);
    temporaryExists = false;
    syncDirectory(canonicalDirectory);
  } finally {
    if (temporaryExists) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // Preserve the primary write/replace failure during best-effort cleanup.
      }
    }
  }
}

/** Update runtime exclusions only for an existing, local Git data repository. */
export function ensureDataGitIgnoreForRepository(directory: string): void {
  if (dataDirectoryIsGitRepository(directory)) ensureDataGitIgnore(directory);
}

function writeRuntimeDataSettings(path: string, settings: RuntimeDataSettings): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows does not implement POSIX modes; the user profile ACL still applies.
  }
}

function assertWritableDestination(destination: string): void {
  let ancestor = destination;
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  if (!existsSync(ancestor) || !statSync(ancestor).isDirectory()) {
    throw new Error("新数据目录没有可用的上级目录");
  }
  try {
    accessSync(ancestor, constants.W_OK);
  } catch {
    throw new Error("新数据目录的上级目录不可写");
  }
}

function migrationPlanMessage(reason: ReturnType<typeof planDataMigration>["reason"]): string {
  switch (reason) {
    case "destination-not-empty":
      return "新数据目录必须不存在、为空，或仅包含支持的 Git、Obsidian、AGENTS.md 元数据";
    case "destination-conflict":
      return "当前数据与目标目录的 Git/Obsidian 元数据存在同名冲突";
    case "paths-overlap":
      return "新旧数据目录不能相同，也不能互相包含";
    case "source-invalid":
    case "legacy-source-missing":
      return "当前数据目录不存在或不是目录";
    default:
      return "无法检查新数据目录";
  }
}

function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(home, path.slice(2));
  return path;
}

function parsePending(value: unknown): PendingDataDirectoryMigration | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.source !== "string"
    || typeof raw.destination !== "string"
    || !isAbsolute(raw.source)
    || !isAbsolute(raw.destination)
    || typeof raw.requestedAt !== "number"
  ) return undefined;
  return {
    source: resolve(raw.source),
    destination: resolve(raw.destination),
    initializeGit: raw.initializeGit === true,
    requestedAt: raw.requestedAt,
  };
}

function parseCompleted(value: unknown): CompletedDataDirectoryMigration | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.source !== "string"
    || typeof raw.destination !== "string"
    || !isAbsolute(raw.source)
    || !isAbsolute(raw.destination)
    || typeof raw.completedAt !== "number"
  ) return undefined;
  return {
    source: resolve(raw.source),
    destination: resolve(raw.destination),
    initializeGit: raw.initializeGit === true,
    completedAt: raw.completedAt,
  };
}

export function pathsOverlap(first: string, second: string): boolean {
  return isWithin(first, second) || isWithin(second, first);
}

function isWithin(parent: string, candidate: string): boolean {
  const path = relative(resolve(parent), resolve(candidate));
  return path === ""
    || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}
