import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testDataDir = mkdtempSync(join(tmpdir(), "homeagent-bun-test-"));

// Never trust inherited runtime data paths during tests. Some legacy tests
// temporarily delete the canonical variable, so keep the pre-rename alias
// pinned to the same per-process directory as a safe fallback.
process.env.HOMEAGENT_DATA_DIR = testDataDir;
process.env.HOMEBRAIN_DATA_DIR = testDataDir;

process.once("exit", () => {
  rmSync(testDataDir, { recursive: true, force: true });
});
