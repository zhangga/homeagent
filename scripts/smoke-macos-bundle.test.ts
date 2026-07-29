import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectMacOSBundle } from "./smoke-macos-bundle.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("macOS bundle smoke preflight", () => {
  test("requires executable, runtime, brand icon, and avatar resources", () => {
    const root = mkdtempSync(join(tmpdir(), "hb-bundle-"));
    dirs.push(root);
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
    ]) writeFileSync(join(app, file), file);
    writeFileSync(
      join(app, "Contents/Info.plist"),
      "<plist><dict><key>CFBundleIconFile</key><string>HomeAgent</string></dict></plist>",
    );

    expect(inspectMacOSBundle(app).files).toHaveLength(8);

    const icon = join(app, "Contents/Resources/HomeAgent.icns");
    rmSync(icon);
    expect(() => inspectMacOSBundle(app)).toThrow(
      "missing Contents/Resources/HomeAgent.icns",
    );
    writeFileSync(icon, "icon");

    const avatar = join(
      app,
      "Contents/Resources/brand/homeagent-feishu-avatar-512.png",
    );
    rmSync(avatar);
    expect(() => inspectMacOSBundle(app)).toThrow(
      "missing Contents/Resources/brand/homeagent-feishu-avatar-512.png",
    );
    writeFileSync(avatar, "avatar");

    writeFileSync(join(app, "Contents/Info.plist"), "<plist><dict></dict></plist>");
    expect(() => inspectMacOSBundle(app)).toThrow(
      "Info.plist does not reference HomeAgent.icns",
    );
  });
});
