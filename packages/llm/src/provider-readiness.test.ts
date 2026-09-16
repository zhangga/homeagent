import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { codexPreparationIdentity } from "./providers.ts";

test("the readiness identity changes with the CLI or local credential metadata without exposing either", () => {
  const root = mkdtempSync(join(tmpdir(), "ha-ready-identity-"));
  const previousBin = process.env.HOMEAGENT_CODEX_BIN;
  const previousHome = process.env.HOMEAGENT_CODEX_HOME;
  try {
    const bin = join(root, "fixture.exe");
    const home = join(root, "codex"); mkdirSync(home);
    process.env.HOMEAGENT_CODEX_BIN = bin; process.env.HOMEAGENT_CODEX_HOME = home;
    writeFileSync(bin, "fake version one");
    const first = codexPreparationIdentity();
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).not.toContain(root);
    writeFileSync(bin, "fake version two, different size");
    const second = codexPreparationIdentity(); expect(second).not.toBe(first);
    writeFileSync(join(home, "auth.json"), "private-test-token");
    expect(codexPreparationIdentity()).not.toBe(second);
  } finally {
    if (previousBin === undefined) delete process.env.HOMEAGENT_CODEX_BIN; else process.env.HOMEAGENT_CODEX_BIN = previousBin;
    if (previousHome === undefined) delete process.env.HOMEAGENT_CODEX_HOME; else process.env.HOMEAGENT_CODEX_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});
