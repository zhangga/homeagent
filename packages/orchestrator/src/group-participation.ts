import type { GroupParticipationLevel, LlmClient } from "@homeagent/core";
import { AI_ROUTING_MAX_TOKENS, config, logger } from "@homeagent/shared";
import { prefilterQuestion } from "./conversation-interpreter.ts";

const log = logger.child("group-participation");

export interface GroupParticipationDecision {
  respond: boolean;
  reason: string;
  source: "model" | "guard" | "fallback";
  participationScore: number;
  disruptionRisk: number;
}

export type GroupParticipationClientResolver = () => LlmClient;

const PARTICIPATION_POLICIES = {
  reserved: { minimumScore: 85, maximumRisk: 25 },
  balanced: { minimumScore: 60, maximumRisk: 50 },
  active: { minimumScore: 35, maximumRisk: 70 },
} as const satisfies Record<
  GroupParticipationLevel,
  { minimumScore: number; maximumRisk: number }
>;

const PARTICIPATION_SCHEMA = {
  type: "object",
  properties: {
    participationScore: {
      type: "integer",
      minimum: 0,
      maximum: 100,
      description: "how valuable it would be for the assistant to participate now",
    },
    disruptionRisk: {
      type: "integer",
      minimum: 0,
      maximum: 100,
      description: "how likely an unsolicited assistant reply is to interrupt or annoy the group",
    },
    reason: { type: "string", description: "a brief reason for the scores" },
  },
  required: ["participationScore", "disruptionRisk", "reason"],
} as const;

function score(value: unknown, field: string): number {
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > 100) {
    throw new Error(`group participation decision has invalid ${field}`);
  }
  return Number(value);
}

function validate(raw: unknown): {
  participationScore: number;
  disruptionRisk: number;
  reason: string;
} {
  const value = raw as Record<string, unknown>;
  return {
    participationScore: score(value?.participationScore, "participationScore"),
    disruptionRisk: score(value?.disruptionRisk, "disruptionRisk"),
    reason: typeof value.reason === "string" ? value.reason.trim() : "",
  };
}

function addressedToAnotherMember(text: string): boolean {
  return /^@\S+\s+/u.test(text.trim());
}

export async function decideGroupParticipation(
  resolveClient: GroupParticipationClientResolver,
  text: string,
  level: GroupParticipationLevel,
): Promise<GroupParticipationDecision> {
  if (addressedToAnotherMember(text)) {
    return {
      respond: false,
      reason: "消息明确 @ 了其他群成员",
      source: "guard",
      participationScore: 0,
      disruptionRisk: 100,
    };
  }

  const policy = PARTICIPATION_POLICIES[level];

  try {
    const client = resolveClient();
    const { value } = await client.completeJSON({
      model: config().modelFast,
      system: [
        "你负责判断一个没有 @ 机器人的群聊消息，机器人是否应该主动参与。",
        "分别给出参与价值 participationScore 和打扰风险 disruptionRisk，范围都是 0 到 100。",
        "参与价值参考：明确的群体提问或求助通常为 90-100；有价值的建议请求、问题讨论或重要补充为 60-89；可选观点、风险提示或澄清为 35-59；普通聊天为 0-34。",
        "明确提问、求建议、需要解释或解决问题通常参与价值高；有帮助的风险提示、事实补充或澄清也可以有中等价值。",
        "普通闲聊、感叹、抱怨、自言自语、反问、引用问题、私人对话及需要明确叫机器人执行的管理命令，参与价值应低或打扰风险应高。",
        "评分应独立于机器人当前活跃度，拿不准时提高打扰风险。",
      ].join("\n"),
      prompt: `判断下面这条群消息是否值得机器人主动回答：\n"""\n${text.trim()}\n"""`,
      schema: PARTICIPATION_SCHEMA as unknown as Record<string, unknown>,
      validate,
      maxTokens: AI_ROUTING_MAX_TOKENS,
      purpose: "classify",
    });
    const respond =
      value.participationScore >= policy.minimumScore
      && value.disruptionRisk <= policy.maximumRisk;
    return {
      respond,
      reason: value.reason,
      source: "model",
      participationScore: value.participationScore,
      disruptionRisk: value.disruptionRisk,
    };
  } catch (err) {
    const respond = prefilterQuestion(text);
    log.warn("group participation classification failed; using deterministic fallback", {
      respond,
      err: String(err),
    });
    return {
      respond,
      reason: respond ? "明显疑问句的本地回退" : "无法可靠判断为群体提问",
      source: "fallback",
      participationScore: respond ? 100 : 0,
      disruptionRisk: respond ? 0 : 100,
    };
  }
}
