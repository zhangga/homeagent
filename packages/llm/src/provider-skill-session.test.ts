import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { hashProviderSkillBundle, preflightProviderNativeSession, runProviderDetailed, withProviderSkillSession, type ProviderSkillInput, type RunInput } from "./providers.ts";
import { providerPreparationFailure } from "./provider-preparation.ts";

let root: string;
let oldBin: string | undefined;
let oldHome: string | undefined;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ha-lazy-skills-")));
  oldBin = process.env.HOMEAGENT_CODEX_BIN;
  oldHome = process.env.HOMEAGENT_CODEX_HOME;
  process.env.HOMEAGENT_CODEX_HOME = join(root, "codex-home");
});
afterEach(() => {
  if (oldBin === undefined) delete process.env.HOMEAGENT_CODEX_BIN; else process.env.HOMEAGENT_CODEX_BIN = oldBin;
  if (oldHome === undefined) delete process.env.HOMEAGENT_CODEX_HOME; else process.env.HOMEAGENT_CODEX_HOME = oldHome;
  rmSync(root, { recursive: true, force: true });
});

function fixture(count = 116): RunInput {
  const workdir = join(root, "work");
  const dataRoot = join(root, "data");
  mkdirSync(workdir); mkdirSync(dataRoot);
  const skillInputs: ProviderSkillInput[] = Array.from({ length: count }, (_, index) => {
    const name = `skill-${index}`;
    const directory = join(root, "sources", name);
    mkdirSync(join(directory, "scripts", "node_modules", "runtime"), { recursive: true });
    const skillFile = join(directory, "SKILL.md");
    writeFileSync(skillFile, `# ${name}\nFollow ../skill-1/SKILL.md when needed.\n`);
    writeFileSync(join(directory, "scripts", "run.sh"), "#!/bin/sh\nprintf 'ok'\n", { mode: 0o755 });
    writeFileSync(join(directory, "scripts", "node_modules", "runtime", "index.js"), "module.exports = 'frozen';\n");
    return { name, description: `技能 ${index} 的用途`, directory, skillFile, bundleHash: hashProviderSkillBundle(skillFile) };
  });
  // All probes are local fakes; this never invokes a model or a real CLI.
  const script = join(root, "provider.cjs");
  writeFileSync(script, [
    "const fs = require('node:fs'); const path = require('node:path');",
    "const args = process.argv.slice(2);",
    "if (args.includes('--version')) console.log('codex-cli 0.152.1');",
    "else if (args.includes('--help')) console.log('Usage: codex exec fork [OPTIONS] [SESSION_ID] [PROMPT]');",
    "else if (args.includes('status')) console.log('Logged in using ChatGPT');",
    "else if (args.includes('mcp')) console.log('[]');",
    "else if (args.includes('sandbox')) process.exit(0);",
    "else (async () => {",
    "  const prompt = await Bun.stdin.text();",
    "  const command = prompt.match(/^技能加载命令.*：(.+) <技能名称>$/m)?.[1];",
    "  const names = prompt.match(/REQUEST_SKILLS=(.*)/)?.[1]?.split(',').filter(Boolean) ?? [];",
    "  const paths = [];",
    "  for (const name of names) {",
    "    const cmd = command + \" '\" + name + \"'\";",
    "    const child = Bun.spawn(process.platform === 'win32' ? ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', cmd] : ['/bin/sh', '-c', cmd], { stdout: 'pipe', stderr: 'pipe' });",
    "    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);",
    "    if (code) throw new Error('Fake skill command failed: ' + stderr);",
    "    const skillFile = stdout.trim();",
    "    paths.push(skillFile);",
    "    if (!fs.readFileSync(path.join(path.dirname(skillFile), 'scripts/node_modules/runtime/index.js'), 'utf8').includes('frozen')) throw new Error('Dependency missing');",
    "    if (prompt.includes('REPLACE_SKILL_ROOT') && paths.length === 1) {",
    "      const stageRoot = path.dirname(path.dirname(skillFile));",
    "      const original = path.join(__dirname, 'original-stage-root');",
    "      fs.renameSync(stageRoot, original); fs.mkdirSync(stageRoot, { mode: 0o700 });",
    "      for (const name of fs.readdirSync(original)) fs.renameSync(path.join(original, name), path.join(stageRoot, name));",
    "      fs.rmdirSync(original);",
    "    }",
    "  }",
    "  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }));",
    "  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ prompt, args, paths }) } }));",
    "  console.log(JSON.stringify({ type: 'turn.completed' }));",
    "})().catch(() => { process.exitCode = 42; });",
  ].join("\n"));
  const bin = join(root, process.platform === "win32" ? "provider.cmd" : "provider");
  writeFileSync(bin, process.platform === "win32"
    ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
    : `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${script.replaceAll("'", "'\\''")}' "$@"\n`);
  if (process.platform !== "win32") chmodSync(bin, 0o755);
  process.env.HOMEAGENT_CODEX_BIN = bin;
  return {
    prompt: "REQUEST_SKILLS=", workdir, protectedDataRoot: dataRoot, skillInputs,
    execution: { permission: "full", executionMode: "local-full-access", workdir, skills: skillInputs.map(skill => skill.name), skillMode: "all" },
    acquireExecutionPermit: () => ({ register: () => () => {}, release: () => {} }),
  };
}

