import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStore } from "./agents.ts";
import { randomUUID } from "node:crypto";

let root: string;
let dataDir: string;
let workdir: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ha-local-grants-")));
  dataDir = join(root, "data");
  workdir = join(root, "work");
  mkdirSync(workdir);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const confirmation = () => ({
  termsVersion: 1 as const,
  source: "local-operator" as const,
  chatScopes: [{ spaceId: "team/oc_local" as const, policyHash: "a".repeat(64) }],
  taskExecutionEnabled: true,
});

function publishFull(store: AgentStore, id: string) {
  const head = store.listRevisions(id)[0]!;
  const draft = store.saveDraft(id, { executionMode: "local-full-access", permission: "full", workdir }, head.id)!;
  return store.release(id, draft.id, draft.id, confirmation())!;
}

function blockPrimary(): () => void {
  const path = join(dataDir, "config", "agents.json");
  const original = `${path}.saved`;
  renameSync(path, original);
  mkdirSync(path);
  return () => { rmSync(path, { recursive: true }); renameSync(original, path); };
}

test("a full-access draft is inert and explicit publication atomically binds a local grant to its new revision", () => {
  const store = new AgentStore(dataDir);
  const created = store.create({ name: "Windows Agent", provider: "codex" });
  const full = { executionMode: "local-full-access", permission: "full", workdir };
  const draft = store.saveDraft(created.id, full, created.publishedRevisionId)!;
  expect(draft.snapshot.executionMode).toBe("local-full-access");
  expect(store.get(created.id)).toEqual(created);
  expect(store.listLocalExecutionGrants(created.id)).toEqual([]);
  expect(() => store.release(created.id, draft.id, draft.id)).toThrow("本机完全访问确认");

  const released = store.release(created.id, draft.id, draft.id, confirmation())!;
  const [grant] = store.listLocalExecutionGrants(created.id);
  expect(grant).toMatchObject({
    version: 1, agentId: created.id, agentRevisionId: released.publishedRevisionId,
    termsVersion: 1, source: "local-operator", chatScopes: confirmation().chatScopes, taskExecutionEnabled: true,
  });
  expect(grant?.id).toMatch(/^local_execution_grant_[0-9a-f-]{36}$/);
  expect(store.listRevisions(created.id)[0]?.snapshot).not.toHaveProperty("localExecutionGrantId");
  const reopened = new AgentStore(dataDir);
  expect(reopened.get(created.id)).toEqual(released);
  expect(reopened.listLocalExecutionGrants(created.id)).toEqual([grant!]);
});

test("revocation survives restart, switching to isolated revokes every older grant, and rollback needs fresh consent", () => {
  const store = new AgentStore(dataDir);
  const initial = store.create({ name: "Windows Agent", provider: "codex" });
  const first = publishFull(store, initial.id);
  const second = publishFull(store, initial.id);
  expect(store.listLocalExecutionGrants(initial.id)).toHaveLength(2);
  expect(store.revokeLocalExecutionGrants(initial.id, second.publishedRevisionId!)).toBe(2);
  expect(new AgentStore(dataDir).listLocalExecutionGrants(initial.id).every(grant => grant.revokedAt !== undefined)).toBe(true);
  const third = publishFull(store, initial.id);
  const draft = store.saveDraft(initial.id, { executionMode: "isolated", permission: "write" }, third.publishedRevisionId)!;
  const isolated = store.release(initial.id, draft.id, draft.id)!;
  expect(store.listLocalExecutionGrants(initial.id).every(grant => grant.revokedAt !== undefined)).toBe(true);
  expect(() => store.rollback(initial.id, first.publishedRevisionId!, isolated.publishedRevisionId)).toThrow("本机完全访问确认");
  const rolledBack = store.rollback(initial.id, first.publishedRevisionId!, isolated.publishedRevisionId, confirmation())!;
  expect(rolledBack.publishedRevisionId).not.toBe(first.publishedRevisionId);
  const active = store.listLocalExecutionGrants(initial.id).filter(grant => grant.revokedAt === undefined);
  expect(active).toHaveLength(1);
  expect(active[0]?.agentRevisionId).toBe(rolledBack.publishedRevisionId);
  store.remove(initial.id);
  expect(new AgentStore(dataDir).listLocalExecutionGrants(initial.id)).toEqual([]);
});

