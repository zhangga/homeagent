import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { DownloadedAttachment } from "@homeagent/connectors";

const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".csv",
  ".json",
  ".log",
]);
const MAX_OUTPUT_CHARS = 200_000;
const NATIVE_TIMEOUT_MS = 60_000;

export interface NativeResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface CancellableDeadline {
  elapsed: Promise<void>;
  cancel: () => void;
}

export type DeadlineFactory = (timeoutMs: number) => CancellableDeadline;

export type NativeExtractor = (
  mode: "image" | "pdf",
  path: string,
) => Promise<NativeResult>;

export type NativeProcessRunner = (
  command: string[],
  timeoutMs: number,
) => Promise<NativeResult>;

export interface NativeExtractorRuntime {
  platform?: typeof process.platform;
  execPath?: string;
  attachmentHelper?: string;
  runProcess?: NativeProcessRunner;
}

export async function extractAttachmentText(
  input: DownloadedAttachment,
  runNative: NativeExtractor = defaultNativeExtractor,
): Promise<string | null> {
  try {
    const extension = extname(input.attachment.name ?? "").toLowerCase();
    if (input.attachment.kind === "file" && TEXT_EXTENSIONS.has(extension)) {
      const bytes = readFileSync(input.localPath);
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
      return decoded ? decoded.slice(0, MAX_OUTPUT_CHARS) : null;
    }

    const mode = input.attachment.kind === "image"
      ? "image"
      : input.attachment.kind === "pdf"
        ? "pdf"
        : undefined;
    if (!mode) return null;

    const result = await runNative(mode, input.localPath);
    if (result.code !== 0) return null;
    const text = result.stdout.trim();
    return text ? text.slice(0, MAX_OUTPUT_CHARS) : null;
  } catch {
    return null;
  }
}

export function createNativeExtractor(runtime: NativeExtractorRuntime = {}): NativeExtractor {
  const platform = runtime.platform ?? process.platform;
  const execPath = runtime.execPath ?? process.execPath;
  const runProcess = runtime.runProcess ?? runBoundedProcess;

  return async (mode, path) => {
    if (platform !== "darwin") {
      return { code: null, stdout: "", stderr: "native extraction requires macOS" };
    }

    const bundledHelper = resolveBundledHelper(execPath, runtime.attachmentHelper);
    if (bundledHelper) {
      return await runProcess([bundledHelper, mode, path], NATIVE_TIMEOUT_MS);
    }

    const script = join(import.meta.dir, "attachment-extract.swift");
    const directory = mkdtempSync(join(tmpdir(), "homeagent-native-extract-"));
    const binary = join(directory, "attachment-extract");
    const startedAt = Date.now();
    try {
      const compilation = await runProcess(
        [
          "/usr/bin/xcrun",
          "swiftc",
          script,
          "-module-cache-path",
          join(directory, "module-cache"),
          "-o",
          binary,
        ],
        NATIVE_TIMEOUT_MS,
      );
      if (compilation.code !== 0) return compilation;

      const remainingMs = NATIVE_TIMEOUT_MS - (Date.now() - startedAt);
      if (remainingMs <= 0) {
        return { code: null, stdout: "", stderr: "native extraction timed out" };
      }
      return await runProcess([binary, mode, path], remainingMs);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

const defaultNativeExtractor = createNativeExtractor();

function resolveBundledHelper(execPath: string, configuredHelper?: string): string | undefined {
  const markers = [".app/Contents/MacOS/", ".app/Contents/Resources/bin/"];
  const match = markers
    .map((marker) => ({ marker, at: execPath.indexOf(marker) }))
    .find((candidate) => candidate.at >= 0);
  if (!match) return undefined;

  const appRoot = execPath.slice(0, match.at + 4);
  const resourcesBin = resolve(appRoot, "Contents", "Resources", "bin");
  const helper = resolve(configuredHelper ?? join(resourcesBin, "attachment-extract"));
  const withinResources = relative(resourcesBin, helper);
  if (
    withinResources === ".." ||
    withinResources.startsWith(`..${sep}`) ||
    isAbsolute(withinResources)
  ) {
    throw new Error("attachment helper is outside the application Resources/bin directory");
  }
  return helper;
}

export async function runBoundedProcess(
  command: string[],
  timeoutMs: number,
  terminationGraceMs = 250,
  deadlineFactory: DeadlineFactory = createDeadline,
): Promise<NativeResult> {
  const proc = Bun.spawn(command, {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const stdout = collectProcessStream(proc.stdout);
  const stderr = collectProcessStream(proc.stderr);
  const completion = Promise.all([stdout.result, stderr.result, proc.exited]);
  const deadline = deadlineFactory(Math.max(1, timeoutMs));
  const outcome = await (async () => {
    try {
      return await Promise.race([
        completion.then((value) => ({ kind: "completed" as const, value })),
        deadline.elapsed.then(() => ({ kind: "timeout" as const })),
      ]);
    } finally {
      deadline.cancel();
    }
  })();

  if (outcome.kind === "completed") {
    const [stdoutText, stderrText, code] = outcome.value;
    return { code, stdout: stdoutText, stderr: stderrText };
  }

  const graceMs = Math.max(1, terminationGraceMs);
  try {
    proc.kill("SIGTERM");
  } catch {
    // The process may have exited at the timeout boundary.
  }
  if (!(await settlesWithin(proc.exited, graceMs))) {
    try {
      proc.kill("SIGKILL");
    } catch {
      // The process may have exited during the grace-period boundary.
    }
    await settlesWithin(proc.exited, graceMs);
  }
  stdout.cancel();
  stderr.cancel();
  const stdoutText = stdout.snapshot();
  const stderrText = stderr.snapshot();
  return {
    code: null,
    stdout: stdoutText,
    stderr: `${stderrText}${stderrText ? "\n" : ""}native extraction timed out`,
  };
}

function collectProcessStream(stream: ReadableStream<Uint8Array>): {
  result: Promise<string>;
  snapshot: () => string;
  cancel: () => void;
} {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let cancelled = false;
  let text = "";
  const result = (async () => {
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
    snapshot: () => text,
    cancel: () => {
      cancelled = true;
      void reader.cancel().catch(() => {
        // A concurrently exiting process may already have closed the stream.
      });
    },
  };
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

function createDeadline(timeoutMs: number): CancellableDeadline {
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
