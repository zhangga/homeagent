import {
  CodexProviderSetup,
  prepareProviderCodexHome,
  type CodexLoginSession,
  type CodexWindowsSandboxSetupSession,
} from "@homeagent/llm";
import type { CodexSetupPort } from "@homeagent/web";

interface CodexProviderSetupLike {
  startDeviceLogin(): Promise<CodexLoginSession>;
  deviceLoginStatus(): CodexLoginSession;
  cancelDeviceLogin(): CodexLoginSession;
  startWindowsSandboxSetup(): Promise<CodexWindowsSandboxSetupSession>;
  windowsSandboxSetupStatus(): CodexWindowsSandboxSetupSession;
  cancelWindowsSandboxSetup(): CodexWindowsSandboxSetupSession;
}

export interface CreateCodexSetupPortOptions {
  codexBin?: string;
  findExecutable?: (bin: string) => string | null;
  prepareCodexHome?: () => void;
  providerSetup?: CodexProviderSetupLike;
}

/**
 * Adapt the machine Codex login flow to the management interface. Packaging
 * changes where HomeAgent runs, not whether the operator can authorize Codex.
 */
export function createCodexSetupPort(
  options: CreateCodexSetupPortOptions = {},
): CodexSetupPort {
  const codexBin = options.codexBin?.trim() || "codex";
  const findExecutable = options.findExecutable ?? ((bin) => Bun.which(bin));
  const prepareCodexHome = options.prepareCodexHome ?? prepareProviderCodexHome;
  const isInstalled = () => findExecutable(codexBin) !== null;
  if (isInstalled()) {
    try {
      prepareCodexHome();
    } catch {
      // Keep the management UI available so the operator can repair the path.
    }
  }
  const providerSetup = options.providerSetup ?? new CodexProviderSetup({ codexBin });
  return {
    isInstalled,
    prepareLocalAuthentication: () => prepareCodexHome(),
    startDeviceLogin: () => providerSetup.startDeviceLogin(),
    deviceLoginStatus: () => providerSetup.deviceLoginStatus(),
    cancelDeviceLogin: () => providerSetup.cancelDeviceLogin(),
    startWindowsSandboxSetup: () => providerSetup.startWindowsSandboxSetup(),
    windowsSandboxSetupStatus: () => providerSetup.windowsSandboxSetupStatus(),
    cancelWindowsSandboxSetup: () => providerSetup.cancelWindowsSandboxSetup(),
  };
}
