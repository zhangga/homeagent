// Run against packages/app/src/dual-mode-browser-fixture.ts with playwright-cli run-code.
async page => {
  const base = await page.evaluate(() => location.origin);
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) throw new Error('Expected a loopback fixture');
  const fixture = await page.request.get(base + '/__fixture');
  if (!fixture.ok() || !(await fixture.json()).offline) throw new Error('Expected the offline fixture');
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const nav = page.getByRole('navigation', { name: '主导航' });
  const openNav = () => page.getByRole('button', { name: '导航', exact: true }).click();
  const widthOf = async locator => (await locator.boundingBox())?.width ?? 0;

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(base);
  const agentUrl = page.url();
  assert(await page.locator('#agent-model').count() === 0, 'Opening an Agent on a phone must start in overview');
  const edit = page.getByRole('link', { name: '编辑配置', exact: true });
  assert(await edit.isVisible(), 'The overview must offer an edit action');
  for (const control of [edit, page.locator('.overview-actions button'), page.locator('.overview-back')]) {
    const box = await control.boundingBox();
    assert(box && box.height >= 44, 'Overview actions must be at least 44px tall on a phone');
  }
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'The Agent overview must fit the phone');
  await edit.click();
  await page.getByRole('button', { name: '模型与执行参数', exact: true }).click();
  assert(await page.locator('#agent-execution-mode').isVisible(), 'Agent settings must open on a phone');
  await page.keyboard.press('Escape');
  assert(await page.locator('#agent-inspector').isHidden(), 'Closed settings must leave the focus order');
  const actions = await page.locator('.agent-editor-actions').locator('button, a').all();
  for (const action of actions) {
    const box = await action.boundingBox();
    assert(box && box.x >= 0 && box.x + box.width <= 390, 'Each Agent action must fit the phone');
  }
  await page.getByRole('link', { name: '返回概览', exact: true }).click();
  assert(page.url() === agentUrl && await edit.isVisible(), 'Leaving the editor must restore the selected Agent overview');
  await openNav();
  const taskLink = nav.locator('a[href="/tasks"]');
  assert(await taskLink.evaluate(el => parseFloat(getComputedStyle(el).fontSize) > 0), 'Drawer link names must be visible');
  await taskLink.click();
  const taskName = page.locator('input[name="name"]');
  assert(await widthOf(taskName) >= 280, 'The task editor must use the phone width');
  await taskName.fill('手机布局回归');
  await page.goBack();
  assert(page.url() === agentUrl, 'Back must restore the original Agent');
  await openNav();
  await nav.locator('a[href="/work"]').click();
  assert(await widthOf(page.locator('input[name="title"]')) >= 280, 'The work editor must use the phone width');

  await page.setViewportSize({ width: 1280, height: 900 });
  await nav.locator('a[href="/tasks"]').click();
  const list = await page.locator('.listcol').boundingBox();
  const field = await taskName.boundingBox();
  assert(list && field && list.x + list.width < field.x, 'Desktop must retain its two-column task editor');
  return { mobileOverviewAndEdit: true, mobileWorkAndTask: true, desktopTaskLayout: true };
}
