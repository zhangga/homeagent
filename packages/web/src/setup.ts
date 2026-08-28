import {
  providerSupportsOrdinaryCompletion,
  type DetectedProvider,
} from "@homeagent/llm";
import type { LarkSetupStatus } from "@homeagent/shared";
import type { FeishuRuntimeStatus } from "./integrations.ts";

export type SetupStep = "storage" | "ai" | "feishu" | "activate" | "done";

export interface SetupSnapshot {
  current: SetupStep;
  completed: SetupStep[];
  storageReady: boolean;
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
  storageReady?: boolean;
}

export interface SetupDataDirectoryStatus {
  currentPath: string;
  available: boolean;
  lockedByEnvironment: boolean;
  gitAvailable: boolean;
  gitRepository: boolean;
  restartable: boolean;
  migrationError?: string;
  pendingMigration?: {
    destination: string;
    initializeGit: boolean;
    requestedAt: number;
  };
}

export function buildSetupSnapshot(input: SetupSnapshotInput): SetupSnapshot {
  const storageReady = input.storageReady ?? true;
  const selectedProviderReady = input.providers.some(
    (provider) => provider.id === input.defaultProvider
      && provider.available
      && providerSupportsOrdinaryCompletion(provider.id),
  );
  const larkReady = input.lark.state === "ready" && input.lark.verified;
  const runtimeReady = larkReady && !input.restartRequired && input.runtime.ready;
  const current: SetupStep = !storageReady
    ? "storage"
    : !selectedProviderReady
      ? "ai"
      : !larkReady
        ? "feishu"
        : !runtimeReady
          ? "activate"
          : "done";
  const order: SetupStep[] = ["storage", "ai", "feishu", "activate", "done"];

  return {
    current,
    completed: order.slice(0, Math.max(0, order.indexOf(current))),
    storageReady,
    selectedProviderReady,
    larkReady,
    runtimeReady,
  };
}
