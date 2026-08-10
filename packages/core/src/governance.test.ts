import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page, SpaceId } from "@homeagent/shared";
import { KnowledgeEngine } from "./engine.ts";
import { parseSpaceArchive, type SpaceArchive } from "./governance.ts";
import type { LlmClient } from "./llm.ts";
import { SkillCatalog } from "./skill-catalog.ts";

const SPACE: SpaceId = "team/oc_governance";
const dirs: string[] = [];

function tempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), label));
  dirs.push(dir);
  return dir;
}

function persistArchiveFixture(dataDir: string, version: number, archive: unknown): unknown {
  const path = join(dataDir, `candidate-space-v${version}.json`);
  writeFileSync(path, `${JSON.stringify(archive, null, 2)}\n`, "utf8");
  return JSON.parse(readFileSync(path, "utf8"));
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("space data governance", () => {
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

    expect(archive.version).toBe(14);
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
    expect(archive.version).toBe(14);
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
    expect(archive.version).toBe(14);
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
    expect(archive.version).toBe(14);
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
    const expectedPlan = structuredClone(current.taskRuns[0].executionPlan);
    source.close();

    current.version = 10;
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
    expect(upgraded.version).toBe(14);
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
      delete archive.agentRevisions;
      delete archive.agent.publishedRevisionId;
    }

    const targetDir = tempDir("ha-v10-shared-agent-target-");
    const target = new KnowledgeEngine({
      dataDir: targetDir,
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
    delete v11.quality;
    v11.agentRevisions[0].source = "migration";
    v10.version = 10;
    delete v10.agentRevisions;
    delete v10.agent.publishedRevisionId;
    delete v10.quality;

    const targetDir = tempDir("ha-mixed-agent-v11-first-");
    const target = new KnowledgeEngine({
      dataDir: targetDir,
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
    delete v10.agentRevisions;
    delete v10.agent.publishedRevisionId;
    delete v10.quality;
    v11.version = 11;
    delete v11.quality;
    v11.agentRevisions[0].source = "migration";

    const targetDir = tempDir("ha-mixed-agent-v10-first-");
    const target = new KnowledgeEngine({
      dataDir: targetDir,
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
    expect(upgraded.version).toBe(14);
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
    const source = new KnowledgeEngine({ dataDir: sourceDir });
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
    expect(upgraded.version).toBe(14);
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
    expect(upgraded.version).toBe(14);
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
      name: "每日报告",
      space: SPACE,
      topic: "项目进展",
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
      startedAt: 1_700_000_150_000,
    });
    source.chatRuns.succeed(chatRun.id, {
      finishedAt: chatRun.startedAt,
      output: "durable chat result",
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
        version: 14,
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
        tasks: [expect.objectContaining({ name: "每日报告", space: SPACE })],
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
    expect(restored.registry.get(SPACE)).toEqual(archive.space);
    expect(restored.agentForSpace(SPACE)).toEqual(archive.agent);
    expect(restored.agents.listRevisions(agent.id)).toEqual(archive.agentRevisions);
    expect(restored.tasks.list()).toEqual(archive.tasks);
    expect(restored.listTaskRuns(task.id)).toEqual(archive.taskRuns);
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

    expect(parsed.version).toBe(14);
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

    expect(parsed.version).toBe(14);
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
    expect((await target.exportSpace(SPACE)).version).toBe(14);
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

    const unsafe = JSON.parse(JSON.stringify(archive));
    unsafe.learning.plans[0].onlineResources[0].url = "javascript:alert(1)";
    expect(() => parseSpaceArchive(unsafe)).toThrow("onlineResources");
  });

  test("accepts version 4 governance archives with no task run history", async () => {
    const engine = new KnowledgeEngine({ dataDir: tempDir("ha-v4-archive-") });
    engine.ensureSpace(SPACE);
    const archive = JSON.parse(JSON.stringify(await engine.exportSpace(SPACE))) as Record<string, unknown>;
    engine.close();
    archive.version = 4;
    delete archive.taskRuns;

    const parsed = parseSpaceArchive(archive);

    expect(parsed.version).toBe(14);
    expect(parsed.taskRuns).toEqual([]);
  });

  test("accepts version 5 task history and backfills execution limits", async () => {
    const engine = new KnowledgeEngine({
      dataDir: tempDir("ha-v5-archive-"),
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
    delete archive.taskRuns[0].timeoutMs;
    delete archive.taskRuns[0].notify;
    delete archive.taskRuns[0].notification;

    const parsed = parseSpaceArchive(archive);

    expect(parsed.version).toBe(14);
    expect(parsed.tasks[0]?.timeoutMinutes).toBe(12);
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
    engine.registry.remove = () => {
      throw new Error("workspace removal failed");
    };

    await expect(engine.deleteSpace(SPACE)).rejects.toThrow("workspace removal failed");

    expect(engine.registry.has(SPACE)).toBe(true);
    expect(engine.tasks.get(task.id)).toEqual(task);
    expect(engine.learning.get(learningPlan.id)).toEqual(learningPlan);
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
