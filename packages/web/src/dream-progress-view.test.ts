import { expect, test } from "bun:test";
import type { DreamRunSnapshot } from "@homeagent/core";
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
