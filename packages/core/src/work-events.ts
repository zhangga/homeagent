import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { isSpaceId, type SpaceId } from "@homeagent/shared";
import { assertLocalStatePath, writeAtomicStateFile } from "./durable-file.ts";
import { isWorkPlanRef, type WorkPlanRef } from "./work-plans.ts";
import { isResolvedExecutionPlan, type ResolvedExecutionPlan } from "./execution-plan.ts";
import { parseWorkActionProviderReport, type WorkActionProviderReport } from "./work-continuation.ts";
import type { WorkPlanPreparation } from "./work-plans.ts";

export type WorkRecoveryDecision = { kind: "plan"; reason: string; steps: { instruction: string; doneWhen: string }[] }
  | { kind: "wait"; reason: string; question: string };
export interface WorkRecovery {
  version: 1; kind: "recovery"; id: string; workItemId: string; space: SpaceId; sourceInputId: string;
  actionId: string; attempt: number; runId: string; factKey: string;
  report: WorkActionProviderReport; rejection?: string;
  prepared: WorkPlanPreparation;
  planner: { execution: ResolvedExecutionPlan; agentId?: string; instruction: string; timeoutMs: number; maxTokens: number };
  status: "queued" | "running" | "decided" | "applied" | "waiting" | "failed" | "obsolete";
  decision?: WorkRecoveryDecision;
  createdAt: number;
}

export function parseWorkRecoveryDecision(value: unknown): WorkRecoveryDecision {
  if (!value || typeof value !== "object") throw new Error("Invalid work recovery decision");
  const decision = value as Partial<WorkRecoveryDecision>;
  if (!bounded(decision.reason, 2_000)) throw new Error("Invalid work recovery reason");
  if (decision.kind === "wait" && bounded(decision.question, 2_000)) {
    return { kind: "wait", reason: decision.reason, question: decision.question };
  }
  if (decision.kind !== "plan" || !Array.isArray(decision.steps) || !decision.steps.length || decision.steps.length > 200
    || decision.steps.some(step => !step || !bounded(step.instruction, 1_900) || !bounded(step.doneWhen, 1_900)
      || step.instruction.length + step.doneWhen.length > 1_900)
    || JSON.stringify(decision.steps).length > 190_000) throw new Error("Invalid work recovery steps");
  return { kind: "plan", reason: decision.reason, steps: decision.steps.map(step => ({ instruction: step.instruction, doneWhen: step.doneWhen })) };
}

export interface WorkNotice {
  version: 1;
  id: string;
  workItemId: string;
  space: SpaceId;
  planRef?: WorkPlanRef;
  sourceInputId: string;
  kind: "completion" | "replanned" | "waiting";
  status: "watching" | "pending" | "sent" | "failed" | "cancelled";
  markdown?: string;
  attempts: number;
  nextAttemptAt?: number;
  createdAt: number;
  sentAt?: number;
  messageId?: string;
}

export function workEventId(kind: "notice" | "recovery", values: unknown[]): string {
  return `${kind}_${createHash("sha256").update(JSON.stringify(values)).digest("hex")}`;
}

