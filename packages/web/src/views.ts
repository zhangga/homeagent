/**
 * Individual page bodies for the management backend. Each is a pure function of
 * data already loaded by the routes, returning an html fragment for `layout`.
 * Auto-escaping is on by default (hono/html); `raw()` is used only for trusted
 * static markup. Mutating pages render POST forms.
 */
import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import type {
  AskResult,
  Citation,
  PageRef,
  RawRecord,
  SpaceId,
  Page,
  SystemHealthSnapshot,
  LarkProvisioningSession,
  LarkSetupStatus,
  LarkChatSummary,
} from "@homeagent/shared";
import {
  MAX_CHAT_TIMEOUT_MINUTES,
  MIN_CHAT_TIMEOUT_MINUTES,
} from "@homeagent/shared";
import type {
  SpaceMeta,
  Agent,
  ChatRun,
  Task,
  TaskRun,
  Reminder,
  LearningPlan,
  LearningSession,
  LearningSource,
  KnowledgeGovernanceSnapshot,
  KnowledgePageTrace,
  RawGovernanceDetail,
  QuarantineRecord,
  AnswerFeedbackReview,
  QualitySnapshot,
  QualityRerun,
  RunQueueInfo,
  AggregatedRunUsage,
  WorkItem,
  WorkAction,
  WorkContinuationPolicy,
  AgentKnowledgeFeedback,
  AgentKnowledgeFeedbackManualResolutionKind,
} from "@homeagent/core";
import {
  ANSWER_FEEDBACK_KINDS,
  AGENT_PERMISSIONS,
  DEFAULT_TASK_TIMEOUT_MINUTES,
  isKnowledgeContentRef,
  resolveGroupParticipationLevel,
  MAX_TASK_NOTIFICATION_ATTEMPTS,
  TASK_CADENCES,
  learningProgress,
  skillWarningViews,
} from "@homeagent/core";
import {
  codexReasoningEffortsForModel,
  providerSupportsOrdinaryCompletion,
  type DetectedProvider,
} from "@homeagent/llm";
import type { FeishuRuntimeStatus } from "./integrations.ts";
import type {
  FeishuGroupIntegrationView,
  FeishuIntegrationSnapshot,
} from "./feishu-integration-service.ts";
import {
  deriveFeishuConnectionProgress,
  type FeishuConnectionProgress,
} from "./feishu-connection-progress.ts";
import { feishuProgressBrowserScript } from "./feishu-progress-client.ts";
import type { FeishuExternalSharingStatus } from "./external-sharing.ts";
import {
  feishuProvisioningPollScript,
  isFeishuProvisioningActive,
  isFeishuProvisioningFailure,
} from "./feishu-provisioning-view.ts";
import { safeLarkVerificationUrl } from "./verification-url.ts";

const ANSWER_FEEDBACK_LABELS = {
  helpful: "有帮助",
  unhelpful: "没帮助",
  citation_error: "引用有误",
} as const satisfies Record<(typeof ANSWER_FEEDBACK_KINDS)[number], string>;
const AGENT_KNOWLEDGE_FEEDBACK_LABELS = {
  helpful: "有帮助",
  not_found: "没有找到",
  incorrect: "内容不正确",
  stale: "内容已过时",
  conflicting: "知识有冲突",
  hard_to_reuse: "难以复用",
} as const;
const AGENT_KNOWLEDGE_RESOLUTION_LABELS = {
  helpful_acknowledged: "正向信号已确认",
  knowledge_changed: "知识页已变更",
  knowledge_confirmed: "人工复核后确认有效",
  coverage_recorded: "已记录知识覆盖计划",
  duplicate: "重复反馈",
  not_actionable: "无需处理",
} as const;
const SINGLETON = new Set(["index", "overview", "log", "glossary"]);
const GROUP_PARTICIPATION_LABELS = {
  reserved: "稳重",
  balanced: "均衡",
  active: "积极",
} as const;

export interface QualityReviewViewItem {
  review: AnswerFeedbackReview;
  citations: Array<{ citation: Citation; spaces: SpaceId[] }>;
}

function fmtTime(ms?: number): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
}

function citationEvidenceView(citation: Citation): HtmlEscapedString | Promise<HtmlEscapedString> | string {
  const evidence = citation.evidence;
  if (!evidence) return "";
  const hasValidTime = typeof evidence.latestSourceAt === "number"
    && Number.isFinite(evidence.latestSourceAt)
    && Math.abs(evidence.latestSourceAt) <= 8_640_000_000_000_000;
  const freshness = {
    recent: "证据较新",
    aging: "证据较久",
    stale: "证据陈旧",
    unknown: "证据时间未知",
  }[evidence.freshness];
  const sourceCount = Number.isInteger(evidence.sourceCount) && evidence.sourceCount >= 0
    ? `${evidence.sourceCount} 条 Raw`
    : "Raw 数量未知";
  return html`<span>（${hasValidTime ? html`最新证据：${fmtTime(evidence.latestSourceAt)}` : "证据时间未知"}
    · ${freshness} · ${sourceCount}${evidence.complete ? "" : " · 证据链不完整"}）</span>`;
}

function flash(msg?: string): HtmlEscapedString | Promise<HtmlEscapedString> | string {
  return msg ? html`<div class="flash" role="status" aria-live="polite">${msg}</div>` : "";
}

function runUsageView(usage: AggregatedRunUsage): HtmlEscapedString | Promise<HtmlEscapedString> {
  const tokenParts = [
    usage.inputTokens === undefined ? undefined : `输入 ${usage.inputTokens}`,
    usage.cachedInputTokens === undefined ? undefined : `缓存输入 ${usage.cachedInputTokens}`,
    usage.cacheCreationInputTokens === undefined
      ? undefined
      : `新建缓存 ${usage.cacheCreationInputTokens}`,
    usage.outputTokens === undefined ? undefined : `输出 ${usage.outputTokens}`,
    usage.reasoningTokens === undefined ? undefined : `推理 ${usage.reasoningTokens}`,
  ].filter((part): part is string => Boolean(part));
  const costBasis = usage.costBasis === "reported"
    ? "Provider 报告"
    : usage.costBasis === "estimated"
      ? "估算"
      : usage.costBasis === "mixed"
        ? "混合口径"
        : "不可用";
  return html`<div><strong>用量：</strong>调用 ${usage.calls} 次
    · token 可见 ${usage.knownTokenCalls}/${usage.calls}
    · 成本可见 ${usage.knownCostCalls}/${usage.calls}
    ${tokenParts.length > 0 ? ` · ${tokenParts.join(" / ")}` : ""}
    ${usage.costUsd === undefined ? " · 成本未知" : ` · $${usage.costUsd.toFixed(6)}（${costBasis}）`}
  </div>`;
}

/** A friendly label for a space: its display name, else the id. */
function spaceLabel(meta: SpaceMeta): string {
  return meta.name?.trim() || meta.id;
}

// ---- spaces / knowledge (adapted from the read-only viewer) ----------------

export function spaceListView(
  spaces: { meta: SpaceMeta; pages: number; pending: number }[],
): HtmlEscapedString | Promise<HtmlEscapedString> {
  if (spaces.length === 0) {
    return html`<h1>空间 / 知识</h1>
      <div class="empty">还没有任何空间。把机器人加入飞书群或私聊它即可创建。</div>`;
  }
  const rows = spaces.map(
    (s) => html`<tr>
      <td><a href="/spaces/${encodeURIComponent(s.meta.id)}">${spaceLabel(s.meta)}</a>
        <div class="muted">${s.meta.id}</div></td>
      <td>${s.pages}</td>
      <td>${s.pending}</td>
      <td class="muted">${fmtTime(s.meta.lastDreamAt)}</td>
    </tr>`,
  );
  return html`<h1>空间 / 知识</h1>
    <p class="subtitle">每个飞书群或私聊对应一个知识空间。</p>
    <table>
      <tr><th>空间</th><th>知识页</th><th>待提炼</th><th>上次提炼</th></tr>
      ${rows}
    </table>`;
}

export function spaceDetailView(
  space: SpaceId,
  pages: PageRef[],
  rawCount: number,
  quarantineCount: number,
  meta?: SpaceMeta,
  agents: Agent[] = [],
  flashMsg?: string,
  topLevelMapLinks?: string[],
): HtmlEscapedString | Promise<HtmlEscapedString> {
  const topLevelMapSlugs = new Set(topLevelMapLinks ?? []);
  const maps = pages.filter((page) =>
    page.type === "map" && (topLevelMapSlugs.size === 0 || topLevelMapSlugs.has(page.slug))
  );
  const content = pages.filter((page) => page.type !== "map" && !SINGLETON.has(page.slug));
  const enc = encodeURIComponent(space);
  const isTeam = space.startsWith("team/");
  const pageRows = content.length
    ? content.map(
        (p) => html`<tr>
          <td><a href="/spaces/${enc}/pages/${encodeURIComponent(p.slug)}">${p.title}</a></td>
          <td><span class="tag">${p.type}</span></td>
          <td class="muted">${p.summary}</td>
        </tr>`,
      )
    : [html`<tr><td colspan="3" class="empty">暂无知识页，运行提炼后生成。</td></tr>`];
  const mapRows = maps.map((page) => html`<tr>
    <td><a href="/spaces/${enc}/pages/${encodeURIComponent(page.slug)}">${page.title}</a>
      <div class="muted">${page.slug}</div></td>
    <td class="muted">${page.summary}</td>
  </tr>`);

  const groupSettingsLink = isTeam
    ? html` · <a href="/integrations">群设置</a>`
    : "";
  const personalAgentSettings = !isTeam
    ? html`<div class="card">
        <h2 style="margin-top:0">个人空间 Agent</h2>
        <p class="muted">这里只显示 Visibility 为 Personal 的 Agent；留空时使用全局默认 Provider。</p>
        <form method="post" action="/spaces/${enc}/agent" class="row">
          <select name="agentId">
            <option value="" ${!meta?.agentId ? "selected" : ""}>默认（全局）</option>
            ${agents
              .filter((agent) => agent.visibility === "Personal")
              .map((agent) => html`<option value="${agent.id}" ${agent.id === meta?.agentId ? "selected" : ""}>${agent.name}</option>`)}
          </select>
          <button type="submit">保存 Agent</button>
        </form>
      </div>`
    : "";

  return html`<h1>${meta ? spaceLabel(meta) : space}</h1>
    <p class="subtitle">${space}</p>
    ${flash(flashMsg)}
    <div class="card">
      <div class="muted">绑定群：${meta?.chatId ?? "—"} · 上次提炼：${fmtTime(meta?.lastDreamAt)}
        · 上次 Wiki 维护：${fmtTime(meta?.lastMaintenanceAt)}
        ${meta?.lastMaintenanceIssueCount === undefined
          ? ""
          : `（${meta.lastMaintenanceIssueCount} 项问题${meta.lastMaintenanceTruncated ? "，报告已截断" : ""}）`}</div>
      <div style="margin-top:10px" class="actions">
        <a href="/spaces/${enc}/raw">原始条目（${rawCount}）</a> ·
        <a href="/spaces/${enc}/quarantine">提炼失败（${quarantineCount}）</a> ·
        <a href="/spaces/${enc}/governance">空间规则与治理记录</a> ·
        <a href="/spaces/${enc}/ask">问答测试</a>${groupSettingsLink} ·
        <form method="post" action="/spaces/${enc}/dream" class="inline-form">
          <button type="submit">手动触发提炼</button>
        </form> ·
        <form method="post" action="/spaces/${enc}/maintenance" class="inline-form">
          <button type="submit" class="secondary">运行 Wiki 维护检查</button>
        </form>
      </div>
    </div>
    ${personalAgentSettings}
    <section class="card material-import" aria-labelledby="material-import-title">
      <div class="material-import-head">
        <div>
          <div class="material-kicker">INGEST / LOCAL</div>
          <h2 id="material-import-title">导入本地资料</h2>
          <p>文件会先成为可追溯的 Raw，再由 Dream Cycle 判断如何整理进 Wiki。</p>
        </div>
        <ol class="material-flow" aria-label="导入流程">
          <li><span>1</span>选择资料</li>
          <li><span>2</span>登记 Raw</li>
          <li><span>3</span>提炼 Wiki</li>
        </ol>
      </div>
      <form method="post" action="/spaces/${enc}/materials" enctype="multipart/form-data" class="material-import-form">
        <div class="field">
          <label for="local-material-${enc}">资料文件</label>
          <input class="material-file-input" id="local-material-${enc}" name="material" type="file"
            accept=".txt,.md,.markdown,.csv,.json,.log" multiple required />
          <p class="field-help">可一次选择最多 20 份 UTF-8 文本、Markdown、CSV、JSON 或日志；单个文件不超过 20 MiB。</p>
        </div>
        <div class="material-import-actions">
          <label class="checkbox-row">
            <input type="checkbox" name="distillNow" />
            <span>导入后立即提炼 <small>未勾选时由夜间提炼兜底</small></span>
          </label>
          <button type="submit">导入资料</button>
        </div>
      </form>
    </section>
    ${maps.length > 0
      ? html`<h2>知识地图（${maps.length}）</h2>
        <table>
          <tr><th>主题</th><th>范围</th></tr>
          ${mapRows}
        </table>`
      : ""}
    <h2>知识页（${content.length}）</h2>
    <table>
      <tr><th>标题</th><th>类型</th><th>摘要</th></tr>
      ${pageRows}
    </table>`;
}

export function spaceGovernanceView(
  space: SpaceId,
  snapshot: KnowledgeGovernanceSnapshot,
  flashMsg?: string,
): HtmlEscapedString | Promise<HtmlEscapedString> {
  const enc = encodeURIComponent(space);
  const actionLabels: Record<string, string> = {
    rules_updated: "更新空间规则",
    rule_reset: "恢复默认规则",
    raw_redistilled: "重新提炼原始记录",
    page_deleted: "删除知识页",
    page_regenerated: "重新生成知识页",
    correction_submitted: "提交人工纠错",
  };
  const rows = [...snapshot.audit].reverse().map((record) => html`<tr>
    <td class="muted">${fmtTime(record.createdAt)}</td>
    <td>${actionLabels[record.action] ?? record.action}</td>
    <td><span class="tag">${record.status === "succeeded" ? "成功" : "失败"}</span></td>
    <td>${record.target}</td>
    <td>${record.actor}</td>
    <td class="muted">${record.summary}</td>
  </tr>`);
  return html`<h1>空间规则与治理记录</h1>
    <p class="subtitle">${space} · 规则会在下一次提炼时立即生效。</p>
    ${flash(flashMsg)}
    <form method="post" action="/spaces/${enc}/governance/rules">
      <div class="card">
        <h2>空间意图 purpose.md</h2>
        <textarea name="purpose" rows="12">${snapshot.purpose}</textarea>
        <div class="actions" style="margin-top:10px">
          <button type="submit">保存空间规则</button>
        </div>
      </div>
      <div class="card">
        <h2>页类型规则 schema.md</h2>
        <textarea name="schema" rows="14">${snapshot.schema}</textarea>
      </div>
    </form>
    <div class="card">
      <strong>恢复默认值</strong>
      <div class="muted">只重置所选文件，不会覆盖另一项规则。</div>
      <div class="actions" style="margin-top:10px">
        <form method="post" action="/spaces/${enc}/governance/rules/reset" class="inline-form">
          <input type="hidden" name="target" value="purpose" />
          <button type="submit">恢复默认 purpose</button>
        </form>
        <form method="post" action="/spaces/${enc}/governance/rules/reset" class="inline-form">
          <input type="hidden" name="target" value="schema" />
          <button type="submit">恢复默认 schema</button>
        </form>
      </div>
    </div>
    <h2>治理审计（${snapshot.audit.length}）</h2>
    ${rows.length > 0
      ? html`<table>
          <tr><th>时间</th><th>操作</th><th>结果</th><th>目标</th><th>操作人</th><th>摘要</th></tr>
          ${rows}
        </table>`
      : html`<div class="empty">还没有人工治理操作。</div>`}`;
}

export function quarantineView(
  space: SpaceId,
  records: QuarantineRecord[],
  flashMsg?: string,
): HtmlEscapedString | Promise<HtmlEscapedString> {
  const enc = encodeURIComponent(space);
  const rows = records.map((record) => html`<tr>
    <td class="muted">${fmtTime(record.createdAt)}</td>
    <td><strong>${record.slug}</strong><div class="muted">${record.id}</div></td>
    <td>${record.rawIds.length} 条原始来源</td>
    <td><div class="contentbox">${record.error.slice(0, 500)}</div></td>
    <td>
      <form method="post" action="/spaces/${enc}/quarantine/${encodeURIComponent(record.id)}/retry" class="inline-form">
        <button type="submit">重试</button>
      </form>
    </td>
  </tr>`);
  return html`<h1>提炼失败恢复</h1>
    <p class="subtitle">只重新处理隔离记录关联的原始来源，不会带上本空间其他待提炼内容。</p>
    ${flash(flashMsg)}
    ${records.length > 0
      ? html`<div class="card">
          <div class="row">
            <div><strong>${records.length} 条失败记录</strong><div class="muted">恢复成功后旧记录会自动删除；再次失败会保留最新错误。</div></div>
            <form method="post" action="/spaces/${enc}/quarantine/retry-all" class="inline-form">
              <button type="submit">全部重试</button>
            </form>
          </div>
        </div>
        <table>
          <tr><th>失败时间</th><th>目标知识页</th><th>来源</th><th>错误</th><th>操作</th></tr>
          ${rows}
        </table>`
      : html`<div class="empty">当前没有待恢复的提炼失败。</div>`}`;
}

export function pageView(
  space: SpaceId,
  page: Page,
  flashMsg?: string,
  trace?: KnowledgePageTrace,
): HtmlEscapedString | Promise<HtmlEscapedString> {
  const enc = encodeURIComponent(space);
  const aliases = page.aliases.length ? html`<div class="muted">别名：${page.aliases.join("、")}</div>` : "";
  const links = page.links.length
    ? html`<div class="muted">链接：${page.links.map(
        (l) => html`<a href="/spaces/${enc}/pages/${encodeURIComponent(l)}">${l}</a> `,
      )}</div>`
    : "";
  const tags = page.tags.map((t) => html`<span class="tag">${t}</span>`);
  const sourceLinks = page.sources.length
    ? page.sources.map((sourceId) => html`<a href="/spaces/${enc}/raw/${encodeURIComponent(sourceId)}">${sourceId}</a> `)
    : "—";
  const freshnessLabel = trace
    ? {
        recent: "证据较新",
        aging: "证据较久",
        stale: "证据陈旧",
        unknown: "证据时间未知",
      }[trace.freshness]
    : "证据时间未知";
  const evidenceRows = trace?.sources.map((source) => html`<tr>
    <td><a href="/spaces/${enc}/raw/${encodeURIComponent(source.id)}">${source.id}</a></td>
    <td><span class="tag">${source.source}</span></td>
    <td>${fmtTime(source.createdAt)}</td>
    <td>${source.author ?? "—"}</td>
    <td>${source.admission === "ready" ? "已准入" : source.admission}</td>
  </tr>`) ?? [];
  const evidence = trace && isKnowledgeContentRef(page)
    ? html`<h2>证据链与时效性</h2>
      <div class="card">
        <div><strong>${freshnessLabel}</strong> · 最新证据：${fmtTime(trace.latestEvidenceAt)} ·
          ${trace.sourceCount} 条 Raw · 证据链${trace.complete ? "完整" : "不完整"}</div>
        <p class="muted">时效等级依据最新 Raw 的记录时间计算，只表示证据新旧，不代表事实自动失效。</p>
        ${evidenceRows.length > 0
          ? html`<table>
              <tr><th>Raw</th><th>来源</th><th>记录时间</th><th>作者</th><th>准入</th></tr>
              ${evidenceRows}
            </table>`
          : html`<div class="empty">没有可读取的 Raw 证据。</div>`}
        ${trace.missingSourceIds.length > 0
          ? html`<p class="muted">缺失来源：${trace.missingSourceIds.join("、")}</p>`
          : ""}
        ${trace.truncated ? html`<p class="muted">证据链较长，此处只显示前 100 条。</p>` : ""}
      </div>`
    : "";
  const governance = page.type === "map"
    ? html`<h2>导航页说明</h2>
      <div class="card muted">这是系统自动生成的导航页，会随知识页变化增量更新；请在其链接的知识页上进行纠错或治理。</div>`
    : html`<h2>人工治理</h2>
      <div class="card">
        <div class="actions">
          <form method="post" action="/spaces/${enc}/pages/regenerate" class="inline-form">
            <input type="hidden" name="slug" value="${page.slug}" />
            <button type="submit">重新生成知识页</button>
          </form>
          <form method="post" action="/spaces/${enc}/pages/delete" class="inline-form">
            <input type="hidden" name="slug" value="${page.slug}" />
            <button type="submit" class="danger" onclick="return confirm('确定删除这张知识页？原始来源会保留。')">删除知识页</button>
          </form>
        </div>
        <form method="post" action="/spaces/${enc}/pages/correct" style="margin-top:18px">
          <input type="hidden" name="slug" value="${page.slug}" />
          <div class="field">
            <label>人工纠错 <span class="hint">纠错会保存为 manual 原始来源，再重新生成当前页。</span></label>
            <textarea name="correction" required placeholder="说明哪一项事实有误，以及正确内容是什么。"></textarea>
          </div>
          <button type="submit">提交人工纠错</button>
        </form>
      </div>`;
  return html`<h1>${page.title} <span class="tag">${page.type}</span></h1>
    ${flash(flashMsg)}
    <div class="card">
      <div class="muted">slug：${page.slug} · 更新：${fmtTime(page.updatedAt)}</div>
      ${aliases}${links}
      <div style="margin-top:8px">${tags}</div>
      <div class="muted" style="margin-top:8px">来源 raw：${sourceLinks}</div>
    </div>
    <h2>正文</h2>
    <div class="contentbox">${page.content}</div>
    ${evidence}
    ${governance}`;
}

function rawStatusLabel(raw: RawRecord): string {
  if (raw.admission === "held") return "待动作验收";
  if (raw.admission === "excluded") return "已排除";
  return raw.ingested ? "已提炼" : "待提炼";
}

