import { expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureProviderSkillBundleAsync, hashProviderSkillBundle } from "./skill-bundle.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ha-bundle-io-"));
  mkdirSync(join(root, "scripts", "node_modules", "runtime"), { recursive: true });
  const names = ["SKILL.md", "scripts/run.sh", "scripts/node_modules/runtime/index.js", "中文.txt", "é.txt",
    ...Array.from({ length: 40 }, (_, i) => `resource-${i}.txt`)];
  for (const name of names) writeFileSync(join(root, name), `complete content: ${name}`);
  chmodSync(join(root, "scripts/run.sh"), 0o755);
  return { root, names, skillFile: join(root, "SKILL.md") };
}

test("cold bundle capture overlaps file reads and preserves the full v1 hash and dependencies", async () => {
  const { root, names, skillFile } = fixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let active = 0, peak = 0, reads = 0;
  const pending = captureProviderSkillBundleAsync(skillFile, undefined, undefined, async path => {
    active++; reads++; peak = Math.max(peak, active);
    try { await gate; return await readFile(path); } finally { active--; }
  });
  try {
    // No read has completed: a serial implementation cannot make this progress.
    expect(reads).toBeGreaterThan(1);
    expect(reads).toBeLessThan(names.length);
    release();
    const captured = await pending;
    expect(reads).toBe(names.length);
    expect(peak).toBeLessThanOrEqual(16);
    const expected = createHash("sha256").update("homeagent-skill-bundle-v1\0");
    for (const name of names.sort((a, b) => a.localeCompare(b))) {
      const content = await readFile(join(root, name));
      expected.update(`${Buffer.byteLength(name)}:${name}\0${lstatSync(join(root, name)).mode & 0o777}\0${content.length}\0`);
      expected.update(content);
    }
    expect(captured.hash).toBe(expected.digest("hex"));
    expect(captured.hash).toBe(hashProviderSkillBundle(skillFile));
    expect(captured.files.map(file => file.path)).toEqual(names);
  } finally { release(); await pending.catch(() => {}); rmSync(root, { recursive: true, force: true }); }
});

test("parallel capture rejects writes during reading and drains in-flight reads on failure", async () => {
  const { root, skillFile } = fixture();
  let active = 0;
  try {
    await expect(captureProviderSkillBundleAsync(skillFile, undefined, undefined, async path => {
      active++;
      try {
        const content = await readFile(path);
        if (path === skillFile) writeFileSync(path, "changed after read");
        return content;
      } finally { active--; }
    })).rejects.toThrow("changed");
    expect(active).toBe(0);
    await expect(captureProviderSkillBundleAsync(skillFile, undefined, undefined, async path => {
      active++;
      try { if (path === skillFile) throw new Error("read failed"); return await readFile(path); }
      finally { active--; }
    })).rejects.toThrow("read failed");
    expect(active).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("parallel capture retains entry and byte boundaries before reading content", async () => {
  const { root, names, skillFile } = fixture();
  let reads = 0;
  try {
    await expect(captureProviderSkillBundleAsync(skillFile, 2, undefined, async path => { reads++; return readFile(path); })).rejects.toThrow("too many entries");
    await expect(captureProviderSkillBundleAsync(skillFile, undefined, 1, async path => { reads++; return readFile(path); })).rejects.toThrow("too large");
    expect(reads).toBe(0);
    const snapshot = await captureProviderSkillBundleAsync(skillFile);
    expect(snapshot.files).toHaveLength(names.length);
    expect((await captureProviderSkillBundleAsync(skillFile, snapshot.entries, snapshot.totalBytes)).hash).toBe(snapshot.hash);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("parallel capture rejects a junction escaping the bundle", async () => {
  const { root, skillFile } = fixture();
  const outside = mkdtempSync(join(tmpdir(), "ha-bundle-outside-"));
  try {
    writeFileSync(join(outside, "private.txt"), "outside");
    symlinkSync(outside, join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
    await expect(captureProviderSkillBundleAsync(skillFile)).rejects.toThrow("symbolic links");
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test("queued reads reject a directory replaced after enumeration before reading through it", async () => {
  const { root, skillFile } = fixture();
  const outside = mkdtempSync(join(tmpdir(), "ha-bundle-replaced-"));
  let replaced = false, escapedReads = 0;
  try {
    writeFileSync(join(outside, "run.sh"), "outside");
    await expect(captureProviderSkillBundleAsync(skillFile, undefined, undefined, async path => {
      if (!replaced) {
        replaced = true;
        renameSync(join(root, "scripts"), join(root, "original-scripts"));
        symlinkSync(outside, join(root, "scripts"), process.platform === "win32" ? "junction" : "dir");
      }
      if (path === join(root, "scripts", "run.sh")) escapedReads++;
      return readFile(path);
    })).rejects.toThrow("changed");
    expect(escapedReads).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});
