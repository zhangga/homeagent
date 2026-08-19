/**
 * Durable work context for an ongoing piece of work.
 *
 * The JSON file is the atomic source of truth. Each item is also projected
 * into its workspace as Markdown plus status.json so humans and agents can
 * inspect the current context without knowing the internal store format.
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
import {
  isSpaceId,
  logger,
  spaceToDir,
  type SpaceId,
} from "@homeagent/shared";
import { durableFsyncSync, durableRenameSync } from "./durable-file.ts";

export type WorkItemPhase = "planned" | "active" | "blocked" | "completed";

export interface WorkItem {
  id: string;
  space: SpaceId;
  title: string;
  brief: string;
  runbook: string;
  phase: WorkItemPhase;
  summary: string;
  blockers: string[];
  nextActions: string[];
  active: boolean;
  rawIds: string[];
  pageSlugs: string[];
  chatRunIds: string[];
  taskRunIds: string[];
  /** WorkAction checkpoints already projected into summary/nextActions. */
  completedActionIds?: string[];
  /** Internal idempotency map for blockers projected from failed WorkActions. */
  actionBlockers?: Record<string, string>;
  createdAt: number;
  updatedAt: number;
}

export interface WorkItemInput {
  space: string;
  title: string;
  brief?: string;
  runbook?: string;
  phase?: WorkItemPhase;
  summary?: string;
  blockers?: string[];
  nextActions?: string[];
  active?: boolean;
}

export interface WorkItemUpdate {
  title?: string;
  brief?: string;
  runbook?: string;
  phase?: WorkItemPhase;
  summary?: string;
  blockers?: string[];
  nextActions?: string[];
  active?: boolean;
}

export interface WorkPageReference {
  slug: string;
  sources: string[];
}

interface WorkItemsFile {
  version: 1;
  items: Record<string, WorkItem>;
}

const log = logger.child("work-items");
const PHASES = new Set<WorkItemPhase>(["planned", "active", "blocked", "completed"]);
const WORK_ITEM_ID_RE = /^work_[0-9a-f-]{36}$/i;
const MAX_TITLE_LENGTH = 200;
const MAX_TEXT_LENGTH = 200_000;
const MAX_LIST_ITEMS = 200;
const MAX_REFERENCES = 2_000;

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function stringList(value: unknown, max = MAX_LIST_ITEMS): value is string[] {
  return Array.isArray(value)
    && value.length <= max
    && value.every((item) => typeof item === "string" && item.length > 0 && item.length <= 2_000);
}

function stringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= MAX_LIST_ITEMS
    && entries.every(([key, message]) => (
      key.length > 0
      && key.length <= 200
      && typeof message === "string"
      && message.length > 0
      && message.length <= 2_000
    ));
}

export function isWorkItem(value: unknown): value is WorkItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<WorkItem>;
  return typeof item.id === "string" && WORK_ITEM_ID_RE.test(item.id)
    && typeof item.space === "string" && isSpaceId(item.space)
    && typeof item.title === "string" && item.title.length > 0 && item.title.length <= MAX_TITLE_LENGTH
    && typeof item.brief === "string" && item.brief.length <= MAX_TEXT_LENGTH
    && typeof item.runbook === "string" && item.runbook.length <= MAX_TEXT_LENGTH
    && typeof item.phase === "string" && PHASES.has(item.phase as WorkItemPhase)
    && typeof item.summary === "string" && item.summary.length <= MAX_TEXT_LENGTH
    && stringList(item.blockers)
    && stringList(item.nextActions)
    && typeof item.active === "boolean"
    && !(item.active && item.phase === "completed")
    && stringList(item.rawIds, MAX_REFERENCES)
    && stringList(item.pageSlugs, MAX_REFERENCES)
    && stringList(item.chatRunIds, MAX_REFERENCES)
    && stringList(item.taskRunIds, MAX_REFERENCES)
    && (item.completedActionIds === undefined
      || stringList(item.completedActionIds, MAX_REFERENCES))
    && (item.actionBlockers === undefined || stringRecord(item.actionBlockers))
    && finite(item.createdAt)
    && finite(item.updatedAt);
}

function trimText(value: string | undefined, max = MAX_TEXT_LENGTH): string {
  const result = value?.trim() ?? "";
  if (result.length > max) throw new Error(`work item text exceeds ${max} characters`);
  return result;
}

export function workActionBlockerMessage(instruction: string, error: string): string {
  return `${instruction.trim().slice(0, 1_000)}：${error.trim().slice(0, 1_000)}`;
}

