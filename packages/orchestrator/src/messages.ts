/**
 * Canned copy for the orchestrator (kept out of runtime.ts so wording is easy to
 * tweak). The plan calls out coldStartNote (Q3): the honest nudge appended when answering from general
 *     knowledge while the space's knowledge base is still empty.
 */
import { isProviderTimeoutError } from "@homeagent/llm";

/**
 * Shown when a message can't be answered because no runnable LLM provider is
 * configured (no agent assigned and no usable default CLI), or a provider error
 * has no safe public classification. Directs the operator to the management
 * backend rather than failing silently or exposing arbitrary diagnostics.
 */
export const NO_PROVIDER_NOTICE = [
  "⚠️ 回答 Agent 暂时不可用。",
  "即使本机 CLI 在控制台可用，HomeAgent 也可能尚未连接当前账号；请在管理后台检查当前空间的 Agent 和 Provider 连接状态，或更换默认的本机 CLI。",
].join("\n");

/** Safe, fixed copy for the canonical capacity error returned by Codex. */
export const MODEL_CAPACITY_NOTICE = [
  "⚠️ 当前模型容量已满，暂时无法完成这次回答。",
  "Provider 原始提示：Selected model is at capacity. Please try a different model.",
  "请稍后重试，或在管理后台为当前 Agent 选择其他模型。",
].join("\n");

export function providerTimeoutNotice(error: unknown): string {
  const match = String(error).match(/timed out after (\d+)ms/i);
  const timeoutMs = match ? Number(match[1]) : undefined;
  const limit = timeoutMs && Number.isFinite(timeoutMs)
    ? timeoutMs % 60_000 === 0
      ? `${timeoutMs / 60_000} 分钟`
      : timeoutMs % 1_000 === 0
        ? `${timeoutMs / 1_000} 秒`
        : `${timeoutMs} 毫秒`
    : "配置的最长回答时间";
  return [
    `⚠️ 回答超时：当前 Agent 已配置，但本机 AI 没有在 ${limit} 内完成这次回答。`,
    "可以稍后重试、在设置中延长聊天最长回答时间，或改用更快的模型；Codex 推荐 gpt-5.6-luna。",
  ].join("\n");
}

export const UNSUPPORTED_IMAGE_NOTICE = [
  "⚠️ 当前 Agent 不支持图片输入，因此我没有分析这张图。",
  "普通对话目前不会为了图片绕过 no-tools 隔离；请改用文字描述，或等待接入受限的视觉 completion 通道。",
].join("\n");

export const NO_TOOLS_MODE_NOTICE = [
  "⚠️ 当前 Provider 无法为普通对话提供可验证的 no-tools 隔离，因此这次调用已被安全拒绝。",
  "请把空间 Agent 切换到 Claude 或 Codex；TRAE 当前只用于显式任务执行。",
].join("\n");

export const GROUP_REMINDER_AUTOMATION_DENIAL =
  "只有群主或群管理员可以管理本群提醒；私聊提醒仍由本人直接管理。";

/**
 * Shown when the local CLI login itself expired or was revoked. This is
 * self-serviceable and must not be reported as a HomeAgent wiring problem: the
 * operator has to re-run the provider login, not inspect the management backend.
 */
export const PROVIDER_LOGIN_EXPIRED_NOTICE = [
  "⚠️ 本机 Codex 登录已失效，暂时无法回答。",
  "登录凭据已过期或被吊销（常见于在别处重新登录过）。请在终端执行 `codex login` 重新登录，HomeAgent 会自动采用刷新后的凭据。",
].join("\n");

/**
 * Shown when a Feishu group turn needed the Codex native topic session but the
 * frozen execution contract could not satisfy its isolation gate. This is an
 * Agent configuration problem, not a missing account connection: `full`
 * permission, a Workdir overlapping the data directory, a Skill bundle
 * overlapping the Workdir, a non-empty effective MCP list, or a Codex below
 * 0.152.1 all fail closed here. The generic notice pointed operators at Agent
 * and Provider connection status, which cannot fix any of those.
 */
