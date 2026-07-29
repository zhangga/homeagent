/**
 * Feishu connector (plan §IV, Slice 5). All lark-cli usage is confined to this
 * file (plan R6). It:
 *   - spawns `event consume im.message.receive_v1 --as bot` and
 *     `event consume im.chat.member.bot.added_v1 --as bot`, each as a long-lived
 *     subprocess;
 *   - blocks on stderr until the `[event] ready` marker before trusting stdout
 *     (lark-event subprocess contract);
 *   - parses NDJSON stdout, normalizes to InboundEvents, forwards to the handler;
 *   - restarts a crashed consumer with exponential backoff (plan R4);
 *   - stops with SIGTERM only (never kill -9, which leaks subscriptions);
 *   - sends replies/notices via `im +messages-reply --as bot`;
 *   - adds/removes native message reactions via `im reactions`;
 *   - fetches docx links via `docs +fetch --as user` for doc sync (Q8).
 */
import { config, logger } from "@homeagent/shared";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Connector,
  ConnectorHealth,
  DownloadedAttachment,
  InboundEvent,
  OutboundReply,
  ReplyTarget,
} from "./connector.ts";
import {
  normalizeBotAdded,
  normalizeMessage,
  parseMessageResources,
  type FeishuIdentity,
} from "./feishu-normalize.ts";
import { bunSpawner, lines, type ProcHandle, type ProcSpawner } from "./process.ts";

const log = logger.child("feishu");

const MESSAGE_KEY = "im.message.receive_v1";
const BOT_ADDED_KEY = "im.chat.member.bot.added_v1";
const READY_RE = /\[event\]\s+ready\b/;
const MAX_REPLY_CONTEXT_CHARS = 20_000;

export interface CancellableDeadline {
  elapsed: Promise<void>;
  cancel: () => void;
}

export type DeadlineFactory = (timeoutMs: number) => CancellableDeadline;

export interface CommandOptions {
  cwd?: string;
  timeoutMs?: number;
  terminationGraceMs?: number;
  /** sensitive command input passed through a pipe, never argv */
  stdin?: string;
  /** per-command environment overlay */
  env?: Record<string, string>;
  /** injectable clock seam; defaults to a cancellable setTimeout */
  deadlineFactory?: DeadlineFactory;
  /** absolute path to a command-created file that must stay within the byte limit */
  outputPath?: string;
  maxOutputBytes?: number;
}

type RunCommand = (cmd: string[], opts?: CommandOptions) => Promise<string>;

export interface FeishuConnectorOptions {
  larkBin?: string;
  identity?: FeishuIdentity;
  /** injected for tests; defaults to Bun.spawn */
  spawner?: ProcSpawner;
  /** base backoff ms for restart (doubles up to a cap) */
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /**
   * Give up on a consumer that never reaches the ready marker after this many
   * consecutive attempts (a permanent config/scope error, e.g. an event that is
   * not enabled in the developer console). Healthy-then-crashed consumers are
   * always restarted regardless. Default 5.
   */
  maxNeverReady?: number;
  /** maximum accepted downloaded attachment size; defaults to 20 MiB */
  maxAttachmentBytes?: number;
  /** run a command and return its stdout (injected for tests) */
  runCommand?: RunCommand;
}

interface Consumer {
  key: string;
  proc?: ProcHandle;
  stopped: boolean;
  attempts: number;
  /** consecutive failures to ever reach the ready marker */
  neverReady: number;
  state: "starting" | "ready" | "backoff" | "failed" | "stopped";
  lastReadyAt?: number;
  lastEventAt?: number;
  lastError?: string;
}

interface FetchedMessage {
  message_id?: string;
  parent_id?: string;
  root_id?: string;
  sender?: { id?: string };
  msg_type?: string;
  body?: { content?: string };
}

function renderFetchedMessage(message: FetchedMessage | undefined): string | undefined {
  if (!message) return undefined;
  const type = message.msg_type;
  const content = message.body?.content;
  if (type === "image") return "【图片】";
  if (type === "audio") return "【音频：当前只获取到音频引用】";
  if (type === "media") return "【视频：当前只获取到视频引用】";
  if (!content) return type === "file" ? "【文件：当前只获取到文件引用】" : undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return boundReplyContext(content);
  }
  if (typeof parsed !== "object" || parsed === null) return boundReplyContext(content);

  const value = parsed as Record<string, unknown>;
  if (typeof value.text === "string" && value.text.trim()) return boundReplyContext(value.text);
  if (type === "file") {
    const name = typeof value.file_name === "string" ? value.file_name.trim() : "";
    return name ? `【文件：${name}】` : "【文件】";
  }

  const parts: string[] = [];
  collectRichText(parsed, parts);
  const rendered = parts.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return boundReplyContext(rendered || content);
}

