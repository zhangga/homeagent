import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, realpathSync } from "node:fs";
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

describe("AgentStore", () => {
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
    expect(raw.version).toBe(2);
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
    expect(onDisk.version).toBe(2);
    expect(onDisk.agents.agent_old.skills).toEqual(store.get("agent_old")?.skills);
  });

  test("the GPT-5.6 alias is migrated to the explicit Sol model id", () => {
    const path = join(dir, "config", "agents.json");
    require("node:fs").mkdirSync(join(dir, "config"), { recursive: true });
    require("node:fs").writeFileSync(
      path,
      JSON.stringify({
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
    expect(migrated.version).toBe(2);
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
    const reopened = new AgentStore(dir);
    expect(reopened.has(a.id)).toBe(false);
  });

  test("list is stable-sorted by creation time", () => {
    const store = new AgentStore(dir);
    const first = store.create({ name: "first" });
    const second = store.create({ name: "second" });
    const ids = store.list().map((a) => a.id);
    expect(ids).toEqual([first.id, second.id]);
  });
});
