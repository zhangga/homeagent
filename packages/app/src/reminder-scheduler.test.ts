import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeEngine } from "@homeagent/core";
import type { SpaceId } from "@homeagent/shared";
import { ReminderScheduler } from "./reminder-scheduler.ts";

const SPACE: SpaceId = "team/oc_reminder_scheduler";
const NOW = new Date("2026-07-15T12:00:00+08:00").getTime();

describe("ReminderScheduler", () => {
  let dir: string;
  let engine: KnowledgeEngine;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hb-reminder-scheduler-"));
    engine = new KnowledgeEngine({ dataDir: dir });
    engine.ensureSpace(SPACE, { chatId: "oc_reminder_scheduler" });
  });

  afterEach(() => {
    engine.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("delivers a due one-shot reminder and completes it", async () => {
    const reminder = engine.reminders.create({
      title: "去茶饼斋",
      space: SPACE,
      chatId: "oc_reminder_scheduler",
      creatorId: "ou_me",
      triggerAt: NOW,
    }, NOW)!;
    const notices: string[] = [];
    const scheduler = new ReminderScheduler(engine, {
      notify: async (_item, message) => void notices.push(message),
    });

    expect(await scheduler.tick("test", new Date(NOW))).toEqual([reminder.id]);
    expect(notices[0]).toContain("⏰ 提醒：去茶饼斋");
    expect(engine.reminders.get(reminder.id)?.status).toBe("completed");
  });

  test("keeps a repeating reminder scheduled and explains how to stop it", async () => {
    const reminder = engine.reminders.create({
      title: "确认去大同",
      space: SPACE,
      chatId: "oc_reminder_scheduler",
      creatorId: "ou_me",
      triggerAt: NOW,
      repeatEveryMs: 3 * 3600_000,
      untilConfirmed: true,
    }, NOW)!;
    const notices: string[] = [];
    const scheduler = new ReminderScheduler(engine, {
      notify: async (_item, message) => void notices.push(message),
    });

    await scheduler.tick("test", new Date(NOW));
    expect(notices[0]).toContain("回复并 @我“确认去大同”");
    expect(engine.reminders.get(reminder.id)).toEqual(expect.objectContaining({
      status: "scheduled",
      nextTriggerAt: NOW + 3 * 3600_000,
    }));
  });

  test("does not advance a reminder when delivery fails", async () => {
    const reminder = engine.reminders.create({
      title: "失败重试",
      space: SPACE,
      chatId: "oc_reminder_scheduler",
      creatorId: "ou_me",
      triggerAt: NOW,
    }, NOW)!;
    const scheduler = new ReminderScheduler(engine, {
      notify: async () => { throw new Error("network unavailable"); },
    });

    expect(await scheduler.tick("test", new Date(NOW))).toEqual([]);
    expect(engine.reminders.get(reminder.id)?.status).toBe("scheduled");
    expect(scheduler.health()).toEqual(expect.objectContaining({
      lastStatus: "error",
      lastError: expect.stringContaining("network unavailable"),
    }));
  });

  test("retries a post-send commit with the same occurrence idempotency key", async () => {
    const reminder = engine.reminders.create({
      title: "提交失败重试",
      space: SPACE,
      chatId: "oc_reminder_scheduler",
      creatorId: "ou_me",
      triggerAt: NOW,
    }, NOW)!;
    const persistNotified = engine.reminders.markNotified.bind(engine.reminders);
    let commitAttempts = 0;
    engine.reminders.markNotified = (...args) => {
      commitAttempts += 1;
      return commitAttempts === 1 ? undefined : persistNotified(...args);
    };
    const attemptedKeys: string[] = [];
    const acceptedKeys = new Set<string>();
    let physicalDeliveries = 0;
    const scheduler = new ReminderScheduler(engine, {
      notify: async (_item, _message, deliveryKey: string) => {
        attemptedKeys.push(deliveryKey);
        if (acceptedKeys.has(deliveryKey)) return;
        acceptedKeys.add(deliveryKey);
        physicalDeliveries += 1;
      },
    });

    expect(await scheduler.tick("post-send-commit-empty", new Date(NOW))).toEqual([]);
    expect(await scheduler.tick("retry", new Date(NOW + 1))).toEqual([reminder.id]);
    expect(attemptedKeys).toEqual([expect.any(String), attemptedKeys[0]]);
    expect(attemptedKeys[0]).toMatch(/^ha-reminder-/);
    expect(physicalDeliveries).toBe(1);
  });

  test("uses a distinct reminder idempotency key for each repeating occurrence", async () => {
    engine.reminders.create({
      title: "重复提醒键",
      space: SPACE,
      chatId: "oc_reminder_scheduler",
      creatorId: "ou_me",
      triggerAt: NOW,
      repeatEveryMs: 60_000,
      untilConfirmed: true,
    }, NOW);
    const keys: string[] = [];
    const scheduler = new ReminderScheduler(engine, {
      notify: async (_item, _message, deliveryKey: string) => {
        keys.push(deliveryKey);
      },
    });

    await scheduler.tick("first occurrence", new Date(NOW));
    await scheduler.tick("second occurrence", new Date(NOW + 60_000));

    expect(keys).toEqual([expect.any(String), expect.any(String)]);
    expect(keys[0]).not.toBe(keys[1]);
  });

  test("prevents deleting a space while one of its reminders is being delivered", async () => {
    engine.reminders.create({
      title: "并发投递",
      space: SPACE,
      chatId: "oc_reminder_scheduler",
      creatorId: "ou_me",
      triggerAt: NOW,
    }, NOW);
    let releaseDelivery!: () => void;
    let deliveryStarted!: () => void;
    const started = new Promise<void>((resolve) => { deliveryStarted = resolve; });
    const released = new Promise<void>((resolve) => { releaseDelivery = resolve; });
    const scheduler = new ReminderScheduler(engine, {
      notify: async () => {
        deliveryStarted();
        await released;
      },
    });

    const tick = scheduler.tick("test", new Date(NOW));
    await started;
    await expect(engine.exportSpace(SPACE)).rejects.toThrow("space has delivering reminders");
    await expect(engine.deleteSpace(SPACE)).rejects.toThrow("space has delivering reminders");
    releaseDelivery();
    await tick;
    expect((await engine.deleteSpace(SPACE)).status).toBe("deleted");
  });
});