function boundReplyContext(text: string): string | undefined {
  const normalized = text.trim();
  if (!normalized) return undefined;
  if (normalized.length <= MAX_REPLY_CONTEXT_CHARS) return normalized;
  return `${normalized.slice(0, MAX_REPLY_CONTEXT_CHARS)}\n【上下文已截断】`;
}

function collectRichText(value: unknown, parts: string[], depth = 0): void {
  if (depth > 20 || parts.length > 1_000) return;
  if (Array.isArray(value)) {
    for (const item of value) collectRichText(item, parts, depth + 1);
    return;
  }
  if (typeof value !== "object" || value === null) return;

  const node = value as Record<string, unknown>;
  const tag = typeof node.tag === "string" ? node.tag : undefined;
  if (tag === "text" && typeof node.text === "string" && node.text.trim()) {
    parts.push(node.text.trim());
    return;
  }
  if (tag === "a") {
    const label = typeof node.text === "string" ? node.text.trim() : "";
    const href = typeof node.href === "string" ? node.href.trim() : "";
    if (label || href) parts.push(label || href);
    return;
  }
  if (tag === "at") {
    const name = typeof node.user_name === "string" ? node.user_name.trim() : "";
    if (name) parts.push(`@${name}`);
    return;
  }
  if (tag === "img") {
    parts.push("【图片】");
    return;
  }

  if (typeof node.title === "string" && node.title.trim()) parts.push(node.title.trim());
  if ("content" in node) collectRichText(node.content, parts, depth + 1);
  for (const [key, child] of Object.entries(node)) {
    if (key === "title" || key === "content" || key === "tag") continue;
    if (/^[a-z]{2}_[A-Z]{2}$/.test(key)) collectRichText(child, parts, depth + 1);
  }
}

export class FeishuConnector implements Connector {
  readonly name = "feishu";
  private larkBin: string;
  private identity: FeishuIdentity;
  private spawner: ProcSpawner;
  private backoffBaseMs: number;
  private backoffMaxMs: number;
  private maxNeverReady: number;
  private maxAttachmentBytes: number;
  private runCommand: RunCommand;
  private handler?: (event: InboundEvent) => void | Promise<void>;
  private consumers: Consumer[] = [];
  private stopping = false;

  constructor(opts: FeishuConnectorOptions = {}) {
    this.larkBin = opts.larkBin ?? "lark-cli";
    this.identity = opts.identity ?? {
      // Bot identity is snapshotted at startup from config() (settings.json +
      // env). Editing it in the management backend takes effect on next restart.
      botName: config().feishuBotName,
      botOpenId: config().feishuBotOpenId,
    };
    this.spawner = opts.spawner ?? bunSpawner;
    this.backoffBaseMs = opts.backoffBaseMs ?? 1000;
    this.backoffMaxMs = opts.backoffMaxMs ?? 60_000;
    this.maxNeverReady = opts.maxNeverReady ?? 5;
    this.maxAttachmentBytes = opts.maxAttachmentBytes ?? 20 * 1024 * 1024;
    this.runCommand = opts.runCommand ?? runFeishuCommand;
  }

