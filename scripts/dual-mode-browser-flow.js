// Run with playwright-cli run-code --filename=scripts/dual-mode-browser-flow.js
// Only accepts a fresh offline fixture, never a production HomeAgent instance.
async page => {
  const base = await page.evaluate(() => location.origin);
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) throw new Error('Expected loopback fixture');
  const audit = async () => {
    const response = await page.request.get(base + '/__fixture');
    const result = await response.json();
    if (!response.ok() || result.offline !== true) throw new Error('Not an offline fixture');
    return result;
  };
  const verify = (condition, message) => { if (!condition) throw new Error(message); };
  const submit = async button => {
    await button.click();
    await page.waitForLoadState('domcontentloaded');
  };
  const errors = [];
  const onError = error => errors.push(error.message);
  page.on('pageerror', onError);
  const initial = await audit();
  verify(initial.grants === 0 && initial.counters.preparation === 0, 'Start a fresh fixture before running acceptance');
  await page.setViewportSize({ width: 1600, height: 1100 });
  const card = page.locator('[data-agent-readiness]');
  verify(await card.getAttribute('data-agent-readiness') === 'unknown', 'GET must not probe');
  await submit(page.getByRole('button', { name: '检测当前发布配置', exact: true }));
  verify(await card.getAttribute('data-agent-readiness') === 'unavailable', 'Isolated failure must be visible');
  verify((await card.innerText()).includes('根目录拒绝规则未通过验证'), 'Show fixed isolation reason');
  await page.locator('#agent-execution-mode').selectOption('local-full-access');
  verify(await page.locator('#agent-permission').inputValue() === 'full', 'Full intent sets matching permission');
  verify(await page.locator('button[name="agentAction"][value="publish"]').innerText() === '继续：确认发布', 'Mode change must update the publish action label');
  await submit(page.getByRole('button', { name: '保存草稿', exact: true }));
  verify((await audit()).grants === 0 && (await audit()).mode === 'isolated', 'Draft must not publish or authorize');
  verify((await card.innerText()).includes('隔离模式'), 'Readiness must still describe the published mode');
  const stale = await page.context().newPage();
  await stale.goto(page.url(), { waitUntil: 'domcontentloaded' });
  await submit(page.getByRole('button', { name: '继续：确认发布', exact: true }));
  verify(page.url().includes('/local-execution'), 'Publication must enter a separate confirmation page');
  verify((await page.locator('body').innerText()).includes('离线验收群（未连接飞书）'), 'Confirmation must show actual scope');
  verify(!await page.locator('[name="confirmFullAccess"]').isChecked(), 'Risk acknowledgement must not be preselected');
  verify(!await page.locator('[name="taskExecutionEnabled"]').isChecked(), 'Task authorization must not be preselected');
  const confirmationUrl = page.url();
  await page.getByRole('button', { name: '确认并发布新版本', exact: true }).click();
  verify(page.url() === confirmationUrl && (await audit()).grants === 0, 'Browser validation must block unchecked acknowledgement');
  await page.locator('[name="confirmFullAccess"]').check();
  const confirmRequest = page.waitForRequest(request => request.method() === 'POST' && request.url().includes('/local-execution'));
  await submit(page.getByRole('button', { name: '确认并发布新版本', exact: true }));
  verify((await (await confirmRequest).allHeaders()).origin === base, 'Same-origin confirmation must retain a verifiable Origin');
  verify((await audit()).activeGrants === 1 && !(await audit()).taskEnabled, 'Confirmation authorizes Chat but not Task');
  verify(await card.getAttribute('data-agent-readiness') === 'unknown', 'New revision invalidates old isolation result');
  const staleResponse = stale.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/readiness'));
  await stale.getByRole('button', { name: '检测当前发布配置', exact: true }).click();
  verify((await staleResponse).status() === 409, 'Stale published revision must be rejected');
  await stale.close();
  await submit(page.getByRole('button', { name: '检测当前发布配置', exact: true }));
  verify(await card.getAttribute('data-agent-readiness') === 'ready', 'Full fake preflight should pass');
  verify((await card.innerText()).includes('未隔离') && (await card.innerText()).includes('实际模型调用未验证'), 'Do not claim sandbox or model verification');
  const beforeRecovery = await audit();
  await submit(page.getByRole('button', { name: '重新检测 CLI 连接', exact: true }));
  const afterRecovery = await audit();
  verify(afterRecovery.counters.isolationDetection === beforeRecovery.counters.isolationDetection && afterRecovery.counters.sandboxSetup === 0, 'Full recovery must not request sandbox detection or setup');
  verify(await card.getAttribute('data-agent-readiness') === 'unknown', 'CLI recovery invalidates cached Agent preparation');
  // The CLI yields on native modals even with a Playwright dialog listener.
  // Stub only this test page's confirm decision; the checkbox consent above is real.
  await page.evaluate(() => {
    window.confirm = message => {
      if (!message.startsWith('撤销此 Agent 全部版本')) throw new Error('Unexpected confirmation');
      return true;
    };
  });
  await submit(page.getByRole('button', { name: '撤销完全访问', exact: true }));
  verify((await audit()).activeGrants === 0, 'Revoke must remove current authorization');
  verify(await card.getAttribute('data-agent-readiness') === 'unavailable', 'Revocation must be visible immediately');
  const beforeRevokedCheck = (await audit()).counters.preparation;
  await submit(page.getByRole('button', { name: '检测当前发布配置', exact: true }));
  verify((await audit()).counters.preparation === beforeRevokedCheck, 'Revoked configuration cannot invoke preflight');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '详情', exact: true }).click();
  verify(await page.locator('#agent-execution-mode').isVisible(), 'Mobile inspector must expose execution mode');
  await page.locator('#agent-execution-mode').selectOption('isolated');
  verify(await page.locator('#agent-permission').inputValue() === '', 'Switching back must require an explicit restricted permission');
  verify(!await page.locator('#agent-permission').evaluate(element => element.checkValidity()), 'Missing permission must block submit');
  verify(await page.locator('button[name="agentAction"][value="publish"]').innerText() === '发布', 'Switching back restores publish label');
  await page.locator('#agent-permission').selectOption('write');
  await page.locator('#agent-inspector').getByRole('button', { name: '关闭详情', exact: true }).click();
  await submit(page.getByRole('button', { name: '发布', exact: true }));
  await page.getByRole('button', { name: '详情', exact: true }).click();
  verify(await page.locator('#agent-permission').inputValue() === 'write', 'Published restricted permission must remain explicit');
  await submit(page.getByRole('button', { name: '检测当前发布配置', exact: true }));
  verify(await card.getAttribute('data-agent-readiness') === 'unavailable', 'Switching back must recheck isolation, not reuse full readiness');
  const final = await audit();
  verify(final.mode === 'isolated' && final.activeGrants === 0 && final.counters.model === 0 && final.counters.login === 0 && final.counters.sandboxSetup === 0, 'Offline acceptance must leave no full grant or real calls');
  verify(final.counters.isolatedPreparation === 2 && final.counters.fullPreparation === 1, 'Each requested mode follows its own preparation boundary');
  verify(errors.length === 0, 'Browser JavaScript must not throw');
  page.off('pageerror', onError);
  return { offline: true, desktopAndMobile: true, draftConsentReadinessRevoke: true, staleRevisionRejected: true, counters: final.counters };
}
