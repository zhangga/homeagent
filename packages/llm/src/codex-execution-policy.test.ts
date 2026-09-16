import { expect, test } from "bun:test";
import { resolveCodexExecutionPolicy } from "./codex-execution-policy.ts";
import { providerPreparationFailure } from "./provider-preparation.ts";

test("explicit full access never requests a filesystem proof, including topic routing", () => {
  expect(resolveCodexExecutionPolicy({ executionMode: "local-full-access", permission: "full" }, true))
    .toEqual({ mode: "local-full-access", filesystemProof: "not-applicable", sandbox: "danger-full-access" });
});

test.each([false, true])("restricted permissions keep their original boundary (topic=%s)", topic => {
  for (const permission of ["read-only", "write"] as const) {
    for (const executionMode of [undefined, "isolated"] as const) {
      expect(resolveCodexExecutionPolicy({ permission, executionMode }, topic)).toEqual(topic
        ? { mode: "isolated", filesystemProof: "required", sandbox: "permission-profile" }
        : { mode: "isolated", filesystemProof: "not-native", sandbox: permission === "write" ? "workspace-write" : "read-only" });
    }
  }
  expect(resolveCodexExecutionPolicy(undefined, topic).mode).toBe("isolated");
});

test.each([false, true])("invalid and legacy full configurations cannot infer consent (topic=%s)", topic => {
  for (const permission of ["read-only", "write"] as const) {
    expect(() => resolveCodexExecutionPolicy({ permission, executionMode: "local-full-access" }, topic))
      .toThrow("execution-mode-invalid");
  }
  expect(() => resolveCodexExecutionPolicy({ permission: "full", executionMode: "isolated" }, topic))
    .toThrow("execution-mode-invalid");
  try {
    resolveCodexExecutionPolicy({ permission: "full" }, topic);
    throw new Error("expected legacy full rejection");
  } catch (error) {
    expect(providerPreparationFailure(error)).toEqual({ stage: "execution-policy", reason: "local-execution-consent-required" });
  }
});

test("unknown mode and permission values are rejected at runtime", () => {
  for (const raw of [
    {},
    { executionMode: "future", permission: "read-only" },
    { executionMode: "isolated", permission: "admin" },
    { executionMode: ["local-full-access"], permission: "full" },
  ]) {
    expect(() => Reflect.apply(resolveCodexExecutionPolicy, undefined, [raw, false])).toThrow("execution-mode-invalid");
  }
});
