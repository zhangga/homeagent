import { describe, expect, test } from "bun:test";
import { Serializer } from "./serializer.ts";

describe("Serializer", () => {
  test("runs tasks for the same key in FIFO order", async () => {
    const s = new Serializer();
    const order: number[] = [];
    const mk = (n: number, delay: number) =>
      s.run("k", async () => {
        await Bun.sleep(delay);
        order.push(n);
        return n;
      });
    // Enqueue with decreasing delays: without serialization, 3 would finish first.
    const p1 = mk(1, 30);
    const p2 = mk(2, 20);
    const p3 = mk(3, 5);
    const results = await Promise.all([p1, p2, p3]);
    expect(order).toEqual([1, 2, 3]);
    expect(results).toEqual([1, 2, 3]);
  });

  test("different keys run concurrently", async () => {
    const s = new Serializer();
    const started: string[] = [];
    const a = s.run("a", async () => {
      started.push("a");
      await Bun.sleep(20);
      return "a";
    });
    const b = s.run("b", async () => {
      started.push("b");
      await Bun.sleep(20);
      return "b";
    });
    await Promise.all([a, b]);
    // Both should have started before either finished (concurrent).
    expect(started.sort()).toEqual(["a", "b"]);
  });

  test("a throwing task does not poison the chain", async () => {
    const s = new Serializer();
    const bad = s.run("k", async () => {
      throw new Error("boom");
    });
    await expect(bad).rejects.toThrow("boom");
    const good = await s.run("k", async () => 42);
    expect(good).toBe(42);
  });

  test("caller observes each task's own outcome", async () => {
    const s = new Serializer();
    const first = s.run("k", async () => "first");
    const second = s.run("k", async () => {
      throw new Error("second failed");
    });
    const third = s.run("k", async () => "third");
    expect(await first).toBe("first");
    await expect(second).rejects.toThrow("second failed");
    expect(await third).toBe("third");
  });

  test("drain resolves after enqueued work settles", async () => {
    const s = new Serializer();
    let done = false;
    s.run("k", async () => {
      await Bun.sleep(10);
      done = true;
    });
    expect(s.isBusy("k")).toBe(true);
    await s.drain("k");
    expect(done).toBe(true);
  });

  test("reports queue backlog, wait time, duration, and outcomes", async () => {
    let now = 100;
    const s = new Serializer({ now: () => now });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = s.run("k", async () => {
      now = 130;
      await gate;
      now = 180;
      return "first";
    });
    const second = s.run("k", async () => {
      now = 210;
      throw new Error("second failed");
    });

    await Promise.resolve();
    expect(s.snapshot("k")).toEqual(expect.objectContaining({
      queued: 1,
      running: 1,
      pending: 2,
      maxPending: 2,
      averageWaitMs: 0,
    }));

    release();
    await expect(first).resolves.toBe("first");
    await expect(second).rejects.toThrow("second failed");
    expect(s.snapshot("k")).toEqual({
      key: "k",
      queued: 0,
      running: 0,
      pending: 0,
      maxPending: 2,
      completed: 1,
      failed: 1,
      averageWaitMs: 40,
      maxWaitMs: 80,
      averageDurationMs: 55,
      maxDurationMs: 80,
    });
  });

  test("aggregates metrics across independent conversation keys", async () => {
    const serializer = new Serializer();
    await Promise.all([
      serializer.run("chat:a", async () => "a"),
      serializer.run("chat:b", async () => "b"),
    ]);

    expect(serializer.snapshotAll("events")).toEqual(expect.objectContaining({
      key: "events",
      queued: 0,
      running: 0,
      completed: 2,
      failed: 0,
    }));
  });
});
