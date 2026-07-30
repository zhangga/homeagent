import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { InboundEvent } from "./connector.ts";
import type { ProcHandle, ProcSpawner } from "./process.ts";
import { FeishuConnector, runFeishuCommand } from "./feishu.ts";

/** A controllable fake process: push stdout/stderr lines, resolve exit at will. */
class FakeProc implements ProcHandle {
  private outCtl!: ReadableStreamDefaultController<Uint8Array>;
  private errCtl!: ReadableStreamDefaultController<Uint8Array>;
  private exitResolve!: (code: number) => void;
  stdout: AsyncIterable<Uint8Array>;
  stderr: AsyncIterable<Uint8Array>;
  exited: Promise<number>;
  killed = false;
  private enc = new TextEncoder();

  constructor() {
    this.stdout = streamFrom((c) => (this.outCtl = c));
    this.stderr = streamFrom((c) => (this.errCtl = c));
    this.exited = new Promise((res) => (this.exitResolve = res));
  }
  emitStdout(line: string): void {
    this.outCtl.enqueue(this.enc.encode(line + "\n"));
  }
  emitStderr(line: string): void {
    this.errCtl.enqueue(this.enc.encode(line + "\n"));
  }
  finish(code = 0): void {
    try {
      this.outCtl.close();
    } catch {}
    try {
      this.errCtl.close();
    } catch {}
    this.exitResolve(code);
  }
  kill(): void {
    this.killed = true;
    this.finish(0);
  }
}

function streamFrom(
  grab: (c: ReadableStreamDefaultController<Uint8Array>) => void,
): AsyncIterable<Uint8Array> {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      grab(controller);
    },
  });
  // ReadableStream is async-iterable in Bun.
  return stream as unknown as AsyncIterable<Uint8Array>;
}

class FakeSpawner implements ProcSpawner {
  procs: { cmd: string[]; proc: FakeProc }[] = [];
  private waiters: ((p: FakeProc) => void)[] = [];
  spawn(cmd: string[]): ProcHandle {
    const proc = new FakeProc();
    this.procs.push({ cmd, proc });
    const w = this.waiters.shift();
    if (w) w(proc);
    return proc;
  }
  /** wait until the Nth process (1-based) for a key substring is spawned */
  async waitForProc(keySubstring: string, index = 1): Promise<FakeProc> {
    for (let i = 0; i < 200; i++) {
      const matches = this.procs.filter((p) => p.cmd.some((a) => a.includes(keySubstring)));
      if (matches.length >= index) return matches[index - 1]!.proc;
      await Bun.sleep(5);
    }
    throw new Error(`process for ${keySubstring} #${index} never spawned`);
  }
}

let connector: FeishuConnector;

afterEach(async () => {
  await connector?.stop();
});