test.each(["missing", "data-root", "parent", "codex-home", "relative"])("publication refuses an invalid full Workdir: %s", (kind) => {
  const previousHome = process.env.HOMEAGENT_CODEX_HOME;
  const codexHome = join(root, "codex-home");
  mkdirSync(codexHome);
  process.env.HOMEAGENT_CODEX_HOME = codexHome;
  try {
    const store = new AgentStore(dataDir);
    const agent = store.create({ provider: "codex" });
    const candidate = kind === "missing" ? join(root, "missing") : kind === "data-root" ? dataDir
      : kind === "parent" ? root : kind === "codex-home" ? codexHome : ".";
    const draft = store.saveDraft(agent.id, { executionMode: "local-full-access", permission: "full", workdir: candidate })!;
    expect(() => store.release(agent.id, draft.id, draft.id, confirmation())).toThrow("execution-mode-invalid");
    expect(store.get(agent.id)).toEqual(agent);
    expect(store.listLocalExecutionGrants(agent.id)).toEqual([]);
  } finally {
    if (previousHome === undefined) delete process.env.HOMEAGENT_CODEX_HOME; else process.env.HOMEAGENT_CODEX_HOME = previousHome;
  }
});

test("failed publication or revocation never changes the durable grant or the in-memory revision", () => {
  const store = new AgentStore(dataDir);
  const agent = store.create({ provider: "codex" });
  const draft = store.saveDraft(agent.id, { executionMode: "local-full-access", permission: "full", workdir })!;
  const restorePrimary = blockPrimary();
  try {
    expect(() => store.release(agent.id, draft.id, draft.id, confirmation())).toThrow();
    expect(store.get(agent.id)).toEqual(agent);
    expect(store.listRevisions(agent.id)[0]).toEqual(draft);
    expect(store.listLocalExecutionGrants(agent.id)).toEqual([]);
  } finally { restorePrimary(); }
  expect(new AgentStore(dataDir).listLocalExecutionGrants(agent.id)).toEqual([]);
  const released = store.release(agent.id, draft.id, draft.id, confirmation())!;
  const before = store.listLocalExecutionGrants(agent.id);
  const restoreAgain = blockPrimary();
  try {
    expect(() => store.revokeLocalExecutionGrants(agent.id, released.publishedRevisionId!)).toThrow();
    expect(store.listLocalExecutionGrants(agent.id)).toEqual(before);
  } finally { restoreAgain(); }
  expect(new AgentStore(dataDir).listLocalExecutionGrants(agent.id)).toEqual(before);
});

test("a stale backup can recover history but cannot revive a grant after primary revocation", () => {
  const store = new AgentStore(dataDir);
  const agent = publishFull(store, store.create({ provider: "codex" }).id);
  const primary = join(dataDir, "config", "agents.json");
  const backup = `${primary}.bak`;
  renameSync(backup, `${backup}.stale`);
  mkdirSync(backup);
  expect(store.revokeLocalExecutionGrants(agent.id, agent.publishedRevisionId!)).toBe(1);
  expect(store.listLocalExecutionGrants(agent.id)[0]?.revocationReason).toBe("operator");
  rmSync(backup, { recursive: true });
  renameSync(`${backup}.stale`, backup);
  writeFileSync(primary, "{injected corruption");
  const recovered = new AgentStore(dataDir);
  expect(recovered.get(agent.id)).toEqual(agent);
  expect(recovered.listLocalExecutionGrants(agent.id)[0]?.revocationReason).toBe("backup-recovery");
  expect(new AgentStore(dataDir).listLocalExecutionGrants(agent.id)).toEqual(recovered.listLocalExecutionGrants(agent.id));
});

