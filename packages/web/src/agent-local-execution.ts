import type { Hono } from "hono";
import { html } from "hono/html";
import { isResolvedExecutionPlan, type KnowledgeEngine, type StoredExecutionPlan } from "@homeagent/core";
import type { SpaceId } from "@homeagent/shared";
import type { DetectedProvider } from "@homeagent/llm";
import { layout } from "./layout.ts";
import type { AgentLocalExecutionView } from "./agent-workbench.ts";

export const localExecutionConfirmationUrl = (agentId: string, revisionId: string) =>
  `/agents/${encodeURIComponent(agentId)}/revisions/${encodeURIComponent(revisionId)}/local-execution`;

export function localExecutionRunStatus(engine: KnowledgeEngine, space: SpaceId, agentId: string | undefined, plan: StoredExecutionPlan | undefined, kind: "chat" | "task"): string | undefined {
  if (plan?.provider !== "codex" || plan.execution?.permission !== "full") return undefined;
  if (plan.execution.executionMode !== "local-full-access") return "旧 full 配置未确认，不能恢复执行";
  return isResolvedExecutionPlan(plan) && agentId && plan.agentRevisionId && plan.localExecution
    && engine.localExecution.validateReference(space, agentId, plan.agentRevisionId, kind, plan.localExecution)
    ? "冻结运行的本机确认当前有效；不代替 Task 的逐次审批"
    : "冻结运行的本机确认已撤销、失效或未授权；不能用当前配置替换旧计划重试";
}

export function localExecutionWorkbenchState(engine: KnowledgeEngine, agentId: string, csrfToken: string): AgentLocalExecutionView | undefined {
  const agent = engine.agents.get(agentId);
  if (!agent) return undefined;
  const draft = engine.agents.getDraft(agentId);
  if (agent.executionMode !== "local-full-access" && draft?.snapshot.executionMode !== "local-full-access") return undefined;
  const grants = engine.agents.listLocalExecutionGrants(agentId).filter(grant => grant.revokedAt === undefined);
  const current = grants.find(grant => grant.agentRevisionId === agent.publishedRevisionId);
  let scopes;
  try { scopes = engine.localExecution.preview(agentId).chatScopes; } catch { scopes = undefined; }
  const confirmedScopes = scopes?.filter(scope => current?.chatScopes.some(confirmed => confirmed.spaceId === scope.spaceId && confirmed.policyHash === scope.policyHash)).length ?? 0;
  const targetId = draft?.snapshot.executionMode === "local-full-access" ? draft.id
    : agent.executionMode === "local-full-access" ? agent.publishedRevisionId : undefined;
  return { csrfToken, confirmationUrl: targetId ? localExecutionConfirmationUrl(agentId, targetId) : undefined,
    confirmed: Boolean(current) && scopes !== undefined, confirmedScopes,
    pendingScopes: scopes ? scopes.length - confirmedScopes : engine.agentBindings(agentId).length,
    taskExecutionEnabled: current?.taskExecutionEnabled ?? false, activeGrants: grants.length };
}

function publicError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("版本已变化")) return "Agent 版本已变化，请返回工作台刷新后重新确认。";
  if (message.includes("绑定范围已变化")) return "绑定范围已变化，本次未发布；请重新检查完整范围并确认。";
  if (message.includes("无法安全清理")) return "本机确认数量或容量已满，无法安全清理仍在使用的确认；本次未发布。";
  if (message.includes("execution-mode-invalid")) return "Workdir 无效、已变化或与 HomeAgent 数据/状态目录重叠；本次未发布。";
  if (message.includes("不兼容的空间绑定")) return "Visibility 与现有空间绑定不兼容；请先解除不兼容的绑定。";
  return "操作未完成，发布版本和本机确认未改变；请返回工作台检查后重试。";
}

/** Additional guard for local authority: never trust forwarding headers as an Origin allowlist. */
function sameOrigin(request: Request): boolean {
  if (request.headers.get("sec-fetch-site") === "cross-site") return false;
  const url = new URL(request.url);
  const host = request.headers.get("host");
  if (host && host !== url.host) return false;
  const origin = request.headers.get("origin");
  if (!origin) return true; // A same-instance form token is still mandatory.
  try { return new URL(origin).origin === url.origin; } catch { return false; }
}

/** Dedicated bounded URL-encoded form; duplicate/unknown fields cannot alter consent semantics. */
async function readForm(request: Request, allowed: readonly string[]): Promise<URLSearchParams | undefined> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/x-www-form-urlencoded")) return undefined;
  const reader = request.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8192) { await reader.cancel(); return undefined; }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const params = new URLSearchParams(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  for (const key of params.keys()) if (!allowed.includes(key) || params.getAll(key).length !== 1) return undefined;
  return params;
}

