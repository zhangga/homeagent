import { randomUUID } from "node:crypto";
import type { DreamReport, RawRecord, SpaceId } from "@homeagent/shared";

export type DreamStage = "queued" | "preparing" | "analyzing" | "generating" | "saving" | "indexing";
export type DreamTrigger = "manual" | "scheduled" | "import" | "redistill" | "retry" | "task";
export interface DreamSourceRef { id: string; name: string }
export interface DreamProgress {
  stage: DreamStage;
  rawCount?: number;
  processedRaw?: number;
  skippedRaw?: number;
  pagesTotal?: number;
  pagesCompleted?: number;
  pagesWritten?: number;
  pagesFailed?: number;
  page?: { slug: string; title: string; index: number };
  chunk?: { index: number; total: number };
  sources?: DreamSourceRef[];
  sourceCount?: number;
}
export interface DreamRunSnapshot extends DreamProgress {
  id: string;
  space: SpaceId;
  trigger: DreamTrigger;
  batch?: { index: number; total: number };
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  queuedAt: number;
  startedAt?: number;
  finishedAt?: number;
  updatedAt: number;
  stageStartedAt: number;
  errorCount: number;
}

/** Metadata only: never copy Raw bodies, prompts or provider diagnostics into progress. */
export function dreamSourceRefs(sources: RawRecord[]): DreamSourceRef[] {
  return sources.slice(0, 40).map((source) => ({
    id: source.id,
    name: (source.attachments?.find((attachment) => attachment.name)?.name
      ?? `${source.source} · ${source.id.slice(0, 8)}`).slice(0, 255),
  }));
}

/** In-memory observation, independent of durable Raw and execution/recovery state. */
export class DreamRunTracker {
  private readonly runs = new Map<string, DreamRunSnapshot>();

  constructor(private readonly now: () => number = Date.now) {}

  enqueue(space: SpaceId, trigger: DreamTrigger, batch?: DreamRunSnapshot["batch"]): string {
    const at = this.now();
    const id = `dream_${randomUUID()}`;
    this.runs.set(id, {
      id, space, trigger, ...(batch ? { batch: { ...batch } } : {}),
      status: "queued", stage: "queued", queuedAt: at, updatedAt: at, stageStartedAt: at,
      errorCount: 0, pagesWritten: 0, pagesCompleted: 0, pagesFailed: 0, processedRaw: 0,
    });
    return id;
  }

  start(id: string): void {
    const run = this.runs.get(id);
    if (!run) return;
    run.status = "running";
    run.startedAt = this.now();
    this.update(id, { stage: "preparing" });
  }

  update(id: string, progress: DreamProgress): void {
    const run = this.runs.get(id);
    if (!run || run.finishedAt !== undefined) return;
    const at = this.now();
    if (run.stage !== progress.stage || run.page?.slug !== progress.page?.slug
      || run.chunk?.index !== progress.chunk?.index) run.stageStartedAt = at;
    Object.assign(run, structuredClone(progress), { updatedAt: at });
    // A later stage must not keep showing the previous model fragment as current work.
    if (!progress.page) delete run.page;
    if (!progress.chunk) delete run.chunk;
  }

  finish(id: string, report?: DreamReport, cancelled = false): void {
    const run = this.runs.get(id);
    if (!run || run.finishedAt !== undefined) return;
    const at = this.now();
    run.finishedAt = at;
    run.updatedAt = at;
    run.status = cancelled ? "cancelled" : report && report.errors.length === 0 ? "completed" : "failed";
    run.errorCount = report?.errors.length ?? 1;
    if (report) Object.assign(run, {
      rawCount: report.examined, processedRaw: report.processedRawIds.length,
      skippedRaw: report.skipped, pagesWritten: report.pagesWritten, pagesFailed: report.pagesQuarantined,
    });
    const finished = [...this.runs.values()].filter((item) => item.finishedAt !== undefined)
      .sort((a, b) => a.finishedAt! - b.finishedAt!);
    for (const old of finished.slice(0, Math.max(0, finished.length - 50))) this.runs.delete(old.id);
  }

  list(space?: SpaceId): DreamRunSnapshot[] {
    return structuredClone([...this.runs.values()]
      .filter((run) => space === undefined || run.space === space)
      .sort((a, b) => Number(a.finishedAt !== undefined) - Number(b.finishedAt !== undefined)
        || b.queuedAt - a.queuedAt));
  }

  removeSpace(space: SpaceId): void {
    for (const run of this.runs.values()) if (run.space === space) this.runs.delete(run.id);
  }
}
