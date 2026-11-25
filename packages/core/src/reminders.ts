/**
 * Durable user reminders. Reminders are separate from research tasks and raw
 * knowledge: they have a precise delivery time, an owner, and an explicit
 * lifecycle that survives service restarts.
 */
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { isSpaceId, type SpaceId } from "@homeagent/shared";
import { durableFsyncSync, durableRenameSync } from "./durable-file.ts";
import { isFeishuDeliveryReceipt, sameFeishuDeliveryReceipt, type FeishuDeliveryReceipt } from "./feishu-delivery-receipt.ts";

export type ReminderStatus = "scheduled" | "completed" | "cancelled";

export interface Reminder {
  id: string;
  title: string;
  space: SpaceId;
  /** Conversation that receives the proactive notification (group or p2p). */
  chatId: string;
  /** Only the creator may complete/cancel/snooze the reminder. */
  creatorId: string;
  /** Original requested delivery instant. */
  triggerAt: number;
  /** Mutable delivery instant used by retries, repetition, and snoozing. */
  nextTriggerAt: number;
  repeatEveryMs?: number;
  untilConfirmed: boolean;
  status: ReminderStatus;
  sourceMessageId?: string;
  lastNotifiedAt?: number;
  /** Local Feishu receipts for direct replies, excluded from Space archives. */
  notificationReceipts?: FeishuDeliveryReceipt[];
  completedAt?: number;
  cancelledAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface ReminderInput {
  title: string;
  space: string;
  chatId: string;
  creatorId: string;
  triggerAt: number;
  repeatEveryMs?: number;
  untilConfirmed?: boolean;
  sourceMessageId?: string;
}

interface RemindersFile {
  reminders: Record<string, Reminder>;
}

const MIN_REPEAT_MS = 60_000;
const MAX_NOTIFICATION_RECEIPTS = 4096;

function copyReminder(reminder: Reminder): Reminder {
  return { ...reminder, ...(reminder.notificationReceipts && { notificationReceipts: reminder.notificationReceipts.map(r => ({ ...r })) }) };
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validStoredReminder(value: unknown): value is Reminder {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const reminder = value as Partial<Reminder>;
  return typeof reminder.id === "string" && reminder.id.length > 0
    && typeof reminder.title === "string" && reminder.title.length > 0
    && typeof reminder.space === "string"
    && isSpaceId(reminder.space)
    && typeof reminder.chatId === "string" && reminder.chatId.length > 0
    && typeof reminder.creatorId === "string" && reminder.creatorId.length > 0
    && finite(reminder.triggerAt)
    && finite(reminder.nextTriggerAt)
    && ["scheduled", "completed", "cancelled"].includes(reminder.status ?? "")
    && typeof reminder.untilConfirmed === "boolean"
    && (reminder.repeatEveryMs === undefined
      || (finite(reminder.repeatEveryMs) && reminder.repeatEveryMs >= MIN_REPEAT_MS))
    && (!reminder.untilConfirmed || reminder.repeatEveryMs !== undefined)
    && (reminder.sourceMessageId === undefined || typeof reminder.sourceMessageId === "string")
    && (reminder.lastNotifiedAt === undefined || finite(reminder.lastNotifiedAt))
    && (reminder.completedAt === undefined || finite(reminder.completedAt))
    && (reminder.cancelledAt === undefined || finite(reminder.cancelledAt))
    && finite(reminder.createdAt)
    && finite(reminder.updatedAt);
}

export class ReminderStore {
  private readonly configPath: string;
  private reminders: Map<string, Reminder>;

  constructor(dataDir: string) {
    this.configPath = join(dataDir, "config", "reminders.json");
    this.reminders = this.load();
  }

  private load(): Map<string, Reminder> {
    const reminders = new Map<string, Reminder>();
    if (!existsSync(this.configPath)) return reminders;
    try {
      const parsed = JSON.parse(readFileSync(this.configPath, "utf8")) as RemindersFile;
      for (const [id, reminder] of Object.entries(parsed.reminders ?? {})) {
        if (!validStoredReminder(reminder) || reminder.id !== id) continue;
        const { notificationReceipts, ...record } = reminder;
        const receipts = Array.isArray(notificationReceipts)
          ? notificationReceipts.slice(-MAX_NOTIFICATION_RECEIPTS).filter(isFeishuDeliveryReceipt) : [];
        reminders.set(id, { ...record, ...(receipts.length && { notificationReceipts: receipts }) });
      }
    } catch {
      // A corrupt optional config file must not prevent HomeAgent from starting.
    }
    return reminders;
  }

  private persist(reminders = this.reminders): void {
    const configDir = dirname(this.configPath);
    mkdirSync(configDir, { recursive: true });
    const file: RemindersFile = { reminders: Object.fromEntries(reminders) };
    const temporaryPath = `${this.configPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporaryPath, JSON.stringify(file, null, 2), {
        encoding: "utf8",
        mode: 0o600,
      });
      const fileDescriptor = openSync(temporaryPath, "r+");
      try {
        durableFsyncSync(fileDescriptor);
      } finally {
        closeSync(fileDescriptor);
      }
      durableRenameSync(temporaryPath, this.configPath);
      const directoryDescriptor = openSync(configDir, "r");
      try {
        durableFsyncSync(directoryDescriptor, {
          allowUnsupportedDirectoryOnWindows: true,
        });
      } finally {
        closeSync(directoryDescriptor);
      }
    } catch (err) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // The rename may already have consumed the temporary path.
      }
      throw err;
    }
  }

  /** Persist a detached candidate before making it visible to readers. */
  private commit<T>(change: (candidate: Map<string, Reminder>) => T): T {
    const candidate = new Map(
      [...this.reminders].map(([id, reminder]) => [id, copyReminder(reminder)]),
    );
    const result = change(candidate);
    this.persist(candidate);
    this.reminders = candidate;
    return result;
  }

  list(): Reminder[] {
    return [...this.reminders.values()].map(copyReminder).sort(
      (a, b) => a.nextTriggerAt - b.nextTriggerAt || a.createdAt - b.createdAt,
    );
  }

  get(id: string): Reminder | undefined {
    const reminder = this.reminders.get(id);
    return reminder && copyReminder(reminder);
  }

  fromNotification(space: SpaceId, chatId: string, creatorId: string, receipt: FeishuDeliveryReceipt): Reminder | undefined {
    const matching = [...this.reminders.values()].filter(reminder =>
      reminder.space === space && reminder.chatId === chatId && reminder.creatorId === creatorId
      && reminder.lastNotifiedAt !== undefined && reminder.notificationReceipts?.some(r => sameFeishuDeliveryReceipt(r, receipt)));
    return matching.length === 1 ? copyReminder(matching[0]!) : undefined;
  }

  has(id: string): boolean {
    return this.reminders.has(id);
  }

  create(input: ReminderInput, now = Date.now()): Reminder | undefined {
    const title = input.title.trim();
    const space = input.space.trim();
    const chatId = input.chatId.trim();
    const creatorId = input.creatorId.trim();
    if (!title || !isSpaceId(space) || !chatId || !creatorId || !finite(input.triggerAt)) {
      return undefined;
    }
    const sourceMessageId = input.sourceMessageId?.trim() || undefined;
    if (sourceMessageId) {
      const existing = this.list().find(
        (reminder) => reminder.space === space
          && reminder.chatId === chatId
          && reminder.sourceMessageId === sourceMessageId,
      );
      if (existing) return existing;
    }
    const repeatEveryMs = finite(input.repeatEveryMs) && input.repeatEveryMs >= MIN_REPEAT_MS
      ? input.repeatEveryMs
      : undefined;
    const reminder: Reminder = {
      id: `reminder_${randomUUID()}`,
      title,
      space,
      chatId,
      creatorId,
      triggerAt: input.triggerAt,
      nextTriggerAt: input.triggerAt,
      repeatEveryMs,
      untilConfirmed: Boolean(input.untilConfirmed && repeatEveryMs),
      status: "scheduled",
      sourceMessageId,
      createdAt: now,
      updatedAt: now,
    };
    return this.commit((candidate) => {
      candidate.set(reminder.id, reminder);
      return copyReminder(reminder);
    });
  }

  due(now = Date.now()): Reminder[] {
    return this.list().filter(
      (reminder) => reminder.status === "scheduled" && reminder.nextTriggerAt <= now,
    );
  }

  upcoming(space: SpaceId, from: number, to: number, creatorId?: string): Reminder[] {
    return this.list().filter(
      (reminder) => reminder.space === space
        && (creatorId === undefined || reminder.creatorId === creatorId)
        && reminder.status === "scheduled"
        && reminder.nextTriggerAt >= from
        && reminder.nextTriggerAt <= to,
    );
  }

  markNotified(id: string, at = Date.now(), receipt?: FeishuDeliveryReceipt | void, occurrenceAt?: number): Reminder | undefined {
    const reminder = this.reminders.get(id);
    if (!reminder || reminder.status !== "scheduled") return undefined;
    return this.commit((candidate) => {
      const updated = candidate.get(id)!;
      updated.lastNotifiedAt = at;
      updated.updatedAt = at;
      if (isFeishuDeliveryReceipt(receipt)) {
        const receipts = updated.notificationReceipts ?? [];
        if (!receipts.some(r => sameFeishuDeliveryReceipt(r, receipt))) {
          updated.notificationReceipts = [...receipts, { ...receipt }].slice(-MAX_NOTIFICATION_RECEIPTS);
        }
      }
      // The user may have postponed this occurrence while the transport was sending it.
      if (occurrenceAt !== undefined && updated.nextTriggerAt !== occurrenceAt) return copyReminder(updated);
      if (updated.untilConfirmed && updated.repeatEveryMs) {
        updated.nextTriggerAt = at + updated.repeatEveryMs;
      } else {
        updated.status = "completed";
        updated.completedAt = at;
      }
      return copyReminder(updated);
    });
  }

  complete(id: string, actorId: string, at = Date.now()): Reminder | undefined {
    const reminder = this.reminders.get(id);
    if (!reminder || reminder.creatorId !== actorId || reminder.status !== "scheduled") {
      return undefined;
    }
    return this.commit((candidate) => {
      const updated = candidate.get(id)!;
      updated.status = "completed";
      delete updated.notificationReceipts;
      updated.completedAt = at;
      updated.updatedAt = at;
      return copyReminder(updated);
    });
  }

  cancel(id: string, actorId: string, at = Date.now()): Reminder | undefined {
    const reminder = this.reminders.get(id);
    if (!reminder || reminder.creatorId !== actorId || reminder.status !== "scheduled") {
      return undefined;
    }
    return this.commit((candidate) => {
      const updated = candidate.get(id)!;
      updated.status = "cancelled";
      updated.cancelledAt = at;
      updated.updatedAt = at;
      return copyReminder(updated);
    });
  }

  snooze(id: string, actorId: string, nextTriggerAt: number, at = Date.now(), receipt?: FeishuDeliveryReceipt): Reminder | undefined {
    const reminder = this.reminders.get(id);
    const deliveredOneShot = reminder?.status === "completed" && !reminder.untilConfirmed
      && reminder.completedAt === reminder.lastNotifiedAt && receipt !== undefined
      && reminder.notificationReceipts?.some(r => sameFeishuDeliveryReceipt(r, receipt));
    if (
      !reminder
      || reminder.creatorId !== actorId
      || (reminder.status !== "scheduled" && !deliveredOneShot)
      || !Number.isFinite(new Date(nextTriggerAt).getTime())
      || nextTriggerAt <= at
    ) {
      return undefined;
    }
    return this.commit((candidate) => {
      const updated = candidate.get(id)!;
      updated.status = "scheduled";
      delete updated.completedAt;
      updated.nextTriggerAt = nextTriggerAt;
      updated.updatedAt = at;
      return copyReminder(updated);
    });
  }

  remove(id: string): boolean {
    if (!this.reminders.has(id)) return false;
    return this.commit((candidate) => candidate.delete(id));
  }

  restore(reminders: Reminder[]): Reminder[] {
    for (const reminder of reminders) {
      if (this.reminders.has(reminder.id)) {
        throw new Error(`reminder id already exists: ${reminder.id}`);
      }
    }
    if (reminders.length === 0) return [];
    return this.commit((candidate) => reminders.map((reminder) => {
      const copy = copyReminder(reminder);
      candidate.set(copy.id, copy);
      return copyReminder(copy);
    }));
  }

  removeBySpace(space: SpaceId): number {
    const ids = [...this.reminders]
      .filter(([, reminder]) => reminder.space === space)
      .map(([id]) => id);
    if (ids.length === 0) return 0;
    return this.commit((candidate) => {
      for (const id of ids) candidate.delete(id);
      return ids.length;
    });
  }
}
