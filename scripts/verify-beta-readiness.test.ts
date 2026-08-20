import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  parseBetaReadinessArgs,
  verifyBetaReadiness,
  type BetaCommandRunner,
} from "./verify-beta-readiness.ts";

const required = [
  "bun.lock",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  ".github/workflows/ci.yml",
  ".github/workflows/release-macos.yml",
  "docs/beta-release-runbook.md",
  "scripts/soak-feishu-e2e.ts",
  "quality/evaluation-cases.json",
  "assets/brand/homeagent-mark.svg",
  "assets/brand/homeagent-glyph.svg",
  "assets/brand/homeagent-feishu-avatar-512.png",
];

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "homeagent-beta-readiness-"));
  roots.push(root);
  for (const file of required) {
    const path = join(root, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file);
  }
  writeFileSync(join(root, "package.json"), JSON.stringify({
    name: "homeagent",
    version: "0.1.0-beta.1",
  }));
  writeFileSync(
    join(root, "docs", "beta-release-runbook.md"),
    [
      "Restore and verify `homeagent.space v14` before release.",
      "Run agent_revision_lifecycle, writable_task_approval, and readonly_task_retry.",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "scripts", "soak-feishu-e2e.ts"),
    [
      "export const AGENT_PLATFORM_SOAK_SCENARIOS = [",
      "  'agent_revision_lifecycle',",
      "  'writable_task_approval',",
      "  'readonly_task_retry',",
      "] as const;",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(root, ".github", "workflows", "release-macos.yml"),
    [
      "steps:",
      "  - run: bun run evaluate:quality",
      "  - run: bun run verify:crash-recovery",
      "  - run: bun run verify:beta -- --checks-only",
      "  draft: true",
      "  prerelease: true",
      "",
    ].join("\n"),
  );
  return root;
}

