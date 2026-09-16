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
