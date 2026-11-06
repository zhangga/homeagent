import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { isSpaceId, type SpaceId } from "@homeagent/shared";
import { assertLocalStatePath, writeAtomicStateFile } from "./durable-file.ts";
import type { WorkItem } from "./work-items.ts";
import type { WorkAction } from "./work-continuation.ts";

export interface WorkPlanRef { revision: number; digest: string }
export interface WorkPlanStep { id: string; instruction: string; doneWhen?: string; legacy?: true }
export interface WorkPlanStepRef { revision: number; stepId: string; digest: string; planDigest: string }
export interface WorkPlanRevision {
  version: 1;
  workItemId: string;
  space: SpaceId;
  revision: number;
  previous?: WorkPlanRef;
  goal: string;
  runbook?: string;
  reason: string;
  source: { kind: "chat" | "manual"; id: string };
  steps: WorkPlanStep[];
  acceptedActionIds: string[];
  createdAt: number;
}

export interface WorkPlanPreparation {
  workItemId: string;
  space: SpaceId;
  fingerprint: string;
  source: WorkPlanRevision["source"];
  current?: WorkPlanRef;
  goal: string;
  remaining: WorkPlanStep[];
  accepted: { actionId: string; instruction: string; result: string }[];
}

export class WorkPlanChangedError extends Error {
  constructor() { super("工作计划已更新，需要重新读取当前计划"); this.name = "WorkPlanChangedError"; }
}

const ITEM = /^work_[a-f0-9-]{36}$/i;
const STEP = /^step_[a-f0-9]{32}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const text = (value: unknown, max: number, empty = false): value is string =>
  typeof value === "string" && (empty || value.trim().length > 0) && value.length <= max;
const revisionNumber = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
// Existing WorkItem text, step and reference envelopes, including JSON escaping.
const MAX_PLAN_BYTES = 6 * (200_000 * 2 + 200 * 2_000 + 2_000 * 200 + 2_000) + 64_000;

export function isWorkPlanRef(value: unknown): value is WorkPlanRef {
  if (!value || typeof value !== "object") return false;
  const ref = value as Partial<WorkPlanRef>;
  return revisionNumber(ref.revision) && typeof ref.digest === "string" && DIGEST.test(ref.digest);
}

export function isWorkPlanStepRef(value: unknown): value is WorkPlanStepRef {
  if (!isWorkPlanRef(value) || !("stepId" in value)) return false;
  return typeof value.stepId === "string" && STEP.test(value.stepId)
    && "planDigest" in value && typeof value.planDigest === "string" && DIGEST.test(value.planDigest);
}

export function parseWorkPlanRevision(value: unknown): WorkPlanRevision {
  if (!value || typeof value !== "object") throw new Error("Invalid work plan revision");
  const plan = value as Partial<WorkPlanRevision>;
  if (plan.version !== 1 || typeof plan.workItemId !== "string" || !ITEM.test(plan.workItemId)
    || typeof plan.space !== "string" || !isSpaceId(plan.space) || !revisionNumber(plan.revision)
    || (plan.previous !== undefined && (!isWorkPlanRef(plan.previous) || plan.previous.revision >= plan.revision))
    || !text(plan.goal, 200_000, true) || !text(plan.reason, 2_000)
    || (plan.runbook !== undefined && !text(plan.runbook, 200_000, true))
    || !plan.source || !["chat", "manual"].includes(plan.source.kind) || !text(plan.source.id, 200)
    || (plan.source.kind === "chat" && !/^chat_run_[a-f0-9-]{36,64}$/i.test(plan.source.id))
    || !Array.isArray(plan.steps) || plan.steps.length > 200
    || !Array.isArray(plan.acceptedActionIds) || plan.acceptedActionIds.length > 2_000
    || !plan.acceptedActionIds.every(id => text(id, 200)) || new Set(plan.acceptedActionIds).size !== plan.acceptedActionIds.length
    || typeof plan.createdAt !== "number" || !Number.isFinite(plan.createdAt)) throw new Error("Invalid work plan revision");
  const ids = new Set<string>();
  const steps = plan.steps.map(step => {
    if (!step || typeof step !== "object" || typeof step.id !== "string" || !STEP.test(step.id) || ids.has(step.id)
      || !text(step.instruction, 2_000) || (step.legacy !== undefined && step.legacy !== true)
      || (step.legacy ? step.doneWhen !== undefined : !text(step.doneWhen, 1_900))
      || (!step.legacy && step.instruction.length + (step.doneWhen?.length ?? 0) > 1_900)) throw new Error("Invalid work plan step");
    ids.add(step.id);
    return { id: step.id, instruction: step.instruction, ...(step.legacy ? { legacy: true as const } : { doneWhen: step.doneWhen! }) };
  });
  if (steps.map(formatWorkPlanStep).join("\n\n").length > 200_000) throw new Error("Work plan is too large");
  return { version: 1, workItemId: plan.workItemId, space: plan.space, revision: plan.revision,
    ...(plan.previous ? { previous: { revision: plan.previous.revision, digest: plan.previous.digest } } : {}),
    goal: plan.goal, ...(plan.runbook !== undefined ? { runbook: plan.runbook } : {}), reason: plan.reason, source: { kind: plan.source.kind, id: plan.source.id },
    steps, acceptedActionIds: [...plan.acceptedActionIds], createdAt: plan.createdAt };
}

