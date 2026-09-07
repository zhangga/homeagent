import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import {
  codexReasoningEffortsForModel,
  curatedProviderModels,
  detectProviders,
  ensureProviderCodexHome,
  hashProviderSkillBundle,
  isCliProvider,
  isProviderNativeSessionParentMissingError,
  prepareProviderCodexHome,
  providerFailureDetail,
  providerSkillReference,
  preflightProviderNativeSession,
  ProviderRunError,
  runProvider,
  runProviderDetailed,
} from "./providers.ts";

const READ_ONLY_EXECUTION = {
  permission: "read-only" as const,
  skills: [],
};
const CODEX_STATUS_ARGS = [
  "-c",
  'cli_auth_credentials_store="file"',
  "login",
  "status",
] as const;

test("prepares a missing dedicated Codex home with a canonical directory", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "homeagent-codex-home-")));
  const target = join(root, "provider-state", "codex");
  try {
    expect(ensureProviderCodexHome({ HOMEAGENT_CODEX_HOME: target })).toBe(
      realpathSync(target),
    );
    expect(lstatSync(target).isDirectory()).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a non-directory dedicated Codex home", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "homeagent-codex-home-file-")));
  const target = join(root, "codex");
  try {
    writeFileSync(target, "not a directory", "utf8");
    expect(() => ensureProviderCodexHome({ HOMEAGENT_CODEX_HOME: target }))
      .toThrow("provider codex state directory is unavailable");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("imports only the ambient Codex auth cache into the dedicated Provider home", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "homeagent-codex-auth-import-")));
  const ambientHome = join(root, "ambient-codex");
  const providerHome = join(root, "provider-codex");
  const auth = JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "test-only" } });
  try {
    mkdirSync(join(ambientHome, "skills"), { recursive: true });
    writeFileSync(join(ambientHome, "auth.json"), auth, "utf8");
    writeFileSync(join(ambientHome, "config.toml"), "model = \"ambient\"\n", "utf8");
    writeFileSync(join(ambientHome, "skills", "ambient.txt"), "ambient", "utf8");

    expect(prepareProviderCodexHome({
      CODEX_HOME: ambientHome,
      HOMEAGENT_CODEX_HOME: providerHome,
    })).toBe(realpathSync(providerHome));
    expect(readFileSync(join(providerHome, "auth.json"), "utf8")).toBe(auth);
    expect(existsSync(join(providerHome, "config.toml"))).toBe(false);
    expect(existsSync(join(providerHome, "skills"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("does not replace an existing dedicated Codex auth cache", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "homeagent-codex-auth-existing-")));
  const ambientHome = join(root, "ambient-codex");
  const providerHome = join(root, "provider-codex");
  try {
    mkdirSync(ambientHome, { recursive: true });
    mkdirSync(providerHome, { recursive: true });
    writeFileSync(join(ambientHome, "auth.json"), '{"account":"ambient"}', "utf8");
    writeFileSync(join(providerHome, "auth.json"), '{"account":"provider"}', "utf8");

    prepareProviderCodexHome({
      CODEX_HOME: ambientHome,
      HOMEAGENT_CODEX_HOME: providerHome,
    });

    expect(readFileSync(join(providerHome, "auth.json"), "utf8"))
      .toBe('{"account":"provider"}');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("adopts a console re-login that is newer than the isolated cache", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "homeagent-codex-auth-refresh-")));
  const ambientHome = join(root, "ambient-codex");
  const providerHome = join(root, "provider-codex");
  try {
    mkdirSync(ambientHome, { recursive: true });
    mkdirSync(providerHome, { recursive: true });
    // The isolated cache holds the credential revoked by the console re-login.
    writeFileSync(
      join(providerHome, "auth.json"),
      JSON.stringify({ last_refresh: "2026-09-02T02:09:01.306Z", tokens: { t: "stale" } }),
      "utf8",
    );
    writeFileSync(
      join(ambientHome, "auth.json"),
      JSON.stringify({ last_refresh: "2026-09-07T03:16:14.345Z", tokens: { t: "fresh" } }),
      "utf8",
    );

    prepareProviderCodexHome({
      CODEX_HOME: ambientHome,
      HOMEAGENT_CODEX_HOME: providerHome,
    });

    const adopted = JSON.parse(readFileSync(join(providerHome, "auth.json"), "utf8"));
    expect(adopted.tokens.t).toBe("fresh");
    expect(adopted.last_refresh).toBe("2026-09-07T03:16:14.345Z");
    // The refreshed cache must remain a real, private, same-directory file.
    expect(lstatSync(join(providerHome, "auth.json")).isSymbolicLink()).toBe(false);
    // No staging leftovers.
    expect(readdirSync(providerHome).filter((n) => n.includes(".tmp"))).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("never rolls the isolated Codex cache back to an older ambient login", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "homeagent-codex-auth-rollback-")));
  const ambientHome = join(root, "ambient-codex");
  const providerHome = join(root, "provider-codex");
  try {
    mkdirSync(ambientHome, { recursive: true });
    mkdirSync(providerHome, { recursive: true });
    // HomeAgent refreshed its own cache; the ambient copy is now the stale one.
    writeFileSync(
      join(providerHome, "auth.json"),
      JSON.stringify({ last_refresh: "2026-09-07T03:16:14.345Z", tokens: { t: "current" } }),
      "utf8",
    );
    writeFileSync(
      join(ambientHome, "auth.json"),
      JSON.stringify({ last_refresh: "2026-09-02T02:09:01.306Z", tokens: { t: "older" } }),
      "utf8",
    );

    prepareProviderCodexHome({
      CODEX_HOME: ambientHome,
      HOMEAGENT_CODEX_HOME: providerHome,
    });

    expect(JSON.parse(readFileSync(join(providerHome, "auth.json"), "utf8")).tokens.t)
      .toBe("current");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("keeps the isolated Codex cache when the ambient copy is unusable", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "homeagent-codex-auth-keep-")));
  const ambientHome = join(root, "ambient-codex");
  const providerHome = join(root, "provider-codex");
  try {
    mkdirSync(ambientHome, { recursive: true });
    mkdirSync(providerHome, { recursive: true });
    writeFileSync(
      join(providerHome, "auth.json"),
      JSON.stringify({ last_refresh: "2026-09-02T02:09:01.306Z", tokens: { t: "usable" } }),
      "utf8",
    );
    // Unparseable ambient content must never outrank a working cache, even
    // though it is newer on disk.
    writeFileSync(join(ambientHome, "auth.json"), "not-json", "utf8");

    prepareProviderCodexHome({
      CODEX_HOME: ambientHome,
      HOMEAGENT_CODEX_HOME: providerHome,
    });

    expect(JSON.parse(readFileSync(join(providerHome, "auth.json"), "utf8")).tokens.t)
      .toBe("usable");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("drops Skills that exceed the shared staging budget instead of failing the call", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ha-codex-skill-budget-")));
  const providerDirectory = join(root, "provider");
  const dataRoot = join(root, "data");
  const workdir = join(root, "workdir");
  mkdirSync(providerDirectory, { recursive: true });
  mkdirSync(dataRoot, { recursive: true });
  mkdirSync(workdir, { recursive: true });

  // Two Skills whose combined payload cannot fit one invocation budget. The
  // first alone is under the limit, so staging must keep it and drop the rest.
  const names = ["fits-first", "over-budget"];
  const skillInputs = names.map((name) => {
    const directory = join(root, "skills", name);
    mkdirSync(directory, { recursive: true });
    const skillFile = join(directory, "SKILL.md");
    writeFileSync(skillFile, `# ${name}\n`, "utf8");
    // 9 MiB each: one fits inside the 16 MiB budget, two cannot.
    writeFileSync(join(directory, "payload.bin"), Buffer.alloc(9 * 1024 * 1024, 1));
    return { name, directory, skillFile, bundleHash: hashProviderSkillBundle(skillFile) };
  });

  try {
    process.env.HOMEAGENT_CODEX_BIN = writeArgAndStdinReportingCodexProvider(
      providerDirectory,
    );
    const output = await runProviderDetailed("codex", {
      prompt: "budget check",
      protectedDataRoot: dataRoot,
      execution: { permission: "read-only", workdir, skills: [...names], skillMode: "all" },
      skillInputs,
    }, 5000);

    const observed = JSON.parse(output.text) as { args: string[]; prompt: string };
    // The call succeeds and the surviving Skill is still offered to the model.
    expect(observed.prompt).toContain("- fits-first: ");
    // The dropped Skill must not be advertised, or the model would call a Skill
    // whose bundle was never staged.
    expect(observed.prompt).not.toContain("- over-budget: ");
    expect(observed.args.join("\0")).not.toContain("over-budget");
  } finally {
    delete process.env.HOMEAGENT_CODEX_BIN;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a Skill bundle integrity failure is never treated as a budget drop", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ha-codex-skill-integrity-")));
  const providerDirectory = join(root, "provider");
  const dataRoot = join(root, "data");
  const workdir = join(root, "workdir");
  const skillDirectory = join(root, "skills", "linked");
  const outside = join(root, "outside.txt");
  mkdirSync(providerDirectory, { recursive: true });
  mkdirSync(dataRoot, { recursive: true });
  mkdirSync(workdir, { recursive: true });
  mkdirSync(skillDirectory, { recursive: true });
  writeFileSync(outside, "secret\n", "utf8");
  const skillFile = join(skillDirectory, "SKILL.md");
  writeFileSync(skillFile, "# linked\n", "utf8");
  const bundleHash = hashProviderSkillBundle(skillFile);

  let linked = true;
  try {
    // A symlink added after freezing makes capture throw "Skill bundle cannot
    // contain symbolic links". That is an integrity failure, not a capacity
    // limit, and must fail the call rather than silently drop the Skill.
    symlinkSync(outside, join(skillDirectory, "leak.txt"), "file");
  } catch {
    linked = false;
  }

  try {
    if (!linked) return; // Windows without symlink privilege
    process.env.HOMEAGENT_CODEX_BIN = writeArgAndStdinReportingCodexProvider(
      providerDirectory,
    );
    await expect(runProviderDetailed("codex", {
      prompt: "integrity check",
      protectedDataRoot: dataRoot,
      execution: { permission: "read-only", workdir, skills: ["linked"], skillMode: "all" },
      skillInputs: [{ name: "linked", directory: skillDirectory, skillFile, bundleHash }],
    }, 5000)).rejects.toThrow(/Skill input changed after frozen validation/);
    // The provider must never have been invoked with a partially staged set.
    expect(existsSync(join(providerDirectory, "provider.calls.jsonl"))).toBe(false);
  } finally {
    delete process.env.HOMEAGENT_CODEX_BIN;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a tampered Skill bundle still fails the whole call", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ha-codex-skill-tamper-")));
  const providerDirectory = join(root, "provider");
  const dataRoot = join(root, "data");
  const workdir = join(root, "workdir");
  const skillDirectory = join(root, "skills", "tampered");
  mkdirSync(providerDirectory, { recursive: true });
  mkdirSync(dataRoot, { recursive: true });
  mkdirSync(workdir, { recursive: true });
  mkdirSync(skillDirectory, { recursive: true });
  const skillFile = join(skillDirectory, "SKILL.md");
  writeFileSync(skillFile, "# original\n", "utf8");
  const bundleHash = hashProviderSkillBundle(skillFile);
  // Content changes after the hash was frozen: this is tampering, not capacity,
  // and must never be downgraded to a silent skip by the budget handling.
  writeFileSync(skillFile, "# swapped\n", "utf8");

  try {
    process.env.HOMEAGENT_CODEX_BIN = writeArgAndStdinReportingCodexProvider(
      providerDirectory,
    );
    await expect(runProviderDetailed("codex", {
      prompt: "tamper check",
      protectedDataRoot: dataRoot,
      execution: { permission: "read-only", workdir, skills: ["tampered"], skillMode: "all" },
      skillInputs: [{ name: "tampered", directory: skillDirectory, skillFile, bundleHash }],
    }, 5000)).rejects.toThrow(/Skill input changed after frozen validation/);
  } finally {
    delete process.env.HOMEAGENT_CODEX_BIN;
    rmSync(root, { recursive: true, force: true });
  }
});

