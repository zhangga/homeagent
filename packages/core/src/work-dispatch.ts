import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { isSpaceId, type SpaceId, type WorkMessage } from "@homeagent/shared";
import { assertLocalStatePath, writeAtomicStateFile } from "./durable-file.ts";
import { isResolvedExecutionPlan, isProviderExecution } from "./execution-plan.ts";
import { isTaskRunSkillEvidence } from "./task-runs.ts";
import type { StartChatRunInput } from "./chat-runs.ts";
import type { ProviderId, CodexReasoningEffort } from "@homeagent/llm";

export interface WorkRoutingPlan {
  version: 1;
  provider?: ProviderId;
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
  instruction: string;
  maxTokens: number;
  timeoutMs: number;
  candidates: { id: string; title: string; updatedAt: number }[];
}

export type WorkInputState = "received" | "preparing" | "waiting" | "planned" | "dispatched" | "settled" | "interrupted" | "cancelled";
export type WorkOperation = "chat" | "chat-recovery" | "new" | "followup" | "status" | "cancel" | "pause" | "resume" | "clarify";
export interface WorkInput {
  version: 1;
  id: string;
  connector: string;
  appId: string;
  bindingId?: string;
  space: SpaceId;
  message: WorkMessage;
  sequence: number;
  revision: number;
  state: WorkInputState;
  workItemId?: string;
  operation?: WorkOperation;
  /** Target resolved at intake. A delayed control must never select a newer conversation. */
  chatRecovery?: { operation: "retry" | "resend"; runId?: string; attempts?: number; cardMessageId?: string };
  routing?: WorkRoutingPlan;
  plan?: StartChatRunInput;
  response?: { kind: "answer"; question: string }
    | { kind: "work-plan"; question: string; instruction: string }
    | { kind: "work-replan"; question: string; instruction: string }
    | { kind: "remember" | "static"; text: string };
  runId?: string;
  /** Stable list shown to this actor, for subsequent ordinal controls. */
  presentedItemIds?: string[];
  receipt?: { text: string; status: "pending" | "sent"; messageId?: string };
  updatedAt: number;
}
export interface AcceptWorkInput {
  connector: string;
  appId?: string;
  bindingId?: string;
  space: SpaceId;
  message: WorkMessage;
  chatRecovery?: WorkInput["chatRecovery"];
}

export type WorkInputSummary = Omit<WorkInput, "message" | "plan" | "response" | "routing" | "receipt"> & {
  message: Omit<WorkMessage, "text" | "docLinks">;
  receipt?: { status: "pending" | "sent"; messageId?: string };
};

// Matches the existing material ingestion envelope; never truncate accepted input.
export const MAX_WORK_INPUT_CHARACTERS = 20 * 1024 * 1024;
const STATES = new Set<WorkInputState>(["received", "preparing", "waiting", "planned", "dispatched", "settled", "interrupted", "cancelled"]);
const ID = /^input_[a-f0-9]{64}$/;
const bounded = (value: unknown, max = 512): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
const optional = (value: unknown, max = 512): boolean => value === undefined || bounded(value, max);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export function workInputId(input: AcceptWorkInput): string {
  return `input_${createHash("sha256").update(JSON.stringify([
    input.connector, input.appId ?? "", input.message.chatId, input.message.messageId,
  ])).digest("hex")}`;
}

