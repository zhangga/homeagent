import { createHash } from "node:crypto";
import type { SpaceId } from "@homeagent/shared";
import { AgentStore, agentVisibleInSpace } from "./agents.ts";
import { SpaceRegistry } from "./registry.ts";
import { FeishuGroupBindingStore } from "./feishu-bindings.ts";
import { isExecutionScopeEpoch } from "./execution-identities.ts";
import { isLocalExecutionReference, type LocalExecutionReference } from "./execution-plan.ts";
import {
  normalizeLocalExecutionConfirmation,
  type LocalExecutionChatScope,
  type LocalExecutionConfirmation,
} from "./local-execution-grants.ts";

export interface LocalExecutionScopePreview {
  chatScopes: LocalExecutionChatScope[];
  fingerprint: string;
}

/** Source is supplied by the trusted caller, never copied from an HTTP form. */
export interface ConfirmLocalExecutionScopes extends Omit<LocalExecutionConfirmation, "chatScopes"> {
  expectedScopeFingerprint: string;
}

const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Derives consent from durable bindings; callers cannot authorize arbitrary scopes. */
export class LocalExecutionAuthorizations {
  private closed = false;
  private readonly cancellations = new Set<() => void>();
  private readonly retained = new Map<string, number>();
  constructor(
    private readonly agents: AgentStore,
    private readonly registry: SpaceRegistry,
    private readonly bindings: FeishuGroupBindingStore,
  ) {}