test("ignores an invalid ambient Codex auth cache", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "homeagent-codex-auth-invalid-")));
  const ambientHome = join(root, "ambient-codex");
  const providerHome = join(root, "provider-codex");
  try {
    mkdirSync(ambientHome, { recursive: true });
    writeFileSync(join(ambientHome, "auth.json"), "not-json", "utf8");

    prepareProviderCodexHome({
      CODEX_HOME: ambientHome,
      HOMEAGENT_CODEX_HOME: providerHome,
    });

    expect(existsSync(join(providerHome, "auth.json"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ignores an oversized ambient Codex auth cache", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "homeagent-codex-auth-oversized-")));
  const ambientHome = join(root, "ambient-codex");
  const providerHome = join(root, "provider-codex");
  try {
    mkdirSync(ambientHome, { recursive: true });
    writeFileSync(join(ambientHome, "auth.json"), Buffer.alloc(1024 * 1024 + 1, 0x20));

    prepareProviderCodexHome({
      CODEX_HOME: ambientHome,
      HOMEAGENT_CODEX_HOME: providerHome,
    });

    expect(existsSync(join(providerHome, "auth.json"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function stagedCodexSkillDirectories(): string[] {
  return readdirSync(tmpdir())
    .filter((name) => name.startsWith("homeagent-codex-skills-"))
    .sort();
}

test("provider failure details redact opaque session identifiers", () => {
  const sessionId = "11111111-2222-4333-8444-555555555555";
  expect(providerFailureDetail("", `no rollout found for thread id ${sessionId}`)).toBe(
    "no rollout found for thread id [redacted-id]",
  );
});

test("native parent detection excludes general capability failures", () => {
  expect(isProviderNativeSessionParentMissingError(
    new Error("no rollout found for thread id [redacted-id]"),
  )).toBe(true);
  expect(isProviderNativeSessionParentMissingError(
    new Error("provider codex returned thread id [redacted-id] not found"),
  )).toBe(true);
  expect(isProviderNativeSessionParentMissingError(
    new Error("provider codex native session capability is unavailable"),
  )).toBe(false);
  expect(isProviderNativeSessionParentMissingError(
    new Error("native session request timed out"),
  )).toBe(false);
});

function writeArgEchoProvider(directory: string, name = "provider"): string {
  const bin = join(directory, process.platform === "win32" ? `${name}.cmd` : name);
  writeFileSync(
    bin,
    process.platform === "win32"
      ? "@echo off\r\necho %*\r\n"
      : '#!/bin/sh\nprintf "%s\\n" "$*"\n',
    "utf8",
  );
  if (process.platform !== "win32") chmodSync(bin, 0o755);
  return bin;
}

function writeStaticProvider(
  directory: string,
  stdout: string,
  name = "provider",
  exitCode = 0,
): string {
  const script = join(directory, `${name}.js`);
  const bin = join(directory, process.platform === "win32" ? `${name}.cmd` : name);
  writeFileSync(
    script,
    `process.stdout.write(${JSON.stringify(stdout)});\nprocess.exitCode = ${exitCode};\n`,
    "utf8",
  );
  writeFileSync(
    bin,
    process.platform === "win32"
      ? `@echo off\r\n"${process.execPath}" "%~dp0\\${name}.js" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/${name}.js" "$@"\n`,
    "utf8",
  );
  if (process.platform !== "win32") chmodSync(bin, 0o755);
  return bin;
}

function writeEnvironmentReportingProvider(directory: string, name = "provider"): string {
  const script = join(directory, `${name}.js`);
  const bin = join(directory, process.platform === "win32" ? `${name}.cmd` : name);
  writeFileSync(
    script,
    "process.stdout.write(JSON.stringify(process.env));\n",
    "utf8",
  );
  writeFileSync(
    bin,
    process.platform === "win32"
      ? `@echo off\r\n"${process.execPath}" "%~dp0\\${name}.js" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/${name}.js" "$@"\n`,
    "utf8",
  );
  if (process.platform !== "win32") chmodSync(bin, 0o755);
  return bin;
}

function writeArgReportingCodexProvider(
  directory: string,
  sessionId: string,
  name = "provider",
  answer?: string,
): string {
  const script = join(directory, `${name}.js`);
  const calls = join(directory, `${name}.calls.jsonl`);
  const bin = join(directory, process.platform === "win32" ? `${name}.cmd` : name);
  writeFileSync(
    script,
    [
      'const { appendFileSync } = require("node:fs");',
      "const args = process.argv.slice(2);",
      `appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");`,
      "if (args.length === 1 && args[0] === '--version') process.stdout.write('codex-cli 0.152.1\\n');",
      "else if (JSON.stringify(args) === JSON.stringify(['exec', 'fork', '--help'])) process.stdout.write('Usage: codex exec fork [OPTIONS] [SESSION_ID] [PROMPT]\\n');",
      "else if (args.length === 5 && args[0] === '-c' && args[2] === 'mcp' && args[3] === 'list' && args[4] === '--json') process.stdout.write('[]');",
      "else if (args.includes('sandbox') && args.includes('-P') && args.includes('homeagent_topic')) process.exitCode = 0;",
      "else {",
      `  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: ${JSON.stringify(sessionId)} }) + "\\n");`,
      `  process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: ${answer === undefined ? "args.join(' ')" : JSON.stringify(answer)} } }) + '\\n');`,
      "  process.stdout.write(JSON.stringify({ type: 'turn.completed' }));",
      "}",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    bin,
    process.platform === "win32"
      ? `@echo off\r\n"${process.execPath}" "%~dp0\\${name}.js" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/${name}.js" "$@"\n`,
    "utf8",
  );
  if (process.platform !== "win32") chmodSync(bin, 0o755);
  return bin;
}

function writeArgAndStdinReportingCodexProvider(
  directory: string,
  name = "provider",
): string {
  const script = join(directory, `${name}.js`);
  const calls = join(directory, `${name}.calls.jsonl`);
  const bin = join(directory, process.platform === "win32" ? `${name}.cmd` : name);
  writeFileSync(
    script,
    [
      'const { appendFileSync } = require("node:fs");',
      "const args = process.argv.slice(2);",
      `appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");`,
      "if (args.length === 1 && args[0] === '--version') process.stdout.write('codex-cli 0.152.1\\n');",
      "else if (JSON.stringify(args) === JSON.stringify(['exec', 'fork', '--help'])) process.stdout.write('Usage: codex exec fork [OPTIONS] [SESSION_ID] [PROMPT]\\n');",
      "else if (args.length === 5 && args[0] === '-c' && args[2] === 'mcp' && args[3] === 'list' && args[4] === '--json') process.stdout.write('[]');",
      "else if (args.includes('sandbox') && args.includes('-P') && args.includes('homeagent_topic')) process.exitCode = 0;",
      "else {",
      "  let prompt = '';",
      '  process.stdin.setEncoding("utf8");',
      "  process.stdin.on('data', (chunk) => { prompt += chunk; });",
      "  process.stdin.on('end', () => {",
      "    const text = JSON.stringify({ args, prompt });",
      "    process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }) + '\\n');",
      "    process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }) + '\\n');",
      "    process.stdout.write(JSON.stringify({ type: 'turn.completed' }));",
      "  });",
      "}",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    bin,
    process.platform === "win32"
      ? `@echo off\r\n"${process.execPath}" "%~dp0\\${name}.js" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/${name}.js" "$@"\n`,
    "utf8",
  );
  if (process.platform !== "win32") chmodSync(bin, 0o755);
  return bin;
}

function writeLiveSkillMutatingCodexProvider(
  directory: string,
  liveSkillFile: string,
  name = "provider",
): string {
  const script = join(directory, `${name}.js`);
  const calls = join(directory, `${name}.calls.jsonl`);
  const bin = join(directory, process.platform === "win32" ? `${name}.cmd` : name);
  writeFileSync(
    script,
    [
      'const { appendFileSync, readFileSync, writeFileSync } = require("node:fs");',
      "const args = process.argv.slice(2);",
      `appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");`,
      "if (args.length === 1 && args[0] === '--version') process.stdout.write('codex-cli 0.152.1\\n');",
      "else if (JSON.stringify(args) === JSON.stringify(['exec', 'fork', '--help'])) process.stdout.write('Usage: codex exec fork [OPTIONS] [SESSION_ID] [PROMPT]\\n');",
      "else if (args.length === 5 && args[0] === '-c' && args[2] === 'mcp' && args[3] === 'list' && args[4] === '--json') process.stdout.write('[]');",
      "else if (args.includes('sandbox') && args.includes('-P') && args.includes('homeagent_topic')) process.exitCode = 0;",
      "else {",
      "  let prompt = '';",
      '  process.stdin.setEncoding("utf8");',
      "  process.stdin.on('data', (chunk) => { prompt += chunk; });",
      "  process.stdin.on('end', () => {",
      `    writeFileSync(${JSON.stringify(liveSkillFile)}, '# Mutated live Skill\\n', 'utf8');`,
      "    const line = prompt.split('\\n').find((item) => item.startsWith('- review: '));",
      "    const stagedPath = JSON.parse(line.slice('- review: '.length));",
      "    const stagedContent = readFileSync(stagedPath, 'utf8');",
      "    process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }) + '\\n');",
      "    process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: stagedContent } }) + '\\n');",
      "    process.stdout.write(JSON.stringify({ type: 'turn.completed' }));",
      "  });",
      "}",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    bin,
    process.platform === "win32"
      ? `@echo off\r\n"${process.execPath}" "%~dp0\\${name}.js" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/${name}.js" "$@"\n`,
    "utf8",
  );
  if (process.platform !== "win32") chmodSync(bin, 0o755);
  return bin;
}

function writeArgReportingClaudeProvider(
  directory: string,
  sessionId: string,
  name = "provider",
): string {
  const script = join(directory, `${name}.js`);
  const bin = join(directory, process.platform === "win32" ? `${name}.cmd` : name);
  writeFileSync(
    script,
    [
      "const args = process.argv.slice(2);",
      "process.stdout.write(JSON.stringify({",
      "  type: 'result',",
      "  subtype: 'success',",
      "  result: args.join(' '),",
      `  session_id: ${JSON.stringify(sessionId)},`,
      "  usage: {},",
      "}));",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    bin,
    process.platform === "win32"
      ? `@echo off\r\n"${process.execPath}" "%~dp0\\${name}.js" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/${name}.js" "$@"\n`,
    "utf8",
  );
  if (process.platform !== "win32") chmodSync(bin, 0o755);
  return bin;
}

function writeArgAndStdinReportingClaudeProvider(
  directory: string,
  name = "provider",
): string {
  const script = join(directory, `${name}.js`);
  const bin = join(directory, process.platform === "win32" ? `${name}.cmd` : name);
  writeFileSync(
    script,
    [
      "const args = process.argv.slice(2);",
      "let prompt = '';",
      'process.stdin.setEncoding("utf8");',
      "process.stdin.on('data', (chunk) => { prompt += chunk; });",
      "process.stdin.on('end', () => {",
      "  process.stdout.write(JSON.stringify({",
      "    type: 'result',",
      "    subtype: 'success',",
      "    result: JSON.stringify({ args, prompt }),",
      "    usage: {},",
      "  }));",
      "});",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    bin,
    process.platform === "win32"
      ? `@echo off\r\n"${process.execPath}" "%~dp0\\${name}.js" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/${name}.js" "$@"\n`,
    "utf8",
  );
  if (process.platform !== "win32") chmodSync(bin, 0o755);
  return bin;
}

function writeCodexSchemaInspector(directory: string, name = "provider"): string {
  const script = join(directory, `${name}.js`);
  const bin = join(directory, process.platform === "win32" ? `${name}.cmd` : name);
  writeFileSync(
    script,
    [
      'const { existsSync, readFileSync, writeFileSync } = require("node:fs");',
      "const args = process.argv.slice(2);",
      'const index = args.indexOf("--output-schema");',
      'if (index < 0 || !args[index + 1]) { process.stderr.write("missing output schema"); process.exit(41); }',
      'const outputIndex = args.findIndex((arg) => arg === "-o" || arg === "--output-last-message");',
      'if (outputIndex < 0 || !args[outputIndex + 1]) { process.stderr.write("missing final output path"); process.exit(42); }',
      "const schemaPath = args[index + 1];",
      "let prompt = '';",
      'process.stdin.setEncoding("utf8");',
      "process.stdin.on('data', (chunk) => { prompt += chunk; });",
      "process.stdin.on('end', () => {",
      "  const text = JSON.stringify({",
      '    schema: JSON.parse(readFileSync(schemaPath, "utf8")),',
      "    schemaPath,",
      "    schemaExistsDuringRun: existsSync(schemaPath),",
      "    prompt,",
      "  });",
      '  writeFileSync(args[outputIndex + 1], text, "utf8");',
      "  process.stdout.write(JSON.stringify({ type: 'turn.completed' }));",
      "});",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    bin,
    process.platform === "win32"
      ? `@echo off\r\n"${process.execPath}" "%~dp0\\${name}.js" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/${name}.js" "$@"\n`,
    "utf8",
  );
  if (process.platform !== "win32") chmodSync(bin, 0o755);
  return bin;
}

function writeCodexFinalArtifactProvider(
  directory: string,
  finalOutput = JSON.stringify({ content: "# Knowledge\n\nDurable result" }),
  stdout = JSON.stringify({
    type: "turn.completed",
    usage: { input_tokens: 240, output_tokens: 45 },
  }),
  name = "provider",
): string {
  const script = join(directory, `${name}.js`);
  const bin = join(directory, process.platform === "win32" ? `${name}.cmd` : name);
  writeFileSync(
    script,
    [
      'const { writeFileSync } = require("node:fs");',
      "const args = process.argv.slice(2);",
      'const outputIndex = args.findIndex((arg) => arg === "-o" || arg === "--output-last-message");',
      'if (outputIndex < 0 || !args[outputIndex + 1]) { process.stderr.write("missing final output path"); process.exit(41); }',
      `const finalOutput = ${JSON.stringify(finalOutput)};`,
      'writeFileSync(args[outputIndex + 1], finalOutput, "utf8");',
      `process.stdout.write(${JSON.stringify(stdout)});`,
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    bin,
    process.platform === "win32"
      ? `@echo off\r\n"${process.execPath}" "%~dp0\\${name}.js" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/${name}.js" "$@"\n`,
    "utf8",
  );
  if (process.platform !== "win32") chmodSync(bin, 0o755);
  return bin;
}

function writeCodexSchemaRejector(
  directory: string,
  capturedPathFile: string,
  name = "provider",
): string {
  const script = join(directory, `${name}.js`);
  const bin = join(directory, process.platform === "win32" ? `${name}.cmd` : name);
  writeFileSync(
    script,
    [
      'const { writeFileSync } = require("node:fs");',
      "const args = process.argv.slice(2);",
      'const index = args.indexOf("--output-schema");',
      'if (index < 0 || !args[index + 1]) { process.stderr.write("missing output schema"); process.exit(41); }',
      `writeFileSync(${JSON.stringify(capturedPathFile)}, args[index + 1], "utf8");`,
      'process.stderr.write("structured output rejected");',
      "process.exitCode = 42;",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    bin,
    process.platform === "win32"
      ? `@echo off\r\n"${process.execPath}" "%~dp0\\${name}.js" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/${name}.js" "$@"\n`,
    "utf8",
  );
  if (process.platform !== "win32") chmodSync(bin, 0o755);
  return bin;
}

function writeVersionAndHelpProvider(
  directory: string,
  help: string,
  name = "provider",
  authStatus = '{"loggedIn":true}',
  authExitCode = 0,
  authDelayMs = 0,
): string {
  const script = join(directory, `${name}.js`);
  const calls = join(directory, `${name}.calls.jsonl`);
  const bin = join(directory, process.platform === "win32" ? `${name}.cmd` : name);
  writeFileSync(
    script,
    [
      'const { appendFileSync } = require("node:fs");',
      `const help = ${JSON.stringify(help)};`,
      "const args = process.argv.slice(2);",
      `appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");`,
      `if (args.length === 1 && args[0] === "--help") process.stdout.write(help);`,
      `else if (args.length === 1 && args[0] === "--version") process.stdout.write(${JSON.stringify(`${name} 1.0\n`)});`,
      `else if (JSON.stringify(args) === ${JSON.stringify(JSON.stringify(["auth", "status", "--json"]))}) { const finish = () => { process.stdout.write(${JSON.stringify(authStatus)}); process.exitCode = ${authExitCode}; }; ${authDelayMs} > 0 ? setTimeout(finish, ${authDelayMs}) : finish(); }`,
      "else process.exitCode = 42;",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    bin,
    process.platform === "win32"
      ? `@echo off\r\n"${process.execPath}" "%~dp0\\${name}.js" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/${name}.js" "$@"\n`,
    "utf8",
  );
  if (process.platform !== "win32") chmodSync(bin, 0o755);
  return bin;
}

function writeCodexStatusProvider(
  directory: string,
  name: string,
  statusExitCode: number,
  statusArgs: readonly string[] = CODEX_STATUS_ARGS,
  forkHelpExitCode = 0,
  version = `${name} 1.0.0`,
  mcpListOutput = "[]",
  mcpListExitCode = 0,
  sandboxExitCode = 0,
  sandboxStderr = "",
  keyringStatusExitCode?: number,
  mcpListStderr = "",
): string {
  const script = join(directory, `${name}.js`);
  const calls = join(directory, `${name}.calls.jsonl`);
  const bin = join(directory, process.platform === "win32" ? `${name}.cmd` : name);
  writeFileSync(
    script,
    [
      'const { appendFileSync } = require("node:fs");',
      "const args = process.argv.slice(2);",
      `appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");`,
      `if (args.length === 1 && args[0] === "--version") process.stdout.write(${JSON.stringify(`${version}\n`)});`,
      `else if (JSON.stringify(args) === ${JSON.stringify(JSON.stringify(statusArgs))}) { process.stdout.write("${statusExitCode === 0 ? "Logged in using ChatGPT" : "Not logged in"}\\n"); process.exitCode = ${statusExitCode}; }`,
      ...(keyringStatusExitCode === undefined
        ? []
        : [`else if (JSON.stringify(args) === ${JSON.stringify(JSON.stringify([
            "-c",
            'cli_auth_credentials_store="keyring"',
            "login",
            "status",
          ]))}) { process.stdout.write("${keyringStatusExitCode === 0 ? "Logged in using ChatGPT" : "Not logged in"}\\n"); process.exitCode = ${keyringStatusExitCode}; }`]),
      `else if (JSON.stringify(args) === ${JSON.stringify(JSON.stringify(["exec", "fork", "--help"]))}) { process.stdout.write("Usage: codex exec fork [OPTIONS] [SESSION_ID] [PROMPT]\\n"); process.exitCode = ${forkHelpExitCode}; }`,
      `else if (args.length === 5 && args[0] === "-c" && args[2] === "mcp" && args[3] === "list" && args[4] === "--json") { process.stdout.write(${JSON.stringify(mcpListOutput)}); process.stderr.write(${JSON.stringify(mcpListStderr)}); process.exitCode = ${mcpListExitCode}; }`,
      `else if (args.includes("sandbox") && args.includes("-P") && args.includes("homeagent_topic")) { process.stderr.write(${JSON.stringify(sandboxStderr)}); process.exitCode = ${sandboxExitCode}; }`,
      "else process.exitCode = 42;",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    bin,
    process.platform === "win32"
      ? `@echo off\r\n"${process.execPath}" "%~dp0\\${name}.js" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/${name}.js" "$@"\n`,
    "utf8",
  );
  if (process.platform !== "win32") chmodSync(bin, 0o755);
  return bin;
}

const COMPLETE_CLAUDE_HELP = [
  "Usage: claude [options]",
  "-p, --print",
  "--safe-mode",
  "--no-session-persistence",
  "--strict-mcp-config",
  "--output-format <format>",
  "--tools <tools...>",
  "--model <model>",
  "--append-system-prompt <prompt>",
  "--resume <session-id>",
  "--fork-session",
].join("\n");

function providerProbeCalls(directory: string, name: string): string[][] {
  return readFileSync(join(directory, `${name}.calls.jsonl`), "utf8")
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}

function codexMcpListArgs(workdir?: string): string[] {
  const absoluteWorkdir = resolve(workdir ?? process.cwd());
  return [
    "-c",
    `projects={${JSON.stringify(absoluteWorkdir)}={trust_level="untrusted"}}`,
    "mcp",
    "list",
    "--json",
  ];
}

describe("Codex model capabilities", () => {
  test("reasoning effort choices follow the selected model", () => {
    expect(codexReasoningEffortsForModel("gpt-5.6-sol")).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(codexReasoningEffortsForModel("gpt-5.5")).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(codexReasoningEffortsForModel("gpt-5.3-codex-spark")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(codexReasoningEffortsForModel("custom-codex-model")).toEqual([]);
    expect(codexReasoningEffortsForModel("gpt-5.6-custom")).toEqual([]);
    expect(codexReasoningEffortsForModel()).toEqual([]);
  });
});

describe("provider detection", () => {
  test("provider subprocesses receive an allowlisted environment without host secrets", async () => {
    const keys = [
      "HOMEAGENT_TRAE_BIN",
      "HOMEAGENT_FEISHU_APP_SECRET",
      "CODEX_APP_TOOLS_PIPE_PATH",
      "CODEX_SESSION_ID",
      "GITHUB_TOKEN",
      "APIROUTER_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S",
      "GIT_CONFIG_KEY_0",
      "CODEX_HOME",
      "HOMEAGENT_CODEX_HOME",
    ] as const;
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    const directory = mkdtempSync(join(tmpdir(), "ha-provider-clean-env-"));
    try {
      process.env.HOMEAGENT_TRAE_BIN = writeEnvironmentReportingProvider(directory);
      process.env.HOMEAGENT_FEISHU_APP_SECRET = "feishu-secret-sentinel";
      process.env.CODEX_APP_TOOLS_PIPE_PATH = "desktop-tools-sentinel";
      process.env.CODEX_SESSION_ID = "desktop-session-sentinel";
      process.env.GITHUB_TOKEN = "github-token-sentinel";
      process.env.APIROUTER_API_KEY = "router-key-sentinel";
      process.env.ANTHROPIC_AUTH_TOKEN = "anthropic-token-sentinel";
      process.env.NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S = "repl-sentinel";
      process.env.GIT_CONFIG_KEY_0 = "git-config-sentinel";
      process.env.CODEX_HOME = join(directory, "ambient-codex-home");
      process.env.HOMEAGENT_CODEX_HOME = join(directory, "homeagent-codex-home");

      const output = await runProviderDetailed(
        "trae-cli",
        { prompt: "inspect", execution: READ_ONLY_EXECUTION },
        500,
      );
      const childEnvironment = JSON.parse(output.text) as Record<string, string>;

      expect(childEnvironment.PATH).toBeTruthy();
      expect(childEnvironment.NO_COLOR).toBe("1");
      expect(childEnvironment.CODEX_HOME).toBe(process.env.HOMEAGENT_CODEX_HOME);
      expect(childEnvironment.CODEX_HOME).not.toBe(process.env.CODEX_HOME);
      for (const forbidden of keys.filter(
        (key) => key !== "CODEX_HOME" && key !== "HOMEAGENT_CODEX_HOME",
      )) {
        expect(childEnvironment[forbidden]).toBeUndefined();
      }
      expect(childEnvironment.HOMEAGENT_CODEX_HOME).toBeUndefined();
    } finally {
      for (const key of keys) {
        const value = previous[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("maps a validated Skill name to each provider's invocation syntax", () => {
    expect(providerSkillReference("codex", "code-review")).toBe("$code-review");
    expect(providerSkillReference("claude", "code-review")).toBe("/code-review");
    expect(providerSkillReference("trae-cli", "code-review")).toBe("code-review");
    expect(providerSkillReference("gateway", "code-review")).toBeUndefined();
    expect(providerSkillReference("codex", "../escape")).toBeUndefined();
  });

  test("Claude returns provider-reported token usage and cost with the answer", async () => {
    const previous = process.env.HOMEAGENT_CLAUDE_BIN;
    const directory = mkdtempSync(join(tmpdir(), "ha-claude-usage-"));
    try {
      process.env.HOMEAGENT_CLAUDE_BIN = writeStaticProvider(
        directory,
        JSON.stringify({
          type: "result",
          subtype: "success",
          result: "final answer",
          total_cost_usd: 0.0123,
          usage: {
            input_tokens: 120,
            cache_read_input_tokens: 80,
            cache_creation_input_tokens: 10,
            output_tokens: 30,
          },
        }),
      );

      const output = await runProviderDetailed("claude", { prompt: "answer" }, 500);

      expect(output).toEqual({
        text: "final answer",
        usage: {
          inputTokens: 120,
          cachedInputTokens: 80,
          cacheCreationInputTokens: 10,
          outputTokens: 30,
          costUsd: 0.0123,
          costBasis: "reported",
          source: "claude-json",
        },
      });
    } finally {
      if (previous === undefined) delete process.env.HOMEAGENT_CLAUDE_BIN;
      else process.env.HOMEAGENT_CLAUDE_BIN = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("Claude requests JSON and marks unstructured fallback output as unavailable", async () => {
    const previous = process.env.HOMEAGENT_CLAUDE_BIN;
    const directory = mkdtempSync(join(tmpdir(), "ha-claude-json-argv-"));
    try {
      process.env.HOMEAGENT_CLAUDE_BIN = writeArgEchoProvider(directory);

      const output = await runProviderDetailed("claude", { prompt: "answer" }, 500);

      expect(output).toEqual({
        text: expect.stringContaining("--output-format json"),
        usage: {
          costBasis: "unavailable",
          source: "legacy-text",
        },
      });
    } finally {
      if (previous === undefined) delete process.env.HOMEAGENT_CLAUDE_BIN;
      else process.env.HOMEAGENT_CLAUDE_BIN = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("Claude structured failures are errors with their reported spend attached", async () => {
    const previous = process.env.HOMEAGENT_CLAUDE_BIN;
    const directory = mkdtempSync(join(tmpdir(), "ha-claude-result-error-"));
    try {
      process.env.HOMEAGENT_CLAUDE_BIN = writeStaticProvider(
        directory,
        JSON.stringify({
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          result: `API Error: 429 Too Many Requests\n\u0000${"x".repeat(1_000)}`,
          total_cost_usd: 0.004,
          usage: { input_tokens: 40, output_tokens: 5 },
        }),
      );

      let failure: unknown;
      try {
        await runProviderDetailed("claude", { prompt: "answer" }, 500);
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(ProviderRunError);
      expect(String(failure)).toContain("429 Too Many Requests");
      expect(String(failure)).not.toMatch(/[\r\n\u0000]/u);
      expect(String(failure).length).toBeLessThanOrEqual(400);
      expect((failure as ProviderRunError).usage).toEqual({
        inputTokens: 40,
        outputTokens: 5,
        costUsd: 0.004,
        costBasis: "reported",
        source: "claude-json",
      });
    } finally {
      if (previous === undefined) delete process.env.HOMEAGENT_CLAUDE_BIN;
      else process.env.HOMEAGENT_CLAUDE_BIN = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("Claude preserves structured failure usage when its CLI exits non-zero", async () => {
    const previous = process.env.HOMEAGENT_CLAUDE_BIN;
    const directory = mkdtempSync(join(tmpdir(), "ha-claude-exit-usage-"));
    try {
      process.env.HOMEAGENT_CLAUDE_BIN = writeStaticProvider(
        directory,
        JSON.stringify({
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          total_cost_usd: 0.006,
          usage: { input_tokens: 60, output_tokens: 7 },
        }),
        "provider",
        1,
      );

      let failure: unknown;
      try {
        await runProviderDetailed("claude", { prompt: "answer" }, 500);
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(ProviderRunError);
      expect((failure as ProviderRunError).usage).toEqual({
        inputTokens: 60,
        outputTokens: 7,
        costUsd: 0.006,
        costBasis: "reported",
        source: "claude-json",
      });
    } finally {
      if (previous === undefined) delete process.env.HOMEAGENT_CLAUDE_BIN;
      else process.env.HOMEAGENT_CLAUDE_BIN = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("Claude rejects a non-zero structured success while preserving its usage", async () => {
    const previous = process.env.HOMEAGENT_CLAUDE_BIN;
    const directory = mkdtempSync(join(tmpdir(), "ha-claude-exit-success-usage-"));
    try {
      process.env.HOMEAGENT_CLAUDE_BIN = writeStaticProvider(
        directory,
        JSON.stringify({
          type: "result",
          subtype: "success",
          result: "must not be accepted",
          total_cost_usd: 0.009,
          usage: { input_tokens: 70, output_tokens: 8 },
        }),
        "provider",
        1,
      );

      let failure: unknown;
      try {
        await runProviderDetailed("claude", { prompt: "answer" }, 500);
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(ProviderRunError);
      expect(String(failure)).toContain("exited 1");
      expect((failure as ProviderRunError).usage).toEqual({
        inputTokens: 70,
        outputTokens: 8,
        costUsd: 0.009,
        costBasis: "reported",
        source: "claude-json",
      });
    } finally {
      if (previous === undefined) delete process.env.HOMEAGENT_CLAUDE_BIN;
      else process.env.HOMEAGENT_CLAUDE_BIN = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("Codex returns final JSONL answer and token usage without inventing cost", async () => {
    const previous = process.env.HOMEAGENT_CODEX_BIN;
    const directory = mkdtempSync(join(tmpdir(), "ha-codex-usage-"));
    try {
      process.env.HOMEAGENT_CODEX_BIN = writeStaticProvider(
        directory,
        [
          JSON.stringify({ type: "thread.started", thread_id: "thread_1" }),
          JSON.stringify({
            type: "item.completed",
            item: { id: "item_1", type: "agent_message", text: "final answer" },
          }),
          JSON.stringify({
            type: "turn.completed",
            usage: {
              input_tokens: 240,
              cached_input_tokens: 180,
              cache_write_input_tokens: 15,
              output_tokens: 45,
              reasoning_output_tokens: 12,
            },
          }),
        ].join("\n"),
      );

      const output = await runProviderDetailed(
        "codex",
        { prompt: "answer", execution: READ_ONLY_EXECUTION },
        500,
      );

      expect(output).toEqual({
        text: "final answer",
        usage: {
          inputTokens: 240,
          cachedInputTokens: 180,
          cacheCreationInputTokens: 15,
          outputTokens: 45,
          reasoningTokens: 12,
          costBasis: "unavailable",
          source: "codex-jsonl",
        },
      });
    } finally {
      if (previous === undefined) delete process.env.HOMEAGENT_CODEX_BIN;
      else process.env.HOMEAGENT_CODEX_BIN = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("Claude rejects native sessions when OAuth, frozen Skills, and isolation cannot coexist", async () => {
    for (const nativeSession of [
      { mode: "start" as const },
      {
        mode: "fork" as const,
        id: "11111111-2222-4333-8444-555555555555",
      },
    ]) {
      await expect(runProviderDetailed(
        "claude",
        {
          prompt: "topic turn",
          execution: READ_ONLY_EXECUTION,
          nativeSession,
        },
        500,
      )).rejects.toThrow("does not support isolated native sessions");
    }
  });

  test("Codex starts a persistent native session and returns its id", async () => {
    const previous = process.env.HOMEAGENT_CODEX_BIN;
    const directory = mkdtempSync(join(tmpdir(), "ha-codex-native-session-"));
    const sessionId = "11111111-2222-4333-8444-555555555555";
    try {
      process.env.HOMEAGENT_CODEX_BIN = writeArgReportingCodexProvider(
        directory,
        sessionId,
        "provider",
        "continued answer",
      );

      const output = await runProviderDetailed(
        "codex",
        {
          prompt: "start topic",
          execution: READ_ONLY_EXECUTION,
          nativeSession: { mode: "start" },
        },
        500,
      );

      expect(output).toEqual(expect.objectContaining({
        text: "continued answer",
        nativeSessionId: sessionId,
      }));
      const mcpProbe = providerProbeCalls(directory, "provider")[2]!;
      expect(mcpProbe).toEqual(expect.arrayContaining(["mcp", "list", "--json"]));
      expect(mcpProbe.join(" ")).toContain("homeagent-codex-workdir-");
      expect(mcpProbe.join(" ")).not.toContain(resolve(process.cwd()));
    } finally {
      if (previous === undefined) delete process.env.HOMEAGENT_CODEX_BIN;
      else process.env.HOMEAGENT_CODEX_BIN = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("Codex native session accepts an empty MCP list in its exact workdir", async () => {
    const previous = process.env.HOMEAGENT_CODEX_BIN;
    const directory = mkdtempSync(join(tmpdir(), "ha-codex-native-session-argv-"));
    const sessionId = "11111111-2222-4333-8444-555555555555";
    try {
      process.env.HOMEAGENT_CODEX_BIN = writeArgReportingCodexProvider(
        directory,
        sessionId,
      );

      const output = await runProviderDetailed(
        "codex",
        {
          prompt: "start topic",
          execution: { ...READ_ONLY_EXECUTION, workdir: directory },
          nativeSession: { mode: "start" },
        },
        500,
      );

      expect(output.text).toContain(
        "exec --strict-config --ignore-user-config --ignore-rules --json --skip-git-repo-check",
      );
      expect(output.text).toContain('-c default_permissions="homeagent_topic"');
      expect(output.text).toContain('\":root\"=\"deny\"');
      expect(output.text).toContain("skills={include_instructions=false,bundled={enabled=false},config=[]}");
      expect(output.text).toContain('-c approvals_reviewer="user"');
      expect(output.text).toContain("projects={");
      expect(output.text).toContain("={trust_level=\"untrusted\"}}");
      expect(output.text).toContain('cli_auth_credentials_store="file"');
      expect(output.text).toContain('shell_environment_policy.inherit="core"');
      expect(output.text).toContain("shell_environment_policy.include_only=");
      expect(output.text).toContain("allow_login_shell=false");
      expect(output.text).toContain("-c project_doc_max_bytes=0");
      expect(output.text).toContain('-c developer_instructions=""');
      for (const feature of [
        "hooks",
        "apps",
        "goals",
        "multi_agent",
        "plugins",
        "remote_plugin",
        "memories",
      ]) {
        expect(output.text).toContain(`--disable ${feature}`);
      }
      expect(output.text).not.toContain("--ephemeral");
      expect(output.text).not.toContain("--sandbox");
      expect(providerProbeCalls(directory, "provider").slice(0, 3)).toEqual([
        ["--version"],
        ["exec", "fork", "--help"],
        codexMcpListArgs(directory),
      ]);
    } finally {
      if (previous === undefined) delete process.env.HOMEAGENT_CODEX_BIN;
      else process.env.HOMEAGENT_CODEX_BIN = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("Codex topic routing stays ephemeral while using the exact frozen Skill profile", async () => {
    const previous = process.env.HOMEAGENT_CODEX_BIN;
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ha-codex-topic-routing-")));
    const providerDirectory = join(root, "provider");
    const dataRoot = join(root, "data");
    const workdir = join(root, "workdir");
    const skillDirectory = join(root, "skills", "ambient-probe");
    mkdirSync(providerDirectory, { recursive: true });
    mkdirSync(dataRoot, { recursive: true });
    mkdirSync(workdir, { recursive: true });
    mkdirSync(skillDirectory, { recursive: true });
    const skillFile = join(skillDirectory, "SKILL.md");
    writeFileSync(skillFile, "# Frozen skill\n", "utf8");
    const stagedBefore = stagedCodexSkillDirectories();
    try {
      process.env.HOMEAGENT_CODEX_BIN = writeArgAndStdinReportingCodexProvider(
        providerDirectory,
      );

      const output = await runProviderDetailed("codex", {
        prompt: "classify this topic",
        protectedDataRoot: dataRoot,
        execution: {
          permission: "read-only",
          workdir,
          skills: ["ambient-probe"],
          skillMode: "all",
        },
        skillInputs: [{
          name: "ambient-probe",
          directory: skillDirectory,
          skillFile,
          bundleHash: hashProviderSkillBundle(skillFile),
        }],
        nativeSessionIsolation: true,
      }, 500);
      const observed = JSON.parse(output.text) as { args: string[]; prompt: string };

      expect(observed.args).toContain('default_permissions="homeagent_topic"');
      expect(observed.args).toContain("--ephemeral");
      expect(observed.args).not.toContain("--sandbox");
      expect(observed.args).toContain(
        "skills={include_instructions=false,bundled={enabled=false},config=[]}",
      );
      expect(observed.prompt).not.toContain(realpathSync(skillDirectory));
      expect(observed.prompt).toContain("homeagent-codex-skills-");
      expect(observed.args.join("\0")).not.toContain(realpathSync(skillDirectory));
      const skillLine = observed.prompt.split("\n")
        .find((line) => line.startsWith("- ambient-probe: "))!;
      const stagedSkillFile = JSON.parse(skillLine.slice("- ambient-probe: ".length)) as string;
      expect(stagedSkillFile).toContain("homeagent-codex-skills-");
      expect(existsSync(stagedSkillFile)).toBe(false);
      expect(stagedCodexSkillDirectories()).toEqual(stagedBefore);
      expect(observed.prompt).not.toContain("$ambient-probe");
      const calls = providerProbeCalls(providerDirectory, "provider");
      expect(calls).toHaveLength(5);
      expect(calls[3]).toEqual(expect.arrayContaining([
        "sandbox",
        "-P",
        "homeagent_topic",
        "--include-managed-config",
        "-C",
        realpathSync(workdir),
      ]));
      const sandboxProbe = calls[3]!;
      const encodedIndex = sandboxProbe.indexOf("-EncodedCommand");
      const probeCommand = process.platform === "win32"
        ? Buffer.from(sandboxProbe[encodedIndex + 1]!, "base64").toString("utf16le")
        : sandboxProbe.join(" ");
      expect(probeCommand).toContain(".homeagent-isolation-probe-");
      expect(probeCommand).toContain("codex-root-deny-probe-");
      expect(probeCommand).toContain("homeagent-codex-read-probe-");
    } finally {
      if (previous === undefined) delete process.env.HOMEAGENT_CODEX_BIN;
      else process.env.HOMEAGENT_CODEX_BIN = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Codex native start and fork expose only this turn's staged Skill mapping", async () => {
    const previousBin = process.env.HOMEAGENT_CODEX_BIN;
    const previousHome = process.env.HOMEAGENT_CODEX_HOME;
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ha-codex-staged-native-")));
    const providerDirectory = join(root, "provider");
    const dataRoot = join(root, "data");
    const workdir = join(root, "workdir");
    const codexHome = join(root, "codex-home");
    const liveSkillDirectory = join(root, "live-skills", "review");
    mkdirSync(providerDirectory, { recursive: true });
    mkdirSync(dataRoot, { recursive: true });
    mkdirSync(workdir, { recursive: true });
    mkdirSync(codexHome, { recursive: true });
    mkdirSync(liveSkillDirectory, { recursive: true });
    const skillFile = join(liveSkillDirectory, "SKILL.md");
    writeFileSync(skillFile, "# Frozen review\n", "utf8");
    const skillInput = {
      name: "review",
      directory: realpathSync(liveSkillDirectory),
      skillFile: realpathSync(skillFile),
      bundleHash: hashProviderSkillBundle(skillFile),
    };
    const stagedBefore = stagedCodexSkillDirectories();
    try {
      process.env.HOMEAGENT_CODEX_BIN = writeArgAndStdinReportingCodexProvider(
        providerDirectory,
      );
      process.env.HOMEAGENT_CODEX_HOME = codexHome;
      const observations: Array<{ args: string[]; prompt: string }> = [];
      for (const nativeSession of [
        { mode: "start" as const },
        { mode: "fork" as const, id: "11111111-2222-4333-8444-555555555555" },
      ]) {
        const output = await runProviderDetailed("codex", {
          prompt: "use review",
          protectedDataRoot: dataRoot,
          execution: {
            permission: "read-only",
            workdir,
            skills: ["review"],
            skillMode: "all",
          },
          skillInputs: [skillInput],
          nativeSession,
        }, 500);
        observations.push(JSON.parse(output.text) as { args: string[]; prompt: string });
      }

      expect(observations).toHaveLength(2);
      for (const observed of observations) {
        expect(observed.prompt).toContain("本轮唯一有效的技能映射");
        expect(observed.prompt).toContain("忽略会话历史中的旧技能路径");
        expect(observed.prompt).toContain("homeagent-codex-skills-");
        expect(observed.prompt).not.toContain(realpathSync(liveSkillDirectory));
        expect(observed.args.join("\0")).not.toContain(realpathSync(liveSkillDirectory));
      }
      expect(observations[1]!.args).toEqual(expect.arrayContaining([
        "fork",
        "11111111-2222-4333-8444-555555555555",
      ]));
      expect(stagedCodexSkillDirectories()).toEqual(stagedBefore);
    } finally {
      if (previousBin === undefined) delete process.env.HOMEAGENT_CODEX_BIN;
      else process.env.HOMEAGENT_CODEX_BIN = previousBin;
      if (previousHome === undefined) delete process.env.HOMEAGENT_CODEX_HOME;
      else process.env.HOMEAGENT_CODEX_HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Codex rejects a Skill changed before preflight without starting a subprocess", async () => {
    const previousBin = process.env.HOMEAGENT_CODEX_BIN;
    const previousHome = process.env.HOMEAGENT_CODEX_HOME;
    const root = mkdtempSync(join(tmpdir(), "ha-codex-staged-preflight-change-"));
    const providerDirectory = join(root, "provider");
    const dataRoot = join(root, "data");
    const workdir = join(root, "workdir");
    const codexHome = join(root, "codex-home");
    const skillDirectory = join(root, "skills", "review");
    for (const directory of [providerDirectory, dataRoot, workdir, codexHome, skillDirectory]) {
      mkdirSync(directory, { recursive: true });
    }
    const skillFile = join(skillDirectory, "SKILL.md");
    writeFileSync(skillFile, "# Before\n", "utf8");
    const bundleHash = hashProviderSkillBundle(skillFile);
    writeFileSync(skillFile, "# After\n", "utf8");
    try {
      process.env.HOMEAGENT_CODEX_BIN = writeArgAndStdinReportingCodexProvider(
        providerDirectory,
      );
      process.env.HOMEAGENT_CODEX_HOME = codexHome;
      await expect(preflightProviderNativeSession(
        "codex",
        500,
        undefined,
        realpathSync(workdir),
        { permission: "read-only", workdir: realpathSync(workdir), skills: ["review"] },
        [{
          name: "review",
          directory: realpathSync(skillDirectory),
          skillFile: realpathSync(skillFile),
          bundleHash,
        }],
        realpathSync(dataRoot),
      )).rejects.toThrow("native session isolation is unavailable");
      expect(existsSync(join(providerDirectory, "provider.calls.jsonl"))).toBe(false);
    } finally {
      if (previousBin === undefined) delete process.env.HOMEAGENT_CODEX_BIN;
      else process.env.HOMEAGENT_CODEX_BIN = previousBin;
      if (previousHome === undefined) delete process.env.HOMEAGENT_CODEX_HOME;
      else process.env.HOMEAGENT_CODEX_HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Codex does not start a stateful final turn when a routed Skill changes", async () => {
    const previousBin = process.env.HOMEAGENT_CODEX_BIN;
    const previousHome = process.env.HOMEAGENT_CODEX_HOME;
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ha-codex-staged-route-change-")));
    const providerDirectory = join(root, "provider");
    const dataRoot = join(root, "data");
    const workdir = join(root, "workdir");
    const codexHome = join(root, "codex-home");
    const skillDirectory = join(root, "skills", "review");
    for (const directory of [providerDirectory, dataRoot, workdir, codexHome, skillDirectory]) {
      mkdirSync(directory, { recursive: true });
    }
    const skillFile = join(skillDirectory, "SKILL.md");
    writeFileSync(skillFile, "# Frozen route\n", "utf8");
    const skillInput = {
      name: "review",
      directory: realpathSync(skillDirectory),
      skillFile: realpathSync(skillFile),
      bundleHash: hashProviderSkillBundle(skillFile),
    };
    const input = {
      prompt: "route then answer",
      protectedDataRoot: dataRoot,
      execution: {
        permission: "read-only" as const,
        workdir,
        skills: ["review"],
        skillMode: "all" as const,
      },
      skillInputs: [skillInput],
    };
    const stagedBefore = stagedCodexSkillDirectories();
    try {
      process.env.HOMEAGENT_CODEX_BIN = writeArgAndStdinReportingCodexProvider(
        providerDirectory,
      );
      process.env.HOMEAGENT_CODEX_HOME = codexHome;
      await runProviderDetailed("codex", { ...input, nativeSessionIsolation: true }, 500);
      const callsBeforeMutation = providerProbeCalls(providerDirectory, "provider");
      writeFileSync(skillFile, "# Mutated after routing\n", "utf8");

      await expect(runProviderDetailed("codex", {
        ...input,
        nativeSession: { mode: "start" },
      }, 500)).rejects.toThrow("Skill input changed after frozen validation");
      expect(providerProbeCalls(providerDirectory, "provider")).toEqual(callsBeforeMutation);
      expect(stagedCodexSkillDirectories()).toEqual(stagedBefore);
    } finally {
      if (previousBin === undefined) delete process.env.HOMEAGENT_CODEX_BIN;
      else process.env.HOMEAGENT_CODEX_BIN = previousBin;
      if (previousHome === undefined) delete process.env.HOMEAGENT_CODEX_HOME;
      else process.env.HOMEAGENT_CODEX_HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Codex bounds aggregate staged Skill bytes for one invocation", async () => {
    const previousBin = process.env.HOMEAGENT_CODEX_BIN;
    const root = mkdtempSync(join(tmpdir(), "ha-codex-staged-aggregate-"));
    const providerDirectory = join(root, "provider");
    const workdir = join(root, "workdir");
    const skillDirectories = [
      join(root, "skills", "first"),
      join(root, "skills", "second"),
    ];
    for (const directory of [providerDirectory, workdir, ...skillDirectories]) {
      mkdirSync(directory, { recursive: true });
    }
    const skillInputs = skillDirectories.map((directory, index) => {
      const skillFile = join(directory, "SKILL.md");
      writeFileSync(skillFile, `# Aggregate ${index}\n`, "utf8");
      writeFileSync(join(directory, "payload.bin"), Buffer.alloc(8 * 1024 * 1024));
      return {
        name: index === 0 ? "first" : "second",
        directory: realpathSync(directory),
        skillFile: realpathSync(skillFile),
        bundleHash: hashProviderSkillBundle(skillFile),
      };
    });
    const stagedBefore = stagedCodexSkillDirectories();
    try {
      process.env.HOMEAGENT_CODEX_BIN = writeArgAndStdinReportingCodexProvider(
        providerDirectory,
      );
      const output = await runProviderDetailed("codex", {
        prompt: "must not exceed the invocation staging budget",
        execution: {
          permission: "read-only",
          workdir,
          skills: ["first", "second"],
          skillMode: "all",
        },
        skillInputs,
      }, 500);

      // The aggregate byte cap is still enforced: two 8 MiB bundles cannot both
      // be staged for one invocation. Exceeding it is a capacity limit, so the
      // call proceeds with the Skills that fit instead of failing outright.
      const observed = JSON.parse(output.text) as { prompt: string; args: string[] };
      expect(observed.prompt).toContain("- first: ");
      expect(observed.prompt).not.toContain("- second: ");
      // A dropped Skill must not remain in the invocation contract, or the model
      // could call a bundle that was never staged.
      expect(observed.args.join("\0")).not.toContain("second");
      // Staged copies are still cleaned up once the call finishes.
      expect(stagedCodexSkillDirectories()).toEqual(stagedBefore);
    } finally {
      if (previousBin === undefined) delete process.env.HOMEAGENT_CODEX_BIN;
      else process.env.HOMEAGENT_CODEX_BIN = previousBin;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Codex reads frozen staged bytes when the live Skill changes during the call", async () => {
    const previousBin = process.env.HOMEAGENT_CODEX_BIN;
    const previousHome = process.env.HOMEAGENT_CODEX_HOME;
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ha-codex-staged-during-call-")));
    const providerDirectory = join(root, "provider");
    const dataRoot = join(root, "data");
    const workdir = join(root, "workdir");
    const codexHome = join(root, "codex-home");
    const skillDirectory = join(root, "skills", "review");
    for (const directory of [providerDirectory, dataRoot, workdir, codexHome, skillDirectory]) {
      mkdirSync(directory, { recursive: true });
    }
    const skillFile = join(skillDirectory, "SKILL.md");
    writeFileSync(skillFile, "# Frozen staged Skill\n", "utf8");
    const stagedBefore = stagedCodexSkillDirectories();
    try {
      process.env.HOMEAGENT_CODEX_BIN = writeLiveSkillMutatingCodexProvider(
        providerDirectory,
        skillFile,
      );
      process.env.HOMEAGENT_CODEX_HOME = codexHome;
      const output = await runProviderDetailed("codex", {
        prompt: "read the frozen Skill",
        protectedDataRoot: dataRoot,
        execution: {
          permission: "read-only",
          workdir,
          skills: ["review"],
          skillMode: "all",
        },
        skillInputs: [{
          name: "review",
          directory: realpathSync(skillDirectory),
          skillFile: realpathSync(skillFile),
          bundleHash: hashProviderSkillBundle(skillFile),
        }],
        nativeSessionIsolation: true,
      }, 500);

      expect(output.text).toBe("# Frozen staged Skill");
      expect(readFileSync(skillFile, "utf8")).toBe("# Mutated live Skill\n");
      expect(stagedCodexSkillDirectories()).toEqual(stagedBefore);
    } finally {
      if (previousBin === undefined) delete process.env.HOMEAGENT_CODEX_BIN;
      else process.env.HOMEAGENT_CODEX_BIN = previousBin;
      if (previousHome === undefined) delete process.env.HOMEAGENT_CODEX_HOME;
      else process.env.HOMEAGENT_CODEX_HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Codex native isolation rejects full access and HomeAgent data overlap before invocation", async () => {
    const previous = process.env.HOMEAGENT_CODEX_BIN;
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ha-codex-native-admission-")));
    const providerDirectory = join(root, "provider");
    const dataRoot = join(root, "data");
    const nestedWorkdir = join(dataRoot, "workdir");
    const safeWorkdir = join(root, "safe-workdir");
    const overlappingSkillDirectory = join(safeWorkdir, "skills", "review");
    mkdirSync(providerDirectory, { recursive: true });
    mkdirSync(nestedWorkdir, { recursive: true });
    mkdirSync(overlappingSkillDirectory, { recursive: true });
    const overlappingSkillFile = join(overlappingSkillDirectory, "SKILL.md");
    writeFileSync(overlappingSkillFile, "# Mutable live Skill\n", "utf8");
    try {
      process.env.HOMEAGENT_CODEX_BIN = writeArgReportingCodexProvider(
        providerDirectory,
        "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      );
      for (const execution of [
        { permission: "full" as const, workdir: root, skills: [] },
        { permission: "read-only" as const, workdir: nestedWorkdir, skills: [] },
      ]) {
        await expect(runProviderDetailed("codex", {
          prompt: "must not invoke Codex",
          protectedDataRoot: dataRoot,
          execution,
          nativeSessionIsolation: true,
        }, 500)).rejects.toThrow("native session isolation is unavailable");
      }
      await expect(runProviderDetailed("codex", {
        prompt: "must not expose the live Skill through Workdir",
        protectedDataRoot: dataRoot,
        execution: {
          permission: "read-only",
          workdir: safeWorkdir,
          skills: ["review"],
          skillMode: "all",
        },
        skillInputs: [{
          name: "review",
          directory: realpathSync(overlappingSkillDirectory),
          skillFile: realpathSync(overlappingSkillFile),
          bundleHash: hashProviderSkillBundle(overlappingSkillFile),
        }],
        nativeSessionIsolation: true,
      }, 500)).rejects.toThrow("native session isolation is unavailable");
      expect(existsSync(join(providerDirectory, "provider.calls.jsonl"))).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.HOMEAGENT_CODEX_BIN;
      else process.env.HOMEAGENT_CODEX_BIN = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Codex native detection and runtime fail closed when the sandbox proof fails", async () => {
    const previous = process.env.HOMEAGENT_CODEX_BIN;
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ha-codex-sandbox-denied-")));
    const providerDirectory = join(root, "provider");
    const dataRoot = join(root, "data");
    const workdir = join(root, "workdir");
    mkdirSync(providerDirectory, { recursive: true });
    mkdirSync(dataRoot, { recursive: true });
    mkdirSync(workdir, { recursive: true });
    try {
      process.env.HOMEAGENT_CODEX_BIN = writeCodexStatusProvider(
        providerDirectory,
        "provider",
        0,
        CODEX_STATUS_ARGS,
        0,
        "codex-cli 0.152.1",
        "[]",
        0,
        42,
      );
      expect((await detectProviders(500)).find((provider) => provider.id === "codex"))
        .toEqual(expect.objectContaining({ available: true, nativeSessions: false }));

      await expect(runProviderDetailed("codex", {
        prompt: "must not invoke a model",
        protectedDataRoot: dataRoot,
        execution: { permission: "read-only", workdir, skills: [] },
        nativeSessionIsolation: true,
      }, 500)).rejects.toThrow("native session isolation is unavailable");
      const calls = providerProbeCalls(providerDirectory, "provider");
      expect(calls.filter((args) => args.includes("sandbox"))).toHaveLength(2);
      expect(calls.some((args) => args.includes("--json") && args.includes("exec"))).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.HOMEAGENT_CODEX_BIN;
      else process.env.HOMEAGENT_CODEX_BIN = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Codex native preflight preserves an already-aborted caller reason", async () => {
    const root = mkdtempSync(join(tmpdir(), "ha-codex-preflight-abort-"));
    const dataRoot = join(root, "data");
    const workdir = join(root, "workdir");
    const codexHome = join(root, "codex-home");
    const skillDirectory = join(root, "skills", "review");
    const previousHome = process.env.HOMEAGENT_CODEX_HOME;
    mkdirSync(dataRoot, { recursive: true });
    mkdirSync(workdir, { recursive: true });
    mkdirSync(codexHome, { recursive: true });
    mkdirSync(skillDirectory, { recursive: true });
    const skillFile = join(skillDirectory, "SKILL.md");
    writeFileSync(skillFile, "# Abort-safe staging\n", "utf8");
    const bundleHash = hashProviderSkillBundle(skillFile);
    writeFileSync(skillFile, "# Changed after admission\n", "utf8");
    process.env.HOMEAGENT_CODEX_HOME = codexHome;
    const controller = new AbortController();
    controller.abort(new Error("caller cancelled native preflight"));
    const stagedBefore = stagedCodexSkillDirectories();
    try {
      await expect(preflightProviderNativeSession(
        "codex",
        500,
        controller.signal,
        realpathSync(workdir),
        { permission: "read-only", workdir: realpathSync(workdir), skills: ["review"] },
        [{
          name: "review",
          directory: realpathSync(skillDirectory),
          skillFile: realpathSync(skillFile),
          bundleHash,
        }],
        realpathSync(dataRoot),
      )).rejects.toThrow("caller cancelled native preflight");
      expect(stagedCodexSkillDirectories()).toEqual(stagedBefore);
    } finally {
      if (previousHome === undefined) delete process.env.HOMEAGENT_CODEX_HOME;
      else process.env.HOMEAGENT_CODEX_HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Codex provider run preserves cancellation before Skill staging", async () => {
    const previousBin = process.env.HOMEAGENT_CODEX_BIN;
    const root = mkdtempSync(join(tmpdir(), "ha-codex-run-abort-staging-"));
    const providerDirectory = join(root, "provider");
    const workdir = join(root, "workdir");
    const skillDirectory = join(root, "skills", "review");
    for (const directory of [providerDirectory, workdir, skillDirectory]) {
      mkdirSync(directory, { recursive: true });
    }
    const skillFile = join(skillDirectory, "SKILL.md");
    writeFileSync(skillFile, "# Before cancellation\n", "utf8");
    const bundleHash = hashProviderSkillBundle(skillFile);
    writeFileSync(skillFile, "# Changed after admission\n", "utf8");
    const controller = new AbortController();
    controller.abort(new Error("caller cancelled provider run"));
    const stagedBefore = stagedCodexSkillDirectories();
    try {
      process.env.HOMEAGENT_CODEX_BIN = writeArgAndStdinReportingCodexProvider(
        providerDirectory,
      );
      await expect(runProviderDetailed("codex", {
        prompt: "must not stage after cancellation",
        execution: {
          permission: "read-only",
          workdir,
          skills: ["review"],
          skillMode: "all",
        },
        skillInputs: [{
          name: "review",
          directory: realpathSync(skillDirectory),
          skillFile: realpathSync(skillFile),
          bundleHash,
        }],
      }, 500, controller.signal)).rejects.toThrow("caller cancelled provider run");
      expect(existsSync(join(providerDirectory, "provider.calls.jsonl"))).toBe(false);
      expect(stagedCodexSkillDirectories()).toEqual(stagedBefore);
    } finally {
      if (previousBin === undefined) delete process.env.HOMEAGENT_CODEX_BIN;
      else process.env.HOMEAGENT_CODEX_BIN = previousBin;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Codex forks the requested native session without ambient state", async () => {
    const previous = process.env.HOMEAGENT_CODEX_BIN;
    const directory = mkdtempSync(join(tmpdir(), "ha-codex-native-session-resume-"));
    const sessionId = "11111111-2222-4333-8444-555555555555";
    const forkedSessionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    try {
      process.env.HOMEAGENT_CODEX_BIN = writeArgReportingCodexProvider(
        directory,
        forkedSessionId,
      );

      const output = await runProviderDetailed(
        "codex",
        {
          prompt: "continue topic",
          model: "gpt-5.6-sol",
          execution: READ_ONLY_EXECUTION,
          nativeSession: { mode: "fork", id: sessionId },
        },
        500,
      );

      expect(output).toEqual(expect.objectContaining({ nativeSessionId: forkedSessionId }));
      expect(output.text).toContain(
        `exec --strict-config --ignore-user-config --ignore-rules --json --skip-git-repo-check -m gpt-5.6-sol fork ${sessionId} -`,
      );
      expect(output.text).not.toContain("--ephemeral");
      expect(output.text).not.toContain("--sandbox");
    } finally {
      if (previous === undefined) delete process.env.HOMEAGENT_CODEX_BIN;
      else process.env.HOMEAGENT_CODEX_BIN = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("Codex refuses a fork that keeps using the parent session", async () => {
    const previous = process.env.HOMEAGENT_CODEX_BIN;
    const directory = mkdtempSync(join(tmpdir(), "ha-codex-native-session-mismatch-"));
    const requestedId = "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE";
    try {
      process.env.HOMEAGENT_CODEX_BIN = writeArgReportingCodexProvider(
        directory,
        requestedId.toLowerCase(),
      );

      await expect(runProviderDetailed(
        "codex",
        {
          prompt: "continue topic",
          execution: READ_ONLY_EXECUTION,
          nativeSession: { mode: "fork", id: requestedId },
        },
        500,
      )).rejects.toThrow("did not fork");
    } finally {
      if (previous === undefined) delete process.env.HOMEAGENT_CODEX_BIN;
      else process.env.HOMEAGENT_CODEX_BIN = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects an unknown native session mode before invoking the provider", async () => {
    const previous = process.env.HOMEAGENT_CODEX_BIN;
    const directory = mkdtempSync(join(tmpdir(), "ha-invalid-native-session-mode-"));
    try {
      process.env.HOMEAGENT_CODEX_BIN = writeArgReportingCodexProvider(
        directory,
        "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      );

      await expect(runProviderDetailed(
        "codex",
        {
          prompt: "must not run",
          execution: READ_ONLY_EXECUTION,
          nativeSession: { mode: "unknown" } as never,
        },
        500,
      )).rejects.toThrow("native session request is invalid");
    } finally {
      if (previous === undefined) delete process.env.HOMEAGENT_CODEX_BIN;
      else process.env.HOMEAGENT_CODEX_BIN = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("ordinary calls do not expose non-resumable Provider session ids", async () => {
    const previousClaude = process.env.HOMEAGENT_CLAUDE_BIN;
    const previousCodex = process.env.HOMEAGENT_CODEX_BIN;
    const directory = mkdtempSync(join(tmpdir(), "ha-stateless-native-session-id-"));
    try {
      const sessionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
      process.env.HOMEAGENT_CLAUDE_BIN = writeArgReportingClaudeProvider(
        directory,
        sessionId,
        "claude-provider",
      );
      process.env.HOMEAGENT_CODEX_BIN = writeArgReportingCodexProvider(
        directory,
        sessionId,
        "codex-provider",
      );

      const claude = await runProviderDetailed("claude", { prompt: "one shot" }, 500);
      const codex = await runProviderDetailed("codex", { prompt: "one shot" }, 500);

      expect([claude.nativeSessionId, codex.nativeSessionId]).toEqual([
        undefined,
        undefined,
      ]);
    } finally {
      if (previousClaude === undefined) delete process.env.HOMEAGENT_CLAUDE_BIN;
      else process.env.HOMEAGENT_CLAUDE_BIN = previousClaude;
      if (previousCodex === undefined) delete process.env.HOMEAGENT_CODEX_BIN;
      else process.env.HOMEAGENT_CODEX_BIN = previousCodex;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("text-only provider API rejects native sessions instead of dropping their id", async () => {
    const previous = process.env.HOMEAGENT_CODEX_BIN;
    const directory = mkdtempSync(join(tmpdir(), "ha-text-only-native-session-"));
    try {
      process.env.HOMEAGENT_CODEX_BIN = writeArgReportingCodexProvider(
        directory,
        "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      );

      await expect(runProvider(
        "codex",
        {
          prompt: "must not lose the session id",
          execution: READ_ONLY_EXECUTION,
          nativeSession: { mode: "start" },
        },
        500,
      )).rejects.toThrow("text-only provider API does not support native sessions");
    } finally {
      if (previous === undefined) delete process.env.HOMEAGENT_CODEX_BIN;
      else process.env.HOMEAGENT_CODEX_BIN = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("Codex structured calls enforce a readable output schema and clean it up", async () => {
    const previous = process.env.HOMEAGENT_CODEX_BIN;
    const directory = mkdtempSync(join(tmpdir(), "ha-codex-output-schema-"));
    const schema = {
      type: "object",
      properties: { content: { type: "string" } },
      required: ["content"],
      additionalProperties: false,
    };
    try {
      process.env.HOMEAGENT_CODEX_BIN = writeCodexSchemaInspector(directory);

      const output = await runProviderDetailed(
        "codex",
        { prompt: "generate a knowledge page", outputSchema: schema },
        500,
      );
      const observed = JSON.parse(output.text) as {
        schema: unknown;
        schemaPath: string;
        schemaExistsDuringRun: boolean;
        prompt: string;
      };

      expect(observed).toEqual(expect.objectContaining({
        schema,
        schemaExistsDuringRun: true,
        prompt: "generate a knowledge page",
      }));
      expect(existsSync(observed.schemaPath)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.HOMEAGENT_CODEX_BIN;
      else process.env.HOMEAGENT_CODEX_BIN = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("Codex structured calls read the final artifact instead of guessing from JSONL events", async () => {
    const previous = process.env.HOMEAGENT_CODEX_BIN;
    const directory = mkdtempSync(join(tmpdir(), "ha-codex-final-artifact-"));
    try {
      process.env.HOMEAGENT_CODEX_BIN = writeCodexFinalArtifactProvider(directory);

      const output = await runProviderDetailed(
        "codex",
        {
          prompt: "generate a knowledge page",
          outputSchema: {
            type: "object",
            properties: { content: { type: "string" } },
            required: ["content"],
            additionalProperties: false,
          },
        },
        500,
      );

      expect(output).toEqual({
        text: JSON.stringify({ content: "# Knowledge\n\nDurable result" }),
        usage: {
          inputTokens: 240,
          outputTokens: 45,
          costBasis: "unavailable",
          source: "codex-jsonl",
        },
      });
    } finally {
      if (previous === undefined) delete process.env.HOMEAGENT_CODEX_BIN;
      else process.env.HOMEAGENT_CODEX_BIN = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("Codex structured calls enforce the requested output budget locally", async () => {
    const previous = process.env.HOMEAGENT_CODEX_BIN;
    const directory = mkdtempSync(join(tmpdir(), "ha-codex-output-budget-"));
    try {
      process.env.HOMEAGENT_CODEX_BIN = writeCodexFinalArtifactProvider(
        directory,
        JSON.stringify({ content: "x".repeat(20 * 1024) }),
      );

      await expect(runProviderDetailed(
        "codex",
        {
          prompt: "generate a knowledge page",
          outputSchema: { type: "object" },
          maxTokens: 4,
        },
        500,
      )).rejects.toThrow("requested output budget");
    } finally {
      if (previous === undefined) delete process.env.HOMEAGENT_CODEX_BIN;
      else process.env.HOMEAGENT_CODEX_BIN = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("Codex structured calls use the final artifact when JSONL contains misleading messages", async () => {
    const previous = process.env.HOMEAGENT_CODEX_BIN;
    const directory = mkdtempSync(join(tmpdir(), "ha-codex-structured-message-"));
    const structured = JSON.stringify({ content: "knowledge page" });
    try {
      process.env.HOMEAGENT_CODEX_BIN = writeCodexFinalArtifactProvider(
        directory,
        structured,
        [
          JSON.stringify({
            type: "item.completed",
            item: { id: "item_1", type: "agent_message", text: structured },
          }),
          JSON.stringify({
            type: "item.completed",
            item: {
              id: "item_2",
              type: "agent_message",
              text: "I finished generating the knowledge page.",
            },
          }),
          JSON.stringify({ type: "turn.completed" }),
        ].join("\n"),
      );

      const output = await runProviderDetailed(
        "codex",
        {
          prompt: "generate a knowledge page",
          outputSchema: {
            type: "object",
            properties: { content: { type: "string" } },
            required: ["content"],
            additionalProperties: false,
          },
        },
        500,
      );

      expect(output.text).toBe(structured);
    } finally {
      if (previous === undefined) delete process.env.HOMEAGENT_CODEX_BIN;
      else process.env.HOMEAGENT_CODEX_BIN = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("Codex structured calls close nested objects while preserving optional fields", async () => {
    const previous = process.env.HOMEAGENT_CODEX_BIN;
    const directory = mkdtempSync(join(tmpdir(), "ha-codex-strict-output-schema-"));
    const schema = {
      type: "object",
      properties: {
        operations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              reason: { type: "string" },
            },
            required: ["name"],
          },
        },
      },
      required: ["operations"],
    };
    const original = structuredClone(schema);
    try {
      process.env.HOMEAGENT_CODEX_BIN = writeCodexSchemaInspector(directory);

      const output = await runProviderDetailed(
        "codex",
        { prompt: "analyze", outputSchema: schema },
        500,
      );
      const observed = JSON.parse(output.text) as { schema: unknown };

      expect(observed.schema).toEqual({
        type: "object",
        properties: {
          operations: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                reason: {
                  anyOf: [{ type: "string" }, { type: "null" }],
                },
              },
              required: ["name", "reason"],
              additionalProperties: false,
            },
          },
        },
        required: ["operations"],
        additionalProperties: false,
      });
      expect(schema).toEqual(original);
    } finally {
      if (previous === undefined) delete process.env.HOMEAGENT_CODEX_BIN;
      else process.env.HOMEAGENT_CODEX_BIN = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("Codex structured calls clean up the schema after provider failure", async () => {
    const previous = process.env.HOMEAGENT_CODEX_BIN;
    const directory = mkdtempSync(join(tmpdir(), "ha-codex-output-schema-failure-"));
    const capturedPathFile = join(directory, "captured-schema-path.txt");
    try {
      process.env.HOMEAGENT_CODEX_BIN = writeCodexSchemaRejector(
        directory,
        capturedPathFile,
      );

      await expect(runProviderDetailed(
        "codex",
        { prompt: "generate", outputSchema: { type: "object" } },
        500,
      )).rejects.toThrow("structured output rejected");

      const schemaPath = readFileSync(capturedPathFile, "utf8");
      expect(existsSync(schemaPath)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.HOMEAGENT_CODEX_BIN;
      else process.env.HOMEAGENT_CODEX_BIN = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("Codex structured calls reject oversized output schemas before invocation", async () => {
    const previous = process.env.HOMEAGENT_CODEX_BIN;
    const directory = mkdtempSync(join(tmpdir(), "ha-codex-output-schema-limit-"));
    try {
      process.env.HOMEAGENT_CODEX_BIN = writeStaticProvider(directory, "unused");

      await expect(runProviderDetailed(
        "codex",
        {
          prompt: "generate",
          outputSchema: { type: "object", description: "x".repeat(64 * 1024) },
        },
        500,
      )).rejects.toThrow("output schema exceeds the supported size");
    } finally {
      if (previous === undefined) delete process.env.HOMEAGENT_CODEX_BIN;
      else process.env.HOMEAGENT_CODEX_BIN = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("Codex preserves structured failure usage when its CLI exits non-zero", async () => {
    const previous = process.env.HOMEAGENT_CODEX_BIN;
    const directory = mkdtempSync(join(tmpdir(), "ha-codex-exit-usage-"));
    try {
      process.env.HOMEAGENT_CODEX_BIN = writeStaticProvider(
        directory,
        [
          JSON.stringify({ type: "thread.started", thread_id: "thread_failed" }),
          JSON.stringify({
            type: "turn.failed",
            error: { message: "workspace unavailable" },
            usage: {
              input_tokens: 90,
              cached_input_tokens: 50,
              output_tokens: 3,
              reasoning_output_tokens: 2,
            },
          }),
        ].join("\n"),
        "provider",
        1,
      );

      let failure: unknown;
      try {
        await runProviderDetailed(
          "codex",
          { prompt: "answer", execution: READ_ONLY_EXECUTION },
          500,
        );
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(ProviderRunError);
      expect(String(failure)).toContain("workspace unavailable");
      expect((failure as ProviderRunError).usage).toEqual({
        inputTokens: 90,
        cachedInputTokens: 50,
        outputTokens: 3,
        reasoningTokens: 2,
        costBasis: "unavailable",
        source: "codex-jsonl",
      });
    } finally {
      if (previous === undefined) delete process.env.HOMEAGENT_CODEX_BIN;
      else process.env.HOMEAGENT_CODEX_BIN = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("Codex rejects a non-zero structured success while preserving its usage", async () => {
    const previous = process.env.HOMEAGENT_CODEX_BIN;
    const directory = mkdtempSync(join(tmpdir(), "ha-codex-exit-success-usage-"));
    try {
      process.env.HOMEAGENT_CODEX_BIN = writeStaticProvider(
        directory,
        [
          JSON.stringify({
            type: "item.completed",
            item: { type: "agent_message", text: "must not be accepted" },
          }),
          JSON.stringify({
            type: "turn.completed",
            usage: { input_tokens: 100, output_tokens: 9 },
          }),
        ].join("\n"),
        "provider",
        1,
      );

      let failure: unknown;
      try {
        await runProviderDetailed(
          "codex",
          { prompt: "answer", execution: READ_ONLY_EXECUTION },
          500,
        );
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(ProviderRunError);
      expect(String(failure)).toContain("exited 1");
      expect((failure as ProviderRunError).usage).toEqual({
        inputTokens: 100,
        outputTokens: 9,
        costBasis: "unavailable",
        source: "codex-jsonl",
      });
    } finally {
      if (previous === undefined) delete process.env.HOMEAGENT_CODEX_BIN;
      else process.env.HOMEAGENT_CODEX_BIN = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("Codex keeps the JSONL answer but marks usage unavailable when counters are omitted", async () => {
    const previous = process.env.HOMEAGENT_CODEX_BIN;
    const directory = mkdtempSync(join(tmpdir(), "ha-codex-missing-usage-"));
    try {
      process.env.HOMEAGENT_CODEX_BIN = writeStaticProvider(
        directory,
        [
          JSON.stringify({
            type: "item.completed",
            item: { id: "item_1", type: "agent_message", text: "final answer" },
          }),
          JSON.stringify({ type: "turn.completed" }),
        ].join("\n"),
      );

      const output = await runProviderDetailed(
        "codex",
        { prompt: "answer", execution: READ_ONLY_EXECUTION },
        500,
      );

      expect(output).toEqual({
        text: "final answer",
        usage: {
          costBasis: "unavailable",
          source: "codex-jsonl",
        },
      });
    } finally {
      if (previous === undefined) delete process.env.HOMEAGENT_CODEX_BIN;
      else process.env.HOMEAGENT_CODEX_BIN = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("Codex requests JSONL and marks unstructured fallback output as unavailable", async () => {
    const previous = process.env.HOMEAGENT_CODEX_BIN;
    const directory = mkdtempSync(join(tmpdir(), "ha-codex-json-argv-"));
    const bin = join(directory, process.platform === "win32" ? "codex.cmd" : "codex");
    try {
      writeFileSync(
        bin,
        process.platform === "win32"
          ? '@echo off\r\necho %*\r\nnode -e "let s=\'\';process.stdin.setEncoding(\'utf8\');process.stdin.on(\'data\',d=>s+=d);process.stdin.on(\'end\',()=>process.stdout.write(s))"\r\n'
          : '#!/bin/sh\nprintf "%s\\n" "$*"\ncat\n',
        "utf8",
      );
      if (process.platform !== "win32") chmodSync(bin, 0o755);
      process.env.HOMEAGENT_CODEX_BIN = bin;

      const output = await runProviderDetailed(
        "codex",
        { prompt: "answer", execution: READ_ONLY_EXECUTION },
        500,
      );

      expect(output).toEqual({
        text: expect.stringContaining(
          "exec --ephemeral --strict-config --ignore-user-config --ignore-rules --json --sandbox read-only",
        ),
        usage: {
          costBasis: "unavailable",
          source: "legacy-text",
        },
      });
      expect(output.text).not.toContain("--output-schema");
    } finally {
      if (previous === undefined) delete process.env.HOMEAGENT_CODEX_BIN;
      else process.env.HOMEAGENT_CODEX_BIN = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("TRAE returns text while explicitly marking usage and cost unavailable", async () => {
    const previous = process.env.HOMEAGENT_TRAE_BIN;
    const directory = mkdtempSync(join(tmpdir(), "ha-trae-usage-"));
    try {
      process.env.HOMEAGENT_TRAE_BIN = writeStaticProvider(directory, "final answer");

      const output = await runProviderDetailed(
        "trae-cli",
        { prompt: "answer", execution: READ_ONLY_EXECUTION },
        500,
      );

      expect(output).toEqual({
        text: "final answer",
        usage: {
          costBasis: "unavailable",
          source: "trae-text",
        },
      });
    } finally {
      if (previous === undefined) delete process.env.HOMEAGENT_TRAE_BIN;
      else process.env.HOMEAGENT_TRAE_BIN = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("Claude ordinary calls isolate pinned native Skills with every tool disabled", async () => {
    const previous = process.env.HOMEAGENT_CLAUDE_BIN;
    const directory = mkdtempSync(join(tmpdir(), "ha-claude-no-tools-"));
    try {
      process.env.HOMEAGENT_CLAUDE_BIN = writeArgAndStdinReportingClaudeProvider(directory);

      const noTools = JSON.parse(await runProvider("claude", {
        prompt: "answer the question",
      }, 500)) as { args: string[]; prompt: string };
      const withSkillHint = JSON.parse(await runProvider("claude", {
        prompt: "answer the question",
        skills: ["review"],
      }, 500)) as { args: string[]; prompt: string };
      const noToolsArgs = noTools.args.join(" ");

      expect(withSkillHint.prompt).not.toContain("/review");
      expect(noToolsArgs).toContain(
        "--safe-mode --no-session-persistence --strict-mcp-config --output-format json --tools",
      );
      expect(noToolsArgs).not.toContain("--allowedTools");
      expect(noToolsArgs).not.toContain("--bare");
      expect(noToolsArgs).not.toContain("--tools Read,Glob,Grep");
      expect(noToolsArgs).not.toContain("--permission-mode");
    } finally {
      if (previous === undefined) delete process.env.HOMEAGENT_CLAUDE_BIN;
      else process.env.HOMEAGENT_CLAUDE_BIN = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("an execution contract remains the authority for required Skills", async () => {
    const previous = process.env.HOMEAGENT_CLAUDE_BIN;
    const directory = mkdtempSync(join(tmpdir(), "ha-execution-skills-"));
    try {
      process.env.HOMEAGENT_CLAUDE_BIN = writeArgAndStdinReportingClaudeProvider(directory);

      const output = JSON.parse(await runProvider("claude", {
        prompt: "perform the explicit task",
        skills: [],
        execution: {
          permission: "read-only",
          skills: ["review"],
        },
      }, 500)) as { prompt: string };

      expect(output.prompt).toContain("/review");
    } finally {
      if (previous === undefined) delete process.env.HOMEAGENT_CLAUDE_BIN;
      else process.env.HOMEAGENT_CLAUDE_BIN = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("all-Skill execution exposes the catalog for on-demand selection", async () => {
    const previous = process.env.HOMEAGENT_CLAUDE_BIN;
    const directory = mkdtempSync(join(tmpdir(), "ha-all-execution-skills-"));
    try {
      process.env.HOMEAGENT_CLAUDE_BIN = writeArgAndStdinReportingClaudeProvider(directory);

      const output = JSON.parse(await runProvider("claude", {
        prompt: "read the linked Lark document",
        execution: {
          permission: "read-only",
          skills: ["lark-doc", "code-review"],
          skillMode: "all",
        },
      }, 500)) as { prompt: string };

      expect(output.prompt).toContain("可按需使用以下技能：/lark-doc、/code-review");
      expect(output.prompt).toContain("只加载与当前请求相关的技能");
      expect(output.prompt).not.toContain("必须先加载并遵循");
    } finally {
      if (previous === undefined) delete process.env.HOMEAGENT_CLAUDE_BIN;
      else process.env.HOMEAGENT_CLAUDE_BIN = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("Codex ordinary calls run as ephemeral read-only completions without native Skills", async () => {
    const previous = process.env.HOMEAGENT_CODEX_BIN;
    const directory = mkdtempSync(join(tmpdir(), "ha-codex-no-tools-"));
    const bin = join(directory, process.platform === "win32" ? "codex.cmd" : "codex");
    const workdir = join(directory, "agent-workdir");
    try {
      mkdirSync(workdir);
      writeFileSync(join(workdir, "AGENT_CONTEXT.md"), "agent context", "utf8");
      writeFileSync(
        bin,
        process.platform === "win32"
          ? '@echo off\r\nnode -e "console.log(require(\'fs\').existsSync(\'AGENT_CONTEXT.md\')?\'AGENT_WORKDIR_VISIBLE\':\'AGENT_WORKDIR_MISSING\')"\r\necho %*\r\nnode -e "let s=\'\';process.stdin.setEncoding(\'utf8\');process.stdin.on(\'data\',d=>s+=d);process.stdin.on(\'end\',()=>process.stdout.write(s))"\r\n'
          : '#!/bin/sh\nnode -e "console.log(require(\'fs\').existsSync(\'AGENT_CONTEXT.md\')?\'AGENT_WORKDIR_VISIBLE\':\'AGENT_WORKDIR_MISSING\')"\nprintf "%s\\n" "$*"\ncat\n',
        "utf8",
      );
      if (process.platform !== "win32") chmodSync(bin, 0o755);
      process.env.HOMEAGENT_CODEX_BIN = bin;

      const output = await runProvider("codex", {
        prompt: "answer the question",
        skills: ["review"],
        workdir,
      }, 500);

      expect(output).toContain("exec --ephemeral --strict-config --ignore-user-config --ignore-rules");
      expect(output).toContain("approval_policy");
      expect(output).toContain("never");
      expect(output).toContain(
        "--json --sandbox read-only --skip-git-repo-check -- -",
      );
      expect(output).toContain("answer the question");
      expect(output).toContain("AGENT_WORKDIR_VISIBLE");
      expect(output).not.toContain("AGENT_WORKDIR_MISSING");
      expect(output).not.toContain("/review");
    } finally {
      if (previous === undefined) delete process.env.HOMEAGENT_CODEX_BIN;
      else process.env.HOMEAGENT_CODEX_BIN = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("TRAE refuses ordinary calls without a verified no-tools mode", async () => {
    const previous = process.env.HOMEAGENT_TRAE_BIN;
    const directory = mkdtempSync(join(tmpdir(), "ha-trae-no-tools-"));
    try {
      process.env.HOMEAGENT_TRAE_BIN = writeArgEchoProvider(directory);

      await expect(runProvider("trae-cli", {
        prompt: "answer the question",
      }, 500)).rejects.toThrow("cannot provide a no-tools execution mode");
      await expect(runProvider("trae-cli", {
        prompt: "answer the question",
        skills: ["review"],
      }, 500)).rejects.toThrow("cannot provide a no-tools execution mode");
    } finally {
      if (previous === undefined) delete process.env.HOMEAGENT_TRAE_BIN;
      else process.env.HOMEAGENT_TRAE_BIN = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("passes visual inputs to Codex as native image attachments", async () => {
    const previous = process.env.HOMEAGENT_CODEX_BIN;
    const directory = mkdtempSync(join(tmpdir(), "ha-provider-argv-"));
    try {
      process.env.HOMEAGENT_CODEX_BIN = writeArgEchoProvider(directory);

      const output = await runProvider(
        "codex",
        {
          prompt: "分析这顿晚餐",
          images: [{ path: "/tmp/dinner.png" }],
          execution: READ_ONLY_EXECUTION,
        },
        500,
      );
      expect(output).toContain('cli_auth_credentials_store=\\"file\\"');
      expect(output).toContain(
        "exec --ephemeral --strict-config --ignore-user-config --ignore-rules --json --sandbox read-only",
      );
      expect(output).toContain("--image /tmp/dinner.png -- -");
    } finally {
      if (previous === undefined) delete process.env.HOMEAGENT_CODEX_BIN;
      else process.env.HOMEAGENT_CODEX_BIN = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("delivers a multiline Codex prompt intact over stdin", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ha-codex-stdin-"));
    const bin = join(directory, process.platform === "win32" ? "codex.cmd" : "codex");
    const previous = process.env.HOMEAGENT_CODEX_BIN;
    const prompt = "默认agent\n\n请回答用户的问题：\n今天是几号啊";
    try {
      writeFileSync(
        bin,
        process.platform === "win32"
          ? '@echo off\r\nnode -e "let s=\'\';process.stdin.setEncoding(\'utf8\');process.stdin.on(\'data\',d=>s+=d);process.stdin.on(\'end\',()=>process.stdout.write(s))"\r\n'
          : "#!/bin/sh\ncat\n",
        "utf8",
      );
      if (process.platform !== "win32") chmodSync(bin, 0o755);
      process.env.HOMEAGENT_CODEX_BIN = bin;

      expect(await runProvider(
        "codex",
        { prompt, execution: READ_ONLY_EXECUTION },
        500,
      )).toBe(prompt);
    } finally {
      if (previous === undefined) delete process.env.HOMEAGENT_CODEX_BIN;
      else process.env.HOMEAGENT_CODEX_BIN = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("Codex redacts native session ids from structured turn failures", async () => {
    const previous = process.env.HOMEAGENT_CODEX_BIN;
    const directory = mkdtempSync(join(tmpdir(), "ha-codex-turn-failure-redaction-"));
    const sessionId = "11111111-2222-4333-8444-555555555555";
    try {
      process.env.HOMEAGENT_CODEX_BIN = writeStaticProvider(
        directory,
        JSON.stringify({
          type: "turn.failed",
          error: { message: `no rollout found for thread id ${sessionId}` },
        }),
      );

      await expect(runProviderDetailed(
        "codex",
        { prompt: "continue", execution: READ_ONLY_EXECUTION },
        500,
      )).rejects.toThrow("no rollout found for thread id [redacted-id]");
    } finally {
      if (previous === undefined) delete process.env.HOMEAGENT_CODEX_BIN;
      else process.env.HOMEAGENT_CODEX_BIN = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("delivers a multiline Claude prompt only over stdin", async () => {
    const previous = process.env.HOMEAGENT_CLAUDE_BIN;
    const directory = mkdtempSync(join(tmpdir(), "ha-claude-stdin-"));
    try {
      process.env.HOMEAGENT_CLAUDE_BIN = writeArgAndStdinReportingClaudeProvider(
        directory,
      );
      const prompt = "first line\nsecond sensitive line";

      const output = await runProviderDetailed("claude", { prompt }, 500);
      const captured = JSON.parse(output.text) as { args: string[]; prompt: string };

      expect(captured.prompt).toBe(prompt);
      expect(captured.args.join(" ")).not.toContain("second sensitive line");
    } finally {
      if (previous === undefined) delete process.env.HOMEAGENT_CLAUDE_BIN;
      else process.env.HOMEAGENT_CLAUDE_BIN = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("never silently drops images for providers without a verified visual input path", async () => {
    await expect(
      runProvider(
        "claude",
        { prompt: "分析图片", images: [{ path: "/tmp/dinner.png" }] },
        500,
      ),
    ).rejects.toThrow("does not support image inputs");
    await expect(
      runProvider(
        "trae-cli",
        { prompt: "分析图片", images: [{ path: "/tmp/dinner.png" }] },
        500,
      ),
    ).rejects.toThrow("does not support image inputs");
  });

  test("bounds the number of images accepted by a provider call", async () => {
    await expect(
      runProvider(
        "codex",
        {
          prompt: "分析图片",
          images: Array.from({ length: 5 }, (_, index) => ({
            path: `/tmp/image-${index}.png`,
          })),
        },
        500,
      ),
    ).rejects.toThrow("at most 4 images");
  });

  test("honors explicit binary overrides without changing CLI authentication", async () => {
    const keys = [
      "HOMEAGENT_CODEX_BIN",
      "HOMEAGENT_CLAUDE_BIN",
      "HOMEAGENT_TRAE_BIN",
    ] as const;
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    const directory = mkdtempSync(join(tmpdir(), "ha-provider-overrides-"));
    try {
      const bin = writeArgEchoProvider(directory);
      for (const key of keys) process.env[key] = bin;

      const detected = await detectProviders(500);
      expect(detected.map(({ id, bin }) => ({ id, bin }))).toEqual([
        { id: "claude", bin },
        { id: "codex", bin },
        { id: "trae-cli", bin },
      ]);
      const defaultRun = await runProvider(
        "codex",
        { prompt: "hello", execution: READ_ONLY_EXECUTION },
        500,
      );
      expect(defaultRun).toContain('cli_auth_credentials_store=\\"file\\"');
      expect(defaultRun).toContain(
        "exec --ephemeral --strict-config --ignore-user-config --ignore-rules --json --sandbox read-only --skip-git-repo-check -- -",
      );

      const configuredRun = await runProvider(
        "codex",
        {
          prompt: "hello",
          model: "gpt-5.6-sol",
          reasoningEffort: "high",
          execution: READ_ONLY_EXECUTION,
        },
        500,
      );
      expect(configuredRun).toContain("model_reasoning_effort");
      expect(configuredRun).toContain("high");
      expect(configuredRun).toContain(
        "exec --ephemeral --strict-config --ignore-user-config --ignore-rules --json --sandbox read-only --skip-git-repo-check -m gpt-5.6-sol -- -",
      );
    } finally {
      for (const key of keys) {
        const value = previous[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("does not advertise Claude when version works but no-tools help flags are missing", async () => {
    const keys = [
      "HOMEAGENT_CODEX_BIN",
      "HOMEAGENT_CLAUDE_BIN",
      "HOMEAGENT_TRAE_BIN",
    ] as const;
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    const directory = mkdtempSync(join(tmpdir(), "ha-provider-capability-"));
    try {
      process.env.HOMEAGENT_CLAUDE_BIN = writeVersionAndHelpProvider(
        directory,
        "Usage: claude -p --tools --output-format --model --append-system-prompt\n",
        "claude-capability",
      );
      process.env.HOMEAGENT_CODEX_BIN = writeStaticProvider(
        directory,
        "codex 1.0\n",
        "codex-capability",
      );
      process.env.HOMEAGENT_TRAE_BIN = writeStaticProvider(
        directory,
        "trae 1.0\n",
        "trae-capability",
      );

      const detected = await detectProviders(500);
      expect(detected.find((provider) => provider.id === "claude")).toEqual(
        expect.objectContaining({
          available: false,
          detail: expect.stringContaining("--safe-mode"),
        }),
      );
      expect(detected.find((provider) => provider.id === "codex")?.available).toBe(true);
      expect(detected.find((provider) => provider.id === "trae-cli")?.available).toBe(true);
    } finally {
      for (const key of keys) {
        const value = previous[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("advertises stateless Claude without native session fork support", async () => {
    const previous = process.env.HOMEAGENT_CLAUDE_BIN;
    const directory = mkdtempSync(join(tmpdir(), "ha-provider-native-session-capability-"));
    try {
      process.env.HOMEAGENT_CLAUDE_BIN = writeVersionAndHelpProvider(
        directory,
        COMPLETE_CLAUDE_HELP
          .replace("\n--resume <session-id>", "")
          .replace("\n--fork-session", ""),
        "claude-native-session-capability",
      );

      expect((await detectProviders(500)).find((provider) => provider.id === "claude"))
        .toEqual(expect.objectContaining({
          available: true,
          detail: "claude-native-session-capability 1.0",
        }));
    } finally {
      if (previous === undefined) delete process.env.HOMEAGENT_CLAUDE_BIN;
      else process.env.HOMEAGENT_CLAUDE_BIN = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("advertises Claude after help and auth probes without executing a completion", async () => {
    const previous = process.env.HOMEAGENT_CLAUDE_BIN;
    const directory = mkdtempSync(join(tmpdir(), "ha-provider-capability-ready-"));
    const name = "claude-capability-ready";
    try {
      process.env.HOMEAGENT_CLAUDE_BIN = writeVersionAndHelpProvider(
        directory,
        COMPLETE_CLAUDE_HELP,
        name,
      );

      expect((await detectProviders(500)).find((provider) => provider.id === "claude"))
        .toEqual(expect.objectContaining({
          available: true,
          detail: "claude-capability-ready 1.0",
        }));
      expect(providerProbeCalls(directory, name)).toEqual([
        ["--version"],
        ["--help"],
        ["auth", "status", "--json"],
      ]);
    } finally {
      if (previous === undefined) delete process.env.HOMEAGENT_CLAUDE_BIN;
      else process.env.HOMEAGENT_CLAUDE_BIN = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("does not advertise a capable Claude CLI when auth status is logged out", async () => {
    const previous = process.env.HOMEAGENT_CLAUDE_BIN;
    const directory = mkdtempSync(join(tmpdir(), "ha-provider-auth-logged-out-"));
    const name = "claude-auth-logged-out";
    try {
      process.env.HOMEAGENT_CLAUDE_BIN = writeVersionAndHelpProvider(
        directory,
        COMPLETE_CLAUDE_HELP,
        name,
        JSON.stringify({
          loggedIn: false,
          authMethod: "private-auth-method",
          apiProvider: "private-api-provider",
        }),
      );

      const claude = (await detectProviders(500)).find((provider) => provider.id === "claude");
      expect(claude).toEqual(expect.objectContaining({
        available: false,
        detail: "Claude 认证不可用",
      }));
      expect(JSON.stringify(claude)).not.toContain("private-auth-method");
      expect(JSON.stringify(claude)).not.toContain("private-api-provider");
      expect(providerProbeCalls(directory, name)).toEqual([
        ["--version"],
        ["--help"],
        ["auth", "status", "--json"],
      ]);
    } finally {
      if (previous === undefined) delete process.env.HOMEAGENT_CLAUDE_BIN;
      else process.env.HOMEAGENT_CLAUDE_BIN = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("does not advertise Codex when ChatGPT is not connected", async () => {
    const previous = process.env.HOMEAGENT_CODEX_BIN;
    const directory = mkdtempSync(join(tmpdir(), "ha-codex-auth-logged-out-"));
    const name = "codex-auth-logged-out";
    try {
      process.env.HOMEAGENT_CODEX_BIN = writeCodexStatusProvider(directory, name, 1);

      const codex = (await detectProviders(500)).find((provider) => provider.id === "codex");
      expect(codex).toEqual(expect.objectContaining({
        available: false,
        detail: "HomeAgent 尚未连接当前 Codex 账号",
      }));
      expect(providerProbeCalls(directory, name)).toEqual([
        ["--version"],
        [...CODEX_STATUS_ARGS],
        [
          "-c",
          'cli_auth_credentials_store="keyring"',
          "login",
          "status",
        ],
      ]);
    } finally {
      if (previous === undefined) delete process.env.HOMEAGENT_CODEX_BIN;
      else process.env.HOMEAGENT_CODEX_BIN = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("seeds the isolated Codex home from the console login during detection", async () => {
    const previousBin = process.env.HOMEAGENT_CODEX_BIN;
    const previousHome = process.env.HOMEAGENT_CODEX_HOME;
    const previousAmbient = process.env.CODEX_HOME;
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "ha-codex-detect-seed-")));
    const codexHome = join(directory, "provider-state", "codex");
    const ambientHome = join(directory, "ambient-codex");
    const name = "codex-detect-seed";
    try {
      // Point the ambient home at a fixture so this test never reads, copies or
      // prints the developer's real Codex credentials.
      mkdirSync(ambientHome, { recursive: true });
      const credentials = JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { access_token: "test-only-console-token" },
      });
      writeFileSync(join(ambientHome, "auth.json"), credentials, "utf8");
      process.env.CODEX_HOME = ambientHome;
      process.env.HOMEAGENT_CODEX_BIN = writeCodexStatusProvider(
        directory,
        name,
        0,
        [...CODEX_STATUS_ARGS],
        0,
        "codex-cli 0.151.9",
        "[]",
        0,
        0,
      );
      process.env.HOMEAGENT_CODEX_HOME = codexHome;
      expect(existsSync(codexHome)).toBe(false);

      const codex = (await detectProviders(500)).find((provider) => provider.id === "codex");

      expect(codex).toEqual(expect.objectContaining({
        available: true,
        detail: expect.stringContaining("codex-cli 0.151.9"),
      }));
      // Detection itself created the isolated home and reused the console
      // login, instead of reporting a usable account as unavailable.
      const seeded = join(codexHome, "auth.json");
      expect(existsSync(seeded)).toBe(true);
      expect(readFileSync(seeded, "utf8")).toBe(credentials);
      expect(lstatSync(seeded).isSymbolicLink()).toBe(false);
    } finally {
      if (previousBin === undefined) delete process.env.HOMEAGENT_CODEX_BIN;
      else process.env.HOMEAGENT_CODEX_BIN = previousBin;
      if (previousHome === undefined) delete process.env.HOMEAGENT_CODEX_HOME;
      else process.env.HOMEAGENT_CODEX_HOME = previousHome;
      if (previousAmbient === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousAmbient;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("prepares the isolated Codex home before reusing file authentication", async () => {
    const previousBin = process.env.HOMEAGENT_CODEX_BIN;
    const previousHome = process.env.HOMEAGENT_CODEX_HOME;
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "ha-codex-file-reuse-")));
    const codexHome = join(directory, "provider-state", "codex");
    const name = "codex-file-reuse";
    try {
      process.env.HOMEAGENT_CODEX_BIN = writeCodexStatusProvider(
        directory,
        name,
        0,
        [...CODEX_STATUS_ARGS],
        0,
        "codex-cli 0.151.9",
        "[]",
        0,
        0,
      );
      process.env.HOMEAGENT_CODEX_HOME = codexHome;

      expect(existsSync(codexHome)).toBe(false);
      ensureProviderCodexHome();
      const codex = (await detectProviders(500)).find((provider) => provider.id === "codex");

      expect(existsSync(codexHome)).toBe(true);
      expect(codex).toEqual(expect.objectContaining({
        available: true,
        detail: expect.stringContaining("codex-cli 0.151.9"),
      }));
      expect(providerProbeCalls(directory, name)).toEqual([
        ["--version"],
        [...CODEX_STATUS_ARGS],
      ]);
    } finally {
      if (previousBin === undefined) delete process.env.HOMEAGENT_CODEX_BIN;
      else process.env.HOMEAGENT_CODEX_BIN = previousBin;
      if (previousHome === undefined) delete process.env.HOMEAGENT_CODEX_HOME;
      else process.env.HOMEAGENT_CODEX_HOME = previousHome;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("keeps ordinary Codex available while reporting missing native session support", async () => {
    const previous = process.env.HOMEAGENT_CODEX_BIN;
    const directory = mkdtempSync(join(tmpdir(), "ha-codex-native-session-capability-"));
    const name = "codex-native-session-capability";
    try {
      process.env.HOMEAGENT_CODEX_BIN = writeCodexStatusProvider(
        directory,
        name,
        0,
        [...CODEX_STATUS_ARGS],
        42,
      );

      const codex = (await detectProviders(500)).find((provider) => provider.id === "codex");
      expect(codex).toEqual(expect.objectContaining({
        available: true,
        nativeSessions: false,
        detail: expect.stringContaining("Codex 原生会话能力不可用"),
      }));
      expect(providerProbeCalls(directory, name)).toEqual([
        ["--version"],
        [...CODEX_STATUS_ARGS],
        ["exec", "fork", "--help"],
      ]);
    } finally {
      if (previous === undefined) delete process.env.HOMEAGENT_CODEX_BIN;
      else process.env.HOMEAGENT_CODEX_BIN = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("identifies the recoverable Windows elevated sandbox requirement without leaking stderr", async () => {
    const previous = process.env.HOMEAGENT_CODEX_BIN;
    const directory = mkdtempSync(join(tmpdir(), "ha-codex-windows-sandbox-setup-"));
    const name = "codex-windows-sandbox-setup";
    const privateDiagnostic = "private diagnostic must stay private";
    try {
      process.env.HOMEAGENT_CODEX_BIN = writeCodexStatusProvider(
        directory,
        name,
        0,
        [...CODEX_STATUS_ARGS],
        0,
        "codex-cli 0.152.1",
        "[]",
        0,
        1,
        `windows sandbox failed: Restricted read-only access requires the elevated Windows sandbox backend\n${privateDiagnostic}`,
      );

      const codex = (await detectProviders(500)).find((provider) => provider.id === "codex");
      expect(codex).toEqual(expect.objectContaining({
        available: true,
        nativeSessions: false,
        nativeSessionIssue: "windows-elevated-sandbox-required",
      }));
      expect(JSON.stringify(codex)).not.toContain(privateDiagnostic);
    } finally {
      if (previous === undefined) delete process.env.HOMEAGENT_CODEX_BIN;
      else process.env.HOMEAGENT_CODEX_BIN = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("keeps native Codex sessions available with only the known Windows arg0 warnings", async () => {
    const previous = process.env.HOMEAGENT_CODEX_BIN;
    const directory = mkdtempSync(join(tmpdir(), "ha-codex-windows-arg0-warning-"));
    const name = "codex-windows-arg0-warning";
    const warnings = [
      "WARNING: failed to clean up stale arg0 temp dirs: 拒绝访问。 (os error 5)",
      'WARNING: proceeding, even though we could not create PATH aliases: 拒绝访问。 (os error 5) at path "C:\\private\\codex-arg0"',
    ].join("\n");
    try {
      process.env.HOMEAGENT_CODEX_BIN = writeCodexStatusProvider(
        directory,
        name,
        0,
        [...CODEX_STATUS_ARGS],
        0,
        "codex-cli 0.152.1",
        "[]",
        0,
        0,
        "",
        undefined,
        warnings,
      );

      const codex = (await detectProviders(500)).find((provider) => provider.id === "codex");
      expect(codex).toEqual(expect.objectContaining({
        available: true,
        nativeSessions: true,
        detail: "codex-cli 0.152.1",
      }));
      expect(JSON.stringify(codex)).not.toContain("private");
    } finally {
      if (previous === undefined) delete process.env.HOMEAGENT_CODEX_BIN;
      else process.env.HOMEAGENT_CODEX_BIN = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("reuses the console Codex keyring login without inheriting ambient configuration", async () => {
    const previous = process.env.HOMEAGENT_CODEX_BIN;
    const directory = mkdtempSync(join(tmpdir(), "ha-codex-keyring-login-"));
    const name = "codex-keyring-login";
    try {
      process.env.HOMEAGENT_CODEX_BIN = writeCodexStatusProvider(
        directory,
        name,
        1,
        [...CODEX_STATUS_ARGS],
        0,
        "codex-cli 0.152.1",
        "[]",
        0,
        0,
        "",
        0,
      );

      const codex = (await detectProviders(500)).find((provider) => provider.id === "codex");
      expect(codex).toEqual(expect.objectContaining({ available: true }));
      await expect(runProviderDetailed("codex", {
        prompt: "must reach only the fake provider",
      }, 500)).rejects.toThrow("provider codex exited 42");

      const calls = providerProbeCalls(directory, name);
      expect(calls[1]).toEqual([...CODEX_STATUS_ARGS]);
      expect(calls[2]).toEqual([
        "-c",
        'cli_auth_credentials_store="keyring"',
        "login",
        "status",
      ]);
      expect(calls.at(-1)).toEqual(expect.arrayContaining([
        "-c",
        'cli_auth_credentials_store="keyring"',
        "exec",
      ]));
    } finally {
      if (previous === undefined) delete process.env.HOMEAGENT_CODEX_BIN;
      else process.env.HOMEAGENT_CODEX_BIN = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("keeps ordinary Codex available below the native session isolation minimum", async () => {
    const previous = process.env.HOMEAGENT_CODEX_BIN;
    const directory = mkdtempSync(join(tmpdir(), "ha-codex-native-session-version-"));
    const name = "codex-native-session-version";
    try {
      process.env.HOMEAGENT_CODEX_BIN = writeCodexStatusProvider(
        directory,
        name,
        0,
        [...CODEX_STATUS_ARGS],
        0,
        "codex-cli 0.151.9",
      );

      const codex = (await detectProviders(500)).find((provider) => provider.id === "codex");
      expect(codex).toEqual(expect.objectContaining({
        available: true,
        nativeSessions: false,
        detail: expect.stringContaining("Codex 原生会话能力不可用"),
      }));
      expect(providerProbeCalls(directory, name)).toEqual([
        ["--version"],
        [...CODEX_STATUS_ARGS],
      ]);
    } finally {
      if (previous === undefined) delete process.env.HOMEAGENT_CODEX_BIN;
      else process.env.HOMEAGENT_CODEX_BIN = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("keeps ordinary Codex available but disables native sessions when managed MCP exists", async () => {
    const previous = process.env.HOMEAGENT_CODEX_BIN;
    const directory = mkdtempSync(join(tmpdir(), "ha-codex-native-session-mcp-detect-"));
    const name = "codex-native-session-mcp-detect";
    const privateServerName = "private-system-managed-server";
    try {
      process.env.HOMEAGENT_CODEX_BIN = writeCodexStatusProvider(
        directory,
        name,
        0,
        [...CODEX_STATUS_ARGS],
        0,
        "codex-cli 0.152.1",
        JSON.stringify([{ name: privateServerName }]),
      );

      const codex = (await detectProviders(500)).find((provider) => provider.id === "codex");
      expect(codex).toEqual(expect.objectContaining({
        available: true,
        nativeSessions: false,
        detail: expect.stringContaining("Codex 原生会话能力不可用"),
      }));
      expect(JSON.stringify(codex)).not.toContain(privateServerName);
      const calls = providerProbeCalls(directory, name);
      expect(calls.slice(0, 3)).toEqual([
        ["--version"],
        [...CODEX_STATUS_ARGS],
        ["exec", "fork", "--help"],
      ]);
      expect(calls[3]).toEqual(expect.arrayContaining(["mcp", "list", "--json"]));
      expect(calls).toHaveLength(4);
    } finally {
      if (previous === undefined) delete process.env.HOMEAGENT_CODEX_BIN;
      else process.env.HOMEAGENT_CODEX_BIN = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects non-empty or malformed MCP output before a native model call", async () => {
    const previous = process.env.HOMEAGENT_CODEX_BIN;
    const directory = mkdtempSync(join(tmpdir(), "ha-codex-native-session-mcp-preflight-"));
    try {
      for (const [name, privateServerName, mcpOutput] of [
        [
          "codex-native-session-mcp-nonempty",
          "private-nonempty-managed-server",
          JSON.stringify([{ name: "private-nonempty-managed-server" }]),
        ],
        [
          "codex-native-session-mcp-malformed",
          "private-malformed-managed-server",
          '{"name":"private-malformed-managed-server"}',
        ],
      ] as const) {
        process.env.HOMEAGENT_CODEX_BIN = writeCodexStatusProvider(
          directory,
          name,
          0,
          [...CODEX_STATUS_ARGS],
          0,
          "codex-cli 0.152.1",
          mcpOutput,
        );

        let failure = "";
        try {
          await runProviderDetailed(
            "codex",
            {
              prompt: "must not reach a model",
              execution: { ...READ_ONLY_EXECUTION, workdir: directory },
              nativeSession: { mode: "start" },
            },
            500,
          );
        } catch (error) {
          failure = String(error);
        }

        expect(failure).toBe(
          "Error: provider codex native session isolation is unavailable",
        );
        expect(failure).not.toContain(privateServerName);
        expect(providerProbeCalls(directory, name)).toEqual([
          ["--version"],
          ["exec", "fork", "--help"],
          codexMcpListArgs(directory),
        ]);
      }
    } finally {
      if (previous === undefined) delete process.env.HOMEAGENT_CODEX_BIN;
      else process.env.HOMEAGENT_CODEX_BIN = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects a native session start before completion when Codex cannot fork", async () => {
    const previous = process.env.HOMEAGENT_CODEX_BIN;
    const directory = mkdtempSync(join(tmpdir(), "ha-codex-native-session-preflight-"));
    const name = "codex-native-session-preflight";
    try {
      process.env.HOMEAGENT_CODEX_BIN = writeCodexStatusProvider(
        directory,
        name,
        0,
        [...CODEX_STATUS_ARGS],
        42,
      );

      await expect(runProviderDetailed(
        "codex",
        {
          prompt: "must not reach a model",
          execution: READ_ONLY_EXECUTION,
          nativeSession: { mode: "start" },
        },
        500,
      )).rejects.toThrow("native session isolation is unavailable");
      expect(providerProbeCalls(directory, name)).toEqual([
        ["--version"],
        ["exec", "fork", "--help"],
      ]);
    } finally {
      if (previous === undefined) delete process.env.HOMEAGENT_CODEX_BIN;
      else process.env.HOMEAGENT_CODEX_BIN = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects a native session before completion on an older Codex", async () => {
    const previous = process.env.HOMEAGENT_CODEX_BIN;
    const directory = mkdtempSync(join(tmpdir(), "ha-codex-native-session-old-version-"));
    const name = "codex-native-session-old-version";
    try {
      process.env.HOMEAGENT_CODEX_BIN = writeCodexStatusProvider(
        directory,
        name,
        0,
        [...CODEX_STATUS_ARGS],
        0,
        "codex-cli 0.151.9",
      );

      await expect(runProviderDetailed(
        "codex",
        {
          prompt: "must not reach a model",
          execution: READ_ONLY_EXECUTION,
          nativeSession: { mode: "start" },
        },
        500,
      )).rejects.toThrow("native session isolation is unavailable");
      expect(providerProbeCalls(directory, name)).toEqual([["--version"]]);
    } finally {
      if (previous === undefined) delete process.env.HOMEAGENT_CODEX_BIN;
      else process.env.HOMEAGENT_CODEX_BIN = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

    test("uses the isolated file credential store for a user-installed Codex on PATH", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ha-codex-default-auth-"));
    const name = "codex";
    try {
      writeCodexStatusProvider(directory, name, 0, CODEX_STATUS_ARGS);
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PATH: `${directory}${delimiter}${process.env.PATH ?? ""}`,
      };
      delete env.HOMEAGENT_CODEX_BIN;
      delete env.HOMEBRAIN_CODEX_BIN;
      const proc = Bun.spawn([
        process.execPath,
        "-e",
        "import { detectProviders } from './packages/llm/src/providers.ts'; console.log(JSON.stringify((await detectProviders(500)).find((provider) => provider.id === 'codex')));",
      ], {
        cwd: process.cwd(),
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      expect(code).toBe(0);
      expect(stderr).toBe("");
      const codex = JSON.parse(stdout) as Awaited<ReturnType<typeof detectProviders>>[number];
      const calls = providerProbeCalls(directory, name);
      expect(calls.slice(0, 3)).toEqual([
        ["--version"],
        [...CODEX_STATUS_ARGS],
        ["exec", "fork", "--help"],
      ]);
      expect(calls[3]).toEqual(expect.arrayContaining(["mcp", "list", "--json"]));
      expect(calls[4]).toEqual(expect.arrayContaining([
        "sandbox",
        "-P",
        "homeagent_topic",
        "--include-managed-config",
      ]));
      expect(calls).toHaveLength(5);
      expect(codex).toEqual(expect.objectContaining({
        available: true,
        bin: "codex",
        nativeSessions: true,
      }));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("uses a fixed safe detail when Claude auth status exits non-zero", async () => {
    const previous = process.env.HOMEAGENT_CLAUDE_BIN;
    const directory = mkdtempSync(join(tmpdir(), "ha-provider-auth-exit-"));
    try {
      process.env.HOMEAGENT_CLAUDE_BIN = writeVersionAndHelpProvider(
        directory,
        COMPLETE_CLAUDE_HELP,
        "claude-auth-exit",
        '{"loggedIn":true,"authMethod":"private-nonzero-auth"}',
        7,
      );

      const claude = (await detectProviders(500)).find((provider) => provider.id === "claude");
      expect(claude).toEqual(expect.objectContaining({
        available: false,
        detail: "Claude 认证不可用",
      }));
      expect(JSON.stringify(claude)).not.toContain("private-nonzero-auth");
    } finally {
      if (previous === undefined) delete process.env.HOMEAGENT_CLAUDE_BIN;
      else process.env.HOMEAGENT_CLAUDE_BIN = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("uses a fixed safe detail for malformed or oversized Claude auth JSON", async () => {
    const previous = process.env.HOMEAGENT_CLAUDE_BIN;
    const directory = mkdtempSync(join(tmpdir(), "ha-provider-auth-json-"));
    try {
      for (const [name, output] of [
        ["claude-auth-malformed", "not-json-private-auth-output"],
        [
          "claude-auth-oversized",
          JSON.stringify({ loggedIn: true, privatePadding: "x".repeat(17 * 1024) }),
        ],
      ] as const) {
        process.env.HOMEAGENT_CLAUDE_BIN = writeVersionAndHelpProvider(
          directory,
          COMPLETE_CLAUDE_HELP,
          name,
          output,
        );
        const claude = (await detectProviders(500)).find(
          (provider) => provider.id === "claude",
        );
        expect(claude).toEqual(expect.objectContaining({
          available: false,
          detail: "Claude 认证不可用",
        }));
        expect(JSON.stringify(claude)).not.toContain("private-auth-output");
        expect(JSON.stringify(claude)).not.toContain("privatePadding");
      }
    } finally {
      if (previous === undefined) delete process.env.HOMEAGENT_CLAUDE_BIN;
      else process.env.HOMEAGENT_CLAUDE_BIN = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("uses a fixed safe detail when Claude auth status times out", async () => {
    const previous = process.env.HOMEAGENT_CLAUDE_BIN;
    const directory = mkdtempSync(join(tmpdir(), "ha-provider-auth-timeout-"));
    try {
      process.env.HOMEAGENT_CLAUDE_BIN = writeVersionAndHelpProvider(
        directory,
        COMPLETE_CLAUDE_HELP,
        "claude-auth-timeout",
        '{"loggedIn":true}',
        0,
        1_000,
      );

      expect((await detectProviders(500)).find((provider) => provider.id === "claude"))
        .toEqual(expect.objectContaining({
          available: false,
          detail: "Claude 认证不可用",
        }));
    } finally {
      if (previous === undefined) delete process.env.HOMEAGENT_CLAUDE_BIN;
      else process.env.HOMEAGENT_CLAUDE_BIN = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("accepts pre-rename binary overrides without changing CLI authentication", async () => {
    const canonical = process.env.HOMEAGENT_CODEX_BIN;
    const legacy = process.env.HOMEBRAIN_CODEX_BIN;
    const directory = mkdtempSync(join(tmpdir(), "ha-provider-legacy-"));
    try {
      delete process.env.HOMEAGENT_CODEX_BIN;
      process.env.HOMEBRAIN_CODEX_BIN = writeArgEchoProvider(directory);

      const detected = await detectProviders(500);
      expect(detected.find((provider) => provider.id === "codex")?.bin)
        .toBe(process.env.HOMEBRAIN_CODEX_BIN);
      expect(await runProvider(
        "codex",
        { prompt: "legacy", execution: READ_ONLY_EXECUTION },
        500,
      )).toContain('cli_auth_credentials_store=\\"file\\"');
    } finally {
      if (canonical === undefined) delete process.env.HOMEAGENT_CODEX_BIN;
      else process.env.HOMEAGENT_CODEX_BIN = canonical;
      if (legacy === undefined) delete process.env.HOMEBRAIN_CODEX_BIN;
      else process.env.HOMEBRAIN_CODEX_BIN = legacy;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("Claude research can combine query commands and web tools", async () => {
    const previous = process.env.HOMEAGENT_CLAUDE_BIN;
    const directory = mkdtempSync(join(tmpdir(), "ha-provider-research-"));
    try {
      process.env.HOMEAGENT_CLAUDE_BIN = writeArgEchoProvider(directory);

      const output = await runProvider("claude", {
        prompt: "读取飞书文档并核验公开资料",
        execution: {
          permission: "read-only",
          skills: [],
          skillMode: "all",
          research: true,
        },
      }, 500);

      expect(output).toContain(
        "--tools Read,Glob,Grep,Bash,WebSearch,WebFetch --permission-mode dontAsk",
      );
    } finally {
      if (previous === undefined) delete process.env.HOMEAGENT_CLAUDE_BIN;
      else process.env.HOMEAGENT_CLAUDE_BIN = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("Codex research enables native search inside its configured sandbox", async () => {
    const previous = process.env.HOMEAGENT_CODEX_BIN;
    const directory = mkdtempSync(join(tmpdir(), "ha-codex-research-"));
    try {
      process.env.HOMEAGENT_CODEX_BIN = writeArgEchoProvider(directory);
      const skillDirectory = join(directory, "lark-doc");
      mkdirSync(skillDirectory);
      const skillFile = join(skillDirectory, "SKILL.md");
      writeFileSync(skillFile, "# Lark doc\n", "utf8");

      const output = await runProvider("codex", {
        prompt: "读取资料并交叉核验",
        execution: {
          permission: "read-only",
          skills: ["lark-doc"],
          skillMode: "all",
          research: true,
        },
        skillInputs: [{
          name: "lark-doc",
          directory: skillDirectory,
          skillFile,
          bundleHash: hashProviderSkillBundle(skillFile),
        }],
      }, 500);

      expect(output).toContain("--search exec");
      expect(output).toContain("--sandbox read-only");
    } finally {
      if (previous === undefined) delete process.env.HOMEAGENT_CODEX_BIN;
      else process.env.HOMEAGENT_CODEX_BIN = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("Claude writable research keeps editing, query-command, and web tools", async () => {
    const previous = process.env.HOMEAGENT_CLAUDE_BIN;
    const directory = mkdtempSync(join(tmpdir(), "ha-provider-write-research-"));
    try {
      process.env.HOMEAGENT_CLAUDE_BIN = writeArgEchoProvider(directory);

      const output = await runProvider("claude", {
        prompt: "调研并更新工作区报告",
        execution: {
          permission: "write",
          skills: [],
          research: true,
        },
      }, 500);

      expect(output).toContain(
        "--tools Read,Glob,Grep,Edit,Write,NotebookEdit,Bash,WebSearch,WebFetch --permission-mode acceptEdits",
      );
    } finally {
      if (previous === undefined) delete process.env.HOMEAGENT_CLAUDE_BIN;
      else process.env.HOMEAGENT_CLAUDE_BIN = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("task execution maps permission tiers to provider sandboxes", async () => {
    const keys = [
      "HOMEAGENT_CODEX_BIN",
      "HOMEAGENT_CLAUDE_BIN",
      "HOMEAGENT_TRAE_BIN",
    ] as const;
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    const directory = mkdtempSync(join(tmpdir(), "ha-provider-permissions-"));
    try {
      const bin = writeArgEchoProvider(directory);
      for (const key of keys) process.env[key] = bin;

      expect(
        await runProvider("claude", {
          prompt: "inspect",
          execution: { permission: "read-only", skills: [] },
        }, 500),
      ).toBe(
        "-p --safe-mode --no-session-persistence --strict-mcp-config --output-format json --tools Read,Glob,Grep --permission-mode dontAsk",
      );
      expect(
        await runProvider("claude", {
          prompt: "research",
          execution: { permission: "read-only", skills: [], webSearch: true },
        }, 500),
      ).toBe(
        "-p --safe-mode --no-session-persistence --strict-mcp-config --output-format json --tools WebSearch,WebFetch --permission-mode dontAsk",
      );
      expect(
        await runProvider("claude", {
          prompt: "edit",
          execution: { permission: "write", skills: [] },
        }, 500),
      ).toBe(
        "-p --safe-mode --no-session-persistence --strict-mcp-config --output-format json --tools Read,Glob,Grep,Edit,Write,NotebookEdit --permission-mode acceptEdits",
      );
      expect(
        await runProvider("claude", {
          prompt: "admin",
          execution: { permission: "full", skills: [] },
        }, 500),
      ).toBe(
        "-p --safe-mode --no-session-persistence --strict-mcp-config --output-format json --tools default --dangerously-skip-permissions",
      );
      const codexWrite = await runProvider("codex", {
        prompt: "edit",
        execution: { permission: "write", skills: [] },
      }, 500);
      expect(codexWrite).toContain("approval_policy");
      expect(codexWrite).toContain(
        "--ephemeral --strict-config --ignore-user-config --ignore-rules",
      );
      expect(codexWrite).toContain(
        "exec --ephemeral --strict-config --ignore-user-config --ignore-rules --json --sandbox workspace-write --skip-git-repo-check -- -",
      );

      await expect(runProvider("codex", {
        prompt: "research",
        execution: { permission: "read-only", skills: [], webSearch: true },
      }, 500)).rejects.toThrow("cannot isolate web search from local file tools");
      expect(
        await runProvider("trae-cli", {
          prompt: "admin",
          execution: { permission: "full", skills: [] },
        }, 500),
      ).toBe(
        "exec --sandbox danger-full-access admin",
      );
      await expect(runProvider("trae-cli", {
        prompt: "research",
        execution: { permission: "read-only", skills: [], webSearch: true },
      }, 500)).rejects.toThrow("does not support web search");
      await expect(runProvider("codex", {
        prompt: "unsafe research",
        execution: { permission: "write", skills: [], webSearch: true },
      }, 500)).rejects.toThrow("requires read-only");
      expect(
        await runProvider("claude", {
          prompt: "invalid",
          execution: { permission: "root" as never, skills: [] },
        }, 500),
      ).toBe(
        "-p --safe-mode --no-session-persistence --strict-mcp-config --output-format json --tools Read,Glob,Grep --permission-mode dontAsk",
      );
    } finally {
      for (const key of keys) {
        const value = previous[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("task execution starts in the configured workdir and injects required skills", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ha-provider-workdir-"));
    const bin = join(dir, process.platform === "win32" ? "provider.cmd" : "provider");
    const previous = process.env.HOMEAGENT_CODEX_BIN;
    try {
      writeFileSync(
        bin,
        process.platform === "win32"
          ? '@echo off\r\necho %CD%\r\necho %*\r\nnode -e "let s=\'\';process.stdin.setEncoding(\'utf8\');process.stdin.on(\'data\',d=>s+=d);process.stdin.on(\'end\',()=>process.stdout.write(s))"\r\n'
          : '#!/bin/sh\nprintf "%s\\n" "$PWD"\nprintf "%s\\n" "$*"\ncat\n',
        "utf8",
      );
      if (process.platform !== "win32") chmodSync(bin, 0o755);
      process.env.HOMEAGENT_CODEX_BIN = bin;
      const codeReviewDirectory = join(dir, "code-review");
      const githubDirectory = join(dir, "github-yeet");
      mkdirSync(codeReviewDirectory);
      mkdirSync(githubDirectory);
      const codeReviewFile = join(codeReviewDirectory, "SKILL.md");
      const githubFile = join(githubDirectory, "SKILL.md");
      writeFileSync(codeReviewFile, "# Code review\n", "utf8");
      writeFileSync(githubFile, "# GitHub\n", "utf8");

      const output = await runProvider("codex", {
        prompt: "review this project",
        execution: {
          permission: "read-only",
          workdir: dir,
          skills: ["code-review", "../escape", "code-review", "github:yeet"],
        },
        skillInputs: [
          {
            name: "code-review",
            directory: codeReviewDirectory,
            skillFile: codeReviewFile,
            bundleHash: hashProviderSkillBundle(codeReviewFile),
          },
          {
            name: "github:yeet",
            directory: githubDirectory,
            skillFile: githubFile,
            bundleHash: hashProviderSkillBundle(githubFile),
          },
        ],
      }, 500);

      expect(output.split(/\r?\n/u)[0]).toBe(realpathSync(dir));
      expect(output).not.toContain(realpathSync(codeReviewDirectory));
      expect(output).not.toContain(realpathSync(githubDirectory));
      expect(output).toContain("homeagent-codex-skills-");
      expect(output).not.toContain("$code-review");
      expect(output).not.toContain("$github:yeet");
      expect(output).not.toContain("../escape");
      expect(output).toContain("--sandbox read-only");
    } finally {
      if (previous === undefined) delete process.env.HOMEAGENT_CODEX_BIN;
      else process.env.HOMEAGENT_CODEX_BIN = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("detects the fixed known CLIs and reports availability", async () => {
    const list = await detectProviders(8000);
    const ids = list.map((p) => p.id).sort();
    expect(ids).toEqual(["claude", "codex", "trae-cli"]);
    // every entry carries a boolean available + a detail string
    for (const p of list) {
      expect(typeof p.available).toBe("boolean");
      expect(typeof p.detail).toBe("string");
      expect(p.detail.length).toBeGreaterThan(0);
    }
  });

  test("isCliProvider recognizes known ids, rejects gateway/unknown", () => {
    expect(isCliProvider("claude")).toBe(true);
    expect(isCliProvider("codex")).toBe(true);
    expect(isCliProvider("trae-cli")).toBe(true);
    // "gateway" is the built-in network provider, not a local CLI
    expect(isCliProvider("gateway")).toBe(false);
    expect(isCliProvider("nope")).toBe(false);
  });

  test("runProvider rejects an unknown provider id", async () => {
    await expect(runProvider("gateway" as never, { prompt: "hi" })).rejects.toThrow();
  });

  test("runProvider terminates the CLI process when its abort signal fires", async () => {
    if (process.platform === "win32") return;

    const dir = mkdtempSync(join(tmpdir(), "ha-provider-abort-"));
    const bin = join(dir, "slow-provider");
    const previous = process.env.HOMEAGENT_TRAE_BIN;
    try {
      writeFileSync(bin, "#!/bin/sh\nexec sleep 10\n", "utf8");
      chmodSync(bin, 0o755);
      process.env.HOMEAGENT_TRAE_BIN = bin;
      const controller = new AbortController();
      const completion = runProvider(
        "trae-cli",
        { prompt: "wait", execution: READ_ONLY_EXECUTION },
        5_000,
        controller.signal,
      );

      setTimeout(() => controller.abort(new Error("caller cancelled")), 10);

      await expect(completion).rejects.toThrow("caller cancelled");
    } finally {
      if (previous === undefined) delete process.env.HOMEAGENT_TRAE_BIN;
      else process.env.HOMEAGENT_TRAE_BIN = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("provider errors fall back to stdout when stderr is empty", () => {
    expect(providerFailureDetail("auth failed on stdout", "")).toBe("auth failed on stdout");
    expect(providerFailureDetail("less useful stdout", "stderr detail")).toBe("stderr detail");
  });

  test("curatedProviderModels returns a distinct model list per CLI provider", () => {
    const m = curatedProviderModels();
    // no "gateway" key — providers are CLIs only
    expect(m.gateway).toBeUndefined();
    expect(m["trae-cli"]).toContain("openrouter-3o");
    // codex list mirrors mew's menu
    expect(m.codex?.slice(0, 3)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ]);
    expect(m.codex).toContain("gpt-5.5");
    expect(m.codex).toContain("gpt-5.3-codex-spark");
    expect(m.claude?.length).toBeGreaterThan(0);
    // provider lists are not all identical
    expect(m.claude).not.toEqual(m["trae-cli"]);
  });
});
