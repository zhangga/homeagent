import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderPreparationError } from "@homeagent/llm";
import { createLiveCodexFixture, hasVerifiedFileWrite, liveCodexFailure, removeLiveCodexFixture, requireLiveCodexConsent, runLiveCodexAcceptance } from "./codex-dual-mode-live.ts";
import type { ProviderExecutionEvidence } from "@homeagent/llm";

test("live acceptance requires both opt-ins before touching credentials or providers", async () => {
  for (const env of [{}, { HOMEAGENT_LIVE: "0" }, { HOMEAGENT_LIVE: "1" }]) {
    expect(() => requireLiveCodexConsent(env, [])).toThrow();
    if (env.HOMEAGENT_LIVE !== "1") expect(() => requireLiveCodexConsent(env, ["--confirm-local-full-access"])).toThrow();
  }
  expect(() => requireLiveCodexConsent({ HOMEAGENT_LIVE: "1" }, ["--confirm-local-full-access"])).not.toThrow();
  expect(() => requireLiveCodexConsent({ HOMEAGENT_LIVE: "1" }, ["--confirm-local-full-access", "extra"])).toThrow();
  await expect(runLiveCodexAcceptance({}, [])).rejects.toThrow("HOMEAGENT_LIVE=1");
});

test("live evidence exposes only fixed diagnostics, never raw provider errors", () => {
  expect(liveCodexFailure(new Error("private-token-and-provider-output"))).toEqual({ stage: "live-acceptance", reason: "check-failed" });
  expect(liveCodexFailure(new ProviderPreparationError({ stage: "native-session", reason: "protected-root-readable", exitCode: 75 })))
    .toEqual({ stage: "native-session", reason: "protected-root-readable", exitCode: 75 });
});

test("live fixture cleanup checks its exact parent before deleting", () => {
  const parent = realpathSync(tmpdir());
  const root = realpathSync(mkdtempSync(join(parent, ".codex-live-test-")));
  try {
    expect(() => removeLiveCodexFixture(root, join(parent, "wrong"))).toThrow();
    expect(existsSync(root)).toBe(true);
  } finally { removeLiveCodexFixture(root, parent); }
  expect(existsSync(root)).toBe(false);
});

test("live Codex state is never placed in system Temp where CLI helper creation is refused", () => {
  expect(() => createLiveCodexFixture(realpathSync(tmpdir()))).toThrow("Temp");
  const fixture = createLiveCodexFixture();
  try { expect(existsSync(fixture.root)).toBe(true); }
  finally { removeLiveCodexFixture(fixture.root, fixture.parent); }
});

test("live write validation recognizes actual file editing tools and successful commands, not unknown activity", () => {
  const evidence: ProviderExecutionEvidence = { source: "codex-jsonl", events: [], truncated: false,
    execution: { executionMode: "local-full-access", sandboxCheck: "not-applicable", effectiveSandbox: "danger-full-access", process: "started", model: "verified" } };
  expect(hasVerifiedFileWrite(evidence)).toBe(false);
  for (const event of [{ kind: "file-change", status: "completed" }, { kind: "command", status: "completed", exitCode: 0 }] as const) {
    expect(hasVerifiedFileWrite({ ...evidence, events: [event] })).toBe(true);
  }
  for (const event of [{ kind: "file-change", status: "failed" }, { kind: "command", status: "completed" },
    { kind: "command", status: "completed", exitCode: 1 }, { kind: "web-search", status: "completed" }] as const) {
    expect(hasVerifiedFileWrite({ ...evidence, events: [event] })).toBe(false);
  }
  expect(hasVerifiedFileWrite({ ...evidence, truncated: true, events: [{ kind: "file-change", status: "completed" }] })).toBe(false);
});
