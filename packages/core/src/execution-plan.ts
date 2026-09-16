import {
  CODEX_REASONING_EFFORTS,
  type CodexReasoningEffort,
  type ProviderExecution,
  type ProviderId,
} from "@homeagent/llm";
import { isAgentRevisionId, isLocalExecutionGrantId } from "./execution-identities.ts";
import { isLocalExecutionChatScope, type LocalExecutionChatScope } from "./local-execution-grants.ts";
export { isAgentRevisionId } from "./execution-identities.ts";

export const RESOLVED_EXECUTION_PLAN_VERSION = 2 as const;
export const LOCAL_EXECUTION_NOT_CONFIRMED = "本机完全访问尚未确认或绑定范围已变化";
export const LEGACY_CODEX_FULL_RECONFIRMATION = "旧 Codex full 配置需要重新确认执行模式并创建新运行";
export const MAX_EXECUTION_PLAN_INSTRUCTION_CHARACTERS = 20_000;
export const MAX_EXECUTION_PLAN_MODEL_CHARACTERS = 200;
export const MAX_EXECUTION_PLAN_ERROR_CHARACTERS = 20_000;
export const MAX_EXECUTION_PLAN_WORKDIR_CHARACTERS = 2_048;
export const MAX_EXECUTION_PLAN_SKILLS = 2_000;

/** Immutable provider choices captured before a Chat or Task Run is queued. */
interface ExecutionPlanIntent {
  version: 1 | 2;
  /** Published Agent revision that produced this frozen plan, when known. */
  agentRevisionId?: string;
  instruction: string;
  provider?: ProviderId;
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
  /** Canonical Agent directory used by the frozen Chat/Task execution. */
  workdir?: string;
  /** Automatically load every compatible Skill discovered for the Provider. */
  skillMode?: "all";
  execution?: ProviderExecution;
  resolutionError?: string;
}

export type LocalExecutionReference =
  | { grantId: string; kind: "chat"; scope: LocalExecutionChatScope }
  | { grantId: string; kind: "task"; scope?: never };

export interface ResolvedExecutionPlan extends ExecutionPlanIntent {
  archiveVersion?: never;
  /** A frozen reference, not authorization by itself. Revalidated by Core. */
  localExecution?: LocalExecutionReference;
}

/** Portable historical intent, deliberately rejected by the executable validator. */
export interface ArchivedExecutionPlan extends ExecutionPlanIntent {
  version: 2;
  archiveVersion: 1;
  localExecution?: never;
}
export type StoredExecutionPlan = ResolvedExecutionPlan | ArchivedExecutionPlan;

export function isLocalExecutionReference(value: unknown): value is LocalExecutionReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const reference = value as Partial<LocalExecutionReference>;
  return isLocalExecutionGrantId(reference.grantId)
    && Object.keys(reference).every(key => ["grantId", "kind", "scope"].includes(key))
    && (reference.kind === "chat" ? isLocalExecutionChatScope(reference.scope)
      : reference.kind === "task" && reference.scope === undefined);
}

function isProviderId(value: unknown): value is ProviderId {
  return ["gateway", "claude", "codex", "trae-cli"].includes(String(value));
}

export function isProviderExecution(value: unknown): value is ProviderExecution {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const execution = value as Partial<ProviderExecution>;
  const validWorkdir = execution.workdir === undefined || (
    typeof execution.workdir === "string"
    && execution.workdir.length > 0
    && execution.workdir.length <= MAX_EXECUTION_PLAN_WORKDIR_CHARACTERS
  );
  return (
    ["read-only", "write", "full"].includes(String(execution.permission))
    && (execution.executionMode === undefined
      || execution.executionMode === "isolated" && execution.permission !== "full"
      || execution.executionMode === "local-full-access" && execution.permission === "full")
    && validWorkdir
    && (execution.permission === "read-only" || execution.workdir !== undefined)
    && Array.isArray(execution.skills)
    && execution.skills.length <= MAX_EXECUTION_PLAN_SKILLS
    && execution.skills.every((skill) =>
      typeof skill === "string"
      && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/.test(skill)
    )
    && (execution.skillMode === undefined || execution.skillMode === "all")
    && (execution.research === undefined || typeof execution.research === "boolean")
    && (execution.webSearch === undefined || typeof execution.webSearch === "boolean")
  );
}

