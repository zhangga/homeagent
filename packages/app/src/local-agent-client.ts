import type {
  AgentKnowledgeFeedback,
  LocalAgentKnowledgeResult,
  LocalAgentKnowledgeToolName,
  SubmitAgentKnowledgeFeedbackInput,
} from "@homeagent/core";
import type { SpaceId } from "@homeagent/shared";

const MAX_LOCAL_AGENT_RESPONSE_BYTES = 2 * 1024 * 1024;
const LOCAL_AGENT_REQUEST_TIMEOUT_MS = 15_000;

type LocalAgentFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type LocalAgentApiErrorCode =
  | "invalid_input"
  | "not_found"
  | "conflict"
  | "capacity"
  | "unauthorized"
  | "unavailable";

export class LocalAgentApiError extends Error {
  constructor(
    readonly code: LocalAgentApiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LocalAgentApiError";
  }
}

export interface LocalAgentApiClientOptions {
  baseUrl: string;
  token?: string;
  feedbackToken?: string;
  fetch?: LocalAgentFetch;
}

function endpoint(baseUrl: string, pathname: string): URL {
  const parsed = new URL(baseUrl);
  if (
    parsed.protocol !== "http:"
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
  ) {
    throw new LocalAgentApiError("invalid_input", "local Agent API URL is invalid");
  }
  return new URL(pathname, parsed);
}

function readToken(value: string | undefined, label: string): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (value.length > 4096 || /[\r\n]/.test(value)) {
    throw new LocalAgentApiError("invalid_input", `local Agent ${label} token is invalid`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function readBoundedResponseBody(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_LOCAL_AGENT_RESPONSE_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // The bounded failure remains authoritative even if transport cleanup fails.
        }
        throw new LocalAgentApiError(
          "unavailable",
          "HomeAgent knowledge response is too large",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(merged);
  } catch {
    throw new LocalAgentApiError("unavailable", "HomeAgent knowledge response is invalid");
  }
}

export class LocalAgentApiClient {
  private readonly queryEndpoint: URL;
  private readonly feedbackEndpoint: URL;
  private readonly readToken?: string;
  private readonly feedbackToken?: string;
  private readonly fetchImpl: LocalAgentFetch;

  constructor(options: LocalAgentApiClientOptions) {
    this.queryEndpoint = endpoint(options.baseUrl, "/api/agent/v1/query");
    this.feedbackEndpoint = endpoint(options.baseUrl, "/api/agent/v1/feedback");
    this.readToken = readToken(options.token, "read");
    this.feedbackToken = readToken(options.feedbackToken, "feedback");
    this.fetchImpl = options.fetch ?? fetch;
  }

  async call(
    tool: LocalAgentKnowledgeToolName,
    args: Record<string, unknown> = {},
  ): Promise<LocalAgentKnowledgeResult> {
    return await this.postJson(
      this.queryEndpoint,
      this.readToken,
      { tool, arguments: args },
      "result",
      "HomeAgent knowledge query failed",
    ) as unknown as LocalAgentKnowledgeResult;
  }

  async submitFeedback(
    space: SpaceId,
    input: SubmitAgentKnowledgeFeedbackInput,
  ): Promise<AgentKnowledgeFeedback> {
    return await this.postJson(
      this.feedbackEndpoint,
      this.feedbackToken,
      { space, ...input },
      "feedback",
      "HomeAgent feedback submission failed",
    ) as unknown as AgentKnowledgeFeedback;
  }

  private async postJson(
    endpoint: URL,
    token: string | undefined,
    body: Record<string, unknown>,
    resultField: "result" | "feedback",
    failureMessage: string,
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.fetchImpl(endpoint, {
        method: "POST",
        redirect: "error",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(LOCAL_AGENT_REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new LocalAgentApiError("unavailable", "HomeAgent local knowledge service is unavailable");
    }
    const declaredLength = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > MAX_LOCAL_AGENT_RESPONSE_BYTES) {
      throw new LocalAgentApiError("unavailable", "HomeAgent knowledge response is too large");
    }
    const responseBody = await readBoundedResponseBody(response);
    let parsed: unknown;
    try {
      parsed = JSON.parse(responseBody) as unknown;
    } catch {
      throw new LocalAgentApiError("unavailable", "HomeAgent knowledge response is invalid");
    }
    if (
      response.ok
      && isRecord(parsed)
      && parsed.ok === true
      && isRecord(parsed[resultField])
    ) {
      return parsed[resultField];
    }
    if (response.status === 401 || response.status === 403) {
      throw new LocalAgentApiError("unauthorized", "HomeAgent local Agent access is unauthorized");
    }
    if (isRecord(parsed) && parsed.ok === false && isRecord(parsed.error)) {
      const code = parsed.error.code;
      const message = parsed.error.message;
      if (
        (code === "invalid_input"
          || code === "not_found"
          || code === "conflict"
          || code === "capacity"
          || code === "unavailable")
        && typeof message === "string"
        && message.length > 0
        && message.length <= 300
      ) {
        throw new LocalAgentApiError(code, message);
      }
    }
    throw new LocalAgentApiError("unavailable", failureMessage);
  }
}

export function localAgentApiBaseUrl(config: { webHost: string; webPort: number }): string {
  const configured = config.webHost.trim();
  const host = configured === "0.0.0.0"
    ? "127.0.0.1"
    : configured === "::" || configured === "[::]"
      ? "[::1]"
      : configured.includes(":") && !configured.startsWith("[")
        ? `[${configured}]`
        : configured;
  return `http://${host}:${config.webPort}`;
}
