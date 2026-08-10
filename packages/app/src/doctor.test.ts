import { describe, expect, test } from "bun:test";
import {
  runDoctor,
  runDoctorCli,
  type DoctorProbeSet,
} from "./doctor.ts";
import type { RuntimePaths } from "./runtime-paths.ts";

const paths: RuntimePaths = {
  bundled: true,
  appRoot: "/Applications/HomeAgent.app",
  resourceDir: "/Applications/HomeAgent.app/Contents/Resources",
  brandAssetDir: "/Applications/HomeAgent.app/Contents/Resources/brand",
  dataDir: "/Users/example/Library/Application Support/HomeAgent",
  logDir: "/Users/example/Library/Logs/HomeAgent",
  larkBin: "/Applications/HomeAgent.app/Contents/Resources/bin/lark-cli",
  attachmentHelper:
    "/Applications/HomeAgent.app/Contents/Resources/bin/attachment-extract",
};

function probes(status: "pass" | "action" | "fail" = "pass"): DoctorProbeSet {
  return {
    dataDirectory: async () => status,
    larkCli: async () => status,
    aiProvider: async () => status,
    port: async () => status,
    launchAgent: async () => status,
    feishuRuntime: async () => status,
  };
}

describe("runDoctor", () => {
  test("returns the stable installation check order with human-safe results", async () => {
    const report = await runDoctor({
      platform: "darwin",
      paths,
      port: 3000,
      now: () => 1_784_000_000_000,
      probes: probes(),
    });

    expect(report.checks.map((check) => check.id)).toEqual([
      "macos",
      "data-directory",
      "lark-cli",
      "ai-provider",
      "port",
      "launch-agent",
      "feishu-runtime",
    ]);
    expect(report.status).toBe("pass");
    expect(report.checkedAt).toBe(1_784_000_000_000);
    expect(report.setupUrl).toBe("http://127.0.0.1:3000/setup");
    expect(report.checks.every((check) => check.status === "pass")).toBeTrue();
    expect(report.checks.every((check) => /[\u3400-\u9fff]/.test(check.message))).toBeTrue();
  });

  test("bounds stalled probes and exposes only fixed messages", async () => {
    const secret = "raw-token-and-stderr-must-stay-private";
    const mixed = probes("action");
    mixed.larkCli = async () => {
      void secret;
      return await new Promise<never>(() => {});
    };
    mixed.port = () => "fail";

    const startedAt = Date.now();
    const report = await runDoctor({
      platform: "linux",
      paths,
      port: 3311,
      timeoutMs: 5,
      probes: mixed,
    });

    expect(Date.now() - startedAt).toBeLessThan(200);
    expect(report.status).toBe("fail");
    expect(report.checks.find((check) => check.id === "lark-cli")?.status).toBe("fail");
    expect(report.checks.find((check) => check.id === "data-directory")?.setupUrl).toBe(
      "http://127.0.0.1:3311/setup",
    );
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(JSON.stringify(report)).not.toContain(paths.larkBin);
  });

  test("requires an available no-tools provider for ordinary conversations", async () => {
    const ordinaryProbes = probes();
    delete (ordinaryProbes as Partial<DoctorProbeSet>).aiProvider;
    const report = await runDoctor({
      platform: "darwin",
      paths,
      port: 3000,
      probes: ordinaryProbes,
      detectProviders: async () => [
        { id: "codex", name: "Codex", bin: "codex", available: true, detail: "1.0" },
      ],
    });

    expect(report.checks.find((check) => check.id === "ai-provider")?.status).toBe("action");
    expect(report.checks.find((check) => check.id === "ai-provider")?.message)
      .toContain("安全普通对话");
    expect(report.status).toBe("action");
  });

  test("accepts an available Claude provider for ordinary conversations", async () => {
    const ordinaryProbes = probes();
    delete (ordinaryProbes as Partial<DoctorProbeSet>).aiProvider;
    const report = await runDoctor({
      platform: "darwin",
      paths,
      port: 3000,
      probes: ordinaryProbes,
      detectProviders: async () => [
        { id: "claude", name: "Claude", bin: "claude", available: true, detail: "2.0" },
        { id: "trae-cli", name: "TRAE", bin: "trae-cli", available: true, detail: "1.0" },
      ],
    });

    expect(report.checks.find((check) => check.id === "ai-provider")?.status).toBe("pass");
    expect(report.status).toBe("pass");
  });

  test("doctor --json writes directly parseable, sanitized JSON", async () => {
    let output = "";
    const exitCode = await runDoctorCli({
      argv: ["doctor", "--json"],
      write: (text) => {
        output += text;
      },
      doctor: {
        platform: "darwin",
        paths,
        port: 3000,
        probes: probes(),
      },
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(output).checks).toHaveLength(7);
    expect(output).not.toContain(paths.dataDir);
  });
});
