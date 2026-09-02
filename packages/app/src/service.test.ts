import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LaunchAgentService,
  acquireProcessLock,
  rotateActiveServiceLogs,
  type CommandResult,
  type ServiceCommandRunner,
} from "./service.ts";

describe("macOS LaunchAgent service", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test("install writes a private boot-persistent plist without secrets and bootstraps it", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "hb-service-home-"));
    const dataDir = mkdtempSync(join(tmpdir(), "hb-service-data-"));
    dirs.push(homeDir, dataDir);
    mkdirSync(join(dataDir, "logs"), { recursive: true });
    writeFileSync(join(dataDir, "logs", "service.stdout.log"), "oversized-old-log");
    const calls: string[][] = [];
    let loaded = false;
    const runner: ServiceCommandRunner = async (argv): Promise<CommandResult> => {
      calls.push(argv);
      if (argv.includes("print")) {
        return loaded
          ? { code: 0, stdout: "state = running\npid = 7001\n", stderr: "" }
          : { code: 113, stdout: "", stderr: "not found" };
      }
      if (argv.includes("bootstrap")) loaded = true;
      return { code: 0, stdout: "", stderr: "" };
    };
    const service = new LaunchAgentService({
      platform: "darwin",
      uid: 501,
      homeDir,
      repoRoot: "/Users/test/HomeAgent & Family",
      dataDir,
      bunPath: "/opt/homebrew/bin/bun",
      environment: {
        HOME: homeDir,
        PATH: "/opt/homebrew/bin:/usr/bin:/bin",
        ANTHROPIC_AUTH_TOKEN: "must-not-be-persisted",
        HOMEAGENT_WEB_ADMIN_TOKEN: "also-must-not-be-persisted",
      },
      runner,
      logMaxBytes: 10,
      logPreserveBytes: 8,
    });

    const status = await service.install();
    const plist = readFileSync(service.plistPath, "utf8");

    expect(status.installed).toBe(true);
    if (process.platform === "darwin") {
      expect(Bun.spawnSync(["/usr/bin/plutil", "-lint", service.plistPath]).exitCode).toBe(0);
    }
    expect(statSync(service.plistPath).mode & 0o777).toBe(0o600);
    expect(statSync(service.stdoutPath).mode & 0o777).toBe(0o600);
    expect(statSync(service.stderrPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(`${service.stdoutPath}.1`, "utf8")).toBe("oversized-old-log".slice(-8));
    expect(plist).toContain("<string>com.homeagent.agent</string>");
    expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(plist).toContain("<key>KeepAlive</key>\n  <true/>");
    expect(plist).toContain("/opt/homebrew/bin/bun");
    expect(plist).toContain("packages/app/src/main.ts");
    expect(plist).toContain("/Users/test/HomeAgent &amp; Family");
    expect(plist).toContain("HOMEAGENT_SERVICE_MANAGED");
    expect(plist).toContain("service.stdout.log");
    expect(plist).toContain("service.stderr.log");
    expect(plist).not.toContain("must-not-be-persisted");
    expect(plist).not.toContain("also-must-not-be-persisted");
    expect(calls).toContainEqual([
      "/bin/launchctl",
      "enable",
      "gui/501/com.homeagent.agent",
    ]);
    expect(calls).toContainEqual([
      "/bin/launchctl",
      "bootstrap",
      "gui/501",
      service.plistPath,
    ]);
  });

  test("bundled install runs the app executable and uses macOS Library data and logs", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "hb-service-bundle-home-"));
    dirs.push(homeDir);
    const dataDir = join(homeDir, "Library", "Application Support", "HomeAgent");
    const logDir = join(homeDir, "Library", "Logs", "HomeAgent");
    let loaded = false;
    const service = new LaunchAgentService({
      platform: "darwin",
      uid: 501,
      homeDir,
      repoRoot: "/Applications/HomeAgent.app",
      dataDir,
      logDir,
      bunPath: "/should/not/be/used/bun",
      bundled: true,
      executablePath: "/Applications/HomeAgent.app/Contents/MacOS/homeagent",
      environment: { HOME: homeDir, PATH: "/usr/bin:/bin" },
      runner: async (argv) => {
        if (argv[1] === "print") {
          return loaded
            ? { code: 0, stdout: "state = running\npid = 9081\n", stderr: "" }
            : { code: 113, stdout: "", stderr: "not found" };
        }
        if (argv[1] === "bootstrap") loaded = true;
        return { code: 0, stdout: "", stderr: "" };
      },
    });

    await service.install();
    const plist = readFileSync(service.plistPath, "utf8");

    expect(plist).toContain("<string>/Applications/HomeAgent.app/Contents/MacOS/homeagent</string>");
    expect(plist).toContain("<string>serve</string>");
    expect(plist).not.toContain("/should/not/be/used/bun");
    expect(plist).not.toContain("packages/app/src/main.ts");
    expect(plist).not.toContain("<key>WorkingDirectory</key>");
    expect(plist).toContain("Library/Application Support/HomeAgent");
    expect(plist).toContain(
      `<key>PATH</key>\n  <string>/usr/bin:/bin:${join(homeDir, ".local", "bin")}:${join(homeDir, ".bun", "bin")}:/opt/homebrew/bin:/usr/local/bin</string>`,
    );
    expect(service.stdoutPath).toBe(join(logDir, "service.stdout.log"));
    expect(service.stderrPath).toBe(join(logDir, "service.stderr.log"));
    expect(statSync(service.stdoutPath).mode & 0o777).toBe(0o600);
  });

  test("install unloads and removes the pre-rename LaunchAgent", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "ha-service-legacy-home-"));
    const dataDir = mkdtempSync(join(tmpdir(), "ha-service-legacy-data-"));
    dirs.push(homeDir, dataDir);
    const legacyPlist = join(
      homeDir,
      "Library",
      "LaunchAgents",
      "com.homebrain.agent.plist",
    );
    mkdirSync(join(homeDir, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(legacyPlist, "legacy");
    const calls: string[][] = [];
    let newLoaded = false;
    const service = new LaunchAgentService({
      platform: "darwin",
      uid: 501,
      homeDir,
      repoRoot: "/Applications/HomeAgent.app",
      dataDir,
      bunPath: "/opt/homebrew/bin/bun",
      environment: { HOME: homeDir, PATH: "/usr/bin:/bin" },
      runner: async (argv) => {
        calls.push(argv);
        const target = argv.at(-1);
        if (argv[1] === "print" && target === "gui/501/com.homebrain.agent") {
          return { code: 0, stdout: "state = running\npid = 3001\n", stderr: "" };
        }
        if (argv[1] === "print") {
          return newLoaded
            ? { code: 0, stdout: "state = running\npid = 3002\n", stderr: "" }
            : { code: 113, stdout: "", stderr: "not found" };
        }
        if (argv[1] === "bootstrap") newLoaded = true;
        return { code: 0, stdout: "", stderr: "" };
      },
    });

    await service.install();

    expect(existsSync(legacyPlist)).toBeFalse();
    expect(calls).toContainEqual([
      "/bin/launchctl",
      "bootout",
      "gui/501/com.homebrain.agent",
    ]);
    expect(calls).toContainEqual([
      "/bin/launchctl",
      "bootstrap",
      "gui/501",
      service.plistPath,
    ]);
  });

  test("start, stop, restart, status, and uninstall use the correct launchctl lifecycle", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "hb-service-life-home-"));
    const dataDir = mkdtempSync(join(tmpdir(), "hb-service-life-data-"));
    dirs.push(homeDir, dataDir);
    const calls: string[][] = [];
    let loaded = false;
    let pid = 7301;
    const runner: ServiceCommandRunner = async (argv) => {
      calls.push(argv);
      const action = argv[1];
      if (action === "print") {
        return loaded
          ? { code: 0, stdout: `state = running\npid = ${pid}\nlast exit code = 0\n`, stderr: "" }
          : { code: 113, stdout: "", stderr: "not found" };
      }
      if (action === "bootstrap") loaded = true;
      if (action === "bootout") loaded = false;
      if (action === "kickstart" || action === "kill") {
        loaded = true;
        pid += 1;
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const service = new LaunchAgentService({
      platform: "darwin",
      uid: 501,
      homeDir,
      repoRoot: "/repo",
      dataDir,
      bunPath: "/opt/homebrew/bin/bun",
      environment: { HOME: homeDir, PATH: "/opt/homebrew/bin:/usr/bin:/bin" },
      runner,
    });

    await service.install();
    expect(await service.status()).toEqual(expect.objectContaining({ running: true, pid: 7301 }));

    expect(await service.restart()).toEqual(expect.objectContaining({ running: true, pid: 7302 }));
    expect(calls).toContainEqual(["/bin/launchctl", "kill", "SIGTERM", "gui/501/com.homeagent.agent"]);

    expect(await service.stop()).toEqual(expect.objectContaining({ installed: true, loaded: false }));
    expect(calls).toContainEqual(["/bin/launchctl", "bootout", "gui/501/com.homeagent.agent"]);

    expect(await service.start()).toEqual(expect.objectContaining({ running: true }));
    expect(calls.filter((call) => call[1] === "bootstrap").length).toBe(2);

    expect(await service.uninstall()).toEqual(expect.objectContaining({ installed: false, loaded: false }));
  });

  test("process lock rejects a live duplicate and replaces a stale owner", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "hb-service-lock-"));
    dirs.push(dataDir);
    const first = acquireProcessLock({
      dataDir,
      pid: 4101,
      startedAt: 1_783_932_000_000,
      isProcessAlive: (pid) => pid === 4101,
    });
    expect(first.path).toBe(join(dataDir, "run", "homebrain.lock"));

    expect(() => acquireProcessLock({
      dataDir,
      pid: 4102,
      startedAt: 1_783_932_001_000,
      isProcessAlive: (pid) => pid === 4101,
    })).toThrow("homeagent is already running (PID 4101)");
    first.release();

    const runDir = join(dataDir, "run");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "homebrain.lock"), JSON.stringify({ pid: 3999, startedAt: 1 }));
    const replacement = acquireProcessLock({
      dataDir,
      pid: 4102,
      startedAt: 1_783_932_001_000,
      isProcessAlive: () => false,
    });
    expect(JSON.parse(readFileSync(replacement.path, "utf8"))).toEqual({
      version: 2,
      pid: 4102,
      startedAt: 1_783_932_001_000,
    });
    replacement.release();
  });

  test("uninstall keeps the plist when launchd refuses to unload the service", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "hb-service-uninstall-home-"));
    const dataDir = mkdtempSync(join(tmpdir(), "hb-service-uninstall-data-"));
    dirs.push(homeDir, dataDir);
    let loaded = false;
    let refuseBootout = false;
    const service = new LaunchAgentService({
      platform: "darwin",
      uid: 501,
      homeDir,
      repoRoot: "/repo",
      dataDir,
      bunPath: "/opt/homebrew/bin/bun",
      environment: { HOME: homeDir, PATH: "/opt/homebrew/bin:/usr/bin:/bin" },
      runner: async (argv) => {
        if (argv[1] === "print") {
          return loaded
            ? { code: 0, stdout: "state = running\npid = 42\n", stderr: "" }
            : { code: 113, stdout: "", stderr: "not found" };
        }
        if (argv[1] === "bootstrap") loaded = true;
        if (argv[1] === "bootout") {
          if (refuseBootout) return { code: 1, stdout: "", stderr: "operation not permitted" };
          loaded = false;
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    await service.install();
    refuseBootout = true;

    expect(service.uninstall()).rejects.toThrow("launchctl uninstall failed: operation not permitted");
    expect(readFileSync(service.plistPath, "utf8")).toContain("com.homeagent.agent");
  });

  test("status only associates a lock start time with the matching launchd PID", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "hb-service-status-home-"));
    const dataDir = mkdtempSync(join(tmpdir(), "hb-service-status-data-"));
    dirs.push(homeDir, dataDir);
    const runDir = join(dataDir, "run");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "homebrain.lock"), JSON.stringify({
      pid: 9999,
      startedAt: 1_700_000_000_000,
    }));
    const service = new LaunchAgentService({
      platform: "darwin",
      uid: 501,
      homeDir,
      repoRoot: "/repo",
      dataDir,
      bunPath: "/opt/homebrew/bin/bun",
      environment: { HOME: homeDir, PATH: "/usr/bin:/bin" },
      runner: async () => ({
        code: 0,
        stdout: "state = running\npid = 7788\n",
        stderr: "",
      }),
    });

    expect((await service.status()).startedAt).toBeUndefined();
  });

  test("install fails when launchd never reaches a running process", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "hb-service-crash-home-"));
    const dataDir = mkdtempSync(join(tmpdir(), "hb-service-crash-data-"));
    dirs.push(homeDir, dataDir);
    let loaded = false;
    const service = new LaunchAgentService({
      platform: "darwin",
      uid: 501,
      homeDir,
      repoRoot: "/repo",
      dataDir,
      bunPath: "/missing/bun",
      environment: { HOME: homeDir, PATH: "/usr/bin:/bin" },
      startupTimeoutMs: 0,
      runner: async (argv) => {
        if (argv[1] === "print") {
          return loaded
            ? { code: 0, stdout: "state = waiting\nlast exit code = 1\n", stderr: "" }
            : { code: 113, stdout: "", stderr: "not found" };
        }
        if (argv[1] === "bootstrap") loaded = true;
        return { code: 0, stdout: "", stderr: "" };
      },
    });

    expect(service.install()).rejects.toThrow(
      "homeagent service did not reach running state within 0ms (last exit 1)",
    );
  });

  test("real concurrent processes cannot both acquire the same lock", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "hb-service-race-"));
    dirs.push(dataDir);
    const serviceModule = new URL("./service.ts", import.meta.url).href;
    const childCode = `
      import { acquireProcessLock } from ${JSON.stringify(serviceModule)};
      await Bun.sleep(100);
      try {
        const lock = acquireProcessLock({ dataDir: ${JSON.stringify(dataDir)} });
        console.log("acquired");
        await Bun.sleep(300);
        lock.release();
      } catch (err) {
        console.log("rejected:" + String(err));
        process.exitCode = 2;
      }
    `;
    const children = [
      Bun.spawn([process.execPath, "-e", childCode], { stdout: "pipe", stderr: "pipe" }),
      Bun.spawn([process.execPath, "-e", childCode], { stdout: "pipe", stderr: "pipe" }),
    ];
    const results = await Promise.all(children.map(async (child) => ({
      stdout: await new Response(child.stdout).text(),
      stderr: await new Response(child.stderr).text(),
      code: await child.exited,
    })));

    expect(results.map((result) => result.code).sort()).toEqual([0, 2]);
    expect(results.filter((result) => result.stdout.includes("acquired"))).toHaveLength(1);
    expect(results.filter((result) => result.stdout.includes("already running"))).toHaveLength(1);
    expect(results.map((result) => result.stderr).join("")).toBe("");
  });

  test("recovers legacy stale lock metadata and an abandoned cleanup guard", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "hb-service-stale-cleanup-"));
    dirs.push(dataDir);
    const runDir = join(dataDir, "run");
    mkdirSync(join(runDir, "homebrain.lock.cleanup"), { recursive: true });
    writeFileSync(join(runDir, "homebrain.lock"), JSON.stringify({ pid: 3333, startedAt: 1 }));

    const lock = acquireProcessLock({
      dataDir,
      pid: 4444,
      startedAt: 2,
      isProcessAlive: () => false,
    });
    expect(JSON.parse(readFileSync(lock.path, "utf8"))).toEqual({ version: 2, pid: 4444, startedAt: 2 });
    expect(() => statSync(join(runDir, "homebrain.lock.cleanup"))).toThrow();
    lock.release();
  });

  test("runtime log maintenance bounds active files and privatizes rotated backups", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "hb-service-log-rotate-"));
    dirs.push(dataDir);
    const logDir = join(dataDir, "logs");
    mkdirSync(logDir, { recursive: true });
    const active = join(logDir, "service.stderr.log");
    writeFileSync(active, "0123456789abcdef", { mode: 0o644 });
    writeFileSync(`${active}.1`, "older", { mode: 0o644 });

    rotateActiveServiceLogs(dataDir, 10, 8);

    expect(readFileSync(active, "utf8")).toBe("");
    expect(readFileSync(`${active}.1`, "utf8")).toBe("89abcdef");
    expect(readFileSync(`${active}.2`, "utf8")).toBe("older");
    expect(statSync(active).mode & 0o777).toBe(0o600);
    expect(statSync(`${active}.1`).mode & 0o777).toBe(0o600);
    expect(statSync(`${active}.2`).mode & 0o777).toBe(0o600);
  });
});
