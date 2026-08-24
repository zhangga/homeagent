/**
 * Durable action-boundary continuation for WorkItems.
 *
 * A WorkAction snapshots one user-visible next action before execution. The
 * snapshot is the idempotency anchor across scheduler ticks and restarts: as
 * long as it is active, another action cannot be claimed for the same item.
 */
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { isSpaceId, type SpaceId } from "@homeagent/shared";
import { durableFsyncSync, durableRenameSync } from "./durable-file.ts";
import type { WorkItem } from "./work-items.ts";

export type WorkActionStatus =
  | "queued"
  | "awaiting_approval"
  | "running"
  | "awaiting_acceptance"
  | "succeeded"
  | "blocked"
  | "cancelled";

export type WorkActionPermission = "read-only" | "write" | "full" | "unknown";
export type WorkActionAcceptanceStatus = "pending" | "accepted" | "rejected";
export type WorkActionAcceptanceMode = "automatic" | "human";

export interface WorkActionExecutionCheck {
  name: string;
  status: "passed" | "failed" | "not_run";
  detail?: string;
}

export interface WorkActionEvidence {
  kind: "task_run" | "raw" | "page";
  id: string;
  description?: string;
}

export interface WorkActionExecutionReport {
  version: 1;
  outcome: "completed" | "blocked" | "unverified";
  result: string;
  blockers: string[];
  checks: WorkActionExecutionCheck[];
  evidence: WorkActionEvidence[];
}

export interface WorkActionProviderReport {
  version: 1;
  outcome: "completed" | "blocked";
  result: string;
  blockers: string[];
  checks: WorkActionExecutionCheck[];
}

export interface WorkActionAcceptance {
  taskRunId: string;
  attempt: number;
  permission: WorkActionPermission;
  status: WorkActionAcceptanceStatus;
  requestedAt: number;
  summary: string;
  rawId?: string;
  report: WorkActionExecutionReport;
  decidedAt?: number;
  decidedBy?: string;
  mode?: WorkActionAcceptanceMode;
  reason?: string;
}

export interface WorkActionCheckpoint {
  completedAt: number;
  summary: string;
  rawId?: string;
  taskRunId?: string;
}

export interface WorkAction {
  id: string;
  workItemId: string;
  space: SpaceId;
  instruction: string;
  status: WorkActionStatus;
  attempt: number;
  taskRunIds: string[];
  /** Bounded post-execution acceptance audit, retained across retries. */
  acceptances?: WorkActionAcceptance[];
  checkpoint?: WorkActionCheckpoint;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface WorkContinuationPolicy {
  workItemId: string;
  space: SpaceId;
  autoContinue: boolean;
  updatedAt: number;
}

export interface WorkContinuationPolicyUpdate {
  autoContinue: boolean;
}

export interface WorkContinuationArchive {
  actions: WorkAction[];
  policies: WorkContinuationPolicy[];
}

export interface FinishWorkActionInput {
  runId: string;
  rawId?: string;
  finishedAt: number;
}

export interface SubmitWorkActionAcceptanceInput extends FinishWorkActionInput {
  permission: WorkActionPermission;
  summary: string;
  outputTruncated?: boolean;
  report?: WorkActionProviderReport;
}

export interface DecideWorkActionAcceptanceInput {
  runId: string;
  decidedAt: number;
  decidedBy: string;
  mode: WorkActionAcceptanceMode;
  reason?: string;
}

interface WorkContinuationFile {
  version: 1;
  actions: Record<string, WorkAction>;
  policies?: Record<string, WorkContinuationPolicy>;
}

const ACTIVE_STATUSES = new Set<WorkActionStatus>([
  "queued",
  "awaiting_approval",
  "running",
  "awaiting_acceptance",
]);
const EXECUTING_STATUSES = new Set<WorkActionStatus>([
  "queued",
  "awaiting_approval",
  "running",
]);
const ACTION_ID_RE = /^action_[0-9a-f-]{36}$/i;
const WORK_ITEM_ID_RE = /^work_[0-9a-f-]{36}$/i;
const MAX_INSTRUCTION_CHARACTERS = 20_000;
export const MAX_WORK_ACTION_RUNS = 100;
const MAX_REPORT_ENTRIES = 50;
const MAX_REPORT_LABEL_CHARACTERS = 300;

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isCheckpoint(value: unknown): value is WorkActionCheckpoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const checkpoint = value as Partial<WorkActionCheckpoint>;
  return finite(checkpoint.completedAt)
    && typeof checkpoint.summary === "string"
    && checkpoint.summary.length <= MAX_INSTRUCTION_CHARACTERS
    && (checkpoint.rawId === undefined || typeof checkpoint.rawId === "string")
    && (checkpoint.taskRunId === undefined || typeof checkpoint.taskRunId === "string");
}

