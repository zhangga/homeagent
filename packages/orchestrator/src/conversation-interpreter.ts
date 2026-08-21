/**
 * Lightweight interpretation for an addressed conversation turn.
 *
 * System controls are deliberately narrow and deterministic because they cause
 * side effects. Everything else defaults to conversation so fuzzy requests can
 * reach the answering model, which may answer directly or ask for clarification.
 * This avoids turning grammatical imperatives such as "分析一下" into HomeAgent
 * control commands.
 */

export type ConversationDisposition = "conversation" | "remember" | "chitchat";
export type KnowledgeControl = "redistill";

export interface ConversationInterpretation {
  disposition: ConversationDisposition;
  /** User-facing text with leading rendered bot mentions removed. */
  text: string;
}

/** Short pure-greeting / acknowledgement phrases that never need a model call. */
const GREETINGS = new Set([
  "在吗", "在么", "你好", "您好", "hello", "hi", "hey", "在不在",
  "哈哈", "哈哈哈", "呵呵", "嘿", "早", "早上好", "晚安", "谢谢", "谢了",
  "thanks", "thank you", "ok", "okay", "好的", "收到", "👍", "666",
  "嗯", "嗯嗯", "哦", "噢", "啊", "哈", "好", "行", "可以", "没事",
]);

const QUESTION_PREFIXES = [
  "谁", "什么", "哪里", "哪儿", "哪个", "哪些", "哪位",
  "哪家", "哪天", "哪种", "哪条", "哪本", "哪件", "哪次",
  "怎么", "怎样", "如何", "为什么", "为何", "多少",
  "几点", "几号", "几时", "几个", "几位", "几岁", "几年", "几天",
  "何时", "什么时候", "是否", "有没有", "有没", "能否", "可否",
  "是不是", "要不要", "该不该",
];

const QUESTION_SUFFIXES = [
  "是谁", "是什么", "叫什么", "什么意思", "在哪", "在哪里", "在哪儿",
  "怎么回事", "怎么样", "怎么办", "有多少", "多少个",
];

const ENGLISH_QUESTION_PREFIXES = [
  "who ", "what ", "where ", "when ", "why ", "how ",
  "is ", "are ", "am ", "was ", "were ",
  "do ", "does ", "did ", "can ", "could ", "would ", "should ",
];

/** Remove one or more rendered @mentions from the start of a message. */
export function normalizeConversationText(text: string): string {
  let normalized = text.trim();
  while (/^@\S+\s+/u.test(normalized)) {
    normalized = normalized.replace(/^@\S+\s+/u, "").trimStart();
  }
  return normalized;
}

/**
 * Questions with explicit punctuation or stable interrogative forms can be
 * recognized without invoking a model. Group participation uses this as a safe
 * fallback when its model is unavailable.
 */
export function prefilterQuestion(text: string): boolean {
  const normalized = normalizeConversationText(text);
  if (/[?？]/u.test(normalized)) return true;

  const compact = normalized
    .toLowerCase()
    .replace(/[!！。.~～,，、\s]+$/gu, "")
    .trim();
  if (!compact) return false;
  if (QUESTION_PREFIXES.some((prefix) => compact.startsWith(prefix))) return true;
  if (QUESTION_SUFFIXES.some((suffix) => compact.endsWith(suffix))) return true;
  if (compact.endsWith("吗")) return true;
  return ENGLISH_QUESTION_PREFIXES.some((prefix) => compact.startsWith(prefix));
}

/** A message is a trivial greeting if it is short and matches a known phrase. */
export function prefilterChitchat(text: string): boolean {
  const normalized = normalizeConversationText(text);
  const compact = normalized
    .toLowerCase()
    .replace(/[!！。.~～?？,，\s]+$/g, "");
  if (compact.length === 0) return true;
  if (GREETINGS.has(compact)) return true;
  return false;
}

function isExplicitRememberRequest(text: string): boolean {
  const compact = text.replace(/[。.!！]+$/u, "").trim();
  return /^(?:(?:请|帮我)\s*)?(?:记住|记下|记录下来)/u.test(compact)
    || /(?:^|[，,\s])(?:记住|记下|记录下来)$/u.test(compact)
    // A user often pastes the material first, then addresses the bot on the
    // final line. Leading-mention normalization cannot see that rendered @,
    // so recognize only a narrow, line-anchored deictic memory command here.
    || /(?:^|[\r\n])\s*(?:@\S+\s+)?(?:(?:请|帮我)\s*)?(?:记住|记下|记录下来)(?:上面|以上|前面|上述|这些|这条|本条)(?:的)?(?:信息|内容|消息|资料|记录)?\s*$/u.test(compact);
}

/**
 * Parse only explicit knowledge controls. The expression is anchored so
 * questions such as "重新提炼有什么影响" remain ordinary conversation.
 */
export function parseKnowledgeControl(text: string): KnowledgeControl | null {
  const normalized = normalizeConversationText(text)
    .replace(/[。.!！]+$/u, "")
    .trim();
  if (/^\/?dream$/iu.test(normalized)) return "redistill";
  if (
    /^(?:(?:请|麻烦|帮我)\s*)?(?:(?:现在|立即)\s*)?(?:重新提炼|重新整理)(?:一下|下)?(?:吧)?$/u
      .test(normalized)
  ) {
    return "redistill";
  }
  if (
    /^(?:(?:请|麻烦|帮我)\s*)?(?:(?:现在|立即)\s*)?(?:重新提炼|重新整理|整理)(?:一下|下)?(?:本空间|这个空间|当前空间)?(?:的)?(?:知识|知识库)(?:吧)?$/u
      .test(normalized)
  ) {
    return "redistill";
  }
  return null;
}

/**
 * Keep the local interpretation intentionally conservative: only explicit
 * memory requests and trivial chat are diverted. All uncertain language goes
 * to conversation, where the model can answer or ask a natural clarification.
 */
export function interpretConversation(text: string): ConversationInterpretation {
  const normalized = normalizeConversationText(text);
  if (prefilterChitchat(normalized)) {
    return { disposition: "chitchat", text: normalized };
  }
  if (prefilterQuestion(normalized)) {
    return { disposition: "conversation", text: normalized };
  }
  if (isExplicitRememberRequest(normalized)) {
    return { disposition: "remember", text: normalized };
  }
  return { disposition: "conversation", text: normalized };
}
