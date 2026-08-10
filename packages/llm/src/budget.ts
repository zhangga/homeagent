/**
 * Call logging + daily budget enforcement.
 *
 * Every gateway or local-CLI call appends one JSON line to data/logs/llm-YYYY-MM-DD.jsonl.
 * The budget tracker sums today's estimated spend and blocks new calls once the
 * cap is hit. Blocking is *advisory by purpose*: the orchestrator passes a
 * `purpose` so that answering (user-facing) can be prioritized while distillation
 * (deferrable) is shed first when the budget is tight.
 */
import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "@homeagent/shared";
import type { CompletionUsage, ProviderId } from "./providers.ts";

/** Why a call is being made — drives budget prioritization. */
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

/** Local YYYY-MM-DD in Asia/Shanghai, the operating timezone for the budget day. */
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
  spent: number;
  budget: number;
  unknownCostCalls: number;
  accountingComplete: boolean;
  reason?: string;
  warning?: string;
}

/**
 * Decide whether a call of `purpose` may proceed under today's budget.
 *
 * Deferrable purposes (distill) are shed at the full cap. User-facing purposes
 * (ask, classify) get a grace multiplier so a conversation is never cut off
 * mid-answer purely by the soft budget — the cap primarily throttles the
 * expensive batch distillation.
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
  const coverage = {
    unknownCostCalls: spend.unknownCostCalls,
    accountingComplete: spend.unknownCostCalls === 0,
    ...(spend.unknownCostCalls > 0
      ? { warning: `${spend.unknownCostCalls} call(s) have unknown cost; the USD budget is not fully enforceable` }
      : {}),
  };
  if (spent >= limit) {
    return {
      allowed: false,
      spent,
      budget,
      ...coverage,
      reason: `daily budget ${deferrable ? "" : "(grace) "}exhausted: $${spent.toFixed(
        4,
      )} >= $${limit.toFixed(2)} for purpose=${purpose}`,
    };
  }
  return { allowed: true, spent, budget, ...coverage };
}

/** Raised when a call is blocked by the budget. Callers may downgrade/defer. */
export class BudgetExceededError extends Error {
  constructor(public decision: BudgetDecision) {
    super(decision.reason ?? "daily budget exceeded");
    this.name = "BudgetExceededError";
  }
}
