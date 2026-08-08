/**
 * Serializer runs async tasks one-at-a-time per key, in FIFO order.
 *
 * homeagent writes knowledge from concurrent sources (feishu events, the
 * scheduler's dream cycle, manual web triggers). Interleaving writes to the
 * same space would corrupt the markdown/SQLite pair. Every mutating path funnels
 * through here keyed by SpaceId, so reads stay lock-free while writes to one
 * space never overlap. Different keys run concurrently.
 */
export interface SerializerSnapshot {
  key: string;
  queued: number;
  running: number;
  pending: number;
  maxPending: number;
  completed: number;
  failed: number;
  averageWaitMs: number;
  maxWaitMs: number;
  averageDurationMs: number;
  maxDurationMs: number;
}

interface SerializerMetrics {
  queued: number;
  running: number;
  started: number;
  maxPending: number;
  completed: number;
  failed: number;
  totalWaitMs: number;
  maxWaitMs: number;
  totalDurationMs: number;
  maxDurationMs: number;
}

export class Serializer {
  /** tail of the promise chain per key; absent key means idle */
  private chains = new Map<string, Promise<unknown>>();
  private metrics = new Map<string, SerializerMetrics>();
  private readonly now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  /**
   * Run `task` after all previously-enqueued tasks for `key` settle.
   * Rejections are isolated: one task throwing does not poison the chain.
   */
  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const enqueuedAt = this.now();
    const metrics = this.metrics.get(key) ?? {
      queued: 0,
      running: 0,
      started: 0,
      maxPending: 0,
      completed: 0,
      failed: 0,
      totalWaitMs: 0,
      maxWaitMs: 0,
      totalDurationMs: 0,
      maxDurationMs: 0,
    };
    metrics.queued += 1;
    metrics.maxPending = Math.max(metrics.maxPending, metrics.queued + metrics.running);
    this.metrics.set(key, metrics);
    const instrumented = async (): Promise<T> => {
      metrics.queued -= 1;
      metrics.running += 1;
      metrics.started += 1;
      const startedAt = this.now();
      const waitMs = Math.max(0, startedAt - enqueuedAt);
      metrics.totalWaitMs += waitMs;
      metrics.maxWaitMs = Math.max(metrics.maxWaitMs, waitMs);
      try {
        const value = await task();
        metrics.completed += 1;
        return value;
      } catch (err) {
        metrics.failed += 1;
        throw err;
      } finally {
        const durationMs = Math.max(0, this.now() - startedAt);
        metrics.totalDurationMs += durationMs;
        metrics.maxDurationMs = Math.max(metrics.maxDurationMs, durationMs);
        metrics.running -= 1;
      }
    };
    // Swallow the previous result/error so the chain never rejects for the next
    // task; the caller of each task still observes its own outcome via `result`.
    const result = prev.then(instrumented, instrumented);
    // Keep the chain alive but non-rejecting for scheduling purposes.
    const chained = result.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(key, chained);
    // Once this task is the last one, drop the key to avoid unbounded growth.
    void chained.finally(() => {
      if (this.chains.get(key) === chained) this.chains.delete(key);
    });
    return result;
  }

  /** True if any task is queued or running for `key`. */
  isBusy(key: string): boolean {
    return this.chains.has(key);
  }

  /** Resolve once all currently-enqueued tasks for `key` have settled. */
  async drain(key: string): Promise<void> {
    const chain = this.chains.get(key);
    if (chain) await chain;
  }

  /** Aggregate-only queue metrics for operational health reporting. */
  snapshot(key: string): SerializerSnapshot {
    const metrics = this.metrics.get(key);
    if (!metrics) {
      return {
        key,
        queued: 0,
        running: 0,
        pending: 0,
        maxPending: 0,
        completed: 0,
        failed: 0,
        averageWaitMs: 0,
        maxWaitMs: 0,
        averageDurationMs: 0,
        maxDurationMs: 0,
      };
    }
    const settled = metrics.completed + metrics.failed;
    return {
      key,
      queued: metrics.queued,
      running: metrics.running,
      pending: metrics.queued + metrics.running,
      maxPending: metrics.maxPending,
      completed: metrics.completed,
      failed: metrics.failed,
      averageWaitMs: metrics.started === 0 ? 0 : Math.round(metrics.totalWaitMs / metrics.started),
      maxWaitMs: metrics.maxWaitMs,
      averageDurationMs: settled === 0 ? 0 : Math.round(metrics.totalDurationMs / settled),
      maxDurationMs: metrics.maxDurationMs,
    };
  }

  /** Aggregate queue metrics across every key while preserving a stable label. */
  snapshotAll(key = "all"): SerializerSnapshot {
    const snapshots = [...this.metrics.keys()].map((metricKey) => this.snapshot(metricKey));
    const settled = snapshots.reduce(
      (total, snapshot) => total + snapshot.completed + snapshot.failed,
      0,
    );
    const started = snapshots.reduce(
      (total, snapshot) => total + snapshot.completed + snapshot.failed + snapshot.running,
      0,
    );
    return {
      key,
      queued: snapshots.reduce((total, snapshot) => total + snapshot.queued, 0),
      running: snapshots.reduce((total, snapshot) => total + snapshot.running, 0),
      pending: snapshots.reduce((total, snapshot) => total + snapshot.pending, 0),
      maxPending: snapshots.reduce((total, snapshot) => total + snapshot.maxPending, 0),
      completed: snapshots.reduce((total, snapshot) => total + snapshot.completed, 0),
      failed: snapshots.reduce((total, snapshot) => total + snapshot.failed, 0),
      averageWaitMs: started === 0
        ? 0
        : Math.round(snapshots.reduce(
            (total, snapshot) =>
              total + snapshot.averageWaitMs
                * (snapshot.completed + snapshot.failed + snapshot.running),
            0,
          ) / started),
      maxWaitMs: snapshots.reduce(
        (maximum, snapshot) => Math.max(maximum, snapshot.maxWaitMs),
        0,
      ),
      averageDurationMs: settled === 0
        ? 0
        : Math.round(snapshots.reduce(
            (total, snapshot) =>
              total + snapshot.averageDurationMs * (snapshot.completed + snapshot.failed),
            0,
          ) / settled),
      maxDurationMs: snapshots.reduce(
        (maximum, snapshot) => Math.max(maximum, snapshot.maxDurationMs),
        0,
      ),
    };
  }
}
