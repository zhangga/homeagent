import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeLlm, KnowledgeEngine, SkillCatalog } from "@homeagent/core";
import type { JSONOptions } from "@homeagent/llm";
import { resetConfig, type Page, type SpaceId } from "@homeagent/shared";
import { createWebApp } from "./app.ts";

const space = "team/oc_material_pages";
const other = "personal/ou_elsewhere";
const root = `/spaces/${encodeURIComponent(space)}`;
let dir: string;
let previous: string | undefined;
let engine: KnowledgeEngine;
let llm: FakeLlm;
let app: ReturnType<typeof createWebApp>;

function open() {
  engine = new KnowledgeEngine({ dataDir: dir, llm, skillCatalog: new SkillCatalog({ roots: [] }) });
  engine.ensureSpace(space);
  app = createWebApp({ engine });
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ha-material-citations-"));
  previous = process.env.HOMEAGENT_DATA_DIR;
  process.env.HOMEAGENT_DATA_DIR = dir;
  resetConfig();
  llm = new FakeLlm();
  open();
});
afterEach(() => {
  engine.close();
  rmSync(dir, { recursive: true, force: true });
  if (previous === undefined) delete process.env.HOMEAGENT_DATA_DIR;
  else process.env.HOMEAGENT_DATA_DIR = previous;
  resetConfig();
});

function upload(files: File[], batch?: string) {
  const form = new FormData();
  if (batch) form.set("materialBatch", batch);
  for (const file of files) form.append("material", file);
  return app.request(root + "/materials", { method: "POST", body: form });
}
function cite(slug: string, sources: string[], where: SpaceId = space, type: Page["type"] = "concept") {
  return engine.upsertPage(where, { slug, title: slug + " 标题", type, sources, summary: "",
    content: "测试知识正文", aliases: [], tags: [], links: [], contentHash: "", updatedAt: 100 });
}
function currentUrl(body: string) {
  const href = /href="([^"]+)">查看最新关联页/u.exec(body)?.[1];
  expect(href).toBeDefined();
  return href!.replaceAll("&amp;", "&");
}
function receiptPanel(body: string) {
  return /<section class="card" aria-label="本次导入的关联知识页">([\s\S]*?)<\/section>/u.exec(body)?.[1] ?? "";
}

test("reopened batch and native multi-part redirects show actual, deduplicated pages for each uploaded file", async () => {
  const batch = crypto.randomUUID();
  const split = new File(["x".repeat(200_000) + "尾段"], "同名.txt");
  const small = new File(["独立文件"], "同名.txt");
  const submit = () => upload([split, small], batch);
  const first = await (await submit()).text();
  expect(first).toContain("目前没有知识页引用这份资料");
  const link = currentUrl(first);
  const records = engine.registry.store(space).index().listRaw();
  const tail = records.find(raw => raw.content.includes("正文分段：2/2"))!;
  const head = records.find(raw => raw.content.includes("正文分段：1/2"))!;
  const separate = records.find(raw => raw.content.includes("独立文件"))!;
  await cite("concepts/multi", [head.id, tail.id]);
  await cite("concepts/tail", [tail.id]);
  await cite("concepts/other-file", [separate.id]);
  await cite("concepts/hidden-foreign", [tail.id], other);
  await cite("maps/skip-navigation", [tail.id], space, "map");
  const latest = await (await submit()).text();
  const [before, after] = latest.split('data-material-row="1"');
  expect(before).toContain(`href="${root}/pages/concepts%2Ftail"`);
  expect(before!.match(/>concepts\/multi 标题</gu)).toHaveLength(1);
  expect(before).not.toContain("other-file");
  expect(after).toContain("concepts/other-file 标题");
  expect(after).not.toContain("concepts/tail 标题");
  expect(latest).not.toContain("hidden-foreign");
  expect(latest).not.toContain("skip-navigation");
  engine.close(); open();
  const panel = receiptPanel(await (await app.request(link)).text());
  expect(panel).toContain("concepts/tail 标题");
  expect(panel).toContain("concepts/other-file 标题");
  expect(panel.match(/>concepts\/multi 标题</gu)).toHaveLength(1);
  expect(receiptPanel(await (await app.request(link.replace(encodeURIComponent(space), encodeURIComponent(other)))).text())).toBe("");
  const redirected = await upload([split], batch);
  expect(redirected.status).toBe(302);
  const singleSplit = receiptPanel(await (await app.request(redirected.headers.get("location")!)).text());
  expect(singleSplit).toContain("concepts/tail 标题");
  expect(singleSplit).not.toContain("concepts/other-file 标题");
  expect(llm.calls).toHaveLength(0);
});

