import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStore } from "./agents.ts";
import { SpaceRegistry } from "./registry.ts";
import { FeishuGroupBindingStore } from "./feishu-bindings.ts";
import { LocalExecutionAuthorizations } from "./local-execution-scopes.ts";

let dir: string;
beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), "ha-execution-scopes-"))); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("transient retention counts independent callers, is idempotent, and never grants execution authority", () => {
  const agents = new AgentStore(dir);
  const registry = new SpaceRegistry(dir);
  const authority = new LocalExecutionAuthorizations(agents, registry, new FeishuGroupBindingStore(dir));
  const reference = { kind: "task" as const, grantId: `local_execution_grant_${randomUUID()}` };
  try {
    const first = authority.retain(reference);
    const second = authority.retain(reference);
    expect(authority.referencedGrantIds()).toEqual(new Set([reference.grantId]));
    authority.referencedGrantIds()!.clear();
    first(); first();
    expect(authority.referencedGrantIds()).toEqual(new Set([reference.grantId]));
    expect(authority.validateReference("personal/a", "agent_missing", "agent_revision_missing", "task", reference)).toBe(false);
    second();
    expect(authority.referencedGrantIds()?.size).toBe(0);
    authority.close();
    expect(authority.referencedGrantIds()).toBeUndefined();
    expect(() => authority.retain(reference)).toThrow("引用不可用");
  } finally { authority.close(); registry.closeAll(); }
});

test("scope previews keep the exact 256-Space boundary and reject overflow instead of truncating consent", () => {
  const agents = new AgentStore(dir);
  const agent = agents.create({ provider: "codex", visibility: "Personal" });
  const bindings = new FeishuGroupBindingStore(dir);
  const spaces = Object.fromEntries(Array.from({ length: 256 }, (_, index) => {
    const id = `personal/user_${index}`;
    return [id, { id, createdAt: 1, agentId: agent.id, agentBindingEpoch: randomUUID() }];
  }));
  const path = join(dir, "config", "spaces.json");
  writeFileSync(path, JSON.stringify({ version: 1, spaces }));
  expect(new LocalExecutionAuthorizations(agents, new SpaceRegistry(dir), bindings).preview(agent.id).chatScopes).toHaveLength(256);
  spaces["personal/overflow"] = { id: "personal/overflow", createdAt: 1, agentId: agent.id, agentBindingEpoch: randomUUID() };
  writeFileSync(path, JSON.stringify({ version: 1, spaces }));
  expect(() => new LocalExecutionAuthorizations(agents, new SpaceRegistry(dir), bindings).preview(agent.id)).toThrow();
});

test("personal scopes use only their own durable Agent binding, including the target revision visibility", () => {
  const agents = new AgentStore(dir);
  const registry = new SpaceRegistry(dir);
  const bindings = new FeishuGroupBindingStore(dir);
const authority = new LocalExecutionAuthorizations(agents, registry, bindings);
  try {
    const agent = agents.create({ provider: "codex", visibility: "Personal" });
    for (const space of ["personal/z", "personal/a", "team/a"] as const) {
      registry.ensure(space); registry.updateMeta(space, { agentId: agent.id });
    }
    const preview = authority.preview(agent.id);
    expect(preview.chatScopes.map(scope => scope.spaceId)).toEqual(["personal/a", "personal/z"]);
    preview.chatScopes[0]!.policyHash = "0".repeat(64);
    expect(authority.preview(agent.id).chatScopes[0]!.policyHash).not.toBe("0".repeat(64));
    bindings.connect({ chatId: "oc_unrelated", spaceId: "team/unrelated", boundAppId: "cli_app", responseMode: "all_messages", replyInThread: false });
    const first = authority.scopeFor("personal/a", agent.id)!;
    expect(first).toEqual(authority.preview(agent.id).chatScopes[0]!);
    expect(authority.scopeFor("team/a", agent.id)).toBeUndefined();
    const draft = agents.saveDraft(agent.id, { visibility: "Team" })!;
    expect(authority.preview(agent.id, draft.id).chatScopes).toEqual([]);
    expect(authority.scopeFor("personal/a", agent.id, draft.id)).toBeUndefined();
    registry.updateMeta("personal/a", { agentId: "" });
    registry.updateMeta("personal/a", { agentId: agent.id });
    expect(authority.scopeFor("personal/a", agent.id)).not.toEqual(first);
    agents.remove(agent.id);
    expect(authority.scopeFor("personal/a", agent.id)).toBeUndefined();
  } finally { registry.closeAll(); }
});

