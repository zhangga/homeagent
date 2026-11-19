import { expect, test } from "bun:test";
import { chatRunLiveScript } from "./chat-run-live.ts";

class Node {
  children: Node[] = [];
  className = "";
  dataset: Record<string, string> = {};
  id = "";
  open = false;
  replaceWith?: (fresh: Node) => void;
  querySelectorAll = (): Node[] => [];
  contains = () => false;
  style = { display: "none" };
  parent?: Node;
  private text = "";
  get textContent(): string { return this.text; }
  set textContent(value: string) { this.text = value; this.children = []; }
  get firstElementChild(): Node | undefined { return this.children[0]; }
  get lastElementChild(): Node | undefined { return this.children.at(-1); }
  classList = { contains: (name: string) => this.className.split(" ").includes(name) };
  appendChild(child: Node): void { this.children.push(child); child.parent = this; }
  remove(): void { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); }
}

function harness(snapshot: unknown, finalSnapshot = snapshot) {
  const root = new Node();
  const list = new Node();
  const answer = new Node();
  const summary = new Node();
  const nodes = new Map([["live-run", root], ["live-run-events", list], ["live-run-answer", answer], ["live-run-summary", summary]]);
  const initialState = { status: "running", delivery: { status: "pending", attempts: 0 }, cancelRequested: false, deliveryActive: false };
  let state = initialState;
  function dataset() {
    return { runId: "test-run", runStatus: state.status, deliveryStatus: state.delivery.status,
      deliveryAttempts: String(state.delivery.attempts), cancelRequested: state.cancelRequested ? "1" : "0",
      deliveryActive: state.deliveryActive ? "1" : "0", terminal: ["queued", "running"].includes(state.status) ? "0" : "1" };
  }
  root.dataset = dataset();
  const sections = ["chat-run-overview", "chat-run-details"];
  function section(id: string) {
    const node = new Node();
    node.id = id;
    node.replaceWith = fresh => { nodes.set(id, fresh); };
    return node;
  }
  for (const id of sections) nodes.set(id, section(id));
  root.querySelectorAll = () => [...nodes.values()].filter(node => node.open);
  class Parser {
    parseFromString() {
      const next = new Node();
      next.dataset = dataset();
      return { getElementById: (id: string) => id === "live-run" ? next : section(id) };
    }
  }
  const streams: Stream[] = [];
  class Stream {
    onmessage?: (message: { data: string }) => void;
    closed = false;
    constructor(readonly url: string) { streams.push(this); }
    close(): void { this.closed = true; }
  }
  let reads = 0;
  const urls: string[] = [];
  const events = new Map<string, () => void>();
  const timers = new Map<number, () => Promise<void>>();
  let timerId = 0;
  const listen = (name: string, fn: () => void) => events.set(name, fn);
  const document = {
    getElementById: (id: string) => nodes.get(id),
    createElement: () => new Node(),
    hidden: false, activeElement: null, addEventListener: listen,
  };
  new Function("document", "window", "fetch", "EventSource", "DOMParser", "setTimeout", "clearTimeout", chatRunLiveScript())(
    document, { addEventListener: listen }, async (url: string) => {
      urls.push(url);
      return { ok: true, text: async () => "", json: async () => url.endsWith("/status") ? state : reads++ === 0 ? snapshot : finalSnapshot };
    }, Stream, Parser,
    (fn: () => Promise<void>) => { timers.set(++timerId, fn); return timerId; },
    (id: number) => timers.delete(id),
  );
  return { list, answer, summary, streams, root, document, nodes, urls, timers,
    setState: (next: typeof state) => { state = next; },
    visibility: () => events.get("visibilitychange")?.(),
    tick: async () => {
      const [id, fn] = [...timers][0]!;
      timers.delete(id);
      await fn();
    } };
}

async function flush(): Promise<void> { for (let index = 0; index < 10; index++) await Promise.resolve(); }
const note = (seq: number, delta: string) => ({ seq, kind: "assistant.snapshot", visibility: "public", delta });
const tool = (seq: number, kind = "tool.started", status = "running") => ({ seq, kind, visibility: "public", tool: { type: "web-search", status } });

test("snapshot and SSE retain interleaved notes/tools, resume by seq, and deduplicate the final answer", async () => {
  const view = harness({ run: { status: "running" }, events: [note(1, "先检查构建状态。"), tool(2)] }, {
    run: { status: "succeeded", output: "完成" + "完整回答".repeat(2_000) },
  });
  await flush();
  expect(view.list.children.map(node => node.textContent)).toEqual(["先检查构建状态。", "网络查询 · 执行中"]);
  expect(view.streams[0]?.url).toEndWith("after=2");
  const emit = (event: unknown) => view.streams[0]!.onmessage!({ data: JSON.stringify(event) });
  emit(tool(2)); // SSE replay after reconnect must not duplicate a step.
  emit(tool(3, "tool.completed", "completed"));
  emit(note(4, "构建成功，开始更新环境。"));
  emit(note(5, "构建成功，开始更新环境。"));
  emit(note(6, "完成"));
  emit({ seq: 7, kind: "run.succeeded", title: "执行完成", delta: "完成" });
  await flush();
  expect(view.list.children.map(node => node.textContent)).toEqual([
    "先检查构建状态。", "网络查询 · 执行中", "网络查询 · 已完成", "构建成功，开始更新环境。", "执行完成",
  ]);
  expect(view.answer.textContent).toBe("完成" + "完整回答".repeat(2_000));
  expect(view.summary.textContent).toBe("已完成 · 已调用 1 次工具");
  expect(view.streams[0]?.closed).toBeTrue();
});

