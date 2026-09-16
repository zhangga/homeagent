import { beforeEach, afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeEngine, SkillCatalog } from "@homeagent/core";
import { resetConfig } from "@homeagent/shared";
import { createWebApp } from "./app.ts";
import { editorValuesFor } from "./agent-workbench.ts";
import { localExecutionRunStatus } from "./agent-local-execution.ts";

let root: string;
let engine: KnowledgeEngine;
let agentId: string;
let workdir: string;
const space = "team/oc_confirm" as const;
const providers = [{ id: "codex" as const, name: "Codex", bin: "codex", available: true,
  nativeSessionCommands: true, nativeSessions: false, nativeSessionIssue: "protected-root-readable" as const, detail: "offline 0.154.0" }];
const defaults = { provider: "codex", model: "gpt-5.6-sol" };
const appFor = (adminToken?: string) => createWebApp({ engine, adminToken, detectProviders: async () => providers,
  providerModels: async () => ({ codex: ["gpt-5.6-sol"] }) });
const form = (values: Record<string, string>) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(values) });
async function confirmationPage(app = appFor()) {
  const draft = engine.saveAgentDraft(agentId, { executionMode: "local-full-access", permission: "full", workdir })!;
  const url = `/agents/${agentId}/revisions/${draft.id}/local-execution`;
  const response = await app.request(url);
  const fields: Record<string, string> = { ...hidden(await response.text()), confirmFullAccess: "1" };
  return { app, url, fields, draft };
}
function hidden(html: string): Record<string, string> {
  return Object.fromEntries([...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"/g)].map(match => [match[1]!, match[2]!]));
}

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ha-web-full-")));
  process.env.HOMEAGENT_DATA_DIR = join(root, "data"); resetConfig();
  workdir = join(root, "work"); mkdirSync(workdir);
  engine = new KnowledgeEngine({ dataDir: join(root, "data"), skillCatalog: new SkillCatalog({ roots: [] }), runProvider: async () => { throw new Error("No live provider in web tests"); } });
  await engine.ensureSpace(space);
  agentId = engine.agents.create({ provider: "codex", name: "Windows Agent", model: "gpt-5.6-sol" }).id;
  engine.registry.updateMeta(space, { agentId, name: "测试群" });
  engine.feishuBindings.connect({ spaceId: space, chatId: "oc_confirm", boundAppId: "cli_fixture", responseMode: "mentions_only", replyInThread: true });
});
afterEach(() => { engine.close(); rmSync(root, { recursive: true, force: true }); delete process.env.HOMEAGENT_DATA_DIR; resetConfig(); });

test("confirmation preserves same-origin browser form provenance without sending cross-origin referrers", async () => {
  const { app, url } = await confirmationPage();
  const response = await app.request(url);
  // no-referrer makes Chromium send Origin: null for this navigation POST;
  // keep rejecting null Origin rather than weakening the authority boundary.
  expect(response.headers.get("referrer-policy")).toBe("same-origin");
  expect(response.headers.get("cache-control")).toBe("no-store");
});

test("full publication uses an inert draft followed by a distinct, scope-bound human confirmation", async () => {
  const app = appFor();
  const current = engine.agents.get(agentId)!;
  const values = editorValuesFor(current, providers, defaults);
  const response = await app.request(`/agents/${agentId}`, form({
    name: values.name, instruction: "frozen instruction", provider: "codex", model: "gpt-5.6-sol", reasoningEffort: "",
    visibility: "Team", permission: "full", executionMode: "local-full-access", workdir,
    agentAction: "publish", expectedHeadRevisionId: current.publishedRevisionId!,
  }));
  expect(response.status).toBe(302);
  const url = response.headers.get("location")!;
  expect(url).toContain("/local-execution");
  expect(engine.agents.get(agentId)?.publishedRevisionId).toBe(current.publishedRevisionId);
  expect(engine.agents.listLocalExecutionGrants(agentId)).toEqual([]);
  const page = await app.request(url);
  const html = await page.text();
  expect(html).toContain("工作目录外文件和网络");
  expect(html).toContain("测试群");
  expect(html).toContain("群成员消息");
  expect(html).toContain("gpt-5.6-sol");
  expect(page.headers.get("cache-control")).toBe("no-store");
  const confirmed = await app.request(url, form({ ...hidden(html), confirmFullAccess: "1", taskExecutionEnabled: "1" }));
  expect(confirmed.status).toBe(302);
  expect(engine.agents.get(agentId)?.executionMode).toBe("local-full-access");
  expect(engine.agents.listLocalExecutionGrants(agentId)[0]).toMatchObject({ source: "local-operator", taskExecutionEnabled: true });
  expect(engine.localExecution.referenceFor(space, agentId, engine.agents.get(agentId)!.publishedRevisionId!, "chat")).toBeDefined();
});

