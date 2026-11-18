import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeEngine, SkillCatalog } from "@homeagent/core";
import { resetConfig, saveSettings } from "@homeagent/shared";
import { createWebApp } from "./app.ts";
import { FeishuIntegrationService } from "./feishu-integration-service.ts";

let dir: string;
let previousDataDir: string | undefined;
let engine: KnowledgeEngine;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "homeagent-home-"));
  previousDataDir = process.env.HOMEAGENT_DATA_DIR;
  process.env.HOMEAGENT_DATA_DIR = dir;
  resetConfig();
  engine = new KnowledgeEngine({
    dataDir: dir,
    skillCatalog: new SkillCatalog({ roots: [] }),
    runProvider: async () => { throw new Error("unexpected provider call"); },
  });
});

afterEach(() => {
  engine.close();
  rmSync(dir, { recursive: true, force: true });
  if (previousDataDir === undefined) delete process.env.HOMEAGENT_DATA_DIR;
  else process.env.HOMEAGENT_DATA_DIR = previousDataDir;
  resetConfig();
});

test("after setup the first space has personal and group paths and reports only current pending confirmations", async () => {
  const app = createWebApp({ engine });
  expect((await app.request("/")).headers.get("location")).toBe("/setup");
  saveSettings({ onboardingCompletedAt: 1, feishuAppId: "cli_current", feishuBotName: "小助理" });
  const home = async () => (await app.request("/")).text();
  const empty = await home();
  expect(empty).toContain("私聊 小助理");
  expect(empty).toContain("@小助理 启用群聊");
  expect(empty).toContain('<a href="/integrations">查看飞书连接</a>');
  expect(empty).not.toContain("个群等待管理员确认");

  engine.feishuBindings.registerPending({ chatId: "oc_old", spaceId: "team/oc_old", boundAppId: "cli_old" });
  engine.feishuBindings.registerPending({ chatId: "oc_new", spaceId: "team/oc_new", boundAppId: "cli_current" });
  expect(await home()).toContain("1 个群等待管理员确认");
  expect(engine.registry.list()).toHaveLength(0);
  saveSettings({ feishuConnectionDisabledAppId: "cli_current" });
  expect(await home()).not.toContain("个群等待管理员确认");
});

test("the home and group confirmation guide name the configured bot without repeating discovery", async () => {
  saveSettings({ onboardingCompletedAt: 1, feishuBotName: "设计小助理" });
  let statusCalls = 0;
  const larkSetup = {
    status: async () => {
      statusCalls++;
      return { state: "ready" as const, verified: true, appId: "cli_team", message: "ready" };
    },
    configure: async () => { throw new Error("unexpected configuration"); },
    listBotChats: async () => [{ chatId: "oc_team", name: "设计群" }],
  };
  const app = createWebApp({ engine, larkSetup, feishuIntegration: new FeishuIntegrationService({ engine, larkSetup }) });
  const home = await (await app.request("/")).text();
  expect(home).toContain("@设计小助理 启用群聊");
  const guide = await (await app.request("/integrations/groups/connect")).text();
  expect(guide).toContain("@设计小助理 启用群聊");
  expect(guide).toContain("返回飞书连接");
  expect(guide).toContain('<a href="/integrations">飞书连接</a>');
  expect(guide).toContain("设计群");
  expect(statusCalls).toBe(1);
});

test("returning admins can open an approval or active Chat and continue to their knowledge space", async () => {
  const space = "team/oc_homepage";
  engine.ensureSpace(space);
  const agent = engine.agents.create({
    name: "研究助手", provider: "claude", permission: "write", workdir: dir,
  });
  engine.updateSpaceMeta(space, { agentId: agent.id, name: "产品小组" });
  const task = engine.tasks.create({ name: "整理调研资料", space, topic: "本周进展", distillOnRun: false })!;
  const app = createWebApp({ engine, adminToken: "test-admin", agentReadToken: "test-reader" });
  const headers = { authorization: "Bearer test-admin" };
  const start = await app.request(`/tasks/${task.id}/run`, { method: "POST", headers });
  expect(start.status).toBe(302);
  const [approval] = engine.listTaskRuns(task.id);
  expect(approval?.status).toBe("awaiting_approval");
  const chat = engine.chatRuns.start({ space, input: "核对 <资料>", trigger: "message" });
  engine.chatRuns.begin(chat.id);
  const ended = engine.chatRuns.start({ space, input: "终态对话", trigger: "message" });
  engine.chatRuns.begin(ended.id);
  engine.chatRuns.succeed(ended.id, { output: "完成", finishedAt: Date.now() });
  for (const input of ["分析采购报价", "整理讨论纪要"]) {
    engine.chatRuns.start({ space, input, trigger: "message" });
  }

  expect((await app.request("/")).status).toBe(401);
  expect((await app.request("/", { headers: { authorization: "Bearer test-reader" } })).status).toBe(401);
  const body = await (await app.request("/", { headers })).text();
  expect(body).toContain(`href="/tasks/runs/${approval!.id}"`);
  expect(body).toContain("待审批");
  expect(body).toContain(`href="/chats/runs/${chat.id}"`);
  expect(body.indexOf(approval!.id)).toBeLessThan(body.indexOf(chat.id));
  expect(body).toContain("核对 &lt;资料&gt;");
  expect(body).toContain("<summary>查看其余 1 项</summary>");
  expect(body).not.toContain(ended.id);
  expect(body).toContain('href="/spaces/team%2Foc_homepage" aria-label="产品小组"');
  expect(body).toContain("待提炼");
});
