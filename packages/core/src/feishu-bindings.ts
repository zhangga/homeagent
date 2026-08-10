/**
 * Durable HomeAgent-side lifecycle state for Feishu group integrations.
 *
 * Knowledge spaces deliberately outlive group connections. Keeping bindings
 * in their own registry lets a group be disconnected without deleting the
 * space, tasks, reminders, or learned content associated with it.
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
import type { SpaceId } from "@homeagent/shared";
import { isSpaceId } from "@homeagent/shared";
import type { GroupParticipationLevel, SpaceMeta } from "./types.ts";
import { durableFsyncSync, durableRenameSync } from "./durable-file.ts";

export type FeishuGroupBindingState =
  | "pending_confirmation"
  | "active"
  | "disconnected"
  | "needs_reconnect";

export type FeishuResponseMode =
  | "mentions_only"
  | "smart"
  | "all_messages";

export type FeishuBindingTestStatus = "succeeded" | "failed";
export type FeishuConfirmationPromptStatus =
  | "attempting"
  | "sent"
  | "failed";

export interface FeishuConfirmationPrompt {
  lastAttemptAt: number;
  status: FeishuConfirmationPromptStatus;
  lastError?: string;
}

export interface FeishuGroupBinding {
  chatId: string;
  spaceId: SpaceId;
  boundAppId?: string;
  state: FeishuGroupBindingState;
  responseMode: FeishuResponseMode;
  participationLevel?: GroupParticipationLevel;
  replyInThread: boolean;
  createdAt: number;
  updatedAt: number;
  lastVerifiedAt?: number;
  confirmationPrompt?: FeishuConfirmationPrompt;
  lastTestAt?: number;
  lastTestStatus?: FeishuBindingTestStatus;
  lastError?: string;
}

export interface ConnectFeishuGroupInput {
  chatId: string;
  spaceId: SpaceId;
  boundAppId?: string;
  responseMode: FeishuResponseMode;
  participationLevel?: GroupParticipationLevel;
  replyInThread: boolean;
}

export interface RegisterPendingFeishuGroupInput {
  chatId: string;
  spaceId: SpaceId;
  boundAppId?: string;
}

export type FeishuGroupPolicyPatch = Partial<Pick<
  FeishuGroupBinding,
  "responseMode" | "participationLevel" | "replyInThread"
>>;

export type FeishuBindingTestResult =
  | { status: "succeeded"; at?: number }
  | { status: "failed"; at?: number; error?: unknown };

export type FeishuConfirmationPromptResult =
  | { status: "attempting" | "sent"; at?: number }
  | { status: "failed"; at?: number; error?: unknown };

interface FeishuGroupBindingsFileV1 {
  version: 1;
  bindings: FeishuGroupBinding[];
}

interface FeishuGroupBindingsFileV2 {
  version: 2;
  bindings: FeishuGroupBinding[];
}

type FeishuGroupBindingsFile =
  | FeishuGroupBindingsFileV1
  | FeishuGroupBindingsFileV2;

export class FeishuGroupBindingStore {
  private readonly configPath: string;
  private bindings: Map<string, FeishuGroupBinding>;

  constructor(dataDir: string) {
    this.configPath = join(dataDir, "config", "feishu-group-bindings.json");
    const existed = existsSync(this.configPath);
    const loaded = this.load();
    this.bindings = loaded.bindings;
    if (!existed || loaded.needsMigration) this.persist(this.bindings);
  }

  list(): FeishuGroupBinding[] {
    return [...this.bindings.values()]
      .sort((a, b) => a.chatId.localeCompare(b.chatId))
      .map(cloneBinding);
  }

  getByChatId(chatId: string): FeishuGroupBinding | undefined {
    const binding = this.bindings.get(chatId);
    return binding ? cloneBinding(binding) : undefined;
  }

  getBySpace(spaceId: SpaceId): FeishuGroupBinding | undefined {
    const binding = [...this.bindings.values()].find(
      (candidate) => candidate.spaceId === spaceId,
    );
    return binding ? cloneBinding(binding) : undefined;
  }

  activeByChatId(chatId: string): FeishuGroupBinding | undefined {
    const binding = this.bindings.get(chatId);
    return binding?.state === "active" ? cloneBinding(binding) : undefined;
  }

  registerPending(
    input: RegisterPendingFeishuGroupInput,
  ): FeishuGroupBinding {
    return this.upsertPending(input, false);
  }

  requestConfirmation(
    input: RegisterPendingFeishuGroupInput,
  ): FeishuGroupBinding {
    return this.upsertPending(input, true);
  }

  recordConfirmationPrompt(
    chatId: string,
    result: FeishuConfirmationPromptResult,
  ): FeishuGroupBinding | undefined {
    const previous = this.bindings.get(chatId);
    if (!previous || previous.state !== "pending_confirmation") {
      return undefined;
    }
    const attemptedAt = result.at ?? Date.now();
    const binding: FeishuGroupBinding = {
      ...previous,
      confirmationPrompt: {
        lastAttemptAt: attemptedAt,
        status: result.status,
        lastError: result.status === "failed"
          ? normalizeError(result.error)
          : undefined,
      },
      updatedAt: Date.now(),
    };
    const candidate = new Map(this.bindings);
    candidate.set(binding.chatId, binding);
    this.persist(candidate);
    this.bindings = candidate;
    return cloneBinding(binding);
  }

  connect(input: ConnectFeishuGroupInput): FeishuGroupBinding {
    assertConnectionInput(input);
    const previous = this.bindings.get(input.chatId);
    if (previous && previous.spaceId !== input.spaceId) {
      throw new Error(`Feishu chat ${input.chatId} is already bound`);
    }
    const sameSpace = [...this.bindings.values()].find(
      (binding) => binding.spaceId === input.spaceId,
    );
    if (sameSpace && sameSpace.chatId !== input.chatId) {
      throw new Error(`Feishu space ${input.spaceId} is already bound`);
    }
    if (
      previous?.spaceId === input.spaceId
      && previous.boundAppId === input.boundAppId
      && previous.state === "active"
      && previous.responseMode === input.responseMode
      && previous.participationLevel === input.participationLevel
      && previous.replyInThread === input.replyInThread
    ) {
      return cloneBinding(previous);
    }
    const now = Date.now();
    const binding: FeishuGroupBinding = {
      ...input,
      state: "active",
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    const candidate = new Map(this.bindings);
    candidate.set(binding.chatId, binding);
    this.persist(candidate);
    this.bindings = candidate;
    return cloneBinding(binding);
  }

  updatePolicy(
    spaceId: SpaceId,
    patch: FeishuGroupPolicyPatch,
  ): FeishuGroupBinding | undefined {
    const previous = [...this.bindings.values()].find(
      (binding) => binding.spaceId === spaceId,
    );
    if (!previous) return undefined;
    const binding: FeishuGroupBinding = {
      ...previous,
      ...patch,
      updatedAt: Date.now(),
    };
    const candidate = new Map(this.bindings);
    candidate.set(binding.chatId, binding);
    this.persist(candidate);
    this.bindings = candidate;
    return cloneBinding(binding);
  }

  disconnect(spaceId: SpaceId): FeishuGroupBinding | undefined {
    const previous = [...this.bindings.values()].find(
      (binding) => binding.spaceId === spaceId,
    );
    if (!previous) return undefined;
    if (previous.state === "disconnected") return cloneBinding(previous);
    const binding: FeishuGroupBinding = {
      ...previous,
      state: "disconnected",
      updatedAt: Date.now(),
    };
    const candidate = new Map(this.bindings);
    candidate.set(binding.chatId, binding);
    this.persist(candidate);
    this.bindings = candidate;
    return cloneBinding(binding);
  }

  markAppNeedsReconnect(appId: string): number {
    const candidate = new Map(this.bindings);
    const now = Date.now();
    let changed = 0;
    for (const binding of candidate.values()) {
      if (
        (binding.state !== "active"
          && binding.state !== "pending_confirmation")
        || binding.boundAppId !== appId
      ) {
        continue;
      }
      candidate.set(binding.chatId, {
        ...binding,
        state: "needs_reconnect",
        updatedAt: now,
      });
      changed += 1;
    }
    if (changed > 0) {
      this.persist(candidate);
      this.bindings = candidate;
    }
    return changed;
  }

  markMismatchedAppNeedsReconnect(currentAppId: string): number {
    const candidate = new Map(this.bindings);
    const now = Date.now();
    let changed = 0;
    for (const binding of candidate.values()) {
      if (
        (binding.state !== "active"
          && binding.state !== "pending_confirmation")
        || binding.boundAppId === currentAppId
      ) {
        continue;
      }
      candidate.set(binding.chatId, {
        ...binding,
        state: "needs_reconnect",
        updatedAt: now,
      });
      changed += 1;
    }
    if (changed > 0) {
      this.persist(candidate);
      this.bindings = candidate;
    }
    return changed;
  }

  recordTest(
    spaceId: SpaceId,
    result: FeishuBindingTestResult,
  ): FeishuGroupBinding | undefined {
    const previous = [...this.bindings.values()].find(
      (binding) => binding.spaceId === spaceId,
    );
    if (!previous) return undefined;
    const testedAt = result.at ?? Date.now();
    const binding: FeishuGroupBinding = {
      ...previous,
      updatedAt: Date.now(),
      lastTestAt: testedAt,
      lastTestStatus: result.status,
      lastError: result.status === "failed"
        ? normalizeError(result.error)
        : undefined,
      ...(result.status === "succeeded"
        ? { lastVerifiedAt: testedAt }
        : {}),
    };
    const candidate = new Map(this.bindings);
    candidate.set(binding.chatId, binding);
    this.persist(candidate);
    this.bindings = candidate;
    return cloneBinding(binding);
  }

  migrateLegacy(spaces: SpaceMeta[], currentAppId?: string): number {
    const candidate = new Map(this.bindings);
    const knownSpaces = new Set(
      [...candidate.values()].map((binding) => binding.spaceId),
    );
    const now = Date.now();
    let migrated = 0;
    for (const space of spaces) {
      if (
        !space.id.startsWith("team/")
        || !space.chatId?.trim()
        || candidate.has(space.chatId)
        || knownSpaces.has(space.id)
      ) {
        continue;
      }
      const hasParticipation = space.participationLevel !== undefined;
      const responseMode: FeishuResponseMode =
        space.mentionsOnly === false && !hasParticipation
          ? "all_messages"
          : "smart";
      const participationLevel = responseMode === "smart"
        ? space.participationLevel ?? "balanced"
        : undefined;
      const boundAppId = currentAppId?.trim() || undefined;
      candidate.set(space.chatId, {
        chatId: space.chatId,
        spaceId: space.id,
        boundAppId,
        state: boundAppId ? "active" : "needs_reconnect",
        responseMode,
        participationLevel,
        replyInThread: space.replyInThread ?? true,
        createdAt: space.createdAt,
        updatedAt: now,
      });
      knownSpaces.add(space.id);
      migrated += 1;
    }
    if (migrated > 0) {
      this.persist(candidate);
      this.bindings = candidate;
    }
    return migrated;
  }

  private upsertPending(
    input: RegisterPendingFeishuGroupInput,
    allowDisconnected: boolean,
  ): FeishuGroupBinding {
    assertPendingInput(input);
    const previous = this.bindings.get(input.chatId);
    if (previous && previous.spaceId !== input.spaceId) {
      throw new Error(`Feishu chat ${input.chatId} is already bound`);
    }
    const sameSpace = [...this.bindings.values()].find(
      (binding) => binding.spaceId === input.spaceId,
    );
    if (sameSpace && sameSpace.chatId !== input.chatId) {
      throw new Error(`Feishu space ${input.spaceId} is already bound`);
    }
    if (previous?.state === "disconnected" && !allowDisconnected) {
      return cloneBinding(previous);
    }
    if (
      previous?.state === "active"
      && previous.boundAppId === input.boundAppId
    ) {
      return cloneBinding(previous);
    }
    if (
      previous?.state === "pending_confirmation"
      && previous.boundAppId === input.boundAppId
      && previous.spaceId === input.spaceId
    ) {
      return cloneBinding(previous);
    }
    const now = Date.now();
    const binding: FeishuGroupBinding = {
      ...input,
      state: "pending_confirmation",
      responseMode: "mentions_only",
      participationLevel: undefined,
      replyInThread: true,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      confirmationPrompt: undefined,
    };
    const candidate = new Map(this.bindings);
    candidate.set(binding.chatId, binding);
    this.persist(candidate);
    this.bindings = candidate;
    return cloneBinding(binding);
  }

  private load(): {
    bindings: Map<string, FeishuGroupBinding>;
    needsMigration: boolean;
  } {
    if (!existsSync(this.configPath)) {
      return { bindings: new Map(), needsMigration: false };
    }
    const parsed = JSON.parse(
      readFileSync(this.configPath, "utf8"),
    ) as FeishuGroupBindingsFile;
    if (
      (parsed.version !== 1 && parsed.version !== 2)
      || !Array.isArray(parsed.bindings)
    ) {
      throw new Error("Unsupported Feishu group binding registry");
    }
    const map = new Map<string, FeishuGroupBinding>();
    const spaces = new Set<string>();
    for (const candidate of parsed.bindings) {
      const binding = parseBinding(candidate);
      if (map.has(binding.chatId) || spaces.has(binding.spaceId)) {
        throw new Error("Duplicate Feishu group binding");
      }
      map.set(binding.chatId, binding);
      spaces.add(binding.spaceId);
    }
    return {
      bindings: map,
      needsMigration: parsed.version === 1,
    };
  }

  private persist(bindings: Map<string, FeishuGroupBinding>): void {
    const configDir = dirname(this.configPath);
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    const temporaryPath =
      `${this.configPath}.${process.pid}.${randomUUID()}.tmp`;
    const file: FeishuGroupBindingsFileV2 = {
      version: 2,
      bindings: [...bindings.values()].sort((a, b) =>
        a.chatId.localeCompare(b.chatId)
      ),
    };
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
    } catch (error) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // A successful rename consumes the temporary path.
      }
      throw error;
    }
  }
}

const MAX_STORED_ERROR_LENGTH = 500;

function normalizeError(error: unknown): string {
  const normalized = String(error ?? "Unknown error")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.slice(0, MAX_STORED_ERROR_LENGTH);
}

const BINDING_STATES: FeishuGroupBindingState[] = [
  "pending_confirmation",
  "active",
  "disconnected",
  "needs_reconnect",
];
const RESPONSE_MODES: FeishuResponseMode[] = [
  "mentions_only",
  "smart",
  "all_messages",
];
const PARTICIPATION_LEVELS: GroupParticipationLevel[] = [
  "reserved",
  "balanced",
  "active",
];
const TEST_STATUSES: FeishuBindingTestStatus[] = ["succeeded", "failed"];
const PROMPT_STATUSES: FeishuConfirmationPromptStatus[] = [
  "attempting",
  "sent",
  "failed",
];

function assertConnectionInput(input: ConnectFeishuGroupInput): void {
  if (
    !input.chatId.trim()
    || !isSpaceId(input.spaceId)
    || !input.spaceId.startsWith("team/")
    || !RESPONSE_MODES.includes(input.responseMode)
    || (input.participationLevel !== undefined
      && !PARTICIPATION_LEVELS.includes(input.participationLevel))
    || typeof input.replyInThread !== "boolean"
  ) {
    throw new Error("Invalid Feishu group connection");
  }
}

function assertPendingInput(input: RegisterPendingFeishuGroupInput): void {
  if (
    !input.chatId.trim()
    || !isSpaceId(input.spaceId)
    || !input.spaceId.startsWith("team/")
    || (input.boundAppId !== undefined && !input.boundAppId.trim())
  ) {
    throw new Error("Invalid pending Feishu group");
  }
}

function cloneBinding(binding: FeishuGroupBinding): FeishuGroupBinding {
  return {
    ...binding,
    confirmationPrompt: binding.confirmationPrompt
      ? { ...binding.confirmationPrompt }
      : undefined,
  };
}

function parseBinding(candidate: unknown): FeishuGroupBinding {
  if (!candidate || typeof candidate !== "object") {
    throw new Error("Invalid Feishu group binding");
  }
  const binding = candidate as Partial<FeishuGroupBinding>;
  if (
    typeof binding.chatId !== "string"
    || !binding.chatId.trim()
    || typeof binding.spaceId !== "string"
    || !isSpaceId(binding.spaceId)
    || !binding.spaceId.startsWith("team/")
    || typeof binding.state !== "string"
    || !BINDING_STATES.includes(binding.state as FeishuGroupBindingState)
    || typeof binding.responseMode !== "string"
    || !RESPONSE_MODES.includes(binding.responseMode as FeishuResponseMode)
    || (binding.participationLevel !== undefined
      && !PARTICIPATION_LEVELS.includes(binding.participationLevel))
    || typeof binding.replyInThread !== "boolean"
    || !Number.isFinite(binding.createdAt)
    || !Number.isFinite(binding.updatedAt)
    || (binding.boundAppId !== undefined
      && typeof binding.boundAppId !== "string")
    || (binding.lastVerifiedAt !== undefined
      && !Number.isFinite(binding.lastVerifiedAt))
    || (
      binding.confirmationPrompt !== undefined
      && (
        !binding.confirmationPrompt
        || typeof binding.confirmationPrompt !== "object"
        || !Number.isFinite(binding.confirmationPrompt.lastAttemptAt)
        || typeof binding.confirmationPrompt.status !== "string"
        || !PROMPT_STATUSES.includes(binding.confirmationPrompt.status)
        || (
          binding.confirmationPrompt.lastError !== undefined
          && typeof binding.confirmationPrompt.lastError !== "string"
        )
      )
    )
    || (binding.lastTestAt !== undefined
      && !Number.isFinite(binding.lastTestAt))
    || (binding.lastTestStatus !== undefined
      && !TEST_STATUSES.includes(binding.lastTestStatus))
    || (binding.lastError !== undefined
      && typeof binding.lastError !== "string")
  ) {
    throw new Error("Invalid Feishu group binding");
  }
  return cloneBinding(binding as FeishuGroupBinding);
}