test("the workbench exposes mode intent and revocation stops the published grant without changing its revision", async () => {
  const app = appFor();
  const draft = engine.saveAgentDraft(agentId, { executionMode: "local-full-access", permission: "full", workdir })!;
  const url = `/agents/${agentId}/revisions/${draft.id}/local-execution`;
  const fields = hidden(await (await app.request(url)).text());
  expect((await app.request(url, form({ ...fields, confirmFullAccess: "1" }))).status).toBe(302);
  const published = engine.agents.get(agentId)!;
  const page = await (await app.request(`/agents/${agentId}`)).text();
  expect(page).toContain('name="executionMode"');
  expect(page).toContain("本机完全访问（无沙箱）");
  expect(page).toContain("撤销完全访问");
  expect(page).not.toContain("启用 Windows 安全沙箱</button>");
  const tokens = hidden(page);
  const revoked = await app.request(`/agents/${agentId}/local-execution/revoke`, form({
    csrfToken: tokens.csrfToken!, expectedHeadRevisionId: published.publishedRevisionId!,
  }));
  expect(revoked.status).toBe(302);
  expect(engine.agents.get(agentId)).toEqual(published);
  expect(engine.agents.listLocalExecutionGrants(agentId).every(grant => grant.revokedAt !== undefined)).toBe(true);
  const after = await (await app.request(`/agents/${agentId}`)).text();
  expect(after).toContain("等待本机确认");
});

test.each(["ack", "csrf", "head", "scope", "source", "duplicate", "oversized"] as const)("confirmation rejects %s tampering without publishing", async kind => {
  const { app, url, fields } = await confirmationPage();
  const current = engine.agents.get(agentId);
  const history = engine.agents.listRevisions(agentId);
  const request = form(fields);
  if (kind === "ack") request.body.delete("confirmFullAccess");
  if (kind === "csrf") request.body.set("csrfToken", "wrong");
  if (kind === "head") request.body.set("expectedHeadRevisionId", "agent_revision_stale");
  if (kind === "scope") request.body.set("expectedScopeFingerprint", "0".repeat(64));
  if (kind === "source") request.body.set("source", "authenticated-admin");
  if (kind === "duplicate") request.body.append("confirmFullAccess", "1");
  if (kind === "oversized") request.body.set("expectedScopeFingerprint", "x".repeat(8193));
  const response = await app.request(url, request);
  expect(response.status).toBeGreaterThanOrEqual(400);
  expect(engine.agents.get(agentId)).toEqual(current);
  expect(engine.agents.listRevisions(agentId)).toEqual(history);
  expect(engine.agents.listLocalExecutionGrants(agentId)).toEqual([]);
});

test.each(["foreign-origin", "forged-forwarding", "null-origin", "cross-scheme", "foreign-host"] as const)("confirmation and revoke reject %s even with a valid form token", async kind => {
  const { app, url, fields } = await confirmationPage();
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  if (kind === "foreign-origin" || kind === "forged-forwarding") headers.origin = "https://attacker.example";
  if (kind === "forged-forwarding") { headers["x-forwarded-host"] = "attacker.example"; headers["x-forwarded-proto"] = "https"; }
  if (kind === "null-origin") headers.origin = "null";
  if (kind === "cross-scheme") headers.origin = "https://localhost";
  if (kind === "foreign-host") headers.host = "attacker.example";
  expect((await app.request(url, { ...form(fields), headers })).status).toBe(403);
  expect((await app.request(`/agents/${agentId}/local-execution/revoke`, { ...form({ csrfToken: fields.csrfToken!, expectedHeadRevisionId: fields.expectedHeadRevisionId! }), headers })).status).toBe(403);
  expect(engine.agents.listLocalExecutionGrants(agentId)).toEqual([]);
});

test("a binding race during CLI detection invalidates consent instead of widening the saved scope", async () => {
  const app = createWebApp({ engine, providerModels: async () => ({}), detectProviders: async () => {
    engine.feishuBindings.updatePolicy(space, { responseMode: "all_messages" });
    return providers;
  } });
  const { url, fields } = await confirmationPage(app);
  const response = await app.request(url, form(fields));
  expect(response.status).toBe(409);
  expect(await response.text()).toContain("绑定范围已变化");
  expect(engine.agents.listLocalExecutionGrants(agentId)).toEqual([]);
});

