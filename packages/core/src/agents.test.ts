import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStore, agentVisibleInSpace, resolveAgentExecution } from "./agents.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hb-agents-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function blockAgentPersistence(): void {
  const configDir = join(dir, "config");
  renameSync(configDir, join(dir, "saved-config"));
  writeFileSync(configDir, "not a directory", "utf8");
}

describe("AgentStore", () => {
  test("publishes immutable Agent revisions and rolls back by publishing a new revision", () => {
    const store = new AgentStore(dir);
    const created = store.create({
      name: "Researcher",
      instruction: "original persona",
      provider: "claude",
    });

    const first = store.listRevisions(created.id)[0]!;
    expect(created.publishedRevisionId).toBe(first.id);
    expect(first.number).toBe(1);
    expect(first.source).toBe("create");
    expect(first.snapshot.instruction).toBe("original persona");

    const updated = store.update(created.id, {
      instruction: "new persona",
      provider: "codex",
    })!;
    const afterUpdate = store.listRevisions(created.id);
    expect(afterUpdate).toHaveLength(2);
    expect(updated.publishedRevisionId).toBe(afterUpdate[0]!.id);
    expect(afterUpdate[0]).toMatchObject({ number: 2, source: "update" });
    expect(afterUpdate[0]!.snapshot.instruction).toBe("new persona");
    expect(afterUpdate[1]).toEqual(first);

    const rolledBack = store.rollback(created.id, first.id)!;
    const history = store.listRevisions(created.id);
    expect(history).toHaveLength(3);
    expect(history[0]).toMatchObject({
      number: 3,
      source: "rollback",
      basedOnRevisionId: first.id,
    });
    expect(rolledBack.publishedRevisionId).toBe(history[0]!.id);
    expect(rolledBack.instruction).toBe("original persona");
    expect(rolledBack.provider).toBe("claude");
    expect(history[2]).toEqual(first);
  });

  test("saveDraft leaves published Agents unchanged until release", () => {
    const store = new AgentStore(dir);
    const published = store.create({
      name: "Researcher",
      instruction: "published persona",
      provider: "claude",
    });

    const draft = store.saveDraft(published.id, {
      instruction: "draft persona",
      provider: "codex",
    })!;

    expect(draft).toMatchObject({ source: "draft", number: 2 });
    expect(store.getDraft(published.id)).toEqual(draft);
    expect(store.get(published.id)).toEqual(published);
    expect(store.list()).toEqual([published]);

    const released = store.release(published.id, draft.id)!;
    expect(released).toMatchObject({
      instruction: "draft persona",
      provider: "codex",
    });
    expect(store.getDraft(published.id)).toBeUndefined();
    expect(store.listRevisions(published.id)[0]).toMatchObject({
      source: "release",
      basedOnRevisionId: draft.id,
      number: 3,
    });
  });

  test("lifecycle mutations reject stale heads and never roll back an unpublished draft", () => {
    const store = new AgentStore(dir);
    const published = store.create({ name: "CAS Agent", instruction: "v1" });
    const releaseOne = published.publishedRevisionId!;
    const firstDraft = store.saveDraft(
      published.id,
      { instruction: "draft one" },
      releaseOne,
    )!;

    expect(() => store.saveDraft(
      published.id,
      { instruction: "stale overwrite" },
      releaseOne,
    )).toThrow("Agent 版本已变化");

    const secondDraft = store.saveDraft(
      published.id,
      { instruction: "draft two" },
      firstDraft.id,
    )!;
    expect(store.release(published.id, firstDraft.id, secondDraft.id)).toBeUndefined();
    expect(store.rollback(published.id, secondDraft.id, secondDraft.id)).toBeUndefined();

    const released = store.release(published.id, secondDraft.id, secondDraft.id)!;
    expect(released.instruction).toBe("draft two");
    expect(() => store.rollback(
      published.id,
      releaseOne,
      secondDraft.id,
    )).toThrow("Agent 版本已变化");
    expect(store.get(published.id)?.publishedRevisionId).toBe(released.publishedRevisionId);
  });

  test("does not expose mutable revision snapshots", () => {
    const store = new AgentStore(dir);
    const published = store.create({
      name: "Immutable",
      skills: [{ kind: "legacy-name", name: "review" }],
    });
    const draft = store.saveDraft(published.id, { instruction: "draft" })!;

    draft.snapshot.instruction = "mutated outside";
    draft.snapshot.skills[0]!.name = "changed";
    const listed = store.listRevisions(published.id);
    listed[0]!.snapshot.instruction = "also mutated";

    expect(store.getDraft(published.id)?.snapshot).toMatchObject({
      instruction: "draft",
      skills: [{ kind: "legacy-name", name: "review" }],
    });
  });

  test("a failed draft save changes neither published Agents nor revision history", () => {
    const store = new AgentStore(dir);
    const published = store.create({ name: "Published", instruction: "v1" });
    const history = store.listRevisions(published.id);
    blockAgentPersistence();

    expect(() => store.saveDraft(published.id, { instruction: "phantom draft" }))
      .toThrow();
    expect(store.get(published.id)).toEqual(published);
    expect(store.getDraft(published.id)).toBeUndefined();
    expect(store.listRevisions(published.id)).toEqual(history);
  });

  test("create does not retain an Agent in memory when persistence fails", () => {
    const store = new AgentStore(dir);
    const existing = store.create({ name: "Existing" });
    const history = store.listRevisions(existing.id);
    blockAgentPersistence();

    expect(() => store.create({ name: "Phantom" })).toThrow();
    expect(store.list().map((agent) => agent.name)).toEqual(["Existing"]);
    expect(store.listRevisions(existing.id)).toEqual(history);
  });

  test("update does not retain changes in memory when persistence fails", () => {
    const store = new AgentStore(dir);
    const agent = store.create({ name: "Existing" });
    const history = store.listRevisions(agent.id);
    blockAgentPersistence();

    expect(() => store.update(agent.id, { name: "Changed" })).toThrow();
    expect(store.get(agent.id)?.name).toBe("Existing");
    expect(store.listRevisions(agent.id)).toEqual(history);
  });

  test("remove keeps the Agent in memory when persistence fails", () => {
    const store = new AgentStore(dir);
    const agent = store.create({ name: "Existing" });
    const history = store.listRevisions(agent.id);
    blockAgentPersistence();

    expect(() => store.remove(agent.id)).toThrow();
    expect(store.has(agent.id)).toBe(true);
    expect(store.listRevisions(agent.id)).toEqual(history);
  });

  test("recovers the last successfully persisted agents when the primary config is corrupt", () => {
    const store = new AgentStore(dir);
    const agent = store.create({ name: "Survivor" });
    const history = store.listRevisions(agent.id);
    const path = join(dir, "config", "agents.json");

    writeFileSync(path, "{not valid json", "utf8");

    const recovered = new AgentStore(dir);
    expect(recovered.get(agent.id)?.name).toBe("Survivor");
    expect(recovered.listRevisions(agent.id)).toEqual(history);
  });

  test("does not recover an update that failed before the primary commit", () => {
    const store = new AgentStore(dir);
    const agent = store.create({ name: "Committed" });
    const history = store.listRevisions(agent.id);
    const path = join(dir, "config", "agents.json");
    rmSync(path);
    mkdirSync(path);

    expect(() => store.update(agent.id, { name: "Uncommitted" })).toThrow();
    expect(store.get(agent.id)?.name).toBe("Committed");
    expect(store.listRevisions(agent.id)).toEqual(history);

    rmSync(path, { recursive: true });
    const recovered = new AgentStore(dir);
    expect(recovered.get(agent.id)?.name).toBe("Committed");
    expect(recovered.listRevisions(agent.id)).toEqual(history);
  });

  test("uses the backup when a parseable primary contains an invalid Agent entry", () => {
    const store = new AgentStore(dir);
    const agent = store.create({ name: "Valid backup" });
    const path = join(dir, "config", "agents.json");
    writeFileSync(path, JSON.stringify({
      version: 2,
      agents: { [agent.id]: null },
    }), "utf8");

    expect(new AgentStore(dir).get(agent.id)?.name).toBe("Valid backup");
  });

  test("uses the backup when the current primary contains an invalid Skill binding", () => {
    const store = new AgentStore(dir);
    const agent = store.create({
      name: "Valid nested backup",
      skills: [{
        kind: "source",
        sourceKey: "codex-user:keep-me",
        name: "keep-me",
      }],
    });
    const path = join(dir, "config", "agents.json");
    const primary = JSON.parse(readFileSync(path, "utf8"));
    primary.agents[agent.id].skills = [null];
    writeFileSync(path, JSON.stringify(primary), "utf8");

    expect(new AgentStore(dir).get(agent.id)?.skills).toEqual([{
      kind: "source",
      sourceKey: "codex-user:keep-me",
      name: "keep-me",
    }]);
  });

  test("uses the backup when the current primary is missing a required field", () => {
    const store = new AgentStore(dir);
    const agent = store.create({ name: "Complete backup", provider: "codex" });
    const path = join(dir, "config", "agents.json");
    const primary = JSON.parse(readFileSync(path, "utf8"));
    delete primary.agents[agent.id].provider;
    writeFileSync(path, JSON.stringify(primary), "utf8");

    expect(new AgentStore(dir).get(agent.id)?.provider).toBe("codex");
  });

  test("uses the backup when published revision history is parseably corrupted", () => {
    const store = new AgentStore(dir);
    const agent = store.create({ name: "Revision survivor", instruction: "v1" });
    const updated = store.update(agent.id, { instruction: "v2" })!;
    const history = store.listRevisions(agent.id);
    const path = join(dir, "config", "agents.json");
    const primary = JSON.parse(readFileSync(path, "utf8"));
    primary.revisions[agent.id][0].snapshot.instruction = "corrupt but parseable";
    writeFileSync(path, JSON.stringify(primary), "utf8");

    const recovered = new AgentStore(dir);
    expect(recovered.get(agent.id)).toEqual(updated);
    expect(recovered.listRevisions(agent.id)).toEqual(history);
  });

  test("repairs an invalid backup while the primary config is healthy", () => {
    const store = new AgentStore(dir);
    const agent = store.create({ name: "Repair survivor" });
    const path = join(dir, "config", "agents.json");
    writeFileSync(`${path}.bak`, "{not valid json", "utf8");

    expect(new AgentStore(dir).get(agent.id)?.name).toBe("Repair survivor");
    writeFileSync(path, "{not valid json", "utf8");

    expect(new AgentStore(dir).get(agent.id)?.name).toBe("Repair survivor");
  });

  test("refreshes a stale backup from the healthy primary config", () => {
    const store = new AgentStore(dir);
    const agent = store.create({ name: "Before" });
    const path = join(dir, "config", "agents.json");
    const staleBackup = readFileSync(`${path}.bak`, "utf8");
    store.update(agent.id, { name: "After" });
    writeFileSync(`${path}.bak`, staleBackup, "utf8");

    expect(new AgentStore(dir).get(agent.id)?.name).toBe("After");
    writeFileSync(path, "{not valid json", "utf8");

    expect(new AgentStore(dir).get(agent.id)?.name).toBe("After");
  });

  test("legacy migration writes a current record that remains readable", () => {
    const path = join(dir, "config", "agents.json");
    mkdirSync(join(dir, "config"), { recursive: true });
    writeFileSync(path, JSON.stringify({
      version: 2,
      agents: {
        agent_legacy_shape: {
          id: "agent_legacy_shape",
          name: "",
          instruction: "",
          model: "",
          provider: "codex",
          reasoningEffort: "",
          visibility: "Team",
          workdir: "  legacy-workdir  ",
          permission: "read-only",
          skills: [],
          createdAt: 10,
          updatedAt: 1,
        },
      },
    }), "utf8");

    const migrated = new AgentStore(dir).get("agent_legacy_shape")!;
    const reopened = new AgentStore(dir).get("agent_legacy_shape")!;

    expect(migrated.name.trim().length).toBeGreaterThan(0);
    expect(migrated.workdir).toBe("legacy-workdir");
    expect(migrated.updatedAt).toBeGreaterThanOrEqual(migrated.createdAt);
    expect(reopened).toEqual(migrated);
  });

  test("v3 Agents migrate to one published revision that is stable across restarts", () => {
    const path = join(dir, "config", "agents.json");
    mkdirSync(join(dir, "config"), { recursive: true });
    writeFileSync(path, JSON.stringify({
      version: 3,
      agents: {
        agent_v3: {
          id: "agent_v3",
          name: "Version three",
          instruction: "stable migration",
          model: "",
          reasoningEffort: "",
          provider: "claude",
          visibility: "Team",
          permission: "read-only",
          skills: [],
          createdAt: 10,
          updatedAt: 20,
        },
      },
    }), "utf8");

    const migratedStore = new AgentStore(dir);
    const migrated = migratedStore.get("agent_v3")!;
    const revision = migratedStore.listRevisions("agent_v3")[0]!;
    expect(migrated.publishedRevisionId).toBe(revision.id);
    expect(revision).toMatchObject({
      agentId: "agent_v3",
      number: 1,
      source: "migration",
      createdAt: 20,
    });

    const restarted = new AgentStore(dir);
    expect(restarted.get("agent_v3")).toEqual(migrated);
    expect(restarted.listRevisions("agent_v3")).toEqual([revision]);
    expect(JSON.parse(readFileSync(path, "utf8")).version).toBe(4);
  });

  test("restored Agents are normalized into a readable current record", () => {
    const store = new AgentStore(dir);
    store.restore({
      id: "agent_restored_shape",
      name: "",
      instruction: "",
      model: "gpt-5.6",
      reasoningEffort: "max",
      provider: "codex",
      visibility: "Team",
      workdir: "  restored-workdir  ",
      permission: "read-only",
      skills: [],
      createdAt: 10,
      updatedAt: 1,
    });

    const reopened = new AgentStore(dir).get("agent_restored_shape")!;
    expect(reopened.name.trim().length).toBeGreaterThan(0);
    expect(reopened.model).toBe("gpt-5.6-sol");
    expect(reopened.workdir).toBe("restored-workdir");
    expect(reopened.updatedAt).toBeGreaterThanOrEqual(reopened.createdAt);
    expect(new AgentStore(dir).listRevisions("agent_restored_shape")[0]).toMatchObject({
      source: "restore",
      snapshot: { model: "gpt-5.6-sol", workdir: "restored-workdir" },
    });
  });

  test("restore can preserve an exact immutable Agent revision history", () => {
    const source = new AgentStore(dir);
    const created = source.create({ name: "Archive v1", instruction: "one" });
    const draft = source.saveDraft(created.id, { instruction: "two" })!;
    const released = source.release(created.id, draft.id)!;
    const revisions = source.listRevisions(created.id);
    const restoredDir = mkdtempSync(join(tmpdir(), "hb-agent-history-"));
    try {
      const restoredStore = new AgentStore(restoredDir);
      restoredStore.restore(released, revisions);

      expect(restoredStore.get(created.id)).toEqual(released);
      expect(restoredStore.listRevisions(created.id)).toEqual(revisions);
      expect(new AgentStore(restoredDir).listRevisions(created.id)).toEqual(revisions);
    } finally {
      rmSync(restoredDir, { recursive: true, force: true });
    }
  });

  test("seeds recovery for a valid primary config created before backups existed", () => {
    const store = new AgentStore(dir);
    const agent = store.create({ name: "Legacy install" });
    const path = join(dir, "config", "agents.json");
    rmSync(`${path}.bak`);

    expect(new AgentStore(dir).get(agent.id)?.name).toBe("Legacy install");
    writeFileSync(path, "{not valid json", "utf8");

    expect(new AgentStore(dir).get(agent.id)?.name).toBe("Legacy install");
  });

  test("fails explicitly when the primary config is corrupt and no backup exists", () => {
    const store = new AgentStore(dir);
    store.create({ name: "No backup" });
    const path = join(dir, "config", "agents.json");
    rmSync(`${path}.bak`);
    writeFileSync(path, "{not valid json", "utf8");

    expect(() => new AgentStore(dir)).toThrow("no backup is available");
  });

  test("refuses a future Agent schema without replacing it from an older backup", () => {
    const store = new AgentStore(dir);
    store.create({ name: "Current backup" });
    const path = join(dir, "config", "agents.json");
    writeFileSync(path, JSON.stringify({
      version: 999,
      futureField: "must survive",
      agents: {},
    }), "utf8");

    expect(() => new AgentStore(dir)).toThrow(/unsupported.*999/i);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      version: 999,
      futureField: "must survive",
      agents: {},
    });
  });

  test("persists exact source-bound Skills in the versioned Agent schema", () => {
    const store = new AgentStore(dir);
    const agent = store.create({
      name: "bound",
      skills: [
        { kind: "source", sourceKey: "shared-agents:review", name: "review" },
        { kind: "source", sourceKey: "codex-user:ship", name: "ship" },
      ],
    });

    expect(agent.skills).toEqual([
      { kind: "source", sourceKey: "shared-agents:review", name: "review" },
      { kind: "source", sourceKey: "codex-user:ship", name: "ship" },
    ]);
    const raw = JSON.parse(readFileSync(join(dir, "config", "agents.json"), "utf8"));
    expect(raw.version).toBe(4);
    expect(raw.agents[agent.id].skills).toEqual(agent.skills);
  });

  test("does not expose mutable Skill binding objects from AgentStore", () => {
    const store = new AgentStore(dir);
    const created = store.create({
      name: "bound",
      skills: [{
        kind: "source",
        sourceKey: "shared-agents:review",
        name: "review",
      }],
    });

    created.skills[0]!.name = "mutated";
    created.skills.push({ kind: "legacy-name", name: "extra" });

    expect(store.get(created.id)?.skills).toEqual([{
      kind: "source",
      sourceKey: "shared-agents:review",
      name: "review",
    }]);
  });

  test("rejects a newly submitted source binding that the catalog does not know", () => {
    const store = new AgentStore(dir, {
      validateSourceSkill: (binding) => binding.sourceKey === "shared-agents:known",
    });

    expect(() => store.create({
      name: "invalid",
      skills: [{
        kind: "source",
        sourceKey: "shared-agents:missing",
        name: "missing",
      }],
    })).toThrow("Skill source");
  });

  test("rejects more than 50 Skill bindings", () => {
    const store = new AgentStore(dir);
    const skills = Array.from({ length: 51 }, (_, index) => ({
      kind: "source" as const,
      sourceKey: `shared-agents:skill-${index}`,
      name: `skill-${index}`,
    }));

    expect(() => store.create({ name: "too-many", skills })).toThrow(
      "at most 50",
    );
  });

  test("leaves an Agent unchanged when a Skill binding update is rejected", () => {
    const store = new AgentStore(dir, {
      validateSourceSkill: (binding) => binding.sourceKey === "shared-agents:known",
    });
    const agent = store.create({ name: "original" });

    expect(() => store.update(agent.id, {
      name: "must-not-stick",
      skills: [{
        kind: "source",
        sourceKey: "shared-agents:missing",
        name: "missing",
      }],
    })).toThrow("Skill source");
    expect(store.get(agent.id)?.name).toBe("original");
    expect(store.get(agent.id)?.skills).toEqual([]);
  });

  test("rejects Agent fields that cannot fit in a durable execution plan", () => {
    const store = new AgentStore(dir);
    expect(() => store.create({
      name: "oversized instruction",
      instruction: "x".repeat(20_001),
    })).toThrow(/instruction/i);
    expect(store.list()).toEqual([]);

    const agent = store.create({ name: "bounded", provider: "codex" });
    expect(() => store.update(agent.id, {
      model: "m".repeat(201),
    })).toThrow(/model/i);
    expect(() => store.update(agent.id, {
      workdir: "w".repeat(2_049),
    })).toThrow(/workdir/i);
    expect(store.get(agent.id)).toEqual(agent);
  });

  test("create assigns an id, defaults, and persists to agents.json", () => {
    const store = new AgentStore(dir);
    const a = store.create({ name: "知识助手", instruction: "简洁作答", model: "claude-sonnet-5" });
    expect(a.id).toMatch(/^agent_/);
    expect(a.name).toBe("知识助手");
    expect(a.provider).toBe("claude");
    expect(a.visibility).toBe("Team");

    const path = join(dir, "config", "agents.json");
    expect(existsSync(path)).toBe(true);
    const raw = JSON.parse(readFileSync(path, "utf8"));
    expect(raw.agents[a.id].instruction).toBe("简洁作答");
  });

  test("blank name falls back to a placeholder; blank model stays empty", () => {
    const store = new AgentStore(dir);
    const a = store.create({ name: "   ", model: "  " });
    expect(a.name).toBe("未命名 Agent");
    expect(a.model).toBe("");
  });

  test("visibility limits an Agent to matching space types", () => {
    const store = new AgentStore(dir);
    const team = store.create({ name: "team", visibility: "Team" });
    const personal = store.create({ name: "personal", visibility: "Personal" });
    const invalid = store.create({ name: "invalid", visibility: "Public" });

    expect(agentVisibleInSpace(team, "team/oc_group")).toBe(true);
    expect(agentVisibleInSpace(team, "personal/ou_user")).toBe(false);
    expect(agentVisibleInSpace(personal, "personal/ou_user")).toBe(true);
    expect(agentVisibleInSpace(personal, "team/oc_group")).toBe(false);
    expect(invalid.visibility).toBe("Team");
  });

  test("Codex reasoning effort is normalized and survives a reload", () => {
    const store = new AgentStore(dir);
    const agent = store.create({
      name: "深度助手",
      provider: "codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
    });

    expect(agent.reasoningEffort).toBe("high");
    expect(new AgentStore(dir).get(agent.id)?.reasoningEffort).toBe("high");
    expect(store.create({ name: "无效配置", reasoningEffort: "extreme" }).reasoningEffort).toBe("");
    expect(store.create({ name: "继承模型", reasoningEffort: "max" }).reasoningEffort).toBe("max");
    expect(
      store.create({ name: "旧模型", model: "gpt-5.5", reasoningEffort: "max" }).reasoningEffort,
    ).toBe("");

    expect(store.update(agent.id, { reasoningEffort: "max" })?.reasoningEffort).toBe("max");
    const changed = store.update(agent.id, { model: "gpt-5.5" });
    expect(changed?.reasoningEffort).toBe("");
  });

  test("task-execution fields: defaults, safe parsing, and update", () => {
    const store = new AgentStore(dir);
    const a = store.create({
      name: "runner",
      skills: [
        { kind: "source", sourceKey: "shared-agents:code-review", name: "code-review" },
        { kind: "source", sourceKey: "shared-agents:web-search", name: "web-search" },
        { kind: "source", sourceKey: "shared-agents:code-review", name: "duplicate" },
        { kind: "source", sourceKey: "codex-user:github-yeet", name: "github:yeet" },
      ],
    });
    // permission defaults to the safest tier
    expect(a.permission).toBe("read-only");
    expect(a.workdir).toBeUndefined();
    // Source keys are stable-deduplicated while preserving the first selection.
    expect(a.skills).toEqual([
      { kind: "source", sourceKey: "shared-agents:code-review", name: "code-review" },
      { kind: "source", sourceKey: "shared-agents:web-search", name: "web-search" },
      { kind: "source", sourceKey: "codex-user:github-yeet", name: "github:yeet" },
    ]);

    const up = store.update(a.id, {
      permission: "write",
      workdir: " ~/proj ",
      skills: [{ kind: "source", sourceKey: "shared-agents:x", name: "x" }],
    });
    expect(up?.permission).toBe("write");
    expect(up?.workdir).toBe("~/proj");
    expect(up?.skills).toEqual([
      { kind: "source", sourceKey: "shared-agents:x", name: "x" },
    ]);

    // unknown permission normalizes back to read-only
    expect(store.create({ name: "z", permission: "root" }).permission).toBe("read-only");
  });

  test("task execution config validates the workdir before enabling writes", () => {
    const store = new AgentStore(dir);
    const writable = store.create({
      name: "writer",
      permission: "write",
      workdir: dir,
      skills: [{
        kind: "source",
        sourceKey: "shared-agents:code-review",
        name: "code-review",
      }],
    });

    expect(resolveAgentExecution(writable)).toEqual({
      permission: "write",
      workdir: realpathSync(dir),
      skills: [],
    });

    const unsafe = store.create({ name: "unsafe", permission: "full" });
    expect(() => resolveAgentExecution(unsafe)).toThrow("Workdir");

    const missing = store.create({
      name: "missing",
      permission: "read-only",
      workdir: join(dir, "does-not-exist"),
    });
    expect(() => resolveAgentExecution(missing)).toThrow("不存在");
  });

  test("provider defaults to the default CLI; unknown normalizes to it; known CLI is kept", () => {
    const store = new AgentStore(dir);
    expect(store.create({ name: "a" }).provider).toBe("claude");
    expect(store.create({ name: "b", provider: "totally-unknown" }).provider).toBe("claude");
    // "gateway" is no longer a selectable provider -> normalized to default CLI
    expect(store.create({ name: "g", provider: "gateway" }).provider).toBe("claude");
    expect(store.create({ name: "c", provider: "claude" }).provider).toBe("claude");
    expect(store.create({ name: "d", provider: "trae-cli" }).provider).toBe("trae-cli");
  });

  test("update patches only provided fields", () => {
    const store = new AgentStore(dir);
    const a = store.create({ name: "A", instruction: "old", model: "m1" });
    const updated = store.update(a.id, { instruction: "new" });
    expect(updated?.instruction).toBe("new");
    expect(updated?.name).toBe("A");
    expect(updated?.model).toBe("m1");
  });

  test("an update remains readable when the system clock moves backwards", () => {
    const clock = spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const store = new AgentStore(dir);
      const agent = store.create({ name: "Before rollback" });
      clock.mockReturnValue(500);

      const updated = store.update(agent.id, { name: "After rollback" })!;
      const reopened = new AgentStore(dir).get(agent.id)!;

      expect(updated.updatedAt).toBeGreaterThanOrEqual(updated.createdAt);
      expect(reopened).toEqual(updated);
    } finally {
      clock.mockRestore();
    }
  });

  test("update returns undefined for unknown id", () => {
    const store = new AgentStore(dir);
    expect(store.update("agent_missing", { name: "x" })).toBeUndefined();
  });

  test("changes survive a reload (new store over the same dir)", () => {
    const store = new AgentStore(dir);
    const a = store.create({ name: "Persisted", model: "" });
    const reopened = new AgentStore(dir);
    expect(reopened.get(a.id)?.name).toBe("Persisted");
    expect(reopened.list().length).toBe(1);
  });

  test("legacy gateway agents migrate to the default CLI on load and are rewritten", () => {
    const path = join(dir, "config", "agents.json");
    require("node:fs").mkdirSync(join(dir, "config"), { recursive: true });
    // Simulate an older file that still records provider: "gateway".
    require("node:fs").writeFileSync(
      path,
      JSON.stringify({
        agents: {
          agent_old: {
            id: "agent_old",
            name: "旧助手",
            instruction: "",
            model: "",
            provider: "gateway",
            createdAt: 1,
            updatedAt: 1,
          },
        },
      }),
      "utf8",
    );
    const store = new AgentStore(dir);
    expect(store.get("agent_old")?.provider).toBe("claude");
    // migration is persisted back to disk (no more "gateway")
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    expect(onDisk.agents.agent_old.provider).toBe("claude");
  });

  test("migrates a legacy Skill name when the catalog has one exact compatible source", () => {
    const path = join(dir, "config", "agents.json");
    require("node:fs").mkdirSync(join(dir, "config"), { recursive: true });
    require("node:fs").writeFileSync(
      path,
      JSON.stringify({
        agents: {
          agent_old: {
            id: "agent_old",
            name: "old",
            instruction: "",
            model: "",
            provider: "codex",
            visibility: "Team",
            permission: "read-only",
            skills: ["review"],
            createdAt: 1,
            updatedAt: 1,
          },
        },
      }),
      "utf8",
    );

    const store = new AgentStore(dir, {
      resolveLegacySkill: (name, provider) => name === "review" && provider === "codex"
        ? { kind: "source", sourceKey: "codex-user:review", name: "review" }
        : undefined,
    });

    expect(store.get("agent_old")?.skills).toEqual([{
      kind: "source",
      sourceKey: "codex-user:review",
      name: "review",
    }]);
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    expect(onDisk.version).toBe(4);
    expect(onDisk.agents.agent_old.skills).toEqual(store.get("agent_old")?.skills);
  });

  test("the GPT-5.6 alias is migrated to the explicit Sol model id", () => {
    const path = join(dir, "config", "agents.json");
    require("node:fs").mkdirSync(join(dir, "config"), { recursive: true });
    require("node:fs").writeFileSync(
      path,
      JSON.stringify({
        version: 2,
        agents: {
          agent_sol: {
            id: "agent_sol",
            name: "旧 Sol 助手",
            instruction: "",
            model: "gpt-5.6",
            provider: "codex",
            permission: "read-only",
            skills: [],
            createdAt: 1,
            updatedAt: 1,
          },
        },
      }),
      "utf8",
    );

    const store = new AgentStore(dir);
    expect(store.get("agent_sol")?.model).toBe("gpt-5.6-sol");
    expect(JSON.parse(readFileSync(path, "utf8")).agents.agent_sol.model).toBe("gpt-5.6-sol");
  });

  test("persisted skill arrays are sanitized again during migration", () => {
    const path = join(dir, "config", "agents.json");
    require("node:fs").mkdirSync(join(dir, "config"), { recursive: true });
    require("node:fs").writeFileSync(
      path,
      JSON.stringify({
        agents: {
          agent_skills: {
            id: "agent_skills",
            name: "旧技能配置",
            instruction: "",
            model: "",
            provider: "codex",
            visibility: "Team",
            permission: "root",
            skills: ["code-review", "../escape", "code-review", "github:yeet"],
            createdAt: 1,
            updatedAt: 1,
          },
        },
      }),
      "utf8",
    );

    const store = new AgentStore(dir);
    expect(store.get("agent_skills")?.skills).toEqual([
      { kind: "legacy-name", name: "code-review" },
      { kind: "legacy-name", name: "github:yeet" },
    ]);
    expect(store.get("agent_skills")?.permission).toBe("read-only");
    const migrated = JSON.parse(readFileSync(path, "utf8"));
    expect(migrated.version).toBe(4);
    expect(migrated.agents.agent_skills.skills).toEqual([
      { kind: "legacy-name", name: "code-review" },
      { kind: "legacy-name", name: "github:yeet" },
    ]);
    expect(migrated.agents.agent_skills.permission).toBe("read-only");
  });

  test("remove deletes and persists", () => {
    const store = new AgentStore(dir);
    const a = store.create({ name: "Temp" });
    expect(store.remove(a.id)).toBe(true);
    expect(store.has(a.id)).toBe(false);
    expect(store.listRevisions(a.id)).toEqual([]);
    const reopened = new AgentStore(dir);
    expect(reopened.has(a.id)).toBe(false);
    expect(reopened.listRevisions(a.id)).toEqual([]);
  });

  test("list is stable-sorted by creation time", () => {
    const store = new AgentStore(dir);
    const first = store.create({ name: "first" });
    const second = store.create({ name: "second" });
    const ids = store.list().map((a) => a.id);
    expect(ids).toEqual([first.id, second.id]);
  });
});
