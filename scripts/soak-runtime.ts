import {
  appendFileSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

export const FEISHU_SOAK_SCENARIOS = [
  "group_binding_lifecycle",
  "message_capture",
  "mention_answer",
  "proactive_participation",
  "image_analysis",
  "attachment_extraction",
  "research_notification",
  "reminder_delivery",
  "learning_interaction",
  "distill_citation",
  "network_recovery",
] as const;

export type FeishuSoakScenario = (typeof FEISHU_SOAK_SCENARIOS)[number];

export interface SoakEvidence {
  at: number;
  scenario: FeishuSoakScenario;
  ok: boolean;
  artifactId: string;
}

export interface SoakSample {
  at: number;
  ok: boolean;
  healthStatus?: number;
  readyStatus?: number;
  latencyMs: number;
  instanceId?: string;
  pid?: number;
  error?: string;
}

export interface SoakEvidenceReport {
  checked: boolean;
  passed: boolean;
  accepted: number;
  missing: FeishuSoakScenario[];
  failed: FeishuSoakScenario[];
}

export interface SoakReport {
  startedAt: number;
  finishedAt: number;
  samples: number;
  failures: number;
  failureRate: number;
  maxConsecutiveFailures: number;
  restarts: number;
  maxLatencyMs: number;
  runtimePassed: boolean;
  releaseGate: boolean;
  businessEvidence: SoakEvidenceReport;
  releaseGatePassed: boolean;
}

export interface SoakOptions {
  baseUrl?: string;
  durationMs?: number;
  intervalMs?: number;
  requestTimeoutMs?: number;
  requireReady?: boolean;
  allowedFailureRate?: number;
  allowedConsecutiveFailures?: number;
  allowedRestarts?: number;
  outputPath?: string;
  releaseGate?: boolean;
  evidencePath?: string;
  evidenceRecords?: SoakEvidence[];
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onSample?: (sample: SoakSample) => void;
}

const MIN_RELEASE_SOAK_MS = 24 * 60 * 60_000;

function positive(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be positive`);
  return value;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function failureRate(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error("allowedFailureRate must be between 0 and 1");
  }
  return value;
}

function parseEvidence(value: unknown, label: string): SoakEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const evidence = value as Partial<SoakEvidence>;
  if (typeof evidence.at !== "number" || !Number.isFinite(evidence.at)) {
    throw new Error(`${label}.at must be a number`);
  }
  if (!FEISHU_SOAK_SCENARIOS.includes(evidence.scenario as FeishuSoakScenario)) {
    throw new Error(`${label}.scenario is invalid`);
  }
  if (typeof evidence.ok !== "boolean") throw new Error(`${label}.ok must be boolean`);
  if (
    typeof evidence.artifactId !== "string"
    || !evidence.artifactId.trim()
    || evidence.artifactId.length > 200
    || /[\r\n]/u.test(evidence.artifactId)
  ) {
    throw new Error(`${label}.artifactId must be a short non-empty identifier`);
  }
  return {
    at: evidence.at,
    scenario: evidence.scenario!,
    ok: evidence.ok,
    artifactId: evidence.artifactId,
  };
}

function readEvidence(path: string): SoakEvidence[] {
  return readFileSync(resolve(path), "utf8")
    .split(/\r?\n/u)
    .flatMap((line, index) => {
      if (!line.trim()) return [];
      try {
        return [parseEvidence(JSON.parse(line), `evidence line ${index + 1}`)];
      } catch (error) {
        if (error instanceof SyntaxError) {
          throw new Error(`evidence line ${index + 1} is not valid JSON`);
        }
        throw error;
      }
    });
}

function summarizeEvidence(
  records: SoakEvidence[],
  startedAt: number,
  finishedAt: number,
): SoakEvidenceReport {
  const latest = new Map<FeishuSoakScenario, SoakEvidence>();
  for (const candidate of records) {
    const record = parseEvidence(candidate, "evidence");
    if (record.at < startedAt || record.at > finishedAt) continue;
    const previous = latest.get(record.scenario);
    if (!previous || record.at >= previous.at) latest.set(record.scenario, record);
  }
  const missing = FEISHU_SOAK_SCENARIOS.filter((scenario) => !latest.has(scenario));
  const failed = FEISHU_SOAK_SCENARIOS.filter(
    (scenario) => latest.has(scenario) && !latest.get(scenario)!.ok,
  );
  return {
    checked: true,
    passed: missing.length === 0 && failed.length === 0,
    accepted: latest.size,
    missing,
    failed,
  };
}

export function recordSoakEvidence(
  path: string,
  input: Omit<SoakEvidence, "at"> & { at?: number },
): SoakEvidence {
  const record = parseEvidence(
    { ...input, at: input.at ?? Date.now() },
    "evidence",
  );
  const output = resolve(path);
  mkdirSync(dirname(output), { recursive: true });
  appendFileSync(output, `${JSON.stringify(record)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return record;
}

async function probe(
  baseUrl: string,
  requestTimeoutMs: number,
  fetchImpl: typeof fetch,
  now: () => number,
  requireReady: boolean,
): Promise<SoakSample> {
  const at = now();
  try {
    const healthPromise = fetchImpl(`${baseUrl}/healthz`, {
      cache: "no-store",
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    const readyPromise = requireReady
      ? fetchImpl(`${baseUrl}/readyz`, {
        cache: "no-store",
        signal: AbortSignal.timeout(requestTimeoutMs),
      })
      : undefined;
    const health = await healthPromise;
    const ready = readyPromise ? await readyPromise : undefined;
    const healthBody = await health.json().catch(() => ({})) as {
      instanceId?: unknown;
      pid?: unknown;
    };
    const ok = health.status === 200 && (!ready || ready.status === 200);
    return {
      at,
      ok,
      healthStatus: health.status,
      readyStatus: ready?.status,
      latencyMs: Math.max(0, now() - at),
      instanceId: typeof healthBody.instanceId === "string"
        ? healthBody.instanceId
        : undefined,
      pid: typeof healthBody.pid === "number" ? healthBody.pid : undefined,
      ...(!ok
        ? { error: `health=${health.status}, ready=${ready?.status ?? "skipped"}` }
        : {}),
    };
  } catch (error) {
    return {
      at,
      ok: false,
      latencyMs: Math.max(0, now() - at),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runSoak(options: SoakOptions = {}): Promise<SoakReport> {
  const baseUrl = (options.baseUrl ?? "http://127.0.0.1:3000").replace(/\/+$/u, "");
  const durationMs = positive(options.durationMs ?? MIN_RELEASE_SOAK_MS, "durationMs");
  const intervalMs = positive(options.intervalMs ?? 60_000, "intervalMs");
  const requestTimeoutMs = positive(
    options.requestTimeoutMs ?? 5_000,
    "requestTimeoutMs",
  );
  const requireReady = options.requireReady ?? true;
  const allowedFailureRate = failureRate(options.allowedFailureRate ?? 0.01);
  const allowedConsecutiveFailures = nonNegativeInteger(
    options.allowedConsecutiveFailures ?? 3,
    "allowedConsecutiveFailures",
  );
  const allowedRestarts = nonNegativeInteger(
    options.allowedRestarts ?? 0,
    "allowedRestarts",
  );
  const releaseGate = options.releaseGate ?? false;
  if (releaseGate && durationMs < MIN_RELEASE_SOAK_MS) {
    throw new Error("release gate soak must run for at least 24 hours");
  }
  if (releaseGate && !options.evidencePath && !options.evidenceRecords) {
    throw new Error("release gate soak requires a business evidence file");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? Bun.sleep;
  const startedAt = now();
  const deadline = startedAt + durationMs;
  let samples = 0;
  let failures = 0;
  let consecutiveFailures = 0;
  let maxConsecutiveFailures = 0;
  let restarts = 0;
  let maxLatencyMs = 0;
  let previousInstanceId: string | undefined;

  while (true) {
    const sample = await probe(baseUrl, requestTimeoutMs, fetchImpl, now, requireReady);
    samples += 1;
    maxLatencyMs = Math.max(maxLatencyMs, sample.latencyMs);
    if (sample.ok) {
      consecutiveFailures = 0;
    } else {
      failures += 1;
      consecutiveFailures += 1;
      maxConsecutiveFailures = Math.max(maxConsecutiveFailures, consecutiveFailures);
    }
    if (
      previousInstanceId
      && sample.instanceId
      && sample.instanceId !== previousInstanceId
    ) {
      restarts += 1;
    }
    if (sample.instanceId) previousInstanceId = sample.instanceId;
    if (options.outputPath) {
      const output = resolve(options.outputPath);
      mkdirSync(dirname(output), { recursive: true });
      appendFileSync(output, `${JSON.stringify(sample)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
    }
    options.onSample?.(sample);

    const current = now();
    if (current >= deadline) break;
    await sleep(Math.min(intervalMs, deadline - current));
  }

  const finishedAt = now();
  const observedFailureRate = samples === 0 ? 1 : failures / samples;
  const runtimePassed = observedFailureRate <= allowedFailureRate
    && maxConsecutiveFailures <= allowedConsecutiveFailures
    && restarts <= allowedRestarts;
  const businessEvidence = releaseGate
    ? summarizeEvidence(
      options.evidenceRecords ?? readEvidence(options.evidencePath!),
      startedAt,
      finishedAt,
    )
    : {
      checked: false,
      passed: false,
      accepted: 0,
      missing: [...FEISHU_SOAK_SCENARIOS],
      failed: [],
    };
  return {
    startedAt,
    finishedAt,
    samples,
    failures,
    failureRate: observedFailureRate,
    maxConsecutiveFailures,
    restarts,
    maxLatencyMs,
    runtimePassed,
    releaseGate,
    businessEvidence,
    releaseGatePassed: releaseGate && runtimePassed && businessEvidence.passed,
  };
}

function stringArg(args: string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  if (at < 0) return undefined;
  const value = args[at + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function numberArg(args: string[], flag: string, fallback: number): number {
  const value = stringArg(args, flag);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${flag} must be a number`);
  return parsed;
}

function assertKnownArgs(args: string[], flags: Record<string, "boolean" | "value">): void {
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const kind = flags[arg];
    if (!kind) throw new Error(`unknown argument: ${arg}`);
    if (seen.has(arg)) throw new Error(`duplicate argument: ${arg}`);
    seen.add(arg);
    if (kind === "value") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      index += 1;
    }
  }
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args.includes("--record-evidence")) {
      assertKnownArgs(args, {
        "--record-evidence": "value",
        "--evidence": "value",
        "--artifact-id": "value",
        "--failed": "boolean",
      });
      const scenario = stringArg(args, "--record-evidence") as FeishuSoakScenario | undefined;
      const evidencePath = stringArg(args, "--evidence");
      const artifactId = stringArg(args, "--artifact-id");
      if (!scenario || !evidencePath || !artifactId) {
        throw new Error("--record-evidence requires --evidence and --artifact-id");
      }
      const record = recordSoakEvidence(evidencePath, {
        scenario,
        artifactId,
        ok: !args.includes("--failed"),
      });
      console.log(`Soak evidence recorded: ${JSON.stringify(record)}`);
    } else {
      assertKnownArgs(args, {
        "--base-url": "value",
        "--hours": "value",
        "--interval-seconds": "value",
        "--request-timeout-seconds": "value",
        "--allow-not-ready": "boolean",
        "--max-failure-rate": "value",
        "--max-consecutive-failures": "value",
        "--max-restarts": "value",
        "--output": "value",
        "--release-gate": "boolean",
        "--evidence": "value",
      });
      const report = await runSoak({
        baseUrl: stringArg(args, "--base-url"),
        durationMs: numberArg(args, "--hours", 24) * 60 * 60_000,
        intervalMs: numberArg(args, "--interval-seconds", 60) * 1_000,
        requestTimeoutMs: numberArg(args, "--request-timeout-seconds", 5) * 1_000,
        requireReady: !args.includes("--allow-not-ready"),
        allowedFailureRate: numberArg(args, "--max-failure-rate", 0.01),
        allowedConsecutiveFailures: numberArg(args, "--max-consecutive-failures", 3),
        allowedRestarts: numberArg(args, "--max-restarts", 0),
        outputPath: stringArg(args, "--output"),
        releaseGate: args.includes("--release-gate"),
        evidencePath: stringArg(args, "--evidence"),
        onSample: (sample) => {
          const status = sample.ok ? "ok" : "failure";
          console.log(
            `[${new Date(sample.at).toISOString()}] ${status} `
            + `health=${sample.healthStatus ?? "-"} ready=${sample.readyStatus ?? "-"} `
            + `latency=${sample.latencyMs}ms${sample.error ? ` error=${sample.error}` : ""}`,
          );
        },
      });
      const passed = report.releaseGate ? report.releaseGatePassed : report.runtimePassed;
      console.log(
        `${report.releaseGate ? "Feishu release soak gate" : "Runtime soak"} `
        + `${passed ? "passed" : "failed"}`,
      );
      console.log(JSON.stringify(report, null, 2));
      if (!passed) process.exitCode = 1;
    }
  } catch (error) {
    console.error(`soak: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
