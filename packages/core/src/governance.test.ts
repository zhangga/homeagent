import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page, SpaceId } from "@homeagent/shared";
import { topicNativeSessionCompatibilityKey } from "./chat-runs.ts";
import { KnowledgeEngine } from "./engine.ts";
import type { ResolvedExecutionPlan, StoredExecutionPlan } from "./execution-plan.ts";
import { refreshDigest } from "./digest.ts";
import { parseSpaceArchive, type SpaceArchive } from "./governance.ts";
import { knowledgePageRevision } from "./local-agent-knowledge.ts";
import type { LlmClient } from "./llm.ts";
import { SkillCatalog } from "./skill-catalog.ts";

const SPACE: SpaceId = "team/oc_governance";
const dirs: string[] = [];

function tempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), label));
  dirs.push(dir);
  return dir;
}

function completedWorkActionOutput(result: string): string {
  return JSON.stringify({
    version: 1,
    outcome: "completed",
    result,
    blockers: [],
    checks: [{ name: "动作结果核对", status: "passed" }],
  });
}

function persistArchiveFixture(dataDir: string, version: number, archive: unknown): unknown {
  const path = join(dataDir, `candidate-space-v${version}.json`);
  writeFileSync(path, `${JSON.stringify(archive, null, 2)}\n`, "utf8");
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Model the actual old format, not a current v2 DTO with only its outer version changed. */
function legacyPlanFixture(plan: StoredExecutionPlan): ResolvedExecutionPlan {
  if (plan.localExecution || plan.execution?.executionMode === "local-full-access") throw new Error("Cannot make local authorization into a legacy fixture");
  const { archiveVersion: _archive, localExecution: _local, ...intent } = plan;
  const { executionMode: _mode, ...execution } = plan.execution ?? { permission: "read-only", skills: [] };
  return { ...intent, version: 1, ...(plan.execution ? { execution } : {}) };
}

function legacyRunPlanFixtures(archive: { taskRuns?: { executionPlan?: StoredExecutionPlan }[]; chatRuns?: { executionPlan?: StoredExecutionPlan }[] }): void {
  for (const run of [...(archive.taskRuns ?? []), ...(archive.chatRuns ?? [])]) {
    if (run.executionPlan) run.executionPlan = legacyPlanFixture(run.executionPlan);
  }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("space data governance", () => {
  test("archive v20 preserves execution mode intent without transferring local authority", async () => {
    const source = new KnowledgeEngine({ dataDir: tempDir("ha-mode-archive-"), skillCatalog: new SkillCatalog({ roots: [] }) });
    const target = new KnowledgeEngine({ dataDir: tempDir("ha-mode-restore-"), skillCatalog: new SkillCatalog({ roots: [] }) });
    try {
      await source.ensureSpace(SPACE);
      const agent = source.agents.create({ provider: "codex", visibility: "team" });
      source.registry.updateMeta(SPACE, { agentId: agent.id });
      const draft = source.agents.saveDraft(agent.id, {
        executionMode: "local-full-access", permission: "full", workdir: tempDir("ha-mode-work-"),
      })!;
      source.agents.release(agent.id, draft.id, draft.id, {
        termsVersion: 1, source: "local-operator", taskExecutionEnabled: true,
        chatScopes: [{ spaceId: SPACE, policyHash: "a".repeat(64) }],
      });
      const grant = source.agents.listLocalExecutionGrants(agent.id)[0]!;
      const archive = await source.exportSpace(SPACE);
      expect(archive.version).toBe(20);
      expect(archive.agent?.executionMode).toBe("local-full-access");
      expect(JSON.stringify(archive)).not.toContain(grant.id);
      expect(JSON.stringify(archive)).not.toContain(grant.chatScopes[0]!.policyHash);
      expect(archive.agent).not.toHaveProperty("localExecutionGrants");
      expect(parseSpaceArchive(archive).agentRevisions).toEqual(archive.agentRevisions);
      const injected = { ...archive,
        agent: { ...archive.agent!, localExecutionGrants: [grant] },
        agentRevisions: archive.agentRevisions.map(revision => ({ ...revision, localExecutionGrantId: grant.id })),
      };
      expect(JSON.stringify(parseSpaceArchive(injected))).not.toContain(grant.id);
      await target.restoreSpace(archive);
      expect(target.agents.get(agent.id)?.executionMode).toBe("local-full-access");
      expect(target.agents.listLocalExecutionGrants(agent.id)).toEqual([]);
      expect(target.agents.listRevisions(agent.id)).toEqual(archive.agentRevisions);
      expect(() => parseSpaceArchive({ ...archive, version: 19 })).toThrow(/executionMode/);

      // Even an isolated current head cannot smuggle a full-mode revision into an older format.
      const isolated = source.agents.saveDraft(agent.id, { executionMode: "isolated", permission: "write" })!;
      source.agents.release(agent.id, isolated.id, isolated.id);
      const changed = await source.exportSpace(SPACE);
      const { executionMode: _mode, ...legacyAgent } = changed.agent!;
      expect(() => parseSpaceArchive({ ...changed, version: 19, agent: legacyAgent })).toThrow(/executionMode/);
    } finally { source.close(); target.close(); }
  });

  test("archive v19 validates original files and v18 remains readable", async () => {
    const source = new KnowledgeEngine({ dataDir: tempDir("ha-source-file-archive-") });
    await source.rememberFile(
      { space: SPACE, source: "manual", content: "# 本地资料：contract.bin" },
      {
        attachment: { kind: "file", ref: "manual:contract.bin", name: "contract.bin" },
        bytes: new Uint8Array([0, 1, 2, 255]),
      },
    );
    const archive = await source.exportSpace(SPACE);
    source.close();

    expect(parseSpaceArchive(archive).sourceFiles).toEqual(archive.sourceFiles);

    const missing = structuredClone(archive) as Record<string, any>;
    missing.sourceFiles = [];
    expect(() => parseSpaceArchive(missing)).toThrow(/sourceDigest.*missing from sourceFiles/i);

    const corrupt = structuredClone(archive) as Record<string, any>;
    corrupt.sourceFiles[0].contentBase64 = "AAEC/g==";
    expect(() => parseSpaceArchive(corrupt)).toThrow(/digest does not match content/i);

    const legacy = structuredClone(archive) as Record<string, any>;
    legacy.version = 18;
    legacyRunPlanFixtures(legacy);
    delete legacy.sourceFiles;
    delete legacy.raw[0].attachments[0].sourceDigest;
    delete legacy.raw[0].attachments[0].sourceSizeBytes;
    expect(parseSpaceArchive(legacy)).toEqual(expect.objectContaining({
      version: 20,
      sourceFiles: [],
    }));
  });

  test("archive v18 round-trips Space-scoped Agent knowledge feedback", async () => {
    const source = new KnowledgeEngine({ dataDir: tempDir("ha-feedback-archive-") });
    await source.upsertPage(SPACE, {
      slug: "concepts/release",
      type: "concept",
      title: "发布流程",
      summary: "发布检查",
      aliases: [],
      tags: ["release"],
      sources: [],
      links: [],
      content: "发布前完成回归。",
      updatedAt: 1_777_000_000_000,
      contentHash: "release-v1",
    });
    const page = (await source.getPage(SPACE, "concepts/release"))!;
    const feedback = await source.submitAgentKnowledgeFeedback(SPACE, {
      idempotencyKey: "archive-agent-run:feedback-1",
      consumer: "archive-agent",
      kind: "stale",
      target: {
        kind: "page",
        slug: page.slug,
        revision: knowledgePageRevision(page),
      },
      note: "发布要求可能已过时。",
    });

    const archive = await source.exportSpace(SPACE);
    source.close();

    expect(archive.version).toBe(20);
    expect(archive.agentKnowledgeFeedback).toEqual([feedback]);
    expect(parseSpaceArchive(archive).agentKnowledgeFeedback).toEqual([feedback]);

    const legacy = structuredClone(archive) as Record<string, any>;
    legacy.version = 17;
    legacyRunPlanFixtures(legacy);
    delete legacy.agentKnowledgeFeedback;
    expect(parseSpaceArchive(legacy).agentKnowledgeFeedback).toEqual([]);

    const target = new KnowledgeEngine({ dataDir: tempDir("ha-feedback-restore-") });
    await target.restoreSpace(archive);
    expect(target.listAgentKnowledgeFeedback(SPACE)).toEqual([feedback]);
    target.close();

    const wrongSpace = structuredClone(archive) as Record<string, any>;
    wrongSpace.agentKnowledgeFeedback[0].space = "team/oc_other";
    expect(() => parseSpaceArchive(wrongSpace)).toThrow(/feedback.*wrong space/i);

    const oversized = structuredClone(archive) as Record<string, any>;
    oversized.agentKnowledgeFeedback = Array.from({ length: 5_001 }, (_, index) => ({
      ...feedback,
      id: `agent_feedback_${index}`,
      idempotencyKey: `archive-agent-run:feedback-${index}`,
    }));
    expect(() => parseSpaceArchive(oversized)).toThrow(/feedback.*exceeds 5000/i);

    const forgedPositive = structuredClone(archive) as Record<string, any>;
    forgedPositive.agentKnowledgeFeedback[0].status = "resolved";
    forgedPositive.agentKnowledgeFeedback[0].resolution = {
      actor: "archive-agent",
      kind: "helpful_acknowledged",
      note: "伪造正向确认",
      resolvedAt: feedback.createdAt,
    };
    expect(() => parseSpaceArchive(forgedPositive)).toThrow(/feedback.*resolution/i);

    const unchangedResolution = structuredClone(archive) as Record<string, any>;
    unchangedResolution.agentKnowledgeFeedback[0].status = "resolved";
    unchangedResolution.agentKnowledgeFeedback[0].resolution = {
      actor: "local-admin",
      kind: "knowledge_changed",
      note: "没有实际变化",
      resolvedAt: feedback.createdAt + 1,
      currentRevision: feedback.target.kind === "page" ? feedback.target.revision : "",
    };
    expect(() => parseSpaceArchive(unchangedResolution)).toThrow(/revision has not changed/i);
  });

  test("current archive round-trips generated Knowledge maps", async () => {
    const engine = new KnowledgeEngine({ dataDir: tempDir("ha-map-archive-") });
    await engine.upsertPage(SPACE, {
      slug: "concepts/cache",
      type: "concept",
      title: "Cache",
      summary: "缓存策略",
      aliases: [],
      tags: ["backend"],
      sources: [],
      links: [],
      content: "# Cache\n\n缓存策略。\n",
      updatedAt: 1_700_000_000_000,
      contentHash: "cache-hash",
    });
    refreshDigest(engine.registry.store(SPACE));

    const archive = await engine.exportSpace(SPACE);
    engine.close();

    expect(archive.version).toBe(20);
    expect(parseSpaceArchive(archive).pages).toContainEqual(
      expect.objectContaining({ slug: "maps/backend", type: "map" }),
    );

    expect(() => parseSpaceArchive({ ...archive, version: 16 }))
      .toThrow(/Knowledge maps require archive v17/);

    const target = new KnowledgeEngine({ dataDir: tempDir("ha-map-restore-") });
    await target.restoreSpace(archive);
    expect((await target.getPage(SPACE, "maps/backend"))?.links)
      .toEqual(["concepts/cache"]);
    target.close();
  });

  test("archive v16 preserves a ready Raw admission state", async () => {
    const engine = new KnowledgeEngine({ dataDir: tempDir("ha-raw-admission-archive-") });
    const rawId = await engine.remember({
      space: SPACE,
      source: "manual",
      content: "普通知识输入可直接参与提炼",
    });
    const candidate = structuredClone(await engine.exportSpace(SPACE)) as Record<string, any>;
    candidate.version = 16;
    candidate.raw[0].admission = "ready";
    engine.close();

    expect(parseSpaceArchive(candidate).raw).toEqual([
      expect.objectContaining({ id: rawId, admission: "ready" }),
    ]);
  });

  test("archive v16 rejects a held Raw without WorkAction provenance", async () => {
    const engine = new KnowledgeEngine({ dataDir: tempDir("ha-held-raw-archive-") });
    await engine.remember({
      space: SPACE,
      source: "manual",
      content: "伪造为待验收的普通输入",
    });
    const candidate = structuredClone(await engine.exportSpace(SPACE)) as Record<string, any>;
    candidate.raw[0].admission = "held";
    engine.close();

    expect(() => parseSpaceArchive(candidate)).toThrow(/held Raw.*WorkAction provenance/i);
  });

  test("archive v16 rejects a Raw forged onto an unknown WorkAction", async () => {
    const engine = new KnowledgeEngine({ dataDir: tempDir("ha-forged-raw-action-archive-") });
    await engine.remember({
      space: SPACE,
      source: "task",
      content: "伪造的动作结果",
    });
    const candidate = structuredClone(await engine.exportSpace(SPACE)) as Record<string, any>;
    candidate.raw[0].workActionId = "action_00000000-0000-4000-8000-000000000000";
    engine.close();

    expect(() => parseSpaceArchive(candidate)).toThrow(/Raw WorkAction association is invalid/i);
  });

  test("archive v16 rejects a forged admission state for an accepted WorkAction Raw", async () => {
    const source = new KnowledgeEngine({
      dataDir: tempDir("ha-forged-raw-admission-"),
      skillCatalog: new SkillCatalog({ roots: [] }),
      runProvider: async () => completedWorkActionOutput("验收完成"),
    });
    const item = source.workItems.create({
      space: SPACE,
      title: "核对 Raw 准入态",
      nextActions: ["执行只读核对"],
    });
    const started = source.startWorkContinuation(item.id);
    await started.completion;
    const run = source.getTaskRun(started.run.id)!;
    const candidate = structuredClone(await source.exportSpace(SPACE)) as Record<string, any>;
    const raw = candidate.raw.find((entry: Record<string, unknown>) => entry.id === run.rawId)!;
    raw.workActionId = started.run.workActionId;
    raw.admission = "held";
    source.close();

    expect(() => parseSpaceArchive(candidate)).toThrow(/Raw admission does not match WorkAction/i);
  });

  test("archive v16 rejects a WorkAction Raw detached from its WorkItem", async () => {
    const source = new KnowledgeEngine({
      dataDir: tempDir("ha-detached-action-raw-"),
      skillCatalog: new SkillCatalog({ roots: [] }),
      runProvider: async () => completedWorkActionOutput("关联核对完成"),
    });
    const item = source.workItems.create({
      space: SPACE,
      title: "核对动作 Raw 归属",
      nextActions: ["核对关联"],
    });
    const started = source.startWorkContinuation(item.id);
    await started.completion;
    const run = source.getTaskRun(started.run.id)!;
    const candidate = structuredClone(await source.exportSpace(SPACE)) as Record<string, any>;
    const raw = candidate.raw.find((entry: Record<string, unknown>) => entry.id === run.rawId)!;
    raw.admission = "ready";
    delete raw.workItemId;
    source.close();

    expect(() => parseSpaceArchive(candidate)).toThrow(/Raw WorkItem association is invalid/i);
  });

  test("archive v15 derives an excluded admission for a rejected WorkAction Raw", async () => {
    const source = new KnowledgeEngine({
      dataDir: tempDir("ha-v15-held-raw-"),
      skillCatalog: new SkillCatalog({ roots: [] }),
      runProvider: async () => "执行已结束，等待人工验收",
    });
    const item = source.workItems.create({
      space: SPACE,
      title: "迁移待验收动作",
      nextActions: ["人工核对结果"],
    });
    const started = source.startWorkContinuation(item.id);
    await started.completion;
    const run = source.getTaskRun(started.run.id)!;
    source.rejectWorkAction(
      started.run.workActionId!,
      started.run.id,
      "operator",
      "验收未通过",
    );
    const legacy = structuredClone(await source.exportSpace(SPACE)) as Record<string, any>;
    legacy.version = 15;
    legacyRunPlanFixtures(legacy);
    for (const raw of legacy.raw) {
      delete raw.admission;
      delete raw.workActionId;
    }
    // Model the actual legacy capture crash window: neither side persisted the
    // Raw ownership edge. Export-time reconciliation must not accidentally
    // turn the ambiguity fixture into a directly linked TaskRun.
    const legacyRun = legacy.taskRuns.find((candidate: { id: string }) => candidate.id === run.id);
    delete legacyRun.rawId;
    source.close();

    expect(parseSpaceArchive(legacy).raw).toEqual([
      expect.objectContaining({
        id: run.rawId,
        admission: "excluded",
        workActionId: started.run.workActionId,
      }),
    ]);
  });

  test("archive v15 closes rejected acceptance evidence around a recovered Raw", async () => {
    const source = new KnowledgeEngine({
      dataDir: tempDir("ha-v15-rejected-raw-evidence-"),
      skillCatalog: new SkillCatalog({ roots: [] }),
      runProvider: async () => "旧版动作结果等待人工验收",
    });
    const item = source.workItems.create({
      space: SPACE,
      title: "迁移旧版拒绝证据",
      nextActions: ["执行旧版只读核对"],
    });
    const started = source.startWorkContinuation(item.id);
    await started.completion;
    const run = source.getTaskRun(started.run.id)!;
    source.rejectWorkAction(
      started.run.workActionId!,
      started.run.id,
      "operator",
      "旧版结果不可采信",
    );
    const legacy = structuredClone(await source.exportSpace(SPACE)) as Record<string, any>;
    legacy.version = 15;
    legacyRunPlanFixtures(legacy);
    const legacyRun = legacy.taskRuns.find(
      (candidate: Record<string, unknown>) => candidate.id === run.id,
    );
    delete legacyRun.rawId;
    const acceptance = legacy.workActions[0].acceptances[0];
    delete acceptance.rawId;
    acceptance.report.evidence = acceptance.report.evidence.filter(
      (evidence: Record<string, unknown>) => evidence.kind !== "raw",
    );
    const captureCheck = acceptance.report.checks.find(
      (check: Record<string, unknown>) => check.name === "执行输出已归档",
    );
    captureCheck.status = "failed";
    delete captureCheck.detail;
    for (const raw of legacy.raw) {
      delete raw.admission;
      delete raw.workActionId;
    }
    source.close();

    const parsed = parseSpaceArchive(legacy);
    const normalizedAcceptance = parsed.workActions[0]!.acceptances![0]!;
    expect(parsed.taskRuns[0]!.rawId).toBe(run.rawId);
    expect(normalizedAcceptance.rawId).toBe(run.rawId);
    expect(normalizedAcceptance.report.evidence).toContainEqual({
      kind: "raw",
      id: run.rawId!,
    });
    expect(normalizedAcceptance.report.checks).toContainEqual(expect.objectContaining({
      name: "执行输出已归档",
      status: "passed",
    }));
    expect(() => parseSpaceArchive(parsed)).not.toThrow();

    const conflicting = structuredClone(legacy);
    const conflictingAcceptance = conflicting.workActions[0].acceptances[0];
    conflictingAcceptance.rawId = "raw_conflicting-evidence";
    conflictingAcceptance.report.evidence.push({
      kind: "raw",
      id: "raw_conflicting-evidence",
    });
    expect(() => parseSpaceArchive(conflicting)).toThrow(/conflicts with recovered Raw/i);
  });

  test("archive v16 keeps failed attempt Raw excluded after a later attempt succeeds", async () => {
    const source = new KnowledgeEngine({
      dataDir: tempDir("ha-multi-attempt-raw-archive-"),
      skillCatalog: new SkillCatalog({ roots: [] }),
      runProvider: async () => completedWorkActionOutput("只读核对完成"),
    });
    const item = source.workItems.create({
      space: SPACE,
      title: "保留多次尝试的准入边界",
      nextActions: ["执行只读核对"],
    });
    const succeed = spyOn(source.taskRuns, "succeed").mockImplementationOnce(() => {
      throw new Error("injected TaskRun success persistence failure");
    });
    const first = source.startWorkContinuation(item.id);
    await first.completion;
    succeed.mockRestore();
    const firstRun = source.getTaskRun(first.run.id)!;
    const retry = source.retryWorkAction(first.run.workActionId!);
    await retry.completion;
    const retryRun = source.getTaskRun(retry.run.id)!;

    const archive = await source.exportSpace(SPACE);
    source.close();

    expect(() => parseSpaceArchive(archive)).not.toThrow();
    const parsed = parseSpaceArchive(archive);
    expect(parsed.raw.find((raw) => raw.id === firstRun.rawId)).toEqual(
      expect.objectContaining({ admission: "excluded" }),
    );
    expect(parsed.raw.find((raw) => raw.id === retryRun.rawId)).toEqual(
      expect.objectContaining({ admission: "ready" }),
    );
  });

  test("archive v15 recovers uniquely captured WorkAction Raw and removes its polluted page", async () => {
    const source = new KnowledgeEngine({
      dataDir: tempDir("ha-v15-orphan-action-raw-"),
      skillCatalog: new SkillCatalog({ roots: [] }),
      runProvider: async () => {
        throw new Error("旧版捕获后终态落盘失败");
      },
    });
    const item = source.workItems.create({
      space: SPACE,
      title: "迁移捕获崩溃窗口",
      nextActions: ["执行旧版只读检查"],
    });
    const started = source.startWorkContinuation(item.id);
    await started.completion;
    const run = source.getTaskRun(started.run.id)!;
    const rawId = await source.remember({
      space: SPACE,
      source: "task",
      workItemId: item.id,
      content: `# 任务研究：${run.taskName}\n主题：${run.topic}\n\n旧版已捕获但未关联的结果`,
      createdAt: run.finishedAt,
    });
    await source.upsertPage(SPACE, {
      slug: "analysis/v15-orphan-action-result",
      type: "analysis",
      title: "旧版孤儿动作结果",
      summary: "不应继续作为知识恢复",
      aliases: [],
      tags: [],
      sources: [rawId],
      links: [],
      content: "# 旧版孤儿动作结果\n\n不应继续作为知识恢复。",
      updatedAt: run.finishedAt!,
      contentHash: "v15-orphan-action-result",
    });
    const legacy = structuredClone(await source.exportSpace(SPACE)) as Record<string, any>;
    legacy.version = 15;
    legacyRunPlanFixtures(legacy);
    for (const raw of legacy.raw) {
      delete raw.admission;
      delete raw.workActionId;
    }
    source.close();

    const parsed = parseSpaceArchive(legacy);
    expect(parsed.taskRuns.find((candidate) => candidate.id === run.id)?.rawId).toBe(rawId);
    expect(parsed.raw.find((raw) => raw.id === rawId)).toEqual(expect.objectContaining({
      admission: "excluded",
      workActionId: started.run.workActionId,
      ingested: false,
    }));
    expect(parsed.pages.map((page) => page.slug))
      .not.toContain("analysis/v15-orphan-action-result");
    expect(() => parseSpaceArchive(parsed)).not.toThrow();

    const ambiguous = structuredClone(legacy);
    const duplicate = structuredClone(
      ambiguous.raw.find((candidate: Record<string, unknown>) => candidate.id === rawId),
    );
    duplicate.id = `${rawId}-duplicate`;
    ambiguous.raw.push(duplicate);
    ambiguous.workItems[0].rawIds.push(duplicate.id);
    expect(() => parseSpaceArchive(ambiguous)).toThrow(/Raw evidence is ambiguous/i);
  });

  test("archive v16 rejects a Wiki page sourced from an excluded WorkAction Raw", async () => {
    const source = new KnowledgeEngine({
      dataDir: tempDir("ha-excluded-raw-page-"),
      skillCatalog: new SkillCatalog({ roots: [] }),
      runProvider: async () => "执行已结束，等待人工验收",
    });
    const item = source.workItems.create({
      space: SPACE,
      title: "隔离未验收知识",
      nextActions: ["生成候选结论"],
    });
    const started = source.startWorkContinuation(item.id);
    await started.completion;
    const run = source.getTaskRun(started.run.id)!;
    source.rejectWorkAction(
      started.run.workActionId!,
      started.run.id,
      "operator",
      "结论不可采信",
    );
    const candidate = structuredClone(await source.exportSpace(SPACE)) as Record<string, any>;
    candidate.pages.push({
      slug: "analysis/forged-action-result",
      type: "analysis",
      title: "被污染的动作结论",
      summary: "不应恢复",
      aliases: [],
      tags: [],
      sources: [run.rawId!],
      links: [],
      content: "# 被污染的动作结论\n\n不应恢复。",
      updatedAt: Date.now(),
      contentHash: "forged-action-result",
    });
    candidate.raw.find((raw: Record<string, unknown>) => raw.id === run.rawId)!.admission =
      "excluded";
    source.close();

    expect(() => parseSpaceArchive(candidate)).toThrow(/page.*non-ready Raw/i);
  });

  test("archive v15 removes a polluted page and requeues its ready Raw sources", async () => {
    const source = new KnowledgeEngine({
      dataDir: tempDir("ha-v15-polluted-page-"),
      skillCatalog: new SkillCatalog({ roots: [] }),
      runProvider: async () => "执行已结束，等待人工验收",
    });
    const item = source.workItems.create({
      space: SPACE,
      title: "迁移旧知识污染",
      nextActions: ["生成候选结论"],
    });
    const started = source.startWorkContinuation(item.id);
    await started.completion;
    const run = source.getTaskRun(started.run.id)!;
    source.rejectWorkAction(
      started.run.workActionId!,
      started.run.id,
      "operator",
      "旧结论不可采信",
    );
    const readyRawId = await source.remember({
      space: SPACE,
      source: "manual",
      content: "仍可用于重建页面的可信来源",
    });
    source.registry.store(SPACE).index().markIngested([readyRawId]);
    const legacy = structuredClone(await source.exportSpace(SPACE)) as Record<string, any>;
    legacy.version = 15;
    legacyRunPlanFixtures(legacy);
    legacy.pages.push({
      slug: "analysis/legacy-polluted-result",
      type: "analysis",
      title: "旧版污染页面",
      summary: "混入未验收动作结果",
      aliases: [],
      tags: [],
      sources: [run.rawId!, readyRawId],
      links: [],
      content: "# 旧版污染页面\n\n需要从可信来源重建。",
      updatedAt: Date.now(),
      contentHash: "legacy-polluted-result",
    });
    for (const digest of ["index", "glossary", "overview"] as const) {
      legacy.pages.push({
        slug: digest,
        type: digest,
        title: digest,
        summary: "包含旧版污染页面摘要",
        aliases: [],
        tags: [],
        sources: [],
        links: ["analysis/legacy-polluted-result"],
        content: `# ${digest}\n\n旧版污染页面：混入未验收动作结果。`,
        updatedAt: Date.now(),
        contentHash: `legacy-${digest}`,
      });
    }
    legacy.workItems[0].pageSlugs.push(
      "analysis/legacy-polluted-result",
      "index",
      "glossary",
      "overview",
    );
    legacy.workActions[0].acceptances[0].report.evidence.push({
      kind: "page",
      id: "analysis/legacy-polluted-result",
    });
    for (const raw of legacy.raw) {
      delete raw.admission;
      delete raw.workActionId;
    }
    source.close();

    const parsed = parseSpaceArchive(legacy);
    expect(parsed.pages.some((page) => page.slug === "analysis/legacy-polluted-result"))
      .toBe(false);
    expect(parsed.pages.map((page) => page.slug)).not.toContain("index");
    expect(parsed.pages.map((page) => page.slug)).not.toContain("glossary");
    expect(parsed.pages.map((page) => page.slug)).not.toContain("overview");
    expect(parsed.raw.find((raw) => raw.id === readyRawId)).toEqual(
      expect.objectContaining({ admission: "ready", ingested: false }),
    );
    expect(parsed.raw.find((raw) => raw.id === run.rawId)).toEqual(
      expect.objectContaining({ admission: "excluded" }),
    );
    expect(parsed.workItems[0]!.pageSlugs).not.toContain("analysis/legacy-polluted-result");
    expect(parsed.workActions[0]!.acceptances![0]!.report.evidence)
      .not.toContainEqual(expect.objectContaining({
        kind: "page",
        id: "analysis/legacy-polluted-result",
      }));
    expect(() => parseSpaceArchive(parsed)).not.toThrow();
  });

  test("current archive round-trips work context, continuation, and Raw admission", async () => {
    const source = new KnowledgeEngine({
      dataDir: tempDir("ha-work-archive-source-"),
      skillCatalog: new SkillCatalog({ roots: [] }),
      runProvider: async () => completedWorkActionOutput("恢复验证完成"),
    });
    const workItem = source.workItems.create({
      space: SPACE,
      title: "完成工作上下文归档",
      summary: "保存当前进展",
      nextActions: ["验证恢复"],
    });
    const rawId = await source.remember({
      space: SPACE,
      source: "manual",
      content: "归档必须保留工作上下文",
    });
    source.configureWorkContinuation(workItem.id, true);
    const started = source.startWorkContinuation(workItem.id);
    await started.completion;

    const archive = await source.exportSpace(SPACE);
    source.close();

    expect(archive.version).toBe(20);
    expect(archive.workItems).toEqual([
      expect.objectContaining({ id: workItem.id, rawIds: expect.arrayContaining([rawId]) }),
    ]);
    expect(archive.workActions).toEqual([
      expect.objectContaining({
        id: started.run.workActionId,
        status: "succeeded",
        taskRunIds: [started.run.id],
      }),
    ]);
    expect(archive.taskRuns).toEqual([
      expect.objectContaining({ id: started.run.id, workActionId: started.run.workActionId }),
    ]);
    expect(archive.workContinuationPolicies).toEqual([
      expect.objectContaining({ workItemId: workItem.id, autoContinue: true }),
    ]);
    const actionRawId = archive.taskRuns[0]!.rawId!;
    expect(archive.raw.find((raw) => raw.id === actionRawId)).toEqual(
      expect.objectContaining({
        admission: "ready",
        workActionId: started.run.workActionId,
      }),
    );

    const legacyV15 = structuredClone(archive) as Record<string, any>;
    legacyV15.version = 15;
    legacyRunPlanFixtures(legacyV15);
    for (const raw of legacyV15.raw) {
      delete raw.admission;
      delete raw.workActionId;
    }
    expect(parseSpaceArchive(legacyV15).raw.find((raw) => raw.id === actionRawId)).toEqual(
      expect.objectContaining({
        admission: "ready",
        workActionId: started.run.workActionId,
      }),
    );

    const malformed = structuredClone(archive);
    malformed.workItems[0]!.completedActionIds = ["action_unknown"];
    expect(() => parseSpaceArchive(malformed)).toThrow("completed work action");

    const succeededWithoutAcceptance = structuredClone(archive);
    succeededWithoutAcceptance.workActions[0]!.acceptances = [];
    expect(() => parseSpaceArchive(succeededWithoutAcceptance)).toThrow(
      /workActions|succeeded without its current accepted result/,
    );

    const forgedAttemptOrder = structuredClone(archive);
    forgedAttemptOrder.workActions[0]!.attempt = 99;
    forgedAttemptOrder.workActions[0]!.acceptances![0]!.attempt = 99;
    expect(() => parseSpaceArchive(forgedAttemptOrder)).toThrow(
      /workActions|acceptance attempt/,
    );

    const cancelledWithCheckpoint = structuredClone(archive);
    cancelledWithCheckpoint.workActions[0]!.status = "cancelled";
    cancelledWithCheckpoint.workActions[0]!.acceptances = [];
    cancelledWithCheckpoint.workItems[0]!.completedActionIds = [];
    expect(() => parseSpaceArchive(cancelledWithCheckpoint)).toThrow(
      /workActions|checkpoint is only valid for a succeeded action/,
    );

    const forgedAcceptance = structuredClone(archive);
    forgedAcceptance.workActions[0]!.acceptances![0]!.summary = "伪造的验收摘要";
    forgedAcceptance.workActions[0]!.acceptances![0]!.report.result = "伪造的验收摘要";
    forgedAcceptance.workActions[0]!.checkpoint!.summary = "伪造的验收摘要";
    expect(() => parseSpaceArchive(forgedAcceptance)).toThrow(
      "acceptance result does not match its run",
    );

    const forgedProviderReport = structuredClone(archive);
    forgedProviderReport.taskRuns[0]!.output = JSON.stringify({
      version: 1,
      outcome: "blocked",
      result: "恢复验证完成",
      blockers: ["归档中的真实执行结果仍被阻塞"],
      checks: [{ name: "动作结果核对", status: "failed" }],
    });
    expect(() => parseSpaceArchive(forgedProviderReport)).toThrow(
      "acceptance report does not match its run output",
    );

    const humanAcceptedBlocked = structuredClone(archive);
    humanAcceptedBlocked.taskRuns[0]!.output = JSON.stringify({
      version: 1,
      outcome: "blocked",
      result: "恢复验证完成",
      blockers: ["缺少恢复权限"],
      checks: [{ name: "动作结果核对", status: "failed" }],
    });
    const blockedAcceptance = humanAcceptedBlocked.workActions[0]!.acceptances![0]!;
    blockedAcceptance.mode = "human";
    blockedAcceptance.decidedBy = "operator";
    blockedAcceptance.report.outcome = "blocked";
    blockedAcceptance.report.blockers = ["缺少恢复权限"];
    blockedAcceptance.report.checks[1] = {
      name: "动作结果核对",
      status: "failed",
    };
    expect(() => parseSpaceArchive(humanAcceptedBlocked)).toThrow(
      /workActions|blocked result cannot be accepted/,
    );

    const forgedCheckpoint = structuredClone(archive);
    forgedCheckpoint.workActions[0]!.checkpoint!.summary = "伪造的检查点摘要";
    expect(() => parseSpaceArchive(forgedCheckpoint)).toThrow(
      /workActions|work action|checkpoint acceptance/,
    );

    const forgedCheckpointRaw = structuredClone(archive);
    forgedCheckpointRaw.workActions[0]!.checkpoint!.rawId = rawId;
    expect(() => parseSpaceArchive(forgedCheckpointRaw)).toThrow(
      /workActions|work action|checkpoint acceptance/,
    );

    const target = new KnowledgeEngine({ dataDir: tempDir("ha-work-archive-target-") });
    await target.restoreSpace(archive);

    expect(target.workItems.get(workItem.id)).toEqual(archive.workItems[0]);
    expect(target.workContinuations.get(started.run.workActionId!)).toEqual(archive.workActions[0]);
    expect(target.workContinuations.policyFor(workItem.id, SPACE).autoContinue).toBe(true);
    expect(target.registry.store(SPACE).index().getRaw(rawId)?.workItemId).toBe(workItem.id);
    target.close();
  });

  test("human-accepted unverified output round-trips without weakening blocked results", async () => {
    const source = new KnowledgeEngine({
      dataDir: tempDir("ha-work-unverified-source-"),
      skillCatalog: new SkillCatalog({ roots: [] }),
      runProvider: async () => "写入已完成，等待人工核对",
    });
    source.ensureSpace(SPACE);
    const agent = source.agents.create({
      name: "人工验收助手",
      permission: "write",
      workdir: tempDir("ha-work-unverified-workdir-"),
    });
    source.registry.updateMeta(SPACE, { agentId: agent.id });
    const item = source.workItems.create({
      space: SPACE,
      title: "归档未验证结果",
      nextActions: ["更新灰度配置"],
    });
    const pending = source.startWorkContinuation(item.id);
    await source.approveTaskRun(pending.run.id, "operator").completion;
    const accepted = source.acceptWorkAction(
      pending.run.workActionId!,
      pending.run.id,
      "operator",
    );

    expect(accepted.acceptances?.at(-1)).toEqual(expect.objectContaining({
      status: "accepted",
      mode: "human",
      report: expect.objectContaining({ outcome: "unverified" }),
    }));
    const archive = await source.exportSpace(SPACE);
    expect(() => parseSpaceArchive(archive)).not.toThrow();
    source.close();

    const target = new KnowledgeEngine({ dataDir: tempDir("ha-work-unverified-target-") });
    await target.restoreSpace(archive);
    expect(target.workContinuations.get(pending.run.workActionId!)?.acceptances?.at(-1))
      .toEqual(expect.objectContaining({
        status: "accepted",
        mode: "human",
        report: expect.objectContaining({ outcome: "unverified" }),
      }));
    target.close();
  });

  test("deleting a space removes its work context", async () => {
    const engine = new KnowledgeEngine({ dataDir: tempDir("ha-work-delete-") });
    const workItem = engine.workItems.create({
      space: SPACE,
      title: "删除时一起清理",
      nextActions: ["确认删除"],
    });
    engine.configureWorkContinuation(workItem.id, true);
    const action = engine.workContinuations.claimNext(workItem);
    engine.workContinuations.cancel(action.id);
    await engine.remember({ space: SPACE, source: "manual", content: "待删除" });

    const result = await engine.deleteSpace(SPACE);

    expect(result.workItemsDeleted).toBe(1);
    expect(engine.workItems.get(workItem.id)).toBeUndefined();
    expect(engine.workContinuations.get(action.id)).toBeUndefined();
    expect(engine.workContinuations.listPolicies(SPACE)).toEqual([]);
    engine.close();
  });

  test("pending action acceptance blocks both export and deletion", async () => {
    const engine = new KnowledgeEngine({
      dataDir: tempDir("ha-work-acceptance-guard-"),
      skillCatalog: new SkillCatalog({ roots: [] }),
      runProvider: async () => "写入完成，等待核对",
    });
    engine.ensureSpace(SPACE);
    const agent = engine.agents.create({
      name: "变更助手",
      permission: "write",
      workdir: tempDir("ha-work-acceptance-workdir-"),
    });
    engine.registry.updateMeta(SPACE, { agentId: agent.id });
    const item = engine.workItems.create({
      space: SPACE,
      title: "执行受控变更",
      nextActions: ["更新灰度配置"],
    });
    const pending = engine.startWorkContinuation(item.id);
    await engine.approveTaskRun(pending.run.id, "operator").completion;

    expect(engine.workContinuations.get(pending.run.workActionId!)?.status)
      .toBe("awaiting_acceptance");
    await expect(engine.exportSpace(SPACE)).rejects.toThrow("active work actions");
    await expect(engine.deleteSpace(SPACE)).rejects.toThrow("active work actions");
    expect(engine.registry.has(SPACE)).toBe(true);
    engine.close();
  });

  test("a blocked action archive validates its projected blocker", async () => {
    const source = new KnowledgeEngine({
      dataDir: tempDir("ha-work-blocked-archive-"),
      skillCatalog: new SkillCatalog({ roots: [] }),
      runProvider: async () => {
        throw new Error("检查服务不可用");
      },
    });
    source.ensureSpace(SPACE);
    const item = source.workItems.create({
      space: SPACE,
      title: "完成发布检查",
      nextActions: ["执行发布前检查"],
    });
    const started = source.startWorkContinuation(item.id);
    await started.completion;

    const archive = await source.exportSpace(SPACE);

    expect(archive.workActions).toEqual([
      expect.objectContaining({ status: "blocked", error: expect.stringContaining("检查服务不可用") }),
    ]);
    expect(() => parseSpaceArchive(archive)).not.toThrow();
    source.close();
  });

  test("a rejected action preserves its acceptance audit across archive restore", async () => {
    const source = new KnowledgeEngine({
      dataDir: tempDir("ha-work-rejected-archive-"),
      skillCatalog: new SkillCatalog({ roots: [] }),
      runProvider: async () => "变更执行完成",
    });
    source.ensureSpace(SPACE);
    const agent = source.agents.create({
      name: "归档变更助手",
      permission: "write",
      workdir: tempDir("ha-work-rejected-workdir-"),
    });
    source.registry.updateMeta(SPACE, { agentId: agent.id });
    const item = source.workItems.create({
      space: SPACE,
      title: "归档验收驳回",
      nextActions: ["更新灰度配置"],
    });
    const pending = source.startWorkContinuation(item.id);
    await source.approveTaskRun(pending.run.id, "operator").completion;
    source.rejectWorkAction(
      pending.run.workActionId!,
      pending.run.id,
      "local-admin",
      "结果缺少核对证据",
    );
    source.workItems.update(item.id, { phase: "active", blockers: [] });

    const archive = await source.exportSpace(SPACE);
    expect(() => parseSpaceArchive(archive)).not.toThrow();
    const target = new KnowledgeEngine({ dataDir: tempDir("ha-work-rejected-target-") });
    await target.restoreSpace(archive);

    expect(target.workContinuations.get(pending.run.workActionId!)).toEqual(
      expect.objectContaining({
        status: "blocked",
        acceptances: [expect.objectContaining({
          taskRunId: pending.run.id,
          status: "rejected",
          reason: "结果缺少核对证据",
        })],
      }),
    );
    expect(target.workItems.get(item.id)?.blockers).toEqual([
      "更新灰度配置：结果缺少核对证据",
    ]);
    source.close();
    target.close();
  });

  test("rejects an archive that turns a historical rejection into an acceptance", async () => {
    const source = new KnowledgeEngine({
      dataDir: tempDir("ha-work-historical-acceptance-"),
      skillCatalog: new SkillCatalog({ roots: [] }),
      runProvider: async () => "变更执行完成",
    });
    source.ensureSpace(SPACE);
    const agent = source.agents.create({
      name: "历史验收防重放助手",
      permission: "write",
      workdir: tempDir("ha-work-historical-acceptance-workdir-"),
    });
    source.registry.updateMeta(SPACE, { agentId: agent.id });
    const item = source.workItems.create({
      space: SPACE,
      title: "阻止历史验收重放",
      nextActions: ["更新灰度配置"],
    });
    const first = source.startWorkContinuation(item.id);
    await source.approveTaskRun(first.run.id, "operator").completion;
    source.rejectWorkAction(
      first.run.workActionId!,
      first.run.id,
      "local-admin",
      "第一次结果缺少核对证据",
    );
    const second = source.retryWorkAction(first.run.workActionId!);
    await source.approveTaskRun(second.run.id, "operator").completion;
    source.rejectWorkAction(
      second.run.workActionId!,
      second.run.id,
      "local-admin",
      "第二次结果仍缺少核对证据",
    );
    const archive = await source.exportSpace(SPACE);
    source.close();
    expect(() => parseSpaceArchive(archive)).not.toThrow();
    const forged = structuredClone(archive);
    forged.workActions[0]!.acceptances![0]!.status = "accepted";

    expect(() => parseSpaceArchive(forged)).toThrow(/workActions|accepted/i);
  });

  test("cancelling a rejected action retry leaves an archive-safe projection", async () => {
    const source = new KnowledgeEngine({
      dataDir: tempDir("ha-work-cancelled-retry-archive-"),
      skillCatalog: new SkillCatalog({ roots: [] }),
      runProvider: async () => "变更执行完成",
    });
    source.ensureSpace(SPACE);
    const agent = source.agents.create({
      name: "取消重试助手",
      permission: "write",
      workdir: tempDir("ha-work-cancelled-retry-workdir-"),
    });
    source.registry.updateMeta(SPACE, { agentId: agent.id });
    const item = source.workItems.create({
      space: SPACE,
      title: "取消被驳回动作的重试",
      nextActions: ["更新灰度配置"],
    });
    const first = source.startWorkContinuation(item.id);
    await source.approveTaskRun(first.run.id, "operator").completion;
    source.rejectWorkAction(
      first.run.workActionId!,
      first.run.id,
      "local-admin",
      "结果缺少核对证据",
    );

    const retry = source.retryWorkAction(first.run.workActionId!);
    expect(retry.state).toBe("awaiting_approval");
    expect(source.cancelWorkAction(first.run.workActionId!)).toBe(true);
    expect(source.workItems.get(item.id)).toEqual(expect.objectContaining({
      phase: "active",
      blockers: [],
      actionBlockers: {},
      nextActions: ["更新灰度配置"],
    }));

    const archive = await source.exportSpace(SPACE);
    expect(() => parseSpaceArchive(archive)).not.toThrow();
    const target = new KnowledgeEngine({ dataDir: tempDir("ha-work-cancelled-retry-target-") });
    await target.restoreSpace(archive);
    expect(target.workContinuations.get(first.run.workActionId!)).toEqual(
      expect.objectContaining({ status: "cancelled", checkpoint: undefined }),
    );
    source.close();
    target.close();
  });

  test("archive v14 restores the source trace referenced by a durable Chat Run", async () => {
    const source = new KnowledgeEngine({ dataDir: tempDir("ha-quality-archive-source-") });
    source.ensureSpace(SPACE);
    const trace = source.quality.recordTrace({
      spaces: [SPACE],
      question: "Who owns the backend?",
      outcome: "succeeded",
      source: "knowledge",
      answer: "Alice",
      citations: [{ slug: "people/alice", title: "Alice" }],
      latencyMs: 10,
      createdAt: 1_000,
    });
    const run = source.chatRuns.start({
      space: SPACE,
      input: "Who owns the backend?",
      trigger: "message",
      executionPlan: {
        version: 1,
        instruction: "Use the archived knowledge.",
        provider: "codex",
      },
      startedAt: 1_100,
    });
    source.chatRuns.begin(run.id, 1_200);
    source.chatRuns.succeed(run.id, {
      finishedAt: 1_300,
      output: "Alice",
      traceId: trace.id,
    });

    const archive = await source.exportSpace(SPACE);
    source.close();

    expect(archive.version).toBe(20);
    expect(archive.quality).toEqual({ traces: [trace], reruns: [] });
    const llm: LlmClient = {
      async complete() {
        return {
          text: "Bob",
          model: "archive-test-model",
          usage: {
            inputTokens: 10,
            outputTokens: 2,
            costBasis: "unavailable",
            source: "legacy-text",
          },
        };
      },
      async completeJSON<T>(): Promise<T> {
        throw new Error("empty archived knowledge must use general completion");
      },
    };
    const target = new KnowledgeEngine({
      dataDir: tempDir("ha-quality-archive-target-"),
      llm,
    });
    await target.restoreSpace(archive);

    expect(target.chatRuns.get(run.id)?.traceId).toBe(trace.id);
    expect(target.answerTrace(trace.id)).toEqual(trace);
    const rerun = await target.rerunChatRunForEvaluation(run.id);
    expect(rerun.status).toBe("completed");
    expect(target.answerTrace(rerun.candidateTraceId!)?.answer).toBe("Bob");
    target.close();

    const legacy = structuredClone(archive) as Record<string, any>;
    legacy.version = 13;
    legacyRunPlanFixtures(legacy);
    delete legacy.quality;
    const normalizedLegacy = parseSpaceArchive(legacy);
    expect(normalizedLegacy.chatRuns[0]?.traceId).toBeUndefined();
    expect(normalizedLegacy.quality).toEqual({ traces: [], reruns: [] });

    const wrongSpace = structuredClone(archive);
    wrongSpace.quality.traces[0]!.spaces = ["team/oc_other"];
    expect(() => parseSpaceArchive(wrongSpace)).toThrow(/chat run trace.*space/i);
  });

  test("merges a shared multi-space trace in either restore order and stays fail-closed while incomplete", async () => {
    const secondary: SpaceId = "team/oc_governance_secondary";
    const source = new KnowledgeEngine({ dataDir: tempDir("ha-shared-quality-source-") });
    source.ensureSpace(SPACE);
    source.ensureSpace(secondary);
    const trace = source.quality.recordTrace({
      spaces: [SPACE, secondary],
      question: "What changed across both teams?",
      outcome: "succeeded",
      answer: "Both teams changed their release process.",
      citations: [],
      latencyMs: 10,
      createdAt: 1_000,
    });
    const createRun = (space: SpaceId, startedAt: number) => {
      const run = source.chatRuns.start({
        space,
        input: "What changed?",
        trigger: "message",
        executionPlan: {
          version: 1,
          instruction: "Compare both archived spaces.",
          provider: "codex",
        },
        startedAt,
      });
      source.chatRuns.begin(run.id, startedAt + 1);
      source.chatRuns.succeed(run.id, {
        finishedAt: startedAt + 2,
        output: "Both teams changed their release process.",
        traceId: trace.id,
      });
      return run;
    };
    const firstRun = createRun(SPACE, 1_100);
    const secondRun = createRun(secondary, 1_200);
    const firstArchive = await source.exportSpace(SPACE);
    const secondArchive = await source.exportSpace(secondary);
    source.close();

    expect(firstArchive.quality.traces).toEqual([trace]);
    expect(secondArchive.quality.traces).toEqual([trace]);
    const target = new KnowledgeEngine({ dataDir: tempDir("ha-shared-quality-target-") });
    await target.restoreSpace(secondArchive);
    await expect(target.rerunChatRunForEvaluation(secondRun.id))
      .rejects.toThrow(/trace spaces are unavailable/i);
    await target.restoreSpace(firstArchive);
    expect(target.answerTrace(trace.id)?.spaces).toEqual([SPACE, secondary]);
    expect(target.chatRuns.get(firstRun.id)?.traceId).toBe(trace.id);
    target.close();

    const reverse = new KnowledgeEngine({ dataDir: tempDir("ha-shared-quality-reverse-") });
    await reverse.restoreSpace(firstArchive);
    await reverse.restoreSpace(secondArchive);
    expect(reverse.answerTrace(trace.id)).toEqual(trace);
    expect(reverse.chatRuns.get(secondRun.id)?.traceId).toBe(trace.id);
    reverse.close();
  });

  test("archive v14 preserves durable retry disposition and honest usage", async () => {
    const dataDir = tempDir("ha-retry-archive-");
    const source = new KnowledgeEngine({ dataDir });
    source.ensureSpace(SPACE);
    const task = source.tasks.create({
      name: "archived retry",
      space: SPACE,
      topic: "preserve automatic retry audit",
      distillOnRun: false,
    })!;
    const run = source.taskRuns.start({
      task,
      trigger: "scheduled",
      provider: "claude",
      executionPlan: {
        version: 1,
        instruction: "Frozen retry archive plan.",
        provider: "claude",
        execution: { permission: "read-only", skills: [] },
      },
      distill: false,
      startedAt: 100,
    });
    source.taskRuns.begin(run.id, 110);
    source.taskRuns.fail(run.id, {
      finishedAt: 120,
      error: "Error: provider overloaded (503)",
      failure: { phase: "provider", kind: "overloaded", retryable: true },
      retry: {
        attempt: 1,
        maxAttempts: 2,
        status: "waiting",
        nextAttemptAt: 60_120,
      },
    });
    const child = source.taskRuns.claimRetry(run.id, 60_120)!;
    source.taskRuns.admitLaunch(child.id);
    source.taskRuns.begin(child.id, 60_121);
    source.taskRuns.fail(child.id, {
      finishedAt: 60_122,
      error: "Error: provider overloaded (503)",
      failure: { phase: "provider", kind: "overloaded", retryable: true },
      retry: {
        attempt: 2,
        maxAttempts: 2,
        status: "exhausted",
      },
      usage: {
        calls: 1,
        knownTokenCalls: 1,
        unknownTokenCalls: 0,
        knownCostCalls: 0,
        unknownCostCalls: 1,
        inputTokens: 42,
        costBasis: "unavailable",
        sources: ["codex-jsonl"],
      },
    });

    const archive = await source.exportSpace(SPACE);
    source.close();
    expect(archive.version).toBe(20);
    const archivedChild = archive.taskRuns.find((item) => item.id === child.id)!;
    expect(archivedChild).toEqual(expect.objectContaining({
      failure: { phase: "provider", kind: "overloaded", retryable: true },
      retry: {
        attempt: 2,
        maxAttempts: 2,
        status: "exhausted",
      },
      usage: expect.objectContaining({
        calls: 1,
        knownTokenCalls: 1,
        unknownCostCalls: 1,
        inputTokens: 42,
      }),
    }));
    expect("costUsd" in archivedChild.usage!).toBe(false);

    const target = new KnowledgeEngine({ dataDir: tempDir("ha-retry-archive-restore-") });
    await target.restoreSpace(archive);
    expect(target.getTaskRun(child.id)).toEqual(archivedChild);
    target.close();

    const corrupt = structuredClone(archive) as Record<string, any>;
    const corruptChild = corrupt.taskRuns.find((item: any) => item.id === child.id);
    corruptChild.retry.maxAttempts = 3;
    expect(() => parseSpaceArchive(corrupt)).toThrow(/retry/i);
  });

  test("refuses to export a waiting retry as ordinary terminal history", async () => {
    const source = new KnowledgeEngine({ dataDir: tempDir("ha-waiting-retry-export-") });
    source.ensureSpace(SPACE);
    const task = source.tasks.create({
      name: "waiting retry export guard",
      space: SPACE,
      topic: "potential future execution",
      distillOnRun: false,
    })!;
    const run = source.taskRuns.start({
      task,
      trigger: "scheduled",
      executionPlan: {
        version: 1,
        instruction: "Do not make this portable.",
        provider: "claude",
        execution: { permission: "read-only", skills: [] },
      },
      distill: false,
      startedAt: 1,
    });
    source.taskRuns.begin(run.id, 2);
    source.taskRuns.fail(run.id, {
      finishedAt: 3,
      error: "Error: provider overloaded (503)",
      failure: { phase: "provider", kind: "overloaded", retryable: true },
      retry: {
        attempt: 1,
        maxAttempts: 2,
        status: "waiting",
        nextAttemptAt: 60_003,
      },
    });

    await expect(source.exportSpace(SPACE)).rejects.toThrow(/active|waiting|retry/i);
    source.close();
  });

  test("archive preserves expired approval deadlines and notification audit", async () => {
    const dataDir = tempDir("ha-expired-approval-archive-");
    const source = new KnowledgeEngine({ dataDir });
    source.ensureSpace(SPACE);
    const task = source.tasks.create({
      name: "expired archived approval",
      space: SPACE,
      topic: "preserve the closed approval request",
      distillOnRun: false,
    })!;
    const run = source.taskRuns.start({
      task,
      trigger: "manual",
      distill: false,
      startedAt: 100,
      approvalRequired: true,
      executionPlan: {
        version: 1,
        instruction: "Archived expired write request.",
        provider: "codex",
        execution: { permission: "write", workdir: dataDir, skills: [] },
      },
    });
    await source.deliverTaskRunApprovalNotification(
      run.id,
      async () => {},
      { attemptedAt: 101 },
    );
    source.expireTaskRunApprovals(run.approval!.expiresAt!);

    const archive = await source.exportSpace(SPACE);
    source.close();
    expect(archive.version).toBe(20);
    expect(archive.taskRuns[0]).toEqual(expect.objectContaining({
      approval: expect.objectContaining({
        status: "expired",
        expiresAt: run.approval!.expiresAt,
      }),
      approvalNotification: expect.objectContaining({
        status: "sent",
        attempts: 1,
      }),
    }));

    const targetDir = tempDir("ha-expired-approval-restore-");
    const target = new KnowledgeEngine({ dataDir: targetDir });
    await target.restoreSpace(archive);
    expect(target.getTaskRun(run.id)).toEqual(expect.objectContaining({
      approval: expect.objectContaining({ status: "expired" }),
      approvalNotification: expect.objectContaining({ status: "sent" }),
    }));
    target.close();
  });

  test("archive v12 preserves Agent revision history and Task approval audit", async () => {
    const dataDir = tempDir("ha-lifecycle-archive-");
    const source = new KnowledgeEngine({
      dataDir,
      skillCatalog: new SkillCatalog({ roots: [] }),
      runProvider: async () => "approved archive output",
    });
    source.ensureSpace(SPACE);
    const created = source.agents.create({
      name: "Archived Agent",
      instruction: "release one",
      provider: "claude",
      permission: "write",
      workdir: dataDir,
    });
    const draft = source.saveAgentDraft(created.id, { instruction: "release two" })!;
    source.releaseAgent(created.id, draft.id);
    source.updateSpaceMeta(SPACE, { agentId: created.id });
    const task = source.tasks.create({
      name: "approved archive task",
      space: SPACE,
      topic: "preserve approval",
      distillOnRun: false,
    })!;
    const pending = source.startTaskRun(task.id);
    const completed = await source.approveTaskRun(pending.run.id, "archive-admin").completion;
    expect(completed.status).toBe("succeeded");

    const expectedRevisions = source.agents.listRevisions(created.id);
    const archive = await source.exportSpace(SPACE);
    source.close();
    expect(archive.version).toBe(20);
    expect(archive.agentRevisions).toEqual(expectedRevisions);
    expect(archive.taskRuns[0]?.approval).toEqual(expect.objectContaining({
      status: "approved",
      decidedBy: "archive-admin",
    }));

    const targetDir = tempDir("ha-lifecycle-restore-");
    const target = new KnowledgeEngine({ dataDir: targetDir });
    await target.restoreSpace(archive);
    expect(target.agents.listRevisions(created.id)).toEqual(expectedRevisions);
    expect(target.listTaskRuns(task.id)[0]?.approval).toEqual(expect.objectContaining({
      status: "approved",
      decidedBy: "archive-admin",
    }));
    target.close();

    const restarted = new KnowledgeEngine({ dataDir: targetDir });
    expect(restarted.agents.get(created.id)).toEqual(archive.agent);
    expect(restarted.agents.listRevisions(created.id)).toEqual(expectedRevisions);
    restarted.close();
  });

  test("v12 rejects Task approval fields that TaskRunStore cannot reopen", async () => {
    const dataDir = tempDir("ha-approval-schema-source-");
    const source = new KnowledgeEngine({
      dataDir,
      skillCatalog: new SkillCatalog({ roots: [] }),
      runProvider: async () => "approved output",
    });
    source.ensureSpace(SPACE);
    const agent = source.agents.create({
      name: "Approval schema Agent",
      provider: "claude",
      permission: "write",
      workdir: dataDir,
    });
    source.updateSpaceMeta(SPACE, { agentId: agent.id });
    const task = source.tasks.create({
      name: "approval schema task",
      space: SPACE,
      topic: "validate approval archive",
      distillOnRun: false,
    })!;
    const pending = source.startTaskRun(task.id);
    await source.approveTaskRun(pending.run.id, "archive-admin").completion;
    const archive = await source.exportSpace(SPACE);
    source.close();

    const negativeRequestedAt = structuredClone(archive);
    negativeRequestedAt.taskRuns[0]!.approval!.requestedAt = -1;
    expect(() => parseSpaceArchive(negativeRequestedAt)).toThrow(/requestedAt|timestamp/i);

    const emptyDecider = structuredClone(archive);
    emptyDecider.taskRuns[0]!.approval!.decidedBy = "";
    expect(() => parseSpaceArchive(emptyDecider)).toThrow(/decidedBy|empty/i);

    const executionBeforeApproval = structuredClone(archive);
    executionBeforeApproval.taskRuns[0]!.runStartedAt =
      executionBeforeApproval.taskRuns[0]!.approval!.decidedAt! - 1;
    expect(() => parseSpaceArchive(executionBeforeApproval))
      .toThrow(/approval|runStartedAt|timestamp/i);

    const completionBeforeApproval = structuredClone(archive);
    completionBeforeApproval.taskRuns[0]!.runStartedAt = undefined;
    completionBeforeApproval.taskRuns[0]!.approval!.decidedAt =
      completionBeforeApproval.taskRuns[0]!.finishedAt! + 1;
    expect(() => parseSpaceArchive(completionBeforeApproval))
      .toThrow(/approval|finishedAt|timestamp/i);
  });

  test("v12 rejects Agent lifecycle states that AgentStore cannot reopen", async () => {
    const source = new KnowledgeEngine({ dataDir: tempDir("ha-lifecycle-invalid-") });
    source.ensureSpace(SPACE);
    const created = source.agents.create({
      name: "Lifecycle invariant",
      instruction: "release one",
      provider: "claude",
    });
    const draft = source.saveAgentDraft(created.id, { instruction: "release two" })!;
    source.releaseAgent(created.id, draft.id);
    source.updateSpaceMeta(SPACE, { agentId: created.id });
    const archive = await source.exportSpace(SPACE);
    source.close();

    const publishedDraft = structuredClone(archive);
    publishedDraft.agentRevisions.find(
      (revision) => revision.id === publishedDraft.agent?.publishedRevisionId,
    )!.source = "draft";
    expect(() => parseSpaceArchive(publishedDraft)).toThrow(/published.*draft/i);

    const staleMaterialization = structuredClone(archive);
    staleMaterialization.agent!.updatedAt += 1;
    expect(() => parseSpaceArchive(staleMaterialization)).toThrow(/updatedAt|materialized/i);

    const futureAncestor = structuredClone(archive);
    const newest = futureAncestor.agentRevisions[0]!;
    const oldest = futureAncestor.agentRevisions.at(-1)!;
    oldest.basedOnRevisionId = newest.id;
    expect(() => parseSpaceArchive(futureAncestor)).toThrow(/ancestry|references/i);

    const badRevisionId = structuredClone(archive);
    const published = badRevisionId.agentRevisions.find(
      (revision) => revision.id === badRevisionId.agent?.publishedRevisionId,
    )!;
    published.id = "bad";
    badRevisionId.agent!.publishedRevisionId = "bad";
    expect(() => parseSpaceArchive(badRevisionId)).toThrow(/revision.*invalid/i);

    const oversized = structuredClone(archive);
    oversized.agentRevisions = Array.from(
      { length: 10_001 },
      () => structuredClone(archive.agentRevisions[0]!),
    );
    expect(() => parseSpaceArchive(oversized)).toThrow(/10,?000|too many/i);
  });

  test("v10 JSON archive preserves a frozen execution plan across restart and v14 round-trip", async () => {
    const sourceDir = tempDir("ha-v10-disk-source-");
    const source = new KnowledgeEngine({
      dataDir: sourceDir,
      skillCatalog: new SkillCatalog({ roots: [] }),
      runProvider: async () => "archived read-only output",
    });
    source.ensureSpace(SPACE);
    const agent = source.agents.create({
      name: "v10 execution plan Agent",
      instruction: "Use the frozen v10 instruction.",
      provider: "claude",
      permission: "read-only",
    });
    source.updateSpaceMeta(SPACE, { agentId: agent.id });
    const task = source.tasks.create({
      name: "v10 execution plan task",
      space: SPACE,
      topic: "preserve the frozen execution plan",
      distillOnRun: false,
    })!;
    const started = source.startTaskRun(task.id);
    expect((await started.completion).status).toBe("succeeded");
    const current = structuredClone(await source.exportSpace(SPACE)) as Record<string, any>;
    const expectedPlan = legacyPlanFixture(current.taskRuns[0].executionPlan);
    source.close();

    current.version = 10;
    legacyRunPlanFixtures(current);
    delete current.agentRevisions;
    delete current.agent.publishedRevisionId;
    delete current.quality;
    for (const run of current.taskRuns) {
      delete run.approval;
      delete run.approvalNotification;
      delete run.failure;
      delete run.retry;
      delete run.usage;
    }
    const parsed = parseSpaceArchive(persistArchiveFixture(sourceDir, 10, current));
    expect(parsed.taskRuns[0]?.executionPlan).toEqual(expectedPlan);

    const restoredDir = tempDir("ha-v10-disk-restored-");
    const restored = new KnowledgeEngine({ dataDir: restoredDir });
    await restored.restoreSpace(parsed);
    restored.close();

    const restarted = new KnowledgeEngine({ dataDir: restoredDir });
    expect(restarted.listTaskRuns(task.id)[0]?.executionPlan).toEqual(expectedPlan);
    const upgraded = await restarted.exportSpace(SPACE);
    expect(upgraded.version).toBe(20);
    expect(upgraded.taskRuns[0]?.executionPlan).toEqual(expectedPlan);
    restarted.close();

    const fresh = new KnowledgeEngine({ dataDir: tempDir("ha-v10-disk-fresh-") });
    await fresh.restoreSpace(parseSpaceArchive(upgraded));
    expect(fresh.listTaskRuns(task.id)[0]?.executionPlan).toEqual(expectedPlan);
    fresh.close();
  });

  test("v10 terminal writable runs normalize to a closed legacy approval audit", async () => {
    const sourceDir = tempDir("ha-v10-writable-source-");
    const source = new KnowledgeEngine({
      dataDir: sourceDir,
      skillCatalog: new SkillCatalog({ roots: [] }),
      runProvider: async () => "legacy writable output",
    });
    source.ensureSpace(SPACE);
    const agent = source.agents.create({
      name: "Legacy writable Agent",
      provider: "claude",
      permission: "write",
      workdir: sourceDir,
    });
    source.updateSpaceMeta(SPACE, { agentId: agent.id });
    const task = source.tasks.create({
      name: "legacy writable task",
      space: SPACE,
      topic: "legacy writable history",
      distillOnRun: false,
    })!;
    const pending = source.startTaskRun(task.id);
    await source.approveTaskRun(pending.run.id, "pre-v11-admin").completion;
    const legacy = structuredClone(await source.exportSpace(SPACE)) as Record<string, any>;
    source.close();
    legacy.version = 10;
    legacyRunPlanFixtures(legacy);
    delete legacy.agentRevisions;
    delete legacy.agent.publishedRevisionId;
    delete legacy.taskRuns[0].approval;

    const normalized = parseSpaceArchive(legacy);
    expect(normalized.taskRuns[0]?.approval).toMatchObject({
      status: "legacy",
      decidedBy: "homeagent.archive-v10",
    });

    const targetDir = tempDir("ha-v10-writable-target-");
    const target = new KnowledgeEngine({ dataDir: targetDir });
    await target.restoreSpace(legacy);
    target.close();
    const restarted = new KnowledgeEngine({ dataDir: targetDir });
    const reexported = await restarted.exportSpace(SPACE);
    const reparsed = parseSpaceArchive(reexported);
    expect(reexported.taskRuns[0]?.approval?.status).toBe("legacy");
    restarted.close();
    const dishonest = structuredClone(reexported) as Record<string, any>;
    dishonest.taskRuns[0].approval.decidedAt = dishonest.taskRuns[0].finishedAt + 1;
    expect(() => parseSpaceArchive(dishonest)).toThrow(/legacy|approval|finishedAt/i);

    const roundTrip = new KnowledgeEngine({ dataDir: tempDir("ha-v10-writable-roundtrip-") });
    await roundTrip.restoreSpace(reparsed);
    expect(roundTrip.listTaskRuns(task.id)[0]?.approval?.status).toBe("legacy");
    roundTrip.close();
  });

  test("two v10 spaces bound to one Agent restore in either order without identity drift", async () => {
    const otherSpace: SpaceId = "team/oc_governance_second";
    const source = new KnowledgeEngine({ dataDir: tempDir("ha-v10-shared-agent-source-") });
    source.ensureSpace(SPACE);
    source.ensureSpace(otherSpace);
    const agent = source.agents.create({
      name: "Shared legacy Agent",
      instruction: "same identity and snapshot",
      provider: "codex",
    });
    source.updateSpaceMeta(SPACE, { agentId: agent.id });
    source.updateSpaceMeta(otherSpace, { agentId: agent.id });
    const first = structuredClone(await source.exportSpace(SPACE)) as Record<string, any>;
    const second = structuredClone(await source.exportSpace(otherSpace)) as Record<string, any>;
    source.close();
    for (const archive of [first, second]) {
      archive.version = 10;
      legacyRunPlanFixtures(archive);
      delete archive.agentRevisions;
      delete archive.agent.publishedRevisionId;
    }

    const targetDir = tempDir("ha-v10-shared-agent-target-");
    const target = new KnowledgeEngine({
      dataDir: targetDir,
      skillCatalog: new SkillCatalog({ roots: [] }),
      runProvider: async () => "legacy restored agent ran",
    });
    await target.restoreSpace(second);
    await target.restoreSpace(first);
    expect(target.registry.get(SPACE)?.agentId).toBe(agent.id);
    expect(target.registry.get(otherSpace)?.agentId).toBe(agent.id);
    const restored = target.agents.get(agent.id)!;
    expect(restored.updatedAt).toBe(agent.updatedAt);
    const task = target.tasks.create({
      name: "legacy restored Agent task",
      space: SPACE,
      topic: "validate the synthesized revision id",
      distillOnRun: false,
    })!;
    const started = target.startTaskRun(task.id);
    expect(started.run.executionPlan?.agentRevisionId).toMatch(
      /^agent_revision_[a-zA-Z0-9-]{1,160}$/,
    );
    expect((await started.completion).status).toBe("succeeded");
    target.close();

    const restarted = new KnowledgeEngine({ dataDir: targetDir });
    expect(restarted.agentForSpace(SPACE)).toEqual(restored);
    expect(restarted.agentForSpace(otherSpace)).toEqual(restored);
    restarted.close();
  });

  test("a v11 shared Agent restored before its v10 sibling keeps one runnable identity", async () => {
    const sibling: SpaceId = "team/oc_governance_mixed_v10";
    const source = new KnowledgeEngine({ dataDir: tempDir("ha-mixed-agent-source-") });
    source.ensureSpace(SPACE);
    source.ensureSpace(sibling);
    const agent = source.agents.create({
      name: "Mixed archive Agent",
      instruction: "Keep one identity across archive versions.",
      provider: "claude",
      permission: "read-only",
    });
    source.updateSpaceMeta(SPACE, { agentId: agent.id });
    source.updateSpaceMeta(sibling, { agentId: agent.id });
    const v11 = structuredClone(await source.exportSpace(SPACE)) as Record<string, any>;
    const v10 = structuredClone(await source.exportSpace(sibling)) as Record<string, any>;
    source.close();

    v11.version = 11;
    legacyRunPlanFixtures(v11);
    delete v11.quality;
    v11.agentRevisions[0].source = "migration";
    v10.version = 10;
    legacyRunPlanFixtures(v10);
    delete v10.agentRevisions;
    delete v10.agent.publishedRevisionId;
    delete v10.quality;

    const targetDir = tempDir("ha-mixed-agent-v11-first-");
    const target = new KnowledgeEngine({
      dataDir: targetDir,
      skillCatalog: new SkillCatalog({ roots: [] }),
      runProvider: async () => "mixed archive Agent ran",
    });
    try {
      await target.restoreSpace(v11);
      await target.restoreSpace(v10);
      expect(target.agentForSpace(SPACE)).toEqual(v11.agent);
      expect(target.agentForSpace(sibling)).toEqual(v11.agent);
      const task = target.tasks.create({
        name: "mixed archive identity task",
        space: sibling,
        topic: "prove the restored Agent remains runnable",
        distillOnRun: false,
      })!;
      const started = target.startTaskRun(task.id);
      expect((await started.completion).status).toBe("succeeded");
      expect(started.run.executionPlan?.agentRevisionId).toBe(v11.agent.publishedRevisionId);
    } finally {
      target.close();
    }

    const restarted = new KnowledgeEngine({ dataDir: targetDir });
    try {
      expect(restarted.agentForSpace(SPACE)).toEqual(v11.agent);
      expect(restarted.agentForSpace(sibling)).toEqual(v11.agent);
    } finally {
      restarted.close();
    }
  });

  test("a v10 shared Agent restored before its v11 sibling upgrades to one runnable identity", async () => {
    const sibling: SpaceId = "team/oc_governance_mixed_v11";
    const source = new KnowledgeEngine({ dataDir: tempDir("ha-mixed-agent-reverse-source-") });
    source.ensureSpace(SPACE);
    source.ensureSpace(sibling);
    const agent = source.agents.create({
      name: "Mixed reverse archive Agent",
      instruction: "Converge on the v11 identity in either restore order.",
      provider: "claude",
      permission: "read-only",
    });
    source.updateSpaceMeta(SPACE, { agentId: agent.id });
    source.updateSpaceMeta(sibling, { agentId: agent.id });
    const v10 = structuredClone(await source.exportSpace(SPACE)) as Record<string, any>;
    const v11 = structuredClone(await source.exportSpace(sibling)) as Record<string, any>;
    source.close();

    v10.version = 10;
    legacyRunPlanFixtures(v10);
    delete v10.agentRevisions;
    delete v10.agent.publishedRevisionId;
    delete v10.quality;
    v11.version = 11;
    legacyRunPlanFixtures(v11);
    delete v11.quality;
    v11.agentRevisions[0].source = "migration";

    const targetDir = tempDir("ha-mixed-agent-v10-first-");
    const target = new KnowledgeEngine({
      dataDir: targetDir,
      skillCatalog: new SkillCatalog({ roots: [] }),
      runProvider: async () => "reverse mixed archive Agent ran",
    });
    try {
      await target.restoreSpace(v10);
      await target.restoreSpace(v11);
      expect(target.agentForSpace(SPACE)).toEqual(v11.agent);
      expect(target.agentForSpace(sibling)).toEqual(v11.agent);
      expect(target.agents.listRevisions(agent.id)).toEqual(v11.agentRevisions);
      const task = target.tasks.create({
        name: "reverse mixed archive identity task",
        space: sibling,
        topic: "prove the authoritative v11 Agent remains runnable",
        distillOnRun: false,
      })!;
      const started = target.startTaskRun(task.id);
      expect((await started.completion).status).toBe("succeeded");
      expect(started.run.executionPlan?.agentRevisionId).toBe(v11.agent.publishedRevisionId);
    } finally {
      target.close();
    }

    const restarted = new KnowledgeEngine({ dataDir: targetDir });
    try {
      expect(restarted.agentForSpace(SPACE)).toEqual(v11.agent);
      expect(restarted.agentForSpace(sibling)).toEqual(v11.agent);
      expect(restarted.agents.listRevisions(agent.id)).toEqual(v11.agentRevisions);
    } finally {
      restarted.close();
    }
  });

  test("two v14 archives with genuinely different Agent histories still conflict", async () => {
    const sibling: SpaceId = "team/oc_governance_v14_history_conflict";
    const source = new KnowledgeEngine({ dataDir: tempDir("ha-v14-agent-conflict-source-") });
    source.ensureSpace(SPACE);
    source.ensureSpace(sibling);
    const agent = source.agents.create({
      name: "v14 history conflict Agent",
      instruction: "Keep published state stable.",
      provider: "claude",
    });
    source.updateSpaceMeta(SPACE, { agentId: agent.id });
    source.updateSpaceMeta(sibling, { agentId: agent.id });
    const first = await source.exportSpace(SPACE);
    source.saveAgentDraft(agent.id, { instruction: "Unpublished draft." });
    const second = await source.exportSpace(sibling);
    source.close();
    expect(second.agent).toEqual(first.agent);
    expect(second.agentRevisions).not.toEqual(first.agentRevisions);

    const target = new KnowledgeEngine({ dataDir: tempDir("ha-v14-agent-conflict-target-") });
    try {
      await target.restoreSpace(first);
      await expect(target.restoreSpace(second)).rejects.toThrow(/different revision history/i);
      expect(target.registry.has(SPACE)).toBe(true);
      expect(target.registry.has(sibling)).toBe(false);
    } finally {
      target.close();
    }
  });

  test("v11 JSON archive preserves Agent revisions and approved execution audit across restart", async () => {
    const sourceDir = tempDir("ha-v11-disk-source-");
    const source = new KnowledgeEngine({
      dataDir: sourceDir,
      skillCatalog: new SkillCatalog({ roots: [] }),
      runProvider: async () => "approved v11 output",
    });
    source.ensureSpace(SPACE);
    const agent = source.agents.create({
      name: "v11 lifecycle Agent",
      instruction: "release one",
      provider: "claude",
      permission: "write",
      workdir: sourceDir,
    });
    const draft = source.saveAgentDraft(agent.id, { instruction: "release two" })!;
    source.releaseAgent(agent.id, draft.id);
    source.updateSpaceMeta(SPACE, { agentId: agent.id });
    const task = source.tasks.create({
      name: "v11 approved task",
      space: SPACE,
      topic: "preserve approval evidence",
      distillOnRun: false,
    })!;
    const pending = source.startTaskRun(task.id);
    expect(pending.run.status).toBe("awaiting_approval");
    expect((await source.approveTaskRun(pending.run.id, "v11-admin").completion).status)
      .toBe("succeeded");
    const current = structuredClone(await source.exportSpace(SPACE)) as Record<string, any>;
    const expectedRevisions = structuredClone(current.agentRevisions);
    const expectedApproval = structuredClone(current.taskRuns[0].approval);
    source.close();

    current.version = 11;
    legacyRunPlanFixtures(current);
    delete current.quality;
    for (const run of current.taskRuns) {
      delete run.approval.expiresAt;
      delete run.approvalNotification;
      delete run.failure;
      delete run.retry;
      delete run.usage;
    }
    delete expectedApproval.expiresAt;
    const parsed = parseSpaceArchive(persistArchiveFixture(sourceDir, 11, current));
    expect(parsed.agentRevisions).toEqual(expectedRevisions);
    expect(parsed.taskRuns[0]?.approval).toEqual(expectedApproval);

    const restoredDir = tempDir("ha-v11-disk-restored-");
    const restored = new KnowledgeEngine({ dataDir: restoredDir });
    await restored.restoreSpace(parsed);
    restored.close();

    const restarted = new KnowledgeEngine({ dataDir: restoredDir });
    expect(restarted.agents.listRevisions(agent.id)).toEqual(expectedRevisions);
    expect(restarted.listTaskRuns(task.id)[0]?.approval).toEqual(expectedApproval);
    const upgraded = await restarted.exportSpace(SPACE);
    expect(upgraded.version).toBe(20);
    restarted.close();

    const fresh = new KnowledgeEngine({ dataDir: tempDir("ha-v11-disk-fresh-") });
    await fresh.restoreSpace(parseSpaceArchive(upgraded));
    expect(fresh.agents.listRevisions(agent.id)).toEqual(expectedRevisions);
    expect(fresh.listTaskRuns(task.id)[0]?.approval).toEqual(expectedApproval);
    fresh.close();
  });

  test("v11 JSON archive fails closed when writable execution lacks approval evidence", async () => {
    const sourceDir = tempDir("ha-v11-missing-approval-source-");
    const source = new KnowledgeEngine({
      dataDir: sourceDir,
      skillCatalog: new SkillCatalog({ roots: [] }),
      runProvider: async () => "approved before evidence removal",
    });
    source.ensureSpace(SPACE);
    const agent = source.agents.create({
      name: "v11 missing approval Agent",
      provider: "claude",
      permission: "full",
      workdir: sourceDir,
    });
    source.updateSpaceMeta(SPACE, { agentId: agent.id });
    const task = source.tasks.create({
      name: "v11 missing approval task",
      space: SPACE,
      topic: "reject unverifiable high privilege history",
      distillOnRun: false,
    })!;
    const pending = source.startTaskRun(task.id);
    expect((await source.approveTaskRun(pending.run.id, "v11-admin").completion).status)
      .toBe("succeeded");
    const legacy = structuredClone(await source.exportSpace(SPACE)) as Record<string, any>;
    source.close();

    legacy.version = 11;
    legacyRunPlanFixtures(legacy);
    delete legacy.quality;
    delete legacy.taskRuns[0].approval;
    delete legacy.taskRuns[0].approvalNotification;
    delete legacy.taskRuns[0].failure;
    delete legacy.taskRuns[0].retry;
    delete legacy.taskRuns[0].usage;
    const untrusted = persistArchiveFixture(sourceDir, 11, legacy);

    expect(() => parseSpaceArchive(untrusted)).toThrow(/approval.*required.*writable/i);
  });

  test("v12 JSON archive preserves approval expiry and notification audit across restart", async () => {
    const sourceDir = tempDir("ha-v12-disk-source-");
    const source = new KnowledgeEngine({ dataDir: sourceDir, skillCatalog: new SkillCatalog({ roots: [] }) });
    source.ensureSpace(SPACE);
    const agent = source.agents.create({
      name: "v12 expiring approval Agent",
      provider: "codex",
      permission: "write",
      workdir: sourceDir,
    });
    source.updateSpaceMeta(SPACE, { agentId: agent.id });
    const task = source.tasks.create({
      name: "v12 expired approval task",
      space: SPACE,
      topic: "preserve expiry and notification evidence",
      distillOnRun: false,
    })!;
    const pending = source.startTaskRun(task.id);
    await source.deliverTaskRunApprovalNotification(
      pending.run.id,
      async () => {},
      { attemptedAt: pending.run.approval!.requestedAt + 1 },
    );
    source.expireTaskRunApprovals(pending.run.approval!.expiresAt!);
    const current = structuredClone(await source.exportSpace(SPACE)) as Record<string, any>;
    const expectedApproval = structuredClone(current.taskRuns[0].approval);
    const expectedNotification = structuredClone(current.taskRuns[0].approvalNotification);
    source.close();

    current.version = 12;
    legacyRunPlanFixtures(current);
    delete current.quality;
    for (const run of current.taskRuns) {
      delete run.failure;
      delete run.retry;
      delete run.usage;
    }
    const parsed = parseSpaceArchive(persistArchiveFixture(sourceDir, 12, current));
    expect(parsed.taskRuns[0]).toEqual(expect.objectContaining({
      status: "cancelled",
      approval: expectedApproval,
      approvalNotification: expectedNotification,
    }));

    const restoredDir = tempDir("ha-v12-disk-restored-");
    const restored = new KnowledgeEngine({ dataDir: restoredDir });
    await restored.restoreSpace(parsed);
    restored.close();

    const restarted = new KnowledgeEngine({ dataDir: restoredDir });
    expect(restarted.listTaskRuns(task.id)[0]).toEqual(expect.objectContaining({
      approval: expectedApproval,
      approvalNotification: expectedNotification,
    }));
    const upgraded = await restarted.exportSpace(SPACE);
    expect(upgraded.version).toBe(20);
    restarted.close();

    const fresh = new KnowledgeEngine({ dataDir: tempDir("ha-v12-disk-fresh-") });
    await fresh.restoreSpace(parseSpaceArchive(upgraded));
    expect(fresh.listTaskRuns(task.id)[0]).toEqual(expect.objectContaining({
      approval: expectedApproval,
      approvalNotification: expectedNotification,
    }));
    fresh.close();
  });

  test("v13 JSON archive preserves retry usage and drops pre-v14 quality references", async () => {
    const sourceDir = tempDir("ha-v13-disk-source-");
    const source = new KnowledgeEngine({ dataDir: sourceDir });
    source.ensureSpace(SPACE);
    const task = source.tasks.create({
      name: "v13 retry task",
      space: SPACE,
      topic: "preserve retry and honest usage",
      distillOnRun: false,
    })!;
    const parent = source.taskRuns.start({
      task,
      trigger: "scheduled",
      provider: "claude",
      executionPlan: {
        version: 1,
        instruction: "Frozen v13 retry plan.",
        provider: "claude",
        execution: { permission: "read-only", skills: [] },
      },
      distill: false,
      startedAt: 100,
    });
    source.taskRuns.begin(parent.id, 110);
    source.taskRuns.fail(parent.id, {
      finishedAt: 120,
      error: "Error: provider overloaded (503)",
      failure: { phase: "provider", kind: "overloaded", retryable: true },
      retry: {
        attempt: 1,
        maxAttempts: 2,
        status: "waiting",
        nextAttemptAt: 60_120,
      },
    });
    const child = source.taskRuns.claimRetry(parent.id, 60_120)!;
    source.taskRuns.admitLaunch(child.id);
    source.taskRuns.begin(child.id, 60_121);
    source.taskRuns.fail(child.id, {
      finishedAt: 60_122,
      error: "Error: provider overloaded (503)",
      failure: { phase: "provider", kind: "overloaded", retryable: true },
      retry: { attempt: 2, maxAttempts: 2, status: "exhausted" },
      usage: {
        calls: 1,
        knownTokenCalls: 1,
        unknownTokenCalls: 0,
        knownCostCalls: 0,
        unknownCostCalls: 1,
        inputTokens: 42,
        costBasis: "unavailable",
        sources: ["codex-jsonl"],
      },
    });
    const trace = source.quality.recordTrace({
      spaces: [SPACE],
      question: "What changed?",
      outcome: "succeeded",
      answer: "The retry policy changed.",
      citations: [],
      latencyMs: 10,
      createdAt: 70_000,
    });
    const chat = source.chatRuns.start({
      space: SPACE,
      input: "What changed?",
      trigger: "message",
      executionPlan: {
        version: 1,
        instruction: "Frozen v13 chat plan.",
        provider: "claude",
      },
      startedAt: 70_100,
    });
    source.chatRuns.begin(chat.id, 70_101);
    source.chatRuns.succeed(chat.id, {
      finishedAt: 70_102,
      output: "The retry policy changed.",
      traceId: trace.id,
      usage: {
        calls: 1,
        knownTokenCalls: 0,
        unknownTokenCalls: 1,
        knownCostCalls: 0,
        unknownCostCalls: 1,
        costBasis: "unavailable",
        sources: ["legacy-text"],
      },
    });
    const current = structuredClone(await source.exportSpace(SPACE)) as Record<string, any>;
    const expectedParentRetry = structuredClone(
      current.taskRuns.find((run: any) => run.id === parent.id).retry,
    );
    const expectedChild = structuredClone(
      current.taskRuns.find((run: any) => run.id === child.id),
    );
    const expectedChatUsage = structuredClone(current.chatRuns[0].usage);
    source.close();

    current.version = 13;
    legacyRunPlanFixtures(current);
    delete current.quality;
    const parsed = parseSpaceArchive(persistArchiveFixture(sourceDir, 13, current));
    expect(parsed.taskRuns.find((run) => run.id === parent.id)?.retry)
      .toEqual(expectedParentRetry);
    expect(parsed.taskRuns.find((run) => run.id === child.id)).toEqual(expectedChild);
    expect(parsed.chatRuns[0]?.usage).toEqual(expectedChatUsage);
    expect(parsed.chatRuns[0]?.traceId).toBeUndefined();
    expect(parsed.quality).toEqual({ traces: [], reruns: [] });

    const restoredDir = tempDir("ha-v13-disk-restored-");
    const restored = new KnowledgeEngine({ dataDir: restoredDir });
    await restored.restoreSpace(parsed);
    restored.close();

    const restarted = new KnowledgeEngine({ dataDir: restoredDir });
    expect(restarted.getTaskRun(child.id)).toEqual(expectedChild);
    expect(restarted.chatRuns.get(chat.id)?.traceId).toBeUndefined();
    const upgraded = await restarted.exportSpace(SPACE);
    expect(upgraded.version).toBe(20);
    expect(upgraded.quality).toEqual({ traces: [], reruns: [] });
    restarted.close();

    const fresh = new KnowledgeEngine({ dataDir: tempDir("ha-v13-disk-fresh-") });
    await fresh.restoreSpace(parseSpaceArchive(upgraded));
    expect(fresh.getTaskRun(child.id)).toEqual(expectedChild);
    expect(fresh.chatRuns.get(chat.id)?.usage).toEqual(expectedChatUsage);
    expect(fresh.chatRuns.get(chat.id)?.traceId).toBeUndefined();
    fresh.close();
  });

  test("exports and parses exact Agent Skill source bindings", async () => {
    const dataDir = tempDir("ha-skill-archive-");
    const skillRoot = join(dataDir, "skills");
    mkdirSync(join(skillRoot, "review"), { recursive: true });
    writeFileSync(
      join(skillRoot, "review", "SKILL.md"),
      ["---", "name: review", "description: Review.", "---"].join("\n"),
      "utf8",
    );
    const engine = new KnowledgeEngine({
      dataDir,
      skillCatalog: new SkillCatalog({
        roots: [{ kind: "codex-user", path: skillRoot, providerIds: ["codex"] }],
      }),
    });
    engine.ensureSpace(SPACE);
    const agent = engine.agents.create({
      name: "bound",
      provider: "codex",
      skills: [{
        kind: "source",
        sourceKey: "codex-user:review",
        name: "review",
      }],
    });
    engine.registry.updateMeta(SPACE, { agentId: agent.id });

    const archive = await engine.exportSpace(SPACE);
    engine.close();
    const parsed = parseSpaceArchive(archive);

    expect(parsed.agent?.skills).toEqual([{
      kind: "source",
      sourceKey: "codex-user:review",
      name: "review",
    }]);
  });

  test("keeps version 6 Agent Skill names as unresolved legacy bindings", async () => {
    const engine = new KnowledgeEngine({ dataDir: tempDir("ha-v6-skill-archive-") });
    engine.ensureSpace(SPACE);
    const agent = engine.agents.create({ name: "legacy", provider: "codex" });
    engine.registry.updateMeta(SPACE, { agentId: agent.id });
    const archive = await engine.exportSpace(SPACE);
    engine.close();

    const parsed = parseSpaceArchive({
      ...archive,
      version: 6,
      agent: {
        ...archive.agent,
        skills: ["review", "review", "ship"],
      },
    });

    expect(parsed.agent?.skills).toEqual([
      { kind: "legacy-name", name: "review" },
      { kind: "legacy-name", name: "ship" },
    ]);
  });

  test("a versioned export restores the complete space into a fresh data directory", async () => {
    const source = new KnowledgeEngine({
      dataDir: tempDir("hb-export-"),
      skillCatalog: new SkillCatalog({ roots: [] }),
      runProvider: async () => "项目运行记录",
    });
    source.ensureSpace(SPACE, { chatId: "oc_governance" });
    const agent = source.agents.create({
      name: "治理助手",
      instruction: "只依据空间知识回答",
      provider: "codex",
    });
    source.registry.updateMeta(SPACE, {
      name: "治理群",
      agentId: agent.id,
      participationLevel: "active",
    });
    await source.updateSpaceRules(
      SPACE,
      { purpose: "# 治理目标\n\n保留可验证的团队事实。" },
      "local-admin",
    );
    const rawId = await source.remember({
      space: SPACE,
      source: "message",
      agentId: agent.id,
      author: "ou_owner",
      chatId: "oc_governance",
      messageId: "om_keep",
      content: "项目代号是北极星",
      createdAt: 1_700_000_000_000,
    });
    await source.recordAgentResponse(SPACE, {
      chatId: "oc_governance",
      messageId: "om_keep",
      response: "已记录：项目代号是北极星。",
      respondedAt: 1_700_000_000_500,
    });
    const page: Page = {
      slug: "concepts/project-code",
      type: "concept",
      title: "项目代号",
      summary: "项目代号是北极星",
      aliases: [],
      tags: ["project"],
      sources: [rawId],
      links: [],
      content: "# 项目代号\n\n北极星。",
      updatedAt: 1_700_000_100_000,
      contentHash: "hash-project-code",
    };
    await source.upsertPage(SPACE, page);
    // Markdown is authoritative; simulate a missing/stale rebuildable index.
    source.registry.store(SPACE).index().deletePage(page.slug);
    const task = source.tasks.create({
      name: "每周报告",
      space: SPACE,
      topic: "项目进展",
      cadence: "weekly",
      dayOfWeek: 5,
      hour: 17,
      distillOnRun: false,
    })!;
    await source.runTask(task.id, { trigger: "scheduled" });
    const chatRun = source.chatRuns.start({
      space: SPACE,
      input: "archive this durable chat",
      trigger: "message",
      agentId: agent.id,
      provider: "codex",
      model: "gpt-5.6",
      executionPlan: {
        version: 1,
        instruction: "frozen-chat-instruction",
        provider: "codex",
        model: "gpt-5.6",
      },
      timeoutMs: 25 * 60_000,
      startedAt: 1_700_000_150_000,
    });
    source.chatRuns.succeed(chatRun.id, {
      finishedAt: chatRun.startedAt,
      output: "durable chat result",
      executionEvidence: {
        calls: [{ source: "codex-jsonl", events: [], truncated: false, execution: {
          executionMode: "isolated", sandboxCheck: "not-checked", effectiveSandbox: "read-only",
          process: "started", model: "verified",
        } }],
        truncated: false,
      },
      usage: {
        calls: 1,
        knownTokenCalls: 1,
        unknownTokenCalls: 0,
        knownCostCalls: 1,
        unknownCostCalls: 0,
        inputTokens: 25,
        outputTokens: 5,
        costUsd: 0.003,
        costBasis: "reported",
        sources: ["codex-jsonl"],
      },
    });
    source.reminders.create({
      title: "提交每日报告",
      space: SPACE,
      chatId: "oc_governance",
      creatorId: "ou_owner",
      triggerAt: 1_800_000_000_000,
    });
    const learningPlan = source.learning.create({
      name: "读《原则》",
      space: SPACE,
      creatorId: "ou_owner",
      chatId: "oc_governance",
      sourceTitle: "principles.md",
      sourceContent: "# 第一章\n\n项目原则正文",
      sourceRawIds: [rawId],
      sourceMessageId: "om_keep",
    }, 1_700_000_200_000);
    const learningSession = source.learning.prepareSession(learningPlan.id, {
      startOffset: 0,
      endOffset: learningPlan.sourceLength,
      sectionTitle: "第一章",
      excerpt: "# 第一章\n\n项目原则正文",
      guide: "## 今日目标\n理解原则",
      preparedAt: 1_700_000_300_000,
    })!;
    source.learning.markDelivered(learningSession.id, 1_700_000_400_000);
    await source.remember({
      space: SPACE,
      source: "message",
      author: "ou_owner",
      chatId: "oc_governance",
      messageId: "om_retracted",
      content: "不应保留",
    });
    await source.retractMessage(SPACE, {
      chatId: "oc_governance",
      messageId: "om_retracted",
      requestedBy: "ou_owner",
    });

    const archive = await source.exportSpace(SPACE);
    expect(archive).toEqual(
      expect.objectContaining({
        format: "homeagent.space",
        version: 20,
        space: expect.objectContaining({
          id: SPACE,
          name: "治理群",
          agentId: agent.id,
          participationLevel: "active",
        }),
        agent: expect.objectContaining({ id: agent.id, name: "治理助手" }),
        agentRevisions: [expect.objectContaining({
          id: agent.publishedRevisionId,
          source: "create",
        })],
        pages: [expect.objectContaining({ slug: page.slug, title: page.title })],
        raw: expect.arrayContaining([
          expect.objectContaining({
            id: rawId,
            messageId: "om_keep",
            agentId: agent.id,
            agentResponse: "已记录：项目代号是北极星。",
            agentRespondedAt: 1_700_000_000_500,
          }),
          expect.objectContaining({ source: "task", content: expect.stringContaining("项目运行记录") }),
        ]),
        retractions: [
          expect.objectContaining({ chatId: "oc_governance", messageId: "om_retracted" }),
        ],
        tasks: [expect.objectContaining({
          name: "每周报告",
          space: SPACE,
          cadence: "weekly",
          dayOfWeek: 5,
          hour: 17,
        })],
        taskRuns: [
          expect.objectContaining({
            taskId: task.id,
            status: "succeeded",
            trigger: "scheduled",
            output: "项目运行记录",
          }),
        ],
        reminders: [expect.objectContaining({ title: "提交每日报告", space: SPACE })],
        learning: {
          plans: [expect.objectContaining({ id: learningPlan.id, name: "读《原则》" })],
          sources: [expect.objectContaining({ title: "principles.md", rawIds: [rawId] })],
          sessions: [expect.objectContaining({ id: learningSession.id, status: "awaiting_reply" })],
        },
        governanceAudit: [
          expect.objectContaining({
            action: "rules_updated",
            actor: "local-admin",
            target: "purpose",
          }),
        ],
      }),
    );
    source.close();

    const restored = new KnowledgeEngine({ dataDir: tempDir("hb-restore-") });
    await restored.restoreSpace(archive);
    expect(await restored.getPage(SPACE, page.slug)).toEqual(archive.pages[0]!);
    expect(restored.registry.get(SPACE)).toEqual(expect.objectContaining(archive.space));
    expect(restored.registry.get(SPACE)?.agentBindingEpoch).toMatch(/^[0-9a-f-]{36}$/);
    expect(restored.agentForSpace(SPACE)).toEqual(archive.agent);
    expect(restored.agents.listRevisions(agent.id)).toEqual(archive.agentRevisions);
    expect(restored.tasks.list()).toEqual(archive.tasks);
    expect(restored.listTaskRuns(task.id)).toEqual(archive.taskRuns);
    expect(archive.chatRuns[0]?.executionEvidence).toBeUndefined();
    expect(restored.chatRuns.list(SPACE)).toEqual(archive.chatRuns);
    expect(restored.reminders.list()).toEqual(archive.reminders);
    expect(restored.learning.exportBySpace(SPACE)).toEqual(archive.learning);
    const roundTrip = await restored.exportSpace(SPACE);
    expect(roundTrip.raw).toEqual(archive.raw);
    expect(roundTrip.retractions).toEqual(archive.retractions);
    expect(roundTrip.reminders).toEqual(archive.reminders);
    expect(roundTrip.taskRuns).toEqual(archive.taskRuns);
    expect(roundTrip.chatRuns).toEqual(archive.chatRuns);
    expect(roundTrip.learning).toEqual(archive.learning);
    expect(roundTrip.governanceAudit).toEqual(archive.governanceAudit);
    restored.close();
  });

  test("accepts a pre-rename archive and normalizes its format", async () => {
    const engine = new KnowledgeEngine({ dataDir: tempDir("ha-legacy-archive-") });
    engine.ensureSpace(SPACE, { chatId: "oc_governance" });
    const archive = await engine.exportSpace(SPACE);
    engine.close();

    const parsed = parseSpaceArchive({ ...archive, format: "homebrain.space" });

    expect(parsed.format).toBe("homeagent.space");
    expect(parsed.space.id).toBe(SPACE);
  });

  test("accepts version 1 archives by supplying an empty learning graph", async () => {
    const engine = new KnowledgeEngine({ dataDir: tempDir("ha-v1-archive-") });
    engine.ensureSpace(SPACE);
    const archive = await engine.exportSpace(SPACE);
    engine.close();

    const {
      learning: _learning,
      governanceAudit: _governanceAudit,
      ...withoutLearning
    } = archive;
    const parsed = parseSpaceArchive({ ...withoutLearning, version: 1 });

    expect(parsed.version).toBe(20);
    expect(parsed.learning).toEqual({ plans: [], sources: [], sessions: [] });
    expect(parsed.governanceAudit).toEqual([]);
    expect(parsed.taskRuns).toEqual([]);
  });

  test("accepts version 2 reading archives and normalizes their learning fields", async () => {
    const engine = new KnowledgeEngine({ dataDir: tempDir("ha-v2-archive-") });
    engine.ensureSpace(SPACE);
    const plan = engine.learning.create({
      name: "读原则",
      space: SPACE,
      creatorId: "ou_owner",
      chatId: "oc_governance",
      sourceTitle: "principles.md",
      sourceContent: "原则正文",
      sourceRawIds: ["raw_book"],
      sourceMessageId: "om_book",
    }, 10);
    const archive = JSON.parse(JSON.stringify(await engine.exportSpace(SPACE))) as Record<string, any>;
    engine.close();
    archive.version = 2;
    delete archive.governanceAudit;
    delete archive.learning.plans[0].mode;
    delete archive.learning.plans[0].topic;
    delete archive.learning.plans[0].route;
    delete archive.learning.plans[0].routeIndex;
    delete archive.learning.plans[0].adaptiveFocus;
    delete archive.learning.sources[0].materials;

    const parsed = parseSpaceArchive(archive);

    expect(parsed.version).toBe(20);
    expect(parsed.learning.plans[0]).toEqual(expect.objectContaining({
      id: plan.id,
      mode: "reading",
      route: [],
      routeIndex: 0,
    }));
    expect(parsed.learning.sources[0]?.materials).toEqual([
      expect.objectContaining({ title: "principles.md", rawIds: ["raw_book"] }),
    ]);
  });

  test("version 3 archives preserve topic routes and material provenance", async () => {
    const source = new KnowledgeEngine({ dataDir: tempDir("ha-v3-topic-source-") });
    source.ensureSpace(SPACE, { chatId: "oc_governance" });
    const plan = source.learning.createTopic({
      name: "学习 Rust",
      topic: "Rust 异步编程",
      space: SPACE,
      creatorId: "ou_owner",
      chatId: "oc_governance",
      route: [
        { title: "Future", objective: "理解 Future" },
        { title: "运行时", objective: "理解运行时" },
      ],
    }, 100);
    source.learning.addMaterial(plan.id, "ou_owner", {
      title: "Async Book",
      content: "Future 只有在 poll 时推进。",
      rawIds: ["raw_async"],
      messageId: "om_async",
    }, 101);

    const archive = JSON.parse(JSON.stringify(await source.exportSpace(SPACE))) as Record<string, any>;
    archive.version = 3;
    delete archive.governanceAudit;
    source.close();

    const target = new KnowledgeEngine({ dataDir: tempDir("ha-v3-topic-target-") });
    await target.restoreSpace(archive);
    expect(target.learning.get(plan.id)).toEqual(expect.objectContaining({
      mode: "topic",
      topic: "Rust 异步编程",
      route: expect.arrayContaining([expect.objectContaining({ title: "Future" })]),
    }));
    expect(target.learning.source(plan.id)?.materials).toEqual([
      expect.objectContaining({ title: "Async Book", rawIds: ["raw_async"] }),
    ]);
    expect((await target.exportSpace(SPACE)).version).toBe(20);
    target.close();
  });

  test("current archives preserve learner profiles, route revisions, and follow-up state", async () => {
    const source = new KnowledgeEngine({ dataDir: tempDir("ha-profile-archive-source-") });
    source.ensureSpace(SPACE, { chatId: "oc_governance" });
    const plan = source.learning.createTopic({
      name: "分布式系统",
      topic: "分布式系统",
      space: SPACE,
      creatorId: "ou_owner",
      chatId: "oc_governance",
      assessmentQuestions: ["项目经验？", "如何理解一致性？", "每天投入多久？"],
      route: [
        { title: "导览", objective: "建立概念地图" },
        { title: "一致性", objective: "理解一致性模型" },
      ],
    }, 100);
    const assessed = source.learning.completeAssessment(plan.id, "ou_owner", {
      answers: "后端经验；一致性基础薄弱；每天 30 分钟。",
      profile: {
        level: "beginner",
        levelRationale: "有工程经验但缺少分布式基础",
        goals: ["设计高可用服务"],
        strengths: ["后端开发"],
        gaps: ["故障模型"],
        preferences: ["案例驱动"],
        pace: "steady",
        dailyMinutes: 30,
        evidence: ["无法解释一致性权衡"],
      },
      route: [
        { title: "故障模型", objective: "理解网络与节点故障" },
        { title: "一致性", objective: "比较一致性保证" },
      ],
      adjustment: "从故障模型开始。",
    }, 101)!;
    source.learning.replaceOnlineResources(plan.id, 2, {
      query: "distributed systems failure model university course",
      resources: [{
        title: "Distributed Systems Course",
        url: "https://pdos.csail.mit.edu/6.824/",
        publisher: "MIT",
        summary: "分布式系统课程与实验资料。",
        relevance: "用于建立故障模型和共识算法的实践基础。",
        kind: "course",
      }],
    }, 101.5);
    const session = source.learning.prepareSession(plan.id, {
      startOffset: 0,
      endOffset: 1,
      routeStepId: assessed.route[0]!.id,
      sectionTitle: "故障模型",
      excerpt: "暂无用户材料",
      guide: "## 今日目标\n理解故障模型",
      preparedAt: 102,
    })!;
    source.learning.markDelivered(session.id, 103);
    source.learning.markFollowedUp(session.id, 104);
    const readingPlan = source.learning.create({
      name: "阅读计划",
      space: SPACE,
      creatorId: "ou_me",
      chatId: "oc_p2p",
      sourceTitle: "阅读材料",
      sourceContent: "第一段正文。第二段正文。",
      sourceRawIds: ["raw_reading"],
      sourceMessageId: "om_reading",
    }, 105);
    const readingSession = source.learning.prepareSession(readingPlan.id, {
      startOffset: 0,
      endOffset: 6,
      sectionTitle: "第一段",
      excerpt: "第一段正文",
      guide: "阅读导引",
      preparedAt: 106,
    })!;
    source.learning.markDelivered(readingSession.id, 107);
    source.learning.completeSession(readingSession.id, {
      learnerReply: "还需要一个例子",
      feedback: "继续补强",
      mastery: "review",
      nextFocus: "用图示解释",
      adjustNextLesson: true,
      nextLessonRequest: "下一课请增加图示",
      completedAt: 108,
    });

    const archive = await source.exportSpace(SPACE);
    source.close();
    const parsed = parseSpaceArchive(JSON.parse(JSON.stringify(archive)));

    expect(parsed.learning.plans[0]).toEqual(expect.objectContaining({
      assessmentAnswers: expect.stringContaining("每天 30 分钟"),
      routeVersion: 2,
      lastRouteAdjustment: "从故障模型开始。",
      profile: expect.objectContaining({
        level: "beginner",
        dailyMinutes: 30,
        gaps: ["故障模型"],
      }),
      resourceResearchVersion: 2,
      resourceResearchQuery: "distributed systems failure model university course",
      onlineResources: [
        expect.objectContaining({
          title: "Distributed Systems Course",
          url: "https://pdos.csail.mit.edu/6.824/",
          publisher: "MIT",
        }),
      ],
    }));
    expect(parsed.learning.sessions[0]).toEqual(expect.objectContaining({
      followUpCount: 1,
      lastFollowUpAt: 104,
    }));
    expect(parsed.learning.sessions.find((item) => item.id === readingSession.id)).toEqual(
      expect.objectContaining({
        nextLessonAdjusted: true,
        nextLessonRequest: "下一课请增加图示",
      }),
    );

    const unsafe = JSON.parse(JSON.stringify(archive));
    unsafe.learning.plans[0].onlineResources[0].url = "javascript:alert(1)";
    expect(() => parseSpaceArchive(unsafe)).toThrow("onlineResources");
    const oversizedRequest = JSON.parse(JSON.stringify(archive));
    const storedReadingSession = oversizedRequest.learning.sessions.find(
      (item: { id?: string }) => item.id === readingSession.id,
    );
    storedReadingSession.nextLessonRequest = "甲".repeat(1_001);
    expect(() => parseSpaceArchive(oversizedRequest)).toThrow("nextLessonRequest");
  });

  test("accepts version 4 governance archives with no task run history", async () => {
    const engine = new KnowledgeEngine({ dataDir: tempDir("ha-v4-archive-") });
    engine.ensureSpace(SPACE);
    const archive = JSON.parse(JSON.stringify(await engine.exportSpace(SPACE))) as Record<string, unknown>;
    engine.close();
    archive.version = 4;
    delete archive.taskRuns;

    const parsed = parseSpaceArchive(archive);

    expect(parsed.version).toBe(20);
    expect(parsed.taskRuns).toEqual([]);
  });

  test("accepts version 5 task history and backfills execution limits", async () => {
    const engine = new KnowledgeEngine({
      dataDir: tempDir("ha-v5-archive-"),
      skillCatalog: new SkillCatalog({ roots: [] }),
      runProvider: async () => "旧版任务结果",
    });
    engine.ensureSpace(SPACE);
    const task = engine.tasks.create({
      name: "旧版任务",
      space: SPACE,
      topic: "兼容迁移",
      notify: false,
      distillOnRun: false,
    })!;
    await engine.runTask(task.id);
    const archive = JSON.parse(JSON.stringify(await engine.exportSpace(SPACE))) as Record<string, any>;
    engine.close();
    archive.version = 5;
    delete archive.tasks[0].timeoutMinutes;
    delete archive.tasks[0].dayOfWeek;
    delete archive.taskRuns[0].timeoutMs;
    delete archive.taskRuns[0].notify;
    delete archive.taskRuns[0].notification;

    const parsed = parseSpaceArchive(archive);

    expect(parsed.version).toBe(20);
    expect(parsed.tasks[0]?.timeoutMinutes).toBe(360);
    expect(parsed.tasks[0]?.dayOfWeek).toBe(1);
    expect(parsed.taskRuns).toEqual([
      expect.objectContaining({
        taskId: task.id,
        status: "succeeded",
        output: "旧版任务结果",
      }),
    ]);
  });

  test("deleting a space removes its knowledge and tasks but keeps shared agents", async () => {
    const engine = new KnowledgeEngine({ dataDir: tempDir("hb-delete-") });
    engine.ensureSpace(SPACE, { chatId: "oc_governance" });
    const agent = engine.agents.create({ name: "共享助手", provider: "codex" });
    engine.registry.updateMeta(SPACE, { agentId: agent.id });
    const rawId = await engine.remember({
      space: SPACE,
      source: "message",
      content: "将被删除",
    });
    await engine.upsertPage(SPACE, {
      slug: "concepts/deleted",
      type: "concept",
      title: "待删除",
      summary: "待删除",
      aliases: [],
      tags: [],
      sources: [rawId],
      links: [],
      content: "# 待删除",
      updatedAt: 1,
      contentHash: "deleted",
    });
    const task = engine.tasks.create({ name: "空间任务", space: SPACE, topic: "x" })!;
    const taskRun = engine.taskRuns.start({
      task,
      trigger: "scheduled",
      distill: false,
      startedAt: 2,
    });
    engine.taskRuns.succeed(taskRun.id, {
      finishedAt: taskRun.startedAt,
      output: "空间任务结果",
    });
    const chatRun = engine.chatRuns.start({
      space: SPACE,
      rawId,
      chatId: "oc_governance",
      messageId: "om_chat",
      input: "空间 Chat",
      trigger: "message",
      agentId: agent.id,
      provider: "codex",
      startedAt: 3,
    });
    engine.chatRuns.succeed(chatRun.id, {
      finishedAt: chatRun.startedAt,
      output: "空间 Chat 结果",
    });
    engine.reminders.create({
      title: "空间提醒",
      space: SPACE,
      chatId: "oc_governance",
      creatorId: "ou_owner",
      triggerAt: Date.now() + 3600_000,
    });
    const learningPlan = engine.learning.create({
      name: "空间学习",
      space: SPACE,
      creatorId: "ou_owner",
      chatId: "oc_governance",
      sourceTitle: "book.md",
      sourceContent: "书籍正文",
      sourceRawIds: [rawId],
      sourceMessageId: "om_book",
    });
    const backup = await engine.exportSpace(SPACE);

    expect(await engine.deleteSpace(SPACE)).toEqual({
      status: "deleted",
      space: SPACE,
      pagesDeleted: 1,
      rawDeleted: 1,
      tasksDeleted: 1,
      workItemsDeleted: 0,
      remindersDeleted: 1,
      learningPlansDeleted: 1,
    });
    expect(engine.registry.has(SPACE)).toBe(false);
    expect(await engine.getPage(SPACE, "concepts/deleted")).toBeNull();
    expect(engine.tasks.list()).toEqual([]);
    expect(engine.listTaskRuns(task.id)).toEqual([]);
    expect(engine.chatRuns.get(chatRun.id)).toBeUndefined();
    expect(engine.reminders.list()).toEqual([]);
    expect(engine.learning.get(learningPlan.id)).toBeUndefined();
    expect(engine.agents.has(agent.id)).toBe(true);
    expect(await engine.deleteSpace(SPACE)).toEqual({
      status: "not_found",
      space: SPACE,
      pagesDeleted: 0,
      rawDeleted: 0,
      tasksDeleted: 0,
      workItemsDeleted: 0,
      remindersDeleted: 0,
      learningPlansDeleted: 0,
    });

    await engine.restoreSpace(backup);
    expect(await engine.getPage(SPACE, "concepts/deleted")).not.toBeNull();
    expect(engine.tasks.list()).toEqual(backup.tasks);
    expect(engine.listTaskRuns(task.id)).toEqual(backup.taskRuns);
    expect(engine.chatRuns.list(SPACE)).toEqual(backup.chatRuns);
    expect(engine.reminders.list()).toEqual(backup.reminders);
    expect(engine.learning.exportBySpace(SPACE)).toEqual(backup.learning);
    engine.close();
  });

  test("raw retention deletes only expired ingested messages", async () => {
    const engine = new KnowledgeEngine({ dataDir: tempDir("hb-retention-") });
    const now = 1_800_000_000_000;
    const day = 86_400_000;
    const raw = [
      { id: "old-ingested", source: "message", createdAt: now - 40 * day, ingested: true },
      { id: "old-pending", source: "message", createdAt: now - 40 * day, ingested: false },
      { id: "recent-ingested", source: "message", createdAt: now - 5 * day, ingested: true },
      { id: "old-doc", source: "doc", createdAt: now - 40 * day, ingested: true },
    ].map((record) => ({
      ...record,
      space: SPACE,
      content: record.id,
      attachments: [],
      admission: "ready" as const,
    })) as SpaceArchive["raw"];
    await engine.restoreSpace({
      format: "homeagent.space",
      version: 1,
      exportedAt: now,
      space: { id: SPACE, createdAt: now - 50 * day },
      purpose: "purpose",
      schema: "schema",
      pages: [],
      raw,
      retractions: [],
      tasks: [],
    });
    const retainedRun = engine.chatRuns.start({
      space: SPACE,
      rawId: "old-ingested",
      input: "old-ingested",
      trigger: "message",
    });
    engine.chatRuns.succeed(retainedRun.id, {
      finishedAt: retainedRun.startedAt,
      output: "expired answer",
    });

    expect(await engine.pruneRawMessages(30, now)).toEqual({
      retentionDays: 30,
      cutoff: now - 30 * day,
      deleted: 1,
      bySpace: { [SPACE]: 1 },
    });
    const remaining = await engine.exportSpace(SPACE);
    expect(remaining.raw.map((record) => record.id).sort()).toEqual([
      "old-doc",
      "old-pending",
      "recent-ingested",
    ]);
    expect((await engine.pruneRawMessages(0, now)).deleted).toBe(0);
    expect(engine.chatRuns.get(retainedRun.id)).toBeUndefined();
    engine.close();
  });

  test("failed raw retention restores Chat Run audit without reviving the topic session", async () => {
    const dataDir = tempDir("hb-retention-topic-rollback-");
    let engine = new KnowledgeEngine({ dataDir });
    const now = 1_800_000_000_000;
    const day = 86_400_000;
    await engine.restoreSpace({
      format: "homeagent.space",
      version: 1,
      exportedAt: now,
      space: { id: SPACE, createdAt: now - 50 * day },
      purpose: "purpose",
      schema: "schema",
      pages: [],
      raw: [{
        id: "old-ingested",
        source: "message",
        createdAt: now - 40 * day,
        ingested: true,
        space: SPACE,
        content: "old-ingested",
        attachments: [],
        admission: "ready",
      }],
      retractions: [],
      tasks: [],
    });
    const executionPlan: ResolvedExecutionPlan = {
      version: 1,
      instruction: "Topic agent",
      provider: "codex",
    };
    const topicNativeSession = {
      kind: "feishu-topic" as const,
      chatId: "oc_governance",
      rootMessageId: "om_topic_root",
      provider: "codex" as const,
      compatibilityKey: topicNativeSessionCompatibilityKey({ executionPlan }),
    };
    const head = engine.chatRuns.start({
      space: SPACE,
      rawId: "old-ingested",
      chatId: "oc_governance",
      messageId: "om_topic_first",
      input: "first",
      trigger: "message",
      executionPlan,
      topicNativeSession,
      startedAt: 100,
    });
    engine.chatRuns.begin(head.id, 101);
    engine.chatRuns.prepareTopicNativeSession(head.id);
    engine.chatRuns.succeed(head.id, {
      finishedAt: 110,
      output: "done",
      nativeSessionId: "11111111-2222-4333-8444-555555555555",
    });
    engine.chatRuns.startDeliveryAttempt(head.id, 111);
    engine.chatRuns.deliverySent(head.id, 112);
    const index = engine.registry.store(SPACE).index();
    const mutableIndex = index as unknown as {
      deleteExpiredRawMessages: typeof index.deleteExpiredRawMessages;
    };
    const originalDeleteExpiredRawMessages = index.deleteExpiredRawMessages.bind(index);
    mutableIndex.deleteExpiredRawMessages = () => {
      throw new Error("simulated retention failure");
    };
    try {
      await expect(engine.pruneRawMessages(30, now))
        .rejects.toThrow("simulated retention failure");
    } finally {
      mutableIndex.deleteExpiredRawMessages = originalDeleteExpiredRawMessages;
    }

    expect(engine.chatRuns.get(head.id)?.status).toBe("succeeded");
    engine.close();
    engine = new KnowledgeEngine({ dataDir });
    const followup = engine.chatRuns.start({
      space: SPACE,
      chatId: "oc_governance",
      messageId: "om_topic_followup",
      input: "followup",
      trigger: "message",
      executionPlan,
      topicNativeSession,
      startedAt: 120,
    });
    engine.chatRuns.begin(followup.id, 121);
    expect(engine.chatRuns.prepareTopicNativeSession(followup.id)).toEqual({ mode: "start" });
    engine.close();
  });

  test("raw retention preserves topic heads when no Raw is expired", async () => {
    const dataDir = tempDir("hb-retention-topic-noop-");
    let engine = new KnowledgeEngine({ dataDir });
    const rawId = await engine.remember({
      space: SPACE,
      source: "message",
      author: "ou_owner",
      chatId: "oc_governance",
      messageId: "om_recent",
      content: "recent",
    });
    const executionPlan: ResolvedExecutionPlan = {
      version: 1,
      instruction: "Topic agent",
      provider: "codex",
    };
    const topicNativeSession = {
      kind: "feishu-topic" as const,
      chatId: "oc_governance",
      rootMessageId: "om_topic_root",
      provider: "codex" as const,
      compatibilityKey: topicNativeSessionCompatibilityKey({ executionPlan }),
    };
    const head = engine.chatRuns.start({
      space: SPACE,
      rawId,
      chatId: "oc_governance",
      messageId: "om_recent",
      input: "recent",
      trigger: "message",
      executionPlan,
      topicNativeSession,
    });
    engine.chatRuns.begin(head.id);
    engine.chatRuns.prepareTopicNativeSession(head.id);
    engine.chatRuns.succeed(head.id, {
      finishedAt: Date.now(),
      output: "done",
      nativeSessionId: "11111111-2222-4333-8444-555555555555",
    });
    engine.chatRuns.startDeliveryAttempt(head.id, Date.now());
    engine.chatRuns.deliverySent(head.id, Date.now());

    expect((await engine.pruneRawMessages(30, Date.now())).deleted).toBe(0);
    engine.close();
    engine = new KnowledgeEngine({ dataDir });
    const followup = engine.chatRuns.start({
      space: SPACE,
      chatId: "oc_governance",
      messageId: "om_followup",
      input: "followup",
      trigger: "message",
      executionPlan,
      topicNativeSession,
    });
    engine.chatRuns.begin(followup.id);
    expect(engine.chatRuns.prepareTopicNativeSession(followup.id)).toEqual({
      mode: "fork",
      id: "11111111-2222-4333-8444-555555555555",
    });
    engine.close();
  });

  test("message retraction removes the matching Chat Run copy", async () => {
    const engine = new KnowledgeEngine({ dataDir: tempDir("hb-chat-retraction-") });
    const rawId = await engine.remember({
      space: SPACE,
      source: "message",
      author: "ou_owner",
      chatId: "oc_governance",
      messageId: "om_chat_retract",
      content: "需要撤回的 Chat",
    });
    const run = engine.chatRuns.start({
      space: SPACE,
      rawId,
      chatId: "oc_governance",
      messageId: "om_chat_retract",
      author: "ou_owner",
      input: "需要撤回的 Chat",
      trigger: "message",
    });
    engine.chatRuns.succeed(run.id, {
      finishedAt: run.startedAt,
      output: "需要一并删除的回答",
    });

    const result = await engine.retractMessage(SPACE, {
      chatId: "oc_governance",
      messageId: "om_chat_retract",
      requestedBy: "ou_owner",
    });

    expect(result.status).toBe("retracted");
    expect(engine.chatRuns.get(run.id)).toBeUndefined();
    engine.close();
  });

  test("connector-authorized retraction without Raw persists a tombstone and clears topic heads", async () => {
    const dataDir = tempDir("hb-context-only-retraction-");
    let engine = new KnowledgeEngine({ dataDir });
    engine.ensureSpace(SPACE, { chatId: "oc_governance" });
    const executionPlan: ResolvedExecutionPlan = {
      version: 1,
      instruction: "Topic agent",
      provider: "codex",
    };
    const topicNativeSession = {
      kind: "feishu-topic" as const,
      chatId: "oc_governance",
      rootMessageId: "om_other_topic_root",
      provider: "codex" as const,
      compatibilityKey: topicNativeSessionCompatibilityKey({ executionPlan }),
    };
    const head = engine.chatRuns.start({
      space: SPACE,
      chatId: "oc_governance",
      messageId: "om_other_topic_turn",
      input: "question",
      trigger: "message",
      executionPlan,
      topicNativeSession,
    });
    engine.chatRuns.begin(head.id);
    engine.chatRuns.prepareTopicNativeSession(head.id);
    engine.chatRuns.succeed(head.id, {
      finishedAt: Date.now(),
      output: "answer",
      nativeSessionId: "11111111-2222-4333-8444-555555555555",
    });
    engine.chatRuns.startDeliveryAttempt(head.id, Date.now());
    engine.chatRuns.deliverySent(head.id, Date.now());

    expect(await engine.retractMessage(SPACE, {
      chatId: "oc_governance",
      messageId: "om_context_only_missing_author",
      requestedBy: "ou_owner",
    })).toEqual(expect.objectContaining({ status: "not_found" }));
    expect(await engine.retractMessage(SPACE, {
      chatId: "oc_governance",
      messageId: "om_context_only_foreign",
      requestedBy: "ou_intruder",
      targetAuthor: "ou_owner",
    })).toEqual(expect.objectContaining({ status: "forbidden" }));
    expect(engine.registry.store(SPACE).index().getMessageRetraction(
      "oc_governance",
      "om_context_only_foreign",
    )).toBeNull();

    expect(await engine.retractMessage(SPACE, {
      chatId: "oc_governance",
      messageId: "om_context_only_target",
      requestedBy: "ou_owner",
      targetAuthor: "ou_owner",
    })).toEqual(expect.objectContaining({ status: "retracted" }));
    expect(await engine.retractMessage(SPACE, {
      chatId: "oc_governance",
      messageId: "om_context_only_admin_target",
      requestedBy: "ou_admin",
      targetAuthor: "ou_other",
      requesterIsAdmin: true,
    })).toEqual(expect.objectContaining({ status: "retracted" }));
    expect(await engine.remember({
      space: SPACE,
      source: "message",
      author: "ou_owner",
      chatId: "oc_governance",
      messageId: "om_context_only_target",
      content: "delayed secret delivery",
    })).toBe("retracted:om_context_only_target");
    expect(engine.registry.store(SPACE).index().findRawsByMessageId(
      "om_context_only_target",
      "oc_governance",
    )).toHaveLength(0);
    engine.close();

    engine = new KnowledgeEngine({ dataDir });
    expect(engine.registry.store(SPACE).index().getMessageRetraction(
      "oc_governance",
      "om_context_only_target",
    )).toEqual(expect.objectContaining({ originalAuthor: "ou_owner" }));
    const followup = engine.chatRuns.start({
      space: SPACE,
      chatId: "oc_governance",
      messageId: "om_other_topic_followup",
      input: "followup",
      trigger: "message",
      executionPlan,
      topicNativeSession,
    });
    engine.chatRuns.begin(followup.id);
    expect(engine.chatRuns.prepareTopicNativeSession(followup.id)).toEqual({ mode: "start" });
    engine.close();
  });

  test("a failed context-only retraction journal write keeps the topic head invalidated after reopen", async () => {
    const dataDir = tempDir("hb-context-only-retraction-head-fail-closed-");
    let engine = new KnowledgeEngine({ dataDir });
    engine.ensureSpace(SPACE, { chatId: "oc_governance" });
    const executionPlan: ResolvedExecutionPlan = {
      version: 1,
      instruction: "Topic agent",
      provider: "codex",
    };
    const topicNativeSession = {
      kind: "feishu-topic" as const,
      chatId: "oc_governance",
      rootMessageId: "om_context_only_failure_root",
      provider: "codex" as const,
      compatibilityKey: topicNativeSessionCompatibilityKey({ executionPlan }),
    };
    const head = engine.chatRuns.start({
      space: SPACE,
      chatId: "oc_governance",
      messageId: "om_context_only_failure_turn",
      input: "question",
      trigger: "message",
      executionPlan,
      topicNativeSession,
    });
    engine.chatRuns.begin(head.id);
    engine.chatRuns.prepareTopicNativeSession(head.id);
    engine.chatRuns.succeed(head.id, {
      finishedAt: head.startedAt,
      output: "answer",
      nativeSessionId: "11111111-2222-4333-8444-555555555555",
    });
    engine.chatRuns.startDeliveryAttempt(head.id, head.startedAt + 1);
    engine.chatRuns.deliverySent(head.id, head.startedAt + 2);

    const index = engine.registry.store(SPACE).index();
    const mutableIndex = index as unknown as {
      recordMessageRetraction: typeof index.recordMessageRetraction;
    };
    const originalRecordMessageRetraction = index.recordMessageRetraction.bind(index);
    mutableIndex.recordMessageRetraction = () => {
      throw new Error("simulated context-only retraction journal failure");
    };
    try {
      await expect(engine.retractMessage(SPACE, {
        chatId: "oc_governance",
        messageId: "om_context_only_no_raw_target",
        requestedBy: "ou_owner",
        targetAuthor: "ou_owner",
      })).rejects.toThrow("simulated context-only retraction journal failure");
    } finally {
      mutableIndex.recordMessageRetraction = originalRecordMessageRetraction;
    }

    expect(index.findRawsByMessageId(
      "om_context_only_no_raw_target",
      "oc_governance",
    )).toHaveLength(0);
    expect(index.getMessageRetraction(
      "oc_governance",
      "om_context_only_no_raw_target",
    )).toBeNull();
    expect(engine.chatRuns.get(head.id)?.status).toBe("succeeded");
    engine.close();

    engine = new KnowledgeEngine({ dataDir });
    const followup = engine.chatRuns.start({
      space: SPACE,
      chatId: "oc_governance",
      messageId: "om_context_only_failure_followup",
      input: "followup",
      trigger: "message",
      executionPlan,
      topicNativeSession,
    });
    engine.chatRuns.begin(followup.id);
    expect(engine.chatRuns.prepareTopicNativeSession(followup.id)).toEqual({ mode: "start" });
    engine.close();
  });

  test("message retraction does not commit its tombstone before Chat Run cleanup", async () => {
    const engine = new KnowledgeEngine({ dataDir: tempDir("hb-chat-retraction-order-") });
    const rawId = await engine.remember({
      space: SPACE,
      source: "message",
      author: "ou_owner",
      chatId: "oc_governance",
      messageId: "om_chat_retract_order",
      content: "撤回顺序",
    });
    const mutableChatRuns = engine.chatRuns as unknown as {
      removeByRawIds: typeof engine.chatRuns.removeByRawIds;
    };
    const originalRemoveByRawIds = engine.chatRuns.removeByRawIds.bind(engine.chatRuns);
    mutableChatRuns.removeByRawIds = () => {
      throw new Error("simulated Chat Run cleanup failure");
    };
    try {
      await expect(engine.retractMessage(SPACE, {
        chatId: "oc_governance",
        messageId: "om_chat_retract_order",
        requestedBy: "ou_owner",
      })).rejects.toThrow("simulated Chat Run cleanup failure");
    } finally {
      mutableChatRuns.removeByRawIds = originalRemoveByRawIds;
    }

    const index = engine.registry.store(SPACE).index();
    expect(index.getMessageRetraction("oc_governance", "om_chat_retract_order")).toBeNull();
    expect(index.getRaw(rawId)).not.toBeNull();
    engine.close();
  });

  test("a failed retraction journal write keeps every Space topic head invalidated after reopen", async () => {
    const dataDir = tempDir("hb-chat-retraction-head-fail-closed-");
    let engine = new KnowledgeEngine({ dataDir });
    const rawId = await engine.remember({
      space: SPACE,
      source: "message",
      author: "ou_owner",
      chatId: "oc_governance",
      messageId: "om_chat_retract_head",
      content: "可能已进入多个原生会话的内容",
    });
    const executionPlan: ResolvedExecutionPlan = {
      version: 1,
      instruction: "Topic agent",
      provider: "codex",
    };
    const startHead = (rootMessageId: string, messageId: string, sessionId: string) => {
      const topicNativeSession = {
        kind: "feishu-topic" as const,
        chatId: "oc_governance",
        rootMessageId,
        provider: "codex" as const,
        compatibilityKey: topicNativeSessionCompatibilityKey({ executionPlan }),
      };
      const run = engine.chatRuns.start({
        space: SPACE,
        chatId: "oc_governance",
        messageId,
        input: "question",
        trigger: "message",
        executionPlan,
        topicNativeSession,
      });
      engine.chatRuns.begin(run.id);
      engine.chatRuns.prepareTopicNativeSession(run.id);
      engine.chatRuns.succeed(run.id, {
        finishedAt: run.startedAt,
        output: "answer",
        nativeSessionId: sessionId,
      });
      engine.chatRuns.startDeliveryAttempt(run.id, run.startedAt + 1);
      engine.chatRuns.deliverySent(run.id, run.startedAt + 2);
      return { run, topicNativeSession };
    };
    const first = startHead(
      "om_topic_root_a",
      "om_topic_turn_a",
      "11111111-2222-4333-8444-555555555555",
    );
    const second = startHead(
      "om_topic_root_b",
      "om_topic_turn_b",
      "66666666-7777-4888-8999-aaaaaaaaaaaa",
    );
    const index = engine.registry.store(SPACE).index();
    const mutableIndex = index as unknown as {
      recordMessageRetraction: typeof index.recordMessageRetraction;
    };
    const originalRecordMessageRetraction = index.recordMessageRetraction.bind(index);
    mutableIndex.recordMessageRetraction = () => {
      throw new Error("simulated retraction journal failure");
    };
    try {
      await expect(engine.retractMessage(SPACE, {
        chatId: "oc_governance",
        messageId: "om_chat_retract_head",
        requestedBy: "ou_owner",
      })).rejects.toThrow("simulated retraction journal failure");
    } finally {
      mutableIndex.recordMessageRetraction = originalRecordMessageRetraction;
    }

    expect(index.getMessageRetraction("oc_governance", "om_chat_retract_head")).toBeNull();
    expect(index.getRaw(rawId)).not.toBeNull();
    expect(engine.chatRuns.get(first.run.id)?.status).toBe("succeeded");
    expect(engine.chatRuns.get(second.run.id)?.status).toBe("succeeded");
    engine.close();

    engine = new KnowledgeEngine({ dataDir });
    for (const [offset, prior] of [first, second].entries()) {
      const followup = engine.chatRuns.start({
        space: SPACE,
        chatId: "oc_governance",
        messageId: `om_topic_followup_${offset}`,
        input: "followup",
        trigger: "message",
        executionPlan,
        topicNativeSession: prior.topicNativeSession,
      });
      engine.chatRuns.begin(followup.id);
      expect(engine.chatRuns.prepareTopicNativeSession(followup.id)).toEqual({ mode: "start" });
    }
    engine.close();
  });

  test("raw retention preserves provenance needed to authorize later source retraction", async () => {
    const engine = new KnowledgeEngine({ dataDir: tempDir("ha-learning-retention-") });
    const now = 1_800_000_000_000;
    const rawId = "old-learning-source";
    await engine.restoreSpace({
      format: "homeagent.space",
      version: 1,
      exportedAt: now,
      space: { id: SPACE, createdAt: now - 50 * 86_400_000 },
      purpose: "purpose",
      schema: "schema",
      pages: [],
      raw: [{
        id: rawId,
        space: SPACE,
        source: "message",
        author: "ou_owner",
        chatId: "oc_governance",
        messageId: "om_book",
        content: "book content",
        attachments: [],
        createdAt: now - 40 * 86_400_000,
        ingested: true,
      }],
      retractions: [],
      tasks: [],
    });
    const plan = engine.learning.create({
      name: "retained",
      space: SPACE,
      creatorId: "ou_owner",
      chatId: "oc_governance",
      sourceTitle: "book.md",
      sourceContent: "book content",
      sourceRawIds: [rawId],
      sourceMessageId: "om_book",
    });

    expect((await engine.pruneRawMessages(30, now)).deleted).toBe(0);
    expect(engine.registry.store(SPACE).index().getRaw(rawId)).not.toBeNull();
    expect((await engine.retractMessage(SPACE, {
      chatId: "oc_governance",
      messageId: "om_book",
      requestedBy: "ou_owner",
    })).status).toBe("retracted");
    expect(engine.learning.get(plan.id)).toBeUndefined();
    engine.close();
  });

  test("restore rejects duplicate archive identities before creating a space", async () => {
    const engine = new KnowledgeEngine({ dataDir: tempDir("hb-duplicate-restore-") });
    const now = Date.now();
    const raw = {
      id: "duplicate",
      space: SPACE,
      source: "message" as const,
      content: "duplicate",
      attachments: [],
      createdAt: now,
      ingested: true,
    };

    await expect(engine.restoreSpace({
      format: "homeagent.space",
      version: 1,
      exportedAt: now,
      space: { id: SPACE, createdAt: now },
      purpose: "purpose",
      schema: "schema",
      pages: [],
      raw: [raw, raw],
      retractions: [],
      tasks: [],
    })).rejects.toThrow("duplicate raw id");
    expect(engine.registry.has(SPACE)).toBe(false);
    engine.close();
  });

  test("restore rejects space ids that could collide on disk", async () => {
    const engine = new KnowledgeEngine({ dataDir: tempDir("hb-space-collision-") });
    const existing: SpaceId = "team/a_b";
    engine.ensureSpace(existing);
    const now = Date.now();

    await expect(engine.restoreSpace({
      format: "homeagent.space",
      version: 1,
      exportedAt: now,
      space: { id: "team/a/b", createdAt: now },
      purpose: "purpose",
      schema: "schema",
      pages: [],
      raw: [],
      retractions: [],
      tasks: [],
    })).rejects.toThrow("storage path conflicts");
    expect(engine.registry.has(existing)).toBe(true);
    expect(engine.registry.has("team/a/b" as SpaceId)).toBe(false);
    engine.close();
  });

  test("an unusual but valid existing space id can round-trip when its storage is unique", async () => {
    const engine = new KnowledgeEngine({ dataDir: tempDir("hb-unusual-space-") });
    const unusual = "team/a.b+c" as SpaceId;
    engine.ensureSpace(unusual);
    const archive = await engine.exportSpace(unusual);

    await engine.deleteSpace(unusual);
    await engine.restoreSpace(archive);

    expect(engine.registry.has(unusual)).toBe(true);
    engine.close();
  });

  test("restore preflight rejects task id conflicts without leaving a partial space", async () => {
    const engine = new KnowledgeEngine({ dataDir: tempDir("hb-conflict-restore-") });
    const other: SpaceId = "team/other";
    engine.ensureSpace(other);
    const task = engine.tasks.create({ name: "existing", space: other, topic: "topic" })!;
    const now = Date.now();

    await expect(engine.restoreSpace({
      format: "homeagent.space",
      version: 1,
      exportedAt: now,
      space: { id: SPACE, createdAt: now },
      purpose: "purpose",
      schema: "schema",
      pages: [],
      raw: [],
      retractions: [],
      tasks: [{ ...task, space: SPACE }],
    })).rejects.toThrow("task id already exists");
    expect(engine.registry.has(SPACE)).toBe(false);
    expect(engine.tasks.get(task.id)?.space).toBe(other);
    engine.close();
  });

  test("rolls back a quality merge when a later space restore step fails", async () => {
    const source = new KnowledgeEngine({ dataDir: tempDir("ha-quality-rollback-source-") });
    source.ensureSpace(SPACE);
    const trace = source.quality.recordTrace({
      spaces: [SPACE],
      question: "Who owns the backend?",
      outcome: "succeeded",
      answer: "Alice",
      citations: [],
      latencyMs: 10,
      createdAt: 1_000,
    });
    const run = source.chatRuns.start({
      space: SPACE,
      input: "Who owns the backend?",
      trigger: "message",
      executionPlan: {
        version: 1,
        instruction: "Use the archived knowledge.",
        provider: "codex",
      },
      startedAt: 1_100,
    });
    source.chatRuns.begin(run.id, 1_200);
    source.chatRuns.succeed(run.id, {
      finishedAt: 1_300,
      output: "Alice",
      traceId: trace.id,
    });
    const archive = await source.exportSpace(SPACE);
    source.close();

    const target = new KnowledgeEngine({ dataDir: tempDir("ha-quality-rollback-target-") });
    let qualityWasMergedBeforeFailure = false;
    target.registry.restoreMeta = () => {
      qualityWasMergedBeforeFailure = target.answerTrace(trace.id) !== undefined;
      throw new Error("late space restore failure");
    };

    await expect(target.restoreSpace(archive)).rejects.toThrow("late space restore failure");
    expect(qualityWasMergedBeforeFailure).toBe(true);
    expect(target.registry.has(SPACE)).toBe(false);
    expect(target.chatRuns.get(run.id)).toBeUndefined();
    expect(target.answerTrace(trace.id)).toBeUndefined();
    target.close();
  });

  test("rejects a conflicting quality trace before creating or writing the space", async () => {
    const source = new KnowledgeEngine({ dataDir: tempDir("ha-quality-conflict-source-") });
    source.ensureSpace(SPACE);
    const trace = source.quality.recordTrace({
      spaces: [SPACE],
      question: "Who owns the backend?",
      outcome: "succeeded",
      answer: "Alice",
      citations: [],
      latencyMs: 10,
      createdAt: 1_000,
    });
    const run = source.chatRuns.start({
      space: SPACE,
      input: "Who owns the backend?",
      trigger: "message",
      startedAt: 1_100,
    });
    source.chatRuns.begin(run.id, 1_200);
    source.chatRuns.succeed(run.id, {
      finishedAt: 1_300,
      output: "Alice",
      traceId: trace.id,
    });
    const archive = await source.exportSpace(SPACE);
    source.close();

    const target = new KnowledgeEngine({ dataDir: tempDir("ha-quality-conflict-target-") });
    const conflicting = structuredClone(archive.quality);
    conflicting.traces[0]!.answer = "Mallory";
    target.quality.restoreArchive(conflicting);

    await expect(target.restoreSpace(archive)).rejects.toThrow(/quality trace.*different data/i);
    expect(target.registry.has(SPACE)).toBe(false);
    expect(target.chatRuns.get(run.id)).toBeUndefined();
    expect(target.answerTrace(trace.id)?.answer).toBe("Mallory");
    target.close();
  });

  test("restore preserves a dangling archived agent binding", async () => {
    const engine = new KnowledgeEngine({ dataDir: tempDir("hb-dangling-agent-") });
    engine.ensureSpace(SPACE);
    engine.registry.updateMeta(SPACE, { agentId: "agent_missing" });
    const archive = await engine.exportSpace(SPACE);
    expect(archive.agent).toBeUndefined();

    await engine.deleteSpace(SPACE);
    await engine.restoreSpace(archive);

    expect(engine.registry.get(SPACE)?.agentId).toBe("agent_missing");
    engine.close();
  });

  test("failed workspace deletion restores linked tasks", async () => {
    const engine = new KnowledgeEngine({ dataDir: tempDir("hb-delete-rollback-") });
    engine.ensureSpace(SPACE);
    const task = engine.tasks.create({ name: "keep", space: SPACE, topic: "topic" })!;
    const learningPlan = engine.learning.create({
      name: "keep learning",
      space: SPACE,
      creatorId: "ou_owner",
      chatId: "oc_governance",
      sourceTitle: "book.md",
      sourceContent: "book content",
      sourceRawIds: ["raw_book"],
      sourceMessageId: "om_book",
    });
    const executionPlan: ResolvedExecutionPlan = {
      version: 1,
      instruction: "Topic agent",
      provider: "codex",
    };
    const topicNativeSession = {
      kind: "feishu-topic" as const,
      chatId: "oc_governance",
      rootMessageId: "om_topic_root",
      provider: "codex" as const,
      compatibilityKey: topicNativeSessionCompatibilityKey({ executionPlan }),
    };
    const chatRun = engine.chatRuns.start({
      space: SPACE,
      chatId: "oc_governance",
      messageId: "om_topic_first",
      input: "first",
      trigger: "message",
      executionPlan,
      topicNativeSession,
      startedAt: 100,
    });
    engine.chatRuns.begin(chatRun.id, 101);
    engine.chatRuns.prepareTopicNativeSession(chatRun.id);
    engine.chatRuns.succeed(chatRun.id, {
      finishedAt: 110,
      output: "done",
      nativeSessionId: "11111111-2222-4333-8444-555555555555",
    });
    engine.chatRuns.startDeliveryAttempt(chatRun.id, 111);
    engine.chatRuns.deliverySent(chatRun.id, 112);
    engine.registry.remove = () => {
      throw new Error("workspace removal failed");
    };

    await expect(engine.deleteSpace(SPACE)).rejects.toThrow("workspace removal failed");

    expect(engine.registry.has(SPACE)).toBe(true);
    expect(engine.tasks.get(task.id)).toEqual(task);
    expect(engine.learning.get(learningPlan.id)).toEqual(learningPlan);
    expect(engine.chatRuns.get(chatRun.id)?.status).toBe("succeeded");
    const followup = engine.chatRuns.start({
      space: SPACE,
      chatId: "oc_governance",
      messageId: "om_topic_followup",
      input: "followup",
      trigger: "message",
      executionPlan,
      topicNativeSession,
      startedAt: 120,
    });
    engine.chatRuns.begin(followup.id, 121);
    expect(engine.chatRuns.prepareTopicNativeSession(followup.id)).toEqual({
      mode: "fork",
      id: "11111111-2222-4333-8444-555555555555",
    });
    engine.close();
  });

  test("retracting the source message removes learning snapshots derived from it", async () => {
    const engine = new KnowledgeEngine({ dataDir: tempDir("ha-learning-retraction-") });
    const rawId = await engine.remember({
      space: SPACE,
      source: "message",
      author: "ou_owner",
      chatId: "oc_governance",
      messageId: "om_book",
      content: "# 附件：book.md\n\n书籍正文",
    });
    const plan = engine.createLearningPlanFromMessage({
      space: SPACE,
      chatId: "oc_governance",
      messageId: "om_book",
      creatorId: "ou_owner",
      name: "读书",
    });

    await engine.retractMessage(SPACE, {
      chatId: "oc_governance",
      messageId: "om_book",
      requestedBy: "ou_owner",
    });

    expect(engine.learning.get(plan.id)).toBeUndefined();
    expect(engine.registry.store(SPACE).index().getRaw(rawId)).toBeNull();
    engine.close();
  });

  test("restore validates the complete learning graph before creating a space", async () => {
    const source = new KnowledgeEngine({ dataDir: tempDir("ha-learning-invalid-source-") });
    source.ensureSpace(SPACE);
    source.learning.create({
      name: "invalid",
      space: SPACE,
      creatorId: "ou_owner",
      chatId: "oc_governance",
      sourceTitle: "book.md",
      sourceContent: "book content",
      sourceRawIds: ["raw_book"],
      sourceMessageId: "om_book",
    });
    const archive = await source.exportSpace(SPACE);
    source.close();
    archive.learning.plans[0] = { ...archive.learning.plans[0]!, sourceId: "missing" };
    const target = new KnowledgeEngine({ dataDir: tempDir("ha-learning-invalid-target-") });

    await expect(target.restoreSpace(archive)).rejects.toThrow("learning plan sourceId");
    expect(target.registry.has(SPACE)).toBe(false);
    expect(target.learning.list()).toEqual([]);
    target.close();
  });

  test("restore rejects an oversized learning source before creating a space", async () => {
    const source = new KnowledgeEngine({ dataDir: tempDir("ha-learning-large-source-") });
    source.ensureSpace(SPACE);
    source.learning.create({
      name: "large",
      space: SPACE,
      creatorId: "ou_owner",
      chatId: "oc_governance",
      sourceTitle: "book.md",
      sourceContent: "x",
      sourceRawIds: ["raw_book"],
      sourceMessageId: "om_book",
    });
    const archive = await source.exportSpace(SPACE);
    source.close();
    archive.learning.sources[0] = {
      ...archive.learning.sources[0]!,
      content: "x".repeat(2_000_001),
    };
    archive.learning.plans[0] = {
      ...archive.learning.plans[0]!,
      sourceLength: 2_000_001,
    };
    const target = new KnowledgeEngine({ dataDir: tempDir("ha-learning-large-target-") });

    await expect(target.restoreSpace(archive)).rejects.toThrow("exceeds 2000000 characters");
    expect(target.registry.has(SPACE)).toBe(false);
    target.close();
  });

  test("restore rejects task hours outside the scheduler domain", async () => {
    const engine = new KnowledgeEngine({ dataDir: tempDir("hb-task-hour-") });
    const now = Date.now();
    await expect(engine.restoreSpace({
      format: "homeagent.space",
      version: 1,
      exportedAt: now,
      space: { id: SPACE, createdAt: now },
      purpose: "purpose",
      schema: "schema",
      pages: [],
      raw: [],
      retractions: [],
      tasks: [{
        id: "task_invalid_hour",
        name: "invalid",
        space: SPACE,
        topic: "topic",
        cadence: "daily",
        hour: 24,
        enabled: true,
        notify: false,
        distillOnRun: true,
        createdAt: now,
        updatedAt: now,
      }],
    })).rejects.toThrow("tasks[0].hour is invalid");
    expect(engine.registry.has(SPACE)).toBe(false);
    engine.close();
  });

  test("restore rejects an embedded agent that is not bound to the space", async () => {
    const engine = new KnowledgeEngine({ dataDir: tempDir("hb-unbound-agent-") });
    const agent = engine.agents.create({ name: "unbound", provider: "codex" });
    engine.agents.remove(agent.id);
    const now = Date.now();

    await expect(engine.restoreSpace({
      format: "homeagent.space",
      version: 1,
      exportedAt: now,
      space: { id: SPACE, createdAt: now },
      agent,
      purpose: "purpose",
      schema: "schema",
      pages: [],
      raw: [],
      retractions: [],
      tasks: [],
    })).rejects.toThrow("agent.id does not match space.agentId");
    expect(engine.agents.has(agent.id)).toBe(false);
    expect(engine.registry.has(SPACE)).toBe(false);
    engine.close();
  });

  test("restore rejects an embedded Agent whose Visibility mismatches the space", async () => {
    const engine = new KnowledgeEngine({ dataDir: tempDir("hb-agent-visibility-") });
    const agent = engine.agents.create({
      name: "personal-only",
      provider: "codex",
      visibility: "Personal",
    });
    engine.agents.remove(agent.id);
    const now = Date.now();

    await expect(engine.restoreSpace({
      format: "homeagent.space",
      version: 1,
      exportedAt: now,
      space: { id: SPACE, createdAt: now, agentId: agent.id },
      agent,
      purpose: "purpose",
      schema: "schema",
      pages: [],
      raw: [],
      retractions: [],
      tasks: [],
    })).rejects.toThrow("agent.visibility does not match archive space");
    expect(engine.agents.has(agent.id)).toBe(false);
    expect(engine.registry.has(SPACE)).toBe(false);
    engine.close();
  });

  test("legacy personal archives infer a missing Agent Visibility from the space", () => {
    const now = Date.now();
    const archive = parseSpaceArchive({
      format: "homeagent.space",
      version: 1,
      exportedAt: now,
      space: {
        id: "personal/ou_legacy",
        createdAt: now,
        agentId: "agent_legacy_personal",
      },
      agent: {
        id: "agent_legacy_personal",
        name: "旧个人助手",
        instruction: "",
        model: "",
        reasoningEffort: "",
        provider: "codex",
        permission: "read-only",
        skills: [],
        createdAt: now,
        updatedAt: now,
      },
      purpose: "purpose",
      schema: "schema",
      pages: [],
      raw: [],
      retractions: [],
      tasks: [],
    });

    expect(archive.agent?.visibility).toBe("Personal");
  });
});
