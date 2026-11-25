import type { InboundMessage } from "@homeagent/connectors";
import type { ChatRun, WorkInput } from "@homeagent/core";

export type ChatRecoveryOperation = "retry" | "resend";

export function chatRecoveryCommand(text: string): ChatRecoveryOperation | undefined {
  const command = text.trim().replace(/^(?:@\S+\s+)+/u, "").replace(/[。！!]+$/u, "").trim();
  return command === "重试这次" ? "retry" : command === "补发回答" ? "resend" : undefined;
}

export function chatRecoveryAvailable(run: ChatRun): ChatRecoveryOperation | undefined {
  if (run.status === "succeeded" && run.output && !run.outputTruncated
    && (run.delivery.status === "failed" || (run.delivery.status === "pending" && run.delivery.attempts === 0))) return "resend";
  if (run.executionPlan && ["failed", "timed_out", "cancelled"].includes(run.status)) return "retry";
  return undefined;
}

/** Bind controls to the original input, even if the Space's current Agent or work item has changed. */
export function ordinaryFeishuSource(run: ChatRun, input: WorkInput | undefined, appId: string): input is WorkInput {
  return !!input && input.connector === "feishu" && input.appId === appId && input.space === run.space
    && input.operation === "chat" && !!input.response && ["answer", "static", "remember"].includes(input.response.kind)
    && input.message.chatId === run.chatId && input.message.messageId === run.messageId && input.message.senderId === run.author;
}

/** Prefer an exact card or reply. Multiple independent questions in one topic require an explicit reply. */
export function chatRecoveryTarget(msg: InboundMessage, candidates: { run: ChatRun; source: WorkInput }[]): ChatRun | undefined {
  const exact = candidates.filter(({ run }) => msg.parentMessageId !== undefined
    && (run.delivery.liveReply?.messageId === msg.parentMessageId || run.delivery.messageId === msg.parentMessageId));
  const matches = (exact.length ? exact : candidates).filter(({ run, source }) => {
    const root = source.message.rootMessageId ?? source.message.messageId;
    if (source.message.threadId && msg.threadId && source.message.threadId !== msg.threadId) return false;
    if (msg.rootMessageId && msg.rootMessageId !== root && !(exact.length && msg.rootMessageId === msg.parentMessageId)) return false;
    return exact.length > 0 || msg.parentMessageId === run.messageId || (!!msg.rootMessageId && msg.rootMessageId === root);
  });
  if (exact.length) return matches.length === 1 ? matches[0]!.run : undefined;
  // An explicit reply to the original question keeps that identity. In its
  // topic alone, a fresh command may select the latest attempt of one question.
  const original = matches.filter(({ run }) => !run.retryOf && msg.parentMessageId === run.messageId);
  if (original.length === 1) return original[0]!.run;
  const attempts = matches.filter(({ run }) => run.startedAt <= msg.createdAt);
  const parents = new Set(attempts.map(({ run }) => run.retryOf));
  const leaves = attempts.filter(({ run }) => !parents.has(run.id));
  return leaves.length === 1 ? leaves[0]!.run : undefined;
}
