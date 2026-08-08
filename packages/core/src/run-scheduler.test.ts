import { describe, expect, test } from "bun:test";
import {
  RunQueueCancelledError,
  RunQueueTimeoutError,
  RunScheduler,
} from "./run-scheduler.ts";

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("RunScheduler", () => {
  test("queues beyond a layer limit and admits interactive work before scheduled work", async () => {
    const scheduler = new RunScheduler();
    const firstGate = deferred();
    const order: string[] = [];
    const layers = [{ key: "global", limit: 1 }];

    const first = scheduler.schedule({
      id: "first",
      priority: "manual",
      layers,
      execute: async () => {
        order.push("first");
        await firstGate.promise;
      },
    });
    const scheduled = scheduler.schedule({
      id: "scheduled",
      priority: "scheduled",
      layers,
      execute: async () => {
        order.push("scheduled");
      },
    });
    const interactive = scheduler.schedule({
      id: "interactive",
      priority: "interactive",
      layers,
      execute: async () => {
        order.push("interactive");
      },
    });

    await Promise.resolve();
    expect(order).toEqual(["first"]);
    expect(scheduler.queueInfo("interactive")).toEqual(expect.objectContaining({
      position: 1,
      priority: "interactive",
      blockedBy: ["global"],
    }));
    expect(scheduler.queueInfo("scheduled")).toEqual(expect.objectContaining({
      position: 2,
      priority: "scheduled",
    }));
    expect(scheduler.snapshot()).toEqual(expect.objectContaining({
      running: 1,
      queued: 2,
      limited: 2,
    }));

    firstGate.resolve();
    await Promise.all([first, scheduled, interactive]);

    expect(order).toEqual(["first", "interactive", "scheduled"]);
    expect(scheduler.snapshot()).toEqual(expect.objectContaining({
      averageWaitMs: expect.any(Number),
      maxWaitMs: expect.any(Number),
    }));
  });

  test("ages long-waiting low-priority work so it cannot starve", async () => {
    let now = 0;
    const scheduler = new RunScheduler({
      now: () => now,
      priorityAgingMs: 1_000,
    });
    const gate = deferred();
    const order: string[] = [];
    const layers = [{ key: "global", limit: 1 }];

    const first = scheduler.schedule({
      id: "first",
      priority: "interactive",
      layers,
      execute: () => gate.promise,
    });
    const background = scheduler.schedule({
      id: "background",
      priority: "background",
      layers,
      execute: async () => {
        order.push("background");
      },
    });
    now = 4_000;
    const manual = scheduler.schedule({
      id: "manual",
      priority: "manual",
      layers,
      execute: async () => {
        order.push("manual");
      },
    });

    gate.resolve();
    await Promise.all([first, background, manual]);

    expect(order).toEqual(["background", "manual"]);
  });

  test("cancels queued work without disturbing the running admission", async () => {
    const scheduler = new RunScheduler();
    const gate = deferred();
    const layers = [{ key: "global", limit: 1 }];
    const first = scheduler.schedule({
      id: "running",
      priority: "manual",
      layers,
      execute: () => gate.promise,
    });
    const queued = scheduler.schedule({
      id: "queued",
      priority: "manual",
      layers,
      execute: async () => {
        throw new Error("must not run");
      },
    });

    expect(scheduler.cancel("queued")).toBe(true);
    expect(scheduler.cancel("running")).toBe(false);
    await expect(queued).rejects.toBeInstanceOf(RunQueueCancelledError);
    expect(scheduler.snapshot().queued).toBe(0);

    gate.resolve();
    await first;
  });

  test("times out work that waits beyond its queue deadline", async () => {
    const scheduler = new RunScheduler();
    const gate = deferred();
    const layers = [{ key: "global", limit: 1 }];
    const first = scheduler.schedule({
      id: "running",
      priority: "manual",
      layers,
      execute: () => gate.promise,
    });
    const queued = scheduler.schedule({
      id: "deadline",
      priority: "interactive",
      layers,
      queueTimeoutMs: 10,
      execute: async () => undefined,
    });

    await expect(queued).rejects.toBeInstanceOf(RunQueueTimeoutError);
    expect(scheduler.snapshot()).toEqual(expect.objectContaining({
      queued: 0,
      timedOut: 1,
    }));

    gate.resolve();
    await first;
  });
});
