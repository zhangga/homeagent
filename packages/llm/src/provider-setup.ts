import { brandedEnv } from "@homeagent/shared";
import { prepareProviderCodexHome, providerChildEnvironment } from "./providers.ts";

const CAPTURE_LIMIT_BYTES = 8 * 1024;
const LOGIN_DETAIL_WAIT_MS = 15_000;
const LOGIN_TTL_MS = 10 * 60_000;
const COMMAND_TIMEOUT_MS = 15_000;
const SANDBOX_SETUP_WAIT_MS = 15_000;
const SANDBOX_SETUP_TTL_MS = 10 * 60_000;
const APP_SERVER_CLIENT_VERSION = "0.1.0-beta.1";

const LOGIN_FAILED_MESSAGE = "ChatGPT 登录未完成，请重试";
const LOGIN_EXPIRED_MESSAGE = "ChatGPT 登录已过期，请重试";
const LOGIN_CANCELLED_MESSAGE = "已取消 ChatGPT 登录";
const LOGIN_READY_MESSAGE = "ChatGPT 已连接";
const SANDBOX_SETUP_FAILED_MESSAGE = "Windows 安全沙箱设置未完成，请重试";
const SANDBOX_SETUP_READY_MESSAGE = "Windows 安全沙箱设置已完成";

export type CodexLoginState =
  | "idle"
  | "starting"
  | "waiting_for_user"
  | "verifying"
  | "ready"
  | "failed"
  | "expired"
  | "cancelled";

export interface CodexLoginSession {
  state: CodexLoginState;
  verificationUrl?: string;
  userCode?: string;
  startedAt?: number;
  expiresAt?: number;
  message: string;
}

export interface CodexLoginProcess {
  stdout: AsyncIterable<Uint8Array>;
  stderr: AsyncIterable<Uint8Array>;
  exited: Promise<number>;
  kill(): void;
}

export type CodexWindowsSandboxSetupState =
  | "idle"
  | "starting"
  | "waiting_for_user"
  | "ready"
  | "failed"
  | "cancelled";

export interface CodexWindowsSandboxSetupSession {
  state: CodexWindowsSandboxSetupState;
  startedAt?: number;
  expiresAt?: number;
  message: string;
}

export interface CodexAppServerProcess extends CodexLoginProcess {
  stdin: {
    write(value: string): unknown;
    flush?(): unknown;
    end?(): unknown;
  };
}

export interface CodexAppServerSpawner {
  spawn(argv: string[]): CodexAppServerProcess;
}

export interface CodexLoginSpawner {
  spawn(argv: string[]): CodexLoginProcess;
}

export interface CodexCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CodexCommandRunner {
  run(argv: string[], timeoutMs: number): Promise<CodexCommandResult>;
}

export interface CodexProviderSetupOptions {
  codexBin?: string;
  spawner?: CodexLoginSpawner;
  commandRunner?: CodexCommandRunner;
  appServerSpawner?: CodexAppServerSpawner;
  prepareCodexHome?: () => void;
  detailWaitMs?: number;
  ttlMs?: number;
  sandboxSetupWaitMs?: number;
  sandboxSetupTtlMs?: number;
}

const ACTIVE_LOGIN_STATES = new Set<CodexLoginState>([
  "starting",
  "waiting_for_user",
  "verifying",
]);

const ACTIVE_SANDBOX_SETUP_STATES = new Set<CodexWindowsSandboxSetupState>([
  "starting",
  "waiting_for_user",
]);

const bunCodexLoginSpawner: CodexLoginSpawner = {
  spawn(argv) {
    const proc = Bun.spawn(argv, {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: providerChildEnvironment(),
    });
    return {
      stdout: proc.stdout as unknown as AsyncIterable<Uint8Array>,
      stderr: proc.stderr as unknown as AsyncIterable<Uint8Array>,
      exited: proc.exited,
      kill: () => proc.kill("SIGTERM"),
    };
  },
};

const bunCodexAppServerSpawner: CodexAppServerSpawner = {
  spawn(argv) {
    const proc = Bun.spawn(argv, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: providerChildEnvironment(),
    });
    return {
      stdin: proc.stdin as unknown as CodexAppServerProcess["stdin"],
      stdout: proc.stdout as unknown as AsyncIterable<Uint8Array>,
      stderr: proc.stderr as unknown as AsyncIterable<Uint8Array>,
      exited: proc.exited,
      kill: () => proc.kill("SIGTERM"),
    };
  },
};

