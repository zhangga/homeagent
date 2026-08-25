import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeEngine } from "@homeagent/core";
import {
  isUsableManagedExecutable,
  prepareFeishuStartup,
  selectAppCommand,
} from "./main.ts";

const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("compiled app command dispatch", () => {
  test("double-click defaults to desktop while source start defaults to serve", () => {
    expect(selectAppCommand([], true)).toBe("desktop");
    expect(selectAppCommand([], false)).toBe("serve");
  });

  test("supports stable compiled subcommands", () => {
    expect(selectAppCommand(["serve"], true)).toBe("serve");
    expect(selectAppCommand(["desktop"], true)).toBe("desktop");
    expect(selectAppCommand(["service", "status"], true)).toBe("service");
    expect(selectAppCommand(["doctor", "--json"], true)).toBe("doctor");
    expect(selectAppCommand(["mcp"], true)).toBe("mcp");
    expect(selectAppCommand(["knowledge", "list_spaces"], true)).toBe("knowledge");
    expect(selectAppCommand(["feedback", "--space", "team/oc_x"], true)).toBe("feedback");
    expect(selectAppCommand(["wat"], true)).toBe("unknown");
  });

  test("treats empty or non-executable managed provider files as damaged", () => {
    const dir = mkdtempSync(join(tmpdir(), "homeagent-managed-bin-"));
    temporary.push(dir);
    const binary = join(dir, "codex");
    writeFileSync(binary, "");
    chmodSync(binary, 0o755);
    expect(isUsableManagedExecutable(binary)).toBeFalse();
    writeFileSync(binary, "binary");
    chmodSync(binary, 0o644);
    expect(isUsableManagedExecutable(binary)).toBe(process.platform === "win32");
    chmodSync(binary, 0o755);
    expect(isUsableManagedExecutable(binary)).toBeTrue();
  });

  test("prepares legacy bindings before deciding whether consumers may start", async () => {
    const dir = mkdtempSync(join(tmpdir(), "homeagent-feishu-startup-"));
    temporary.push(dir);
    const engine = new KnowledgeEngine({ dataDir: dir });
    engine.ensureSpace("team/oc_product", { chatId: "oc_product" });
    const status = async () => ({
      state: "ready" as const,
      verified: true,
      appId: "cli_current",
      brand: "feishu" as const,
      botName: "HomeAgent",
      botOpenId: "ou_bot",
      message: "ready",
    });

    const enabled = await prepareFeishuStartup(engine, { status });
    expect(enabled).toMatchObject({
      migrated: 1,
      locallyDisabled: false,
      consumersEnabled: true,
    });
    expect(engine.feishuBindings.getByChatId("oc_product")).toMatchObject({
      state: "active",
      boundAppId: "cli_current",
    });

    const disabledDir = mkdtempSync(join(tmpdir(), "homeagent-feishu-disabled-"));
    temporary.push(disabledDir);
    const disabledEngine = new KnowledgeEngine({ dataDir: disabledDir });
    disabledEngine.ensureSpace("team/oc_disabled", { chatId: "oc_disabled" });
    const disabled = await prepareFeishuStartup(
      disabledEngine,
      { status },
      "cli_current",
    );
    expect(disabled).toMatchObject({
      migrated: 1,
      locallyDisabled: true,
      consumersEnabled: false,
    });
    expect(disabledEngine.feishuBindings.getByChatId("oc_disabled")?.state)
      .toBe("needs_reconnect");

    const replacedDir = mkdtempSync(join(tmpdir(), "homeagent-feishu-replaced-"));
    temporary.push(replacedDir);
    const replacedEngine = new KnowledgeEngine({ dataDir: replacedDir });
    for (const [chatId, boundAppId] of [
      ["oc_old", "cli_old"],
      ["oc_unknown", undefined],
    ] as const) {
      replacedEngine.feishuBindings.connect({
        chatId,
        spaceId: `team/${chatId}`,
        boundAppId,
        responseMode: "mentions_only",
        replyInThread: true,
      });
    }
    const replaced = await prepareFeishuStartup(replacedEngine, { status });
    expect(replaced.consumersEnabled).toBeTrue();
    expect(replacedEngine.feishuBindings.getByChatId("oc_old")?.state)
      .toBe("needs_reconnect");
    expect(replacedEngine.feishuBindings.getByChatId("oc_unknown")?.state)
      .toBe("needs_reconnect");

    engine.close();
    disabledEngine.close();
    replacedEngine.close();
  });

  test("removes the historical oc_demo binding without touching real groups", async () => {
    const dir = mkdtempSync(join(tmpdir(), "homeagent-feishu-demo-cleanup-"));
    temporary.push(dir);
    const engine = new KnowledgeEngine({ dataDir: dir });
    engine.ensureSpace("team/oc_demo", { chatId: "oc_demo" });
    engine.feishuBindings.connect({
      chatId: "oc_demo",
      spaceId: "team/oc_demo",
      boundAppId: "cli_current",
      responseMode: "smart",
      participationLevel: "balanced",
      replyInThread: true,
    });
    engine.feishuBindings.connect({
      chatId: "oc_real",
      spaceId: "team/oc_real",
      boundAppId: "cli_current",
      responseMode: "mentions_only",
      replyInThread: false,
    });

    await prepareFeishuStartup(engine, {
      status: async () => ({
        state: "ready" as const,
        verified: true,
        appId: "cli_current",
        brand: "feishu" as const,
        botName: "HomeAgent",
        botOpenId: "ou_bot",
        message: "ready",
      }),
    });

    const demoBinding = engine.feishuBindings.getByChatId("oc_demo");
    const realBinding = engine.feishuBindings.getByChatId("oc_real");
    engine.close();

    expect(demoBinding).toBeUndefined();
    expect(realBinding).toMatchObject({
      state: "active",
      responseMode: "mentions_only",
    });

    const restored = new KnowledgeEngine({ dataDir: dir });
    expect(restored.feishuBindings.getByChatId("oc_demo")).toBeUndefined();
    expect(restored.feishuBindings.getByChatId("oc_real")?.state).toBe("active");
    restored.close();
  });
});
