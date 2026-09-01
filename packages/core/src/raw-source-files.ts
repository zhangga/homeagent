import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type { Attachment } from "@homeagent/shared";
import { durableFsyncSync, durableRenameSync } from "./durable-file.ts";

export const RAW_SOURCE_DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
export const MAX_RAW_SOURCE_BYTES = 20 * 1024 * 1024;

export interface StoredRawSourceFile {
  digest: string;
  sizeBytes: number;
  path: string;
}

export type RawSourceCapture = {
  attachment: Attachment;
  bytes: Uint8Array;
} | {
  attachment: Attachment;
  localPath: string;
};

export type RawSourceDownload = StoredRawSourceFile & {
  name: string;
  kind: Attachment["kind"];
};

function digestBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sameCanonicalPath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

/** Immutable, content-addressed original files owned by one Space. */
export class RawSourceFileStore {
  constructor(readonly root: string) {}

  ensure(): void {
    mkdirSync(this.root, { recursive: true });
    const stat = lstatSync(this.root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("raw source directory must be a regular directory");
    }
    if (!sameCanonicalPath(realpathSync(this.root), resolve(this.root))) {
      throw new Error("raw source directory must not traverse a link");
    }
  }

  pathFor(digest: string): string {
    if (!RAW_SOURCE_DIGEST_PATTERN.test(digest)) {
      throw new Error("raw source digest is invalid");
    }
    return join(this.root, digest);
  }

  write(bytes: Uint8Array, expectedDigest?: string): StoredRawSourceFile {
    if (bytes.byteLength > MAX_RAW_SOURCE_BYTES) {
      throw new Error(`raw source exceeds ${MAX_RAW_SOURCE_BYTES} bytes`);
    }
    const digest = digestBytes(bytes);
    if (expectedDigest !== undefined && digest !== expectedDigest) {
      throw new Error("raw source digest does not match content");
    }
    this.ensure();
    const path = this.pathFor(digest);
    if (existsSync(path)) return this.read(digest);

    const temporary = join(this.root, `.${digest}.${process.pid}.${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, bytes, { mode: 0o600, flag: "wx" });
      const descriptor = openSync(temporary, "r+");
      try {
        durableFsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      durableRenameSync(temporary, path);
      try {
        const directoryDescriptor = openSync(this.root, "r");
        try {
          durableFsyncSync(directoryDescriptor, { allowUnsupportedDirectoryOnWindows: true });
        } finally {
          closeSync(directoryDescriptor);
        }
      } catch {
        // The atomic rename is the commit point. Directory fsync is not
        // supported by every Windows/Bun combination.
      }
      return { digest, sizeBytes: bytes.byteLength, path };
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
  }

  writeFromPath(path: string): StoredRawSourceFile {
    if (!sameCanonicalPath(realpathSync(path), resolve(path))) {
      throw new Error("raw source path must not traverse a link");
    }
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("raw source path must be a regular file");
    }
    if (stat.size > MAX_RAW_SOURCE_BYTES) {
      throw new Error(`raw source exceeds ${MAX_RAW_SOURCE_BYTES} bytes`);
    }
    return this.write(readFileSync(path));
  }

  read(digest: string): StoredRawSourceFile {
    const path = this.pathFor(digest);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("stored raw source is not a regular file");
    }
    if (stat.size > MAX_RAW_SOURCE_BYTES) {
      throw new Error(`stored raw source exceeds ${MAX_RAW_SOURCE_BYTES} bytes`);
    }
    const bytes = readFileSync(path);
    if (digestBytes(bytes) !== digest) {
      throw new Error(`stored raw source digest mismatch: ${digest}`);
    }
    return { digest, sizeBytes: bytes.byteLength, path };
  }

  readBytes(digest: string): Uint8Array {
    return readFileSync(this.read(digest).path);
  }

  remove(digest: string): boolean {
    const path = this.pathFor(digest);
    if (!existsSync(path)) return false;
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("stored raw source is not a regular file");
    }
    rmSync(path);
    return true;
  }
}
