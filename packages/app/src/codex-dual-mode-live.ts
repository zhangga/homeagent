/** Opt-in live acceptance, never imported by production entrypoints. */
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { KnowledgeEngine, SkillCatalog } from "@homeagent/core";
import { prepareProviderCodexHome, providerPreparationFailure, type ProviderExecutionEvidence } from "@homeagent/llm";
import { resetConfig } from "@homeagent/shared";

export function requireLiveCodexConsent(env: NodeJS.ProcessEnv, args: readonly string[]): void {
  if (env.HOMEAGENT_LIVE !== "1" || args.length !== 1 || args[0] !== "--confirm-local-full-access") {
    throw new Error("需要 HOMEAGENT_LIVE=1 和 --confirm-local-full-access；将调用真实模型并允许无沙箱工具执行。");
  }
}

/** Only fixed preparation codes may leave the private provider boundary. */
export function liveCodexFailure(error: unknown) {
  return providerPreparationFailure(error) ?? { stage: "live-acceptance", reason: "check-failed" };
}

export function hasVerifiedFileWrite(evidence: ProviderExecutionEvidence): boolean {
  return !evidence.truncated && evidence.execution?.model === "verified"
    && evidence.execution.process === "started" && evidence.execution.effectiveSandbox === "danger-full-access"
    && evidence.execution.executionMode === "local-full-access" && evidence.execution.sandboxCheck === "not-applicable"
    && evidence.events.some(event => event.status === "completed"
      && (event.kind === "file-change" || (event.kind === "command" && event.exitCode === 0)));
}

export function createLiveCodexFixture(directory = resolve(import.meta.dir, "../../..")) {
  const parent = realpathSync(directory);
  const fromTemp = relative(realpathSync(tmpdir()), parent);
  if (fromTemp === "" || (!isAbsolute(fromTemp) && fromTemp !== ".." && !fromTemp.startsWith(`..${sep}`))) {
    throw new Error("Codex 真实验收目录不能位于系统 Temp；请在非 Temp 的源码仓库运行。");
  }
  return { parent, root: realpathSync(mkdtempSync(join(parent, ".codex-live-"))) };
}

export function removeLiveCodexFixture(root: string, parent: string): void {
  if (!existsSync(root)) return;
  if (!basename(root).startsWith(".codex-live-") || dirname(root) !== parent
    || realpathSync(root) !== root || lstatSync(root).isSymbolicLink()) {
    throw new Error("临时目录身份改变，拒绝自动清理。");
  }
  rmSync(root, { recursive: true, force: true });
}

