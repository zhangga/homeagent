import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("bun test preload ignores inherited data directories and cleans its own directory", async () => {
  const inheritedCanonical = join(tmpdir(), "homeagent-inherited-canonical-data");
  const inheritedLegacy = join(tmpdir(), "homeagent-inherited-legacy-data");
  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      [
        'const { existsSync } = await import("node:fs");',
        'await import("./scripts/test-preload.ts");',
        "process.stdout.write(JSON.stringify({",
        "  canonical: process.env.HOMEAGENT_DATA_DIR,",
        "  legacy: process.env.HOMEBRAIN_DATA_DIR,",
        "  existsDuringProcess: existsSync(process.env.HOMEAGENT_DATA_DIR),",
        "}));",
      ].join("\n"),
    ],
    {
      cwd: join(import.meta.dir, ".."),
      env: {
        ...process.env,
        HOMEAGENT_DATA_DIR: inheritedCanonical,
        HOMEBRAIN_DATA_DIR: inheritedLegacy,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  expect(exitCode).toBe(0);
  expect(stderr).toBe("");
  const observed = JSON.parse(stdout) as {
    canonical: string;
    legacy: string;
    existsDuringProcess: boolean;
  };
  expect(observed.canonical).not.toBe(inheritedCanonical);
  expect(observed.canonical).not.toBe(inheritedLegacy);
  expect(observed.canonical).toContain("homeagent-bun-test-");
  expect(observed.legacy).toBe(observed.canonical);
  expect(observed.existsDuringProcess).toBe(true);
  expect(existsSync(observed.canonical)).toBe(false);
});
