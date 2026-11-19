import { html, raw } from "hono/html";
import { EXECUTION_POLICY_ISSUE_LABELS, NATIVE_SESSION_ISSUE_LABELS } from "@homeagent/llm";
import { agentDetailUrl, type AgentBindingView, type AgentWorkbenchView } from "./agent-workbench.ts";

function responsibility(instruction: string) {
  const text = instruction.trim();
  if (!text) return html`<p class="overview-muted">尚未填写职责。</p>`;
  const compact = text.replace(/\s+/gu, " ");
  const chars = Array.from(compact);
  if (chars.length <= 120 && text.split(/\r?\n/u).length <= 3) {
    return html`<p class="overview-instruction">${text}</p>`;
  }
  return html`<p class="overview-preview">${chars.slice(0, 120).join("")}${chars.length > 120 ? "…" : ""}</p>
    <details><summary>完整职责</summary><p class="overview-instruction">${text}</p></details>`;
}

function spaceLinks(bindings: AgentBindingView[]) {
  return html`<ul class="overview-space-list">${bindings.map((space) => html`
    <li><a href="/spaces/${encodeURIComponent(space.id)}">${space.label}</a>
      <span>${space.typeLabel}</span></li>`)}</ul>`;
}

export function agentOverviewView(view: AgentWorkbenchView) {
  const agent = view.selected;
  const inspector = view.inspector;
  if (!agent || !inspector) throw new Error("Agent overview requires a selected Agent");
  const { bindings, provider } = inspector;
  const readiness = view.readiness?.snapshot;
  const checkedState = readiness?.state;
  const cliIssue = Boolean(provider.recovery);
  const status = cliIssue ? provider.statusLabel
    : checkedState ? {
      unknown: "配置待检测", checking: "正在检测", ready: "准备检查通过", unavailable: "准备检查未通过",
    }[checkedState] : provider.statusLabel;
  const failure = readiness?.failure;
  const failureLabel = failure?.stage === "native-session" ? NATIVE_SESSION_ISSUE_LABELS[failure.reason]
    : failure?.stage === "execution-policy" ? EXECUTION_POLICY_ISSUE_LABELS[failure.reason]
    : failure ? "冻结 Skill 副本容量超限" : undefined;
  const tone = cliIssue || checkedState === "unavailable" ? "issue"
    : checkedState === "ready" || (!readiness && !provider.recovery) ? "ready" : "pending";
  const base = agentDetailUrl(agent.id);
  const publishedNumber = view.revision?.publishedRevisionNumber;
  const fullAccess = agent.executionMode === "local-full-access";
  const recovery = provider.recovery;
  return html`<div class="agent-overview" data-agent-overview>
    <a class="overview-back" href="/agents?view=list">返回助手列表</a>
    ${view.flash ? html`<p class="agent-flash" role="status">${view.flash}</p>` : ""}
    <header class="overview-header">
      <div><h1>${agent.name}</h1>
        <p class="overview-version">已发布${publishedNumber ? ` · v${publishedNumber}` : ""}${view.revision?.draftRevisionId ? " · 有未发布草稿" : ""}</p>
      </div>
      <a class="agent-primary overview-edit" href="${agentDetailUrl(agent.id, { edit: true })}">编辑配置</a>
    </header>
    <section class="overview-responsibility"><h2>职责</h2>${responsibility(agent.instruction)}</section>
    <div class="overview-facts">
      <section><h2>绑定空间 <span class="agent-count">${bindings.length}</span></h2>
        ${bindings.length ? spaceLinks(bindings.slice(0, 3)) : html`<p class="overview-muted">尚未绑定任何空间。</p>`}
        ${bindings.length > 3 ? html`<details><summary>其余 ${bindings.length - 3} 个空间</summary>${spaceLinks(bindings.slice(3))}</details>` : ""}
      </section>
      <section data-agent-readiness="${checkedState ?? "cli"}">
        <h2>可用状态</h2>
        <p class="overview-state ${tone}"><strong>${status}</strong></p>
        <p class="overview-muted">${provider.name}${readiness && !cliIssue && !fullAccess ? ` · ${provider.statusLabel}` : ""}${agent.provider === "trae-cli" ? " · 仅支持研究任务" : ""}。实际模型调用未验证。</p>
        ${fullAccess ? html`<p>本机完全访问 · 未隔离</p>
          <p>${view.localExecution?.confirmed ? `已确认 ${view.localExecution.confirmedScopes} 个 Chat 范围` : "当前发布版本等待本机确认"}${view.localExecution?.pendingScopes ? ` · ${view.localExecution.pendingScopes} 个范围待确认` : ""}</p>` : ""}
        ${failureLabel ? html`<p>${failureLabel}</p>` : ""}
        ${readiness?.reason === "expired" ? html`<p class="overview-muted">上次检查已过期，请重新检测。</p>` : ""}
        ${readiness?.checkedAt ? html`<p class="overview-muted">上次检测 ${new Date(readiness.checkedAt).toLocaleTimeString("zh-CN", { hour12:false })}（结果有效期 60 秒）</p>` : ""}
        <div class="overview-actions">
          ${checkedState === "checking" ? html`<a href="${base}">刷新检测状态</a>` : view.readiness ? html`<form method="post" action="${base}/readiness">
            <input type="hidden" name="csrfToken" value="${view.readiness.csrfToken}" />
            <input type="hidden" name="expectedPublishedRevisionId" value="${agent.publishedRevisionId}" />
            <button type="submit" class="agent-secondary">检测当前发布配置</button>
          </form>` : ""}
          ${recovery ? html`<a href="${agentDetailUrl(agent.id, { edit: true })}#agent-provider-status">查看恢复选项</a>` : ""}
        </div>
        ${readiness?.expiresAt && !cliIssue ? html`<script data-expires-at="${readiness.expiresAt}">${raw(`{
          const script = document.currentScript;
          const section = script.closest('[data-agent-readiness]');
          setTimeout(() => {
            section.dataset.agentReadiness = 'unknown';
            const state = section.querySelector('.overview-state');
            state.className = 'overview-state pending';
            state.querySelector('strong').textContent = '上次检查已过期，请重新检测';
          }, Math.max(0, Number(script.dataset.expiresAt) - Date.now()));
        }`)}</script>` : ""}
      </section>
    </div>
  </div>`;
}