  /** Retention is not authorization. Every actual invocation still validates the durable grant. */
  retain(reference: LocalExecutionReference | undefined): () => void {
    if (!reference) return () => {};
    if (this.closed || !isLocalExecutionReference(reference)) throw new Error("本机执行引用不可用");
    const id = reference.grantId;
    this.retained.set(id, (this.retained.get(id) ?? 0) + 1);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const count = this.retained.get(id) ?? 0;
      if (count > 1) this.retained.set(id, count - 1); else this.retained.delete(id);
    };
  }

  referencedGrantIds(): Set<string> | undefined {
    return this.closed ? undefined : new Set(this.retained.keys());
  }

  /** Sync validation and registration share the same event-loop turn as Store commits. */
  watch(validate: () => void, cancel: () => void): () => void {
    validate();
    if (this.closed) throw new Error("Local execution authorizations are closed");
    let active = true;
    const subscriptions: (() => void)[] = [];
    const stop = () => {
      active = false;
      this.cancellations.delete(invalidate);
      for (const unsubscribe of subscriptions) unsubscribe();
    };
    const invalidate = () => {
      if (!active) return;
      stop();
      cancel();
    };
    const recheck = () => {
      if (!active) return;
      try { validate(); }
      catch {
        invalidate();
      }
    };
    for (const store of [this.agents, this.registry, this.bindings]) {
      subscriptions.push(store.onCommittedChange(recheck));
    }
    this.cancellations.add(invalidate);
    return stop;
  }

  close(): void {
    this.closed = true;
    for (const cancel of [...this.cancellations]) {
      try { cancel(); } catch { /* Continue cancelling other owned processes. */ }
    }
  }

  scopeFor(space: SpaceId, agentId: string, revisionId?: string): LocalExecutionChatScope | undefined {
    const agent = this.agents.get(agentId);
    const revision = agent && this.agents.listRevisions(agentId)
      .find(item => item.id === (revisionId ?? agent.publishedRevisionId));
    const meta = this.registry.get(space);
    if (!agent || !revision || !agentVisibleInSpace({ ...agent, visibility: revision.snapshot.visibility }, space)
      || meta?.agentId !== agentId || !isExecutionScopeEpoch(meta.agentBindingEpoch)) return undefined;
    const identity = { version: 1, spaceId: space, agentId, agentBindingEpoch: meta.agentBindingEpoch };
    if (space.startsWith("personal/")) return { spaceId: space, policyHash: hash({ ...identity, kind: "personal" }) };
    const binding = this.bindings.getBySpace(space);
    if (binding?.state !== "active" || !binding.boundAppId || !isExecutionScopeEpoch(binding.executionScopeEpoch)
      || (meta.chatId !== undefined && meta.chatId !== binding.chatId)) return undefined;
    return { spaceId: space, policyHash: hash({
      ...identity, kind: "team", executionScopeEpoch: binding.executionScopeEpoch,
      boundAppId: binding.boundAppId, chatId: binding.chatId, responseMode: binding.responseMode,
      participationLevel: binding.participationLevel ?? null, replyInThread: binding.replyInThread,
    }) };
  }

  preview(agentId: string, revisionId?: string): LocalExecutionScopePreview {
    if (!this.agents.get(agentId)) throw new Error("Agent 不存在");
    if (revisionId !== undefined && !this.agents.listRevisions(agentId).some(revision => revision.id === revisionId)) {
      throw new Error("Agent 版本不存在");
    }
    const chatScopes = this.registry.listByAgent(agentId).flatMap(meta => {
      const scope = this.scopeFor(meta.id, agentId, revisionId);
      return scope ? [scope] : [];
    });
    const normalized = normalizeLocalExecutionConfirmation({
      termsVersion: 1, source: "local-operator", taskExecutionEnabled: false, chatScopes,
    }).chatScopes;
    return { chatScopes: normalized, fingerprint: hash({ version: 1, agentId, chatScopes: normalized }) };
  }

  /** Freeze an existing grant; this never creates consent or approves a Task. */
  referenceFor(space: SpaceId, agentId: string, revisionId: string, kind: "chat" | "task"): LocalExecutionReference | undefined {
    const grant = this.agents.listLocalExecutionGrants(agentId)
      .find(item => item.agentRevisionId === revisionId && item.revokedAt === undefined);
    if (!grant) return undefined;
    const reference: LocalExecutionReference | undefined = kind === "task"
      ? { grantId: grant.id, kind: "task" }
      : (() => {
          const scope = this.scopeFor(space, agentId, revisionId);
          return scope ? { grantId: grant.id, kind: "chat", scope } : undefined;
        })();
    return reference && this.validateReference(space, agentId, revisionId, kind, reference) ? reference : undefined;
  }

  /** Compare frozen scope, current route and the persisted grant, without replacing any frozen choice. */
  validateReference(space: SpaceId, agentId: string, revisionId: string, kind: "chat" | "task", reference: unknown): boolean {
    if (this.closed || !isLocalExecutionReference(reference) || reference.kind !== kind || !this.registry.has(space)) return false;
    const agent = this.agents.get(agentId);
    const revision = this.agents.listRevisions(agentId).find(item => item.id === revisionId && item.source !== "draft");
    if (!agent || !revision || !agentVisibleInSpace({ ...agent, visibility: revision.snapshot.visibility }, space)) return false;
    const grant = this.agents.listLocalExecutionGrants(agentId).find(item => item.id === reference.grantId);
    if (!grant || grant.revokedAt !== undefined || grant.agentRevisionId !== revisionId) return false;
    if (reference.kind === "task") return grant.taskExecutionEnabled;
    const current = this.scopeFor(space, agentId, revisionId);
    return current !== undefined && reference.scope.spaceId === space && reference.scope.policyHash === current.policyHash
      && grant.chatScopes.some(scope => scope.spaceId === space && scope.policyHash === current.policyHash);
  }

  release(agentId: string, draftId: string, expectedHeadId: string, confirmation: ConfirmLocalExecutionScopes) {
    const consent = this.confirm(agentId, draftId, confirmation);
    // No asynchronous boundary between deriving the scope and atomic Agent publication.
    return this.agents.release(agentId, draftId, expectedHeadId, consent);
  }

  rollback(agentId: string, revisionId: string, expectedHeadId: string, confirmation: ConfirmLocalExecutionScopes) {
    return this.agents.rollback(agentId, revisionId, expectedHeadId, this.confirm(agentId, revisionId, confirmation));
  }

  private confirm(agentId: string, revisionId: string, confirmation: ConfirmLocalExecutionScopes): LocalExecutionConfirmation {
    const current = this.preview(agentId, revisionId);
    if (typeof confirmation?.expectedScopeFingerprint !== "string"
      || !/^[0-9a-f]{64}$/.test(confirmation.expectedScopeFingerprint)
      || current.fingerprint !== confirmation.expectedScopeFingerprint) throw new Error("绑定范围已变化，请重新确认");
    return normalizeLocalExecutionConfirmation({
      termsVersion: confirmation.termsVersion, source: confirmation.source,
      taskExecutionEnabled: confirmation.taskExecutionEnabled, chatScopes: current.chatScopes,
    });
  }
}