const bunCodexCommandRunner: CodexCommandRunner = {
  async run(argv, timeoutMs) {
    const proc = Bun.spawn(argv, {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: providerChildEnvironment(),
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
    }, timeoutMs);
    try {
      const [stdout, stderr, code] = await Promise.all([
        readBounded(proc.stdout as unknown as AsyncIterable<Uint8Array>),
        readBounded(proc.stderr as unknown as AsyncIterable<Uint8Array>),
        proc.exited,
      ]);
      return {
        code: timedOut ? 124 : code,
        stdout: new TextDecoder().decode(stdout),
        stderr: new TextDecoder().decode(stderr),
      };
    } finally {
      clearTimeout(timer);
    }
  },
};

export class CodexProviderSetup {
  private readonly codexBin: string;
  private readonly spawner: CodexLoginSpawner;
  private readonly commandRunner: CodexCommandRunner;
  private readonly appServerSpawner: CodexAppServerSpawner;
  private readonly prepareCodexHome: () => void;
  private readonly detailWaitMs: number;
  private readonly ttlMs: number;
  private readonly sandboxSetupWaitMs: number;
  private readonly sandboxSetupTtlMs: number;
  private generation = 0;
  private process?: CodexLoginProcess;
  private sandboxGeneration = 0;
  private sandboxProcess?: CodexAppServerProcess;
  private sandboxTimer?: ReturnType<typeof setTimeout>;
  private session: CodexLoginSession = {
    state: "idle",
    message: "HomeAgent 尚未连接当前 Codex 账号",
  };
  private sandboxSession: CodexWindowsSandboxSetupSession = {
    state: "idle",
    message: "Windows 安全沙箱尚未设置",
  };

  constructor(options: CodexProviderSetupOptions = {}) {
    this.codexBin =
      options.codexBin?.trim() || brandedEnv(process.env, "CODEX_BIN")?.trim() || "codex";
    this.spawner = options.spawner ?? bunCodexLoginSpawner;
    this.commandRunner = options.commandRunner ?? bunCodexCommandRunner;
    this.appServerSpawner = options.appServerSpawner ?? bunCodexAppServerSpawner;
    this.prepareCodexHome = options.prepareCodexHome ?? (() => {
      prepareProviderCodexHome();
    });
    this.detailWaitMs = boundedDuration(options.detailWaitMs, LOGIN_DETAIL_WAIT_MS);
    this.ttlMs = boundedDuration(options.ttlMs, LOGIN_TTL_MS);
    this.sandboxSetupWaitMs = boundedDuration(
      options.sandboxSetupWaitMs,
      SANDBOX_SETUP_WAIT_MS,
    );
    this.sandboxSetupTtlMs = boundedDuration(
      options.sandboxSetupTtlMs,
      SANDBOX_SETUP_TTL_MS,
    );
  }

