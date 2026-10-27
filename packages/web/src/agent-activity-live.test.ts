import { expect, test } from "bun:test";
import { agentActivityLiveScript } from "./agent-activity-live.ts";

class Node {
  innerHTML = "initial";
  textContent = "";
  className = "";
  scrollTop = 0;
  open = false;
  focused = false;
  dataset: Record<string, string> = {};
  slots = new Map<string, Node>();
  querySelector(selector: string) { return this.slots.get(selector); }
  querySelectorAll(selector: string) { return this.slots.has(selector) ? [this.slots.get(selector)!] : []; }
  contains(node: unknown) { return this.focused && node !== undefined; }
}

function harness() {
  const overview = new Node();
  const recent = new Node();
  const summary = new Node();
  const root = new Node();
  root.dataset.agentActivityUrl = "/agents/activity?agent=agent_test&runs=40";
  const history = new Node();
  overview.slots.set("details", history);
  const list = new Node();
  overview.slots.set(".agent-activity-runs", list);
  const agent = new Node();
  agent.dataset = { agentId: "agent_test", agentIdleLabel: "CLI 已连接", agentIdleState: "ready" };
  const label = new Node();
  const mark = new Node();
  agent.slots.set("[data-agent-status]", label);
  agent.slots.set(".agent-status-mark", mark);
  const nodes = new Map([
    ["agent-activity", root], ["agent-activity-overview", overview],
    ["agent-activity-summary", summary], ["agent-recent-runs", recent],
  ]);
  const document = {
    hidden: false, activeElement: { value: "未保存的 Instruction" },
    getElementById: (id: string) => nodes.get(id),
    querySelectorAll: () => [agent],
    addEventListener: (name: string, callback: () => void) => { events.set(name, callback); },
  };
  const events = new Map<string, () => void>();
  const timers = new Map<number, { callback: () => void; delay: number }>();
  let nextTimer = 0;
  let reads = 0;
  let snapshot = {
    activeCount: 1, summary: "1 个运行中 · 0 个排队中", overviewHtml: "默认（全局） · 运行中",
    recentHtml: "Chat · 运行中", agents: [{ id: "agent_test", running: true, queued: false }],
  };
  let read: () => Promise<unknown> = async () => ({ ok: true, json: async () => snapshot });
  let request: { url: string; options: RequestInit } | undefined;
  new Function("document", "window", "fetch", "setTimeout", "clearTimeout", agentActivityLiveScript())(
    document, { addEventListener: (name: string, callback: () => void) => { events.set(name, callback); } },
    (url: string, options: RequestInit) => { reads++; request = { url, options }; return read(); },
    (callback: () => void, delay: number) => { timers.set(++nextTimer, { callback, delay }); return nextTimer; },
    (timer: number) => { timers.delete(timer); },
  );
  return {
    overview, recent, summary, history, list, label, mark, document, timers,
    reads: () => reads, request: () => request,
    setSnapshot: (value: typeof snapshot) => { snapshot = value; },
    setRead: (value: typeof read) => { read = value; },
    fire: (name: string) => events.get(name)?.(),
    tick: () => {
      const [id, timer] = [...timers][0]!;
      timers.delete(id);
      timer.callback();
    },
  };
}

async function flush() { for (let index = 0; index < 12; index++) await Promise.resolve(); }

test("a new default Chat appears automatically while unsaved Agent settings, focus and history stay intact", async () => {
  const view = harness();
  expect(view.reads()).toBe(0);
  view.history.open = true;
  view.list.scrollTop = 72;
  const focused = view.document.activeElement;
  view.tick();
  await flush();
  expect(view.request()?.url).toBe("/agents/activity?agent=agent_test&runs=40");
  expect(view.request()?.options).toEqual(expect.objectContaining({ cache: "no-store", credentials: "same-origin" }));
  expect(view.overview.innerHTML).toBe("默认（全局） · 运行中");
  expect(view.recent.innerHTML).toBe("Chat · 运行中");
  expect(view.label.textContent).toBe("任务运行中");
  expect(view.mark.className).toBe("agent-status-mark running");
  expect(view.document.activeElement).toBe(focused);
  expect(focused.value).toBe("未保存的 Instruction");
  expect(view.history.open).toBe(true);
  expect(view.list.scrollTop).toBe(72);
  expect([...view.timers.values()].map((timer) => timer.delay)).toEqual([3000]);
});

test("queued and completed runs update badges and retain completed history", async () => {
  const view = harness();
  view.setSnapshot({ activeCount: 1, summary: "0 个运行中 · 1 个排队中", overviewHtml: "排队中",
    recentHtml: "Chat · 排队中", agents: [{ id: "agent_test", running: false, queued: true }],
  });
  view.tick();
  await flush();
  expect(view.label.textContent).toBe("任务排队中");
  view.setSnapshot({ activeCount: 0, summary: "当前没有运行或排队的任务", overviewHtml: "默认 Agent 最近记录 · 已完成",
    recentHtml: "Chat · 已完成", agents: [{ id: "agent_test", running: false, queued: false }],
  });
  view.tick();
  await flush();
  expect(view.overview.innerHTML).toContain("已完成");
  expect(view.recent.innerHTML).toBe("Chat · 已完成");
  expect(view.label.textContent).toBe("CLI 已连接");
  expect(view.mark.className).toBe("agent-status-mark ready");
  expect([...view.timers.values()].map((timer) => timer.delay)).toEqual([5000]);
});

test("focused Run links are not replaced until focus leaves the list", async () => {
  const view = harness();
  view.recent.focused = true;
  view.tick();
  await flush();
  expect(view.recent.innerHTML).toBe("initial");
  expect(view.overview.innerHTML).toContain("运行中");
  view.recent.focused = false;
  view.tick();
  await flush();
  expect(view.recent.innerHTML).toBe("Chat · 运行中");
});

test("hidden pages pause polling, visible pages resume without overlapping requests, and navigation stops it", async () => {
  const view = harness();
  view.document.hidden = true;
  view.fire("visibilitychange");
  expect(view.timers.size).toBe(0);
  view.setRead(() => new Promise(() => {}));
  view.document.hidden = false;
  view.fire("visibilitychange");
  view.fire("visibilitychange");
  expect(view.reads()).toBe(1);
  view.fire("pagehide");
  expect(view.request()?.options.signal?.aborted).toBe(true);
  view.fire("visibilitychange");
  expect(view.reads()).toBe(1);
});

test("a failed or redirected refresh preserves existing records and retries with backoff", async () => {
  const view = harness();
  view.setRead(async () => ({ ok: true, redirected: true, json: async () => { throw new Error("login page"); } }));
  for (const delay of [5000, 10000]) {
    view.tick();
    await flush();
    expect(view.overview.innerHTML).toBe("initial");
    expect(view.summary.textContent).toContain("状态更新失败");
    expect([...view.timers.values()].map((timer) => timer.delay)).toEqual([delay]);
  }
});
