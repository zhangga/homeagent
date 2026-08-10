import {
  CODEX_REASONING_EFFORTS,
  type CodexReasoningEffort,
  type ProviderExecution,
  type ProviderId,
} from "@homeagent/llm";

export const RESOLVED_EXECUTION_PLAN_VERSION = 1 as const;
export const MAX_EXECUTION_PLAN_INSTRUCTION_CHARACTERS = 20_000;
export const MAX_EXECUTION_PLAN_MODEL_CHARACTERS = 200;
export const MAX_EXECUTION_PLAN_ERROR_CHARACTERS = 20_000;
export const MAX_EXECUTION_PLAN_WORKDIR_CHARACTERS = 2_048;
export const MAX_EXECUTION_PLAN_SKILLS = 50;

/** Immutable provider choices captured before a Chat or Task Run is queued. */
export interface ResolvedExecutionPlan {
  version: typeof RESOLVED_EXECUTION_PLAN_VERSION;
  /** Published Agent revision that produced this frozen plan, when known. */
  agentRevisionId?: string;
  instruction: string;
  provider?: ProviderId;
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
  execution?: ProviderExecution;
  resolutionError?: string;
}

function isProviderId(value: unknown): value is ProviderId {
  return ["gateway", "claude", "codex", "trae-cli"].includes(String(value));
}

export function isAgentRevisionId(value: unknown): value is string {
  return typeof value === "string"
    && /^agent_revision_[a-zA-Z0-9-]{1,160}$/.test(value);
}

function isExecution(value: unknown): value is ProviderExecution {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const execution = value as Partial<ProviderExecution>;
  const validWorkdir = execution.workdir === undefined || (
    typeof execution.workdir === "string"
    && execution.workdir.length > 0
    && execution.workdir.length <= MAX_EXECUTION_PLAN_WORKDIR_CHARACTERS
  );
  return (
    ["read-only", "write", "full"].includes(String(execution.permission))
    && validWorkdir
    && (execution.permission === "read-only" || execution.workdir !== undefined)
    && Array.isArray(execution.skills)
    && execution.skills.length <= MAX_EXECUTION_PLAN_SKILLS
    && execution.skills.every((skill) =>
      typeof skill === "string"
      && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/.test(skill)
    )
    && (execution.webSearch === undefined || typeof execution.webSearch === "boolean")
  );
}

export function isResolvedExecutionPlan(value: unknown): value is ResolvedExecutionPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const plan = value as Partial<ResolvedExecutionPlan>;
  return (
    plan.version === RESOLVED_EXECUTION_PLAN_VERSION
    && (plan.agentRevisionId === undefined || isAgentRevisionId(plan.agentRevisionId))
    && typeof plan.instruction === "string"
    && plan.instruction.length <= MAX_EXECUTION_PLAN_INSTRUCTION_CHARACTERS
    && (plan.provider === undefined || isProviderId(plan.provider))
    && (plan.model === undefined || (
      typeof plan.model === "string"
      && plan.model.length <= MAX_EXECUTION_PLAN_MODEL_CHARACTERS
    ))
    && (plan.reasoningEffort === undefined
      || CODEX_REASONING_EFFORTS.includes(plan.reasoningEffort))
    && (plan.execution === undefined || isExecution(plan.execution))
    && (plan.resolutionError === undefined || (
      typeof plan.resolutionError === "string"
      && plan.resolutionError.length <= MAX_EXECUTION_PLAN_ERROR_CHARACTERS
    ))
  );
}

export function cloneResolvedExecutionPlan(
  plan: ResolvedExecutionPlan,
): ResolvedExecutionPlan {
  return {
    version: plan.version,
    ...(plan.agentRevisionId === undefined
      ? {}
      : { agentRevisionId: plan.agentRevisionId }),
    instruction: plan.instruction,
    ...(plan.provider === undefined ? {} : { provider: plan.provider }),
    ...(plan.model === undefined ? {} : { model: plan.model }),
    ...(plan.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: plan.reasoningEffort }),
    ...(plan.execution === undefined
      ? {}
      : {
          execution: {
            ...plan.execution,
            skills: [...plan.execution.skills],
          },
        }),
    ...(plan.resolutionError === undefined
      ? {}
      : { resolutionError: plan.resolutionError }),
  };
}