  async startDeviceLogin(): Promise<CodexLoginSession> {
    if (ACTIVE_LOGIN_STATES.has(this.session.state)) return this.deviceLoginStatus();

    const generation = ++this.generation;
    if (this.process) {
      safelyKill(this.process);
      this.process = undefined;
    }

    const startedAt = Date.now();
    this.session = {
      state: "starting",
      startedAt,
      expiresAt: startedAt + this.ttlMs,
      message: "正在准备 ChatGPT 登录",
    };

    let proc: CodexLoginProcess;
    try {
      this.prepareCodexHome();
      proc = this.spawner.spawn([
        this.codexBin,
        "-c",
        'cli_auth_credentials_store="file"',
        "login",
        "--device-auth",
      ]);
      this.process = proc;
    } catch {
      this.finishLogin("failed", LOGIN_FAILED_MESSAGE);
      return this.deviceLoginStatus();
    }

    const ttlTimer = setTimeout(() => {
      if (this.generation === generation && ACTIVE_LOGIN_STATES.has(this.session.state)) {
        this.finishLogin("expired", LOGIN_EXPIRED_MESSAGE);
        safelyKill(proc);
      }
    }, this.ttlMs);
    (ttlTimer as unknown as { unref?: () => void }).unref?.();

    let captured: Uint8Array = new Uint8Array();
    let verificationUrl: string | undefined;
    let userCode: string | undefined;
    let detailsResolved = false;
    let resolveDetails!: (details: { verificationUrl: string; userCode: string }) => void;
    const detailsFound = new Promise<{ verificationUrl: string; userCode: string }>((resolve) => {
      resolveDetails = resolve;
    });
    const inspect = (chunk: Uint8Array): void => {
      captured = appendBounded(captured, chunk);
      const text = new TextDecoder().decode(captured);
      verificationUrl ??= extractAllowedLoginUrl(text);
      userCode ??= extractSafeUserCode(text);
      if (!detailsResolved && verificationUrl && userCode) {
        detailsResolved = true;
        resolveDetails({ verificationUrl, userCode });
      }
    };
    const consume = async (stream: AsyncIterable<Uint8Array>): Promise<void> => {
      for await (const chunk of stream) inspect(chunk);
    };
    const readers = [consume(proc.stdout), consume(proc.stderr)];

    let resolveExitObserved!: () => void;
    const exitObserved = new Promise<void>((resolve) => {
      resolveExitObserved = resolve;
    });
    const handledExit = (async (): Promise<void> => {
      const code = await proc.exited;
      clearTimeout(ttlTimer);
      await Promise.allSettled(readers);
      if (this.generation !== generation) {
        resolveExitObserved();
        return;
      }
      if (this.process === proc) this.process = undefined;
      if (this.session.state === "expired" || this.session.state === "cancelled") {
        resolveExitObserved();
        return;
      }
      if (this.session.state === "failed") {
        resolveExitObserved();
        return;
      }
      if (code !== 0) {
        this.finishLogin("failed", LOGIN_FAILED_MESSAGE);
        resolveExitObserved();
        return;
      }

      this.session = {
        ...this.session,
        state: "verifying",
        message: "正在确认 ChatGPT 登录",
      };
      resolveExitObserved();
      let status: CodexCommandResult;
      try {
        status = await this.commandRunner.run(
          [
            this.codexBin,
            "-c",
            'cli_auth_credentials_store="file"',
            "login",
            "status",
          ],
          COMMAND_TIMEOUT_MS,
        );
      } catch {
        status = { code: 1, stdout: "", stderr: "" };
      }
      if (this.generation !== generation || this.session.state !== "verifying") return;
      if (status.code === 0) this.finishLogin("ready", LOGIN_READY_MESSAGE);
      else this.finishLogin("failed", LOGIN_FAILED_MESSAGE);
    })();
    void handledExit.catch(() => {
      clearTimeout(ttlTimer);
      if (this.generation === generation && ACTIVE_LOGIN_STATES.has(this.session.state)) {
        if (this.process === proc) this.process = undefined;
        this.finishLogin("failed", LOGIN_FAILED_MESSAGE);
      }
      resolveExitObserved();
    });

    let detailTimer: ReturnType<typeof setTimeout> | undefined;
    const detailDeadline = new Promise<{ type: "deadline" }>((resolve) => {
      detailTimer = setTimeout(() => resolve({ type: "deadline" }), this.detailWaitMs);
    });
    const outcome = await Promise.race([
      detailsFound.then((details) => ({ type: "details" as const, details })),
      exitObserved.then(() => ({ type: "exit" as const })),
      detailDeadline,
    ]);
    if (detailTimer) clearTimeout(detailTimer);

    if (
      outcome.type === "details"
      && this.generation === generation
      && this.session.state === "starting"
    ) {
      this.session = {
        ...this.session,
        state: "waiting_for_user",
        verificationUrl: outcome.details.verificationUrl,
        userCode: outcome.details.userCode,
        message: "请在浏览器中确认 ChatGPT 登录",
      };
    } else if (
      outcome.type === "deadline"
      && this.generation === generation
      && this.session.state === "starting"
    ) {
      this.finishLogin("failed", LOGIN_FAILED_MESSAGE);
      safelyKill(proc);
    }

    return this.deviceLoginStatus();
  }

  deviceLoginStatus(): CodexLoginSession {
    return { ...this.session };
  }

  cancelDeviceLogin(): CodexLoginSession {
    if (!ACTIVE_LOGIN_STATES.has(this.session.state)) return this.deviceLoginStatus();
    this.finishLogin("cancelled", LOGIN_CANCELLED_MESSAGE);
    if (this.process) {
      safelyKill(this.process);
      this.process = undefined;
    }
    return this.deviceLoginStatus();
  }

