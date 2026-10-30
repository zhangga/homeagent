import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetConfig } from "@homeagent/shared";
import { makeCliClient } from "./cli-client.ts";
import { regeneratePageFromSources, retryQuarantinedDreamOperation, runDreamCycle } from "./dream.ts";
import type { DreamProgress } from "./dream-progress.ts";
import { listQuarantineRecords } from "./quarantine.ts";
import { SpaceStore } from "./space.ts";
import { FakeLlm } from "./testing.ts";
import { observeLlmUsage } from "./usage.ts";
import * as durable from "./durable-file.ts";
import { RawJournal } from "./raw-journal.ts";

const SPACE = "team/oc_extraction_retry";
let dir: string;
let store: SpaceStore;
class CacheLlm extends FakeLlm { constructor(readonly cacheIdentity = "offline-provider-v1") { super(); } }
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ha-extraction-retry-"));
  process.env.HOMEAGENT_DATA_DIR = dir;
  resetConfig();
  store = new SpaceStore(SPACE, dir);
  store.ensure();
});
afterEach(() => {
  store.close(); rmSync(dir, { recursive: true, force: true });
  delete process.env.HOMEAGENT_DATA_DIR; resetConfig();
});
function note(content: string) { return { title: "Topic", summary: "Evidence", content, links: ["concepts/linked"], aliases: ["Alias"], tags: ["Tag"] }; }
function raw(parts = 3) {
  return store.index().insertRaw({ space: SPACE, source: "message",
    content: Array.from({ length: parts }, (_, i) => `FRAGMENT_${i + 1}_END`.padEnd(48_000, "文")).join("") });
}
function fake(id: string, fail: number | "merge" | undefined = undefined, identity?: string) {
  return new CacheLlm(identity).onJSON(opts => {
    const prompt = opts.prompt!;
    if (prompt.includes("## 待提炼的原始条目")) return { operations: [{ type: "concept", name: "topic", title: "Topic", rawIds: [id] }], skippedRawIds: [] };
    if (prompt.includes("## 来源分段提取")) {
      const part = Number(/FRAGMENT_(\d+)_END/u.exec(prompt)?.[1]);
      if (fail === part) throw new Error("extraction failed");
      return note(`DETAIL_${part}_END`);
    }
    if (fail === "merge") throw new Error("merge failed");
    return note("Merged page");
  });
}
function reopen() { store.close(); store = new SpaceStore(SPACE, dir); }
function folders() {
  const root = join(store.root, ".dream-extractions");
  return existsSync(root) ? readdirSync(root).map(name => join(root, name)) : [];
}
function extracted(client: FakeLlm) {
  return client.calls.filter(call => call.opts.prompt?.includes("## 来源分段提取"))
    .map(call => Number(/FRAGMENT_(\d+)_END/u.exec(call.opts.prompt!)?.[1]));
}

test("a failed final merge reopens all extraction checkpoints and only calls the provider for the merge", async () => {
  const id = raw();
  const first = fake(id, "merge");
  expect((await runDreamCycle(store, {}, { client: first })).pagesQuarantined).toBe(1);
  expect(extracted(first)).toEqual([1, 2, 3]);
  expect(folders()).toHaveLength(1);
  reopen();
  const retry = fake(id);
  const progress: DreamProgress[] = [];
  const usage: unknown[] = [];
  const result = await retryQuarantinedDreamOperation(store, listQuarantineRecords(store)[0]!, {}, {
    client: observeLlmUsage(retry, item => usage.push(item)), onProgress: item => progress.push(item),
  });
  expect(result.errors).toEqual([]);
  expect(retry.calls).toHaveLength(1);
  expect(usage).toHaveLength(1);
  expect(progress.some(item => item.extraction?.reused === 3 && item.extraction.completed === 3)).toBe(true);
  const page = store.index().getPage("concepts/topic")!;
  expect([...page.content.matchAll(/DETAIL_(\d+)_END/gu)].map(match => match[1])).toEqual(["1", "2", "3"]);
  expect(page.sources).toEqual([id]);
  expect(page.aliases).toEqual(["Alias"]);
  expect(page.links).toEqual(["concepts/linked"]);
  expect(folders()).toEqual([]);
});

