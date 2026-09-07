import { afterEach, describe, expect, test } from "bun:test";
import {
  CodexProviderSetup,
  type CodexAppServerProcess,
  type CodexLoginProcess,
} from "./provider-setup.ts";

async function* chunks(...values: string[]): AsyncGenerator<Uint8Array> {
  for (const value of values) yield new TextEncoder().encode(value);
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function eventually(assertion: () => void, timeoutMs = 250): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await Bun.sleep(2);
    }
  }
}

const activeSetups: CodexProviderSetup[] = [];

afterEach(() => {
  for (const setup of activeSetups) {
    setup.cancelDeviceLogin();
    setup.cancelWindowsSandboxSetup();
  }
  activeSetups.length = 0;
});

describe("CodexProviderSetup", () => {
  test("starts one device login and exposes only a safe URL and user code", async () => {
    const exited = deferred<number>();
    let spawned: string[] | undefined;
    let spawnCount = 0;
    const setup = new CodexProviderSetup({
      codexBin: "/usr/local/bin/codex",
      detailWaitMs: 50,
      ttlMs: 1_000,
      prepareCodexHome: () => {},
      spawner: {
        spawn(argv) {
          spawned = argv;
          spawnCount += 1;
          return {
            stdout: chunks("internal trace that must not escape\n"),
            stderr: chunks(
              "x".repeat(9_000),
              "Open https://auth.openai.",
              "com/codex/device and enter user code ABCD-EFGH\n",
            ),
            exited: exited.promise,
            kill: () => exited.resolve(143),
          };
        },
      },
      commandRunner: {
        run: async () => ({ code: 1, stdout: "", stderr: "not logged in" }),
      },
    });
    activeSetups.push(setup);

    const first = await setup.startDeviceLogin();
    const duplicate = await setup.startDeviceLogin();

    expect(spawned).toEqual([
      "/usr/local/bin/codex",
      "-c",
      'cli_auth_credentials_store="file"',
      "login",
      "--device-auth",
    ]);
    expect(spawnCount).toBe(1);
    expect(first).toEqual(expect.objectContaining({
      state: "waiting_for_user",
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "ABCD-EFGH",
    }));
    expect(duplicate.startedAt).toBe(first.startedAt);
    expect(JSON.stringify(first)).not.toContain("internal trace");
  });

  test("ignores untrusted URLs and never surfaces child-process output", async () => {
    const setup = new CodexProviderSetup({
      detailWaitMs: 50,
      prepareCodexHome: () => {},
      spawner: {
        spawn: () => ({
          stdout: chunks("https://attacker.example/device?token=secret\nuser code SECRET_TOKEN\n"),
          stderr: chunks("raw credential material\n"),
          exited: Promise.resolve(1),
          kill: () => {},
        }),
      },
      commandRunner: {
        run: async () => ({ code: 1, stdout: "", stderr: "unused" }),
      },
    });
    activeSetups.push(setup);

    const session = await setup.startDeviceLogin();

    expect(session.state).toBe("failed");
    expect(session.verificationUrl).toBeUndefined();
    expect(session.userCode).toBeUndefined();
    expect(session.message).toBe("ChatGPT 登录未完成，请重试");
    expect(JSON.stringify(session)).not.toContain("secret");
    expect(JSON.stringify(session)).not.toContain("credential");
  });

  test("becomes ready only after codex login status succeeds", async () => {
    const exited = deferred<number>();
    const commands: string[][] = [];
    const setup = new CodexProviderSetup({
      codexBin: "/usr/local/bin/codex",
      detailWaitMs: 50,
      ttlMs: 1_000,
      prepareCodexHome: () => {},
      spawner: {
        spawn: () => ({
          stdout: chunks("Visit https://chatgpt.com/device\nCode: WXYZ-1234\n"),
          stderr: chunks(""),
          exited: exited.promise,
          kill: () => exited.resolve(143),
        }),
      },
      commandRunner: {
        async run(argv) {
          commands.push(argv);
          return { code: 0, stdout: "Logged in using ChatGPT", stderr: "" };
        },
      },
    });
    activeSetups.push(setup);

    expect((await setup.startDeviceLogin()).state).toBe("waiting_for_user");
    exited.resolve(0);
    await eventually(() => expect(setup.deviceLoginStatus().state).toBe("ready"));

    expect(commands).toEqual([[
      "/usr/local/bin/codex",
      "-c",
      'cli_auth_credentials_store="file"',
      "login",
      "status",
    ]]);
    expect(setup.deviceLoginStatus().message).toBe("ChatGPT 已连接");
  });

  test("cancels and expires with fixed public messages", async () => {
    const makeSetup = (ttlMs: number) => {
      let kills = 0;
      const exited = deferred<number>();
      const setup = new CodexProviderSetup({
        detailWaitMs: 50,
        ttlMs,
        prepareCodexHome: () => {},
        spawner: {
          spawn: (): CodexLoginProcess => ({
            stdout: chunks("https://auth.openai.com/device\nUser code: SAFE-CODE\n"),
            stderr: chunks("private output"),
            exited: exited.promise,
            kill: () => {
              kills += 1;
              exited.resolve(143);
            },
          }),
        },
        commandRunner: {
          run: async () => ({ code: 1, stdout: "", stderr: "unused" }),
        },
      });
      activeSetups.push(setup);
      return { setup, kills: () => kills };
    };

    const cancelled = makeSetup(1_000);
    await cancelled.setup.startDeviceLogin();
    expect(cancelled.setup.cancelDeviceLogin()).toEqual(expect.objectContaining({
      state: "cancelled",
      message: "已取消 ChatGPT 登录",
    }));
    expect(cancelled.kills()).toBe(1);

    const expired = makeSetup(10);
    await expired.setup.startDeviceLogin();
    await eventually(() => expect(expired.setup.deviceLoginStatus().state).toBe("expired"));
    expect(expired.setup.deviceLoginStatus().message).toBe("ChatGPT 登录已过期，请重试");
    expect(expired.kills()).toBe(1);
  });

  test("prepares the isolated Codex home before spawning device login", async () => {
    let prepared = false;
    let observedPreparedState = false;
    const setup = new CodexProviderSetup({
      detailWaitMs: 20,
      prepareCodexHome: () => {
        prepared = true;
      },
      spawner: {
        spawn: () => {
          observedPreparedState = prepared;
          return {
            stdout: chunks(""),
            stderr: chunks(""),
            exited: Promise.resolve(1),
            kill: () => {},
          };
        },
      },
      commandRunner: {
        run: async () => ({ code: 1, stdout: "", stderr: "unused" }),
      },
    });
    activeSetups.push(setup);

    expect((await setup.startDeviceLogin()).state).toBe("failed");
    expect(observedPreparedState).toBe(true);
  });

  test("starts the official elevated Windows sandbox setup and reports completion safely", async () => {
    const completion = deferred<void>();
    const sent: string[] = [];
    const exited = deferred<number>();
    async function* stdout(): AsyncGenerator<Uint8Array> {
      yield new TextEncoder().encode('{"id":0,"result":{"platformFamily":"windows"}}\n');
      yield new TextEncoder().encode('{"id":53,"result":{"started":true}}\n');
      await completion.promise;
      yield new TextEncoder().encode(
        '{"method":"windowsSandbox/setupCompleted","params":{"mode":"elevated","success":true,"error":null}}\n',
      );
      exited.resolve(0);
    }
    const setup = new CodexProviderSetup({
      codexBin: "C:\\tools\\codex.exe",
      prepareCodexHome: () => {},
      appServerSpawner: {
        spawn(argv) {
          expect(argv).toEqual(["C:\\tools\\codex.exe", "app-server"]);
          return {
            stdin: {
              write(value) {
                sent.push(value);
              },
            },
            stdout: stdout(),
            stderr: chunks("private app-server diagnostics"),
            exited: exited.promise,
            kill: () => exited.resolve(143),
          } satisfies CodexAppServerProcess;
        },
      },
      sandboxSetupWaitMs: 100,
      sandboxSetupTtlMs: 1_000,
    });
    activeSetups.push(setup);

    const started = await setup.startWindowsSandboxSetup();

    expect(started).toEqual(expect.objectContaining({
      state: "waiting_for_user",
      message: "请在 Windows 系统窗口中批准 Codex 安全沙箱设置",
    }));
    expect(sent.map((line) => JSON.parse(line))).toEqual([
      {
        method: "initialize",
        id: 0,
        params: {
          clientInfo: { name: "homeagent", title: "HomeAgent", version: "0.1.0-beta.1" },
        },
      },
      { method: "initialized", params: {} },
      { method: "windowsSandbox/setupStart", id: 53, params: { mode: "elevated" } },
    ]);

    completion.resolve();
    await eventually(() => expect(setup.windowsSandboxSetupStatus()).toEqual({
      state: "ready",
      startedAt: started.startedAt,
      expiresAt: started.expiresAt,
      message: "Windows 安全沙箱设置已完成",
    }));
    expect(JSON.stringify(setup.windowsSandboxSetupStatus())).not.toContain("diagnostics");
  });

  test("keeps Windows sandbox setup errors fixed and bounded", async () => {
    const secret = "private admin failure and token";
    const setup = new CodexProviderSetup({
      prepareCodexHome: () => {},
      appServerSpawner: {
        spawn: () => ({
          stdin: { write: () => {} },
          stdout: chunks(
            '{"id":0,"result":{}}\n',
            '{"id":53,"result":{"started":true}}\n',
            `${JSON.stringify({
              method: "windowsSandbox/setupCompleted",
              params: { mode: "elevated", success: false, error: secret },
            })}\n`,
          ),
          stderr: chunks(secret),
          exited: Promise.resolve(1),
          kill: () => {},
        }),
      },
      sandboxSetupWaitMs: 100,
    });
    activeSetups.push(setup);

    const session = await setup.startWindowsSandboxSetup();
    await eventually(() => expect(setup.windowsSandboxSetupStatus().state).toBe("failed"));

    expect(session.message).not.toContain(secret);
    expect(setup.windowsSandboxSetupStatus()).toEqual(expect.objectContaining({
      state: "failed",
      message: "Windows 安全沙箱设置未完成，请重试",
    }));
    expect(JSON.stringify(setup.windowsSandboxSetupStatus())).not.toContain(secret);
  });
});