  async startWindowsSandboxSetup(): Promise<CodexWindowsSandboxSetupSession> {
    if (ACTIVE_SANDBOX_SETUP_STATES.has(this.sandboxSession.state)) {
      return this.windowsSandboxSetupStatus();
    }

    const generation = ++this.sandboxGeneration;
    this.stopSandboxProcess();
    const startedAt = Date.now();
    this.sandboxSession = {
      state: "starting",
      startedAt,
      expiresAt: startedAt + this.sandboxSetupTtlMs,
      message: "正在启动 Windows 安全沙箱设置",
    };

    let proc: CodexAppServerProcess;
    try {
      this.prepareCodexHome();
      proc = this.appServerSpawner.spawn([this.codexBin, "app-server"]);
      this.sandboxProcess = proc;
    } catch {
      this.finishSandboxSetup("failed", SANDBOX_SETUP_FAILED_MESSAGE);
      return this.windowsSandboxSetupStatus();
    }

    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    let startedResolved = false;
    const observeStarted = (): void => {
      if (startedResolved) return;
      startedResolved = true;
      resolveStarted();
    };
    const handleMessage = (message: unknown): void => {
      if (this.sandboxGeneration !== generation || !isRecord(message)) return;
      if (message.id === 53) {
        const result = isRecord(message.result) ? message.result : undefined;
        if (result?.started === true) {
          if (this.sandboxSession.state === "starting") {
            this.sandboxSession = {
              ...this.sandboxSession,
              state: "waiting_for_user",
              message: "请在 Windows 系统窗口中批准 Codex 安全沙箱设置",
            };
          }
        } else {
          this.finishSandboxSetup("failed", SANDBOX_SETUP_FAILED_MESSAGE);
          this.stopSandboxProcess();
        }
        observeStarted();
        return;
      }
      if (message.method !== "windowsSandbox/setupCompleted") return;
      const params = isRecord(message.params) ? message.params : undefined;
      if (params?.mode !== "elevated" || typeof params.success !== "boolean") return;
      this.finishSandboxSetup(
        params.success ? "ready" : "failed",
        params.success ? SANDBOX_SETUP_READY_MESSAGE : SANDBOX_SETUP_FAILED_MESSAGE,
      );
      observeStarted();
      this.stopSandboxProcess();
    };
    const readers = Promise.allSettled([
      consumeJsonLines(proc.stdout, handleMessage),
      readBounded(proc.stderr),
    ]);
    void (async () => {
      await proc.exited;
      await readers;
      if (
        this.sandboxGeneration === generation
        && ACTIVE_SANDBOX_SETUP_STATES.has(this.sandboxSession.state)
      ) {
        this.finishSandboxSetup("failed", SANDBOX_SETUP_FAILED_MESSAGE);
        observeStarted();
      }
      if (this.sandboxProcess === proc) this.sandboxProcess = undefined;
    })().catch(() => {
      if (
        this.sandboxGeneration === generation
        && ACTIVE_SANDBOX_SETUP_STATES.has(this.sandboxSession.state)
      ) {
        this.finishSandboxSetup("failed", SANDBOX_SETUP_FAILED_MESSAGE);
        observeStarted();
      }
    });

    this.sandboxTimer = setTimeout(() => {
      if (
        this.sandboxGeneration === generation
        && ACTIVE_SANDBOX_SETUP_STATES.has(this.sandboxSession.state)
      ) {
        this.finishSandboxSetup("failed", SANDBOX_SETUP_FAILED_MESSAGE);
        observeStarted();
        this.stopSandboxProcess();
      }
    }, this.sandboxSetupTtlMs);
    (this.sandboxTimer as unknown as { unref?: () => void }).unref?.();

    try {
      sendAppServerMessage(proc, {
        method: "initialize",
        id: 0,
        params: {
          clientInfo: {
            name: "homeagent",
            title: "HomeAgent",
            version: APP_SERVER_CLIENT_VERSION,
          },
        },
      });
      sendAppServerMessage(proc, { method: "initialized", params: {} });
      sendAppServerMessage(proc, {
        method: "windowsSandbox/setupStart",
        id: 53,
        params: { mode: "elevated" },
      });
    } catch {
      this.finishSandboxSetup("failed", SANDBOX_SETUP_FAILED_MESSAGE);
      observeStarted();
      this.stopSandboxProcess();
    }

    let waitTimer: ReturnType<typeof setTimeout> | undefined;
    const waitDeadline = new Promise<void>((resolve) => {
      waitTimer = setTimeout(resolve, this.sandboxSetupWaitMs);
    });
    await Promise.race([started, waitDeadline]);
    if (waitTimer) clearTimeout(waitTimer);
    if (
      this.sandboxGeneration === generation
      && this.sandboxSession.state === "starting"
    ) {
      this.finishSandboxSetup("failed", SANDBOX_SETUP_FAILED_MESSAGE);
      this.stopSandboxProcess();
    }
    return this.windowsSandboxSetupStatus();
  }

  windowsSandboxSetupStatus(): CodexWindowsSandboxSetupSession {
    return { ...this.sandboxSession };
  }

  cancelWindowsSandboxSetup(): CodexWindowsSandboxSetupSession {
    if (!ACTIVE_SANDBOX_SETUP_STATES.has(this.sandboxSession.state)) {
      return this.windowsSandboxSetupStatus();
    }
    this.finishSandboxSetup("cancelled", "已取消 Windows 安全沙箱设置");
    this.stopSandboxProcess();
    return this.windowsSandboxSetupStatus();
  }