describe("FeishuConnector daemon (fake spawn)", () => {
  test("does not process stdout until the ready marker appears", async () => {
    const spawner = new FakeSpawner();
    const events: InboundEvent[] = [];
    connector = new FeishuConnector({ spawner, runCommand: async () => "{}" });
    await connector.start((e) => {
      events.push(e);
    });

    const proc = await spawner.waitForProc("im.message.receive_v1");
    // Emit a well-formed event on stdout BEFORE ready. The gating guarantee is
    // that nothing is processed while we are still waiting for the ready marker.
    proc.emitStdout(
      JSON.stringify({ chat_id: "oc_1", chat_type: "p2p", content: "early", message_id: "om_0", event_id: "e0", sender_id: "ou_a" }),
    );
    await Bun.sleep(30);
    expect(events.length).toBe(0); // still gated: no ready marker yet

    // Now signal ready; the pump starts and the message flows.
    proc.emitStderr("[event] ready event_key=im.message.receive_v1");
    await Bun.sleep(20);
    proc.emitStdout(
      JSON.stringify({ chat_id: "oc_1", chat_type: "p2p", content: "谁负责后端？", message_id: "om_1", event_id: "e1", sender_id: "ou_a" }),
    );
    await Bun.sleep(30);

    const msgs = events.filter((e) => e.kind === "message") as { text: string }[];
    // Post-ready the pump drains everything buffered, including the later message.
    expect(msgs.length).toBeGreaterThanOrEqual(1);
    expect(msgs.some((m) => m.text === "谁负责后端？")).toBe(true);
  });

  test("normalizes a bot_added event from the added consumer", async () => {
    const spawner = new FakeSpawner();
    const events: InboundEvent[] = [];
    connector = new FeishuConnector({ spawner, runCommand: async () => "{}" });
    await connector.start((e) => {
      events.push(e);
    });

    const proc = await spawner.waitForProc("im.chat.member.bot.added_v1");
    proc.emitStderr("[event] ready event_key=im.chat.member.bot.added_v1");
    await Bun.sleep(20);
    proc.emitStdout(JSON.stringify({ header: { event_id: "evt_add" }, event: { chat_id: "oc_new" } }));
    await Bun.sleep(30);

    const added = events.filter((e) => e.kind === "bot_added");
    expect(added.length).toBe(1);
    expect((added[0] as { chatId: string }).chatId).toBe("oc_new");
  });

  test("reports consumer readiness and the last received event", async () => {
    const spawner = new FakeSpawner();
    connector = new FeishuConnector({ spawner, runCommand: async () => "{}" });
    await connector.start(() => {});

    const messageProc = await spawner.waitForProc("im.message.receive_v1");
    const addedProc = await spawner.waitForProc("im.chat.member.bot.added_v1");
    messageProc.emitStderr("[event] ready event_key=im.message.receive_v1");
    addedProc.emitStderr("[event] ready event_key=im.chat.member.bot.added_v1");
    await Bun.sleep(20);
    messageProc.emitStdout(
      JSON.stringify({
        chat_id: "oc_1",
        chat_type: "p2p",
        content: "hello",
        message_id: "om_1",
        event_id: "evt_1",
        sender_id: "ou_1",
      }),
    );
    await Bun.sleep(20);

    const status = connector.health();
    expect(status.ready).toBe(true);
    expect(status.lastEventAt).toBeNumber();
    expect(status.consumers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "im.message.receive_v1", state: "ready" }),
        expect.objectContaining({ key: "im.chat.member.bot.added_v1", state: "ready" }),
      ]),
    );
  });

  test("reports a terminal failure when the consumer process cannot spawn", async () => {
    const spawner: ProcSpawner = {
      spawn: () => {
        throw new Error("lark-cli not found");
      },
    };
    connector = new FeishuConnector({
      spawner,
      runCommand: async () => "{}",
      maxNeverReady: 1,
    });

    await connector.start(() => {});
    await Bun.sleep(10);

    const status = connector.health();
    expect(status.ready).toBe(false);
    expect(status.consumers).toEqual([
      expect.objectContaining({ state: "failed", lastError: "Error: lark-cli not found" }),
      expect.objectContaining({ state: "failed", lastError: "Error: lark-cli not found" }),
    ]);
  });

  test("restarts a crashed consumer with backoff", async () => {
    const spawner = new FakeSpawner();
    connector = new FeishuConnector({
      spawner,
      runCommand: async () => "{}",
      backoffBaseMs: 10,
      backoffMaxMs: 20,
    });
    await connector.start(() => {});

    const first = await spawner.waitForProc("im.message.receive_v1", 1);
    first.emitStderr("[event] ready event_key=im.message.receive_v1");
    await Bun.sleep(10);
    // crash it
    first.finish(1);
    // a second process for the same key should be spawned after backoff
    const second = await spawner.waitForProc("im.message.receive_v1", 2);
    expect(second).not.toBe(first);
  });

  test("reports the exit code when a ready consumer crashes", async () => {
    const spawner = new FakeSpawner();
    connector = new FeishuConnector({
      spawner,
      runCommand: async () => "{}",
      backoffBaseMs: 1000,
      backoffMaxMs: 1000,
    });
    await connector.start(() => {});

    const proc = await spawner.waitForProc("im.message.receive_v1");
    proc.emitStderr("[event] ready event_key=im.message.receive_v1");
    await Bun.sleep(10);
    proc.finish(7);
    await Bun.sleep(10);

    expect(
      connector.health().consumers.find((consumer) => consumer.key === "im.message.receive_v1"),
    ).toEqual(expect.objectContaining({ state: "backoff", lastError: "consumer exited with code 7" }));
  });

  test("gives up on a consumer that never reaches ready", async () => {
    const spawner = new FakeSpawner();
    connector = new FeishuConnector({
      spawner,
      runCommand: async () => "{}",
      backoffBaseMs: 2,
      backoffMaxMs: 4,
      maxNeverReady: 3,
    });
    await connector.start(() => {});

    // For the bot-added key, crash every process before ready. After
    // maxNeverReady attempts the loop should stop spawning new ones.
    for (let i = 1; i <= 3; i++) {
      const p = await spawner.waitForProc("im.chat.member.bot.added_v1", i);
      p.emitStderr('{"ok":false,"error":{"type":"missing_scope"}}');
      p.finish(3);
      await Bun.sleep(15);
    }
    await Bun.sleep(30);
    const count = spawner.procs.filter((p) =>
      p.cmd.some((a) => a.includes("im.chat.member.bot.added_v1")),
    ).length;
    // capped at maxNeverReady (3); should not keep spawning
    expect(count).toBeLessThanOrEqual(3);
  });

  test("stop() sends SIGTERM (kills) all consumers", async () => {
    const spawner = new FakeSpawner();
    connector = new FeishuConnector({ spawner, runCommand: async () => "{}" });
    await connector.start(() => {});
    const msg = await spawner.waitForProc("im.message.receive_v1");
    msg.emitStderr("[event] ready event_key=im.message.receive_v1");
    await Bun.sleep(10);
    await connector.stop();
    expect(msg.killed).toBe(true);
  });
});

