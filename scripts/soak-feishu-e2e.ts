import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { deflateSync } from "node:zlib";
import {
  recordSoakEvidence,
  type FeishuSoakScenario,
  type SoakEvidence,
} from "./soak-runtime.ts";

export const AUTOMATED_FEISHU_SOAK_SCENARIOS = [
  "group_binding_lifecycle",
  "message_capture",
  "mention_answer",
  "proactive_participation",
  "image_analysis",
  "attachment_extraction",
  "research_notification",
  "reminder_delivery",
  "learning_interaction",
  "distill_citation",
] as const satisfies readonly FeishuSoakScenario[];

type AutomatedScenario = (typeof AUTOMATED_FEISHU_SOAK_SCENARIOS)[number];

export interface LarkMessage {
  message_id: string;
  content?: string;
  create_time?: string;
  thread_id?: string;
  sender?: {
    id?: string;
    sender_type?: string;
    open_bot_id?: string;
  };
  thread_replies?: LarkMessage[];
}

interface LarkCliEnvelope {
  ok?: boolean;
  data?: unknown;
  error?: {
    message?: string;
    hint?: string;
    subtype?: string;
    missing_scopes?: string[];
  };
  [key: string]: unknown;
}

export interface StoredTask {
  id: string;
  name: string;
  space: string;
  notify?: boolean;
  timeoutMinutes?: number;
}

export interface StoredTaskRun {
  id: string;
  taskId: string;
  taskName?: string;
  status: string;
  trigger?: string;
  startedAt: number;
  finishedAt?: number;
  rawId?: string;
  pagesWritten?: number;
  notification?: {
    status?: string;
    sentAt?: number;
  };
}

interface StoredReminder {
  id: string;
  title: string;
  sourceMessageId?: string;
  lastNotifiedAt?: number;
  status: string;
}

export interface StoredLearningPlan {
  id: string;
  name: string;
  chatId: string;
  creatorId: string;
}

export interface StoredLearningSession {
  id: string;
  planId: string;
  status: string;
  deliveredAt?: number;
  completedAt?: number;
}

interface ResearchEvidence {
  task: StoredTask;
  run: StoredTaskRun;
  noticeMessageId?: string;
}

interface LarkProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

type ProcessRunner = (args: string[], cwd: string) => Promise<LarkProcessResult>;

export interface FeishuSoakDriverOptions {
  chatId: string;
  botOpenId: string;
  dataDir: string;
  evidencePath: string;
  monitorPath: string;
  adminUrl: string;
  adminToken?: string;
  researchTaskName?: string;
  scenarios: AutomatedScenario[];
  responseTimeoutMs: number;
  longTimeoutMs: number;
  sender: "api" | "ui";
  dryRun: boolean;
}

interface StoredFeishuBinding {
  chatId: string;
  spaceId: string;
  state: "active" | "disconnected" | "needs_reconnect";
  boundAppId?: string;
  responseMode: "mentions_only" | "smart" | "all_messages";
  participationLevel?: "reserved" | "balanced" | "active";
  replyInThread: boolean;
}

export interface FeishuSoakAdminFormRequest {
  adminUrl: string;
  adminToken?: string;
  path: string;
  form: Record<string, string>;
  fetchImpl?: typeof fetch;
}

export interface UiUserAction {
  type: "soak_user_action";
  action: "send_text" | "reply_text" | "send_image" | "send_file";
  chatId: string;
  text?: string;
  mentionBot?: boolean;
  rootMessageId?: string;
  path?: string;
}

interface ScenarioResult {
  scenario: AutomatedScenario;
  ok: boolean;
  artifactId?: string;
  error?: string;
}

class LarkCliError extends Error {
  readonly envelope?: LarkCliEnvelope;

  constructor(message: string, envelope?: LarkCliEnvelope) {
    super(message);
    this.name = "LarkCliError";
    this.envelope = envelope;
  }
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function parseLarkCliResult(stdout: string): LarkCliEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    throw new LarkCliError("lark-cli returned invalid JSON");
  }
  const envelope = object(parsed) as LarkCliEnvelope;
  if (envelope.ok === false) {
    const message = envelope.error?.message?.trim() || "lark-cli request failed";
    const hint = envelope.error?.hint?.trim();
    throw new LarkCliError(hint ? `${message}. ${hint}` : message, envelope);
  }
  return envelope;
}

export function flattenLarkMessages(messages: LarkMessage[]): LarkMessage[] {
  const flattened: LarkMessage[] = [];
  const seen = new Set<string>();
  const visit = (candidate: LarkMessage) => {
    if (candidate.message_id && !seen.has(candidate.message_id)) {
      seen.add(candidate.message_id);
      flattened.push(candidate);
    }
    for (const reply of candidate.thread_replies ?? []) visit(reply);
  };
  for (const candidate of messages) visit(candidate);
  return flattened;
}

function isBotMessage(message: LarkMessage, botOpenId: string): boolean {
  return message.sender?.open_bot_id === botOpenId
    || (message.sender?.sender_type === "app" && message.sender?.id === botOpenId);
}

export function findBotReply(
  messages: LarkMessage[],
  options: {
    botOpenId: string;
    rootMessageId: string;
    contentIncludes?: string[];
    contentPattern?: RegExp;
  },
): LarkMessage | undefined {
  const root = flattenLarkMessages(messages).find(
    (message) => message.message_id === options.rootMessageId,
  );
  if (!root) return undefined;
  const candidates = flattenLarkMessages(root.thread_replies ?? []);
  return candidates.find((candidate) => {
    if (!isBotMessage(candidate, options.botOpenId)) return false;
    const content = candidate.content ?? "";
    if (options.contentIncludes?.some((part) => !content.includes(part))) return false;
    if (options.contentPattern && !options.contentPattern.test(content)) return false;
    return !looksLikeFailureReply(content);
  });
}

