/**
 * Call logging + daily cost observability.
 *
 * Every gateway or local-CLI call appends one JSON line to data/logs/llm-YYYY-MM-DD.jsonl.
 * The tracker sums today's known spend and reports incomplete accounting. Cost
 * references are deliberately observe-only: Provider calls must not be rejected
 * because a configured amount was reached.
 */
import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "@homeagent/shared";
import type { CompletionUsage, ProviderId } from "./providers.ts";

/** Why a call is being made — groups cost observations by workload. */
export type CallPurpose = "ask" | "distill" | "classify" | "other";

export interface CallRecord {
  t: string;
  model: string;
  purpose: CallPurpose;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  /** Honest provider usage; absent on legacy records written before usage provenance. */
  usage?: CompletionUsage;
  provider?: ProviderId;
  space?: string;
  ok: boolean;
  ms: number;
}

/** Local YYYY-MM-DD in Asia/Shanghai, the operating timezone for the accounting day. */
export function localDay(d = new Date()): string {
  // en-CA gives ISO-like YYYY-MM-DD formatting.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function logDir(dataDir = config().dataDir): string {
  return join(dataDir, "logs");
}

function logPath(day = localDay(), dataDir = config().dataDir): string {
  return join(logDir(dataDir), `llm-${day}.jsonl`);
}

export function recordCall(rec: CallRecord, dataDir = config().dataDir): void {
  mkdirSync(logDir(dataDir), { recursive: true });
  appendFileSync(logPath(localDay(), dataDir), JSON.stringify(rec) + "\n", "utf8");
}

export interface UsageSpendSummary {
  knownCostUsd: number;
  knownCostCalls: number;
  unknownCostCalls: number;
  totalCalls: number;
}

/** Report known spend and explicit unknown-cost coverage for today's calls. */
export function usageSpendToday(
  day = localDay(),
  dataDir = config().dataDir,
): UsageSpendSummary {
  const path = logPath(day, dataDir);
  const summary: UsageSpendSummary = {
    knownCostUsd: 0,
    knownCostCalls: 0,
    unknownCostCalls: 0,
    totalCalls: 0,
  };
  if (!existsSync(path)) return summary;
  const text = readFileSync(path, "utf8");
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as CallRecord;
      summary.totalCalls += 1;
      const cost = rec.usage?.costUsd ?? rec.costUsd;
      if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) {
        summary.knownCostUsd += cost;
        summary.knownCostCalls += 1;
      } else {
        summary.unknownCostCalls += 1;
      }
    } catch {
      // ignore malformed lines; a partial write should not break accounting
    }
  }
  return summary;
}

/** Sum only known reported/estimated USD spend; inspect usageSpendToday for coverage. */
export function spentToday(day = localDay(), dataDir = config().dataDir): number {
  return usageSpendToday(day, dataDir).knownCostUsd;
}

export interface BudgetDecision {
  allowed: boolean;
  /** True only for a compatibility decision supplied by an external enforcing client. */
  enforced: boolean;
  referenceExceeded: boolean;
  spent: number;
  budget: number;
  unknownCostCalls: number;
  accountingComplete: boolean;
  reason?: string;
  warning?: string;
}

/**
 * Report the current daily cost reference without gating a Provider call.
 *
 * The historical purpose thresholds remain visible for cost diagnosis, but
 * `allowed` is always true. Runtime stability and completion take priority over
 * cost admission until an explicit enforcement mode is designed and enabled.
 */
export function checkBudget(
  purpose: CallPurpose,
  budget = config().dailyBudgetUsd,
  dataDir = config().dataDir,
): BudgetDecision {
  const spend = usageSpendToday(localDay(), dataDir);
  const spent = spend.knownCostUsd;
  const deferrable = purpose === "distill" || purpose === "other";
  const limit = deferrable ? budget : budget * 1.5;
  const referenceExceeded = budget > 0 && spent >= limit;
  const warnings = [
    spend.unknownCostCalls > 0
      ? `${spend.unknownCostCalls} call(s) have unknown cost; daily cost accounting is incomplete`
      : undefined,
    referenceExceeded
      ? `daily cost reference exceeded: $${spent.toFixed(4)} >= $${limit.toFixed(2)} for purpose=${purpose}`
      : undefined,
  ].filter((warning): warning is string => warning !== undefined);
  const coverage = {
    unknownCostCalls: spend.unknownCostCalls,
    accountingComplete: spend.unknownCostCalls === 0,
    ...(warnings.length > 0 ? { warning: warnings.join("; ") } : {}),
  };
  return {
    allowed: true,
    enforced: false,
    referenceExceeded,
    spent,
    budget,
    ...coverage,
  };
}

/**
 * Compatibility error for an external or legacy enforcing client. HomeAgent's
 * built-in clients never raise it from the observe-only daily cost reference.
 */
export class BudgetExceededError extends Error {
  constructor(public decision: BudgetDecision) {
    super(decision.reason ?? "provider cost admission rejected");
    this.name = "BudgetExceededError";
  }
}
