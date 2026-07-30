import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  codexReasoningEffortsForModel,
  curatedProviderModels,
  detectProviders,
  isCliProvider,
  providerFailureDetail,
  providerSkillReference,
  runProvider,
} from "./providers.ts";

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
        },
        500,
      );
      expect(output).toContain("cli_auth_credentials_store");
      expect(output).toContain("exec --sandbox read-only");
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

      expect(await runProvider("codex", { prompt }, 500)).toBe(prompt);
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
      const defaultRun = await runProvider("codex", { prompt: "hello" }, 500);
      expect(defaultRun).toContain("cli_auth_credentials_store");
      expect(defaultRun).toContain("exec --sandbox read-only -- -");

      const configuredRun = await runProvider(
        "codex",
        { prompt: "hello", model: "gpt-5.6-sol", reasoningEffort: "high" },
        500,
      );
      expect(configuredRun).toContain("model_reasoning_effort");
      expect(configuredRun).toContain("high");
      expect(configuredRun).toContain("exec --sandbox read-only -m gpt-5.6-sol -- -");
    } finally {
      for (const key of keys) {
        const value = previous[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
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
      expect(await runProvider("codex", { prompt: "legacy" }, 500)).toContain(
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
        "-p inspect --bare --tools Read,Glob,Grep --permission-mode dontAsk",
      );
      expect(
        await runProvider("claude", {
          prompt: "research",
          execution: { permission: "read-only", skills: [], webSearch: true },
        }, 500),
      ).toBe(
        "-p research --bare --tools Read,Glob,Grep,WebSearch,WebFetch --permission-mode dontAsk",
      );
      expect(
        await runProvider("claude", {
          prompt: "edit",
          execution: { permission: "write", skills: [] },
        }, 500),
      ).toBe(
        "-p edit --bare --tools Read,Glob,Grep,Edit,Write,NotebookEdit --permission-mode acceptEdits",
      );
      expect(
        await runProvider("claude", {
          prompt: "admin",
          execution: { permission: "full", skills: [] },
        }, 500),
      ).toBe(
        "-p admin --bare --tools default --dangerously-skip-permissions",
      );
      const codexWrite = await runProvider("codex", {
        prompt: "edit",
        execution: { permission: "write", skills: [] },
      }, 500);
      expect(codexWrite).toContain("approval_policy");
      expect(codexWrite).toContain(
        "exec --sandbox workspace-write --skip-git-repo-check -- -",
      );

      const codexResearch = await runProvider("codex", {
        prompt: "research",
        execution: { permission: "read-only", skills: [], webSearch: true },
      }, 500);
      expect(codexResearch).toContain("approval_policy");
      expect(codexResearch).toContain(
        "--search exec --sandbox read-only --skip-git-repo-check -- -",
      );
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
        "-p invalid --bare --tools Read,Glob,Grep --permission-mode dontAsk",
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
        { prompt: "wait" },
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