function isExecutionPlanIntent(value: unknown): value is ExecutionPlanIntent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const plan = value as Partial<ResolvedExecutionPlan>;
  return (
    (plan.version === 1 || plan.version === 2)
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
    && (plan.workdir === undefined || (
      typeof plan.workdir === "string"
      && plan.workdir.length > 0
      && plan.workdir.length <= MAX_EXECUTION_PLAN_WORKDIR_CHARACTERS
    ))
    && (plan.skillMode === undefined || plan.skillMode === "all")
    && (plan.execution === undefined || isProviderExecution(plan.execution))
    && (plan.resolutionError === undefined || (
      typeof plan.resolutionError === "string"
      && plan.resolutionError.length <= MAX_EXECUTION_PLAN_ERROR_CHARACTERS
    ))
  );
}

export function isResolvedExecutionPlan(value: unknown): value is ResolvedExecutionPlan {
  if (!isExecutionPlanIntent(value)) return false;
  const plan = value as ResolvedExecutionPlan;
  if (plan.archiveVersion !== undefined || (plan.execution?.executionMode !== undefined && plan.provider !== "codex")) return false;
  if (plan.version === 1) return plan.localExecution === undefined;
  if (!Object.keys(plan).every(key => [...intentKeys, "localExecution"].includes(key))) return false;
  if (plan.execution?.executionMode !== "local-full-access") {
    return plan.localExecution === undefined
      && (!(plan.provider === "codex" && plan.execution?.permission === "full")
        || plan.resolutionError === LEGACY_CODEX_FULL_RECONFIRMATION);
  }
  return plan.provider === "codex" && isAgentRevisionId(plan.agentRevisionId)
    && !!plan.workdir && plan.workdir === plan.execution.workdir
    && (isLocalExecutionReference(plan.localExecution)
      || plan.localExecution === undefined && plan.resolutionError === LOCAL_EXECUTION_NOT_CONFIRMED);
}

const intentKeys = ["version", "agentRevisionId", "instruction", "provider", "model", "reasoningEffort", "workdir", "skillMode", "execution", "resolutionError"];

export function isArchivedExecutionPlan(value: unknown): value is ArchivedExecutionPlan {
  if (!isExecutionPlanIntent(value)) return false;
  const plan = value as ArchivedExecutionPlan;
  return plan.version === 2 && plan.archiveVersion === 1 && plan.localExecution === undefined
    && Object.keys(plan).every(key => [...intentKeys, "archiveVersion"].includes(key))
    && (plan.execution?.executionMode === undefined || plan.provider === "codex");
}

export function isStoredExecutionPlan(value: unknown): value is StoredExecutionPlan {
  return isResolvedExecutionPlan(value) || isArchivedExecutionPlan(value);
}

export function cloneResolvedExecutionPlan(
  plan: ResolvedExecutionPlan,
): ResolvedExecutionPlan {
  return { ...cloneExecutionPlanIntent(plan), ...(plan.localExecution === undefined ? {} : { localExecution: structuredClone(plan.localExecution) }) };
}

export function cloneStoredExecutionPlan(plan: StoredExecutionPlan): StoredExecutionPlan {
  return plan.archiveVersion === 1
    ? { ...cloneExecutionPlanIntent(plan), version: 2, archiveVersion: 1 }
    : cloneResolvedExecutionPlan(plan);
}

export function archiveExecutionPlan(plan: StoredExecutionPlan): StoredExecutionPlan {
  // Legacy fingerprints and historical approval meaning remain unchanged.
  return plan.version === 1 ? cloneResolvedExecutionPlan(plan)
    : { ...cloneExecutionPlanIntent(plan), version: 2, archiveVersion: 1 };
}

function cloneExecutionPlanIntent(plan: ExecutionPlanIntent): ExecutionPlanIntent {
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
    ...(plan.workdir === undefined ? {} : { workdir: plan.workdir }),
    ...(plan.skillMode === undefined ? {} : { skillMode: plan.skillMode }),
    ...(plan.execution === undefined
      ? {}
      : {
          execution: {
            permission: plan.execution.permission,
            ...(plan.execution.executionMode === undefined ? {} : { executionMode: plan.execution.executionMode }),
            ...(plan.execution.workdir === undefined ? {} : { workdir: plan.execution.workdir }),
            ...(plan.execution.skillMode === undefined ? {} : { skillMode: plan.execution.skillMode }),
            ...(plan.execution.research === undefined ? {} : { research: plan.execution.research }),
            ...(plan.execution.webSearch === undefined ? {} : { webSearch: plan.execution.webSearch }),
            skills: [...plan.execution.skills],
          },
        }),
    ...(plan.resolutionError === undefined
      ? {}
      : { resolutionError: plan.resolutionError }),
  };
}