function workActionProjectionConflictMessage(actionId: string, instruction: string): string {
  return `验收投影冲突（${actionId}）：当前首个下一步已变更，未自动消费“${trimText(instruction, 1_000)}”`;
}

function normalizeList(value: string[] | undefined): string[] {
  if (!value) return [];
  const result = [...new Set(value.map((item) => item.trim()).filter(Boolean))];
  if (result.length > MAX_LIST_ITEMS || result.some((item) => item.length > 2_000)) {
    throw new Error("work item list is too large");
  }
  return result;
}

function clone(item: WorkItem): WorkItem {
  return {
    ...item,
    blockers: [...item.blockers],
    nextActions: [...item.nextActions],
    rawIds: [...item.rawIds],
    pageSlugs: [...item.pageSlugs],
    chatRunIds: [...item.chatRunIds],
    taskRunIds: [...item.taskRunIds],
    completedActionIds: [...(item.completedActionIds ?? [])],
    actionBlockers: { ...(item.actionBlockers ?? {}) },
  };
}

function atomicWrite(path: string, content: string): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
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
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The rename may already have consumed the temporary path.
    }
    throw error;
  }
}

export class WorkItemStore {
  private readonly configPath: string;
  private readonly workspaceRoot: string;
  private items: Map<string, WorkItem>;

  constructor(dataDir: string) {
    this.configPath = join(dataDir, "config", "work-items.json");
    this.workspaceRoot = join(dataDir, "workspaces");
    this.items = this.load();
    this.projectAll();
  }

  private load(): Map<string, WorkItem> {
    const items = new Map<string, WorkItem>();
    if (!existsSync(this.configPath)) return items;
    try {
      const parsed = JSON.parse(readFileSync(this.configPath, "utf8")) as Partial<WorkItemsFile>;
      for (const [id, item] of Object.entries(parsed.items ?? {})) {
        if (!isWorkItem(item) || item.id !== id) continue;
        items.set(id, clone(item));
      }
    } catch (error) {
      log.warn("failed to load work item store", { error: String(error) });
    }
    return items;
  }

  private persist(items: Map<string, WorkItem>): void {
    const file: WorkItemsFile = {
      version: 1,
      items: Object.fromEntries([...items].map(([id, item]) => [id, clone(item)])),
    };
    atomicWrite(this.configPath, `${JSON.stringify(file, null, 2)}\n`);
  }

