import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkDispatchStore, MAX_WORK_INPUT_CHARACTERS } from "./work-dispatch.ts";
import type { WorkMessage } from "@homeagent/shared";

const message: WorkMessage = { kind: "message", eventId: "event", chatType: "p2p", chatId: "chat",
  senderId: "user", text: "完整输入", messageId: "message", mentionsBot: true, createdAt: 1 };

test("durable intake preserves full input, deduplicates source identity and isolates mutable snapshots", () => {
  const directory = mkdtempSync(join(tmpdir(), "ha-intake-"));
  try {
    const store = new WorkDispatchStore(directory);
    const original = { ...message, text: "长".repeat(100_001), docLinks: ["https://example.com"] };
    const input = store.accept({ connector: "feishu", space: "personal/user", message: original });
    original.docLinks[0] = "changed";
    input.message.text = "changed";
    expect(store.get(input.id)?.message.text.length).toBe(100_001);
    expect(store.get(input.id)?.message.docLinks).toEqual(["https://example.com"]);
    const duplicate = store.accept({ connector: "feishu", space: "personal/user", message: { ...message, text: "edited" } });
    expect(duplicate.id).toBe(input.id);
    expect(duplicate.message.text.length).toBe(100_001);
    const reopened = new WorkDispatchStore(directory);
    expect(reopened.get(input.id)?.message.text.length).toBe(100_001);
    reopened.update(input.id, 1, { state: "preparing" });
    expect(() => reopened.update(input.id, 1, { state: "settled" })).toThrow("revision conflict");
    expect(new WorkDispatchStore(directory).get(input.id)?.state).toBe("preparing");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("intake write failure does not accept an input, and an invalid envelope is rejected without truncation", () => {
  const directory = mkdtempSync(join(tmpdir(), "ha-intake-"));
  try {
    const store = new WorkDispatchStore(directory);
    mkdirSync(join(directory, "config"));
    writeFileSync(join(directory, "config", "work-dispatch"), "blocks writes");
    expect(() => store.accept({ connector: "feishu", space: "personal/user", message })).toThrow();
    expect(store.list()).toHaveLength(0);
    expect(() => store.accept({ connector: "feishu", space: "personal/user", message: { ...message, text: "a".repeat(MAX_WORK_INPUT_CHARACTERS + 1) } })).toThrow();
    expect(store.list()).toHaveLength(0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("validates collection limits, rejects future state and cannot repurpose a committed dispatch", () => {
  const directory = mkdtempSync(join(tmpdir(), "ha-intake-"));
  try {
    const store = new WorkDispatchStore(directory);
    const accepted = store.accept({ connector: "cli", space: "personal/user", message: { ...message, docLinks: Array(200).fill("https://example.com") } });
    expect(() => store.accept({ connector: "cli", space: "personal/user", message: { ...message, messageId: "overflow", docLinks: Array(201).fill("https://example.com") } })).toThrow();
    expect(store.page("personal/user", 0, 1)).toHaveLength(1);
    expect(store.page("personal/user", accepted.sequence, 1)).toHaveLength(0);
    expect("text" in store.summaries()[0]!.message).toBe(false);
    const plan = { space: accepted.space, chatId: message.chatId, messageId: message.messageId,
      author: message.senderId, input: message.text, trigger: "message" as const, dispatchKey: accepted.id,
      launchAdmission: "pending" as const, executionPlan: { version: 1 as const, instruction: "original" } };
    expect(() => store.update(accepted.id, 1, { state: "planned", plan: { ...plan, space: "personal/other" } })).toThrow();
    const planned = store.update(accepted.id, 1, { state: "planned", plan });
    expect(() => store.update(planned.id, planned.revision, { state: "interrupted", plan: undefined })).toThrow("immutable");
    const finished = store.update(planned.id, planned.revision, { state: "settled" });
    expect(() => store.update(finished.id, finished.revision, { state: "received" })).toThrow("cannot be replayed");
    const path = join(directory, "config", "work-dispatch", `${accepted.id}.json`);
    const saved = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...saved, version: 2 }));
    expect(() => new WorkDispatchStore(directory)).toThrow("Invalid work input state");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("chat planning instructions are frozen and recovered with the accepted goal", () => {
  const directory = mkdtempSync(join(tmpdir(), "ha-planning-input-"));
  try {
    const store = new WorkDispatchStore(directory);
    const input = store.accept({ connector: "cli", space: "personal/user", message });
    expect(() => store.update(input.id, input.revision, { response: { kind: "work-plan", question: "目标", instruction: "x".repeat(20_001) } })).toThrow();
    const response = { kind: "work-plan" as const, question: "目标", instruction: "冻结规划指令" };
    const plan = { space: input.space, chatId: message.chatId, messageId: message.messageId,
      author: message.senderId, input: message.text, trigger: "message" as const, dispatchKey: input.id,
      launchAdmission: "pending" as const, executionPlan: { version: 1 as const, instruction: "原始 Agent 指令" } };
    const committed = store.update(input.id, input.revision, { response, plan, state: "planned" });
    response.instruction = "修改后的指令";
    expect(new WorkDispatchStore(directory).get(input.id)?.response).toEqual({ kind: "work-plan", question: "目标", instruction: "冻结规划指令" });
    expect(() => store.update(input.id, committed.revision, { response })).toThrow("immutable");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
