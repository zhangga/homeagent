import { describe, expect, test } from "bun:test";
import type {
  Agent,
  SkillCatalogSnapshot,
  SkillRootKind,
  SkillSource,
} from "@homeagent/core";
import { buildSkillInventory } from "./skill-inventory-view.ts";

function source(
  rootKind: SkillRootKind,
  relativeDir: string,
  name: string,
  hash: string,
  status: SkillSource["status"] = "available",
): SkillSource {
  return {
    sourceKey: `${rootKind}:${relativeDir}`,
    rootKind,
    relativeDir,
    name,
    description: `${name} description`,
    providerIds: rootKind === "claude-user" ? ["claude"] : ["codex"],
    skillFile: `C:\\private\\${relativeDir}\\SKILL.md`,
    skillFileHash: hash,
    status,
    diagnostics: status === "invalid"
      ? [{ code: "invalid_frontmatter", message: "缺少名称" }]
      : [],
  };
}

function snapshot(sources: SkillSource[]): SkillCatalogSnapshot {
  const entries = new Map<string, SkillCatalogSnapshot["entries"][number]>();
  for (const item of sources) {
    const key = `${item.name}:${item.skillFileHash}`;
    const existing = entries.get(key);
    if (existing) {
      existing.sources.push(item);
    } else {
      entries.set(key, {
        key,
        name: item.name,
        description: item.description,
        skillFileHash: item.skillFileHash,
        sources: [item],
      });
    }
  }
  return {
    sources,
    entries: [...entries.values()],
    diagnostics: [],
    refreshedAt: 123,
  };
}

function agent(sourceKey: string): Agent {
  return {
    id: "agent_review",
    name: "Review Agent",
    instruction: "",
    provider: "codex",
    model: "",
    reasoningEffort: "",
    visibility: "Team",
    permission: "read-only",
    skills: [{ kind: "source", sourceKey, name: "review" }],
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("Skills inventory presenter", () => {
  test("marks same-name different-content entries as conflicts", () => {
    const first = source("codex-user", "review", "review", "a".repeat(64));
    const second = source("claude-user", "review", "review", "b".repeat(64));

    const view = buildSkillInventory(snapshot([first, second]), []);

    expect(view.rows).toHaveLength(2);
    expect(view.rows.map((row) => row.status)).toEqual(["conflict", "conflict"]);
    expect(view.issueCount).toBe(2);
  });

  test("groups same-content sources and resolves exact reverse Agent usage", () => {
    const hash = "a".repeat(64);
    const first = source("codex-user", "review", "review", hash);
    const second = source("claude-user", "review", "review", hash);

    const view = buildSkillInventory(snapshot([first, second]), [
      agent(second.sourceKey),
    ]);

    expect(view.rows).toHaveLength(1);
    expect(view.rows[0]).toEqual(expect.objectContaining({
      status: "duplicate",
      sourceLabels: ["codex-user · review", "claude-user · review"],
      usedBy: [expect.objectContaining({ name: "Review Agent" })],
    }));
    expect(view.agentCount).toBe(1);
  });

  test("surfaces invalid entries and degrades safely without a snapshot", () => {
    const invalid = source(
      "codex-user",
      "broken",
      "broken",
      "b".repeat(64),
      "invalid",
    );

    const invalidView = buildSkillInventory(snapshot([invalid]), []);
    expect(invalidView.rows[0]?.status).toBe("invalid");
    expect(invalidView.rows[0]?.diagnostics[0]).toContain("缺少名称");
    expect(invalidView.rows[0]?.sourceLabels[0]).not.toContain("C:\\private");

    const missingView = buildSkillInventory(undefined, []);
    expect(missingView.rows).toEqual([]);
    expect(missingView.diagnostics[0]).toContain("Provider 默认规则");
  });
});
