import { describe, expect, test } from "bun:test";
import type { FeishuGroupBinding } from "@homeagent/core";
import type { LarkSetupStatus } from "@homeagent/shared";
import { deriveFeishuConnectionProgress } from "./feishu-connection-progress.ts";

const readyBot: LarkSetupStatus = {
  state: "ready",
  verified: true,
  appId: "cli_current",
  brand: "feishu",
  botName: "HomeAgent",
  botOpenId: "ou_bot",
  message: "ready",
};

function binding(
  patch: Partial<FeishuGroupBinding> = {},
): FeishuGroupBinding {
  return {
    chatId: "oc_product",
    spaceId: "team/oc_product",
    boundAppId: "cli_current",
    state: "active",
    responseMode: "mentions_only",
    replyInThread: true,
    createdAt: 100,
    updatedAt: 200,
    ...patch,
  };
}

describe("Feishu connection progress", () => {
  test("an active untested group is the next group to test", () => {
    const progress = deriveFeishuConnectionProgress({
      bot: readyBot,
      activeIdentity: { botName: "HomeAgent", botOpenId: "ou_bot" },
      runtime: { ready: true, consumers: [] },
      capability: "available",
      groups: [binding()],
    });

    expect(progress.groups).toEqual([
      expect.objectContaining({
        spaceId: "team/oc_product",
        stage: "ready_to_test",
      }),
    ]);
    expect(progress.nextAction).toEqual({
      kind: "test_group",
      spaceId: "team/oc_product",
    });
    expect(progress.pollAfterMs).toBe(5_000);
  });

  test("a successfully tested group is complete and stops polling", () => {
    const progress = deriveFeishuConnectionProgress({
      bot: readyBot,
      activeIdentity: { botName: "HomeAgent", botOpenId: "ou_bot" },
      runtime: { ready: true, consumers: [] },
      capability: "available",
      groups: [
        binding({
          lastTestStatus: "succeeded",
          lastTestAt: 300,
        }),
      ],
    });

    expect(progress.groups[0]).toEqual(
      expect.objectContaining({
        stage: "complete",
        completedAt: 300,
      }),
    );
    expect(progress.nextAction).toEqual({ kind: "none" });
    expect(progress.pollAfterMs).toBeUndefined();
  });

  test("runtime failure preserves completion evidence and becomes the next recovery action", () => {
    const progress = deriveFeishuConnectionProgress({
      bot: readyBot,
      activeIdentity: { botName: "HomeAgent", botOpenId: "ou_bot" },
      runtime: {
        ready: false,
        consumers: [{ key: "im.message.receive_v1", state: "failed" }],
      },
      capability: "available",
      groups: [
        binding({
          lastTestStatus: "succeeded",
          lastTestAt: 300,
        }),
      ],
    });

    expect(progress.bot.stage).toBe("runtime_unhealthy");
    expect(progress.groups[0]).toEqual(
      expect.objectContaining({
        stage: "complete",
        health: "degraded",
        completedAt: 300,
      }),
    );
    expect(progress.nextAction).toEqual({ kind: "recover_runtime" });
    expect(progress.pollAfterMs).toBe(5_000);
  });

  test("Bot setup blocks group work when no usable application is configured", () => {
    const progress = deriveFeishuConnectionProgress({
      bot: {
        state: "unconfigured",
        verified: false,
        message: "not configured",
      },
      runtime: { ready: false, consumers: [] },
      capability: "unknown",
      groups: [binding()],
    });

    expect(progress.bot.stage).toBe("not_configured");
    expect(progress.nextAction).toEqual({ kind: "connect_bot" });
  });

  test("an unverified Bot must be verified before group work", () => {
    const progress = deriveFeishuConnectionProgress({
      bot: {
        state: "invalid",
        verified: false,
        appId: "cli_current",
        message: "identity not verified",
      },
      runtime: { ready: false, consumers: [] },
      capability: "unknown",
      groups: [binding()],
    });

    expect(progress.bot.stage).toBe("not_verified");
    expect(progress.nextAction).toEqual({ kind: "verify_bot" });
  });

  test("a changed Bot identity requires restart before runtime recovery or group work", () => {
    const progress = deriveFeishuConnectionProgress({
      bot: readyBot,
      activeIdentity: { botName: "Old Bot", botOpenId: "ou_old" },
      runtime: { ready: true, consumers: [] },
      capability: "available",
      groups: [
        binding({
          lastTestStatus: "succeeded",
          lastTestAt: 300,
        }),
      ],
    });

    expect(progress.bot.stage).toBe("restart_required");
    expect(progress.bot.health).toBe("degraded");
    expect(progress.nextAction).toEqual({ kind: "restart_runtime" });
    expect(progress.pollAfterMs).toBe(5_000);
  });

  test("a pending group waits for administrator confirmation", () => {
    const progress = deriveFeishuConnectionProgress({
      bot: readyBot,
      activeIdentity: { botName: "HomeAgent", botOpenId: "ou_bot" },
      runtime: { ready: true, consumers: [] },
      capability: "available",
      groups: [binding({ state: "pending_confirmation" })],
    });

    expect(progress.groups[0]?.stage).toBe("waiting_confirmation");
    expect(progress.nextAction).toEqual({
      kind: "wait_for_confirmation",
      spaceId: "team/oc_product",
    });
  });

  test("a group bound to another application must reconnect before testing", () => {
    const progress = deriveFeishuConnectionProgress({
      bot: readyBot,
      activeIdentity: { botName: "HomeAgent", botOpenId: "ou_bot" },
      runtime: { ready: true, consumers: [] },
      capability: "available",
      groups: [
        binding({
          boundAppId: "cli_old",
          lastTestStatus: "succeeded",
          lastTestAt: 300,
        }),
      ],
    });

    expect(progress.groups[0]?.stage).toBe("needs_reconnect");
    expect(progress.nextAction).toEqual({
      kind: "reconnect_group",
      spaceId: "team/oc_product",
    });
  });

  test("a ready Bot with no current group asks to connect one", () => {
    const progress = deriveFeishuConnectionProgress({
      bot: readyBot,
      activeIdentity: { botName: "HomeAgent", botOpenId: "ou_bot" },
      runtime: { ready: true, consumers: [] },
      capability: "available",
      groups: [],
    });

    expect(progress.nextAction).toEqual({ kind: "connect_group" });
    expect(progress.pollAfterMs).toBe(5_000);
  });

  test("missing full-message capability limits but does not block a mention-only completion", () => {
    const progress = deriveFeishuConnectionProgress({
      bot: readyBot,
      activeIdentity: { botName: "HomeAgent", botOpenId: "ou_bot" },
      runtime: { ready: true, consumers: [] },
      capability: "unavailable",
      groups: [
        binding({
          lastTestStatus: "succeeded",
          lastTestAt: 300,
        }),
      ],
    });

    expect(progress.bot.health).toBe("limited");
    expect(progress.groups[0]).toEqual(
      expect.objectContaining({
        stage: "complete",
        health: "healthy",
      }),
    );
    expect(progress.nextAction).toEqual({ kind: "none" });
    expect(progress.pollAfterMs).toBeUndefined();
  });

  test("missing full-message capability limits an advanced group without erasing completion", () => {
    const progress = deriveFeishuConnectionProgress({
      bot: readyBot,
      activeIdentity: { botName: "HomeAgent", botOpenId: "ou_bot" },
      runtime: { ready: true, consumers: [] },
      capability: "unavailable",
      groups: [
        binding({
          responseMode: "smart",
          lastTestStatus: "succeeded",
          lastTestAt: 300,
        }),
      ],
    });

    expect(progress.groups[0]).toEqual(
      expect.objectContaining({
        stage: "complete",
        health: "limited",
      }),
    );
    expect(progress.pollAfterMs).toBeUndefined();
  });

  test("the oldest test-ready group wins regardless of repository order", () => {
    const progress = deriveFeishuConnectionProgress({
      bot: readyBot,
      activeIdentity: { botName: "HomeAgent", botOpenId: "ou_bot" },
      runtime: { ready: true, consumers: [] },
      capability: "available",
      groups: [
        binding({ createdAt: 200 }),
        binding({
          chatId: "oc_ops",
          spaceId: "team/oc_ops",
          createdAt: 100,
        }),
      ],
    });

    expect(progress.nextAction).toEqual({
      kind: "test_group",
      spaceId: "team/oc_ops",
    });
  });

  test("revision is stable for equivalent state and changes with public progress", () => {
    const baseInput = {
      bot: readyBot,
      activeIdentity: { botName: "HomeAgent", botOpenId: "ou_bot" },
      runtime: { ready: true, consumers: [] },
      capability: "available" as const,
    };
    const first = binding({ createdAt: 100 });
    const second = binding({
      chatId: "oc_ops",
      spaceId: "team/oc_ops",
      createdAt: 200,
    });

    const ordered = deriveFeishuConnectionProgress({
      ...baseInput,
      groups: [first, second],
    });
    const reversed = deriveFeishuConnectionProgress({
      ...baseInput,
      groups: [second, first],
    });
    const completed = deriveFeishuConnectionProgress({
      ...baseInput,
      groups: [
        binding({
          createdAt: 100,
          lastTestStatus: "succeeded",
          lastTestAt: 300,
        }),
        second,
      ],
    });

    expect(reversed.revision).toBe(ordered.revision);
    expect(completed.revision).not.toBe(ordered.revision);
  });
});
