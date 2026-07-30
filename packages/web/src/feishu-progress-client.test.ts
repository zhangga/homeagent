import { expect, test } from "bun:test";
import type { FeishuConnectionProgress } from "./feishu-connection-progress.ts";
import {
  applyFeishuProgressToView,
  feishuProgressBrowserScript,
  startFeishuProgressClient,
  type FeishuProgressView,
} from "./feishu-progress-client.ts";

function pollingProgress(
  patch: Partial<FeishuConnectionProgress> = {},
): FeishuConnectionProgress {
  return {
    version: 1,
    revision: "revision-1",
    pollAfterMs: 5_000,
    bot: {
      stage: "ready",
      health: "healthy",
      capability: "available",
    },
    groups: [{
      spaceId: "team/oc_web",
      stage: "ready_to_test",
      health: "healthy",
    }],
    nextAction: {
      kind: "test_group",
      spaceId: "team/oc_web",
    },
    ...patch,
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

test("Feishu progress polling starts after the server-provided interval", async () => {
  const scheduled: Array<{ callback: () => void; delay: number }> = [];
  let reads = 0;

  startFeishuProgressClient({
    initial: pollingProgress(),
    readProgress: () => {
      reads += 1;
      return new Promise(() => {});
    },
    applyProgress: () => {},
    setWarning: () => {},
    isVisible: () => true,
    subscribeVisibility: () => () => {},
    schedule: (callback, delay) => {
      scheduled.push({ callback, delay });
      return scheduled.length;
    },
    cancel: () => {},
  });

  expect(reads).toBe(0);
  expect(scheduled.map((timer) => timer.delay)).toEqual([5_000]);

  scheduled[0]!.callback();
  await flushPromises();
  expect(reads).toBe(1);
});

test("a successful Feishu progress read is applied and uses its next interval", async () => {
  const scheduled: Array<{ callback: () => void; delay: number }> = [];
  const applied: FeishuConnectionProgress[] = [];
  const next = pollingProgress({
    revision: "revision-2",
    pollAfterMs: 9_000,
  });

  startFeishuProgressClient({
    initial: pollingProgress(),
    readProgress: async () => next,
    applyProgress: (progress) => {
      applied.push(progress);
    },
    setWarning: () => {},
    isVisible: () => true,
    subscribeVisibility: () => () => {},
    schedule: (callback, delay) => {
      scheduled.push({ callback, delay });
      return scheduled.length;
    },
    cancel: () => {},
  });

  scheduled[0]!.callback();
  await flushPromises();

  expect(applied).toEqual([next]);
  expect(scheduled.some((timer) => timer.delay === 9_000)).toBe(true);
});

test("polling stops when the server omits the next interval", async () => {
  const scheduled: Array<{ callback: () => void; delay: number }> = [];

  startFeishuProgressClient({
    initial: pollingProgress(),
    readProgress: async () => pollingProgress({
      revision: "complete",
      pollAfterMs: undefined,
      nextAction: { kind: "none" },
    }),
    applyProgress: () => {},
    setWarning: () => {},
    isVisible: () => true,
    subscribeVisibility: () => () => {},
    schedule: (callback, delay) => {
      scheduled.push({ callback, delay });
      return scheduled.length;
    },
    cancel: () => {},
  });

  scheduled[0]!.callback();
  await Promise.resolve();
  await Promise.resolve();

  expect(scheduled.filter((timer) => timer.delay === 5_000)).toHaveLength(1);
});

test("Feishu progress reads never overlap", async () => {
  const scheduled: Array<{ callback: () => void; delay: number }> = [];
  let reads = 0;

  startFeishuProgressClient({
    initial: pollingProgress(),
    readProgress: () => {
      reads += 1;
      return new Promise(() => {});
    },
    applyProgress: () => {},
    setWarning: () => {},
    isVisible: () => true,
    subscribeVisibility: () => () => {},
    schedule: (callback, delay) => {
      scheduled.push({ callback, delay });
      return scheduled.length;
    },
    cancel: () => {},
  });

  scheduled[0]!.callback();
  scheduled[0]!.callback();
  await flushPromises();

  expect(reads).toBe(1);
});

test("consecutive failures use bounded backoff and a fixed warning", async () => {
  const scheduled: Array<{ callback: () => void; delay: number }> = [];
  const warnings: boolean[] = [];

  startFeishuProgressClient({
    initial: pollingProgress(),
    readProgress: async () => {
      throw new Error("private failure detail");
    },
    applyProgress: () => {},
    setWarning: (visible) => {
      warnings.push(visible);
    },
    isVisible: () => true,
    subscribeVisibility: () => () => {},
    schedule: (callback, delay) => {
      scheduled.push({ callback, delay });
      return scheduled.length;
    },
    cancel: () => {},
  });

  const backoff: number[] = [];
  for (let attempt = 0; attempt < 5; attempt += 1) {
    scheduled.at(-1)!.callback();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    backoff.push(scheduled.at(-1)!.delay);
  }

  expect(backoff).toEqual([5_000, 10_000, 20_000, 30_000, 30_000]);
  expect(warnings).toEqual([true, true, true, true, true]);
});

test("polling pauses while hidden and reads immediately when visible", async () => {
  const scheduled: Array<{ callback: () => void; delay: number }> = [];
  let visible = false;
  let onVisibility = () => {};
  let reads = 0;

  startFeishuProgressClient({
    initial: pollingProgress(),
    readProgress: () => {
      reads += 1;
      return new Promise(() => {});
    },
    applyProgress: () => {},
    setWarning: () => {},
    isVisible: () => visible,
    subscribeVisibility: (listener) => {
      onVisibility = listener;
      return () => {};
    },
    schedule: (callback, delay) => {
      scheduled.push({ callback, delay });
      return scheduled.length;
    },
    cancel: () => {},
  });

  expect(scheduled).toHaveLength(0);
  expect(reads).toBe(0);

  visible = true;
  onVisibility();
  await Promise.resolve();
  expect(reads).toBe(1);
});

test("a four-second timeout aborts the read and ignores its stale result", async () => {
  const scheduled: Array<{ callback: () => void; delay: number }> = [];
  const applied: FeishuConnectionProgress[] = [];
  const warnings: boolean[] = [];
  let signal: AbortSignal | undefined;
  let resolveRead: ((progress: FeishuConnectionProgress) => void) | undefined;

  startFeishuProgressClient({
    initial: pollingProgress(),
    readProgress: (requestSignal) => {
      signal = requestSignal;
      return new Promise<FeishuConnectionProgress>((resolve) => {
        resolveRead = resolve;
      });
    },
    applyProgress: (progress) => {
      applied.push(progress);
    },
    setWarning: (visible) => {
      warnings.push(visible);
    },
    isVisible: () => true,
    subscribeVisibility: () => () => {},
    schedule: (callback, delay) => {
      scheduled.push({ callback, delay });
      return scheduled.length;
    },
    cancel: () => {},
  });

  scheduled.find((timer) => timer.delay === 5_000)!.callback();
  await Promise.resolve();
  expect(signal?.aborted).toBe(false);

  const timeout = scheduled.find((timer) => timer.delay === 4_000);
  expect(timeout).toBeDefined();
  timeout!.callback();
  expect(signal?.aborted).toBe(true);
  expect(warnings).toEqual([true]);

  resolveRead!(pollingProgress({ revision: "stale" }));
  await Promise.resolve();
  await Promise.resolve();
  expect(applied).toEqual([]);
});

test("malformed progress is rejected with the fixed refresh warning", async () => {
  const scheduled: Array<{ callback: () => void; delay: number }> = [];
  const applied: FeishuConnectionProgress[] = [];
  const warnings: boolean[] = [];

  startFeishuProgressClient({
    initial: pollingProgress(),
    readProgress: async () => ({
      version: 1,
      revision: "malformed",
      bot: {
        stage: "ready",
        health: "healthy",
        capability: "available",
      },
      groups: [],
      nextAction: {
        kind: "javascript:alert(1)",
      },
    }),
    applyProgress: (progress) => {
      applied.push(progress);
    },
    setWarning: (visible) => {
      warnings.push(visible);
    },
    isVisible: () => true,
    subscribeVisibility: () => () => {},
    schedule: (callback, delay) => {
      scheduled.push({ callback, delay });
      return scheduled.length;
    },
    cancel: () => {},
  });

  scheduled.find((timer) => timer.delay === 5_000)!.callback();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  expect(applied).toEqual([]);
  expect(warnings).toEqual([true]);
});

test("progress application updates allowlisted slots without touching editable forms", () => {
  const calls: string[] = [];
  let editableWrites = 0;
  const view: FeishuProgressView & { writeEditableForm(): void } = {
    setRoot: ({ nextAction }) => {
      calls.push(`root:${nextAction}`);
    },
    setSummary: ({ title }) => {
      calls.push(`summary:${title}`);
    },
    showAction: (kind) => {
      calls.push(`action:${kind}`);
    },
    setBot: ({ stage }) => {
      calls.push(`bot:${stage}`);
    },
    setGroup: (group) => {
      calls.push(`group:${group.spaceId}:${group.stage}`);
      return group.spaceId === "team/oc_web";
    },
    writeEditableForm: () => {
      editableWrites += 1;
    },
  };

  const applied = applyFeishuProgressToView(
    pollingProgress(),
    view,
  );

  expect(applied).toBe(true);
  expect(calls).toContain("action:test_group");
  expect(calls).toContain("group:team/oc_web:ready_to_test");
  expect(editableWrites).toBe(0);
});

test("an absent rendered group requests a manual refresh instead of replacing the page", async () => {
  const scheduled: Array<{ callback: () => void; delay: number }> = [];
  const warnings: boolean[] = [];

  startFeishuProgressClient({
    initial: pollingProgress(),
    readProgress: async () => pollingProgress({ revision: "new-group" }),
    applyProgress: () => false,
    setWarning: (visible) => {
      warnings.push(visible);
    },
    isVisible: () => true,
    subscribeVisibility: () => () => {},
    schedule: (callback, delay) => {
      scheduled.push({ callback, delay });
      return scheduled.length;
    },
    cancel: () => {},
  });

  scheduled.find((timer) => timer.delay === 5_000)!.callback();
  await flushPromises();

  expect(warnings).toEqual([true]);
  expect(scheduled.filter((timer) => timer.delay === 5_000)).toHaveLength(2);
});

test("the browser bootstrap updates fixed slots without HTML or form mutation", () => {
  const script = feishuProgressBrowserScript(
    pollingProgress({ revision: "</script><script>alert(1)</script>" }),
  );

  expect(script).toContain("/integrations/progress");
  expect(script).toContain("visibilitychange");
  expect(script).toContain("AbortController");
  expect(script).toContain("textContent");
  expect(script).not.toContain("</script><script>alert(1)</script>");
  expect(script).not.toContain("innerHTML");
  expect(script).not.toContain(".action =");
  expect(script).not.toContain(".value =");
});
