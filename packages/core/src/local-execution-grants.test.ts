import { expect, test } from "bun:test";
import {
  cloneLocalExecutionGrant, isLocalExecutionGrant, normalizeLocalExecutionConfirmation,
  type LocalExecutionGrant,
} from "./local-execution-grants.ts";

const confirmation = () => ({
  termsVersion: 1, source: "authenticated-admin", taskExecutionEnabled: false,
  chatScopes: [{ spaceId: "team/a", policyHash: "a".repeat(64) }],
});
const grant = (): LocalExecutionGrant => ({
  ...normalizeLocalExecutionConfirmation(confirmation()),
  version: 1, id: "local_execution_grant_00000000-0000-4000-8000-000000000000",
  agentId: "agent_test", agentRevisionId: "agent_revision_test", confirmedAt: 10,
});

test("fresh scopes are bounded, cloned, deduplicated and sorted; persisted scopes must already be canonical", () => {
  const input = confirmation();
  input.chatScopes.push({ spaceId: "team/b", policyHash: "b".repeat(64) }, input.chatScopes[0]!);
  input.chatScopes.reverse();
  const canonical = normalizeLocalExecutionConfirmation(input);
  expect(canonical.chatScopes.map(scope => scope.spaceId)).toEqual(["team/a", "team/b"]);
  input.chatScopes[0]!.policyHash = "c".repeat(64);
  expect(canonical.chatScopes[0]!.policyHash).toBe("a".repeat(64));
  expect(isLocalExecutionGrant({ ...grant(), chatScopes: [...canonical.chatScopes].reverse() })).toBe(false);
  expect(isLocalExecutionGrant({ ...grant(), chatScopes: [canonical.chatScopes[0], canonical.chatScopes[0]] })).toBe(false);
  expect(() => normalizeLocalExecutionConfirmation({ ...confirmation(), chatScopes: [
    { spaceId: "team/a", policyHash: "a".repeat(64) }, { spaceId: "team/a", policyHash: "b".repeat(64) },
  ] })).toThrow("范围冲突");
  const full = Array.from({ length: 256 }, (_, i) => ({ spaceId: `team/scope_${i}`, policyHash: "a".repeat(64) }));
  expect(normalizeLocalExecutionConfirmation({ ...confirmation(), chatScopes: full }).chatScopes).toHaveLength(256);
  expect(() => normalizeLocalExecutionConfirmation({ ...confirmation(), chatScopes: [...full, full[0]] })).toThrow();
  const valid = grant();
  const copied = cloneLocalExecutionGrant(valid);
  copied.chatScopes[0]!.policyHash = "d".repeat(64);
  expect(valid.chatScopes[0]!.policyHash).toBe("a".repeat(64));
});

test.each([
  { termsVersion: 2 }, { source: "untrusted-user" }, { taskExecutionEnabled: "true" }, { decidedBy: "admin" },
  { chatScopes: [{ spaceId: "team/a", policyHash: "A".repeat(64) }] },
  { chatScopes: [{ spaceId: "team/a", policyHash: "a".repeat(63) }] },
  { chatScopes: [{ spaceId: "team/a", policyHash: "a".repeat(64), message: "not permitted" }] },
  { chatScopes: [{ spaceId: `team/${"a".repeat(252)}`, policyHash: "a".repeat(64) }] },
  { chatScopes: [{ spaceId: "invalid", policyHash: "a".repeat(64) }] },
])("confirmation rejects unknown or unbounded input: %j", patch => {
  expect(() => normalizeLocalExecutionConfirmation({ ...confirmation(), ...patch })).toThrow("确认无效");
});

test.each([
  { version: 2 }, { id: "local_execution_grant_not-a-uuid" }, { agentId: "../escape" },
  { agentId: "a".repeat(167) }, { agentRevisionId: "invalid" },
  { confirmedAt: -1 }, { confirmedAt: 0.5 }, { confirmedAt: Number.MAX_SAFE_INTEGER + 1 },
  { revokedAt: 9, revocationReason: "operator" }, { revokedAt: 11 },
  { revocationReason: "operator" }, { revokedAt: 11, revocationReason: "untrusted" },
  { source: "arbitrary identity" }, { rawDiagnostics: "not permitted" },
])("persisted grants reject invalid provenance fields: %j", patch => {
  expect(isLocalExecutionGrant({ ...grant(), ...patch })).toBe(false);
});

test("revocation supports only paired bounded audit fields", () => {
  expect(isLocalExecutionGrant(grant())).toBe(true);
  for (const reason of ["operator", "mode-changed", "backup-recovery"]) {
    expect(isLocalExecutionGrant({ ...grant(), revokedAt: 10, revocationReason: reason })).toBe(true);
  }
});