export function formatWorkPlanStep(step: WorkPlanStep, index: number): string {
  return step.legacy ? step.instruction : `${index + 1}. ${step.instruction}\n完成标准：${step.doneWhen}`;
}

export function workPlanDigest(plan: WorkPlanRevision): string {
  return createHash("sha256").update(JSON.stringify(parseWorkPlanRevision(plan))).digest("hex");
}

export function workPlanStepDigest(step: WorkPlanStep): string {
  return createHash("sha256").update(JSON.stringify([step.id, step.instruction, step.doneWhen ?? null, step.legacy ?? false])).digest("hex");
}

/** Validate the complete portable graph before restoring any files. */
export function assertWorkPlanArchive(plans: WorkPlanRevision[], items: WorkItem[], actions: WorkAction[]): void {
  const byKey = new Map<string, WorkPlanRevision>();
  const definitions = new Map<string, string>();
  const byItem = new Map(items.map(item => [item.id, item]));
  const byAction = new Map(actions.map(action => [action.id, action]));
  for (const plan of plans) {
    const key = `${plan.workItemId}:${plan.revision}`;
    if (byKey.has(key) || byItem.get(plan.workItemId)?.space !== plan.space) throw new Error("Invalid work plan archive owner");
    byKey.set(key, plan);
    for (const step of plan.steps) {
      const id = `${plan.workItemId}:${step.id}`, digest = workPlanStepDigest(step);
      if (definitions.has(id) && definitions.get(id) !== digest) throw new Error("Work plan step identity changed");
      definitions.set(id, digest);
    }
    for (const id of plan.acceptedActionIds) {
      const action = byAction.get(id);
      if (action?.workItemId !== plan.workItemId || action.status !== "succeeded"
        || !byItem.get(plan.workItemId)?.completedActionIds?.includes(id)) throw new Error("Invalid work plan accepted evidence");
    }
  }
  const resolve = (itemId: string, ref: WorkPlanRef) => {
    const plan = byKey.get(`${itemId}:${ref.revision}`);
    if (!plan || workPlanDigest(plan) !== ref.digest) throw new Error("Work plan archive reference mismatch");
    return plan;
  };
  const reachable = new Set<string>();
  for (const item of items) {
    if (!item.planRef) continue;
    const plan = resolve(item.id, item.planRef);
    const texts = item.nextStepIds!.map(id => {
      const index = plan.steps.findIndex(step => step.id === id);
      if (index < 0) throw new Error("Missing remaining plan step");
      if (actions.some(action => action.workItemId === item.id && action.status === "succeeded" && action.planStep?.stepId === id)) throw new Error("Accepted step cannot remain pending");
      return formatWorkPlanStep(plan.steps[index]!, index);
    });
    if (JSON.stringify(texts) !== JSON.stringify(item.nextActions)
      || item.runbook !== (plan.runbook ?? plan.steps.map(formatWorkPlanStep).join("\n\n"))) throw new Error("Work plan archive projection mismatch");
    let cursor: WorkPlanRevision | undefined = plan;
    while (cursor) {
      reachable.add(`${item.id}:${cursor.revision}`);
      cursor = cursor.previous ? resolve(item.id, cursor.previous) : undefined;
    }
  }
  for (const action of actions) {
    if (!action.planStep) continue;
    const plan = byKey.get(`${action.workItemId}:${action.planStep.revision}`);
    const index = plan?.steps.findIndex(step => step.id === action.planStep!.stepId) ?? -1;
    if (!plan || index < 0 || !reachable.has(`${action.workItemId}:${plan.revision}`)
      || workPlanDigest(plan) !== action.planStep.planDigest
      || workPlanStepDigest(plan.steps[index]!) !== action.planStep.digest
      || formatWorkPlanStep(plan.steps[index]!, index) !== action.instruction) throw new Error("Work action plan definition mismatch");
  }
  if ([...byKey.keys()].some(key => !reachable.has(key))) throw new Error("Uncommitted work plan in archive");
}

/** Immutable definitions. Only WorkItem.planRef selects an executable revision. */
export class WorkPlanStore {
  constructor(private readonly dataDir: string) {}

  private directory(itemId: string): string {
    if (!ITEM.test(itemId)) throw new Error("Invalid work plan owner");
    const directory = join(this.dataDir, "config", "work-plans", itemId);
    assertLocalStatePath(this.dataDir, directory);
    return directory;
  }