describe("FeishuConnector outbound", () => {
  test("resolves Windows command shims before spawning with an environment overlay", async () => {
    if (process.platform !== "win32") return;

    const directory = mkdtempSync(join(tmpdir(), "homeagent-command-shim-"));
    const executable = join(directory, "homeagent-command-probe.cmd");
    writeFileSync(executable, "@echo off\r\necho %HOMEAGENT_COMMAND_PROBE%\r\n");

    try {
      await expect(
        runFeishuCommand(["homeagent-command-probe"], {
          env: {
            PATH: `${directory};${process.env.PATH ?? ""}`,
            HOMEAGENT_COMMAND_PROBE: "resolved",
          },
        }).then((output) => output.trim()),
      ).resolves.toBe("resolved");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("bypasses the npm lark-cli shim so multiline arguments keep following flags", async () => {
    if (process.platform !== "win32") return;

    const directory = mkdtempSync(join(tmpdir(), "homeagent-lark-cli-shim-"));
    const nativeDirectory = join(
      directory,
      "node_modules",
      "@larksuite",
      "cli",
      "bin",
    );
    const nativeExecutable = join(nativeDirectory, "lark-cli.exe");
    mkdirSync(nativeDirectory, { recursive: true });
    writeFileSync(join(directory, "lark-cli.cmd"), "@echo off\r\nexit /b 99\r\n");
    linkSync(process.execPath, nativeExecutable);

    try {
      const output = await runFeishuCommand(
        [
          "lark-cli",
          "-e",
          "process.stdout.write(JSON.stringify(Bun.argv))",
          "first line\nsecond line",
          "--message-id",
          "om_multiline",
        ],
        { env: { PATH: `${directory};${process.env.PATH ?? ""}` } },
      );
      const argv = JSON.parse(output) as string[];

      expect(argv).toContain("first line\nsecond line");
      expect(argv).toContain("--message-id");
      expect(argv).toContain("om_multiline");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("passes sensitive command input over stdin instead of argv", async () => {
    const output = await runFeishuCommand(
      [process.execPath, "-e", "const input = await Bun.stdin.text(); process.stdout.write(input)"],
      { stdin: "stdin-only-value" },
    );

    expect(output).toBe("stdin-only-value");
  });

  test("cancels the command deadline after a fast successful command", async () => {
    let cancellations = 0;
    await expect(
      runFeishuCommand([process.execPath, "-e", "process.exit(0)"], {
        timeoutMs: 30_000,
        deadlineFactory: () => ({
          elapsed: new Promise<void>(() => {}),
          cancel: () => {
            cancellations += 1;
          },
        }),
      }),
    ).resolves.toBe("");

    expect(cancellations).toBe(1);
  });

  test("terminates a command that ignores SIGTERM and returns within a fixed bound", async () => {
    if (process.platform === "win32") return;

    const directory = mkdtempSync(join(tmpdir(), "hb-command-timeout-"));
    const executable = join(directory, "hang.sh");
    const pidFile = join(directory, "pid");
    writeFileSync(
      executable,
      `#!/bin/sh\necho $$ > '${pidFile}'\ntrap '' TERM\nexec /bin/sleep 30\n`,
    );
    chmodSync(executable, 0o755);

    const startedAt = Date.now();
    try {
      await expect(
        runFeishuCommand([executable], { timeoutMs: 500, terminationGraceMs: 100 }),
      ).rejects.toThrow("timed out");
      expect(Date.now() - startedAt).toBeLessThan(1_000);

      const pid = Number(readFileSync(pidFile, "utf8").trim());
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("terminates a download while its output file grows beyond the byte limit", async () => {
    if (process.platform === "win32") return;

    const directory = mkdtempSync(join(tmpdir(), "hb-command-size-"));
    const executable = join(directory, "grow.sh");
    const outputPath = join(directory, "resource.bin");
    writeFileSync(
      executable,
      `#!/bin/sh\ntrap '' TERM\nexec /usr/bin/yes 1234567890 > '${outputPath}'\n`,
    );
    chmodSync(executable, 0o755);

    const startedAt = Date.now();
    try {
      await expect(
        runFeishuCommand([executable], {
          // Keep the command timeout well beyond the 25 ms size polling loop;
          // a loaded full-suite run must still prove the size guard wins.
          timeoutMs: 2_000,
          terminationGraceMs: 50,
          outputPath,
          maxOutputBytes: 1_024,
        }),
      ).rejects.toThrow("output exceeded");
      expect(Date.now() - startedAt).toBeLessThan(3_000);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("bounds the message-resource metadata fetch", async () => {
    const calls: { cmd: string[]; timeoutMs?: number }[] = [];
    connector = new FeishuConnector({
      spawner: new FakeSpawner(),
      runCommand: async (cmd, opts) => {
        calls.push({ cmd, timeoutMs: opts?.timeoutMs });
        return JSON.stringify({ data: { items: [] } });
      },
    });

    expect(await connector.downloadAttachments("om_empty")).toEqual([]);
    expect(calls[0]).toEqual(
      expect.objectContaining({
        cmd: expect.arrayContaining(["/open-apis/im/v1/messages/om_empty"]),
        timeoutMs: 30_000,
      }),
    );
  });

  test("downloads a message resource with bot identity and returns a cleanup handle", async () => {
    const calls: {
      cmd: string[];
      cwd?: string;
      timeoutMs?: number;
      outputPath?: string;
      maxOutputBytes?: number;
    }[] = [];
    connector = new FeishuConnector({
      spawner: new FakeSpawner(),
      identity: {},
      runCommand: async (cmd, opts) => {
        calls.push({
          cmd,
          cwd: opts?.cwd,
          timeoutMs: opts?.timeoutMs,
          outputPath: opts?.outputPath,
          maxOutputBytes: opts?.maxOutputBytes,
        });
        if (cmd.includes("/open-apis/im/v1/messages/om_file")) {
          return JSON.stringify({
            data: {
              items: [
                {
                  message_id: "om_file",
                  msg_type: "file",
                  body: {
                    content: JSON.stringify({
                      file_key: "file_1",
                      file_name: "notes.txt",
                    }),
                  },
                },
              ],
            },
          });
        }
        await Bun.write(join(opts!.cwd!, "resource.bin"), "project codename is Polaris");
        return JSON.stringify({ ok: true });
      },
    });

    const [download] = await connector.downloadAttachments("om_file");

    expect(download?.attachment).toEqual({
      kind: "file",
      ref: "file_1",
      name: "notes.txt",
    });
    expect(await Bun.file(download!.localPath).text()).toBe("project codename is Polaris");
    expect(calls[1]?.cmd).toEqual(
      expect.arrayContaining([
        "im",
        "+messages-resources-download",
        "--as",
        "bot",
        "--message-id",
        "om_file",
        "--file-key",
        "file_1",
        "--type",
        "file",
        "--output",
        "resource.bin",
      ]),
    );
    expect(calls[1]?.cwd).toBe(dirname(download!.localPath));
    expect(calls[1]?.cwd).not.toBe(process.cwd());
    expect(calls[1]).toEqual(
      expect.objectContaining({
        timeoutMs: 30_000,
        outputPath: download!.localPath,
        maxOutputBytes: 20 * 1024 * 1024,
      }),
    );

    const parent = dirname(download!.localPath);
    download!.cleanup();
    expect(existsSync(parent)).toBe(false);
  });

  test("removes an oversized attachment instead of returning it", async () => {
    let resourceDirectory: string | undefined;
    connector = new FeishuConnector({
      spawner: new FakeSpawner(),
      identity: {},
      maxAttachmentBytes: 10,
      runCommand: async (cmd, opts) => {
        if (cmd.includes("/open-apis/im/v1/messages/om_large")) {
          return JSON.stringify({
            data: {
              items: [
                {
                  message_id: "om_large",
                  msg_type: "file",
                  body: {
                    content: JSON.stringify({
                      file_key: "file_large",
                      file_name: "large.txt",
                    }),
                  },
                },
              ],
            },
          });
        }
        resourceDirectory = opts!.cwd!;
        await Bun.write(join(resourceDirectory, "resource.bin"), "12345678901");
        return JSON.stringify({ ok: true });
      },
    });

    expect(await connector.downloadAttachments("om_large")).toEqual([]);
    expect(resourceDirectory).toBeDefined();
    expect(existsSync(resourceDirectory!)).toBe(false);
  });

  test("reply builds the correct lark-cli command", async () => {
    const spawner = new FakeSpawner();
    const commands: string[][] = [];
    connector = new FeishuConnector({
      spawner,
      runCommand: async (cmd) => {
        commands.push(cmd);
        return "{}";
      },
    });
    await connector.reply({
      chatId: "oc_1",
      replyToMessageId: "om_1",
      markdown: "hello",
      inThread: true,
    });
    const cmd = commands[0]!;
    expect(cmd).toContain("+messages-reply");
    expect(cmd).toContain("--message-id");
    expect(cmd).toContain("om_1");
    expect(cmd).toContain("--markdown");
    expect(cmd).toContain("hello");
    expect(cmd).toContain("--reply-in-thread");
    expect(cmd).toContain("--as");
    expect(cmd).toContain("bot");
  });

  test("reply retries idempotently and propagates a final delivery failure", async () => {
    const commands: string[][] = [];
    connector = new FeishuConnector({
      spawner: new FakeSpawner(),
      replyRetryDelayMs: 0,
      runCommand: async (cmd) => {
        commands.push(cmd);
        throw new Error("temporary Feishu delivery failure");
      },
    });

    await expect(connector.reply({
      chatId: "oc_1",
      replyToMessageId: "om_retry",
      markdown: "hello",
    })).rejects.toThrow("temporary Feishu delivery failure");

    expect(commands).toHaveLength(2);
    const idempotencyKeys = commands.map((cmd) => {
      const keyIndex = cmd.indexOf("--idempotency-key");
      return keyIndex < 0 ? undefined : cmd[keyIndex + 1];
    });
    expect(idempotencyKeys[0]).toBeDefined();
    expect(idempotencyKeys[1]).toBe(idempotencyKeys[0]);
  });

  test("notice uses +messages-send with chat-id", async () => {
    const spawner = new FakeSpawner();
    const commands: string[][] = [];
    connector = new FeishuConnector({
      spawner,
      runCommand: async (cmd) => {
        commands.push(cmd);
        return "{}";
      },
    });
    await connector.notice("oc_group", "欢迎语");
    const cmd = commands[0]!;
    expect(cmd).toContain("+messages-send");
    expect(cmd).toContain("--chat-id");
    expect(cmd).toContain("oc_group");
    expect(cmd).toContain("欢迎语");
  });

  test("notice propagates delivery failures so durable callers can retry", async () => {
    connector = new FeishuConnector({
      spawner: new FakeSpawner(),
      runCommand: async () => { throw new Error("authentication expired"); },
    });

    await expect(connector.notice("oc_group", "提醒")).rejects.toThrow("authentication expired");
  });

  test("adds and removes a native message reaction", async () => {
    const spawner = new FakeSpawner();
    const commands: string[][] = [];
    connector = new FeishuConnector({
      spawner,
      runCommand: async (cmd) => {
        commands.push(cmd);
        return cmd.includes("create")
          ? JSON.stringify({ ok: true, data: { reaction_id: "reaction_1" } })
          : JSON.stringify({ ok: true });
      },
    });

    const reactionId = await connector.addReaction("om_1", "THINKING");
    expect(reactionId).toBe("reaction_1");
    expect(commands[0]).toContain("reactions");
    expect(commands[0]).toContain("create");
    expect(commands[0]).toContain("om_1");
    expect(commands[0]!.join(" ")).toContain("THINKING");

    await connector.removeReaction("om_1", reactionId!);
    expect(commands[1]).toContain("reactions");
    expect(commands[1]).toContain("delete");
    expect(commands[1]).toContain("reaction_1");
  });

  test("resolves the original message from a quoted reply", async () => {
    const commands: string[][] = [];
    const responses = [
      JSON.stringify({
        ok: true,
        data: { items: [{ message_id: "om_command", parent_id: "om_source" }] },
      }),
      JSON.stringify({
        ok: true,
        data: {
          items: [
            {
              message_id: "om_source",
              sender: { id: "ou_owner" },
            },
          ],
        },
      }),
    ];
    connector = new FeishuConnector({
      spawner: new FakeSpawner(),
      runCommand: async (cmd) => {
        commands.push(cmd);
        return responses.shift()!;
      },
    });

    expect(await connector.resolveReplyTarget("om_command")).toEqual({
      messageId: "om_source",
      senderId: "ou_owner",
    });
    expect(commands[0]!.slice(1, 4)).toEqual([
      "api",
      "GET",
      "/open-apis/im/v1/messages/om_command",
    ]);
  });

  test("includes readable source content when resolving a reply target", async () => {
    const responses = [
      JSON.stringify({
        ok: true,
        data: { items: [{ message_id: "om_reply", parent_id: "om_source" }] },
      }),
      JSON.stringify({
        ok: true,
        data: {
          items: [
            {
              message_id: "om_source",
              sender: { id: "ou_owner" },
              msg_type: "text",
              body: { content: JSON.stringify({ text: "晚餐有三菜一汤，是特意准备的。" }) },
            },
          ],
        },
      }),
    ];
    connector = new FeishuConnector({
      spawner: new FakeSpawner(),
      runCommand: async () => responses.shift()!,
    });

    expect(await connector.resolveReplyTarget("om_reply")).toEqual({
      messageId: "om_source",
      senderId: "ou_owner",
      text: "晚餐有三菜一汤，是特意准备的。",
      messageType: "text",
    });
  });

  test("renders rich-text reply context without exposing raw Feishu JSON", async () => {
    const responses = [
      JSON.stringify({
        ok: true,
        data: { items: [{ message_id: "om_reply", root_id: "om_post" }] },
      }),
      JSON.stringify({
        ok: true,
        data: {
          items: [
            {
              message_id: "om_post",
              msg_type: "post",
              body: {
                content: JSON.stringify({
                  zh_CN: {
                    title: "今晚的晚餐",
                    content: [[
                      { tag: "text", text: "做了三菜一汤" },
                      { tag: "img", image_key: "img_1" },
                    ]],
                  },
                }),
              },
            },
          ],
        },
      }),
    ];
    connector = new FeishuConnector({
      spawner: new FakeSpawner(),
      runCommand: async () => responses.shift()!,
    });

    expect((await connector.resolveReplyTarget("om_reply"))?.text).toBe(
      "今晚的晚餐\n做了三菜一汤\n【图片】",
    );
  });

  test("bounds fetched reply context before it reaches the answering model", async () => {
    const responses = [
      JSON.stringify({
        ok: true,
        data: { items: [{ message_id: "om_reply", parent_id: "om_large" }] },
      }),
      JSON.stringify({
        ok: true,
        data: {
          items: [{
            message_id: "om_large",
            msg_type: "text",
            body: { content: JSON.stringify({ text: "A".repeat(25_000) }) },
          }],
        },
      }),
    ];
    connector = new FeishuConnector({
      spawner: new FakeSpawner(),
      runCommand: async () => responses.shift()!,
    });

    const text = (await connector.resolveReplyTarget("om_reply"))?.text ?? "";
    expect(text.length).toBeLessThan(20_100);
    expect(text).toEndWith("【上下文已截断】");
  });

  test("falls back to root_id when a reply has no parent_id", async () => {
    const responses = [
      JSON.stringify({
        ok: true,
        data: { items: [{ message_id: "om_command", root_id: "om_source" }] },
      }),
      JSON.stringify({
        ok: true,
        data: { items: [{ message_id: "om_source", sender: { id: "ou_owner" } }] },
      }),
    ];
    connector = new FeishuConnector({
      spawner: new FakeSpawner(),
      runCommand: async () => responses.shift()!,
    });

    expect(await connector.resolveReplyTarget("om_command")).toEqual({
      messageId: "om_source",
      senderId: "ou_owner",
    });
  });

  test("resolves the thread root when the command is a topic reply", async () => {
    const responses = [
      JSON.stringify({
        ok: true,
        data: {
          items: [
            {
              message_id: "om_command",
              root_id: "om_source",
              thread_id: "omt_1",
              thread_message_position: "1",
            },
          ],
        },
      }),
      JSON.stringify({
        ok: true,
        data: { items: [{ message_id: "om_source", sender: { id: "ou_owner" } }] },
      }),
    ];
    connector = new FeishuConnector({
      spawner: new FakeSpawner(),
      runCommand: async () => responses.shift()!,
    });

    expect(await connector.resolveReplyTarget("om_command")).toEqual({
      messageId: "om_source",
      senderId: "ou_owner",
    });
  });

  test("recognizes the group owner and managers as administrators", async () => {
    connector = new FeishuConnector({
      spawner: new FakeSpawner(),
      runCommand: async () =>
        JSON.stringify({
          ok: true,
          data: {
            name: "Product",
            owner_id: "ou_owner",
            user_manager_id_list: ["ou_manager"],
          },
        }),
    });

    expect(await connector.getBotChat("oc_1")).toEqual({
      chatId: "oc_1",
      name: "Product",
    });
    expect(await connector.checkChatAdministrator("oc_1", "ou_owner"))
      .toBe(true);
    expect(await connector.isChatAdministrator("oc_1", "ou_owner")).toBe(true);
    expect(await connector.isChatAdministrator("oc_1", "ou_manager")).toBe(true);
    expect(await connector.isChatAdministrator("oc_1", "ou_member")).toBe(false);
  });

  test("strict administrator lookup propagates transport failure", async () => {
    connector = new FeishuConnector({
      spawner: new FakeSpawner(),
      runCommand: async () => {
        throw new Error("chat lookup unavailable");
      },
    });

    await expect(
      connector.checkChatAdministrator("oc_1", "ou_owner"),
    ).rejects.toThrow("chat lookup unavailable");
    expect(await connector.isChatAdministrator("oc_1", "ou_owner"))
      .toBe(false);
  });

  test("fetchDoc parses markdown from CLI json", async () => {
    const spawner = new FakeSpawner();
    connector = new FeishuConnector({
      spawner,
      runCommand: async () => JSON.stringify({ markdown: "# Doc\n正文内容" }),
    });
    const md = await connector.fetchDoc("https://x.feishu.cn/docx/abc");
    expect(md).toContain("正文内容");
  });

  test("fetchDoc returns null on command failure", async () => {
    const spawner = new FakeSpawner();
    connector = new FeishuConnector({
      spawner,
      runCommand: async () => {
        throw new Error("boom");
      },
    });
    expect(await connector.fetchDoc("bad")).toBeNull();
  });
});
