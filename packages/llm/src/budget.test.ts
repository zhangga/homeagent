import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetConfig } from "@homeagent/shared";
import {
  checkBudget,
  recordCall,
  spentToday,
  usageSpendToday,
  localDay,
} from "./budget.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hb-budget-"));
  process.env.HOMEAGENT_DATA_DIR = dir;
  process.env.HOMEAGENT_DAILY_BUDGET_USD = "5";
  resetConfig();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.HOMEAGENT_DATA_DIR;
  delete process.env.HOMEAGENT_DAILY_BUDGET_USD;
  resetConfig();
});

function seed(costUsd: number) {
  recordCall({
    t: new Date().toISOString(),
    model: "claude-sonnet-5",
    purpose: "distill",
    inputTokens: 0,
    outputTokens: 0,
    costUsd,
    ok: true,
    ms: 1,
  });
}

describe("budget", () => {
  test("localDay is YYYY-MM-DD", () => {
    expect(localDay()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("spentToday sums recorded costs", () => {
    expect(spentToday()).toBe(0);
    seed(1.25);
    seed(0.75);
    expect(spentToday()).toBeCloseTo(2.0, 5);
  });

  test("reports unknown-cost calls instead of presenting them as complete zero spend", () => {
    recordCall({
      t: new Date().toISOString(),
      model: "gpt-5.6-sol",
      purpose: "distill",
      usage: { costBasis: "unavailable", source: "codex-jsonl" },
      provider: "codex",
      ok: true,
      ms: 1,
    });

    expect(usageSpendToday()).toEqual({
      knownCostUsd: 0,
      knownCostCalls: 0,
      unknownCostCalls: 1,
      totalCalls: 1,
    });
    expect(checkBudget("distill")).toEqual(expect.objectContaining({
      allowed: true,
      spent: 0,
      unknownCostCalls: 1,
      accountingComplete: false,
      warning: expect.stringContaining("unknown cost"),
    }));
  });

  test("explicit dataDir isolates recording and budget checks", () => {
    const isolated = join(dir, "isolated");
    recordCall({
      t: new Date().toISOString(),
      model: "claude-sonnet-5",
      purpose: "distill",
      costUsd: 1,
      ok: true,
      ms: 1,
    }, isolated);

    expect(spentToday()).toBe(0);
    expect(spentToday(localDay(), isolated)).toBe(1);
    expect(checkBudget("distill", 1, isolated).allowed).toBe(false);
  });

  test("distill is blocked at the cap", () => {
    seed(5.0);
    const d = checkBudget("distill");
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain("budget");
  });

  test("ask gets grace headroom past the cap", () => {
    seed(5.0);
    // deferrable blocked, but ask allowed until 1.5x
    expect(checkBudget("distill").allowed).toBe(false);
    expect(checkBudget("ask").allowed).toBe(true);
    seed(3.0); // now 8.0 >= 7.5 grace limit
    expect(checkBudget("ask").allowed).toBe(false);
  });

  test("tolerates malformed log lines", async () => {
    const { config } = require("@homeagent/shared");
    const logs = join(config().dataDir, "logs");
    mkdirSync(logs, { recursive: true });
    await Bun.write(join(logs, `llm-${localDay()}.jsonl`), "not json\n{bad}\n");
    // spentToday should not throw; may be 0
    expect(() => spentToday()).not.toThrow();
  });
});
