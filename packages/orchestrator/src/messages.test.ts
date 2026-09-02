import { expect, test } from "bun:test";
import { ProviderRunError } from "@homeagent/llm";
import {
  MODEL_CAPACITY_NOTICE,
  NO_PROVIDER_NOTICE,
  NO_TOOLS_MODE_NOTICE,
  UNSUPPORTED_IMAGE_NOTICE,
  providerNotice,
} from "./messages.ts";

test("provider notices explain fail-closed no-tools and visual boundaries", () => {
  expect(providerNotice(
    new Error("provider trae-cli cannot provide a no-tools execution mode"),
  )).toBe(NO_TOOLS_MODE_NOTICE);
  expect(NO_TOOLS_MODE_NOTICE).toContain("TRAE 当前只用于显式任务执行");
  expect(NO_TOOLS_MODE_NOTICE).toContain("Claude 或 Codex");
  expect(UNSUPPORTED_IMAGE_NOTICE).not.toContain("切换到 Codex");
});

test("provider notices expose an allowlisted model-capacity reason", () => {
  const error = new ProviderRunError(
    "codex",
    "provider codex returned Selected model is at capacity. Please try a different model.",
    { costBasis: "unavailable", source: "codex-jsonl" },
  );

  expect(providerNotice(error)).toBe(MODEL_CAPACITY_NOTICE);
  expect(MODEL_CAPACITY_NOTICE).toContain("当前模型容量已满");
  expect(MODEL_CAPACITY_NOTICE).toContain(
    "Selected model is at capacity. Please try a different model.",
  );
});

test("provider notices do not expose unclassified diagnostics", () => {
  const diagnostic = "provider failed with token secret-value at /private/path";

  expect(providerNotice(new Error(diagnostic))).toBe(NO_PROVIDER_NOTICE);
  expect(providerNotice(new Error(diagnostic))).not.toContain("secret-value");
});
