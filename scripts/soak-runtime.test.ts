import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FEISHU_SOAK_SCENARIOS,
  recordSoakEvidence,
  runSoak,
} from "./soak-runtime.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function response(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("runtime soak monitor", () => {
  test("requires group binding lifecycle evidence for release", () => {
    expect(FEISHU_SOAK_SCENARIOS).toContain("group_binding_lifecycle");
  });

  test("passes a stable ready runtime over repeated samples", async () => {
    let now = 0;
    const report = await runSoak({
      durationMs: 2_000,
      intervalMs: 1_000,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      fetchImpl: async (input) => String(input).endsWith("/healthz")
        ? response(200, { instanceId: "instance-a", pid: 42 })
        : response(200, { ready: true }),
    });

    expect(report).toEqual(expect.objectContaining({
      samples: 3,
      failures: 0,
      maxConsecutiveFailures: 0,
      restarts: 0,
      runtimePassed: true,
      releaseGate: false,
      releaseGatePassed: false,
    }));
  });

  test("fails when readiness outages exceed the configured bounds", async () => {
    let now = 0;
    const report = await runSoak({
      durationMs: 1_000,
      intervalMs: 1_000,
      allowedFailureRate: 0,
      allowedConsecutiveFailures: 0,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      fetchImpl: async (input) => String(input).endsWith("/healthz")
        ? response(200, { instanceId: "instance-a" })
        : response(503, { ready: false }),
    });

    expect(report.failures).toBe(2);
    expect(report.maxConsecutiveFailures).toBe(2);
    expect(report.runtimePassed).toBeFalse();
  });

  test("counts process replacements even when both instances are healthy", async () => {
    let now = 0;
    let healthCalls = 0;
    const report = await runSoak({
      durationMs: 1_000,
      intervalMs: 1_000,
      allowedRestarts: 0,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      fetchImpl: async (input) => {
        if (!String(input).endsWith("/healthz")) return response(200, { ready: true });
        healthCalls += 1;
        return response(200, {
          instanceId: healthCalls === 1 ? "instance-a" : "instance-b",
        });
      },
    });

    expect(report.restarts).toBe(1);
    expect(report.runtimePassed).toBeFalse();
  });

  test("does not request readiness when readiness is explicitly optional", async () => {
    let now = 0;
    const requested: string[] = [];
    const report = await runSoak({
      durationMs: 1,
      intervalMs: 1,
      requireReady: false,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      fetchImpl: async (input) => {
        requested.push(String(input));
        return response(200, { instanceId: "instance-a" });
      },
    });

    expect(requested.every((url) => url.endsWith("/healthz"))).toBeTrue();
    expect(report.runtimePassed).toBeTrue();
  });

  test("rejects zero duration and release gates shorter than 24 hours", async () => {
    await expect(runSoak({ durationMs: 0 })).rejects.toThrow("durationMs must be positive");
    await expect(runSoak({
      durationMs: 60_000,
      releaseGate: true,
      evidenceRecords: [],
    })).rejects.toThrow("at least 24 hours");
  });

  test("a release gate requires current successful evidence for every Feishu scenario", async () => {
    let now = 0;
    const durationMs = 24 * 60 * 60_000;
    const evidenceRecords = FEISHU_SOAK_SCENARIOS.map((scenario) => ({
      at: 1,
      scenario,
      ok: scenario !== "network_recovery",
      artifactId: `artifact-${scenario}`,
    }));
    const report = await runSoak({
      durationMs,
      intervalMs: durationMs,
      releaseGate: true,
      evidenceRecords,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      fetchImpl: async (input) => String(input).endsWith("/healthz")
        ? response(200, { instanceId: "instance-a" })
        : response(200, { ready: true }),
    });

    expect(report.runtimePassed).toBeTrue();
    expect(report.businessEvidence.failed).toEqual(["network_recovery"]);
    expect(report.releaseGatePassed).toBeFalse();
  });

  test("reads operator-recorded evidence from the release JSONL file", async () => {
    const root = mkdtempSync(join(tmpdir(), "homeagent-soak-evidence-"));
    roots.push(root);
    const evidencePath = join(root, "evidence.jsonl");
    for (const scenario of FEISHU_SOAK_SCENARIOS) {
      recordSoakEvidence(evidencePath, {
        at: 1,
        scenario,
        ok: true,
        artifactId: `artifact-${scenario}`,
      });
    }
    let now = 0;
    const durationMs = 24 * 60 * 60_000;
    const report = await runSoak({
      durationMs,
      intervalMs: durationMs,
      releaseGate: true,
      evidencePath,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      fetchImpl: async (input) => String(input).endsWith("/healthz")
        ? response(200, { instanceId: "instance-a" })
        : response(200, { ready: true }),
    });

    expect(report.businessEvidence.accepted).toBe(FEISHU_SOAK_SCENARIOS.length);
    expect(report.releaseGatePassed).toBeTrue();
  });
});
