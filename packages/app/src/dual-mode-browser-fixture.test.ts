import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { startDualModeBrowserFixture } from "./dual-mode-browser-fixture.ts";

test("offline browser acceptance serves the real management routes without running local providers", async () => {
  const fixture = await startDualModeBrowserFixture();
  try {
    const page = await fetch(`${fixture.url}/agents/${fixture.agentId}`);
    expect(page.status).toBe(200);
    const overview = await page.text();
    expect(overview).toContain("配置待检测");
    expect(overview).toContain(`href="/agents/${fixture.agentId}?edit=1"`);
    expect(overview).not.toContain('id="agent-editor-form"');
    const edit = await fetch(`${fixture.url}/agents/${fixture.agentId}?edit=1`);
    expect(edit.status).toBe(200);
    expect(await edit.text()).toContain("当前配置待检测");
    const readiness = await fetch(`${fixture.url}/agents/${fixture.agentId}/readiness`);
    expect(await readiness.json()).toMatchObject({ state: "unknown", modelCall: "not-verified" });
    const audit = await (await fetch(`${fixture.url}/__fixture`)).json();
    expect(audit).toMatchObject({ offline: true, counters: { model: 0, preparation: 0, sandboxSetup: 0, login: 0 } });
    expect(existsSync(fixture.root)).toBe(true);
  } finally { await fixture.close(); }
  expect(existsSync(fixture.root)).toBe(false);
});

test("research acceptance exposes isolated read-only and approval tasks only in task mode", async () => {
  const fixture = await startDualModeBrowserFixture({ researchTasks: true });
  try {
    const list = await (await fetch(`${fixture.url}/tasks`)).text();
    expect(list).toContain("产品研究周报");
    expect(list).toContain("样本完整性检查");
    expect(list).toContain("发布校对");
    const audit = await (await fetch(`${fixture.url}/__fixture`)).json();
    expect(audit).toMatchObject({ offline: true, researchTasks: true, counters: { model: 0, simulatedResearch: 0 } });
  } finally { await fixture.close(); }
});

test("work acceptance seeds an unapproved run, a review, a blocked action and a still-running action", async () => {
  const fixture = await startDualModeBrowserFixture({ workItems: true });
  try {
    const list = await (await fetch(`${fixture.url}/work`)).text();
    for (const title of ["复核上线清单", "更新值班手册", "核验交付样本", "整理用户访谈"]) {
      expect(list).toContain(title);
    }
    for (const status of ["awaiting_acceptance", "awaiting_approval", "blocked", "running"]) {
      expect(list).toContain(`data-work-state="${status}"`);
    }
    const audit = await (await fetch(`${fixture.url}/__fixture`)).json();
    expect(audit).toMatchObject({ workItems: true, counters: { model: 0, simulatedWork: 3 } });
  } finally { await fixture.close(); }
  expect(existsSync(fixture.root)).toBe(false);
});

test("the chat fixture holds answer and delivery independently and retries only the failed send", async () => {
  const fixture = await startDualModeBrowserFixture({ chatRuns: true });
  try {
    const control = (action: string) => fetch(`${fixture.url}/__fixture/chats/${action}`, { method: "POST" });
    const sample = await (await control("answer")).json();
    if (!sample || typeof sample !== "object" || !("id" in sample) || typeof sample.id !== "string") throw new Error("Missing sample run");
    const id = sample.id;
    const snapshot = async () => (await fetch(`${fixture.url}/api/chats/runs/${id}/snapshot`)).json();
    expect(await snapshot()).toMatchObject({ run: { status: "running" } });
    await control("finish-answer");
    expect(await snapshot()).toMatchObject({ run: { status: "succeeded", delivery: { status: "pending" } } });
    await control("fail-delivery");
    expect(await snapshot()).toMatchObject({ run: { delivery: { status: "failed" } } });
    const retry = await fetch(`${fixture.url}/chats/runs/${id}/retry`, { method: "POST", redirect: "manual" });
    expect(retry.headers.get("location")).toStartWith(`/chats/runs/${id}?`);
    expect(await snapshot()).toMatchObject({ run: { delivery: { status: "sent" } } });
    const audit = await (await fetch(`${fixture.url}/__fixture`)).json();
    expect(audit).toMatchObject({ chatCalls: { answer: 1, cancel: 0, failure: 0, answerDelivery: 2 }, counters: { model: 0 } });
  } finally { await fixture.close(); }
});

test("the reminder fixture includes a postponed reminder, an active repeat and two distinct historical outcomes", async () => {
  const fixture = await startDualModeBrowserFixture({ reminders: true });
  try {
    const result = await (await fetch(`${fixture.url}/__fixture`)).json();
    expect(result).toMatchObject({ counters: { model: 0 }, reminderSamples: [
      { title: "预订周会会议室", status: "cancelled", cancelledAt: expect.any(Number) },
      { title: "归档上次发布的验收记录", status: "completed", completedAt: expect.any(Number) },
      { title: "确认值班交接清单", status: "scheduled", untilConfirmed: true, repeatEveryMs: 90 * 60_000, lastNotifiedAt: expect.any(Number) },
      { title: "把设计评审材料发给项目组", status: "scheduled" }, { title: "跟进供应商的替代报价", status: "scheduled" },
    ] });
  } finally { await fixture.close(); }
});

test("offline health sources exercise the real readiness calculation and simulate managed restart", async () => {
  const fixture = await startDualModeBrowserFixture({ systemHealth: true });
  try {
    const probe = () => fetch(fixture.url + "/readyz");
    const select = (scenario: string) => fetch(fixture.url + "/__fixture/health/" + scenario, { method: "POST" });
    const restart = () => fetch(fixture.url + "/service/restart", { method: "POST", redirect: "manual" });
    expect(await (await probe()).json()).toMatchObject({ ready: true, status: "ok" });
    expect((await restart()).status).toBe(302);
    await select("degraded");
    const degraded = await probe();
    expect(degraded.status).toBe(200);
    expect(await degraded.json()).toMatchObject({ ready: true, status: "degraded", components: { dreamScheduler: { status: "degraded" } } });
    await select("unready");
    const down = await probe();
    expect(down.status).toBe(503);
    expect(await down.json()).toMatchObject({ ready: false, status: "down", components: { providers: { status: "down" }, feishu: { status: "down" } } });
    expect((await restart()).status).toBe(409);
    expect(await (await fetch(fixture.url + "/api/dream-runs")).json()).toMatchObject({ runs: [{ status: "completed" }] });
    expect(await (await fetch(fixture.url + "/__fixture")).json()).toMatchObject({ healthSample: { restarts: 1 }, counters: { model: 0 } });
  } finally { await fixture.close(); }
});