  private finishLogin(state: "ready" | "failed" | "expired" | "cancelled", message: string): void {
    this.session = {
      state,
      ...(this.session.startedAt !== undefined ? { startedAt: this.session.startedAt } : {}),
      ...(this.session.expiresAt !== undefined ? { expiresAt: this.session.expiresAt } : {}),
      message,
    };
  }

  private finishSandboxSetup(
    state: "ready" | "failed" | "cancelled",
    message: string,
  ): void {
    if (this.sandboxTimer) clearTimeout(this.sandboxTimer);
    this.sandboxTimer = undefined;
    this.sandboxSession = {
      state,
      ...(this.sandboxSession.startedAt !== undefined
        ? { startedAt: this.sandboxSession.startedAt }
        : {}),
      ...(this.sandboxSession.expiresAt !== undefined
        ? { expiresAt: this.sandboxSession.expiresAt }
        : {}),
      message,
    };
  }

  private stopSandboxProcess(): void {
    if (!this.sandboxProcess) return;
    try {
      this.sandboxProcess.stdin.end?.();
    } catch {
      // The app-server may close stdin as setup finishes.
    }
    safelyKill(this.sandboxProcess);
    this.sandboxProcess = undefined;
  }
}

function boundedDuration(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(LOGIN_TTL_MS, Math.trunc(value)));
}

function safelyKill(proc: CodexLoginProcess): void {
  try {
    proc.kill();
  } catch {
    // The login process may exit between observing the session and cancellation.
  }
}

function appendBounded(previous: Uint8Array, chunk: Uint8Array): Uint8Array {
  if (chunk.byteLength >= CAPTURE_LIMIT_BYTES) {
    return chunk.slice(chunk.byteLength - CAPTURE_LIMIT_BYTES);
  }
  const kept = previous.subarray(
    Math.max(0, previous.byteLength - (CAPTURE_LIMIT_BYTES - chunk.byteLength)),
  );
  const next = new Uint8Array(kept.byteLength + chunk.byteLength);
  next.set(kept);
  next.set(chunk, kept.byteLength);
  return next;
}

async function readBounded(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  let captured: Uint8Array = new Uint8Array();
  for await (const chunk of stream) captured = appendBounded(captured, chunk);
  return captured;
}

async function consumeJsonLines(
  stream: AsyncIterable<Uint8Array>,
  consume: (message: unknown) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of stream) {
    pending += decoder.decode(chunk, { stream: true });
    if (Buffer.byteLength(pending, "utf8") > CAPTURE_LIMIT_BYTES) {
      const lastBreak = pending.lastIndexOf("\n");
      pending = lastBreak >= 0 ? pending.slice(lastBreak + 1) : "";
    }
    let lineBreak = pending.indexOf("\n");
    while (lineBreak >= 0) {
      const line = pending.slice(0, lineBreak).trim();
      pending = pending.slice(lineBreak + 1);
      if (line) {
        try {
          consume(JSON.parse(line));
        } catch {
          // Only valid bounded JSON messages cross the app-server boundary.
        }
      }
      lineBreak = pending.indexOf("\n");
    }
  }
}

function sendAppServerMessage(proc: CodexAppServerProcess, message: unknown): void {
  proc.stdin.write(`${JSON.stringify(message)}\n`);
  proc.stdin.flush?.();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractAllowedLoginUrl(text: string): string | undefined {
  const matches = text.match(/https:\/\/[^\s<>'"\u001b]+/g) ?? [];
  for (const raw of matches) {
    const candidate = raw.replace(/[),.;\]]+$/, "");
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol !== "https:") continue;
      if (parsed.username || parsed.password || parsed.port) continue;
      if (parsed.hostname !== "auth.openai.com" && parsed.hostname !== "chatgpt.com") continue;
      return parsed.toString();
    } catch {
      // Keep scanning; no unparsed value crosses the provider boundary.
    }
  }
  return undefined;
}

function extractSafeUserCode(text: string): string | undefined {
  const patterns = [
    /(?:user[\s-]*code|one[\s-]*time[\s-]*code|用户代码|验证码)(?:\s+is)?\s*[:：]?\s*([A-Z0-9][A-Z0-9-]{3,31})\b/i,
    /\bcode\s*[:：]\s*([A-Z0-9][A-Z0-9-]{3,31})\b/i,
  ];
  for (const pattern of patterns) {
    const value = text.match(pattern)?.[1];
    if (value && /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/i.test(value)) return value.toUpperCase();
  }
  return undefined;
}
