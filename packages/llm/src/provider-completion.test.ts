import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProviderDetailed } from "./providers.ts";

async function fixture(options: { output?: string; terminal?: string; lingerMs?: number; outputDelayMs?: number; exitCode?: number; orphan?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ha-codex-completion-")));
  const previousBin = process.env.HOMEAGENT_CODEX_BIN;
  const previousHome = process.env.HOMEAGENT_CODEX_HOME;
  const script = join(root, "provider.cjs");
  const bin = join(root, process.platform === "win32" ? "provider.cmd" : "provider");
  const pidPath = join(root, "child.pid");
  const orphanPidPath = join(root, "orphan.pid");
  writeFileSync(script, [
    'const { writeFileSync } = require("node:fs");',
    `writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
    'const args = process.argv.slice(2);',
    'process.stdin.resume();',
    'process.stdin.on("end", () => {',
    ...(options.orphan ? [
      `  const orphan = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 6000)"], { stdin: "ignore", stdout: "inherit", stderr: "inherit" });`,
      `  writeFileSync(${JSON.stringify(orphanPidPath)}, String(orphan.pid));`,
    ] : []),
    `  const output = () => writeFileSync(args[args.indexOf("-o") + 1], ${JSON.stringify(options.output ?? JSON.stringify({ answer: "完整成果" }))});`,
    options.outputDelayMs ? `  setTimeout(output, ${options.outputDelayMs});` : '  output();',
    `  process.stdout.write(JSON.stringify({ type: ${JSON.stringify(options.terminal ?? "turn.completed")}, usage: { input_tokens: 12, output_tokens: 4 } }) + "\\n");`,
    `  setTimeout(() => process.exit(${options.exitCode ?? 0}), ${options.lingerMs ?? 6000});`,
    '});',
  ].join("\n"));
  writeFileSync(bin, process.platform === "win32"
    ? `@echo off\r\n"${process.execPath}" "%~dp0\\provider.cjs" %*\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/provider.cjs" "$@"\n`);
  if (process.platform !== "win32") chmodSync(bin, 0o755);
  process.env.HOMEAGENT_CODEX_BIN = bin;
  process.env.HOMEAGENT_CODEX_HOME = join(root, "codex-home");
  return {
    invoke: (overrides: Partial<Parameters<typeof runProviderDetailed>[1]> = {}, timeoutMs = 4000, signal?: AbortSignal) => runProviderDetailed("codex", {
      prompt: "输出完整成果", execution: { permission: "read-only", skills: [] },
      outputSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] },
      ...overrides,
    }, timeoutMs, signal),
    assertStopped: () => expect(() => process.kill(Number(readFileSync(pidPath, "utf8")), 0)).toThrow(),
    close: () => {
      if (existsSync(pidPath)) {
        try { process.kill(Number(readFileSync(pidPath, "utf8")), "SIGKILL"); } catch { /* fixture already exited */ }
      }
      if (existsSync(orphanPidPath)) {
        try { process.kill(Number(readFileSync(orphanPidPath, "utf8")), "SIGKILL"); } catch { /* fixture already exited */ }
      }
      if (previousBin === undefined) delete process.env.HOMEAGENT_CODEX_BIN; else process.env.HOMEAGENT_CODEX_BIN = previousBin;
      if (previousHome === undefined) delete process.env.HOMEAGENT_CODEX_HOME; else process.env.HOMEAGENT_CODEX_HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test.each([false, true])("Codex returns its final artifact when teardown stalls (progress: %s)", async withProgress => {
  const f = await fixture();
  try {
    const output = await f.invoke(withProgress ? { onProgress: () => {} } : {});
    expect(JSON.parse(output.text)).toEqual({ answer: "完整成果" });
    expect(output.usage.outputTokens).toBe(4);
    f.assertStopped();
  } finally { f.close(); }
}, 10000);

test("Codex waits for the final artifact after the terminal event", async () => {
  const f = await fixture({ outputDelayMs: 200, lingerMs: 3500 });
  try { expect(JSON.parse((await f.invoke()).text)).toEqual({ answer: "完整成果" }); f.assertStopped(); }
  finally { f.close(); }
});

test("a valid Codex artifact does not hide a normal nonzero exit", async () => {
  const f = await fixture({ lingerMs: 50, exitCode: 42 });
  try { await expect(f.invoke()).rejects.toThrow("exited 42"); f.assertStopped(); }
  finally { f.close(); }
});

test.each([0, 42])("Codex finishes after its parent exits %s while a background tool holds output pipes", async exitCode => {
  const f = await fixture({ orphan: true, lingerMs: 50, exitCode });
  try {
    const started = Date.now();
    if (exitCode === 0) expect(JSON.parse((await f.invoke()).text)).toEqual({ answer: "完整成果" });
    else await expect(f.invoke()).rejects.toThrow("exited 42");
    expect(Date.now() - started).toBeLessThan(4000);
    f.assertStopped();
  } finally { f.close(); }
}, 10000);

test.each([
  { output: "{incomplete", terminal: "turn.completed" },
  { output: JSON.stringify({ answer: "未完成" }), terminal: "turn.started" },
  { output: JSON.stringify({ answer: "失败结果" }), terminal: "turn.failed" },
])("incomplete Codex output or protocol cannot become a successful cleanup: %j", async options => {
  const f = await fixture(options);
  try { await expect(f.invoke({}, 500)).rejects.toThrow("timed out"); f.assertStopped(); }
  finally { f.close(); }
});

test("cancellation after a Codex terminal event still cancels the run and stops its process", async () => {
  const f = await fixture();
  const controller = new AbortController();
  try {
    await expect(f.invoke({ onProgress: event => {
      if (event.title === "Provider 执行完成") controller.abort(new Error("cancel completed turn"));
    } }, 4000, controller.signal)).rejects.toThrow("cancel completed turn");
    f.assertStopped();
  } finally { f.close(); }
});