test("backup recovery must durably revoke grants before a store can be opened", () => {
  const store = new AgentStore(dataDir);
  const agent = publishFull(store, store.create({ provider: "codex" }).id);
  const restorePrimary = blockPrimary();
  try { expect(() => new AgentStore(dataDir)).toThrow(); } finally { restorePrimary(); }
  expect(new AgentStore(dataDir).listLocalExecutionGrants(agent.id)[0]?.revokedAt).toBeUndefined();
});

test.each([
  { provider: "codex", executionMode: "isolated", permission: "full" },
  { provider: "codex", executionMode: "local-full-access", permission: "read-only" },
  { provider: "codex", executionMode: "local-full-access", permission: "write" },
  { provider: "codex", executionMode: "unknown", permission: "full" },
  { provider: "codex", permission: "full" },
  { provider: "claude", executionMode: "local-full-access", permission: "full" },
  { provider: "trae-cli", executionMode: "isolated", permission: "write" },
])("new configurations reject an invalid mode/permission pair: %j", input => {
  const store = new AgentStore(dataDir);
  expect(() => store.create({ ...input, workdir })).toThrow("执行模式");
  const agent = store.create({ provider: "codex" });
  expect(() => store.saveDraft(agent.id, { ...input, workdir })).toThrow("执行模式");
  expect(store.listRevisions(agent.id)).toHaveLength(1);
});

test("legacy v4 full intent migrates without changing snapshots or manufacturing consent", () => {
  const store = new AgentStore(dataDir);
  const agent = store.create({ provider: "claude", permission: "full", workdir });
  const primary = join(dataDir, "config", "agents.json");
  const legacy = JSON.parse(readFileSync(primary, "utf8"));
  legacy.version = 4;
  delete legacy.localExecutionGrants;
  legacy.agents[agent.id].provider = "codex";
  legacy.revisions[agent.id][0].snapshot.provider = "codex";
  writeFileSync(primary, JSON.stringify(legacy));
  const migrated = new AgentStore(dataDir);
  expect(migrated.get(agent.id)?.permission).toBe("full");
  expect(migrated.get(agent.id)).not.toHaveProperty("executionMode");
  expect(migrated.listRevisions(agent.id)).toEqual(legacy.revisions[agent.id]);
  expect(migrated.listLocalExecutionGrants(agent.id)).toEqual([]);
  expect(JSON.parse(readFileSync(primary, "utf8")).version).toBe(5);
});

test("confirmation is cloned, stale heads fail, and compatibility updates cannot mint authority", () => {
  const store = new AgentStore(dataDir);
  const agent = store.create({ provider: "codex", executionMode: "local-full-access", permission: "full", workdir });
  expect(store.listLocalExecutionGrants(agent.id)).toEqual([]);
  const draft = store.saveDraft(agent.id, { instruction: "new publication" })!;
  expect(() => store.release(agent.id, draft.id, agent.publishedRevisionId, confirmation())).toThrow("版本已变化");
  const consent = confirmation();
  const released = store.release(agent.id, draft.id, draft.id, consent)!;
  consent.chatScopes[0]!.policyHash = "b".repeat(64);
  const granted = store.listLocalExecutionGrants(agent.id);
  granted[0]!.chatScopes[0]!.policyHash = "c".repeat(64);
  expect(store.listLocalExecutionGrants(agent.id)[0]!.chatScopes).toEqual(confirmation().chatScopes);
  const updated = store.update(agent.id, { instruction: "compatibility update" })!;
  expect(store.listLocalExecutionGrants(agent.id).map(grant => grant.agentRevisionId)).toEqual([released.publishedRevisionId!]);
  expect(() => store.revokeLocalExecutionGrants(agent.id, released.publishedRevisionId!)).toThrow("版本已变化");
  expect(store.get(agent.id)).toEqual(updated);
});

