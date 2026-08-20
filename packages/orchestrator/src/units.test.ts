import { describe, expect, test } from "bun:test";
import type { InboundMessage } from "@homeagent/connectors";
import { attribute } from "./attribution.ts";
import { gate } from "./gateway.ts";
import {
  interpretConversation,
  normalizeConversationText,
  parseKnowledgeControl,
  prefilterChitchat,
  prefilterQuestion,
} from "./conversation-interpreter.ts";
import { formatAnswer } from "./format.ts";
import type { AskResult } from "@homeagent/shared";

function msg(over: Partial<InboundMessage>): InboundMessage {
  return {
    kind: "message",
    eventId: "e1",
    chatType: "group",
    chatId: "oc_1",
    senderId: "ou_a",
    text: "hi",
    messageId: "om_1",
    mentionsBot: false,
    createdAt: Date.now(),
    ...over,
  };
}

describe("attribution (Q4/Q5)", () => {
  test("group message -> team space; reads team ∪ personal", () => {
    const a = attribute(msg({ chatType: "group", chatId: "oc_1", senderId: "ou_a" }));
    expect(a.writeSpace).toBe("team/oc_1");
    expect(a.readSpaces).toEqual(["team/oc_1", "personal/ou_a"]);
  });

  test("p2p message -> personal space; reads personal only", () => {
    const a = attribute(msg({ chatType: "p2p", chatId: "oc_p", senderId: "ou_a" }));
    expect(a.writeSpace).toBe("personal/ou_a");
    expect(a.readSpaces).toEqual(["personal/ou_a"]);
  });
});

describe("reply gateway (Q2)", () => {
  test("p2p always responds", () => {
    const d = gate(msg({ chatType: "p2p", mentionsBot: false }));
    expect(d.respond).toBe(true);
    expect(d.capture).toBe(true);
  });

  test("group with mention responds", () => {
    const d = gate(msg({ chatType: "group", mentionsBot: true }));
    expect(d.respond).toBe(true);
  });

  test("group without mention captures but does not respond", () => {
    const d = gate(msg({ chatType: "group", mentionsBot: false }));
    expect(d.respond).toBe(false);
    expect(d.capture).toBe(true);
  });

  test("group with mentionsOnly=false responds to every message", () => {
    const d = gate(msg({ chatType: "group", mentionsBot: false }), { mentionsOnly: false });
    expect(d.respond).toBe(true);
    expect(d.capture).toBe(true);
  });

  test("mentionsOnly=false has no effect once already mentioned", () => {
    const d = gate(msg({ chatType: "group", mentionsBot: true }), { mentionsOnly: false });
    expect(d.respond).toBe(true);
  });
});

describe("chitchat prefilter", () => {
  test("greetings are prefiltered", () => {
    expect(prefilterChitchat("在吗")).toBe(true);
    expect(prefilterChitchat("你好！")).toBe(true);
    expect(prefilterChitchat("谢谢")).toBe(true);
    expect(prefilterChitchat("ok")).toBe(true);
  });

  test("substantive messages are not prefiltered", () => {
    expect(prefilterChitchat("谁负责后端服务？")).toBe(false);
    expect(prefilterChitchat("记住：发布流程是先灰度再全量")).toBe(false);
    expect(prefilterChitchat("分析")).toBe(false);
    expect(prefilterChitchat("总结")).toBe(false);
  });
});

