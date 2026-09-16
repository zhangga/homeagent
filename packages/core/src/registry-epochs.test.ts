import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpaceRegistry } from "./registry.ts";

let dir: string;
let registry: SpaceRegistry;
const space = "team/oc_epoch" as const;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ha-registry-epoch-")); registry = new SpaceRegistry(dir); });
afterEach(() => { registry.closeAll(); rmSync(dir, { recursive: true, force: true }); });

test("current registry rejects malformed metadata, unknown fields and a redirected config directory", () => {
  registry.ensure(space);
  const path = join(dir, "config", "spaces.json");
  const original = readFileSync(path, "utf8");
  for (const patch of [{ agentBindingEpoch: "bad" }, { privateGrant: "must-not-travel" }, { name: "x".repeat(1_001) }]) {
    const invalid = JSON.parse(original); Object.assign(invalid.spaces[space], patch);
    writeFileSync(path, JSON.stringify(invalid));
    expect(() => new SpaceRegistry(dir)).toThrow();
  }
  writeFileSync(path, original);
  const configDir = join(dir, "config");
  const saved = join(dir, "saved-config"); renameSync(configDir, saved);
  symlinkSync(saved, configDir, process.platform === "win32" ? "junction" : "dir");
  try {
    expect(() => registry.updateMeta(space, { agentId: "other" })).toThrow();
    expect(() => new SpaceRegistry(dir)).toThrow();
    expect(readFileSync(join(saved, "spaces.json"), "utf8")).toBe(original);
  } finally { unlinkSync(configDir); renameSync(saved, configDir); }
});

test("binding epochs survive restart but never survive an A-B-A binding cycle or an import", () => {
  registry.ensure(space);
  const initial = registry.get(space)!.agentBindingEpoch;
  expect(initial).toMatch(/^[0-9a-f-]{36}$/);
  const bound = registry.updateMeta(space, { agentId: "agent_a" })!;
  expect(bound.agentBindingEpoch).not.toBe(initial);
  registry.updateMeta(space, { name: "display only", agentId: "agent_a" });
  registry.setLastDream(space, 100);
  registry.setLastMaintenance(space, { finishedAt: 101, scannedPages: 2, issueCount: 0, truncated: false });
  expect(new SpaceRegistry(dir).get(space)!.agentBindingEpoch).toBe(bound.agentBindingEpoch);
  registry.updateMeta(space, { agentId: "agent_b" });
  expect(registry.updateMeta(space, { agentId: "agent_a" })!.agentBindingEpoch).not.toBe(bound.agentBindingEpoch);
  registry.clearAgentBindings("agent_a");
  expect(registry.updateMeta(space, { agentId: "agent_a" })!.agentBindingEpoch).not.toBe(bound.agentBindingEpoch);
  expect(registry.restoreMeta(bound).agentBindingEpoch).not.toBe(bound.agentBindingEpoch);
  registry.remove(space);
  registry.ensure(space);
  expect(registry.get(space)!.agentBindingEpoch).not.toBe(initial);
});

test("failed policy persistence changes neither the binding nor its epoch and getters are detached", () => {
  registry.ensure(space);
  registry.updateMeta(space, { agentId: "agent_a" });
  const before = structuredClone(registry.get(space)!);
  const exposed = registry.get(space)!;
  exposed.agentId = "agent_injected";
  registry.list()[0]!.agentBindingEpoch = "injected";
  expect(registry.get(space)).toEqual(before);
  const path = join(dir, "config", "spaces.json");
  renameSync(path, `${path}.saved`);
  mkdirSync(path);
  try {
    expect(() => registry.updateMeta(space, { agentId: "agent_b", replyInThread: false })).toThrow();
    expect(registry.get(space)).toEqual(before);
  } finally { rmSync(path, { recursive: true }); renameSync(`${path}.saved`, path); }
  expect(new SpaceRegistry(dir).get(space)).toEqual(before);
});

test("legacy registry migration generates stable epochs and refuses unknown future versions", () => {
  const path = join(dir, "config", "spaces.json");
  mkdirSync(join(dir, "config"), { recursive: true });
  writeFileSync(path, JSON.stringify({ spaces: { [space]: { id: space, createdAt: 1, agentId: "agent_a" } } }));
  const migrated = new SpaceRegistry(dir);
  expect(migrated.get(space)!.agentBindingEpoch).toMatch(/^[0-9a-f-]{36}$/);
  expect(new SpaceRegistry(dir).get(space)).toEqual(migrated.get(space));
  const persisted = JSON.parse(readFileSync(path, "utf8"));
  expect(persisted.version).toBe(1);
  writeFileSync(path, JSON.stringify({ ...persisted, version: 2 }));
  expect(() => new SpaceRegistry(dir)).toThrow("Unsupported Space registry");
  expect(JSON.parse(readFileSync(path, "utf8")).version).toBe(2);
});