export function registerAgentLocalExecutionRoutes(app: Hono, options: {
  engine: KnowledgeEngine;
  csrfToken: string;
  authenticated: boolean;
  providers: () => Promise<DetectedProvider[]>;
}): void {
  const { engine, csrfToken } = options;
  const route = "/agents/:id/revisions/:revisionId/local-execution";
  const commonFields = ["csrfToken", "expectedHeadRevisionId"];

  app.get("/agents/:id/readiness", c => {
    c.header("cache-control", "no-store");
    const status = engine.agentReadiness.status(c.req.param("id"));
    return status ? c.json(status) : c.notFound();
  });
  app.post("/agents/:id/readiness", async c => {
    c.header("cache-control", "no-store");
    if (!sameOrigin(c.req.raw)) return c.text("Forbidden", 403);
    let body: URLSearchParams | undefined;
    try { body = await readForm(c.req.raw, ["csrfToken", "expectedPublishedRevisionId"]); }
    catch { return c.text("检测表单无效。", 400); }
    if (!body) return c.text("检测表单无效。", 400);
    if (body.get("csrfToken") !== csrfToken) return c.text("Forbidden", 403);
    const id = c.req.param("id");
    const agent = engine.agents.get(id);
    if (!agent || agent.provider !== "codex") return c.notFound();
    if (body.get("expectedPublishedRevisionId") !== agent.publishedRevisionId) return c.text("发布版本已变化，请刷新后检测。", 409);
    try {
      const status = await engine.agentReadiness.check(id);
      if (status?.reason === "busy") return c.text("已有两个 Agent 正在检测，请稍后重试。", 503);
      return c.redirect(`/agents/${encodeURIComponent(id)}`);
    } catch { return c.text("当前配置检测未完成，请重试。", 503); }
  });

  app.get(route, async c => {
    c.header("cache-control", "no-store");
    // Chromium uses this policy for the navigation POST's Origin too. Keep a
    // same-origin form verifiable while suppressing referrers to other origins.
    c.header("referrer-policy", "same-origin");
    const id = c.req.param("id");
    const revisionId = c.req.param("revisionId");
    const agent = engine.agents.get(id);
    const revisions = engine.agents.listRevisions(id);
    const target = revisions.find(revision => revision.id === revisionId);
    if (!agent || !target) return c.notFound();
    if (target.snapshot.provider !== "codex" || target.snapshot.executionMode !== "local-full-access" || target.snapshot.permission !== "full") {
      return c.text("请先在工作台明确选择本机完全访问及 full，并保存草稿。", 409);
    }
    if (target.source === "draft" && target.id !== revisions[0]?.id) return c.text("草稿已变化，请刷新后重新确认。", 409);
    try {
      const preview = engine.localExecution.preview(id, revisionId);
      const activeOldRuns = [...engine.chatRuns.list(), ...engine.taskRuns.list()].filter(run => run.agentId === id
        && ["queued", "running", "awaiting_approval"].includes(run.status)).length;
      return c.html(await layout("确认本机完全访问", [{ label: "Agents", href: "/agents" }, { label: agent.name, href: `/agents/${encodeURIComponent(id)}` }, { label: "确认发布" }], html`
        <section class="agent-consent" style="max-width:760px;margin:24px auto;line-height:1.65">
          <p class="muted">CODEX · 本机执行授权</p>
          <h1>确认本机完全访问（无沙箱）</h1>
          <p role="note" style="border-left:4px solid #b7791f;padding:12px 18px;background:#fff8e6;color:#623e0a">
            Codex 将以 HomeAgent 运行账户的权限执行，可能访问工作目录外文件和网络。Workdir 不是访问控制，也不会自动获得 Windows 管理员权限。
          </p>
          <dl><dt>Agent / 来源版本</dt><dd>${agent.name} · v${target.number}（${target.source === "draft" ? "草稿" : "历史配置重新发布"}）</dd>
            <dt>Model / 推理强度</dt><dd>${target.snapshot.model || "CLI 默认模型"} / ${target.snapshot.reasoningEffort || "默认"}</dd>
            <dt>Permission / Workdir</dt><dd>full · <code>${target.snapshot.workdir || "未配置"}</code></dd>
            <dt>Instruction</dt><dd style="white-space:pre-wrap;overflow-wrap:anywhere">${target.snapshot.instruction || "未配置"}</dd></dl>
          <h2>本次完整 Chat 范围（${preview.chatScopes.length}）</h2>
          <p>这些空间中的群成员消息可能触发本机执行。HomeAgent 仍只主动提供对应 Space 的上下文，但 Provider 工具没有文件和网络隔离。</p>
          <ul>${preview.chatScopes.map(scope => {
            const meta = engine.registry.get(scope.spaceId);
            const binding = engine.feishuBindings.getBySpace(scope.spaceId);
            return html`<li>${meta?.name || scope.spaceId} · ${scope.spaceId}${binding ? html` · Bot ${binding.boundAppId} · ${binding.responseMode} / ${binding.participationLevel || "默认"} · ${binding.replyInThread ? "话题内回复" : "群内回复"}` : " · 私聊"}</li>`;
          })}</ul>
          ${preview.chatScopes.length === 0 ? html`<p>当前没有可确认的 Chat 绑定；以后新增或变更绑定，需要再次确认并发布。</p>` : ""}
          <p>此操作产生新版本和新确认；下一条话题请求会新建会话链。现有 ${activeOldRuns} 条非终态运行保留旧计划；未撤销的旧确认仍可使用。切回隔离或撤销会停止相关完全访问调用，已发生的外部效果不能回滚。</p>
          <form method="post" action="${localExecutionConfirmationUrl(id, revisionId)}">
            <input type="hidden" name="csrfToken" value="${csrfToken}" />
            <input type="hidden" name="expectedHeadRevisionId" value="${revisions[0]!.id}" />
            <input type="hidden" name="expectedScopeFingerprint" value="${preview.fingerprint}" />
            <input type="hidden" name="termsVersion" value="1" />
            <p><label><input type="checkbox" name="taskExecutionEnabled" value="1" /> 同时允许显式 Task 使用本机完全访问（每个 Task 仍须单独人工审批）</label></p>
            <p><label><input type="checkbox" name="confirmFullAccess" value="1" required /> 我已了解无沙箱风险，允许上述范围以 HomeAgent 运行账户权限执行。</label></p>
            <button type="submit">确认并发布新版本</button> <a href="/agents/${encodeURIComponent(id)}">返回工作台，不发布</a>
          </form>
          <p class="muted">发布不代表模型、网络或飞书权限已经验证；隔离失败不会自动降级为完全访问。默认不启用此模式。</p>
        </section>`, "agents"));
    } catch (error) { return c.text(publicError(error), 409); }
  });

  app.post(route, async c => {
    c.header("cache-control", "no-store");
    if (!sameOrigin(c.req.raw)) return c.text("Forbidden", 403);
    let body: URLSearchParams | undefined;
    try { body = await readForm(c.req.raw, [...commonFields, "expectedScopeFingerprint", "termsVersion", "confirmFullAccess", "taskExecutionEnabled"]); }
    catch { return c.text("确认表单无效，请刷新后重试。", 400); }
    if (!body) return c.text("确认表单无效，请刷新后重试。", 400);
    if (body.get("csrfToken") !== csrfToken) return c.text("Forbidden", 403);
    if (body.get("confirmFullAccess") !== "1" || body.get("termsVersion") !== "1"
      || (body.has("taskExecutionEnabled") && body.get("taskExecutionEnabled") !== "1")) return c.text("请明确勾选本机完全访问确认。", 422);
    const id = c.req.param("id");
    const revisionId = c.req.param("revisionId");
    const target = engine.agents.listRevisions(id).find(revision => revision.id === revisionId);
    if (!target) return c.notFound();
    if (target.snapshot.provider !== "codex" || target.snapshot.executionMode !== "local-full-access" || target.snapshot.permission !== "full") return c.text("执行模式与确认不匹配。", 409);
    try {
      const provider = (await options.providers()).find(provider => provider.id === "codex");
      if (!provider?.available) return c.text("Codex CLI 尚未连接；请先恢复本机连接，再确认发布。", 409);
      const confirmation = { termsVersion: 1 as const, source: options.authenticated ? "authenticated-admin" as const : "local-operator" as const,
        taskExecutionEnabled: body.get("taskExecutionEnabled") === "1", expectedScopeFingerprint: body.get("expectedScopeFingerprint") ?? "" };
      const head = body.get("expectedHeadRevisionId") ?? "";
      const published = target.source === "draft"
        ? engine.releaseAgent(id, revisionId, head, confirmation)
        : engine.rollbackAgent(id, revisionId, head, confirmation);
      if (!published) return c.text("版本已变化，请刷新后重新确认。", 409);
      return c.redirect(`/agents/${encodeURIComponent(id)}?ok=${encodeURIComponent("本机完全访问已确认并发布；未启用沙箱，实际调用尚待验证")}`);
    } catch (error) { return c.text(publicError(error), 409); }
  });

  app.post("/agents/:id/local-execution/revoke", async c => {
    c.header("cache-control", "no-store");
    if (!sameOrigin(c.req.raw)) return c.text("Forbidden", 403);
    let body: URLSearchParams | undefined;
    try { body = await readForm(c.req.raw, commonFields); } catch { return c.text("撤销表单无效。", 400); }
    if (!body) return c.text("撤销表单无效。", 400);
    if (body.get("csrfToken") !== csrfToken) return c.text("Forbidden", 403);
    const id = c.req.param("id");
    if (!engine.agents.has(id)) return c.notFound();
    try {
      engine.agents.revokeLocalExecutionGrants(id, body.get("expectedHeadRevisionId") ?? "");
      return c.redirect(`/agents/${encodeURIComponent(id)}?ok=${encodeURIComponent("完全访问确认已撤销；相关在途调用已请求取消，已发生的外部效果不能回滚")}`);
    } catch (error) { return c.text(publicError(error), 409); }
  });
}
