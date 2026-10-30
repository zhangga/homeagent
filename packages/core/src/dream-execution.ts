import { config, normalizeDreamModel, type DreamMetrics, type DreamModels, type DreamPhase, type DreamPhaseMetrics } from "@homeagent/shared";
import { BudgetExceededError, type CompleteOptions, type CompleteResult, type JSONOptions } from "@homeagent/llm";
import type { LlmClient } from "./llm.ts";
import type { DreamProgress } from "./dream-progress.ts";
import { observeLlmUsage, RunUsageAccumulator } from "./usage.ts";

const PHASES: DreamPhase[] = ["planning", "extraction", "merge"];
const TOKEN_FIELDS = ["inputTokens", "outputTokens", "cachedInputTokens", "cacheCreationInputTokens", "reasoningTokens"] as const;
interface PhaseState {
  client: LlmClient;
  model: string | undefined;
  modelLabel?: string;
  provider?: string;
  usage: RunUsageAccumulator;
  active: number;
  startedAt: number;
  elapsed: number;
  failed: number;
  reused: number;
}

/** One immutable model selection per Dream run, with no prompts or Raw in telemetry. */
export class DreamExecution {
  private readonly phases: Record<DreamPhase, PhaseState>;
  private readonly startedAt: number;
  private lastProgress: DreamProgress = { stage: "preparing" };

  constructor(base: LlmClient, options: { model?: string; models?: DreamModels; signal?: AbortSignal } = {},
    private readonly onProgress?: (progress: DreamProgress) => void,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.startedAt = now();
    const cfg = config();
    const models: DreamModels = {
      planning: options.models?.planning ?? cfg.dreamPlanningModel,
      extraction: options.models?.extraction ?? cfg.dreamExtractionModel,
      merge: options.models?.merge ?? cfg.dreamMergeModel,
    };
    const make = (phase: DreamPhase): PhaseState => {
      const selected = normalizeDreamModel(models[phase] ?? "");
      const client = selected && base.forModel ? base.forModel(selected) : base;
      const model = selected || client.model || options.model || cfg.model;
      const usage = new RunUsageAccumulator();
      const observed = observeLlmUsage(client, item => usage.record(item));
      const modelLabel = selected || client.model || (client.provider ? undefined : model);
      const state: PhaseState = { client: observed, model, modelLabel, provider: client.provider, usage, active: 0, startedAt: 0, elapsed: 0, failed: 0, reused: 0 };
      const invoke = async <T>(call: () => Promise<T>): Promise<T> => {
        if (options.signal?.aborted) throw options.signal.reason ?? new Error("distillation cancelled");
        if (state.active++ === 0) state.startedAt = this.now();
        let invoked = false;
        try {
          this.flush();
          if (options.signal?.aborted) throw options.signal.reason ?? new Error("distillation cancelled");
          invoked = true;
          return await call();
        }
        catch (error) { if (invoked && !(error instanceof BudgetExceededError)) state.failed++; throw error; }
        finally {
          if (--state.active === 0) state.elapsed += Math.max(0, this.now() - state.startedAt);
          this.flush();
        }
      };
      state.client = {
        cacheIdentity: client.cacheIdentity,
        model: client.model,
        provider: client.provider,
        complete: (opts: CompleteOptions): Promise<CompleteResult> => invoke(() => observed.complete({ ...opts, model })),
        completeJSON: <T>(opts: JSONOptions<T>) => invoke(() => observed.completeJSON({ ...opts, model })),
      };
      return state;
    };
    this.phases = { planning: make("planning"), extraction: make("extraction"), merge: make("merge") };
  }

  phase(phase: DreamPhase): { client: LlmClient; model: string | undefined } {
    const { client, model } = this.phases[phase];
    return { client, model };
  }
  reusedExtraction(): void { this.phases.extraction.reused++; }

  snapshot(): DreamMetrics {
    const phase = (key: DreamPhase): DreamPhaseMetrics => {
      const state = this.phases[key];
      const usage = state.usage.snapshot();
      return { ...(state.modelLabel ? { model: state.modelLabel.replace(/[\u0000-\u001f\u007f]/gu, "").slice(0, 240) } : {}),
        ...(state.provider ? { provider: state.provider.slice(0, 80) } : {}),
        elapsedMs: Math.round(state.elapsed + (state.active ? Math.max(0, this.now() - state.startedAt) : 0)),
        calls: usage.calls, activeCalls: state.active, failedCalls: state.failed,
        knownTokenCalls: usage.knownTokenCalls, unknownTokenCalls: usage.unknownTokenCalls,
        ...Object.fromEntries(TOKEN_FIELDS.filter(field => usage[field] !== undefined).map(field => [field, usage[field]])),
        reusedExtractions: state.reused };
    };
    return { elapsedMs: Math.round(Math.max(0, this.now() - this.startedAt)),
      phases: { planning: phase("planning"), extraction: phase("extraction"), merge: phase("merge") } };
  }

  readonly progress = (progress: DreamProgress): void => {
    this.lastProgress = structuredClone(progress);
    this.flush();
  };
  flush(): void { this.onProgress?.({ ...structuredClone(this.lastProgress), metrics: this.snapshot() }); }
}

/** Bounded numeric/model summary only; the existing Wiki log remains its durable home. */
export function dreamMetricsLog(metrics: DreamMetrics): string {
  return ` elapsed_ms=${metrics.elapsedMs} ` + PHASES.map(phase => {
    const item = metrics.phases[phase];
    const model = (item.model ?? "default").replace(/[\r\n\u0000-\u001f\u007f]/gu, "").slice(0, 240);
    return `${phase}=${JSON.stringify({ model, elapsed_ms: item.elapsedMs, calls: item.calls, failed: item.failedCalls,
      input_tokens: item.inputTokens ?? "unknown", output_tokens: item.outputTokens ?? "unknown",
      cached_input_tokens: item.cachedInputTokens ?? "unknown", unknown_token_calls: item.unknownTokenCalls, reused: item.reusedExtractions })}`;
  }).join(" ");
}