function isExecutionReport(value: unknown): value is WorkActionExecutionReport {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const report = value as Partial<WorkActionExecutionReport>;
  return report.version === 1
    && ["completed", "blocked", "unverified"].includes(String(report.outcome))
    && typeof report.result === "string"
    && report.result.length > 0
    && report.result.length <= MAX_INSTRUCTION_CHARACTERS
    && Array.isArray(report.blockers)
    && report.blockers.length <= MAX_REPORT_ENTRIES
    && report.blockers.every((blocker) => (
      typeof blocker === "string"
      && blocker.length > 0
      && blocker.length <= MAX_INSTRUCTION_CHARACTERS
    ))
    && (report.outcome === "blocked"
      ? report.blockers.length > 0
      : report.blockers.length === 0)
    && Array.isArray(report.checks)
    && report.checks.length > 0
    && report.checks.length <= MAX_REPORT_ENTRIES
    && report.checks.every((check) => (
      check !== null
      && typeof check === "object"
      && !Array.isArray(check)
      && typeof check.name === "string"
      && check.name.length > 0
      && check.name.length <= MAX_REPORT_LABEL_CHARACTERS
      && ["passed", "failed", "not_run"].includes(check.status)
      && (check.detail === undefined || (
        typeof check.detail === "string"
        && check.detail.length <= MAX_INSTRUCTION_CHARACTERS
      ))
    ))
    && Array.isArray(report.evidence)
    && report.evidence.length > 0
    && report.evidence.length <= MAX_REPORT_ENTRIES
    && report.evidence.every((evidence) => (
      evidence !== null
      && typeof evidence === "object"
      && !Array.isArray(evidence)
      && ["task_run", "raw", "page"].includes(evidence.kind)
      && typeof evidence.id === "string"
      && evidence.id.length > 0
      && evidence.id.length <= MAX_INSTRUCTION_CHARACTERS
      && (evidence.description === undefined || (
        typeof evidence.description === "string"
        && evidence.description.length <= MAX_INSTRUCTION_CHARACTERS
      ))
    ));
}

export function parseWorkActionProviderReport(
  output: string,
): WorkActionProviderReport | undefined {
  if (!output.trim() || output.length > MAX_INSTRUCTION_CHARACTERS * 2) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const report = value as Partial<WorkActionProviderReport>;
  if (
    report.version !== 1
    || (report.outcome !== "completed" && report.outcome !== "blocked")
    || typeof report.result !== "string"
    || !report.result.trim()
    || report.result.trim().length > MAX_INSTRUCTION_CHARACTERS
    || !Array.isArray(report.blockers)
    || report.blockers.length > MAX_REPORT_ENTRIES
    || !report.blockers.every((blocker) => (
      typeof blocker === "string"
      && blocker.trim().length > 0
      && blocker.trim().length <= MAX_INSTRUCTION_CHARACTERS
    ))
    || (report.outcome === "completed"
      ? report.blockers.length !== 0
      : report.blockers.length === 0)
    || !Array.isArray(report.checks)
    || report.checks.length === 0
    || report.checks.length > MAX_REPORT_ENTRIES - 4
    || !report.checks.every((check) => (
      check !== null
      && typeof check === "object"
      && !Array.isArray(check)
      && typeof check.name === "string"
      && check.name.trim().length > 0
      && check.name.trim().length <= MAX_REPORT_LABEL_CHARACTERS
      && ["passed", "failed", "not_run"].includes(check.status)
      && (check.detail === undefined || (
        typeof check.detail === "string"
        && check.detail.trim().length <= MAX_INSTRUCTION_CHARACTERS
      ))
    ))
  ) return undefined;
  return {
    version: 1,
    outcome: report.outcome,
    result: report.result.trim(),
    blockers: report.blockers.map((blocker) => blocker.trim()),
    checks: report.checks.map((check) => ({
      name: check.name.trim(),
      status: check.status,
      detail: check.detail?.trim() || undefined,
    })),
  };
}

function isAcceptance(value: unknown): value is WorkActionAcceptance {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const acceptance = value as Partial<WorkActionAcceptance>;
  const baseValid = typeof acceptance.taskRunId === "string"
    && acceptance.taskRunId.length > 0
    && typeof acceptance.attempt === "number"
    && Number.isInteger(acceptance.attempt)
    && acceptance.attempt >= 1
    && ["read-only", "write", "full", "unknown"].includes(String(acceptance.permission))
    && ["pending", "accepted", "rejected"].includes(String(acceptance.status))
    && finite(acceptance.requestedAt)
    && typeof acceptance.summary === "string"
    && acceptance.summary.length > 0
    && acceptance.summary.length <= MAX_INSTRUCTION_CHARACTERS
    && (acceptance.rawId === undefined || (
      typeof acceptance.rawId === "string" && acceptance.rawId.length > 0
    ))
    && isExecutionReport(acceptance.report)
    && acceptance.report.result === acceptance.summary
    && acceptance.report.evidence.some((evidence) => (
      evidence.kind === "task_run" && evidence.id === acceptance.taskRunId
    ))
    && (acceptance.rawId === undefined || acceptance.report.evidence.some((evidence) => (
      evidence.kind === "raw" && evidence.id === acceptance.rawId
    )))
    && (acceptance.decidedAt === undefined || finite(acceptance.decidedAt))
    && (acceptance.decidedBy === undefined || (
      typeof acceptance.decidedBy === "string" && acceptance.decidedBy.length <= 200
    ))
    && (acceptance.mode === undefined || ["automatic", "human"].includes(acceptance.mode))
    && (acceptance.reason === undefined || (
      typeof acceptance.reason === "string"
      && acceptance.reason.length <= MAX_INSTRUCTION_CHARACTERS
    ));
  if (!baseValid) return false;
  if (acceptance.status === "pending") {
    return acceptance.decidedAt === undefined
      && acceptance.decidedBy === undefined
      && acceptance.mode === undefined
      && acceptance.reason === undefined;
  }
  if (
    !finite(acceptance.decidedAt)
    || acceptance.decidedAt < acceptance.requestedAt!
    || typeof acceptance.decidedBy !== "string"
    || acceptance.decidedBy.trim().length === 0
    || !["automatic", "human"].includes(acceptance.mode!)
  ) return false;
  if (acceptance.status === "rejected") {
    return typeof acceptance.reason === "string" && acceptance.reason.trim().length > 0;
  }
  if (acceptance.report!.outcome === "blocked") return false;
  if (
    acceptance.mode === "automatic"
    && (
      acceptance.permission !== "read-only"
      || !acceptance.rawId
      || acceptance.report!.outcome !== "completed"
      || acceptance.report!.checks.some((check) => check.status !== "passed")
    )
  ) return false;
  return true;
}

