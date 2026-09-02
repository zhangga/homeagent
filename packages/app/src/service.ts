import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import { dlopen, FFIType, ptr } from "bun:ffi";
import { brandedEnv } from "@homeagent/shared";

export const SERVICE_LABEL = "com.homeagent.agent";
export const LEGACY_SERVICE_LABEL = "com.homebrain.agent";
const SERVICE_LOG_NAMES = ["service.stdout.log", "service.stderr.log"] as const;

function shiftLogBackups(path: string): void {
  rmSync(`${path}.3`, { force: true });
  if (existsSync(`${path}.2`)) renameSync(`${path}.2`, `${path}.3`);
  if (existsSync(`${path}.1`)) renameSync(`${path}.1`, `${path}.2`);
  for (const backup of [`${path}.2`, `${path}.3`]) {
    if (existsSync(backup)) chmodSync(backup, 0o600);
  }
}

function readTailBytes(path: string, bytes: number): Buffer {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, size - length);
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

/** Bound launchd-owned active logs without replacing their open inode. */
export function rotateActiveServiceLogs(
  dataDir: string,
  maxBytes = 10 * 1024 * 1024,
  preserveBytes = 1024 * 1024,
  configuredLogDir?: string,
): void {
  const logDir = configuredLogDir ?? join(dataDir, "logs");
  mkdirSync(logDir, { recursive: true });
  for (const name of SERVICE_LOG_NAMES) {
    const path = join(logDir, name);
    writeFileSync(path, "", { encoding: "utf8", flag: "a", mode: 0o600 });
    if (statSync(path).size > maxBytes) {
      const tail = readTailBytes(path, preserveBytes);
      shiftLogBackups(path);
      writeFileSync(`${path}.1`, tail, { mode: 0o600 });
      chmodSync(`${path}.1`, 0o600);
      // launchd opens Standard*Path with append semantics, so subsequent writes
      // continue at the new end of this same inode after truncation.
      truncateSync(path, 0);
    }
    chmodSync(path, 0o600);
  }
}

