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

test("parallel plan parsing bounds the whole graph and keeps delegation and dependency references", () => {
  const step = { instruction: "调研", doneWhen: "注明来源", agentId: "agent_worker" };
  const child = { key: "a", title: "调研A", goal: "有来源的研究", steps: [step] };
  const plan = { kind: "plan" as const, steps: [{ instruction: "汇总", doneWhen: "引用A", dependsOn: ["a"] }], children: [child] };
  expect(parseChatWorkPlan(plan)).toEqual(plan);
  for (const invalid of [ { ...plan, children: [child, child] }, { ...plan, children: [{ ...child, children: [] }] },
    { ...plan, children: [{ ...child, key: "x".repeat(101) }] }, { ...plan, children: [{ ...child, title: "x".repeat(201) }] },
    { ...plan, children: [{ ...child, goal: "x".repeat(200_001) }] }, { ...plan, children: [{ ...child, steps: Array(200).fill(step) }] },
    { ...plan, steps: [{ ...step, dependsOn: Array(201).fill("a") }] }, { ...plan, steps: [{ ...step, agentId: "../invalid" }] },
  ]) expect(() => parseChatWorkPlan(invalid)).toThrow();
});

test("Codex nullable optional fields preserve default workers and independent child steps", () => {
  const base = { instruction: "核算", doneWhen: "总数正确" };
  const nullable = { ...base, agentId: null, dependsOn: null };
  expect(parseChatWorkPlan({ kind: "plan", steps: [nullable], children: null })).toEqual({ kind: "plan", steps: [base] });
  expect(parseChatWorkPlan({ kind: "plan", steps: [{ ...nullable, agentId: "agent_writer", dependsOn: ["a"] }],
    children: [{ key: "a", title: "核算A", goal: "核对数据", steps: [nullable] }] })).toEqual({ kind: "plan",
    steps: [{ ...base, agentId: "agent_writer", dependsOn: ["a"] }],
    children: [{ key: "a", title: "核算A", goal: "核对数据", steps: [base] }] });
  for (const step of [{ ...nullable, agentId: false }, { ...nullable, dependsOn: [null] }]) {
    expect(() => parseChatWorkPlan({ kind: "plan", steps: [step], children: null })).toThrow();
  }
});
