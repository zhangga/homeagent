import { lstatSync, type Stats } from "node:fs";

/** Private, ephemeral evidence. Never persist paths or use it as an access grant. */
export interface FileIdentity {
  path: string;
  missing?: true;
  dev?: number;
  ino?: number;
  size?: number;
  mode?: number;
  mtimeMs?: number;
  ctimeMs?: number;
}

export function fileIdentity(path: string, metadata?: Stats): FileIdentity {
  try {
    const stat = metadata ?? lstatSync(path);
    return { path, dev: stat.dev, ino: stat.ino, size: stat.size, mode: stat.mode,
      mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, missing: true };
    throw error;
  }
}

export function fileIdentitiesMatch(proof: readonly FileIdentity[]): boolean {
  try {
    return proof.every(expected => {
      const current = fileIdentity(expected.path);
      return current.missing === expected.missing && current.dev === expected.dev && current.ino === expected.ino
        && current.size === expected.size && current.mode === expected.mode
        && current.mtimeMs === expected.mtimeMs && current.ctimeMs === expected.ctimeMs;
    });
  } catch { return false; }
}
