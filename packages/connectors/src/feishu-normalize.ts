/**
 * Pure normalization of lark-cli event NDJSON into the connector's InboundEvent
 * envelope (plan §IV). Kept separate from the subprocess plumbing in feishu.ts
 * so the parsing rules are unit-testable without spawning anything.
 *
 * Field placement is per lark-cli's `event schema` (verified live):
 *   - im.message.receive_v1     -> fields at top level (jq_root_path ".")
 *   - im.chat.member.bot.added_v1 -> fields under ".event" (jq_root_path ".event")
 *
 * Mention detection (Q2 group @-gating): the rendered receive schema does NOT
 * expose a mentions array, and the pre-rendered `content` may or may not contain
 * the literal bot name. We therefore detect a bot mention from several defensive
 * signals, most precise first:
 *   1. a `mentions[]` array (feishu's raw field, often preserved) whose entry
 *      open_id matches the configured bot open_id, or whose name matches the
 *      configured bot name;
 *   2. the rendered content containing "@<botName>";
 *   3. when identity hints and structured mentions are both absent, a textual
 *      @mention token in the rendered content.
 * Operators set HOMEAGENT_FEISHU_BOT_NAME / _OPEN_ID for precise gating; without
 * them we fall back to "any mention present" so the bot is not permanently mute.
 */
import type { Attachment } from "@homeagent/shared";
import type { BotAddedEvent, InboundMessage } from "./connector.ts";
import { normalizeByteTechArticleUrl } from "./source-links.ts";

export interface FeishuIdentity {
  botName?: string;
  botOpenId?: string;
}

