/**
 * CLI connector (plan §IV cli, Slice 4). A debug surface that lets us drive the
 * entire orchestrator main-flow from a terminal or a test — WITHOUT feishu. This
 * is the plan's key insight for validating the trunk before touching lark-cli
 * (plan §九: "cli connector is the trunk-validation key; the archived version
 * lacked this").
 *
 * Two modes:
 *   - programmatic: push InboundEvents via inject(); replies are captured in
 *     `sent` and forwarded to onEvent handlers. Ideal for tests.
 *   - interactive: read lines from stdin, print replies to stdout. Line syntax:
 *       plain text            -> p2p message from the default user
 *       /group <text>         -> group message WITHOUT @bot (silent remember)
 *       /at <text>            -> group message WITH @bot (should get a reply)
 *       /added                -> simulate the bot being added to the group
 */
import type {
  Connector,
  InboundEvent,
  InboundMessage,
  NoticeOptions,
  OutboundReply,
} from "./connector.ts";

export interface CliConnectorOptions {
  /** default sender open_id for p2p lines */
  userId?: string;
  /** chat id used for /group and /at lines */
  groupChatId?: string;
  /** p2p chat id (feishu p2p chat_id also starts with oc_, but distinct) */
  p2pChatId?: string;
  /** when true, read stdin interactively */
  interactive?: boolean;
  /** sink for outbound replies (defaults to stdout in interactive mode) */
  onReply?: (out: OutboundReply) => void;
  /**
   * Debug-only hook for slash-commands the connector does not itself understand
   * (e.g. `/dream`). Lets an app wire debug behaviors without the transport
   * knowing about the engine. Return true if the command was handled.
   */
  onSlash?: (cmd: string, rest: string) => boolean | Promise<boolean>;
}

export class CliConnector implements Connector {
  readonly name = "cli";
  private handler?: (event: InboundEvent) => void | Promise<void>;
  private counter = 0;
  private stopped = false;
  private opts: Required<Omit<CliConnectorOptions, "onReply" | "onSlash">> &
    Pick<CliConnectorOptions, "onReply" | "onSlash">;
  /** captured outbound replies (programmatic mode / assertions) */
  readonly sent: OutboundReply[] = [];
  readonly notices: { chatId: string; markdown: string }[] = [];

  constructor(opts: CliConnectorOptions = {}) {
    this.opts = {
      userId: opts.userId ?? "ou_cli_user",
      groupChatId: opts.groupChatId ?? "oc_cli_group",
      p2pChatId: opts.p2pChatId ?? "oc_cli_p2p",
      interactive: opts.interactive ?? false,
      onReply: opts.onReply,
      onSlash: opts.onSlash,
    };
  }

  async start(onEvent: (event: InboundEvent) => void | Promise<void>): Promise<void> {
    this.handler = onEvent;
    if (this.opts.interactive) await this.readStdin();
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }

  async reply(out: OutboundReply): Promise<void> {
    this.sent.push(out);
    if (this.opts.onReply) this.opts.onReply(out);
    else if (this.opts.interactive) process.stdout.write(`\n🤖 ${out.markdown}\n\n`);
  }

  async notice(chatId: string, markdown: string, _opts?: NoticeOptions): Promise<void> {
    this.notices.push({ chatId, markdown });
    if (this.opts.onReply) this.opts.onReply({ chatId, markdown });
    else if (this.opts.interactive) process.stdout.write(`\n📢 [${chatId}] ${markdown}\n\n`);
  }

  // ---- programmatic injection (tests) -------------------------------------

  private nextId(): string {
    return `cli-${++this.counter}`;
  }

  private baseMessage(): Omit<InboundMessage, "chatType" | "chatId" | "text" | "mentionsBot"> {
    const id = this.nextId();
    return {
      kind: "message",
      eventId: id,
      senderId: this.opts.userId,
      messageId: `om_${id}`,
      createdAt: Date.now(),
    };
  }

  /** Inject a p2p (private chat) message. */
  async sendP2P(text: string): Promise<void> {
    await this.dispatch({
      ...this.baseMessage(),
      chatType: "p2p",
      chatId: this.opts.p2pChatId,
      text,
      mentionsBot: true, // p2p is always addressed to the bot
    });
  }

  /** Inject a group message; `mention` gates whether the bot should respond. */
  async sendGroup(text: string, mention: boolean): Promise<void> {
    await this.dispatch({
      ...this.baseMessage(),
      chatType: "group",
      chatId: this.opts.groupChatId,
      text,
      mentionsBot: mention,
    });
  }

  /** Inject a raw event (e.g. bot_added). */
  async inject(event: InboundEvent): Promise<void> {
    await this.dispatch(event);
  }

  /** Simulate the bot being added to the group. */
  async sendBotAdded(): Promise<void> {
    await this.dispatch({
      kind: "bot_added",
      eventId: this.nextId(),
      chatId: this.opts.groupChatId,
      createdAt: Date.now(),
    });
  }

  private async dispatch(event: InboundEvent): Promise<void> {
    if (!this.handler) throw new Error("CliConnector.start must be called before dispatching");
    await this.handler(event);
  }

  // ---- interactive stdin --------------------------------------------------

  private async readStdin(): Promise<void> {
    process.stdout.write(
      "homeagent cli connector ready. Built-in: /at <text>, /group <text>, /added; other /commands are handled by the app (see startup banner). Ctrl-D to exit.\n> ",
    );
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of Bun.stdin.stream()) {
      if (this.stopped) break;
      buffer += decoder.decode(chunk);
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        await this.handleLine(line);
        process.stdout.write("> ");
      }
    }
  }

  private async handleLine(line: string): Promise<void> {
    if (line === "") return;
    if (line === "/added") return this.sendBotAdded();
    if (line.startsWith("/at ")) return this.sendGroup(line.slice(4), true);
    if (line.startsWith("/group ")) return this.sendGroup(line.slice(7), false);
    // Give the app a chance to handle other slash-commands (e.g. /dream).
    if (line.startsWith("/") && this.opts.onSlash) {
      const space = line.indexOf(" ");
      const cmd = space === -1 ? line : line.slice(0, space);
      const rest = space === -1 ? "" : line.slice(space + 1);
      const handled = await this.opts.onSlash(cmd, rest);
      if (handled) return;
    }
    return this.sendP2P(line);
  }
}
