import { constants, accessSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import {
  detectProviders as detectLocalProviders,
  providerSupportsOrdinaryCompletion,
  type DetectedProvider,
} from "@homeagent/llm";
import { brandedEnv, readSettings } from "@homeagent/shared";
import { resolveRuntimePaths, type RuntimePaths } from "./runtime-paths.ts";

export type DoctorStatus = "pass" | "action" | "fail";
export type DoctorCheckId =
  | "macos"
  | "data-directory"
  | "lark-cli"
  | "ai-provider"
  | "port"
  | "launch-agent"
  | "feishu-runtime";

export interface DoctorCheck {
  id: DoctorCheckId;
  status: DoctorStatus;
  message: string;
  setupUrl?: string;
}

export interface DoctorReport {
  status: DoctorStatus;
  checkedAt: number;
  setupUrl: string;
  checks: DoctorCheck[];
}

type Probe = () => DoctorStatus | Promise<DoctorStatus>;

export interface DoctorProbeSet {
  dataDirectory: Probe;
  larkCli: Probe;
  aiProvider: Probe;
  port: Probe;
  launchAgent: Probe;
  feishuRuntime: Probe;
}

export interface DoctorOptions {
  platform?: typeof process.platform;
  paths?: RuntimePaths;
  homeDir?: string;
  port?: number;
  timeoutMs?: number;
  now?: () => number;
  probes?: Partial<DoctorProbeSet>;
  detectProviders?: (timeoutMs?: number) => Promise<DetectedProvider[]>;
}

const MESSAGES: Record<DoctorCheckId, Record<DoctorStatus, string>> = {
  macos: {
    pass: "当前系统支持 HomeAgent 的 macOS 后台服务",
    action: "请确认当前设备满足 macOS 系统要求",
    fail: "当前系统不是受支持的 macOS",
  },
  "data-directory": {
    pass: "本地知识数据目录可读写",
    action: "首次启动后将自动创建本地知识数据目录",
    fail: "本地知识数据目录不可读写，请检查磁盘权限",
  },
  "lark-cli": {
    pass: "飞书连接组件可以正常运行",
    action: "需要在设置中安装或连接飞书组件",
    fail: "飞书连接组件缺失、损坏或检查超时",
  },
  "ai-provider": {
    pass: "至少一个支持安全普通对话的本地 AI 提供方可以正常运行",
    action: "需要在设置中连接并登录一个支持安全普通对话的 AI 提供方",
    fail: "AI 提供方检查失败或超时",
  },
  port: {
    pass: "本地管理端口可用或已由 HomeAgent 使用",
    action: "HomeAgent 服务尚未开始监听本地管理端口",
    fail: "本地管理端口被其他应用占用或检查超时",
  },
  "launch-agent": {
    pass: "HomeAgent 后台服务已经安装并加载",
    action: "需要启动 HomeAgent 后台服务",
    fail: "HomeAgent 后台服务状态检查失败或超时",
  },
  "feishu-runtime": {
    pass: "飞书机器人事件监听已经就绪",
    action: "需要继续设置或启动飞书机器人监听",
    fail: "飞书机器人运行状态检查失败或超时",
  },
};

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const paths = options.paths ?? resolveRuntimePaths();
  const homeDir = options.homeDir ?? homedir();
  const port = validPort(options.port) ?? configuredPort(paths);
  const setupUrl = `http://127.0.0.1:${port}/setup`;
  const timeoutMs = Math.max(1, options.timeoutMs ?? 2_000);
  const defaults = defaultProbes({
    paths,
    homeDir,
    port,
    timeoutMs,
    platform: options.platform ?? process.platform,
    detectProviders: options.detectProviders ?? detectLocalProviders,
  });
  const probes: DoctorProbeSet = { ...defaults, ...options.probes };

  const statuses = await Promise.all([
    boundedProbe(probes.dataDirectory, timeoutMs),
    boundedProbe(probes.larkCli, timeoutMs),
    boundedProbe(probes.aiProvider, timeoutMs),
    boundedProbe(probes.port, timeoutMs),
    boundedProbe(probes.launchAgent, timeoutMs),
    boundedProbe(probes.feishuRuntime, timeoutMs),
  ]);
  const ids: DoctorCheckId[] = [
    "macos",
    "data-directory",
    "lark-cli",
    "ai-provider",
    "port",
    "launch-agent",
    "feishu-runtime",
  ];
  const checkStatuses: DoctorStatus[] = [
    (options.platform ?? process.platform) === "darwin" ? "pass" : "fail",
    ...statuses,
  ];
  const checks = ids.map((id, index): DoctorCheck => {
    const status = checkStatuses[index] ?? "fail";
    return {
      id,
      status,
      message: MESSAGES[id][status],
      ...(status !== "pass" && id !== "macos" ? { setupUrl } : {}),
    };
  });

  return {
    status: aggregateStatus(checkStatuses),
    checkedAt: (options.now ?? Date.now)(),
    setupUrl,
    checks,
  };
}

