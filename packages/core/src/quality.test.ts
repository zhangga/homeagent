import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QualityStore } from "./quality.ts";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "homeagent-quality-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("QualityStore", () => {
  test("exports and restores the answer traces referenced by archived chat runs", () => {
    const source = new QualityStore(tempDir());
    const trace = source.recordTrace({
      spaces: ["team/oc_quality"],
      question: "Who owns the backend?",
      outcome: "succeeded",
      source: "knowledge",
      answer: "Alice",
      citations: [{ slug: "people/alice", title: "Alice", space: "team/oc_quality" }],
      retrievalPages: [{ slug: "people/alice", space: "team/oc_quality", contentHash: "source", revision: "a".repeat(64) }],
      latencyMs: 10,
      createdAt: 1_000,
    });

    const archive = source.exportArchive([{
      id: "chat_run_source",
      traceId: trace.id,
    }]);
    const target = new QualityStore(tempDir());
    target.restoreArchive(archive);

    expect(archive).toEqual({ traces: [trace], reruns: [] });
    expect(target.trace(trace.id)).toEqual(trace);
  });

  test("accepts legacy retrieval evidence and rejects malformed page revisions without replacing it", () => {
    const dir = tempDir();
    const store = new QualityStore(dir);
    const legacy = store.recordTrace({ spaces: ["team/oc_quality"], question: "发布流程", outcome: "succeeded",
      citations: [], latencyMs: 10, retrievalPages: [{ slug: "concepts/release", space: "team/oc_quality", contentHash: "old" }] });
    for (const revision of ["", "g".repeat(64), "a".repeat(65)]) {
      expect(() => store.recordTrace({ ...legacy, retrievalPages: [{ ...legacy.retrievalPages![0]!, revision }] })).toThrow();
    }
    expect(new QualityStore(dir).trace(legacy.id)).toEqual(legacy);
  });

  test("exports closed rerun audits and candidate traces but excludes active reruns", () => {
    const source = new QualityStore(tempDir());
    const sourceTrace = source.recordTrace({
      spaces: ["team/oc_quality"],
      question: "Who owns the backend?",
      outcome: "succeeded",
      answer: "Alice",
      citations: [],
      latencyMs: 10,
      createdAt: 1_000,
    });
    const completed = source.startRerun({
      sourceChatRunId: "chat_run_source",
      sourceTraceId: sourceTrace.id,
      createdAt: 2_000,
    })!;
    const candidateTrace = source.recordTrace({
      spaces: ["team/oc_quality"],
      question: "Who owns the backend?",
      outcome: "succeeded",
      answer: "Bob",
      citations: [],
      latencyMs: 12,
      createdAt: 3_000,
    });
    source.completeRerun(completed.id, candidateTrace.id, 3_100);
    const failed = source.startRerun({
      sourceChatRunId: "chat_run_source",
      sourceTraceId: sourceTrace.id,
      createdAt: 4_000,
    })!;
    source.failRerun(failed.id, "provider unavailable", 4_100);
    source.startRerun({
      sourceChatRunId: "chat_run_source",
      sourceTraceId: sourceTrace.id,
      createdAt: 5_000,
    });

    const archive = source.exportArchive([{
      id: "chat_run_source",
      traceId: sourceTrace.id,
    }]);

    expect(archive.traces.map((trace) => trace.id)).toEqual([
      sourceTrace.id,
      candidateTrace.id,
    ]);
    expect(archive.reruns.map((rerun) => ({ id: rerun.id, status: rerun.status }))).toEqual([
      { id: completed.id, status: "completed" },
      { id: failed.id, status: "failed" },
    ]);
    const target = new QualityStore(tempDir());
    target.restoreArchive(archive);
    expect(target.trace(candidateTrace.id)).toEqual(candidateTrace);
    expect(target.rerunsForChatRun("chat_run_source").map((rerun) => rerun.status)).toEqual([
      "failed",
      "completed",
    ]);
    const conflicting = structuredClone(archive);
    conflicting.reruns[0]!.completedAt! += 1;
    expect(() => target.restoreArchive(conflicting)).toThrow(/quality rerun.*different data/i);
  });

  test("restores identical quality archives idempotently and rejects content conflicts atomically", () => {
    const source = new QualityStore(tempDir());
    const trace = source.recordTrace({
      spaces: ["team/oc_quality"],
      question: "Who owns the backend?",
      outcome: "succeeded",
      answer: "Alice",
      citations: [],
      latencyMs: 10,
      createdAt: 1_000,
    });
    const archive = source.exportArchive([{ id: "chat_run_source", traceId: trace.id }]);
    const target = new QualityStore(tempDir());

    target.restoreArchive(archive);
    expect(target.restoreArchive(archive)).toEqual({ traceIds: [], rerunIds: [] });
    expect(target.restoreArchive({
      traces: [{
        createdAt: trace.createdAt,
        latencyMs: trace.latencyMs,
        citations: trace.citations.map((citation) => ({
          title: citation.title,
          slug: citation.slug,
        })),
        answer: trace.answer,
        source: trace.source,
        outcome: trace.outcome,
        question: trace.question,
        spaces: [...trace.spaces],
        id: trace.id,
      }],
      reruns: [],
    })).toEqual({ traceIds: [], rerunIds: [] });
    const conflicting = structuredClone(archive);
    conflicting.traces[0]!.answer = "Mallory";

    expect(() => target.restoreArchive(conflicting)).toThrow(/different data/i);
    expect(target.trace(trace.id)?.answer).toBe("Alice");
  });

  test("rejects oversized quality archive identity fields before mutating the store", () => {
    const source = new QualityStore(tempDir());
    const trace = source.recordTrace({
      spaces: ["team/oc_quality"],
      question: "Who owns the backend?",
      outcome: "succeeded",
      answer: "Alice",
      citations: [],
      latencyMs: 10,
      createdAt: 1_000,
    });
    const archive = source.exportArchive([{ id: "chat_run_source", traceId: trace.id }]);
    const oversizedSpace = structuredClone(archive);
    oversizedSpace.traces[0]!.spaces = [`team/${"x".repeat(600)}`];
    const oversizedQuestion = structuredClone(archive);
    oversizedQuestion.traces[0]!.question = "x".repeat(4_001);
    const invalidCitationSpace = structuredClone(archive) as unknown as {
      traces: Array<{ citations: Array<{ slug: string; title: string; space?: string }> }>;
      reruns: unknown[];
    };
    invalidCitationSpace.traces[0]!.citations = [{
      slug: "people/alice",
      title: "Alice",
      space: "not-a-space",
    }];
    const oversizedCollection = {
      traces: Array.from({ length: 1_001 }, () => structuredClone(trace)),
      reruns: [],
    };
    const target = new QualityStore(tempDir());

    expect(() => target.restoreArchive(oversizedSpace)).toThrow(/invalid answer trace/i);
    expect(() => target.restoreArchive(oversizedQuestion)).toThrow(/invalid answer trace/i);
    expect(() => target.restoreArchive(invalidCitationSpace)).toThrow(/invalid answer trace/i);
    expect(() => target.restoreArchive(oversizedCollection)).toThrow(/exceeds 1000 traces/i);
    expect(target.trace(trace.id)).toBeUndefined();
  });

  test("persists successful and failed answer traces across restarts", () => {
    const dir = tempDir();
    const store = new QualityStore(dir);
    const success = store.recordTrace({
      spaces: ["team/oc_quality"],
      question: "谁负责后端？",
      outcome: "succeeded",
      source: "knowledge",
      answer: "Alice 负责后端。",
      citations: [{ slug: "entities/alice", title: "Alice" }],
      latencyMs: 125,
      createdAt: 1000,
    });
    const failure = store.recordTrace({
      spaces: ["team/oc_quality"],
      question: "服务为什么超时？",
      outcome: "failed",
      error: "provider unavailable",
      citations: [],
      latencyMs: 250,
      createdAt: 2000,
    });

    const restarted = new QualityStore(dir);
    expect(restarted.trace(success.id)).toEqual(success);
    expect(restarted.trace(failure.id)).toEqual(failure);
  });

  test("a replayable form trace cannot replace another completed attempt", () => {
    const dir = tempDir();
    const store = new QualityStore(dir);
    const input = {
      submissionTraceId: "answer_" + "c".repeat(64), spaces: ["personal/operator" as const],
      question: "什么时候交接？", outcome: "failed" as const, citations: [], latencyMs: 25,
    };
    const first = store.recordTrace(input);
    expect(first.id).toBe(input.submissionTraceId);
    expect(() => store.recordTrace({ ...input, question: "其他问题" })).toThrow();
    expect(() => store.recordTrace({ ...input, submissionTraceId: "malformed" })).toThrow();
    expect(new QualityStore(dir).trace(first.id)).toEqual(first);
  });

  test("retains bounded question and answer excerpts with their original citation evidence after reopening", () => {
    const dir = tempDir();
    const store = new QualityStore(dir);
    const evidence = { sourceCount: 2, latestSourceAt: 100, freshness: "recent" as const, complete: true };
    const input = { spaces: ["team/oc_quality" as const], outcome: "succeeded" as const, source: "knowledge" as const,
      question: "问".repeat(4_000), answer: "答".repeat(12_000), citations: [{ slug: "entities/team", title: "团队", evidence }], latencyMs: 1 };
    const exact = store.recordTrace(input);
    expect(exact.questionTruncated).toBeUndefined();
    expect(exact.answerTruncated).toBeUndefined();
    const clipped = store.recordTrace({ ...input, question: input.question + "？", answer: input.answer + "。" });
    evidence.sourceCount = 5;
    clipped.citations[0]!.evidence!.sourceCount = 100;
    const expected = { question: input.question, answer: input.answer, questionTruncated: true, answerTruncated: true,
      citations: [{ slug: "entities/team", title: "团队", evidence: { ...evidence, sourceCount: 2 } }] };
    expect(store.trace(clipped.id)).toMatchObject(expected);
    expect(new QualityStore(dir).trace(clipped.id)).toMatchObject(expected);
  });

  test("accepts one validated feedback record per trace", () => {
    const store = new QualityStore(tempDir());
    const trace = store.recordTrace({
      spaces: ["team/oc_quality"],
      question: "谁负责后端？",
      outcome: "succeeded",
      source: "knowledge",
      answer: "Alice 负责后端。",
      citations: [{ slug: "entities/alice", title: "Alice" }],
      latencyMs: 10,
    });

    expect(store.recordFeedback(trace.id, "helpful", "回答准确", 2000)).toEqual(
      expect.objectContaining({
        traceId: trace.id,
        kind: "helpful",
        note: "回答准确",
        createdAt: 2000,
      }),
    );
    expect(store.recordFeedback(trace.id, "unhelpful")).toBeUndefined();
    expect(store.recordFeedback("answer_missing", "helpful")).toBeUndefined();
    expect(store.recordFeedback(trace.id, "unknown" as never)).toBeUndefined();
  });

  test("turns negative feedback into a durable review and evaluation candidate", () => {
    const dir = tempDir();
    const store = new QualityStore(dir);
    const trace = store.recordTrace({
      spaces: ["team/oc_quality"],
      question: "线上故障该找谁？",
      outcome: "succeeded",
      source: "knowledge",
      answer: "请联系 Alice。",
      citations: [{ slug: "entities/alice", title: "Alice" }],
      latencyMs: 80,
      createdAt: 1000,
    });
    const helpfulTrace = store.recordTrace({
      spaces: ["team/oc_quality"],
      question: "发布流程是什么？",
      outcome: "succeeded",
      source: "knowledge",
      answer: "先灰度发布。",
      citations: [{ slug: "release", title: "发布流程" }],
      latencyMs: 40,
      createdAt: 1500,
    });
    store.recordFeedback(trace.id, "citation_error", "引用页面没有值班信息", 2000);
    store.recordFeedback(helpfulTrace.id, "helpful", undefined, 2100);

    expect(store.feedbackReviews({ status: "open" })).toEqual([
      expect.objectContaining({
        status: "open",
        trace: expect.objectContaining({ id: trace.id, question: "线上故障该找谁？" }),
        feedback: expect.objectContaining({ kind: "citation_error" }),
      }),
      expect.objectContaining({
        status: "open",
        trace: expect.objectContaining({ id: helpfulTrace.id }),
        feedback: expect.objectContaining({ kind: "helpful" }),
      }),
    ]);

    expect(store.promoteFeedbackToEvaluationCase(trace.id, "   ")).toBeUndefined();
    const evaluationCase = store.promoteFeedbackToEvaluationCase(
      trace.id,
      "补充值班负责人后重跑",
      3000,
    );
    expect(evaluationCase).toEqual(expect.objectContaining({
      traceId: trace.id,
      spaces: ["team/oc_quality"],
      question: "线上故障该找谁？",
      observedAnswer: "请联系 Alice。",
      observedCitations: [{ slug: "entities/alice", title: "Alice" }],
      feedbackKind: "citation_error",
      feedbackNote: "引用页面没有值班信息",
      curatorNote: "补充值班负责人后重跑",
      createdAt: 3000,
    }));
    expect(store.promoteFeedbackToEvaluationCase(trace.id, "重复加入")).toBeUndefined();
    expect(store.promoteFeedbackToEvaluationCase(helpfulTrace.id, "不应加入")).toBeUndefined();

    expect(store.resolveFeedback(trace.id, "   ")).toBeUndefined();
    expect(store.resolveFeedback(helpfulTrace.id, "正面反馈无需处理")).toBeUndefined();
    expect(store.resolveFeedback(trace.id, "已修正负责人知识页", 4000)).toEqual(
      expect.objectContaining({
        traceId: trace.id,
        resolvedAt: 4000,
        resolutionNote: "已修正负责人知识页",
      }),
    );
    expect(store.feedbackReviews({ status: "open" }).map((item) => item.trace.id)).toEqual([
      helpfulTrace.id,
    ]);
    expect(store.feedbackReviews({ status: "resolved" })).toEqual([
      expect.objectContaining({
        status: "resolved",
        trace: expect.objectContaining({ id: trace.id }),
        evaluationCase: expect.objectContaining({ id: evaluationCase!.id }),
      }),
    ]);

    const restarted = new QualityStore(dir);
    expect(restarted.evaluationCases()).toEqual([
      expect.objectContaining({ id: evaluationCase!.id, traceId: trace.id }),
    ]);
    expect(restarted.feedbackReviews({ status: "resolved" })).toHaveLength(1);
  });

  test("snapshot exposes aggregates without leaking stored content", () => {
    const store = new QualityStore(tempDir());
    const helpful = store.recordTrace({
      spaces: ["team/oc_quality"],
      question: "private question",
      outcome: "succeeded",
      source: "knowledge",
      answer: "private answer",
      citations: [{ slug: "private-page", title: "Private Page" }],
      latencyMs: 100,
      createdAt: 1000,
    });
    store.recordTrace({
      spaces: ["team/oc_quality"],
      question: "failed private question",
      outcome: "timed_out",
      error: "private timeout detail",
      citations: [],
      latencyMs: 500,
      createdAt: 2000,
    });
    store.recordFeedback(helpful.id, "helpful", "private note", 3000);

    const snapshot = store.snapshot();
    expect(snapshot).toEqual({
      answers: {
        total: 2,
        succeeded: 1,
        failed: 0,
        timedOut: 1,
        knowledge: 1,
        general: 0,
        averageLatencyMs: 300,
        maxLatencyMs: 500,
      },
      feedback: {
        total: 1,
        helpful: 1,
        unhelpful: 0,
        citationError: 0,
        helpfulRate: 1,
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain("private");
  });

  test("persists an evaluation rerun that links the source and candidate traces", () => {
    const dir = tempDir();
    const store = new QualityStore(dir);
    const source = store.recordTrace({
      spaces: ["team/oc_quality"],
      question: "Who owns the backend?",
      outcome: "succeeded",
      source: "knowledge",
      answer: "Alice",
      citations: [{ slug: "people/alice", title: "Alice" }],
      latencyMs: 10,
      createdAt: 1_000,
    });

    const rerun = store.startRerun({
      sourceChatRunId: "chat_run_source",
      sourceTraceId: source.id,
      createdAt: 2_000,
    });
    expect(rerun).toEqual(expect.objectContaining({
      sourceChatRunId: "chat_run_source",
      sourceTraceId: source.id,
      status: "running",
      createdAt: 2_000,
    }));
    expect(store.startRerun({
      sourceChatRunId: "chat_run_source",
      sourceTraceId: "answer_missing",
      createdAt: 2_001,
    })).toBeUndefined();

    const candidate = store.recordTrace({
      spaces: ["team/oc_quality"],
      question: "Who owns the backend?",
      outcome: "succeeded",
      source: "knowledge",
      answer: "Bob",
      citations: [{ slug: "people/bob", title: "Bob" }],
      latencyMs: 12,
      createdAt: 3_000,
    });
    expect(store.completeRerun(rerun!.id, candidate.id, 3_100)).toEqual(
      expect.objectContaining({
        id: rerun!.id,
        status: "completed",
        candidateTraceId: candidate.id,
        completedAt: 3_100,
      }),
    );
    expect(store.completeRerun(rerun!.id, candidate.id, 3_200)).toBeUndefined();

    const restarted = new QualityStore(dir);
    expect(restarted.rerunsForChatRun("chat_run_source")).toEqual([
      expect.objectContaining({
        id: rerun!.id,
        sourceTraceId: source.id,
        candidateTraceId: candidate.id,
        status: "completed",
      }),
    ]);
  });

  test("marks an interrupted evaluation rerun failed when the store reopens", () => {
    const dir = tempDir();
    const store = new QualityStore(dir);
    const source = store.recordTrace({
      spaces: ["team/oc_quality"],
      question: "What changed?",
      outcome: "succeeded",
      source: "general",
      answer: "Original",
      citations: [],
      latencyMs: 5,
      createdAt: 4_000,
    });
    const rerun = store.startRerun({
      sourceChatRunId: "chat_run_interrupted",
      sourceTraceId: source.id,
      createdAt: 4_100,
    })!;

    const reopened = new QualityStore(dir);

    expect(reopened.rerunsForChatRun("chat_run_interrupted")).toEqual([
      expect.objectContaining({
        id: rerun.id,
        status: "failed",
        completedAt: expect.any(Number),
        error: "The application stopped before the evaluation rerun completed.",
      }),
    ]);
  });
});