test("failed extraction reuses a completed in-flight sibling after reopen and extracts only missing groups", async () => {
  const id = raw();
  const first = fake(id, 1);
  expect((await runDreamCycle(store, {}, { client: first })).pagesQuarantined).toBe(1);
  expect(extracted(first)).toEqual([1, 2]);
  reopen();
  const retry = fake(id);
  expect((await retryQuarantinedDreamOperation(store, listQuarantineRecords(store)[0]!, {}, { client: retry })).errors).toEqual([]);
  expect(extracted(retry)).toEqual([1, 3]);
  expect(retry.calls).toHaveLength(3);
});

test("shared extraction persists each target and restores group boundaries on a single-page retry", async () => {
  const ids = [1, 2, 3].map(part => store.index().insertRaw({ space: SPACE, source: "message", content: `SOURCE_${part}`.padEnd(20_000, "文") }));
  const first = new CacheLlm().onJSON(opts => {
    const prompt = opts.prompt!;
    if (prompt.includes("## 待提炼的原始条目")) {
      const rawIds = ids.filter(id => prompt.includes(id));
      return { operations: [
        { type: "concept", name: "a", title: "a", rawIds },
        ...(rawIds.includes(ids[0]!) ? [{ type: "concept", name: "b", title: "b", rawIds: [ids[0]!] }] : []),
      ], skippedRawIds: [] };
    }
    if (prompt.includes("## 多页共享提取")) return { pages: ["a", "b"].map(name => ({ slug: `concepts/${name}`, ...note(`${name}_SHARED`) })) };
    if (prompt.includes("## 来源分段提取")) return note("PRIVATE_SECOND_AND_THIRD");
    throw new Error("merge failed");
  });
  expect((await runDreamCycle(store, {}, { client: first })).pagesQuarantined).toBe(2);
  expect(folders()).toHaveLength(2);
  reopen();
  for (const name of ["a", "b"]) {
    const record = listQuarantineRecords(store).find(item => item.slug === `concepts/${name}`)!;
    const retry = new CacheLlm().onJSON(() => note("Merged"));
    expect((await retryQuarantinedDreamOperation(store, record, {}, { client: retry })).errors).toEqual([]);
    expect(retry.calls).toHaveLength(1);
    const prompt = retry.calls[0]!.opts.prompt!;
    expect(prompt).toContain(`${name}_SHARED`);
    expect(prompt).not.toContain(`${name === "a" ? "b" : "a"}_SHARED`);
    const content = store.index().getPage(record.slug)!.content;
    if (name === "a") {
      expect(content).toContain(`来源 Raw：${ids[1]}（1/1）、${ids[2]}（1/1）`);
      expect(content).toContain("PRIVATE_SECOND_AND_THIRD");
    } else expect(content).not.toContain("PRIVATE_SECOND_AND_THIRD");
  }
  expect(folders()).toEqual([]);
});

