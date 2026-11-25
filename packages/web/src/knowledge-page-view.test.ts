import { expect, test } from "bun:test";
import type { Page, SpaceId } from "@homeagent/shared";
import { pageView } from "./views.ts";

const space: SpaceId = "team/oc_design";
const page: Page = {
  title: "交接指南", slug: "concepts/handover", type: "concept", summary: "周五交接前核对事项。",
  aliases: ["交班"], tags: ["团队"], links: ["concepts/值班"], sources: ["raw-a"],
  updatedAt: 1_700_000_000_000, contentHash: "fixture",
  content: [
    "# 交接指南", "", "## 准备", "", "- 核对 **排期**", "- 查看 [[concepts/值班|值班表]]",
    "", "| 事项 | 时间 |", "| --- | --- |", "| 交接 | 周五 |",
    "", "[参考手册](https://example.com/manual)", "", "`[[index]]`",
  ].join("\n"),
};

test("a reader sees the summary and rendered article before provenance, metadata and governance", async () => {
  const output = String(await pageView(space, page, undefined, {
    space, page, sourceCount: 1, sources: [{ id: "raw-a", createdAt: 1, source: "manual", admission: "ready" }],
    missingSourceIds: [], latestEvidenceAt: 1, freshness: "stale", complete: true, truncated: false,
  }));
  const article = output.match(/<article[^>]*>([\s\S]*?)<\/article>/u)?.[1] ?? "";
  expect(output.indexOf("周五交接前核对事项。")).toBeLessThan(output.indexOf("<article"));
  expect(output.indexOf("更新于")).toBeLessThan(output.indexOf("<article"));
  expect(output).toContain('href="#knowledge-sources">1 条原始来源');
  expect(output).toContain("证据陈旧");
  expect(article).toContain("<h2>准备</h2>");
  expect(article).toContain("<li>核对 <strong>排期</strong></li>");
  expect(article).toContain(`href="/spaces/team%2Foc_design/pages/${encodeURIComponent("concepts/值班")}">值班表</a>`);
  expect(article).toContain("<table>");
  expect(article).toContain("<code>[[index]]</code>");
  expect(article).toContain('href="https://example.com/manual"');
  expect(article).not.toContain("<h1>交接指南");
  const end = output.indexOf("</article>");
  for (const detail of ["证据链与时效性", "页面信息", "查看 Markdown 原文", "人工治理", "# 交接指南", "/raw/raw-a"]) {
    expect(output.indexOf(detail)).toBeGreaterThan(end);
  }
  for (const action of ["regenerate", "correct", "delete"]) {
    expect(output).toContain(`action="/spaces/team%2Foc_design/pages/${action}"`);
  }
});

test("rendered Markdown preserves visible text without executing HTML, active links or image loads", async () => {
  const content = [
    '<a href="javascript:alert(1)">危险</a>', '<img src="/private">', '<script>alert(1)</script>',
    "", "[被拒绝的链接](javascript:alert%281%29)", "![图纸](https://example.com/private.png)",
    "", "~~~html", "<script>示例</script>", "~~~",
  ].join("\n");
  const output = String(await pageView(space, { ...page, content }));
  const article = output.match(/<article[^>]*>([\s\S]*?)<\/article>/u)?.[1] ?? "";
  expect(article).toContain("&lt;script&gt;");
  expect(article).toContain("被拒绝的链接");
  expect(article).toContain("图纸");
  expect(article).not.toMatch(/<script|<img|<a\s/iu);
});

test("maps have navigable same-space links and keep their read-only controls", async () => {
  const output = String(await pageView(space, {
    ...page, type: "map", slug: "maps/team", sources: [], content: "- [[concepts/handover|交接指南]]",
  }));
  expect(output).toContain('href="/spaces/team%2Foc_design/pages/concepts%2Fhandover">交接指南</a>');
  expect(output).toContain("系统自动生成的导航页");
  expect(output).not.toContain("证据链与时效性");
  expect(output).not.toContain("提交人工纠错");
});

test("an older source runtime can read the page without Bun's native Markdown API", async () => {
  const native = Bun.markdown;
  try {
    Object.defineProperty(Bun, "markdown", { value: undefined });
    const output = String(await pageView(space, page));
    expect(output).toContain("<h2>准备</h2>");
    expect(output).toContain("<strong>排期</strong>");
    expect(output).toContain('href="https://example.com/manual"');
    expect(output).toContain("查看 Markdown 原文");
  } finally {
    Object.defineProperty(Bun, "markdown", { value: native });
  }
});
