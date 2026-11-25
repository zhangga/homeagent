import { NoProviderError } from "@homeagent/core";
import { isProviderCapacityError, isProviderLoginExpiredError, isProviderTimeoutError } from "@homeagent/llm";

export interface AskFailure {
  message: string;
  settingsLink?: boolean;
}

/** Only fixed, actionable copy crosses from provider diagnostics into a Space page. */
export function askFailure(error: unknown, provider?: string): AskFailure {
  if (error instanceof NoProviderError || error === "NoProviderError") {
    return { message: "本空间缺少可用的回答 Agent。请配置默认 AI 或为空间绑定助手后重试。", settingsLink: true };
  }
  const diagnostic = String(error);
  if (isProviderCapacityError(error) || /\brate[ _-]limit(?:ed|[ _-](?:exceeded|error))?\b|\boverloaded(?:_error)?\b|\btoo many requests\b|\b(?:HTTP|status(?: code)?)\s*[:=]?\s*429\b/i.test(diagnostic)) {
    return { message: "当前模型繁忙，请稍后重试这个问题。" };
  }
  const codexAuthUnavailable = /provider codex authentication is unavailable/i.test(diagnostic);
  if (isProviderLoginExpiredError(error) || codexAuthUnavailable || /\bnot (?:logged|signed) in\b|\b(?:login|log in|sign in|authentication) required\b/i.test(diagnostic)) {
    const action = provider === "codex" || codexAuthUnavailable ? "请在本机执行 codex login，完成后重试这个问题。"
      : provider === "agy" ? "请在本机执行 agy 完成登录，完成后重试这个问题。"
      : "请在本机重新登录当前回答助手所用的 AI 服务，完成后重试这个问题。";
    return { message: "当前 AI 服务需要重新登录。" + action };
  }
  if (isProviderTimeoutError(error)) return { message: "本次回答超时，可以重试这个问题。" };
  return { message: "这次提问未能完成，可以重试这个问题。" };
}