test("a resumed shared extraction requests only targets whose saved result is missing", async () => {
  const id = raw(2);
  const requested: string[][] = [];
  const client = () => new CacheLlm().onJSON(opts => {
    const prompt = opts.prompt!;
    if (prompt.includes("## 待提炼的原始条目")) return { operations: ["a", "b"].map(name => ({ type: "concept", name, title: name, rawIds: [id] })), skippedRawIds: [] };
    if (prompt.includes("## 多页共享提取")) {
      const targets = prompt.split("\n").filter(line => line.startsWith('{"slug":')).map(line => JSON.parse(line).slug as string);
      requested.push(targets);
      const part = /FRAGMENT_(\d+)_END/u.exec(prompt)![1];
      return { pages: targets.map(slug => ({ slug, ...note(`${slug}_DETAIL_${part}_END`) })) };
    }
    return note("Merged");
  });
  const controller = new AbortController();
  await expect(runDreamCycle(store, { signal: controller.signal }, { client: client(), onProgress: progress => {
    if (progress.extraction?.completed === 1) controller.abort(new Error("stop"));
  } })).rejects.toThrow("stop");
  for (const folder of folders()) for (const name of readdirSync(folder)) {
    const file = join(folder, name);
    if (readFileSync(file, "utf8").includes("concepts/b_DETAIL_1_END")) rmSync(file);
  }
  reopen();
  requested.length = 0;
  const retry = client();
  expect((await runDreamCycle(store, {}, { client: retry })).errors).toEqual([]);
  expect(requested).toEqual([["concepts/b"]]);
  expect(retry.calls).toHaveLength(5); // Two plans, one missing target extraction, two merges.
  for (const name of ["a", "b"]) {
    const content = store.index().getPage(`concepts/${name}`)!.content;
    expect(content).toContain(`concepts/${name}_DETAIL_1_END`);
    expect(content).toContain(`concepts/${name}_DETAIL_2_END`);
  }
});

for (const corrupt of ["checksum", "truncated", "future-version", "missing"] as const) {
  test(`${corrupt} checkpoint repeats only the affected extraction`, async () => {
    const id = raw(2);
    await runDreamCycle(store, {}, { client: fake(id, "merge") });
    const path = folders()[0]!;
    const file = readdirSync(path).filter(name => name !== "plan.json")
      .map(name => join(path, name)).find(file => readFileSync(file, "utf8").includes("DETAIL_1_END"))!;
    if (corrupt === "missing") rmSync(file);
    else if (corrupt === "truncated") writeFileSync(file, "{broken");
    else {
      const stored = JSON.parse(readFileSync(file, "utf8"));
      if (corrupt === "checksum") stored.note.content = "tampered";
      else stored.version = 2;
      writeFileSync(file, JSON.stringify(stored));
    }
    reopen();
    const retry = fake(id);
    expect((await retryQuarantinedDreamOperation(store, listQuarantineRecords(store)[0]!, {}, { client: retry })).errors).toEqual([]);
    expect(extracted(retry)).toEqual([1]);
    expect(retry.calls).toHaveLength(2);
    expect(store.index().getPage("concepts/topic")!.content).not.toContain("tampered");
  });
}

for (const changed of ["model", "provider", "schema", "purpose", "target"] as const) {
  test(`changing ${changed} invalidates previously completed extraction`, async () => {
    const id = raw(2);
    await runDreamCycle(store, {}, { client: fake(id, "merge") });
    const record = listQuarantineRecords(store)[0]!;
    if (changed === "schema") writeFileSync(join(store.root, "schema.md"), "Changed extraction rules");
    if (changed === "purpose") writeFileSync(join(store.root, "purpose.md"), "Changed purpose");
    if (changed === "target") record.operation!.title = "Changed target";
    const retry = fake(id, undefined, changed === "provider" ? "other-provider" : undefined);
    expect((await retryQuarantinedDreamOperation(store, record, changed === "model" ? { model: "other-model" } : {}, { client: retry })).errors).toEqual([]);
    expect(extracted(retry)).toEqual([1, 2]);
  });
}

