import { expect, test } from "bun:test";
import { formatAnswer, withReplyModel } from "./format.ts";
import type { AskResult } from "@homeagent/shared";

test("only surfaces catalog warnings for Skills named in the current request", () => {
  const result: AskResult = {
    answer: "已完成。", source: "general", citations: [],
    skillWarnings: [
      { name: "baoyu-post-to-wechat", code: "invalid_skill", message: "Skill 包体积超过加载上限，已跳过" },
      { name: "review", code: "missing_source", message: "Skill 当前不可用，已跳过" },
    ],
  };
  for (const question of ["测试会话", "现在使用的模型是什么", "请使用 baoyu-post-to-wechat-extra", "preview"]) {
    expect(formatAnswer(result, question)).toBe("已完成。");
  }
  for (const question of ["请使用 baoyu-post-to-wechat 发布文章", "$baoyu-post-to-wechat", "使用BAOYU-POST-TO-WECHAT。", "使用`baoyu-post-to-wechat`发布"]) {
    const reply = formatAnswer(result, question);
    expect(reply).toContain("已完成。");
    expect(reply).toContain("baoyu-post-to-wechat：Skill 包体积超过加载上限");
    expect(reply).not.toContain("review：");
  }
  expect(result.skillWarnings).toHaveLength(2);
});

test("reply model caption distinguishes reported models, frozen configuration, and unknown defaults", () => {
  expect(withReplyModel("回答", { provider: "claude", model: "sonnet" }, "claude-sonnet-4-6"))
    .toBe("> 本次模型：Claude Code · `claude-sonnet-4-6`（Provider 返回）\n\n回答");
  expect(withReplyModel("回答", { provider: "codex", model: "gpt-5.6-sol" }))
    .toBe("> 本次模型：Codex · `gpt-5.6-sol`（本次运行配置）\n\n回答");
  expect(withReplyModel("回答", { provider: "codex" }))
    .toBe("> 本次模型：Codex · CLI 默认（未返回具体型号）\n\n回答");
});

test("model metadata stays bounded and cannot inject reply markup", () => {
  for (const model of ["x".repeat(201), "line\nbreak", "[fake](url)", "model`", "诊断正文"]) {
    expect(withReplyModel("原回答", { provider: "codex", model: "gpt-5.6-sol" }, model))
      .toBe("> 本次模型：Codex · `gpt-5.6-sol`（本次运行配置）\n\n原回答");
  }
  expect(withReplyModel("原回答", { provider: "codex" }, "m".repeat(200))).toContain(`\`${"m".repeat(200)}\``);
});