function seedGrantCapacity() {
  const store = new AgentStore(dataDir);
  const agent = publishFull(store, store.create({ provider: "codex" }).id);
  const primary = join(dataDir, "config", "agents.json");
  const persisted = JSON.parse(readFileSync(primary, "utf8"));
  const template = store.listLocalExecutionGrants(agent.id)[0]!;
  const history = store.listRevisions(agent.id);
  for (let i = 0; i < 99; i++) {
    const revision = { ...history[0]!, id: `agent_revision_${randomUUID()}`, number: history.length + 1, basedOnRevisionId: history[0]!.id };
    history.unshift(revision);
    const grant = { ...template, id: `local_execution_grant_${randomUUID()}`, agentRevisionId: revision.id };
    persisted.localExecutionGrants[grant.id] = grant;
  }
  persisted.revisions[agent.id] = history;
  persisted.agents[agent.id].publishedRevisionId = history[0]!.id;
  writeFileSync(primary, JSON.stringify(persisted));
  return agent.id;
}

test("grant retention refuses a 101st publication without a trusted reference reader", () => {
  const agentId = seedGrantCapacity();
  const bounded = new AgentStore(dataDir);
  expect(bounded.listLocalExecutionGrants(agentId)).toHaveLength(100);
  const draft = bounded.saveDraft(agentId, { instruction: "capacity test" })!;
  expect(() => bounded.release(agentId, draft.id, draft.id, confirmation())).toThrow("超过上限");
  expect(bounded.listRevisions(agentId)[0]).toEqual(draft);
  expect(new AgentStore(dataDir).listLocalExecutionGrants(agentId)).toHaveLength(100);
});

test("publication prunes only an unreferenced old grant and commits retention with the new revision", () => {
  const agentId = seedGrantCapacity();
  const protectedIds = new Set<string>();
  const store = new AgentStore(dataDir, { referencedLocalExecutionGrantIds: () => protectedIds });
  const before = store.listLocalExecutionGrants(agentId);
  const oldHead = store.get(agentId)!.publishedRevisionId;
  const removable = before.find(grant => grant.agentRevisionId !== oldHead)!;
  for (const grant of before) if (grant.id !== removable.id) protectedIds.add(grant.id);
  const published = publishFull(store, agentId);
  const retained = store.listLocalExecutionGrants(agentId);
  expect(retained).toHaveLength(100);
  expect(retained.some(grant => grant.id === removable.id)).toBe(false);
  expect(retained.filter(grant => protectedIds.has(grant.id))).toHaveLength(99);
  expect(retained.some(grant => grant.agentRevisionId === published.publishedRevisionId)).toBe(true);
  const reopened = new AgentStore(dataDir);
  expect(reopened.listLocalExecutionGrants(agentId)).toEqual(retained);
  expect(reopened.listRevisions(agentId).some(revision => revision.id === removable.agentRevisionId)).toBe(true);
});

test.each(["referenced", "current-publication", "unknown", "reader-error"])("retention fails closed when records are protected or references are %s", kind => {
  const agentId = seedGrantCapacity();
  const initial = new AgentStore(dataDir);
  const before = initial.listLocalExecutionGrants(agentId);
  const current = initial.get(agentId)!.publishedRevisionId;
  const store = new AgentStore(dataDir, { referencedLocalExecutionGrantIds: () => {
    if (kind === "unknown") return undefined;
    if (kind === "reader-error") throw new Error("private reference diagnostics");
    return new Set(before.filter(grant => kind !== "current-publication" || grant.agentRevisionId !== current).map(grant => grant.id));
  } });
  const draft = store.saveDraft(agentId, { instruction: "capacity test" })!;
  expect(() => store.release(agentId, draft.id, draft.id, confirmation())).toThrow("无法安全清理");
  expect(store.get(agentId)?.publishedRevisionId).toBe(current);
  expect(new AgentStore(dataDir).listLocalExecutionGrants(agentId)).toEqual(before);
});