  async start(onEvent: (event: InboundEvent) => void | Promise<void>): Promise<void> {
    this.handler = onEvent;
    this.stopping = false;
    this.consumers = [
      { key: MESSAGE_KEY, stopped: false, attempts: 0, neverReady: 0, state: "starting" },
      { key: BOT_ADDED_KEY, stopped: false, attempts: 0, neverReady: 0, state: "starting" },
    ];
    // Launch each consumer loop; do not await (they run for the connector's life).
    for (const c of this.consumers) void this.runConsumer(c);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const c of this.consumers) {
      c.stopped = true;
      c.state = "stopped";
      c.proc?.kill(); // SIGTERM
    }
  }

  health(): ConnectorHealth {
    const consumers = this.consumers.map((consumer) => ({
      key: consumer.key,
      state: consumer.state,
      attempts: consumer.attempts,
      lastReadyAt: consumer.lastReadyAt,
      lastEventAt: consumer.lastEventAt,
      lastError: consumer.lastError,
    }));
    const eventTimes = consumers
      .map((consumer) => consumer.lastEventAt)
      .filter((at): at is number => at !== undefined);
    return {
      name: this.name,
      ready: consumers.length > 0 && consumers.every((consumer) => consumer.state === "ready"),
      lastEventAt: eventTimes.length > 0 ? Math.max(...eventTimes) : undefined,
      consumers,
    };
  }

  // ---- inbound: consumer loop with ready-gating + backoff -----------------

  private async runConsumer(c: Consumer): Promise<void> {
    while (!c.stopped && !this.stopping) {
      c.state = "starting";
      const cmd = [this.larkBin, "event", "consume", c.key, "--as", "bot"];
      log.info("starting consumer", { key: c.key });
      let proc: ProcHandle;
      try {
        proc = this.spawner.spawn(cmd);
      } catch (err) {
        c.neverReady += 1;
        c.lastError = String(err).slice(-300);
        log.warn("consumer process failed to spawn", {
          key: c.key,
          neverReady: c.neverReady,
          err: c.lastError,
        });
        if (c.neverReady >= this.maxNeverReady) {
          c.state = "failed";
          log.error("giving up on consumer (process could not spawn)", { key: c.key });
          break;
        }
        await this.backoff(c);
        continue;
      }
      c.proc = proc;

      const { ready, stderrTail } = await this.awaitReady(proc, c.key);
      if (ready) {
        c.attempts = 0; // healthy start resets backoff
        c.neverReady = 0;
        c.state = "ready";
        c.lastReadyAt = Date.now();
        c.lastError = undefined;
        await this.pumpStdout(proc, c);
      } else {
        // Process ended before ready — a startup failure. Track separately from
        // post-ready crashes so a permanently-misconfigured event key (e.g. not
        // enabled in the console) stops retrying instead of looping forever.
        c.neverReady += 1;
        c.lastError = stderrTail.slice(-300) || "consumer exited before ready";
        log.warn("consumer exited before ready", {
          key: c.key,
          neverReady: c.neverReady,
          detail: stderrTail.slice(-300),
        });
        if (c.neverReady >= this.maxNeverReady) {
          c.state = "failed";
          log.error("giving up on consumer (never reached ready)", {
            key: c.key,
            hint: "check that the event is enabled in the developer console and the bot has the required scope",
          });
          break;
        }
      }

      if (c.stopped || this.stopping) break;
      // crashed / exited: exponential backoff before restart (plan R4)
      await this.backoff(c);
    }
    if (c.stopped || this.stopping) c.state = "stopped";
    log.info("consumer loop ended", { key: c.key });
  }

  private async backoff(c: Consumer): Promise<void> {
    c.attempts += 1;
    c.state = "backoff";
    const backoff = Math.min(this.backoffBaseMs * 2 ** (c.attempts - 1), this.backoffMaxMs);
    const jitter = Math.random() * Math.min(500, backoff);
    log.warn("consumer down; backing off", {
      key: c.key,
      attempts: c.attempts,
      backoffMs: Math.round(backoff + jitter),
    });
    await Bun.sleep(backoff + jitter);
  }

  /**
   * Block on stderr until the ready marker, or resolve not-ready if the process
   * exits first. Captures a tail of stderr for diagnostics.
   */
  private async awaitReady(
    proc: ProcHandle,
    key: string,
  ): Promise<{ ready: boolean; stderrTail: string }> {
    let ready = false;
    let stderrTail = "";
    const exitRace = proc.exited.then(() => "exited" as const);
    const readScan = (async () => {
      for await (const line of lines(proc.stderr)) {
        const trimmed = line.trim();
        if (trimmed) {
          stderrTail = (stderrTail + "\n" + trimmed).slice(-1000);
          log.debug("consumer stderr", { key, line: trimmed });
        }
        if (READY_RE.test(line)) {
          ready = true;
          return "ready" as const;
        }
      }
      return "eof" as const;
    })();
    const winner = await Promise.race([exitRace, readScan]);
    return { ready: ready || winner === "ready", stderrTail };
  }

  /** Read NDJSON from stdout, normalize, forward. Returns when stdout ends. */
  private async pumpStdout(proc: ProcHandle, c: Consumer): Promise<void> {
    try {
      for await (const line of lines(proc.stdout)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let obj: Record<string, unknown>;
        try {
          obj = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          log.debug("non-json stdout line ignored", { key: c.key });
          continue;
        }
        const event =
          c.key === MESSAGE_KEY
            ? normalizeMessage(obj, this.identity)
            : normalizeBotAdded(obj);
        if (!event) continue;
        c.lastEventAt = Date.now();
        try {
          await this.handler?.(event);
        } catch (err) {
          log.error("event handler threw", { key: c.key, err: String(err) });
        }
      }
    } catch (err) {
      c.lastError = String(err);
      log.warn("stdout pump error", { key: c.key, err: String(err) });
    }
    const exitCode = await proc.exited.catch(() => null);
    if (!c.stopped && !this.stopping && !c.lastError) {
      c.lastError = `consumer exited with code ${exitCode ?? "unknown"}`;
    }
  }

  // ---- outbound -----------------------------------------------------------

  async reply(out: OutboundReply): Promise<void> {
    const cmd = [
      this.larkBin,
      "im",
      "+messages-reply",
      "--as",
      "bot",
      "--markdown",
      out.markdown,
    ];
    if (out.replyToMessageId) cmd.push("--message-id", out.replyToMessageId);
    if (out.inThread) cmd.push("--reply-in-thread");
    try {
      await this.runCommand(cmd);
    } catch (err) {
      log.error("reply failed", { err: String(err) });
    }
  }

  async notice(chatId: string, markdown: string): Promise<void> {
    // A notice is a standalone message to a chat (not a reply). Uses the
    // +messages-send shortcut with --chat-id.
    const cmd = [
      this.larkBin,
      "im",
      "+messages-send",
      "--as",
      "bot",
      "--chat-id",
      chatId,
      "--markdown",
      markdown,
    ];
    try {
      await this.runCommand(cmd);
    } catch (err) {
      log.error("notice failed", { err: String(err) });
      throw err;
    }
  }

  async addReaction(messageId: string, emojiType: string): Promise<string | undefined> {
    const cmd = [
      this.larkBin,
      "im",
      "reactions",
      "create",
      "--as",
      "bot",
      "--message-id",
      messageId,
      "--data",
      JSON.stringify({ reaction_type: { emoji_type: emojiType } }),
      "--json",
    ];
    try {
      const out = await this.runCommand(cmd);
      const parsed = JSON.parse(out) as Record<string, unknown>;
      const data = parsed.data as Record<string, unknown> | undefined;
      return typeof data?.reaction_id === "string" ? data.reaction_id : undefined;
    } catch (err) {
      // Reactions are only a progress hint; failure must never block the reply.
      log.warn("add reaction failed", { messageId, emojiType, err: String(err) });
      return undefined;
    }
  }

  async removeReaction(messageId: string, reactionId: string): Promise<void> {
    const cmd = [
      this.larkBin,
      "im",
      "reactions",
      "delete",
      "--as",
      "bot",
      "--message-id",
      messageId,
      "--reaction-id",
      reactionId,
      "--json",
    ];
    try {
      await this.runCommand(cmd);
    } catch (err) {
      log.warn("remove reaction failed", { messageId, reactionId, err: String(err) });
    }
  }

  async resolveReplyTarget(messageId: string): Promise<ReplyTarget | undefined> {
    try {
      const current = await this.fetchMessage(messageId);
      const targetId = current?.parent_id ?? current?.root_id;
      if (!targetId || targetId === messageId) return undefined;
      const target = await this.fetchMessage(targetId);
      const resolved: ReplyTarget = {
        messageId: targetId,
        senderId: target?.sender?.id,
      };
      const text = renderFetchedMessage(target);
      if (text) resolved.text = text;
      if (target?.msg_type) resolved.messageType = target.msg_type;
      return resolved;
    } catch (err) {
      log.warn("resolve reply target failed", { messageId, err: String(err) });
      return undefined;
    }
  }

  async downloadAttachments(messageId: string): Promise<DownloadedAttachment[]> {
    const message = await this.fetchMessage(messageId);
    const resources = parseMessageResources(message?.msg_type, message?.body?.content);
    const downloads: DownloadedAttachment[] = [];

    for (const resource of resources) {
      const directory = mkdtempSync(join(tmpdir(), "homeagent-attachment-"));
      const output = "resource.bin";
      try {
        await this.runCommand(
          [
            this.larkBin,
            "im",
            "+messages-resources-download",
            "--as",
            "bot",
            "--message-id",
            messageId,
            "--file-key",
            resource.fileKey,
            "--type",
            resource.resourceType,
            "--output",
            output,
            "--json",
          ],
          {
            cwd: directory,
            timeoutMs: 30_000,
            outputPath: join(directory, output),
            maxOutputBytes: this.maxAttachmentBytes,
          },
        );
        const localPath = join(directory, output);
        const sizeBytes = statSync(localPath).size;
        if (sizeBytes > this.maxAttachmentBytes) {
          rmSync(directory, { recursive: true, force: true });
          log.warn("attachment exceeds size limit", { messageId, sizeBytes });
          continue;
        }
        downloads.push({
          attachment: {
            kind: resource.kind,
            ref: resource.fileKey,
            name: resource.name,
          },
          localPath,
          sizeBytes,
          cleanup: () => rmSync(directory, { recursive: true, force: true }),
        });
      } catch (err) {
        rmSync(directory, { recursive: true, force: true });
        log.warn("attachment download failed", {
          messageId,
          fileKey: resource.fileKey,
          err: String(err),
        });
      }
    }

    return downloads;
  }

  private async fetchMessage(messageId: string): Promise<FetchedMessage | undefined> {
    // The higher-level +messages-mget shortcut intentionally formats message
    // output and currently drops parent_id/root_id. Use the raw read endpoint
    // so reply relationships survive intact.
    const out = await this.runCommand(
      [
        this.larkBin,
        "api",
        "GET",
        `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`,
        "--as",
        "bot",
        "--params",
        JSON.stringify({ user_id_type: "open_id" }),
        "--json",
      ],
      { timeoutMs: 30_000 },
    );
    const parsed = JSON.parse(out) as Record<string, unknown>;
    const data = parsed.data as Record<string, unknown> | undefined;
    const items = data?.items;
    return Array.isArray(items) ? (items[0] as FetchedMessage | undefined) : undefined;
  }

  async isChatAdministrator(chatId: string, userId: string): Promise<boolean> {
    try {
      const out = await this.runCommand([
        this.larkBin,
        "im",
        "chats",
        "get",
        "--as",
        "bot",
        "--chat-id",
        chatId,
        "--user-id-type",
        "open_id",
        "--json",
      ]);
      const parsed = JSON.parse(out) as Record<string, unknown>;
      const data = parsed.data as Record<string, unknown> | undefined;
      const managers = Array.isArray(data?.user_manager_id_list)
        ? data.user_manager_id_list.map(String)
        : [];
      return data?.owner_id === userId || managers.includes(userId);
    } catch (err) {
      log.warn("chat administrator lookup failed", { chatId, userId, err: String(err) });
      return false;
    }
  }

  // ---- doc sync (Q8) ------------------------------------------------------

  /** Fetch a docx/wiki link as markdown (user identity). Returns null on error. */
  async fetchDoc(docUrlOrToken: string): Promise<string | null> {
    const cmd = [
      this.larkBin,
      "docs",
      "+fetch",
      "--doc",
      docUrlOrToken,
      "--doc-format",
      "markdown",
      "--as",
      "user",
      "--json",
    ];
    try {
      const out = await this.runCommand(cmd);
      // The CLI returns JSON; the markdown is under a content-ish field. Be
      // permissive about the exact key so a CLI shape tweak degrades gracefully.
      const parsed = JSON.parse(out) as Record<string, unknown>;
      const content =
        (parsed.markdown as string | undefined) ??
        (parsed.content as string | undefined) ??
        ((parsed.data as Record<string, unknown> | undefined)?.content as string | undefined);
      return content ?? null;
    } catch (err) {
      log.warn("doc fetch failed", { doc: docUrlOrToken, err: String(err) });
      return null;
    }
  }
}

