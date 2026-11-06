import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpaceId } from "@homeagent/shared";
import { spaceToDir } from "@homeagent/shared";
import { WorkItemStore } from "./work-items.ts";

const SPACE: SpaceId = "team/oc_product";
const NOW = new Date("2026-08-18T09:00:00+08:00").getTime();

describe("WorkItemStore", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "homeagent-work-items-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("persists the current work item and its readable workspace files across restart", () => {
    const store = new WorkItemStore(dir);
    const first = store.create({
      space: SPACE,
      title: "上线知识治理",
      brief: "明确验收标准并完成灰度。",
      runbook: "1. 跑回归\n2. 检查审计记录",
    }, NOW);

    store.update(first.id, {
      phase: "blocked",
      summary: "回归完成，等待权限。",
      blockers: ["缺少生产环境审批"],
      nextActions: ["申请审批"],
    }, NOW + 1_000);

    const second = store.create({
      space: SPACE,
      title: "修复检索召回",
    }, NOW + 2_000);

    expect(store.get(first.id)).toEqual(expect.objectContaining({
      active: true,
      phase: "blocked",
      blockers: ["缺少生产环境审批"],
    }));
    expect(store.activeForSpace(SPACE)?.id).toBe(second.id);

    const restarted = new WorkItemStore(dir);
    expect(restarted.activeForSpace(SPACE)).toEqual(second);
    expect(restarted.get(first.id)?.summary).toBe("回归完成，等待权限。");
    restarted.select(first.id);
    expect(restarted.currentForSpace(SPACE)?.id).toBe(first.id);
    expect(restarted.get(second.id)?.active).toBe(true);

    const projectionDir = join(dir, "workspaces", spaceToDir(SPACE), "work", first.id);
    expect(existsSync(join(projectionDir, "status.json"))).toBe(true);
    expect(readFileSync(join(projectionDir, "brief.md"), "utf8")).toContain("明确验收标准");
    expect(readFileSync(join(projectionDir, "runbook.md"), "utf8")).toContain("检查审计记录");
  });

  test("migrates v1's single active item into an independent durable current selection", () => {
    const store = new WorkItemStore(dir);
    const item = store.create({ space: SPACE, title: "旧事项" });
    writeFileSync(join(dir, "config", "work-items.json"), JSON.stringify({ version: 1, items: { [item.id]: item } }));
    const reopened = new WorkItemStore(dir);
    expect(reopened.currentForSpace(SPACE)?.id).toBe(item.id);
    const another = reopened.create({ space: SPACE, title: "新事项" });
    reopened.select(item.id);
    const again = new WorkItemStore(dir);
    expect(again.currentForSpace(SPACE)?.id).toBe(item.id);
    expect(again.get(another.id)?.active).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "config", "work-items.json"), "utf8")).version).toBe(4);
  });

  test("refuses malformed or future WorkItem files instead of treating them as empty", () => {
    new WorkItemStore(dir).create({ space: SPACE, title: "保留工作" });
    const path = join(dir, "config", "work-items.json");
    for (const value of [{ version: 2, currentBySpace: {} }, { version: 2, items: [], currentBySpace: {} }, { version: 5, items: {}, currentBySpace: {} }]) {
      writeFileSync(path, JSON.stringify(value));
      expect(() => new WorkItemStore(dir)).toThrow("WorkItem state is invalid");
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(value);
    }
  });

  test("does not consume a later action when the current boundary changed during execution", () => {
    const store = new WorkItemStore(dir);
    const item = store.create({
      space: SPACE,
      title: "完成灰度发布",
      nextActions: ["执行发布前检查", "生成发布报告"],
    }, NOW);
    store.update(item.id, {
      nextActions: ["先处理紧急回滚", "执行发布前检查", "生成发布报告"],
    }, NOW + 1);

    const conflicted = store.applyActionCheckpoint(
      item.id,
      "action_boundary",
      "执行发布前检查",
      "检查已完成",
      NOW + 2,
    );

    expect(conflicted).toEqual(expect.objectContaining({
      phase: "blocked",
      completedActionIds: [],
      nextActions: ["先处理紧急回滚", "执行发布前检查", "生成发布报告"],
      blockers: [expect.stringContaining("验收投影冲突")],
    }));
  });

  test("user edits cannot remove a blocker owned by a WorkAction", () => {
    const store = new WorkItemStore(dir);
    const item = store.create({
      space: SPACE,
      title: "完成灰度发布",
      nextActions: ["更新灰度配置"],
    }, NOW);
    store.applyActionBlocker(
      item.id,
      "action_rejected",
      "更新灰度配置",
      "缺少变更证据",
      NOW + 1,
    );

    const edited = store.update(item.id, {
      phase: "active",
      blockers: ["用户补充的备注"],
    }, NOW + 2);

    expect(edited).toEqual(expect.objectContaining({
      phase: "blocked",
      blockers: ["用户补充的备注", "更新灰度配置：缺少变更证据"],
      actionBlockers: { action_rejected: "更新灰度配置：缺少变更证据" },
    }));
  });

  test("chat plans are atomic, detached, idempotent and bounded across reopen", () => {
    const store = new WorkItemStore(dir);
    const item = store.create({ space: SPACE, title: "分步工作" });
    const run = "chat_run_11111111-2222-4333-8444-555555555555";
    store.attachChatRun(item.id, run);
    const before = store.get(item.id);
    for (const steps of [[], ["重复", "重复"], ["x".repeat(2001)], Array.from({ length: 201 }, (_, i) => `${i}`),
      Array.from({ length: 200 }, (_, i) => `${i}${"x".repeat(1100)}`)]) {
      expect(() => store.applyChatPlan(item.id, run, steps)).toThrow();
      expect(store.get(item.id)).toEqual(before);
    }
    const path = join(dir, "config", "work-items.json");
    renameSync(path, `${path}.saved`); mkdirSync(path);
    expect(() => store.applyChatPlan(item.id, run, ["第一步", "第二步"])).toThrow();
    expect(store.get(item.id)).toEqual(before);
    rmdirSync(path); renameSync(`${path}.saved`, path);
    expect(new WorkItemStore(dir).get(item.id)).toEqual(before);
    const steps = ["第一步", "第二步"];
    const planned = store.applyChatPlan(item.id, run, steps);
    steps[0] = "外部修改"; planned.nextActions[0] = "返回值修改";
    const restarted = new WorkItemStore(dir);
    expect(restarted.get(item.id)?.nextActions).toEqual(["第一步", "第二步"]);
    restarted.applyActionCheckpoint(item.id, "action_1", "第一步", "已完成");
    expect(restarted.applyChatPlan(item.id, run, ["不应重置"] ).nextActions).toEqual(["第二步"]);
    restarted.applyActionCheckpoint(item.id, "action_2", "第二步", "已完成");
    expect(new WorkItemStore(dir).get(item.id)).toEqual(expect.objectContaining({ phase: "completed", active: false }));
  });
});