export function isWorkAction(value: unknown): value is WorkAction {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const action = value as Partial<WorkAction>;
  const baseValid = typeof action.id === "string" && ACTION_ID_RE.test(action.id)
    && typeof action.workItemId === "string" && WORK_ITEM_ID_RE.test(action.workItemId)
    && typeof action.space === "string" && isSpaceId(action.space)
    && typeof action.instruction === "string"
    && action.instruction.length > 0
    && action.instruction.length <= MAX_INSTRUCTION_CHARACTERS
    && typeof action.status === "string"
    && ["queued", "awaiting_approval", "running", "awaiting_acceptance", "succeeded", "blocked", "cancelled"]
      .includes(action.status)
    && typeof action.attempt === "number"
    && Number.isInteger(action.attempt)
    && action.attempt >= 1
    && Array.isArray(action.taskRunIds)
    && action.taskRunIds.length <= MAX_WORK_ACTION_RUNS
    && action.taskRunIds.every((id) => typeof id === "string" && id.length > 0)
    && new Set(action.taskRunIds).size === action.taskRunIds.length
    && (action.acceptances === undefined || (
      Array.isArray(action.acceptances)
      && action.acceptances.length <= MAX_WORK_ACTION_RUNS
      && action.acceptances.every(isAcceptance)
      && action.acceptances.every((acceptance) => (
        action.taskRunIds!.indexOf(acceptance.taskRunId) + 1 === acceptance.attempt
        && acceptance.attempt <= action.attempt!
      ))
      && new Set(action.acceptances.map((acceptance) => acceptance.taskRunId)).size
        === action.acceptances.length
    ))
    && (action.checkpoint === undefined || isCheckpoint(action.checkpoint))
    && (action.error === undefined || (
      typeof action.error === "string" && action.error.length <= MAX_INSTRUCTION_CHARACTERS
    ))
    && finite(action.createdAt)
    && finite(action.updatedAt);
  if (!baseValid) return false;
  const acceptances = action.acceptances ?? [];
  const latest = acceptances.at(-1);
  const latestRunId = action.taskRunIds!.at(-1);
  const acceptedCount = acceptances.filter(
    (acceptance) => acceptance.status === "accepted",
  ).length;
  if (action.status === "succeeded") {
    return acceptedCount === 1
      && latest?.status === "accepted"
      && latest.attempt === action.attempt
      && latest.taskRunId === latestRunId
      && action.checkpoint !== undefined
      && action.checkpoint.taskRunId === latest.taskRunId
      && action.checkpoint.summary === latest.summary
      && action.checkpoint.rawId === latest.rawId
      && action.checkpoint.completedAt === latest.decidedAt;
  }
  if (acceptedCount !== 0) return false;
  if (action.checkpoint !== undefined) return false;
  if (action.status === "awaiting_acceptance") {
    return latest?.status === "pending"
      && latest.attempt === action.attempt
      && latest.taskRunId === latestRunId
      && action.checkpoint === undefined;
  }
  if (latest && latest.attempt === action.attempt && latest.taskRunId === latestRunId) {
    if (latest.status === "pending") return false;
    if (latest.status === "accepted") return false;
    if (latest.status === "rejected") {
      return (action.status === "blocked" || action.status === "cancelled")
        && action.checkpoint === undefined;
    }
  }
  return true;
}

export function isWorkContinuationPolicy(value: unknown): value is WorkContinuationPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const policy = value as Partial<WorkContinuationPolicy>;
  return typeof policy.workItemId === "string" && WORK_ITEM_ID_RE.test(policy.workItemId)
    && typeof policy.space === "string" && isSpaceId(policy.space)
    && typeof policy.autoContinue === "boolean"
    && finite(policy.updatedAt);
}

function clone(action: WorkAction): WorkAction {
  return {
    ...action,
    taskRunIds: [...action.taskRunIds],
    acceptances: action.acceptances?.map((acceptance) => ({
      ...acceptance,
      report: {
        ...acceptance.report,
        blockers: [...acceptance.report.blockers],
        checks: acceptance.report.checks.map((check) => ({ ...check })),
        evidence: acceptance.report.evidence.map((evidence) => ({ ...evidence })),
      },
    })),
    checkpoint: action.checkpoint ? { ...action.checkpoint } : undefined,
  };
}