const bounded = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
const fields = (value: object, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));
function parseRecovery(value: unknown): WorkRecovery {
  if (!value || typeof value !== "object") throw new Error("Invalid work recovery");
  const record = structuredClone(value) as Partial<WorkRecovery>;
  const prepared = record.prepared;
  if (record.version !== 1 || record.kind !== "recovery" || !/^recovery_[a-f0-9]{64}$/.test(record.id ?? "")
    || !/^work_[a-f0-9-]{36}$/i.test(record.workItemId ?? "") || !isSpaceId(record.space ?? "")
    || !/^input_[a-f0-9]{64}$/.test(record.sourceInputId ?? "") || !/^[a-f0-9]{64}$/.test(record.factKey ?? "")
    || !bounded(record.actionId, 200) || !bounded(record.runId, 200)
    || !Number.isSafeInteger(record.attempt) || record.attempt! < 1
    || !record.report || !parseWorkActionProviderReport(JSON.stringify(record.report))
    || (record.rejection !== undefined && !bounded(record.rejection, 2_000))
    || !prepared || prepared.workItemId !== record.workItemId || prepared.space !== record.space
    || !prepared.source || prepared.source.kind !== "recovery" || prepared.source.id !== record.id || prepared.source.actionId !== record.actionId
    || !/^[a-f0-9]{64}$/.test(prepared.fingerprint) || !isWorkPlanRef(prepared.current)
    || typeof prepared.goal !== "string" || prepared.goal.length > 200_000
    || !Array.isArray(prepared.remaining) || prepared.remaining.length > 200
    || prepared.remaining.some(step => !step || !/^step_[a-f0-9]{32}$/.test(step.id) || !bounded(step.instruction, 2_000)
      || (step.legacy ? step.doneWhen !== undefined : !bounded(step.doneWhen, 1_900)))
    || !Array.isArray(prepared.accepted) || prepared.accepted.length > 2_000
    || prepared.accepted.some(action => !action || !bounded(action.actionId, 200) || !bounded(action.instruction, 2_000)
      || typeof action.result !== "string" || action.result.length > 2_000)
    || (prepared.blocked !== undefined && (!bounded(prepared.blocked.actionId, 200)
      || !parseWorkActionProviderReport(JSON.stringify(prepared.blocked.report))
      || (prepared.blocked.rejection !== undefined && !bounded(prepared.blocked.rejection, 2_000))))
    || !record.planner || !isResolvedExecutionPlan(record.planner.execution) || record.planner.execution.execution !== undefined
    || (record.planner.agentId !== undefined && !bounded(record.planner.agentId, 200))
    || !bounded(record.planner.instruction, 20_000) || !Number.isSafeInteger(record.planner.timeoutMs) || record.planner.timeoutMs <= 0
    || !Number.isSafeInteger(record.planner.maxTokens) || record.planner.maxTokens <= 0
    || !["queued", "running", "decided", "applied", "waiting", "failed", "obsolete"].includes(record.status ?? "")
    || (["decided", "applied", "waiting"].includes(record.status ?? "") && !record.decision)
    || typeof record.createdAt !== "number" || !Number.isFinite(record.createdAt)) throw new Error("Invalid work recovery");
  if (!fields(record, ["version", "kind", "id", "workItemId", "space", "sourceInputId", "actionId", "attempt", "runId", "factKey",
    "report", "rejection", "prepared", "planner", "status", "decision", "createdAt"])
    || !fields(prepared, ["workItemId", "space", "fingerprint", "source", "current", "goal", "remaining", "accepted", "blocked"])
    || !fields(prepared.source, ["kind", "id", "actionId"]) || !fields(prepared.current!, ["revision", "digest"])
    || !fields(record.planner, ["execution", "agentId", "instruction", "timeoutMs", "maxTokens"])
    || prepared.remaining.some(step => !fields(step, ["id", "instruction", "doneWhen", "legacy"]) || (step.legacy !== undefined && step.legacy !== true)
      || (!step.legacy && step.instruction.length + step.doneWhen!.length > 1_900))
    || new Set(prepared.remaining.map(step => step.id)).size !== prepared.remaining.length
    || prepared.accepted.some(action => !fields(action, ["actionId", "instruction", "result"]))
    || new Set(prepared.accepted.map(action => action.actionId)).size !== prepared.accepted.length
    || (prepared.blocked && !fields(prepared.blocked, ["actionId", "report", "rejection"]))) throw new Error("Invalid work recovery fields");
  // Store normalized report DTOs, never unknown provider fields.
  record.report = parseWorkActionProviderReport(JSON.stringify(record.report))!;
  if (prepared.blocked) prepared.blocked = { ...prepared.blocked, report: parseWorkActionProviderReport(JSON.stringify(prepared.blocked.report))! };
  return structuredClone({ ...record, ...(record.decision ? { decision: parseWorkRecoveryDecision(record.decision) } : {}) } as WorkRecovery);
}
function parseNotice(value: unknown): WorkNotice {
  if (!value || typeof value !== "object") throw new Error("Invalid work notice");
  const notice = value as Partial<WorkNotice>;
  if (Object.keys(notice).some(key => !["version", "id", "workItemId", "space", "planRef", "sourceInputId", "kind", "status",
    "markdown", "attempts", "nextAttemptAt", "createdAt", "sentAt", "messageId"].includes(key))) throw new Error("Invalid work notice fields");
  if (notice.version !== 1 || !bounded(notice.id, 80) || !/^notice_[a-f0-9]{64}$/.test(notice.id)
    || !bounded(notice.workItemId, 200) || !/^work_[a-f0-9-]{36}$/i.test(notice.workItemId)
    || typeof notice.space !== "string" || !isSpaceId(notice.space)
    || !bounded(notice.sourceInputId, 80) || !/^input_[a-f0-9]{64}$/.test(notice.sourceInputId)
    || (notice.planRef !== undefined && (!isWorkPlanRef(notice.planRef) || Object.keys(notice.planRef).some(key => !["revision", "digest"].includes(key))))
    || !["completion", "replanned", "waiting"].includes(notice.kind ?? "")
    || !["watching", "pending", "sent", "failed", "cancelled"].includes(notice.status ?? "")
    || (notice.markdown !== undefined && !bounded(notice.markdown, 200_000))
    || (["pending", "sent", "failed"].includes(notice.status ?? "") && !notice.markdown)
    || typeof notice.attempts !== "number" || !Number.isSafeInteger(notice.attempts) || notice.attempts < 0
    || (notice.nextAttemptAt !== undefined && (typeof notice.nextAttemptAt !== "number" || !Number.isFinite(notice.nextAttemptAt)))
    || typeof notice.createdAt !== "number" || !Number.isFinite(notice.createdAt)
    || (notice.sentAt !== undefined && (typeof notice.sentAt !== "number" || !Number.isFinite(notice.sentAt)))
    || (notice.messageId !== undefined && !bounded(notice.messageId, 512))) throw new Error("Invalid work notice");
  return structuredClone(notice as WorkNotice);
}

