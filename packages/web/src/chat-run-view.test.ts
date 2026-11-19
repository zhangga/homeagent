import { describe, expect, test } from "bun:test";
import type { ChatRun } from "@homeagent/core";
import { chatRunView } from "./views.ts";

const run: ChatRun = {
  id: "chat_demo", space: "team/oc_demo", input: "请确认这周交付了什么？", output: "已发布空间管理。",
  trigger: "message", priority: "interactive", status: "succeeded",
  delivery: { status: "sent", attempts: 1, lastAttemptAt: 12 },
  queuedAt: 1, startedAt: 1, runStartedAt: 2, finishedAt: 10,
};

async function render(record: ChatRun, deliveryActive = false) {
  const body = String(await chatRunView(record, undefined, undefined, [], undefined, deliveryActive));
  const overview = body.indexOf('<section class="card" id="chat-run-overview"');
  const process = body.indexOf('<details class="card" id="chat-run-process"');
  const details = body.indexOf('<details class="card" id="chat-run-details"');
  expect(overview).toBeGreaterThan(-1);
  expect(process).toBeGreaterThan(overview);
  expect(details).toBeGreaterThan(process);
  expect(body).toContain('<details class="card" id="chat-run-process">');
  expect(body).toContain('<details class="card" id="chat-run-details">');
  return { root: body.slice(0, overview), main: body.slice(overview, process), diagnostics: body.slice(details, body.indexOf("<script>", details)) };
}

describe("chat detail", () => {
  test("the first card shows the exchange and actual Feishu delivery, with frozen diagnostics and evaluation under details", async () => {
    const caption = "> 本次模型：Codex · 已验证\n> 推理等级：high\n\n";
    const { main, diagnostics } = await render({ ...run, provider: "codex", model: "frozen-model",
      output: caption + run.output, rawId: "raw_result", retryOf: "chat_before",
      traceId: "trace_1", executionPlan: { version: 1, instruction: "原指令", provider: "codex" } });
    expect(main).toContain(run.input);
    expect(main).toContain('<div id="live-run-answer">已发布空间管理。</div>');
    expect(main).toContain('id="chat-run-status">已完成');
    expect(main).toContain("已发送");
    expect(main).not.toContain("本次模型");
    expect(main).not.toContain("推理等级");
    expect(main).not.toContain("冻结权限");
    expect(main).not.toContain("/retry");
    expect(diagnostics).toContain("本次模型：Codex · 已验证");
    expect(diagnostics).toContain("推理等级：high");
    expect(diagnostics).toContain("frozen-model");
    expect(diagnostics).toContain("未记录执行证据");
    expect(diagnostics).toContain('href="/spaces/team%2Foc_demo/raw/raw_result"');
    expect(diagnostics).toContain('href="/chats/runs/chat_before"');
    expect(diagnostics).toContain('action="/chats/runs/chat_demo/evaluate"');
  });

  test("retrying delivery uses the existing answer and only a current send is in progress", async () => {
    const failed: ChatRun = { ...run, delivery: { status: "failed", attempts: 2, error: "飞书连接暂不可用" } };
    const { main } = await render(failed);
    expect(main).toContain("发送失败");
    expect(main).toContain("飞书连接暂不可用");
    expect(main).toContain('action="/chats/runs/chat_demo/retry"');
    expect(main).toContain("重试投递");
    expect(main).not.toContain("重试文本回答");
    expect(main.indexOf("重试投递")).toBeLessThan(main.indexOf(run.output!));
    const diagnostic = "连接中断。".repeat(250) + "请稍后重试。";
    const longError = await render({ ...failed, delivery: { ...failed.delivery, error: diagnostic } });
    expect(longError.main).toContain('<details id="chat-run-full-delivery-error">');
    expect(longError.main).toContain(diagnostic);
    expect(longError.main.slice(longError.main.indexOf("</details>"))).toContain("重试投递");
    const pending: ChatRun = { ...run, delivery: { status: "pending", attempts: 1 } };
    const active = await render(pending, true);
    expect(active.root).toContain('data-delivery-active="1"');
    expect(active.main).toContain("发送中");
    expect(active.main).not.toContain("/retry");
    const saved = await render(pending);
    expect(saved.main).toContain("结果待确认");
    expect(saved.main).toContain("重试投递");
  });

  test("queued, active, cancellation requested and terminal states keep the matching action", async () => {
    const base: ChatRun = { ...run, delivery: { status: "pending", attempts: 0 }, output: undefined, finishedAt: undefined };
    for (const status of ["queued", "running"] as const) {
      const { main } = await render({ ...base, status });
      expect(main).toContain(status === "queued" ? "排队中" : "运行中");
      expect(main).toContain('action="/chats/runs/chat_demo/cancel"');
      expect(main).not.toContain("/retry");
    }
    const stopping = await render({ ...base, status: "running", cancelRequestedAt: 9 });
    expect(stopping.root).toContain('data-cancel-requested="1"');
    expect(stopping.main).toContain("正在取消");
    expect(stopping.main).not.toContain("/cancel");
    for (const [status, label] of [["cancelled", "已取消"], ["failed", "执行失败"], ["timed_out", "已超时"]] as const) {
      const { main } = await render({ ...base, status });
      expect(main).toContain(`id="chat-run-status">${label}`);
      expect(main).toContain("未发送");
      expect(main).toContain("重试文本回答");
      expect(main).not.toContain("/cancel");
      expect(main).not.toContain("重试投递");
    }
  });

  test("long and multiline questions keep their complete text behind a short preview", async () => {
    const input = "🔎".repeat(120) + "\n末尾核验 <tag>";
    const { main } = await render({ ...run, input, inputTruncated: true, outputTruncated: true });
    expect(main).toContain('<details id="chat-run-full-question">');
    const preview = main.slice(main.indexOf("<summary>"), main.indexOf("</summary>"));
    expect(preview).toContain("🔎".repeat(90));
    expect(preview).not.toContain("末尾核验");
    expect(main).toContain("末尾核验 &lt;tag&gt;");
    expect(main).toContain("输入过长");
    expect(main).toContain("输出过长");
    expect(main).toContain(run.output!);
    expect((await render({ ...run, input: "📚".repeat(80) })).main).not.toContain('<details id="chat-run-full-question">');
    expect((await render({ ...run, input: "a\nb\nc\nd" })).main).toContain('<details id="chat-run-full-question">');
  });
});