test("a normal single-file redirect surfaces actual page links before the full file, including after later distillation", async () => {
  const response = await upload([new File(["需要核对的材料"], "资料.md")]);
  const url = response.headers.get("location")!;
  expect(url).toContain(root + "/raw/local-import-");
  const id = engine.registry.store(space).index().listRaw()[0]!.id;
  const empty = await (await app.request(url)).text();
  expect(empty).toContain("当前没有知识页引用这条原始记录");
  await cite("concepts/later", [id]);
  const page = await (await app.request(url)).text();
  expect(page.indexOf('>concepts/later 标题</a>')).toBeLessThan(page.indexOf("<h2>完整内容"));
  expect(page).toContain(`href="${root}/pages/concepts%2Flater"`);
});

test("partial imports and idempotent retries show citations only for confirmed parts", async () => {
  const batch = crypto.randomUUID();
  const file = new File(["x".repeat(200_000) + "尾段"], "需重试.txt");
  const original = engine.rememberFile.bind(engine);
  const fail = spyOn(engine, "rememberFile").mockImplementation(async (...args) => {
    if (args[0].content.includes("正文分段：2/2")) throw new Error("offline failure");
    return original(...args);
  });
  const first = await (await upload([file], batch)).text();
  expect(first).toContain("已确认 1/2");
  const head = engine.registry.store(space).index().listRaw()[0]!;
  await cite("concepts/confirmed", [head.id]);
  const partial = await (await upload([file], batch)).text();
  expect(partial).toContain("concepts/confirmed 标题");
  fail.mockRestore();
  const retryForm = new FormData();
  for (const [, key, value] of first.matchAll(/name="(materialBatch|materialSlot|materialIdentity|materialBudget)" value="([^"]+)"/gu)) {
    retryForm.set(key!, value!);
  }
  retryForm.set("material", file);
  const retry = () => app.request(root + "/materials", { method: "POST", body: retryForm });
  expect(await (await retry()).text()).toContain("concepts/confirmed 标题");
  const tail = engine.registry.store(space).index().listRaw().find(raw => raw.id !== head.id)!;
  await cite("concepts/after-retry", [tail.id]);
  expect(await (await retry()).text()).toContain("concepts/after-retry 标题");
  expect(receiptPanel(await (await app.request(currentUrl(first))).text())).toContain("concepts/after-retry 标题");
  expect(engine.registry.store(space).index().countRaw()).toBe(2);
});