describe("beta readiness verification", () => {
  test("runs the full local verification sequence on a clean beta tree", async () => {
    const root = repo();
    const calls: string[][] = [];
    const runner: BetaCommandRunner = async (argv) => {
      calls.push(argv);
      return { code: 0, stdout: "", stderr: "" };
    };

    const report = await verifyBetaReadiness({ repoRoot: root, runner });

    expect(calls).toEqual([
      ["git", "status", "--porcelain"],
      ["bun", "run", "verify:brand"],
      ["bun", "test"],
      ["bun", "run", "typecheck"],
      ["bun", "run", "evaluate:quality"],
      ["bun", "run", "verify:crash-recovery"],
    ]);
    expect(report).toEqual({
      scope: "local-preflight",
      version: "0.1.0-beta.1",
      commands: [
        "bun run verify:brand",
        "bun test",
        "bun run typecheck",
        "bun run evaluate:quality",
        "bun run verify:crash-recovery",
      ],
      localChecksPassed: true,
      automatedBrandAssetsVerified: true,
      appSmokeTested: false,
      signingEnvironmentChecked: false,
      manualVisualChecksPending: [
        "macos-finder-dock-dmg",
        "admin-setup-restarting",
        "feishu-circular-avatar-crop",
      ],
      externalGatesPending: [
        "packaged-app-crash-smoke",
        "signed-and-notarized-release-artifacts",
        "fresh-mac-no-terminal-install",
        "real-feishu-24-48h-soak",
      ],
    });
  });

  test("refuses a dirty working tree before running expensive checks", async () => {
    const root = repo();
    const runner: BetaCommandRunner = async () => ({
      code: 0,
      stdout: " M packages/core/src/engine.ts\n",
      stderr: "",
    });

    await expect(verifyBetaReadiness({ repoRoot: root, runner })).rejects.toThrow(
      "working tree must be clean",
    );
  });

  test("requires canonical brand assets as beta release inputs", async () => {
    const root = repo();
    rmSync(join(root, "assets", "brand", "homeagent-mark.svg"));

    await expect(verifyBetaReadiness({
      repoRoot: root,
      allowDirty: true,
      checksOnly: true,
    })).rejects.toThrow(
      "missing beta release input: assets/brand/homeagent-mark.svg",
    );
  });

  test("rejects a release runbook that documents an obsolete Space Archive contract", async () => {
    const root = repo();
    writeFileSync(
      join(root, "docs", "beta-release-runbook.md"),
      "Restore and verify `homeagent.space v7` before release.\n",
    );

    await expect(verifyBetaReadiness({
      repoRoot: root,
      allowDirty: true,
      checksOnly: true,
    })).rejects.toThrow("homeagent.space v14");
  });

  test("requires the Agent platform soak gates in both the driver and release runbook", async () => {
    const root = repo();
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(
      join(root, "scripts", "soak-feishu-e2e.ts"),
      "export const scenarios = ['mention_answer'];\n",
    );

    await expect(verifyBetaReadiness({
      repoRoot: root,
      allowDirty: true,
      checksOnly: true,
    })).rejects.toThrow("agent_revision_lifecycle");
  });

  test("requires tag releases to repeat the quality and crash-recovery gates", async () => {
    const root = repo();
    writeFileSync(
      join(root, ".github", "workflows", "release-macos.yml"),
      "steps:\n  - run: bun test\n  - run: bun run typecheck\n",
    );

    await expect(verifyBetaReadiness({
      repoRoot: root,
      allowDirty: true,
      checksOnly: true,
    })).rejects.toThrow("bun run evaluate:quality");

    writeFileSync(
      join(root, ".github", "workflows", "release-macos.yml"),
      "steps:\n  - run: bun run evaluate:quality\n",
    );
    await expect(verifyBetaReadiness({
      repoRoot: root,
      allowDirty: true,
      checksOnly: true,
    })).rejects.toThrow("bun run verify:crash-recovery");
  });

  test("requires tag releases to execute the actual repository contract preflight", async () => {
    const root = repo();
    writeFileSync(
      join(root, ".github", "workflows", "release-macos.yml"),
      [
        "steps:",
        "  - run: bun run evaluate:quality",
        "  - run: bun run verify:crash-recovery",
        "",
      ].join("\n"),
    );

    await expect(verifyBetaReadiness({
      repoRoot: root,
      allowDirty: true,
      checksOnly: true,
    })).rejects.toThrow("bun run verify:beta -- --checks-only");
  });

  test("keeps tag-built release assets in a draft prerelease until external gates pass", async () => {
    const root = repo();
    writeFileSync(
      join(root, ".github", "workflows", "release-macos.yml"),
      [
        "steps:",
        "  - run: bun run evaluate:quality",
        "  - run: bun run verify:crash-recovery",
        "  - run: bun run verify:beta -- --checks-only",
        "",
      ].join("\n"),
    );

    await expect(verifyBetaReadiness({
      repoRoot: root,
      allowDirty: true,
      checksOnly: true,
    })).rejects.toThrow("draft: true");
  });

  test("does not accept release gate commands that exist only in YAML comments", async () => {
    const root = repo();
    writeFileSync(
      join(root, ".github", "workflows", "release-macos.yml"),
      [
        "steps:",
        "  # - run: bun run evaluate:quality",
        "  # - run: bun run verify:crash-recovery",
        "  # - run: bun run verify:beta -- --checks-only",
        "  draft: true",
        "  prerelease: true",
        "",
      ].join("\n"),
    );

    await expect(verifyBetaReadiness({
      repoRoot: root,
      allowDirty: true,
      checksOnly: true,
    })).rejects.toThrow("bun run evaluate:quality");
  });

  test("preflights packaged icon, plist reference, and avatar in checks-only mode", async () => {
    const root = repo();
    const app = join(root, "HomeAgent.app");
    for (const dir of [
      "Contents/MacOS",
      "Contents/Resources/app",
      "Contents/Resources/bin",
      "Contents/Resources/brand",
    ]) {
      mkdirSync(join(app, dir), { recursive: true });
    }
    for (const file of [
      "Contents/MacOS/homeagent",
      "Contents/Resources/app/homeagent.js",
      "Contents/Resources/bin/bun",
      "Contents/Resources/bin/lark-cli",
      "Contents/Resources/bin/attachment-extract",
      "Contents/Resources/HomeAgent.icns",
      "Contents/Resources/brand/homeagent-feishu-avatar-512.png",
    ]) {
      writeFileSync(join(app, file), file);
    }
    writeFileSync(
      join(app, "Contents/Info.plist"),
      "<plist><dict><key>CFBundleIconFile</key><string>HomeAgent</string></dict></plist>",
    );

    const report = await verifyBetaReadiness({
      repoRoot: root,
      allowDirty: true,
      checksOnly: true,
      appPath: app,
    });
    expect(report.appSmokeTested).toBeFalse();

    rmSync(join(app, "Contents/Resources/HomeAgent.icns"));
    await expect(verifyBetaReadiness({
      repoRoot: root,
      allowDirty: true,
      checksOnly: true,
      appPath: app,
    })).rejects.toThrow("missing Contents/Resources/HomeAgent.icns");
  });

  test("reports missing signing variable names without exposing values", async () => {
    const root = repo();

    await expect(verifyBetaReadiness({
      repoRoot: root,
      allowDirty: true,
      checksOnly: true,
      requireSigningEnvironment: true,
      env: { APPLE_ID: "maintainer@example.com" },
    })).rejects.toThrow("APPLE_CERTIFICATE_BASE64");
  });

  test("rejects unknown, duplicate, and incomplete CLI arguments", () => {
    expect(() => parseBetaReadinessArgs(["--app"])).toThrow("--app requires a path");
    expect(() => parseBetaReadinessArgs(["--require-signing-environment"]))
      .toThrow("unknown argument");
    expect(() => parseBetaReadinessArgs(["--checks-only", "--checks-only"]))
      .toThrow("duplicate argument");
  });
});
