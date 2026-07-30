import type { FeishuGroupBinding } from "@homeagent/core";
import type {
  LarkBotIdentity,
  LarkCapabilityState,
  LarkSetupStatus,
  SpaceId,
} from "@homeagent/shared";
import type { FeishuRuntimeStatus } from "./integrations.ts";

export type FeishuBotProgressStage =
  | "not_configured"
  | "not_verified"
  | "restart_required"
  | "runtime_unhealthy"
  | "ready";

export type FeishuGroupProgressStage =
  | "waiting_confirmation"
  | "ready_to_test"
  | "complete"
  | "needs_reconnect"
  | "disconnected";

export type FeishuProgressHealth = "healthy" | "limited" | "degraded";

export type FeishuNextActionKind =
  | "connect_bot"
  | "verify_bot"
  | "restart_runtime"
  | "recover_runtime"
  | "connect_group"
  | "reconnect_group"
  | "test_group"
  | "wait_for_confirmation"
  | "none";

export interface FeishuConnectionProgress {
  version: 1;
  revision: string;
  pollAfterMs?: number;
  bot: {
    stage: FeishuBotProgressStage;
    health: FeishuProgressHealth;
    capability: LarkCapabilityState;
  };
  groups: Array<{
    spaceId: SpaceId;
    stage: FeishuGroupProgressStage;
    health: FeishuProgressHealth;
    completedAt?: number;
  }>;
  nextAction: {
    kind: FeishuNextActionKind;
    spaceId?: SpaceId;
  };
}

export interface FeishuConnectionProgressInput {
  bot: LarkSetupStatus;
  activeIdentity?: LarkBotIdentity;
  runtime?: FeishuRuntimeStatus;
  capability: LarkCapabilityState;
  groups: FeishuGroupBinding[];
}

function publicRevision(value: unknown): string {
  let hash = 2_166_136_261;
  for (const char of JSON.stringify(value)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function deriveFeishuConnectionProgress(
  input: FeishuConnectionProgressInput,
): FeishuConnectionProgress {
  const runtimeHealthy = input.runtime?.ready === true
    && !input.runtime.consumers.some((consumer) => consumer.state === "failed");
  const activeIdentityMatches = input.activeIdentity?.botOpenId
    === input.bot.botOpenId;
  const botStage: FeishuBotProgressStage =
    input.bot.state === "unconfigured"
      ? "not_configured"
      : input.bot.state !== "ready"
          || !input.bot.verified
          || !input.bot.appId
          || !input.bot.botOpenId
        ? "not_verified"
        : !activeIdentityMatches
          ? "restart_required"
          : runtimeHealthy
            ? "ready"
            : "runtime_unhealthy";
  const orderedBindings = [...input.groups].sort(
    (left, right) =>
      left.createdAt - right.createdAt
      || left.spaceId.localeCompare(right.spaceId),
  );
  const groups = orderedBindings.map((binding) => {
    const needsReconnect = binding.state === "needs_reconnect"
      || (
        (binding.state === "active"
          || binding.state === "pending_confirmation")
        && input.bot.appId !== undefined
        && binding.boundAppId !== input.bot.appId
      );
    const complete = !needsReconnect
      && binding.state === "active"
      && binding.lastTestStatus === "succeeded";
    return {
      spaceId: binding.spaceId,
      stage: needsReconnect
        ? "needs_reconnect" as const
        : complete
          ? "complete" as const
          : binding.state === "active"
            ? "ready_to_test" as const
            : binding.state === "pending_confirmation"
              ? "waiting_confirmation" as const
              : "disconnected" as const,
      health: botStage !== "ready"
        ? "degraded" as const
        : binding.responseMode !== "mentions_only"
            && input.capability !== "available"
          ? "limited" as const
          : "healthy" as const,
      ...(complete && binding.lastTestAt !== undefined
        ? { completedAt: binding.lastTestAt }
        : {}),
    };
  });
  const firstReady = groups.find((group) => group.stage === "ready_to_test");
  const firstReconnect = groups.find((group) =>
    group.stage === "needs_reconnect"
  );
  const firstPending = groups.find((group) =>
    group.stage === "waiting_confirmation"
  );
  const hasCurrentGroup = groups.some((group) =>
    group.stage !== "disconnected"
  );
  const settled = botStage === "ready"
    && groups.length > 0
    && groups.every((group) =>
      group.stage === "complete" || group.stage === "disconnected"
    )
    && groups.some((group) => group.stage === "complete");
  const progress = {
    version: 1,
    ...(settled ? {} : { pollAfterMs: 5_000 }),
    bot: {
      stage: botStage,
      health: botStage !== "ready"
        ? "degraded"
        : input.capability === "available"
          ? "healthy"
          : "limited",
      capability: input.capability,
    },
    groups,
    nextAction: botStage === "not_configured"
      ? { kind: "connect_bot" }
      : botStage === "not_verified"
        ? { kind: "verify_bot" }
        : botStage === "restart_required"
          ? { kind: "restart_runtime" }
          : !runtimeHealthy
            ? { kind: "recover_runtime" }
            : firstReady
              ? { kind: "test_group", spaceId: firstReady.spaceId }
              : firstReconnect
                ? {
                  kind: "reconnect_group",
                  spaceId: firstReconnect.spaceId,
                }
                : firstPending
                  ? {
                    kind: "wait_for_confirmation",
                    spaceId: firstPending.spaceId,
                  }
                  : !hasCurrentGroup
                    ? { kind: "connect_group" }
                    : { kind: "none" },
  } satisfies Omit<FeishuConnectionProgress, "revision">;
  return {
    ...progress,
    revision: publicRevision(progress),
  };
}