export async function runLiveCodexAcceptance(env: NodeJS.ProcessEnv, args: readonly string[], signal?: AbortSignal): Promise<void> {
  requireLiveCodexConsent(env, args); // Before directories, credentials, stores or processes.
  const { parent, root } = createLiveCodexFixture();
  const keys = ["HOMEAGENT_DATA_DIR", "HOMEAGENT_CODEX_HOME", "HOMEAGENT_LOG_LEVEL"] as const;
  const previous = keys.map(key => process.env[key]);
  let engine: KnowledgeEngine | undefined;
  const report = (stage: string, result: unknown) => console.log(JSON.stringify({ stage, result }));
  let phase = "authentication-reuse";
  try {
    process.env.HOMEAGENT_DATA_DIR = join(root, "data");
    process.env.HOMEAGENT_CODEX_HOME = join(root, "data", "provider-state", "codex");
    process.env.HOMEAGENT_LOG_LEVEL = "error";
    resetConfig();
    signal?.throwIfAborted();
    prepareProviderCodexHome(); // Auth-only reuse; never copy ambient rules, plugins or sessions.
    report(phase, { controlledHome: true, fileCacheImported: existsSync(join(process.env.HOMEAGENT_CODEX_HOME, "auth.json")) });
    const workdir = join(root, "work");
    mkdirSync(workdir);
    engine = new KnowledgeEngine({ dataDir: join(root, "data"), skillCatalog: new SkillCatalog({ roots: [] }) });
    // Local scope metadata only: no transport, credentials, scheduler or Feishu server.
    const space = "team/oc_local_live_acceptance" as const;
    await engine.ensureSpace(space);
    const agent = engine.agents.create({ name: "临时 Codex 真实验收", provider: "codex", model: "gpt-5.6-sol",
      permission: "write", executionMode: "isolated", visibility: "Team", workdir });
    engine.registry.updateMeta(space, { agentId: agent.id });
    engine.feishuBindings.connect({ spaceId: space, chatId: "oc_local_live_acceptance", boundAppId: "cli_local_fixture",
      responseMode: "mentions_only", replyInThread: true });
    phase = "isolated-preparation";
    report(phase, await engine.agentReadiness.check(agent.id));
    signal?.throwIfAborted();
    phase = "full-preparation";
    const draft = engine.saveAgentDraft(agent.id, { executionMode: "local-full-access", permission: "full" })!;
    engine.releaseAgent(agent.id, draft.id, draft.id, { termsVersion: 1, source: "local-operator", taskExecutionEnabled: false,
      expectedScopeFingerprint: engine.localExecution.preview(agent.id, draft.id).fingerprint });
    const full = await engine.agentReadiness.check(agent.id);
    report(phase, full);
    if (full?.state !== "ready") throw new Error("Full preparation failed");
    const snapshot = engine.agentRunExecutionSnapshot(space, true, false, "all");
    const evidence: ProviderExecutionEvidence[] = [];
    const onExecutionEvidence = (call: ProviderExecutionEvidence) => { evidence.push(structuredClone(call)); };
    const marker = `HA_${randomUUID().replaceAll("-", "")}`;
    phase = "native-start";
    report(phase, { state: "running", catalog: "empty-controlled-fixture" });
    const start = await engine.askWithExecutionPlan([space],
      `这是仅用于验收的对话。记住随机标记 ${marker}，本轮只回答该标记。不要执行工具、读取文件或访问网络。`,
      snapshot.executionPlan, snapshot.skillEvidence, { nativeSession: { mode: "start" }, signal, onExecutionEvidence }, agent.id);
    const startPassed = start.answer.trim() === marker && Boolean(start.nativeSessionId);
    report(phase, { passed: startPassed, evidence });
    if (!startPassed || !start.nativeSessionId) throw new Error("Native start failed");
    phase = "native-fork-tool";
    report(phase, { state: "running" });
    const fork = await engine.askWithExecutionPlan([space],
      "请从本会话上一轮记忆中取出随机标记，用可用的文件编辑工具或 PowerShell 命令把它以 UTF-8 写入当前 Workdir 的 acceptance.txt，且只写该文件。禁止读取其他目录或访问网络。最终只回答该标记。",
      snapshot.executionPlan, snapshot.skillEvidence, { nativeSession: { mode: "fork", id: start.nativeSessionId }, signal, onExecutionEvidence }, agent.id);
    const artifact = join(workdir, "acceptance.txt");
    const stat = existsSync(artifact) ? lstatSync(artifact) : undefined;
    const artifactMatches = Boolean(stat?.isFile() && !stat.isSymbolicLink() && stat.size <= 256
      && realpathSync(artifact) === artifact && readFileSync(artifact, "utf8").replace(/^\uFEFF/u, "").trim() === marker);
    const forkPassed = fork.answer.trim() === marker && Boolean(fork.nativeSessionId && fork.nativeSessionId !== start.nativeSessionId)
      && artifactMatches && evidence.length === 2 && evidence.every(call => call.execution?.model === "verified")
      && hasVerifiedFileWrite(evidence[1]!);
    report(phase, { passed: forkPassed, inheritedMarker: fork.answer.trim() === marker, distinctChild: Boolean(fork.nativeSessionId && fork.nativeSessionId !== start.nativeSessionId), artifactMatches, evidence });
    if (!forkPassed) throw new Error("Native fork or tool evidence failed");
    phase = "revoked-frozen-plan";
    engine.agents.revokeLocalExecutionGrants(agent.id, engine.agents.get(agent.id)!.publishedRevisionId!);
    let rejected = false;
    try {
      await engine.askWithExecutionPlan([space], "撤销后禁止启动模型。", snapshot.executionPlan, snapshot.skillEvidence,
        { nativeSession: { mode: "start" }, signal, onExecutionEvidence }, agent.id);
    } catch (error) { rejected = providerPreparationFailure(error)?.reason === "local-execution-consent-revoked"; }
    report(phase, { passed: rejected && evidence.length === 2, additionalExecutionEvidence: evidence.length - 2 });
    if (!rejected || evidence.length !== 2) throw new Error("Revocation failed");
    report("complete", { passed: true, feishu: "not-connected", productionService: "unchanged", skills: "not-verified", restart: "not-verified" });
  } catch (error) {
    report(phase, { passed: false, failure: liveCodexFailure(error) });
    throw new Error("Codex 真实验收未通过；参阅上方固定原因码，未输出 Provider 原始诊断。");
  } finally {
    try { engine?.close(); }
    finally {
      keys.forEach((key, index) => { const value = previous[index]; if (value === undefined) delete process.env[key]; else process.env[key] = value; });
      resetConfig();
      removeLiveCodexFixture(root, parent);
      report("cleanup", { temporaryDataRemoved: !existsSync(root) });
    }
  }
}

if (import.meta.main) {
  const controller = new AbortController();
  const stop = () => controller.abort(new Error("Live acceptance cancelled"));
  const input = (chunk: string) => { if (chunk.trim() === "stop") stop(); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.stdin.setEncoding("utf8").on("data", input);
  try { await runLiveCodexAcceptance(process.env, process.argv.slice(2), controller.signal); }
  catch { console.error("真实验收未完成。必须显式授权；运行中可输入 stop 取消。认证缓存、会话和生产数据不应手工修改。"); process.exitCode = 1; }
  finally { process.stdin.removeListener("data", input); process.stdin.pause(); process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
}
