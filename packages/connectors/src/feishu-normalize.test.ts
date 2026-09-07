import { describe, expect, test } from "bun:test";
import {
  detectBotMention,
  extractDocLinks,
  normalizeBotAdded,
  normalizeMessage,
  parseMessageResources,
} from "./feishu-normalize.ts";

describe("normalizeMessage", () => {
  const base = {
    chat_id: "oc_1",
    chat_type: "group",
    content: "谁负责后端？",
    event_id: "evt_1",
    message_id: "om_1",
    sender_id: "ou_a",
    create_time: "1700000000000",
  };

  test("maps top-level fields into the envelope", () => {
    const m = normalizeMessage({ ...base });
    expect(m).not.toBeNull();
    expect(m!.chatId).toBe("oc_1");
    expect(m!.chatType).toBe("group");
    expect(m!.senderId).toBe("ou_a");
    expect(m!.messageId).toBe("om_1");
    expect(m!.eventId).toBe("evt_1");
    expect(m!.text).toBe("谁负责后端？");
  });

  test("retains the Feishu message type for attachment routing", () => {
    expect(normalizeMessage({ ...base, message_type: "image" })?.messageType).toBe("image");
  });

  test("retains the Feishu topic identity for conversation routing", () => {
    expect(normalizeMessage({
      ...base,
      thread_id: "omt_topic_1",
      root_id: "om_root_1",
      parent_id: "om_parent_1",
    })).toEqual(expect.objectContaining({
      threadId: "omt_topic_1",
      rootMessageId: "om_root_1",
      parentMessageId: "om_parent_1",
    }));
  });

  test("uses the lark-cli reply_to field as the topic parent", () => {
    expect(normalizeMessage({
      ...base,
      reply_to: "om_rendered_parent",
      parent_id: "om_raw_parent",
    })?.parentMessageId).toBe("om_rendered_parent");
  });

  test("p2p always counts as mentioning the bot", () => {
    const m = normalizeMessage({ ...base, chat_type: "p2p" });
    expect(m!.mentionsBot).toBe(true);
  });

  test("group without mention -> mentionsBot false", () => {
    const m = normalizeMessage({ ...base, chat_type: "group" }, { botName: "homeagent" });
    expect(m!.mentionsBot).toBe(false);
  });

  test("treats a Feishu topic_group as a group conversation", () => {
    const m = normalizeMessage(
      { ...base, chat_type: "topic_group" },
      { botName: "homeagent" },
    );
    expect(m).toEqual(expect.objectContaining({
      chatType: "group",
      mentionsBot: false,
    }));
  });

  test("falls back to id when message_id missing", () => {
    const m = normalizeMessage({ ...base, message_id: undefined, id: "om_legacy" });
    expect(m!.messageId).toBe("om_legacy");
  });

  test("returns null when required ids missing", () => {
    expect(normalizeMessage({ content: "x" })).toBeNull();
    expect(normalizeMessage({ chat_id: "oc_1", content: "x" })).toBeNull();
  });
});

describe("parseMessageResources", () => {
  test("extracts image and named file resources from raw message content", () => {
    expect(parseMessageResources("image", JSON.stringify({ image_key: "img_1" }))).toEqual([
      { kind: "image", fileKey: "img_1", resourceType: "image" },
    ]);
    expect(
      parseMessageResources(
        "file",
        JSON.stringify({
          file_key: "file_1",
          file_name: "roadmap.pdf",
        }),
      ),
    ).toEqual([
      { kind: "pdf", fileKey: "file_1", resourceType: "file", name: "roadmap.pdf" },
    ]);
  });

  test("extracts embedded images from a rich-text post", () => {
    expect(
      parseMessageResources(
        "post",
        JSON.stringify({
          zh_CN: {
            title: "今晚的晚餐",
            content: [[
              { tag: "text", text: "三菜一汤" },
              { tag: "img", image_key: "img_1" },
              { tag: "img", image_key: "img_2" },
            ]],
          },
        }),
      ),
    ).toEqual([
      { kind: "image", fileKey: "img_1", resourceType: "image" },
      { kind: "image", fileKey: "img_2", resourceType: "image" },
    ]);
  });

  test("malformed and unsupported resource content is ignored", () => {
    expect(parseMessageResources("text", JSON.stringify({ text: "hello" }))).toEqual([]);
    expect(parseMessageResources("file", "not-json")).toEqual([]);
    expect(parseMessageResources("file", "null")).toEqual([]);
    expect(
      parseMessageResources("file", JSON.stringify({ file_name: "missing-key.pdf" })),
    ).toEqual([]);
  });
});