test("retention and rollback are one commit: failed writes neither evict authority nor notify consumers", () => {
  const agentId = seedGrantCapacity();
  const store = new AgentStore(dataDir, { referencedLocalExecutionGrantIds: () => new Set() });
  const before = store.listLocalExecutionGrants(agentId);
  const revisions = store.listRevisions(agentId);
  const head = store.get(agentId)!;
  let notifications = 0;
  const stop = store.onCommittedChange(() => { notifications++; });
  const restorePrimary = blockPrimary();
  try {
    expect(() => store.rollback(agentId, before[0]!.agentRevisionId, head.publishedRevisionId, confirmation())).toThrow();
    expect(store.listLocalExecutionGrants(agentId)).toEqual(before);
    expect(store.listRevisions(agentId)).toEqual(revisions);
    expect(notifications).toBe(0);
  } finally { restorePrimary(); stop(); }
  expect(new AgentStore(dataDir).listLocalExecutionGrants(agentId)).toEqual(before);
  const rolledBack = store.rollback(agentId, before[0]!.agentRevisionId, head.publishedRevisionId, confirmation())!;
  const after = new AgentStore(dataDir).listLocalExecutionGrants(agentId);
  expect(after).toHaveLength(100);
  expect(after.some(grant => grant.agentRevisionId === head.publishedRevisionId)).toBe(true);
  expect(after.some(grant => grant.agentRevisionId === rolledBack.publishedRevisionId)).toBe(true);
  expect(store.listRevisions(agentId)).toHaveLength(revisions.length + 1);
});

test.each(["count", "bytes"])("grant tables reject oversized %s before validating individual records", kind => {
  const store = new AgentStore(dataDir);
  store.create({ provider: "codex" });
  const primary = join(dataDir, "config", "agents.json");
  const invalid = JSON.parse(readFileSync(primary, "utf8"));
  invalid.localExecutionGrants = kind === "count"
    ? Object.fromEntries(Array.from({ length: 10_001 }, (_, i) => [`invalid_${i}`, null]))
    : { oversized: "x".repeat(16 * 1024 * 1024) };
  writeFileSync(primary, JSON.stringify(invalid));
  writeFileSync(`${primary}.bak`, JSON.stringify(invalid));
  expect(() => new AgentStore(dataDir)).toThrow("确认集合超过上限");
});

test.each(["draft", "wrong-revision", "wrong-agent", "wrong-space", "timestamp", "duplicate-revision"])("reopen rejects grant/revision provenance mismatch: %s", kind => {
  const store = new AgentStore(dataDir);
  const agent = publishFull(store, store.create({ provider: "codex" }).id);
  const primary = join(dataDir, "config", "agents.json");
  const invalid = JSON.parse(readFileSync(primary, "utf8"));
  const valid = store.listLocalExecutionGrants(agent.id)[0]!;
  const candidate = invalid.localExecutionGrants[valid.id];
  if (kind === "draft") candidate.agentRevisionId = store.listRevisions(agent.id)[1]!.id;
  if (kind === "wrong-revision") candidate.agentRevisionId = `agent_revision_${randomUUID()}`;
  if (kind === "wrong-agent") candidate.agentId = "agent_other";
  if (kind === "wrong-space") candidate.chatScopes = [{ spaceId: "personal/ou_other", policyHash: "a".repeat(64) }];
  if (kind === "timestamp") candidate.confirmedAt = valid.confirmedAt - 1;
  if (kind === "duplicate-revision") {
    const duplicate = { ...candidate, id: `local_execution_grant_${randomUUID()}` };
    invalid.localExecutionGrants[duplicate.id] = duplicate;
  }
  writeFileSync(primary, JSON.stringify(invalid));
  writeFileSync(`${primary}.bak`, JSON.stringify(invalid));
  expect(() => new AgentStore(dataDir)).toThrow("确认与发布版本不匹配");
});

test("restoring Agent metadata cannot copy hidden local authority fields through open object shapes", () => {
  const source = new AgentStore(dataDir);
  const agent = publishFull(source, source.create({ provider: "codex" }).id);
  const grant = source.listLocalExecutionGrants(agent.id)[0]!;
  const targetDir = join(root, "target");
  const target = new AgentStore(targetDir);
  const untrusted = { ...agent, localExecutionGrantId: grant.id, localExecutionGrants: [grant] };
  target.restore(untrusted,
    source.listRevisions(agent.id).map(revision => ({ ...revision, localExecutionGrantId: grant.id })));
  expect(target.get(agent.id)).toEqual(agent);
  expect(target.listLocalExecutionGrants(agent.id)).toEqual([]);
  expect(readFileSync(join(targetDir, "config", "agents.json"), "utf8")).not.toContain(grant.id);
});
