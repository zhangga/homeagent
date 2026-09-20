import { expect, test } from "bun:test";
import { collectCodexExecutionEvidence, codexExecutionEvidenceFromLine, isExecutionEvidence, appendExecutionEvidence } from "./execution-evidence.ts";

const event = (command: string, aggregated_output: string, exit_code = 0) => JSON.stringify({
  type: "item.completed", item: { type: "command_execution", command, aggregated_output, exit_code },
});

test("parses one completed Codex tool line for live progress without retaining payloads", () => {
  const parsed = codexExecutionEvidenceFromLine(event(
    'lark-cli im +messages-search --as user --query "sensitive" --json',
    JSON.stringify({ ok: true, identity: "user", data: { messages: [{ body: "private" }], has_more: true } }),
  ));
  expect(parsed).toEqual({
    kind: "command", status: "completed", exitCode: 0,
    lark: { operation: "messages-search", requestedIdentity: "user", reportedIdentity: "user", ok: true, count: 1, hasMore: true },
  });
  expect(JSON.stringify(parsed)).not.toMatch(/sensitive|private/);
});

test("captures bounded CLI metadata without commands, credentials, names or message bodies", () => {
  const evidence = collectCodexExecutionEvidence(event(
    'lark-cli im +chat-search --as user --query "private-query" --json',
    JSON.stringify({ ok: true, identity: "user", data: { chats: [{ name: "private-name" }], has_more: false }, token: "secret" }),
  ));
  expect(evidence.events).toEqual([{
    kind: "command", status: "completed", exitCode: 0,
    lark: { operation: "chat-search", requestedIdentity: "user", reportedIdentity: "user", ok: true, count: 1, hasMore: false },
  }]);
  expect(JSON.stringify(evidence)).not.toMatch(/private|secret|query/);
  expect(isExecutionEvidence({ calls: [evidence], truncated: false })).toBe(true);
});

test("shell chains and ambiguous identities do not masquerade as verified lark calls", () => {
  const evidence = collectCodexExecutionEvidence(event('echo lark-cli im +chat-list --as user; exit 0', '{"ok":true,"identity":"user"}'));
  expect(evidence.events[0]?.lark).toBeUndefined();
  expect(collectCodexExecutionEvidence(event('lark-cli im +chat-list --json', '{}')).events[0]?.lark)
    .toEqual({ operation: "chat-list", requestedIdentity: "unspecified" });
});

test("evidence collections truncate and reject injected persistence fields", () => {
  const one = event('lark-cli im +chat-list --as bot', '{}', 1);
  const evidence = collectCodexExecutionEvidence(Array(40).fill(one).join('\n'));
  expect(evidence.events).toHaveLength(32);
  expect(evidence.truncated).toBe(true);
  expect(evidence.events[0]?.status).toBe("failed");
  const aggregate = { calls: [], truncated: false };
  for (let i = 0; i < 20; i++) appendExecutionEvidence(aggregate, evidence);
  expect(aggregate.calls).toHaveLength(16);
  expect(aggregate.truncated).toBe(true);
  expect(isExecutionEvidence(aggregate)).toBe(true);
  expect(isExecutionEvidence({ ...aggregate, secret: "token" })).toBe(false);
  expect(isExecutionEvidence({ calls: [{ ...evidence, command: "secret" }], truncated: false })).toBe(false);
  expect(isExecutionEvidence({ ...aggregate, preparationFailure: { stage: "native-session", reason: "protected-root-readable", exitCode: 75, stderr: "secret" } })).toBe(false);
  expect(isExecutionEvidence({ calls: [{ ...evidence, events: [{ kind: ["command"], status: "completed" }] }], truncated: false })).toBe(false);
});

test("quoted option values and malformed shell tokens cannot fabricate an identity", () => {
  const inspect = (command: string) => collectCodexExecutionEvidence(event(command, '{}')).events[0]?.lark;
  expect(inspect('lark-cli im +chat-search --query "--as" --as bot')?.requestedIdentity).toBe("bot");
  expect(inspect('lark-cli im +chat-search --query "--as=user"')?.requestedIdentity).toBe("unspecified");
  expect(inspect('lark-cli im +chat-list --as user --as bot')).toBeUndefined();
  expect(inspect('lark-cli im +chat-list --as "user')).toBeUndefined();
  expect(inspect('lark-cli im +chat-list --as u"ser"')).toBeUndefined();
});

test("execution mode evidence distinguishes no sandbox and unverified model calls", () => {
  const execution = {
    executionMode: "local-full-access", sandboxCheck: "not-applicable", effectiveSandbox: "danger-full-access",
    process: "started", model: "unknown",
  };
  const call = { source: "codex-jsonl", events: [], truncated: false, execution };
  expect(isExecutionEvidence({ calls: [call], truncated: false })).toBe(true);
  for (const patch of [
    { sandboxCheck: "passed" }, { effectiveSandbox: "permission-profile" }, { executionMode: "future" },
    { process: "not-started", model: "verified" }, { command: "secret" },
  ]) {
    expect(isExecutionEvidence({ calls: [{ ...call, execution: { ...execution, ...patch } }], truncated: false })).toBe(false);
  }
});