function atomicWrite(path: string, content: string): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
    const fileDescriptor = openSync(temporaryPath, "r+");
    try {
      durableFsyncSync(fileDescriptor);
    } finally {
      closeSync(fileDescriptor);
    }
    durableRenameSync(temporaryPath, path);
    const directoryDescriptor = openSync(directory, "r");
    try {
      durableFsyncSync(directoryDescriptor, { allowUnsupportedDirectoryOnWindows: true });
    } finally {
      closeSync(directoryDescriptor);
    }
  } finally {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
}

export class WorkContinuationStore {
  private readonly configPath: string;
  private readonly loadError?: string;
  private actions: Map<string, WorkAction>;
  private policies: Map<string, WorkContinuationPolicy>;

  constructor(dataDir: string) {
    this.configPath = join(dataDir, "config", "work-continuation.json");
    const loaded = this.load();
    this.actions = loaded.actions;
    this.policies = loaded.policies;
    this.loadError = loaded.error;
  }

  private load(): {
    actions: Map<string, WorkAction>;
    policies: Map<string, WorkContinuationPolicy>;
    error?: string;
  } {
    const actions = new Map<string, WorkAction>();
    const policies = new Map<string, WorkContinuationPolicy>();
    if (!existsSync(this.configPath)) return { actions, policies };
    try {
      const parsed = JSON.parse(readFileSync(this.configPath, "utf8")) as Partial<WorkContinuationFile>;
      if (
        parsed.version !== 1
        || !parsed.actions
        || typeof parsed.actions !== "object"
        || Array.isArray(parsed.actions)
        || (parsed.policies !== undefined && (
          typeof parsed.policies !== "object" || Array.isArray(parsed.policies)
        ))
      ) throw new Error("invalid work continuation file");
      for (const [id, action] of Object.entries(parsed.actions ?? {})) {
        if (!isWorkAction(action) || action.id !== id) {
          throw new Error("invalid work action");
        }
        actions.set(id, clone(action));
      }
      for (const [workItemId, policy] of Object.entries(parsed.policies ?? {})) {
        if (!isWorkContinuationPolicy(policy) || policy.workItemId !== workItemId) {
          throw new Error("invalid work continuation policy");
        }
        policies.set(workItemId, { ...policy });
      }
    } catch {
      return {
        actions: new Map(),
        policies: new Map(),
        error: "work continuation persisted state is invalid",
      };
    }
    return { actions, policies };
  }

  private assertHealthy(): void {
    if (this.loadError) throw new Error(this.loadError);
  }

  private persist(
    actions = this.actions,
    policies = this.policies,
  ): void {
    const file: WorkContinuationFile = {
      version: 1,
      actions: Object.fromEntries([...actions].map(([id, action]) => [id, clone(action)])),
      policies: Object.fromEntries(
        [...policies].map(([id, policy]) => [id, { ...policy }]),
      ),
    };
    atomicWrite(this.configPath, `${JSON.stringify(file, null, 2)}\n`);
  }

  private commit<T>(change: (candidate: Map<string, WorkAction>) => T): T {
    const candidate = new Map(
      [...this.actions].map(([id, action]) => [id, clone(action)]),
    );
    const result = change(candidate);
    for (const [id, action] of candidate) {
      if (action.id !== id || !isWorkAction(action)) {
        throw new Error("work action mutation produced invalid state");
      }
    }
    this.persist(candidate);
    this.actions = candidate;
    return result;
  }

  private commitPolicies<T>(
    change: (candidate: Map<string, WorkContinuationPolicy>) => T,
  ): T {
    const candidate = new Map(
      [...this.policies].map(([id, policy]) => [id, { ...policy }]),
    );
    const result = change(candidate);
    this.persist(this.actions, candidate);
    this.policies = candidate;
    return result;
  }

  policyFor(workItemId: string, space: SpaceId): WorkContinuationPolicy {
    const policy = this.policies.get(workItemId);
    return policy
      ? { ...policy }
      : { workItemId, space, autoContinue: false, updatedAt: 0 };
  }

  listPolicies(space?: SpaceId): WorkContinuationPolicy[] {
    return [...this.policies.values()]
      .filter((policy) => space === undefined || policy.space === space)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map((policy) => ({ ...policy }));
  }

  configure(
    item: Pick<WorkItem, "id" | "space">,
    update: WorkContinuationPolicyUpdate,
    now = Date.now(),
  ): WorkContinuationPolicy {
    this.assertHealthy();
    const policy: WorkContinuationPolicy = {
      workItemId: item.id,
      space: item.space,
      autoContinue: update.autoContinue,
      updatedAt: now,
    };
    return this.commitPolicies((candidate) => {
      candidate.set(item.id, { ...policy });
      return { ...policy };
    });
  }

