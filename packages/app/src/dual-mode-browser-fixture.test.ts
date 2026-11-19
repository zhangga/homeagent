import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { startDualModeBrowserFixture } from "./dual-mode-browser-fixture.ts";

test("offline browser acceptance serves the real management routes without running local providers", async () => {
  const fixture = await startDualModeBrowserFixture();
  try {
    const page = await fetch(`${fixture.url}/agents/${fixture.agentId}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("当前配置待检测");
    const readiness = await fetch(`${fixture.url}/agents/${fixture.agentId}/readiness`);
    expect(await readiness.json()).toMatchObject({ state: "unknown", modelCall: "not-verified" });
    const audit = await (await fetch(`${fixture.url}/__fixture`)).json();
    expect(audit).toMatchObject({ offline: true, counters: { model: 0, preparation: 0, sandboxSetup: 0, login: 0 } });
    expect(existsSync(fixture.root)).toBe(true);
  } finally { await fixture.close(); }
  expect(existsSync(fixture.root)).toBe(false);
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
