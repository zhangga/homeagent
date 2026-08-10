import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetConfig } from "@homeagent/shared";
import { ProviderRunError, spentToday } from "@homeagent/llm";
import { extractJson, makeCliClient } from "./cli-client.ts";
import { observeLlmUsage, RunUsageAccumulator } from "./usage.ts";

describe("extractJson", () => {
  test("parses a bare JSON object", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  test("strips a ```json fenced block", () => {
    const out = "here you go:\n```json\n{\"ok\":true}\n```\nthanks";
    expect(extractJson(out)).toEqual({ ok: true });
  });

  test("recovers the outermost object amid surrounding prose", () => {
    const out = 'Sure! {"slugs":["a"],"relevant":true} — done';
    expect(extractJson(out)).toEqual({ slugs: ["a"], relevant: true });
  });

  test("throws when no JSON is present", () => {
    expect(() => extractJson("no json here")).toThrow();
  });
});

describe("makeCliClient", () => {
  test("complete() preserves structured provider usage without inventing a cost", async () => {
    const cli = makeCliClient("codex", "gpt-5.6-sol", async () => ({
      text: "answer",
      usage: {
        inputTokens: 240,
        cachedInputTokens: 180,
        outputTokens: 45,
        costBasis: "unavailable",
        source: "codex-jsonl",
      },
    }));

    const result = await cli.complete({ prompt: "hi" });

    expect(result).toEqual({
      text: "answer",
      model: "gpt-5.6-sol",
      usage: {
        inputTokens: 240,
        cachedInputTokens: 180,
        outputTokens: 45,
        costBasis: "unavailable",
        source: "codex-jsonl",
      },
    });
    expect(result).not.toHaveProperty("costUsd");
  });

  test("known CLI cost is recorded and blocks the next deferrable call at the daily budget", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ha-cli-budget-"));
    const previousDataDir = process.env.HOMEAGENT_DATA_DIR;
    const previousBudget = process.env.HOMEAGENT_DAILY_BUDGET_USD;
    let calls = 0;
    try {
      process.env.HOMEAGENT_DATA_DIR = directory;
      process.env.HOMEAGENT_DAILY_BUDGET_USD = "0.01";
      resetConfig();
      const cli = makeCliClient("claude", "sonnet", async () => {
        calls += 1;
        return {
          text: "answer",
          usage: {
            inputTokens: 100,
            outputTokens: 20,
            costUsd: 0.02,
            costBasis: "reported",
            source: "claude-json",
          },
        };
      });

      await cli.complete({ prompt: "first", purpose: "other" });

      expect(spentToday()).toBeCloseTo(0.02, 8);
      await expect(cli.complete({ prompt: "second", purpose: "other" }))
        .rejects.toThrow(/budget/i);
      expect(calls).toBe(1);
    } finally {
      if (previousDataDir === undefined) delete process.env.HOMEAGENT_DATA_DIR;
      else process.env.HOMEAGENT_DATA_DIR = previousDataDir;
      if (previousBudget === undefined) delete process.env.HOMEAGENT_DAILY_BUDGET_USD;
      else process.env.HOMEAGENT_DAILY_BUDGET_USD = previousBudget;
      resetConfig();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("completeJSON participates in the same usage accounting and budget preflight", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ha-cli-json-budget-"));
    const previousDataDir = process.env.HOMEAGENT_DATA_DIR;
    const previousBudget = process.env.HOMEAGENT_DAILY_BUDGET_USD;
    let calls = 0;
    try {
      process.env.HOMEAGENT_DATA_DIR = directory;
      process.env.HOMEAGENT_DAILY_BUDGET_USD = "0.01";
      resetConfig();
      const cli = makeCliClient("claude", "sonnet", async () => {
        calls += 1;
        return {
          text: '{"intent":"question"}',
          usage: {
            inputTokens: 80,
            outputTokens: 10,
            costUsd: 0.02,
            costBasis: "reported",
            source: "claude-json",
          },
        };
      });
      const options = {
        prompt: "classify",
        purpose: "other" as const,
        schema: { type: "object" },
      };

      const first = await cli.completeJSON<{ intent: string }>(options);

      expect(first.result.usage?.costUsd).toBe(0.02);
      expect(spentToday()).toBeCloseTo(0.02, 8);
      await expect(cli.completeJSON(options)).rejects.toThrow(/budget/i);
      expect(calls).toBe(1);
    } finally {
      if (previousDataDir === undefined) delete process.env.HOMEAGENT_DATA_DIR;
      else process.env.HOMEAGENT_DATA_DIR = previousDataDir;
      if (previousBudget === undefined) delete process.env.HOMEAGENT_DAILY_BUDGET_USD;
      else process.env.HOMEAGENT_DAILY_BUDGET_USD = previousBudget;
      resetConfig();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("completeJSON exposes provider usage even when response parsing fails", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ha-cli-json-usage-error-"));
    try {
      const accumulator = new RunUsageAccumulator();
      const cli = makeCliClient(
        "claude",
        "sonnet",
        async () => ({
          text: "not json",
          usage: {
            inputTokens: 55,
            outputTokens: 4,
            costUsd: 0.003,
            costBasis: "reported",
            source: "claude-json",
          },
        }),
        undefined,
        undefined,
        undefined,
        undefined,
        [],
        directory,
      );
      const observed = observeLlmUsage(cli, (usage) => accumulator.record(usage));

      await expect(observed.completeJSON({
        prompt: "classify",
        schema: { type: "object" },
      })).rejects.toThrow(/parseable JSON/i);

      expect(accumulator.snapshot()).toEqual(expect.objectContaining({
        calls: 1,
        knownTokenCalls: 1,
        knownCostCalls: 1,
        inputTokens: 55,
        outputTokens: 4,
        costUsd: 0.003,
      }));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("provider-reported spend is recorded even when the structured run fails", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ha-cli-failed-spend-"));
    const previousDataDir = process.env.HOMEAGENT_DATA_DIR;
    const previousBudget = process.env.HOMEAGENT_DAILY_BUDGET_USD;
    try {
      process.env.HOMEAGENT_DATA_DIR = directory;
      process.env.HOMEAGENT_DAILY_BUDGET_USD = "5";
      resetConfig();
      const cli = makeCliClient("claude", "sonnet", async () => {
        throw new ProviderRunError("claude", "provider failed", {
          inputTokens: 40,
          outputTokens: 5,
          costUsd: 0.004,
          costBasis: "reported",
          source: "claude-json",
        });
      });

      await expect(cli.complete({ prompt: "fail", purpose: "other" }))
        .rejects.toThrow("provider failed");

      expect(spentToday()).toBeCloseTo(0.004, 8);
    } finally {
      if (previousDataDir === undefined) delete process.env.HOMEAGENT_DATA_DIR;
      else process.env.HOMEAGENT_DATA_DIR = previousDataDir;
      if (previousBudget === undefined) delete process.env.HOMEAGENT_DAILY_BUDGET_USD;
      else process.env.HOMEAGENT_DAILY_BUDGET_USD = previousBudget;
      resetConfig();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("complete() returns the CLI stdout as text and folds system into prompt", async () => {
    let seen = "";
    const cli = makeCliClient("claude", "sonnet", async (_id, input) => {
      seen = input.prompt;
      return "  hello world  ";
    });
    const r = await cli.complete({ prompt: "hi", system: "你是海盗" });
    expect(r.text).toBe("hello world");
    expect(seen).toContain("你是海盗"); // system folded into the prompt
    expect(seen).toContain("hi");
  });

  test("complete() forwards visual inputs to the provider boundary", async () => {
    let images: unknown;
    const cli = makeCliClient("codex", "", async (_id, input) => {
      images = input.images;
      return "看到了晚餐图片";
    });

    await cli.complete({
      prompt: "分析这顿晚餐",
      images: [{ path: "/tmp/dinner.png" }],
    });

    expect(images).toEqual([{ path: "/tmp/dinner.png" }]);
  });

  test("forwards pinned Skill hints without creating an execution contract", async () => {
    const seen: unknown[] = [];
    const cli = makeCliClient(
      "codex",
      "",
      async (_id, input) => {
        seen.push(input);
        return /JSON Schema/.test(input.prompt) ? '{"ok":true}' : "ok";
      },
      undefined,
      undefined,
      undefined,
      undefined,
      ["review"],
    );

    await cli.complete({ prompt: "answer" });
    await cli.completeJSON({ prompt: "classify", schema: { type: "object" } });

    expect(seen).toHaveLength(2);
    for (const input of seen) {
      expect(input).toEqual(expect.objectContaining({
        execution: undefined,
        skills: ["review"],
      }));
    }
  });

  test("completeJSON() appends a schema instruction, parses, and validates", async () => {
    let seen = "";
    const cli = makeCliClient("trae-cli", "", async (_id, input) => {
      seen = input.prompt;
      return '```json\n{"intent":"question"}\n```';
    });
    const { value } = await cli.completeJSON<{ intent: string }>({
      prompt: "classify this",
      schema: { type: "object", properties: { intent: { type: "string" } } },
      validate: (raw) => raw as { intent: string },
    });
    expect(value.intent).toBe("question");
    expect(seen).toContain("JSON Schema"); // strict-JSON instruction was appended
  });

  test("completeJSON() throws a clear error on unparseable output", async () => {
    const cli = makeCliClient("codex", "", async () => "not json at all");
    await expect(
      cli.completeJSON({ prompt: "x", schema: { type: "object" } }),
    ).rejects.toThrow(/did not return parseable JSON/);
  });

  test("uses the constructor model and ignores per-call opts.model", async () => {
    // ask/dream pass network-tier model names (e.g. claude-sonnet-5, modelFast)
    // that a local CLI would reject; the client must pin the model chosen by the
    // engine at construction time.
    let usedModel: string | undefined;
    const cli = makeCliClient("trae-cli", "openrouter-3o", async (_id, input) => {
      usedModel = input.model;
      return "ok";
    });
    await cli.complete({ prompt: "a" });
    expect(usedModel).toBe("openrouter-3o");
    await cli.complete({ prompt: "a", model: "claude-sonnet-5" });
    expect(usedModel).toBe("openrouter-3o"); // per-call model ignored
  });

  test("empty constructor model => CLI's own default (undefined passed through)", async () => {
    let usedModel: string | undefined = "sentinel";
    const cli = makeCliClient("trae-cli", "", async (_id, input) => {
      usedModel = input.model;
      return "ok";
    });
    await cli.complete({ prompt: "a", model: "claude-sonnet-5" });
    expect(usedModel).toBeUndefined();
  });
});
