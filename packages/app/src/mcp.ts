import type {
  AgentKnowledgeFeedback,
  LocalAgentKnowledgeResult,
  LocalAgentKnowledgeToolName,
  SubmitAgentKnowledgeFeedbackInput,
} from "@homeagent/core";
import { isLocalAgentKnowledgeToolName } from "@homeagent/core";
import { isSpaceId, type SpaceId } from "@homeagent/shared";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { LocalAgentApiError } from "./local-agent-client.ts";

export const HOMEAGENT_MCP_PROTOCOL_VERSION = "2025-11-25";
const MAX_MCP_MESSAGE_BYTES = 1024 * 1024;
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  HOMEAGENT_MCP_PROTOCOL_VERSION,
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
]);

type JsonRpcId = string | number;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

interface JsonRpcError {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  error: { code: number; message: string };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

export interface LocalAgentKnowledgeCaller {
  call(
    tool: LocalAgentKnowledgeToolName,
    args?: Record<string, unknown>,
  ): Promise<LocalAgentKnowledgeResult>;
  submitFeedback?(
    space: SpaceId,
    input: SubmitAgentKnowledgeFeedbackInput,
  ): Promise<AgentKnowledgeFeedback>;
}

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const FEEDBACK_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const SPACE_SCHEMA = {
  type: "string",
  minLength: 1,
  maxLength: 256,
  description: "必须显式指定的 HomeAgent SpaceId，例如 team/oc_xxx 或 personal/ou_xxx。",
} as const;

const SLUG_SCHEMA = {
  type: "string",
  minLength: 1,
  maxLength: 300,
  description: "知识页 slug。先通过 overview、map 或 search 获得，不要猜测。",
} as const;

export const HOMEAGENT_KNOWLEDGE_MCP_TOOLS = [
  {
    name: "list_spaces",
    title: "列出 HomeAgent Spaces",
    description: "列出本机可读 Space 的有界安全摘要，不返回群绑定或 Agent 管理元数据。",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 100, default: 50 } },
      additionalProperties: false,
    },
    annotations: READ_ONLY_ANNOTATIONS,
    execution: { taskSupport: "forbidden" },
  },
  {
    name: "get_overview",
    title: "读取知识概览",
    description: "读取一个显式 Space 的 overview，作为渐进披露的首选入口。",
    inputSchema: {
      type: "object",
      properties: { space: SPACE_SCHEMA },
      required: ["space"],
      additionalProperties: false,
    },
    annotations: READ_ONLY_ANNOTATIONS,
    execution: { taskSupport: "forbidden" },
  },
  {
    name: "list_maps",
    title: "列出顶层知识地图",
    description: "列出一个显式 Space 的顶层 Knowledge maps；下级地图通过 get_page 沿链接按需读取。",
    inputSchema: {
      type: "object",
      properties: {
        space: SPACE_SCHEMA,
        limit: { type: "integer", minimum: 1, maximum: 100, default: 24 },
      },
      required: ["space"],
      additionalProperties: false,
    },
    annotations: READ_ONLY_ANNOTATIONS,
    execution: { taskSupport: "forbidden" },
  },
  {
    name: "search_knowledge",
    title: "搜索知识",
    description: "仅在一个显式 Space 内执行现有本地 FTS，返回最多 20 个普通 Knowledge page 命中。",
    inputSchema: {
      type: "object",
      properties: {
        space: SPACE_SCHEMA,
        query: { type: "string", minLength: 1, maxLength: 500 },
        limit: { type: "integer", minimum: 1, maximum: 20, default: 8 },
      },
      required: ["space", "query"],
      additionalProperties: false,
    },
    annotations: READ_ONLY_ANNOTATIONS,
    execution: { taskSupport: "forbidden" },
  },
  {
    name: "get_page",
    title: "读取知识页",
    description: "读取一个页面正文；普通页面附证据时效摘要，但不返回 Raw id。",
    inputSchema: {
      type: "object",
      properties: { space: SPACE_SCHEMA, slug: SLUG_SCHEMA },
      required: ["space", "slug"],
      additionalProperties: false,
    },
    annotations: READ_ONLY_ANNOTATIONS,
    execution: { taskSupport: "forbidden" },
  },
  {
    name: "get_page_trace",
    title: "追溯知识页证据",
    description: "显式追溯普通知识页的有界 Raw 元数据；不返回 Raw 正文或 Raw 的 chatId、messageId、工作归属字段。",
    inputSchema: {
      type: "object",
      properties: { space: SPACE_SCHEMA, slug: SLUG_SCHEMA },
      required: ["space", "slug"],
      additionalProperties: false,
    },
    annotations: READ_ONLY_ANNOTATIONS,
    execution: { taskSupport: "forbidden" },
  },
] as const;