test("a material receipt can be reopened while its Dream is queued or blocked in a Provider and survives restart", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  class PausedLlm extends FakeLlm {
    override async completeJSON<T>(opts: JSONOptions<T>) {
      entered.resolve();
      await release.promise;
      return super.completeJSON(opts);
    }
  }
  engine.close();
  llm = new PausedLlm().onJSON(opts => {
    const ids = [...(opts.prompt ?? "").matchAll(/<entry id="([^"]+)"/gu)].map(match => match[1]);
    return ids.length ? { operations: [], skippedRawIds: ids } : {};
  });
  open();
  const queue = Promise.withResolvers<void>();
  const blocker = engine.scheduleBackgroundRun("hold-material-queue", space, () => queue.promise);
  const batch = crypto.randomUUID();
  const submit = () => {
    const form = new FormData();
    form.set("materialBatch", batch);
    form.set("distillNow", "on");
    form.append("material", new File(["第一份内容"], "甲.md"));
    form.append("material", new File(["第二份内容"], "乙.md"));
    return app.request(root + "/materials", { method: "POST", body: form });
  };
  let reopenUrl = "";
  try {
    const first = await (await submit()).text();
    reopenUrl = currentUrl(first);
    expect(first).toContain("已排队，等待提炼");
    expect(first).toContain('data-material-count>已导入 2 份资料');
    expect(first).toContain('查看原始条目</a>');
    const status = /data-endpoint="([^"]+)"/u.exec(first)![1]!.replaceAll("&amp;", "&");
    queue.resolve();
    await blocker;
    await entered.promise;
    expect(await (await app.request(status)).text()).toContain("正在提炼");
    expect(await (await app.request(reopenUrl)).text()).toContain("正在提炼");
    expect(await (await submit()).text()).toContain("正在提炼");
    expect(engine.listDreamRuns(space)).toHaveLength(1);
    expect(engine.registry.store(space).index().countRaw()).toBe(2);
  } finally {
    queue.resolve();
    release.resolve();
    await blocker;
    await engine.waitForMaterialDreams();
  }
  const completed = await (await app.request(reopenUrl)).text();
  expect(completed).toContain("提炼已完成");
  expect(completed).toContain("2/2 条原始记录已处理");
  expect(completed).toContain("目前没有知识页引用这份资料");
  await submit();
  expect(engine.listDreamRuns(space)).toHaveLength(1);
  engine.close(); open();
  expect(await (await app.request(reopenUrl)).text()).toContain("提炼已完成");
  await submit();
  expect(engine.listDreamRuns(space)).toHaveLength(0);
});