function stageRoots(): string[] {
  return readdirSync(realpathSync(tmpdir())).filter(name => name.startsWith("homeagent-codex-skills-"));
}
interface Observed { prompt: string; args: string[]; paths: string[] }
async function invoke(input: RunInput, names: string[] = []): Promise<Observed> {
  return JSON.parse((await runProviderDetailed("codex", { ...input, prompt: `REQUEST_SKILLS=${names.join(",")}` }, 20_000)).text);
}

test("116 discoverable Skills prepare zero bundles for ordinary questions, including preflight", async () => {
  const input = fixture();
  const before = stageRoots();
  let stagedRoot: string | undefined;
  await withProviderSkillSession(async () => {
    await preflightProviderNativeSession("codex", 20_000, undefined, input.workdir, input.execution, input.skillInputs, input.protectedDataRoot);
    const created = stageRoots().filter(name => !before.includes(name));
    expect(created).toHaveLength(1);
    stagedRoot = join(realpathSync(tmpdir()), created[0]!);
    expect(readdirSync(stagedRoot)).toEqual([]);
    const result = await invoke(input);
    expect(result.paths).toEqual([]);
    expect(result.prompt).toContain('skill-115: "技能 115 的用途"');
    expect(result.prompt).not.toContain(input.skillInputs![0]!.directory);
    expect(readdirSync(stagedRoot)).toEqual([]);
    expect(stageRoots().filter(name => !before.includes(name))).toEqual(created);
  });
  expect(existsSync(stagedRoot!)).toBe(false);
  expect(stageRoots()).toEqual(before);
}, 30_000);

test("on-demand Skills retain dependencies and reuse a bundle across routing, answer, and late dependency loads", async () => {
  const input = fixture();
  let firstPath = "";
  await withProviderSkillSession(async () => {
    const first = await invoke(input, ["skill-0", "skill-0"]);
    firstPath = first.paths[0]!;
    expect(first.paths).toEqual([firstPath, firstPath]);
    expect(hashProviderSkillBundle(firstPath)).toBe(input.skillInputs![0]!.bundleHash);
    expect(readdirSync(dirname(dirname(firstPath)))).toEqual(["skill-0000"]);
    const firstIdentity = lstatSync(firstPath);
    const later = await invoke(input, ["skill-115", "skill-1", "skill-0"]);
    expect(later.paths[2]).toBe(firstPath);
    expect(lstatSync(firstPath).ino).toBe(firstIdentity.ino);
    expect(lstatSync(firstPath).mtimeMs).toBe(firstIdentity.mtimeMs);
    expect(readdirSync(dirname(dirname(firstPath))).sort()).toEqual(["skill-0000", "skill-0001", "skill-0115"]);
    expect(readFileSync(join(dirname(firstPath), "scripts", "run.sh"), "utf8")).toContain("printf 'ok'");
  });
  expect(existsSync(firstPath)).toBe(false);
}, 30_000);

test("parallel Runs never share mutable prepared directories", async () => {
  const input = fixture(2);
  const paths: string[] = [];
  await Promise.all([0, 1].map(() => withProviderSkillSession(async () => {
    const result = await invoke(input, ["skill-0"]);
    paths.push(result.paths[0]!);
  })));
  expect(new Set(paths).size).toBe(2);
  expect(paths.every(path => !existsSync(path))).toBe(true);
}, 30_000);

test("a bundle changed after discovery is rejected at its first load and cancels the Provider", async () => {
  const input = fixture(2);
  const before = stageRoots();
  await expect(withProviderSkillSession(async () => {
    await invoke(input);
    writeFileSync(join(input.skillInputs![1]!.directory, "scripts", "run.sh"), "changed");
    await invoke(input, ["skill-1"]);
  })).rejects.toThrow("Skill input changed after frozen validation");
  expect(stageRoots()).toEqual(before);
}, 30_000);