export const HOMEAGENT_FEEDBACK_MCP_TOOL = {
  name: "submit_knowledge_feedback",
  title: "提交知识消费反馈",
  description: "记录当前 Agent 对页面或搜索结果的有界反馈；只进入人工治理队列，不会直接修改 Raw、Wiki 或触发 Dream cycle。",
  inputSchema: {
    type: "object",
    properties: {
      space: SPACE_SCHEMA,
      idempotencyKey: { type: "string", minLength: 1, maxLength: 200 },
      consumer: { type: "string", minLength: 1, maxLength: 200 },
      kind: {
        type: "string",
        enum: ["helpful", "not_found", "incorrect", "stale", "conflicting", "hard_to_reuse"],
      },
      target: {
        oneOf: [
          {
            type: "object",
            properties: {
              kind: { const: "page" },
              slug: SLUG_SCHEMA,
              revision: { type: "string", pattern: "^[a-f0-9]{64}$" },
            },
            required: ["kind", "slug", "revision"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              kind: { const: "search" },
              query: { type: "string", minLength: 1, maxLength: 500 },
            },
            required: ["kind", "query"],
            additionalProperties: false,
          },
        ],
      },
      note: { type: "string", minLength: 1, maxLength: 4000 },
    },
    required: ["space", "idempotencyKey", "consumer", "kind", "target"],
    additionalProperties: false,
  },
  annotations: FEEDBACK_ANNOTATIONS,
  execution: { taskSupport: "forbidden" },
} as const;

export interface KnowledgeMcpServerOptions {
  feedbackEnabled?: boolean;
}

function request(value: unknown): JsonRpcRequest | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (item.jsonrpc !== "2.0" || typeof item.method !== "string") return undefined;
  if (item.id !== undefined && typeof item.id !== "string" && typeof item.id !== "number") {
    return undefined;
  }
  return item as unknown as JsonRpcRequest;
}

function success(id: JsonRpcId, result: unknown): JsonRpcSuccess {
  return { jsonrpc: "2.0", id, result };
}

