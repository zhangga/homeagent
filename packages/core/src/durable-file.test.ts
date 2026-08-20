import {
  closeSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { durableFsyncSync } from "./durable-file.ts";

test("regular-file fsync failures are never treated as an unsupported directory sync", () => {
  if (process.platform !== "win32") return;
  const dir = mkdtempSync(join(tmpdir(), "ha-durable-file-"));
  const path = join(dir, "data.json");
  writeFileSync(path, "{}", "utf8");
  const descriptor = openSync(path, "r");
  try {
    expect(() => durableFsyncSync(descriptor)).toThrow();
  } finally {
    closeSync(descriptor);
    rmSync(dir, { recursive: true, force: true });
  }
});
