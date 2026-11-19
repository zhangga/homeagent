// Open a fresh --work offline fixture at /work, set a desktop or phone width, then run with playwright-cli.
async page => {
  const base = await page.evaluate(() => location.origin);
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) throw new Error('Expected a loopback fixture');
  const audit = async () => (await page.request.get(base + '/__fixture')).json();
  const initial = await audit();
  if (!initial.offline || !initial.workItems || initial.counters.simulatedWork !== 3) {
    throw new Error('Start a fresh fixture with --work');
  }
  const verify = (ok, message) => { if (!ok) throw new Error(message); };
  const index = async () => { await page.goto(base + '/work'); };
  const row = title => page.locator('li[data-work-item]').filter({ has: page.getByRole('link', { name: title, exact: true }) });
  const state = async (title, expected) => {
    verify(await row(title).getAttribute('data-work-state') === expected, title + ' should be ' + expected);
  };
  const backToUpdatedList = async (title, expected) => {
    // Form redirects and active Run refreshes can leave an extra detail entry in history.
    for (let step = 0; step < 3 && page.url() !== base + '/work'; step++) await page.goBack();
    await page.waitForURL(base + '/work', { timeout: 5000 });
    await row(title).and(page.locator('li[data-work-state="' + expected + '"]')).waitFor({ timeout: 5000 });
  };
  const open = (title, action) => row(title).getByRole('link', { name: action, exact: true }).click();
  const primary = kind => page.locator('[data-work-attention="' + kind + '"]');
  const errors = [];
  const onError = error => errors.push(error.message);
  page.on('pageerror', onError);
  await index();
  for (const [title, expected] of [
    ['复核上线清单', 'awaiting_acceptance'], ['更新值班手册', 'awaiting_approval'],
    ['整理用户访谈', 'running'], ['核验交付样本', 'blocked'],
  ]) { await state(title, expected); }
  verify(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Index exceeds the viewport');
  verify(await page.locator('li[data-work-state]').evaluateAll(rows =>
    rows.every(item => item.getBoundingClientRect().bottom <= window.innerHeight)
  ), 'All four fixture states should fit in the initial viewport');

  await open('整理用户访谈', '查看进度');
  await page.locator('[data-task-run-status="running"]').waitFor();
  verify(page.url().includes('/tasks/runs/'), 'Running row must open the actual run');
  const runningPath = page.url().slice(base.length);
  await index();
  await open('整理用户访谈', '整理用户访谈');
  verify(await primary('running').getByRole('link', { name: '查看执行进度' }).getAttribute('href') === runningPath,
    'The item overview and list action must refer to the same active run');
  await index();
  await open('核验交付样本', '查看阻塞原因');
  verify(page.url().endsWith('#work-next-action'), 'Blocked action must have a direct anchor');
  const block = primary('blocked');
  verify((await block.innerText()).split('样本缺少来源记录').length === 2, 'Show one copy of the reason from the frozen report');
  verify(await block.getByRole('button', { name: '重试此动作' }).isVisible(), 'Retry remains accessible');

  await index();
  await open('复核上线清单', '查看报告');
  verify(page.url().includes('#acceptance-'), 'Open the current report directly from the index');
  const report = primary('awaiting_acceptance');
  verify((await report.innerText()).includes('已完成：核对上线前的三项检查。'), 'Show the actual submitted report');
  await report.getByRole('button', { name: '接受结果', exact: true }).click();
  await backToUpdatedList('复核上线清单', 'normal');
  await open('复核上线清单', '复核上线清单');
  await page.locator('summary').filter({ hasText: '编辑事项与计划' }).click();
  await page.locator('textarea[name="summary"]').fill('上线前检查已经复核。');
  await page.getByRole('button', { name: '保存上下文', exact: true }).click();
  verify(await page.locator('textarea[name="summary"]').inputValue() === '上线前检查已经复核。', 'Original edit and save must persist');

  await index();
  const approvalPath = await row('更新值班手册').getByRole('link', { name: '处理审批' }).getAttribute('href');
  await open('更新值班手册', '更新值班手册');
  verify(await primary('awaiting_approval').getByRole('link', { name: '前往审批' }).getAttribute('href') === approvalPath,
    'The item overview must refer to the same pending approval as the list');
  await index();
  await open('更新值班手册', '处理审批');
  const approval = page.locator('[data-task-run-status="awaiting_approval"]');
  await approval.waitFor();
  verify((await approval.innerText()).includes('更新交班手册的联系人'), 'Lead with the action awaiting approval');
  const fullTopic = approval.locator('details').filter({ hasText: '查看完整冻结任务主题' });
  verify(await fullTopic.getAttribute('open') === null, 'The full frozen provider prompt should start collapsed');
  await fullTopic.locator('summary').click();
  verify((await fullTopic.innerText()).includes('## 本次动作'), 'The complete original approval scope must still be available');
  await fullTopic.locator('summary').click();
  verify((await audit()).counters.simulatedWork === 3, 'Opening an approval must not execute the work');
  await page.getByRole('button', { name: '批准并执行', exact: true }).click();
  await page.locator('[data-task-run-status="succeeded"]').waitFor({ timeout: 15_000 });
  verify((await audit()).counters.simulatedWork === 4, 'Approval must execute exactly once');
  await backToUpdatedList('更新值班手册', 'awaiting_acceptance');
  await open('更新值班手册', '查看报告');
  const pending = primary('awaiting_acceptance');
  await pending.locator('textarea[name="reason"]').fill('请补充备用联系人的交接记录。');
  await pending.getByRole('button', { name: '驳回结果', exact: true }).click();
  await backToUpdatedList('更新值班手册', 'blocked');
  await open('更新值班手册', '查看阻塞原因');
  verify((await primary('blocked').innerText()).includes('请补充备用联系人的交接记录。'), 'Rejected work must show the reviewer reason');
  verify(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Work detail exceeds the viewport');
  page.off('pageerror', onError);
  verify(errors.length === 0, errors.join('\n'));
  return { width: await page.evaluate(() => innerWidth), fourStates: true, approvedThenReviewed: true,
    acceptedAndRejected: true, historyReflectsActions: true, originalEdit: true, counters: (await audit()).counters };
}
