import { describe, expect, test } from "bun:test";
import type { ServiceStatus } from "./service.ts";
import { createDefaultService, runServiceCli, type ServiceController } from "./service-cli.ts";

const status: ServiceStatus = {
  installed: true,
  loaded: true,
  running: true,
  label: "com.homeagent.agent",
  state: "running",
  pid: 7788,
  startedAt: 1_783_932_000_000,
  plistPath: "/tmp/com.homeagent.agent.plist",
  stdoutPath: "/tmp/service.stdout.log",
  stderrPath: "/tmp/service.stderr.log",
};

function fakeService(calls: string[]): ServiceController {
  return {
    install: async () => (calls.push("install"), status),
    start: async () => (calls.push("start"), status),
    stop: async () => (calls.push("stop"), { ...status, loaded: false, running: false }),
    restart: async () => (calls.push("restart"), status),
    status: async () => (calls.push("status"), status),
    uninstall: async () => (calls.push("uninstall"), { ...status, installed: false, loaded: false, running: false }),
    readLogs: (lines) => (calls.push(`logs:${lines}`), { stdout: "out line", stderr: "err line" }),
    followLogs: async (lines) => { calls.push(`follow:${lines}`); },
  };
}

describe("service CLI", () => {
  test("creates a bundled service with resolved Application Support and Logs paths", () => {
    const service = createDefaultService({
      platform: "darwin",
      uid: 501,
      homeDir: "/Users/test",
      execPath: "/Applications/HomeAgent.app/Contents/MacOS/homeagent",
      environment: { HOME: "/Users/test", PATH: "/usr/bin:/bin" },
      runtimePaths: {
        bundled: true,
        appRoot: "/Applications/HomeAgent.app",
        resourceDir: "/Applications/HomeAgent.app/Contents/Resources",
        brandAssetDir: "/Applications/HomeAgent.app/Contents/Resources/brand",
        dataDir: "/Users/test/Library/Application Support/HomeAgent",
        logDir: "/Users/test/Library/Logs/HomeAgent",
        larkBin: "/Applications/HomeAgent.app/Contents/Resources/bin/lark-cli",
      },
    });

    expect(service.plistPath).toBe("/Users/test/Library/LaunchAgents/com.homeagent.agent.plist");
    expect(service.stdoutPath).toBe("/Users/test/Library/Logs/HomeAgent/service.stdout.log");
    expect(service.stderrPath).toBe("/Users/test/Library/Logs/HomeAgent/service.stderr.log");
  });

  test("dispatches lifecycle commands and prints machine-readable status", async () => {
    const calls: string[] = [];
    const output: string[] = [];
    const service = fakeService(calls);

    expect(await runServiceCli(["restart"], { service, write: (line) => output.push(line) })).toBe(0);
    expect(calls).toEqual(["restart"]);
    expect(output.join("\n")).toContain("PID: 7788");

    calls.length = 0;
    output.length = 0;
    expect(await runServiceCli(["status", "--json"], { service, write: (line) => output.push(line) })).toBe(0);
    expect(calls).toEqual(["status"]);
    expect(JSON.parse(output.join("\n"))).toEqual(expect.objectContaining({ running: true, pid: 7788 }));
  });

  test("supports bounded log output and rejects unknown commands", async () => {
    const calls: string[] = [];
    const output: string[] = [];
    const errors: string[] = [];
    const service = fakeService(calls);

    expect(await runServiceCli(["logs", "--lines", "25"], {
      service,
      write: (line) => output.push(line),
      writeError: (line) => errors.push(line),
    })).toBe(0);
    expect(calls).toEqual(["logs:25"]);
    expect(output.join("\n")).toContain("out line");
    expect(output.join("\n")).toContain("err line");

    expect(await runServiceCli(["wat"], {
      service,
      write: (line) => output.push(line),
      writeError: (line) => errors.push(line),
    })).toBe(2);
    expect(errors.join("\n")).toContain("install|start|stop|restart|status|logs|uninstall");
  });
});
