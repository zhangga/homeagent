/** Private local audit metadata. Never persist commands, output, paths or resource names. */
import { isProviderPreparationFailure, type ProviderPreparationFailure } from "./provider-preparation.ts";
import { isCodexExecutionMode, type CodexExecutionMode } from "./codex-execution-policy.ts";
const OPERATIONS = ["chat-list", "chat-search", "chat-messages-list", "messages-search", "messages-mget", "threads-messages-list", "auth-status"] as const;
type Operation = typeof OPERATIONS[number];
type Identity = "user" | "bot";
export interface ToolExecutionEvidence {
  kind: "command" | "file-change" | "mcp" | "web-search";
  status: "completed" | "failed" | "unknown";
  exitCode?: number;
  lark?: {
    operation: Operation;
    requestedIdentity: Identity | "unspecified";
    reportedIdentity?: Identity;
    ok?: boolean;
    count?: number;
    hasMore?: boolean;
  };
}
export interface ProviderExecutionEvidence {
  source: "codex-jsonl";
  events: ToolExecutionEvidence[];
  truncated: boolean;
  execution?: ProviderExecutionMetadata;
}
export interface ProviderExecutionMetadata {
  executionMode: CodexExecutionMode;
  sandboxCheck: "passed" | "failed" | "not-applicable" | "not-checked";
  effectiveSandbox: "permission-profile" | "read-only" | "workspace-write" | "danger-full-access";
  process: "not-started" | "started";
  model: "unknown" | "verified";
}
export interface ExecutionEvidence {
  calls: ProviderExecutionEvidence[];
  truncated: boolean;
  preparationFailure?: ProviderPreparationFailure;
}
const MAX_EVENTS = 32;
const MAX_CALLS = 16;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const identity = (value: unknown): value is Identity => value === "user" || value === "bot";
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 1_000_000;
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));

function isExecutionMetadata(value: unknown): value is ProviderExecutionMetadata {
  if (!record(value) || !keys(value, ["executionMode", "sandboxCheck", "effectiveSandbox", "process", "model"])
    || !isCodexExecutionMode(value.executionMode)
    || !["passed", "failed", "not-applicable", "not-checked"].some(item => item === value.sandboxCheck)
    || !["permission-profile", "read-only", "workspace-write", "danger-full-access"].some(item => item === value.effectiveSandbox)
    || !["not-started", "started"].some(item => item === value.process)
    || !["unknown", "verified"].some(item => item === value.model)
    || (value.process === "not-started" && value.model === "verified")) return false;
  if (value.executionMode === "local-full-access") {
    return value.sandboxCheck === "not-applicable" && value.effectiveSandbox === "danger-full-access";
  }
  if (value.effectiveSandbox === "danger-full-access" || value.sandboxCheck === "not-applicable") return false;
  if (value.effectiveSandbox !== "permission-profile") return value.sandboxCheck === "not-checked";
  return value.process !== "started" || value.sandboxCheck === "passed";
}

export function isExecutionEvidence(value: unknown): value is ExecutionEvidence {
  if (!record(value) || !keys(value, ["calls", "truncated", "preparationFailure"]) || typeof value.truncated !== "boolean"
    || (value.preparationFailure !== undefined && !isProviderPreparationFailure(value.preparationFailure))
    || !Array.isArray(value.calls) || value.calls.length > MAX_CALLS) return false;
  return value.calls.every(call => record(call) && keys(call, ["source", "events", "truncated", "execution"])
    && call.source === "codex-jsonl" && typeof call.truncated === "boolean"
    && (call.execution === undefined || isExecutionMetadata(call.execution))
    && Array.isArray(call.events) && call.events.length <= MAX_EVENTS && call.events.every(event => {
      if (!record(event) || !keys(event, ["kind", "status", "exitCode", "lark"])
        || typeof event.kind !== "string" || !["command", "file-change", "mcp", "web-search"].includes(event.kind)
        || typeof event.status !== "string" || !["completed", "failed", "unknown"].includes(event.status)
        || (event.exitCode !== undefined && (!Number.isSafeInteger(event.exitCode) || Math.abs(Number(event.exitCode)) > 2147483648))) return false;
      if (event.lark === undefined) return true;
      const lark = event.lark;
      return event.kind === "command" && record(lark)
        && keys(lark, ["operation", "requestedIdentity", "reportedIdentity", "ok", "count", "hasMore"])
        && OPERATIONS.some(op => op === lark.operation)
        && (identity(lark.requestedIdentity) || lark.requestedIdentity === "unspecified")
        && (lark.reportedIdentity === undefined || identity(lark.reportedIdentity))
        && (lark.ok === undefined || typeof lark.ok === "boolean")
        && (lark.hasMore === undefined || typeof lark.hasMore === "boolean")
        && (lark.count === undefined || count(lark.count));
    }));
}

export function cloneExecutionEvidence(value: ExecutionEvidence): ExecutionEvidence {
  if (!isExecutionEvidence(value)) throw new Error("Invalid execution evidence");
  return structuredClone(value);
}