  list(workItemId?: string): WorkAction[] {
    return [...this.actions.values()]
      .filter((action) => workItemId === undefined || action.workItemId === workItemId)
      .sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id))
      .map(clone);
  }

  get(id: string): WorkAction | undefined {
    const action = this.actions.get(id);
    return action ? clone(action) : undefined;
  }

  activeForWorkItem(workItemId: string): WorkAction | undefined {
    const action = [...this.actions.values()].find(
      (candidate) => candidate.workItemId === workItemId && ACTIVE_STATUSES.has(candidate.status),
    );
    return action ? clone(action) : undefined;
  }

  claimNext(item: WorkItem, now = Date.now()): WorkAction {
    this.assertHealthy();
    const active = this.activeForWorkItem(item.id);
    if (active) return active;
    if (!item.active || item.phase === "completed") {
      throw new Error("work item is not active");
    }
    if (item.phase === "blocked" || item.blockers.length > 0) {
      throw new Error("work item is blocked");
    }
    const instruction = item.nextActions[0]?.trim();
    if (!instruction) throw new Error("work item has no next action");
    const latest = [...this.actions.values()]
      .filter((action) => action.workItemId === item.id)
      .sort((left, right) => (
        right.createdAt - left.createdAt || right.id.localeCompare(left.id)
      ))[0];
    if (
      latest?.instruction === instruction
      && (latest.status === "blocked" || latest.status === "cancelled")
    ) {
      throw new Error(`work action requires retry: ${latest.id}`);
    }
    if (instruction.length > MAX_INSTRUCTION_CHARACTERS) {
      throw new Error("work action instruction is too large");
    }
    const action: WorkAction = {
      id: `action_${randomUUID()}`,
      workItemId: item.id,
      space: item.space,
      instruction,
      status: "queued",
      attempt: 1,
      taskRunIds: [],
      acceptances: [],
      createdAt: now,
      updatedAt: now,
    };
    return this.commit((candidate) => {
      const concurrent = [...candidate.values()].find(
        (entry) => entry.workItemId === item.id && ACTIVE_STATUSES.has(entry.status),
      );
      if (concurrent) return clone(concurrent);
      candidate.set(action.id, clone(action));
      return clone(action);
    });
  }

  attachRun(
    id: string,
    runId: string,
    status: "queued" | "awaiting_approval",
    now = Date.now(),
  ): WorkAction {
    this.assertHealthy();
    const normalizedRunId = runId.trim();
    if (!normalizedRunId) throw new Error("work action run id is required");
    if (!this.actions.has(id)) throw new Error(`work action not found: ${id}`);
    return this.commit((candidate) => {
      const action = candidate.get(id)!;
      if (!EXECUTING_STATUSES.has(action.status)) {
        throw new Error(`work action is terminal: ${id}`);
      }
      if (!action.taskRunIds.includes(normalizedRunId)) {
        if (action.taskRunIds.length >= MAX_WORK_ACTION_RUNS) {
          throw new Error("work action has too many runs");
        }
        action.taskRunIds.push(normalizedRunId);
      }
      // A Task Run may have been durably created just before the process
      // stopped, while the cross-store attempt update had not yet landed.
      // The associated Run count is the durable source of truth once linked.
      action.attempt = Math.max(action.attempt, action.taskRunIds.length);
      action.status = status;
      action.updatedAt = now;
      return clone(action);
    });
  }

  /**
   * Append recovered TaskRun history without reopening the action or rewriting
   * its audit order. Existing run ids and acceptance attempt numbers are the
   * durable authority; recovery may only add previously missing later runs.
   */
  reconcileRunHistory(
    id: string,
    orderedRunIds: string[],
    now = Date.now(),
  ): WorkAction {
    this.assertHealthy();
    if (!finite(now)) throw new Error("work action reconciliation time is invalid");
    const normalized = orderedRunIds.map((runId) => runId.trim());
    if (normalized.some((runId) => !runId)) {
      throw new Error("work action run id is required");
    }
    if (new Set(normalized).size !== normalized.length) {
      throw new Error("work action run history contains duplicates");
    }
    if (normalized.length > MAX_WORK_ACTION_RUNS) {
      throw new Error("work action has too many runs");
    }
    const existing = this.actions.get(id);
    if (!existing) throw new Error(`work action not found: ${id}`);
    if (existing.taskRunIds.some((runId) => !normalized.includes(runId))) {
      throw new Error("work action reconciliation cannot discard run history");
    }
    if (existing.taskRunIds.some((runId, index) => normalized[index] !== runId)) {
      throw new Error("work action reconciliation cannot reorder or insert into run history");
    }
    const recoveredRunIds = normalized.slice(existing.taskRunIds.length);
    if (recoveredRunIds.length === 0) return clone(existing);
    return this.commit((candidate) => {
      const action = candidate.get(id)!;
      action.taskRunIds = [...action.taskRunIds, ...recoveredRunIds];
      action.attempt = Math.max(action.attempt, action.taskRunIds.length);
      return clone(action);
    });
  }

  markRunning(id: string, runId: string, now = Date.now()): WorkAction {
    this.assertHealthy();
    if (!this.actions.has(id)) throw new Error(`work action not found: ${id}`);
    return this.commit((candidate) => {
      const action = candidate.get(id)!;
      if (!action.taskRunIds.includes(runId)) {
        throw new Error(`run does not belong to work action: ${runId}`);
      }
      if (!EXECUTING_STATUSES.has(action.status)) {
        throw new Error(`work action is terminal: ${id}`);
      }
      action.status = "running";
      action.updatedAt = now;
      return clone(action);
    });
  }

  submitForAcceptance(
    id: string,
    input: SubmitWorkActionAcceptanceInput,
  ): WorkAction {
    this.assertHealthy();
    const summary = input.summary.trim();
    if (!summary) throw new Error("work action acceptance summary is required");
    if (summary.length > MAX_INSTRUCTION_CHARACTERS) {
      throw new Error("work action acceptance summary is too large");
    }
    if (!["read-only", "write", "full", "unknown"].includes(input.permission)) {
      throw new Error("work action acceptance permission is invalid");
    }
    if (!finite(input.finishedAt)) throw new Error("work action finish time is invalid");
    let providerReport: WorkActionProviderReport | undefined;
    if (input.report !== undefined) {
      try {
        providerReport = parseWorkActionProviderReport(JSON.stringify(input.report));
      } catch {
        providerReport = undefined;
      }
      if (!providerReport || providerReport.result !== summary) {
        throw new Error("work action provider report is invalid");
      }
    }
    const existing = this.actions.get(id);
    if (!existing) throw new Error(`work action not found: ${id}`);
    const previous = existing.acceptances?.find(
      (acceptance) => acceptance.taskRunId === input.runId,
    );
    if (previous) return clone(existing);
    return this.commit((candidate) => {
      const action = candidate.get(id)!;
      if (!action.taskRunIds.includes(input.runId)) {
        throw new Error(`run does not belong to work action: ${input.runId}`);
      }
      if (!["queued", "awaiting_approval", "running"].includes(action.status)) {
        throw new Error(`work action cannot request acceptance: ${id}`);
      }
      action.acceptances ??= [];
      if (action.acceptances.length >= MAX_WORK_ACTION_RUNS) {
        throw new Error("work action has too many acceptance records");
      }
      action.acceptances.push({
        taskRunId: input.runId,
        attempt: action.attempt,
        permission: input.permission,
        status: "pending",
        requestedAt: input.finishedAt,
        summary,
        rawId: input.rawId,
        report: {
          version: 1,
          outcome: providerReport?.outcome ?? "unverified",
          result: summary,
          blockers: providerReport?.blockers ?? [],
          checks: [
            {
              name: "结构化执行报告",
              status: providerReport ? "passed" : "failed",
              detail: providerReport
                ? undefined
                : "Provider 未返回可校验的 WorkAction JSON 报告，禁止自动验收",
            },
            ...(providerReport?.checks ?? []),
            { name: "Task Run 成功结束", status: "passed" },
            {
              name: "执行输出已归档",
              status: input.rawId ? "passed" : "failed",
            },
            {
              name: "执行输出未截断",
              status: input.outputTruncated ? "failed" : "passed",
            },
          ],
          evidence: [
            { kind: "task_run", id: input.runId },
            ...(input.rawId ? [{ kind: "raw" as const, id: input.rawId }] : []),
          ],
        },
      });
      action.status = "awaiting_acceptance";
      action.error = undefined;
      action.checkpoint = undefined;
      action.updatedAt = input.finishedAt;
      return clone(action);
    });
  }

  accept(
    id: string,
    input: DecideWorkActionAcceptanceInput,
  ): WorkAction {
    this.assertHealthy();
    const decidedBy = input.decidedBy.trim();
    if (!decidedBy) throw new Error("work action acceptance actor is required");
    if (decidedBy.length > 200) throw new Error("work action acceptance actor is too large");
    if (!finite(input.decidedAt)) throw new Error("work action acceptance time is invalid");
    if (!["automatic", "human"].includes(input.mode)) {
      throw new Error("work action acceptance mode is invalid");
    }
    if ((input.reason?.length ?? 0) > MAX_INSTRUCTION_CHARACTERS) {
      throw new Error("work action acceptance note is too large");
    }
    const existing = this.actions.get(id);
    if (!existing) throw new Error(`work action not found: ${id}`);
    const current = existing.acceptances?.at(-1);
    if (current?.report.outcome === "blocked") {
      throw new Error("blocked work action result cannot be accepted");
    }
    if (
      input.mode === "automatic"
      && current
      && (
        current.permission !== "read-only"
        || !current.rawId
        || current.report.outcome !== "completed"
        || current.report.checks.some((check) => check.status !== "passed")
      )
    ) {
      throw new Error("work action automatic acceptance is unsafe");
    }
    if (
      existing.status === "succeeded"
      && current?.taskRunId === input.runId
      && current.status === "accepted"
    ) {
      return clone(existing);
    }
    return this.commit((candidate) => {
      const action = candidate.get(id)!;
      const acceptance = action.acceptances?.at(-1);
      if (!acceptance || acceptance.taskRunId !== input.runId) {
        throw new Error(`run is not the current work action acceptance candidate: ${input.runId}`);
      }
      if (action.status !== "awaiting_acceptance" || acceptance.status !== "pending") {
        throw new Error(`work action is not awaiting acceptance: ${id}`);
      }
      if (input.decidedAt < acceptance.requestedAt) {
        throw new Error("work action acceptance time predates the result");
      }
      acceptance.status = "accepted";
      acceptance.decidedAt = input.decidedAt;
      acceptance.decidedBy = decidedBy;
      acceptance.mode = input.mode;
      acceptance.reason = input.reason?.trim() || undefined;
      action.status = "succeeded";
      action.error = undefined;
      action.checkpoint = {
        completedAt: input.decidedAt,
        summary: acceptance.summary,
        rawId: acceptance.rawId,
        taskRunId: acceptance.taskRunId,
      };
      action.updatedAt = input.decidedAt;
      return clone(action);
    });
  }

  reject(
    id: string,
    input: DecideWorkActionAcceptanceInput,
  ): WorkAction {
    this.assertHealthy();
    const decidedBy = input.decidedBy.trim();
    const reason = input.reason?.trim() ?? "";
    if (!decidedBy) throw new Error("work action rejection actor is required");
    if (decidedBy.length > 200) throw new Error("work action rejection actor is too large");
    if (!reason) throw new Error("work action rejection reason is required");
    if (reason.length > MAX_INSTRUCTION_CHARACTERS) {
      throw new Error("work action rejection reason is too large");
    }
    if (!finite(input.decidedAt)) throw new Error("work action rejection time is invalid");
    if (!["automatic", "human"].includes(input.mode)) {
      throw new Error("work action rejection mode is invalid");
    }
    const existing = this.actions.get(id);
    if (!existing) throw new Error(`work action not found: ${id}`);
    const current = existing.acceptances?.at(-1);
    if (
      existing.status === "blocked"
      && current?.taskRunId === input.runId
      && current.status === "rejected"
    ) {
      return clone(existing);
    }
    return this.commit((candidate) => {
      const action = candidate.get(id)!;
      const acceptance = action.acceptances?.at(-1);
      if (!acceptance || acceptance.taskRunId !== input.runId) {
        throw new Error(`run is not the current work action acceptance candidate: ${input.runId}`);
      }
      if (action.status !== "awaiting_acceptance" || acceptance.status !== "pending") {
        throw new Error(`work action is not awaiting acceptance: ${id}`);
      }
      if (input.decidedAt < acceptance.requestedAt) {
        throw new Error("work action rejection time predates the result");
      }
      acceptance.status = "rejected";
      acceptance.decidedAt = input.decidedAt;
      acceptance.decidedBy = decidedBy;
      acceptance.mode = input.mode;
      acceptance.reason = reason;
      action.status = "blocked";
      action.error = reason;
      action.checkpoint = undefined;
      action.updatedAt = input.decidedAt;
      return clone(action);
    });
  }

  block(id: string, error: string, input: FinishWorkActionInput): WorkAction {
    this.assertHealthy();
    const normalizedError = error.trim().slice(0, MAX_INSTRUCTION_CHARACTERS);
    if (!normalizedError) throw new Error("work action error is required");
    if (!finite(input.finishedAt)) throw new Error("work action finish time is invalid");
    if (!this.actions.has(id)) throw new Error(`work action not found: ${id}`);
    return this.commit((candidate) => {
      const action = candidate.get(id)!;
      if (!action.taskRunIds.includes(input.runId)) {
        throw new Error(`run does not belong to work action: ${input.runId}`);
      }
      if (!EXECUTING_STATUSES.has(action.status)) {
        if (action.status === "blocked") return clone(action);
        throw new Error(`work action is terminal: ${id}`);
      }
      action.status = "blocked";
      action.error = normalizedError;
      action.checkpoint = undefined;
      action.updatedAt = input.finishedAt;
      return clone(action);
    });
  }

  waitForRetry(id: string, error: string, input: FinishWorkActionInput): WorkAction {
    this.assertHealthy();
    const normalizedError = error.trim().slice(0, MAX_INSTRUCTION_CHARACTERS);
    if (!normalizedError) throw new Error("work action error is required");
    if (!finite(input.finishedAt)) throw new Error("work action finish time is invalid");
    if (!this.actions.has(id)) throw new Error(`work action not found: ${id}`);
    return this.commit((candidate) => {
      const action = candidate.get(id)!;
      if (!action.taskRunIds.includes(input.runId)) {
        throw new Error(`run does not belong to work action: ${input.runId}`);
      }
      if (!EXECUTING_STATUSES.has(action.status)) {
        throw new Error(`work action is terminal: ${id}`);
      }
      action.status = "queued";
      action.error = normalizedError;
      action.checkpoint = undefined;
      action.updatedAt = input.finishedAt;
      return clone(action);
    });
  }

  failClosed(id: string, error: string, now = Date.now()): WorkAction {
    this.assertHealthy();
    const normalizedError = error.trim().slice(0, MAX_INSTRUCTION_CHARACTERS);
    if (!normalizedError) throw new Error("work action recovery error is required");
    if (!finite(now)) throw new Error("work action recovery time is invalid");
    const existing = this.actions.get(id);
    if (!existing) throw new Error(`work action not found: ${id}`);
    if (existing.status === "blocked") return clone(existing);
    if (!ACTIVE_STATUSES.has(existing.status)) {
      throw new Error(`work action is terminal: ${id}`);
    }
    return this.commit((candidate) => {
      const action = candidate.get(id)!;
      if (!ACTIVE_STATUSES.has(action.status)) {
        throw new Error(`work action is terminal: ${id}`);
      }
      const acceptance = action.acceptances?.at(-1);
      if (acceptance?.status === "pending") {
        const decidedAt = Math.max(now, acceptance.requestedAt);
        acceptance.status = "rejected";
        acceptance.decidedAt = decidedAt;
        acceptance.decidedBy = "homeagent.recovery";
        acceptance.mode = "automatic";
        acceptance.reason = normalizedError;
        now = decidedAt;
      }
      action.status = "blocked";
      action.error = normalizedError;
      action.checkpoint = undefined;
      action.updatedAt = now;
      return clone(action);
    });
  }

  claimAutomaticRetry(id: string, now = Date.now()): WorkAction {
    this.assertHealthy();
    const existing = this.actions.get(id);
    if (!existing || existing.status !== "queued" || existing.taskRunIds.length === 0) {
      throw new Error(`work action is not waiting for retry: ${id}`);
    }
    if (existing.taskRunIds.length >= MAX_WORK_ACTION_RUNS) {
      throw new Error("work action has too many runs");
    }
    return this.commit((candidate) => {
      const action = candidate.get(id)!;
      if (action.status !== "queued") {
        throw new Error(`work action is not waiting for retry: ${id}`);
      }
      if (action.taskRunIds.length >= MAX_WORK_ACTION_RUNS) {
        throw new Error("work action has too many runs");
      }
      action.attempt = action.taskRunIds.length + 1;
      action.updatedAt = now;
      return clone(action);
    });
  }

  retry(id: string, now = Date.now()): WorkAction {
    this.assertHealthy();
    const existing = this.actions.get(id);
    if (!existing) throw new Error(`work action not found: ${id}`);
    if (existing.status !== "blocked" && existing.status !== "cancelled") {
      throw new Error(`work action is not retryable: ${id}`);
    }
    if (existing.taskRunIds.length >= MAX_WORK_ACTION_RUNS) {
      throw new Error("work action has too many runs");
    }
    return this.commit((candidate) => {
      const action = candidate.get(id)!;
      if (action.status !== "blocked" && action.status !== "cancelled") {
        throw new Error(`work action is not retryable: ${id}`);
      }
      if (action.taskRunIds.length >= MAX_WORK_ACTION_RUNS) {
        throw new Error("work action has too many runs");
      }
      const concurrent = [...candidate.values()].find((entry) => (
        entry.id !== id
        && entry.workItemId === action.workItemId
        && ACTIVE_STATUSES.has(entry.status)
      ));
      if (concurrent) throw new Error(`work item already has an active action: ${concurrent.id}`);
      action.status = "queued";
      action.attempt = action.taskRunIds.length + 1;
      action.checkpoint = undefined;
      action.error = undefined;
      action.updatedAt = now;
      return clone(action);
    });
  }

  abandon(id: string, now = Date.now()): WorkAction {
    this.assertHealthy();
    if (!finite(now)) throw new Error("work action abandonment time is invalid");
    const existing = this.actions.get(id);
    if (!existing) throw new Error(`work action not found: ${id}`);
    if (existing.status !== "blocked") {
      throw new Error(`work action is not blocked: ${id}`);
    }
    return this.commit((candidate) => {
      const action = candidate.get(id)!;
      if (action.status !== "blocked") {
        throw new Error(`work action is not blocked: ${id}`);
      }
      action.status = "cancelled";
      action.checkpoint = undefined;
      action.updatedAt = now;
      return clone(action);
    });
  }

  cancel(id: string, now = Date.now()): WorkAction | undefined {
    this.assertHealthy();
    const existing = this.actions.get(id);
    if (!existing) return undefined;
    if (existing.status === "cancelled") return clone(existing);
    if (!EXECUTING_STATUSES.has(existing.status)) return undefined;
    return this.commit((candidate) => {
      const action = candidate.get(id)!;
      if (!EXECUTING_STATUSES.has(action.status)) return undefined;
      action.status = "cancelled";
      action.updatedAt = now;
      return clone(action);
    });
  }

  exportBySpace(space: SpaceId): WorkContinuationArchive {
    this.assertHealthy();
    return {
      actions: this.list().filter((action) => action.space === space),
      policies: this.listPolicies(space),
    };
  }

  assertCanRestore(archive: WorkContinuationArchive): void {
    this.assertHealthy();
    const actionIds = new Set<string>();
    for (const action of archive.actions) {
      if (!isWorkAction(action)) throw new Error("archive contains an invalid work action");
      if (actionIds.has(action.id) || this.actions.has(action.id)) {
        throw new Error(`work action already exists: ${action.id}`);
      }
      actionIds.add(action.id);
    }
    const policyIds = new Set<string>();
    for (const policy of archive.policies) {
      if (!isWorkContinuationPolicy(policy)) {
        throw new Error("archive contains an invalid work continuation policy");
      }
      if (policyIds.has(policy.workItemId) || this.policies.has(policy.workItemId)) {
        throw new Error(`work continuation policy already exists: ${policy.workItemId}`);
      }
      policyIds.add(policy.workItemId);
    }
  }

  restore(archive: WorkContinuationArchive): void {
    this.assertHealthy();
    this.assertCanRestore(archive);
    if (archive.actions.length === 0 && archive.policies.length === 0) return;
    const actions = new Map(
      [...this.actions].map(([id, action]) => [id, clone(action)]),
    );
    const policies = new Map(
      [...this.policies].map(([id, policy]) => [id, { ...policy }]),
    );
    for (const action of archive.actions) actions.set(action.id, clone(action));
    for (const policy of archive.policies) policies.set(policy.workItemId, { ...policy });
    this.persist(actions, policies);
    this.actions = actions;
    this.policies = policies;
  }

  removeBySpace(space: SpaceId): WorkContinuationArchive {
    this.assertHealthy();
    const removed = this.exportBySpace(space);
    if (removed.actions.length === 0 && removed.policies.length === 0) return removed;
    const actions = new Map(
      [...this.actions]
        .filter(([, action]) => action.space !== space)
        .map(([id, action]) => [id, clone(action)]),
    );
    const policies = new Map(
      [...this.policies]
        .filter(([, policy]) => policy.space !== space)
        .map(([id, policy]) => [id, { ...policy }]),
    );
    this.persist(actions, policies);
    this.actions = actions;
    this.policies = policies;
    return removed;
  }
}
