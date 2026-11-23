import { expect, test } from "bun:test";
import type { PageRef, SpaceId } from "@homeagent/shared";
import { askView, rawListView, spaceDetailView } from "./views.ts";

const team: SpaceId = "team/oc_design";
const page: PageRef = {
  slug: "concepts/onboarding", title: "入门指南", type: "concept",
  summary: "第一次使用时要做的几件事", aliases: [], tags: [],
};

test("space readers can ask, import and read the catalog before opening maintenance", async () => {
  const body = String(await spaceDetailView(team, [page], { raw: 9, pending: 3, failed: 1 }, {
    id: team, name: "设计讨论", chatId: "oc_design", createdAt: 1,
  }));
  const root = "/spaces/team%2Foc_design";
  const ask = body.indexOf(`href="${root}/ask"`);
  const catalog = body.indexOf(`href="${root}/pages/concepts%2Fonboarding"`);
  const settings = body.indexOf("<summary>空间设置与维护</summary>");
  expect(ask).toBeGreaterThan(-1);
  expect(catalog).toBeGreaterThan(ask);
  expect(settings).toBeGreaterThan(catalog);
  expect(body.slice(0, ask)).toContain("待提炼 3 条");
  expect(body.slice(0, ask)).toContain(`href="${root}/quarantine"`);
  expect(body.slice(ask, catalog)).toMatch(/<details>\s*<summary[^>]*>导入本地资料<\/summary>\s*<form/);
  expect(body.slice(ask, catalog)).toMatch(/<\/details>\s*<a[^>]+href="\/spaces\/team%2Foc_design\/raw">原始条目（9）/);
  expect(body).toContain(page.title);
  expect(body).toContain(page.summary);
  expect(body).toContain("概念");
  const maintenance = body.slice(settings);
  expect(maintenance).toContain(`href="${root}/governance"`);
  expect(maintenance).toContain('href="/integrations"');
  expect(maintenance).toContain(`action="${root}/dream"`);
  expect(maintenance).toContain(`action="${root}/maintenance"`);
});

test("Raw history shows the captured title, summary and source with full details one click away", async () => {
  const shared = { space: team, createdAt: 1000, ingested: false, admission: "ready" as const };
  const body = String(await rawListView(team, "交付团队", {
    hasNewer: false, hasOlder: false,
    records: [
      { ...shared, id: "sample", source: "task", workActionId: "action", admission: "held",
        content: "# 任务研究：继续：核验交付样本\n主题：你正在继续一个已持久化的 HomeAgent 工作项。\n# 工作项\n核验交付样本\n## 本次动作\n核对交付样本的来源记录\n只输出一个 JSON 对象。" },
      { ...shared, id: "local", source: "manual", content: "# 本地资料：交付清单.md\n\nSHA-256：" + "a".repeat(64) + "\n\n签字页有两项待补。" },
      { ...shared, id: "doc-import-" + "b".repeat(64), source: "doc",
        content: '# 来源资料：https://example.test/guide\n\n<!-- {"format":"homeagent.document-source","version":1,"capture":"agent-submitted","title":"操作指南"} -->\n\n# 操作指南\n\n这是发布检查的正文。' },
      { ...shared, id: "chat-import-" + "c".repeat(64), source: "manual",
        content: '<!-- HomeAgent: Agent 查询所得来源快照；附件仅为引用 -->\n{"format":"homeagent.chat-source","chatName":"交付群"}\n\n收件名单\n请核对三个签收人。' },
      { ...shared, id: "attachment", source: "message", content: "", attachments: [{ kind: "file", ref: "file", name: "现场图片.png" }] },
      { ...shared, id: "lesson", source: "learning", content: "培训小结\n两位同事已完成培训。" },
    ],
  }, false));
  for (const title of ["核验交付样本", "交付清单.md", "操作指南", "收件名单", "现场图片.png", "培训小结"]) {
    expect(body).toContain(`>${title}</a>`);
  }
  for (const summary of ["核对交付样本的来源记录", "签字页有两项待补。", "这是发布检查的正文。", "请核对三个签收人。"]) {
    expect(body).toContain(`<p class="raw-summary">${summary}</p>`);
  }
  for (const label of ["交付团队", "群消息快照", "任务", "手动录入", "学习", "待动作验收"]) expect(body).toContain(label);
  for (const header of ["只输出一个 JSON", "SHA-256", "homeagent.document-source", "homeagent.chat-source"]) expect(body).not.toContain(header);
  expect(body).toContain('href="/spaces/team%2Foc_design/raw/sample"');
});

test("empty spaces explain how knowledge appears and retain personal Agent settings", async () => {
  const space = "personal/ou_visitor";
  const empty = String(await spaceDetailView(space, [], { raw: 0, pending: 0, failed: 0 }));
  expect(empty).toContain("可以导入资料");
  expect(empty).toContain('action="/spaces/personal%2Fou_visitor/agent"');
  const waiting = String(await spaceDetailView(space, [], { raw: 2, pending: 2, failed: 0 }));
  expect(waiting).toContain("已有资料待提炼");
  expect(waiting).toContain("知识页（0）");
});

test("the ask entry and question form use the same wording and preserve the selected space", async () => {
  const body = String(await askView(team, null, null));
  expect(body).toContain("<h1>向空间提问</h1>");
  expect(body).toContain('action="/spaces/team%2Foc_design/ask"');
  expect(body).toContain('aria-label="问题"');
});
