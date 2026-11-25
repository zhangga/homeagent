import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeLlm, KnowledgeEngine, SkillCatalog } from "@homeagent/core";
import { resetConfig, type Page } from "@homeagent/shared";
import { createWebApp } from "./app.ts";
import { SPACE_SEARCH_QUERY_LIMIT } from "./views.ts";

const team = "team/oc_search";
const personal = "personal/ou_search";
const base = `/spaces/${encodeURIComponent(team)}`;
let dir: string;
let previousDir: string | undefined;
let engine: KnowledgeEngine;
let llm: FakeLlm;
let app: ReturnType<typeof createWebApp>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "homeagent-space-search-"));
  previousDir = process.env.HOMEAGENT_DATA_DIR;
  process.env.HOMEAGENT_DATA_DIR = dir;
  resetConfig();
  llm = new FakeLlm();
  engine = new KnowledgeEngine({ dataDir: dir, llm, skillCatalog: new SkillCatalog({ roots: [] }) });
  engine.ensureSpace(team);
  app = createWebApp({ engine });
});

afterEach(() => {
  engine.close();
  rmSync(dir, { recursive: true, force: true });
  if (previousDir === undefined) delete process.env.HOMEAGENT_DATA_DIR;
  else process.env.HOMEAGENT_DATA_DIR = previousDir;
  resetConfig();
});

function search(q: string, path = base) {
  return app.request(`${path}/search`, { method: "POST", body: new URLSearchParams({ q }) });
}

function page(slug: string, title: string, content: string): Page {
  return { slug, title, type: "concept", sources: [], tags: [], aliases: [], links: [],
    content, summary: "", updatedAt: 1000, contentHash: "" };
}

test("readers find a page, pending message and imported file in the current Space and follow the result links", async () => {
  const home = await (await app.request(base)).text();
  expect(home).toContain(`<form method="post" action="${base}/search"`);
  expect(home).toContain("搜本空间");
  const article = page("concepts/release", "上线手册", "灰度流程按百分比放量。");
  await engine.upsertPage(team, article);
  await engine.upsertPage(personal, page(article.slug, "个人空间的保密手册", "灰度保密"));
  const id = await engine.remember({ space: team, source: "message", content: "上线讨论\n灰度窗口已确认。" });
  const foreign = await engine.remember({ space: personal, source: "message", content: "灰度个人笔记" });
  const upload = new FormData();
  upload.set("material", new File(["背景说明。".repeat(400) + "验收标准为灰度期间零告警。"], "验收清单.txt"));
  expect((await app.request(`${base}/materials`, { method: "POST", body: upload })).status).toBeLessThan(400);
  const response = await search("灰度");
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = await response.text();
  for (const value of ["知识页（1）", "上线手册", article.content, "原始资料（2）", "上线讨论", "灰度窗口已确认",
    "验收清单.txt", "本地文件", "待提炼", "验收标准为灰度期间零告警。"]) expect(body).toContain(value);
  for (const hidden of ["灰度个人笔记", "个人空间的保密手册", foreign, "SHA-256"]) expect(body).not.toContain(hidden);
  expect(body).toContain(`href="${base}/raw/${id}"`);
  const fileHref = body.match(/href="([^"]+\/raw\/local-import-[a-f0-9]+)">验收清单.txt/u)?.[1];
  expect(fileHref).toBeDefined();
  const fileDetail = await (await app.request(fileHref!)).text();
  expect(fileDetail).toContain("零告警");
  expect(fileDetail).toContain("/attachments/0");
  const pageHref = `${base}/pages/${encodeURIComponent(article.slug)}`;
  expect(body).toContain(`href="${pageHref}"`);
  expect(await (await app.request(pageHref)).text()).toContain(article.content);
  expect(await (await search("验收清单")).text()).toContain(fileHref!);
  expect(llm.calls).toHaveLength(0);
});

test("held, excluded and retracted evidence never becomes a search hit", async () => {
  const post = await engine.remember({ space: team, source: "message", content: "撤回测试\n灰度密钥轮换",
    chatId: "oc_search", messageId: "om_search", author: "ou_owner" });
  for (const action of ["held", "excluded"]) {
    const id = await engine.remember({ space: team, source: "task", content: `灰度未验收 ${action}`,
      admission: "held", workActionId: action });
    if (action === "excluded") engine.registry.store(team).index().excludeRawAdmission(id, action);
  }
  expect(await (await search("灰度")).text()).toContain(`/raw/${post}`);
  const removed = await engine.retractMessage(team, { chatId: "oc_search", messageId: "om_search", requestedBy: "ou_owner" });
  expect(removed.status).toBe("retracted");
  const body = await (await search("灰度")).text();
  expect(body).toContain("没有匹配的知识页或原始资料");
  expect(body).not.toContain("灰度未验收");
  expect(body).not.toContain(`/raw/${post}`);
  expect(llm.calls).toHaveLength(0);
});

test("sorting and bounding hits excludes navigation pages before counting and reports remaining hits", async () => {
  const store = engine.registry.store(team);
  for (let i = 0; i < 23; i++) {
    store.writePage({ ...page(`maps/navigation-${i}`, "灰度", "灰度"), type: "map" });
    store.writePage(page(`concepts/topic-${i}`, `手册 ${i}`, "灰度部署"));
    await engine.remember({ space: team, source: "message", content: `灰度进展 ${i}` });
  }
  const body = await (await search("灰度")).text();
  expect(body).toContain("知识页（20+）");
  expect(body).toContain("原始资料（20+）");
  expect(body.match(/href="[^"]+\/pages\/concepts%2Ftopic-/gu)).toHaveLength(20);
  expect(body.match(/href="[^"]+\/raw\/[^"]+"/gu)).toHaveLength(20);
  expect(body).not.toContain("maps%2Fnavigation");
});

test("empty, unmatched and oversized inputs do not expose unrelated records or create missing Spaces", async () => {
  await engine.remember({ space: team, source: "message", content: "PRIVATE_SOURCE" });
  expect(await (await app.request(`${base}/search`)).text()).toContain("请输入要查找的关键词");
  expect(await (await search("  ")).text()).toContain("请输入要查找的关键词");
  for (const q of ["没命中", "!!!", "a".repeat(SPACE_SEARCH_QUERY_LIMIT)]) {
    const response = await search(q);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("没有匹配的知识页或原始资料");
    expect(body).not.toContain("PRIVATE_SOURCE");
  }
  expect((await search("a".repeat(SPACE_SEARCH_QUERY_LIMIT + 1))).status).toBe(400);
  expect((await search("资料", "/spaces/team%2Funknown")).status).toBe(404);
  expect(engine.registry.has("team/unknown")).toBe(false);
  expect(llm.calls).toHaveLength(0);
});