function failure(id: JsonRpcId | null, code: number, message: string): JsonRpcError {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export class KnowledgeMcpServer {
  private initializeResponded = false;
  private initialized = false;

  constructor(
    private readonly caller: LocalAgentKnowledgeCaller,
    private readonly options: KnowledgeMcpServerOptions = {},
  ) {}

  async handle(input: unknown): Promise<JsonRpcResponse | null> {
    const message = request(input);
    if (!message) return failure(null, -32600, "Invalid Request");
    const id = message.id;

    if (message.method === "initialize") {
      if (id === undefined) return null;
      const params = message.params && typeof message.params === "object" && !Array.isArray(message.params)
        ? message.params as Record<string, unknown>
        : {};
      const requestedVersion = typeof params.protocolVersion === "string"
        ? params.protocolVersion
        : undefined;
      if (!requestedVersion) return failure(id, -32602, "Invalid initialize parameters");
      this.initializeResponded = true;
      return success(id, {
        protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.has(requestedVersion)
          ? requestedVersion
          : HOMEAGENT_MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: {
          name: "homeagent-knowledge",
          title: "HomeAgent Local Knowledge",
          version: "0.1.0",
        },
        instructions: "先选择一个 Space，再按 overview → maps/search → page → trace 渐进读取。不要跨 Space 拼接知识。",
      });
    }

    if (message.method === "notifications/initialized") {
      if (this.initializeResponded) this.initialized = true;
      return null;
    }

    if (message.method === "ping") {
      return id === undefined ? null : success(id, {});
    }

    if (!this.initialized) {
      return id === undefined ? null : failure(id, -32002, "Server not initialized");
    }

    if (message.method === "tools/list") {
      const feedbackEnabled = this.options.feedbackEnabled && this.caller.submitFeedback;
      return id === undefined ? null : success(id, {
        tools: feedbackEnabled
          ? [...HOMEAGENT_KNOWLEDGE_MCP_TOOLS, HOMEAGENT_FEEDBACK_MCP_TOOL]
          : HOMEAGENT_KNOWLEDGE_MCP_TOOLS,
      });
    }

    if (message.method === "tools/call") {
      if (id === undefined) return null;
      if (!message.params || typeof message.params !== "object" || Array.isArray(message.params)) {
        return failure(id, -32602, "Invalid tool call parameters");
      }
      const params = message.params as Record<string, unknown>;
      if (params.name === HOMEAGENT_FEEDBACK_MCP_TOOL.name) {
        if (!this.options.feedbackEnabled || !this.caller.submitFeedback) {
          return failure(id, -32602, "Unknown tool");
        }
        if (!params.arguments || typeof params.arguments !== "object" || Array.isArray(params.arguments)) {
          return failure(id, -32602, "Invalid tool arguments");
        }
        const args = params.arguments as Record<string, unknown>;
        const allowed = ["space", "idempotencyKey", "consumer", "kind", "target", "note"];
        if (
          Object.keys(args).some((key) => !allowed.includes(key))
          || typeof args.space !== "string"
          || !isSpaceId(args.space)
        ) {
          return failure(id, -32602, "Invalid tool arguments");
        }
        try {
          const result = await this.caller.submitFeedback(args.space as SpaceId, {
            idempotencyKey: args.idempotencyKey,
            consumer: args.consumer,
            kind: args.kind,
            target: args.target,
            ...(args.note === undefined ? {} : { note: args.note }),
          } as SubmitAgentKnowledgeFeedbackInput);
          return success(id, {
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: result,
            isError: false,
          });
        } catch (error) {
          return success(id, {
            content: [{
              type: "text",
              text: error instanceof LocalAgentApiError
                ? error.message
                : "HomeAgent feedback submission failed.",
            }],
            isError: true,
          });
        }
      }
      if (!isLocalAgentKnowledgeToolName(params.name)) {
        return failure(id, -32602, "Unknown tool");
      }
      if (
        params.arguments !== undefined
        && (!params.arguments || typeof params.arguments !== "object" || Array.isArray(params.arguments))
      ) {
        return failure(id, -32602, "Invalid tool arguments");
      }
      try {
        const result = await this.caller.call(
          params.name,
          (params.arguments ?? {}) as Record<string, unknown>,
        );
        return success(id, {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
          isError: false,
        });
      } catch (error) {
        return success(id, {
          content: [{
            type: "text",
            text: error instanceof LocalAgentApiError
              ? error.message
              : "HomeAgent knowledge query failed.",
          }],
          isError: true,
        });
      }
    }

    return id === undefined ? null : failure(id, -32601, "Method not found");
  }
}

export async function handleMcpLine(
  server: KnowledgeMcpServer,
  line: string,
): Promise<string | undefined> {
  if (new TextEncoder().encode(line).byteLength > MAX_MCP_MESSAGE_BYTES) {
    return JSON.stringify(failure(null, -32600, "Message too large"));
  }
  let message: unknown;
  try {
    message = JSON.parse(line) as unknown;
  } catch {
    return JSON.stringify(failure(null, -32700, "Parse error"));
  }
  const response = await server.handle(message);
  return response ? JSON.stringify(response) : undefined;
}

export interface McpStdioOptions {
  input?: Readable;
  write?: (line: string) => void;
  feedbackEnabled?: boolean;
}

/** Run a newline-delimited MCP stdio session without writing non-protocol data to stdout. */
export async function runKnowledgeMcpStdio(
  caller: LocalAgentKnowledgeCaller,
  options: McpStdioOptions = {},
): Promise<void> {
  const input = options.input ?? process.stdin;
  const write = options.write ?? ((line: string) => process.stdout.write(line));
  const lines = createInterface({ input, crlfDelay: Infinity });
  const server = new KnowledgeMcpServer(caller, {
    feedbackEnabled: options.feedbackEnabled,
  });
  for await (const line of lines) {
    const response = await handleMcpLine(server, line);
    if (response !== undefined) write(`${response}\n`);
  }
}
