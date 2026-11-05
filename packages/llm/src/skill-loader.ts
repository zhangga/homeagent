import { lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ProviderPreparationError } from "./provider-preparation.ts";

/** A local mailbox, used only when the Provider can write its private request directory. */
export interface SkillLoader {
  root: string;
  requests: string;
  command: string;
  signal: AbortSignal;
  activate(): void;
  verify(): void;
  close(): Promise<void>;
}

function quoteShell(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
function quotePowerShell(value: string): string { return `'${value.replaceAll("'", "''")}'`; }

/** The host resolves names against frozen evidence; requests never contain source paths. */
export function createSkillLoader(
  root: string,
  names: readonly string[],
  load: (index: number, signal: AbortSignal) => Promise<string>,
): SkillLoader {
  const requests = join(root, "requests");
  const responses = join(root, "responses");
  const controller = new AbortController();
  const rootIdentity = lstatSync(root);
  const requestIdentity = lstatSync(requests);
  const responseIdentity = lstatSync(responses);
  const windows = process.platform === "win32";
  const script = join(root, windows ? "load.ps1" : "load.sh");
  const scriptContent = windows ? [
    "param([string]$Name)",
    "$ErrorActionPreference = 'Stop'",
    "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)",
    `$names = @(${names.map(quotePowerShell).join(",")})`,
    "$index = [Array]::IndexOf($names, $Name)",
    "if ($index -lt 0) { throw 'Skill is not in the frozen catalog' }",
    `$request = Join-Path ${quotePowerShell(requests)} ([string]$index)`,
    `$response = Join-Path ${quotePowerShell(responses)} ([string]$index)`,
    "if (!(Test-Path -LiteralPath $response)) { [IO.File]::WriteAllText($request, '') }",
    `while (!(Test-Path -LiteralPath $response)) { if (!(Test-Path -LiteralPath ${quotePowerShell(script)})) { throw 'Skill run ended' }; Start-Sleep -Milliseconds 50 }`,
    "$result = [IO.File]::ReadAllText($response)",
    "if ($result -eq 'ERROR') { throw 'Frozen Skill could not be prepared' }",
    "[Console]::WriteLine($result)",
  ].join("\n") : [
    "#!/bin/sh",
    "set -eu",
    'case "${1-}" in',
    ...names.map((name, index) => `${quoteShell(name)}) index=${index} ;;`),
    "*) echo 'Skill is not in the frozen catalog' >&2; exit 1 ;;",
    "esac",
    `request=${quoteShell(requests)}/"$index"`,
    `response=${quoteShell(responses)}/"$index"`,
    '[ -f "$response" ] || : > "$request"',
    `while [ ! -f "$response" ]; do [ -f ${quoteShell(script)} ] || { echo 'Skill run ended' >&2; exit 1; }; sleep 0.05; done`,
    'result=$(cat "$response")',
    '[ "$result" != ERROR ] || { echo "Frozen Skill could not be prepared" >&2; exit 1; }',
    'printf "%s\\n" "$result"',
  ].join("\n");
  const encodedScript = `${windows ? "\uFEFF" : ""}${scriptContent}`;
  writeFileSync(script, encodedScript, { flag: "wx", mode: 0o600 });
  const scriptIdentity = lstatSync(script);
  const verify = () => {
    for (const [path, expected] of [[root, rootIdentity], [requests, requestIdentity], [responses, responseIdentity], [script, scriptIdentity]] as const) {
      const current = lstatSync(path);
      if (current.isSymbolicLink() || current.dev !== expected.dev || current.ino !== expected.ino
        || realpathSync(path) !== path || current.isDirectory() !== expected.isDirectory()
        || (path === script && (current.size !== expected.size || current.mtimeMs !== expected.mtimeMs))) {
        throw new Error("provider Skill loader changed after preparation");
      }
    }
    if (readFileSync(script, "utf8") !== encodedScript) throw new Error("provider Skill loader changed after preparation");
  };
  const completed = new Set<number>();
  let closed = false;
  let closePromise: Promise<void> | undefined;
  let pending: Promise<void> | undefined;
  const drain = async () => {
    verify();
    for (const entry of readdirSync(requests, { withFileTypes: true })) {
      controller.signal.throwIfAborted();
      if (entry.name === ".probe") continue; // The no-model filesystem proof owns this marker.
      const index = Number(entry.name);
      if (!Number.isInteger(index) || String(index) !== entry.name || index < 0 || index >= names.length
        || entry.isSymbolicLink() || !entry.isFile()) throw new Error("provider Skill request is invalid");
      if (completed.has(index)) continue;
      const request = join(requests, entry.name);
      const metadata = lstatSync(request);
      if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size !== 0 || realpathSync(request) !== request) {
        throw new Error("provider Skill request is invalid");
      }
      const result = await load(index, controller.signal);
      controller.signal.throwIfAborted();
      verify();
      const temporary = join(responses, `${index}.pending`);
      await writeFile(temporary, result, { flag: "wx", mode: 0o600, signal: controller.signal });
      await rename(temporary, join(responses, String(index)));
      completed.add(index);
    }
  };
  // Poll only the small mailbox. Never scan installed bundles while idle.
  let timer: ReturnType<typeof setInterval> | undefined;
  const activate = () => {
    if (timer || closed) return;
    timer = setInterval(() => {
      if (closed || pending || controller.signal.aborted) return;
      pending = drain().catch(error => {
        controller.abort(error instanceof ProviderPreparationError ? error
          : new Error("provider Skill input changed after frozen validation"));
      }).finally(() => { pending = undefined; });
    }, 25);
    timer.unref();
  };
  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closed = true;
    if (timer) clearInterval(timer);
    // Set the promise before abort listeners run; they may request cleanup too.
    closePromise = Promise.resolve().then(async () => {
      await pending;
      await rm(root, { recursive: true, force: true });
    });
    controller.abort(new Error("provider Skill run ended"));
    return closePromise;
  };
  controller.signal.addEventListener("abort", () => { void close().catch(() => {}); }, { once: true });
  return {
    root, requests, signal: controller.signal, verify, activate,
    command: windows
      ? `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ${quotePowerShell(script)}`
      : `/bin/sh ${quoteShell(script)}`,
    close,
  };
}
