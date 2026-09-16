import { expect, test } from "bun:test";
import { pruneLocalExecutionGrants } from "./local-execution-retention.ts";
import { MAX_LOCAL_EXECUTION_GRANT_BYTES, type LocalExecutionGrant } from "./local-execution-grants.ts";

const grant = (n: number): LocalExecutionGrant => ({
  version: 1, id: `local_execution_grant_00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  agentId: `agent_${Math.floor(n / 100)}`, agentRevisionId: `agent_revision_${n}`, confirmedAt: n,
  termsVersion: 1, source: "local-operator", chatScopes: [], taskExecutionEnabled: true,
});
const table = (size: number) => new Map(Array.from({ length: size }, (_, n) => {
  const value = grant(n); return [value.id, value] as const;
}));
const bytes = (value: Map<string, LocalExecutionGrant>) => Buffer.byteLength(JSON.stringify(Object.fromEntries(value)), "utf8");

test("global count allows exactly 10000 grants and evicts the oldest unprotected record only under pressure", () => {
  const candidate = table(10_000);
  pruneLocalExecutionGrants(candidate, () => { throw new Error("no pressure: must not scan Run stores"); });
  expect(candidate.size).toBe(10_000);
  const extra = grant(10_000); candidate.set(extra.id, extra);
  pruneLocalExecutionGrants(candidate, () => new Set([grant(0).id, extra.id]));
  expect(candidate.size).toBe(10_000);
  expect(candidate.has(grant(0).id)).toBe(true);
  expect(candidate.has(grant(1).id)).toBe(false);
  expect(candidate.has(extra.id)).toBe(true);
});

test("byte pressure removes only enough old grants for compact UTF-8 capacity and keeps protected scopes", () => {
  const candidate = table(300);
  for (const value of candidate.values()) {
    value.chatScopes = Array.from({ length: 256 }, (_, n) => ({ spaceId: `team/${String(n).padStart(3, "0")}_${"a".repeat(200)}`, policyHash: "b".repeat(64) }));
  }
  expect(bytes(candidate)).toBeGreaterThan(MAX_LOCAL_EXECUTION_GRANT_BYTES);
  const first = candidate.get(grant(0).id)!;
  const protectedScopes = structuredClone(first.chatScopes);
  pruneLocalExecutionGrants(candidate, () => new Set([first.id]));
  expect(bytes(candidate)).toBeLessThanOrEqual(MAX_LOCAL_EXECUTION_GRANT_BYTES);
  expect(candidate.get(first.id)?.chatScopes).toEqual(protectedScopes);
  expect(candidate.has(grant(1).id)).toBe(false);
  // One more equal-sized entry no longer fits: cleanup did not discard extra records.
  candidate.set(grant(1).id, { ...grant(1), chatScopes: protectedScopes });
  expect(bytes(candidate)).toBeGreaterThan(MAX_LOCAL_EXECUTION_GRANT_BYTES);
});

test("per-Agent pressure is resolved before global pressure without evicting an unrelated current Agent", () => {
  const candidate = table(10_000);
  const extra = { ...grant(10_000), agentId: "agent_99" }; candidate.set(extra.id, extra);
  pruneLocalExecutionGrants(candidate, () => new Set([extra.id]));
  expect(candidate.size).toBe(10_000);
  expect(candidate.has(grant(0).id)).toBe(true);
  expect(candidate.has(grant(9900).id)).toBe(false);
  expect([...candidate.values()].filter(value => value.agentId === "agent_99")).toHaveLength(100);
});

test("malformed retention references are refused without exposing reader diagnostics", () => {
  const candidate = table(10_001);
  expect(() => pruneLocalExecutionGrants(candidate, () => new Set(["invalid"]))).toThrow("无法安全清理");
  expect(candidate.size).toBe(10_001);
});