/** Run a command to completion and return trimmed stdout; throws on non-zero. */
export async function runFeishuCommand(
  cmd: string[],
  opts: CommandOptions = {},
): Promise<string> {
  const env = opts.env ? { ...process.env, ...opts.env } : undefined;
  const spawnCommand = resolveWindowsCommandShim(cmd, env, opts.cwd);
  const proc = Bun.spawn(spawnCommand, {
    cwd: opts?.cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: opts.stdin === undefined ? "ignore" : "pipe",
    env,
  });
  if (opts.stdin !== undefined && proc.stdin && typeof proc.stdin !== "number") {
    proc.stdin.write(opts.stdin);
    proc.stdin.end();
  }
  const stdout = collectStream(proc.stdout);
  const stderr = collectStream(proc.stderr);
  const completion = Promise.all([stdout.result, stderr.result, proc.exited]);
  const timeoutMs = opts.timeoutMs;
  const deadline = timeoutMs === undefined
    ? undefined
    : (opts.deadlineFactory ?? createDeadline)(Math.max(1, timeoutMs));
  const outputWatch = opts.outputPath !== undefined && opts.maxOutputBytes !== undefined
    ? watchFileSize(opts.outputPath, opts.maxOutputBytes)
    : undefined;
  const outcome = await (async () => {
    try {
      return await Promise.race([
        completion.then((value) => ({ kind: "completed" as const, value })),
        ...(deadline === undefined
          ? []
          : [deadline.elapsed.then(() => ({ kind: "timeout" as const }))]),
        ...(outputWatch === undefined
          ? []
          : [outputWatch.exceeded.then((sizeBytes) => ({
              kind: "output-limit" as const,
              sizeBytes,
            }))]),
      ]);
    } finally {
      deadline?.cancel();
      outputWatch?.cancel();
    }
  })();

  if (outcome.kind !== "completed") {
    await terminateProcess(proc, Math.max(1, opts.terminationGraceMs ?? 250));
    stdout.cancel();
    stderr.cancel();
    if (outcome.kind === "output-limit") {
      throw new Error(
        `command output exceeded ${opts.maxOutputBytes} bytes (observed ${outcome.sizeBytes})`,
      );
    }
    throw new Error(`command timed out after ${timeoutMs}ms`);
  }

  const [stdoutText, stderrText, code] = outcome.value;
  if (code !== 0) throw new Error(`command failed (${code}): ${stderrText.slice(0, 500)}`);
  return stdoutText;
}

