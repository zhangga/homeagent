import { fsyncSync, renameSync } from "node:fs";

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
