import { expect, test } from "bun:test";
import type { PageRef, SpaceId } from "@homeagent/shared";
import { askView, spaceDetailView } from "./views.ts";

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
  expect(body).toContain(page.title);
  expect(body).toContain(page.summary);
  expect(body).toContain("概念");
  const maintenance = body.slice(settings);
  expect(maintenance).toContain(`href="${root}/raw"`);
  expect(maintenance).toContain(`href="${root}/governance"`);
  expect(maintenance).toContain('href="/integrations"');
  expect(maintenance).toContain(`action="${root}/dream"`);
  expect(maintenance).toContain(`action="${root}/maintenance"`);
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
