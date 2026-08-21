import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpaceId } from "@homeagent/shared";
import {
  isWorkAction,
  MAX_WORK_ACTION_RUNS,
  WorkContinuationStore,
} from "./work-continuation.ts";
import { WorkItemStore } from "./work-items.ts";

const SPACE: SpaceId = "team/continuation";
const NOW = new Date("2026-08-19T09:00:00+08:00").getTime();

describe("WorkContinuationStore", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "homeagent-work-continuation-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("durably claims the first next action of a work item", () => {
    const items = new WorkItemStore(dir);
    const item = items.create({
      space: SPACE,
      title: "完成灰度发布",
      nextActions: ["执行只读发布前检查", "生成灰度报告"],
    }, NOW);
    const continuation = new WorkContinuationStore(dir);

    const action = continuation.claimNext(item, NOW + 1);

    expect(action).toEqual(expect.objectContaining({
      workItemId: item.id,
      space: SPACE,
      instruction: "执行只读发布前检查",
      status: "queued",
      attempt: 1,
    }));
    expect(new WorkContinuationStore(dir).activeForWorkItem(item.id)).toEqual(action);
  });

  test("cannot record a checkpoint before a successful run is submitted for acceptance", () => {
    const items = new WorkItemStore(dir);
    const item = items.create({
      space: SPACE,
      title: "完成灰度发布",
      nextActions: ["执行只读发布前检查"],
    }, NOW);
    const continuation = new WorkContinuationStore(dir);
    const action = continuation.claimNext(item, NOW + 1);

    continuation.attachRun(action.id, "run_first", "queued", NOW + 2);
    continuation.markRunning(action.id, "run_first", NOW + 3);
    expect(continuation.get(action.id)?.checkpoint).toBeUndefined();

    expect(() => continuation.accept(action.id, {
      runId: "run_first",
      decidedAt: NOW + 4,
      decidedBy: "local-admin",
      mode: "human",
    })).toThrow("not the current work action acceptance candidate");

    expect(continuation.get(action.id)?.checkpoint).toBeUndefined();
    expect(continuation.activeForWorkItem(item.id)?.id).toBe(action.id);
  });

  test("submits a successful run for acceptance without recording a checkpoint", () => {
    const items = new WorkItemStore(dir);
    const item = items.create({
      space: SPACE,
      title: "完成灰度发布",
      nextActions: ["执行只读发布前检查"],
    }, NOW);
    const continuation = new WorkContinuationStore(dir);
    const action = continuation.claimNext(item, NOW + 1);
    continuation.attachRun(action.id, "run_candidate", "queued", NOW + 2);
    continuation.markRunning(action.id, "run_candidate", NOW + 3);

    const pending = continuation.submitForAcceptance(action.id, {
      runId: "run_candidate",
      permission: "write",
      summary: "检查执行完成，等待验收",
      rawId: "raw_candidate",
      finishedAt: NOW + 4,
    });

    expect(pending).toEqual(expect.objectContaining({
      status: "awaiting_acceptance",
      checkpoint: undefined,
      acceptances: [{
        taskRunId: "run_candidate",
        attempt: 1,
        permission: "write",
        status: "pending",
        requestedAt: NOW + 4,
        summary: "检查执行完成，等待验收",
        rawId: "raw_candidate",
        report: {
          version: 1,
          outcome: "unverified",
          result: "检查执行完成，等待验收",
          blockers: [],
          checks: [
            {
              name: "结构化执行报告",
              status: "failed",
              detail: "Provider 未返回可校验的 WorkAction JSON 报告，禁止自动验收",
            },
            { name: "Task Run 成功结束", status: "passed" },
            { name: "执行输出已归档", status: "passed" },
            { name: "执行输出未截断", status: "passed" },
          ],
          evidence: [
            { kind: "task_run", id: "run_candidate" },
            { kind: "raw", id: "raw_candidate" },
          ],
        },
      }],
    }));
    expect(continuation.activeForWorkItem(item.id)?.id).toBe(action.id);
    expect(new WorkContinuationStore(dir).get(action.id)).toEqual(pending);
  });

  test("rejects an invalid mutation before it can poison persisted state", () => {
    const items = new WorkItemStore(dir);
    const item = items.create({
      space: SPACE,
      title: "保护续作持久化",
      nextActions: ["执行发布前检查"],
    }, NOW);
    const continuation = new WorkContinuationStore(dir);
    const action = continuation.claimNext(item, NOW + 1);
    continuation.attachRun(action.id, "run_first", "queued", NOW + 2);
    continuation.attachRun(action.id, "run_second", "queued", NOW + 3);
    const before = continuation.get(action.id);

    expect(() => continuation.submitForAcceptance(action.id, {
      runId: "run_first",
      permission: "read-only",
      summary: "旧运行不应覆盖当前尝试",
      rawId: "raw_first",
      finishedAt: NOW + 4,
    })).toThrow("work action mutation produced invalid state");

    expect(continuation.get(action.id)).toEqual(before);
    const restarted = new WorkContinuationStore(dir);
    expect(restarted.get(action.id)).toEqual(before);
    expect(() => restarted.exportBySpace(SPACE)).not.toThrow();
  });

  test("reconciles historical runs in stable order without reopening a blocked action", () => {
    const items = new WorkItemStore(dir);
    const item = items.create({
      space: SPACE,
      title: "repair continuation history",
      nextActions: ["retry the durable action"],
    }, NOW);
    const continuation = new WorkContinuationStore(dir);
    const action = continuation.claimNext(item, NOW + 1);
    continuation.attachRun(action.id, "run_first", "queued", NOW + 2);
    const blocked = continuation.failClosed(action.id, "association repair required", NOW + 3);

    const reconciled = continuation.reconcileRunHistory(
      action.id,
      ["run_first", "run_second"],
      NOW + 4,
    );

    expect(reconciled).toEqual(expect.objectContaining({
      status: "blocked",
      error: blocked.error,
      attempt: 2,
      taskRunIds: ["run_first", "run_second"],
      updatedAt: blocked.updatedAt,
    }));
    expect(new WorkContinuationStore(dir).get(action.id)).toEqual(reconciled);
    expect(() => continuation.reconcileRunHistory(
      action.id,
      ["run_second", "run_first"],
      NOW + 5,
    )).toThrow("cannot reorder or insert");
  });

  test("records the checkpoint only after accepting the current run", () => {
    const items = new WorkItemStore(dir);
    const item = items.create({
      space: SPACE,
      title: "完成灰度发布",
      nextActions: ["执行只读发布前检查"],
    }, NOW);
    const continuation = new WorkContinuationStore(dir);
    const action = continuation.claimNext(item, NOW + 1);
    continuation.attachRun(action.id, "run_candidate", "queued", NOW + 2);
    continuation.markRunning(action.id, "run_candidate", NOW + 3);
    continuation.submitForAcceptance(action.id, {
      runId: "run_candidate",
      permission: "write",
      summary: "检查全部通过",
      rawId: "raw_candidate",
      finishedAt: NOW + 4,
    });

    const accepted = continuation.accept(action.id, {
      runId: "run_candidate",
      decidedAt: NOW + 5,
      decidedBy: "local-admin",
      mode: "human",
    });

    expect(accepted).toEqual(expect.objectContaining({
      status: "succeeded",
      checkpoint: {
        completedAt: NOW + 5,
        summary: "检查全部通过",
        rawId: "raw_candidate",
        taskRunId: "run_candidate",
      },
      acceptances: [expect.objectContaining({
        taskRunId: "run_candidate",
        status: "accepted",
        decidedAt: NOW + 5,
        decidedBy: "local-admin",
        mode: "human",
      })],
    }));
    expect(continuation.accept(action.id, {
      runId: "run_candidate",
      decidedAt: NOW + 6,
      decidedBy: "local-admin",
      mode: "human",
    })).toEqual(accepted);
    expect(continuation.activeForWorkItem(item.id)).toBeUndefined();
    expect(new WorkContinuationStore(dir).get(action.id)).toEqual(accepted);
  });

  test("store-level automatic acceptance cannot bypass writable-result review", () => {
    const items = new WorkItemStore(dir);
    const item = items.create({
      space: SPACE,
      title: "保护写入结果验收",
      nextActions: ["更新灰度配置"],
    }, NOW);
    const continuation = new WorkContinuationStore(dir);
    const action = continuation.claimNext(item, NOW + 1);
    continuation.attachRun(action.id, "run_write", "queued", NOW + 2);
    continuation.markRunning(action.id, "run_write", NOW + 3);
    continuation.submitForAcceptance(action.id, {
      runId: "run_write",
      permission: "write",
      summary: "写入已完成",
      rawId: "raw_write",
      finishedAt: NOW + 4,
    });

    expect(() => continuation.accept(action.id, {
      runId: "run_write",
      decidedAt: NOW + 5,
      decidedBy: "unsafe-caller",
      mode: "automatic",
    })).toThrow("automatic acceptance is unsafe");
    expect(continuation.get(action.id)).toEqual(expect.objectContaining({
      status: "awaiting_acceptance",
      checkpoint: undefined,
      acceptances: [expect.objectContaining({ status: "pending" })],
    }));
  });

  test("store-level human acceptance cannot consume a structured blocked result", () => {
    const items = new WorkItemStore(dir);
    const item = items.create({
      space: SPACE,
      title: "保留受阻动作边界",
      nextActions: ["执行发布前检查"],
    }, NOW);
    const continuation = new WorkContinuationStore(dir);
    const action = continuation.claimNext(item, NOW + 1);
    continuation.attachRun(action.id, "run_blocked", "queued", NOW + 2);
    continuation.markRunning(action.id, "run_blocked", NOW + 3);
    continuation.submitForAcceptance(action.id, {
      runId: "run_blocked",
      permission: "read-only",
      summary: "发布检查无法完成",
      rawId: "raw_blocked",
      finishedAt: NOW + 4,
      report: {
        version: 1,
        outcome: "blocked",
        result: "发布检查无法完成",
        blockers: ["缺少发布检查权限"],
        checks: [{ name: "发布权限", status: "failed" }],
      },
    });

    expect(() => continuation.accept(action.id, {
      runId: "run_blocked",
      decidedAt: NOW + 5,
      decidedBy: "local-admin",
      mode: "human",
    })).toThrow("blocked work action result cannot be accepted");
    expect(continuation.get(action.id)).toEqual(expect.objectContaining({
      status: "awaiting_acceptance",
      checkpoint: undefined,
      acceptances: [expect.objectContaining({ status: "pending" })],
    }));
  });

  test("rejects the current result without consuming the action boundary", () => {
    const items = new WorkItemStore(dir);
    const item = items.create({
      space: SPACE,
      title: "完成灰度发布",
      nextActions: ["执行发布前检查"],
    }, NOW);
    const continuation = new WorkContinuationStore(dir);
    const action = continuation.claimNext(item, NOW + 1);
    continuation.attachRun(action.id, "run_candidate", "queued", NOW + 2);
    continuation.markRunning(action.id, "run_candidate", NOW + 3);
    continuation.submitForAcceptance(action.id, {
      runId: "run_candidate",
      permission: "write",
      summary: "检查命令执行完成",
      rawId: "raw_candidate",
      finishedAt: NOW + 4,
    });

    const rejected = continuation.reject(action.id, {
      runId: "run_candidate",
      decidedAt: NOW + 5,
      decidedBy: "local-admin",
      mode: "human",
      reason: "缺少灰度环境的核对证据",
    });

    expect(rejected).toEqual(expect.objectContaining({
      status: "blocked",
      error: "缺少灰度环境的核对证据",
      checkpoint: undefined,
      acceptances: [expect.objectContaining({
        taskRunId: "run_candidate",
        status: "rejected",
        decidedAt: NOW + 5,
        decidedBy: "local-admin",
        mode: "human",
        reason: "缺少灰度环境的核对证据",
      })],
    }));
    expect(continuation.reject(action.id, {
      runId: "run_candidate",
      decidedAt: NOW + 6,
      decidedBy: "local-admin",
      mode: "human",
      reason: "缺少灰度环境的核对证据",
    })).toEqual(rejected);
    expect(continuation.activeForWorkItem(item.id)).toBeUndefined();
  });

  test("abandons a blocked action without erasing its rejection audit", () => {
    const items = new WorkItemStore(dir);
    const item = items.create({
      space: SPACE,
      title: "终止被驳回动作",
      nextActions: ["执行发布前检查"],
    }, NOW);
    const continuation = new WorkContinuationStore(dir);
    const action = continuation.claimNext(item, NOW + 1);
    continuation.attachRun(action.id, "run_rejected", "queued", NOW + 2);
    continuation.markRunning(action.id, "run_rejected", NOW + 3);
    continuation.submitForAcceptance(action.id, {
      runId: "run_rejected",
      permission: "write",
      summary: "变更执行完成",
      rawId: "raw_rejected",
      finishedAt: NOW + 4,
    });
    const rejected = continuation.reject(action.id, {
      runId: "run_rejected",
      decidedAt: NOW + 5,
      decidedBy: "local-admin",
      mode: "human",
      reason: "结果缺少核对证据",
    });

    const abandoned = continuation.abandon(action.id, NOW + 6);

    expect(abandoned).toEqual(expect.objectContaining({
      status: "cancelled",
      error: rejected.error,
      checkpoint: undefined,
      acceptances: rejected.acceptances,
      updatedAt: NOW + 6,
    }));
    expect(new WorkContinuationStore(dir).get(action.id)).toEqual(abandoned);
  });

  test("claims a fresh repeated instruction after a later action completes", () => {
    const items = new WorkItemStore(dir);
    const item = items.create({
      space: SPACE,
      title: "按顺序执行重复动作",
      nextActions: ["动作 X"],
    }, NOW);
    const continuation = new WorkContinuationStore(dir);
    const firstX = continuation.claimNext(item, NOW + 1);
    continuation.attachRun(firstX.id, "run_x_first", "queued", NOW + 2);
    continuation.block(firstX.id, "首次执行条件不足", {
      runId: "run_x_first",
      finishedAt: NOW + 3,
    });
    continuation.abandon(firstX.id, NOW + 4);

    const actionY = continuation.claimNext({
      ...item,
      nextActions: ["动作 Y"],
    }, NOW + 5);
    continuation.attachRun(actionY.id, "run_y", "queued", NOW + 6);
    continuation.markRunning(actionY.id, "run_y", NOW + 7);
    continuation.submitForAcceptance(actionY.id, {
      runId: "run_y",
      permission: "write",
      summary: "动作 Y 已完成",
      rawId: "raw_y",
      finishedAt: NOW + 8,
    });
    continuation.accept(actionY.id, {
      runId: "run_y",
      decidedAt: NOW + 9,
      decidedBy: "local-admin",
      mode: "human",
    });

    const repeatedX = continuation.claimNext({
      ...item,
      nextActions: ["动作 X"],
    }, NOW + 10);

    expect(repeatedX).toEqual(expect.objectContaining({
      instruction: "动作 X",
      status: "queued",
      attempt: 1,
      taskRunIds: [],
    }));
    expect(repeatedX.id).not.toBe(firstX.id);
    expect(continuation.list(item.id)).toHaveLength(3);
  });

  test("keeps automatic continuation opt-in across restart", () => {
    const items = new WorkItemStore(dir);
    const item = items.create({
      space: SPACE,
      title: "完成灰度发布",
      nextActions: ["执行只读发布前检查"],
    }, NOW);
    const continuation = new WorkContinuationStore(dir);

    continuation.configure(item, { autoContinue: true }, NOW + 1);

    expect(new WorkContinuationStore(dir).policyFor(item.id, item.space)).toEqual({
      workItemId: item.id,
      space: item.space,
      autoContinue: true,
      updatedAt: NOW + 1,
    });
  });

  test("requires retrying a blocked action instead of forking the same next action", () => {
    const items = new WorkItemStore(dir);
    const item = items.create({
      space: SPACE,
      title: "完成灰度发布",
      nextActions: ["执行只读发布前检查"],
    }, NOW);
    const continuation = new WorkContinuationStore(dir);
    const action = continuation.claimNext(item, NOW + 1);
    continuation.attachRun(action.id, "run_failed", "queued", NOW + 2);
    continuation.markRunning(action.id, "run_failed", NOW + 3);
    continuation.block(action.id, "检查失败", {
      runId: "run_failed",
      finishedAt: NOW + 4,
    });

    expect(() => continuation.claimNext(items.get(item.id)!, NOW + 5))
      .toThrow("requires retry");
    expect(continuation.list(item.id)).toHaveLength(1);
  });

  test("retry normalization preserves historical acceptance order across restart", () => {
    const sourceDir = join(dir, "source");
    const targetDir = join(dir, "target");
    const items = new WorkItemStore(sourceDir);
    const item = items.create({
      space: SPACE,
      title: "恢复被驳回动作",
      nextActions: ["执行只读发布前检查"],
    }, NOW);
    const source = new WorkContinuationStore(sourceDir);
    const action = source.claimNext(item, NOW + 1);
    source.attachRun(action.id, "run_first", "queued", NOW + 2);
    source.markRunning(action.id, "run_first", NOW + 3);
    source.submitForAcceptance(action.id, {
      runId: "run_first",
      permission: "write",
      summary: "首次结果等待核对",
      rawId: "raw_first",
      finishedAt: NOW + 4,
    });
    source.reject(action.id, {
      runId: "run_first",
      decidedAt: NOW + 5,
      decidedBy: "local-admin",
      mode: "human",
      reason: "需要补充证据",
    });
    const archive = source.exportBySpace(SPACE);
    archive.actions[0]!.attempt = 99;

    const target = new WorkContinuationStore(targetDir);
    target.restore(archive);
    const retry = target.retry(action.id, NOW + 6);
    expect(retry).toEqual(expect.objectContaining({
      attempt: 2,
      taskRunIds: ["run_first"],
      acceptances: [expect.objectContaining({ attempt: 1 })],
    }));
    target.attachRun(action.id, "run_second", "awaiting_approval", NOW + 7);
    const expected = target.get(action.id);

    const restarted = new WorkContinuationStore(targetDir);
    expect(restarted.get(action.id)).toEqual(expected);
    expect(() => restarted.exportBySpace(SPACE)).not.toThrow();
  });

  test("rejects a historical accepted result on a non-succeeded action", () => {
    const items = new WorkItemStore(dir);
    const item = items.create({
      space: SPACE,
      title: "拒绝重放历史验收",
      nextActions: ["执行只读发布前检查"],
    }, NOW);
    const continuation = new WorkContinuationStore(dir);
    const action = continuation.claimNext(item, NOW + 1);
    continuation.attachRun(action.id, "run_first", "queued", NOW + 2);
    continuation.markRunning(action.id, "run_first", NOW + 3);
    continuation.submitForAcceptance(action.id, {
      runId: "run_first",
      permission: "write",
      summary: "第一次执行结果",
      rawId: "raw_first",
      finishedAt: NOW + 4,
    });
    continuation.reject(action.id, {
      runId: "run_first",
      decidedAt: NOW + 5,
      decidedBy: "local-admin",
      mode: "human",
      reason: "第一次结果被驳回",
    });
    continuation.retry(action.id, NOW + 6);
    continuation.attachRun(action.id, "run_second", "queued", NOW + 7);
    continuation.markRunning(action.id, "run_second", NOW + 8);
    continuation.submitForAcceptance(action.id, {
      runId: "run_second",
      permission: "write",
      summary: "第二次执行结果",
      rawId: "raw_second",
      finishedAt: NOW + 9,
    });
    const rejected = continuation.reject(action.id, {
      runId: "run_second",
      decidedAt: NOW + 10,
      decidedBy: "local-admin",
      mode: "human",
      reason: "第二次结果被驳回",
    });
    const forged = structuredClone(rejected);
    forged.acceptances![0]!.status = "accepted";

    expect(isWorkAction(forged)).toBeFalse();
    const targetDir = join(dir, "target");
    const target = new WorkContinuationStore(targetDir);
    expect(() => target.restore({ actions: [forged], policies: [] }))
      .toThrow("invalid work action");
    expect(new WorkContinuationStore(targetDir).list()).toEqual([]);
  });

  test("atomically refuses a manual retry after the action reaches 100 runs", () => {
    const sourceDir = join(dir, "source");
    const targetDir = join(dir, "target");
    const items = new WorkItemStore(sourceDir);
    const item = items.create({
      space: SPACE,
      title: "限制人工重试次数",
      nextActions: ["执行只读发布前检查"],
    }, NOW);
    const source = new WorkContinuationStore(sourceDir);
    const claimed = source.claimNext(item, NOW + 1);
    const archive = source.exportBySpace(SPACE);
    const saturated = archive.actions[0]!;
    saturated.taskRunIds = Array.from(
      { length: MAX_WORK_ACTION_RUNS },
      (_, index) => `run_${index + 1}`,
    );
    saturated.attempt = MAX_WORK_ACTION_RUNS;
    saturated.status = "blocked";
    saturated.error = "最后一次检查失败";
    saturated.updatedAt = NOW + 2;
    const continuation = new WorkContinuationStore(targetDir);
    continuation.restore(archive);
    const before = continuation.get(claimed.id);
    const persistedBefore = readFileSync(
      join(targetDir, "config", "work-continuation.json"),
      "utf8",
    );

    expect(() => continuation.retry(claimed.id, NOW + 3)).toThrow("too many runs");

    expect(continuation.get(claimed.id)).toEqual(before);
    expect(readFileSync(
      join(targetDir, "config", "work-continuation.json"),
      "utf8",
    )).toBe(persistedBefore);
    const restarted = new WorkContinuationStore(targetDir);
    expect(restarted.get(claimed.id)).toEqual(before);
    expect(() => restarted.exportBySpace(SPACE)).not.toThrow();
  });

  test("atomically refuses an automatic retry claim after the action reaches 100 runs", () => {
    const sourceDir = join(dir, "source");
    const targetDir = join(dir, "target");
    const items = new WorkItemStore(sourceDir);
    const item = items.create({
      space: SPACE,
      title: "限制自动重试次数",
      nextActions: ["执行只读发布前检查"],
    }, NOW);
    const source = new WorkContinuationStore(sourceDir);
    const claimed = source.claimNext(item, NOW + 1);
    const archive = source.exportBySpace(SPACE);
    const saturated = archive.actions[0]!;
    saturated.taskRunIds = Array.from(
      { length: MAX_WORK_ACTION_RUNS },
      (_, index) => `run_${index + 1}`,
    );
    saturated.attempt = MAX_WORK_ACTION_RUNS;
    saturated.status = "queued";
    saturated.error = "等待自动重试";
    saturated.updatedAt = NOW + 2;
    const continuation = new WorkContinuationStore(targetDir);
    continuation.restore(archive);
    const before = continuation.get(claimed.id);
    const persistedBefore = readFileSync(
      join(targetDir, "config", "work-continuation.json"),
      "utf8",
    );

    expect(() => continuation.claimAutomaticRetry(claimed.id, NOW + 3))
      .toThrow("too many runs");

    expect(continuation.get(claimed.id)).toEqual(before);
    expect(readFileSync(
      join(targetDir, "config", "work-continuation.json"),
      "utf8",
    )).toBe(persistedBefore);
    const restarted = new WorkContinuationStore(targetDir);
    expect(restarted.get(claimed.id)).toEqual(before);
    expect(() => restarted.exportBySpace(SPACE)).not.toThrow();
  });

  test("refuses to claim new work while the work item has an unresolved blocker", () => {
    const items = new WorkItemStore(dir);
    const item = items.create({
      space: SPACE,
      title: "完成灰度发布",
      phase: "blocked",
      blockers: ["等待变更审批"],
      nextActions: ["执行只读发布前检查"],
    }, NOW);
    const continuation = new WorkContinuationStore(dir);

    expect(() => continuation.claimNext(item, NOW + 1)).toThrow("work item is blocked");
    expect(continuation.list(item.id)).toHaveLength(0);
  });

  test("fails closed without overwriting an unknown continuation schema", () => {
    const items = new WorkItemStore(dir);
    const item = items.create({
      space: SPACE,
      title: "保护未知续作状态",
      nextActions: ["执行发布检查"],
    }, NOW);
    const configDir = join(dir, "config");
    const path = join(configDir, "work-continuation.json");
    const original = '{"version":99,"actions":{},"policies":{}}\n';
    mkdirSync(configDir, { recursive: true });
    writeFileSync(path, original, "utf8");

    const continuation = new WorkContinuationStore(dir);

    expect(() => continuation.claimNext(item, NOW + 1)).toThrow(
      "persisted state is invalid",
    );
    expect(() => continuation.exportBySpace(SPACE)).toThrow(
      "persisted state is invalid",
    );
    expect(readFileSync(path, "utf8")).toBe(original);
  });
});
