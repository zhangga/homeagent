// With a fresh --health offline fixture, run node scripts/health-browser-flow.js <fixture-url> desktop|mobile [screenshot-directory].
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const [base, size, screenshotDirectory] = process.argv.slice(2);
assert.match(base || '', /^http:\/\/127\.0\.0\.1:\d+$/u);
assert.ok(size === 'desktop' || size === 'mobile');
if (screenshotDirectory) await mkdir(screenshotDirectory, { recursive: true });
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL });
try {
  const viewport = size === 'desktop' ? { width: 1440, height: 900 } : { width: 390, height: 844 };
  const page = await browser.newPage({ viewport, hasTouch: size === 'mobile' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const audit = async () => (await page.request.get(base + '/__fixture')).json();
  const start = await audit();
  assert.ok(start.offline && start.healthSample?.restarts === 0, 'Use a fresh offline health fixture');
  const healthy = page.locator('#health-healthy');
  const component = key => page.locator('[data-health-component="' + key + '"]');
  const heading = locator => locator.locator(':scope > summary');
  const fit = async () => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Horizontal overflow');
  const firstScreen = async locator => {
    const box = await locator.boundingBox();
    assert.ok(box && box.y >= 0 && box.y + box.height <= viewport.height, 'Expected the status or reason in the first viewport');
  };
  const capture = async scenario => {
    if (screenshotDirectory) await page.screenshot({ path: join(screenshotDirectory, 'health-' + scenario + '-' + size + '.png'), animations: 'disabled' });
  };
  for (const scenario of ['healthy', 'degraded', 'unready']) {
    assert.equal((await page.request.post(base + '/__fixture/health/' + scenario)).status(), 204);
    const readiness = await page.request.get(base + '/readyz');
    const snapshot = await readiness.json();
    assert.equal(readiness.status(), scenario === 'unready' ? 503 : 200);
    if (scenario === 'healthy') await page.goto(base + '/health');
    if (scenario === 'degraded') await page.locator('#health-overview').getByRole('link', { name: '刷新状态' }).click();
    if (scenario === 'unready') {
      await page.goto(base + '/reminders');
      const warning = page.locator('#runtime-health-alert');
      await warning.waitFor();
      await warning.getByRole('link', { name: '查看详情' }).click();
    }
    const overview = page.locator('#health-overview');
    assert.equal(await overview.getAttribute('data-ready'), String(snapshot.ready));
    assert.equal(await overview.getAttribute('data-status'), snapshot.status);
    assert.equal(await page.locator('#health-readiness').innerText(), snapshot.ready ? '服务可用' : '服务未就绪');
    assert.equal(await page.locator('#runtime-health-alert').count(), 0);
    await firstScreen(overview);
    assert.equal(await healthy.getAttribute('open'), null, 'Healthy components should start collapsed');
    const issues = Object.entries(snapshot.components).filter(([, record]) => record.status !== 'ok')
      .sort(([, a], [, b]) => Number(b.status === 'down') - Number(a.status === 'down'));
    const keys = await page.locator('#health-issues [data-health-component]').evaluateAll(nodes => nodes.map(el => el.dataset.healthComponent));
    assert.deepEqual(keys, issues.map(([key]) => key));
    for (const [key] of issues) await firstScreen(heading(component(key)));
    await fit();
    await capture(scenario);
    for (const [key, record] of issues) {
      const row = component(key);
      const summary = heading(row);
      assert.ok((await summary.innerText()).includes(record.summary), 'Missing reason for ' + key);
      if (key === 'feishu') {
        assert.equal(await summary.locator('strong').innerText(), '飞书事件监听');
        assert.equal(await summary.locator('.health-reason').innerText(), '飞书消息接收监听失败');
      }
      await summary.click();
      const raw = row.locator('details.health-raw');
      if (await raw.count()) await heading(raw).click();
      const diagnostic = row.locator('pre');
      const data = JSON.parse(await diagnostic.innerText());
      assert.deepEqual(data, record.details);
      if (key === 'feishu') assert.ok(data.consumers.some(c => c.key === 'im.message.receive_v1' && c.state === 'failed'));
      await fit();
      await summary.click();
    }
    const healthyRows = await healthy.locator('[data-health-component]').count();
    assert.equal(healthyRows, Object.keys(snapshot.components).length - issues.length);
    await heading(healthy).click();
    const knowledge = component('knowledge');
    await heading(knowledge).click();
    assert.equal(await knowledge.locator('pre').isVisible(), true);
    await fit();
    await heading(knowledge).click();
    await heading(healthy).click();

    if (scenario === 'healthy') {
      const dream = page.locator('#dream-runs');
      assert.equal(await dream.getByRole('heading', { name: '提炼任务' }).isVisible(), true);
      const dreamHistory = dream.locator('.dream-history');
      await heading(dreamHistory).click();
      const before = await dream.locator('[data-dream-run]').getAttribute('data-dream-run');
      const fragment = page.waitForResponse(response => response.url() === base + '/health/dream-runs');
      await dream.locator('[data-dream-refresh]').click();
      assert.equal((await fragment).status(), 200);
      assert.equal(await dreamHistory.getAttribute('open'), '');
      assert.equal(await dream.locator('[data-dream-run]').getAttribute('data-dream-run'), before);
      assert.equal((await (await page.request.get(base + '/api/dream-runs')).json()).runs[0].id, before);
      await heading(healthy).click();
      const service = component('service');
      await heading(service).click();
      const restart = service.getByRole('button', { name: '安全重启', exact: true });
      assert.equal(await restart.isVisible(), true);
      assert.match(await service.innerText(), /PID.*4208/u);
      const decision = page.waitForEvent('dialog').then(async dialog => {
        const message = dialog.message();
        await dialog.accept();
        assert.match(message, /重启/u);
      });
      await Promise.all([decision, restart.click()]);
      assert.match(await page.locator('main').innerText(), /已请求后台服务安全重启/u);
      assert.equal((await audit()).healthSample.restarts, 1);
    }
    if (scenario === 'unready') {
      assert.equal(await page.getByRole('button', { name: '安全重启', includeHidden: true }).count(), 0);
      assert.equal((await page.request.post(base + '/service/restart')).status(), 409);
      assert.equal((await audit()).healthSample.restarts, 1);
    }
  }
  const final = await audit();
  assert.equal(final.counters.model, 0);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ...viewport, snapshots: 3, healthyCollapsed: true, issueDetails: true,
    dreamHistoryRefreshed: true, simulatedRestarts: final.healthSample.restarts, horizontalOverflow: false }));
} finally { await browser.close(); }
