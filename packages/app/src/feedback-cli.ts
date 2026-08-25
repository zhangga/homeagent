import {
  isAgentKnowledgeFeedbackKind,
  type SubmitAgentKnowledgeFeedbackInput,
} from "@homeagent/core";
import { isSpaceId, type SpaceId } from "@homeagent/shared";
import { LocalAgentApiError } from "./local-agent-client.ts";
import type { LocalAgentKnowledgeCaller } from "./mcp.ts";

const USAGE = [
  "Usage:",
  "  homeagent feedback --space SPACE --idempotency-key KEY --consumer NAME --kind KIND --query TEXT [--note TEXT]",
  "  homeagent feedback --space SPACE --idempotency-key KEY --consumer NAME --kind KIND --slug SLUG --revision REVISION [--note TEXT]",
  "Kinds: helpful, not_found, incorrect, stale, conflicting, hard_to_reuse",
].join("\n");

export interface FeedbackCliOptions {
  caller: LocalAgentKnowledgeCaller;
  write?: (line: string) => void;
  writeError?: (line: string) => void;
}

function parseFlags(args: string[]): Record<string, string> | undefined {
  const flags: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || !value || value.startsWith("--")) return undefined;
    const name = flag.slice(2);
    if (!name || flags[name] !== undefined) return undefined;
    flags[name] = value;
  }
  return flags;
}

function feedbackArguments(flags: Record<string, string>): {
  space: SpaceId;
  input: SubmitAgentKnowledgeFeedbackInput;
} | undefined {
  const allowed = [
    "space",
    "idempotency-key",
    "consumer",
    "kind",
    "query",
    "slug",
    "revision",
    "note",
  ];
  if (Object.keys(flags).some((name) => !allowed.includes(name))) return undefined;
  if (
    !flags.space
    || !isSpaceId(flags.space)
    || !flags["idempotency-key"]
    || !flags.consumer
    || !isAgentKnowledgeFeedbackKind(flags.kind)
  ) return undefined;
  const usesSearch = flags.query !== undefined;
  const usesPage = flags.slug !== undefined || flags.revision !== undefined;
  if (usesSearch === usesPage || (usesPage && (!flags.slug || !flags.revision))) return undefined;
  return {
    space: flags.space,
    input: {
      idempotencyKey: flags["idempotency-key"],
      consumer: flags.consumer,
      kind: flags.kind,
      target: usesSearch
        ? { kind: "search", query: flags.query! }
        : { kind: "page", slug: flags.slug!, revision: flags.revision! },
      ...(flags.note === undefined ? {} : { note: flags.note }),
    },
  };
}

export async function runFeedbackCli(
  argv: string[],
  options: FeedbackCliOptions,
): Promise<number> {
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const writeError = options.writeError ?? ((line: string) => process.stderr.write(`${line}\n`));
  const flags = parseFlags(argv);
  const parsed = flags ? feedbackArguments(flags) : undefined;
  if (!parsed || !options.caller.submitFeedback) {
    writeError(USAGE);
    return 2;
  }
  try {
    const feedback = await options.caller.submitFeedback(parsed.space, parsed.input);
    write(JSON.stringify(feedback, null, 2));
    return 0;
  } catch (error) {
    writeError(
      error instanceof LocalAgentApiError
        ? `homeagent feedback: ${error.message}`
        : "homeagent feedback: submission failed",
    );
    return 1;
  }
}
