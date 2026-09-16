import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { AI_OPERATION_TIMEOUT_MS, config } from "@homeagent/shared";
import { codexPreparationIdentity, providerPreparationFailure, resolveCodexExecutionPolicy, type CodexExecutionMode, type ProviderPreparationFailure } from "@homeagent/llm";
import { resolveAgentExecution, resolveAgentWorkdir, type AgentStore } from "./agents.ts";
import type { SkillCatalog } from "./skill-catalog.ts";
import type { LocalExecutionAuthorizations } from "./local-execution-scopes.ts";
import type { EngineOptions } from "./engine.ts";

export interface AgentReadinessSnapshot {
  state: "unknown" | "checking" | "ready" | "unavailable";
  mode?: CodexExecutionMode;
  sandboxCheck: "passed" | "failed" | "not-applicable" | "not-checked";
  modelCall: "not-verified";
  reason?: "not-checked" | "expired" | "configuration-changed" | "check-failed" | "busy" | "closed";
  failure?: ProviderPreparationFailure;
  checkedAt?: number;
  expiresAt?: number;
}

type Context = { key: string; configurationKey: string; mode?: CodexExecutionMode; failure?: ProviderPreparationFailure; grantId?: string };
type Cached = { key: string; configurationKey: string; skillKey?: string; value: AgentReadinessSnapshot };
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export interface AgentReadinessOptions {
  agents: AgentStore; skills: SkillCatalog; localExecution: LocalExecutionAuthorizations;
  dataDir: string; preflight: NonNullable<EngineOptions["nativeSessionPreflight"]>;
  now?: () => number;
  providerIdentity?: () => string;
}

/** Bounded diagnostic cache, never execution authority. Reads never start a Provider process. */
export class AgentReadiness {
  private readonly cache = new Map<string, Cached>();
  private readonly running = new Map<string, { promise: Promise<AgentReadinessSnapshot | undefined>; controller: AbortController; context: Context }>();
  private generation = 0;
  private closed = false;
  constructor(private readonly options: AgentReadinessOptions) {}

  private now(): number { return (this.options.now ?? Date.now)(); }
  private context(id: string): Context | undefined {
    const agent = this.options.agents.get(id);
    if (!agent || agent.provider !== "codex") return undefined;
    const mode = agent.executionMode ?? (agent.permission === "full" ? undefined : "isolated");
    let directory: unknown;
    try {
      const workdir = resolveAgentWorkdir(agent);
      const stat = workdir ? lstatSync(workdir) : undefined;
      directory = [workdir, stat?.dev, stat?.ino, stat?.birthtimeMs];
    } catch { directory = "invalid"; }
    const grants = this.options.agents.listLocalExecutionGrants(id).filter(grant => grant.agentRevisionId === agent.publishedRevisionId);
    let failure: ProviderPreparationFailure | undefined;
    try { resolveCodexExecutionPolicy({ ...resolveAgentExecution(agent), executionMode: mode }, true); }
    catch { failure = { stage: "execution-policy", reason: "execution-mode-invalid" }; }
    let scope: unknown;
    const grant = grants[0];
    try {
      const preview = this.options.localExecution.preview(id);
      scope = preview.fingerprint;
      if (mode === "local-full-access") {
        if (grant?.revokedAt !== undefined) failure = { stage: "execution-policy", reason: "local-execution-consent-revoked" };
        else if (!grant || preview.chatScopes.some(item => !this.options.localExecution.referenceFor(item.spaceId, id, agent.publishedRevisionId!, "chat"))) {
          failure = { stage: "execution-policy", reason: "local-execution-consent-required" };
        }
      }
    } catch { scope = "invalid"; failure = { stage: "execution-policy", reason: "execution-mode-invalid" }; }
    let identity: string;
    try { identity = (this.options.providerIdentity ?? codexPreparationIdentity)(); }
    catch { identity = "unknown"; failure = { stage: "native-session", reason: "native-cli-unavailable" }; }
    const configurationKey = hash([agent, grants, scope, directory, identity, this.generation, config().defaultProvider, config().defaultModel]);
    return { mode, failure, grantId: grant?.id, configurationKey, key: hash([configurationKey, this.options.skills.cachedSnapshotVersion()]) };
  }

  private unknown(context: Context, reason: AgentReadinessSnapshot["reason"]): AgentReadinessSnapshot {
    return { state: "unknown", mode: context.mode, sandboxCheck: context.mode === "local-full-access" ? "not-applicable" : "not-checked", modelCall: "not-verified", reason };
  }

