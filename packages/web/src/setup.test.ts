import { describe, expect, test } from "bun:test";
import { buildSetupSnapshot } from "./setup.ts";

const provider = {
  id: "codex" as const,
  name: "Codex",
  bin: "codex",
  available: true,
  detail: "0.144.1",
};

describe("buildSetupSnapshot", () => {
  test("moves directly from verified Bot identity to activation", () => {
    expect(buildSetupSnapshot({
      defaultProvider: "codex",
      providers: [provider],
      lark: {
        state: "ready",
        verified: true,
        botName: "HomeAgent",
        botOpenId: "ou_bot",
        message: "ready",
      },
      runtime: { ready: false, consumers: [] },
      restartRequired: true,
    }).current).toBe("activate");
  });

  test("moves directly from an active runtime to done", () => {
    expect(buildSetupSnapshot({
      defaultProvider: "codex",
      providers: [provider],
      lark: {
        state: "ready",
        verified: true,
        botName: "HomeAgent",
        botOpenId: "ou_bot",
        message: "ready",
      },
      runtime: { ready: true, consumers: [] },
      restartRequired: false,
    }).current).toBe("done");
  });

  test("starts at AI when the selected provider is unavailable", () => {
    expect(buildSetupSnapshot({
      defaultProvider: "claude",
      providers: [provider],
      lark: { state: "unconfigured", verified: false, message: "missing" },
      runtime: { ready: false, consumers: [] },
      restartRequired: false,
    }).current).toBe("ai");
  });

  test("finishes after activation without waiting for sharing or a group", () => {
    const base = {
      defaultProvider: "codex",
      providers: [provider],
    };
    expect(buildSetupSnapshot({
      ...base,
      lark: { state: "unconfigured", verified: false, message: "missing" },
      runtime: { ready: false, consumers: [] },
      restartRequired: false,
    }).current).toBe("feishu");
    expect(buildSetupSnapshot({
      ...base,
      lark: {
        state: "ready",
        verified: true,
        botName: "HomeAgent",
        botOpenId: "ou_bot",
        message: "ready",
      },
      runtime: { ready: false, consumers: [] },
      restartRequired: true,
    }).current).toBe("activate");
    expect(buildSetupSnapshot({
      ...base,
      lark: {
        state: "ready",
        verified: true,
        botName: "HomeAgent",
        botOpenId: "ou_bot",
        message: "ready",
      },
      runtime: { ready: false, consumers: [] },
      restartRequired: true,
    }).current).toBe("activate");
    expect(buildSetupSnapshot({
      ...base,
      lark: {
        state: "ready",
        verified: true,
        botName: "HomeAgent",
        botOpenId: "ou_bot",
        message: "ready",
      },
      runtime: { ready: true, consumers: [] },
      restartRequired: false,
    }).current).toBe("done");
    expect(buildSetupSnapshot({
      ...base,
      lark: {
        state: "ready",
        verified: true,
        botName: "HomeAgent",
        botOpenId: "ou_bot",
        message: "ready",
      },
      runtime: { ready: true, consumers: [] },
      restartRequired: false,
    }).current).toBe("done");
  });

  test("completed setups may skip a group but still reopen broken prerequisites", () => {
    const ready = {
      defaultProvider: "codex",
      providers: [provider],
      lark: {
        state: "ready" as const,
        verified: true,
        botName: "HomeAgent",
        botOpenId: "ou_bot",
        message: "ready",
      },
      runtime: { ready: true, consumers: [] },
      restartRequired: false,
    };
    expect(buildSetupSnapshot(ready).current).toBe("done");
    expect(buildSetupSnapshot({
      ...ready,
      lark: { state: "unconfigured", verified: false, message: "missing" },
      runtime: { ready: false, consumers: [] },
    }).current).toBe("feishu");
  });
});
