import { createHash } from "node:crypto";
import { html } from "hono/html";
import type { SpaceMeta, Task, TaskRun } from "@homeagent/core";
import { flash, fmtTime, taskCadenceLabel, taskRunDuration, taskRunStatus, taskRunTrigger } from "./views.ts";
import { taskScheduleTime } from "./task-schedule-preview.ts";

export function taskPreviewKey(task: Pick<Task, "space" | "topic">): string {
  return createHash("sha256").update(JSON.stringify([task.space, task.topic])).digest("hex");
}

export function taskOverviewView(task: Task, space: SpaceMeta | undefined, runs: TaskRun[], flashMsg?: string) {
  const base = `/tasks/${encodeURIComponent(task.id)}`;
  const active = runs.find((run) => ["awaiting_approval", "queued", "running"].includes(run.status));
  return html`<style>
    .task-overview { overflow-wrap:anywhere; }
    .task-overview header { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; margin-bottom:20px; }
    .task-overview h1 { font-size:clamp(24px, 3vw, 32px); line-height:1.25; }
    .task-overview header .btn { flex:none; }
    .task-overview .btn, .task-overview button { display:inline-flex; align-items:center; min-height:44px; }
    .task-context { display:flex; flex-wrap:wrap; gap:4px 18px; margin:8px 0 0; color:var(--muted); font-size:14px; }
    .task-topic-card h2, .task-history h2 { margin:0; }
    .task-topic-text { white-space:pre-wrap; margin:12px 0 18px; line-height:1.65; }
    .task-topic-card form { margin:0; }
    .task-latest { border-bottom:1px solid var(--border); padding:4px 0 12px; }
    .task-latest h2 { margin:10px 0; }
    .task-latest p { margin:6px 0; white-space:pre-wrap; }
    .task-history { margin-top:24px; }
    .task-history ul { list-style:none; padding:0; margin:4px 0; }
    .task-history li { display:flex; align-items:center; flex-wrap:wrap; justify-content:space-between;
      gap:4px 14px; padding:8px 0; border-bottom:1px solid var(--border); }
    .task-history a { display:inline-flex; align-items:center; min-height:40px; gap:10px; }
    .task-history .muted { font-size:13px; }
    @media (max-width:720px) {
      .task-overview header { gap:8px; margin-bottom:14px; }
      .task-context { gap:4px 12px; }
      .task-history a { min-height:44px; }
    }
  </style>
  <article class="task-overview" data-task-overview>
    ${flash(flashMsg)}
    <header><div><h1>${task.name}</h1><p class="task-context">
      ${space ? html`<a href="/spaces/${encodeURIComponent(space.id)}">${space.name?.trim() || space.id}</a>` : task.space}
      <span>${taskCadenceLabel(task)}</span><span>${task.enabled ? "定时已启用" : "定时已停用"}</span>
      ${task.enabled ? html`<span>${task.lastRunAt === undefined ? "首次" : "下次"}预计运行：${taskScheduleTime(task, Date.now())}</span>` : ""}
    </p></div><a class="btn secondary" href="${base}?edit=1">编辑设置</a></header>
    <section class="card task-topic-card" aria-labelledby="task-topic-heading">
      <h2 id="task-topic-heading">已保存的研究主题</h2>
      <p class="task-topic-text" id="task-topic">${task.topic || "当前研究主题为空。"}</p>
      ${active
        ? html`<a class="btn" href="/tasks/runs/${encodeURIComponent(active.id)}">${active.status === "awaiting_approval"
            ? "查看待审批申请" : active.status === "queued" ? "查看排队任务" : "查看运行中任务"}</a>`
        : html`<form method="post" action="${base}/run">
            <input type="hidden" name="expectedTaskPreview" value="${taskPreviewKey(task)}" />
            <button type="submit">立即运行</button>
          </form>`}
    </section>
    ${task.lastRunAt ? html`<section class="task-latest"><h2>上次完成</h2>
      <p class="muted">${fmtTime(task.lastRunAt)}${task.lastStatus === "error" ? " · 失败" : task.lastStatus === "ok" ? " · 成功" : ""}</p>
      ${task.lastStatus === "error" && task.lastError ? html`<p>${task.lastError}</p>` : ""}
      ${task.lastSummary ? html`<p>${task.lastSummary}</p>` : ""}
    </section>` : ""}
    <section class="task-history"><h2>运行历史</h2>
      ${runs.length ? html`<ul>${runs.map((run) => html`<li>
        <a href="/tasks/runs/${encodeURIComponent(run.id)}">${taskRunStatus(run.status)} <span>${fmtTime(run.startedAt)}</span></a>
        <span class="muted">${taskRunTrigger(run.trigger)} · ${taskRunDuration(run)}</span>
      </li>`)}</ul>` : html`<p class="muted">还没有运行记录。</p>`}
    </section>
  </article>`;
}