function resolveWindowsCommandShim(
  cmd: string[],
  env: Record<string, string | undefined> | undefined,
  cwd: string | undefined,
): string[] {
  if (process.platform !== "win32" || cmd.length === 0) return cmd;
  const executable = cmd[0]!;
  if (/[\\/]/.test(executable)) return cmd;
  const resolved = Bun.which(executable, {
    PATH: env?.PATH ?? env?.Path ?? process.env.PATH,
    cwd: cwd ?? process.cwd(),
  });
  return resolved ? [resolved, ...cmd.slice(1)] : cmd;
}

function collectStream(stream: ReadableStream<Uint8Array>): {
  result: Promise<string>;
  cancel: () => void;
} {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let cancelled = false;
  const result = (async () => {
    let text = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      return text + decoder.decode();
    } catch (err) {
      if (cancelled) return text;
      throw err;
    }
  })();
  return {
    result,
    cancel: () => {
      cancelled = true;
      void reader.cancel().catch(() => {
        // A concurrently exiting process may already have closed the stream.
      });
    },
  };
}

function watchFileSize(path: string, maxBytes: number): {
  exceeded: Promise<number>;
  cancel: () => void;
} {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  let resolveExceeded!: (sizeBytes: number) => void;
  const exceeded = new Promise<number>((resolve) => {
    resolveExceeded = resolve;
  });
  const inspect = () => {
    if (cancelled) return;
    try {
      const sizeBytes = statSync(path).size;
      if (sizeBytes > maxBytes) {
        resolveExceeded(sizeBytes);
        return;
      }
    } catch {
      // The CLI creates the output asynchronously; absence is expected initially.
    }
    timer = setTimeout(inspect, 25);
  };
  inspect();
  return {
    exceeded,
    cancel: () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

async function terminateProcess(
  proc: ReturnType<typeof Bun.spawn>,
  graceMs: number,
): Promise<void> {
  try {
    proc.kill("SIGTERM");
  } catch {
    // The process may have exited at the boundary.
  }
  if (!(await settlesWithin(proc.exited, graceMs))) {
    try {
      proc.kill("SIGKILL");
    } catch {
      // The process may have exited during the grace-period boundary.
    }
    await settlesWithin(proc.exited, graceMs);
  }
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  const deadline = createDeadline(timeoutMs);
  try {
    return await Promise.race([
      promise.then(() => true, () => true),
      deadline.elapsed.then(() => false),
    ]);
  } finally {
    deadline.cancel();
  }
}

export function createDeadline(timeoutMs: number): CancellableDeadline {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const elapsed = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, Math.max(1, timeoutMs));
  });
  return {
    elapsed,
    cancel: () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}