export function startServiceLogMaintenance(
  dataDir: string,
  options: { managed?: boolean; maxBytes?: number; intervalMs?: number; logDir?: string } = {},
): () => void {
  const managed = options.managed ?? brandedEnv(process.env, "SERVICE_MANAGED") === "1";
  if (!managed) return () => {};
  const maintain = () => {
    try {
      rotateActiveServiceLogs(
        dataDir,
        options.maxBytes,
        undefined,
        options.logDir ?? brandedEnv(process.env, "LOG_DIR"),
      );
    } catch (err) {
      process.stderr.write(`homeagent log rotation failed: ${String(err)}\n`);
    }
  };
  maintain();
  const timer = setInterval(maintain, options.intervalMs ?? 60_000);
  timer.unref();
  return () => clearInterval(timer);
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type ServiceCommandRunner = (argv: string[]) => Promise<CommandResult>;

export interface LaunchAgentServiceOptions {
  platform: NodeJS.Platform;
  uid: number;
  homeDir: string;
  repoRoot: string;
  dataDir: string;
  logDir?: string;
  bunPath: string;
  bundled?: boolean;
  executablePath?: string;
  environment: NodeJS.ProcessEnv;
  runner?: ServiceCommandRunner;
  startupTimeoutMs?: number;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  logMaxBytes?: number;
  logPreserveBytes?: number;
}

export interface ServiceStatus {
  installed: boolean;
  loaded: boolean;
  running: boolean;
  label: string;
  state?: string;
  pid?: number;
  lastExitCode?: number;
  startedAt?: number;
  plistPath: string;
  stdoutPath: string;
  stderrPath: string;
}

export interface ProcessLockOptions {
  dataDir: string;
  pid?: number;
  startedAt?: number;
  isProcessAlive?: (pid: number) => boolean;
}

export interface ProcessLock {
  path: string;
  pid: number;
  startedAt: number;
  release: () => void;
}

export interface RuntimeServiceStatus {
  managed: boolean;
  pid: number;
  startedAt: number;
}

export function runtimeServiceStatus(options: {
  env?: NodeJS.ProcessEnv;
  pid?: number;
  startedAt?: number;
} = {}): RuntimeServiceStatus {
  return {
    managed: brandedEnv(options.env ?? process.env, "SERVICE_MANAGED") === "1",
    pid: options.pid ?? process.pid,
    startedAt: options.startedAt ?? Date.now() - Math.round(process.uptime() * 1000),
  };
}

const defaultRunner: ServiceCommandRunner = async (argv) => {
  const process = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { code, stdout, stderr };
};

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function plistString(key: string, value: string): string {
  return `  <key>${key}</key>\n  <string>${xml(value)}</string>`;
}

function parsedNumber(output: string, field: string): number | undefined {
  const value = output.match(new RegExp(`\\b${field}\\s*=\\s*(-?\\d+)`))?.[1];
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;
const WINDOWS_LOCKFILE_FAIL_IMMEDIATELY = 1;
const WINDOWS_LOCKFILE_EXCLUSIVE_LOCK = 2;
const WINDOWS_GENERIC_READ_WRITE = 0xc0000000;
const WINDOWS_SHARE_READ_WRITE_DELETE = 7;
const WINDOWS_OPEN_ALWAYS = 4;
const WINDOWS_FILE_ATTRIBUTE_NORMAL = 0x80;
const WINDOWS_LOCK_VIOLATION = 33;
const flockLibrary = process.platform === "darwin"
  ? dlopen("/usr/lib/libSystem.B.dylib", {
      flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    })
  : process.platform === "linux"
    ? dlopen("libc.so.6", {
        flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      })
    : undefined;
const windowsLockLibrary = process.platform === "win32"
  ? dlopen("kernel32.dll", {
      CreateFileW: {
        args: [
          FFIType.ptr,
          FFIType.u32,
          FFIType.u32,
          FFIType.ptr,
          FFIType.u32,
          FFIType.u32,
          FFIType.ptr,
        ],
        returns: FFIType.ptr,
      },
      LockFileEx: {
        args: [
          FFIType.ptr,
          FFIType.u32,
          FFIType.u32,
          FFIType.u32,
          FFIType.u32,
          FFIType.ptr,
        ],
        returns: FFIType.i32,
      },
      UnlockFileEx: {
        args: [
          FFIType.ptr,
          FFIType.u32,
          FFIType.u32,
          FFIType.u32,
          FFIType.ptr,
        ],
        returns: FFIType.i32,
      },
      CloseHandle: {
        args: [FFIType.ptr],
        returns: FFIType.i32,
      },
      GetLastError: {
        args: [],
        returns: FFIType.u32,
      },
    })
  : undefined;

function systemFlock(fd: number, operation: number): number {
  if (!flockLibrary) throw new Error(`single-process locking is unsupported on ${process.platform}`);
  return Number(flockLibrary.symbols.flock(fd, operation));
}

interface NativeProcessLock {
  release(): void;
}

function invalidWindowsHandle(handle: number | bigint | null): boolean {
  if (handle === null) return true;
  if (typeof handle === "bigint") {
    return handle === -1n || handle === 0xffffffffffffffffn;
  }
  return handle === -1 || !Number.isSafeInteger(handle);
}

function tryAcquireNativeProcessLock(
  fd: number,
  path: string,
): NativeProcessLock | undefined {
  if (windowsLockLibrary) {
    // Keep metadata readable while the lock is held. Windows byte-range locks
    // can block truncate/write even through another handle in this process, so
    // the kernel lock lives in a stable sidecar and the existing JSON remains
    // the human-readable owner record.
    const widePath = Buffer.from(`${path}.native\0`, "utf16le");
    const handle = windowsLockLibrary.symbols.CreateFileW(
      ptr(widePath),
      WINDOWS_GENERIC_READ_WRITE,
      WINDOWS_SHARE_READ_WRITE_DELETE,
      0,
      WINDOWS_OPEN_ALWAYS,
      WINDOWS_FILE_ATTRIBUTE_NORMAL,
      0,
    );
    if (invalidWindowsHandle(handle)) {
      const code = Number(windowsLockLibrary.symbols.GetLastError());
      throw new Error(`unable to open the single-process lock (${code})`);
    }
    const overlapped = new Uint8Array(32);
    const locked = Number(windowsLockLibrary.symbols.LockFileEx(
      handle,
      WINDOWS_LOCKFILE_FAIL_IMMEDIATELY | WINDOWS_LOCKFILE_EXCLUSIVE_LOCK,
      0,
      0xffffffff,
      0xffffffff,
      ptr(overlapped),
    ));
    if (locked === 0) {
      const code = Number(windowsLockLibrary.symbols.GetLastError());
      windowsLockLibrary.symbols.CloseHandle(handle);
      if (code === WINDOWS_LOCK_VIOLATION) return undefined;
      throw new Error(`unable to acquire the single-process lock (${code})`);
    }
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        try {
          windowsLockLibrary.symbols.UnlockFileEx(
            handle,
            0,
            0xffffffff,
            0xffffffff,
            ptr(overlapped),
          );
        } finally {
          windowsLockLibrary.symbols.CloseHandle(handle);
        }
      },
    };
  }
  if (!flockLibrary) {
    throw new Error(`single-process locking is unsupported on ${process.platform}`);
  }
  if (systemFlock(fd, LOCK_EX | LOCK_NB) !== 0) return undefined;
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      systemFlock(fd, LOCK_UN);
    },
  };
}

