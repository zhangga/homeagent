import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
      active: false,
      phase: "blocked",
      blockers: ["缺少生产环境审批"],
    }));
    expect(store.activeForSpace(SPACE)?.id).toBe(second.id);

    const restarted = new WorkItemStore(dir);
    expect(restarted.activeForSpace(SPACE)).toEqual(second);
    expect(restarted.get(first.id)?.summary).toBe("回归完成，等待权限。");

    const projectionDir = join(dir, "workspaces", spaceToDir(SPACE), "work", first.id);
    expect(existsSync(join(projectionDir, "status.json"))).toBe(true);
    expect(readFileSync(join(projectionDir, "brief.md"), "utf8")).toContain("明确验收标准");
    expect(readFileSync(join(projectionDir, "runbook.md"), "utf8")).toContain("检查审计记录");
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
});