export function rawListView(space: SpaceId, raws: RawRecord[]): HtmlEscapedString | Promise<HtmlEscapedString> {
  const enc = encodeURIComponent(space);
  const rows = raws.length
    ? raws.map(
        (r) => html`<tr>
          <td class="muted">${fmtTime(r.createdAt)}</td>
          <td><span class="tag">${r.source}</span></td>
          <td>${rawStatusLabel(r)}</td>
          <td><a href="/spaces/${enc}/raw/${encodeURIComponent(r.id)}">${r.content.slice(0, 160)}</a></td>
        </tr>`,
      )
    : [html`<tr><td colspan="4" class="empty">暂无原始条目。</td></tr>`];
  return html`<h1>原始条目 · ${space}</h1>
    <table>
      <tr><th>时间</th><th>来源</th><th>状态</th><th>内容</th></tr>
      ${rows}
    </table>`;
}

export function rawGovernanceDetailView(
  space: SpaceId,
  detail: RawGovernanceDetail,
  flashMsg?: string,
): HtmlEscapedString | Promise<HtmlEscapedString> {
  const enc = encodeURIComponent(space);
  const rawId = encodeURIComponent(detail.raw.id);
  const attachments = detail.raw.attachments ?? [];
  const pageRows = detail.pages.map((page) => html`<li>
    <a href="/spaces/${enc}/pages/${encodeURIComponent(page.slug)}">${page.title}</a>
    <span class="muted">${page.slug}</span>
  </li>`);
  const attachmentRows = attachments.map((attachment) => html`<li>
    ${attachment.name ?? attachment.ref}
    <span class="muted">${attachment.kind} · ${attachment.ref}</span>
  </li>`);
  const agentResponse = detail.raw.source !== "message"
    ? ""
    : detail.raw.agentResponse !== undefined
    ? html`<h2>Agent 回复</h2>
      <div class="contentbox">${detail.raw.agentResponse}</div>
      ${detail.raw.agentRespondedAt === undefined
        ? ""
        : html`<div class="muted" style="margin-top:8px">
          回复时间：${fmtTime(detail.raw.agentRespondedAt)}
        </div>`}`
    : html`<h2>Agent 回复</h2>
      <div class="empty">${detail.raw.agentHandled === false
        ? "这条消息未触发 Agent 回复。"
        : "这条记录没有保存 Agent 回复；旧记录的历史回复无法从本地补回。"}</div>`;
  const redistillControl = detail.raw.admission === "ready"
    ? html`<form method="post" action="/spaces/${enc}/raw/${rawId}/redistill" style="margin-top:12px">
        <button type="submit">重新提炼这条记录</button>
      </form>`
    : "";
  return html`<h1>原始记录详情</h1>
    <p class="subtitle">${detail.raw.id}</p>
    ${flash(flashMsg)}
    <div class="card">
      <div>来源：<span class="tag">${detail.raw.source}</span> · 状态：${rawStatusLabel(detail.raw)}</div>
      <div class="muted" style="margin-top:8px">
        时间：${fmtTime(detail.raw.createdAt)} · 作者：${detail.raw.author ?? "—"} ·
        chat：${detail.raw.chatId ?? "—"} · message：${detail.raw.messageId ?? "—"}
      </div>
      ${redistillControl}
    </div>
    <h2>完整内容</h2>
    <div class="contentbox">${detail.raw.content}</div>
    ${agentResponse}
    <h2>附件（${attachments.length}）</h2>
    ${attachmentRows.length > 0
      ? html`<ul>${attachmentRows}</ul>`
      : html`<div class="empty">没有附件。</div>`}
    <h2>关联知识页（${detail.pages.length}）</h2>
    ${pageRows.length > 0
      ? html`<ul>${pageRows}</ul>`
      : html`<div class="empty">当前没有知识页引用这条原始记录。</div>`}`;
}

export function askView(
  space: SpaceId,
  question: string | null,
  result: AskResult | null,
  flashMsg?: string,
  feedbackRecorded = false,
): HtmlEscapedString | Promise<HtmlEscapedString> {
  const enc = encodeURIComponent(space);
  let answer: HtmlEscapedString | Promise<HtmlEscapedString> | string = "";
  if (result) {
    const badge = result.source === "knowledge"
      ? html`<span class="badge knowledge">知识库</span>`
      : html`<span class="badge general">通用</span>`;
    const cites = result.citations.length
      ? html`<div class="muted" style="margin-top:8px">引用：${result.citations.map(
          (c) => html`<a href="/spaces/${enc}/pages/${encodeURIComponent(c.slug)}">${c.title}</a>
            ${citationEvidenceView(c)} `,
        )}</div>`
      : "";
    const feedback = result.traceId
      ? feedbackRecorded
        ? html`<div class="muted" style="margin-top:12px">本回答的反馈已记录。</div>`
        : html`<div style="margin-top:12px">
          <div class="muted">这个回答有帮助吗？反馈只用于本机质量改进。</div>
          <div class="actions" style="margin-top:8px">
            ${ANSWER_FEEDBACK_KINDS.map((kind) => html`
              <form method="post" action="/spaces/${enc}/ask/feedback">
                <input type="hidden" name="traceId" value="${result.traceId}" />
                <input type="hidden" name="kind" value="${kind}" />
                <button type="submit" class="secondary">${ANSWER_FEEDBACK_LABELS[kind]}</button>
              </form>
            `)}
          </div>
        </div>`
      : "";
    answer = html`<div class="card">
      <div>${badge}</div>
      <div class="contentbox" style="margin-top:10px">${result.answer}</div>
      ${cites}
      ${feedback}
    </div>`;
  }
  return html`<h1>问答测试 · ${space}</h1>
    ${flash(flashMsg)}
    <form method="get" action="/spaces/${enc}/ask" class="actions">
      <input type="text" name="q" placeholder="问一个问题…" value="${question ?? ""}" />
      <button type="submit">提问</button>
    </form>
    ${answer}`;
}

export function qualityView(
  reviewItems: QualityReviewViewItem[],
  snapshot: QualitySnapshot,
  status: "open" | "resolved",
  evaluationCaseCount: number,
  flashMsg?: string,
): HtmlEscapedString | Promise<HtmlEscapedString> {
  const cards = reviewItems.map(({ review, citations: citationTargets }) => {
    const { trace, feedback, evaluationCase } = review;
    const citations = citationTargets.length > 0
      ? citationTargets.map(({ citation, spaces }) => {
          if (spaces.length === 0) {
            return html`${citation.title} <span class="muted">${citation.slug}</span>`;
          }
          if (spaces.length === 1) {
            const space = spaces[0]!;
            return html`
              <a href="/spaces/${encodeURIComponent(space)}/pages/${encodeURIComponent(citation.slug)}">${citation.title}</a>
              <span class="muted">${citation.slug}</span>
            `;
          }
          return html`
            <span class="muted">同名引用，候选空间：</span>
            ${spaces.map((space) => html`
              <a href="/spaces/${encodeURIComponent(space)}/pages/${encodeURIComponent(citation.slug)}">${citation.title}（${space}）</a>
            `)}
            <span class="muted">${citation.slug}</span>
          `;
        })
      : html`<span class="muted">无引用</span>`;
    return html`<div class="card">
      <div class="row">
        <div>
          <span class="badge degraded">${ANSWER_FEEDBACK_LABELS[feedback.kind]}</span>
          ${status === "resolved" ? html`<span class="badge ok">已解决</span>` : ""}
          <span class="muted">${trace.spaces.join("、")} · ${fmtTime(feedback.createdAt)}</span>
        </div>
        <span class="muted">${trace.latencyMs} ms</span>
      </div>
      <h2 style="margin:16px 0 8px">${trace.question}</h2>
      <div class="contentbox">${trace.answer ?? trace.error ?? "没有保存回答正文"}</div>
      <div style="margin-top:10px"><strong>引用：</strong> ${citations}</div>
      ${feedback.note
        ? html`<div class="muted" style="margin-top:8px">反馈说明：${feedback.note}</div>`
        : ""}
      ${feedback.resolutionNote
        ? html`<div class="muted" style="margin-top:8px">处理说明：${feedback.resolutionNote}</div>`
        : ""}
      ${feedback.evaluationCaseId
        ? html`<div class="card" style="margin-top:14px;background:var(--accent-soft)">
            <strong>已加入待校准评测集</strong>
            ${evaluationCase?.curatorNote
              ? html`<div class="muted" style="margin-top:6px">校准说明：${evaluationCase.curatorNote}</div>`
              : html`<div class="muted" style="margin-top:6px">该候选已超出本机保留窗口。</div>`}
          </div>`
        : status === "open"
          ? html`<form method="post" action="/quality/${encodeURIComponent(trace.id)}/promote" style="margin-top:14px">
            <div class="field">
              <label>校准说明 <span class="hint">记录正确方向，后续人工确认后再进入固定评测集。</span></label>
              <textarea name="curatorNote" required placeholder="例如：补充值班范围后重跑"></textarea>
            </div>
            <button type="submit" class="secondary">加入待校准评测集</button>
          </form>`
          : ""}
      ${status === "open"
        ? html`<form method="post" action="/quality/${encodeURIComponent(trace.id)}/resolve" style="margin-top:14px">
            <div class="field">
              <label>处理说明 <span class="hint">修正文档或确认无需处理后再标记解决。</span></label>
              <textarea name="resolutionNote" required placeholder="例如：发布策略页已改为重试两次"></textarea>
            </div>
            <button type="submit">标记已解决</button>
          </form>`
        : ""}
    </div>`;
  });
  const negative = snapshot.feedback.unhelpful + snapshot.feedback.citationError;
  return html`<h1>AI 质量反馈</h1>
    <p class="subtitle">检查没帮助和引用有误的回答；问题、回答和评测候选只保存在本机。</p>
    ${flash(flashMsg)}
    <div class="actions" style="margin-bottom:14px">
      <a class="btn" href="/quality">问答反馈</a>
      <a class="btn secondary" href="/quality/agent-feedback">Agent 知识反馈</a>
    </div>
    <div class="actions" style="margin-bottom:14px">
      <a class="btn ${status === "open" ? "" : "secondary"}" href="/quality">待处理</a>
      <a class="btn ${status === "resolved" ? "" : "secondary"}" href="/quality?status=resolved">已解决</a>
    </div>
    <div class="card">
      <div class="row">
        <div><strong>${reviewItems.length} 条${status === "open" ? "待处理" : "已解决"}</strong><div class="muted">${status === "open" ? "当前打开的负面反馈" : "保留的问题处理历史"}</div></div>
        <div class="muted">全部反馈 ${snapshot.feedback.total} · 负面 ${negative} · <a href="/quality/evaluation-cases.json">${evaluationCaseCount} 条待校准评测案例</a></div>
      </div>
    </div>
    ${cards.length > 0
      ? cards
      : html`<div class="empty">当前没有${status === "open" ? "待处理" : "已解决"}的负面反馈。</div>`}`;
}

function agentFeedbackResolutionOptions(
  feedback: AgentKnowledgeFeedback,
): Array<{ kind: AgentKnowledgeFeedbackManualResolutionKind; label: string }> {
  if (feedback.target.kind === "search") {
    return [
      { kind: "coverage_recorded", label: "已记录知识覆盖计划" },
      { kind: "duplicate", label: "重复反馈" },
      { kind: "not_actionable", label: "无需处理" },
    ];
  }
  return [
    { kind: "knowledge_changed", label: "知识页已修正（系统验证 revision 已变化）" },
    { kind: "knowledge_confirmed", label: "人工复核后确认当前知识有效" },
    { kind: "duplicate", label: "重复反馈" },
    { kind: "not_actionable", label: "无需处理" },
  ];
}

export function agentKnowledgeFeedbackView(
  feedbackRecords: AgentKnowledgeFeedback[],
  status: "open" | "resolved",
  flashMsg?: string,
): HtmlEscapedString | Promise<HtmlEscapedString> {
  const cards = feedbackRecords.map((feedback) => {
    const target = feedback.target.kind === "page"
      ? html`<div>
          <strong>知识页：</strong>
          <a href="/spaces/${encodeURIComponent(feedback.space)}/pages/${encodeURIComponent(feedback.target.slug)}">${feedback.target.slug}</a>
          <div class="muted">Agent 消费 revision：<code>${feedback.target.revision}</code></div>
          ${feedback.currentRevisionAtSubmission
            ? html`<div class="muted">提交时 revision：<code>${feedback.currentRevisionAtSubmission}</code></div>`
            : ""}
        </div>`
      : html`<div><strong>未命中搜索：</strong><code>${feedback.target.query}</code></div>`;
    const resolution = feedback.resolution
      ? html`<div class="contentbox" style="margin-top:12px">
          <strong>${AGENT_KNOWLEDGE_RESOLUTION_LABELS[feedback.resolution.kind]}</strong>
          <div>${feedback.resolution.note}</div>
          <div class="muted">${feedback.resolution.actor} · ${fmtTime(feedback.resolution.resolvedAt)}</div>
          ${feedback.resolution.currentRevision
            ? html`<div class="muted">处置后 revision：<code>${feedback.resolution.currentRevision}</code></div>`
            : ""}
        </div>`
      : "";
    const resolutionForm = status === "open"
      ? html`<form method="post" action="/quality/agent-feedback/${encodeURIComponent(feedback.space)}/${encodeURIComponent(feedback.id)}/resolve" style="margin-top:14px">
          <div class="field">
            <label>处置结果 <span class="hint">关闭只记录治理结论，不会自动写入 Raw/Wiki 或触发 Dream cycle。</span></label>
            <select name="kind" required>
              ${agentFeedbackResolutionOptions(feedback).map((option) =>
                html`<option value="${option.kind}">${option.label}</option>`
              )}
            </select>
          </div>
          <div class="field">
            <label>处理说明</label>
            <textarea name="note" required placeholder="说明核验过程、修正内容或不处理原因。"></textarea>
          </div>
          <button type="submit">验证并关闭</button>
        </form>`
      : "";
    return html`<div class="card">
      <div class="row">
        <div>
          <span class="badge ${feedback.kind === "helpful" ? "ok" : "degraded"}">${AGENT_KNOWLEDGE_FEEDBACK_LABELS[feedback.kind]}</span>
          ${status === "resolved" ? html`<span class="badge ok">已解决</span>` : ""}
          <span class="muted">${feedback.space} · ${fmtTime(feedback.createdAt)}</span>
        </div>
        <span class="muted">${feedback.consumer}</span>
      </div>
      <div style="margin-top:14px">${target}</div>
      ${feedback.note
        ? html`<div class="contentbox" style="margin-top:12px">${feedback.note}</div>`
        : ""}
      ${resolution}
      ${resolutionForm}
    </div>`;
  });
  return html`<h1>Agent 知识反馈</h1>
    <p class="subtitle">集中处理本机其他 Agent 在复用 Wiki 时提交的问题；反馈本身不是 Raw，也不会直接改写知识。</p>
    ${flash(flashMsg)}
    <div class="actions" style="margin-bottom:14px">
      <a class="btn secondary" href="/quality">问答反馈</a>
      <a class="btn" href="/quality/agent-feedback">Agent 知识反馈</a>
    </div>
    <div class="actions" style="margin-bottom:14px">
      <a class="btn ${status === "open" ? "" : "secondary"}" href="/quality/agent-feedback">待处理</a>
      <a class="btn ${status === "resolved" ? "" : "secondary"}" href="/quality/agent-feedback?status=resolved">已解决</a>
    </div>
    <div class="card">
      <strong>${feedbackRecords.length} 条${status === "open" ? "待处理" : "已解决"}</strong>
      <div class="muted">页面反馈绑定 Agent 消费时的 revision；“知识页已变更”会在关闭前重新验证。</div>
    </div>
    ${cards.length > 0
      ? cards
      : html`<div class="empty">当前没有${status === "open" ? "待处理" : "已解决"}的 Agent 知识反馈。</div>`}`;
}

export function logsView(logs: { day: string; lines: string[] }[]): HtmlEscapedString | Promise<HtmlEscapedString> {
  if (logs.length === 0) return html`<h1>LLM 调用日志</h1><div class="empty">暂无调用记录。</div>`;
  const blocks = logs.map(
    (l) => html`<h2>${l.day}</h2><pre>${raw(escapePre(l.lines.join("\n")))}</pre>`,
  );
  return html`<h1>LLM 调用日志</h1>${blocks}`;
}