function syncLockMetadata(fd: number): void {
  try {
    fsyncSync(fd);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (
      process.platform === "win32"
      && (code === "EPERM" || code === "EINVAL")
    ) {
      return;
    }
    throw error;
  }
}

function openLockMetadata(path: string): number {
  try {
    return openSync(path, "r+");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    return openSync(path, "wx+", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return openSync(path, "r+");
  }
}

/** Acquire the single-process guard, replacing only a provably stale owner. */
export function acquireProcessLock(options: ProcessLockOptions): ProcessLock {
  const pid = options.pid ?? process.pid;
  const startedAt = options.startedAt ?? Date.now();
  const alive = options.isProcessAlive ?? defaultIsProcessAlive;
  const runDir = join(options.dataDir, "run");
  // Keep the pre-rename filename as a persisted coordination boundary. Using a
  // new lock name would let old and new binaries run against the same data.
  const path = join(runDir, "homebrain.lock");
  const cleanupPath = `${path}.cleanup`;
  mkdirSync(runDir, { recursive: true });
  const fd = openLockMetadata(path);
  let nativeLock: NativeProcessLock | undefined;
  try {
    nativeLock = tryAcquireNativeProcessLock(fd, path);
    if (!nativeLock) {
      let ownerPid: number | undefined;
      try {
        const owner = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown };
        if (typeof owner.pid === "number") ownerPid = owner.pid;
      } catch {
        // The kernel lock remains authoritative even if metadata is unreadable.
      }
      throw new Error(
        ownerPid ? `homeagent is already running (PID ${ownerPid})` : "homeagent is already running",
      );
    }

    // Before P3.2, the service used a PID-only lock. Refuse an actually live
    // legacy owner during an in-place upgrade; version 2 locks are governed by
    // the kernel and therefore cannot be confused by PID reuse.
    try {
      const previous = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown; pid?: unknown };
      if (
        previous.version !== 2
        && typeof previous.pid === "number"
        && previous.pid !== pid
        && alive(previous.pid)
      ) {
        throw new Error(`homeagent is already running (PID ${previous.pid})`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("homeagent is already running")) throw err;
      // Empty/corrupt stale metadata is safe to replace while holding flock.
    }

    rmSync(cleanupPath, { recursive: true, force: true });
    ftruncateSync(fd, 0);
    writeFileSync(fd, JSON.stringify({ version: 2, pid, startedAt }), "utf8");
    syncLockMetadata(fd);
    chmodSync(path, 0o600);
    let released = false;
    return {
      path,
      pid,
      startedAt,
      release: () => {
        if (released) return;
        released = true;
        try {
          nativeLock?.release();
        } finally {
          closeSync(fd);
        }
      },
    };
  } catch (err) {
    nativeLock?.release();
    closeSync(fd);
    throw err;
  }
}

