import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpaceStore } from "./space.ts";
import { getQuarantineRecord, listQuarantineRecords, writeQuarantineRecord } from "./quarantine.ts";
import { retryQuarantinedDreamOperation, runDreamCycle } from "./dream.ts";
import { FakeLlm } from "./testing.ts";
import * as durable from "./durable-file.ts";
import type { QuarantinedDreamOperation } from "./types.ts";

let dir: string;
let store: SpaceStore;
let rawId: string;
const SPACE = "team/oc_fragment_quarantine";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ha-fragment-quarantine-"));
  store = new SpaceStore(SPACE, dir);
  store.ensure();
  rawId = store.index().insertRaw({ space: SPACE, source: "message", content: "relevant" });
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

function operation(): QuarantinedDreamOperation {
  return { type: "concept", name: "topic", title: "Topic", rawIds: [rawId], basePageHash: null,
    sourceFragments: [{ rawId, start: 0, end: 8, part: 1, totalParts: 1,
      contentHash: new Bun.CryptoHasher("sha256").update("relevant").digest("hex") }] };
}
function persist(op = operation()) {
  return writeQuarantineRecord(store, { slug: "concepts/topic", error: "capacity", rawIds: [rawId], createdAt: 1, operation: op });
}

test("frozen fragment metadata is cloned and survives reopen; legacy full-source plans still read", () => {
  const input = operation();
  const record = persist(input);
  input.sourceFragments![0]!.start = 5;
  record.operation!.sourceFragments![0]!.end = 7;
  store.close();
  store = new SpaceStore(SPACE, dir);
  expect(getQuarantineRecord(store, record.id)?.operation?.sourceFragments).toEqual(operation().sourceFragments);
  const legacy = operation();
  delete legacy.sourceFragments;
  expect(getQuarantineRecord(store, persist(legacy).id)?.operation).toEqual(legacy);
});

test("invalid frozen fragment ranges never fall back to a full-source legacy retry", () => {
  for (const invalid of [
    { start: -1 }, { end: 48_001 }, { part: 0 }, { totalParts: 0 },
    { rawId: "another-source" }, { contentHash: "invalid" },
  ]) {
    const op = operation();
    Object.assign(op.sourceFragments![0]!, invalid);
    expect(() => persist(op)).toThrow("invalid frozen Dream operation");
  }
  const record = persist();
  const path = join(store.root, "quarantine", `${record.id}.json`);
  record.operation!.sourceFragments![0]!.start = -1;
  writeFileSync(path, JSON.stringify(record));
  const corrupt = getQuarantineRecord(store, record.id)!;
  expect(corrupt.rawIds).toEqual([]);
  expect(corrupt.error).toContain("冻结的提炼计划无效");
});

test("the fragment collection boundary preserves all accepted ranges and rejects excess without partial writes", () => {
  const op = operation();
  op.sourceFragments = Array.from({ length: 10_000 }, (_, index) => ({
    ...operation().sourceFragments![0]!, start: index, end: index + 1, part: index + 1, totalParts: 10_001,
  }));
  const record = persist(op);
  expect(getQuarantineRecord(store, record.id)?.operation?.sourceFragments).toHaveLength(10_000);
  op.sourceFragments.push({ ...op.sourceFragments[0]! });
  expect(() => persist(op)).toThrow("invalid frozen Dream operation");
  expect(listQuarantineRecords(store)).toHaveLength(1);
});

test("changed or unavailable frozen fragments stop before provider invocation", async () => {
  for (const invalid of [{ contentHash: "0".repeat(64) }, { end: 9 }]) {
    const record = persist();
    Object.assign(record.operation!.sourceFragments![0]!, invalid);
    const fake = new FakeLlm();
    await expect(retryQuarantinedDreamOperation(store, record, {}, { client: fake })).rejects.toThrow();
    expect(fake.calls).toEqual([]);
    expect(getQuarantineRecord(store, record.id)).toBeDefined();
  }
});

test("a quarantine persistence failure leaves the Raw pending and preserves previous recovery records", async () => {
  const record = persist();
  const path = join(store.root, "quarantine", `${record.id}.json`);
  const before = readFileSync(path, "utf8");
  const fake = new FakeLlm()
    .queueJSON({ operations: [{ type: "concept", name: "topic", title: "Topic", rawIds: [rawId] }], skippedRawIds: [] })
    .queueJSON({ title: "Topic", content: "" });
  const failure = spyOn(durable, "writeAtomicStateFile").mockImplementation(() => { throw new Error("disk failure"); });
  try { await expect(runDreamCycle(store, { model: "fake" }, { client: fake })).rejects.toThrow("disk failure"); }
  finally { failure.mockRestore(); }
  expect(readFileSync(path, "utf8")).toBe(before);
  store.close();
  store = new SpaceStore(SPACE, dir);
  expect(store.index().countRaw(true)).toBe(1);
  expect(listQuarantineRecords(store)).toHaveLength(1);
});
