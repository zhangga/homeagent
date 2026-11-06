import { expect, test } from "bun:test";
import { isWorkPlanningCandidate, isWorkReplanningCandidate, parseChatWorkPlan } from "./work-planning.ts";

test("explicit amendments include progress content without treating advice or status as work", () => {
  for (const text of ["汇总进度时增加风险", "摘要增加解释阻塞原因", "谢谢，周报改成100字以内", "第一步改成按部门分组"]) {
    expect(isWorkReplanningCandidate(text)).toBe(true);
  }
  for (const text of ["当前进度如何？", "谢谢", "为什么增加成本比较？", "修改方案只要建议，不要执行", "限制100字是什么意思？"]) {
    expect(isWorkReplanningCandidate(text)).toBe(false);
  }
});

test("multi-step execution goals are candidates while advice stays conversational", () => {
  expect(isWorkPlanningCandidate("整理本周项目进展，找出阻塞项，生成周报")).toBe(true);
  expect(isWorkPlanningCandidate("修复登录问题并验证测试")).toBe(true);
  expect(isWorkPlanningCandidate("如何整理项目并生成周报？")).toBe(false);
  expect(isWorkPlanningCandidate("分析项目并生成报告，先给方案，不要执行")).toBe(false);
  expect(isWorkPlanningCandidate("你好")).toBe(false);
  expect(isWorkPlanningCandidate("分析独立接口检查")).toBe(false);
  expect(isWorkPlanningCandidate("研究实现方案")).toBe(false);
});

test("the planner must supply bounded executable steps with verifiable completion criteria", () => {
  for (const invalid of [null, { kind: "plan", steps: [] }, { kind: "plan", steps: [{ instruction: "收集资料", doneWhen: " " }] },
    { kind: "plan", steps: [{ instruction: "x".repeat(1900), doneWhen: "检查" }] },
    { kind: "plan", steps: Array.from({ length: 201 }, () => ({ instruction: "检查", doneWhen: "完成" })) }]) {
    expect(() => parseChatWorkPlan(invalid)).toThrow();
  }
  expect(parseChatWorkPlan({ kind: "answer", steps: [] })).toEqual({ kind: "answer", steps: [] });
  expect(parseChatWorkPlan({ kind: "plan", steps: Array.from({ length: 200 }, () => ({ instruction: "检查", doneWhen: "完成" })) }).steps).toHaveLength(200);
});
