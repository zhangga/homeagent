import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLocalCodexModelSettings, resolveCodexModelSettings } from "./codex-model-settings.ts";

let root: string;
let home: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ha-codex-model-settings-")));
  home = join(root, ".codex");
  mkdirSync(home);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("inherits saved model preferences without importing any other Codex configuration", () => {
  writeFileSync(join(home, "config.toml"), [
    'model = "gpt-next-new-model" # no HomeAgent catalog update required',
    'model_reasoning_effort = "ultra"',
    'sandbox_mode = "danger-full-access"',
    'developer_instructions = "PRIVATE_INSTRUCTIONS"',
    '[mcp_servers.private]',
    'url = "https://private.invalid"',
    '[profiles.legacy]',
    'model = "must-not-inherit-a-nonselected-profile"',
  ].join("\n"));
  const local = readLocalCodexModelSettings({}, root);
  expect(local).toEqual({ model: "gpt-next-new-model", reasoningEffort: "ultra" });
  expect(resolveCodexModelSettings({}, local)).toEqual(local);
});

test("honors console CODEX_HOME independently of the HomeAgent Provider state directory", () => {
  const consoleHome = join(root, "console");
  mkdirSync(consoleHome);
  writeFileSync(join(home, "config.toml"), 'model = "unused-home-model"');
  writeFileSync(join(consoleHome, "config.toml"), 'model = "gpt-5.6"\nmodel_reasoning_effort = "xhigh"');
  expect(readLocalCodexModelSettings({ CODEX_HOME: consoleHome, HOMEAGENT_CODEX_HOME: home }, root))
    .toEqual({ model: "gpt-5.6-sol", reasoningEffort: "xhigh" });
});

test("reads updated preferences on the next resolution and keeps explicit values first", () => {
  const path = join(home, "config.toml");
  writeFileSync(path, 'model = "gpt-6-astra"\nmodel_reasoning_effort = "high"');
  const original = readLocalCodexModelSettings({}, root);
  writeFileSync(path, 'model = "gpt-newer"\nmodel_reasoning_effort = "max"');
  const current = readLocalCodexModelSettings({}, root);
  expect(original).toEqual({ model: "gpt-6-astra", reasoningEffort: "high" });
  expect(resolveCodexModelSettings({}, current)).toEqual({ model: "gpt-newer", reasoningEffort: "max" });
  expect(resolveCodexModelSettings({ model: "gpt-5.6-sol", reasoningEffort: "low" }, current))
    .toEqual({ model: "gpt-5.6-sol", reasoningEffort: "low" });
  expect(resolveCodexModelSettings({ model: "gpt-5.6-sol" }, current))
    .toEqual({ model: "gpt-5.6-sol", reasoningEffort: "max" });
  expect(resolveCodexModelSettings({ reasoningEffort: "xhigh" }, current))
    .toEqual({ model: "gpt-newer", reasoningEffort: "xhigh" });
  expect(resolveCodexModelSettings({ model: "gpt-5.4" }, current).reasoningEffort).toBeUndefined();
});

test("missing, malformed and non-file config preserve the CLI default path", () => {
  expect(readLocalCodexModelSettings({}, root)).toEqual({});
  writeFileSync(join(home, "config.toml"), 'model = "PRIVATE_UNFINISHED');
  expect(readLocalCodexModelSettings({}, root)).toEqual({});
  rmSync(join(home, "config.toml"));
  mkdirSync(join(home, "config.toml"));
  expect(readLocalCodexModelSettings({}, root)).toEqual({});
});

test("current model defaults retain newly supported effort and filter unsupported choices", () => {
  for (const model of ["gpt-6.1-sol", "gpt-6-sol", "gpt-5.6-sol", "gpt-5.6-terra"]) {
    writeFileSync(join(home, "config.toml"), `model = "${model}"\nmodel_reasoning_effort = "ultra"`);
    expect(resolveCodexModelSettings({}, readLocalCodexModelSettings({}, root)))
      .toEqual({ model, reasoningEffort: "ultra" });
    expect(resolveCodexModelSettings({ model }, { reasoningEffort: "none" }).reasoningEffort).toBeUndefined();
  }
  expect(resolveCodexModelSettings({ model: "gpt-6-luna" }, { reasoningEffort: "max" }))
    .toEqual({ model: "gpt-6-luna", reasoningEffort: "max" });
  expect(resolveCodexModelSettings({ model: "gpt-6-luna" }, { reasoningEffort: "ultra" }).reasoningEffort)
    .toBeUndefined();
});

test("bounds config bytes and model identifiers and accepts only supported effort names", () => {
  const path = join(home, "config.toml");
  const prefix = `model = "${"m".repeat(200)}"\nmodel_reasoning_effort = "xhigh"\n#`;
  writeFileSync(path, prefix.padEnd(1024 * 1024, "x"));
  expect(readLocalCodexModelSettings({}, root)).toEqual({ model: "m".repeat(200), reasoningEffort: "xhigh" });
  writeFileSync(path, prefix.padEnd(1024 * 1024 + 1, "x"));
  expect(readLocalCodexModelSettings({}, root)).toEqual({});
  writeFileSync(path, `model = "${"m".repeat(201)}"\nmodel_reasoning_effort = "extreme"`);
  expect(readLocalCodexModelSettings({}, root)).toEqual({});
  writeFileSync(path, 'model = 123\nmodel_reasoning_effort = "high"');
  expect(readLocalCodexModelSettings({}, root)).toEqual({ reasoningEffort: "high" });
});

test("rejects a linked console configuration directory", () => {
  const linked = join(root, "linked");
  writeFileSync(join(home, "config.toml"), 'model = "outside-model"');
  symlinkSync(home, linked, process.platform === "win32" ? "junction" : "dir");
  expect(readLocalCodexModelSettings({ CODEX_HOME: linked }, root)).toEqual({});
});

test.skipIf(process.platform === "win32")("rejects a linked config file", () => {
  const target = join(root, "external.toml");
  writeFileSync(target, 'model = "outside-model"');
  symlinkSync(target, join(home, "config.toml"));
  expect(readLocalCodexModelSettings({}, root)).toEqual({});
});
