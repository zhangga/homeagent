import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createMacOSBuildPlan } from "./build-macos-app.ts";

describe("macOS app build plan", () => {
  test("contains the immutable runtime layout", () => {
    const root = resolve("repo-fixture");
    const plan = createMacOSBuildPlan({ repoRoot: root, target: "arm64" });
    expect(plan.appPath).toBe(join(root, "dist", "HomeAgent.app"));
    expect(plan.outputs).toEqual([
      "HomeAgent.app/Contents/Info.plist",
      "HomeAgent.app/Contents/MacOS/homeagent",
      "HomeAgent.app/Contents/Resources/app/homeagent.js",
      "HomeAgent.app/Contents/Resources/bin/bun",
      "HomeAgent.app/Contents/Resources/bin/lark-cli",
      "HomeAgent.app/Contents/Resources/bin/attachment-extract",
      "HomeAgent.app/Contents/Resources/HomeAgent.icns",
      "HomeAgent.app/Contents/Resources/brand/homeagent-feishu-avatar-512.png",
      "HomeAgent.app/Contents/Resources/LICENSE",
      "HomeAgent.app/Contents/Resources/THIRD_PARTY_NOTICES.md",
    ]);
    expect(plan.larkAsset).toBe("lark-cli-1.0.69-darwin-arm64.tar.gz");
  });

  test("maps Intel builds to upstream amd64 artifacts", () => {
    const plan = createMacOSBuildPlan({
      repoRoot: resolve("repo-fixture"),
      target: "x64",
    });
    expect(plan.bunTarget).toBe("bun-darwin-x64");
    expect(plan.larkAsset).toContain("darwin-amd64");
  });

  test("declares the HomeAgent icon in the plist template", () => {
    const plist = readFileSync(
      join(import.meta.dir, "..", "assets", "macos", "Info.plist.template"),
      "utf8",
    );
    expect(plist).toMatch(
      /<key>CFBundleIconFile<\/key>\s*<string>HomeAgent<\/string>/,
    );
  });
});
