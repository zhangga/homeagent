import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FeishuGroupBindingStore } from "./feishu-bindings.ts";

let dir: string;
const input = () => ({ chatId: "oc_epoch", spaceId: "team/oc_epoch" as const, boundAppId: "cli_test",
  responseMode: "mentions_only" as const, replyInThread: true });
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ha-binding-epoch-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("a policy patch cannot inject connection ownership or caller-selected epochs", () => {
  const store = new FeishuGroupBindingStore(dir);
  const first = store.connect(input());
  const patch = { responseMode: "all_messages" as const, state: "disconnected", boundAppId: "cli_injected", executionScopeEpoch: first.executionScopeEpoch };
  const changed = store.updatePolicy(first.spaceId, patch)!;
  expect(changed.state).toBe("active");
  expect(changed.boundAppId).toBe(first.boundAppId);
  expect(changed.executionScopeEpoch).not.toBe(first.executionScopeEpoch);
});

test("Feishu epochs rotate for policy and connection changes, never for health observations", () => {
  const store = new FeishuGroupBindingStore(dir);
  const first = store.connect(input());
  expect(first.executionScopeEpoch).toMatch(/^[0-9a-f-]{36}$/);
  store.recordTest(first.spaceId, { status: "succeeded", at: 10 });
  expect(store.connect(input()).executionScopeEpoch).toBe(first.executionScopeEpoch);
  expect(new FeishuGroupBindingStore(dir).getByChatId(first.chatId)!.executionScopeEpoch).toBe(first.executionScopeEpoch);
  store.updatePolicy(first.spaceId, { responseMode: "all_messages" });
  const reverted = store.updatePolicy(first.spaceId, { responseMode: "mentions_only" })!;
  expect(reverted.executionScopeEpoch).not.toBe(first.executionScopeEpoch);
  store.disconnect(first.spaceId);
  expect(store.connect(input()).executionScopeEpoch).not.toBe(reverted.executionScopeEpoch);
  const connected = store.getByChatId(first.chatId)!;
  store.markAppNeedsReconnect("cli_test");
  expect(store.connect(input()).executionScopeEpoch).not.toBe(connected.executionScopeEpoch);
  store.removeByChatId(first.chatId);
  expect(store.connect(input()).executionScopeEpoch).not.toBe(first.executionScopeEpoch);
});

test("failed Feishu binding replacement cannot advance the policy or epoch", () => {
  const store = new FeishuGroupBindingStore(dir);
  const before = store.connect(input());
  const path = join(dir, "config", "feishu-group-bindings.json");
  renameSync(path, `${path}.saved`);
  mkdirSync(path);
  try {
    expect(() => store.updatePolicy(before.spaceId, { responseMode: "all_messages" })).toThrow();
    expect(store.getByChatId(before.chatId)).toEqual(before);
  } finally { rmSync(path, { recursive: true }); renameSync(`${path}.saved`, path); }
  expect(new FeishuGroupBindingStore(dir).getByChatId(before.chatId)).toEqual(before);
});

test("v2 binding migration creates stable local epochs and refuses injected v3 epochs", () => {
  const path = join(dir, "config", "feishu-group-bindings.json");
  mkdirSync(join(dir, "config"), { recursive: true });
  writeFileSync(path, JSON.stringify({ version: 2, bindings: [{ ...input(), state: "active", createdAt: 1, updatedAt: 1 }] }));
  const store = new FeishuGroupBindingStore(dir);
  const epoch = store.getByChatId(input().chatId)!.executionScopeEpoch;
  expect(epoch).toMatch(/^[0-9a-f-]{36}$/);
  expect(new FeishuGroupBindingStore(dir).getByChatId(input().chatId)!.executionScopeEpoch).toBe(epoch);
  const persisted = JSON.parse(readFileSync(path, "utf8"));
  expect(persisted.version).toBe(3);
  persisted.bindings[0].executionScopeEpoch = "not-a-uuid";
  writeFileSync(path, JSON.stringify(persisted));
  expect(() => new FeishuGroupBindingStore(dir)).toThrow("Invalid Feishu group binding");
});
