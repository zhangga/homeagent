import { ProviderPreparationError } from "./provider-preparation.ts";

export type CodexExecutionMode = "isolated" | "local-full-access";
export type CodexExecutionPolicy =
  | { mode: "isolated"; filesystemProof: "required"; sandbox: "permission-profile" }
  | { mode: "isolated"; filesystemProof: "not-native"; sandbox: "read-only" | "workspace-write" }
  | { mode: "local-full-access"; filesystemProof: "not-applicable"; sandbox: "danger-full-access" };

export function isCodexExecutionMode(value: unknown): value is CodexExecutionMode {
  return value === "isolated" || value === "local-full-access";
}

/** Select parameters, never authorization. Core must authorize each model launch. */
export function resolveCodexExecutionPolicy(
  execution: { executionMode?: CodexExecutionMode; permission: "read-only" | "write" | "full" } | undefined,
  topic: boolean,
): CodexExecutionPolicy {
  const mode = execution?.executionMode;
  const permission = execution ? execution.permission : "read-only";
  if (!["read-only", "write", "full"].some(value => value === permission)
    || (mode !== undefined && !isCodexExecutionMode(mode))
    || (mode === "local-full-access" && permission !== "full")
    || (mode === "isolated" && permission === "full")) {
    throw new ProviderPreparationError({ stage: "execution-policy", reason: "execution-mode-invalid" });
  }
  if (mode === "local-full-access") {
    return { mode, filesystemProof: "not-applicable", sandbox: "danger-full-access" };
  }
  if (permission === "full") {
    throw new ProviderPreparationError({ stage: "execution-policy", reason: "local-execution-consent-required" });
  }
  if (topic) return { mode: "isolated", filesystemProof: "required", sandbox: "permission-profile" };
  return { mode: "isolated", filesystemProof: "not-native", sandbox: permission === "write" ? "workspace-write" : "read-only" };
}
