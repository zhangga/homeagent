/** Offline acceptance only: real admission and subprocesses, fake model and transport. */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { KnowledgeEngine, SkillCatalog, FakeLlm, type SkillRoot } from "@homeagent/core";
import { CliConnector, type Connector } from "@homeagent/connectors";
import { Orchestrator } from "@homeagent/orchestrator";
import { createWebApp } from "@homeagent/web";
import { resetConfig } from "@homeagent/shared";
import { prepareStartupSkills } from "./skill-warmup.ts";

export async function measureSkillPreparation(extraRoots: SkillRoot[] = [], requestedSkill?: string, options: { warmup?: boolean; coldPair?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ha-skill-chain-")));
  const saved = { bin: process.env.HOMEAGENT_CODEX_BIN, home: process.env.HOMEAGENT_CODEX_HOME, data: process.env.HOMEAGENT_DATA_DIR };
  const sources = join(root, "sources");
  const workdir = join(root, "work");
  mkdirSync(workdir);
  const count = extraRoots.length ? 2 : 116;
  for (let i = 0; i < count; i++) {
    const directory = join(sources, `fixture-${i}`);
    mkdirSync(join(directory, "scripts", "node_modules", "runtime"), { recursive: true });
    writeFileSync(join(directory, "SKILL.md"), `---\nname: fixture-${i}\ndescription: 离线验收技能\n---\n# Skill\nUse fixture-1 if needed.`);
    writeFileSync(join(directory, "scripts", "node_modules", "runtime", "index.js"), "module.exports = 'frozen';");
    // Enough files to expose synchronous discovery; never use a live data tree.
    for (let j = 0; j < 32; j++) writeFileSync(join(directory, `resource-${j}.txt`), "fixture ".repeat(1024));
  }
  const providerScript = join(root, "provider.cjs");
  writeFileSync(providerScript, String.raw`
const fs = require('node:fs'), path = require('node:path');
const launchedAt = Date.now();
const args = process.argv.slice(2);
if (args.includes('--version')) console.log('codex-cli 0.152.1');
else if (args.includes('--help')) console.log('Usage: codex exec fork [OPTIONS] [SESSION_ID] [PROMPT]');
else if (args.includes('status')) console.log('Logged in using ChatGPT');
else if (args.includes('mcp')) console.log('[]');
else if (args.includes('sandbox')) process.exit(0);
else (async () => {
  const prompt = await Bun.stdin.text();
  const command = prompt.match(/^技能加载命令.*：(.+) <技能名称>$/m)?.[1];
  const names = prompt.includes('LOAD_FIXTURE') ? ['fixture-0', 'fixture-0', 'fixture-1'] : [];
  const extra = prompt.match(/LOAD_REAL_SKILL=([a-zA-Z0-9._:-]+)/)?.[1];
  if (extra) names.push(extra);
  const paths = [];
  for (const name of names) {
    const cmd = command + " '" + name + "'";
    const child = Bun.spawn(process.platform === 'win32' ? ['powershell.exe','-NoProfile','-NonInteractive','-Command',cmd] : ['/bin/sh','-c',cmd], {stdout:'pipe',stderr:'pipe'});
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code) throw Error('offline loader failed');
    const file = out.trim(); paths.push(file);
    if (name.startsWith('fixture-') && !fs.readFileSync(path.join(path.dirname(file), 'scripts/node_modules/runtime/index.js'), 'utf8').includes('frozen')) throw Error('dependency missing');
    if (!fs.readFileSync(file, 'utf8')) throw Error('empty skill');
  }
  let answer = '离线链路完成';
  const schemaIndex = args.indexOf('--output-schema');
  if (schemaIndex >= 0) {
    const schema = JSON.parse(fs.readFileSync(args[schemaIndex+1], 'utf8'));
    answer = JSON.stringify(schema.properties?.slugs ? {slugs:['entities/fixture'],relevant:true}
      : {answer:'离线链路完成',grounded:true,usedSlugs:['entities/fixture'],gaps:[]});
  }
  const outputIndex = args.indexOf('-o');
  if (outputIndex >= 0) fs.writeFileSync(args[outputIndex+1], answer);
  fs.appendFileSync(path.join(__dirname,'calls.jsonl'), JSON.stringify({paths,hasLoader:!!command,launchedAt,at:Date.now()})+'\n');
  console.log(JSON.stringify({type:'thread.started',thread_id:'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'}));
  console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:answer}}));
  console.log(JSON.stringify({type:'turn.completed'}));
})().catch(()=>{process.exitCode=42});
`);
  const bin = join(root, process.platform === "win32" ? "provider.cmd" : "provider");
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  writeFileSync(bin, process.platform === "win32" ? `@echo off\r\n"${process.execPath}" "${providerScript}" %*\r\n`
    : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(providerScript)} "$@"\n`);
  chmodSync(bin, 0o755);
  process.env.HOMEAGENT_CODEX_BIN = bin;
  process.env.HOMEAGENT_CODEX_HOME = join(root, "provider-state");
  process.env.HOMEAGENT_DATA_DIR = join(root, "data");
  resetConfig();
  const catalog = new SkillCatalog({ roots: [...extraRoots, { kind: "shared-agents", path: sources, providerIds: ["codex"] }] });
  const engine = new KnowledgeEngine({ dataDir: join(root, "data"), skillCatalog: catalog });
  const transport = new CliConnector();
  const connector: Connector = { name: "feishu", start: h => transport.start(h), stop: () => transport.stop(),
    reply: r => transport.reply(r), notice: (chat, text, options) => transport.notice(chat, text, options) };
  const classifier = new FakeLlm();
  classifier.onJSON(() => ({ slugs: [], relevant: false }));
  const runtime = new Orchestrator({ engine, connector, llm: classifier });
  let server: ReturnType<typeof Bun.serve> | undefined;
  let probe: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  const space = "team/oc_skill_chain" as const;
  try {
    await engine.ensureSpace(space, { chatId: "oc_skill_chain" });
    engine.feishuBindings.connect({ spaceId: space, chatId: "oc_skill_chain", boundAppId: "cli_fixture", responseMode: "mentions_only", replyInThread: true });
    const agent = engine.agents.create({ name: "离线验收", provider: "codex", visibility: "Team" });
    engine.updateSpaceMeta(space, { agentId: agent.id });
    const draft = engine.agents.saveDraft(agent.id, { executionMode: "local-full-access", permission: "full", workdir })!;
    engine.localExecution.release(agent.id, draft.id, draft.id, { termsVersion: 1, source: "local-operator", taskExecutionEnabled: true,
      expectedScopeFingerprint: engine.localExecution.preview(agent.id, draft.id).fingerprint });
    engine.registry.store(space).writePage({ slug: "entities/fixture", type: "entity", title: "离线验收", summary: "离线验收 周报",
      content: "离线验收 周报", aliases: [], tags: [], sources: [], links: [], contentHash: "fixture", updatedAt: 1 });
    engine.workItems.create({ space, title: "周报" });
    const cancelled = options.coldPair ? engine.workItems.create({ space, title: "调研离线验收方案" }) : undefined;
    if (cancelled) engine.workItems.update(cancelled.id, { active: false });
    await runtime.start();
    const app = createWebApp({ engine, detectProviders: async () => [] });
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
    const probeScript = join(root, "probe.ts");
    writeFileSync(probeScript, String.raw`
import {existsSync,writeFileSync} from 'node:fs'; import {join} from 'node:path';
const [base,root] = process.argv.slice(2); const samples=[];
while(!existsSync(join(root,'stop'))) {
  for(const path of ['/work','/healthz']) {
    const at=Date.now(), start=performance.now(); const response=await fetch(new URL(path,base)); const body=await response.text();
    if(!response.ok || (path==='/work' && !body.includes('周报'))) throw Error('HTTP acceptance failed');
    samples.push({path,at,ms:performance.now()-start});
  }
  writeFileSync(join(root,'polling'),''); await Bun.sleep(10);
}
console.log(JSON.stringify(samples));
`);
    probe = Bun.spawn([process.execPath, probeScript, server.url.href, root], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    while (!existsSync(join(root, "polling"))) {
      if (probe.exitCode !== null) throw new Error("HTTP probe exited");
      await Bun.sleep(5);
    }
    const phases: Array<{ name: string; start: number; end: number }> = [];
    if (options.warmup) {
      const start = Date.now();
      await prepareStartupSkills(engine, "codex");
      phases.push({ name: "startup-warmup", start, end: Date.now() });
    }
    const scansBeforeMessages = catalog.backgroundScanCount();
    const send = async (id: string, text: string) => {
      const start = Date.now();
      await transport.inject({ kind: "message", eventId: id, messageId: id, chatId: "oc_skill_chain", chatType: "group",
        senderId: "ou_fixture", text, mentionsBot: true, createdAt: start });
      const failed = engine.chatRuns.list(space).find(run => run.messageId === id && run.status === "failed");
      if (failed) throw new Error(`Offline Run failed: ${JSON.stringify(failed.error)}`);
      phases.push({ name: id, start, end: Date.now() });
    };
    if (options.coldPair) {
      await Promise.all([send("cold-research", "调研离线验收方案"), send("cold-report", "整理独立周报")]);
    } else await send("cold-no-skill", "调研离线验收方案");
    const scanVersion = catalog.cachedSnapshotVersion();
    if (!options.coldPair) await Promise.all([send("warm-load", `整理独立周报 LOAD_FIXTURE${requestedSkill ? ` LOAD_REAL_SKILL=${requestedSkill}` : ""}`), send("warm-no-skill", "分析独立接口需求")]);
    writeFileSync(join(root, "stop"), "");
    const output = await new Response(probe.stdout).text();
    if (await probe.exited !== 0) throw new Error("HTTP probe failed");
    probe = undefined;
    const samples = JSON.parse(output) as Array<{ path: string; at: number; ms: number }>;
    const calls = readFileSync(join(root, "calls.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line) as { paths: string[]; hasLoader: boolean; launchedAt: number; at: number });
    const runs = engine.chatRuns.list(space).map(run => ({ messageId: run.messageId, workItemId: run.workItemId, status: run.status, delivery: run.delivery.status,
      queuedAt: run.queuedAt, startedAt: run.startedAt, runStartedAt: run.runStartedAt, finishedAt: run.finishedAt, skills: run.skillEvidence?.resolved.length }));
    return { phases, samples, runs, calls, scanVersion, finalScanVersion: catalog.cachedSnapshotVersion(), scans: catalog.backgroundScanCount(), scansBeforeMessages,
      cancelledItem: cancelled ? engine.workItems.get(cancelled.id) : undefined,
      loadedRoots: new Set(calls.flatMap(call => call.paths.map(file => dirname(dirname(file))))).size,
      cleaned: calls.flatMap(call => call.paths).every(file => !existsSync(file)) };
  } finally {
    if (probe) { writeFileSync(join(root, "stop"), ""); await probe.exited; }
    await runtime.stop(); await server?.stop(true); engine.close();
    for (const [key, value] of [["HOMEAGENT_CODEX_BIN", saved.bin], ["HOMEAGENT_CODEX_HOME", saved.home], ["HOMEAGENT_DATA_DIR", saved.data]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    resetConfig();
    rmSync(root, { recursive: true, force: true });
  }
}