export function appendExecutionEvidence(target: ExecutionEvidence, call: ProviderExecutionEvidence): void {
  const copied = cloneExecutionEvidence({ calls: [call], truncated: false }).calls[0]!;
  if (target.calls.length < MAX_CALLS) target.calls.push(copied);
  else target.truncated = true;
}

function larkEvidence(command: unknown, output: unknown): ToolExecutionEvidence["lark"] {
  if (typeof command !== "string" || command.length > 16_384) return undefined;
  // Only recognize a single literal command, not shell scripts, pipelines,
  // substitutions or command text printed by echo. Unknown is preferable to a
  // fabricated identity. Encoded commands intentionally remain unclassified.
  let literal = command.trim();
  const wrapper = /^(?:powershell(?:\.exe)?|pwsh(?:\.exe)?)\s+(?:-NoProfile\s+)?-Command\s+(["'])([^\r\n]*)\1$/i.exec(literal);
  if (wrapper) literal = wrapper[2]!;
  if (/[;|&`$<>\r\n]/.test(literal)) return undefined;
  const rawTokens = literal.match(/"[^"\r\n]*"|'[^'\r\n]*'|[^\s"']+/g);
  // Require complete, whitespace-separated tokens. Unmatched quotes and shell
  // concatenation are ambiguous and must not produce an identity assertion.
  if (!rawTokens || rawTokens.join(" ") !== literal.replace(/\s+/g, " ")) return undefined;
  const tokens = rawTokens.map(token => token.replace(/^(["'])(.*)\1$/, "$2"));
  if (!tokens || !/^lark-cli(?:\.exe|\.cmd|\.ps1)?$/i.test(tokens[0] ?? "")) return undefined;
  const op = tokens[1] === "auth" && tokens[2] === "status" ? "auth-status"
    : tokens[1] === "im" ? tokens[2]?.replace(/^\+/, "") : undefined;
  const operation = OPERATIONS.find(candidate => candidate === op);
  if (!operation) return undefined;
  const asArgs: Array<string | undefined> = [];
  for (let index = 3; index < tokens.length; index++) {
    const token = rawTokens[index]!;
    if (token === "--as") asArgs.push(tokens[++index]);
    else if (token.startsWith("--as=")) asArgs.push(token.slice(5));
    else if (token.startsWith("-") && !token.includes("=")) {
      // A quoted value such as --query "--as" is not an identity flag.
      const next = rawTokens[index + 1];
      if (next !== undefined && !next.startsWith("-")) index++;
    }
  }
  if (asArgs.length > 1 || (asArgs.length === 1 && !identity(asArgs[0]))) return undefined;
  const result: NonNullable<ToolExecutionEvidence["lark"]> = {
    operation, requestedIdentity: identity(asArgs[0]) ? asArgs[0] : "unspecified",
  };
  if (typeof output !== "string" || output.length > 262_144) return result;
  try {
    const root: unknown = JSON.parse(output);
    if (!record(root)) return result;
    if (identity(root.identity)) result.reportedIdentity = root.identity;
    if (typeof root.ok === "boolean") result.ok = root.ok;
    const data = record(root.data) ? root.data : root;
    if (typeof data.has_more === "boolean") result.hasMore = data.has_more;
    const items = operation.startsWith("chat-") && operation !== "chat-messages-list" ? data.chats : data.messages;
    if (Array.isArray(items) && count(items.length)) result.count = items.length;
  } catch { /* Non-JSON output is deliberately not retained. */ }
  return result;
}

export function codexExecutionEvidenceFromLine(line: string): ToolExecutionEvidence | undefined {
  if (line.length > 1_048_576) return undefined;
  let raw: unknown;
  try { raw = JSON.parse(line); } catch { return undefined; }
  if (!record(raw) || raw.type !== "item.completed" || !record(raw.item)) return undefined;
  const item = raw.item;
  const kind = item.type === "command_execution" ? "command" : item.type === "file_change" ? "file-change"
    : item.type === "mcp_tool_call" ? "mcp" : item.type === "web_search" ? "web-search" : undefined;
  if (!kind) return undefined;
  const exitCode = Number.isSafeInteger(item.exit_code) && Math.abs(Number(item.exit_code)) <= 2147483648 ? Number(item.exit_code) : undefined;
  const evidence: ToolExecutionEvidence = {
    kind, status: item.status === "failed" || (exitCode !== undefined && exitCode !== 0) ? "failed"
      : item.status === "completed" || exitCode === 0 ? "completed" : "unknown",
    ...(exitCode !== undefined ? { exitCode } : {}),
  };
  const lark = kind === "command" ? larkEvidence(item.command, item.aggregated_output) : undefined;
  if (lark) evidence.lark = lark;
  return evidence;
}

export function collectCodexExecutionEvidence(stdout: string): ProviderExecutionEvidence {
  const result: ProviderExecutionEvidence = { source: "codex-jsonl", events: [], truncated: false };
  for (const line of stdout.split(/\r?\n/)) {
    if (line.length > 1_048_576) { result.truncated = true; continue; }
    const evidence = codexExecutionEvidenceFromLine(line);
    if (!evidence) continue;
    if (result.events.length >= MAX_EVENTS) { result.truncated = true; continue; }
    result.events.push(evidence);
  }
  return result;
}