test("binding save followed by a failed grant publication remains unconfirmed, and rollback uses a fresh preview", () => {
  const data = join(dir, "data");
  const workdir = join(dir, "work"); mkdirSync(workdir);
  const agents = new AgentStore(data);
  const registry = new SpaceRegistry(data);
  const bindings = new FeishuGroupBindingStore(data);
  const authority = new LocalExecutionAuthorizations(agents, registry, bindings);
  try {
    const agent = agents.create({ provider: "codex", visibility: "Personal" });
    registry.ensure("personal/a"); registry.updateMeta("personal/a", { agentId: agent.id });
    const draft = agents.saveDraft(agent.id, { executionMode: "local-full-access", permission: "full", workdir })!;
    const confirm = () => ({ termsVersion: 1 as const, source: "local-operator" as const, taskExecutionEnabled: false,
      expectedScopeFingerprint: authority.preview(agent.id).fingerprint });
    const path = join(data, "config", "agents.json");
    renameSync(path, `${path}.saved`); mkdirSync(path);
    try { expect(() => authority.release(agent.id, draft.id, draft.id, confirm())).toThrow(); }
    finally { rmSync(path, { recursive: true }); renameSync(`${path}.saved`, path); }
    expect(new SpaceRegistry(data).get("personal/a")?.agentId).toBe(agent.id);
    expect(agents.get(agent.id)?.publishedRevisionId).toBe(agent.publishedRevisionId);
    expect(new AgentStore(data).listLocalExecutionGrants(agent.id)).toEqual([]);
    const released = authority.release(agent.id, draft.id, draft.id, confirm())!;
    const rolledBack = authority.rollback(agent.id, released.publishedRevisionId!, released.publishedRevisionId!, confirm())!;
    expect(rolledBack.publishedRevisionId).not.toBe(released.publishedRevisionId);
    expect(agents.listLocalExecutionGrants(agent.id)).toHaveLength(2);
    expect(() => authority.rollback(agent.id, released.publishedRevisionId!, released.publishedRevisionId!, confirm())).toThrow();
  } finally { registry.closeAll(); }
});