function valid(input: WorkInput): boolean {
  const m = input.message;
  return input.version === 1 && ID.test(input.id) && isSpaceId(input.space)
    && bounded(input.connector) && typeof input.appId === "string" && input.appId.length <= 512
    && optional(input.bindingId) && optional(input.workItemId) && optional(input.runId)
    && (input.operation === undefined || ["chat", "chat-recovery", "new", "followup", "status", "cancel", "pause", "resume", "clarify"].includes(input.operation))
    && (input.routing === undefined || (input.routing.version === 1
      && (input.routing.provider === undefined || ["gateway", "claude", "codex", "trae-cli"].includes(input.routing.provider))
      && optional(input.routing.model, 200) && bounded(input.routing.instruction, 20_000)
      && (input.routing.reasoningEffort === undefined || ["minimal", "low", "medium", "high", "xhigh"].includes(input.routing.reasoningEffort))
      && Number.isSafeInteger(input.routing.maxTokens) && input.routing.maxTokens > 0
      && Number.isSafeInteger(input.routing.timeoutMs) && input.routing.timeoutMs > 0
      && Array.isArray(input.routing.candidates) && input.routing.candidates.length <= 100
      && input.routing.candidates.every(candidate => bounded(candidate.id) && bounded(candidate.title, 200) && finite(candidate.updatedAt))))
    && Number.isSafeInteger(input.sequence) && input.sequence > 0
    && Number.isSafeInteger(input.revision) && input.revision > 0 && STATES.has(input.state)
    && finite(input.updatedAt) && !!m && m.kind === "message"
    && ["p2p", "group"].includes(m.chatType) && bounded(m.eventId) && bounded(m.chatId)
    && bounded(m.senderId) && bounded(m.messageId) && finite(m.createdAt)
    && typeof m.mentionsBot === "boolean" && typeof m.text === "string" && m.text.length <= MAX_WORK_INPUT_CHARACTERS
    && optional(m.threadId) && optional(m.rootMessageId) && optional(m.parentMessageId) && optional(m.messageType)
    && (input.operation === "chat-recovery" ? !!input.chatRecovery && input.connector === "feishu"
      && ["retry", "resend"].includes(input.chatRecovery.operation)
      && (input.chatRecovery.cardMessageId === undefined || (bounded(input.chatRecovery.cardMessageId) && !!input.chatRecovery.runId
        && input.chatRecovery.cardMessageId === m.parentMessageId))
      && (input.chatRecovery.runId === undefined ? input.chatRecovery.attempts === undefined
        : bounded(input.chatRecovery.runId) && Number.isSafeInteger(input.chatRecovery.attempts) && input.chatRecovery.attempts! >= 0)
      : input.chatRecovery === undefined)
    && (m.docLinks === undefined || (Array.isArray(m.docLinks) && m.docLinks.length <= 200 && m.docLinks.every(url => bounded(url, 16_384))))
    && workInputId(input) === input.id
    && (input.presentedItemIds === undefined || (Array.isArray(input.presentedItemIds) && input.presentedItemIds.length <= 200 && input.presentedItemIds.every(id => bounded(id))))
    && (!input.receipt || (bounded(input.receipt.text, 100_000) && ["pending", "sent"].includes(input.receipt.status) && optional(input.receipt.messageId)))
    && (!input.response || (input.response.kind === "answer" ? bounded(input.response.question, MAX_WORK_INPUT_CHARACTERS)
      : input.response.kind === "work-plan" || input.response.kind === "work-replan" ? bounded(input.response.question, MAX_WORK_INPUT_CHARACTERS) && bounded(input.response.instruction, 20_000)
      : ["remember", "static"].includes(input.response.kind) && bounded(input.response.text, 100_000)))
    && (!input.plan || (input.plan.space === input.space && input.plan.chatId === m.chatId
      && input.plan.messageId === m.messageId && input.plan.author === m.senderId
      && input.plan.input === m.text && input.plan.workItemId === input.workItemId
      && input.plan.dispatchKey === input.id && input.plan.launchAdmission === "pending" && input.plan.trigger === "message"
      && optional(input.plan.agentId) && optional(input.plan.model, 200)
      && (input.plan.timeoutMs === undefined || (Number.isSafeInteger(input.plan.timeoutMs) && input.plan.timeoutMs > 0))
      && (input.plan.execution === undefined || isProviderExecution(input.plan.execution))
      && (input.plan.skillEvidence === undefined || isTaskRunSkillEvidence(input.plan.skillEvidence))
      && isResolvedExecutionPlan(input.plan.executionPlan)))
    && (!["planned", "dispatched"].includes(input.state) || !!input.plan);
}

/** Local inbox, not Raw or knowledge. Each input is an independent atomic file. */
export class WorkDispatchStore {
  private readonly directory: string;
  private inputs = new Map<string, WorkInput>();
  private sequence = 0;

  constructor(private readonly dataDir: string) {
    this.directory = join(dataDir, "config", "work-dispatch");
    assertLocalStatePath(dataDir, this.directory);
    if (!existsSync(this.directory)) return;
    for (const name of readdirSync(this.directory)) {
      if (!name.endsWith(".json")) continue; // Incomplete temporary writes are not commits.
      const id = name.slice(0, -5);
      if (!ID.test(id)) throw new Error("Invalid work input file");
      const path = this.path(id);
      // Three full text copies (message, frozen plan, response) may each JSON-escape to six bytes per character.
      if (statSync(path).size > MAX_WORK_INPUT_CHARACTERS * 24) throw new Error("Work input file too large");
      const input = JSON.parse(readFileSync(path, "utf8")) as WorkInput;
      if (!valid(input) || input.id !== id) throw new Error("Invalid work input state");
      this.inputs.set(id, structuredClone(input));
      this.sequence = Math.max(this.sequence, input.sequence);
    }
  }

