import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetConfig } from "@homeagent/shared";
import { localDay, spentToday } from "./budget.ts";
import { complete, completeJSON } from "./gateway.ts";

test("gateway exposes reported tokens with explicitly estimated cost", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ha-gateway-usage-"));
  const previousFetch = globalThis.fetch;
  const previous = {
    dataDir: process.env.HOMEAGENT_DATA_DIR,
    budget: process.env.HOMEAGENT_DAILY_BUDGET_USD,
    baseUrl: process.env.ANTHROPIC_BASE_URL,
    token: process.env.ANTHROPIC_AUTH_TOKEN,
  };
  try {
    process.env.HOMEAGENT_DATA_DIR = directory;
    process.env.HOMEAGENT_DAILY_BUDGET_USD = "5";
    process.env.ANTHROPIC_BASE_URL = "https://gateway.invalid";
    process.env.ANTHROPIC_AUTH_TOKEN = "test-token";
    resetConfig();
    globalThis.fetch = (async () => new Response(JSON.stringify({
      content: [{ type: "text", text: "answer" }],
      usage: { input_tokens: 100, output_tokens: 20 },
      model: "claude-sonnet-5",
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

    const result = await complete({ prompt: "hello", retries: 0 });

    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      costUsd: result.costUsd,
      costBasis: "estimated",
      source: "gateway",
    });
  } finally {
    globalThis.fetch = previousFetch;
    if (previous.dataDir === undefined) delete process.env.HOMEAGENT_DATA_DIR;
    else process.env.HOMEAGENT_DATA_DIR = previous.dataDir;
    if (previous.budget === undefined) delete process.env.HOMEAGENT_DAILY_BUDGET_USD;
    else process.env.HOMEAGENT_DAILY_BUDGET_USD = previous.budget;
    if (previous.baseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = previous.baseUrl;
    if (previous.token === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
    else process.env.ANTHROPIC_AUTH_TOKEN = previous.token;
    resetConfig();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("gateway accounting persistence failures never override the Provider result", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ha-gateway-accounting-failure-"));
  const previousFetch = globalThis.fetch;
  const previous = {
    dataDir: process.env.HOMEAGENT_DATA_DIR,
    baseUrl: process.env.ANTHROPIC_BASE_URL,
    token: process.env.ANTHROPIC_AUTH_TOKEN,
  };
  try {
    process.env.HOMEAGENT_DATA_DIR = directory;
    process.env.ANTHROPIC_BASE_URL = "https://gateway.invalid";
    process.env.ANTHROPIC_AUTH_TOKEN = "test-token";
    resetConfig();
    mkdirSync(join(directory, "logs", `llm-${localDay()}.jsonl`), { recursive: true });
    globalThis.fetch = (async () => new Response(JSON.stringify({
      content: [{ type: "text", text: "stable answer" }],
      usage: { input_tokens: 100, output_tokens: 20 },
      model: "claude-sonnet-5",
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

    await expect(complete({ prompt: "hello", retries: 0 })).resolves.toMatchObject({
      text: "stable answer",
    });
  } finally {
    globalThis.fetch = previousFetch;
    if (previous.dataDir === undefined) delete process.env.HOMEAGENT_DATA_DIR;
    else process.env.HOMEAGENT_DATA_DIR = previous.dataDir;
    if (previous.baseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = previous.baseUrl;
    if (previous.token === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
    else process.env.ANTHROPIC_AUTH_TOKEN = previous.token;
    resetConfig();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("gateway leaves token and cost fields absent when the response omits usage", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ha-gateway-unknown-usage-"));
  const previousFetch = globalThis.fetch;
  const previous = {
    dataDir: process.env.HOMEAGENT_DATA_DIR,
    budget: process.env.HOMEAGENT_DAILY_BUDGET_USD,
    baseUrl: process.env.ANTHROPIC_BASE_URL,
    token: process.env.ANTHROPIC_AUTH_TOKEN,
  };
  try {
    process.env.HOMEAGENT_DATA_DIR = directory;
    process.env.HOMEAGENT_DAILY_BUDGET_USD = "5";
    process.env.ANTHROPIC_BASE_URL = "https://gateway.invalid";
    process.env.ANTHROPIC_AUTH_TOKEN = "test-token";
    resetConfig();
    globalThis.fetch = (async () => new Response(JSON.stringify({
      content: [{ type: "text", text: "answer" }],
      model: "claude-sonnet-5",
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

    const result = await complete({ prompt: "hello", retries: 0 });

    expect(result.usage).toEqual({ costBasis: "unavailable", source: "gateway" });
    expect(result).not.toHaveProperty("inputTokens");
    expect(result).not.toHaveProperty("outputTokens");
    expect(result).not.toHaveProperty("costUsd");
    expect(spentToday()).toBe(0);
  } finally {
    globalThis.fetch = previousFetch;
    if (previous.dataDir === undefined) delete process.env.HOMEAGENT_DATA_DIR;
    else process.env.HOMEAGENT_DATA_DIR = previous.dataDir;
    if (previous.budget === undefined) delete process.env.HOMEAGENT_DAILY_BUDGET_USD;
    else process.env.HOMEAGENT_DAILY_BUDGET_USD = previous.budget;
    if (previous.baseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = previous.baseUrl;
    if (previous.token === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
    else process.env.ANTHROPIC_AUTH_TOKEN = previous.token;
    resetConfig();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("structured gateway completions expose the same usage provenance", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ha-gateway-json-usage-"));
  const previousFetch = globalThis.fetch;
  const previous = {
    dataDir: process.env.HOMEAGENT_DATA_DIR,
    budget: process.env.HOMEAGENT_DAILY_BUDGET_USD,
    baseUrl: process.env.ANTHROPIC_BASE_URL,
    token: process.env.ANTHROPIC_AUTH_TOKEN,
  };
  try {
    process.env.HOMEAGENT_DATA_DIR = directory;
    process.env.HOMEAGENT_DAILY_BUDGET_USD = "5";
    process.env.ANTHROPIC_BASE_URL = "https://gateway.invalid";
    process.env.ANTHROPIC_AUTH_TOKEN = "test-token";
    resetConfig();
    globalThis.fetch = (async () => new Response(JSON.stringify({
      content: [{ type: "tool_use", input: { intent: "question" } }],
      usage: { input_tokens: 90, output_tokens: 15 },
      model: "claude-sonnet-5",
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

    const { result } = await completeJSON({
      prompt: "classify",
      schema: { type: "object" },
      retries: 0,
    });

    expect(result.usage).toEqual({
      inputTokens: 90,
      outputTokens: 15,
      costUsd: result.costUsd,
      costBasis: "estimated",
      source: "gateway",
    });
  } finally {
    globalThis.fetch = previousFetch;
    if (previous.dataDir === undefined) delete process.env.HOMEAGENT_DATA_DIR;
    else process.env.HOMEAGENT_DATA_DIR = previous.dataDir;
    if (previous.budget === undefined) delete process.env.HOMEAGENT_DAILY_BUDGET_USD;
    else process.env.HOMEAGENT_DAILY_BUDGET_USD = previous.budget;
    if (previous.baseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = previous.baseUrl;
    if (previous.token === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
    else process.env.ANTHROPIC_AUTH_TOKEN = previous.token;
    resetConfig();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("legacy gateway never silently ignores local image inputs", async () => {
  await expect(
    complete({
      prompt: "分析图片",
      images: [{ path: "/tmp/dinner.png" }],
    }),
  ).rejects.toThrow("does not support image inputs");

  await expect(
    completeJSON({
      prompt: "分析图片",
      images: [{ path: "/tmp/dinner.png" }],
      schema: { type: "object" },
    }),
  ).rejects.toThrow("does not support image inputs");
});