test("reopens a failed run honestly and renders untrusted public text without HTML", async () => {
  const view = harness({ run: { status: "failed" }, events: [
    note(1, "<img src=x onerror=alert(1)>"),
    { ...note(2, "PRIVATE_TEXT"), visibility: "operator" },
    tool(3, "tool.completed", "failed"),
    { seq: 4, kind: "run.failed", title: "执行失败" },
    { seq: 5, kind: "delivery.updated", title: "已送达" },
  ] });
  await flush();
  expect(view.list.children[0]?.textContent).toBe("<img src=x onerror=alert(1)>");
  expect(view.list.children.map(node => node.textContent).join(" ")).not.toContain("PRIVATE_TEXT");
  expect(view.list.children[1]?.className).toContain("run-tool-failed");
  expect(view.summary.textContent).toBe("执行失败 · 已调用 1 次工具");
  expect(view.streams).toHaveLength(0);
});

test("legacy runs without events retain the answer and explain missing progress", async () => {
  const view = harness({ run: { status: "succeeded", output: "旧版完整回答" }, events: [] });
  await flush();
  expect(view.list.children[0]?.textContent).toBe("这次运行尚无公开过程记录。");
  expect(view.answer.textContent).toBe("旧版完整回答");
  expect(view.summary.textContent).toBe("已完成");
  expect(view.streams).toHaveLength(0);
});

test("retains a Provider reasoning summary even when its text is also the final answer", async () => {
  const view = harness({ run: { status: "succeeded", output: "相同文字" }, events: [
    { ...note(1, "相同文字"), phase: "provider", title: "思考摘要" },
    { seq: 2, kind: "run.succeeded", title: "执行完成", delta: "相同文字" },
  ] });
  await flush();
  expect(view.list.children[0]?.textContent).toBe("相同文字");
  expect(view.list.children[0]?.className).toContain("run-summary");
  expect(view.answer.textContent).toBe("相同文字");
});

test("a model caption does not leave the final assistant text duplicated in the process", async () => {
  const output = "> 本次模型：Codex · `gpt-5.6-sol`（本次运行配置）\n> 推理等级：高\n\n完成更新。";
  const view = harness({ run: { status: "succeeded", output }, events: [
    note(1, "先核对构建。"), tool(2), tool(3, "tool.completed", "completed"), note(4, "完成更新。"),
    { seq: 5, kind: "phase.started", title: "会话模型已确认" },
    { seq: 6, kind: "run.succeeded", title: "执行完成", delta: output },
  ] });
  await flush();
  expect(view.answer.textContent).toBe("完成更新。");
  expect(view.list.children.map(node => node.textContent)).not.toContain("完成更新。");
  expect(view.list.children[0]?.textContent).toBe("先核对构建。");
});

test("an open Run follows completion and delayed delivery while preserving expanded details", async () => {
  const view = harness({ run: { status: "running" }, events: [] }, { run: { status: "succeeded", output: "完整回答" }, events: [] });
  await flush();
  view.nodes.get("chat-run-details")!.open = true;
  const timeline = view.nodes.get("live-run-events");
  const change = async (status: string, delivery: string, attempts: number, cancelRequested = false, deliveryActive = false) => {
    view.setState({ status, delivery: { status: delivery, attempts }, cancelRequested, deliveryActive });
    await view.tick();
    expect(view.root.dataset).toMatchObject({ runStatus: status, deliveryStatus: delivery, deliveryAttempts: String(attempts),
      cancelRequested: cancelRequested ? "1" : "0", deliveryActive: deliveryActive ? "1" : "0" });
    expect(view.nodes.get("chat-run-details")!.open).toBe(true);
    expect(view.nodes.get("live-run-events")).toBe(timeline);
  };
  await change("succeeded", "pending", 1, false, true);
  await change("succeeded", "failed", 1);
  view.document.hidden = true;
  view.visibility();
  expect(view.timers.size).toBe(0);
  view.document.hidden = false;
  view.visibility();
  await change("succeeded", "pending", 2, false, true);
  await change("succeeded", "sent", 2);
  expect(view.timers.size).toBe(0);
  expect(view.answer.textContent).toBe("完整回答");
  expect(view.urls.filter(url => url === "/chats/runs/test-run")).toHaveLength(4);
});

test("a missed terminal event still retires the cancellation controls using the saved Run", async () => {
  const view = harness({ run: { status: "running" }, events: [] }, { run: { status: "cancelled" }, events: [] });
  await flush();
  view.setState({ status: "running", delivery: { status: "pending", attempts: 0 }, cancelRequested: true, deliveryActive: false });
  await view.tick();
  expect(view.root.dataset.cancelRequested).toBe("1");
  view.setState({ status: "cancelled", delivery: { status: "pending", attempts: 0 }, cancelRequested: true, deliveryActive: false });
  await view.tick();
  expect(view.root.dataset).toMatchObject({ runStatus: "cancelled", terminal: "1" });
  expect(view.streams[0]!.closed).toBe(true);
  expect(view.summary.textContent).toBe("已取消");
});