  private path(id: string): string {
    if (!ID.test(id)) throw new Error("Invalid work input id");
    const path = join(this.directory, `${id}.json`);
    assertLocalStatePath(this.dataDir, path);
    return path;
  }

  private commit(input: WorkInput): WorkInput {
    if (!valid(input)) throw new Error("Invalid work input state");
    writeAtomicStateFile(this.path(input.id), `${JSON.stringify(input)}\n`);
    this.inputs.set(input.id, structuredClone(input));
    this.sequence = Math.max(this.sequence, input.sequence);
    return structuredClone(input);
  }

  accept(input: AcceptWorkInput): WorkInput {
    const id = workInputId(input);
    const previous = this.get(id);
    // Platform redelivery may change metadata. It must never overwrite accepted content.
    if (previous) return previous;
    return this.commit({ ...structuredClone(input), ...(input.chatRecovery ? { operation: "chat-recovery" as const } : {}),
      appId: input.appId ?? "", version: 1, id,
      sequence: this.sequence + 1, revision: 1, state: "received", updatedAt: Date.now() });
  }

  get(id: string): WorkInput | undefined {
    const input = this.inputs.get(id);
    return input ? structuredClone(input) : undefined;
  }

  list(space?: SpaceId): WorkInput[] {
    return [...this.inputs.values()].filter(input => space === undefined || input.space === space)
      .sort((a, b) => a.sequence - b.sequence).map(input => structuredClone(input));
  }

  /** Routing/status queries do not copy every retained message body or execution plan. */
  summaries(space?: SpaceId): WorkInputSummary[] {
    return [...this.inputs.values()].filter(input => space === undefined || input.space === space)
      .sort((a, b) => a.sequence - b.sequence).map(input => {
        const { message, plan: _plan, response: _response, routing: _routing, receipt, ...summary } = input;
        const { text: _text, docLinks: _links, ...source } = message;
        return structuredClone({ ...summary, message: source, ...(receipt ? { receipt: { status: receipt.status, messageId: receipt.messageId } } : {}) });
      });
  }

  page(space: SpaceId, afterSequence = 0, limit = 100): WorkInput[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || !Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new Error("Invalid work input page");
    return this.summaries(space).filter(input => input.sequence > afterSequence).slice(0, limit).map(input => this.get(input.id)!);
  }

  update(id: string, expectedRevision: number, change: Partial<Pick<WorkInput,
    "state" | "workItemId" | "operation" | "chatRecovery" | "routing" | "plan" | "response" | "runId" | "presentedItemIds" | "receipt">>): WorkInput {
    const input = this.get(id);
    if (!input || input.revision !== expectedRevision) throw new Error("Work input revision conflict");
    if (input.chatRecovery && "chatRecovery" in change && JSON.stringify(input.chatRecovery) !== JSON.stringify(change.chatRecovery)) {
      throw new Error("Chat recovery target is immutable");
    }
    if (input.plan && "plan" in change && JSON.stringify(input.plan) !== JSON.stringify(change.plan)) {
      throw new Error("Work input plan is immutable");
    }
    if (input.runId && "runId" in change && input.runId !== change.runId) throw new Error("Work input Run is immutable");
    if (input.plan && "response" in change && JSON.stringify(input.response) !== JSON.stringify(change.response)) throw new Error("Work input response plan is immutable");
    if (["settled", "interrupted", "cancelled"].includes(input.state) && change.state && change.state !== input.state) {
      throw new Error("Terminal work input cannot be replayed");
    }
    return this.commit({ ...input, ...structuredClone(change), revision: input.revision + 1, updatedAt: Date.now() });
  }

  hasPending(space: SpaceId): boolean {
    return [...this.inputs.values()].some(input => input.space === space && !["settled", "interrupted", "cancelled"].includes(input.state));
  }

  restoreLocalSnapshot(inputs: WorkInput[]): void {
    for (const input of inputs) if (!valid(input)) throw new Error("Invalid work input snapshot");
    for (const input of inputs) this.commit(input);
  }

  removeBySpace(space: SpaceId): void {
    if (this.hasPending(space)) throw new Error("Space has pending work inputs");
    this.remove(this.list(space));
  }

  /** Retraction removes the operational source copy before the Raw tombstone commits. */
  removeByMessage(space: SpaceId, chatId: string, messageId: string): void {
    this.remove(this.list(space).filter(input => input.message.chatId === chatId && input.message.messageId === messageId));
  }

  private remove(inputs: WorkInput[]): void {
    try {
      for (const input of inputs) {
        unlinkSync(this.path(input.id));
        this.inputs.delete(input.id);
      }
    } catch (error) { this.restoreLocalSnapshot(inputs); throw error; }
  }
}
