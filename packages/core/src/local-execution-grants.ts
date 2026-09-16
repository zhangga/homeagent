import { isSpaceId, type SpaceId } from "@homeagent/shared";
import { isAgentRevisionId, isLocalExecutionGrantId } from "./execution-identities.ts";
export { isLocalExecutionGrantId } from "./execution-identities.ts";

export const LOCAL_EXECUTION_TERMS_VERSION = 1 as const;
export const MAX_LOCAL_EXECUTION_GRANTS_PER_AGENT = 100;
export const MAX_LOCAL_EXECUTION_GRANTS = 10_000;
export const MAX_LOCAL_EXECUTION_SCOPES = 256;
export const MAX_LOCAL_EXECUTION_GRANT_BYTES = 16 * 1024 * 1024;
export type LocalExecutionSource = "local-operator" | "authenticated-admin";
export type LocalExecutionRevocationReason = "operator" | "mode-changed" | "backup-recovery";
export interface LocalExecutionChatScope {
  spaceId: SpaceId;
  policyHash: string;
}

/** Trusted Core publication input, not an HTTP form or a Provider instruction. */
export interface LocalExecutionConfirmation {
  termsVersion: typeof LOCAL_EXECUTION_TERMS_VERSION;
  source: LocalExecutionSource;
  chatScopes: LocalExecutionChatScope[];
  taskExecutionEnabled: boolean;
}
/** Local-only: never embed in an Agent snapshot or a Space archive. */
export interface LocalExecutionGrant extends LocalExecutionConfirmation {
  version: 1;
  id: string;
  agentId: string;
  agentRevisionId: string;
  confirmedAt: number;
  revokedAt?: number;
  revocationReason?: LocalExecutionRevocationReason;
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: string[]): boolean =>
  Object.keys(value).every(key => allowed.includes(key));
const timestamp = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const source = (value: unknown): value is LocalExecutionSource =>
  value === "local-operator" || value === "authenticated-admin";
const confirmationKeys = ["termsVersion", "source", "chatScopes", "taskExecutionEnabled"];

export function isLocalExecutionChatScope(value: unknown): value is LocalExecutionChatScope {
  return record(value) && keys(value, ["spaceId", "policyHash"])
    && typeof value.spaceId === "string" && value.spaceId.length <= 256 && isSpaceId(value.spaceId)
    && typeof value.policyHash === "string" && /^[0-9a-f]{64}$/.test(value.policyHash);
}

/** Normalize fresh confirmation input; persisted records must already be canonical. */
export function normalizeLocalExecutionConfirmation(value: unknown): LocalExecutionConfirmation {
  if (!record(value) || !keys(value, confirmationKeys)
    || value.termsVersion !== LOCAL_EXECUTION_TERMS_VERSION || !source(value.source)
    || typeof value.taskExecutionEnabled !== "boolean" || !Array.isArray(value.chatScopes)
    || value.chatScopes.length > MAX_LOCAL_EXECUTION_SCOPES || !value.chatScopes.every(isLocalExecutionChatScope)) {
    throw new Error("本机完全访问确认无效");
  }
  const scopes = new Map<string, LocalExecutionChatScope>();
  for (const scope of value.chatScopes) {
    const existing = scopes.get(scope.spaceId);
    if (existing && existing.policyHash !== scope.policyHash) throw new Error("本机完全访问确认范围冲突");
    scopes.set(scope.spaceId, { ...scope });
  }
  return {
    termsVersion: value.termsVersion, source: value.source,
    chatScopes: [...scopes.values()].sort((a, b) => a.spaceId < b.spaceId ? -1 : a.spaceId > b.spaceId ? 1 : 0),
    taskExecutionEnabled: value.taskExecutionEnabled,
  };
}

export function isLocalExecutionGrant(value: unknown): value is LocalExecutionGrant {
  if (!record(value) || !keys(value, [...confirmationKeys, "version", "id", "agentId", "agentRevisionId", "confirmedAt", "revokedAt", "revocationReason"])
    || value.version !== 1 || !isLocalExecutionGrantId(value.id)
    || typeof value.agentId !== "string" || !/^[a-zA-Z0-9_-]{1,166}$/.test(value.agentId)
    || !isAgentRevisionId(value.agentRevisionId) || !timestamp(value.confirmedAt)
    || (value.revokedAt !== undefined && (!timestamp(value.revokedAt) || value.revokedAt < value.confirmedAt))
    || (value.revokedAt === undefined ? value.revocationReason !== undefined
      : !["operator", "mode-changed", "backup-recovery"].some(reason => reason === value.revocationReason))) return false;
  try {
    const normalized = normalizeLocalExecutionConfirmation({
      termsVersion: value.termsVersion, source: value.source,
      chatScopes: value.chatScopes, taskExecutionEnabled: value.taskExecutionEnabled,
    });
    return JSON.stringify(normalized.chatScopes) === JSON.stringify(value.chatScopes);
  } catch { return false; }
}

export function cloneLocalExecutionGrant(value: LocalExecutionGrant): LocalExecutionGrant {
  if (!isLocalExecutionGrant(value)) throw new Error("本机完全访问确认无效");
  return structuredClone(value);
}
