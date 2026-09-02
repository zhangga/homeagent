/** Public setup boundary used by the management backend. */
import type {
  LarkCapabilityState,
  LarkChatSummary,
  LarkProvisioningSession,
  LarkSetupInput,
  LarkSetupStatus,
} from "@homeagent/shared";
import type { CodexLoginSession } from "@homeagent/llm";

export interface LarkSetupPort {
  status(): Promise<LarkSetupStatus>;
  configure(input: LarkSetupInput): Promise<LarkSetupStatus>;
  startAutomatic?(brand: "feishu" | "lark"): Promise<LarkProvisioningSession>;
  provisioningStatus?(): LarkProvisioningSession;
  /** Read-only verification that a chat belongs to an external group. */
  chatIsExternal?(chatId: string): Promise<boolean>;
  listBotChats?(): Promise<LarkChatSummary[]>;
  getBotChat?(chatId: string): Promise<LarkChatSummary | undefined>;
  fullGroupMessageCapability?(): Promise<LarkCapabilityState>;
}

export interface FeishuRuntimeStatus {
  ready: boolean;
  consumers: Array<{
    key: string;
    state: string;
    lastError?: string;
  }>;
}

/** Machine Codex login boundary used by the first-run wizard. */
export interface CodexSetupPort {
  /** Whether `codex` is present on the service PATH. */
  isInstalled(): boolean;
  /** Start the browser/device authorization flow. */
  startDeviceLogin(): Promise<CodexLoginSession>;
  deviceLoginStatus(): CodexLoginSession;
  cancelDeviceLogin(): CodexLoginSession;
}
