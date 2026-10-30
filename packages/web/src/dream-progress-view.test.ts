import { expect, test } from "bun:test";
import type { DreamRunSnapshot } from "@homeagent/core";
import type { DreamPhaseMetrics } from "@homeagent/shared";
import { dreamRunsFragment, dreamRunsPanel } from "./dream-progress-view.ts";

const run: DreamRunSnapshot = {
  id: "dream_test", space: "team/oc_test", trigger: "import", batch: { index: 2, total: 3 },
  status: "running", stage: "generating", queuedAt: 0, startedAt: 1000,
  updatedAt: 2000, stageStartedAt: 2000, errorCount: 0, rawCount: 40,
  pagesTotal: 8, pagesCompleted: 2, pagesWritten: 2, pagesFailed: 0,
  page: { slug: "concepts/release", title: "<img src=x onerror=alert(1)>", index: 3 },
  chunk: { index: 2, total: 5 }, sourceCount: 1,
  sources: [{ id: "raw_1", name: "<script>secret</script>.md" }],
};

test("renders actual step, batch, fragment, duration and escaped source links", async () => {
  const body = String(await dreamRunsFragment([run], 122_000));
  expect(body).toContain("第 2 / 3 批");
  expect(body).toContain("生成与合并知识页");
  expect(body).toContain("2 / 5");
  expect(body).toContain("等待模型返回");
  expect(body).toContain("2 分 0 秒");
  expect(body).toContain("/spaces/team%2Foc_test/raw/raw_1");
  expect(body).not.toContain("<img");
  expect(body).not.toContain("<script>");
  expect(body).toContain("&lt;script&gt;");
});

test("terminal and empty states do not claim that a model is still running", async () => {
  const completed = String(await dreamRunsFragment([{ ...run, status: "completed", finishedAt: 62_000, processedRaw: 40 }], 999_000));
  expect(completed).toContain("1 分 1 秒");
  expect(completed).toContain("已处理 40 条 Raw");
  expect(completed).not.toContain("正在等待模型返回");
  const failed = String(await dreamRunsFragment([{ ...run, status: "failed", finishedAt: 62_000, errorCount: 1 }]));
  expect(failed).toContain("提炼失败记录");
  expect(failed).not.toContain("正在等待模型返回");
  expect(String(await dreamRunsPanel([]))).toContain("仅保留本次服务启动后的运行信息");
});

test("keeps current execution separate from historical failures", async () => {
  const body = String(await dreamRunsFragment([
    { ...run, id: "dream_failed", status: "failed", finishedAt: 1000, errorCount: 1 }, run,
  ], 122_000));
  expect(body).toContain("当前提炼");
  expect(body).toContain("历史运行记录");
  expect(body.indexOf('data-dream-run="dream_test"')).toBeLessThan(body.indexOf("历史运行记录"));
  expect(body.indexOf('data-dream-run="dream_failed"')).toBeGreaterThan(body.indexOf("历史运行记录"));
});

test("distinguishes independent extraction from the one-time page merge", async () => {
  const extracting = String(await dreamRunsFragment([{ ...run, stage: "extracting" }], 122_000));
  expect(extracting).toContain("提取分段知识");
  expect(extracting).toContain("这一段的知识片段");
  expect(extracting).not.toContain("正在等待模型返回完整知识页");
  const merging = String(await dreamRunsFragment([{ ...run, stage: "generating", chunk: undefined }], 122_000));
  expect(merging).toContain("集中生成与合并知识页");
  expect(merging).toContain("正在等待模型返回完整知识页");
  expect(merging).not.toContain("来源分段：第");
});

test("concurrent extraction displays returned results separately from in-flight fragments", async () => {
  const concurrent: DreamRunSnapshot = { ...run, stage: "extracting", extraction: { active: 2, completed: 1, total: 5 } };
  const body = String(await dreamRunsFragment([concurrent], 122_000));
  expect(body).toContain("分段提取：已完成 <strong>1 / 5</strong> 段");
  expect(body).toContain("正在处理 2 段");
  expect(body).not.toContain("来源分段：第");
  expect(body).toContain("等待模型返回分段知识片段");
  const ended = String(await dreamRunsFragment([{ ...concurrent, status: "cancelled", finishedAt: 122_000 }]));
  expect(ended).not.toContain("正在处理");
  expect(ended).not.toContain("正在等待模型返回");
});

test("reused extraction checkpoints are included in completed progress", async () => {
  const body = String(await dreamRunsFragment([{ ...run, stage: "extracting", extraction: { active: 1, completed: 4, total: 5, reused: 3 } }]));
  expect(body).toContain("已完成 <strong>4 / 5</strong>");
  expect(body).toContain("复用 3 段");
  expect(body).toContain("正在处理 1 段");
});

test("phase metrics distinguish partial usage, zero tokens and reused results without exposing model markup", async () => {
  const phase: DreamPhaseMetrics = { model: "<script>model</script>", provider: "codex", elapsedMs: 1300, calls: 2, activeCalls: 0, failedCalls: 1,
    knownTokenCalls: 1, unknownTokenCalls: 1, inputTokens: 100, outputTokens: 0, cachedInputTokens: 20, reusedExtractions: 0 };
  const body = String(await dreamRunsFragment([{ ...run, metrics: { elapsedMs: 2_000, phases: {
    planning: phase, extraction: { ...phase, calls: 0, knownTokenCalls: 0, unknownTokenCalls: 0, inputTokens: undefined, outputTokens: undefined, reusedExtractions: 3 },
    merge: { ...phase, inputTokens: undefined, outputTokens: undefined },
  } } }]));
  expect(body).toContain("阶段耗时与 token 用量");
  expect(body).toContain('data-dream-details="dream_test-metrics"');
  expect(body).toContain('id="dream_test-metrics-title"');
  expect(body).toContain("1.30 秒");
  expect(body).toContain("100 / 0");
  expect(body).toContain("未知 / 未知");
  expect(body).toContain("复用 3 段");
  expect(body).toContain("未调用");
  expect(body).toContain("未知用量调用");
  expect(body).not.toContain("<script>model");
  expect(body).toContain("&lt;script&gt;model");
});
