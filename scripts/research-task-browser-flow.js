// Start the offline fixture with --tasks, then open its loopback URL in playwright-cli.
// Run: playwright-cli --raw run-code --filename=scripts/research-task-browser-flow.js
async page => {
  const base = await page.evaluate(() => location.origin);
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) throw new Error('Expected the offline loopback fixture');
  const audit = async () => (await page.request.get(base + '/__fixture')).json();
  const initial = await audit();
  if (!initial.offline || !initial.researchTasks || initial.counters.simulatedResearch) {
    throw new Error('Start a fresh research-task fixture with --tasks');
  }
  const check = (value, message) => { if (!value) throw new Error(message); };
  const openTask = async name => {
    await page.goto(base + '/tasks');
    await page.getByRole('link', { name, exact: true }).click();
    await page.locator('[data-task-overview]').waitFor();
  };
  const edit = async topic => {
    await page.getByRole('link', { name: '编辑设置', exact: true }).click();
    check(await page.getByRole('button', { name: '立即运行', exact: true }).count() === 0, 'Unsaved editor must not offer Run');
    await page.locator('textarea[name="topic"]').fill(topic);
  };
  const start = async () => {
    await page.getByRole('button', { name: '立即运行', exact: true }).click();
    await page.waitForURL(/\/tasks\/runs\/[^/?]+/);
  };
  const result = async (status, text) => {
    const primary = page.locator('[data-task-run-status="' + status + '"]');
    await primary.waitFor({ timeout: 15_000 });
    check((await primary.innerText()).includes(text), 'Expected ' + status + ' summary to contain ' + text);
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Run page exceeds viewport width');
    return page.url();
  };
  const errors = [];
  const onError = error => errors.push(error.message);
  const refreshed = new Set();
  const onResponse = response => {
    if (response.ok() && /\/tasks\/runs\/[^/]+\/status$/.test(response.url())) {
      refreshed.add(response.url().slice(0, -'/status'.length));
    }
  };
  page.on('pageerror', onError);
  page.on('response', onResponse);
  let saved = '整理本周产品反馈';
  let approvalTopic = '核对发布清单';
  const runs = {};
  for (const [size, width, height] of [['desktop', 1440, 900], ['mobile', 390, 844]]) {
    await page.setViewportSize({ width, height });
    await openTask('产品研究周报');
    const taskUrl = page.url();
    check((await page.locator('[data-task-overview]').innerText()).includes(saved), 'Show the saved research topic');
    check(await page.locator('textarea[name="topic"]').count() === 0, 'Detail must open in overview');
    await edit('这是一段未提交的研究主题');
    await page.getByRole('link', { name: '返回任务详情', exact: true }).click();
    await start();
    await result('succeeded', '离线样本已核对。本次研究主题：' + saved);

    await page.goto(taskUrl);
    const stale = await page.context().newPage();
    await stale.goto(taskUrl);
    saved = size === 'desktop' ? '分析移动端反馈中的三项主要建议' : '整理本周客户访谈中的共性需求';
    await edit(saved);
    await page.getByRole('button', { name: '保存', exact: true }).click();
    check((await page.locator('[data-task-overview]').innerText()).includes(saved), 'Saving must return to the updated task');
    const beforeStale = (await audit()).counters.simulatedResearch;
    await stale.getByRole('button', { name: '立即运行', exact: true }).click();
    await stale.locator('[data-task-overview]').waitFor();
    check(stale.url().split('?')[0] === taskUrl.split('?')[0], 'Stale preview must not launch a different topic');
    check((await stale.locator('main').innerText()).includes(saved), 'Stale preview must display current settings');
    check((await audit()).counters.simulatedResearch === beforeStale, 'Stale launch must not reach the simulated provider');
    await stale.close();
    await start();
    const success = await result('succeeded', '离线样本已核对。本次研究主题：' + saved);
    check(refreshed.has(success), 'The running page must refresh itself to show completion');
    const resultCard = page.locator('[data-task-run-status="succeeded"]');
    const source = resultCard.getByRole('link', { name: '查看原始记录', exact: true });
    const resultText = await resultCard.innerText();
    check(resultText.indexOf('离线样本已核对') < resultText.indexOf('查看原始记录'), 'Read output before the provenance link');
    await source.click();
    check(await page.getByRole('heading', { name: '原始记录详情', exact: true }).isVisible(), 'Preserve the source record');
    await page.goBack();
    await page.locator('[data-task-run-details] > summary').click();
    check(await page.locator('[data-task-run-details]').getAttribute('open') !== null, 'Detailed run evidence remains accessible');

    await openTask('样本完整性检查');
    await start();
    const failed = await result('failed', '离线样本缺失');
    check(await page.getByRole('button', { name: '重新运行', exact: true }).isVisible(), 'A failed run must offer retry');

    await openTask('发布校对');
    const approvalTask = page.url();
    const beforeApproval = (await audit()).counters.simulatedResearch;
    await start();
    const pending = await result('awaiting_approval', approvalTopic);
    check((await audit()).counters.simulatedResearch === beforeApproval, 'Approval must precede the simulated provider call');
    const frozen = approvalTopic;
    approvalTopic = size === 'desktop' ? '核对下周发布清单' : '核对下月发布清单';
    await page.goto(approvalTask);
    await edit(approvalTopic);
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByRole('link', { name: '查看待审批申请', exact: true }).click();
    check(page.url().split('?')[0] === pending.split('?')[0], 'Return to the pending run for this task');
    await result('awaiting_approval', frozen);
    await page.getByRole('button', { name: '批准并执行', exact: true }).click();
    const approved = await result('succeeded', '离线样本已核对。本次研究主题：' + frozen);

    await openTask('发布校对');
    await start();
    await result('awaiting_approval', approvalTopic);
    // Use the actual reject form. Only handle its test-page native confirmation.
    await page.evaluate(() => { window.confirm = message => message.includes('拒绝'); });
    await page.getByRole('button', { name: '拒绝', exact: true }).click();
    await page.locator('[data-task-run-status="cancelled"]').waitFor();
    check((await audit()).counters.simulatedResearch === beforeApproval + 1, 'Reject must not execute the task');
    runs[size] = { task: taskUrl, success, failed, approved, rejected: page.url() };
  }
  await openTask('发布校对');
  await start();
  const pending = await result('awaiting_approval', approvalTopic);
  page.off('pageerror', onError);
  page.off('response', onResponse);
  check(errors.length === 0, errors.join('\n'));
  const counters = (await audit()).counters;
  check(counters.model === 0 && counters.login === 0, 'Acceptance must use the offline runner only');
  return { desktopAndMobile: true, savedTopicVerified: true, approvalAndRejection: true, runs, pending, counters };
}
