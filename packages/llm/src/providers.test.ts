import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  codexReasoningEffortsForModel,
  curatedProviderModels,
  detectProviders,
  isCliProvider,
  providerFailureDetail,
  providerSkillReference,
  ProviderRunError,
  runProvider,
  runProviderDetailed,
} from "./providers.ts";

const READ_ONLY_EXECUTION = {
  permission: "read-only" as const,
  skills: [],
};

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
      `if (args.length === 1 && args[0] === "--version") process.stdout.write(${JSON.stringify(`${name} 1.0\n`)});`,
      `else if (JSON.stringify(args) === ${JSON.stringify(JSON.stringify(["-c", 'cli_auth_credentials_store="keyring"', "login", "status"]))}) { process.stdout.write("${statusExitCode === 0 ? "Logged in using ChatGPT" : "Not logged in"}\\n"); process.exitCode = ${statusExitCode}; }`,
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
].join("\n");

function providerProbeCalls(directory: string, name: string): string[][] {
  return readFileSync(join(directory, `${name}.calls.jsonl`), "utf8")
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
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
          "exec --ephemeral --ignore-user-config --ignore-rules --json --sandbox read-only",
        ),
        usage: {
          costBasis: "unavailable",
          source: "legacy-text",
        },
      });
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
      process.env.HOMEAGENT_CLAUDE_BIN = writeArgEchoProvider(directory);

      const noTools = await runProvider("claude", {
        prompt: "answer the question",
      }, 500);
      const withSkillHint = await runProvider("claude", {
        prompt: "answer the question",
        skills: ["review"],
      }, 500);

      expect(withSkillHint).not.toContain("/review");
      expect(noTools).toContain(
        "--safe-mode --no-session-persistence --strict-mcp-config --output-format json --tools",
      );
      expect(noTools).not.toContain("--allowedTools");
      expect(noTools).not.toContain("--bare");
      expect(noTools).not.toContain("--tools Read,Glob,Grep");
      expect(noTools).not.toContain("--permission-mode");
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
      process.env.HOMEAGENT_CLAUDE_BIN = writeArgEchoProvider(directory);

      const output = await runProvider("claude", {
        prompt: "perform the explicit task",
        skills: [],
        execution: {
          permission: "read-only",
          skills: ["review"],
        },
      }, 500);

      expect(output).toContain("/review");
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
      process.env.HOMEAGENT_CLAUDE_BIN = writeArgEchoProvider(directory);

      const output = await runProvider("claude", {
        prompt: "read the linked Lark document",
        execution: {
          permission: "read-only",
          skills: ["lark-doc", "code-review"],
          skillMode: "all",
        },
      }, 500);

      expect(output).toContain("可按需使用以下技能：/lark-doc、/code-review");
      expect(output).toContain("只加载与当前请求相关的技能");
      expect(output).not.toContain("必须先加载并遵循");
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

      expect(output).toContain("exec --ephemeral --ignore-user-config --ignore-rules");
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
      expect(output).toContain("cli_auth_credentials_store");
      expect(output).toContain(
        "exec --ephemeral --ignore-user-config --ignore-rules --json --sandbox read-only",
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

  test("honors managed binary overrides for detection and execution", async () => {
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
      expect(defaultRun).toContain("cli_auth_credentials_store");
      expect(defaultRun).toContain(
        "exec --ephemeral --ignore-user-config --ignore-rules --json --sandbox read-only --skip-git-repo-check -- -",
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
        "exec --ephemeral --ignore-user-config --ignore-rules --json --sandbox read-only --skip-git-repo-check -m gpt-5.6-sol -- -",
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
        detail: "ChatGPT 尚未连接",
      }));
      expect(providerProbeCalls(directory, name)).toEqual([
        ["--version"],
        ["-c", 'cli_auth_credentials_store="keyring"', "login", "status"],
      ]);
    } finally {
      if (previous === undefined) delete process.env.HOMEAGENT_CODEX_BIN;
      else process.env.HOMEAGENT_CODEX_BIN = previous;
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

  test("accepts pre-rename managed binary overrides", async () => {
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
      )).toContain(
        "cli_auth_credentials_store",
      );
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

      const output = await runProvider("codex", {
        prompt: "读取资料并交叉核验",
        execution: {
          permission: "read-only",
          skills: ["lark-doc"],
          skillMode: "all",
          research: true,
        },
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
        "-p inspect --safe-mode --no-session-persistence --strict-mcp-config --output-format json --tools Read,Glob,Grep --permission-mode dontAsk",
      );
      expect(
        await runProvider("claude", {
          prompt: "research",
          execution: { permission: "read-only", skills: [], webSearch: true },
        }, 500),
      ).toBe(
        "-p research --safe-mode --no-session-persistence --strict-mcp-config --output-format json --tools WebSearch,WebFetch --permission-mode dontAsk",
      );
      expect(
        await runProvider("claude", {
          prompt: "edit",
          execution: { permission: "write", skills: [] },
        }, 500),
      ).toBe(
        "-p edit --safe-mode --no-session-persistence --strict-mcp-config --output-format json --tools Read,Glob,Grep,Edit,Write,NotebookEdit --permission-mode acceptEdits",
      );
      expect(
        await runProvider("claude", {
          prompt: "admin",
          execution: { permission: "full", skills: [] },
        }, 500),
      ).toBe(
        "-p admin --safe-mode --no-session-persistence --strict-mcp-config --output-format json --tools default --dangerously-skip-permissions",
      );
      const codexWrite = await runProvider("codex", {
        prompt: "edit",
        execution: { permission: "write", skills: [] },
      }, 500);
      expect(codexWrite).toContain("approval_policy");
      expect(codexWrite).toContain(
        "--ephemeral --ignore-user-config --ignore-rules",
      );
      expect(codexWrite).toContain(
        "exec --ephemeral --ignore-user-config --ignore-rules --json --sandbox workspace-write --skip-git-repo-check -- -",
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
        "-p invalid --safe-mode --no-session-persistence --strict-mcp-config --output-format json --tools Read,Glob,Grep --permission-mode dontAsk",
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

      const output = await runProvider("codex", {
        prompt: "review this project",
        execution: {
          permission: "read-only",
          workdir: dir,
          skills: ["code-review", "../escape", "code-review", "github:yeet"],
        },
      }, 500);

      expect(output.split(/\r?\n/u)[0]).toBe(realpathSync(dir));
      expect(output).toContain("$code-review");
      expect(output).toContain("$github:yeet");
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
