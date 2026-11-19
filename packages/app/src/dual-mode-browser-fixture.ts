/** Explicit offline browser fixture; never imported by production entrypoints. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeEngine, SkillCatalog } from "@homeagent/core";
import { ProviderPreparationError, type DetectedProvider, type ProviderDetectionOptions } from "@homeagent/llm";
import { resetConfig } from "@homeagent/shared";
import { createWebApp, type CodexSetupPort } from "@homeagent/web";
import { createSystemHealthReporter } from "./health.ts";
import { chatRunBrowserSamples } from "./chat-run-browser-samples.ts";
import { healthBrowserSamples } from "./health-browser-samples.ts";
import { seedReminderBrowserSamples } from "./reminder-browser-samples.ts";
import { workItemBrowserSamples } from "./work-items-browser-samples.ts";

export async function startDualModeBrowserFixture(options: {
  researchTasks?: boolean; workItems?: boolean; chatRuns?: boolean; reminders?: boolean; systemHealth?: boolean;
} = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ha-dual-browser-")));
  const priorDataDir = process.env.HOMEAGENT_DATA_DIR;
  process.env.HOMEAGENT_DATA_DIR = join(root, "data");
  resetConfig();
  const counters = { model: 0, preparation: 0, isolatedPreparation: 0, fullPreparation: 0,
    detection: 0, isolationDetection: 0, sandboxSetup: 0, sandboxStatus: 0, login: 0, identityReuse: 0,
    simulatedResearch: 0 };
  const workdir = join(root, "work");
  mkdirSync(workdir);
  const workSamples = options.workItems ? workItemBrowserSamples() : undefined;
  const healthSamples = options.systemHealth ? healthBrowserSamples() : undefined;
  let chatSamples: ReturnType<typeof chatRunBrowserSamples> | undefined;
  const engine = new KnowledgeEngine({
    dataDir: join(root, "data"), skillCatalog: new SkillCatalog({ roots: [] }),
    runProvider: async (provider, input, _timeout, signal) => {
      if (workSamples && provider === "claude" && input.prompt.includes("## 本次动作\n")) {
        return workSamples.respond(input.prompt);
      }
      if (options.researchTasks && provider === "claude" && input.prompt.includes("## 主题\n")) {
        const topic = input.prompt.match(/## 主题\n([\s\S]+?)\n\n要求：/u)?.[1];
        if (!topic) throw new Error("Unexpected offline research prompt");
        counters.simulatedResearch++;
        // Leave enough time for the browser to render the running state before completion.
        await Bun.sleep(800);
        if (topic === "分析缺失的样本") throw new Error("离线样本缺失，未能生成研究结论");
        return `离线样本已核对。本次研究主题：${topic}`;
      }
      if (chatSamples && provider === "claude") return chatSamples.respond(input.prompt, signal, input.onProgress);
      counters.model++;
      throw new Error("Offline browser fixture forbids model execution");
    },
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
    ...healthSamples?.sources,
  });
  let server: ReturnType<typeof Bun.serve> | undefined;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try { await server?.stop(true); await chatSamples?.close(); await workSamples?.close(); }
    finally {
      engine.close();
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
    const agentId = engine.agents.create({ name: "离线验收 Agent（非生产）",
      provider: healthSamples ? "claude" : "codex", model: healthSamples ? undefined : "gpt-6.2-sol",
      permission: "read-only", executionMode: healthSamples ? undefined : "isolated", visibility: "Team", workdir }).id;
    engine.registry.updateMeta(space, { agentId, name: "离线验收群（未连接飞书）" });
    engine.feishuBindings.connect({ spaceId: space, chatId: "oc_offline_browser", boundAppId: "cli_offline_fixture",
      responseMode: "mentions_only", replyInThread: true });
    if (healthSamples) await engine.runDreamCycle(space); // Empty Space records a completed run without a model call.
    if (options.researchTasks) {
      for (const permission of ["read-only", "write"] as const) {
        const taskSpace = `team/oc_fixture_${permission}` as const;
        const writer = permission === "write";
        const taskAgent = engine.agents.create({
          name: writer ? "发布校对助手" : "研究助手", provider: "claude", visibility: "Team", permission, workdir,
        });
        engine.ensureSpace(taskSpace);
        engine.updateSpaceMeta(taskSpace, { name: writer ? "发布团队" : "产品研究组", agentId: taskAgent.id });
        const examples: [string, string][] = writer ? [["发布校对", "核对发布清单"]]
          : [["产品研究周报", "整理本周产品反馈"], ["样本完整性检查", "分析缺失的样本"]];
        for (const [name, topic] of examples) {
          engine.tasks.create({ name, topic, space: taskSpace, enabled: true, notify: false, distillOnRun: false });
        }
      }
    }
    await workSamples?.seed(engine, workdir);
    if (options.reminders) seedReminderBrowserSamples(engine);
    if (options.chatRuns) {
      chatSamples = chatRunBrowserSamples(engine, workdir);
      await chatSamples.runtime.start();
    }
    const app = createWebApp({ engine, detectProviders: detect, codexSetup: setup, health,
      onServiceRestart: healthSamples?.onServiceRestart,
      ...(chatSamples && { onChatRunRetry: chatSamples.runtime.retryChatRun.bind(chatSamples.runtime),
        onChatRunCancel: chatSamples.runtime.cancelChatRun.bind(chatSamples.runtime) }) });
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 120, fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/") return Response.redirect(new URL(`/agents/${agentId}`, url).toString());
      if (chatSamples && request.method === "POST" && url.pathname.startsWith("/__fixture/chats/")) {
        return chatSamples.control(url.pathname.slice("/__fixture/chats/".length));
      }
      if (healthSamples && request.method === "POST" && url.pathname.startsWith("/__fixture/health/")) {
        return new Response(null, { status: healthSamples.select(url.pathname.slice("/__fixture/health/".length)) ? 204 : 404 });
      }
      // Test-only external-boundary counters; no credentials, diagnostics, or real records.
      if (url.pathname === "/__fixture" && request.method === "GET") {
        const grants = engine.agents.listLocalExecutionGrants(agentId);
        return Response.json({ offline: true, researchTasks: Boolean(options.researchTasks), workItems: Boolean(workSamples),
          ...(chatSamples && { chatAgentId: chatSamples.agentId, chatCalls: chatSamples.calls }),
          ...(options.reminders && { reminderSamples: engine.reminders.list() }),
          ...(healthSamples && { healthSample: healthSamples.audit() }),
          counters: { ...counters, simulatedWork: workSamples?.calls ?? 0 },
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
  const fixture = await startDualModeBrowserFixture({
    researchTasks: process.argv.includes("--tasks"), workItems: process.argv.includes("--work"), chatRuns: process.argv.includes("--chats"),
    reminders: process.argv.includes("--reminders"), systemHealth: process.argv.includes("--health"),
  });
  console.log(`离线双模式浏览器验收（无真实 Provider/飞书）：${fixture.url}`);
  const stop = () => { void fixture.close().then(() => process.exit(0)); };
  // Windows terminals do not always forward SIGINT to Bun. Explicit stdin stop
  // also permits deterministic fixture cleanup without terminating a live service.
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (input: string) => { if (input.trim() === "stop") stop(); });
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