function escapePre(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---- runtime health -------------------------------------------------------

export function healthView(
  snapshot: SystemHealthSnapshot,
  flashMsg?: string,
  serviceRestartable = false,
): HtmlEscapedString | Promise<HtmlEscapedString> {
  const labels: Record<string, string> = {
    knowledge: "知识存储",
    providers: "本机 CLI",
    feishu: "飞书事件消费者",
    dreamCycles: "Dream Cycle",
    maintenanceCycles: "Wiki Maintenance",
    tasks: "任务执行",
    reminders: "提醒",
    learning: "学习计划",
    aiQuality: "AI 质量反馈",
    aiRuntime: "AI 运行指标",
    dreamScheduler: "Dream Cycle 调度器",
    maintenanceScheduler: "Wiki Maintenance 调度器",
    workContinuationScheduler: "工作续跑调度器",
    taskScheduler: "任务调度器",
    reminderScheduler: "提醒调度器",
    learningScheduler: "学习调度器",
    service: "后台服务",
  };
  const rows = Object.entries(snapshot.components).map(([key, component]) => {
    const serviceDetails = key === "service" ? component.details : undefined;
    const serviceControls = serviceDetails
      ? html`<div class="row" style="margin-top:12px">
          <span class="muted">PID：${String(serviceDetails.pid ?? "—")} · 启动时间：${fmtTime(
            typeof serviceDetails.startedAt === "number" ? serviceDetails.startedAt : undefined,
          )}</span>
          ${serviceRestartable && serviceDetails.managed === true
            ? html`<form method="post" action="/service/restart" class="inline-form"
                onsubmit="return confirm('安全重启 homeagent 后台服务？')">
                <button type="submit" class="secondary">安全重启</button>
              </form>`
            : ""}
        </div>`
      : "";
    const details = component.details
      ? html`<details><summary class="muted">查看详情</summary><pre>${raw(
          escapePre(JSON.stringify(component.details, null, 2)),
        )}</pre></details>`
      : "";
    return html`<div class="card">
      <div class="row">
        <strong>${labels[key] ?? key}</strong>
        <span class="badge ${component.status}">${component.status}</span>
      </div>
      <div style="margin-top:8px">${component.summary}</div>
      ${serviceControls}
      ${details}
    </div>`;
  });
  return html`<h1>运行状态</h1>
    <p class="subtitle">检查时间：${fmtTime(snapshot.checkedAt)} · Ready：${snapshot.ready ? "是" : "否"}</p>
    ${flash(flashMsg)}
    <div class="card">
      <div class="row">
        <strong>总体状态</strong>
        <span class="badge ${snapshot.status}">${snapshot.status}</span>
      </div>
    </div>
    ${rows}`;
}

// ---- data governance -----------------------------------------------------

export interface GovernanceSpaceSummary {
  meta: SpaceMeta;
  pages: number;
  raw: number;
  pending: number;
  tasks: number;
  learning: number;
}

export function governanceView(
  spaces: GovernanceSpaceSummary[],
  retentionDays: number,
  flashMsg?: string,
): HtmlEscapedString | Promise<HtmlEscapedString> {
  const rows = spaces.length === 0
    ? html`<tr><td colspan="7" class="empty">暂无空间</td></tr>`
    : spaces.map(({ meta, pages, raw: rawCount, pending, tasks, learning }) => html`<tr>
        <td><strong>${meta.name || meta.id}</strong><div class="muted">${meta.id}</div></td>
        <td>${pages}</td>
        <td>${rawCount}</td>
        <td>${pending}</td>
        <td>${tasks}</td>
        <td>${learning}</td>
        <td>
          <div class="actions">
            <a class="btn secondary" href="/spaces/${encodeURIComponent(meta.id)}/export">导出</a>
            <form method="post" action="/spaces/${encodeURIComponent(meta.id)}/delete" class="inline-form"
              onsubmit="return confirm('永久删除该空间的知识、原始记录、治理审计、任务、提醒和学习计划？请先导出备份。后续新消息可能重新创建空空间。')">
              <button type="submit" class="danger">删除</button>
            </form>
          </div>
        </td>
      </tr>`);
  return html`<h1>数据治理</h1>
    <p class="subtitle">导出版本化 JSON 备份、恢复空间，或永久删除空间数据。</p>
    ${flash(flashMsg)}
    <div class="card">
      <h2 style="margin-top:0">原始消息保留</h2>
      <p class="muted">当前策略：${retentionDays === 0 ? "永久保留" : `已提炼的消息正文保留 ${retentionDays} 天`}。待提炼消息和文档不会被删除。</p>
      <form method="post" action="/governance/prune" class="actions"
        onsubmit="return confirm('按当前保留周期立即清理已提炼的过期消息？')">
        <button type="submit" class="secondary">立即清理</button>
      </form>
    </div>
    <div class="card">
      <h2 style="margin-top:0">恢复空间</h2>
      <p class="muted">接受 homeagent.space v1–v18 归档；v2 包含阅读计划，v3 包含主题路线与多来源材料，v4 包含知识人工治理审计，v5 包含任务运行历史，v6 包含运行时限与通知状态，v7 包含精确 Skill 绑定，v8 包含 Chat Run 历史，v9 包含运行队列，v10 包含冻结执行计划，v11 包含 Agent 发布历史与任务审批审计，v12 包含审批期限与通知审计，v13 包含运行用量、失败分类与自动重试审计，v14 包含 Chat 评测 Trace 与已结束重评审计，v15 包含工作上下文、续作动作/checkpoint/策略及其证据关联，v16 包含 WorkAction Raw 的待验收、已准入与已排除状态，v17 包含系统生成的分层知识地图，v18 包含本地 Agent 知识消费反馈及处置记录；已有同名空间不会被覆盖。</p>
      <form method="post" action="/governance/restore" enctype="multipart/form-data" class="actions">
        <input type="file" name="archive" accept="application/json,.json" required />
        <button type="submit">上传并恢复</button>
      </form>
    </div>
    <h2>空间数据</h2>
    <table>
      <thead><tr><th>空间</th><th>知识页</th><th>原始记录</th><th>待提炼</th><th>任务</th><th>学习计划</th><th>操作</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

// ---- Agents (mew two-pane: list + editor) ----------------------------------

/** Agents page: list column + right editor. `selected` is the agent being edited (or null = new). */
export function agentsView(
  agents: Agent[],
  selected: Agent | null,
  providers: DetectedProvider[],
  models: Record<string, string[]>,
  defaults: { provider: string; model: string },
  flashMsg?: string,
): HtmlEscapedString | Promise<HtmlEscapedString> {
  const listItems = agents.map((a) => {
    const active = selected && a.id === selected.id;
    return html`<a class="item ${active ? "active" : ""}" href="/agents/${encodeURIComponent(a.id)}">
      <div class="name"><span class="dot"></span>${a.name}</div>
      <div class="sub">${a.provider} / ${a.model || "默认模型"}</div>
    </a>`;
  });
  const newActive = selected === null ? "active" : "";

  const editing = selected;
  const formAction = editing ? `/agents/${encodeURIComponent(editing.id)}` : "/agents";
  const submitLabel = editing ? "保存" : "创建";
  const nameVal = editing?.name ?? "";
  const instrVal = editing?.instruction ?? "";
  const modelVal = editing?.model ?? "";
  const reasoningEffortVal = editing?.reasoningEffort ?? "";
  const providerVal = editing?.provider ?? providers.find((p) => p.available)?.id ?? "claude";
  const visVal = editing?.visibility ?? "Team";
  const workdirVal = editing?.workdir ?? "";
  const permVal = editing?.permission ?? "read-only";
  const skillsVal = (editing?.skills ?? []).join(", ");
  const permLabels: Record<string, string> = { "read-only": "只读", write: "可写", full: "完全访问" };
  const reasoningEffortLabels: Record<string, string> = {
    none: "无（None）",
    low: "低（Low）",
    medium: "中（Medium）",
    high: "高（High）",
    xhigh: "超高（Extra High）",
    max: "最大（Max）",
  };

  // Provider dropdown: only local CLIs, selectable when detected as runnable,
  // else greyed with the reason. (The internal API is used by the claude CLI
  // itself, not exposed as a homeagent provider.)
  const availableList = providers.filter((p) => p.available).map((p) => p.name).join("、");
  const providerOptions = providers.map((p) => {
    const sel = p.id === providerVal ? "selected" : "";
    const disabled = p.available ? "" : "disabled";
    const suffix = p.available ? `（${p.detail}）` : `（不可用：${p.detail}）`;
    return html`<option value="${p.id}" ${sel} ${disabled}>${p.name}${suffix}</option>`;
  });

  // Model options for the initially-selected provider (server-rendered); the
  // client script below repopulates them whenever Provider changes (mew shows a
  // different model list per provider).
  const initialModels = models[providerVal] ?? [];
  const modelOpts = [
    html`<option value="" ${modelVal === "" ? "selected" : ""}>（使用全局默认）</option>`,
    ...initialModels.map((m) => html`<option value="${m}" ${m === modelVal ? "selected" : ""}>${m}</option>`),
  ];
  if (modelVal && !initialModels.includes(modelVal)) {
    modelOpts.push(html`<option value="${modelVal}" selected>${modelVal}（自定义）</option>`);
  }
  const inheritedCodexModel = defaults.provider === "codex" ? defaults.model : "";
  const reasoningModels = [...new Set(["", ...(models.codex ?? []), ...(modelVal ? [modelVal] : [])])];
  const reasoningCatalog = Object.fromEntries(
    reasoningModels.map((model) => [
      model,
      codexReasoningEffortsForModel(model || inheritedCodexModel || undefined),
    ]),
  );
  const initialReasoningEfforts = providerVal === "codex"
    ? codexReasoningEffortsForModel(modelVal || inheritedCodexModel || undefined)
    : [];

  // A tiny client script: on provider change, rebuild the Model <select> from
  // the embedded catalog. No framework — plain DOM.
  const catalogJson = JSON.stringify(models);
  const reasoningCatalogJson = JSON.stringify(reasoningCatalog);
  const reasoningLabelsJson = JSON.stringify(reasoningEffortLabels);
  const modelScript = raw(`<script>
(function(){
  var CATALOG = ${catalogJson};
  var REASONING = ${reasoningCatalogJson};
  var REASONING_LABELS = ${reasoningLabelsJson};
  var prov = document.getElementById('agent-provider');
  var model = document.getElementById('agent-model');
  var reasoning = document.getElementById('agent-reasoning-effort');
  if (!prov || !model || !reasoning) return;
  function syncReasoning(){
    var current = reasoning.value;
    reasoning.disabled = prov.value !== 'codex';
    reasoning.innerHTML = '';
    var inherited = document.createElement('option');
    inherited.value = ''; inherited.textContent = '默认（继承 Codex 配置）';
    reasoning.appendChild(inherited);
    if (reasoning.disabled) return;
    var list = model.value === '' ? (REASONING[''] || []) : (REASONING[model.value] || []);
    list.forEach(function(effort){
      var option = document.createElement('option');
      option.value = effort; option.textContent = REASONING_LABELS[effort] || effort;
      if (effort === current) option.selected = true;
      reasoning.appendChild(option);
    });
  }
  prov.addEventListener('change', function(){
    var list = CATALOG[prov.value] || [];
    var cur = model.value;
    model.innerHTML = '';
    var def = document.createElement('option');
    def.value = ''; def.textContent = '（使用全局默认）';
    model.appendChild(def);
    list.forEach(function(m){
      var o = document.createElement('option');
      o.value = m; o.textContent = m;
      if (m === cur) o.selected = true;
      model.appendChild(o);
    });
    syncReasoning();
  });
  model.addEventListener('change', syncReasoning);
  syncReasoning();
})();
</script>`);

  const deleteForm = editing
    ? html`<form method="post" action="/agents/${encodeURIComponent(editing.id)}/delete" class="inline-form"
        onsubmit="return confirm('删除该 Agent？已指定它的群将回退到默认。')">
        <button type="submit" class="danger">删除</button>
      </form>`
    : "";

  return html`<h1>Agents</h1>
    <p class="subtitle">配置回答与任务执行使用的智能体。Permission / Workdir 同时作用于普通聊天和任务；提炼与后台学习保持 no-tools。</p>
    <div class="split">
      <div class="listcol">
        <a class="item ${newActive}" href="/agents"><div class="name">＋ 新建 Agent</div>
          <div class="sub">创建一个新的回答智能体</div></a>
        ${listItems}
      </div>
      <div>
        ${flash(flashMsg)}
        <form method="post" action="${formAction}" class="stack card">
          <div class="field">
            <label>名称</label>
            <input type="text" name="name" value="${nameVal}" placeholder="例如：知识助手" required />
          </div>
          <div class="field">
            <label>Instruction <span class="hint">（人格 / 额外系统提示，会注入到回答中）</span></label>
            <textarea name="instruction" placeholder="描述这个 agent 的语气、角色与回答风格…">${instrVal}</textarea>
          </div>
          <div class="grid2">
            <div class="field">
              <label>Provider <span class="hint">本机已检测：${availableList || "无（未装 CLI）"}</span></label>
              <select name="provider" id="agent-provider">
                ${providerOptions}
              </select>
            </div>
            <div class="field">
              <label>Model <span class="hint">随 Provider 变化</span></label>
              <select name="model" id="agent-model">
                ${modelOpts}
              </select>
            </div>
            <div class="field">
              <label>推理强度 <span class="hint">仅 Codex；档位随模型变化，级别越高通常越慢</span></label>
              <select name="reasoningEffort" id="agent-reasoning-effort" ${providerVal === "codex" ? "" : "disabled"}>
                <option value="" ${reasoningEffortVal === "" ? "selected" : ""}>默认（继承 Codex 配置）</option>
                ${initialReasoningEfforts.map(
                  (effort) => html`<option value="${effort}" ${effort === reasoningEffortVal ? "selected" : ""}>${reasoningEffortLabels[effort] ?? effort}</option>`,
                )}
              </select>
            </div>
            <div class="field">
              <label>Visibility <span class="hint">限制 Agent 可绑定的空间类型</span></label>
              <select name="visibility">
                ${["Team", "Personal"].map(
                  (v) => html`<option value="${v}" ${v === visVal ? "selected" : ""}>${v}</option>`,
                )}
              </select>
            </div>
            <div class="field">
              <label>Permission <span class="hint">仅影响任务运行</span></label>
              <select name="permission">
                ${AGENT_PERMISSIONS.map(
                  (p) => html`<option value="${p}" ${p === permVal ? "selected" : ""}>${permLabels[p] ?? p}</option>`,
                )}
              </select>
            </div>
          </div>
          <h2 style="font-size:14px;margin:18px 0 4px">执行上下文 <span class="hint" style="font-weight:400">（Permission / Skills 仅影响任务；普通 Codex 只读使用 Workdir）</span></h2>
          <p class="muted">只读模式禁止写入；可写模式以 Workdir 为工作根目录并启用 Provider 的工作区写入沙箱；完全访问会绕过 Provider 沙箱，必须谨慎使用。可写和完全访问都要求配置有效 Workdir。</p>
          <div class="grid2">
            <div class="field">
              <label>Workdir <span class="hint">普通 Codex 的只读上下文，也是任务工作目录</span></label>
              <input type="text" name="workdir" value="${workdirVal}" placeholder="~/work/项目目录" />
            </div>
            <div class="field">
              <label>Skills <span class="hint">逗号分隔；任务开始前强制加载</span></label>
              <input type="text" name="skills" value="${skillsVal}" placeholder="例如：code-review, web-search" />
            </div>
          </div>
          <div class="actions">
            <button type="submit">${submitLabel}</button>
            ${deleteForm}
          </div>
        </form>
      </div>
    </div>
    ${modelScript}`;
}

// ---- Work context ----------------------------------------------------------

const WORK_PHASE_LABELS: Record<WorkItem["phase"], string> = {
  planned: "已规划",
  active: "推进中",
  blocked: "受阻",
  completed: "已完成",
};

function workAcceptanceView(
  action: WorkAction,
  acceptance: NonNullable<WorkAction["acceptances"]>[number],
  space: SpaceId,
): HtmlEscapedString | Promise<HtmlEscapedString> {
  const headingId = `acceptance-${action.id}-${acceptance.taskRunId}`;
  const decisionLabel = acceptance.status === "accepted"
    ? "已接受"
    : acceptance.status === "rejected"
      ? "已驳回"
      : "待验收";
  const checkLabel = { passed: "通过", failed: "未通过", not_run: "未执行" } as const;
  const evidenceLink = (evidence: typeof acceptance.report.evidence[number]) => {
    const href = evidence.kind === "task_run"
      ? `/tasks/runs/${encodeURIComponent(evidence.id)}`
      : evidence.kind === "raw"
        ? `/spaces/${encodeURIComponent(space)}/raw/${encodeURIComponent(evidence.id)}`
        : `/spaces/${encodeURIComponent(space)}/pages/${encodeURIComponent(evidence.id)}`;
    return html`<a href="${href}">${evidence.kind} · ${evidence.id}</a>`;
  };
  return html`<section class="work-acceptance ${acceptance.status}" aria-labelledby="${headingId}">
    <div class="work-acceptance-head">
      <div>
        <p class="work-kicker">Acceptance gate</p>
        <h3 id="${headingId}">工作动作验收 · ${decisionLabel}</h3>
      </div>
      <span class="work-action-state ${acceptance.status === "pending" ? "awaiting_acceptance" : acceptance.status}">
        ${decisionLabel}
      </span>
    </div>
    <dl class="work-report-meta">
      <div><dt>权限快照</dt><dd><code>${acceptance.permission}</code></dd></div>
      <div><dt>Run</dt><dd><a href="/tasks/runs/${encodeURIComponent(acceptance.taskRunId)}">${acceptance.taskRunId}</a></dd></div>
    </dl>
    <div class="work-report-result"><strong>结果 · ${acceptance.report.outcome === "completed" ? "已完成" : acceptance.report.outcome === "blocked" ? "受阻" : "待核验"}</strong><p>${acceptance.report.result}</p>
      ${acceptance.report.blockers.length > 0 ? html`<div><strong>阻塞</strong><ul>${acceptance.report.blockers.map((blocker) => html`<li>${blocker}</li>`)}</ul></div>` : ""}
    </div>
    <div class="work-report-grid">
      <div><strong>执行检查</strong><ul>${acceptance.report.checks.map((check) =>
        html`<li><span class="work-check ${check.status}">${checkLabel[check.status]}</span>
          ${check.name}${check.detail ? html` · ${check.detail}` : ""}</li>`)}</ul></div>
      <div><strong>证据</strong><ul>${acceptance.report.evidence.map((evidence) =>
        html`<li>${evidenceLink(evidence)}${evidence.description ? html` · ${evidence.description}` : ""}</li>`)}</ul></div>
    </div>
    ${acceptance.status === "pending" ? html`
      <p class="work-acceptance-note">自动续跑已暂停在验收门；接受后才会写入 checkpoint 并开放下一动作。</p>
      <div class="work-acceptance-actions">
        <form method="post" action="/work/actions/${encodeURIComponent(action.id)}/accept">
          <input type="hidden" name="runId" value="${acceptance.taskRunId}" />
          <button type="submit">接受并写入 checkpoint</button>
        </form>
        <form method="post" action="/work/actions/${encodeURIComponent(action.id)}/reject" class="work-reject-form">
          <input type="hidden" name="runId" value="${acceptance.taskRunId}" />
          <label for="reject-${action.id}">驳回原因 <span class="hint">必填，将作为可重试 blocker</span></label>
          <textarea id="reject-${action.id}" name="reason" required maxlength="2000"
            placeholder="说明缺少的结果、检查或证据"></textarea>
          <button type="submit" class="danger">驳回并保留动作边界</button>
        </form>
      </div>` : html`
      <div class="work-decision">
        ${acceptance.decidedBy ? html`决定人：${acceptance.decidedBy}` : ""}
        ${acceptance.decidedAt ? html` · ${fmtTime(acceptance.decidedAt)}` : ""}
        ${acceptance.mode ? html` · ${acceptance.mode === "automatic" ? "自动验收" : "人工验收"}` : ""}
        ${acceptance.reason ? html`<p>${acceptance.reason}</p>` : ""}
      </div>`}
  </section>`;
}

/** Work context page: a compact operational journal with traceable evidence. */
export function workItemsView(
  items: WorkItem[],
  selected: WorkItem | null,
  spaces: SpaceMeta[],
  actions: WorkAction[] = [],
  continuationPolicy?: WorkContinuationPolicy,
  flashMsg?: string,
): HtmlEscapedString | Promise<HtmlEscapedString> {
  const listItems = items.map((item) => html`
    <a class="item ${selected?.id === item.id ? "active" : ""}"
      href="/work/${encodeURIComponent(item.id)}">
      <div class="name">${item.active ? html`<span class="dot"></span>` : ""}${item.title}</div>
      <div class="sub">${WORK_PHASE_LABELS[item.phase]} · ${item.space}</div>
    </a>`);
  const newActive = selected ? "" : "active";
  const formAction = selected ? `/work/${encodeURIComponent(selected.id)}` : "/work";
  const spaceValue = selected?.space ?? spaces[0]?.id ?? "";
  const spaceField = selected
    ? html`<div class="field"><label>空间</label>
        <input type="text" value="${selected.space}" disabled />
      </div>`
    : html`<div class="field"><label>空间</label><select name="space" required>
        ${spaces.map((space) => html`<option value="${space.id}" ${space.id === spaceValue ? "selected" : ""}>
          ${space.name ?? space.id} · ${space.id}
        </option>`)}
      </select></div>`;
  const phase = selected?.phase ?? "active";
  const activation = selected && !selected.active && selected.phase !== "completed"
    ? html`<form method="post" action="/work/${encodeURIComponent(selected.id)}/activate" class="inline-form">
        <button type="submit" class="secondary">设为当前工作项</button>
      </form>`
    : "";
  const refs = selected
    ? html`<section class="card">
        <h2 style="margin-top:0">关联证据</h2>
        <p class="muted">由输入来源自动串联，不需要手工维护。</p>
        <div class="work-metrics">
          <div class="work-metric"><strong>${selected.rawIds.length}</strong><span>原始输入</span></div>
          <div class="work-metric"><strong>${selected.pageSlugs.length}</strong><span>知识页</span></div>
          <div class="work-metric"><strong>${selected.chatRunIds.length}</strong><span>Chat Runs</span></div>
          <div class="work-metric"><strong>${selected.taskRunIds.length}</strong><span>Task Runs</span></div>
        </div>
        ${selected.rawIds.length > 0 ? html`<div class="work-ref-group"><strong>Raw</strong>${selected.rawIds.map((id) =>
          html`<a href="/spaces/${encodeURIComponent(selected.space)}/raw/${encodeURIComponent(id)}">${id}</a>`)}</div>` : ""}
        ${selected.pageSlugs.length > 0 ? html`<div class="work-ref-group"><strong>Wiki</strong>${selected.pageSlugs.map((slug) =>
          html`<a href="/spaces/${encodeURIComponent(selected.space)}/pages/${encodeURIComponent(slug)}">${slug}</a>`)}</div>` : ""}
        ${selected.chatRunIds.length > 0 ? html`<div class="work-ref-group"><strong>Chat Runs</strong>${selected.chatRunIds.map((id) =>
          html`<a href="/chats/runs/${encodeURIComponent(id)}">${id}</a>`)}</div>` : ""}
        ${selected.taskRunIds.length > 0 ? html`<div class="work-ref-group"><strong>Task Runs</strong>${selected.taskRunIds.map((id) =>
          html`<a href="/tasks/runs/${encodeURIComponent(id)}">${id}</a>`)}</div>` : ""}
      </section>`
    : "";
  const actionStatus: Record<WorkAction["status"], string> = {
    queued: "等待执行",
    awaiting_approval: "等待审批",
    running: "执行中",
    awaiting_acceptance: "待验收",
    succeeded: "已完成",
    blocked: "受阻",
    cancelled: "已取消",
  };
  const activeAction = actions.find((action) =>
    ["queued", "awaiting_approval", "running", "awaiting_acceptance"].includes(action.status));
  const latestAction = actions[0];
  const reportAction = activeAction?.status === "awaiting_acceptance"
    ? activeAction
    : latestAction;
  const reportAcceptance = reportAction?.acceptances?.at(-1);
  const latestRunId = latestAction?.taskRunIds.at(-1);
  const blockedAction = latestAction?.status === "blocked" ? latestAction : undefined;
  const retryAction = latestAction
    && ["blocked", "cancelled"].includes(latestAction.status)
    && latestAction.instruction === selected?.nextActions[0]
    ? latestAction
    : undefined;
  const canContinue = selected
    && selected.active
    && selected.phase === "active"
    && selected.blockers.length === 0
    && selected.nextActions.length > 0
    && !activeAction
    && !retryAction;
  const controls = selected
    ? html`<section class="card work-continuation">
        <div class="work-continuation-head">
          <div>
            <p class="work-kicker">Continuation control</p>
            <h2>下一动作</h2>
            <p class="work-next-action">${activeAction?.instruction ?? retryAction?.instruction
              ?? blockedAction?.instruction
              ?? selected.nextActions[0] ?? "等待补充下一步"}</p>
          </div>
          ${activeAction
            ? html`<span class="work-action-state ${activeAction.status}">${actionStatus[activeAction.status]}</span>`
            : retryAction
              ? html`<span class="work-action-state ${retryAction.status}">${actionStatus[retryAction.status]}</span>`
              : blockedAction
                ? html`<span class="work-action-state blocked">${actionStatus.blocked}</span>`
              : html`<span class="work-action-state idle">空闲</span>`}
        </div>
        <div class="work-control-row">
          ${canContinue ? html`<form method="post" action="/work/${encodeURIComponent(selected.id)}/continue">
              <button type="submit">继续一次</button>
            </form>` : ""}
          ${activeAction && ["queued", "awaiting_approval", "running"].includes(activeAction.status)
            ? html`<form method="post" action="/work/actions/${encodeURIComponent(activeAction.id)}/cancel">
              <input type="hidden" name="runId" value="${activeAction.taskRunIds.at(-1) ?? ""}" />
              <input type="hidden" name="attempt" value="${activeAction.attempt}" />
              <button type="submit" class="secondary">取消当前动作</button>
            </form>` : ""}
          ${retryAction ? html`<form method="post" action="/work/actions/${encodeURIComponent(retryAction.id)}/retry">
              <input type="hidden" name="runId" value="${retryAction.taskRunIds.at(-1) ?? ""}" />
              <input type="hidden" name="attempt" value="${retryAction.attempt}" />
              <button type="submit">从动作边界重试</button>
            </form>` : ""}
          ${blockedAction ? html`
            <form method="post" action="/work/actions/${encodeURIComponent(blockedAction.id)}/abandon">
              <input type="hidden" name="runId" value="${blockedAction.taskRunIds.at(-1) ?? ""}" />
              <input type="hidden" name="attempt" value="${blockedAction.attempt}" />
              <button type="submit" class="secondary">放弃受阻动作</button>
            </form>` : ""}
          ${latestRunId ? html`<a class="btn secondary" href="/tasks/runs/${encodeURIComponent(latestRunId)}">查看 Run</a>` : ""}
          <form method="post" action="/work/${encodeURIComponent(selected.id)}/continuation" class="work-auto-form">
            <label><input type="checkbox" name="autoContinue" ${continuationPolicy?.autoContinue ? "checked" : ""} />
              自动续跑 <span class="hint">每轮最多一个动作</span></label>
            <button type="submit" class="secondary">保存</button>
          </form>
        </div>
        ${reportAction && reportAcceptance
          ? workAcceptanceView(reportAction, reportAcceptance, selected.space)
          : ""}
        ${actions.length > 0 ? html`<div class="work-action-timeline">
          ${actions.map((action) => html`<article class="work-action-row">
            <span class="work-action-pin ${action.status}" aria-hidden="true"></span>
            <div>
              <div class="work-action-title"><strong>${action.instruction}</strong>
                <span>${actionStatus[action.status]} · 第 ${action.attempt} 次</span></div>
              ${action.checkpoint ? html`<p>${action.checkpoint.summary}</p>` : ""}
              ${action.error ? html`<p class="work-action-error">${action.error}</p>` : ""}
              ${action.acceptances?.at(-1)?.status !== "pending"
                && action.acceptances?.at(-1)?.decidedBy
                ? html`<p>验收：${action.acceptances.at(-1)!.status === "accepted" ? "已接受" : "已驳回"}
                    · ${action.acceptances.at(-1)!.decidedBy}
                    · ${fmtTime(action.acceptances.at(-1)!.decidedAt)}</p>` : ""}
              <div class="work-run-links">${action.taskRunIds.map((runId) =>
                html`<a href="/tasks/runs/${encodeURIComponent(runId)}">${runId}</a>`)}</div>
            </div>
          </article>`)}
        </div>` : ""}
      </section>`
    : "";

  return html`<h1>工作上下文</h1>
    <p class="subtitle">把目标、当前进展、下一步和证据放在同一条工作线上；新的输入与运行会自动归入当前项。</p>
    <div class="split">
      <div class="listcol">
        <a class="item ${newActive}" href="/work"><div class="name">＋ 新建工作项</div>
          <div class="sub">开始一条新的工作线</div></a>
        ${listItems}
      </div>
      <div>
        ${flash(flashMsg)}
        ${controls}
        <section class="card work-editor">
          <p class="work-kicker">Operational context</p>
          <div class="work-head">
            <div><h2>${selected ? selected.title : "建立工作项"}</h2>
              ${selected?.active ? html`<span class="work-current">● 当前工作项</span>` : ""}
            </div>
            ${activation}
          </div>
          <form method="post" action="${formAction}" class="stack">
            <div class="field"><label>标题</label>
              <input type="text" name="title" value="${selected?.title ?? ""}" placeholder="例如：完成知识治理灰度" required maxlength="200" />
            </div>
            <div class="grid2">
              ${spaceField}
              <div class="field"><label>阶段</label><select name="phase">
                ${Object.entries(WORK_PHASE_LABELS).map(([value, label]) =>
                  html`<option value="${value}" ${phase === value ? "selected" : ""}>${label}</option>`) }
              </select></div>
            </div>
            <div class="field"><label>Brief <span class="hint">目标、范围与验收标准</span></label>
              <textarea name="brief" placeholder="为什么做、做到什么程度算完成">${selected?.brief ?? ""}</textarea>
            </div>
            <div class="field"><label>当前进展</label>
              <textarea name="summary" placeholder="现在已经确认了什么">${selected?.summary ?? ""}</textarea>
            </div>
            <div class="grid2">
              <div class="field"><label>阻塞项 <span class="hint">每行一项</span></label>
                <textarea name="blockers" placeholder="暂无">${selected?.blockers.join("\n") ?? ""}</textarea>
              </div>
              <div class="field"><label>下一步 <span class="hint">每行一项</span></label>
                <textarea name="nextActions" placeholder="下一件可执行的事">${selected?.nextActions.join("\n") ?? ""}</textarea>
              </div>
            </div>
            <div class="field"><label>Runbook <span class="hint">已验证的操作步骤</span></label>
              <textarea name="runbook" style="min-height:150px" placeholder="1. …">${selected?.runbook ?? ""}</textarea>
            </div>
            <div class="actions"><button type="submit">${selected ? "保存上下文" : "创建并设为当前"}</button></div>
          </form>
        </section>
        ${refs}
      </div>
    </div>`;
}

// ---- Tasks (research task execution) ---------------------------------------

const CADENCE_LABELS: Record<string, string> = {
  hourly: "每小时",
  daily: "每天",
  weekly: "每周",
};
const WEEKDAY_LABELS: Record<number, string> = {
  1: "周一",
  2: "周二",
  3: "周三",
  4: "周四",
  5: "周五",
  6: "周六",
  7: "周日",
};

function taskCadenceLabel(task: Task): string {
  if (task.cadence === "hourly") return CADENCE_LABELS.hourly!;
  if (task.cadence === "weekly") {
    return `每${WEEKDAY_LABELS[task.dayOfWeek] ?? "周一"} ${task.hour}:00`;
  }
  return `每天 ${task.hour}:00`;
}

/** Tasks page: list column + right editor. `selected` is the task being edited (or null = new). */
export function tasksView(
  tasks: Task[],
  selected: Task | null,
  spaces: SpaceMeta[],
  runs: TaskRun[] = [],
  flashMsg?: string,
): HtmlEscapedString | Promise<HtmlEscapedString> {
  const statusBadge = (t: Task) => {
    if (!t.lastStatus) return html`<span class="muted">未运行</span>`;
    return t.lastStatus === "ok"
      ? html`<span class="badge knowledge">成功</span>`
      : html`<span class="badge general">失败</span>`;
  };
  const listItems = tasks.map((t) => {
    const active = selected && t.id === selected.id;
    return html`<a class="item ${active ? "active" : ""}" href="/tasks/${encodeURIComponent(t.id)}">
      <div class="name"><span class="dot" style="${t.enabled ? "" : "background:#cbd5e1"}"></span>${t.name}</div>
      <div class="sub">${taskCadenceLabel(t)} · ${t.space}</div>
    </a>`;
  });
  const newActive = selected === null ? "active" : "";

  const editing = selected;
  const formAction = editing ? `/tasks/${encodeURIComponent(editing.id)}` : "/tasks";
  const submitLabel = editing ? "保存" : "创建";
  const nameVal = editing?.name ?? "";
  const topicVal = editing?.topic ?? "";
  const spaceVal = editing?.space ?? spaces[0]?.id ?? "";
  const cadenceVal = editing?.cadence ?? "daily";
  const hourVal = editing?.hour ?? 8;
  const dayOfWeekVal = editing?.dayOfWeek ?? 1;
  const enabledOn = editing ? editing.enabled : true;
  const notifyOn = editing ? editing.notify : true;
  const distillOn = editing ? editing.distillOnRun : true;
  const timeoutMinutes = editing?.timeoutMinutes ?? DEFAULT_TASK_TIMEOUT_MINUTES;

  const spaceOptions = spaces.length
    ? spaces.map((s) => html`<option value="${s.id}" ${s.id === spaceVal ? "selected" : ""}>${s.name?.trim() || s.id}</option>`)
    : [html`<option value="">（还没有空间，先让机器人进群或私聊）</option>`];

  const deleteControl = editing
    ? html`<button type="submit" class="danger"
        formaction="/tasks/${encodeURIComponent(editing.id)}/delete" formmethod="post"
        onclick="return confirm('删除该任务？')">删除</button>`
    : "";
  const activeRun = runs.find((run) =>
    ["awaiting_approval", "queued", "running"].includes(run.status)
  );
  const runControl = editing
    ? activeRun
      ? html`<a href="/tasks/runs/${encodeURIComponent(activeRun.id)}">${activeRun.status === "awaiting_approval"
          ? "查看待审批申请"
          : activeRun.status === "queued"
            ? "查看排队任务"
            : "查看运行中任务"}</a>`
      : html`<button type="submit" class="secondary"
          formaction="/tasks/${encodeURIComponent(editing.id)}/run" formmethod="post">立即运行</button>`
    : "";

  const lastRun = editing?.lastRunAt
    ? html`<div class="muted" style="margin-top:8px">上次运行：${fmtTime(editing.lastRunAt)} · ${statusBadge(editing)}</div>
        ${editing.lastStatus === "error" && editing.lastError
          ? html`<div class="muted">错误：${editing.lastError.slice(0, 200)}</div>`
          : ""}
        ${editing.lastSummary ? html`<div class="contentbox" style="margin-top:8px">${editing.lastSummary}</div>` : ""}`
    : "";
  const runHistory = editing
    ? html`<div class="card" style="margin-top:16px">
        <h2>运行历史</h2>
        ${runs.length === 0
          ? html`<div class="empty">还没有运行记录。</div>`
          : html`<table>
              <tr><th>状态</th><th>触发方式</th><th>开始时间</th><th>耗时</th></tr>
              ${runs.map((run) => html`<tr>
                <td><a href="/tasks/runs/${encodeURIComponent(run.id)}">${taskRunStatus(run.status)}</a></td>
                <td>${taskRunTrigger(run.trigger)}</td>
                <td>${fmtTime(run.startedAt)}</td>
                <td>${taskRunDuration(run)}</td>
              </tr>`)}
            </table>`}
      </div>`
    : "";

  return html`<h1>任务</h1>
    <p class="subtitle">让空间的 Agent 定期研究一个主题，结果写入该空间知识库（夜间提炼成页）并可推送到飞书。</p>
    <div class="split">
      <div class="listcol">
        <a class="item ${newActive}" href="/tasks"><div class="name">＋ 新建任务</div>
          <div class="sub">创建一个研究任务</div></a>
        ${listItems}
      </div>
      <div>
        ${flash(flashMsg)}
        <form method="post" action="${formAction}" class="stack card">
          <div class="field">
            <label>名称</label>
            <input type="text" name="name" value="${nameVal}" placeholder="例如：每日 AI 进展" required />
          </div>
          <div class="field">
            <label>研究主题 <span class="hint">交给空间 Agent 的调研提示</span></label>
            <textarea name="topic" placeholder="例如：总结大模型 Agent 领域本周的重要进展与观点">${topicVal}</textarea>
          </div>
          <div class="grid2">
            <div class="field">
              <label>目标空间 <span class="hint">结果写入这里，用其 Agent</span></label>
              <select name="space">${spaceOptions}</select>
            </div>
            <div class="field">
              <label>周期</label>
              <select name="cadence">
                ${TASK_CADENCES.map(
                  (c) => html`<option value="${c}" ${c === cadenceVal ? "selected" : ""}>${CADENCE_LABELS[c] ?? c}</option>`,
                )}
              </select>
            </div>
            <div class="field">
              <label>星期 <span class="hint">仅每周周期使用</span></label>
              <select name="dayOfWeek">
                ${Object.entries(WEEKDAY_LABELS).map(([day, label]) =>
                  html`<option value="${day}" ${Number(day) === dayOfWeekVal ? "selected" : ""}>${label}</option>`
                )}
              </select>
            </div>
            <div class="field">
              <label>执行时间 <span class="hint">0-23，每天/每周周期使用</span></label>
              <input type="number" min="0" max="23" name="hour" value="${hourVal}" />
            </div>
            <div class="field">
              <label>最长运行时间 <span class="hint">分钟，超时会终止 CLI 进程</span></label>
              <input type="number" min="1" max="60" name="timeoutMinutes" value="${timeoutMinutes}" />
            </div>
          </div>
          <div class="toggle-row">
            <div><strong>启用</strong><div class="hint">关闭后调度器不会自动运行</div></div>
            <label class="switch"><input type="checkbox" name="enabled" ${enabledOn ? "checked" : ""} /><span class="slider"></span></label>
          </div>
          <div class="toggle-row">
            <div><strong>推送飞书</strong><div class="hint">完成后把摘要发到空间绑定的群/私聊</div></div>
            <label class="switch"><input type="checkbox" name="notify" ${notifyOn ? "checked" : ""} /><span class="slider"></span></label>
          </div>
          <div class="toggle-row">
            <div><strong>完成后立即提炼</strong><div class="hint">运行结束就把结果提炼成知识页（关闭则等夜间提炼）</div></div>
            <label class="switch"><input type="checkbox" name="distillOnRun" ${distillOn ? "checked" : ""} /><span class="slider"></span></label>
          </div>
          ${lastRun}
          <div class="actions">
            <button type="submit">${submitLabel}</button>
            ${runControl}
            ${deleteControl}
          </div>
        </form>
        ${runHistory}
      </div>
    </div>`;
}

function taskRunStatus(status: TaskRun["status"]): HtmlEscapedString | Promise<HtmlEscapedString> {
  if (status === "awaiting_approval") return html`<span class="badge general">待审批</span>`;
  if (status === "queued") return html`<span class="badge general">排队中</span>`;
  if (status === "running") return html`<span class="badge general">运行中</span>`;
  if (status === "succeeded") return html`<span class="badge knowledge">成功</span>`;
  if (status === "cancelled") return html`<span class="badge general">已取消</span>`;
  if (status === "timed_out") return html`<span class="badge general">已超时</span>`;
  return html`<span class="badge general">失败</span>`;
}

function taskRunTrigger(trigger: TaskRun["trigger"]): string {
  return {
    manual: "后台手动",
    scheduled: "定时调度",
    chat: "飞书命令",
    retry: "失败重试",
  }[trigger];
}

function taskRunDuration(run: TaskRun): string {
  if (!run.finishedAt) {
    if (run.status === "awaiting_approval") return "等待审批";
    return run.status === "queued" ? "排队中" : "运行中";
  }
  const milliseconds = Math.max(0, run.finishedAt - (run.runStartedAt ?? run.startedAt));
  if (milliseconds < 1000) return `${milliseconds} ms`;
  return `${(milliseconds / 1000).toFixed(1)} 秒`;
}

function taskRunTimeout(run: TaskRun): string {
  if (!run.timeoutMs) return "—";
  if (run.timeoutMs < 60_000) return `${run.timeoutMs} ms`;
  return `${run.timeoutMs / 60_000} 分钟`;
}

export function taskRunView(
  run: TaskRun,
  task: Task | undefined,
  flashMsg?: string,
  queue?: RunQueueInfo,
  workContext?: { action: WorkAction; item: WorkItem },
): HtmlEscapedString | Promise<HtmlEscapedString> {
  const workAcceptance = workContext?.action.acceptances?.find(
    (acceptance) => acceptance.taskRunId === run.id,
  );
  const waitingAutomaticRetry = run.status === "failed" && run.retry?.status === "waiting";
  const retryForm = ["failed", "cancelled", "timed_out"].includes(run.status) && task
    ? html`<form method="post" action="/tasks/runs/${encodeURIComponent(run.id)}/retry" class="inline-form">
        <button type="submit">重新运行</button>
      </form>`
    : "";
  const cancelForm = waitingAutomaticRetry
    || ["awaiting_approval", "queued", "running"].includes(run.status)
    ? html`<form method="post" action="/tasks/runs/${encodeURIComponent(run.id)}/cancel" class="inline-form"
        onsubmit="return confirm('${waitingAutomaticRetry ? "取消这次自动重试？" : "取消这次运行？"}')">
        <button type="submit" class="danger">${waitingAutomaticRetry
          ? "取消自动重试"
          : run.status === "awaiting_approval"
            ? "撤销申请"
            : "取消运行"}</button>
      </form>`
    : "";
  const approval = run.approval;
  const approvalActions = run.status === "awaiting_approval" && approval?.status === "pending"
    ? html`<form method="post" action="/tasks/runs/${encodeURIComponent(run.id)}/approve" class="inline-form">
        <button type="submit">批准并执行</button>
      </form>
      <form method="post" action="/tasks/runs/${encodeURIComponent(run.id)}/reject" class="inline-form"
        onsubmit="return confirm('拒绝这次高权限执行申请？')">
        <button type="submit" class="danger">拒绝</button>
      </form>`
    : "";
  const execution = run.executionPlan?.execution;
  const notification = run.notification;
  const notificationLabel = notification?.status === "sent"
    ? "已发送"
    : notification?.status === "failed"
      ? "通知失败"
      : notification
        ? "待发送"
        : "未请求";
  const notificationRetry = notification?.status === "failed"
    ? html`<form method="post" action="/tasks/runs/${encodeURIComponent(run.id)}/notification/retry" class="inline-form">
        <button type="submit" class="secondary">重试通知</button>
      </form>`
    : "";
  const skillEvidence = run.skillEvidence;
  const skillWarnings = skillEvidence
    ? skillWarningViews({ skipped: skillEvidence.skipped })
    : [];
  const failurePhase = run.failure?.phase === "provider"
    ? "Provider"
    : run.failure?.phase === "admission"
      ? "执行准入"
      : run.failure?.phase === "capture"
        ? "知识写入"
        : undefined;
  const automaticRetry = run.retry
    ? html`<div class="contentbox">
        <strong>自动重试</strong>
        <div>尝试次数：${run.retry.attempt} / ${run.retry.maxAttempts}</div>
        ${run.retry.status === "waiting"
          ? html`<div>状态：等待自动重试${run.retry.nextAttemptAt
              ? html` · 计划时间 ${fmtTime(run.retry.nextAttemptAt)}`
              : ""}</div>`
          : run.retry.status === "claimed"
            ? html`<div>状态：已认领${run.retry.claimedByRunId
                ? html` · <a href="/tasks/runs/${encodeURIComponent(run.retry.claimedByRunId)}">查看重试运行</a>`
                : ""}</div>`
            : html`<div>状态：自动重试已结束</div>`}
      </div>`
    : "";
  return html`<h1>运行详情</h1>
    <p class="subtitle">
      ${workContext
        ? html`<a href="/work/${encodeURIComponent(workContext.item.id)}">${workContext.item.title}</a>`
        : html`<a href="/tasks/${encodeURIComponent(run.taskId)}">${run.taskName}</a>`}
      · ${run.id}
    </p>
    ${flash(flashMsg)}
    ${workContext && workAcceptance
      ? workAcceptanceView(workContext.action, workAcceptance, workContext.item.space)
      : ""}
    <div class="card stack">
      <div><strong>状态：</strong>${taskRunStatus(run.status)}</div>
      ${approval
        ? html`<div class="contentbox">
            <strong>高权限执行审批</strong>
            ${approval.status === "expired"
              ? html`<div><strong>审批已过期</strong></div>`
              : ""}
            <div>权限：<code>${execution?.permission ?? "unknown"}</code></div>
            <div>Workdir：<code>${execution?.workdir ?? "—"}</code></div>
            <div>Provider / Model：${run.executionPlan?.provider ?? "—"} / ${run.executionPlan?.model ?? "默认"}</div>
            ${run.executionPlan?.agentRevisionId
              ? html`<div>Agent 发布版本：<code>${run.executionPlan.agentRevisionId}</code></div>`
              : ""}
            <div><strong>冻结任务主题</strong><div class="contentbox">${run.topic}</div></div>
            <details>
              <summary>冻结 Agent Instruction</summary>
              <div class="contentbox">${run.executionPlan?.instruction || "—"}</div>
            </details>
            <div>申请时间：${fmtTime(approval.requestedAt)}</div>
            ${approval.expiresAt ? html`<div>审批截止：${fmtTime(approval.expiresAt)}</div>` : ""}
            ${approval.decidedAt ? html`<div>决定时间：${fmtTime(approval.decidedAt)}</div>` : ""}
            ${approval.decidedBy ? html`<div>决定人：${approval.decidedBy}</div>` : ""}
            ${approval.reason ? html`<div>原因：${approval.reason}</div>` : ""}
          </div>`
        : ""}
      <div><strong>触发方式：</strong>${taskRunTrigger(run.trigger)}</div>
      <div><strong>排队时间：</strong>${fmtTime(run.queuedAt)}</div>
      <div><strong>开始时间：</strong>${fmtTime(run.runStartedAt)}</div>
      ${queue
        ? html`<div><strong>队列位置：</strong>第 ${queue.position} 位 · 已等待 ${Math.round(queue.waitedMs / 1000)} 秒</div>`
        : ""}
      <div><strong>完成时间：</strong>${fmtTime(run.finishedAt)} · ${taskRunDuration(run)}</div>
      <div><strong>运行上限：</strong>${taskRunTimeout(run)}</div>
      ${run.usage ? runUsageView(run.usage) : ""}
      ${run.failure
        ? html`<div><strong>失败分类：</strong>${failurePhase ?? run.failure.phase} · ${run.failure.kind}
            · ${run.failure.retryable ? "可自动重试" : "不可自动重试"}</div>`
        : ""}
      ${automaticRetry}
      <div><strong>飞书通知：</strong>${notificationLabel}${notification ? ` · 已尝试 ${notification.attempts} 次` : ""}</div>
      ${notification?.nextAttemptAt
        && notification.status !== "sent"
        && notification.attempts < MAX_TASK_NOTIFICATION_ATTEMPTS
        ? html`<div><strong>下次自动重试：</strong>${fmtTime(notification.nextAttemptAt)}</div>`
        : ""}
      ${notification?.status === "failed"
        && notification.attempts >= MAX_TASK_NOTIFICATION_ATTEMPTS
        ? html`<div class="muted">自动重试已停止，可手动重试通知。</div>`
        : ""}
      ${notification?.error
        ? html`<div><strong>通知错误：</strong><span class="muted">${notification.error}</span></div>`
        : ""}
      ${run.retryOf
        ? html`<div><strong>重试来源：</strong><a href="/tasks/runs/${encodeURIComponent(run.retryOf)}">${run.retryOf}</a></div>`
        : ""}
      ${skillEvidence
        ? html`<div>
            <strong>Skill 解析：</strong>
            请求 ${skillEvidence.requested.length} ·
            已加载 ${skillEvidence.resolved.length} ·
            跳过 ${skillEvidence.skipped.length}
            ${skillEvidence.resolved.length > 0
              ? html`<ul>${skillEvidence.resolved.map((skill) =>
                  html`<li><code>${skill.name}</code> · ${skill.sourceKey} ·
                    sha256 ${skill.skillFileHash.slice(0, 12)}</li>`
                )}</ul>`
              : ""}
            ${skillWarnings.length > 0
              ? html`<ul>${skillWarnings.map((warning) =>
                  html`<li><code>${warning.name}</code>：${warning.message}</li>`
                )}</ul>`
              : ""}
          </div>`
        : ""}
      ${run.rawId
        ? html`<div><strong>原始记录：</strong><a href="/spaces/${encodeURIComponent(run.space)}/raw/${encodeURIComponent(run.rawId)}">${run.rawId}</a></div>`
        : ""}
      ${run.pagesWritten !== undefined ? html`<div><strong>写入知识页：</strong>${run.pagesWritten}</div>` : ""}
      ${run.output
        ? html`<div><strong>运行输出</strong><div class="contentbox" style="margin-top:8px">${run.output}</div>
            ${run.outputTruncated ? html`<div class="muted">输出过长，运行记录仅保留前 100,000 个字符。</div>` : ""}</div>`
        : ""}
      ${run.error ? html`<div><strong>错误</strong><div class="contentbox" style="margin-top:8px">${run.error}</div></div>` : ""}
      <div class="actions">${approvalActions}${cancelForm}${retryForm}${notificationRetry}</div>
    </div>`;
}

const CHAT_RUN_ERROR_LABELS: Record<NonNullable<ChatRun["error"]>["kind"], string> = {
  interrupted: "进程中断",
  cancelled: "已取消",
  timeout: "请求超时",
  authentication: "鉴权失败",
  provider_unavailable: "Provider 不可用",
  process_exit: "Provider 进程退出",
  unknown: "未知错误",
};

export function chatRunView(
  run: ChatRun,
  flashMsg?: string,
  queue?: RunQueueInfo,
  reruns: QualityRerun[] = [],
): HtmlEscapedString | Promise<HtmlEscapedString> {
  const retryable =
    ["failed", "cancelled", "timed_out"].includes(run.status)
    || (
      run.status === "succeeded"
      && run.delivery.status !== "sent"
      && Boolean(run.output)
    );
  const cancellable = run.status === "queued" || run.status === "running";
  const evaluable = run.status === "succeeded"
    && run.traceId !== undefined
    && run.executionPlan !== undefined;
  const status = run.status === "queued"
    ? html`<span class="badge">排队中</span>`
    : run.status === "running"
    ? html`<span class="badge">运行中</span>`
    : run.status === "succeeded"
      ? html`<span class="badge knowledge">成功</span>`
      : run.status === "timed_out"
        ? html`<span class="badge general">已超时</span>`
        : html`<span class="badge general">失败</span>`;
  const deliveryLabel = run.delivery.status === "sent"
    ? "已发送"
    : run.delivery.status === "failed"
      ? "发送失败"
      : "待发送";
  const milliseconds = run.finishedAt
    ? Math.max(0, run.finishedAt - (run.runStartedAt ?? run.startedAt))
    : undefined;
  const duration = milliseconds === undefined
    ? run.status === "queued" ? "排队中" : "运行中"
    : milliseconds < 1000
      ? `${milliseconds} ms`
      : `${(milliseconds / 1000).toFixed(1)} 秒`;
  const skillEvidence = run.skillEvidence;
  return html`<h1>Chat Run 详情</h1>
    <p class="subtitle">${run.id}</p>
    ${flash(flashMsg)}
    <div class="card stack">
      <div><strong>状态：</strong>${status}</div>
      <div><strong>排队时间：</strong>${fmtTime(run.queuedAt)}</div>
      <div><strong>开始时间：</strong>${fmtTime(run.runStartedAt)}</div>
      ${queue
        ? html`<div><strong>队列位置：</strong>第 ${queue.position} 位 · 已等待 ${Math.round(queue.waitedMs / 1000)} 秒</div>`
        : ""}
      <div><strong>完成时间：</strong>${fmtTime(run.finishedAt)} · ${duration}</div>
      <div><strong>执行快照：</strong>${run.provider ?? "未记录"} / ${run.model || "CLI 默认模型"}
        ${run.reasoningEffort ? ` · reasoning ${run.reasoningEffort}` : ""}</div>
      <div><strong>空间：</strong>${run.space}</div>
      <div><strong>投递：</strong>${deliveryLabel} · 已尝试 ${run.delivery.attempts} 次</div>
      ${run.usage ? runUsageView(run.usage) : ""}
      ${run.delivery.lastAttemptAt
        ? html`<div><strong>最近投递：</strong>${fmtTime(run.delivery.lastAttemptAt)}</div>`
        : ""}
      ${run.delivery.error
        ? html`<div><strong>投递错误：</strong><span class="muted">${run.delivery.error}</span></div>`
        : ""}
      ${run.retryOf
        ? html`<div><strong>重试来源：</strong><a href="/chats/runs/${encodeURIComponent(run.retryOf)}">${run.retryOf}</a></div>`
        : ""}
      ${run.rawId
        ? html`<div><strong>原始记录：</strong><a href="/spaces/${encodeURIComponent(run.space)}/raw/${encodeURIComponent(run.rawId)}">${run.rawId}</a></div>`
        : ""}
      ${skillEvidence
        ? html`<div><strong>Skill 解析：</strong>
            请求 ${skillEvidence.requested.length} ·
            已加载 ${skillEvidence.resolved.length} ·
            跳过 ${skillEvidence.skipped.length}
            ${skillEvidence.resolved.length > 0
              ? html`<ul>${skillEvidence.resolved.map((skill) =>
                  html`<li><code>${skill.name}</code> · ${skill.sourceKey} ·
                    sha256 ${skill.skillFileHash.slice(0, 12)}</li>`
                )}</ul>`
              : ""}
          </div>`
        : ""}
      <div><strong>输入</strong><div class="contentbox" style="margin-top:8px">${run.input}</div>
        ${run.inputTruncated ? html`<div class="muted">输入过长，重试只会使用已保留的前 100,000 个字符。</div>` : ""}
      </div>
      ${run.output
        ? html`<div><strong>模型输出</strong><div class="contentbox" style="margin-top:8px">${run.output}</div>
            ${run.outputTruncated ? html`<div class="muted">输出过长，运行记录仅保留前 100,000 个字符。</div>` : ""}</div>`
        : ""}
      ${run.error
        ? html`<div><strong>${CHAT_RUN_ERROR_LABELS[run.error.kind]}</strong>
            <div class="contentbox" style="margin-top:8px">${run.error.message}</div></div>`
        : ""}
      ${reruns.length > 0
        ? html`<div><strong>重新评测：</strong><ul>${reruns.map((rerun) => html`<li>
            ${fmtTime(rerun.createdAt)} · ${rerun.status === "completed" ? "已完成" : rerun.status === "failed" ? "失败" : "运行中"}
            ${rerun.candidateTraceId ? ` · candidate ${rerun.candidateTraceId}` : ""}
            ${rerun.error ? ` · ${rerun.error}` : ""}
          </li>`)}</ul></div>`
        : ""}
      ${cancellable || retryable || evaluable
        ? html`<div class="actions">
            ${cancellable
              ? html`<form method="post" action="/chats/runs/${encodeURIComponent(run.id)}/cancel" class="inline-form"
                  onsubmit="return confirm('取消这次 Chat Run？')">
                  <button type="submit" class="danger">取消运行</button>
                </form>`
              : ""}
            ${retryable ? html`
            <form method="post" action="/chats/runs/${encodeURIComponent(run.id)}/retry" class="inline-form">
              <button type="submit">${run.status === "succeeded" ? "重试投递" : "重试文本回答"}</button>
            </form>
            ` : ""}
            ${evaluable ? html`
            <form method="post" action="/chats/runs/${encodeURIComponent(run.id)}/evaluate" class="inline-form">
              <button type="submit" class="secondary">按冻结快照重新评测</button>
            </form>
            ` : ""}
          </div>`
        : ""}
    </div>`;
}

// ---- Reminders ------------------------------------------------------------

const REMINDER_STATUS_LABELS: Record<Reminder["status"], string> = {
  scheduled: "待提醒",
  completed: "已完成",
  cancelled: "已取消",
};

export function remindersView(
  reminders: Reminder[],
  flashMsg?: string,
): HtmlEscapedString | Promise<HtmlEscapedString> {
  const rows = reminders.map((reminder) => {
    const controls = reminder.status === "scheduled"
      ? html`<div class="actions">
          <form method="post" action="/reminders/${encodeURIComponent(reminder.id)}/complete" class="inline-form">
            <button type="submit" class="secondary">标记完成</button>
          </form>
          <form method="post" action="/reminders/${encodeURIComponent(reminder.id)}/cancel" class="inline-form"
            onsubmit="return confirm('取消该提醒？')">
            <button type="submit" class="danger">取消提醒</button>
          </form>
        </div>`
      : "";
    return html`<tr>
      <td><strong>${reminder.title}</strong><div class="muted">${reminder.id}</div></td>
      <td>${fmtTime(reminder.nextTriggerAt)}</td>
      <td><span class="badge ${reminder.status === "scheduled" ? "knowledge" : "general"}">${REMINDER_STATUS_LABELS[reminder.status]}</span>
        ${reminder.untilConfirmed && reminder.repeatEveryMs
          ? html`<div class="muted">每 ${Math.round(reminder.repeatEveryMs / 3600_000)} 小时，直到确认</div>`
          : ""}</td>
      <td>${reminder.space}<div class="muted">创建者：${reminder.creatorId}</div></td>
      <td>${controls}</td>
    </tr>`;
  });
  return html`<h1>提醒</h1>
    <p class="subtitle">通过飞书对机器人说“明天上午 9 点提醒我……”即可创建。这里显示持久化状态并提供管理员控制。</p>
    ${flash(flashMsg)}
    ${rows.length > 0
      ? html`<table>
          <tr><th>内容</th><th>下次提醒</th><th>状态</th><th>空间</th><th>操作</th></tr>
          ${rows}
        </table>`
      : html`<div class="empty">还没有提醒。</div>`}`;
}

// ---- Guided learning ------------------------------------------------------

const LEARNING_STATUS_LABELS: Record<LearningPlan["status"], string> = {
  active: "进行中",
  paused: "已暂停",
  completed: "已完成",
};

const LEARNING_SESSION_LABELS: Record<LearningSession["status"], string> = {
  prepared: "待推送",
  awaiting_reply: "等待回答",
  completed: "已完成",
  skipped: "已跳过",
};

const LEARNING_STUDIO_STYLE = `
  .learning-studio {
    --paper:#f4efe3; --paper-deep:#e9dfca; --ink:#172b2a; --ink-soft:#52615d;
    --forest:#0f5c4d; --forest-soft:#dcebe3; --amber:#d8832f; --amber-soft:#f7e5c8;
    --coral:#bc5746; --line:rgba(23,43,42,.16);
    color:var(--ink); font-family:"Avenir Next","PingFang SC","Microsoft YaHei",sans-serif;
  }
  .learning-studio * { box-sizing:border-box; }
  .learning-studio .studio-title {
    font-family:"Songti SC","STSong",Georgia,serif; font-size:32px; letter-spacing:-.04em;
    margin:0; color:var(--ink);
  }
  .learning-studio .studio-kicker {
    color:var(--amber); font-size:11px; font-weight:800; letter-spacing:.18em;
    text-transform:uppercase; margin-bottom:7px;
  }
  .learning-studio .studio-subtitle { color:var(--ink-soft); max-width:700px; margin:7px 0 22px; }
  .learning-studio .learning-layout {
    display:grid; grid-template-columns:220px minmax(0,1fr); gap:20px; align-items:start;
  }
  .learning-studio .plan-index { position:sticky; top:18px; }
  .learning-studio .plan-tab {
    display:block; color:var(--ink); padding:13px 14px; margin-bottom:9px;
    border:1px solid var(--line); border-radius:4px 15px 15px 4px; background:rgba(255,255,255,.62);
    box-shadow:0 5px 20px rgba(47,52,43,.05); transition:transform .18s ease, border-color .18s ease;
  }
  .learning-studio .plan-tab:hover { transform:translateX(3px); text-decoration:none; border-color:var(--amber); }
  .learning-studio .plan-tab.active { background:var(--ink); color:#fff8e9; border-color:var(--ink); }
  .learning-studio .plan-tab strong { display:block; font-family:"Songti SC","STSong",Georgia,serif; font-size:15px; }
  .learning-studio .plan-tab small { display:block; opacity:.7; font-size:11px; margin-top:4px; line-height:1.45; }
  .learning-studio .learning-map {
    position:relative; overflow:hidden; border:1px solid var(--line); border-radius:22px 5px 22px 5px;
    background:
      radial-gradient(circle at 86% 6%, rgba(216,131,47,.16), transparent 25%),
      linear-gradient(rgba(255,255,255,.52), rgba(255,255,255,.52)),
      repeating-linear-gradient(0deg, transparent 0 27px, rgba(23,43,42,.035) 28px),
      var(--paper);
    box-shadow:0 18px 45px rgba(54,55,43,.12);
    animation:learning-arrive .45s ease both;
  }
  .learning-studio .learning-map:before {
    content:""; position:absolute; width:150px; height:150px; border:1px solid rgba(15,92,77,.14);
    border-radius:50%; right:-58px; top:92px; box-shadow:0 0 0 22px rgba(15,92,77,.035),0 0 0 44px rgba(15,92,77,.025);
  }
  @keyframes learning-arrive { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:none; } }
  .learning-studio .map-hero { display:grid; grid-template-columns:1fr auto; gap:24px; padding:28px 28px 24px; position:relative; }
  .learning-studio .map-eyebrow { display:flex; flex-wrap:wrap; gap:7px; margin-bottom:10px; }
  .learning-studio .map-pill {
    display:inline-flex; align-items:center; gap:5px; border:1px solid var(--line); border-radius:999px;
    padding:4px 9px; color:var(--ink-soft); background:rgba(255,255,255,.5); font-size:11px; font-weight:700;
  }
  .learning-studio .map-pill.live { background:var(--forest-soft); color:var(--forest); border-color:rgba(15,92,77,.18); }
  .learning-studio .map-name {
    font-family:"Songti SC","STSong",Georgia,serif; font-size:30px; line-height:1.12; margin:0 0 9px;
    max-width:560px; letter-spacing:-.035em;
  }
  .learning-studio .map-topic { color:var(--ink-soft); margin:0; max-width:570px; }
  .learning-studio .progress-dial {
    --progress:0; width:112px; height:112px; border-radius:50%; display:grid; place-items:center;
    background:conic-gradient(var(--amber) calc(var(--progress) * 3.6deg), rgba(23,43,42,.1) 0);
    position:relative; box-shadow:inset 0 0 0 1px rgba(23,43,42,.08);
  }
  .learning-studio .progress-dial:before { content:""; position:absolute; inset:9px; border-radius:50%; background:var(--paper); }
  .learning-studio .progress-value { position:relative; text-align:center; font-family:"Songti SC","STSong",serif; font-size:25px; line-height:1; }
  .learning-studio .progress-value small { display:block; margin-top:5px; font:700 9px/1 "Avenir Next","PingFang SC",sans-serif; letter-spacing:.12em; color:var(--ink-soft); }
  .learning-studio .map-ribbon {
    display:grid; grid-template-columns:repeat(4,1fr); border-top:1px solid var(--line); border-bottom:1px solid var(--line);
    background:rgba(255,255,255,.35);
  }
  .learning-studio .ribbon-stat { padding:14px 17px; min-width:0; }
  .learning-studio .ribbon-stat + .ribbon-stat { border-left:1px solid var(--line); }
  .learning-studio .ribbon-stat span { display:block; color:var(--ink-soft); font-size:10px; letter-spacing:.08em; }
  .learning-studio .ribbon-stat strong { display:block; margin-top:3px; font-size:13px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .learning-studio .map-body { padding:24px 28px 30px; position:relative; }
  .learning-studio .section-label {
    display:flex; align-items:center; gap:9px; margin:0 0 13px; font:800 11px/1 "Avenir Next","PingFang SC",sans-serif;
    color:var(--forest); letter-spacing:.14em; text-transform:uppercase;
  }
  .learning-studio .section-label:after { content:""; height:1px; flex:1; background:var(--line); }
  .learning-studio .assessment-card {
    padding:20px; border:1px dashed var(--amber); background:var(--amber-soft); border-radius:4px 18px 18px 18px; margin-bottom:22px;
  }
  .learning-studio .assessment-card h3 { margin:0 0 7px; font-family:"Songti SC","STSong",serif; font-size:20px; }
  .learning-studio .question-list { margin:12px 0 0; padding-left:22px; }
  .learning-studio .question-list li { margin:7px 0; }
  .learning-studio .profile-grid { display:grid; grid-template-columns:1.12fr .88fr; gap:12px; margin-bottom:24px; }
  .learning-studio .profile-card {
    padding:17px 18px; border:1px solid var(--line); background:rgba(255,255,255,.52); border-radius:4px 15px 15px 15px;
  }
  .learning-studio .profile-card.level { grid-row:span 2; background:var(--ink); color:#fff8e9; }
  .learning-studio .profile-card h3 { font-family:"Songti SC","STSong",serif; font-size:18px; margin:0 0 8px; }
  .learning-studio .profile-card p { margin:0; font-size:13px; color:inherit; opacity:.82; }
  .learning-studio .profile-level { font-family:"Songti SC","STSong",serif; font-size:36px; margin:7px 0 8px; color:#f3c071; }
  .learning-studio .profile-meta { margin-top:15px; display:flex; gap:8px; flex-wrap:wrap; }
  .learning-studio .profile-meta span { padding:4px 8px; border:1px solid rgba(255,255,255,.2); border-radius:999px; font-size:11px; }
  .learning-studio .chip-cloud { display:flex; flex-wrap:wrap; gap:6px; }
  .learning-studio .knowledge-chip { padding:4px 8px; border-radius:999px; font-size:11px; background:var(--forest-soft); color:var(--forest); }
  .learning-studio .knowledge-chip.gap { background:#f4d9d2; color:#8b3f35; }
  .learning-studio .route-note {
    border-left:4px solid var(--amber); padding:12px 14px; background:rgba(247,229,200,.74); margin-bottom:18px; font-size:13px;
  }
  .learning-studio .route-note strong { display:block; color:#8a511c; margin-bottom:3px; }
  .learning-studio .route-trail { position:relative; margin:0 0 25px; }
  .learning-studio .route-step { display:grid; grid-template-columns:32px 1fr auto; gap:12px; position:relative; padding:0 0 18px; }
  .learning-studio .route-step:not(:last-child):before {
    content:""; position:absolute; left:15px; top:31px; bottom:0; width:1px; background:var(--line);
  }
  .learning-studio .step-marker {
    width:32px; height:32px; border-radius:50%; display:grid; place-items:center; z-index:1;
    border:1px solid var(--line); background:var(--paper); color:var(--ink-soft); font-size:11px; font-weight:800;
  }
  .learning-studio .route-step.active .step-marker { background:var(--amber); color:#fff; border-color:var(--amber); box-shadow:0 0 0 5px rgba(216,131,47,.12); }
  .learning-studio .route-step.completed .step-marker { background:var(--forest); color:#fff; border-color:var(--forest); }
  .learning-studio .step-copy { padding-top:3px; }
  .learning-studio .step-copy strong { display:block; font-family:"Songti SC","STSong",serif; font-size:16px; }
  .learning-studio .step-copy p { margin:3px 0 0; color:var(--ink-soft); font-size:12px; }
  .learning-studio .step-attempts { color:var(--ink-soft); font-size:10px; padding-top:7px; white-space:nowrap; }
  .learning-studio .current-card {
    display:grid; grid-template-columns:1fr auto; gap:16px; border:1px solid rgba(15,92,77,.2);
    background:linear-gradient(135deg,rgba(220,235,227,.84),rgba(255,255,255,.48)); padding:17px 18px; border-radius:4px 18px 18px 18px; margin-bottom:23px;
  }
  .learning-studio .current-card h3 { font-family:"Songti SC","STSong",serif; margin:0 0 4px; font-size:18px; }
  .learning-studio .current-card p { margin:0; color:var(--ink-soft); font-size:12px; }
  .learning-studio .follow-count { align-self:center; color:var(--forest); font-size:11px; font-weight:800; }
  .learning-studio .history-stack { display:grid; gap:9px; }
  .learning-studio .history-note { border:1px solid var(--line); background:rgba(255,255,255,.5); padding:13px 15px; border-radius:4px 13px 13px 13px; }
  .learning-studio .history-head { display:flex; justify-content:space-between; gap:10px; font-size:12px; }
  .learning-studio .history-note p { color:var(--ink-soft); font-size:12px; margin:7px 0 0; white-space:pre-wrap; }
  .learning-studio .material-strip { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:22px; }
  .learning-studio .material-card { padding:8px 10px; border:1px solid var(--line); background:rgba(255,255,255,.48); border-radius:3px 11px 11px 11px; font-size:11px; }
  .learning-studio .online-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; margin-bottom:22px; }
  .learning-studio .online-card {
    display:block; padding:15px 16px; border:1px solid rgba(15,92,77,.19);
    background:linear-gradient(145deg,rgba(220,235,227,.72),rgba(255,255,255,.5));
    border-radius:4px 16px 16px 16px; color:var(--ink); transition:transform .18s ease,box-shadow .18s ease;
  }
  .learning-studio .online-card:hover { transform:translateY(-2px); text-decoration:none; box-shadow:0 9px 22px rgba(15,92,77,.1); }
  .learning-studio .online-meta { display:flex; justify-content:space-between; gap:8px; color:var(--forest); font-size:9px; font-weight:800; letter-spacing:.08em; text-transform:uppercase; }
  .learning-studio .online-card h4 { margin:8px 0 5px; font-family:"Songti SC","STSong",serif; font-size:16px; }
  .learning-studio .online-card p { margin:0; color:var(--ink-soft); font-size:11px; line-height:1.55; }
  .learning-studio .research-query { color:var(--ink-soft); font-size:11px; margin:-5px 0 12px; }
  .learning-studio details.plan-settings { margin-top:22px; border-top:1px solid var(--line); padding-top:16px; }
  .learning-studio details.plan-settings summary { cursor:pointer; color:var(--ink-soft); font-size:12px; font-weight:800; }
  .learning-studio .settings-sheet { margin-top:14px; padding:16px; border:1px solid var(--line); background:rgba(255,255,255,.45); border-radius:4px 14px 14px 14px; }
  .learning-studio .settings-facts { display:grid; grid-template-columns:repeat(3,1fr); gap:9px; margin-bottom:13px; color:var(--ink-soft); font-size:11px; }
  .learning-studio .empty-map { border:1px dashed var(--line); background:var(--paper); padding:34px; border-radius:4px 20px 20px 20px; text-align:center; }
  @media (max-width:850px) {
    .learning-studio .learning-layout { grid-template-columns:1fr; }
    .learning-studio .plan-index { position:static; display:flex; overflow:auto; gap:8px; padding-bottom:4px; }
    .learning-studio .plan-tab { min-width:190px; margin:0; }
  }
  @media (max-width:620px) {
    .learning-studio .map-hero { grid-template-columns:1fr; padding:22px 19px 18px; }
    .learning-studio .progress-dial { width:92px; height:92px; }
    .learning-studio .map-ribbon { grid-template-columns:1fr 1fr; }
    .learning-studio .ribbon-stat:nth-child(3) { border-left:0; border-top:1px solid var(--line); }
    .learning-studio .ribbon-stat:nth-child(4) { border-top:1px solid var(--line); }
    .learning-studio .map-body { padding:20px 18px 24px; }
    .learning-studio .profile-grid { grid-template-columns:1fr; }
    .learning-studio .online-grid { grid-template-columns:1fr; }
    .learning-studio .profile-card.level { grid-row:auto; }
    .learning-studio .settings-facts { grid-template-columns:1fr; }
  }
`;

function learnerLevelLabel(plan: LearningPlan): string {
  const level = plan.profile?.level;
  if (level === "advanced") return "进阶";
  if (level === "intermediate") return "中阶";
  if (level === "beginner") return "入门";
  return plan.profile?.status === "assessing" ? "待诊断" : "待观察";
}

function learnerPaceLabel(plan: LearningPlan): string {
  if (plan.profile?.pace === "intensive") return "强化推进";
  if (plan.profile?.pace === "gentle") return "轻量积累";
  return "稳步学习";
}

function learningStepLabel(status: LearningPlan["route"][number]["status"]): string {
  if (status === "active") return "当前";
  if (status === "completed") return "✓";
  if (status === "skipped") return "—";
  return "·";
}

function learningResourceKindLabel(
  kind: NonNullable<LearningPlan["onlineResources"]>[number]["kind"],
): string {
  if (kind === "documentation") return "官方文档";
  if (kind === "course") return "课程";
  if (kind === "paper") return "论文";
  if (kind === "video") return "视频";
  if (kind === "reference") return "参考资料";
  return "文章";
}

function verifiedLearningRecord(session: LearningSession): string {
  const feedback = session.feedback?.trim() ?? "";
  const marker = "## 已验证学习记录";
  const marked = feedback.includes(marker) ? feedback.split(marker).at(-1)?.trim() : undefined;
  if (marked) return marked.slice(0, 600);
  const summary = feedback.match(/## 今日总结\s+([\s\S]*?)(?=\n## |$)/u)?.[1]?.trim();
  return (summary || "已达到本课目标，后续课程可在此基础上继续。").slice(0, 600);
}

export function learningView(
  plans: LearningPlan[],
  selected: LearningPlan | null,
  sources: Record<string, LearningSource>,
  sessions: LearningSession[] = [],
  flashMsg?: string,
): HtmlEscapedString | Promise<HtmlEscapedString> {
  const listItems = plans.map((plan) => {
    const progress = learningProgress(plan);
    const planSource = sources[plan.id];
    const sourceTitle = plan.mode === "topic"
      ? `${planSource?.materials.length ?? 0} 份材料`
      : planSource?.title ?? "来源已不可用";
    return html`<a class="plan-tab ${selected?.id === plan.id ? "active" : ""}" href="/learning/${encodeURIComponent(plan.id)}">
      <strong>${plan.name}</strong>
      <small>${plan.mode === "topic" ? learnerLevelLabel(plan) : "材料阅读"} · ${sourceTitle}<br />${LEARNING_STATUS_LABELS[plan.status]} · ${progress}% · ${plan.hour}:00</small>
    </a>`;
  });
  const source = selected ? sources[selected.id] : undefined;
  const currentSession = selected?.currentSessionId
    ? sessions.find((session) => session.id === selected.currentSessionId)
    : undefined;
  const sessionHistory = sessions.filter(
    (session) => session.status === "completed" || session.status === "skipped",
  ).slice().reverse();
  const verifiedHistory = sessionHistory.filter((session) => session.mastery === "ready");

  const detail = selected
    ? html`<article class="learning-map">
        ${flash(flashMsg)}
        <header class="map-hero">
          <div>
            <div class="map-eyebrow">
              <span class="map-pill live">${LEARNING_STATUS_LABELS[selected.status]}</span>
              <span class="map-pill">${selected.mode === "topic" ? "自适应主题学习" : "材料带读"}</span>
              ${selected.mode === "topic" ? html`<span class="map-pill">路线 v${selected.routeVersion ?? 1}</span>` : ""}
            </div>
            <h2 class="map-name">${selected.name}</h2>
            <p class="map-topic">${selected.mode === "topic"
              ? selected.topic
              : `沿着「${source?.title ?? "来源已不可用"}」逐段阅读、思考和反馈。`}</p>
          </div>
          <div class="progress-dial" style="--progress:${learningProgress(selected)}">
            <div class="progress-value">${learningProgress(selected)}%<small>LEARNING</small></div>
          </div>
        </header>
        <div class="map-ribbon">
          <div class="ribbon-stat"><span>当前判断</span><strong>${selected.mode === "topic" ? learnerLevelLabel(selected) : "原文驱动"}</strong></div>
          <div class="ribbon-stat"><span>每日节奏</span><strong>${selected.mode === "topic" ? `${selected.profile?.dailyMinutes ?? 25} 分钟` : `${selected.dailyCharacters} 字`}</strong></div>
          <div class="ribbon-stat"><span>推送时间</span><strong>每天 ${selected.hour}:00</strong></div>
          <div class="ribbon-stat"><span>当前课程</span><strong>${currentSession ? LEARNING_SESSION_LABELS[currentSession.status] : "等待下一课"}</strong></div>
        </div>
        <div class="map-body">
          ${selected.mode === "topic" && selected.profile?.status === "assessing"
            ? html`<section class="assessment-card">
                <div class="studio-kicker">Before the route</div>
                <h3>先画出你的知识地形</h3>
                <p>当前路线只是草图。完成这些问题后，Agent 会根据你的经验、目标和时间重新设计路径。</p>
                <ol class="question-list">
                  ${(selected.assessmentQuestions ?? []).map((question) => html`<li>${question}</li>`)}
                </ol>
                <p><code>学习回答：1. … 2. … 3. …</code></p>
              </section>`
            : ""}
          ${selected.mode === "topic" && selected.profile?.status === "active"
            ? html`<section>
                <h3 class="section-label">学习者画像</h3>
                <div class="profile-grid">
                  <div class="profile-card level">
                    <div class="studio-kicker">Current reading</div>
                    <div class="profile-level">${learnerLevelLabel(selected)}</div>
                    <h3>当前判断</h3>
                    <p>${selected.profile.levelRationale}</p>
                    <div class="profile-meta">
                      <span>${learnerPaceLabel(selected)}</span>
                      <span>${selected.profile.dailyMinutes} 分钟 / 天</span>
                      <span>画像 v${selected.profile.revision}</span>
                    </div>
                  </div>
                  <div class="profile-card">
                    <h3>知识优势</h3>
                    <div class="chip-cloud">${selected.profile.strengths.length > 0
                      ? selected.profile.strengths.map((item) => html`<span class="knowledge-chip">${item}</span>`)
                      : html`<span class="muted">继续从回答中寻找证据</span>`}</div>
                  </div>
                  <div class="profile-card">
                    <h3>待补齐</h3>
                    <div class="chip-cloud">${selected.profile.gaps.length > 0
                      ? selected.profile.gaps.map((item) => html`<span class="knowledge-chip gap">${item}</span>`)
                      : html`<span class="muted">暂未发现关键缺口</span>`}</div>
                  </div>
                  <div class="profile-card">
                    <h3>学习使命与成功标准</h3>
                    <p>${selected.profile.goals.join("；") || "使命与成功标准继续澄清中"}</p>
                    <div class="chip-cloud" style="margin-top:9px">${selected.profile.preferences.map((item) =>
                      html`<span class="knowledge-chip">${item}</span>`
                    )}</div>
                  </div>
                  <div class="profile-card">
                    <h3>最近证据</h3>
                    <p>${selected.profile.evidence.slice(-3).join("；") || "等待第一份学习回答"}</p>
                  </div>
                </div>
              </section>`
            : ""}
          ${currentSession
            ? html`<section>
                <h3 class="section-label">现在停在哪里</h3>
                <div class="current-card">
                  <div>
                    <h3>${currentSession.sectionTitle}</h3>
                    <p>${LEARNING_SESSION_LABELS[currentSession.status]}${selected.adaptiveFocus ? ` · 下一课重点：${selected.adaptiveFocus}` : ""}</p>
                  </div>
                  <div class="follow-count">${currentSession.followUpCount
                    ? `已友好跟进 ${currentSession.followUpCount} 次`
                    : "等待你的反馈"}</div>
                </div>
              </section>`
            : selected.adaptiveFocus
              ? html`<div class="route-note"><strong>下一课重点：${selected.adaptiveFocus}</strong>课程会围绕这个缺口继续设计。</div>`
              : ""}
          ${selected.mode === "topic"
            ? html`<section>
                <h3 class="section-label">个性化学习路线</h3>
                ${selected.lastRouteAdjustment
                  ? html`<div class="route-note"><strong>路线已迭代 v${selected.routeVersion ?? 1}</strong>${selected.lastRouteAdjustment}</div>`
                  : ""}
                <div class="route-trail">
                  ${selected.route.map((step, index) => html`<div class="route-step ${step.status}">
                    <div class="step-marker">${learningStepLabel(step.status)}</div>
                    <div class="step-copy"><strong>${index + 1}. ${step.title}</strong><p>${step.objective}</p></div>
                    <div class="step-attempts">${step.attempts > 0 ? `学习 ${step.attempts} 次` : "未开始"}</div>
                  </div>`)}
                </div>
              </section>`
            : ""}
          ${selected.mode === "topic"
            ? html`<section>
                <h3 class="section-label">学习材料</h3>
                <div class="material-strip">${source && source.materials.length > 0
                  ? source.materials.map((material) => html`<div class="material-card">
                      <strong>${material.title}</strong><br />${fmtTime(material.createdAt)}
                    </div>`)
                  : html`<div class="material-card">暂无用户材料 · 扩展知识会标注为模型一般知识</div>`}</div>
              </section>`
            : ""}
          ${selected.mode === "topic"
            ? html`<section>
                <h3 class="section-label">联网推荐资料</h3>
                ${selected.resourceResearchQuery
                  ? html`<p class="research-query">路线 v${selected.resourceResearchVersion} · 检索方向：${selected.resourceResearchQuery}</p>`
                  : ""}
                ${(selected.onlineResources?.length ?? 0) > 0
                  ? html`<div class="online-grid">${selected.onlineResources!.map((resource) =>
                      html`<a
                        class="online-card"
                        href="${resource.url}"
                        target="_blank"
                        rel="noreferrer noopener"
                      >
                        <div class="online-meta"><span>${resource.publisher}</span><span>${learningResourceKindLabel(resource.kind)}</span></div>
                        <h4>${resource.title}</h4>
                        <p>${resource.relevance}</p>
                      </a>`
                    )}</div>`
                  : html`<div class="material-card">下一课前会按当前知识缺口自动联网检索；失败时会诚实降级，不会伪造链接。</div>`}
              </section>`
            : ""}
          <section>
            <h3 class="section-label">已验证学习记录</h3>
            ${verifiedHistory.length > 0
              ? html`<div class="history-stack">${verifiedHistory.slice(0, 6).map((session) => html`<div class="history-note">
                  <div class="history-head">
                    <strong>第 ${session.sequence} 课 · ${session.sectionTitle}</strong>
                    <span>已掌握 · ${fmtTime(session.completedAt ?? session.preparedAt)}</span>
                  </div>
                  <p>${verifiedLearningRecord(session)}</p>
                </div>`)}</div>`
              : html`<div class="material-card">尚无已验证记录。只有能被回答证据支持的理解才会进入知识空间；仅仅读过或做过不计为掌握。</div>`}
          </section>
          <section>
            <h3 class="section-label">反馈轨迹</h3>
            ${sessionHistory.length > 0
              ? html`<div class="history-stack">${sessionHistory.slice(0, 6).map((session) => html`<div class="history-note">
                  <div class="history-head">
                    <strong>第 ${session.sequence} 课 · ${session.sectionTitle}</strong>
                    <span>${session.mastery === "ready" ? "已掌握" : session.mastery === "review" ? "需复习" : LEARNING_SESSION_LABELS[session.status]} · ${fmtTime(session.completedAt ?? session.deliveredAt ?? session.preparedAt)}</span>
                  </div>
                  ${session.learnerReply ? html`<p><strong>学习回答：</strong>${session.learnerReply}</p>` : ""}
                  ${session.feedback ? html`<p>${session.feedback.slice(0, 360)}</p>` : ""}
                  ${session.routeAdjustment ? html`<p><strong>路线变化：</strong>${session.routeAdjustment}</p>` : ""}
                </div>`)}</div>`
              : html`<div class="material-card">还没有课程记录。第一份回答会成为画像和路线迭代的起点。</div>`}
          </section>
          <details class="plan-settings">
            <summary>计划设置与管理信息</summary>
            <form method="post" action="/learning/${encodeURIComponent(selected.id)}" class="settings-sheet">
              <div class="settings-facts">
                <span>来源：${source?.title ?? "来源已不可用"}</span>
                <span>空间：${selected.space}</span>
                <span>创建者：${selected.creatorId}</span>
                <span>投递聊天：${selected.chatId}</span>
                <span>类型：${selected.mode === "topic" ? "主题学习" : "材料阅读"}</span>
                <span>状态：${LEARNING_STATUS_LABELS[selected.status]}</span>
              </div>
              <div class="grid2">
                <div class="field">
                  <label>每天几点 <span class="hint">北京时间，0–23</span></label>
                  <input type="number" min="0" max="23" name="hour" value="${selected.hour}" required />
                </div>
                ${selected.mode === "reading"
                  ? html`<div class="field">
                      <label>每课字数 <span class="hint">500–8000 字</span></label>
                      <input type="number" min="500" max="8000" name="dailyCharacters" value="${selected.dailyCharacters}" required />
                    </div>`
                  : ""}
              </div>
              <div class="actions">
                <button type="submit">保存设置</button>
                ${selected.status === "active"
                  ? html`<button type="submit" class="secondary" formaction="/learning/${encodeURIComponent(selected.id)}/pause">暂停</button>`
                  : selected.status === "paused"
                    ? html`<button type="submit" class="secondary" formaction="/learning/${encodeURIComponent(selected.id)}/resume">恢复</button>`
                    : ""}
                <button type="submit" class="danger" formaction="/learning/${encodeURIComponent(selected.id)}/delete" onclick="return confirm('删除该学习计划？')">删除</button>
              </div>
            </form>
          </details>
        </div>
      </article>`
    : html`<div class="empty-map">
        ${flash(flashMsg)}
        <div class="studio-kicker">Start a trail</div>
        <h2>在飞书里创建学习计划</h2>
        <p>发送 <code>/learn topic &lt;主题&gt;</code> 创建带入学诊断的个性化路线；也可回复附件或飞书文档，发送 <code>/learn new &lt;名称&gt;</code> 创建材料阅读计划。</p>
      </div>`;

  return html`<style>${raw(LEARNING_STUDIO_STYLE)}</style>
    <div class="learning-studio">
      <div class="studio-kicker">Adaptive learning atlas</div>
      <h1 class="studio-title">学习地图</h1>
      <p class="studio-subtitle">从诊断开始，用每一次回答更新知识画像、学习节奏和后续路线。这里展示的不是静态课程表，而是一张持续生长的地图。</p>
      ${plans.length > 0
        ? html`<div class="learning-layout"><aside class="plan-index">${listItems}</aside>${detail}</div>`
        : html`${flash(flashMsg)}<div class="empty-map">在飞书中发送 /learn topic &lt;主题&gt;，或回复一份材料后发送 /learn new &lt;名称&gt; 创建计划。</div>`}
    </div>`;
}

// ---- Integrations (mew: Lark bot + Lark groups) ----------------------------
function feishuProvisioningControl(
  setup: LarkSetupStatus,
  provisioning: LarkProvisioningSession,
): HtmlEscapedString | Promise<HtmlEscapedString> {
  const url = safeLarkVerificationUrl(provisioning.verificationUrl);
  const active = isFeishuProvisioningActive(provisioning.state);
  if (active) {
    return html`<div class="integration-actions">
      <span class="muted">${provisioning.state === "verifying" ? "正在验证机器人和授权…" : provisioning.message}</span>
      ${url ? html`<a class="btn" href="${url}" target="_blank" rel="noreferrer">打开飞书并确认</a>` : ""}
      ${feishuProvisioningPollScript()}
    </div>`;
  }
  const label = setup.state === "ready" && setup.verified ? "创建并切换机器人" : "一键创建并连接";
  return html`<form method="post" action="/setup/feishu/automatic" class="integration-actions">
    ${isFeishuProvisioningFailure(provisioning.state)
      ? html`<span class="muted">${provisioning.message}</span>`
      : ""}
    <input type="hidden" name="brand" value="feishu" />
    <input type="hidden" name="returnTo" value="/integrations" />
    <button type="submit">${label}</button>
  </form>`;
}

function externalSharingControl(
  sharing: FeishuExternalSharingStatus,
): HtmlEscapedString | Promise<HtmlEscapedString> {
  if (sharing.state === "verified") {
    return html`<div class="integration-actions"><span class="badge ok">对外共享已验证</span><span class="muted">${sharing.verifiedGroupName ?? sharing.verifiedChatId ?? "外部群消息已收到"}</span></div>`;
  }
  if (sharing.state === "awaiting_external_message") {
    return html`<div class="integration-actions"><span class="badge degraded">等待外部群消息</span>${sharing.consoleUrl ? html`<a class="btn secondary" href="${sharing.consoleUrl}" target="_blank" rel="noreferrer">打开飞书应用</a>` : ""}<a class="btn secondary" href="/integrations">重新检查</a></div>`;
  }
  if (sharing.state === "skipped") {
    return html`<div class="integration-actions"><span class="muted">当前仅供企业内部使用</span>
      ${sharing.consoleUrl ? html`<a class="btn secondary" href="${sharing.consoleUrl}" target="_blank" rel="noreferrer">打开飞书应用</a>` : ""}
      <form method="post" action="/setup/feishu/external-sharing/start">
        <input type="hidden" name="returnTo" value="/integrations" />
        <button type="submit" class="secondary">我已提交，开始验证</button>
      </form>
    </div>`;
  }
  return html`<div class="integration-actions">
    ${sharing.consoleUrl ? html`<a class="btn secondary" href="${sharing.consoleUrl}" target="_blank" rel="noreferrer">打开当前飞书应用</a>` : ""}
    <form method="post" action="/setup/feishu/external-sharing/start">
      <input type="hidden" name="returnTo" value="/integrations" />
      <button type="submit">开始对外共享验证</button>
    </form>
  </div>`;
}

function feishuAvatarControl(
  available: boolean,
): HtmlEscapedString | Promise<HtmlEscapedString> {
  return html`<div class="integration-row">
    <div>
      <strong>HomeAgent 品牌头像</strong>
      <div class="muted">下载后请在飞书开放平台手动上传；HomeAgent 不会自动修改当前飞书应用。</div>
    </div>
    ${available
      ? html`<a class="btn secondary"
          href="/brand/homeagent-feishu-avatar.png"
          download="HomeAgent-Feishu-Avatar.png">下载头像 PNG</a>`
      : html`<span class="muted">本地头像资源不可用，请检查安装资源。</span>`}
  </div>`;
}

export function feishuGroupConnectView(input: {
  candidates: LarkChatSummary[];
  flashMsg?: string;
}): HtmlEscapedString | Promise<HtmlEscapedString> {
  return html`<div class="integration-shell">
    <div class="integration-page-head">
      <div>
        <div class="eyebrow">FEISHU GROUPS</div>
        <h1>请求群管理员确认</h1>
        <p class="subtitle">选择当前 Bot 已加入的群。HomeAgent 会向群内发送一次确认提示；群主或管理员确认前不会读取或记录群消息。</p>
      </div>
      <a class="btn secondary" href="/integrations">返回 Integrations</a>
    </div>
    ${flash(input.flashMsg)}
    ${input.candidates.length > 0
      ? html`<form method="post" action="/integrations/groups/connect" class="card stack integration-connect-card">
          <div class="field">
            <label>飞书群</label>
            <select name="chatId" required>
              ${input.candidates.map((chat) =>
                html`<option value="${chat.chatId}">${chat.name || chat.chatId}${chat.external ? " · 外部群" : ""}</option>`
              )}
            </select>
            <div class="hint">提交时会再次校验 Bot 是否仍在群内。</div>
          </div>
          <div class="callout">
            <strong>群内确认后才启用</strong>
            <div class="hint">群主或管理员发送“@HomeAgent 启用群聊”后，群聊将以“仅 @ 回复 + Topic reply”的安全默认值启用；之后可以在 Integrations 调整。</div>
          </div>
          <div class="actions">
            <button type="submit">发送确认提示</button>
            <a class="btn secondary" href="/integrations">取消</a>
          </div>
        </form>`
      : html`<div class="empty">
          <strong>没有需要发起确认的群</strong>
          <p>请先把当前 Bot 加入飞书群。待确认和已启用的群不会重复出现。</p>
        </div>`}
  </div>`;
}

export interface IntegrationsViewInput {
  botName: string;
  botOpenId: string;
  setup: LarkSetupStatus;
  provisioning: LarkProvisioningSession;
  restartRequired: boolean;
  runtime?: FeishuRuntimeStatus;
  externalSharing: FeishuExternalSharingStatus;
  groups: SpaceMeta[];
  agents: Agent[];
  brandAvatarAvailable: boolean;
  integration?: FeishuIntegrationSnapshot;
  flashMsg?: string;
}

export function integrationsView(
  input: IntegrationsViewInput,
): HtmlEscapedString | Promise<HtmlEscapedString> {
  if (input.integration) {
    return integrationsControlCenterView(input, input.integration);
  }
  const {
    botName,
    botOpenId,
    setup,
    provisioning,
    restartRequired,
    runtime,
    externalSharing,
    groups,
    agents,
    flashMsg,
  } = input;
  const teamAgents = agents.filter((agent) => agent.visibility === "Team");
  const shownBotName = setup.botName ?? botName;
  const shownBotOpenId = setup.botOpenId ?? botOpenId;
  const agentName = (id?: string) => teamAgents.find((a) => a.id === id)?.name;
  const runtimeFailed = runtime?.consumers.some((consumer) => consumer.state === "failed") ?? false;
  const runtimeBadge = restartRequired
    ? html`<span class="badge degraded">需要重启</span>`
    : runtimeFailed
      ? html`<span class="badge down">消息监听异常</span>`
      : runtime?.ready
        ? html`<span class="badge ok">消息监听已就绪</span>`
        : html`<span class="badge degraded">等待连接</span>`;
  const runtimeRecovery = restartRequired
    ? html`<a class="btn secondary" href="/health">前往运行状态重启</a>`
    : runtimeFailed
      ? html`<a class="btn secondary" href="/health">前往运行状态恢复</a>`
      : "";

  const groupCards = groups.length
    ? groups.map((g) => {
        const enc = encodeURIComponent(g.id);
        const assigned = agentName(g.agentId) ?? "默认";
        const replyMode = (g.replyInThread ?? true) ? "Topic reply" : "普通回复";
        const legacyRespondAll = g.participationLevel === undefined && g.mentionsOnly === false;
        const participationLevel = legacyRespondAll
          ? "active"
          : resolveGroupParticipationLevel(g);
        const participationMode = legacyRespondAll
          ? "响应全部（旧配置）"
          : `活跃度：${GROUP_PARTICIPATION_LABELS[participationLevel]}`;
        const agentOpts = [
          html`<option value="" ${!g.agentId ? "selected" : ""}>默认（全局）</option>`,
          ...teamAgents.map(
            (a) => html`<option value="${a.id}" ${a.id === g.agentId ? "selected" : ""}>${a.name}</option>`,
          ),
        ];
        return html`<div class="card">
          <div class="row">
            <div>
              <div style="font-weight:600">${spaceLabel(g)}</div>
              <div class="muted">${assigned} · ${replyMode} · ${participationMode}</div>
              <div class="muted">Bot ${g.chatId ?? g.id}</div>
            </div>
          </div>
          <form method="post" action="/integrations/groups/${enc}" class="stack" style="margin-top:12px">
            <div class="grid2">
              <div class="field">
                <label>群名称</label>
                <input type="text" name="name" value="${g.name ?? ""}" placeholder="${g.id}" />
              </div>
              <div class="field">
                <label>指定 Agent</label>
                <select name="agentId">${agentOpts}</select>
              </div>
            </div>
            <div class="toggle-row">
              <div><strong>Topic reply</strong><div class="hint">在话题/分组内回复（飞书 thread）</div></div>
              <label class="switch"><input type="checkbox" name="replyInThread" ${(g.replyInThread ?? true) ? "checked" : ""} /><span class="slider"></span></label>
            </div>
            <div class="field">
              <label>机器人活跃度</label>
              <select name="participationLevel">
                <option value="reserved" ${participationLevel === "reserved" ? "selected" : ""}>稳重 — 只参与明确提问和高价值请求</option>
                <option value="balanced" ${participationLevel === "balanced" ? "selected" : ""}>均衡 — 也参与求建议、问题讨论和重要补充</option>
                <option value="active" ${participationLevel === "active" ? "selected" : ""}>积极 — 更愿意补充观点、提示风险和追问</option>
              </select>
              <div class="hint">活跃度越高，机器人越可能回答未 @ 的群消息；明确 @ 其他成员时仍不插话。敏感权限已在创建时申请，若企业尚未批准，则只能收到 @ 消息。</div>
            </div>
            <div class="actions">
              <button type="submit">保存群设置</button>
              <button type="submit" class="secondary" formaction="/integrations/groups/${enc}/test">发送测试消息</button>
            </div>
          </form>
        </div>`;
      })
    : [html`<div class="empty">还没有群空间。把机器人加入飞书群即可出现在这里。</div>`];

  return html`<h1>飞书连接</h1>
    <p class="subtitle">创建机器人、确认群聊，并管理每个已启用群的回答方式。</p>
    ${flash(flashMsg)}

    <section class="card integration-card">
      <div class="integration-row">
        <div>
          <strong>飞书机器人</strong>
          <div class="muted">接收群消息、发送回答，并建立群知识空间。</div>
        </div>
        ${setup.state === "ready" && setup.verified
          ? html`<div class="connection-pill"><span><span class="dot"></span>${shownBotName || "已连接机器人"}</span><span class="muted">${restartRequired ? "待启用" : "当前"}</span></div>`
          : feishuProvisioningControl(setup, provisioning)}
      </div>
      ${setup.state === "ready" && setup.verified ? html`<div class="integration-row">
        <div>
          <strong>${shownBotName || "已连接机器人"}</strong>
          <div class="muted">${setup.appId ?? ""}${shownBotOpenId ? ` · ${shownBotOpenId}` : ""}</div>
        </div>
        ${feishuProvisioningControl(setup, provisioning)}
      </div>` : ""}
      <div class="integration-row">
        <div>
          <strong>飞书群聊</strong>
          <div class="muted">机器人加入群后等待群主或管理员确认，确认后才建立工作空间。</div>
        </div>
        <div class="integration-actions">${runtimeBadge}${runtimeRecovery}</div>
      </div>
      ${setup.state === "ready" && setup.verified && setup.brand !== "lark" ? html`<div class="integration-row">
        <div>
          <strong>对外共享</strong>
          <div class="muted">允许机器人加入外部群，并接受外部用户私聊。</div>
        </div>
        ${externalSharingControl(externalSharing)}
      </div>` : ""}
      ${feishuAvatarControl(input.brandAvatarAvailable)}
      <div class="integration-detail">
        <div class="muted">首次确认会申请完整权限：消息收发、群消息读取、附件、表情、群信息和两条事件订阅。企业管理员可能需要在这次确认中批准敏感权限；上述权限无需事后进入开放平台补配置。手动连接已有应用时仍需自行确认权限。对外共享由飞书限制在版本发布流程中：创建版本时开启“允许机器人被添加到外部群中使用”和“允许外部用户与机器人单聊”，再提交发布并完成管理员审批。</div>
      </div>
    </section>

    <h2>已连接群聊</h2>
    ${groupCards}

    <details class="card">
      <summary style="cursor:pointer;font-weight:600">更多设置</summary>
      <div class="muted" style="margin:10px 0 6px">手动连接已有应用，或重新验证当前 lark-cli 配置。</div>
      <div class="muted" style="margin:0 0 14px">若一键创建未完成，请回到上方重试；只有手动应用缺少配置时，才需要在对应开发者后台补齐权限和事件订阅。</div>
      <form method="post" action="/integrations/bot/setup" class="stack">
        <div class="field">
          <label>应用平台</label>
          <select name="brand"><option value="feishu">飞书</option><option value="lark"${setup.brand === "lark" ? " selected" : ""}>Lark</option></select>
        </div>
        <div class="grid2">
          <div class="field">
            <label>App ID</label>
            <input type="text" name="appId" placeholder="cli_..." required autocomplete="off" />
          </div>
          <div class="field">
            <label>App Secret</label>
            <input type="password" name="appSecret" required autocomplete="new-password" />
          </div>
        </div>
        <div class="actions"><button type="submit" class="secondary">手动连接已有应用</button><button type="submit" class="secondary" formnovalidate formaction="/integrations/bot/verify">只验证现有配置</button></div>
      </form>
    </details>`;
}

function integrationsControlCenterView(
  input: IntegrationsViewInput,
  snapshot: FeishuIntegrationSnapshot,
): HtmlEscapedString | Promise<HtmlEscapedString> {
  const progress = deriveFeishuConnectionProgress({
    bot: snapshot.bot,
    activeIdentity: snapshot.activeIdentity,
    runtime: snapshot.runtime,
    capability: snapshot.capability,
    groups: snapshot.groups.map((group) => ({
      ...group.binding,
      state: group.state,
    })),
  });
  const nextSpace = progress.nextAction.spaceId;
  const nextGroup = nextSpace
    ? snapshot.groups.find((group) => group.binding.spaceId === nextSpace)
    : undefined;
  const nextGroupLabel = nextGroup?.space?.name
    || nextGroup?.chat?.name
    || nextGroup?.binding.chatId
    || nextSpace;
  const nextTitle = progress.nextAction.kind === "test_group"
    ? `测试「${nextGroupLabel}」`
    : progress.nextAction.kind === "connect_bot"
      ? "连接飞书 Bot"
      : progress.nextAction.kind === "verify_bot"
        ? "验证飞书 Bot"
        : progress.nextAction.kind === "recover_runtime"
          ? "恢复飞书消息监听"
          : progress.nextAction.kind === "restart_runtime"
            ? "重启并加载新 Bot"
            : progress.nextAction.kind === "wait_for_confirmation"
              ? `等待「${nextGroupLabel}」管理员确认`
              : progress.nextAction.kind === "reconnect_group"
                ? `重新连接「${nextGroupLabel}」`
                : progress.nextAction.kind === "connect_group"
                  ? "连接一个群聊"
                  : progress.nextAction.kind === "none"
                    ? "飞书连接已完成"
                    : "检查飞书连接";
  const nextDescription = progress.nextAction.kind === "test_group"
    ? "管理员已确认启用。发送一条测试消息，成功后该群即完成连接。"
    : progress.nextAction.kind === "connect_bot"
      ? "先创建或连接 Bot，群聊闭环才可以开始。"
      : progress.nextAction.kind === "verify_bot"
        ? "重新验证当前应用身份和权限后再继续群聊连接。"
        : progress.nextAction.kind === "recover_runtime"
          ? "历史连接结果仍然保留；先恢复当前消息消费者。"
          : progress.nextAction.kind === "restart_runtime"
            ? "当前运行中的消费者仍在使用旧身份，重启后再继续。"
            : progress.nextAction.kind === "wait_for_confirmation"
              ? "确认完成后会进入待测试状态，不会自动发送测试消息。"
              : progress.nextAction.kind === "reconnect_group"
                ? "Bot 身份已变化，需要由群管理员重新确认后再测试。"
                : progress.nextAction.kind === "connect_group"
                  ? "选择 Bot 已加入的群，由群管理员确认后再完成测试。"
                  : "当前群聊已经过成功测试；后续运行异常不会抹除这份完成记录。";
  const actionVisible = (
    kind: FeishuConnectionProgress["nextAction"]["kind"],
  ) => progress.nextAction.kind === kind;
  const progressCard = html`<section
    class="card integration-progress"
    data-feishu-progress-root
    data-feishu-next-action="${progress.nextAction.kind}"
    data-next-space="${nextSpace ?? ""}"
    data-feishu-revision="${progress.revision}"
    data-poll-after="${progress.pollAfterMs ?? ""}"
  >
    <div>
      <div class="eyebrow">当前下一步</div>
      <strong data-feishu-title>${nextTitle}</strong>
      <div class="muted" data-feishu-description>${nextDescription}</div>
    </div>
    <div class="integration-actions" data-feishu-actions>
      ${actionVisible("connect_bot")
        ? html`<a class="btn" href="#feishu-bot" data-feishu-action="connect_bot">连接 Bot</a>`
        : html`<a class="btn" href="#feishu-bot" data-feishu-action="connect_bot" hidden>连接 Bot</a>`}
      ${actionVisible("verify_bot")
        ? html`<form method="post" action="/integrations/bot/verify" data-feishu-action="verify_bot"><button type="submit">重新验证</button></form>`
        : html`<form method="post" action="/integrations/bot/verify" data-feishu-action="verify_bot" hidden><button type="submit">重新验证</button></form>`}
      ${actionVisible("restart_runtime")
        ? html`<a class="btn" href="/health" data-feishu-action="restart_runtime">前往重启</a>`
        : html`<a class="btn" href="/health" data-feishu-action="restart_runtime" hidden>前往重启</a>`}
      ${actionVisible("recover_runtime")
        ? html`<a class="btn" href="/health" data-feishu-action="recover_runtime">前往恢复</a>`
        : html`<a class="btn" href="/health" data-feishu-action="recover_runtime" hidden>前往恢复</a>`}
      ${actionVisible("connect_group")
        ? html`<a class="btn" href="/integrations/groups/connect" data-feishu-action="connect_group">选择群聊</a>`
        : html`<a class="btn" href="/integrations/groups/connect" data-feishu-action="connect_group" hidden>选择群聊</a>`}
      <button type="button" data-feishu-action="reconnect_group" data-feishu-scroll-group ${actionVisible("reconnect_group") ? "" : "hidden"}>重新连接</button>
      <button type="button" data-feishu-action="test_group" data-feishu-scroll-group ${actionVisible("test_group") ? "" : "hidden"}>发送测试消息</button>
      <button type="button" class="secondary" data-feishu-action="wait_for_confirmation" data-feishu-scroll-group ${actionVisible("wait_for_confirmation") ? "" : "hidden"}>查看确认状态</button>
      ${actionVisible("none")
        ? html`<span class="badge ok" data-feishu-action="none">已完成</span>`
        : html`<span class="badge ok" data-feishu-action="none" hidden>已完成</span>`}
    </div>
  </section>`;
  const setup = snapshot.bot;
  const runtimeFailed =
    snapshot.runtime?.consumers.some((consumer) => consumer.state === "failed")
    ?? false;
  const runtimeBadge = snapshot.restartRequired
    ? html`<span class="badge degraded" data-feishu-bot-stage>需要重启</span>`
    : runtimeFailed
      ? html`<span class="badge down" data-feishu-bot-stage>消息监听异常</span>`
      : snapshot.runtime?.ready
        ? html`<span class="badge ok" data-feishu-bot-stage>正在运行</span>`
        : html`<span class="badge degraded" data-feishu-bot-stage>未启动</span>`;
  const capabilityBadge = snapshot.capability === "available"
    ? html`<span class="badge ok">完整群消息可用</span>`
    : snapshot.capability === "unavailable"
      ? html`<span class="badge degraded">仅 @ 消息可用</span>`
      : html`<span class="badge degraded">权限状态未知</span>`;
  const runtimeRecovery = snapshot.restartRequired
    ? html`<div class="degraded-note">Bot 配置已变化或刚恢复连接，需要重启服务后消息消费者才会使用当前身份。
        <a class="btn secondary" href="/health">前往运行状态重启</a>
      </div>`
    : runtimeFailed
      ? html`<div class="degraded-note">飞书消息监听异常，请到运行状态查看并恢复消费者。
          <a class="btn secondary" href="/health">前往运行状态恢复</a>
        </div>`
      : "";
  const capabilityRecovery = snapshot.capability === "unavailable"
    ? html`<div class="degraded-note">
        <strong>缺少完整群消息权限</strong>
        <div>当前只能可靠处理 @ Bot 的群消息。请在飞书应用中确认群消息权限和版本发布状态，再重新检查。</div>
        <div class="actions" style="margin-top:10px">
          ${setup.brand !== "lark" && input.externalSharing.consoleUrl
            ? html`<a class="btn secondary" href="${input.externalSharing.consoleUrl}" target="_blank" rel="noreferrer">打开飞书应用并检查权限</a>`
            : ""}
          <form method="post" action="/integrations/bot/verify"><button class="secondary" type="submit">重新检查权限</button></form>
        </div>
      </div>`
    : snapshot.capability === "unknown"
      ? html`<div class="degraded-note">
          <strong>权限检测失败</strong>
          <div>HomeAgent 暂时无法确认完整群消息权限；不会据此开放未 @ 消息的响应方式。</div>
          <div class="actions" style="margin-top:10px">
            <form method="post" action="/integrations/bot/verify"><button class="secondary" type="submit">重新检查权限</button></form>
            <a class="btn secondary" href="/health">前往运行状态</a>
          </div>
        </div>`
      : "";
  const cards = snapshot.groups.length > 0
    ? snapshot.groups.map((group) =>
        integrationGroupCard(
          group,
          snapshot,
          progress.groups.find((item) =>
            item.spaceId === group.binding.spaceId
          )!,
        )
      )
    : [html`<div class="empty integration-empty">
        <strong>还没有发现群聊</strong>
        <p>把 Bot 加入飞书群后，HomeAgent 会登记为待确认，并请群主或管理员在群内启用。</p>
      </div>`];

  return html`<style>${raw(`
    .integration-console { --paper:#fffdf8; --ink:#25231f; --line:#e7e0d4; color:var(--ink); }
    .integration-console .console-head { display:flex; justify-content:space-between; gap:20px; align-items:flex-end; margin-bottom:18px; }
    .integration-console .eyebrow { font:600 11px/1.2 ui-monospace,monospace; letter-spacing:.16em; color:#8a623a; margin-bottom:8px; }
    .integration-console .bot-console { background:var(--paper); border-color:var(--line); box-shadow:0 10px 28px rgba(74,58,35,.05); }
    .integration-console .integration-progress { display:flex; justify-content:space-between; align-items:center; gap:18px; border:2px solid #d5a15f; background:#fff8ed; }
    .integration-console .bot-title { display:flex; align-items:center; gap:12px; }
    .integration-console .bot-mark { width:38px; height:38px; display:grid; place-items:center; border-radius:10px; background:#2f5f52; color:#fff; font-weight:700; }
    .integration-console .console-facts { display:flex; flex-wrap:wrap; gap:8px; margin-top:10px; }
    .integration-console .group-grid { display:grid; gap:12px; }
    .integration-console .group-card { border-color:var(--line); background:#fff; }
    .integration-console .group-head { display:flex; justify-content:space-between; gap:16px; align-items:flex-start; }
    .integration-console .group-summary { display:flex; flex-wrap:wrap; gap:7px; margin-top:7px; color:#756d61; font-size:12px; }
    .integration-console .group-summary span { padding:2px 7px; border:1px solid var(--line); border-radius:999px; background:var(--paper); }
    .integration-console details.policy-details { border-top:1px solid var(--line); margin-top:14px; padding-top:12px; }
    .integration-console details.policy-details summary { cursor:pointer; color:#5f564a; font-weight:600; }
    .integration-console .degraded-note { margin:12px 0 0; padding:9px 11px; background:#fff7df; border:1px solid #ecd9a4; border-radius:8px; color:#75551a; font-size:13px; }
    .integration-console .integration-empty { border:1px dashed var(--line); border-radius:10px; background:var(--paper); }
    @media (max-width:720px) { .integration-console .console-head,.integration-console .group-head { align-items:flex-start; flex-direction:column; } }
  `)}</style>
  <div class="integration-console">
    <div class="console-head">
      <div>
        <div class="eyebrow">FEISHU CONTROL CENTER</div>
        <h1>飞书连接</h1>
        <p class="subtitle">Bot 入群后由群主或管理员确认启用；确认前不读取群消息。</p>
      </div>
      <a class="btn" href="/integrations/groups/connect">请求群确认</a>
    </div>
    ${flash(input.flashMsg)}
    ${progressCard}
    <div class="degraded-note" data-feishu-refresh-warning hidden>
      连接状态暂时无法更新，请手动刷新页面。
    </div>

    <section
      class="card bot-console"
      id="feishu-bot"
      data-feishu-bot
      data-feishu-stage="${progress.bot.stage}"
      data-feishu-health="${progress.bot.health}"
      data-feishu-capability="${progress.bot.capability}"
    >
      <div class="integration-row">
        <div>
          <div class="bot-title">
            <span class="bot-mark">飞</span>
            <div>
              <strong>${setup.botName || input.botName || "飞书 Bot"}</strong>
              <div class="muted">${setup.appId ?? "尚未配置应用"}${setup.botOpenId ? ` · ${setup.botOpenId}` : ""}</div>
            </div>
          </div>
          <div class="console-facts">${runtimeBadge}${capabilityBadge}</div>
        </div>
        <div class="integration-actions">
          ${setup.state === "ready" && setup.verified
            ? html`<form method="post" action="/integrations/bot/verify"><button class="secondary" type="submit">重新验证</button></form>
              <form method="post" action="/integrations/bot/disconnect" onsubmit="return confirm('在 HomeAgent 中停用当前 Bot？凭据和知识不会删除。')">
                <button class="danger" type="submit">停用 Bot</button>
              </form>`
            : feishuProvisioningControl(setup, input.provisioning)}
        </div>
      </div>
      ${runtimeRecovery}
      ${capabilityRecovery}
      ${feishuAvatarControl(input.brandAvatarAvailable)}
      ${setup.state === "ready" && setup.verified && setup.brand !== "lark"
        ? html`<div class="integration-row"><div><strong>对外共享</strong><div class="muted">允许加入外部群和接受外部用户私聊。</div></div>${externalSharingControl(input.externalSharing)}</div>`
        : ""}
    </section>

    <div class="console-head">
      <div><h2>群聊连接</h2><p class="subtitle">待确认群不会被收录；断开也不会删除已有知识、任务、提醒或学习计划。</p></div>
      <span class="muted">${snapshot.groups.filter((group) => group.state === "active").length} 个已启用 · ${snapshot.groups.filter((group) => group.state === "pending_confirmation").length} 个待确认</span>
    </div>
    <div class="group-grid">${cards}</div>

    <details class="card">
      <summary style="cursor:pointer;font-weight:600">更多 Bot 设置</summary>
      <div class="muted" style="margin:10px 0 14px">手动连接已有应用或创建并切换机器人。身份变更需要重启服务。</div>
      ${feishuProvisioningControl(setup, input.provisioning)}
      <form method="post" action="/integrations/bot/setup" class="stack" style="margin-top:14px">
        <div class="field">
          <label>应用平台</label>
          <select name="brand">
            <option value="feishu"${setup.brand === "lark" ? "" : " selected"}>飞书</option>
            <option value="lark"${setup.brand === "lark" ? " selected" : ""}>Lark</option>
          </select>
        </div>
        <div class="grid2">
          <div class="field"><label>App ID</label><input type="text" name="appId" placeholder="cli_..." required autocomplete="off" /></div>
          <div class="field"><label>App Secret</label><input type="password" name="appSecret" required autocomplete="new-password" /></div>
        </div>
        <button type="submit" class="secondary">手动连接已有应用</button>
      </form>
    </details>
    <script>${raw(feishuProgressBrowserScript(progress))}</script>
  </div>`;
}

function integrationGroupCard(
  group: FeishuGroupIntegrationView,
  snapshot: FeishuIntegrationSnapshot,
  progress: FeishuConnectionProgress["groups"][number],
): HtmlEscapedString | Promise<HtmlEscapedString> {
  const binding = group.binding;
  const space = group.space;
  const encodedSpace = encodeURIComponent(binding.spaceId);
  const modeLabel = binding.responseMode === "mentions_only"
    ? "仅 @ 回复"
    : binding.responseMode === "all_messages"
      ? "响应所有消息"
      : `智能参与 · ${GROUP_PARTICIPATION_LABELS[binding.participationLevel ?? "balanced"]}`;
  const stateBadge = group.state === "active"
    ? html`<span class="badge ok">已连接</span>`
    : group.state === "pending_confirmation"
      ? html`<span class="badge degraded">等待群管理员确认</span>`
    : group.state === "disconnected"
      ? html`<span class="badge degraded">已断开</span>`
      : html`<span class="badge degraded">需要重连</span>`;
  const canUseFullMessages = snapshot.capability === "available";
  const agentOptions = [
    html`<option value="" ${!space?.agentId ? "selected" : ""}>默认（全局）</option>`,
    ...snapshot.agents.map((agent) =>
      html`<option value="${agent.id}" ${agent.id === space?.agentId ? "selected" : ""}>${agent.name}</option>`
    ),
  ];
  if (group.state !== "active") {
    const displayName = space?.name || group.chat?.name || binding.chatId;
    if (group.state === "pending_confirmation") {
      const prompt = binding.confirmationPrompt;
      const promptLabel = prompt?.status === "sent"
        ? `提示已发送 · ${new Date(prompt.lastAttemptAt).toISOString()}`
        : prompt?.status === "failed"
          ? "提示发送失败，可手动重试"
          : prompt?.status === "attempting"
            ? "提示发送中"
            : "尚未发送提示";
      const botName = snapshot.bot.botName || "HomeAgent";
      return html`<article
        class="card group-card"
        id="feishu-group-${encodedSpace}"
        data-space-id="${binding.spaceId}"
        data-feishu-stage="${progress.stage}"
        data-completed-at="${progress.completedAt ?? ""}"
      >
        <div class="group-head">
          <div><strong>${displayName}</strong><div class="muted">${binding.chatId}</div></div>
          ${stateBadge}
        </div>
        <div class="group-summary"><span>发现于 ${new Date(binding.createdAt).toISOString()}</span><span>${promptLabel}</span></div>
        <div class="group-summary" data-feishu-closure>
          <span data-feishu-group-stage>等待群管理员确认</span>
          <span data-feishu-group-completed hidden></span>
          ${progress.health === "degraded"
            ? html`<span data-feishu-group-health>当前运行异常</span>`
            : progress.health === "limited"
              ? html`<span data-feishu-group-health>当前能力受限</span>`
              : html`<span data-feishu-group-health hidden></span>`}
        </div>
        <div class="degraded-note">请群主或管理员在群内发送“@${botName} 启用群聊”。确认前不会读取、记录或回复普通群消息。</div>
        <div class="actions" style="margin-top:14px">
          <form method="post" action="/integrations/groups/${encodedSpace}/confirmation"><button type="submit">重新发送提示</button></form>
          <form method="post" action="/integrations/groups/${encodedSpace}/ignore" onsubmit="return confirm('忽略该群？之后重新入群也不会自动启用。')"><button type="submit" class="danger">忽略此群</button></form>
          <form method="post" action="/integrations/groups/${encodedSpace}/test" data-feishu-group-test data-feishu-poll-test hidden><button type="submit">测试连接</button></form>
        </div>
      </article>`;
    }
    return html`<article
      class="card group-card"
      id="feishu-group-${encodedSpace}"
      data-space-id="${binding.spaceId}"
      data-feishu-stage="${progress.stage}"
      data-completed-at="${progress.completedAt ?? ""}"
    >
      <div class="group-head">
        <div><strong>${displayName}</strong><div class="muted">${binding.chatId}</div></div>
        ${stateBadge}
      </div>
      <div class="group-summary"><span>${modeLabel}</span>${space ? html`<span>知识空间保留</span>` : ""}</div>
      <div class="group-summary" data-feishu-closure>
        <span data-feishu-group-stage>${progress.stage === "needs_reconnect" ? "需要重新确认" : "已断开"}</span>
        <span data-feishu-group-completed hidden></span>
        ${progress.health === "degraded"
          ? html`<span data-feishu-group-health>当前运行异常</span>`
          : progress.health === "limited"
            ? html`<span data-feishu-group-health>当前能力受限</span>`
            : html`<span data-feishu-group-health hidden></span>`}
      </div>
      <form method="post" action="/integrations/groups/connect" class="actions" style="margin-top:14px">
        <input type="hidden" name="chatId" value="${binding.chatId}" />
        <button type="submit">请求群管理员确认</button>
      </form>
      <form method="post" action="/integrations/groups/${encodedSpace}/test" data-feishu-group-test data-feishu-poll-test hidden><button type="submit">测试连接</button></form>
    </article>`;
  }
  return html`<article
    class="card group-card"
    id="feishu-group-${encodedSpace}"
    data-space-id="${binding.spaceId}"
    data-feishu-stage="${progress.stage}"
    data-completed-at="${progress.completedAt ?? ""}"
  >
    <div class="group-head">
      <div>
        <strong>${space?.name || binding.chatId}</strong>
        <div class="muted">${binding.chatId}</div>
        <div class="group-summary"><span>${modeLabel}</span><span>${binding.replyInThread ? "Topic reply" : "普通回复"}</span><span>${space?.agentId ? "指定 Agent" : "默认 Agent"}</span></div>
      </div>
      ${stateBadge}
    </div>
    <div class="group-summary" data-feishu-closure>
      <span data-feishu-group-stage>${progress.stage === "complete" ? "连接已验证" : "等待测试"}</span>
      ${progress.completedAt
        ? html`<span data-feishu-group-completed>验证于 ${new Date(progress.completedAt).toISOString()}</span>`
        : html`<span data-feishu-group-completed hidden></span>`}
      ${progress.health === "degraded"
        ? html`<span data-feishu-group-health>当前运行异常</span>`
        : progress.health === "limited"
          ? html`<span data-feishu-group-health>当前能力受限</span>`
          : html`<span data-feishu-group-health hidden></span>`}
    </div>
    ${group.degraded
      ? html`<div class="degraded-note">当前应用无法确认完整群消息权限；现有策略保留，但运行时可能只能收到 @ Bot 的消息。</div>`
      : ""}
    <form method="post" action="/integrations/groups/${encodedSpace}" class="stack">
      <div class="field" style="margin-top:14px">
        <label>响应方式</label>
        <select name="responseMode">
          <option value="mentions_only" ${binding.responseMode === "mentions_only" ? "selected" : ""}>仅在 @ Bot 时回复</option>
          <option value="smart" ${binding.responseMode === "smart" ? "selected" : ""} ${canUseFullMessages || binding.responseMode === "smart" ? "" : "disabled"}>智能参与群聊</option>
          <option value="all_messages" ${binding.responseMode === "all_messages" ? "selected" : ""} ${canUseFullMessages || binding.responseMode === "all_messages" ? "" : "disabled"}>响应所有消息</option>
        </select>
      </div>
      <details class="policy-details">
        <summary>更多设置</summary>
        <div class="grid2" style="margin-top:14px">
          <div class="field"><label>群名称</label><input type="text" name="name" value="${space?.name ?? ""}" /></div>
          <div class="field"><label>指定 Agent</label><select name="agentId">${agentOptions}</select></div>
          <div class="field"><label>智能活跃度</label>
            <select name="participationLevel">
              ${(["reserved", "balanced", "active"] as const).map((level) =>
                html`<option value="${level}" ${level === (binding.participationLevel ?? "balanced") ? "selected" : ""}>${GROUP_PARTICIPATION_LABELS[level]}</option>`
              )}
            </select>
          </div>
          <label class="toggle-row compact-toggle"><span><strong>Topic reply</strong><span class="hint">在飞书话题内回复</span></span><span class="switch"><input type="checkbox" name="replyInThread" ${binding.replyInThread ? "checked" : ""} /><span class="slider"></span></span></label>
        </div>
      </details>
      <div class="actions" style="margin-top:14px">
        <button type="submit">保存</button>
        <button type="submit" class="secondary" formaction="/integrations/groups/${encodedSpace}/test" data-feishu-group-test>测试连接</button>
        <button type="submit" class="danger" formaction="/integrations/groups/${encodedSpace}/disconnect" onclick="return confirm('断开该群？已有知识和任务会保留。')">断开</button>
      </div>
    </form>
  </article>`;
}

// ---- Settings --------------------------------------------------------------

export interface SettingsData {
  defaultProvider: string;
  defaultModel: string;
  dailyBudgetUsd: number;
  chatTimeoutMinutes: number;
  dreamHour: number;
  rawRetentionDays: number;
  webPort: number;
  dataDir: string;
}

export interface DataDirectorySettingsData {
  currentPath: string;
  available: boolean;
  lockedByEnvironment: boolean;
  gitAvailable: boolean;
  gitRepository: boolean;
  restartable: boolean;
  migrationError?: string;
  pendingMigration?: {
    destination: string;
    initializeGit: boolean;
    requestedAt: number;
  };
  lastMigration?: {
    source: string;
    destination: string;
    completedAt: number;
    gitInitialized: boolean;
  };
}

export interface SettingsFormValues {
  defaultProvider: string;
  defaultModel: string;
  dailyBudgetUsd: string;
  chatTimeoutMinutes: string;
  dreamHour: string;
  rawRetentionDays: string;
  webPort: string;
}

export type SettingsFieldErrors = Partial<Record<keyof SettingsFormValues, string>>;

export function settingsView(
  s: SettingsData,
  providers: DetectedProvider[],
  models: Record<string, string[]>,
  flashMsg?: string,
  submitted?: SettingsFormValues,
  errors: SettingsFieldErrors = {},
  dataDirectory: DataDirectorySettingsData = {
    currentPath: s.dataDir,
    available: false,
    lockedByEnvironment: false,
    gitAvailable: false,
    gitRepository: false,
    restartable: false,
  },
): HtmlEscapedString | Promise<HtmlEscapedString> {
  const values: SettingsFormValues = submitted ?? {
    defaultProvider: s.defaultProvider,
    defaultModel: s.defaultModel,
    dailyBudgetUsd: String(s.dailyBudgetUsd),
    chatTimeoutMinutes: String(s.chatTimeoutMinutes),
    dreamHour: String(s.dreamHour),
    rawRetentionDays: String(s.rawRetentionDays),
    webPort: String(s.webPort),
  };
  // The global default handles ordinary conversation, so task-only CLIs stay visible but disabled.
  const providerOptions = providers.map((p) => {
    const sel = p.id === values.defaultProvider ? "selected" : "";
    const supportsOrdinaryConversation = providerSupportsOrdinaryCompletion(p.id);
    const disabled = p.available && supportsOrdinaryConversation ? "" : "disabled";
    const suffix = !p.available
      ? `（不可用：${p.detail}）`
      : supportsOrdinaryConversation
        ? `（${p.detail}）`
        : `（仅用于显式任务：${p.detail}）`;
    return html`<option value="${p.id}" ${sel} ${disabled}>${p.name}${suffix}</option>`;
  });
  const initialModels = models[values.defaultProvider] ?? [];
  const modelOpts = [
    html`<option value="" ${values.defaultModel === "" ? "selected" : ""}>（CLI 自身默认）</option>`,
    ...initialModels.map((m) => html`<option value="${m}" ${m === values.defaultModel ? "selected" : ""}>${m}</option>`),
  ];
  if (values.defaultModel && !initialModels.includes(values.defaultModel)) {
    modelOpts.push(html`<option value="${values.defaultModel}" selected>${values.defaultModel}（自定义）</option>`);
  }
  const submittedHour = Number(values.dreamHour);
  const hourIsValid = Number.isInteger(submittedHour) && submittedHour >= 0 && submittedHour <= 23;
  const hourOptions = [
    ...(hourIsValid
      ? []
      : [html`<option value="${values.dreamHour}" selected>${values.dreamHour}（无效值）</option>`]),
    ...Array.from(
      { length: 24 },
      (_, hour) => html`<option value="${hour}" ${String(hour) === values.dreamHour ? "selected" : ""}>${String(hour).padStart(2, "0")}:00</option>`,
    ),
  ];
  const fieldIds: Record<keyof SettingsFormValues, string> = {
    defaultProvider: "default-provider",
    defaultModel: "default-model",
    dailyBudgetUsd: "daily-budget",
    chatTimeoutMinutes: "chat-timeout-minutes",
    dreamHour: "dream-hour",
    rawRetentionDays: "raw-retention-days",
    webPort: "web-port",
  };
  const errorEntries = Object.entries(errors) as Array<[keyof SettingsFormValues, string]>;
  const errorSummary = errorEntries.length > 0
    ? html`<div class="form-error-summary" role="alert" tabindex="-1" autofocus>
        <strong>有 ${errorEntries.length} 项设置需要修改</strong>
        <ul>
          ${errorEntries.map(([field, message]) => html`<li><a href="#${fieldIds[field]}">${message}</a></li>`)}
        </ul>
      </div>`
    : "";
  const errorMessage = (field: keyof SettingsFormValues, id: string) =>
    errors[field] ? html`<p class="field-error" id="${id}">${errors[field]}</p>` : "";
  const describedBy = (field: keyof SettingsFormValues, helpId: string, errorId: string) =>
    errors[field] ? `${helpId} ${errorId}` : helpId;
  const catalogJson = JSON.stringify(models);
  const dataMigrationDisabled = !dataDirectory.available
    || dataDirectory.lockedByEnvironment
    || dataDirectory.pendingMigration !== undefined;
  const settingsScript = raw(`<script>
(function(){
  var CATALOG = ${catalogJson};
  var form = document.querySelector('[data-settings-form]');
  var prov = document.getElementById('default-provider');
  var model = document.getElementById('default-model');
  if (!form || !prov || !model) return;
  var initialModelOptions = model.innerHTML;
  prov.addEventListener('change', function(){
    var list = CATALOG[prov.value] || [];
    var cur = model.value;
    model.innerHTML = '';
    var def = document.createElement('option');
    def.value = ''; def.textContent = '（CLI 自身默认）';
    model.appendChild(def);
    list.forEach(function(m){
      var o = document.createElement('option');
      o.value = m; o.textContent = m;
      if (m === cur) o.selected = true;
      model.appendChild(o);
    });
  });

  var cancel = form.querySelector('[data-settings-cancel]');
  var save = form.querySelector('[data-settings-save]');
  var initial = new URLSearchParams(new FormData(form)).toString();
  var dirty = false;
  function updateDirtyState(){
    dirty = new URLSearchParams(new FormData(form)).toString() !== initial;
    cancel.disabled = !dirty;
    save.disabled = !dirty;
  }
  form.addEventListener('input', updateDirtyState);
  form.addEventListener('change', updateDirtyState);
  form.addEventListener('reset', function(){
    setTimeout(function(){
      model.innerHTML = initialModelOptions;
      updateDirtyState();
    }, 0);
  });
  form.addEventListener('submit', function(){
    dirty = false;
    save.disabled = true;
    save.textContent = '保存中…';
  });
  window.addEventListener('beforeunload', function(event){
    if (!dirty) return;
    event.preventDefault();
    event.returnValue = '';
  });
  updateDirtyState();
})();
</script>`);

  return html`<h1>设置</h1>
    <p class="subtitle">配置未指定 Agent 时的执行方式，以及全局运行、数据和服务参数。</p>
    ${flash(flashMsg)}
    ${errorSummary}
    <form method="post" action="/settings" class="stack settings-form" data-settings-form>
      <fieldset class="settings-section">
        <legend>默认 Agent</legend>
        <p class="settings-section-description">仅在 Agent 没有单独指定执行配置时使用。</p>
        <div class="grid2">
          <div class="field">
            <label for="default-provider">默认 Provider</label>
            <select name="defaultProvider" id="default-provider"
              aria-describedby="${describedBy("defaultProvider", "default-provider-help", "default-provider-error")}"
              aria-invalid="${errors.defaultProvider ? "true" : "false"}">${providerOptions}</select>
            <p class="field-help" id="default-provider-help">默认 Provider 必须能安全关闭全部工具；任务专用 CLI 请在 Agent 中配置。</p>
            ${errorMessage("defaultProvider", "default-provider-error")}
          </div>
          <div class="field">
            <label for="default-model">默认 Model</label>
            <select name="defaultModel" id="default-model"
              aria-describedby="${describedBy("defaultModel", "default-model-help", "default-model-error")}"
              aria-invalid="${errors.defaultModel ? "true" : "false"}">${modelOpts}</select>
            <p class="field-help" id="default-model-help">随 Provider 变化；留空时使用该 CLI 自身的默认模型。</p>
            ${errorMessage("defaultModel", "default-model-error")}
          </div>
        </div>
      </fieldset>

      <fieldset class="settings-section">
        <legend>运行策略</legend>
        <p class="settings-section-description">展示调用成本参考，并控制每日提炼任务的执行时间。</p>
        <div class="grid2">
          <div class="field">
            <label for="daily-budget">每日成本参考线</label>
            <div class="input-with-unit">
              <input id="daily-budget" type="number" step="0.01" min="0" name="dailyBudgetUsd" value="${values.dailyBudgetUsd}"
                aria-describedby="${describedBy("dailyBudgetUsd", "daily-budget-help", "daily-budget-error")}"
                aria-invalid="${errors.dailyBudgetUsd ? "true" : "false"}" />
              <span class="input-unit">USD / 天</span>
            </div>
            <p class="field-help" id="daily-budget-help">只用于成本观察，不会暂停或拒绝任何 Provider 调用；未知成本仍会明确记录。</p>
            ${errorMessage("dailyBudgetUsd", "daily-budget-error")}
          </div>
          <div class="field">
            <label for="dream-hour">提炼时刻</label>
            <select id="dream-hour" name="dreamHour"
              aria-describedby="${describedBy("dreamHour", "dream-hour-help", "dream-hour-error")}"
              aria-invalid="${errors.dreamHour ? "true" : "false"}">${hourOptions}</select>
            <p class="field-help" id="dream-hour-help">每天按 Asia/Shanghai 时区执行。</p>
            ${errorMessage("dreamHour", "dream-hour-error")}
          </div>
          <div class="field">
            <label for="chat-timeout-minutes">聊天最长回答时间</label>
            <div class="input-with-unit">
              <input id="chat-timeout-minutes" type="number"
                min="${MIN_CHAT_TIMEOUT_MINUTES}" max="${MAX_CHAT_TIMEOUT_MINUTES}"
                name="chatTimeoutMinutes" value="${values.chatTimeoutMinutes}"
                aria-describedby="${describedBy("chatTimeoutMinutes", "chat-timeout-minutes-help", "chat-timeout-minutes-error")}"
                aria-invalid="${errors.chatTimeoutMinutes ? "true" : "false"}" />
              <span class="input-unit">分钟</span>
            </div>
            <p class="field-help" id="chat-timeout-minutes-help">每条新消息入队时冻结；复杂回答可延长，仍可随时取消。</p>
            ${errorMessage("chatTimeoutMinutes", "chat-timeout-minutes-error")}
          </div>
        </div>
      </fieldset>

      <fieldset class="settings-section">
        <legend>数据与系统</legend>
        <p class="settings-section-description">控制原始消息保留周期和管理后台监听端口。</p>
        <div class="grid2">
          <div class="field">
            <label for="raw-retention-days">原始消息保留</label>
            <div class="input-with-unit">
              <input id="raw-retention-days" type="number" min="0" max="36500" name="rawRetentionDays" value="${values.rawRetentionDays}"
                aria-describedby="${describedBy("rawRetentionDays", "raw-retention-days-help", "raw-retention-days-error")}"
                aria-invalid="${errors.rawRetentionDays ? "true" : "false"}" />
              <span class="input-unit">天</span>
            </div>
            <p class="field-help" id="raw-retention-days-help">0 表示永久保留；只清理已经完成提炼的原始消息。</p>
            ${errorMessage("rawRetentionDays", "raw-retention-days-error")}
          </div>
          <div class="field">
            <div class="field-label-row">
              <label for="web-port">后台端口</label>
              <span class="effect-badge">需重启生效</span>
            </div>
            <input id="web-port" type="number" min="1" max="65535" name="webPort" value="${values.webPort}"
              aria-describedby="${describedBy("webPort", "web-port-help", "web-port-error")}"
              aria-invalid="${errors.webPort ? "true" : "false"}" />
            <p class="field-help" id="web-port-help">保存只更新配置，不会自动重启 HomeAgent 服务。</p>
            ${errorMessage("webPort", "web-port-error")}
          </div>
        </div>
      </fieldset>

      <div class="actions settings-actions">
        <button type="reset" class="secondary" data-settings-cancel>取消</button>
        <button type="submit" data-settings-save>保存更改</button>
      </div>
    </form>

    <form method="post" action="/settings/data-directory" class="stack settings-form">
      <fieldset class="settings-section data-directory-section">
        <legend>数据目录</legend>
        <p class="settings-section-description">把运行数据移出程序或源码目录。迁移通过重启完成，成功后旧目录仍会原样保留，可用于回滚。</p>
        ${dataDirectory.migrationError
          ? html`<div class="form-error-summary" role="alert"><strong>上次迁移未完成</strong><p>${dataDirectory.migrationError}</p></div>`
          : ""}
        ${dataDirectory.pendingMigration
          ? html`<div class="flash" role="status"><strong>迁移已安排</strong><p>重新启动后将复制到 ${dataDirectory.pendingMigration.destination}${dataDirectory.pendingMigration.initializeGit ? "，并初始化 Git 仓库" : ""}。</p></div>`
          : ""}
        ${dataDirectory.lastMigration
          ? html`<p class="field-help">最近一次迁移：${dataDirectory.lastMigration.source} → ${dataDirectory.lastMigration.destination}</p>`
          : ""}
        <div class="field">
          <div class="field-label-row">
            <label for="data-directory">当前目录</label>
            <span class="effect-badge">${dataDirectory.gitRepository ? "Git 仓库" : "未启用 Git"}</span>
          </div>
          <code class="path-value">${dataDirectory.currentPath}</code>
        </div>
        <div class="field">
          <div class="field-label-row">
            <label for="data-directory">新目录</label>
            <span class="effect-badge">需重启生效</span>
          </div>
          <input id="data-directory" name="dataDirectory" type="text" placeholder="/Volumes/Knowledge/homeagent-data"
            autocomplete="off" ${dataMigrationDisabled ? "disabled" : ""} />
          <p class="field-help">必须使用绝对路径。目标可不存在、为空，或仅包含 <code>.git</code>、<code>.obsidian</code>、<code>.gitignore</code>、<code>.gitattributes</code>、<code>AGENTS.md</code> 等受支持的元数据；其他内容及同名冲突会被拒绝。已有 agent 规则会保留，缺失的仓库与 Space 指南在迁移时补齐。新旧目录不能互相包含。</p>
        </div>
        <label class="checkbox-row">
          <input type="checkbox" name="initializeGit"
            ${dataMigrationDisabled || !dataDirectory.gitAvailable || dataDirectory.gitRepository ? "disabled" : ""} />
          <span>在新目录初始化 Git 仓库</span>
        </label>
        <p class="field-help">新仓库只执行 <code>git init</code>；若目标已有 <code>.git</code>，则直接沿用。两种情况都会补充适合 HomeAgent 的 <code>.gitignore</code>，但不会 add、commit、配置远端或推送。运行锁、日志、内置 CLI 和可重建 SQLite 索引默认不纳入版本控制。</p>
        ${!dataDirectory.gitAvailable && !dataDirectory.gitRepository
          ? html`<p class="field-help">当前系统未找到 Git，因此不能勾选初始化；仍可只迁移目录。</p>`
          : ""}
        ${dataDirectory.lockedByEnvironment
          ? html`<p class="field-error">当前目录由 <code>HOMEAGENT_DATA_DIR</code> 环境变量固定。请先移除该变量，再从设置页迁移。</p>`
          : !dataDirectory.available
            ? html`<p class="field-help">当前运行方式不能从页面迁移。可停止服务后设置 <code>HOMEAGENT_DATA_DIR</code> 并手动复制数据。</p>`
            : ""}
        <label class="checkbox-row">
          <input type="checkbox" name="confirmMigration"
            ${dataMigrationDisabled ? "disabled" : ""} />
          <span>我确认迁移采用复制方式，成功后自行核验并决定是否删除旧目录</span>
        </label>
        <div class="actions settings-actions">
          <button type="submit" ${dataMigrationDisabled ? "disabled" : ""}>
            ${dataDirectory.restartable ? "迁移并重启" : "安排迁移"}
          </button>
        </div>
      </fieldset>
    </form>
    ${settingsScript}`;
}
