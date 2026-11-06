import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkEventStore, parseWorkRecoveryDecision, workEventId, type WorkNotice, type WorkRecovery } from "./work-events.ts";

const itemId = "work_00000000-0000-0000-0000-000000000001";
const sourceId = `input_${"0".repeat(64)}`;
const notice: WorkNotice = { version: 1, id: workEventId("notice", [itemId, 1, "completion"]), workItemId: itemId,
  space: "team/test", sourceInputId: sourceId, kind: "completion", status: "pending", markdown: "全部完成", attempts: 0, createdAt: 1 };

test("recovery decisions normalize Codex optional nulls without accepting malformed delegation", () => {
  const step = { instruction: "使用备用数据", doneWhen: "总数正确" };
  expect(parseWorkRecoveryDecision({ kind: "plan", reason: "原文件缺失", question: null,
    steps: [{ ...step, agentId: null, dependsOn: null }, { ...step, agentId: "agent_writer", dependsOn: [itemId] }] })).toEqual({
    kind: "plan", reason: "原文件缺失", steps: [step, { ...step, agentId: "agent_writer", dependsOn: [itemId] }],
  });
  for (const invalid of [{ ...step, agentId: 123 }, { ...step, dependsOn: [null] }]) {
    expect(() => parseWorkRecoveryDecision({ kind: "plan", reason: "重新规划", steps: [invalid] })).toThrow();
  }
});

function recovery(): WorkRecovery {
  const id = workEventId("recovery", [itemId, "action_test", 1]);
  return { version: 1, kind: "recovery", id, workItemId: itemId, space: "team/test", sourceInputId: sourceId,
    actionId: "action_test", attempt: 1, runId: "run_test", factKey: "1".repeat(64),
    report: { version: 1, outcome: "blocked", result: "缺资料", blockers: ["缺资料"], checks: [{ name: "资料", status: "failed" }] },
    prepared: { workItemId: itemId, space: "team/test", fingerprint: "2".repeat(64), source: { kind: "recovery", id, actionId: "action_test" },
      current: { revision: 1, digest: "3".repeat(64) }, goal: "整理资料", remaining: [
        { id: `step_${"0".repeat(32)}`, instruction: "读取资料", doneWhen: "取得真实数据" }], accepted: [] },
    planner: { execution: { version: 2, provider: "codex", model: "frozen-model", instruction: "冻结指令" },
      instruction: "规划但不执行", timeoutMs: 7_200_000, maxTokens: 32_000 }, status: "queued", createdAt: 1 };
}

test("work notices commit atomically, clone callers and preserve the prior receipt after persistence failure", () => {
  const root = mkdtempSync(join(tmpdir(), "ha-work-events-"));
  try {
    const store = new WorkEventStore(root), input = structuredClone(notice);
    store.save(input); input.markdown = "changed";
    const read = store.get(notice.id)!; read.status = "sent";
    expect(new WorkEventStore(root).get(notice.id)?.markdown).toBe("全部完成");
    const path = join(root, "config", "work-events", `${notice.id}.json`);
    renameSync(path, `${path}.saved`); mkdirSync(path);
    expect(() => store.save({ ...notice, status: "sent", sentAt: 2 })).toThrow();
    expect(store.get(notice.id)?.status).toBe("pending");
    rmdirSync(path); renameSync(`${path}.saved`, path);
    expect(new WorkEventStore(root).get(notice.id)?.status).toBe("pending");
    expect(() => store.save({ ...notice, space: "team/other" })).toThrow("ownership");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("queued recoveries retain frozen input; interrupted planners fail closed; saved decisions survive restart", () => {
  const root = mkdtempSync(join(tmpdir(), "ha-recovery-state-"));
  try {
    const store = new WorkEventStore(root), input = recovery();
    store.saveRecovery(input); input.planner.execution.model = "changed";
    const queued = new WorkEventStore(root).getRecovery(input.id)!;
    expect(queued.status).toBe("queued");
    expect(queued.planner.execution.model).toBe("frozen-model");
    expect(() => store.saveRecovery(input)).toThrow("input changed");
    store.saveRecovery({ ...queued, status: "running" });
    expect(new WorkEventStore(root).getRecovery(input.id)?.status).toBe("failed");
    store.saveRecovery({ ...queued, status: "decided", decision: { kind: "wait", reason: "缺资料", question: "资料在哪？" } });
    const restarted = new WorkEventStore(root);
    expect(restarted.getRecovery(input.id)?.decision).toEqual({ kind: "wait", reason: "缺资料", question: "资料在哪？" });
    const changed = restarted.getRecovery(input.id)!;
    changed.prepared.goal = "changed";
    expect(restarted.getRecovery(input.id)?.prepared.goal).toBe("整理资料");
    expect(() => restarted.saveRecovery({ ...restarted.getRecovery(input.id)!, decision: { kind: "wait", reason: "changed", question: "changed" } })).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("work event parsers reject oversized data, invalid provenance, and unknown fields", () => {
  const root = mkdtempSync(join(tmpdir(), "ha-recovery-validation-"));
  try {
    const store = new WorkEventStore(root), input = recovery();
    store.saveRecovery(input);
    const path = join(root, "config", "work-events", `${input.id}.json`);
    const invalid: unknown[] = [
      { ...input, version: 3 }, { ...input, space: "bad space" }, { ...input, actionId: "x".repeat(201) },
      { ...input, attempt: 0 }, { ...input, sourceInputId: "../escape" }, { ...input, factKey: "bad" },
      { ...input, rejection: "x".repeat(2001) }, { ...input, extra: "unbounded" },
      { ...input, prepared: { ...input.prepared, remaining: Array(201).fill(input.prepared.remaining[0]) } },
      { ...input, prepared: { ...input.prepared, goal: "x".repeat(200001) } },
      { ...input, prepared: { ...input.prepared, accepted: Array(2001).fill({ actionId: "x", instruction: "x", result: "x" }) } },
      { ...input, prepared: { ...input.prepared, source: { ...input.prepared.source, actionId: "other" } } },
      { ...input, planner: { ...input.planner, instruction: "x".repeat(20001) } },
      { ...input, planner: { ...input.planner, timeoutMs: 0 } },
      { ...input, planner: { ...input.planner, execution: { ...input.planner.execution, execution: { permission: "read-only", skills: [] } } } },
      { ...input, status: "decided" },
    ];
    for (const value of invalid) { writeFileSync(path, JSON.stringify(value)); expect(() => new WorkEventStore(root)).toThrow(); }
    expect(() => store.save({ ...notice, markdown: "x".repeat(200001) })).toThrow();
    expect(() => store.save({ ...notice, messageId: "x".repeat(513) })).toThrow();
    for (const decision of [ { kind: "wait", reason: "x", question: "x".repeat(2001) },
      { kind: "plan", reason: "x", steps: [] }, { kind: "plan", reason: "x", steps: Array(201).fill({ instruction: "x", doneWhen: "x" }) },
      { kind: "plan", reason: "x", steps: [{ instruction: "x".repeat(1900), doneWhen: "x" }] },
    ]) expect(() => parseWorkRecoveryDecision(decision)).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
