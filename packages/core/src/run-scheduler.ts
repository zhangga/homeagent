export type RunPriority = "interactive" | "manual" | "scheduled" | "background";

export interface RunConcurrencyLayer {
  key: string;
  limit: number;
}

export interface ScheduleRunInput<T> {
  id: string;
  priority: RunPriority;
  layers: RunConcurrencyLayer[];
  queueTimeoutMs?: number;
  execute: () => Promise<T>;
}

export interface RunSchedulerSnapshot {
  queued: number;
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
  timedOut: number;
  limited: number;
  averageWaitMs: number;
  maxWaitMs: number;
}

export interface RunQueueInfo {
  id: string;
  position: number;
  priority: RunPriority;
  queuedAt: number;
  waitedMs: number;
  blockedBy: string[];
}

interface QueuedRun<T> extends ScheduleRunInput<T> {
  sequence: number;
  enqueuedAt: number;
  timeout?: ReturnType<typeof setTimeout>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

const PRIORITY_ORDER: Record<RunPriority, number> = {
  interactive: 0,
  manual: 1,
  scheduled: 2,
  background: 3,
};

export class RunQueueCancelledError extends Error {
  constructor(readonly runId: string) {
    super(`queued run was cancelled: ${runId}`);
    this.name = "RunQueueCancelledError";
  }
}

export class RunQueueTimeoutError extends Error {
  constructor(
    readonly runId: string,
    readonly timeoutMs: number,
  ) {
    super(`queued run exceeded its ${timeoutMs}ms queue timeout: ${runId}`);
    this.name = "RunQueueTimeoutError";
  }
}

export class RunScheduler {
  private queue: QueuedRun<unknown>[] = [];
  private usage = new Map<string, number>();
  private running = 0;
  private completed = 0;
  private failed = 0;
  private cancelled = 0;
  private timedOut = 0;
  private limited = 0;
  private started = 0;
  private totalWaitMs = 0;
  private maxWaitMs = 0;
  private nextSequence = 0;
  private readonly now: () => number;
  private readonly priorityAgingMs: number;

  constructor(opts: {
    now?: () => number;
    priorityAgingMs?: number;
  } = {}) {
    this.now = opts.now ?? Date.now;
    this.priorityAgingMs = opts.priorityAgingMs ?? 60_000;
  }

  schedule<T>(input: ScheduleRunInput<T>): Promise<T> {
    if (!input.id) throw new Error("run id is required");
    if (input.layers.length === 0) throw new Error("at least one concurrency layer is required");
    if (input.layers.some((layer) =>
      !layer.key || !Number.isInteger(layer.limit) || layer.limit < 1
    )) {
      throw new Error("concurrency layers require a key and a positive integer limit");
    }
    if (
      this.queue.some((run) => run.id === input.id)
      || this.usage.has(`run:${input.id}`)
    ) {
      throw new Error(`run is already scheduled: ${input.id}`);
    }

    let queued!: QueuedRun<unknown>;
    const result = new Promise<T>((resolve, reject) => {
      queued = {
        ...input,
        sequence: this.nextSequence++,
        enqueuedAt: this.now(),
        resolve,
        reject,
      } as QueuedRun<unknown>;
      this.queue.push(queued);
    });
    if (
      input.queueTimeoutMs !== undefined
      && Number.isFinite(input.queueTimeoutMs)
      && input.queueTimeoutMs > 0
    ) {
      queued.timeout = setTimeout(() => {
        const index = this.queue.indexOf(queued);
        if (index < 0) return;
        this.queue.splice(index, 1);
        this.timedOut += 1;
        queued.reject(new RunQueueTimeoutError(input.id, input.queueTimeoutMs!));
      }, input.queueTimeoutMs);
    }
    this.pump();
    if (this.queue.includes(queued)) this.limited += 1;
    return result;
  }

  snapshot(): RunSchedulerSnapshot {
    return {
      queued: this.queue.length,
      running: this.running,
      completed: this.completed,
      failed: this.failed,
      cancelled: this.cancelled,
      timedOut: this.timedOut,
      limited: this.limited,
      averageWaitMs: this.started === 0 ? 0 : Math.round(this.totalWaitMs / this.started),
      maxWaitMs: this.maxWaitMs,
    };
  }

  queueInfo(id: string): RunQueueInfo | undefined {
    const ordered = [...this.queue].sort((a, b) =>
      this.effectivePriority(a) - this.effectivePriority(b)
      || a.sequence - b.sequence
    );
    const index = ordered.findIndex((run) => run.id === id);
    if (index < 0) return undefined;
    const run = ordered[index]!;
    return {
      id,
      position: index + 1,
      priority: run.priority,
      queuedAt: run.enqueuedAt,
      waitedMs: Math.max(0, this.now() - run.enqueuedAt),
      blockedBy: run.layers
        .filter((layer) => (this.usage.get(layer.key) ?? 0) >= layer.limit)
        .map((layer) => layer.key),
    };
  }

  cancel(id: string): boolean {
    const index = this.queue.findIndex((run) => run.id === id);
    if (index < 0) return false;
    const [run] = this.queue.splice(index, 1);
    if (!run) return false;
    if (run.timeout) clearTimeout(run.timeout);
    this.cancelled += 1;
    run.reject(new RunQueueCancelledError(id));
    return true;
  }

  private pump(): void {
    this.queue.sort((a, b) =>
      this.effectivePriority(a) - this.effectivePriority(b)
      || a.sequence - b.sequence
    );
    let admitted = true;
    while (admitted) {
      admitted = false;
      const index = this.queue.findIndex((run) => this.canAdmit(run));
      if (index < 0) break;
      const [run] = this.queue.splice(index, 1);
      if (!run) break;
      this.admit(run);
      admitted = true;
    }
  }

  private effectivePriority(run: QueuedRun<unknown>): number {
    const waitedMs = Math.max(0, this.now() - run.enqueuedAt);
    const promotions = this.priorityAgingMs > 0
      ? Math.floor(waitedMs / this.priorityAgingMs)
      : 0;
    return Math.max(0, PRIORITY_ORDER[run.priority] - promotions);
  }

  private canAdmit(run: QueuedRun<unknown>): boolean {
    return run.layers.every((layer) => (this.usage.get(layer.key) ?? 0) < layer.limit);
  }

  private admit(run: QueuedRun<unknown>): void {
    if (run.timeout) clearTimeout(run.timeout);
    const waitMs = Math.max(0, this.now() - run.enqueuedAt);
    this.started += 1;
    this.totalWaitMs += waitMs;
    this.maxWaitMs = Math.max(this.maxWaitMs, waitMs);
    this.running += 1;
    this.usage.set(`run:${run.id}`, 1);
    for (const layer of run.layers) {
      this.usage.set(layer.key, (this.usage.get(layer.key) ?? 0) + 1);
    }
    let execution: Promise<unknown>;
    try {
      execution = run.execute();
    } catch (error) {
      execution = Promise.reject(error);
    }
    void execution
      .then(
        (value) => {
          this.completed += 1;
          run.resolve(value);
        },
        (error) => {
          this.failed += 1;
          run.reject(error);
        },
      )
      .finally(() => {
        this.running -= 1;
        this.usage.delete(`run:${run.id}`);
        for (const layer of run.layers) {
          const remaining = (this.usage.get(layer.key) ?? 1) - 1;
          if (remaining === 0) this.usage.delete(layer.key);
          else this.usage.set(layer.key, remaining);
        }
        this.pump();
      });
  }
}
