/**
 * Read-only ByteTech article ingestion.
 *
 * This boundary deliberately exposes one fixed command only: authenticated
 * GET of a canonical ByteTech article URL. It does not hand a general
 * bytedcli command surface to ordinary Chat execution.
 */
import { logger } from "@homeagent/shared";
import {
  runFeishuCommand,
  type CommandOptions,
} from "./feishu.ts";
import { normalizeByteTechArticleUrl } from "./source-links.ts";
export {
  isByteTechArticleUrl,
  normalizeByteTechArticleUrl,
} from "./source-links.ts";

const log = logger.child("bytetech");
const MAX_ARTICLE_MARKDOWN_CHARS = 200_000;
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;

type RunCommand = (command: string[], options?: CommandOptions) => Promise<string>;

export interface ByteTechArticleFetcherOptions {
  bin?: string;
  runCommand?: RunCommand;
}

function markdownFromJson(text: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const root = parsed as Record<string, unknown>;
  const candidates = [
    root,
    typeof root.data === "object" && root.data !== null && !Array.isArray(root.data)
      ? root.data as Record<string, unknown>
      : undefined,
    typeof root.result === "object" && root.result !== null && !Array.isArray(root.result)
      ? root.result as Record<string, unknown>
      : undefined,
  ];
  for (const candidate of candidates) {
    const markdown = candidate?.markdown;
    if (typeof markdown === "string" && markdown.trim()) {
      const normalized = markdown.trim();
      if (normalized.length <= MAX_ARTICLE_MARKDOWN_CHARS) return normalized;
      const marker = "\n\n【来源正文已按 200,000 字符上限截断】";
      return `${normalized.slice(0, MAX_ARTICLE_MARKDOWN_CHARS - marker.length)}${marker}`;
    }
  }
  return undefined;
}

function boundedFailureKind(error: unknown): "timeout" | "authentication" | "unavailable" {
  const message = error instanceof Error ? error.message : String(error);
  if (/timed out|timeout/iu.test(message)) return "timeout";
  if (/auth|login|token|credential|unauthorized|forbidden|\b40[13]\b/iu.test(message)) {
    return "authentication";
  }
  return "unavailable";
}

export class ByteTechArticleFetcher {
  private bin: string;
  private runCommand: RunCommand;

  constructor(options: ByteTechArticleFetcherOptions = {}) {
    this.bin = options.bin?.trim() || "bytedcli";
    this.runCommand = options.runCommand ?? runFeishuCommand;
  }

  async fetch(value: string): Promise<string | null> {
    const articleUrl = normalizeByteTechArticleUrl(value);
    if (!articleUrl) return null;
    try {
      const stdout = await this.runCommand(
        [this.bin, "--json", "insearch", "get", articleUrl],
        {
          timeoutMs: FETCH_TIMEOUT_MS,
          terminationGraceMs: 250,
          maxCapturedBytes: MAX_COMMAND_OUTPUT_BYTES,
        },
      );
      const markdown = markdownFromJson(stdout);
      if (!markdown) {
        log.warn("ByteTech article fetch returned no bounded markdown");
        return null;
      }
      return markdown;
    } catch (error) {
      log.warn("ByteTech article fetch failed", {
        kind: boundedFailureKind(error),
      });
      return null;
    }
  }
}