export async function runDoctorCli(input: string[] | {
  argv?: string[];
  write?: (text: string) => void;
  doctor?: DoctorOptions;
} = {}): Promise<number> {
  const options = Array.isArray(input) ? { argv: input } : input;
  const argv = options.argv ?? process.argv.slice(2);
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  const report = await runDoctor(options.doctor);
  if (argv.includes("--json")) {
    write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    write(`HomeAgent 安装检查：${report.status}\n`);
    for (const check of report.checks) {
      write(`[${check.status}] ${check.message}\n`);
    }
    write(`继续设置：${report.setupUrl}\n`);
  }
  return report.status === "fail" ? 1 : 0;
}

function configuredPort(paths: RuntimePaths): number {
  const persisted = readSettings(paths.dataDir).webPort;
  const persistedPort = validPort(persisted);
  if (persistedPort !== undefined) return persistedPort;
  const fromEnvironment = Number(brandedEnv(process.env, "WEB_PORT"));
  return validPort(fromEnvironment) ?? 3000;
}

function validPort(value: number | undefined): number | undefined {
  return Number.isInteger(value) && value !== undefined && value > 0 && value <= 65_535
    ? value
    : undefined;
}

function aggregateStatus(statuses: DoctorStatus[]): DoctorStatus {
  if (statuses.includes("fail")) return "fail";
  return statuses.includes("action") ? "action" : "pass";
}

async function boundedProbe(probe: Probe, timeoutMs: number): Promise<DoctorStatus> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<DoctorStatus>((resolve) => {
    timer = setTimeout(() => resolve("fail"), timeoutMs);
  });
  try {
    return await Promise.race([
      Promise.resolve()
        .then(probe)
        .then((status) =>
          status === "pass" || status === "action" || status === "fail" ? status : "fail",
        )
        .catch(() => "fail" as const),
      deadline,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function defaultProbes(input: {
  paths: RuntimePaths;
  homeDir: string;
  port: number;
  timeoutMs: number;
  platform: typeof process.platform;
  detectProviders: (timeoutMs?: number) => Promise<DetectedProvider[]>;
}): DoctorProbeSet {
  return {
    dataDirectory: () => {
      if (!existsSync(input.paths.dataDir)) return "action";
      try {
        if (!statSync(input.paths.dataDir).isDirectory()) return "fail";
        accessSync(input.paths.dataDir, constants.R_OK | constants.W_OK);
        return "pass";
      } catch {
        return "fail";
      }
    },
    larkCli: async () => {
      const available = await commandExitsZero([input.paths.larkBin, "--version"], input.timeoutMs);
      if (available) return "pass";
      return input.paths.bundled ? "fail" : "action";
    },
    aiProvider: async () => {
      const perProviderMs = Math.max(100, Math.floor(input.timeoutMs / 4));
      const detected = await input.detectProviders(perProviderMs);
      return detected.some(
        (provider) => provider.available && providerSupportsOrdinaryCompletion(provider.id),
      )
        ? "pass"
        : "action";
    },
    port: async () => {
      if (!(await isTcpListening(input.port, input.timeoutMs))) return "pass";
      return (await fetchStatus(`http://127.0.0.1:${input.port}/healthz`, input.timeoutMs)) === 200
        ? "pass"
        : "fail";
    },
    launchAgent: async () => {
      const plist = join(
        input.homeDir,
        "Library",
        "LaunchAgents",
        "com.homeagent.agent.plist",
      );
      if (!existsSync(plist)) return "action";
      if (input.platform !== "darwin") return "fail";
      const uid = process.getuid?.() ?? 0;
      return (await commandExitsZero(
        ["/bin/launchctl", "print", `gui/${uid}/com.homeagent.agent`],
        input.timeoutMs,
      ))
        ? "pass"
        : "action";
    },
    feishuRuntime: async () => {
      const status = await fetchStatus(
        `http://127.0.0.1:${input.port}/readyz`,
        input.timeoutMs,
      );
      if (status === 200) return "pass";
      return status === undefined || status === 503 ? "action" : "fail";
    },
  };
}

async function commandExitsZero(argv: string[], timeoutMs: number): Promise<boolean> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  } catch {
    return false;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  const outcome = await Promise.race([proc.exited, deadline]);
  if (timer) clearTimeout(timer);
  if (outcome === "timeout") {
    try {
      proc.kill("SIGTERM");
    } catch {
      // The process may have exited at the deadline boundary.
    }
    return false;
  }
  return outcome === 0;
}

async function isTcpListening(port: number, timeoutMs: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (listening: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(listening);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function fetchStatus(url: string, timeoutMs: number): Promise<number | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return (await fetch(url, { cache: "no-store", signal: controller.signal })).status;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

if (import.meta.main) {
  void runDoctorCli().then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    () => {
      process.stderr.write("HomeAgent 安装检查无法完成\n");
      process.exitCode = 1;
    },
  );
}
