import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSkillLoader } from "./skill-loader.ts";

function root(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "ha-skill-loader-test-")));
  mkdirSync(join(directory, "requests")); mkdirSync(join(directory, "responses"));
  return directory;
}

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400 && !condition(); attempt++) await Bun.sleep(5);
  expect(condition()).toBe(true);
}

test("concurrent requests for one Skill prepare it once, including requests arriving during preparation", async () => {
  const directory = root();
  const release = Promise.withResolvers<void>();
  let calls = 0;
  const loader = createSkillLoader(directory, ["dependency"], async () => {
    calls++; await release.promise;
    return "frozen/SKILL.md";
  });
  try {
    loader.activate();
    writeFileSync(join(loader.requests, "0"), "");
    await until(() => calls === 1);
    writeFileSync(join(loader.requests, "0"), "");
    writeFileSync(join(loader.requests, "0"), "");
    release.resolve();
    await until(() => existsSync(join(directory, "responses", "0")));
    expect(readFileSync(join(directory, "responses", "0"), "utf8")).toBe("frozen/SKILL.md");
    expect(calls).toBe(1);
  } finally { release.resolve(); await loader.close(); }
  expect(existsSync(directory)).toBe(false);
});

test("cancellation waits for in-flight staging to stop before removing the mailbox", async () => {
  const directory = root();
  let started = false;
  let aborted = false;
  const loader = createSkillLoader(directory, ["slow"], async (_index, signal) => {
    started = true;
    await new Promise<void>(resolve => signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }));
    signal.throwIfAborted();
    return "unreachable";
  });
  loader.activate();
  writeFileSync(join(loader.requests, "0"), "");
  await until(() => started);
  await Promise.all([loader.close(), loader.close()]);
  expect(aborted).toBe(true);
  expect(existsSync(directory)).toBe(false);
});

test("an unknown request cannot select an arbitrary source and closes waiting clients", async () => {
  const directory = root();
  let calls = 0;
  const loader = createSkillLoader(directory, ["known"], async () => { calls++; return "never"; });
  try {
    loader.activate();
    writeFileSync(join(loader.requests, "99"), "");
    await until(() => loader.signal.aborted);
    await loader.close();
    expect(calls).toBe(0);
    expect(existsSync(directory)).toBe(false);
  } finally { await loader.close(); }
});
