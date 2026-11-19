import { expect, test } from "bun:test";
import type { SystemHealthSnapshot } from "@homeagent/shared";
import { healthView } from "./views.ts";

const checkedAt = Date.UTC(2026, 10, 19, 1, 0);

test("health leads with readiness and puts each issue's reason in its disclosure before healthy components and Dream runs", async () => {
  const snapshot: SystemHealthSnapshot = { checkedAt, status: "down", ready: true, components: {
    reminders: { status: "ok", summary: "今天有 3 个待提醒" },
    aiRuntime: { status: "degraded", summary: "12 个消息事件尚未处理完", details: { pending: 12 } },
    healthReporter: { status: "down", summary: "检查 <来源> 失败", details: { code: "<诊断记录>" } },
    otherProbe: { status: "degraded", summary: "暂时没有进一步诊断" },
  } };
  const page = String(await healthView(snapshot));
  expect(page).toContain('id="health-readiness">服务可用</h2>');
  expect(page).toContain('href="/health">刷新状态</a>');
  expect([...page.matchAll(/data-health-component="([^"]+)"/gu)].map(match => match[1]))
    .toEqual(["healthReporter", "aiRuntime", "otherProbe", "reminders"]);
  const issue = page.match(/<details\b[^>]*data-health-component="healthReporter"[^>]*>([\s\S]*?)<\/details>/u)?.[1];
  expect(issue?.split("</summary>")[0]).toContain("检查 &lt;来源&gt; 失败");
  expect(issue?.split("</summary>")[0]).not.toContain("诊断记录");
  expect(issue).toContain("&lt;诊断记录&gt;");
  expect(page).toContain("otherProbe");
  const normal = page.match(/<details\b[^>]*\bid="health-healthy"[^>]*>/u)?.[0];
  expect(normal).toBeDefined();
  expect(normal).not.toMatch(/\sopen\b/u);
  expect(page.indexOf('id="health-issues"')).toBeLessThan(page.indexOf('id="health-healthy"'));
  expect(page.indexOf('id="health-healthy"')).toBeLessThan(page.indexOf('<section id="dream-runs"'));
});

test("readiness can fail with only degraded components; missing components do not become a clean bill of health", async () => {
  const page = String(await healthView({ checkedAt, status: "down", ready: false, components: {
    taskScheduler: { status: "degraded", summary: "上次检查失败，本轮仍在运行" },
  } }));
  expect(page).toContain('id="health-readiness">服务未就绪</h2>');
  expect(page).toContain("上次检查失败，本轮仍在运行");
  expect(page).not.toContain('id="health-healthy"');
  const empty = String(await healthView({ checkedAt, status: "down", ready: false, components: {} }));
  expect(empty).toContain("未返回组件状态");
});