test("publication binds actual durable scopes and stale confirmation cannot approve changed bindings", () => {
  const data = join(dir, "data");
  const workdir = join(dir, "work"); mkdirSync(workdir);
  const agents = new AgentStore(data);
  const registry = new SpaceRegistry(data);
  const bindings = new FeishuGroupBindingStore(data);
  const authority = new LocalExecutionAuthorizations(agents, registry, bindings);
  const space = "team/oc_scope" as const;
  try {
    const agent = agents.create({ provider: "codex" });
    registry.ensure(space, { chatId: "oc_scope" });
    registry.updateMeta(space, { agentId: agent.id });
    const connection = { chatId: "oc_scope", spaceId: space, boundAppId: "cli_test", responseMode: "mentions_only" as const, replyInThread: true };
    bindings.connect(connection);
    const preview = authority.preview(agent.id);
    expect(preview.chatScopes).toHaveLength(1);
    expect(preview.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    const draft = agents.saveDraft(agent.id, { executionMode: "local-full-access", permission: "full", workdir })!;
    bindings.updatePolicy(space, { responseMode: "all_messages" });
    const confirmation = { termsVersion: 1 as const, source: "local-operator" as const, taskExecutionEnabled: true, expectedScopeFingerprint: preview.fingerprint };
    expect(() => authority.release(agent.id, draft.id, draft.id, confirmation)).toThrow("范围已变化");
    expect(agents.get(agent.id)?.publishedRevisionId).toBe(agent.publishedRevisionId);
    expect(agents.listLocalExecutionGrants(agent.id)).toEqual([]);
    bindings.updatePolicy(space, { responseMode: "mentions_only" });
    expect(authority.preview(agent.id).fingerprint).not.toBe(preview.fingerprint);
    const current = authority.preview(agent.id);
    authority.release(agent.id, draft.id, draft.id, { ...confirmation, expectedScopeFingerprint: current.fingerprint });
    expect(agents.listLocalExecutionGrants(agent.id)[0]!.chatScopes).toEqual(current.chatScopes);
    const revision = agents.get(agent.id)!.publishedRevisionId!;
    const chatReference = authority.referenceFor(space, agent.id, revision, "chat")!;
    expect(chatReference.kind).toBe("chat");
    expect(authority.validateReference(space, agent.id, revision, "chat", chatReference)).toBe(true);
    expect(authority.validateReference(space, agent.id, revision, "task", chatReference)).toBe(false);
    expect(authority.referenceFor(space, agent.id, revision, "task")?.kind).toBe("task");
    expect(authority.referenceFor("team/unbound", agent.id, revision, "chat")).toBeUndefined();
    registry.updateMeta(space, { name: "new display name" });
    bindings.recordTest(space, { status: "succeeded" });
    expect(authority.preview(agent.id)).toEqual(current);
    bindings.disconnect(space);
    expect(authority.validateReference(space, agent.id, revision, "chat", chatReference)).toBe(false);
    expect(authority.scopeFor(space, agent.id)).toBeUndefined();
    bindings.connect(connection);
    expect(authority.scopeFor(space, agent.id)?.policyHash).not.toBe(current.chatScopes[0]!.policyHash);
    expect(authority.referenceFor(space, agent.id, revision, "chat")).toBeUndefined();
    agents.revokeLocalExecutionGrants(agent.id, revision);
    expect(authority.referenceFor(space, agent.id, revision, "task")).toBeUndefined();
  } finally { registry.closeAll(); }
});

test("an in-flight authorization is cancelled only after durable revocation, and cannot be reacquired", () => {
  const data = join(dir, "data");
  const workdir = join(dir, "work"); mkdirSync(workdir);
  const agents = new AgentStore(data);
  const registry = new SpaceRegistry(data);
  const bindings = new FeishuGroupBindingStore(data);
  const authority = new LocalExecutionAuthorizations(agents, registry, bindings);
  try {
    const space = "personal/permit" as const;
    const agent = agents.create({ provider: "codex", visibility: "Personal" });
    registry.ensure(space); registry.updateMeta(space, { agentId: agent.id });
    const draft = agents.saveDraft(agent.id, { executionMode: "local-full-access", permission: "full", workdir })!;
    const published = authority.release(agent.id, draft.id, draft.id, {
      termsVersion: 1, source: "local-operator", taskExecutionEnabled: false,
      expectedScopeFingerprint: authority.preview(agent.id, draft.id).fingerprint,
    })!;
    const revision = published.publishedRevisionId!;
    const reference = authority.referenceFor(space, agent.id, revision, "chat")!;
    const validate = () => {
      if (!authority.validateReference(space, agent.id, revision, "chat", reference)) throw new Error("revoked");
    };
    let cancelled = 0;
    const unwatch = authority.watch(validate, () => { cancelled++; });
    const path = join(data, "config", "agents.json");
    renameSync(path, `${path}.saved`); mkdirSync(path);
    try { expect(() => agents.revokeLocalExecutionGrants(agent.id, revision)).toThrow(); }
    finally { rmSync(path, { recursive: true }); renameSync(`${path}.saved`, path); }
    expect(cancelled).toBe(0);
    registry.updateMeta(space, { name: "display only" });
    expect(cancelled).toBe(0);
    agents.revokeLocalExecutionGrants(agent.id, revision);
    expect(cancelled).toBe(1);
    expect(() => authority.watch(validate, () => { cancelled++; })).toThrow("revoked");
    unwatch(); unwatch();
    registry.updateMeta(space, { agentId: "" });
    expect(cancelled).toBe(1);
  } finally { registry.closeAll(); }
});