  private project(item: WorkItem): void {
    const directory = join(this.workspaceRoot, spaceToDir(item.space), "work", item.id);
    const status = {
      version: 1,
      id: item.id,
      space: item.space,
      title: item.title,
      phase: item.phase,
      summary: item.summary,
      blockers: item.blockers,
      nextActions: item.nextActions,
      active: item.active,
      rawIds: item.rawIds,
      pageSlugs: item.pageSlugs,
      chatRunIds: item.chatRunIds,
      taskRunIds: item.taskRunIds,
      completedActionIds: item.completedActionIds ?? [],
      actionBlockers: item.actionBlockers ?? {},
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
    atomicWrite(join(directory, "brief.md"), item.brief ? `${item.brief}\n` : "");
    atomicWrite(join(directory, "runbook.md"), item.runbook ? `${item.runbook}\n` : "");
    atomicWrite(join(directory, "status.json"), `${JSON.stringify(status, null, 2)}\n`);
  }

  private projectAll(): void {
    for (const item of this.items.values()) {
      try {
        this.project(item);
      } catch (error) {
        log.warn("failed to project work item", { id: item.id, error: String(error) });
      }
    }
  }

  /** Persist a detached candidate before making it visible to readers. */
  private commit<T>(change: (candidate: Map<string, WorkItem>) => T): T {
    const candidate = new Map([...this.items].map(([id, item]) => [id, clone(item)]));
    const result = change(candidate);
    this.persist(candidate);
    this.items = candidate;
    this.projectAll();
    return result;
  }

  list(space?: SpaceId): WorkItem[] {
    return [...this.items.values()]
      .filter((item) => space === undefined || item.space === space)
      .sort((a, b) => Number(b.active) - Number(a.active) || b.updatedAt - a.updatedAt)
      .map(clone);
  }

  get(id: string): WorkItem | undefined {
    const item = this.items.get(id);
    return item ? clone(item) : undefined;
  }

  activeForSpace(space: SpaceId): WorkItem | undefined {
    const item = [...this.items.values()].find((candidate) => candidate.space === space && candidate.active);
    return item ? clone(item) : undefined;
  }

  create(input: WorkItemInput, now = Date.now()): WorkItem {
    const space = input.space.trim();
    const title = trimText(input.title, MAX_TITLE_LENGTH);
    if (!isSpaceId(space)) throw new Error("invalid work item space");
    if (!title) throw new Error("work item title is required");
    const phase = input.phase ?? "active";
    if (!PHASES.has(phase)) throw new Error("invalid work item phase");
    const active = phase !== "completed" && input.active !== false;
    const item: WorkItem = {
      id: `work_${randomUUID()}`,
      space,
      title,
      brief: trimText(input.brief),
      runbook: trimText(input.runbook),
      phase,
      summary: trimText(input.summary),
      blockers: normalizeList(input.blockers),
      nextActions: normalizeList(input.nextActions),
      active,
      rawIds: [],
      pageSlugs: [],
      chatRunIds: [],
      taskRunIds: [],
      completedActionIds: [],
      actionBlockers: {},
      createdAt: now,
      updatedAt: now,
    };
    return this.commit((candidate) => {
      if (item.active) this.deactivateSpace(candidate, item.space, now);
      candidate.set(item.id, clone(item));
      return clone(item);
    });
  }

  update(id: string, update: WorkItemUpdate, now = Date.now()): WorkItem {
    const current = this.items.get(id);
    if (!current) throw new Error(`work item not found: ${id}`);
    return this.commit((candidate) => {
      const item = candidate.get(id)!;
      if (update.title !== undefined) {
        const title = trimText(update.title, MAX_TITLE_LENGTH);
        if (!title) throw new Error("work item title is required");
        item.title = title;
      }
      if (update.brief !== undefined) item.brief = trimText(update.brief);
      if (update.runbook !== undefined) item.runbook = trimText(update.runbook);
      if (update.summary !== undefined) item.summary = trimText(update.summary);
      if (update.blockers !== undefined) item.blockers = normalizeList(update.blockers);
      if (update.nextActions !== undefined) item.nextActions = normalizeList(update.nextActions);
      if (update.phase !== undefined) {
        if (!PHASES.has(update.phase)) throw new Error("invalid work item phase");
        item.phase = update.phase;
      }
      const ownedBlockers = Object.values(item.actionBlockers ?? {});
      if (ownedBlockers.length > 0) {
        item.blockers = normalizeList([...item.blockers, ...ownedBlockers]);
        item.phase = "blocked";
      }
      const wantsActive = update.active ?? item.active;
      item.active = item.phase !== "completed" && wantsActive;
      if (item.active) this.deactivateSpace(candidate, item.space, now, item.id);
      item.updatedAt = now;
      return clone(item);
    });
  }

  activate(id: string, now = Date.now()): WorkItem {
    return this.update(id, { active: true }, now);
  }

  private deactivateSpace(
    items: Map<string, WorkItem>,
    space: SpaceId,
    now: number,
    exceptId?: string,
  ): void {
    for (const item of items.values()) {
      if (item.space === space && item.id !== exceptId && item.active) {
        item.active = false;
        item.updatedAt = now;
      }
    }
  }

  private attach(id: string, field: "rawIds" | "chatRunIds" | "taskRunIds", reference: string, now: number): WorkItem {
    const normalized = reference.trim();
    if (!normalized) throw new Error("work item reference is required");
    const current = this.items.get(id);
    if (!current) throw new Error(`work item not found: ${id}`);
    if (current[field].includes(normalized)) return clone(current);
    return this.commit((candidate) => {
      const item = candidate.get(id)!;
      if (item[field].length >= MAX_REFERENCES) throw new Error("work item has too many references");
      item[field].push(normalized);
      item.updatedAt = now;
      return clone(item);
    });
  }

  attachRaw(id: string, rawId: string, now = Date.now()): WorkItem {
    return this.attach(id, "rawIds", rawId, now);
  }

  attachChatRun(id: string, runId: string, now = Date.now()): WorkItem {
    return this.attach(id, "chatRunIds", runId, now);
  }

  attachTaskRun(id: string, runId: string, now = Date.now()): WorkItem {
    return this.attach(id, "taskRunIds", runId, now);
  }

  applyActionCheckpoint(
    id: string,
    actionId: string,
    instruction: string,
    summary: string,
    now = Date.now(),
  ): WorkItem {
    const current = this.items.get(id);
    if (!current) throw new Error(`work item not found: ${id}`);
    if (current.completedActionIds?.includes(actionId)) return clone(current);
    return this.commit((candidate) => {
      const item = candidate.get(id)!;
      item.completedActionIds ??= [];
      if (item.completedActionIds.includes(actionId)) return clone(item);
      const conflict = workActionProjectionConflictMessage(actionId, instruction);
      if (item.nextActions[0] !== instruction) {
        if (!item.blockers.includes(conflict)) item.blockers.push(conflict);
        item.phase = "blocked";
        item.updatedAt = now;
        return clone(item);
      }
      if (item.completedActionIds.length >= MAX_REFERENCES) {
        throw new Error("work item has too many completed actions");
      }
      item.nextActions.splice(0, 1);
      const conflictIndex = item.blockers.indexOf(conflict);
      if (conflictIndex >= 0) item.blockers.splice(conflictIndex, 1);
      const previousBlocker = item.actionBlockers?.[actionId];
      if (previousBlocker) {
        const blockerIndex = item.blockers.indexOf(previousBlocker);
        if (blockerIndex >= 0) item.blockers.splice(blockerIndex, 1);
        delete item.actionBlockers![actionId];
      }
      item.summary = trimText(summary);
      item.completedActionIds.push(actionId);
      if (item.phase === "blocked" && item.blockers.length === 0) item.phase = "active";
      item.updatedAt = now;
      return clone(item);
    });
  }

  applyActionBlocker(
    id: string,
    actionId: string,
    instruction: string,
    error: string,
    now = Date.now(),
  ): WorkItem {
    const current = this.items.get(id);
    if (!current) throw new Error(`work item not found: ${id}`);
    const message = workActionBlockerMessage(instruction, error);
    return this.commit((candidate) => {
      const item = candidate.get(id)!;
      item.actionBlockers ??= {};
      const previous = item.actionBlockers[actionId];
      if (previous && previous !== message) {
        const previousIndex = item.blockers.indexOf(previous);
        if (previousIndex >= 0) item.blockers.splice(previousIndex, 1);
      }
      item.actionBlockers[actionId] = message;
      if (!item.blockers.includes(message)) item.blockers.push(message);
      item.phase = "blocked";
      item.updatedAt = now;
      return clone(item);
    });
  }

  clearActionBlocker(id: string, actionId: string, now = Date.now()): WorkItem {
    const current = this.items.get(id);
    if (!current) throw new Error(`work item not found: ${id}`);
    if (!current.actionBlockers?.[actionId]) return clone(current);
    return this.commit((candidate) => {
      const item = candidate.get(id)!;
      const previous = item.actionBlockers?.[actionId];
      if (!previous) return clone(item);
      delete item.actionBlockers![actionId];
      const blockerIndex = item.blockers.indexOf(previous);
      if (blockerIndex >= 0) item.blockers.splice(blockerIndex, 1);
      if (item.phase === "blocked" && item.blockers.length === 0) item.phase = "active";
      item.updatedAt = now;
      return clone(item);
    });
  }

  syncPageLinks(space: SpaceId, pages: WorkPageReference[], now = Date.now()): void {
    const items = this.list(space);
    if (items.length === 0) return;
    this.commit((candidate) => {
      for (const item of candidate.values()) {
        if (item.space !== space) continue;
        const rawIds = new Set(item.rawIds);
        const nextSlugs = pages
          .filter((page) => page.sources.some((source) => rawIds.has(source)))
          .map((page) => page.slug);
        const normalized = [...new Set(nextSlugs)].sort();
        if (JSON.stringify(normalized) !== JSON.stringify(item.pageSlugs)) {
          item.pageSlugs = normalized.slice(0, MAX_REFERENCES);
          item.updatedAt = now;
        }
      }
    });
  }

  assertCanRestore(items: WorkItem[]): void {
    const seen = new Set<string>();
    for (const item of items) {
      if (!isWorkItem(item)) throw new Error("archive contains an invalid work item");
      if (seen.has(item.id) || this.items.has(item.id)) {
        throw new Error(`work item already exists: ${item.id}`);
      }
      seen.add(item.id);
    }
  }

  restore(items: WorkItem[]): number {
    this.assertCanRestore(items);
    if (items.length === 0) return 0;
    this.commit((candidate) => {
      for (const item of items) candidate.set(item.id, clone(item));
    });
    return items.length;
  }

  removeBySpace(space: SpaceId): WorkItem[] {
    const removed = this.list(space);
    if (removed.length === 0) return [];
    this.commit((candidate) => {
      for (const item of removed) candidate.delete(item.id);
    });
    return removed;
  }
}