/** Owns the on-disk LaunchAgent definition and launchctl lifecycle. */
export class LaunchAgentService {
  readonly plistPath: string;
  readonly legacyPlistPath: string;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  private readonly runner: ServiceCommandRunner;
  private readonly startupTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly logMaxBytes: number;
  private readonly logPreserveBytes: number;
  private readonly logDir: string;

  constructor(private readonly options: LaunchAgentServiceOptions) {
    this.plistPath = join(options.homeDir, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
    this.legacyPlistPath = join(
      options.homeDir,
      "Library",
      "LaunchAgents",
      `${LEGACY_SERVICE_LABEL}.plist`,
    );
    this.logDir = options.logDir ?? join(options.dataDir, "logs");
    this.stdoutPath = join(this.logDir, "service.stdout.log");
    this.stderrPath = join(this.logDir, "service.stderr.log");
    this.runner = options.runner ?? defaultRunner;
    this.startupTimeoutMs = options.startupTimeoutMs ?? 15_000;
    this.pollIntervalMs = Math.max(1, options.pollIntervalMs ?? 100);
    this.sleep = options.sleep ?? Bun.sleep;
    this.logMaxBytes = options.logMaxBytes ?? 10 * 1024 * 1024;
    this.logPreserveBytes = options.logPreserveBytes ?? 1024 * 1024;
  }

  private assertMacOS(): void {
    if (this.options.platform !== "darwin") {
      throw new Error("homeagent service currently supports macOS LaunchAgent only");
    }
  }

  private get domain(): string {
    return `gui/${this.options.uid}`;
  }

  private get target(): string {
    return `${this.domain}/${SERVICE_LABEL}`;
  }

  private get legacyTarget(): string {
    return `${this.domain}/${LEGACY_SERVICE_LABEL}`;
  }

  private plist(): string {
    const path = [...new Set([
      ...(this.options.environment.PATH ?? "").split(delimiter).filter(Boolean),
      join(this.options.homeDir, ".local", "bin"),
      join(this.options.homeDir, ".bun", "bin"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
    ])].join(delimiter);
    const main = join(this.options.repoRoot, "packages", "app", "src", "main.ts");
    const programArguments = this.options.bundled
      ? `    <string>${xml(this.options.executablePath ?? process.execPath)}</string>\n    <string>serve</string>`
      : `    <string>${xml(this.options.bunPath)}</string>\n    <string>run</string>\n    <string>${xml(main)}</string>`;
    const workingDirectory = this.options.bundled
      ? ""
      : `\n${plistString("WorkingDirectory", this.options.repoRoot)}`;
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${plistString("Label", SERVICE_LABEL)}
  <key>ProgramArguments</key>
  <array>
${programArguments}
  </array>
${workingDirectory}
  <key>EnvironmentVariables</key>
  <dict>
${plistString("HOME", this.options.homeDir)}
${plistString("PATH", path)}
${plistString("HOMEAGENT_DATA_DIR", this.options.dataDir)}
${plistString("HOMEAGENT_LOG_DIR", this.logDir)}
${plistString("HOMEAGENT_SERVICE_MANAGED", "1")}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
${plistString("ProcessType", "Background")}
${plistString("StandardOutPath", this.stdoutPath)}
${plistString("StandardErrorPath", this.stderrPath)}
</dict>
</plist>
`;
  }

  private async launchctl(...args: string[]): Promise<CommandResult> {
    return this.runner(["/bin/launchctl", ...args]);
  }

  private prepareLogs(): void {
    rotateActiveServiceLogs(this.options.dataDir, this.logMaxBytes, this.logPreserveBytes, this.logDir);
  }

  /** Prevent the pre-rename Feishu consumer from running beside HomeAgent. */
  async retireLegacyService(): Promise<void> {
    this.assertMacOS();
    if (!existsSync(this.legacyPlistPath)) return;
    const current = await this.launchctl("print", this.legacyTarget);
    if (current.code === 0) {
      const stopped = await this.launchctl("bootout", this.legacyTarget);
      if (stopped.code !== 0) {
        throw new Error(
          `legacy launchctl bootout failed: ${stopped.stderr.trim() || stopped.stdout.trim() || stopped.code}`,
        );
      }
    }
    rmSync(this.legacyPlistPath, { force: true });
  }

  private async waitForRunning(previousPid?: number, requireReplacement = false): Promise<ServiceStatus> {
    const attempts = Math.max(1, Math.ceil(this.startupTimeoutMs / this.pollIntervalMs) + 1);
    let latest: ServiceStatus | undefined;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      latest = await this.status();
      const replaced = !requireReplacement || previousPid === undefined || latest.pid !== previousPid;
      if (latest.running && replaced) return latest;
      if (attempt + 1 < attempts) await this.sleep(this.pollIntervalMs);
    }
    throw new Error(
      `homeagent service did not reach running state within ${this.startupTimeoutMs}ms`
      + (latest?.lastExitCode !== undefined ? ` (last exit ${latest.lastExitCode})` : ""),
    );
  }

  async install(): Promise<ServiceStatus> {
    this.assertMacOS();
    await this.retireLegacyService();
    const current = await this.status();
    if (current.loaded) {
      const stopped = await this.launchctl("bootout", this.target);
      if (stopped.code !== 0) {
        throw new Error(`launchctl bootout failed: ${stopped.stderr.trim() || stopped.stdout.trim() || stopped.code}`);
      }
    }
    mkdirSync(join(this.options.homeDir, "Library", "LaunchAgents"), { recursive: true });
    this.prepareLogs();
    const tempPath = `${this.plistPath}.tmp-${process.pid}`;
    writeFileSync(tempPath, this.plist(), { encoding: "utf8", mode: 0o600 });
    renameSync(tempPath, this.plistPath);
    chmodSync(this.plistPath, 0o600);

    const enabled = await this.launchctl("enable", this.target);
    if (enabled.code !== 0) {
      throw new Error(`launchctl enable failed: ${enabled.stderr.trim() || enabled.stdout.trim() || enabled.code}`);
    }
    const result = await this.launchctl("bootstrap", this.domain, this.plistPath);
    if (result.code !== 0) {
      throw new Error(`launchctl bootstrap failed: ${result.stderr.trim() || result.stdout.trim() || result.code}`);
    }
    return this.waitForRunning();
  }

  async start(): Promise<ServiceStatus> {
    this.assertMacOS();
    const current = await this.status();
    if (!current.installed) throw new Error("homeagent service is not installed; run `bun run service install`");
    if (current.running) return current;
    const result = current.loaded
      ? await this.launchctl("kickstart", this.target)
      : await this.launchctl("bootstrap", this.domain, this.plistPath);
    if (result.code !== 0) {
      throw new Error(`launchctl start failed: ${result.stderr.trim() || result.stdout.trim() || result.code}`);
    }
    return this.waitForRunning();
  }

  async stop(): Promise<ServiceStatus> {
    this.assertMacOS();
    const current = await this.status();
    if (current.loaded) {
      const result = await this.launchctl("bootout", this.target);
      if (result.code !== 0) {
        throw new Error(`launchctl stop failed: ${result.stderr.trim() || result.stdout.trim() || result.code}`);
      }
    }
    return this.status();
  }

  async restart(): Promise<ServiceStatus> {
    this.assertMacOS();
    const current = await this.status();
    if (!current.installed) throw new Error("homeagent service is not installed; run `bun run service install`");
    if (!current.loaded || !current.running) return this.start();
    const result = await this.launchctl("kill", "SIGTERM", this.target);
    if (result.code !== 0) {
      throw new Error(`launchctl restart failed: ${result.stderr.trim() || result.stdout.trim() || result.code}`);
    }
    return this.waitForRunning(current.pid, true);
  }

  async status(): Promise<ServiceStatus> {
    this.assertMacOS();
    const installed = existsSync(this.plistPath);
    const result = await this.launchctl("print", this.target);
    const loaded = result.code === 0;
    const state = loaded ? result.stdout.match(/\bstate\s*=\s*([^\n]+)/)?.[1]?.trim() : undefined;
    const pid = loaded ? parsedNumber(result.stdout, "pid") : undefined;
    const lastExitCode = loaded ? parsedNumber(result.stdout, "last exit code") : undefined;
    const lockPath = join(this.options.dataDir, "run", "homebrain.lock");
    let startedAt: number | undefined;
    if (existsSync(lockPath)) {
      try {
        const lock = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: unknown; startedAt?: unknown };
        if (lock.pid === pid && typeof lock.startedAt === "number") startedAt = lock.startedAt;
      } catch {
        // A malformed lock is reported by the process guard on its next start.
      }
    }
    return {
      installed,
      loaded,
      running: loaded && (state === "running" || pid !== undefined),
      label: SERVICE_LABEL,
      state,
      pid,
      lastExitCode,
      startedAt,
      plistPath: this.plistPath,
      stdoutPath: this.stdoutPath,
      stderrPath: this.stderrPath,
    };
  }

  readLogs(lines = 100): { stdout: string; stderr: string } {
    const tail = (path: string): string => {
      if (!existsSync(path)) return "";
      const fd = openSync(path, "r");
      try {
        const size = fstatSync(fd).size;
        const maxRead = Math.min(size, 1024 * 1024);
        const buffer = Buffer.alloc(maxRead);
        const bytesRead = readSync(fd, buffer, 0, maxRead, size - maxRead);
        const rows = buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/);
        if (size > maxRead && rows.length > 1) rows.shift(); // discard a possibly partial first line
        if (rows.at(-1) === "") rows.pop();
        return rows.slice(-lines).join("\n");
      } finally {
        closeSync(fd);
      }
    };
    return { stdout: tail(this.stdoutPath), stderr: tail(this.stderrPath) };
  }

  async followLogs(lines = 100): Promise<void> {
    mkdirSync(this.logDir, { recursive: true });
    for (const path of [this.stdoutPath, this.stderrPath]) {
      writeFileSync(path, "", { encoding: "utf8", flag: "a", mode: 0o600 });
      chmodSync(path, 0o600);
    }
    const tail = Bun.spawn(
      ["/usr/bin/tail", "-n", String(lines), "-F", this.stdoutPath, this.stderrPath],
      { stdin: "inherit", stdout: "inherit", stderr: "inherit" },
    );
    await tail.exited;
  }

  async uninstall(): Promise<ServiceStatus> {
    this.assertMacOS();
    const current = await this.status();
    if (current.loaded) {
      const result = await this.launchctl("bootout", this.target);
      if (result.code !== 0) {
        throw new Error(`launchctl uninstall failed: ${result.stderr.trim() || result.stdout.trim() || result.code}`);
      }
    }
    rmSync(this.plistPath, { force: true });
    return this.status();
  }
}
