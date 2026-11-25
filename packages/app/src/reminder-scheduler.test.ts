import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeLlm, KnowledgeEngine, SkillCatalog } from "@homeagent/core";
import { CliConnector, type Connector, type InboundMessage } from "@homeagent/connectors";
import { Orchestrator } from "@homeagent/orchestrator";
import type { SpaceId } from "@homeagent/shared";
import { ReminderScheduler } from "./reminder-scheduler.ts";

const SPACE: SpaceId = "team/oc_reminder_scheduler";
const NOW = new Date("2026-07-15T12:00:00+08:00").getTime();

describe("ReminderScheduler", () => {
  let dir: string;
  let engine: KnowledgeEngine;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hb-reminder-scheduler-"));
    engine = new KnowledgeEngine({ dataDir: dir, llm: new FakeLlm(), skillCatalog: new SkillCatalog({ roots: [] }) });
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
    expect(notices[0]).toContain("直接回复这条通知“收到”");
    expect(notices[0]).toContain("@我“确认去大同”");
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

  test("only the owner replying to a delivered notice confirms it after restart, including with two identical titles", async () => {
    const chatId = "oc_reminder_scheduler", appId = "cli_reminder";
    const binding = engine.feishuBindings.connect({ chatId, spaceId: SPACE, boundAppId: appId,
      responseMode: "mentions_only", replyInThread: true });
    const create = (repeat: boolean) => engine.reminders.create({
      title: "去开会", space: SPACE, chatId, creatorId: "ou_me", triggerAt: NOW,
      untilConfirmed: repeat, ...(repeat && { repeatEveryMs: 3 * 3600_000 }),
    }, NOW)!;
    const first = create(true);
    const transport = new CliConnector();
    let isAdmin = true;
    const connector: Connector = {
      name: "feishu", start: handler => transport.start(handler), stop: () => transport.stop(),
      notice: async () => {}, reply: out => transport.reply(out), isChatAdministrator: async () => isAdmin,
    };
    const detect = (id: string) => ({ messageId: `om_${id}`, bindingId: binding.executionScopeEpoch, appId });
    const scheduler = new ReminderScheduler(engine, { notify: async reminder => detect(reminder.id) });
    await scheduler.tick("first", new Date(NOW));
    const fake = new FakeLlm();
    const runtime = () => new Orchestrator({ engine, connector, activeFeishuAppId: appId, llm: fake });
    let orchestrator = runtime();
    let sequence = 0;
    const reply = (text: string, fields: Partial<InboundMessage> = {}) => {
      const messageId = `om_in_${++sequence}`;
      return transport.inject({ kind: "message", messageId, eventId: messageId, senderId: "ou_me",
        chatId, chatType: "group", mentionsBot: false, text, createdAt: Date.now(), ...fields });
    };
    try {
      await orchestrator.start();
      await reply("@agent 收到", { mentionsBot: true });
      await reply("收到", { parentMessageId: "om_unrelated", rootMessageId: detect(first.id).messageId });
      expect(engine.reminders.get(first.id)?.status).toBe("scheduled");
      const second = create(true), once = create(false);
      await scheduler.tick("more", new Date(NOW));
      expect(engine.reminders.get(once.id)?.status).toBe("completed");
      const archive = await engine.exportSpace(SPACE);
      expect(JSON.stringify(archive.reminders)).not.toContain("notificationReceipts");
      await orchestrator.stop();
      engine.close();
      engine = new KnowledgeEngine({ dataDir: dir, llm: fake, skillCatalog: new SkillCatalog({ roots: [] }) });
      orchestrator = runtime();
      await orchestrator.start();
      const original = { parentMessageId: detect(second.id).messageId };
      await reply("收到", { ...original, senderId: "ou_other" });
      isAdmin = false;
      await reply("收到", original);
      expect(engine.reminders.get(second.id)?.status).toBe("scheduled");
      isAdmin = true;
      await reply("收到", original);
      expect(transport.sent.at(-1)?.markdown).toContain("已完成提醒：去开会");
      expect(engine.reminders.get(second.id)?.status).toBe("completed");
      expect(engine.reminders.get(first.id)?.status).toBe("scheduled");
      for (const [reminder, command] of [[once, "10 分钟后再提醒我"], [first, "把去开会的提醒延后10分钟"]] as const) {
        const now = Date.now();
        await reply(command, { parentMessageId: detect(reminder.id).messageId });
        const updated = engine.reminders.get(reminder.id)!;
        expect(updated.status).toBe("scheduled");
        expect(updated.nextTriggerAt).toBeGreaterThanOrEqual(now + 600_000);
        expect(updated.nextTriggerAt).toBeLessThanOrEqual(Date.now() + 600_000);
      }
      expect(engine.reminders.list()).toHaveLength(3);
    } finally {
      await orchestrator.stop();
    }
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
