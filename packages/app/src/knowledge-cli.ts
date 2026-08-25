import {
  isLocalAgentKnowledgeToolName,
  type LocalAgentKnowledgeToolName,
} from "@homeagent/core";
import { LocalAgentApiError } from "./local-agent-client.ts";
import type { LocalAgentKnowledgeCaller } from "./mcp.ts";

const USAGE = [
  "Usage: homeagent knowledge <tool> [options]",
  "Tools:",
  "  list_spaces [--limit N]",
  "  get_overview --space SPACE",
  "  list_maps --space SPACE [--limit N]",
  "  search_knowledge --space SPACE --query TEXT [--limit N]",
  "  get_page --space SPACE --slug SLUG",
  "  get_page_trace --space SPACE --slug SLUG",
].join("\n");

export interface KnowledgeCliOptions {
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

function toolArguments(
  tool: LocalAgentKnowledgeToolName,
  flags: Record<string, string>,
): Record<string, unknown> | undefined {
  const allowed = {
    list_spaces: ["limit"],
    get_overview: ["space"],
    list_maps: ["space", "limit"],
    search_knowledge: ["space", "query", "limit"],
    get_page: ["space", "slug"],
    get_page_trace: ["space", "slug"],
  }[tool];
  if (Object.keys(flags).some((name) => !allowed.includes(name))) return undefined;
  if (tool !== "list_spaces" && flags.space === undefined) return undefined;
  if (tool === "search_knowledge" && flags.query === undefined) return undefined;
  if ((tool === "get_page" || tool === "get_page_trace") && flags.slug === undefined) {
    return undefined;
  }
  const limit = flags.limit === undefined ? undefined : Number(flags.limit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) return undefined;
  return {
    ...(flags.space === undefined ? {} : { space: flags.space }),
    ...(flags.query === undefined ? {} : { query: flags.query }),
    ...(flags.slug === undefined ? {} : { slug: flags.slug }),
    ...(limit === undefined ? {} : { limit }),
  };
}

export async function runKnowledgeCli(
  argv: string[],
  options: KnowledgeCliOptions,
): Promise<number> {
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const writeError = options.writeError ?? ((line: string) => process.stderr.write(`${line}\n`));
  const tool = argv[0];
  if (!isLocalAgentKnowledgeToolName(tool)) {
    writeError(USAGE);
    return 2;
  }
  const flags = parseFlags(argv.slice(1));
  const args = flags ? toolArguments(tool, flags) : undefined;
  if (!args) {
    writeError(USAGE);
    return 2;
  }
  try {
    const result = await options.caller.call(tool, args);
    write(JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    writeError(
      error instanceof LocalAgentApiError
        ? `homeagent knowledge: ${error.message}`
        : "homeagent knowledge: query failed",
    );
    return 1;
  }
}
