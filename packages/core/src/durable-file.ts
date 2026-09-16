import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { logger } from "@homeagent/shared";

/** Do not follow a replaced local data root or any link below that trust boundary. */
export function assertLocalStatePath(dataDir: string, path: string): void {
  const root = resolve(dataDir);
  const suffix = relative(root, resolve(path));
  if (!suffix || isAbsolute(suffix) || suffix.split(/[\\/]/).includes("..")) throw new Error("Invalid local state path");
  let current = root;
  for (const part of ["", ...suffix.split(/[\\/]/)]) {
    if (part) current = join(current, part);
    try { if (lstatSync(current).isSymbolicLink()) throw new Error("Invalid local state path"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

/** Atomic state replacement. A successful rename is the in-memory commit point too. */
export function writeAtomicStateFile(path: string, contents: string): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let committed = false;
  try {
    writeFileSync(temporary, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    const fd = openSync(temporary, "r+");
    try { durableFsyncSync(fd); } finally { closeSync(fd); }
    durableRenameSync(temporary, path);
    committed = true;
    try {
      const fd = openSync(directory, "r");
      try { durableFsyncSync(fd, { allowUnsupportedDirectoryOnWindows: true }); } finally { closeSync(fd); }
    } catch {
      logger.warn("State directory flush failed after atomic commit");
    }
  } finally {
    if (existsSync(temporary)) {
      try { unlinkSync(temporary); } catch (error) { if (!committed) throw error; }
    }
  }
}

/**
 * Flush a file or directory when the runtime supports it.
 *
 * Bun on Windows does not support fsync for directory descriptors. Callers
 * must opt into that narrow exception; regular-file failures always propagate
 * so an atomic writer cannot silently skip flushing its data.
 */
export function durableFsyncSync(
  fileDescriptor: number,
  options: { allowUnsupportedDirectoryOnWindows?: boolean } = {},
): void {
  try {
    fsyncSync(fileDescriptor);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (
      process.platform === "win32"
      && options.allowUnsupportedDirectoryOnWindows === true
      && (code === "EPERM" || code === "EINVAL")
    ) {
      return;
    }
    throw error;
  }
}

/**
 * Keep the same-directory atomic replace while tolerating a brief Windows
 * sharing violation from antivirus/indexing after the temporary file closes.
 */
export function durableRenameSync(source: string, destination: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(source, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        process.platform !== "win32"
        || !["EPERM", "EACCES", "EBUSY"].includes(code ?? "")
        || attempt >= 49
      ) {
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}