describe("detectBotMention", () => {
  test("matches by bot open_id in mentions array", () => {
    const obj = { mentions: [{ name: "homeagent", id: { open_id: "ou_bot" } }] };
    expect(detectBotMention(obj, "@homeagent 你好", { botOpenId: "ou_bot" })).toBe(true);
  });

  test("matches by bot name in mentions array", () => {
    const obj = { mentions: [{ name: "homeagent" }] };
    expect(detectBotMention(obj, "hi", { botName: "homeagent" })).toBe(true);
  });

  test("matches @name in content when no structured mention", () => {
    expect(detectBotMention({}, "@homeagent 谁负责后端", { botName: "homeagent" })).toBe(true);
  });

  test("no identity configured: any mention counts", () => {
    const obj = { mentions: [{ name: "someone" }] };
    expect(detectBotMention(obj, "hi", {})).toBe(true);
  });

  test("no identity configured: detects textual mention in flattened event", () => {
    expect(detectBotMention({}, "@小强Bot HOMEAGENT-GROUP-ASK：1+1等于几？", {})).toBe(true);
  });

  test("no mention, no match -> false", () => {
    expect(detectBotMention({}, "普通消息", { botName: "homeagent" })).toBe(false);
  });

  test("reads mentions nested under message", () => {
    const obj = { message: { mentions: [{ id: { open_id: "ou_bot" } }] } };
    expect(detectBotMention(obj, "x", { botOpenId: "ou_bot" })).toBe(true);
  });
});

describe("extractDocLinks (Q8)", () => {
  test("finds docx/wiki and ByteTech article links and dedupes", () => {
    const text =
      "见文档 https://x.feishu.cn/docx/abc123 和 https://x.feishu.cn/wiki/def456，" +
      "再读 https://bytetech.info/articles/7525079282028621867，" +
      "还有 https://x.feishu.cn/docx/abc123";
    expect(extractDocLinks(text)).toEqual([
      "https://x.feishu.cn/docx/abc123",
      "https://x.feishu.cn/wiki/def456",
      "https://bytetech.info/articles/7525079282028621867",
    ]);
  });

  test("does not treat lookalike ByteTech hosts or non-article paths as documents", () => {
    expect(extractDocLinks([
      "https://bytetech.info.evil.example/articles/123",
      "https://evil.example/https://bytetech.info/articles/456",
      "https://bytetech.info/search?q=articles/789",
    ].join(" "))).toEqual([]);
  });

  test("no links -> empty", () => {
    expect(extractDocLinks("没有链接")).toEqual([]);
  });
});

describe("normalizeBotAdded", () => {
  test("reads chat_id from nested event envelope", () => {
    const obj = { header: { event_id: "evt_9" }, event: { chat_id: "oc_new" } };
    const e = normalizeBotAdded(obj);
    expect(e!.kind).toBe("bot_added");
    expect(e!.chatId).toBe("oc_new");
    expect(e!.eventId).toBe("evt_9");
  });

  test("accepts already-unwrapped object", () => {
    const e = normalizeBotAdded({ chat_id: "oc_x" });
    expect(e!.chatId).toBe("oc_x");
  });

  test("null when no chat_id", () => {
    expect(normalizeBotAdded({ event: {} })).toBeNull();
  });
});