export const NATIVE_SESSION_UNAVAILABLE_NOTICE = [
  "⚠️ 群里的话题回答暂时不可用：当前 Agent 的执行配置无法满足 Codex 原生会话的隔离要求。",
  "最常见的原因是 Agent 权限为 `full`。群聊话题要求可验证的受限沙箱，因此会在调用模型前固定拒绝；请在管理后台把该 Agent 权限改为 `write` 或 `read`。",
  "若权限本来就受限，请再依次检查：Workdir 是否与 HomeAgent 数据目录重叠、冻结 Skill 目录是否与 Workdir 重叠、有效 MCP 列表是否为空、本机 Codex 是否为 0.152.1 及以上。",
].join("\n");

/**
 * Appended to a group answer that had to run without the Codex native topic
 * session. The answer itself is valid, but this turn carries no topic memory,
 * so the note must be visible rather than silently degrading multi-turn.
 */
export const NATIVE_SESSION_FALLBACK_SUFFIX = [
  "",
  "",
  "（本轮未使用话题上下文：当前设备无法为群话题提供可验证的隔离沙箱，因此这次回答不包含本话题的上下文记忆。追问时请补齐必要信息。）",
].join("\n");
export function providerNotice(error: unknown): string {
  const message = String(error);
  if (/does not support image inputs|不支持图片输入/i.test(message)) {
    return UNSUPPORTED_IMAGE_NOTICE;
  }
  if (/cannot provide a no-tools execution mode/i.test(message)) {
    return NO_TOOLS_MODE_NOTICE;
  }
  if (/selected model is at capacity/i.test(message)) {
    return MODEL_CAPACITY_NOTICE;
  }
  if (/provider codex native session isolation is unavailable/i.test(message)) {
    return NATIVE_SESSION_UNAVAILABLE_NOTICE;
  }
  if (
    /refresh token was revoked|could not be refreshed|please log out and sign in again/i
      .test(message)
    || /\b401\b[^\n]*unauthorized|invalid_grant/i.test(message)
  ) {
    return PROVIDER_LOGIN_EXPIRED_NOTICE;
  }
  return isProviderTimeoutError(error) ? providerTimeoutNotice(error) : NO_PROVIDER_NOTICE;
}

/** Usage help for the /task chat commands. */
export const TASK_HELP = [
  "🗓 任务命令：",
  "· `/task` 或 `/task list` — 查看本空间的任务",
  "· `/task new <主题>` — 新建一个每日研究任务（研究结果写入本空间知识库）",
  "· `/task run <名称或序号>` — 立即运行某个任务",
  "· `/task help` — 显示本帮助",
].join("\n");

export const LEARNING_HELP = [
  "📚 学习命令：",
  "· `/learn` 或 `/learn list` — 查看我的学习计划",
  "· `/learn topic <主题>` — 先做入学诊断，再生成持续迭代的主题路线",
  "· `/learn new <名称>` — 回复附件、文章或飞书文档后创建材料阅读计划",
  "· `/learn add <名称或序号>` — 回复另一份材料，将它加入现有计划",
  "· `/learn route <名称或序号>` — 查看主题路线与下一课重点",
  "· `/learn resources <名称或序号>` — 联网刷新并查看当前推荐资料",
  "· `/learn pause <名称或序号>` — 暂停计划",
  "· `/learn resume <名称或序号>` — 恢复计划",
  "· `/learn skip <名称或序号>` — 跳过当前一课",
  "· `/learn delete <名称或序号>` — 删除计划",
  "· `学习回答：[计划名称或序号] <内容>` — 回答指定计划；仅一个待答计划时可省略方括号",
  "· `下一课要求：<要求>` — 仅在回答后另起一行填写，明确调整下一课",
].join("\n");

export function coldStartNote(): string {
  return [
    "（目前这个空间的知识库还是空的，所以上面是我的一般性回答。",
    "把值得记住的事发到群里、或 @我 直接告诉我，我就会逐步建立我们的知识库。）",
  ].join("");
}
