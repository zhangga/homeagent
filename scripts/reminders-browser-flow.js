// Start a fresh "bun run packages/app/src/dual-mode-browser-fixture.ts --reminders" for each width.
// node scripts/reminders-browser-flow.js http://127.0.0.1:<port> desktop|mobile [screenshot-directory]
// PLAYWRIGHT_MODULE may point at an existing Playwright installation; PLAYWRIGHT_CHANNEL can select msedge or chrome.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const [base, size, screenshotDirectory] = process.argv.slice(2);
assert.match(base || '', /^http:\/\/127\.0\.0\.1:\d+$/u);
assert.ok(size === 'desktop' || size === 'mobile', 'Select desktop or mobile');
if (screenshotDirectory) await mkdir(screenshotDirectory, { recursive: true });
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL });

async function exercise(viewport) {
  const context = await browser.newContext({ viewport, hasTouch: size === 'mobile' });
  try {
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    const url = base + '/reminders';
    const samples = async () => {
      const audit = await (await page.request.get(base + '/__fixture')).json();
      assert.ok(audit.offline && Array.isArray(audit.reminderSamples), 'Use an offline reminder fixture');
      return audit.reminderSamples;
    };
    const capture = async stage => {
      if (screenshotDirectory) await page.screenshot({ path: join(screenshotDirectory, 'reminders-' + stage + '-' + size + '.png'), animations: 'disabled' });
    };
    const upcoming = page.locator('#reminders-upcoming');
    const history = page.locator('#reminders-history');
    const row = (item, tab = page) => tab.locator('li[data-reminder-id="' + item.id + '"]');
    const titles = section => section.locator('.reminder-title').allTextContents();
    const time = async (item, kind, stamp) => {
      const entry = row(item).locator('[data-reminder-time="' + kind + '"]');
      assert.equal(await entry.getAttribute('datetime'), new Date(stamp).toISOString());
      assert.ok((await entry.innerText()).trim(), 'Each timestamp must be readable');
    };
    const cancel = async (tab, item, proceed) => {
      const confirmation = tab.waitForEvent('dialog', { timeout: 5000 }).then(async dialog => {
        const message = dialog.message();
        const type = dialog.type();
        if (proceed) await dialog.accept(); else await dialog.dismiss();
        assert.equal(type, 'confirm');
        assert.match(message, /取消.*提醒/u);
      });
      await Promise.all([confirmation, row(item, tab).getByRole('button', { name: '取消提醒', exact: true }).click()]);
    };
    await page.goto(url);
    const data = await samples();
    const [repeat, afternoon, later] = data.filter(item => item.status === 'scheduled');
    assert.ok(later.createdAt < repeat.createdAt && later.triggerAt < repeat.triggerAt && later.nextTriggerAt > repeat.nextTriggerAt);
    assert.deepEqual(await titles(upcoming), [repeat.title, afternoon.title, later.title]);
    assert.equal(await history.getAttribute('open'), null);
    assert.equal(await row(data.find(item => item.status === 'cancelled')).isVisible(), false);
    for (const item of [repeat, afternoon, later]) await time(item, 'next', item.nextTriggerAt);
    assert.match(await row(repeat).innerText(), /直到确认/u);
    assert.match(await row(repeat).innerText(), /90\s*分钟|1\s*小时\s*30\s*分钟/u);
    const dimensions = await upcoming.locator('li[data-reminder-id]').evaluateAll(rows => rows.flatMap(row =>
      [...row.querySelectorAll('.reminder-title,[data-reminder-time="next"],button')].map(node => {
        const r = node.getBoundingClientRect();
        return { left: r.left, right: r.right, touchHeight: node.tagName === 'BUTTON' ? r.height : undefined, viewport: innerWidth };
      })));
    assert.ok(dimensions.every(r => r.left >= 0 && r.right <= r.viewport), 'Titles, times and buttons fit horizontally');
    if (size === 'mobile') assert.ok(dimensions.filter(r => r.touchHeight !== undefined).every(r => r.touchHeight >= 44));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await capture('upcoming');

    await history.locator(':scope > summary').click();
    const existing = data.filter(item => item.status !== 'scheduled').sort((a, b) =>
      (b.completedAt ?? b.cancelledAt) - (a.completedAt ?? a.cancelledAt));
    assert.deepEqual(await titles(history), existing.map(item => item.title));
    for (const item of existing) {
      await time(item, item.status, item.completedAt ?? item.cancelledAt);
      assert.equal(await row(item).locator('button').count(), 0);
    }
    await history.locator(':scope > summary').click();
    const meta = row(repeat).locator('details.reminder-meta');
    await meta.locator('summary').click();
    for (const field of [repeat.id, repeat.creatorId, repeat.space]) assert.ok((await meta.innerText()).includes(field), field);
    await meta.locator('summary').click();

    const stale = await context.newPage();
    await stale.goto(url);
    await page.bringToFront();
    await row(repeat).getByRole('button', { name: '标记完成', exact: true }).click();
    assert.equal(await row(repeat).getAttribute('data-reminder-status'), 'completed');
    // Browser back must not resurrect controls from the pre-submission response.
    await page.goBack();
    await page.locator('[data-reminder-id="' + repeat.id + '"][data-reminder-status="completed"]').waitFor({ state: 'attached', timeout: 5000 });
    assert.equal(await upcoming.locator('[data-reminder-id="' + repeat.id + '"]').count(), 0);
    await stale.bringToFront();
    await cancel(stale, repeat, true);
    assert.ok((await stale.locator('main').innerText()).includes('这条提醒已经完成'));
    await stale.close();
    await page.bringToFront();

    const cancelPosts = [];
    page.on('request', request => {
      if (request.method() === 'POST' && request.url().endsWith('/cancel')) cancelPosts.push(request.url());
    });
    await cancel(page, later, false);
    assert.equal(await row(later).getAttribute('data-reminder-status'), 'scheduled');
    assert.equal(cancelPosts.length, 0, 'Dismissing confirmation must not submit');
    await cancel(page, later, true);
    assert.equal(cancelPosts.length, 1);
    assert.equal(await row(later).getAttribute('data-reminder-status'), 'cancelled');
    await page.goBack();
    await page.locator('[data-reminder-id="' + later.id + '"][data-reminder-status="cancelled"]').waitFor({ state: 'attached', timeout: 5000 });
    assert.deepEqual(await titles(upcoming), [afternoon.title]);
    assert.equal(await history.getAttribute('open'), null);
    await history.locator(':scope > summary').click();
    const updated = await samples();
    const handled = updated.filter(item => item.status !== 'scheduled').sort((a, b) =>
      (b.completedAt ?? b.cancelledAt) - (a.completedAt ?? a.cancelledAt));
    assert.deepEqual(await titles(history), handled.map(item => item.title));
    for (const item of handled) await time(item, item.status, item.completedAt ?? item.cancelledAt);
    assert.doesNotMatch(await row(repeat).innerText(), /直到确认/u, 'Completed reminders should not look as if they will repeat');
    const historyMeta = row(repeat).locator('details.reminder-meta');
    await historyMeta.locator('summary').click();
    assert.match(await historyMeta.innerText(), /原重复规则/u);
    assert.match(await historyMeta.innerText(), /90\s*分钟[\s\S]*直到确认/u);
    await time(repeat, 'previous', repeat.nextTriggerAt);
    await historyMeta.locator('summary').click();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.evaluate(() => window.scrollTo(0, 0));
    await capture('history');
    assert.deepEqual(pageErrors, []);
    console.log(JSON.stringify({ ...viewport, upcomingSorted: true, nativeConfirmDismissedThenAccepted: true,
      historyTimes: handled.length, staleTab: true, browserBackAfterBothActions: true, horizontalOverflow: false }));
  } finally {
    await context.close();
  }
}

try {
  await exercise(size === 'desktop' ? { width: 1440, height: 900 } : { width: 390, height: 844 });
} finally { await browser.close(); }