test("authenticated confirmation owns its source, duplicate submission fails, and full rollback needs fresh consent", async () => {
  const app = appFor("test-admin-token");
  const draft = engine.saveAgentDraft(agentId, { executionMode: "local-full-access", permission: "full", workdir })!;
  const url = `/agents/${agentId}/revisions/${draft.id}/local-execution`;
  expect((await app.request(url)).status).toBe(401);
  const auth = { authorization: "Bearer test-admin-token" };
  const page = await app.request(url, { headers: auth });
  const fields = { ...hidden(await page.text()), confirmFullAccess: "1" };
  const request = { ...form(fields), headers: { ...form(fields).headers, ...auth } };
  expect((await app.request(url, request)).status).toBe(302);
  expect((await app.request(url, request)).status).toBe(409);
  const first = engine.agents.get(agentId)!;
  expect(engine.agents.listLocalExecutionGrants(agentId)[0]?.source).toBe("authenticated-admin");
  const rollback = await app.request(`/agents/${agentId}/revisions/${first.publishedRevisionId}/rollback`, {
    ...form({ expectedHeadRevisionId: first.publishedRevisionId! }), headers: { ...form({}).headers, ...auth },
  });
  expect(rollback.headers.get("location")).toContain("/local-execution");
  expect(engine.agents.listLocalExecutionGrants(agentId)).toHaveLength(1);
  const target = rollback.headers.get("location")!;
  const confirmation = hidden(await (await app.request(target, { headers: auth })).text());
  expect((await app.request(target, { ...form({ ...confirmation, confirmFullAccess: "1" }), headers: { ...form({}).headers, ...auth } })).status).toBe(302);
  expect(engine.agents.listLocalExecutionGrants(agentId)).toHaveLength(2);
  expect(engine.agents.get(agentId)?.publishedRevisionId).not.toBe(first.publishedRevisionId);
});

test("failed HTTP publication and revocation preserve durable authorization and return bounded diagnostics", async () => {
  const { app, url, fields } = await confirmationPage();
  const path = join(root, "data", "config", "agents.json");
  const block = () => { renameSync(path, `${path}.saved`); mkdirSync(path); };
  const restore = () => { rmSync(path, { recursive: true }); renameSync(`${path}.saved`, path); };
  block();
  try {
    const failed = await app.request(url, form(fields));
    expect(failed.status).toBe(409);
    expect((await failed.text()).includes(root)).toBe(false);
    expect(engine.agents.listLocalExecutionGrants(agentId)).toEqual([]);
  } finally { restore(); }
  expect((await app.request(url, form(fields))).status).toBe(302);
  const grants = engine.agents.listLocalExecutionGrants(agentId);
  const published = engine.agents.get(agentId)!;
  block();
  try {
    expect((await app.request(`/agents/${agentId}/local-execution/revoke`, form({ csrfToken: fields.csrfToken!, expectedHeadRevisionId: published.publishedRevisionId! }))).status).toBe(409);
    expect(engine.agents.listLocalExecutionGrants(agentId)).toEqual(grants);
  } finally { restore(); }
});

test("full pages and stale sandbox polling never request isolation; an explicit isolated recovery does", async () => {
  const requested: boolean[] = [];
  const app = createWebApp({ engine, providerModels: async () => ({}), detectProviders: async options => {
    requested.push(options?.codexNativeIsolation === true);
    return options?.codexNativeIsolation ? providers : providers.map(provider => ({ ...provider, nativeSessions: undefined, nativeSessionIssue: undefined }));
  } });
  const { url, fields } = await confirmationPage(app);
  expect((await app.request(url, form(fields))).status).toBe(302);
  await app.request(`/agents/${agentId}`);
  await app.request(`/agents/${agentId}/provider/recover`, form({}));
  await app.request(`/agents/${agentId}/provider/windows-sandbox/session`);
  expect((await app.request(`/agents/${agentId}/provider/windows-sandbox`, form({}))).status).toBe(409);
  expect(requested.some(Boolean)).toBe(false);
  const draft = engine.saveAgentDraft(agentId, { executionMode: "isolated", permission: "read-only" })!;
  engine.releaseAgent(agentId, draft.id, draft.id);
  await app.request(`/agents/${agentId}/provider/recover`, form({}));
  expect(requested.filter(Boolean)).toHaveLength(1);
});

test("confirmation requires a connected CLI and a token from the current application instance", async () => {
  const unavailable = createWebApp({ engine, detectProviders: async () => providers.map(provider => ({ ...provider, available: false })) });
  const { url, fields } = await confirmationPage(unavailable);
  const failed = await unavailable.request(url, form(fields));
  expect(failed.status).toBe(409);
  expect(await failed.text()).toContain("CLI 尚未连接");
  expect((await appFor().request(url, form(fields))).status).toBe(403);
  expect(engine.agents.listLocalExecutionGrants(agentId)).toEqual([]);
});

