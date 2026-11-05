import { expect, test } from "bun:test";
import { measureSkillPreparation } from "./skill-preparation-fixture.ts";

test("two immediate cold requests share one scan, start concurrently, and ignore a cancelled namesake", async () => {
  const result = await measureSkillPreparation([], undefined, { coldPair: true });
  expect(result.scansBeforeMessages).toBe(0);
  expect(result.scans).toBe(1);
  expect(result.runs).toHaveLength(2);
  expect(result.runs.every(run => run.status === "succeeded" && run.delivery === "sent" && run.skills === 116)).toBe(true);
  expect(new Set(result.runs.map(run => run.workItemId)).size).toBe(2);
  expect(result.runs.every(run => run.workItemId !== result.cancelledItem?.id)).toBe(true);
  expect(result.cancelledItem?.active).toBe(false);
  expect(Math.max(...result.runs.map(run => run.runStartedAt!))).toBeLessThan(Math.min(...result.runs.map(run => run.finishedAt!)));
  expect(result.calls.length).toBeGreaterThanOrEqual(4);
  expect(Math.max(...result.samples.map(sample => sample.ms))).toBeLessThan(1000);
  console.log(JSON.stringify({ coldParallelStartMs: result.runs.map(run => run.runStartedAt! - result.phases.find(phase => phase.name === run.messageId)!.start),
    maxHttpMs: Math.round(Math.max(...result.samples.map(sample => sample.ms))) }));
}, 60_000);

test("message admission, frozen execution, lazy dependencies and repeated model calls keep management HTTP responsive", async () => {
  const result = await measureSkillPreparation();
  expect(result.runs).toHaveLength(3);
  expect(result.runs.every(run => run.status === "succeeded" && run.delivery === "sent" && run.skills === 116)).toBe(true);
  expect(result.finalScanVersion).toBe(result.scanVersion);
  expect(result.scans).toBe(1);
  expect(result.calls.length).toBeGreaterThanOrEqual(6);
  const loaded = result.calls.filter(call => call.paths.length);
  expect(loaded.length).toBeGreaterThanOrEqual(2);
  expect(loaded.every(call => call.paths[0] === call.paths[1])).toBe(true);
  expect(result.loadedRoots).toBe(1);
  const first = result.runs.find(run => run.messageId === "warm-load")!;
  const second = result.runs.find(run => run.messageId === "warm-no-skill")!;
  expect(Math.max(first.startedAt!, second.startedAt!)).toBeLessThan(Math.min(first.finishedAt!, second.finishedAt!));
  expect(result.cleaned).toBe(true);
  expect(result.samples.length).toBeGreaterThan(10);
  // External process probes detect a blocked server even when local timers stall.
  expect(Math.max(...result.samples.map(sample => sample.ms))).toBeLessThan(1000);
  console.log(JSON.stringify({ skillPreparation: result.phases, requests: result.samples.length,
    maxHttpMs: Math.round(Math.max(...result.samples.map(sample => sample.ms))), modelCalls: result.calls.length }));
}, 60_000);

test("startup warmup removes the cold catalog scan from the first message and concurrent follow-ups", async () => {
  const result = await measureSkillPreparation([], undefined, { warmup: true });
  expect(result.phases[0]?.name).toBe("startup-warmup");
  expect(result.scansBeforeMessages).toBe(1);
  expect(result.scans).toBe(1);
  expect(result.runs).toHaveLength(3);
  expect(result.runs.every(run => run.status === "succeeded" && run.delivery === "sent" && run.skills === 116)).toBe(true);
  expect(result.calls.length).toBeGreaterThanOrEqual(6);
  expect(result.cleaned).toBe(true);
  const warmup = result.phases[0]!;
  expect(result.calls.every(call => call.at >= warmup.end)).toBe(true);
  expect(result.samples.some(sample => sample.at >= warmup.start && sample.at <= warmup.end)).toBe(true);
  expect(Math.max(...result.samples.map(sample => sample.ms))).toBeLessThan(1000);
  console.log(JSON.stringify({ startupWarmup: warmup.end - warmup.start,
    messageToRunMs: result.runs.map(run => run.startedAt - result.phases.find(phase => phase.name === run.messageId)!.start),
    maxHttpMs: Math.round(Math.max(...result.samples.map(sample => sample.ms))) }));
}, 60_000);