test("effective CLI model and reasoning configuration invalidate checkpoints even when opts.model stays unchanged", async () => {
  const id = raw(2);
  let calls = 0;
  const client = (model: string, effort: "low" | "high", fail = false) => makeCliClient("codex", model, dir, async (_provider, input) => {
    calls++;
    if (input.prompt.includes("## 待提炼的原始条目")) return JSON.stringify({ operations: [{ type: "concept", name: "topic", title: "Topic", rawIds: [id] }], skippedRawIds: [] });
    if (input.prompt.includes("## 来源分段提取")) return JSON.stringify(note("Detail"));
    if (fail) throw new Error("merge failed");
    return JSON.stringify(note("Merged"));
  }, undefined, effort);
  await runDreamCycle(store, { model: "gateway-tier" }, { client: client("cli-a", "low", true) });
  const record = listQuarantineRecords(store)[0]!;
  calls = 0;
  await retryQuarantinedDreamOperation(store, record, { model: "gateway-tier" }, { client: client("cli-b", "high") });
  expect(calls).toBe(3);
});

test("cache write failures preserve completed entries and normal extraction remains usable", async () => {
  const id = raw(2);
  const atomic = durable.writeAtomicStateFile;
  const failure = spyOn(durable, "writeAtomicStateFile").mockImplementation((path, contents) => {
    if (path.includes(".dream-extractions") && contents.includes("DETAIL_2_END")) throw new Error("private disk details");
    return atomic(path, contents);
  });
  try { expect((await runDreamCycle(store, {}, { client: fake(id, "merge") })).pagesQuarantined).toBe(1); }
  finally { failure.mockRestore(); }
  reopen();
  const retry = fake(id);
  expect((await retryQuarantinedDreamOperation(store, listQuarantineRecords(store)[0]!, {}, { client: retry })).errors).toEqual([]);
  expect(extracted(retry)).toEqual([2]);
});

test("force and explicit full regeneration perform fresh extraction; regeneration failure can still reuse its new notes", async () => {
  const id = raw(2);
  await runDreamCycle(store, {}, { client: fake(id, "merge") });
  const forced = fake(id);
  expect((await runDreamCycle(store, { force: true }, { client: forced })).errors).toEqual([]);
  expect(extracted(forced)).toEqual([1, 2]);
  const regeneration = fake(id, "merge");
  await expect(regeneratePageFromSources(store, "concepts/topic", [], {}, { client: regeneration })).rejects.toThrow("merge failed");
  expect(extracted(regeneration)).toEqual([1, 2]);
  const second = fake(id, "merge");
  await expect(regeneratePageFromSources(store, "concepts/topic", [], {}, { client: second })).rejects.toThrow("merge failed");
  expect(extracted(second)).toEqual([1, 2]);
  reopen();
  const retry = fake(id);
  expect((await retryQuarantinedDreamOperation(store, listQuarantineRecords(store)[0]!, {}, { client: retry })).errors).toEqual([]);
  expect(retry.calls).toHaveLength(1);
});

test("cancellation retains completed notes without saving a page or consuming Raw; the next cycle reuses them", async () => {
  const id = raw();
  const controller = new AbortController();
  await expect(runDreamCycle(store, { signal: controller.signal }, { client: fake(id), onProgress: progress => {
    if (progress.extraction?.completed === 1) controller.abort(new Error("stop"));
  } })).rejects.toThrow("stop");
  expect(store.index().getPage("concepts/topic")).toBeNull();
  expect(store.index().getRaw(id)!.ingested).toBe(false);
  reopen();
  const retry = fake(id);
  expect((await runDreamCycle(store, {}, { client: retry })).errors).toEqual([]);
  expect(extracted(retry)).toEqual([3]);
});

test("legacy quarantine without checkpoints and clients without a stable identity still extract every group", async () => {
  const id = raw(2);
  await runDreamCycle(store, {}, { client: fake(id, "merge") });
  rmSync(join(store.root, ".dream-extractions"), { recursive: true });
  const retry = new FakeLlm().onJSON(opts => note(opts.prompt?.includes("## 来源分段提取") ? "Fresh detail" : "Merged"));
  expect((await retryQuarantinedDreamOperation(store, listQuarantineRecords(store)[0]!, {}, { client: retry })).errors).toEqual([]);
  expect(retry.calls).toHaveLength(3);
});

