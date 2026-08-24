import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetConfig } from "@homeagent/shared";
import { ProviderRunError, spentToday } from "@homeagent/llm";
import { CliCompletionError, extractJson, makeCliClient } from "./cli-client.ts";
import { observeLlmUsage, RunUsageAccumulator } from "./usage.ts";

const testAccountingDataDir = mkdtempSync(join(tmpdir(), "ha-cli-client-suite-"));

afterAll(() => {
  rmSync(testAccountingDataDir, { recursive: true, force: true });
});

describe("extractJson", () => {
  test("parses a bare JSON object", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  test("parses a JSON object whose string content contains a Markdown code fence", () => {
    const value = {
      title: "Troubleshooting",
      content: "# Troubleshooting\n\n```powershell\nGet-Process bun\n```",
    };

    expect(extractJson(JSON.stringify(value))).toEqual(value);
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
  test("requires an explicit accounting directory", () => {
    expect(() => (makeCliClient as unknown as (...args: unknown[]) => unknown)(
      "codex",
      "",
      async () => "unused",
    )).toThrow(/accounting data directory/i);
  });

  test("an accounting write failure does not replace a successful provider result", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ha-cli-accounting-failure-"));
    const invalidAccountingDir = join(directory, "not-a-directory");
    writeFileSync(invalidAccountingDir, "occupied");
    try {
      const cli = makeCliClient(
        "codex",
        "gpt-5.6-sol",
        invalidAccountingDir,
        async () => "provider result",
      );

      await expect(cli.complete({ prompt: "hello" })).resolves.toEqual(
        expect.objectContaining({ text: "provider result" }),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("an accounting write failure preserves the original provider error", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ha-cli-accounting-provider-error-"));
    const invalidAccountingDir = join(directory, "not-a-directory");
    writeFileSync(invalidAccountingDir, "occupied");
    const providerError = new Error("original provider failure");
    try {
      const cli = makeCliClient(
        "codex",
        "gpt-5.6-sol",
        invalidAccountingDir,
        async () => {
          throw providerError;
        },
      );

      let thrown: unknown;
      try {
        await cli.complete({ prompt: "hello" });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBe(providerError);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("complete() preserves structured provider usage without inventing a cost", async () => {
    const cli = makeCliClient("codex", "gpt-5.6-sol", testAccountingDataDir, async () => ({
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
    const previousBudget = process.env.HOMEAGENT_DAILY_BUDGET_USD;
    let calls = 0;
    try {
      process.env.HOMEAGENT_DAILY_BUDGET_USD = "0.01";
      resetConfig();
      const cli = makeCliClient("claude", "sonnet", directory, async () => {
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

      expect(spentToday(undefined, directory)).toBeCloseTo(0.02, 8);
      await expect(cli.complete({ prompt: "second", purpose: "other" }))
        .rejects.toThrow(/budget/i);
      expect(calls).toBe(1);
    } finally {
      if (previousBudget === undefined) delete process.env.HOMEAGENT_DAILY_BUDGET_USD;
      else process.env.HOMEAGENT_DAILY_BUDGET_USD = previousBudget;
      resetConfig();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("completeJSON participates in the same usage accounting and budget preflight", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ha-cli-json-budget-"));
    const previousBudget = process.env.HOMEAGENT_DAILY_BUDGET_USD;
    let calls = 0;
    try {
      process.env.HOMEAGENT_DAILY_BUDGET_USD = "0.01";
      resetConfig();
      const cli = makeCliClient("claude", "sonnet", directory, async () => {
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
      expect(spentToday(undefined, directory)).toBeCloseTo(0.02, 8);
      await expect(cli.completeJSON(options)).rejects.toThrow(/budget/i);
      expect(calls).toBe(1);
    } finally {
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
        directory,
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
    const previousBudget = process.env.HOMEAGENT_DAILY_BUDGET_USD;
    try {
      process.env.HOMEAGENT_DAILY_BUDGET_USD = "5";
      resetConfig();
      const cli = makeCliClient("claude", "sonnet", directory, async () => {
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

      expect(spentToday(undefined, directory)).toBeCloseTo(0.004, 8);
    } finally {
      if (previousBudget === undefined) delete process.env.HOMEAGENT_DAILY_BUDGET_USD;
      else process.env.HOMEAGENT_DAILY_BUDGET_USD = previousBudget;
      resetConfig();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("complete() returns the CLI stdout as text and folds system into prompt", async () => {
    let seen = "";
    const cli = makeCliClient("claude", "sonnet", testAccountingDataDir, async (_id, input) => {
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
    const cli = makeCliClient("codex", "", testAccountingDataDir, async (_id, input) => {
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
      testAccountingDataDir,
      async (_id, input) => {
        seen.push(input);
        return input.outputSchema ? '{"ok":true}' : "ok";
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
    const cli = makeCliClient("trae-cli", "", testAccountingDataDir, async (_id, input) => {
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

  test("completeJSON() forwards its schema to native provider enforcement", async () => {
    const schema = {
      type: "object",
      properties: { content: { type: "string" } },
      required: ["content"],
    };
    let observedSchema: unknown;
    const cli = makeCliClient("codex", "", testAccountingDataDir, async (_id, input) => {
      observedSchema = input.outputSchema;
      return '{"content":"# Knowledge"}';
    });

    await cli.completeJSON({ prompt: "generate", schema });

    expect(observedSchema).toEqual(schema);
  });

  test("completeJSON() does not duplicate Codex native schema inside the prompt", async () => {
    let observedPrompt = "";
    const cli = makeCliClient("codex", "", testAccountingDataDir, async (_id, input) => {
      observedPrompt = input.prompt;
      return '{"content":"# Knowledge"}';
    });

    await cli.completeJSON({
      prompt: "generate",
      schema: {
        type: "object",
        properties: { content: { type: "string" } },
        required: ["content"],
      },
    });

    expect(observedPrompt).toBe("generate");
  });

  test("completeJSON() forwards its output budget to the provider boundary", async () => {
    let observedMaxTokens: number | undefined;
    const cli = makeCliClient("codex", "", testAccountingDataDir, async (_id, input) => {
      observedMaxTokens = (input as { maxTokens?: number }).maxTokens;
      return '{"content":"# Knowledge"}';
    });

    await cli.completeJSON({
      prompt: "generate",
      schema: { type: "object" },
      maxTokens: 4096,
    });

    expect(observedMaxTokens).toBe(4096);
  });

  test("completeJSON() throws a clear error on unparseable output", async () => {
    const cli = makeCliClient("codex", "", testAccountingDataDir, async () => "not json at all");
    await expect(
      cli.completeJSON({ prompt: "x", schema: { type: "object" } }),
    ).rejects.toThrow(/did not return parseable JSON/);
  });

  test("completeJSON() distinguishes invalid JSON from domain schema validation", async () => {
    const invalidJson = makeCliClient(
      "codex",
      "",
      testAccountingDataDir,
      async () => "not json",
    );
    const invalidDomain = makeCliClient(
      "codex",
      "",
      testAccountingDataDir,
      async () => '{"content":""}',
    );

    const parseFailure = await invalidJson.completeJSON({
      prompt: "generate",
      schema: { type: "object" },
    }).catch((error: unknown) => error);
    const validationFailure = await invalidDomain.completeJSON({
      prompt: "generate",
      schema: { type: "object" },
      validate: () => {
        throw new Error("generated page has empty content");
      },
    }).catch((error: unknown) => error);

    expect(parseFailure).toBeInstanceOf(CliCompletionError);
    expect((parseFailure as CliCompletionError).kind).toBe("invalid_json");
    expect(validationFailure).toBeInstanceOf(CliCompletionError);
    expect((validationFailure as CliCompletionError).kind).toBe("schema_validation");
  });

  test("uses the constructor model and ignores per-call opts.model", async () => {
    // ask/dream pass network-tier model names (e.g. claude-sonnet-5, modelFast)
    // that a local CLI would reject; the client must pin the model chosen by the
    // engine at construction time.
    let usedModel: string | undefined;
    const cli = makeCliClient(
      "trae-cli",
      "openrouter-3o",
      testAccountingDataDir,
      async (_id, input) => {
        usedModel = input.model;
        return "ok";
      },
    );
    await cli.complete({ prompt: "a" });
    expect(usedModel).toBe("openrouter-3o");
    await cli.complete({ prompt: "a", model: "claude-sonnet-5" });
    expect(usedModel).toBe("openrouter-3o"); // per-call model ignored
  });

  test("empty constructor model => CLI's own default (undefined passed through)", async () => {
    let usedModel: string | undefined = "sentinel";
    const cli = makeCliClient("trae-cli", "", testAccountingDataDir, async (_id, input) => {
      usedModel = input.model;
      return "ok";
    });
    await cli.complete({ prompt: "a", model: "claude-sonnet-5" });
    expect(usedModel).toBeUndefined();
  });
});
