import { describe, expect, test } from "bun:test";
import type {
  CodexLoginSession,
  CodexWindowsSandboxSetupSession,
} from "@homeagent/llm";
import { createCodexSetupPort } from "./codex-setup.ts";

describe("createCodexSetupPort", () => {
  test("exposes machine Codex authorization without a packaging-mode gate", async () => {
    let starts = 0;
    let preparations = 0;
    const idle: CodexLoginSession = {
      state: "idle",
      message: "HomeAgent 尚未连接当前 Codex 账号",
    };
    const sandboxIdle: CodexWindowsSandboxSetupSession = {
      state: "idle",
      message: "Windows 安全沙箱尚未设置",
    };
    const port = createCodexSetupPort({
      codexBin: "codex",
      findExecutable: (bin) => bin === "codex" ? "C:\\tools\\codex.exe" : null,
      prepareCodexHome: () => {
        preparations += 1;
      },
      providerSetup: {
        startDeviceLogin: async () => {
          starts += 1;
          return { state: "waiting_for_user", message: "等待确认" };
        },
        deviceLoginStatus: () => idle,
        cancelDeviceLogin: () => ({ state: "cancelled", message: "已取消" }),
        startWindowsSandboxSetup: async () => ({
          state: "waiting_for_user",
          message: "等待系统授权",
        }),
        windowsSandboxSetupStatus: () => sandboxIdle,
        cancelWindowsSandboxSetup: () => ({ state: "cancelled", message: "已取消" }),
      },
    });

    expect(port.isInstalled()).toBe(true);
    expect(preparations).toBe(1);
    port.prepareLocalAuthentication?.();
    expect(preparations).toBe(2);
    expect((await port.startDeviceLogin()).state).toBe("waiting_for_user");
    expect(starts).toBe(1);
    expect(port.deviceLoginStatus()).toEqual(idle);
    expect(port.cancelDeviceLogin().state).toBe("cancelled");
    expect((await port.startWindowsSandboxSetup?.())?.state).toBe("waiting_for_user");
    expect(port.windowsSandboxSetupStatus?.()).toEqual(sandboxIdle);
    expect(port.cancelWindowsSandboxSetup?.().state).toBe("cancelled");
  });
});
