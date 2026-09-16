/** Explicit offline browser fixture; never imported by production entrypoints. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeEngine, SkillCatalog } from "@homeagent/core";
import { ProviderPreparationError, type DetectedProvider, type ProviderDetectionOptions } from "@homeagent/llm";
import { resetConfig } from "@homeagent/shared";
import { createWebApp, type CodexSetupPort } from "@homeagent/web";
import { createSystemHealthReporter } from "./health.ts";

export async function startDualModeBrowserFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ha-dual-browser-")));
  const priorDataDir = process.env.HOMEAGENT_DATA_DIR;
  process.env.HOMEAGENT_DATA_DIR = join(root, "data");
  resetConfig();
  const counters = { model: 0, preparation: 0, isolatedPreparation: 0, fullPreparation: 0,
    detection: 0, isolationDetection: 0, sandboxSetup: 0, sandboxStatus: 0, login: 0, identityReuse: 0 };
  const workdir = join(root, "work");
  mkdirSync(workdir);
  const engine = new KnowledgeEngine({
    dataDir: join(root, "data"), skillCatalog: new SkillCatalog({ roots: [] }),
    runProvider: async () => { counters.model++; throw new Error("Offline browser fixture forbids model execution"); },
    readiness: { providerIdentity: () => "offline-codex-identity" },
    nativeSessionPreflight: async (_provider, _timeout, _signal, _workdir, execution) => {
      counters.preparation++;
      if (execution?.executionMode === "local-full-access") { counters.fullPreparation++; return; }
      counters.isolatedPreparation++;
      throw new ProviderPreparationError({ stage: "native-session", reason: "protected-root-readable", exitCode: 75 });
    },
  });
  const detect = async (options?: ProviderDetectionOptions): Promise<DetectedProvider[]> => {
    counters.detection++;
    if (options?.codexNativeIsolation) counters.isolationDetection++;
    return [{ id: "codex", name: "Codex", bin: "offline-codex", available: true,
      nativeSessionCommands: true, detail: "离线测试替身 · 不代表真实 CLI 状态",
      ...(options?.codexNativeIsolation ? { nativeSessions: false, nativeSessionIssue: "protected-root-readable" as const } : {}) }];
  };
  const setup: CodexSetupPort = {
    isInstalled: () => true,
    prepareLocalAuthentication: () => { counters.identityReuse++; },
    startDeviceLogin: async () => { counters.login++; return { state: "ready", message: "离线身份替身" }; },
    deviceLoginStatus: () => ({ state: "idle", message: "离线身份替身" }),
    cancelDeviceLogin: () => ({ state: "cancelled", message: "离线身份替身" }),
    startWindowsSandboxSetup: async () => { counters.sandboxSetup++; return { state: "failed", message: "离线验收禁止系统沙箱设置" }; },
    windowsSandboxSetupStatus: () => { counters.sandboxStatus++; return { state: "idle", message: "离线沙箱替身" }; },
    cancelWindowsSandboxSetup: () => ({ state: "cancelled", message: "离线沙箱替身" }),
  };
  const loops = () => ({ started: true, running: false });
  const health = createSystemHealthReporter({ engine, detectProviders: detect,
    requiredProviderIds: () => ["codex"], ordinaryProviderIds: () => ["codex"],
    connectorHealth: () => ({ name: "offline-feishu", ready: true, consumers: [
      { key: "im.message.receive_v1", state: "ready", attempts: 0 },
      { key: "im.chat.member.bot.added_v1", state: "ready", attempts: 0 },
    ] }), dreamSchedulerHealth: loops, maintenanceSchedulerHealth: loops, taskSchedulerHealth: loops,
    workContinuationSchedulerHealth: loops, reminderSchedulerHealth: loops, learningSchedulerHealth: loops,
  });
  let server: ReturnType<typeof Bun.serve> | undefined;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try { await server?.stop(true); engine.close(); }
    finally {
      if (priorDataDir === undefined) delete process.env.HOMEAGENT_DATA_DIR;
      else process.env.HOMEAGENT_DATA_DIR = priorDataDir;
      resetConfig();
      // Only remove this invocation's generated directory; reject a replaced root.
      if (realpathSync(root) !== root) throw new Error("Offline fixture directory identity changed");
      rmSync(root, { recursive: true, force: true });
    }
  };
  try {
    const space = "team/oc_offline_browser" as const;
    await engine.ensureSpace(space);
    const agentId = engine.agents.create({ name: "离线验收 Agent（非生产）", provider: "codex", model: "gpt-5.6-sol",
      permission: "read-only", executionMode: "isolated", visibility: "Team", workdir }).id;
    engine.registry.updateMeta(space, { agentId, name: "离线验收群（未连接飞书）" });
    engine.feishuBindings.connect({ spaceId: space, chatId: "oc_offline_browser", boundAppId: "cli_offline_fixture",
      responseMode: "mentions_only", replyInThread: true });
    const app = createWebApp({ engine, detectProviders: detect, providerModels: async () => ({ codex: ["gpt-5.6-sol"] }),
      codexSetup: setup, health });
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 120, fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/") return Response.redirect(new URL(`/agents/${agentId}`, url).toString());
      // Test-only external-boundary counters; no credentials, diagnostics, or real records.
      if (url.pathname === "/__fixture" && request.method === "GET") {
        const grants = engine.agents.listLocalExecutionGrants(agentId);
        return Response.json({ offline: true, counters: { ...counters },
          mode: engine.agents.get(agentId)?.executionMode, grants: grants.length,
          activeGrants: grants.filter(grant => grant.revokedAt === undefined).length,
          taskEnabled: grants.some(grant => grant.revokedAt === undefined && grant.taskExecutionEnabled),
        }, { headers: { "cache-control": "no-store" } });
      }
      return app.fetch(request);
    } });
    return { url: `http://127.0.0.1:${server.port}`, root, agentId, close };
  } catch (error) { await close(); throw error; }
}

if (import.meta.main) {
  const fixture = await startDualModeBrowserFixture();
  console.log(`离线双模式浏览器验收（无真实 Provider/飞书）：${fixture.url}`);
  const stop = () => { void fixture.close().then(() => process.exit(0)); };
  // Windows terminals do not always forward SIGINT to Bun. Explicit stdin stop
  // also permits deterministic fixture cleanup without terminating a live service.
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (input: string) => { if (input.trim() === "stop") stop(); });
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
