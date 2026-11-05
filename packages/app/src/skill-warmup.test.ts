import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeEngine, SkillCatalog } from "@homeagent/core";
import { prepareStartupSkills } from "./skill-warmup.ts";

test("startup freezes each configured Provider catalog before the first message without launching a model", async () => {
  const root = mkdtempSync(join(tmpdir(), "ha-startup-skills-"));
  const skills = join(root, "skills");
  mkdirSync(skills);
  const skillFile = join(skills, "SKILL.md");
  writeFileSync(skillFile, "---\nname: startup-fixture\n---\n# Initial version");
  const catalog = new SkillCatalog({ roots: [{ kind: "shared-agents", path: skills, providerIds: ["codex", "claude"] }] });
  let modelCalls = 0;
  const engine = new KnowledgeEngine({ dataDir: join(root, "data"), skillCatalog: catalog,
    runProvider: async () => { modelCalls++; throw new Error("Unexpected model call during warmup"); } });
  try {
    for (const [space, provider] of [["personal/codex", "codex"], ["personal/claude", "claude"]] as const) {
      engine.ensureSpace(space);
      const agent = engine.agents.create({ name: provider, provider, visibility: "Personal" });
      engine.updateSpaceMeta(space, { agentId: agent.id });
    }
    await prepareStartupSkills(engine, "codex");
    expect(catalog.backgroundScanCount()).toBe(2);
    expect(modelCalls).toBe(0);
    expect(engine.chatRuns.list()).toHaveLength(0);
    const [first, second] = await Promise.all([
      engine.agentRunExecutionSnapshotAsync("personal/codex"),
      engine.agentRunExecutionSnapshotAsync("personal/codex"),
    ]);
    expect(catalog.backgroundScanCount()).toBe(2);
    expect(first.skillEvidence.resolved).toHaveLength(1);
    expect(second.skillEvidence).toEqual(first.skillEvidence);
    writeFileSync(skillFile, "---\nname: startup-fixture\n---\n# Changed after warmup");
    const changed = await engine.agentRunExecutionSnapshotAsync("personal/codex");
    expect(catalog.backgroundScanCount()).toBe(3);
    expect(changed.skillEvidence.resolved[0]?.skillFileHash).not.toBe(first.skillEvidence.resolved[0]?.skillFileHash);
    expect(modelCalls).toBe(0);
  } finally { engine.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a failed startup warmup does not prevent service startup or grant execution", async () => {
  const root = mkdtempSync(join(tmpdir(), "ha-startup-skill-failure-"));
  const catalog = new SkillCatalog({ roots: [] });
  const engine = new KnowledgeEngine({ dataDir: root, skillCatalog: catalog });
  try {
    catalog.close();
    await prepareStartupSkills(engine, "codex");
    expect(engine.chatRuns.list()).toHaveLength(0);
    expect(engine.taskRuns.list()).toHaveLength(0);
  } finally { engine.close(); rmSync(root, { recursive: true, force: true }); }
});
