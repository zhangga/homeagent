import { expect, test } from "bun:test";
import {
  archiveExecutionPlan, cloneStoredExecutionPlan, isArchivedExecutionPlan,
  isResolvedExecutionPlan, type ResolvedExecutionPlan,
} from "./execution-plan.ts";

const fullPlan = (): ResolvedExecutionPlan => ({
  version: 2, agentRevisionId: "agent_revision_published", instruction: "frozen instruction", provider: "codex",
  workdir: "C:\\work\\isolated-fixture", execution: { permission: "full", executionMode: "local-full-access", workdir: "C:\\work\\isolated-fixture", skills: [] },
  localExecution: { grantId: "local_execution_grant_00000000-0000-4000-8000-000000000001", kind: "chat",
    scope: { spaceId: "team/oc_plan", policyHash: "a".repeat(64) } },
});

test("v2 full plans freeze typed local authorization while legacy plans retain their exact shape", () => {
  const plan = fullPlan();
  expect(isResolvedExecutionPlan(plan)).toBe(true);
  for (const invalid of [
    { ...plan, localExecution: undefined }, { ...plan, agentRevisionId: undefined },
    { ...plan, localExecution: { ...plan.localExecution, grantId: "bogus" } },
    { ...plan, localExecution: { ...plan.localExecution, scope: { spaceId: "team/a", policyHash: "bad" } } },
    { ...plan, provider: "claude" }, { ...plan, version: 3 },
    { ...plan, execution: { ...plan.execution, executionMode: "unknown" } },
    { ...plan, execution: { ...plan.execution, permission: "write" } },
    { ...plan, localExecution: { grantId: plan.localExecution!.grantId, kind: "task", scope: { spaceId: "team/a", policyHash: "a".repeat(64) } } },
  ]) expect(isResolvedExecutionPlan(invalid)).toBe(false);
  expect(isResolvedExecutionPlan({ ...plan, localExecution: { grantId: plan.localExecution!.grantId, kind: "task" } })).toBe(true);
  const legacy = { version: 1, instruction: "old", provider: "codex", execution: { permission: "full", workdir: "C:\\old", skills: [] } };
  expect(isResolvedExecutionPlan(legacy)).toBe(true);
  if (!isResolvedExecutionPlan(legacy)) throw new Error("invalid fixture");
  expect(cloneStoredExecutionPlan(legacy)).toEqual(legacy);
  expect(isResolvedExecutionPlan({ ...legacy, localExecution: plan.localExecution })).toBe(false);
});

test("an explicit archive DTO retains intent but never local authorization or executability", () => {
  const plan = fullPlan();
  const archived = archiveExecutionPlan(plan);
  expect(isArchivedExecutionPlan(archived)).toBe(true);
  expect(isResolvedExecutionPlan(archived)).toBe(false);
  expect(archived.execution?.executionMode).toBe("local-full-access");
  expect(JSON.stringify(archived)).not.toContain("local_execution_grant_");
  expect(JSON.stringify(archived)).not.toContain("policyHash");
  expect(isArchivedExecutionPlan({ ...archived, localExecution: plan.localExecution })).toBe(false);
  expect(cloneStoredExecutionPlan(archived)).toEqual(archived);
});
