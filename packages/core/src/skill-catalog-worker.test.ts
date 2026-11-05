import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillCatalog } from "./skill-catalog.ts";

test("one capture does not rediscover the catalog when hashing outlives its UI cache TTL", () => {
  const root = mkdtempSync(join(tmpdir(), "ha-catalog-ttl-"));
  writeFileSync(join(root, "SKILL.md"), "---\nname: fixture\n---\n# Fixture");
  let time = 0;
  const catalog = new SkillCatalog({ roots: [{ kind: "shared-agents", path: root, providerIds: ["codex"] }],
    cacheTtlMs: 1, now: () => time += 60_000 });
  try {
    const resolution = catalog.captureResolution({ provider: "codex" });
    expect(resolution.skills.resolved).toHaveLength(1);
    expect(resolution.inputs).toHaveLength(1);
    expect(catalog.cachedSnapshotVersion()).toBe(1);
  } finally { catalog.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Worker reuses unchanged discovery, detects dependency edits, and freezes concurrent leases", async () => {
  const root = mkdtempSync(join(tmpdir(), "ha-catalog-worker-"));
  const skill = join(root, "example");
  mkdirSync(join(skill, "scripts"), { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "---\nname: example\ndescription: offline skill\n---\n# Example");
  const script = join(skill, "scripts", "run.js");
  writeFileSync(script, "version one");
  const catalog = new SkillCatalog({ roots: [{ kind: "shared-agents", path: root, providerIds: ["codex"] }] });
  const request = { provider: "codex" as const };
  try {
    await catalog.withResolution(request, async () => {
      const frozen = catalog.resolveAll("codex");
      const version = catalog.cachedSnapshotVersion();
      await catalog.validatePrepared();
      await catalog.withResolution(request, async () => {
        expect(catalog.cachedSnapshotVersion()).toBe(version);
        expect(catalog.backgroundScanCount()).toBe(1);
        expect(catalog.resolveAll("codex")).toEqual(frozen);
      });
      writeFileSync(script, "version two");
      const failure = await catalog.validatePrepared().catch(error => error);
      expect(failure).toBeInstanceOf(Error);
      expect(failure.message).toContain("snapshot changed");
      await catalog.withResolution(request, async () => {
        expect(catalog.resolveAll("codex").resolved[0]!.skillFileHash).not.toBe(frozen.resolved[0]!.skillFileHash);
        await catalog.validatePrepared();
      });
      expect(catalog.resolveAll("codex")).toEqual(frozen);
    });
    await catalog.withResolution(request, async () => {
      mkdirSync(join(root, "new"));
      writeFileSync(join(root, "new", "SKILL.md"), "---\nname: new\n---\n# New");
      expect(await catalog.validatePrepared().catch(error => error)).toBeInstanceOf(Error);
    });
    await catalog.withResolution(request, async () => { expect(catalog.resolveAll("codex").resolved).toHaveLength(2); });
  } finally { catalog.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Worker does not cache a missing root forever and no-tools empty bindings do not scan", async () => {
  const root = mkdtempSync(join(tmpdir(), "ha-catalog-missing-"));
  const installed = join(root, "installed");
  const catalog = new SkillCatalog({ roots: [{ kind: "shared-agents", path: installed, providerIds: ["codex"] }] });
  try {
    expect(catalog.resolveAgentBindings([], "codex").resolved).toEqual([]);
    expect(catalog.cachedSnapshotVersion()).toBe(0);
    await catalog.withResolution({ provider: "codex" }, async () => { expect(catalog.resolveAll("codex").resolved).toEqual([]); });
    mkdirSync(installed);
    writeFileSync(join(installed, "SKILL.md"), "---\nname: installed\n---\n# Installed");
    await catalog.withResolution({ provider: "codex" }, async () => { expect(catalog.resolveAll("codex").resolved).toHaveLength(1); });
  } finally { catalog.close(); rmSync(root, { recursive: true, force: true }); }
});

test("cold concurrent leases keep invalid-bundle diagnostics and retry after a dependency changes", async () => {
  const root = mkdtempSync(join(tmpdir(), "ha-catalog-invalid-"));
  const skill = join(root, "example");
  mkdirSync(skill);
  writeFileSync(join(skill, "SKILL.md"), "---\nname: example\n---\n# Example");
  const dependency = join(skill, "dependency.js");
  writeFileSync(dependency, "x".repeat(256));
  const catalog = new SkillCatalog({ roots: [{ kind: "shared-agents", path: root, providerIds: ["codex"] }], limits: { maxBundleBytes: 128 } });
  try {
    await Promise.all([0, 1].map(() => catalog.withResolution({ provider: "codex" }, () => {
      const result = catalog.resolveAll("codex");
      expect(result.resolved).toEqual([]);
      expect(result.skipped[0]?.code).toBe("invalid_skill");
      expect(catalog.backgroundScanCount()).toBe(1);
    })));
    writeFileSync(dependency, "ok");
    await catalog.withResolution({ provider: "codex" }, () => {
      expect(catalog.resolveAll("codex").resolved).toHaveLength(1);
      expect(catalog.backgroundScanCount()).toBe(2);
    });
  } finally { catalog.close(); rmSync(root, { recursive: true, force: true }); }
});
