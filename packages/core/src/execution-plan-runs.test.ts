import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveExecutionPlan, type ResolvedExecutionPlan } from "./execution-plan.ts";
import { ChatRunStore, topicNativeSessionCompatibilityKey } from "./chat-runs.ts";
import { TaskRunStore } from "./task-runs.ts";
import type { Task } from "./tasks.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ha-plan-v2-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const space = "team/oc_plan" as const;
const full = (kind: "chat" | "task"): ResolvedExecutionPlan => ({
  version: 2, agentRevisionId: "agent_revision_full", instruction: "frozen", provider: "codex", workdir: "C:\\fixture",
  execution: { permission: "full", executionMode: "local-full-access", workdir: "C:\\fixture", skills: [] },
  localExecution: kind === "chat"
    ? { grantId: "local_execution_grant_00000000-0000-4000-8000-000000000001", kind, scope: { spaceId: space, policyHash: "a".repeat(64) } }
    : { grantId: "local_execution_grant_00000000-0000-4000-8000-000000000001", kind },
});
const task: Task = { id: "task_plan", name: "fixture", topic: "fixture", space, cadence: "daily", hour: 8, dayOfWeek: 1,
  enabled: true, notify: false, distillOnRun: false, timeoutMinutes: 5, createdAt: 1, updatedAt: 1 };

test("Run stores expose only nonterminal local grant references, including queued and approval work", () => {
  const chats = new ChatRunStore(dir, { recoverInterrupted: false });
  const tasks = new TaskRunStore(dir, { recoverInterrupted: false });
  const chatPlan = full("chat");
  const taskPlan = full("task");
  const chat = chats.start({ space, input: "fixture", trigger: "message", agentId: "agent_fixture", executionPlan: chatPlan, startedAt: 1 });
  const pending = tasks.start({ task, trigger: "manual", agentId: "agent_fixture", provider: "codex", executionPlan: taskPlan,
    distill: false, startedAt: 1, approvalRequired: true });
  expect(chats.referencedLocalExecutionGrantIds()).toEqual(new Set([chatPlan.localExecution!.grantId]));
  expect(tasks.referencedLocalExecutionGrantIds()).toEqual(new Set([taskPlan.localExecution!.grantId]));
  chats.begin(chat.id, 2);
  expect(chats.referencedLocalExecutionGrantIds().size).toBe(1);
  const copy = tasks.referencedLocalExecutionGrantIds(); copy.clear();
  expect(tasks.referencedLocalExecutionGrantIds().size).toBe(1);
  chats.succeed(chat.id, { finishedAt: 3, output: "done" });
  tasks.cancel(pending.id, { finishedAt: 3, error: "cancelled" });
  expect(chats.referencedLocalExecutionGrantIds().size).toBe(0);
  expect(tasks.referencedLocalExecutionGrantIds().size).toBe(0);
  expect(new ChatRunStore(dir).get(chat.id)?.executionPlan).toEqual(chatPlan);
  expect(new TaskRunStore(dir).get(pending.id)?.executionPlan).toEqual(taskPlan);
});

test("Chat v8 freezes authorization and imports only inert terminal archive plans", () => {
  const store = new ChatRunStore(dir);
  const plan = full("chat");
  const input = { space, input: "fixture", trigger: "message" as const, agentId: "agent_fixture", executionPlan: plan, startedAt: 1 };
  const run = store.start(input);
  expect(JSON.parse(readFileSync(join(dir, "config", "chat-runs.json"), "utf8")).version).toBe(8);
  expect(new ChatRunStore(dir).get(run.id)?.executionPlan).toEqual(plan);
  expect(() => store.start({ ...input, executionPlan: full("task") })).toThrow();
  expect(() => store.start({ ...input, space: "team/other" })).toThrow();
  store.succeed(run.id, { finishedAt: 2, output: "done" });
  const archived = archiveExecutionPlan(plan);
  const destination = new ChatRunStore(join(dir, "restore"));
  destination.restore([{ ...store.get(run.id)!, executionPlan: archived }]);
  expect(new ChatRunStore(join(dir, "restore")).get(run.id)?.executionPlan).toEqual(archived);
  // Runtime validation is mandatory even for untyped callers.
  expect(() => Reflect.apply(store.start, store, [{ ...input, executionPlan: archived }])).toThrow();
  expect(() => destination.restore([{ ...run, id: "chat_bad", executionPlan: archived }])).toThrow();
  expect(topicNativeSessionCompatibilityKey({ executionPlan: plan })).not.toBe(topicNativeSessionCompatibilityKey({ executionPlan: { ...plan, localExecution: { ...plan.localExecution!, grantId: "local_execution_grant_00000000-0000-4000-8000-000000000002" } } }));
});

