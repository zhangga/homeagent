import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Knowledge } from "./knowledge.ts";
import { KnowledgeEngine } from "./engine.ts";
import { FakeLlm } from "./testing.ts";
import type { Page, SpaceId } from "@homeagent/shared";
import { SkillCatalog } from "./skill-catalog.ts";

let dir: string;
let engine: KnowledgeEngine;
const SPACE: SpaceId = "team/oc_contract";

function page(slug: string, title: string, content: string): Page {
  return {
    slug,
    type: "entity",
    title,
    summary: content.slice(0, 30),
    aliases: [],
    tags: [],
    sources: [],
    links: [],
    content,
    updatedAt: Date.now(),
    contentHash: "h",
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hb-engine-"));
  // No real CLI spawns in the contract test: a fake runner returns empty
  // structured results (dream analyze => no operations) and empty text.
  engine = new KnowledgeEngine({
    dataDir: dir,
    runProvider: async (_id, input) => {
      if (/JSON Schema/.test(input.prompt) && /operations/.test(input.prompt)) {
        return JSON.stringify({ operations: [], skippedRawIds: [] });
      }
      return "";
    },
  });
});

afterEach(() => {
  engine.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("Knowledge seam contract", () => {
  test("engine satisfies the Knowledge interface shape", () => {
    // Structural assertion: assigning to the interface type is the contract.
    const k: Knowledge = engine;
    for (const method of [
      "remember",
      "getSpaceGovernance",
      "updateSpaceRules",
      "resetSpaceRule",
      "getRawGovernanceDetail",
      "redistillRaw",
      "deleteKnowledgePage",
      "regenerateKnowledgePage",
      "submitKnowledgeCorrection",
      "retractMessage",
      "runDreamCycle",
      "listQuarantines",
      "retryQuarantine",
      "retryQuarantines",
      "ask",
      "search",
      "getPage",
      "upsertPage",
      "listPages",
      "rebuildIndex",
      "health",
    ]) {
      expect(typeof (k as unknown as Record<string, unknown>)[method]).toBe("function");
    }
  });

  test("remember captures raw without creating pages", async () => {
    const id = await engine.remember({
      space: SPACE,
      source: "message",
      content: "记住：Alice 负责后端服务",
    });
    expect(typeof id).toBe("string");
    // no pages yet (distillation is a separate step)
    expect(await engine.listPages(SPACE)).toEqual([]);
  });

  test("message author can retract a pending capture by chat and message id", async () => {
    await engine.remember({
      space: SPACE,
      source: "message",
      author: "ou_owner",
      chatId: "oc_contract",
      messageId: "om_source",
      content: "测试代号是北极星",
    });

    expect(
      await engine.retractMessage(SPACE, {
        chatId: "oc_contract",
        messageId: "om_source",
        requestedBy: "ou_owner",
      }),
    ).toEqual({ status: "retracted", affectedPages: [], requeuedSourceIds: [] });

    expect(
      await engine.retractMessage(SPACE, {
        chatId: "oc_contract",
        messageId: "om_source",
        requestedBy: "ou_owner",
      }),
    ).toEqual({ status: "already_retracted", affectedPages: [], requeuedSourceIds: [] });
    await engine.remember({
      space: SPACE,
      source: "message",
      author: "ou_owner",
      chatId: "oc_contract",
      messageId: "om_source",
      content: "重投也不能恢复北极星",
    });
    expect((await engine.runDreamCycle(SPACE)).examined).toBe(0);
  });

  test("one user cannot retract another user's captured message", async () => {
    await engine.remember({
      space: SPACE,
      source: "message",
      author: "ou_owner",
      chatId: "oc_contract",
      messageId: "om_source",
      content: "只有作者能撤回",
    });

    expect(
      await engine.retractMessage(SPACE, {
        chatId: "oc_contract",
        messageId: "om_source",
        requestedBy: "ou_other",
      }),
    ).toEqual({ status: "forbidden", affectedPages: [], requeuedSourceIds: [] });
    expect((await engine.runDreamCycle(SPACE)).examined).toBe(1);
  });

  test("group administrator can retract another user's captured message", async () => {
    await engine.remember({
      space: SPACE,
      source: "message",
      author: "ou_owner",
      chatId: "oc_contract",
      messageId: "om_source",
      content: "管理员可以治理群知识",
    });

    expect(
      await engine.retractMessage(SPACE, {
        chatId: "oc_contract",
        messageId: "om_source",
        requestedBy: "ou_admin",
        requesterIsAdmin: true,
      }),
    ).toEqual({ status: "retracted", affectedPages: [], requeuedSourceIds: [] });
    expect((await engine.runDreamCycle(SPACE)).examined).toBe(0);
  });

  test("retraction removes every raw record derived from the same message", async () => {
    for (const source of ["message", "doc"] as const) {
      await engine.remember({
        space: SPACE,
        source,
        author: "ou_owner",
        chatId: "oc_contract",
        messageId: "om_source",
        content: source === "message" ? "见项目文档" : "文档正文",
      });
    }

    expect(
      await engine.retractMessage(SPACE, {
        chatId: "oc_contract",
        messageId: "om_source",
        requestedBy: "ou_owner",
      }),
    ).toEqual({ status: "retracted", affectedPages: [], requeuedSourceIds: [] });
    expect(
      await engine.retractMessage(SPACE, {
        chatId: "oc_contract",
        messageId: "om_source",
        requestedBy: "ou_owner",
      }),
    ).toEqual({ status: "already_retracted", affectedPages: [], requeuedSourceIds: [] });
    expect((await engine.runDreamCycle(SPACE)).examined).toBe(0);
  });

  test("retracting an ingested source removes affected pages and requeues surviving sources", async () => {
    const fake = new FakeLlm();
    const retractEngine = new KnowledgeEngine({ dataDir: join(dir, "retraction"), llm: fake });
    const removedId = await retractEngine.remember({
      space: SPACE,
      source: "message",
      author: "ou_owner",
      chatId: "oc_contract",
      messageId: "om_remove",
      content: "项目代号是北极星",
    });
    const survivingId = await retractEngine.remember({
      space: SPACE,
      source: "message",
      author: "ou_owner",
      chatId: "oc_contract",
      messageId: "om_keep",
      content: "项目负责人是 Alice",
    });
    fake.queueJSON({
      operations: [
        {
          type: "concept",
          name: "project-facts",
          title: "项目信息",
          rawIds: [removedId, survivingId],
        },
      ],
      skippedRawIds: [],
    });
    fake.queueJSON({
      title: "项目信息",
      summary: "项目代号与负责人",
      aliases: [],
      tags: [],
      links: [],
      content: "# 项目信息\n项目代号是北极星，负责人是 Alice。",
    });
    await retractEngine.runDreamCycle(SPACE);
    expect(await retractEngine.getPage(SPACE, "concepts/project-facts")).not.toBeNull();

    expect(
      await retractEngine.retractMessage(SPACE, {
        chatId: "oc_contract",
        messageId: "om_remove",
        requestedBy: "ou_owner",
      }),
    ).toEqual({
      status: "retracted",
      affectedPages: ["concepts/project-facts"],
      requeuedSourceIds: [survivingId],
    });
    expect(await retractEngine.getPage(SPACE, "concepts/project-facts")).toBeNull();

    fake.queueJSON({ operations: [], skippedRawIds: [survivingId] });
    expect((await retractEngine.runDreamCycle(SPACE)).examined).toBe(1);
    retractEngine.close();
  });

  test("retracting a quarantined source clears the stale failure and requeues surviving sources", async () => {
    engine.close();
    const fake = new FakeLlm();
    engine = new KnowledgeEngine({ dataDir: dir, llm: fake });
    const removedId = await engine.remember({
      space: SPACE,
      source: "message",
      author: "ou_owner",
      chatId: "oc_contract",
      messageId: "om_quarantined_remove",
      content: "撤回这条失败来源",
    });
    const survivingId = await engine.remember({
      space: SPACE,
      source: "message",
      author: "ou_owner",
      chatId: "oc_contract",
      messageId: "om_quarantined_keep",
      content: "保留并重新提炼这条来源",
    });
    fake.queueJSON({
      operations: [
        {
          type: "concept",
          name: "quarantined-retraction",
          title: "Quarantined Retraction",
          rawIds: [removedId, survivingId],
        },
      ],
      skippedRawIds: [],
    });
    fake.queueJSON({ title: "Quarantined Retraction", summary: "", content: "" });
    await engine.runDreamCycle(SPACE);
    expect(await engine.listQuarantines(SPACE)).toHaveLength(1);

    expect(
      await engine.retractMessage(SPACE, {
        chatId: "oc_contract",
        messageId: "om_quarantined_remove",
        requestedBy: "ou_owner",
      }),
    ).toEqual({
      status: "retracted",
      affectedPages: [],
      requeuedSourceIds: [survivingId],
    });
    expect(await engine.listQuarantines(SPACE)).toEqual([]);

    fake.queueJSON({ operations: [], skippedRawIds: [survivingId] });
    expect((await engine.runDreamCycle(SPACE)).examined).toBe(1);
  });

  test("upsertPage writes markdown file and is searchable", async () => {
    await engine.upsertPage(SPACE, page("entities/alice", "Alice", "Alice 负责后端服务"));
    // markdown file exists on disk
    const store = engine.registry.store(SPACE);
    expect(existsSync(join(store.wikiDir, "entities/alice.md"))).toBe(true);
    // searchable by 2-char Chinese query
    const hits = await engine.search([SPACE], "后端");
    expect(hits.map((h) => h.slug)).toEqual(["entities/alice"]);
    // retrievable
    const got = await engine.getPage(SPACE, "entities/alice");
    expect(got?.title).toBe("Alice");
  });

  test("search unions across spaces", async () => {
    const other: SpaceId = "personal/ou_me";
    await engine.upsertPage(SPACE, page("entities/a", "A", "关于缓存策略"));
    await engine.upsertPage(other, page("entities/b", "B", "另一个缓存话题"));
    const hits = await engine.search([SPACE, other], "缓存");
    expect(hits.length).toBe(2);
  });

  test("search/getPage on unknown space is empty, not an error", async () => {
    expect(await engine.search(["team/nope"], "x")).toEqual([]);
    expect(await engine.getPage("team/nope", "s")).toBeNull();
    expect(await engine.listPages("team/nope")).toEqual([]);
  });

  test("rebuildIndex reconstructs the DB from markdown files", async () => {
    await engine.upsertPage(SPACE, page("entities/alice", "Alice", "负责后端服务"));
    const store = engine.registry.store(SPACE);
    // Corrupt the DB by deleting the row directly, then rebuild from md.
    store.index().deletePage("entities/alice");
    expect(await engine.getPage(SPACE, "entities/alice")).toBeNull();
    const res = await engine.rebuildIndex(SPACE);
    expect(res.rebuilt).toBe(1);
    expect(res.corrupt).toEqual([]);
    expect(await engine.getPage(SPACE, "entities/alice")).not.toBeNull();
  });

  test("dream cycle stub is callable and returns a report", async () => {
    await engine.remember({ space: SPACE, source: "message", content: "x" });
    const report = await engine.runDreamCycle(SPACE);
    expect(report.space).toBe(SPACE);
    expect(typeof report.finishedAt).toBe("number");
  });

  test("quarantined distillations are visible through the knowledge seam", async () => {
    engine.close();
    const fake = new FakeLlm();
    engine = new KnowledgeEngine({ dataDir: dir, llm: fake });
    const rawId = await engine.remember({
      space: SPACE,
      source: "message",
      content: "需要恢复的提炼内容",
    });
    fake.queueJSON({
      operations: [{ type: "concept", name: "retry-me", title: "Retry Me", rawIds: [rawId] }],
      skippedRawIds: [],
    });
    fake.queueJSON({ title: "Retry Me", summary: "", content: "   " });

    expect((await engine.runDreamCycle(SPACE)).pagesQuarantined).toBe(1);
    expect(await engine.listQuarantines(SPACE)).toEqual([
      expect.objectContaining({
        id: expect.any(String),
        space: SPACE,
        slug: "concepts/retry-me",
        rawIds: [rawId],
        error: expect.stringContaining("empty content"),
        createdAt: expect.any(Number),
      }),
    ]);
  });

  test("a quarantined distillation can be retried without processing unrelated raw", async () => {
    engine.close();
    const fake = new FakeLlm();
    engine = new KnowledgeEngine({ dataDir: dir, llm: fake });
    const rawId = await engine.remember({
      space: SPACE,
      source: "message",
      content: "恢复后应该生成知识页",
    });
    await engine.remember({
      space: SPACE,
      source: "message",
      content: "不属于本次恢复的另一条原始记录",
    });
    fake.queueJSON({
      operations: [{ type: "concept", name: "retry-me", title: "Retry Me", rawIds: [rawId] }],
      skippedRawIds: [],
    });
    fake.queueJSON({ title: "Retry Me", summary: "", content: "   " });
    await engine.runDreamCycle(SPACE, { rawIds: [rawId] });
    const record = (await engine.listQuarantines(SPACE))[0]!;

    fake.queueJSON({
      operations: [{ type: "concept", name: "retry-me", title: "Retry Me", rawIds: [rawId] }],
      skippedRawIds: [],
    });
    fake.queueJSON({
      title: "Retry Me",
      summary: "恢复成功",
      aliases: [],
      tags: [],
      links: [],
      content: "# Retry Me\n\n恢复成功。\n",
    });

    const result = await engine.retryQuarantine(SPACE, record.id);
    expect(result.status).toBe("recovered");
    expect(result.report?.examined).toBe(1);
    expect(await engine.listQuarantines(SPACE)).toEqual([]);
    expect(await engine.getPage(SPACE, "concepts/retry-me")).not.toBeNull();
    expect(engine.registry.store(SPACE).index().countRaw(true)).toBe(1);
  });

  test("an analysis failure keeps the quarantine and returns a fixed public reason", async () => {
    engine.close();
    const fake = new FakeLlm();
    engine = new KnowledgeEngine({ dataDir: dir, llm: fake });
    const rawId = await engine.remember({ space: SPACE, source: "message", content: "分析重试失败" });
    fake.queueJSON({
      operations: [{ type: "concept", name: "analysis-failure", title: "Failure", rawIds: [rawId] }],
      skippedRawIds: [],
    });
    fake.queueJSON({ title: "Failure", summary: "", content: "" });
    await engine.runDreamCycle(SPACE);
    const record = (await engine.listQuarantines(SPACE))[0]!;
    fake.onJSON(() => {
      throw new Error("private provider detail");
    });

    const result = await engine.retryQuarantine(SPACE, record.id);

    expect(result.status).toBe("failed");
    expect(result.reason).toBe("重试未完成，原隔离记录已保留");
    expect(result.reason).not.toContain("private provider detail");
    expect((await engine.listQuarantines(SPACE)).map((item) => item.id)).toEqual([record.id]);
  });

  test("a missing source keeps the quarantine and returns a fixed public reason", async () => {
    engine.close();
    const fake = new FakeLlm();
    engine = new KnowledgeEngine({ dataDir: dir, llm: fake });
    const rawId = await engine.remember({ space: SPACE, source: "message", content: "来源稍后丢失" });
    fake.queueJSON({
      operations: [{ type: "concept", name: "missing-source", title: "Missing", rawIds: [rawId] }],
      skippedRawIds: [],
    });
    fake.queueJSON({ title: "Missing", summary: "", content: "" });
    await engine.runDreamCycle(SPACE);
    const record = (await engine.listQuarantines(SPACE))[0]!;
    engine.registry.store(SPACE).index().deleteRaw(rawId);

    expect(await engine.retryQuarantine(SPACE, record.id)).toEqual({
      status: "failed",
      id: record.id,
      reason: "部分原始来源已不存在，无法安全重试",
    });
    expect((await engine.listQuarantines(SPACE)).map((item) => item.id)).toEqual([record.id]);
  });

  test("a retry that fails generation replaces the old record with fresh evidence", async () => {
    engine.close();
    const fake = new FakeLlm();
    engine = new KnowledgeEngine({ dataDir: dir, llm: fake });
    const rawId = await engine.remember({ space: SPACE, source: "message", content: "仍会失败" });
    const analyze = {
      operations: [{ type: "concept", name: "still-bad", title: "Still Bad", rawIds: [rawId] }],
      skippedRawIds: [],
    };
    fake.queueJSON(analyze).queueJSON({ title: "Still Bad", summary: "", content: "" });
    await engine.runDreamCycle(SPACE);
    const original = (await engine.listQuarantines(SPACE))[0]!;

    fake.queueJSON(analyze).queueJSON({ title: "Still Bad", summary: "", content: "" });
    const result = await engine.retryQuarantine(SPACE, original.id);
    const remaining = await engine.listQuarantines(SPACE);

    expect(result.status).toBe("failed");
    expect(result.reason).toContain("新的失败记录");
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).not.toBe(original.id);
    expect(remaining[0]?.rawIds).toEqual([rawId]);
  });

  test("batch retry attempts the current quarantine snapshot once", async () => {
    engine.close();
    const fake = new FakeLlm();
    engine = new KnowledgeEngine({ dataDir: dir, llm: fake });
    const first = await engine.remember({ space: SPACE, source: "message", content: "first" });
    const second = await engine.remember({ space: SPACE, source: "message", content: "second" });
    fake.queueJSON({
      operations: [
        { type: "concept", name: "first", title: "First", rawIds: [first] },
        { type: "concept", name: "second", title: "Second", rawIds: [second] },
      ],
      skippedRawIds: [],
    });
    fake.queueJSON({ title: "First", summary: "", content: "" });
    fake.queueJSON({ title: "Second", summary: "", content: "" });
    await engine.runDreamCycle(SPACE);
    expect(await engine.listQuarantines(SPACE)).toHaveLength(2);
    fake.onJSON((options) => {
      const rawIds = [first, second].filter((id) => options.prompt?.includes(id));
      return { operations: [], skippedRawIds: rawIds };
    });

    expect(await engine.retryQuarantines(SPACE)).toEqual(expect.objectContaining({
      total: 2,
      recovered: 2,
      failed: 0,
    }));
    expect(await engine.listQuarantines(SPACE)).toEqual([]);
  });

  test("legacy and malformed quarantine files remain visible", async () => {
    engine.ensureSpace(SPACE);
    const quarantineDir = join(engine.registry.store(SPACE).root, "quarantine");
    mkdirSync(quarantineDir, { recursive: true });
    writeFileSync(join(quarantineDir, "concepts__中文知识-123.json"), JSON.stringify({
      slug: "concepts/legacy",
      error: "Error: old timeout",
      rawIds: ["raw-old"],
      at: "2026-07-13T19:15:40.696Z",
    }));
    writeFileSync(join(quarantineDir, "broken-record.json"), "{broken");
    const outsideRecord = join(dir, "outside-quarantine.json");
    writeFileSync(outsideRecord, JSON.stringify({
      slug: "concepts/outside",
      error: "must not be read",
      rawIds: ["raw-outside"],
      at: "2026-07-14T19:15:40.696Z",
    }));
    symlinkSync(outsideRecord, join(quarantineDir, "linked-record.json"));

    const records = await engine.listQuarantines(SPACE);
    expect(records).toHaveLength(2);
    expect(records).toContainEqual(expect.objectContaining({
      id: "concepts__中文知识-123",
      slug: "concepts/legacy",
      error: "Error: old timeout",
      rawIds: ["raw-old"],
      createdAt: Date.parse("2026-07-13T19:15:40.696Z"),
    }));
    expect(records).toContainEqual(expect.objectContaining({
      id: "broken-record",
      slug: "（损坏的隔离记录）",
      rawIds: [],
    }));
  });

  test("raw retention preserves sources needed to recover a quarantine", async () => {
    engine.close();
    const fake = new FakeLlm();
    engine = new KnowledgeEngine({ dataDir: dir, llm: fake });
    const createdAt = Date.now();
    const rawId = await engine.remember({
      space: SPACE,
      source: "message",
      content: "隔离来源不能被清理",
      createdAt,
    });
    fake.queueJSON({
      operations: [{ type: "concept", name: "protected", title: "Protected", rawIds: [rawId] }],
      skippedRawIds: [],
    });
    fake.queueJSON({ title: "Protected", summary: "", content: "" });
    await engine.runDreamCycle(SPACE);

    const report = await engine.pruneRawMessages(1, createdAt + 2 * 86_400_000);
    expect(report.deleted).toBe(0);
    expect(engine.registry.store(SPACE).index().listRawByIds([rawId])).toHaveLength(1);
    expect(await engine.listQuarantines(SPACE)).toHaveLength(1);
  });

  test("health reports CLI execution success and failure without probing the old gateway", async () => {
    const healthEngine = new KnowledgeEngine({
      dataDir: join(dir, "health"),
      runProvider: async (_provider, input) => {
        if (input.prompt.includes("失败主题")) throw new Error("CLI authentication failed");
        return "研究结果";
      },
    });
    healthEngine.ensureSpace(SPACE);
    const agent = healthEngine.agents.create({ name: "Codex", provider: "codex" });
    healthEngine.registry.updateMeta(SPACE, { agentId: agent.id });
    const successful = healthEngine.tasks.create({
      name: "成功任务",
      space: SPACE,
      topic: "成功主题",
      distillOnRun: false,
    })!;
    const failed = healthEngine.tasks.create({
      name: "失败任务",
      space: SPACE,
      topic: "失败主题",
      distillOnRun: false,
    })!;

    await healthEngine.runTask(successful.id);
    await healthEngine.runTask(failed.id);
    const report = await healthEngine.health();
    const providerRuns = report.details?.providerRuns as Array<Record<string, unknown>>;
    const tasks = report.details?.tasks as Array<Record<string, unknown>>;

    expect(report.ok).toBe(true);
    expect(report.details?.mode).toBe("cli-only");
    expect(providerRuns).toEqual([
      expect.objectContaining({
        provider: "codex",
        running: 0,
        lastStatus: "error",
        lastSuccessAt: expect.any(Number),
        lastFailureAt: expect.any(Number),
        lastError: "Error: CLI authentication failed",
      }),
    ]);
    expect(tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: successful.id, running: false, lastStatus: "ok" }),
        expect.objectContaining({
          id: failed.id,
          running: false,
          lastStatus: "error",
          lastError: "Error: CLI authentication failed",
        }),
      ]),
    );
    healthEngine.close();
  });

  test("health reports the latest dream-cycle outcome for each space", async () => {
    await engine.remember({ space: SPACE, source: "message", content: "待提炼知识" });
    await engine.runDreamCycle(SPACE);

    const report = await engine.health();
    expect(report.details?.dreamCycles).toEqual([
      expect.objectContaining({
        space: SPACE,
        running: false,
        lastStatus: "ok",
        lastSuccessAt: expect.any(Number),
        lastExamined: 1,
      }),
    ]);
  });

  test("a task rejects a second run while its first run is active", async () => {
    const completions: Array<(value: string) => void> = [];
    const healthEngine = new KnowledgeEngine({
      dataDir: join(dir, "concurrent-health"),
      runProvider: async () => new Promise<string>((resolve) => completions.push(resolve)),
    });
    healthEngine.ensureSpace(SPACE);
    const task = healthEngine.tasks.create({ name: "并发任务", space: SPACE, topic: "并发" })!;

    const first = healthEngine.startTaskRun(task.id, { distill: false });
    expect(() => healthEngine.startTaskRun(task.id, { distill: false })).toThrow(
      `task already running: ${task.id} (${first.run.id})`,
    );
    expect(completions).toHaveLength(1);

    let tasks = (await healthEngine.health()).details?.tasks as Array<Record<string, unknown>>;
    expect(tasks[0]?.running).toBe(true);
    expect(tasks[0]?.activeRunId).toBe(first.run.id);

    completions[0]!("第一次完成");
    await first.completion;
    tasks = (await healthEngine.health()).details?.tasks as Array<Record<string, unknown>>;
    expect(tasks[0]?.running).toBe(false);
    healthEngine.close();
  });

  test("task setup failures become durable failed runs and clear running health", async () => {
    const healthEngine = new KnowledgeEngine({
      dataDir: join(dir, "setup-failure-health"),
      runProvider: async () => "unused",
    });
    healthEngine.ensureSpace(SPACE);
    const task = healthEngine.tasks.create({ name: "失败任务", space: SPACE, topic: "失败" })!;
    healthEngine.agentForSpace = () => {
      throw new Error("agent store unavailable");
    };

    const report = await healthEngine.runTask(task.id, { distill: false });
    expect(report.ok).toBe(false);
    expect(healthEngine.getTaskRun(report.runId)).toEqual(expect.objectContaining({
      status: "failed",
      error: "Error: agent store unavailable",
    }));
    const tasks = (await healthEngine.health()).details?.tasks as Array<Record<string, unknown>>;
    expect(tasks[0]?.running).toBe(false);
    healthEngine.close();
  });

  test("space scaffold seeds purpose.md and schema.md", async () => {
    await engine.upsertPage(SPACE, page("entities/a", "A", "x"));
    const store = engine.registry.store(SPACE);
    expect(existsSync(join(store.root, "purpose.md"))).toBe(true);
    expect(existsSync(join(store.root, "schema.md"))).toBe(true);
  });

  test("space Agent assignment enforces visibility and agentForSpace remains fail-safe", () => {
    const personalSpace: SpaceId = "personal/ou_contract";
    engine.ensureSpace(SPACE);
    engine.ensureSpace(personalSpace);
    const teamAgent = engine.agents.create({ name: "群助手", visibility: "Team" });
    const personalAgent = engine.agents.create({ name: "个人助手", visibility: "Personal" });

    expect(() => engine.updateSpaceMeta(SPACE, { agentId: personalAgent.id }))
      .toThrow("Agent Visibility");
    expect(() => engine.updateSpaceMeta(personalSpace, { agentId: teamAgent.id }))
      .toThrow("Agent Visibility");
    expect(() => engine.updateSpaceMeta(SPACE, { agentId: "agent_missing" }))
      .toThrow("Agent Visibility");

    engine.updateSpaceMeta(SPACE, { agentId: teamAgent.id });
    engine.updateSpaceMeta(personalSpace, { agentId: personalAgent.id });
    expect(engine.agentForSpace(SPACE)?.id).toBe(teamAgent.id);
    expect(engine.agentForSpace(personalSpace)?.id).toBe(personalAgent.id);

    // Archive recovery and other low-level compatibility paths can still
    // restore stale metadata; runtime lookup must never expose it.
    engine.registry.updateMeta(SPACE, { agentId: personalAgent.id });
    engine.registry.updateMeta(personalSpace, { agentId: teamAgent.id });
    expect(engine.agentForSpace(SPACE)).toBeUndefined();
    expect(engine.agentForSpace(personalSpace)).toBeUndefined();
  });

  test("an Agent cannot change visibility while incompatible spaces are bound", () => {
    engine.ensureSpace(SPACE);
    const agent = engine.agents.create({ name: "群助手", visibility: "Team" });
    engine.updateSpaceMeta(SPACE, { agentId: agent.id });

    expect(() => engine.updateAgent(agent.id, { visibility: "Personal" }))
      .toThrow("先解除");
    expect(engine.agents.get(agent.id)?.visibility).toBe("Team");
    expect(engine.registry.get(SPACE)?.agentId).toBe(agent.id);
  });

  test("deleting an Agent clears every binding before removing it", () => {
    const personalSpace: SpaceId = "personal/ou_delete_agent";
    engine.ensureSpace(SPACE);
    engine.ensureSpace(personalSpace);
    const agent = engine.agents.create({ name: "待删除助手", visibility: "Team" });
    engine.registry.updateMeta(SPACE, { agentId: agent.id });
    engine.registry.updateMeta(personalSpace, { agentId: agent.id });

    const result = engine.removeAgentAndUnbind(agent.id);

    expect(result?.bindings.map((space) => space.id).sort()).toEqual([
      personalSpace,
      SPACE,
    ]);
    expect(engine.agents.has(agent.id)).toBe(false);
    expect(engine.registry.get(SPACE)?.agentId).toBeUndefined();
    expect(engine.registry.get(personalSpace)?.agentId).toBeUndefined();
  });

  test("an Agent is preserved when clearing its bindings fails", () => {
    engine.ensureSpace(SPACE);
    const agent = engine.agents.create({ name: "保留助手", visibility: "Team" });
    engine.updateSpaceMeta(SPACE, { agentId: agent.id });
    engine.registry.clearAgentBindings = () => {
      throw new Error("registry unavailable");
    };

    expect(() => engine.removeAgentAndUnbind(agent.id)).toThrow("registry unavailable");
    expect(engine.agents.has(agent.id)).toBe(true);
    expect(engine.registry.get(SPACE)?.agentId).toBe(agent.id);
  });

  test("an Agent deletion can be retried after its bindings were already cleared", () => {
    engine.ensureSpace(SPACE);
    const agent = engine.agents.create({ name: "可重试删除", visibility: "Team" });
    engine.updateSpaceMeta(SPACE, { agentId: agent.id });
    const persist = (engine.agents as unknown as {
      persist: (agents?: unknown) => void;
    }).persist.bind(engine.agents);
    Object.defineProperty(engine.agents, "persist", {
      configurable: true,
      value: () => {
        throw new Error("agent store unavailable");
      },
    });

    expect(() => engine.removeAgentAndUnbind(agent.id)).toThrow("agent store unavailable");
    expect(engine.registry.get(SPACE)?.agentId).toBeUndefined();
    expect(engine.agents.has(agent.id)).toBe(true);

    Object.defineProperty(engine.agents, "persist", {
      configurable: true,
      value: persist,
    });
    expect(engine.removeAgentAndUnbind(agent.id)?.bindings).toEqual([]);
    expect(engine.agents.has(agent.id)).toBe(false);
  });

  test("runTask: research output is captured as a raw 'task' entry + lastRun recorded", async () => {
    // A dedicated engine whose CLI runner returns research text for the task.
    const taskEngine = new KnowledgeEngine({
      dataDir: dir,
      runProvider: async (_id, input) => {
        if (/研究/.test(input.prompt)) return "要点一：...\n要点二：...";
        return "";
      },
    });
    taskEngine.ensureSpace(SPACE);
    const task = taskEngine.tasks.create({ name: "调研", space: SPACE, topic: "大模型 Agent 进展" })!;
    // distill:false keeps this test focused on capture (no dream calls)
    const report = await taskEngine.runTask(task.id, { distill: false });
    expect(report.ok).toBe(true);
    expect(report.summary).toContain("要点一");
    // captured as a raw entry with source "task"
    const raws = taskEngine.registry.store(SPACE).index().listRaw({});
    expect(raws.some((r) => r.source === "task" && r.content.includes("要点一"))).toBe(true);
    // lastRun recorded on the task
    expect(taskEngine.tasks.get(task.id)?.lastStatus).toBe("ok");
    taskEngine.close();
  });

  test("runTask passes the assigned Agent execution contract to the provider", async () => {
    const workdir = join(dir, "task-workspace");
    mkdirSync(workdir);
    const skillRoot = join(dir, "task-skills");
    for (const name of ["code-review", "github-yeet"]) {
      mkdirSync(join(skillRoot, name), { recursive: true });
      writeFileSync(
        join(skillRoot, name, "SKILL.md"),
        ["---", `name: ${name}`, `description: ${name}.`, "---"].join("\n"),
        "utf8",
      );
    }
    let execution: unknown;
    const taskEngine = new KnowledgeEngine({
      dataDir: dir,
      skillCatalog: new SkillCatalog({
        roots: [{
          kind: "shared-agents",
          path: skillRoot,
          providerIds: ["claude", "codex", "trae-cli"],
        }],
      }),
      runProvider: async (_id, input) => {
        execution = input.execution;
        return "已按 Agent 配置执行";
      },
    });
    taskEngine.ensureSpace(SPACE);
    const agent = taskEngine.agents.create({
      name: "执行助手",
      permission: "write",
      workdir,
      skills: [
        {
          kind: "source",
          sourceKey: "shared-agents:code-review",
          name: "code-review",
        },
        {
          kind: "source",
          sourceKey: "shared-agents:github-yeet",
          name: "github-yeet",
        },
      ],
    });
    taskEngine.registry.updateMeta(SPACE, { agentId: agent.id });
    const task = taskEngine.tasks.create({
      name: "按配置运行",
      space: SPACE,
      topic: "检查项目",
      distillOnRun: false,
    })!;

    const report = await taskEngine.runTask(task.id);
    const storedRun = taskEngine.getTaskRun(report.runId);
    taskEngine.close();

    expect(report.status).toBe("succeeded");
    expect(execution).toEqual({
      permission: "write",
      workdir: realpathSync(workdir),
      skills: ["code-review", "github-yeet"],
    });
    expect(storedRun?.skillEvidence).toEqual({
      requested: [
        {
          kind: "source",
          sourceKey: "shared-agents:code-review",
          name: "code-review",
        },
        {
          kind: "source",
          sourceKey: "shared-agents:github-yeet",
          name: "github-yeet",
        },
      ],
      resolved: [
        expect.objectContaining({
          sourceKey: "shared-agents:code-review",
          name: "code-review",
          invocationName: "code-review",
          skillFileHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
        expect.objectContaining({
          sourceKey: "shared-agents:github-yeet",
          name: "github-yeet",
          invocationName: "github-yeet",
          skillFileHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      ],
      skipped: [],
    });
  });

  test("ordinary Agent calls load resolved Skills but stay read-only without a Workdir", async () => {
    const skillRoot = join(dir, "skills");
    mkdirSync(join(skillRoot, "review"), { recursive: true });
    writeFileSync(
      join(skillRoot, "review", "SKILL.md"),
      ["---", "name: review", "description: Review.", "---"].join("\n"),
      "utf8",
    );
    const workdir = join(dir, "ordinary-workspace");
    mkdirSync(workdir);
    let execution: unknown;
    const taskEngine = new KnowledgeEngine({
      dataDir: dir,
      skillCatalog: new SkillCatalog({
        roots: [{ kind: "codex-user", path: skillRoot, providerIds: ["codex"] }],
      }),
      runProvider: async (_id, input) => {
        execution = input.execution;
        return "ok";
      },
    });
    taskEngine.ensureSpace(SPACE);
    const agent = taskEngine.agents.create({
      name: "bound",
      provider: "codex",
      permission: "full",
      workdir,
      skills: [{
        kind: "source",
        sourceKey: "codex-user:review",
        name: "review",
      }],
    });
    taskEngine.registry.updateMeta(SPACE, { agentId: agent.id });

    await taskEngine.llmClientForSpace(SPACE).complete({ prompt: "hello" });
    taskEngine.close();

    expect(execution).toEqual({
      permission: "read-only",
      skills: ["review"],
    });
  });

  test("ask continues with the base Agent and returns a safe warning when a Skill disappears", async () => {
    const skillRoot = join(dir, "warning-skills");
    const skillDir = join(skillRoot, "review");
    mkdirSync(skillDir, { recursive: true });
    const skillFile = join(skillDir, "SKILL.md");
    writeFileSync(
      skillFile,
      ["---", "name: review", "description: Review.", "---"].join("\n"),
      "utf8",
    );
    const taskEngine = new KnowledgeEngine({
      dataDir: dir,
      skillCatalog: new SkillCatalog({
        roots: [{ kind: "codex-user", path: skillRoot, providerIds: ["codex"] }],
      }),
      runProvider: async () => "base answer",
    });
    taskEngine.ensureSpace(SPACE);
    const agent = taskEngine.agents.create({
      name: "bound",
      provider: "codex",
      skills: [{
        kind: "source",
        sourceKey: "codex-user:review",
        name: "review",
      }],
    });
    taskEngine.registry.updateMeta(SPACE, { agentId: agent.id });
    rmSync(skillFile);

    const result = await taskEngine.ask([SPACE], "hello");
    taskEngine.close();

    expect(result.answer).toBe("base answer");
    expect(result.skillWarnings).toEqual([{
      name: "review",
      code: "missing_source",
      message: "Skill 当前不可用，已跳过",
    }]);
  });

  test("runTask records the Agent provider and model used for execution", async () => {
    let executedProvider: string | undefined;
    let executedModel: string | undefined;
    const taskEngine = new KnowledgeEngine({
      dataDir: dir,
      runProvider: async (provider, input) => {
        executedProvider = provider;
        executedModel = input.model;
        return "已记录执行快照";
      },
    });
    taskEngine.ensureSpace(SPACE);
    const agent = taskEngine.agents.create({
      name: "Codex 执行助手",
      provider: "codex",
      model: "gpt-5.6-luna",
    });
    taskEngine.registry.updateMeta(SPACE, { agentId: agent.id });
    const task = taskEngine.tasks.create({
      name: "记录执行信息",
      space: SPACE,
      topic: "检查执行快照",
      distillOnRun: false,
    })!;

    const report = await taskEngine.runTask(task.id);
    const run = taskEngine.getTaskRun(report.runId);

    expect(run).toEqual(expect.objectContaining({
      agentId: agent.id,
      provider: "codex",
      model: "gpt-5.6-luna",
    }));
    expect(executedProvider).toBe(run?.provider);
    expect(executedModel).toBe(run?.model);
    taskEngine.close();
  });

  test("runTask does not start a writable provider without a valid Workdir", async () => {
    let providerCalls = 0;
    const taskEngine = new KnowledgeEngine({
      dataDir: dir,
      runProvider: async () => {
        providerCalls += 1;
        return "不应执行";
      },
    });
    taskEngine.ensureSpace(SPACE);
    const agent = taskEngine.agents.create({
      name: "危险配置",
      permission: "full",
    });
    taskEngine.registry.updateMeta(SPACE, { agentId: agent.id });
    const task = taskEngine.tasks.create({
      name: "拒绝运行",
      space: SPACE,
      topic: "没有工作目录",
      distillOnRun: false,
    })!;

    const report = await taskEngine.runTask(task.id);

    expect(report.status).toBe("failed");
    expect(report.error).toContain("必须配置 Workdir");
    expect(providerCalls).toBe(0);
    taskEngine.close();
  });

  test("runTask: immediate distillation turns the research into a wiki page", async () => {
    // Runner serves both the research (text) and the dream steps (JSON schemas).
    let engineRef: KnowledgeEngine | undefined;
    const taskEngine: KnowledgeEngine = new KnowledgeEngine({
      dataDir: dir,
      runProvider: async (_id, input): Promise<string> => {
        const p = input.prompt;
        if (/JSON Schema/.test(p) && /operations/.test(p)) {
          // analyze: one create op referencing the pending raw id
          const rawId = engineRef?.registry.store(SPACE).index().listRaw({ onlyPending: true })[0]?.id ?? "r1";
          return JSON.stringify({
            operations: [{ type: "concept", name: "agent-tasks", title: "Agent 任务", rawIds: [rawId] }],
            skippedRawIds: [],
          });
        }
        if (/JSON Schema/.test(p)) {
          // generate: the page body
          return JSON.stringify({ title: "Agent 任务", summary: "研究要点", aliases: [], tags: [], links: [], content: "# Agent 任务\n研究要点。\n" });
        }
        return "研究要点：任务系统很有用。";
      },
    });
    engineRef = taskEngine;
    taskEngine.ensureSpace(SPACE);
    const task = taskEngine.tasks.create({ name: "调研", space: SPACE, topic: "agent tasks" })!;
    const report = await taskEngine.runTask(task.id); // distill on by default
    expect(report.ok).toBe(true);
    expect(report.pagesWritten).toBeGreaterThan(0);
    expect(await taskEngine.getPage(SPACE, "concepts/agent-tasks")).not.toBeNull();
    taskEngine.close();
  });

  test("runTask: distillOnRun=false captures raw but writes no page immediately", async () => {
    let calls = 0;
    const taskEngine = new KnowledgeEngine({
      dataDir: dir,
      runProvider: async () => { calls++; return "研究结论内容"; },
    });
    taskEngine.ensureSpace(SPACE);
    const task = taskEngine.tasks.create({ name: "no-distill", space: SPACE, topic: "x", distillOnRun: false })!;
    const report = await taskEngine.runTask(task.id);
    expect(report.ok).toBe(true);
    expect(report.pagesWritten).toBeUndefined();
    // raw captured, but no distillation LLM calls beyond the single research call
    expect(taskEngine.registry.store(SPACE).index().listRaw({}).some((r) => r.source === "task")).toBe(true);
    expect(calls).toBe(1);
    taskEngine.close();
  });

  test("task runs expose an id immediately and persist their completed output", async () => {
    let finishResearch: ((value: string) => void) | undefined;
    const taskEngine = new KnowledgeEngine({
      dataDir: dir,
      runProvider: async () => new Promise<string>((resolve) => {
        finishResearch = resolve;
      }),
    });
    taskEngine.ensureSpace(SPACE);
    const task = taskEngine.tasks.create({
      name: "持久化运行",
      space: SPACE,
      topic: "记录执行结果",
      distillOnRun: false,
    })!;

    const started = taskEngine.startTaskRun(task.id);
    expect(started.run).toEqual(expect.objectContaining({
      id: expect.stringMatching(/^run_/),
      taskId: task.id,
      status: "running",
      trigger: "manual",
    }));
    expect(taskEngine.getTaskRun(started.run.id)?.status).toBe("running");

    finishResearch?.("完整研究输出");
    const report = await started.completion;
    expect(report.runId).toBe(started.run.id);
    expect(report.ok).toBe(true);
    taskEngine.close();

    const reopened = new KnowledgeEngine({ dataDir: dir, runProvider: async () => "" });
    expect(reopened.getTaskRun(started.run.id)).toEqual(expect.objectContaining({
      status: "succeeded",
      output: "完整研究输出",
      summary: "完整研究输出",
      finishedAt: expect.any(Number),
    }));
    reopened.close();
  });

  test("an active task run can be cancelled and records a durable cancelled outcome", async () => {
    let providerSignal: AbortSignal | undefined;
    const taskEngine = new KnowledgeEngine({
      dataDir: dir,
      runProvider: async (_provider, _input, _timeoutMs, signal) => {
        providerSignal = signal;
        return new Promise<string>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    });
    taskEngine.ensureSpace(SPACE);
    const task = taskEngine.tasks.create({
      name: "可取消任务",
      space: SPACE,
      topic: "等待取消",
      distillOnRun: false,
    })!;

    const started = taskEngine.startTaskRun(task.id);
    expect(taskEngine.cancelTaskRun(started.run.id)).toBe(true);
    const report = await started.completion;

    expect(providerSignal?.aborted).toBe(true);
    expect(report).toEqual(expect.objectContaining({
      runId: started.run.id,
      ok: false,
      status: "cancelled",
      error: "任务已由用户取消",
    }));
    expect(taskEngine.getTaskRun(started.run.id)).toEqual(expect.objectContaining({
      status: "cancelled",
      error: "任务已由用户取消",
      finishedAt: expect.any(Number),
    }));
    taskEngine.close();
  });

  test("a task that exceeds its configured timeout is terminated and can be retried", async () => {
    let attempts = 0;
    let timedOutSignal: AbortSignal | undefined;
    const taskEngine = new KnowledgeEngine({
      dataDir: dir,
      runProvider: async (_provider, _input, _timeoutMs, signal) => {
        attempts += 1;
        if (attempts > 1) return "超时后的重试结果";
        timedOutSignal = signal;
        return new Promise<string>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    });
    taskEngine.ensureSpace(SPACE);
    const task = taskEngine.tasks.create({
      name: "有限时任务",
      space: SPACE,
      topic: "不要无限等待",
      distillOnRun: false,
    })!;

    const timedOut = await taskEngine.runTask(task.id, { timeoutMs: 10 });

    expect(timedOutSignal?.aborted).toBe(true);
    expect(timedOut).toEqual(expect.objectContaining({
      ok: false,
      status: "timed_out",
      error: "任务运行超过 10 ms，已自动终止",
    }));
    expect(taskEngine.getTaskRun(timedOut.runId)).toEqual(expect.objectContaining({
      status: "timed_out",
      timeoutMs: 10,
    }));

    taskEngine.tasks.update(task.id, { timeoutMinutes: 12 });
    const retried = taskEngine.retryTaskRun(timedOut.runId);
    expect(retried.run.timeoutMs).toBe(12 * 60_000);
    expect((await retried.completion).status).toBe("succeeded");
    taskEngine.close();
  });

  test("a timeout during immediate distillation preserves research without quarantining it", async () => {
    let calls = 0;
    const taskEngine = new KnowledgeEngine({
      dataDir: dir,
      runProvider: async (_provider, _input, _timeoutMs, signal) => {
        calls += 1;
        if (calls === 1) return "已经完成的研究输出";
        return new Promise<string>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    });
    taskEngine.ensureSpace(SPACE);
    const task = taskEngine.tasks.create({
      name: "提炼超时",
      space: SPACE,
      topic: "保留研究结果",
      distillOnRun: true,
    })!;

    const report = await taskEngine.runTask(task.id, { timeoutMs: 20 });

    expect(report.status).toBe("timed_out");
    expect(taskEngine.getTaskRun(report.runId)).toEqual(expect.objectContaining({
      status: "timed_out",
      output: "已经完成的研究输出",
      rawId: expect.any(String),
    }));
    expect(taskEngine.registry.store(SPACE).index().listRaw({ onlyPending: true })).toEqual([
      expect.objectContaining({
        source: "task",
        content: expect.stringContaining("已经完成的研究输出"),
      }),
    ]);
    expect(await taskEngine.listQuarantines(SPACE)).toEqual([]);
    taskEngine.close();
  });

  test("notification failures remain durable and can be retried to a sent outcome", async () => {
    const taskEngine = new KnowledgeEngine({
      dataDir: dir,
      runProvider: async () => "需要推送的研究摘要",
    });
    taskEngine.ensureSpace(SPACE);
    const task = taskEngine.tasks.create({
      name: "通知任务",
      space: SPACE,
      topic: "记录通知状态",
      notify: true,
      distillOnRun: false,
    })!;
    const report = await taskEngine.runTask(task.id);
    const attemptedAt = Date.now();

    expect(taskEngine.getTaskRun(report.runId)?.notification).toEqual({
      status: "pending",
      attempts: 0,
    });
    await expect(taskEngine.deliverTaskRunNotification(
      report.runId,
      async () => {
        throw new Error("Feishu unavailable");
      },
      { attemptedAt },
    )).rejects.toThrow("Feishu unavailable");

    expect(taskEngine.getTaskRun(report.runId)?.notification).toEqual({
      status: "failed",
      attempts: 1,
      lastAttemptAt: attemptedAt,
      nextAttemptAt: attemptedAt + 60_000,
      error: "Error: Feishu unavailable",
    });
    expect(taskEngine.listTaskRunsNeedingNotification(attemptedAt + 59_999)).toEqual([]);
    expect(taskEngine.listTaskRunsNeedingNotification(attemptedAt + 60_000)).toEqual([
      expect.objectContaining({ id: report.runId }),
    ]);
    taskEngine.close();

    const reopened = new KnowledgeEngine({ dataDir: dir, runProvider: async () => "" });
    const delivered: string[] = [];
    const sent = await reopened.deliverTaskRunNotification(
      report.runId,
      async (run) => {
        delivered.push(run.summary ?? "");
      },
      { attemptedAt: attemptedAt + 60_000 },
    );

    expect(delivered).toEqual(["需要推送的研究摘要"]);
    expect(sent.notification).toEqual({
      status: "sent",
      attempts: 2,
      lastAttemptAt: attemptedAt + 60_000,
      sentAt: attemptedAt + 60_000,
    });
    reopened.close();
  });

  test("a failed task run can be retried as a linked durable run", async () => {
    let attempts = 0;
    const prompts: string[] = [];
    const taskEngine = new KnowledgeEngine({
      dataDir: dir,
      runProvider: async (_provider, input) => {
        prompts.push(input.prompt);
        attempts += 1;
        if (attempts === 1) throw new Error("temporary provider failure");
        return "重试后的研究结果";
      },
    });
    taskEngine.ensureSpace(SPACE);
    const task = taskEngine.tasks.create({
      name: "可重试任务",
      space: SPACE,
      topic: "测试失败恢复",
      distillOnRun: false,
    })!;

    const failed = await taskEngine.runTask(task.id);
    expect(failed.ok).toBe(false);
    expect(taskEngine.getTaskRun(failed.runId)).toEqual(expect.objectContaining({
      status: "failed",
      error: "Error: temporary provider failure",
    }));

    taskEngine.tasks.update(task.id, {
      name: "已编辑任务",
      topic: "编辑后的新主题",
    });
    const retried = taskEngine.retryTaskRun(failed.runId);
    expect(retried.run).toEqual(expect.objectContaining({
      taskId: task.id,
      trigger: "retry",
      retryOf: failed.runId,
      status: "running",
    }));
    expect((await retried.completion).ok).toBe(true);
    expect(taskEngine.listTaskRuns(task.id).map((run) => run.id)).toEqual([
      retried.run.id,
      failed.runId,
    ]);
    expect(prompts[1]).toContain("测试失败恢复");
    expect(prompts[1]).not.toContain("编辑后的新主题");
    taskEngine.close();
  });

  test("a failed run preserves provider output when capture fails afterwards", async () => {
    const taskEngine = new KnowledgeEngine({
      dataDir: dir,
      runProvider: async () => "已经生成但尚未落库的输出",
    });
    taskEngine.ensureSpace(SPACE);
    const task = taskEngine.tasks.create({
      name: "落库失败",
      space: SPACE,
      topic: "保留输出",
      distillOnRun: false,
    })!;
    taskEngine.remember = async () => {
      throw new Error("raw store unavailable");
    };

    const report = await taskEngine.runTask(task.id);

    expect(report.ok).toBe(false);
    expect(taskEngine.getTaskRun(report.runId)).toEqual(expect.objectContaining({
      status: "failed",
      output: "已经生成但尚未落库的输出",
      error: "Error: raw store unavailable",
    }));
    taskEngine.close();
  });

  test("recovered interrupted runs update the task's latest health", () => {
    const recoveryDir = join(dir, "interrupted-task-health");
    const first = new KnowledgeEngine({ dataDir: recoveryDir, runProvider: async () => "" });
    first.ensureSpace(SPACE);
    const task = first.tasks.create({
      name: "中断任务",
      space: SPACE,
      topic: "恢复健康状态",
      distillOnRun: false,
    })!;
    const interrupted = first.taskRuns.start({
      task,
      trigger: "scheduled",
      distill: false,
    });
    first.close();

    const secondary = new KnowledgeEngine({ dataDir: recoveryDir, runProvider: async () => "" });
    expect(() => secondary.startTaskRun(task.id)).toThrow(interrupted.id);
    secondary.close();

    const reopened = new KnowledgeEngine({
      dataDir: recoveryDir,
      runProvider: async () => "",
      recoverInterruptedTaskRuns: true,
    });

    expect(reopened.getTaskRun(interrupted.id)?.status).toBe("failed");
    expect(reopened.tasks.get(task.id)).toEqual(expect.objectContaining({
      lastStatus: "error",
      lastError: "应用在任务完成前停止，运行已标记为失败",
      lastRunAt: expect.any(Number),
    }));
    reopened.close();
  });

});

describe("answer quality tracing", () => {
  test("records a successful grounded answer and returns its trace id", async () => {
    engine.close();
    const fake = new FakeLlm();
    fake.onJSON((call) => {
      const properties = (call.schema as { properties?: Record<string, unknown> }).properties ?? {};
      if ("relevant" in properties) return { slugs: ["entities/alice"], relevant: true };
      return {
        answer: "Alice 负责后端。",
        grounded: true,
        usedSlugs: ["entities/alice"],
        gaps: [],
      };
    });
    engine = new KnowledgeEngine({ dataDir: dir, llm: fake });
    await engine.upsertPage(SPACE, page("entities/alice", "Alice", "Alice 负责后端。"));

    const result = await engine.ask([SPACE], "谁负责后端？");
    expect(result.traceId).toStartWith("answer_");
    expect(engine.answerTrace(result.traceId!)).toEqual(
      expect.objectContaining({
        spaces: [SPACE],
        question: "谁负责后端？",
        outcome: "succeeded",
        source: "knowledge",
        answer: "Alice 负责后端。",
        citations: [{ slug: "entities/alice", title: "Alice" }],
        latencyMs: expect.any(Number),
      }),
    );
  });

  test("records a failed answer and rethrows the original error", async () => {
    engine.close();
    const fake = new FakeLlm();
    fake.onJSON((call) => {
      const properties = (call.schema as { properties?: Record<string, unknown> }).properties ?? {};
      if ("relevant" in properties) return { slugs: ["entities/alice"], relevant: true };
      throw new Error("synthesis exploded");
    });
    engine = new KnowledgeEngine({ dataDir: dir, llm: fake });
    await engine.upsertPage(SPACE, page("entities/alice", "Alice", "Alice 负责后端。"));

    await expect(engine.ask([SPACE], "谁负责后端？")).rejects.toThrow("synthesis exploded");
    expect(engine.qualitySnapshot().answers).toEqual(
      expect.objectContaining({ total: 1, failed: 1, succeeded: 0 }),
    );
  });

  test("records feedback only when the trace belongs to the requested space", async () => {
    engine.close();
    const fake = new FakeLlm().queueText("这不在知识库记录中，以下是我的一般性回答。");
    engine = new KnowledgeEngine({ dataDir: dir, llm: fake });
    const result = await engine.ask([SPACE], "一个没有知识库记录的问题");

    expect(engine.recordAnswerFeedback(
      result.traceId!,
      SPACE,
      "unhelpful",
      "缺少关键细节",
    )).toEqual(expect.objectContaining({ kind: "unhelpful" }));
    expect(engine.recordAnswerFeedback(
      result.traceId!,
      "team/oc_other",
      "helpful",
    )).toBeUndefined();
  });

  test("exposes the feedback review workflow through the engine", async () => {
    engine.close();
    const fake = new FakeLlm().queueText("这不在知识库记录中，以下是我的一般性回答。");
    engine = new KnowledgeEngine({ dataDir: dir, llm: fake });
    const result = await engine.ask([SPACE], "线上故障该找谁？");
    engine.recordAnswerFeedback(result.traceId!, SPACE, "unhelpful", "没有给出负责人");

    expect(engine.answerFeedbackReviews({
      status: "open",
      kinds: ["unhelpful", "citation_error"],
    })).toEqual([
      expect.objectContaining({
        trace: expect.objectContaining({ id: result.traceId }),
        feedback: expect.objectContaining({ kind: "unhelpful" }),
      }),
    ]);
    const evaluationCase = engine.promoteAnswerFeedback(
      result.traceId!,
      "补充正确负责人后校准",
    );
    expect(engine.qualityEvaluationCases()).toEqual([
      expect.objectContaining({ id: evaluationCase!.id, traceId: result.traceId }),
    ]);
    expect(engine.resolveAnswerFeedback(result.traceId!, "知识页已修正")).toEqual(
      expect.objectContaining({ resolutionNote: "知识页已修正" }),
    );
    expect(engine.answerFeedbackReviews({ status: "open" })).toEqual([]);
  });
});
