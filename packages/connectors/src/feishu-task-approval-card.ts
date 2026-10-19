export interface TaskApprovalCardSnapshot {
  runId: string;
  taskName: string;
  topic: string;
  requestedAt: number;
  expiresAt: number;
  state: "pending" | "approved" | "rejected" | "expired" | "unavailable";
  permission: string;
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  workdir?: string;
  timeoutMs?: number;
  decisionBy?: string;
  message?: string;
  personal: boolean;
}

function text(value: string | undefined, limit: number): string {
  return (value ?? "").replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, limit);
}
function markdown(value: string | undefined, limit: number): string {
  return text(value, limit).replace(/[&<>`*_\[\]~]/gu, char => `&#${char.charCodeAt(0)};`);
}

/** Shared Card 2.0: one primary approval action, a rejection action, then terminal feedback. */
export function buildTaskApprovalCard(snapshot: TaskApprovalCardSnapshot): Record<string, unknown> {
  const labels = { pending: "等待高权限审批", approved: "审批已通过", rejected: "审批已拒绝",
    expired: "审批已过期", unavailable: "审批已失效" };
  const deadline = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric",
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
    .format(snapshot.expiresAt);
  const instruction = snapshot.personal ? "本人可审批；通过后按本次冻结配置执行。" : "群主或群管理员可审批；通过后按本次冻结配置执行。";
  const topic = text(snapshot.topic, 700);
  const elements: Record<string, unknown>[] = [
    { tag: "markdown", content: `**${markdown(snapshot.taskName, 100)}**\n${markdown(topic, 700)}${snapshot.topic.length > 700 ? "…（主题预览）" : ""}` },
    { tag: "column_set", flex_mode: "none", background_style: "grey-50", columns: [
      { tag: "column", width: "weighted", weight: 1, padding: "8px", elements: [
        { tag: "markdown", content: [
          `**执行权限：** ${markdown(snapshot.permission, 20)}${snapshot.permission === "full" ? "（完全访问，可读写工作目录外文件并访问网络）" : ""}`,
          `**Provider / 模型：** ${markdown(snapshot.provider, 30) || "默认"} / ${markdown(snapshot.model, 200) || "CLI 默认"}`,
          ...(snapshot.reasoningEffort ? [`**推理等级：** ${markdown(snapshot.reasoningEffort, 20)}`] : []),
          `**工作目录：** ${markdown(snapshot.workdir, 2048) || "未指定"}`,
          ...(snapshot.timeoutMs ? [`**执行时限：** ${Math.ceil(snapshot.timeoutMs / 60_000)} 分钟`] : []),
          `**审批截止（北京时间）：** ${deadline}`,
        ].join("\n") },
      ] },
    ] },
    { tag: "markdown", text_size: "notation", content: `Run：${markdown(snapshot.runId, 170)}\n${instruction}` },
  ];
  if (snapshot.message) elements.push({ tag: "markdown", content: markdown(snapshot.message, 300) });
  if (snapshot.state === "pending") {
    elements.push({ tag: "column_set", flex_mode: "none", horizontal_spacing: "8px", columns:
      ([{ decision: "approve", label: "通过审批", type: "primary_filled" },
        { decision: "reject", label: "拒绝", type: "danger" }] as const).map(button => ({
        tag: "column", width: "weighted", weight: 1, elements: [{
          tag: "button", type: button.type, width: "fill", text: { tag: "plain_text", content: button.label },
          behaviors: [{ type: "callback", value: { action: "homeagent.task-approval", runId: snapshot.runId,
            requestedAt: snapshot.requestedAt, decision: button.decision } }],
        }],
      })) });
  } else if (snapshot.decisionBy) {
    elements.push({ tag: "markdown", text_size: "notation", content: `处理人：${markdown(snapshot.decisionBy, 300)}` });
  }
  const card = { schema: "2.0", config: { update_multi: true, width_mode: "default",
    summary: { content: `HomeAgent · ${labels[snapshot.state]}` } },
    header: { title: { tag: "plain_text", content: labels[snapshot.state] },
      subtitle: { tag: "plain_text", content: text(snapshot.taskName, 100) },
      template: snapshot.state === "approved" ? "green" : snapshot.state === "rejected" ? "red" : "orange",
      icon: { tag: "standard_icon", token: "approval_colorful" } },
    body: { direction: "vertical", padding: "12px", vertical_spacing: "12px", elements } };
  if (Buffer.byteLength(JSON.stringify(card), "utf8") > 30 * 1024) throw new Error("审批卡片超过飞书消息大小限制");
  return card;
}