test("Task v13 preserves per-Run approval with frozen local references, and archive intent cannot be started", () => {
  const store = new TaskRunStore(dir);
  const plan = full("task");
  const input = { task, trigger: "manual" as const, agentId: "agent_fixture", provider: "codex" as const, executionPlan: plan, distill: false, startedAt: 1 };
  expect(() => store.start(input)).toThrow();
  const run = store.start({ ...input, approvalRequired: true });
  expect(run.status).toBe("awaiting_approval");
  expect(new TaskRunStore(dir).get(run.id)?.executionPlan).toEqual(plan);
  expect(JSON.parse(readFileSync(join(dir, "config", "task-runs.json"), "utf8")).version).toBe(13);
  expect(() => store.start({ ...input, approvalRequired: true, executionPlan: full("chat") })).toThrow();
  const terminal = store.cancel(run.id, { finishedAt: 2, error: "cancelled" })!;
  const archived = archiveExecutionPlan(plan);
  const target = new TaskRunStore(join(dir, "restore"));
  target.restore([{ ...terminal, executionPlan: archived }]);
  expect(new TaskRunStore(join(dir, "restore")).get(run.id)?.executionPlan).toEqual(archived);
  expect(() => Reflect.apply(store.start, store, [{ ...input, approvalRequired: true, executionPlan: archived }])).toThrow();
});

test.each(["chat", "task"])("future %s history refuses startup without overwriting existing data", (kind) => {
  mkdirSync(join(dir, "config"));
  const path = join(dir, "config", `${kind}-runs.json`);
  const original = JSON.stringify({ version: 99, runs: {} }); writeFileSync(path, original);
  expect(() => kind === "chat" ? new ChatRunStore(dir) : new TaskRunStore(dir)).toThrow();
  expect(readFileSync(path, "utf8")).toBe(original);
});

test("current Task history requires a runs object and never silently replaces a malformed root", () => {
  mkdirSync(join(dir, "config"));
  const path = join(dir, "config", "task-runs.json");
  for (const runs of [undefined, [], "bad"]) {
    const original = JSON.stringify({ version: 13, runs }); writeFileSync(path, original);
    expect(() => new TaskRunStore(dir)).toThrow();
    expect(readFileSync(path, "utf8")).toBe(original);
  }
});

test("Chat terminal times cannot roll back before execution and make newly versioned history unreadable", () => {
  const store = new ChatRunStore(dir);
  const run = store.start({ space, input: "clock fixture", trigger: "message", startedAt: 100 });
  store.begin(run.id, 200);
  expect(store.succeed(run.id, { finishedAt: 110, output: "done" })?.finishedAt).toBe(200);
  expect(new ChatRunStore(dir).get(run.id)?.finishedAt).toBe(200);
});

test.each([false, true])("v2 topic heads survive restart only after delivery (%s), and changed consent starts a new chain", (delivered) => {
  let store = new ChatRunStore(dir);
  const plan = full("chat");
  const input = (executionPlan: ResolvedExecutionPlan) => ({ space, chatId: "oc_plan", agentId: "agent_fixture", input: "fixture", trigger: "message" as const,
    executionPlan, topicNativeSession: { kind: "feishu-topic" as const, chatId: "oc_plan", rootMessageId: "om_root", provider: "codex" as const,
      compatibilityKey: topicNativeSessionCompatibilityKey({ agentId: "agent_fixture", executionPlan }) } });
  const first = store.start({ ...input(plan), startedAt: 100 });
  store.begin(first.id, 101);
  expect(store.prepareTopicNativeSession(first.id)).toEqual({ mode: "start" });
  const sessionId = "11111111-2222-4333-8444-555555555555";
  store.succeed(first.id, { finishedAt: 110, output: "fixture", nativeSessionId: sessionId });
  if (delivered) store.deliverySent(first.id, 114);
  store = new ChatRunStore(dir);
  const followup = store.start({ ...input(plan), startedAt: 115 });
  store.begin(followup.id, 116);
  expect(store.prepareTopicNativeSession(followup.id)).toEqual(delivered ? { mode: "fork", id: sessionId } : { mode: "start" });
  store.cancel(followup.id, { finishedAt: 117, error: { kind: "cancelled", message: "offline fixture" } });
  const changed = { ...plan, localExecution: { ...plan.localExecution!, grantId: "local_execution_grant_00000000-0000-4000-8000-000000000002" } };
  const newChain = store.start({ ...input(changed), startedAt: 118 });
  store.begin(newChain.id, 119);
  expect(store.prepareTopicNativeSession(newChain.id)).toEqual({ mode: "start" });
});