describe("conversation interpretation", () => {
  test("recognizes stable question forms without treating nearby statements as questions", () => {
    for (const text of [
      "谁负责后端",
      "小贝儿是谁",
      "张洺汐在哪里",
      "这个词什么意思",
      "怎么处理",
      "有没有安排",
      "你记得小贝儿吗",
      "What is HomeAgent",
    ]) {
      expect(prefilterQuestion(text)).toBe(true);
    }
    for (const text of [
      "小贝儿就是说的张洺汐",
      "记录谁负责后端很重要",
      "几何学是数学的一个分支",
      "重新提炼本空间知识",
      "在么",
    ]) {
      expect(prefilterQuestion(text)).toBe(false);
    }
  });

  test("normalizes leading mentions before interpreting the conversation", () => {
    expect(normalizeConversationText("@agent @小助手 分析下这个晚餐")).toBe("分析下这个晚餐");
  });

  test("defaults fuzzy requests and ordinary statements to conversation", () => {
    for (const text of [
      "@agent 分析下这个晚餐的用心程度",
      "帮我看看这个",
      "发布流程先灰度再全量",
      "这个感觉不太对",
    ]) {
      expect(interpretConversation(text).disposition).toBe("conversation");
    }
  });

  test("only explicit memory language is acknowledged without another model turn", () => {
    expect(interpretConversation("记住：发布流程先灰度再全量").disposition).toBe("remember");
    expect(interpretConversation("记住这个发布流程").disposition).toBe("remember");
    expect(interpretConversation("@agent 张洺汐是男的，2018年生的，记住").disposition).toBe("remember");
    expect(interpretConversation("你还记得发布流程吗").disposition).toBe("conversation");
    expect(interpretConversation("记住了吗？").disposition).toBe("conversation");
  });

  test("parses narrow knowledge controls without hijacking related questions", () => {
    expect(parseKnowledgeControl("重新提炼")).toBe("redistill");
    expect(parseKnowledgeControl("@agent 帮我重新提炼一下知识")).toBe("redistill");
    expect(parseKnowledgeControl("重新整理本空间知识")).toBe("redistill");
    expect(parseKnowledgeControl("/dream")).toBe("redistill");
    expect(parseKnowledgeControl("重新提炼有什么影响？")).toBeNull();
    expect(parseKnowledgeControl("分析一下知识提炼结果")).toBeNull();
  });
});

describe("formatAnswer (Q1)", () => {
  test("knowledge answer lists citations", () => {
    const res: AskResult = {
      answer: "后端由 Alice 负责。",
      source: "knowledge",
      citations: [{ slug: "entities/alice", title: "Alice" }],
    };
    const md = formatAnswer(res);
    expect(md).toContain("Alice");
    expect(md).toContain("依据");
    expect(md).toContain("[[entities/alice|Alice]]");
  });

  test("ambiguous citations show a safe scope label without exposing Space ids", () => {
    const res: AskResult = {
      answer: "请查看 Alice。",
      source: "knowledge",
      citations: [{
        slug: "entities/alice",
        title: "Alice",
        space: "personal/ou_secret_identity",
      }],
    };

    const md = formatAnswer(res);
    expect(md).toContain("[[entities/alice|Alice（个人空间）]]");
    expect(md).not.toContain("ou_secret_identity");
  });

  test("general answer has no citation footer", () => {
    const res: AskResult = { answer: "通用回答。", source: "general", citations: [] };
    expect(formatAnswer(res)).toBe("通用回答。");
  });

  test("Agent-workdir answers do not claim that their workspace evidence is missing", () => {
    const res: AskResult = {
      answer: "后端由 Alice 负责。",
      source: "general",
      context: "agent-workdir",
      citations: [],
      gaps: ["知识库中暂无相关记录"],
    };

    expect(formatAnswer(res)).toBe("后端由 Alice 负责。");
  });

  test("gaps are surfaced", () => {
    const res: AskResult = {
      answer: "部分回答。",
      source: "knowledge",
      citations: [{ slug: "a", title: "A" }],
      gaps: ["缺少上线时间"],
    };
    expect(formatAnswer(res)).toContain("尚缺");
  });
});

describe("formatAnswer Agent Skill warnings", () => {
  test("adds one bounded warning without hiding the answer", () => {
    const res: AskResult = {
      answer: "基础回答。",
      source: "general",
      citations: [],
      skillWarnings: [{
        name: "review",
        code: "missing_source",
        message: "Skill 当前不可用，已跳过",
      }],
    };

    const formatted = formatAnswer(res);

    expect(formatted).toContain("基础回答。");
    expect(formatted).toContain("review");
    expect(formatted).toContain("基础 Agent 已继续执行");
  });
});
