import {
  providerSupportsOrdinaryCompletion,
  type DetectedProvider,
} from "@homeagent/llm";
import type { LarkSetupStatus } from "@homeagent/shared";
import type { FeishuRuntimeStatus } from "./integrations.ts";

export type SetupStep = "ai" | "feishu" | "activate" | "done";

export interface SetupSnapshot {
  current: SetupStep;
  completed: SetupStep[];
  selectedProviderReady: boolean;
  larkReady: boolean;
  runtimeReady: boolean;
}

export interface SetupSnapshotInput {
  defaultProvider: string;
  providers: DetectedProvider[];
  lark: LarkSetupStatus;
  runtime: FeishuRuntimeStatus;
  restartRequired: boolean;
}

export function buildSetupSnapshot(input: SetupSnapshotInput): SetupSnapshot {
  const selectedProviderReady = input.providers.some(
    (provider) => provider.id === input.defaultProvider
      && provider.available
      && providerSupportsOrdinaryCompletion(provider.id),
  );
  const larkReady = input.lark.state === "ready" && input.lark.verified;
  const runtimeReady = larkReady && !input.restartRequired && input.runtime.ready;
  const current: SetupStep = !selectedProviderReady
    ? "ai"
    : !larkReady
      ? "feishu"
      : !runtimeReady
        ? "activate"
        : "done";
  const order: SetupStep[] = ["ai", "feishu", "activate", "done"];

  return {
    current,
    completed: order.slice(0, Math.max(0, order.indexOf(current))),
    selectedProviderReady,
    larkReady,
    runtimeReady,
  };
}