  private path(itemId: string, revision: number): string {
    if (!revisionNumber(revision)) throw new Error("Invalid work plan revision");
    const path = join(this.directory(itemId), `revision_${revision}.json`);
    assertLocalStatePath(this.dataDir, path);
    return path;
  }

  private revisions(itemId: string): number[] {
    const directory = this.directory(itemId);
    if (!existsSync(directory)) return [];
    return readdirSync(directory).filter(name => name.endsWith(".json")).map(name => {
      const match = /^revision_([1-9][0-9]*)\.json$/.exec(name);
      if (!match || !revisionNumber(Number(match[1]))) throw new Error("Invalid work plan file");
      return Number(match[1]);
    }).sort((a, b) => a - b);
  }

  nextRevision(itemId: string): number {
    const next = (this.revisions(itemId).at(-1) ?? 0) + 1;
    if (!revisionNumber(next)) throw new Error("Invalid work plan revision");
    return next;
  }

  get(itemId: string, ref: WorkPlanRef): WorkPlanRevision {
    if (!isWorkPlanRef(ref)) throw new Error("Invalid work plan reference");
    const plan = this.read(itemId, ref.revision);
    if (workPlanDigest(plan) !== ref.digest) throw new Error("Work plan digest mismatch");
    return plan;
  }

  private read(itemId: string, revision: number): WorkPlanRevision {
    const path = this.path(itemId, revision);
    if (statSync(path).size > MAX_PLAN_BYTES) throw new Error("Work plan file is too large");
    const plan = parseWorkPlanRevision(JSON.parse(readFileSync(path, "utf8")));
    if (plan.workItemId !== itemId || plan.revision !== revision) throw new Error("Work plan ownership mismatch");
    return plan;
  }

  page(itemId: string, after = 0, limit = 20): WorkPlanRevision[] {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error("Invalid work plan page");
    return this.revisions(itemId).filter(n => n > after).slice(0, limit).map(n => this.read(itemId, n));
  }

  history(itemId: string, ref: WorkPlanRef): WorkPlanRevision[] {
    const history: WorkPlanRevision[] = [];
    let cursor: WorkPlanRevision | undefined = this.get(itemId, ref);
    while (cursor) {
      history.push(cursor);
      cursor = cursor.previous ? this.get(itemId, cursor.previous) : undefined;
    }
    return history.reverse();
  }

  snapshot(itemId: string): WorkPlanRevision[] {
    return this.revisions(itemId).map(revision => this.read(itemId, revision));
  }

  assertCanRestore(plans: WorkPlanRevision[]): void {
    for (const value of plans) {
      const plan = parseWorkPlanRevision(value);
      const ref = { revision: plan.revision, digest: workPlanDigest(plan) };
      if (existsSync(this.path(plan.workItemId, plan.revision))) this.get(plan.workItemId, ref);
    }
  }

  restore(plans: WorkPlanRevision[]): { workItemId: string; revision: number }[] {
    this.assertCanRestore(plans);
    const added: { workItemId: string; revision: number }[] = [];
    try {
      for (const plan of [...plans].sort((a, b) => a.revision - b.revision)) {
        const existed = existsSync(this.path(plan.workItemId, plan.revision));
        this.save(plan);
        if (!existed) added.push({ workItemId: plan.workItemId, revision: plan.revision });
      }
      return added;
    } catch (error) { this.rollbackRestore(added); throw error; }
  }

  rollbackRestore(added: { workItemId: string; revision: number }[]): void {
    for (const entry of [...added].reverse()) unlinkSync(this.path(entry.workItemId, entry.revision));
  }

  removeItem(itemId: string): void {
    const directory = this.directory(itemId);
    if (!existsSync(directory)) return;
    const paths = readdirSync(directory).map(name => {
      if (!/^revision_[1-9][0-9]*\.json(?:\.[0-9]+\.[a-f0-9-]+\.tmp)?$/.test(name)) throw new Error("Invalid work plan file");
      const path = join(directory, name);
      assertLocalStatePath(this.dataDir, path);
      if (!statSync(path).isFile()) throw new Error("Invalid work plan file");
      return path;
    });
    for (const path of paths) unlinkSync(path);
  }

  save(value: WorkPlanRevision): WorkPlanRef {
    const plan = parseWorkPlanRevision(value);
    const ref = { revision: plan.revision, digest: workPlanDigest(plan) };
    const path = this.path(plan.workItemId, plan.revision);
    if (existsSync(path)) { this.get(plan.workItemId, ref); return ref; }
    if (plan.previous) this.get(plan.workItemId, plan.previous);
    writeAtomicStateFile(path, `${JSON.stringify(plan)}\n`);
    return ref;
  }
}
