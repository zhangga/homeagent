import { expect, test } from "bun:test";
import { isProviderPreparationFailure, ProviderPreparationError, providerPreparationFailure, SkillStagingBudget, SKILL_STAGING_MAX_BYTES, SKILL_STAGING_MAX_ENTRIES } from "./provider-preparation.ts";

test("preparation evidence is bounded, cloned, and cannot contain raw diagnostics", () => {
  const failure = { stage: "native-session" as const, reason: "protected-root-readable" as const, exitCode: 75 };
  const error = new ProviderPreparationError(failure);
  failure.exitCode = 1;
  expect(providerPreparationFailure(error)?.stage).toBe("native-session");
  expect(providerPreparationFailure(error)).toEqual({ stage: "native-session", reason: "protected-root-readable", exitCode: 75 });
  expect(isProviderPreparationFailure({ ...failure, stderr: "private" })).toBe(false);
  expect(isProviderPreparationFailure({ ...failure, reason: "private" })).toBe(false);
  expect(providerPreparationFailure(new Error("provider output"))).toBeUndefined();
});

test("execution policy reasons cannot smuggle diagnostics into private or public evidence", () => {
  for (const reason of ["execution-mode-invalid", "local-execution-consent-required", "local-execution-consent-revoked", "managed-policy-disallows-mode"] as const) {
    const failure = { stage: "execution-policy" as const, reason };
    expect(providerPreparationFailure(new ProviderPreparationError(failure))).toEqual(failure);
    expect(isProviderPreparationFailure({ ...failure, exitCode: 75 })).toBe(false);
    expect(isProviderPreparationFailure({ ...failure, stderr: "private" })).toBe(false);
    expect(isProviderPreparationFailure({ ...failure, grantId: "private" })).toBe(false);
  }
  expect(isProviderPreparationFailure({ stage: "execution-policy", reason: "unknown" })).toBe(false);
});

test("catalog capacity includes the boundary and rejects the whole next Skill", () => {
  for (const dimension of ["bytes", "entries"]) {
    const budget = new SkillStagingBudget(2);
    budget.reserve(dimension === "bytes" ? SKILL_STAGING_MAX_BYTES : 0,
      dimension === "entries" ? SKILL_STAGING_MAX_ENTRIES : 0);
    try { budget.reserve(1, 1); throw new Error("expected capacity error"); }
    catch (error) {
      expect(providerPreparationFailure(error)).toEqual({ stage: "skill-staging", reason: "capacity-exceeded", requestedSkills: 2, stagedSkills: 1 });
    }
  }
  expect(() => new SkillStagingBudget(2001)).toThrow();
  expect(() => new SkillStagingBudget(1).reserve(-1, 1)).toThrow();
  expect(isProviderPreparationFailure({ stage: "skill-staging", reason: "capacity-exceeded", requestedSkills: 2, stagedSkills: 2 })).toBe(false);
});