  status(id: string): AgentReadinessSnapshot | undefined {
    const context = this.context(id);
    if (!context) return undefined;
    if (this.closed) return this.unknown(context, "closed");
    if (context.failure) return { ...this.unknown(context, "check-failed"), state: "unavailable", failure: context.failure };
    const active = this.running.get(id);
    if (active?.context.configurationKey === context.configurationKey && !active.controller.signal.aborted) {
      return { ...this.unknown(context, undefined), state: "checking" };
    }
    const cached = this.cache.get(id);
    if (cached?.key !== context.key) return this.unknown(context, cached ? "configuration-changed" : "not-checked");
    if (this.now() >= (cached.value.expiresAt ?? 0) || this.now() < (cached.value.checkedAt ?? 0)) return this.unknown(context, "expired");
    return structuredClone(cached.value);
  }

  check(id: string): Promise<AgentReadinessSnapshot | undefined> {
    const active = this.running.get(id);
    if (active) return active.promise;
    const context = this.context(id);
    if (!context || this.closed || context.failure) return Promise.resolve(this.status(id));
    if (this.running.size >= 2) return Promise.resolve(this.unknown(context, "busy"));
    const controller = new AbortController();
    const task = this.perform(id, context, controller).finally(() => this.running.delete(id));
    this.running.set(id, { promise: task, controller, context });
    return task;
  }

  private async perform(id: string, context: Context, controller: AbortController): Promise<AgentReadinessSnapshot | undefined> {
    const agent = this.options.agents.get(id)!;
    let failure: ProviderPreparationFailure | undefined;
    let failed = false;
    let skillKey: string | undefined;
    const release = this.options.localExecution.retain(context.grantId ? { grantId: context.grantId, kind: "task" } : undefined);
    let stop = () => {};
    try {
      stop = this.options.localExecution.watch(() => {
        if (this.closed || this.context(id)?.configurationKey !== context.configurationKey) throw new Error("Readiness context changed");
      }, () => controller.abort());
      this.options.skills.refresh();
      const resolved = this.options.skills.resolveAll("codex");
      const inputs = this.options.skills.executionInputs(resolved.resolved);
      skillKey = hash([resolved.resolved, inputs]);
      const execution = { ...resolveAgentExecution(agent), executionMode: context.mode, skillMode: "all" as const, skills: resolved.resolved.map(skill => skill.invocationName) };
      await this.options.preflight("codex", AI_OPERATION_TIMEOUT_MS, controller.signal, execution.workdir, execution, inputs, this.options.dataDir);
      if (controller.signal.aborted) throw new Error("Readiness cancelled");
      this.options.skills.refresh();
      const latest = this.options.skills.resolveAll("codex");
      const latestInputs = this.options.skills.executionInputs(latest.resolved);
      if (skillKey !== hash([latest.resolved, latestInputs])) throw new Error("Skill configuration changed");
      // Refreshing for another Agent must not discard an unchanged shared catalog.
      // Preserve the original configuration key and expiry: this is not a new proof.
      for (const cached of this.cache.values()) {
        if (cached.skillKey === skillKey) cached.key = hash([cached.configurationKey, this.options.skills.cachedSnapshotVersion()]);
      }
    } catch (error) { failed = true; failure = providerPreparationFailure(error); }
    finally { stop(); release(); }
    const current = this.context(id);
    if (!current || this.closed) return this.status(id);
    if (controller.signal.aborted || current.configurationKey !== context.configurationKey) return this.unknown(current, "configuration-changed");
    const checkedAt = this.now();
    const isolationFailed = failure?.stage === "native-session" && ["windows-elevated-sandbox-required", "protected-root-readable", "codex-home-readable",
      "allowed-path-unreadable", "filesystem-probe-timeout", "filesystem-probe-failed"].includes(failure.reason);
    const value: AgentReadinessSnapshot = { state: failed ? "unavailable" : "ready", mode: context.mode,
      sandboxCheck: context.mode === "local-full-access" ? "not-applicable" : isolationFailed ? "failed" : failed ? "not-checked" : "passed",
      modelCall: "not-verified", checkedAt, expiresAt: checkedAt + 60_000,
      ...(failed ? { reason: "check-failed", ...(failure ? { failure } : {}) } : {}) };
    if (this.cache.size >= 256) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(id, { key: current.key, configurationKey: current.configurationKey, skillKey, value });
    return structuredClone(value);
  }

  /** Login/settings recovery invalidates both cached results and in-flight probes. */
  invalidate(): void {
    this.generation++;
    this.cache.clear();
    for (const active of this.running.values()) active.controller.abort();
  }
  close(): void { this.closed = true; this.invalidate(); }
}