test("a Knowledge page save failure retains all completed extraction for retry", async () => {
  const id = raw(2);
  const write = store.writePage.bind(store);
  const failure = spyOn(store, "writePage").mockImplementation(page => {
    if (page.slug === "concepts/topic") throw new Error("page save failed");
    return write(page);
  });
  try { expect((await runDreamCycle(store, {}, { client: fake(id) })).pagesQuarantined).toBe(1); }
  finally { failure.mockRestore(); }
  expect(store.index().getPage("concepts/topic")).toBeNull();
  reopen();
  const retry = fake(id);
  expect((await retryQuarantinedDreamOperation(store, listQuarantineRecords(store)[0]!, {}, { client: retry })).errors).toEqual([]);
  expect(retry.calls).toHaveLength(1);
});

for (const mutation of ["content", "held", "excluded"] as const) {
  test(`${mutation} Raw cannot bypass source validation through an existing checkpoint`, async () => {
    const id = raw(2);
    await runDreamCycle(store, {}, { client: fake(id, "merge") });
    const record = listQuarantineRecords(store)[0]!;
    const original = store.index().getRaw(id)!;
    store.close();
    const journal = new RawJournal(join(store.root, "raw"), SPACE);
    journal.replaceMany([{ ...original, ...(mutation === "content" ? { content: original.content.replace("FRAGMENT_1", "FRAGMENT_X") } : { admission: mutation }) }]);
    store = new SpaceStore(SPACE, dir);
    const retry = fake(id);
    await expect(retryQuarantinedDreamOperation(store, record, {}, { client: retry })).rejects.toThrow();
    expect(retry.calls).toEqual([]);
    expect(store.index().getPage("concepts/topic")).toBeNull();
  });
}

test.skipIf(process.platform === "win32")("SIGKILL after extraction preserves notes for a new cycle without automatically replaying the interrupted process", async () => {
  const id = raw(2);
  store.close();
  const script = `
    import { SpaceStore } from ${JSON.stringify(new URL("./space.ts", import.meta.url).href)};
    import { FakeLlm } from ${JSON.stringify(new URL("./testing.ts", import.meta.url).href)};
    import { runDreamCycle } from ${JSON.stringify(new URL("./dream.ts", import.meta.url).href)};
    const store = new SpaceStore(${JSON.stringify(SPACE)}, ${JSON.stringify(dir)});
    const client = new FakeLlm().onJSON(opts => {
      if (opts.prompt.includes("## 待提炼的原始条目")) return {
        operations: [{ type: "concept", name: "topic", title: "Topic", rawIds: [${JSON.stringify(id)}] }], skippedRawIds: []
      };
      if (opts.prompt.includes("## 来源分段提取")) return { title: "Topic", summary: "Evidence", content: "CRASH_SURVIVING_EVIDENCE", links: [] };
      process.kill(process.pid, "SIGKILL");
      throw new Error("SIGKILL did not terminate");
    });
    Object.assign(client, { cacheIdentity: "offline-provider-v1" });
    await runDreamCycle(store, {}, { client });
  `;
  const child = Bun.spawn([process.execPath, "--eval", script], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ exit, stdout, stderr }).toEqual({ exit: 137, stdout: "", stderr: "" });
  store = new SpaceStore(SPACE, dir);
  const retry = fake(id);
  expect(retry.calls).toEqual([]);
  expect(store.index().getPage("concepts/topic")).toBeNull();
  expect(store.index().getRaw(id)!.ingested).toBe(false);
  expect((await runDreamCycle(store, {}, { client: retry })).errors).toEqual([]);
  expect(extracted(retry)).toEqual([]);
  expect(retry.calls).toHaveLength(3); // Two planning calls plus the final merge.
  expect(store.index().getPage("concepts/topic")!.content.match(/CRASH_SURVIVING_EVIDENCE/gu)).toHaveLength(2);
});