/** Local delivery authority is never imported from a Space archive. */
export class WorkEventStore {
  private readonly directory: string;
  private readonly notices = new Map<string, WorkNotice>();
  private readonly recoveries = new Map<string, WorkRecovery>();
  private readonly deliveries = new Map<string, SpaceId>();
  constructor(private readonly dataDir: string) {
    this.directory = join(dataDir, "config", "work-events");
    assertLocalStatePath(dataDir, this.directory);
    if (!existsSync(this.directory)) return;
    for (const name of readdirSync(this.directory).filter(name => name.endsWith(".json"))) {
      const id = name.slice(0, -5);
      const path = this.path(id);
      // Existing WorkItem/Action text envelopes, including JSON escaping.
      if (statSync(path).size > 55_000_000) throw new Error("Work event is too large");
      const value: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (id.startsWith("recovery_")) {
        const recovery = parseRecovery(value);
        if (recovery.id !== id) throw new Error("Work recovery identity mismatch");
        this.recoveries.set(id, recovery);
        if (recovery.status === "running") this.saveRecovery({ ...recovery, status: "failed" });
      } else {
        const notice = parseNotice(value);
        if (notice.id !== id) throw new Error("Work notice identity mismatch");
        this.notices.set(id, notice);
      }
    }
  }
  private path(id: string): string {
    if (!/^(?:notice|recovery)_[a-f0-9]{64}$/.test(id)) throw new Error("Invalid work event id");
    const path = join(this.directory, `${id}.json`);
    assertLocalStatePath(this.dataDir, path);
    return path;
  }
  list(space?: SpaceId): WorkNotice[] {
    return [...this.notices.values()].filter(notice => !space || notice.space === space).map(notice => structuredClone(notice));
  }
  beginDelivery(id: string): void {
    const notice = this.notices.get(id);
    if (!notice || this.deliveries.has(id)) throw new Error("Work notice delivery is unavailable");
    this.deliveries.set(id, notice.space);
  }
  endDelivery(id: string): void { this.deliveries.delete(id); }
  hasActive(space: SpaceId): boolean {
    return [...this.deliveries.values()].includes(space) || this.listRecoveries(space).some(event => ["queued", "running", "decided"].includes(event.status));
  }
  get(id: string): WorkNotice | undefined {
    const notice = this.notices.get(id);
    return notice && structuredClone(notice);
  }
  save(value: WorkNotice): WorkNotice {
    const notice = parseNotice(value);
    const previous = this.notices.get(notice.id);
    if (previous && (previous.workItemId !== notice.workItemId || previous.space !== notice.space
      || previous.sourceInputId !== notice.sourceInputId || previous.kind !== notice.kind
      || JSON.stringify(previous.planRef) !== JSON.stringify(notice.planRef))) throw new Error("Work notice ownership changed");
    if (previous?.markdown && previous.markdown !== notice.markdown) throw new Error("Work notice content changed");
    if (previous?.status === "sent" && notice.status !== "sent") throw new Error("Work notice was already sent");
    writeAtomicStateFile(this.path(notice.id), `${JSON.stringify(notice)}\n`);
    this.notices.set(notice.id, notice);
    return structuredClone(notice);
  }
  removeSpace(space: SpaceId): void {
    for (const notice of this.list(space)) { unlinkSync(this.path(notice.id)); this.notices.delete(notice.id); }
    for (const recovery of this.listRecoveries(space)) { unlinkSync(this.path(recovery.id)); this.recoveries.delete(recovery.id); }
  }
  listRecoveries(space?: SpaceId): WorkRecovery[] {
    return [...this.recoveries.values()].filter(record => !space || record.space === space).map(record => structuredClone(record));
  }
  getRecovery(id: string): WorkRecovery | undefined {
    const record = this.recoveries.get(id);
    return record && structuredClone(record);
  }
  saveRecovery(value: WorkRecovery): WorkRecovery {
    const record = parseRecovery(value), previous = this.recoveries.get(record.id);
    if (previous) {
      const { status: _status, decision: _decision, ...frozen } = previous;
      const { status: _newStatus, decision: _newDecision, ...next } = record;
      if (JSON.stringify(frozen) !== JSON.stringify(next)
        || (previous.decision && JSON.stringify(previous.decision) !== JSON.stringify(record.decision))) throw new Error("Work recovery input changed");
    }
    writeAtomicStateFile(this.path(record.id), `${JSON.stringify(record)}\n`);
    this.recoveries.set(record.id, record);
    return structuredClone(record);
  }
}