interface MentionEntry {
  key?: string;
  name?: string;
  id?: { open_id?: string; union_id?: string; user_id?: string };
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export interface FeishuMessageResource {
  kind: Attachment["kind"];
  fileKey: string;
  resourceType: "image" | "file";
  name?: string;
}

export function parseMessageResources(
  messageType: string | undefined,
  content: string | undefined,
): FeishuMessageResource[] {
  if (
    !messageType
    || !content
    || !["image", "file", "audio", "media", "post"].includes(messageType)
  ) {
    return [];
  }

  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return [];
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const parsed = value as Record<string, unknown>;

  if (messageType === "post") {
    const imageKeys: string[] = [];
    collectPostImageKeys(parsed, imageKeys);
    return [...new Set(imageKeys)].map((fileKey) => ({
      kind: "image",
      fileKey,
      resourceType: "image",
    }));
  }

  const imageKey = asString(parsed.image_key);
  const fileKey = asString(parsed.file_key);
  const name = asString(parsed.file_name);
  if (messageType === "image" && imageKey) {
    return [{ kind: "image", fileKey: imageKey, resourceType: "image" }];
  }
  if (!fileKey) return [];

  const kind: Attachment["kind"] =
    messageType === "audio"
      ? "audio"
      : name?.toLowerCase().endsWith(".pdf")
        ? "pdf"
        : "file";
  return [{ kind, fileKey, resourceType: "file", name }];
}

function collectPostImageKeys(value: unknown, out: string[], depth = 0): void {
  if (depth > 20 || out.length >= 20) return;
  if (Array.isArray(value)) {
    for (const item of value) collectPostImageKeys(item, out, depth + 1);
    return;
  }
  if (typeof value !== "object" || value === null) return;

  const node = value as Record<string, unknown>;
  if (node.tag === "img") {
    const imageKey = asString(node.image_key);
    if (imageKey) out.push(imageKey);
    return;
  }
  for (const child of Object.values(node)) {
    collectPostImageKeys(child, out, depth + 1);
  }
}

function extractMentions(obj: Record<string, unknown>): MentionEntry[] {
  // mentions may sit at top level or under a nested `message` object depending
  // on how lark-cli forwards the raw event.
  const candidates = [obj.mentions, (obj.message as Record<string, unknown> | undefined)?.mentions];
  for (const c of candidates) {
    if (Array.isArray(c)) return c as MentionEntry[];
  }
  return [];
}

/** Decide whether the bot was mentioned, given identity hints. */
export function detectBotMention(
  obj: Record<string, unknown>,
  content: string,
  identity: FeishuIdentity,
): boolean {
  const mentions = extractMentions(obj);

  if (identity.botOpenId) {
    if (mentions.some((m) => m.id?.open_id === identity.botOpenId)) return true;
  }
  if (identity.botName) {
    if (mentions.some((m) => m.name === identity.botName)) return true;
    if (content.includes(`@${identity.botName}`)) return true;
  }
  // No precise identity configured: any mention is assumed to address the bot
  // (people @ the bot to ask it). This keeps a group-added bot responsive.
  if (!identity.botOpenId && !identity.botName && mentions.length > 0) return true;
  // lark-cli's flattened receive event can omit `mentions[]` while retaining
  // the rendered "@BotName" token. Require start/whitespace before @ so an
  // email address does not accidentally open the group reply gate.
  if (!identity.botOpenId && !identity.botName && /(?:^|\s)@\S+/u.test(content)) return true;

  return false;
}

function supportedFeishuDocUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (
      url.protocol !== "https:"
      || url.username !== ""
      || url.password !== ""
      || !(
        host === "feishu.cn"
        || host.endsWith(".feishu.cn")
        || host === "larkoffice.com"
        || host.endsWith(".larkoffice.com")
      )
      || !/^\/(?:docx|wiki|docs)\/[A-Za-z0-9]+(?:[/?#]|$)/u.test(
        `${url.pathname}${url.search}${url.hash}`,
      )
    ) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

/** Feishu documents and allowlisted internal articles appearing in a message. */
export function extractDocLinks(content: string): string[] {
  const candidates = content.match(/https?:\/\/[^\s<>()\[\]{}"'，。！？；：、]+/gu) ?? [];
  const found: string[] = [];
  for (const candidate of candidates) {
    const trimmed = candidate.replace(/[，。！？；：、,.!?;:]+$/gu, "");
    const normalized = normalizeByteTechArticleUrl(trimmed)
      ?? supportedFeishuDocUrl(trimmed);
    if (normalized) found.push(normalized);
  }
  return [...new Set(found)];
}

/**
 * Normalize a parsed receive_v1 JSON object into an InboundMessage, or null if
 * it is not a usable text message (e.g. missing ids).
 */
export function normalizeMessage(
  obj: Record<string, unknown>,
  identity: FeishuIdentity = {},
): InboundMessage | null {
  const chatId = asString(obj.chat_id);
  const messageId = asString(obj.message_id) ?? asString(obj.id);
  const eventId = asString(obj.event_id) ?? messageId;
  const senderId = asString(obj.sender_id) ?? "unknown";
  const chatTypeRaw = asString(obj.chat_type);
  const content = asString(obj.content) ?? "";
  if (!chatId || !messageId || !eventId) return null;

  const chatType = chatTypeRaw === "group" || chatTypeRaw === "topic_group"
    ? "group"
    : "p2p";
  const createdAt = Number(asString(obj.create_time) ?? asString(obj.timestamp) ?? Date.now());

  return {
    kind: "message",
    eventId,
    chatType,
    chatId,
    senderId,
    text: content,
    messageId,
    threadId: asString(obj.thread_id),
    rootMessageId: asString(obj.root_id),
    parentMessageId: asString(obj.reply_to) ?? asString(obj.parent_id),
    messageType: asString(obj.message_type),
    mentionsBot: chatType === "p2p" ? true : detectBotMention(obj, content, identity),
    docLinks: extractDocLinks(content),
    createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
  };
}

/**
 * Normalize a bot.added event. The consume output nests fields under `.event`;
 * we accept either the already-unwrapped object or the full envelope.
 */
export function normalizeBotAdded(obj: Record<string, unknown>): BotAddedEvent | null {
  const inner = (obj.event as Record<string, unknown> | undefined) ?? obj;
  const chatId = asString(inner.chat_id);
  if (!chatId) return null;
  const eventId =
    asString((obj.header as Record<string, unknown> | undefined)?.event_id) ??
    asString(obj.event_id) ??
    `bot_added-${chatId}-${Date.now()}`;
  return {
    kind: "bot_added",
    eventId,
    chatId,
    createdAt: Date.now(),
  };
}