test("Chat confirmation defaults Task off, shows new scopes pending, and isolated publication revokes old grants", async () => {
  const { app, url, fields } = await confirmationPage();
  expect((await app.request(url, form(fields))).status).toBe(302);
  const published = engine.agents.get(agentId)!;
  expect(engine.agents.listLocalExecutionGrants(agentId)[0]?.taskExecutionEnabled).toBe(false);
  expect(engine.localExecution.referenceFor(space, agentId, published.publishedRevisionId!, "task")).toBeUndefined();
  const added = "team/oc_pending" as const;
  await engine.ensureSpace(added);
  engine.registry.updateMeta(added, { agentId });
  engine.feishuBindings.connect({ spaceId: added, chatId: "oc_pending", boundAppId: "cli_fixture", responseMode: "mentions_only", replyInThread: true });
  const page = await (await app.request(`/agents/${agentId}`)).text();
  expect(page).toContain("已确认 1 个 Chat 范围");
  expect(page).toContain("1 个范围待确认");
  expect(engine.localExecution.referenceFor(added, agentId, published.publishedRevisionId!, "chat")).toBeUndefined();
  const result = await app.request(`/agents/${agentId}`, form({ executionMode: "isolated", permission: "read-only", agentAction: "publish", expectedHeadRevisionId: published.publishedRevisionId! }));
  expect(result.status).toBe(302);
  expect(result.headers.get("location")).not.toContain("/local-execution");
  expect(engine.agents.get(agentId)?.executionMode).toBe("isolated");
  expect(engine.agents.listLocalExecutionGrants(agentId).every(grant => grant.revokedAt !== undefined)).toBe(true);
});

test("confirmation cannot bypass the Engine visibility check for existing Team Space bindings", async () => {
  const app = appFor();
  const draft = engine.saveAgentDraft(agentId, { visibility: "Personal", executionMode: "local-full-access", permission: "full", workdir })!;
  const url = `/agents/${agentId}/revisions/${draft.id}/local-execution`;
  const page = await app.request(url);
  expect(page.status).toBe(200);
  const response = await app.request(url, form({ ...hidden(await page.text()), confirmFullAccess: "1" }));
  expect(response.status).toBe(409);
  expect(await response.text()).toContain("Visibility");
  expect(engine.agents.listLocalExecutionGrants(agentId)).toEqual([]);
});

test("the current published Agent has a protected readiness action; GET never probes and stale forms cannot check a replacement", async () => {
  const app = appFor();
  const page = await (await app.request(`/agents/${agentId}`)).text();
  expect(page).toContain("检测当前发布配置");
  const cached = await app.request(`/agents/${agentId}/readiness`);
  expect(cached.status).toBe(200);
  expect(await cached.json()).toMatchObject({ state: "unknown" });
  const fields = hidden(page);
  const request = form({ csrfToken: fields.csrfToken!, expectedPublishedRevisionId: fields.expectedPublishedRevisionId! });
  expect((await app.request(`/agents/${agentId}/readiness`, request)).status).toBe(302);
  expect(engine.agentReadiness.status(agentId)?.state).toBe("ready");
  const readyPage = await (await app.request(`/agents/${agentId}`)).text();
  expect(readyPage).toContain("当前配置准备通过");
  expect(readyPage).toContain("实际模型调用未验证");
  const draft = engine.saveAgentDraft(agentId, { instruction: "replacement" })!;
  engine.releaseAgent(agentId, draft.id, draft.id);
  expect((await app.request(`/agents/${agentId}/readiness`, request)).status).toBe(409);
  expect((await app.request(`/agents/${agentId}/readiness`, { ...request, headers: { ...request.headers, origin: "https://attacker.example" } })).status).toBe(403);
  expect(engine.agents.listLocalExecutionGrants(agentId)).toEqual([]);
});

test("revision history shows mode intent and Run authorization uses the frozen reference, not today's revision", async () => {
  const { app, url, fields } = await confirmationPage();
  await app.request(url, form(fields));
  const plan = engine.agentRunExecutionSnapshot(space).executionPlan;
  expect(localExecutionRunStatus(engine, space, agentId, plan, "chat")).toContain("本机确认当前有效");
  const page = await (await app.request(`/agents/${agentId}`)).text();
  expect(page).toContain("版本模式：本机完全访问（未隔离）");
  engine.agents.revokeLocalExecutionGrants(agentId, engine.agents.get(agentId)!.publishedRevisionId!);
  expect(localExecutionRunStatus(engine, space, agentId, plan, "chat")).toContain("已撤销、失效或未授权");
});
