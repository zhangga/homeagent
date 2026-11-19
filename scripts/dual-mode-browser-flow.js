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
  const overviewUrl = page.url();
  const edit = () => submit(page.getByRole('link', { name: '编辑配置', exact: true }));
  const verifyOverview = async () => {
    verify(await page.getByRole('link', { name: '编辑配置', exact: true }).isVisible(), 'The selected Agent must open in overview');
    verify(await page.locator('#agent-model, #agent-editor-form').count() === 0, 'Overview must not render editing controls');
    verify(await page.locator('a[href="/spaces/team%2Foc_offline_browser"]').isVisible(), 'The bound space must be reachable');
  };
  await verifyOverview();
  await page.locator('a[href="/spaces/team%2Foc_offline_browser"]').click();
  verify(await page.getByRole('heading', { name: '离线验收群（未连接飞书）' }).isVisible(), 'Bound space must open its own knowledge page');
  await page.goBack();
  verify(await card.getAttribute('data-agent-readiness') === 'unknown', 'GET must not probe');
  await submit(page.getByRole('button', { name: '检测当前发布配置', exact: true }));
  await verifyOverview();
  verify(await card.getAttribute('data-agent-readiness') === 'unavailable', 'Isolated failure must be visible');
  await edit();
  verify((await card.innerText()).includes('根目录拒绝规则未通过验证'), 'The editor must explain the isolation failure');
  await page.locator('#agent-instruction').fill('只在发布后生效的离线职责。');
  await page.locator('#agent-execution-mode').selectOption('local-full-access');
  verify(await page.locator('#agent-permission').inputValue() === 'full', 'Full intent sets matching permission');
  verify(await page.locator('button[name="agentAction"][value="publish"]').innerText() === '继续：确认发布', 'Mode change must update the publish action label');
  await submit(page.getByRole('button', { name: '保存草稿', exact: true }));
  verify((await audit()).grants === 0 && (await audit()).mode === 'isolated', 'Draft must not publish or authorize');
  verify((await card.innerText()).includes('隔离模式'), 'Readiness must still describe the published mode');
  const stale = await page.context().newPage();
  await stale.goto(overviewUrl, { waitUntil: 'domcontentloaded' });
  verify((await stale.locator('main').innerText()).includes('草稿'), 'Overview must identify an unpublished draft');
  verify(!(await stale.locator('main').innerText()).includes('只在发布后生效的离线职责。'), 'Overview must show published duties while a draft exists');
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
  await verifyOverview();
  verify((await page.locator('main').innerText()).includes('只在发布后生效的离线职责。'), 'Published duties must appear on the overview');
  verify(await card.getAttribute('data-agent-readiness') === 'unknown', 'New revision invalidates old isolation result');
  const staleResponse = stale.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/readiness'));
  await stale.getByRole('button', { name: '检测当前发布配置', exact: true }).click();
  verify((await staleResponse).status() === 409, 'Stale published revision must be rejected');
  await stale.close();
  await edit();
  await submit(page.getByRole('button', { name: '检测当前发布配置', exact: true }));
  verify(await card.getAttribute('data-agent-readiness') === 'ready', 'Full fake preflight should pass');
  verify((await card.innerText()).includes('未隔离') && (await card.innerText()).includes('实际模型调用未验证'), 'Do not claim sandbox or model verification');
  const timedContext = await page.context().browser().newContext();
  try {
    const timedPage = await timedContext.newPage();
    await timedPage.clock.install();
    await timedPage.goto(overviewUrl);
    const timedCard = timedPage.locator('[data-agent-readiness]');
    verify(await timedCard.getAttribute('data-agent-readiness') === 'ready', 'Overview must reflect the last successful check');
    await timedPage.clock.fastForward(61_000);
    verify(await timedCard.getAttribute('data-agent-readiness') === 'unknown' && (await timedCard.innerText()).includes('上次检查已过期'), 'Open overview must expire the readiness result');
  } finally {
    await timedContext.close();
  }
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
  await page.goto(overviewUrl);
  await verifyOverview();
  await edit();
  await page.getByRole('button', { name: '模型与执行参数', exact: true }).click();
  verify(await page.locator('#agent-execution-mode').isVisible(), 'Mobile inspector must expose execution mode');
  await page.locator('#agent-execution-mode').selectOption('isolated');
  verify(await page.locator('#agent-permission').inputValue() === '', 'Switching back must require an explicit restricted permission');
  verify(!await page.locator('#agent-permission').evaluate(element => element.checkValidity()), 'Missing permission must block submit');
  verify(await page.locator('button[name="agentAction"][value="publish"]').innerText() === '发布', 'Switching back restores publish label');
  await page.locator('#agent-permission').selectOption('write');
  await page.locator('#agent-inspector').getByRole('button', { name: '关闭参数', exact: true }).click();
  await submit(page.getByRole('button', { name: '发布', exact: true }));
  await verifyOverview();
  await edit();
  await page.getByRole('button', { name: '模型与执行参数', exact: true }).click();
  verify(await page.locator('#agent-permission').inputValue() === 'write', 'Published restricted permission must remain explicit');
  await submit(page.getByRole('button', { name: '检测当前发布配置', exact: true }));
  verify(await card.getAttribute('data-agent-readiness') === 'unavailable', 'Switching back must recheck isolation, not reuse full readiness');
  const final = await audit();
  verify(final.mode === 'isolated' && final.activeGrants === 0 && final.counters.model === 0 && final.counters.login === 0 && final.counters.sandboxSetup === 0, 'Offline acceptance must leave no full grant or real calls');
  verify(final.counters.isolatedPreparation === 2 && final.counters.fullPreparation === 1, 'Each requested mode follows its own preparation boundary');
  verify(errors.length === 0, 'Browser JavaScript must not throw');
  page.off('pageerror', onError);
  return { offline: true, desktopAndMobile: true, overviewAndEdit: true, draftConsentReadinessRevoke: true, staleRevisionRejected: true, counters: final.counters };
}
