import { describe, expect, test } from "bun:test";
import { planRawQuery } from "./raw-query.ts";

const now = Date.parse("2026-10-20T12:30:00+08:00");
describe("Raw query planning", () => {
  test("plans natural last-week author queries without keeping instruction words as keywords", () => {
    const plan = planRawQuery("在知识库找一下上周小王说过的发布结论", now);
    expect(plan.query).toBe("发布结论");
    expect(plan.filters).toEqual({ author: "小王", from: Date.parse("2026-10-12T00:00:00+08:00"), to: Date.parse("2026-10-19T00:00:00+08:00") });
  });
  test("keeps the author when the time expression is between name and speech", () => {
    expect(planRawQuery("查询知识库小王在上周说过的发布结论原文", now).filters.author).toBe("小王");
  });
  test.each([
    ["今天", "2026-10-20", "2026-10-21"], ["昨天", "2026-10-19", "2026-10-20"], ["前天", "2026-10-18", "2026-10-19"],
    ["本周", "2026-10-19", "2026-10-26"], ["本月", "2026-10-01", "2026-11-01"], ["上个月", "2026-09-01", "2026-10-01"],
  ])("uses Shanghai calendar boundaries for %s", (period, from, to) => {
    const plan = planRawQuery(`查询知识库${period}的原文，关键词：发布结论`, now);
    expect(plan.filters.from).toBe(Date.parse(`${from}T00:00:00+08:00`));
    expect(plan.filters.to).toBe(Date.parse(`${to}T00:00:00+08:00`));
    expect(plan.query).toBe("发布结论");
  });
  test.each(["最近十四天", "过去两周", "最近14天"])("uses rolling ranges for %s", period => {
    const plan = planRawQuery(`查询知识库${period}的原文，发布结论`, now);
    expect(plan.filters).toEqual({ from: now - 14 * 86400_000, to: now + 1 });
  });
  test("clamps rolling months at leap-year month ends", () => {
    const plan = planRawQuery("查询知识库最近一个月的发布原文", Date.parse("2024-03-31T12:30:00+08:00"));
    expect(plan.filters.from).toBe(Date.parse("2024-02-29T12:30:00+08:00"));
  });
  test("keeps quoted topic dates separate from explicit time and source filters", () => {
    const plan = planRawQuery('查询已入库原文，时间：2026年10月1日至2026年10月7日，作者：ou_one，来源群：「PST 专项」，文件名："发布 说明.md"，关键词：「到达2026-01-01」', now);
    expect(plan.query).toBe("到达2026-01-01");
    expect(plan.filters).toEqual({ from: Date.parse("2026-10-01T00:00:00+08:00"), to: Date.parse("2026-10-08T00:00:00+08:00"), author: "ou_one", chatName: "PST 专项", fileName: "发布 说明.md" });
  });
  test("does not infer an author from instructions or a generic pronoun", () => {
    expect(planRawQuery("查询知识库原文「发布结论」，查不到请明确说明", now).filters.author).toBeUndefined();
    expect(planRawQuery("在知识库找一下大家说过的发布结论", now).filters.author).toBeUndefined();
    expect(planRawQuery("在知识库找一下我说过的发布结论", now).query).toBe("发布结论");
  });
  test("retains phrases containing date connector characters", () => {
    expect(planRawQuery("查询知识库原文，2026-10-01 至 2026-10-07，关键词：到达情况", now).query).toBe("到达情况");
  });
  test("treats explicit keywords as content even when they contain request words or dates", () => {
    const plan = planRawQuery("查询知识库已入库原文，关键词：查询优化记录仪 2026-10-01", now);
    expect(plan.query).toBe("查询优化记录仪 2026-10-01");
    expect(plan.filters).toEqual({});
  });
  test("does not consume filter-looking text or duplicate date strings inside a quoted title", () => {
    const plan = planRawQuery('查询知识库原文「作者：小王 2026-10-01 上周发布记录」，时间：2026-10-01', now);
    expect(plan.query).toBe("作者：小王 2026-10-01 上周发布记录");
    expect(plan.filters).toEqual({ from: Date.parse("2026-10-01T00:00:00+08:00"), to: Date.parse("2026-10-02T00:00:00+08:00") });
    const relative = planRawQuery('查询知识库原文「上周发布结论」，上周小王说过的', now);
    expect(relative.query).toBe("上周发布结论");
    expect(relative.filters.author).toBe("小王");
  });
  test("supports source types and since-date queries", () => {
    const plan = planRawQuery("查询已入库原文，2026-10-01以来，来源类型：任务，关键词：发布", now);
    expect(plan.filters).toEqual({ source: "task", from: Date.parse("2026-10-01T00:00:00+08:00"), to: now + 1 });
  });
  test("rejects invalid dates and reversed ranges rather than querying an unintended period", () => {
    expect(() => planRawQuery("查询知识库2026-02-30的原文", now)).toThrow("日期无效");
    expect(() => planRawQuery("查询知识库2026-10-20至2026-10-01的原文", now)).toThrow("时间范围无效");
  });
});