test("a failed import Dream is visible from the original single-file URL; an explicit retry runs once", async () => {
  const batch = crypto.randomUUID();
  const submit = () => {
    const form = new FormData();
    form.set("materialBatch", batch);
    form.set("distillNow", "on");
    form.set("material", new File(["稍后再处理"], "来源.md"));
    return app.request(root + "/materials", { method: "POST", body: form });
  };
  llm.onJSON(() => { throw new Error("sensitive internal test diagnostic"); });
  const location = (await submit()).headers.get("location")!;
  expect(location).toContain(root + "/raw/local-import-");
  await engine.waitForMaterialDreams();
  const failed = await (await app.request(location)).text();
  expect(failed).toContain("提炼失败");
  expect(failed).not.toContain("sensitive internal");
  await submit();
  expect(engine.listDreamRuns(space)).toHaveLength(1);
  llm.onJSON(opts => ({ operations: [], skippedRawIds: [...(opts.prompt ?? "").matchAll(/<entry id="([^"]+)"/gu)].map(m => m[1]) }));
  const retryPath = /action="([^"]*\/materials\/distill\?[^"]+)"/u.exec(failed)![1]!.replaceAll("&amp;", "&");
  const form = new FormData();
  form.set("after", /name="after" value="([^"]+)"/u.exec(failed)![1]!);
  await Promise.all([1, 2].map(() => app.request(retryPath, { method: "POST", body: form })));
  await engine.waitForMaterialDreams();
  expect(engine.listDreamRuns(space)).toHaveLength(2);
  expect(await (await app.request(location)).text()).toContain("提炼已完成");
});

test("a native partial receipt can be reopened and repaired without sending successful files or distilling them again", async () => {
  const batch = crypto.randomUUID();
  llm.onJSON(opts => ({ operations: [], skippedRawIds: [...(opts.prompt ?? "").matchAll(/<entry id="([^"]+)"/gu)].map(m => m[1]) }));
  const broken = new File(["第二份内容"], "需修复.txt");
  const save = engine.rememberFile.bind(engine);
  const failedWrite = spyOn(engine, "rememberFile").mockImplementation((...args) => {
    if (args[1].attachment.name === broken.name) return Promise.reject(new Error("offline write failure"));
    return save(...args);
  });
  const body = new FormData();
  body.set("distillNow", "on");
  body.set("materialBatch", batch);
  body.append("material", new File(["第一份内容"], "已保存.md"));
  body.append("material", broken);
  const initial = await (await app.request(root + "/materials", { method: "POST", body })).text();
  const url = currentUrl(initial);
  failedWrite.mockRestore();
  await engine.waitForMaterialDreams();
  engine.close(); open();
  const reopened = await (await app.request(url)).text();
  expect(reopened).toContain("已导入 1 份资料，共 2 份");
  const retry = /<form data-material-retry[^>]*>([\s\S]*?)<\/form>/u.exec(reopened)![1]!;
  const native = new FormData();
  for (const [, key, value] of retry.matchAll(/name="([^"]+)" value="([^"]+)"/gu)) native.append(key!, value!);
  native.set("material", broken);
  const repaired = await (await app.request(root + "/materials", { method: "POST", body: native })).text();
  expect(repaired).toContain("已导入 2 份资料，共 2 份");
  expect(repaired).toContain("已保存.md");
  expect(repaired).toContain("需修复.txt");
  await engine.waitForMaterialDreams();
  expect(engine.registry.store(space).index().countRaw()).toBe(2);
  expect(engine.listDreamRuns(space).flatMap(run => run.materialImport?.rawIds)).toHaveLength(1);
});

test("stopping a queued import leaves its Raw available after restart without replaying a Provider call", async () => {
  const release = Promise.withResolvers<void>();
  const blocker = engine.scheduleBackgroundRun("hold-import-until-shutdown", space, () => release.promise);
  const form = new FormData();
  form.set("distillNow", "on");
  form.set("material", new File(["未开始提炼的资料"], "待处理.txt"));
  const location = (await app.request(root + "/materials", { method: "POST", body: form })).headers.get("location")!;
  try {
    await engine.stopMaterialDreams();
    expect(engine.listDreamRuns(space)[0]?.status).toBe("cancelled");
  } finally { release.resolve(); await blocker; }
  engine.close(); open();
  const view = await (await app.request(location)).text();
  expect(view).toContain("等待提炼");
  expect(view).toContain("0/1 条原始记录已处理");
  expect(view).toContain("提炼剩余资料");
  expect(llm.calls).toHaveLength(0);
});

test("task results separate the recorded batch total from live pages citing this Run's Raw", async () => {
  const task = engine.tasks.create({ space, name: "研究", topic: "灰度" })!;
  const rawId = await engine.remember({ space, source: "task", content: "本次报告" });
  const unrelatedId = await engine.remember({ space, source: "manual", content: "同批其他资料" });
  const run = engine.taskRuns.start({ task, trigger: "manual", distill: true });
  engine.taskRuns.begin(run.id);
  engine.taskRuns.succeed(run.id, { rawId, pagesWritten: 2, finishedAt: Date.now(), output: "输出" });
  await cite("concepts/unrelated", [unrelatedId]);
  await cite("concepts/foreign", [rawId], other);
  const route = `/tasks/runs/${run.id}`;
  const empty = await (await app.request(route)).text();
  expect(empty).toContain("本批次提炼共写入知识页：2");
  expect(empty).toContain("目前没有知识页引用本次报告");
  await cite("concepts/linked", [rawId]);
  const body = await (await app.request(route)).text();
  expect(body).toContain(`href="${root}/pages/concepts%2Flinked"`);
  expect(body).toContain("concepts/linked 标题");
  expect(body).not.toContain("concepts/unrelated");
  expect(body).not.toContain("concepts/foreign");
  expect(llm.calls).toHaveLength(0);
});
