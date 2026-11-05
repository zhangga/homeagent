import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("bundled catalog and bundle Workers resolve beside the packaged application", async () => {
  const root = mkdtempSync(join(tmpdir(), "ha-worker-bundle-"));
  const repo = resolve(import.meta.dir, "..").replaceAll("\\", "/");
  try {
    const skill = join(root, "sources", "fixture"); mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, "SKILL.md"), "---\nname: fixture\n---\n# Offline");
    const entry = join(root, "entry.ts");
    writeFileSync(entry, `
import { SkillCatalog } from ${JSON.stringify(`${repo}/packages/core/src/skill-catalog.ts`)};
import { SkillBundleWorker } from ${JSON.stringify(`${repo}/packages/llm/src/skill-bundle-client.ts`)};
import { join } from 'node:path';
const root = process.argv[2];
const catalog = new SkillCatalog({roots:[{kind:'shared-agents',path:join(root,'sources'),providerIds:['codex']}]});
const worker = new SkillBundleWorker(1);
try {
  await catalog.withResolution({provider:'codex'}, async () => {
    const skills = catalog.resolveAll('codex');
    const input = catalog.executionInputsAfterValidation(skills.resolved)[0];
    const result = await worker.run('stage',input,join(root,'copy'));
    if(result.entries !== 1) throw Error('missing bundled Skill');
    await catalog.validatePrepared();
  });
  console.log('workers verified');
} finally { catalog.close(); await worker.close(); }
`);
    for (const [source, output] of [[entry, "homeagent.js"],
      [`${repo}/packages/core/src/skill-catalog-worker.ts`, "skill-catalog-worker.ts"],
      [`${repo}/packages/llm/src/skill-bundle-worker.ts`, "skill-bundle-worker.ts"]]) {
      // Use the release builder's CLI, isolated from the test runner's module
      // cache and mocks, then actually start the emitted Worker entrypoints.
      const build = Bun.spawn([process.execPath, "build", "--target=bun", source!, `--outfile=${join(root, output!)}`],
        { cwd: repo, stdout: "pipe", stderr: "pipe" });
      const [, diagnostics, code] = await Promise.all([new Response(build.stdout).text(), new Response(build.stderr).text(), build.exited]);
      if (code !== 0) throw new Error(`Worker fixture build failed: ${diagnostics}`);
      expect(code).toBe(0);
    }
    const child = Bun.spawn([process.execPath, join(root, "homeagent.js"), root], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("workers verified");
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30_000);