function looksLikeFailureReply(content: string): boolean {
  return /(?:暂时不可用|尚未配置可用的\s*CLI|运行失败|请求超时|稍后重试|provider unavailable)/iu
    .test(content);
}

export function isTransientLarkFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:HTTP\s*429|Too Many Requests|rate.?limit|invalid (?:response|JSON)|unexpected end of JSON|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|temporarily unavailable|timeout)/iu
    .test(message);
}

export async function executeVerifiedScenario(
  scenario: FeishuSoakScenario,
  evidencePath: string,
  verify: () => Promise<string>,
): Promise<SoakEvidence> {
  const artifactId = (await verify()).trim();
  if (!artifactId) throw new Error(`${scenario} did not produce an artifact id`);
  return recordSoakEvidence(evidencePath, { scenario, ok: true, artifactId });
}

export function selectReusableResearchRun(
  tasks: StoredTask[],
  runs: StoredTaskRun[],
  options: { chatId: string; windowStartedAt: number; taskName?: string },
): ResearchEvidence | undefined {
  const byId = new Map(
    tasks
      .filter((task) => task.space === `team/${options.chatId}`)
      .filter((task) => task.notify !== false)
      .filter((task) => !options.taskName || task.name === options.taskName)
      .map((task) => [task.id, task]),
  );
  const run = runs
    .filter((candidate) => byId.has(candidate.taskId))
    .filter((candidate) => candidate.status === "succeeded")
    .filter((candidate) => candidate.startedAt >= options.windowStartedAt)
    .filter((candidate) => candidate.notification?.status === "sent")
    .sort((left, right) => right.startedAt - left.startedAt)[0];
  return run ? { task: byId.get(run.taskId)!, run } : undefined;
}

export function selectInFlightResearchRun(
  tasks: StoredTask[],
  runs: StoredTaskRun[],
  options: { chatId: string; windowStartedAt: number; taskName?: string },
): ResearchEvidence | undefined {
  const byId = new Map(
    tasks
      .filter((task) => task.space === `team/${options.chatId}`)
      .filter((task) => task.notify !== false)
      .filter((task) => !options.taskName || task.name === options.taskName)
      .map((task) => [task.id, task]),
  );
  const run = runs
    .filter((candidate) => byId.has(candidate.taskId))
    .filter((candidate) => candidate.status === "running")
    .filter((candidate) => candidate.startedAt >= options.windowStartedAt)
    .sort((left, right) => right.startedAt - left.startedAt)[0];
  return run ? { task: byId.get(run.taskId)!, run } : undefined;
}

function valuesFromFile<T>(path: string, key: string): T[] {
  if (!existsSync(path)) return [];
  const parsed = object(JSON.parse(readFileSync(path, "utf8")));
  const collection = parsed[key];
  if (Array.isArray(collection)) return collection as T[];
  return Object.values(object(collection)) as T[];
}

