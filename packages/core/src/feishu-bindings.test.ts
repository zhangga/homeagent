import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FeishuGroupBindingStore } from "./feishu-bindings.ts";
import { KnowledgeEngine } from "./engine.ts";

let dataDir: string | undefined;

afterEach(() => {
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  dataDir = undefined;
});

describe("FeishuGroupBindingStore", () => {
  test("creates an empty version 1 registry", () => {
    dataDir = mkdtempSync(join(tmpdir(), "homeagent-feishu-bindings-"));

    const store = new FeishuGroupBindingStore(dataDir);

    expect(store.list()).toEqual([]);
    expect(JSON.parse(readFileSync(
      join(dataDir, "config", "feishu-group-bindings.json"),
      "utf8",
    ))).toEqual({ version: 1, bindings: [] });
  });

  test("persists a connected group and restores it after restart", () => {
    dataDir = mkdtempSync(join(tmpdir(), "homeagent-feishu-bindings-"));
    const store = new FeishuGroupBindingStore(dataDir);

    const connected = store.connect({
      chatId: "oc_product",
      spaceId: "team/oc_product",
      boundAppId: "cli_product",
      responseMode: "smart",
      participationLevel: "balanced",
      replyInThread: true,
    });

    expect(new FeishuGroupBindingStore(dataDir).getByChatId("oc_product")).toEqual(connected);
  });

  test("repeating the same connection is idempotent", () => {
    dataDir = mkdtempSync(join(tmpdir(), "homeagent-feishu-bindings-"));
    const store = new FeishuGroupBindingStore(dataDir);
    const input = {
      chatId: "oc_product",
      spaceId: "team/oc_product" as const,
      boundAppId: "cli_product",
      responseMode: "smart" as const,
      participationLevel: "balanced" as const,
      replyInThread: true,
    };
    const first = store.connect(input);
    Bun.sleepSync(2);

    expect(store.connect(input)).toEqual(first);
    expect(store.list()).toHaveLength(1);
  });

  test("enforces unique chat and team-space ownership", () => {
    dataDir = mkdtempSync(join(tmpdir(), "homeagent-feishu-bindings-"));
    const store = new FeishuGroupBindingStore(dataDir);
    store.connect({
      chatId: "oc_product",
      spaceId: "team/oc_product",
      responseMode: "smart",
      replyInThread: true,
    });

    expect(() => store.connect({
      chatId: "oc_other",
      spaceId: "team/oc_product",
      responseMode: "smart",
      replyInThread: true,
    })).toThrow("already bound");
    expect(() => store.connect({
      chatId: "oc_product",
      spaceId: "team/oc_other",
      responseMode: "smart",
      replyInThread: true,
    })).toThrow("already bound");
  });

  test("disconnects idempotently and reactivates with the new app", () => {
    dataDir = mkdtempSync(join(tmpdir(), "homeagent-feishu-bindings-"));
    const store = new FeishuGroupBindingStore(dataDir);
    const connected = store.connect({
      chatId: "oc_product",
      spaceId: "team/oc_product",
      boundAppId: "cli_old",
      responseMode: "smart",
      replyInThread: true,
    });

    const disconnected = store.disconnect("team/oc_product");
    expect(disconnected).toMatchObject({
      state: "disconnected",
      createdAt: connected.createdAt,
    });
    expect(store.disconnect("team/oc_product")).toEqual(disconnected);
    expect(store.activeByChatId("oc_product")).toBeUndefined();

    const reconnected = store.connect({
      chatId: "oc_product",
      spaceId: "team/oc_product",
      boundAppId: "cli_new",
      responseMode: "mentions_only",
      replyInThread: false,
    });
    expect(reconnected).toMatchObject({
      state: "active",
      boundAppId: "cli_new",
      createdAt: connected.createdAt,
    });
  });

  test("marks only active bindings for the replaced app as needing reconnect", () => {
    dataDir = mkdtempSync(join(tmpdir(), "homeagent-feishu-bindings-"));
    const store = new FeishuGroupBindingStore(dataDir);
    for (const [chatId, appId] of [
      ["oc_product", "cli_old"],
      ["oc_sales", "cli_other"],
      ["oc_archived", "cli_old"],
    ] as const) {
      store.connect({
        chatId,
        spaceId: `team/${chatId}`,
        boundAppId: appId,
        responseMode: "smart",
        replyInThread: true,
      });
    }
    store.disconnect("team/oc_archived");

    expect(store.markAppNeedsReconnect("cli_old")).toBe(1);
    expect(store.getByChatId("oc_product")?.state).toBe("needs_reconnect");
    expect(store.getByChatId("oc_sales")?.state).toBe("active");
    expect(store.getByChatId("oc_archived")?.state).toBe("disconnected");
  });

  test("marks active bindings owned by any other or unknown app", () => {
    dataDir = mkdtempSync(join(tmpdir(), "homeagent-feishu-bindings-"));
    const store = new FeishuGroupBindingStore(dataDir);
    for (const [chatId, boundAppId] of [
      ["oc_current", "cli_current"],
      ["oc_old", "cli_old"],
      ["oc_unknown", undefined],
    ] as const) {
      store.connect({
        chatId,
        spaceId: `team/${chatId}`,
        boundAppId,
        responseMode: "mentions_only",
        replyInThread: true,
      });
    }

    expect(store.markMismatchedAppNeedsReconnect("cli_current")).toBe(2);
    expect(store.getByChatId("oc_current")?.state).toBe("active");
    expect(store.getByChatId("oc_old")?.state).toBe("needs_reconnect");
    expect(store.getByChatId("oc_unknown")?.state).toBe("needs_reconnect");
  });

  test("updates response policy without changing binding identity", () => {
    dataDir = mkdtempSync(join(tmpdir(), "homeagent-feishu-bindings-"));
    const store = new FeishuGroupBindingStore(dataDir);
    const connected = store.connect({
      chatId: "oc_product",
      spaceId: "team/oc_product",
      boundAppId: "cli_product",
      responseMode: "smart",
      participationLevel: "balanced",
      replyInThread: true,
    });

    expect(store.updatePolicy("team/oc_product", {
      responseMode: "mentions_only",
      participationLevel: undefined,
      replyInThread: false,
    })).toMatchObject({
      chatId: connected.chatId,
      spaceId: connected.spaceId,
      boundAppId: connected.boundAppId,
      createdAt: connected.createdAt,
      responseMode: "mentions_only",
      participationLevel: undefined,
      replyInThread: false,
    });
  });

  test("persists bounded connection-test status", () => {
    dataDir = mkdtempSync(join(tmpdir(), "homeagent-feishu-bindings-"));
    const store = new FeishuGroupBindingStore(dataDir);
    store.connect({
      chatId: "oc_product",
      spaceId: "team/oc_product",
      responseMode: "smart",
      replyInThread: true,
    });

    store.recordTest("team/oc_product", {
      status: "failed",
      at: 1_785_000_000_000,
      error: `  unavailable\r\n${"x".repeat(1_000)}  `,
    });
    const failed = new FeishuGroupBindingStore(dataDir)
      .getBySpace("team/oc_product");
    expect(failed?.lastTestStatus).toBe("failed");
    expect(failed?.lastTestAt).toBe(1_785_000_000_000);
    expect(failed?.lastError).not.toContain("\n");
    expect(failed?.lastError?.length).toBeLessThanOrEqual(500);

    store.recordTest("team/oc_product", {
      status: "succeeded",
      at: 1_785_000_001_000,
    });
    expect(store.getBySpace("team/oc_product")).toMatchObject({
      lastTestStatus: "succeeded",
      lastTestAt: 1_785_000_001_000,
      lastError: undefined,
    });
  });

  test("rejects unsupported, duplicate, and non-team binding records", () => {
    dataDir = mkdtempSync(join(tmpdir(), "homeagent-feishu-bindings-"));
    const path = join(dataDir, "config", "feishu-group-bindings.json");
    mkdirSync(join(dataDir, "config"), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 2, bindings: [] }));
    expect(() => new FeishuGroupBindingStore(dataDir!)).toThrow("Unsupported");

    const valid = {
      chatId: "oc_product",
      spaceId: "team/oc_product",
      state: "active",
      responseMode: "smart",
      participationLevel: "balanced",
      replyInThread: true,
      createdAt: 1,
      updatedAt: 1,
    };
    writeFileSync(path, JSON.stringify({
      version: 1,
      bindings: [valid, { ...valid, chatId: "oc_other" }],
    }));
    expect(() => new FeishuGroupBindingStore(dataDir!)).toThrow("Duplicate");

    writeFileSync(path, JSON.stringify({
      version: 1,
      bindings: [{ ...valid, spaceId: "personal/ou_user" }],
    }));
    expect(() => new FeishuGroupBindingStore(dataDir!)).toThrow("Invalid");
  });

  test("migrates legacy team policies to explicit bindings", () => {
    dataDir = mkdtempSync(join(tmpdir(), "homeagent-feishu-bindings-"));
    const store = new FeishuGroupBindingStore(dataDir);

    expect(store.migrateLegacy([
      {
        id: "team/oc_all",
        chatId: "oc_all",
        createdAt: 10,
        mentionsOnly: false,
        replyInThread: false,
      },
      {
        id: "team/oc_reserved",
        chatId: "oc_reserved",
        createdAt: 20,
        participationLevel: "reserved",
      },
      {
        id: "team/oc_default",
        chatId: "oc_default",
        createdAt: 30,
      },
      {
        id: "personal/ou_user",
        createdAt: 40,
      },
    ], "cli_current")).toBe(3);

    expect(store.list()).toEqual([
      expect.objectContaining({
        chatId: "oc_all",
        boundAppId: "cli_current",
        state: "active",
        responseMode: "all_messages",
        participationLevel: undefined,
        replyInThread: false,
      }),
      expect.objectContaining({
        chatId: "oc_default",
        boundAppId: "cli_current",
        state: "active",
        responseMode: "smart",
        participationLevel: "balanced",
        replyInThread: true,
      }),
      expect.objectContaining({
        chatId: "oc_reserved",
        boundAppId: "cli_current",
        state: "active",
        responseMode: "smart",
        participationLevel: "reserved",
        replyInThread: true,
      }),
    ]);
  });

  test("migration without a verified app needs reconnect and never overwrites edits", () => {
    dataDir = mkdtempSync(join(tmpdir(), "homeagent-feishu-bindings-"));
    const store = new FeishuGroupBindingStore(dataDir);
    const legacy = [{
      id: "team/oc_product" as const,
      chatId: "oc_product",
      createdAt: 10,
    }];

    expect(store.migrateLegacy(legacy)).toBe(1);
    expect(store.getByChatId("oc_product")).toMatchObject({
      boundAppId: undefined,
      state: "needs_reconnect",
    });
    store.updatePolicy("team/oc_product", {
      responseMode: "mentions_only",
      participationLevel: undefined,
      replyInThread: false,
    });

    expect(store.migrateLegacy(legacy, "cli_later")).toBe(0);
    expect(store.list()).toEqual([
      expect.objectContaining({
        boundAppId: undefined,
        state: "needs_reconnect",
        responseMode: "mentions_only",
        replyInThread: false,
      }),
    ]);
  });

  test("is owned by the knowledge engine data directory", () => {
    dataDir = mkdtempSync(join(tmpdir(), "homeagent-feishu-bindings-"));
    const engine = new KnowledgeEngine({ dataDir });
    try {
      engine.feishuBindings.connect({
        chatId: "oc_product",
        spaceId: "team/oc_product",
        responseMode: "smart",
        replyInThread: true,
      });
      expect(new FeishuGroupBindingStore(dataDir).list()).toHaveLength(1);
    } finally {
      engine.close();
    }
  });
});
