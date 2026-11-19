// Open a fresh --chats fixture at desktop or phone width, then run with playwright-cli run-code --filename.
async (page, screenshotDirectory) => {
  const base = await page.evaluate(() => location.origin);
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) throw new Error('Expected an offline loopback fixture');
  const verify = (ok, message) => { if (!ok) throw new Error(message); };
  const audit = async () => (await page.request.get(base + '/__fixture')).json();
  const initial = await audit();
  verify(initial.offline && initial.chatAgentId && initial.chatCalls.answer === 0, 'Start a fresh fixture with --chats');
  const width = await page.evaluate(() => innerWidth);
  const capture = async name => {
    if (screenshotDirectory) await page.screenshot({
      path: screenshotDirectory + '/chat-' + name + (width <= 500 ? '-mobile' : '-desktop') + '.png', animations: 'disabled',
    });
  };
  const control = async name => {
    const res = await page.request.post(base + '/__fixture/chats/' + name);
    verify(res.ok(), 'Offline control failed: ' + name);
    return res.status() === 204 ? undefined : res.json();
  };
  const errors = [];
  const onError = error => errors.push(error.message);
  page.on('pageerror', onError);
  const details = page.locator('#chat-run-details');
  const process = page.locator('#chat-run-process');
  const answer = page.locator('#live-run-answer');
  const button = name => page.locator('#chat-run-actions').getByRole('button', { name, exact: true });
  const state = async (status, delivery) => {
    const selector = '#live-run[data-run-status="' + status + '"]'
      + (delivery ? '[data-delivery-status="' + delivery + '"]' : '');
    await page.locator(selector).waitFor({ timeout: 15000 });
  };
  const open = async kind => {
    const sample = await control(kind);
    await page.goto(base + '/agents/' + initial.chatAgentId);
    await page.locator('#agent-recent-runs a[href="/chats/runs/' + sample.id + '"]').click();
    await state('running');
    verify((await page.locator('#chat-run-question').innerText()).includes(sample.question), 'Show this original question');
    verify(await process.getAttribute('open') === null && await details.getAttribute('open') === null, 'Technical data starts folded');
    return sample.id;
  };
  const live = await open('answer');
  verify(await button('取消运行').isVisible(), 'Active answer must be cancellable');
  await page.evaluate(() => { document.documentElement.dataset.browserVisit = 'open-before-completion'; });
  await process.locator('summary').click();
  await page.locator('#live-run-events').getByText('正在核对值班安排。', { exact: true }).waitFor();
  await process.locator('summary').click();
  await control('finish-answer');
  await state('succeeded', 'pending');
  verify((await answer.innerText()).includes('交接会定在周五下午三点'), 'Show the saved answer before delivery finishes');
  verify(!await button('取消运行').count() && !await button('重试投递').count(), 'No duplicate send while the connector is active');
  // Wait for a later status read with the page left open before returning the transport failure.
  await page.waitForResponse(response => response.url() === base + '/chats/runs/' + live + '/status', { timeout: 12000 });
  await control('fail-delivery');
  await state('succeeded', 'failed');
  verify(await button('重试投递').isVisible() && (await page.locator('#chat-run-delivery').innerText()).includes('失败'),
    'Show a delivery retry on the same already-completed page');
  verify(await page.evaluate(() => document.documentElement.dataset.browserVisit === 'open-before-completion'), 'State changes must update this open document');
  verify(await answer.evaluate(node => node.getBoundingClientRect().bottom <= innerHeight), 'The answer should be visible on the first screen');
  verify(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Detail exceeds viewport width');
  await capture('delivery-failed');
  const monitor = await page.context().newPage();
  await monitor.goto(base + '/chats/runs/' + live);
  await monitor.locator('#live-run[data-delivery-status="failed"]').waitFor();
  await monitor.evaluate(() => { document.documentElement.dataset.browserVisit = 'open-before-retry'; });
  await page.bringToFront();
  await button('重试投递').click();
  await state('succeeded', 'sent');
  verify(await page.locator('#live-run').getAttribute('data-run-id') === live && !await button('重试投递').count(),
    'Resend must reuse the original Run and remove the retry action');
  verify((await audit()).chatCalls.answer === 1 && (await audit()).chatCalls.answerDelivery === 2, 'Resend stored output without rerunning the provider');
  await capture('answered');
  await monitor.bringToFront();
  await monitor.locator('#live-run[data-delivery-status="sent"]').waitFor({ timeout: 16000 });
  verify(await monitor.evaluate(() => document.documentElement.dataset.browserVisit === 'open-before-retry'), 'The second open page must observe delivery without a manual reload');
  await monitor.close();
  await page.bringToFront();
  await details.locator(':scope > summary').click();
  const raw = details.locator('a[href*="/raw/"]');
  verify(await raw.isVisible() && (await page.request.get(base + await raw.getAttribute('href'))).ok(), 'Keep the original source record accessible');

  await open('cancel');
  // The CLI yields on native dialogs. Accept only this test page's cancellation confirmation.
  await page.evaluate(() => { window.confirm = question => question === '取消这次对话运行？'; });
  await button('取消运行').click();
  await state('cancelled');
  verify((await page.locator('#chat-run-status').innerText()).includes('已取消'), 'Cancellation has its own terminal label');
  verify(await button('重试文本回答').isVisible(), 'Cancelled answers keep the existing text retry');

  const failed = await open('failure');
  await control('fail-answer');
  await state('failed');
  verify(await button('重试文本回答').isVisible(), 'Provider failure offers to regenerate the answer');
  await button('重试文本回答').click();
  await state('succeeded', 'sent');
  verify(await page.locator('#live-run').getAttribute('data-run-id') !== failed && (await answer.innerText()).includes('上午九点至下午五点'),
    'Retrying a failed provider should create a successful linked Run with a new answer');
  await details.locator(':scope > summary').click();
  verify(await details.locator('a[href="/chats/runs/' + failed + '"]').isVisible(), 'The new Run must link back to its failed attempt');
  page.off('pageerror', onError);
  verify(errors.length === 0, errors.join('\n'));
  const final = await audit();
  verify(final.counters.model === 0 && final.chatCalls.cancel === 1 && final.chatCalls.failure === 2,
    'Only explicit text retry may call the offline provider a second time');
  return { width, liveAnswerAndDelivery: true, resentWithoutModel: true, lateDeliveryInSecondTab: true,
    cancel: true, linkedProviderRetry: true, calls: final.chatCalls };
}
