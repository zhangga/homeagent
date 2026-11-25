import { createHash } from "node:crypto";
import { MAX_ANSWER_TRACES, type KnowledgeEngine } from "@homeagent/core";
import { isProviderTimeoutError } from "@homeagent/llm";
import { config, type AskResult, type SpaceId } from "@homeagent/shared";
import { askFailure, type AskFailure } from "./ask-failure.ts";

interface Submission {
  result?: AskResult;
  failure?: AskFailure;
  traceId?: string;
  reopened?: boolean;
}

/** Concurrent requests share the full first response. Completed form replays use the durable answer trace. */
export class SpaceAskSubmissions {
  private readonly pending = new Map<string, Promise<Submission>>();
  // If recording fails after the model ran, retain only the form fingerprint.
  private readonly unsaved = new Set<string>();

  constructor(private readonly engine: KnowledgeEngine) {}

  submit(space: SpaceId, question: string, submissionId?: string): Promise<Submission> {
    const digest = createHash("sha256").update(JSON.stringify([space, question, submissionId])).digest("hex");
    const pending = this.pending.get(digest);
    if (pending) return pending;
    const traceId = submissionId ? `answer_${digest}` : undefined;
    if (this.unsaved.has(digest)) {
      return Promise.resolve({ failure: { message: "这次提问已处理，但结果未能保存。可以重试这个问题。" } });
    }
    const trace = traceId ? this.engine.answerTrace(traceId) : undefined;
    if (trace && trace.spaces.length === 1 && trace.spaces[0] === space) {
      return Promise.resolve({ traceId, reopened: true });
    }
    const work = this.ask(space, question, traceId).then(submission => {
      if (submissionId && !submission.traceId) {
        if (this.unsaved.size >= MAX_ANSWER_TRACES) this.unsaved.delete(this.unsaved.values().next().value!);
        this.unsaved.add(digest);
      }
      return submission;
    }).finally(() => this.pending.delete(digest));
    this.pending.set(digest, work);
    return work;
  }

  private async ask(space: SpaceId, question: string, submissionTraceId?: string): Promise<Submission> {
    const startedAt = Date.now();
    const agent = this.engine.agentForSpace(space);
    let failedTraceId: string | undefined;
    try {
      const result = await this.engine.ask([space], question, {
        model: agent?.model || undefined,
        instruction: agent?.instruction || undefined,
        submissionTraceId,
        onFailureTrace: record => { failedTraceId = record.traceId; },
      });
      return { result, traceId: result.traceId };
    } catch (error) {
      // Configuration and preflight can fail before the engine starts its answer trace.
      if (!failedTraceId) {
        try {
          failedTraceId = this.engine.quality.recordTrace({
            submissionTraceId, spaces: [space], question, citations: [],
            outcome: isProviderTimeoutError(error) ? "timed_out" : "failed",
            error: error instanceof Error && error.name === "NoProviderError" ? error.name : String(error),
            latencyMs: Date.now() - startedAt, createdAt: startedAt,
          }).id;
        } catch { /* A storage failure must leave the question editable. */ }
      }
      return { failure: askFailure(error, agent?.provider || config().defaultProvider), traceId: failedTraceId };
    }
  }
}
