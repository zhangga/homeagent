import { fsyncSync, renameSync } from "node:fs";

/**
 * Flush a file or directory when the runtime supports it.
 *
 * Bun on Windows may return EPERM/EINVAL for fsync even on a valid writable
 * file descriptor. The same-directory temporary file + atomic rename remains
 * the integrity boundary there; all other platforms and error codes stay
 * strict so genuine storage failures are never hidden.
 */
export function durableFsyncSync(fileDescriptor: number): void {
  try {
    fsyncSync(fileDescriptor);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (
      process.platform === "win32"
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
