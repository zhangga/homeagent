import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompleteOptions, CompleteResult, JSONOptions } from "@homeagent/llm";
import type { SpaceId } from "@homeagent/shared";
import { KnowledgeEngine } from "./engine.ts";
import type { LlmClient } from "./llm.ts";

const directories: string[] = [];
const SPACE: SpaceId = "team/oc_quality_rerun";
const SECONDARY_SPACE: SpaceId = "personal/ou_quality_rerun";

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("quality reruns", () => {
  test("re-evaluates a successful Chat Run with its frozen plan and no delivery side effects", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ha-quality-rerun-"));
    directories.push(directory);
    const calls: CompleteOptions[] = [];
    const result = (text: string): CompleteResult => ({
      text,
      model: "captured-model",
      usage: {
        inputTokens: 41,
        cachedInputTokens: 10,
        outputTokens: 7,
        reasoningTokens: 3,
        costUsd: 0.006,
        costBasis: "reported",
        source: "claude-json",
      },
    });
    const llm: LlmClient = {
      async complete(options) {
        calls.push(options);
        return result("candidate answer");
      },
      async completeJSON<T>(_options: JSONOptions<T>) {
        throw new Error("empty knowledge rerun must use the general completion path");
      },
    };
    const engine = new KnowledgeEngine({ dataDir: directory, llm });
    let reopened: KnowledgeEngine | undefined;
    try {
      engine.ensureSpace(SPACE);
      engine.ensureSpace(SECONDARY_SPACE);
      const sourceTrace = engine.quality.recordTrace({
        spaces: [SPACE, SECONDARY_SPACE],
        question: "Who owns the backend?",
        outcome: "succeeded",
        source: "general",
        answer: "source answer",
        citations: [],
        latencyMs: 10,
        createdAt: 1_000,
      });
      const sourceRun = engine.chatRuns.start({
        space: SPACE,
        input: "What about that?",
        trigger: "message",
        agentId: "agent_frozen",
        provider: "codex",
        model: "gpt-frozen",
        skillEvidence: { requested: [], resolved: [], skipped: [] },
        executionPlan: {
          version: 1,
          instruction: "Use the frozen persona.",
          provider: "codex",
          model: "gpt-frozen",
        },
        startedAt: 1_100,
      });
      engine.chatRuns.begin(sourceRun.id, 1_200);
      engine.chatRuns.succeed(sourceRun.id, {
        finishedAt: 1_300,
        output: "source answer",
        traceId: sourceTrace.id,
      });

      const rerun = await engine.rerunChatRunForEvaluation(sourceRun.id);

      expect(rerun).toEqual(expect.objectContaining({
        sourceChatRunId: sourceRun.id,
        sourceTraceId: sourceTrace.id,
        status: "completed",
        candidateTraceId: expect.stringMatching(/^answer_/),
      }));
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual(expect.objectContaining({
        system: expect.stringContaining("Use the frozen persona."),
        model: "gpt-frozen",
        prompt: expect.stringContaining("Who owns the backend?"),
      }));
      expect(calls[0]!.prompt).not.toContain("What about that?");
      expect(engine.answerTrace(rerun.candidateTraceId!)).toEqual(expect.objectContaining({
        answer: "candidate answer",
        spaces: [SPACE, SECONDARY_SPACE],
        execution: {
          agentId: "agent_frozen",
          provider: "codex",
          model: "gpt-frozen",
          promptVersion: "ask-v1",
          instructionHash: expect.stringMatching(/^[0-9a-f]{64}$/),
          skills: [],
        },
        retrievalPages: [],
        usage: {
          calls: 1,
          knownTokenCalls: 1,
          unknownTokenCalls: 0,
          knownCostCalls: 1,
          unknownCostCalls: 0,
          inputTokens: 41,
          cachedInputTokens: 10,
          outputTokens: 7,
          reasoningTokens: 3,
          costUsd: 0.006,
          costBasis: "reported",
          sources: ["claude-json"],
        },
      }));
      expect(engine.chatRuns.list(SPACE)).toHaveLength(1);
      expect(engine.chatRuns.get(sourceRun.id)?.delivery).toEqual({
        status: "pending",
        attempts: 0,
      });
      engine.close();

      reopened = new KnowledgeEngine({ dataDir: directory, llm });
      expect(reopened.quality.rerunsForChatRun(sourceRun.id)).toEqual([
        expect.objectContaining({ id: rerun.id, status: "completed" }),
      ]);
    } finally {
      reopened?.close();
      engine.close();
    }
  });

  test("fails closed when a source trace space is no longer available", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ha-quality-rerun-missing-space-"));
    directories.push(directory);
    let calls = 0;
    const llm: LlmClient = {
      async complete() {
        calls += 1;
        return {
          text: "must not run",
          model: "unused",
          usage: { costBasis: "unavailable", source: "legacy-text" },
        };
      },
      async completeJSON<T>(_options: JSONOptions<T>) {
        throw new Error("must not run");
      },
    };
    const engine = new KnowledgeEngine({ dataDir: directory, llm });
    try {
      engine.ensureSpace(SPACE);
      engine.ensureSpace(SECONDARY_SPACE);
      const trace = engine.quality.recordTrace({
        spaces: [SPACE, SECONDARY_SPACE],
        question: "Use both spaces",
        outcome: "succeeded",
        source: "general",
        answer: "source answer",
        citations: [],
        latencyMs: 10,
        createdAt: 1_000,
      });
      const run = engine.chatRuns.start({
        space: SPACE,
        input: "Use both spaces",
        trigger: "message",
        executionPlan: { version: 1, instruction: "Frozen." },
        startedAt: 1_100,
      });
      engine.chatRuns.begin(run.id, 1_200);
      engine.chatRuns.succeed(run.id, {
        finishedAt: 1_300,
        output: "source answer",
        traceId: trace.id,
      });
      expect((await engine.deleteSpace(SECONDARY_SPACE)).status).toBe("deleted");

      await expect(engine.rerunChatRunForEvaluation(run.id))
        .rejects.toThrow(/source trace spaces are unavailable/i);

      expect(calls).toBe(0);
      expect(engine.quality.rerunsForChatRun(run.id)).toEqual([
        expect.objectContaining({ status: "failed" }),
      ]);
    } finally {
      engine.close();
    }
  });
});