test("lazy preparation charges the cumulative budget only when bundles are actually loaded", async () => {
  const input = fixture(2);
  for (const skill of input.skillInputs!) {
    writeFileSync(join(skill.directory, "payload.bin"), Buffer.alloc(65 * 1024 * 1024, 7));
    skill.bundleHash = hashProviderSkillBundle(skill.skillFile);
  }
  const before = stageRoots();
  let failure: unknown;
  try {
    await withProviderSkillSession(async () => {
      await invoke(input); // Discovery is allowed even though the unused catalog exceeds 128 MiB.
      const first = await invoke(input, ["skill-0"]);
      expect(hashProviderSkillBundle(first.paths[0]!)).toBe(input.skillInputs![0]!.bundleHash);
      await invoke(input, ["skill-1"]);
    });
  } catch (error) { failure = error; }
  expect(providerPreparationFailure(failure)).toEqual({
    stage: "skill-staging", reason: "capacity-exceeded", requestedSkills: 2, stagedSkills: 1,
  });
  expect(stageRoots()).toEqual(before);
}, 30_000);

test("reused staged content is revalidated before another model launch", async () => {
  const input = fixture(1);
  await withProviderSkillSession(async () => {
    const result = await invoke(input, ["skill-0"]);
    writeFileSync(result.paths[0]!, "tampered");
    let launches = 0;
    await expect(invoke({ ...input, acquireExecutionPermit: () => {
      launches++;
      return { register: () => () => {}, release: () => {} };
    } })).rejects.toThrow("staged Skill bundle failed verification");
    expect(launches).toBe(0);
  });
}, 30_000);

test("loading another Skill cannot accept replacement of the original staged root", async () => {
  const input = fixture(2);
  await withProviderSkillSession(async () => {
    // Replace only the outer directory between two lazy loads. Existing bundle
    // bytes and file identities remain intact; the original root must still bind.
    await runProviderDetailed("codex", { ...input, prompt: "REPLACE_SKILL_ROOT\nREQUEST_SKILLS=skill-0,skill-1" }, 20_000);
    let launches = 0;
    const failure = await invoke({ ...input, acquireExecutionPermit: () => {
      launches++;
      return { register: () => () => {}, release: () => {} };
    } }).catch(error => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toContain("staged Skill bundle failed verification");
    expect(launches).toBe(0);
  });
}, 30_000);

test("restricted legacy sandbox calls reuse all frozen bundles without changing their permissions", async () => {
  const base = fixture(2);
  const input: RunInput = { ...base, execution: { permission: "read-only", workdir: base.workdir, skills: base.execution!.skills, skillMode: "all" } };
  let firstPath = "";
  await withProviderSkillSession(async () => {
    const first = await invoke(input);
    const second = await invoke(input);
    firstPath = JSON.parse(first.prompt.split("\n").find(line => line.startsWith("- skill-0: "))!.slice("- skill-0: ".length));
    expect(second.prompt).toContain(JSON.stringify(firstPath));
    expect(second.args).toContain("read-only");
    expect(second.prompt).not.toContain("技能加载命令");
    expect(readdirSync(dirname(dirname(firstPath)))).toHaveLength(2);
  });
  expect(existsSync(firstPath)).toBe(false);
}, 30_000);

test.each(["read-only", "write"] as const)("native topic %s calls load Skills on demand with only their request mailbox writable", async permission => {
  const base = fixture(4);
  const input: RunInput = { ...base, nativeTopic: true,
    execution: { permission, workdir: base.workdir, skills: base.execution!.skills, skillMode: "all" } };
  const before = stageRoots();
  let stagedFile = "";
  await withProviderSkillSession(async () => {
    await preflightProviderNativeSession("codex", 20_000, undefined, input.workdir, input.execution, input.skillInputs, input.protectedDataRoot);
    const result = await invoke(input, ["skill-3"]);
    stagedFile = result.paths[0]!;
    expect(readdirSync(dirname(dirname(stagedFile)))).toEqual(["skill-0003"]);
    const profile = result.args.find(arg => arg.startsWith("permissions="))!;
    expect(profile).toContain('\":root\"=\"deny\"');
    expect(profile).toContain("network={enabled=false}");
    expect(profile).toContain(`${JSON.stringify(dirname(dirname(stagedFile)))}="read"`);
    expect(profile).toContain(`${JSON.stringify(input.workdir)}="${permission === "write" ? "write" : "read"}"`);
    expect(profile).toMatch(/homeagent-skill-loader-.*requests.*="write"/);
    expect(profile).not.toContain(input.skillInputs![3]!.directory);
    expect(result.args).not.toContain("--sandbox");
    const fork = await invoke({ ...input, nativeSession: { mode: "fork", id: "11111111-2222-4333-8444-555555555555" } }, ["skill-3"]);
    expect(fork.paths).toEqual([stagedFile]);
  });
  expect(existsSync(stagedFile)).toBe(false);
  expect(stageRoots()).toEqual(before);
}, 30_000);
