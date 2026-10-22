import { expect, test } from "bun:test";
import { rawExcerpt } from "./raw-excerpts.ts";

test("Raw excerpts retain distant matches and a bounded original context around each", () => {
  const body = `发布结论：首轮检查。${"背景。".repeat(10_000)}最终确认：已通过双人复核。`;
  const excerpt = rawExcerpt(body, "发布结论 最终确认", ["发布结论", "最终确认"], 6000);
  expect(excerpt.content.includes("发布结论：首轮检查。")).toBeTrue();
  expect(excerpt.content.includes("最终确认：已通过双人复核。")).toBeTrue();
  expect(excerpt.content.length).toBeLessThanOrEqual(6000);
  expect(excerpt.fragments.every(fragment => body.includes(fragment))).toBeTrue();
  expect(excerpt.fragments).toHaveLength(2);
  expect(excerpt.truncated).toBeTrue();
});

test("Raw match offsets stay correct when Unicode lowercasing changes string length", () => {
  const body = `${"İ".repeat(5000)}${"背景。".repeat(4000)}发布结论：尾部事实。`;
  const excerpt = rawExcerpt(body, "发布结论", ["发布结论"], 6000);
  expect(excerpt.content.includes("发布结论：尾部事实。")).toBeTrue();
  expect(excerpt.fragments.every(fragment => body.includes(fragment))).toBeTrue();
});

test("Raw excerpt boundaries preserve Unicode characters and include all matches when short", () => {
  const body = `${"😀".repeat(6000)}发布结论${"😀".repeat(6000)}`;
  const excerpt = rawExcerpt(body, "发布结论", ["发布结论"], 5999);
  expect(excerpt.content.includes("发布结论")).toBeTrue();
  expect(excerpt.content.isWellFormed()).toBeTrue();
  expect(excerpt.content.length).toBeLessThanOrEqual(5999);
  expect(rawExcerpt("短原文", "原文", ["原文"], 6000)).toEqual({ content: "短原文", fragments: ["短原文"], truncated: false });
});

test("Raw excerpts do not drop a middle match when the same keyword appears at both ends", () => {
  const body = `发布结论：开头。${"背景。".repeat(5000)}发布结论：中间的实际验收结果。${"背景。".repeat(5000)}发布结论：末尾。`;
  const excerpt = rawExcerpt(body, "发布结论", ["发布结论"], 12_000);
  expect(excerpt.content.includes("中间的实际验收结果")).toBeTrue();
  expect(excerpt.content.length).toBeLessThanOrEqual(12_000);
});