function firstSampleAt(path: string): number | undefined {
  if (!existsSync(path)) return undefined;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const at = object(JSON.parse(line)).at;
      if (typeof at === "number" && Number.isFinite(at)) return at;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function parseLarkCreateTime(value: string): number {
  const trimmed = value.trim();
  if (/^\d+$/u.test(trimmed)) {
    const numeric = Number(trimmed);
    if (!Number.isFinite(numeric)) return NaN;
    return trimmed.length <= 10 ? numeric * 1_000 : numeric;
  }
  return Date.parse(trimmed.includes("T") ? trimmed : trimmed.replace(" ", "T"));
}

function isFreshUserMessage(
  message: LarkMessage,
  botOpenId: string,
  notBefore: number,
): boolean {
  if (isBotMessage(message, botOpenId) || message.sender?.sender_type === "app") return false;
  const createdAt = message.create_time ? parseLarkCreateTime(message.create_time) : NaN;
  return Number.isFinite(createdAt) && createdAt >= notBefore - 60_000;
}

export function findFreshUserMessage(
  messages: LarkMessage[],
  options: {
    botOpenId: string;
    notBefore: number;
    contentIncludes: string;
    rootMessageId?: string;
  },
): LarkMessage | undefined {
  const candidates = options.rootMessageId
    ? flattenLarkMessages(messages).find(
      (candidate) => candidate.message_id === options.rootMessageId,
    )?.thread_replies ?? []
    : messages;
  return flattenLarkMessages(candidates).find((candidate) =>
    isFreshUserMessage(candidate, options.botOpenId, options.notBefore)
    && (candidate.content ?? "").includes(options.contentIncludes)
  );
}

export function latestDeliveredLearningSession(
  sessions: StoredLearningSession[],
  planId: string,
): StoredLearningSession | undefined {
  return sessions
    .filter((candidate) => candidate.planId === planId && candidate.deliveredAt !== undefined)
    .sort((left, right) => (right.deliveredAt ?? 0) - (left.deliveredAt ?? 0))[0];
}

function uiText(text: string): { text: string; mentionBot: boolean } {
  const mention = /^<at\s+[^>]*>agent<\/at>\s*/u;
  return {
    text: text.replace(mention, ""),
    mentionBot: mention.test(text),
  };
}

function uiProbe(text: string): string {
  const normalized = uiText(text).text;
  const markers = normalized.match(/F5-[\p{L}\p{N}_-]+/gu) ?? [];
  return markers.sort((left, right) => right.length - left.length)[0]
    ?? normalized.slice(0, 120);
}

async function defaultProcessRunner(args: string[], cwd: string): Promise<LarkProcessResult> {
  const subprocess = Bun.spawn(["lark-cli", ...args], {
    cwd,
    env: {
      ...process.env,
      LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
      LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function nonzeroLarkFailure(result: LarkProcessResult): LarkCliError {
  let envelope: LarkCliEnvelope | undefined;
  let stdoutMessage = "";
  if (result.stdout.trim()) {
    try {
      envelope = object(JSON.parse(result.stdout.trim())) as LarkCliEnvelope;
      stdoutMessage = envelope.error?.message?.trim() ?? "";
    } catch {
      stdoutMessage = "lark-cli returned invalid JSON";
    }
  }
  const detail = result.stderr.trim() || stdoutMessage || `lark-cli exited with ${result.exitCode}`;
  return new LarkCliError(detail, envelope);
}

export async function invokeLarkCliWithRetry(
  args: string[],
  cwd: string,
  options: {
    attempts?: number;
    processRunner?: ProcessRunner;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<LarkCliEnvelope> {
  const attempts = options.attempts ?? 4;
  const processRunner = options.processRunner ?? defaultProcessRunner;
  const sleep = options.sleep ?? Bun.sleep;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await processRunner([...args, "--format", "json"], cwd);
      if (result.exitCode !== 0) throw nonzeroLarkFailure(result);
      return parseLarkCliResult(result.stdout);
    } catch (error) {
      lastError = error;
      if (!isTransientLarkFailure(error) || attempt === attempts) break;
      await sleep(Math.min(8_000, 750 * 2 ** (attempt - 1)));
    }
  }
  throw lastError;
}

function messageIdFrom(envelope: LarkCliEnvelope): string {
  const data = object(envelope.data);
  const id = data.message_id ?? envelope.message_id;
  if (typeof id !== "string" || !id.startsWith("om_")) {
    throw new Error("lark-cli response did not contain a message id");
  }
  return id;
}

function messagesFrom(envelope: LarkCliEnvelope): LarkMessage[] {
  const data = object(envelope.data);
  const messages = data.messages ?? data.items;
  return Array.isArray(messages) ? messages as LarkMessage[] : [];
}

function crc32(input: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function solidRedPng(width = 160, height = 120): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const scanlines = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const offset = y * (width * 3 + 1);
    scanlines[offset] = 0;
    for (let x = 0; x < width; x += 1) {
      scanlines[offset + 1 + x * 3] = 235;
      scanlines[offset + 2 + x * 3] = 45;
      scanlines[offset + 3 + x * 3] = 55;
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function attachmentFixture(marker: string): string {
  const principle = [
    `F5 自动验收资料，唯一口令：${marker}-ATTACHMENT。`,
    "家庭与团队协作原则：重要结论要说明来源，操作步骤要可复现，失败时要保留诊断信息。",
    "本资料用于验证文本附件提取、学习课程生成和知识引用，不包含真实隐私或生产凭据。",
  ].join("\n");
  return [
    "# HomeAgent F5 自动验收材料",
    "",
    ...Array.from({ length: 18 }, (_, index) => `第 ${index + 1} 节\n${principle}`),
  ].join("\n\n");
}

export function resolveRequestedScenarios(value: string | undefined): AutomatedScenario[] {
  if (!value) return [...AUTOMATED_FEISHU_SOAK_SCENARIOS];
  const requested = value.split(",").map((part) => part.trim()).filter(Boolean);
  const allowed = new Set<string>(AUTOMATED_FEISHU_SOAK_SCENARIOS);
  for (const scenario of requested) {
    if (scenario === "network_recovery") {
      throw new Error("network_recovery intentionally requires supervised network interruption");
    }
    if (!allowed.has(scenario)) throw new Error(`unknown automated scenario: ${scenario}`);
  }
  const expanded = new Set(requested as AutomatedScenario[]);
  if (expanded.has("learning_interaction")) expanded.add("attachment_extraction");
  if (expanded.has("distill_citation")) expanded.add("message_capture");
  return AUTOMATED_FEISHU_SOAK_SCENARIOS.filter((scenario) => expanded.has(scenario));
}

function stringArg(args: string[], flag: string, fallback?: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function numberArg(args: string[], flag: string, fallback: number): number {
  const raw = stringArg(args, flag);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${flag} must be positive`);
  return value;
}

function configuredWebPort(
  dataDir: string,
  env: Record<string, string | undefined>,
): number {
  const fromEnvironment = Number(env.HOMEAGENT_WEB_PORT);
  if (
    Number.isInteger(fromEnvironment)
    && fromEnvironment > 0
    && fromEnvironment <= 65_535
  ) {
    return fromEnvironment;
  }
  try {
    const settings = object(JSON.parse(
      readFileSync(join(dataDir, "config", "settings.json"), "utf8"),
    ));
    const fromSettings = settings.webPort;
    if (
      typeof fromSettings === "number"
      && Number.isInteger(fromSettings)
      && fromSettings > 0
      && fromSettings <= 65_535
    ) {
      return fromSettings;
    }
  } catch {
    // The default is also used before HomeAgent has written settings.json.
  }
  return 3_000;
}

function normalizeAdminUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("--admin-url must be a valid HTTP URL");
  }
  if (
    !["http:", "https:"].includes(url.protocol)
    || url.username
    || url.password
    || (url.pathname !== "/" && url.pathname !== "")
    || url.search
    || url.hash
  ) {
    throw new Error("--admin-url must contain only an HTTP(S) origin");
  }
  return url.origin;
}

export function parseFeishuSoakOptions(
  args: string[],
  env: Record<string, string | undefined> = process.env,
): FeishuSoakDriverOptions {
  const valueFlags = new Set([
    "--chat-id",
    "--bot-open-id",
    "--data-dir",
    "--admin-url",
    "--evidence",
    "--monitor",
    "--research-task",
    "--scenarios",
    "--sender",
    "--response-timeout-seconds",
    "--long-timeout-minutes",
  ]);
  const booleanFlags = new Set(["--dry-run"]);
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!valueFlags.has(arg) && !booleanFlags.has(arg)) throw new Error(`unknown argument: ${arg}`);
    if (seen.has(arg)) throw new Error(`duplicate argument: ${arg}`);
    seen.add(arg);
    if (valueFlags.has(arg)) index += 1;
  }

  const dataDir = resolve(stringArg(args, "--data-dir", "./data")!);
  const evidencePath = resolve(stringArg(args, "--evidence", "./data/soak/soak-evidence.jsonl")!);
  const sender = stringArg(args, "--sender", "api");
  if (sender !== "api" && sender !== "ui") {
    throw new Error("--sender must be api or ui");
  }
  return {
    chatId: stringArg(args, "--chat-id") ?? "",
    botOpenId: stringArg(args, "--bot-open-id") ?? "",
    dataDir,
    evidencePath,
    monitorPath: resolve(
      stringArg(args, "--monitor", join(dirname(evidencePath), "soak-24h.jsonl"))!,
    ),
    researchTaskName: stringArg(args, "--research-task"),
    adminUrl: normalizeAdminUrl(
      stringArg(
        args,
        "--admin-url",
        `http://127.0.0.1:${configuredWebPort(dataDir, env)}`,
      )!,
    ),
    adminToken: env.HOMEAGENT_SOAK_ADMIN_TOKEN?.trim() || undefined,
    scenarios: resolveRequestedScenarios(stringArg(args, "--scenarios")),
    responseTimeoutMs: numberArg(args, "--response-timeout-seconds", 180) * 1_000,
    longTimeoutMs: numberArg(args, "--long-timeout-minutes", 25) * 60_000,
    sender,
    dryRun: args.includes("--dry-run"),
  };
}

function allowedAdminMutationPath(path: string): boolean {
  if (path === "/integrations/groups/connect") return true;
  return /^\/integrations\/groups\/[^/?#]+\/disconnect$/u.test(path);
}

export async function postFeishuSoakAdminForm(
  request: FeishuSoakAdminFormRequest,
): Promise<void> {
  if (!allowedAdminMutationPath(request.path)) {
    throw new Error("unsupported soak administration path");
  }
  const origin = normalizeAdminUrl(request.adminUrl);
  const headers = new Headers({
    "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
    origin,
    "sec-fetch-site": "same-origin",
  });
  if (request.adminToken) {
    headers.set("authorization", `Bearer ${request.adminToken}`);
  }
  const response = await (request.fetchImpl ?? fetch)(
    `${origin}${request.path}`,
    {
      method: "POST",
      headers,
      body: new URLSearchParams(request.form),
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    },
  );
  const location = response.headers.get("location") ?? "";
  const rejectedConnect = request.path === "/integrations/groups/connect"
    && location.startsWith("/integrations/groups/connect?");
  if (
    response.status < 300
    || response.status >= 400
    || rejectedConnect
  ) {
    const responseText = await response.text();
    const detail = (request.adminToken
      ? responseText.replaceAll(request.adminToken, "[redacted]")
      : responseText)
      .replace(/\s+/gu, " ")
      .slice(0, 300);
    throw new Error(
      `HomeAgent administration request failed (${response.status})${
        detail ? `: ${detail}` : ""
      }`,
    );
  }
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/gu, " ").slice(0, 500);
}

class FeishuSoakDriver {
  private readonly options: FeishuSoakDriverOptions;
  private readonly runMarker: string;
  private readonly fixtureDir: string;
  private readonly processRunner: ProcessRunner;
  private attachmentMessageId?: string;
  private captured?: { messageId: string; rawId: string; token: string };

  constructor(
    options: FeishuSoakDriverOptions,
    processRunner: ProcessRunner = defaultProcessRunner,
  ) {
    this.options = options;
    this.processRunner = processRunner;
    this.runMarker = `F5-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8)}`;
    this.fixtureDir = mkdtempSync(join(tmpdir(), "homeagent-f5-e2e-"));
  }

  close(): void {
    rmSync(this.fixtureDir, { recursive: true, force: true });
  }

  private storedBinding(): StoredFeishuBinding | undefined {
    return valuesFromFile<StoredFeishuBinding>(
      join(this.options.dataDir, "config", "feishu-group-bindings.json"),
      "bindings",
    ).find((binding) => binding.chatId === this.options.chatId);
  }

  private async waitForBinding(
    state: StoredFeishuBinding["state"],
  ): Promise<StoredFeishuBinding> {
    return this.poll(`group binding ${state}`, 15_000, async () => {
      const binding = this.storedBinding();
      return binding?.state === state ? binding : undefined;
    }, 250);
  }

  private async adminConnect(
    policy: Pick<
      StoredFeishuBinding,
      "responseMode" | "participationLevel" | "replyInThread"
    >,
  ): Promise<StoredFeishuBinding> {
    await postFeishuSoakAdminForm({
      adminUrl: this.options.adminUrl,
      adminToken: this.options.adminToken,
      path: "/integrations/groups/connect",
      form: {
        chatId: this.options.chatId,
        responseMode: policy.responseMode,
        ...(policy.participationLevel
          ? { participationLevel: policy.participationLevel }
          : {}),
        ...(policy.replyInThread ? { replyInThread: "on" } : {}),
      },
    });
    return this.waitForBinding("active");
  }

  private async adminDisconnect(spaceId: string): Promise<void> {
    await postFeishuSoakAdminForm({
      adminUrl: this.options.adminUrl,
      adminToken: this.options.adminToken,
      path: `/integrations/groups/${encodeURIComponent(spaceId)}/disconnect`,
      form: {},
    });
    await this.waitForBinding("disconnected");
  }

  private async lifecycleMentionProbe(label: string): Promise<{
    messageId: string;
    replyId: string;
    rawId: string;
  }> {
    const token = `${this.runMarker}-${label}`;
    const messageId = await this.sendText(
      this.mention(
        `连接生命周期验收：9 + 6 等于多少？请用中文数字回答，并原样包含 ${token}`,
      ),
      `${this.runMarker}-${label.toLowerCase()}`,
    );
    const [reply, raw] = await Promise.all([
      this.waitForBotReply(messageId, { includes: ["十五", token] }),
      this.poll("connected group capture", this.options.responseTimeoutMs, async () =>
        this.rawForMessage(messageId, token)
      ),
    ]);
    return {
      messageId,
      replyId: reply.message_id,
      rawId: raw.id,
    };
  }

  private async assertDisconnectedPrivacy(): Promise<void> {
    const token = `${this.runMarker}-DISCONNECTED`;
    const messageId = await this.sendText(
      this.mention(
        `断开期间不应收录或回复这条消息。隐私验收标记：${token}`,
      ),
      `${this.runMarker}-disconnected`,
    );
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      if (this.rawForMessage(messageId, token)) {
        throw new Error("disconnected group message was unexpectedly captured");
      }
      const root = flattenLarkMessages(await this.listMessages()).find(
        (candidate) => candidate.message_id === messageId,
      );
      if (!root) throw new Error("disconnected probe is not visible to the Bot");
      if (
        flattenLarkMessages(root.thread_replies ?? []).some(
          (candidate) => isBotMessage(candidate, this.options.botOpenId),
        )
      ) {
        throw new Error("disconnected group message unexpectedly received a reply");
      }
      await Bun.sleep(Math.min(5_000, Math.max(1, deadline - Date.now())));
    }
  }

  private async groupBindingLifecycle(): Promise<string> {
    const original = this.storedBinding();
    if (original?.state === "needs_reconnect") {
      throw new Error(
        "group_binding_lifecycle requires an active, disconnected, or new target group",
      );
    }
    const lifecyclePolicy = original
      ? {
        responseMode: original.responseMode,
        participationLevel: original.participationLevel,
        replyInThread: original.replyInThread,
      }
      : {
        responseMode: "mentions_only" as const,
        participationLevel: undefined,
        replyInThread: true,
      };
    let lifecycleSpaceId: string | undefined;
    try {
      const connected = await this.adminConnect(lifecyclePolicy);
      lifecycleSpaceId = connected.spaceId;
      await this.lifecycleMentionProbe("ACTIVE");

      await this.adminDisconnect(connected.spaceId);
      await this.assertDisconnectedPrivacy();

      const reconnected = await this.adminConnect(lifecyclePolicy);
      if (reconnected.spaceId !== lifecycleSpaceId) {
        throw new Error("reconnect did not reuse the original group workspace");
      }
      const resumed = await this.lifecycleMentionProbe("RECONNECTED");
      return resumed.replyId;
    } finally {
      const current = this.storedBinding();
      if (original) {
        const restored = await this.adminConnect({
          responseMode: original.responseMode,
          participationLevel: original.participationLevel,
          replyInThread: original.replyInThread,
        });
        if (restored.spaceId !== original.spaceId) {
          throw new Error("cleanup did not restore the original group workspace");
        }
        if (original.state === "disconnected") {
          await this.adminDisconnect(original.spaceId);
        }
      } else if (current) {
        await this.adminDisconnect(current.spaceId);
      }
    }
  }

  private mention(text: string): string {
    return `<at user_id="${this.options.botOpenId}">agent</at> ${text}`;
  }

  private async lark(args: string[], cwd = process.cwd(), attempts = 4): Promise<LarkCliEnvelope> {
    return invokeLarkCliWithRetry(args, cwd, {
      attempts,
      processRunner: this.processRunner,
    });
  }

  private async requireFullGroupMessageCapability(): Promise<void> {
    const result = await this.processRunner([
      "auth",
      "check",
      "--scope",
      "im:message.group_msg",
      "--json",
    ], process.cwd());
    let parsed: Record<string, unknown>;
    try {
      parsed = object(JSON.parse(result.stdout.trim()));
    } catch {
      throw new Error(
        "proactive_participation requires a verified im:message.group_msg capability",
      );
    }
    const missing = Array.isArray(parsed.missing) ? parsed.missing : [];
    const granted = Array.isArray(parsed.granted)
      ? parsed.granted
      : Array.isArray(parsed.scopes)
        ? parsed.scopes
        : [];
    if (
      result.exitCode !== 0
      || missing.includes("im:message.group_msg")
      || !granted.includes("im:message.group_msg")
    ) {
      throw new Error(
        "proactive_participation requires enterprise approval for im:message.group_msg",
      );
    }
  }

  private emitUiAction(action: UiUserAction): void {
    console.log(`[F5_USER_ACTION] ${JSON.stringify(action)}`);
  }

  private async waitForUiMessage(
    probe: string,
    notBefore: number,
    rootMessageId?: string,
  ): Promise<string> {
    const message = await this.poll("UI user action", this.options.responseTimeoutMs, async () =>
      findFreshUserMessage(await this.listMessages(), {
        botOpenId: this.options.botOpenId,
        notBefore,
        contentIncludes: probe,
        rootMessageId,
      })
    );
    return message.message_id;
  }

  private async sendText(text: string, idempotencyKey: string): Promise<string> {
    if (this.options.sender === "ui") {
      const request = uiText(text);
      const notBefore = Date.now();
      this.emitUiAction({
        type: "soak_user_action",
        action: "send_text",
        chatId: this.options.chatId,
        ...request,
      });
      return this.waitForUiMessage(uiProbe(text), notBefore);
    }
    const envelope = await this.lark([
      "im", "+messages-send",
      "--as", "user",
      "--chat-id", this.options.chatId,
      "--text", text,
      "--idempotency-key", idempotencyKey.slice(0, 50),
    ]);
    return messageIdFrom(envelope);
  }

  private async replyText(rootMessageId: string, text: string, key: string): Promise<string> {
    if (this.options.sender === "ui") {
      const request = uiText(text);
      const notBefore = Date.now();
      this.emitUiAction({
        type: "soak_user_action",
        action: "reply_text",
        chatId: this.options.chatId,
        rootMessageId,
        ...request,
      });
      return this.waitForUiMessage(uiProbe(text), notBefore, rootMessageId);
    }
    const envelope = await this.lark([
      "im", "+messages-reply",
      "--as", "user",
      "--message-id", rootMessageId,
      "--text", text,
      "--reply-in-thread",
      "--idempotency-key", key.slice(0, 50),
    ]);
    return messageIdFrom(envelope);
  }

  private async sendMedia(kind: "file" | "image", path: string, key: string): Promise<string> {
    if (this.options.sender === "ui") {
      const notBefore = Date.now();
      this.emitUiAction({
        type: "soak_user_action",
        action: kind === "image" ? "send_image" : "send_file",
        chatId: this.options.chatId,
        path,
      });
      return this.waitForUiMessage(kind === "image" ? "[图片]" : basename(path), notBefore);
    }
    const envelope = await this.lark([
      "im", "+messages-send",
      "--as", "user",
      "--chat-id", this.options.chatId,
      `--${kind}`, `./${basename(path)}`,
      "--idempotency-key", key.slice(0, 50),
    ], dirname(path));
    return messageIdFrom(envelope);
  }

  private async listMessages(): Promise<LarkMessage[]> {
    const envelope = await this.lark([
      "im", "+chat-messages-list",
      "--as", "bot",
      "--chat-id", this.options.chatId,
      "--page-size", "50",
      "--order", "desc",
      "--no-reactions",
    ]);
    return messagesFrom(envelope);
  }

  private async poll<T>(
    label: string,
    timeoutMs: number,
    check: () => Promise<T | undefined>,
    intervalMs = 3_000,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        const result = await check();
        if (result !== undefined) return result;
      } catch (error) {
        lastError = error;
        if (!isTransientLarkFailure(error)) throw error;
      }
      await Bun.sleep(Math.min(intervalMs, Math.max(1, deadline - Date.now())));
    }
    throw new Error(`${label} timed out${lastError ? `: ${safeError(lastError)}` : ""}`);
  }

  private async waitForBotReply(
    rootMessageId: string,
    options: { includes?: string[]; pattern?: RegExp; timeoutMs?: number },
  ): Promise<LarkMessage> {
    return this.poll("bot reply", options.timeoutMs ?? this.options.responseTimeoutMs, async () =>
      findBotReply(await this.listMessages(), {
        botOpenId: this.options.botOpenId,
        rootMessageId,
        contentIncludes: options.includes,
        contentPattern: options.pattern,
      })
    );
  }

  private async waitForBotNotice(
    includes: string[],
    timeoutMs: number,
    notBefore?: number,
  ): Promise<LarkMessage> {
    return this.poll("bot notice", timeoutMs, async () =>
      flattenLarkMessages(await this.listMessages()).find((candidate) => {
        if (!isBotMessage(candidate, this.options.botOpenId)) return false;
        const content = candidate.content ?? "";
        const createdAt = candidate.create_time ? parseLarkCreateTime(candidate.create_time) : NaN;
        const freshEnough = notBefore === undefined
          || (Number.isFinite(createdAt) && createdAt >= notBefore - 60_000);
        return freshEnough
          && includes.every((part) => content.includes(part))
          && !looksLikeFailureReply(content);
      })
    );
  }

  private async assertNoBotReply(rootMessageId: string, observationMs: number): Promise<void> {
    const deadline = Date.now() + observationMs;
    while (Date.now() < deadline) {
      const root = flattenLarkMessages(await this.listMessages()).find(
        (candidate) => candidate.message_id === rootMessageId,
      );
      if (!root) throw new Error("message_capture root message is not visible to the bot");
      if (root && flattenLarkMessages(root.thread_replies ?? []).some(
        (candidate) => isBotMessage(candidate, this.options.botOpenId),
      )) {
        throw new Error("message_capture unexpectedly received a bot reply");
      }
      await Bun.sleep(Math.min(5_000, Math.max(1, deadline - Date.now())));
    }
  }

  private databasePath(): string {
    return join(
      this.options.dataDir,
      "workspaces",
      `team__${this.options.chatId}`,
      ".index.db",
    );
  }

  private rawForMessage(messageId: string, contentIncludes?: string): { id: string } | undefined {
    const database = new Database(this.databasePath(), { readonly: true });
    try {
      const row = contentIncludes
        ? database.query(
          "SELECT id FROM raw WHERE chat_id = ? AND message_id = ? AND content LIKE ? ORDER BY created DESC LIMIT 1",
        ).get(this.options.chatId, messageId, `%${contentIncludes}%`)
        : database.query(
          "SELECT id FROM raw WHERE chat_id = ? AND message_id = ? ORDER BY created DESC LIMIT 1",
        ).get(this.options.chatId, messageId);
      const id = object(row).id;
      return typeof id === "string" ? { id } : undefined;
    } finally {
      database.close();
    }
  }

  private pageForRaw(rawId: string): { slug: string; title: string } | undefined {
    const database = new Database(this.databasePath(), { readonly: true });
    try {
      const row = database.query(
        `SELECT slug, title FROM pages
         WHERE EXISTS (SELECT 1 FROM json_each(pages.sources_json) WHERE value = ?)
         ORDER BY updated DESC LIMIT 1`,
      ).get(rawId);
      const value = object(row);
      return typeof value.slug === "string" && typeof value.title === "string"
        ? { slug: value.slug, title: value.title }
        : undefined;
    } finally {
      database.close();
    }
  }

  private async messageCapture(): Promise<string> {
    const token = `${this.runMarker}-CAPTURE`;
    const messageId = await this.sendText(
      `【${this.runMarker}】家庭与团队自动验收事实：F5 收录口令是 ${token}。这是一条陈述，请静默收录。`,
      `${this.runMarker}-capture`,
    );
    const raw = await this.poll("message capture", this.options.responseTimeoutMs, async () =>
      this.rawForMessage(messageId, token)
    );
    this.captured = { messageId, rawId: raw.id, token };
    await this.assertNoBotReply(messageId, 45_000);
    return messageId;
  }

  private async mentionAnswer(): Promise<string> {
    const token = `${this.runMarker}-MENTION-OK`;
    const messageId = await this.sendText(
      this.mention(`自动验收问题：7 + 8 等于多少？请用中文数字回答，并原样包含 ${token}`),
      `${this.runMarker}-mention`,
    );
    const reply = await this.waitForBotReply(messageId, { includes: ["十五", token] });
    return reply.message_id;
  }

  private async proactiveParticipation(): Promise<string> {
    await this.requireFullGroupMessageCapability();
    const token = `${this.runMarker}-PROACTIVE-OK`;
    const messageId = await this.sendText(
      `这是面向全群的明确问题：7 + 6 等于多少？请用中文数字回答，并原样包含 ${token}。`,
      `${this.runMarker}-proactive`,
    );
    const reply = await this.waitForBotReply(messageId, { includes: ["十三", token] });
    return reply.message_id;
  }

  private async imageAnalysis(): Promise<string> {
    const imagePath = join(this.fixtureDir, `${this.runMarker}-red.png`);
    writeFileSync(imagePath, solidRedPng(), { mode: 0o600 });
    const rootMessageId = await this.sendMedia(
      "image",
      imagePath,
      `${this.runMarker}-image`,
    );
    const token = `${this.runMarker}-IMAGE-OK`;
    await this.replyText(
      rootMessageId,
      this.mention(`请识别这张纯色图片的主要颜色，不要猜测未看到的内容；回答颜色名称并原样附上 ${token}`),
      `${this.runMarker}-image-question`,
    );
    const reply = await this.waitForBotReply(rootMessageId, {
      includes: ["红色", token],
      timeoutMs: this.options.longTimeoutMs,
    });
    return reply.message_id;
  }

  private async attachmentExtraction(): Promise<string> {
    const token = `${this.runMarker}-ATTACHMENT`;
    const fixturePath = join(this.fixtureDir, `${this.runMarker}-attachment.txt`);
    writeFileSync(fixturePath, attachmentFixture(this.runMarker), { encoding: "utf8", mode: 0o600 });
    const messageId = await this.sendMedia(
      "file",
      fixturePath,
      `${this.runMarker}-attachment`,
    );
    await this.poll("attachment extraction", this.options.responseTimeoutMs, async () =>
      this.rawForMessage(messageId, token)
    );
    this.attachmentMessageId = messageId;
    return messageId;
  }

  private tasks(): StoredTask[] {
    return valuesFromFile<StoredTask>(join(this.options.dataDir, "config", "tasks.json"), "tasks");
  }

  private taskForResearch(): StoredTask {
    const selected = this.tasks()
      .filter((task) => task.space === `team/${this.options.chatId}`)
      .filter((task) => task.notify !== false)
      .filter((task) => !this.options.researchTaskName || task.name === this.options.researchTaskName)
      .at(-1);
    if (!selected) throw new Error("no notifying research task is configured for this chat");
    return selected;
  }

  private taskRuns(): StoredTaskRun[] {
    return valuesFromFile<StoredTaskRun>(
      join(this.options.dataDir, "config", "task-runs.json"),
      "runs",
    );
  }

  private async researchNotification(): Promise<string> {
    const windowStartedAt = firstSampleAt(this.options.monitorPath);
    if (windowStartedAt === undefined) {
      throw new Error(`cannot determine soak window start from ${this.options.monitorPath}`);
    }
    const selection = {
      chatId: this.options.chatId,
      windowStartedAt,
      taskName: this.options.researchTaskName,
    };
    let evidence = selectReusableResearchRun(this.tasks(), this.taskRuns(), selection);

    if (!evidence) {
      const active = selectInFlightResearchRun(this.tasks(), this.taskRuns(), selection);
      const pending = active ?? await (async () => {
        const task = this.taskForResearch();
        const sentAt = Date.now();
        await this.sendText(
          this.mention(`/task run ${task.name}`),
          `${this.runMarker}-research`,
        );
        const run = await this.poll("research task start", this.options.responseTimeoutMs, async () =>
          this.taskRuns()
            .filter((candidate) => candidate.taskId === task.id && candidate.startedAt >= sentAt)
            .sort((left, right) => right.startedAt - left.startedAt)[0]
        );
        return { task, run };
      })();
      const completed = await this.poll("research task completion", this.options.longTimeoutMs, async () => {
        const current = this.taskRuns().find((candidate) => candidate.id === pending.run.id);
        if (!current) return undefined;
        if (["failed", "timed_out", "cancelled"].includes(current.status)) {
          throw new Error(`research task ${current.id} ended with ${current.status}`);
        }
        return current.status === "succeeded" && current.notification?.status === "sent"
          ? current
          : undefined;
      }, 5_000);
      evidence = { task: pending.task, run: completed };
    }

    const notice = await this.waitForBotNotice(
      [`任务「${evidence.task.name}」已完成`],
      this.options.responseTimeoutMs,
      evidence.run.notification?.sentAt,
    );
    evidence.noticeMessageId = notice.message_id;
    return evidence.run.id;
  }

  private reminders(): StoredReminder[] {
    return valuesFromFile<StoredReminder>(
      join(this.options.dataDir, "config", "reminders.json"),
      "reminders",
    );
  }

  private async reminderDelivery(): Promise<string> {
    const token = `${this.runMarker}-REMINDER`;
    const messageId = await this.sendText(
      this.mention(`1分钟后提醒我 ${token}`),
      `${this.runMarker}-reminder`,
    );
    await this.waitForBotReply(messageId, { includes: ["已创建提醒", token] });
    const reminder = await this.poll("reminder persistence", this.options.responseTimeoutMs, async () =>
      this.reminders().find((candidate) => candidate.sourceMessageId === messageId)
    );
    await this.poll("reminder delivery", 3 * 60_000, async () => {
      const current = this.reminders().find((candidate) => candidate.id === reminder.id);
      return current?.lastNotifiedAt ? current : undefined;
    });
    await this.waitForBotNotice(["⏰ 提醒", token], this.options.responseTimeoutMs);
    return reminder.id;
  }

  private learningState(): {
    plans: StoredLearningPlan[];
    sessions: StoredLearningSession[];
  } {
    const path = join(this.options.dataDir, "config", "learning.json");
    return {
      plans: valuesFromFile<StoredLearningPlan>(path, "plans"),
      sessions: valuesFromFile<StoredLearningSession>(path, "sessions"),
    };
  }

  private async learningInteraction(): Promise<string> {
    if (!this.attachmentMessageId) {
      throw new Error("learning_interaction requires attachment_extraction in the same run");
    }
    const planName = `${this.runMarker}-学习计划`;
    await this.replyText(
      this.attachmentMessageId,
      `/learn new ${planName}`,
      `${this.runMarker}-learn-new`,
    );
    const created = await this.waitForBotReply(this.attachmentMessageId, {
      includes: ["已创建学习计划", planName],
      timeoutMs: this.options.longTimeoutMs,
    });
    void created;
    const plan = await this.poll("learning plan persistence", this.options.responseTimeoutMs, async () =>
      this.learningState().plans.find((candidate) => candidate.name === planName)
    );
    await this.waitForBotNotice([`📖 ${planName}`, "第 1 课"], this.options.longTimeoutMs);
    const session = await this.poll("learning session persistence", this.options.responseTimeoutMs, async () =>
      latestDeliveredLearningSession(this.learningState().sessions, plan.id)
    );
    const answerMessageId = await this.sendText(
      this.mention(`学习回答：我理解到重要结论要说明来源，操作步骤应可复现。${this.runMarker}`),
      `${this.runMarker}-learn-answer`,
    );
    await this.waitForBotReply(answerMessageId, {
      includes: ["已记录", planName],
      timeoutMs: this.options.longTimeoutMs,
    });
    await this.poll("learning answer persistence", this.options.responseTimeoutMs, async () => {
      const current = this.learningState().sessions.find((candidate) => candidate.id === session.id);
      return current?.status === "completed" && current.completedAt ? current : undefined;
    });
    return plan.id;
  }

  private async distillCitation(): Promise<string> {
    if (!this.captured) {
      throw new Error("distill_citation requires message_capture in the same run");
    }
    const commandMessageId = await this.sendText(
      this.mention("重新提炼"),
      `${this.runMarker}-distill`,
    );
    await this.waitForBotReply(commandMessageId, { includes: ["开始重新提炼"] });
    const page = await this.poll("manual distillation", this.options.longTimeoutMs, async () =>
      this.pageForRaw(this.captured!.rawId)
    );
    const messageId = await this.sendText(
      this.mention("刚才记录的 F5 收录口令是什么？请只依据知识库回答并引用来源。"),
      `${this.runMarker}-citation`,
    );
    const reply = await this.waitForBotReply(messageId, {
      includes: [this.captured.token, `[[${page.slug}|${page.title}]]`],
      timeoutMs: this.options.longTimeoutMs,
    });
    return reply.message_id;
  }

  private verifier(scenario: AutomatedScenario): () => Promise<string> {
    const verifiers: Record<AutomatedScenario, () => Promise<string>> = {
      group_binding_lifecycle: () => this.groupBindingLifecycle(),
      message_capture: () => this.messageCapture(),
      mention_answer: () => this.mentionAnswer(),
      proactive_participation: () => this.proactiveParticipation(),
      image_analysis: () => this.imageAnalysis(),
      attachment_extraction: () => this.attachmentExtraction(),
      research_notification: () => this.researchNotification(),
      reminder_delivery: () => this.reminderDelivery(),
      learning_interaction: () => this.learningInteraction(),
      distill_citation: () => this.distillCitation(),
    };
    return verifiers[scenario];
  }

  async run(): Promise<ScenarioResult[]> {
    const results: ScenarioResult[] = [];
    for (const scenario of this.options.scenarios) {
      console.log(`[F5] ${scenario}: running`);
      try {
        const evidence = await executeVerifiedScenario(
          scenario,
          this.options.evidencePath,
          this.verifier(scenario),
        );
        results.push({ scenario, ok: true, artifactId: evidence.artifactId });
        console.log(`[F5] ${scenario}: passed (${evidence.artifactId})`);
      } catch (error) {
        const message = safeError(error);
        results.push({ scenario, ok: false, error: message });
        console.error(`[F5] ${scenario}: failed (${message})`);
      }
    }
    return results;
  }
}

function printPlan(options: FeishuSoakDriverOptions): void {
  console.log(JSON.stringify({
    chatId: options.chatId,
    adminUrl: options.adminUrl,
    evidencePath: options.evidencePath,
    monitorPath: options.monitorPath,
    scenarios: options.scenarios,
    sender: options.sender,
    requiredUserScopes: options.sender === "api"
      ? ["im:message.send_as_user", "im:message", "im:resource:upload", "im:resource"]
      : [],
    uiActionPrefix: options.sender === "ui" ? "[F5_USER_ACTION]" : undefined,
    supervisedScenario: "network_recovery",
  }, null, 2));
}

if (import.meta.main) {
  try {
    const options = parseFeishuSoakOptions(process.argv.slice(2));
    if (!options.chatId) throw new Error("--chat-id is required");
    if (!options.botOpenId) throw new Error("--bot-open-id is required");
    if (options.dryRun) {
      printPlan(options);
    } else {
      const driver = new FeishuSoakDriver(options);
      try {
        const results = await driver.run();
        const failed = results.filter((result) => !result.ok);
        console.log(JSON.stringify({
          passed: results.length - failed.length,
          failed: failed.length,
          supervisedRemaining: "network_recovery",
          results,
        }, null, 2));
        if (failed.length > 0) process.exitCode = 1;
      } finally {
        driver.close();
      }
    }
  } catch (error) {
    console.error(`soak:feishu: ${safeError(error)}`);
    process.exitCode = 1;
  }
}
