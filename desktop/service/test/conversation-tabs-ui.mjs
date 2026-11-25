import { tmpdir as isolatedTmpdir } from 'node:os';
// Isolated Workspace + actual Windows PowerShell PTYs; no owner/provider sessions.
import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createService } from '../server.mjs';
import { launchBrowser } from './browser.mjs';

await mkdir('.test-output', { recursive: true });
const repo = await mkdtemp(path.join(process.env.RUNNER_TEMP || isolatedTmpdir(), 'alpha-conversation-tabs-'));
await mkdir(path.join(repo, 'workspace')); await mkdir(path.join(repo, '.alpha'));
await writeFile(path.join(repo, 'workspace/workspace.json'), JSON.stringify({ entities: [{ id: 'fixture', title: 'Fixture Workspace', folder: 'fixture', steps: [] }] }));
await writeFile(path.join(repo, '.alpha/settings.json'), '{"speakReplies":false}');
let service = await createService({ repo, uiDir: path.resolve('dist'), mcpOptions: { home: repo, env: {} } });
const a = service.threads.create({ name: 'Architecture review', projectId: 'fixture' }), b = service.threads.create({ name: 'Research conversation', projectId: 'fixture' });
const extra = Array.from({ length: 12 }, (_, i) => service.threads.create({ name: `Overflow conversation ${i} with a deliberately long title`, projectId: 'fixture' }));
service.threads.message(a.id, { id: 'a-message', role: 'assistant', text: 'Only the architecture conversation sees this message.' });
service.threads.select(a.id);
const w1 = await service.sessions.create({ agent: 'shell', name: 'First synthetic terminal', cwd: repo, projectId: 'fixture', alphaThreadId: a.id });
const w2 = await service.sessions.create({ agent: 'shell', name: 'Second synthetic terminal', cwd: repo, projectId: 'fixture', alphaThreadId: a.id });
const w3 = await service.sessions.create({ agent: 'shell', name: 'Unrelated synthetic terminal', cwd: repo, projectId: 'fixture', alphaThreadId: extra[0].id });
const input = [], originalInput = service.sessions.input.bind(service.sessions);
service.sessions.input = (id, text) => { input.push({ id, text }); return originalInput(id, text); };
const checks = [], screenshots = [], errors = [], transcriptScroll = [];
let browser, page;
const tab = id => page.locator(`#conversation-tab-${id}`);
const mode = name => page.getByRole('button', { name: `Worker terminal for ${name}`, exact: true });
const closeTab = name => page.getByRole('button', { name: `Close conversation tab for ${name}`, exact: true });
const contextAction = async (id, label, keyboard = false) => { if (keyboard) { await tab(id).focus(); await tab(id).press('Shift+F10'); } else await tab(id).click({ button: 'right' }); await page.getByRole('menu', { name: 'Conversation actions' }).getByRole('menuitem', { name: label, exact: true }).click(); };
const history = async () => { await page.getByRole('button', { name: 'View', exact: true }).click(); await page.getByRole('menuitem', { name: 'Conversation history', exact: true }).click(); };
const events = async () => { await page.getByRole('button', { name: 'View', exact: true }).click(); await page.getByRole('menuitem', { name: 'Needs attention', exact: true }).click(); };
const request = async (route, data = {}) => { const response = await fetch(service.origin + '/api' + route, { method: 'POST', headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); assert.ok(response.ok, await response.clone().text()); return response.json(); };
try {
  browser = await launchBrowser(); page = await browser.newPage({ viewport: { width: 1440, height: 900 } }); page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message)); await page.goto(service.urls.workspace);
  const editor = page.getByRole('textbox', { name: 'Message Alpha' });
  await expect(editor).toBeEnabled(); await expect(page.locator('.mdi-center')).toBeVisible(); await expect(page.locator('.conversation-menu')).toHaveCount(0);
  const tabs = page.getByRole('tablist', { name: 'Conversations', exact: true });
  await expect(tabs.getByRole('tab')).toHaveCount(14);
  await expect(tab(b.id)).toHaveText(b.name);
  await expect(tab(b.id)).toHaveAccessibleName(`${b.name}, Messages, Ready`);
  const statusMark = tab(b.id).locator('.conversation-tab-status');
  await expect(statusMark).toHaveAttribute('data-status', 'idle');
  b.status = 'working'; service.threads.publish();
  await expect(tab(b.id)).toHaveAccessibleName(`${b.name}, Messages, Working`);
  await expect(statusMark).toHaveAttribute('data-status', 'active');
  b.status = 'waiting-for-user'; service.threads.publish();
  await expect(tab(b.id)).toHaveAccessibleName(`${b.name}, Messages, Waiting for your answer`);
  await expect(statusMark).toHaveAttribute('data-status', 'attention');
  b.status = 'idle'; service.threads.publish();
  await expect(closeTab(b.name)).toHaveText('×');
  const messageIcon = await mode(a.name).locator('path').getAttribute('d');
  await expect(page.getByRole('button', { name: /Return to conversation/i })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Needs attention:/ })).toHaveCount(0);
  {
    let clock = 0, timer;
    const statusClock = {
      setTimeout(callback, delay) { timer = { callback, at: clock + delay }; return timer; },
      clearTimeout(handle) { if (timer === handle) timer = undefined; },
    };
    const tick = ms => {
      clock += ms;
      if (!timer || timer.at > clock) return;
      const { callback } = timer; timer = undefined; callback();
    };
    const methods = [];
    const fixture = async replyOnly => {
      const item = await service.getCoordinator(b.id, { replyOnly });
      item.statusClock = statusClock;
      item.start = async () => { item.threadId = replyOnly ? 'reply-provider' : 'work-provider'; };
      item.rpc = async method => { methods.push(method); return { turn: { id: item.active.operationId } }; };
      return item;
    };
    let coordinator = await fixture(false);
    const submit = async id => {
      await request(`/threads/${b.id}/input`, { id, text: `Fixture ${id}`, target: coordinator.replyOnly ? 'reply' : 'work' });
      await expect.poll(() => coordinator.active?.turnId).toBe(id);
    };
    const finish = async (id, status, error) => {
      const pending = coordinator.operationPromises.get(id);
      if (status === 'completed') await coordinator.message({ method: 'item/completed', params: { threadId: coordinator.threadId, turnId: id, item: { type: 'agentMessage', text: `Finished ${id}` } } });
      await coordinator.message({ method: 'turn/completed', params: { threadId: coordinator.threadId, turn: { id, status, error } } });
      return pending;
    };
    const progress = page.getByText('I’m still working on this request.', { exact: true });
    const notices = () => b.messages.filter(message => message.source === 'coordinator-status');
    const attention = page.getByRole('button', { name: /^Needs attention:/ });
    await tab(b.id).click();
    await submit('slow-turn');
    tick(179_999);
    assert.equal(notices().length, 0);
    await tab(a.id).click();
    tick(1);
    assert.equal(notices().length, 1);
    assert.equal(b.status, 'working');
    assert.equal(coordinator.active.turnId, 'slow-turn');
    assert.equal(coordinator.operations.get('slow-turn').status, 'running');
    assert.equal(a.messages.some(message => message.source === 'coordinator-status'), false);
    assert.deepEqual(service.awareness.snapshot().items, []);
    await expect(progress).toHaveCount(0);
    await expect(attention).toHaveCount(0);
    await tab(b.id).click();
    await expect(progress).toBeVisible();
    assert.equal(await progress.evaluate(element => !!element.closest('[role="alert"]')), false);
    tick(180_000);
    assert.equal(notices().length, 1);
    assert.deepEqual(methods, ['turn/start']);
    assert.equal((await finish('slow-turn', 'completed')).status, 'completed');
    await expect(page.getByText('Finished slow-turn', { exact: true })).toBeVisible();
    await expect(attention).toHaveCount(0);

    await submit('early-turn');
    await finish('early-turn', 'completed');
    tick(180_000);
    // Foreground failures still reach Needs attention and leave work-lane health maintenance idle.
    coordinator = await fixture(true);
    await submit('canceled-turn');
    await finish('canceled-turn', 'interrupted');
    tick(180_000);
    assert.equal(notices().length, 1);
    service.awareness.resolve(item => item.id === 'operation:canceled-turn');

    await submit('failed-turn');
    await finish('failed-turn', 'failed', { message: 'Fixture provider failure' });
    await expect(page.getByRole('alert').filter({ hasText: 'Fixture provider failure' })).toBeVisible();
    await expect(attention).toBeVisible();
    assert.ok(service.awareness.snapshot().items.some(item => item.id === 'operation:failed-turn' && item.threadId === b.id && item.kind === 'error'));
    service.awareness.resolve(item => item.id === 'operation:failed-turn');
    await tab(a.id).click();
    checks.push('An injected clock crosses three minutes on a running turn and shows one ordinary message only in its owner conversation. Work completes without interrupt or attention; early completion and cancellation send no status, and provider failure still surfaces.');
  }
  await page.getByRole('button', { name: 'New conversation', exact: true }).click(); await expect(page.getByRole('heading', { name: 'New conversation', exact: true })).toBeVisible(); await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await editor.fill('Architecture draft'); await tab(a.id).focus(); await tab(a.id).press('ArrowRight'); await expect(tab(b.id)).toHaveAttribute('aria-selected', 'true'); await expect(tab(b.id)).toBeFocused(); await expect(editor).toHaveValue('');
  await editor.fill('Research draft'); await tab(b.id).press('Home'); await expect(editor).toHaveValue('Architecture draft'); await page.reload(); await expect(editor).toHaveValue('Architecture draft');
  await contextAction(b.id, 'Conversation details'); await expect(page.getByLabel('Title', { exact: true })).toHaveValue(b.name); await page.getByLabel('Purpose', { exact: true }).fill('Updated only Research'); await page.getByRole('button', { name: 'Save details' }).click();
  await expect.poll(() => service.threads.get(b.id).purpose).toBe('Updated only Research'); assert.equal(service.threads.selectedId, a.id);
  await tab(a.id).focus(); await tab(a.id).press('Shift+F10'); await page.screenshot({ path: path.join(repo, 'conversation-context-menu.png') }); await page.keyboard.press('Escape'); await expect(tab(a.id)).toBeFocused();
  await page.locator('[data-message-id="a-message"]').click({ button: 'right' }); await expect(page.getByRole('menu', { name: 'Message actions' })).toBeVisible(); await expect(page.getByRole('menu', { name: 'Conversation actions' })).toHaveCount(0); await page.keyboard.press('Escape');
  checks.push('Tabs keyboard selection, draft/selected persistence, exact background-tab edit, context Escape focus, message menu preserved.');

  {
    const feed = page.locator('[aria-label="Conversation feed"]');
    const toggle = mode(a.name);
    const addReply = id => service.threads.message(a.id, { id, role: 'assistant', text: `Transcript reply ${id}` });
    for (let n = 0; n < 48; n++) service.threads.message(a.id, { id: `history-${n}`, role: 'assistant', text: `Transcript history ${n}` }, false);
    addReply('initial-tail');
    await expect(feed.locator('[data-message-id="initial-tail"]')).toBeVisible();
    await editor.evaluate(node => node.setSelectionRange(3, 8));
    const geometry = id => feed.evaluate((pane, messageId) => {
      const viewport = pane.getBoundingClientRect();
      const reply = pane.querySelector(`[data-message-id="${messageId}"]`)?.getBoundingClientRect();
      return { scrollTop: pane.scrollTop, overflow: pane.scrollHeight - pane.clientHeight,
        gap: pane.scrollHeight - pane.clientHeight - pane.scrollTop,
        latestVisible: !!reply && reply.top >= viewport.top && reply.bottom <= viewport.bottom };
    }, id);
    for (const [index, tail] of ['initial-tail', 'terminal-tail'].entries()) {
      await feed.evaluate(pane => { pane.scrollTop = 0; });
      await expect(feed.locator('[data-message-id="a-message"]')).toBeInViewport();
      if (index === 1) {
        addReply('messages-tail');
        await expect(feed.locator('[data-message-id="messages-tail"]')).toHaveCount(1);
        const readingHistory = await geometry('messages-tail');
        assert.equal(readingHistory.scrollTop, 0);
        assert.equal(readingHistory.latestVisible, false);
      }
      await toggle.focus(); await toggle.press('Enter');
      await expect(feed).toBeHidden();
      if (index === 1) {
        addReply(tail);
        await expect(feed.locator(`[data-message-id="${tail}"]`)).toHaveCount(1);
      }
      await toggle.press('Enter');
      await expect(feed).toBeVisible();
      await expect.poll(() => geometry(tail)).toMatchObject({ gap: 0, latestVisible: true });
      const measurement = await geometry(tail);
      assert.ok(measurement.overflow > 500);
      transcriptScroll.push({ latestReply: tail, ...measurement });
      await expect(toggle).toBeFocused();
      await expect(editor).toHaveValue('Architecture draft');
      assert.deepEqual(await editor.evaluate(node => [node.selectionStart, node.selectionEnd]), [3, 8]);
    }
    checks.push('Repeated Terminal to Messages switches scroll the overflowing transcript to its last reply, including a reply received while hidden. Messages keeps intentional scrollback on a new reply. The mode button keeps focus and the draft and caret are preserved.');
  }

  const beforeMode = input.length;
  await mode(a.name).click(); await expect(mode(a.name)).toHaveAttribute('aria-pressed', 'true'); await expect(editor).toBeDisabled();
  await expect(tab(a.id)).toHaveAccessibleName(/^Architecture review, Terminal, /);
  await expect(mode(a.name).locator('path')).not.toHaveAttribute('d', messageIcon);
  const activity = page.getByRole('region', { name: `Worker activity for ${a.name}` });
  await expect(activity).toBeVisible(); await expect(activity.getByRole('combobox')).toHaveValue(w1.id);
  await expect.poll(async () => (await service.sessions.read(w1.id)).screen).toMatch(/PS |[$>#]/);
  await activity.locator('.worker-terminal:visible .xterm-helper-textarea').focus(); await page.keyboard.type('LOCKED'); assert.equal(input.length, beforeMode);
  await activity.getByRole('button', { name: 'Enable terminal controls' }).click(); await activity.getByRole('button', { name: `Focus terminal: ${w1.name}` }).click();
  await page.keyboard.type(process.platform === 'win32' ? "Write-Output ('FIRST_' + 'PTY_OK')" : "echo FIRST_PTY_OK"); await page.keyboard.press('Enter');
  await expect.poll(async () => (await service.sessions.read(w1.id)).screen).toContain('FIRST_PTY_OK'); assert.ok(input.length > beforeMode); assert.ok(input.every(item => item.id === w1.id));
  const afterFirst = input.length;
  await activity.getByRole('combobox').selectOption(w2.id); await expect(activity.getByRole('button', { name: 'Enable terminal controls' })).toBeVisible();
  await activity.getByRole('button', { name: 'Enable terminal controls' }).click(); await activity.getByRole('button', { name: `Focus terminal: ${w2.name}` }).click();
  await page.keyboard.type(process.platform === 'win32' ? "Write-Output ('SECOND_' + 'PTY_OK')" : 'echo SECOND_PTY_OK'); await page.keyboard.press('Enter');
  await expect.poll(async () => (await service.sessions.read(w2.id)).screen).toContain('SECOND_PTY_OK'); assert.ok(input.slice(afterFirst).every(item => item.id === w2.id));
  await activity.locator('.terminal-host:visible').click({ button: 'right' }); await expect(page.getByRole('menu', { name: 'Conversation actions' })).toHaveCount(0);
  const afterSecond = input.length;
  for (const width of [1440, 768, 390]) { await page.setViewportSize({ width, height: 700 }); await expect(editor).toBeInViewport(); await expect(activity.locator('.worker-terminal:visible')).toBeInViewport(); await expect(page.locator('.mdi-center')).toBeInViewport(); const file = path.join(repo, `raw-${width}.png`); await page.screenshot({ path: file }); screenshots.push(file); }
  await page.setViewportSize({ width: 1440, height: 900 });
  await mode(a.name).click(); await expect(editor).toBeEnabled(); await expect(editor).toHaveValue('Architecture draft'); await mode(a.name).click(); await expect(activity.getByRole('combobox')).toHaveValue(w2.id); await expect(activity.getByRole('button', { name: 'Enable terminal controls' })).toBeVisible();
  await tab(b.id).click(); await expect(editor).toBeEnabled(); await expect(editor).toHaveValue('Research draft'); await mode(b.name).click(); await expect(page.getByText('No worker in this conversation', { exact: true })).toBeVisible();
  await tab(a.id).click(); await expect(activity).toBeVisible(); await expect(activity.locator('.worker-terminal:visible .xterm-rows')).toContainText('SECOND_PTY_OK'); assert.equal(input.length, afterSecond);
  assert.equal(service.sessions.items.size, 3); assert.equal(service.sessions.get(w3.id).lastInputAt, null);
  checks.push('Actual PTY commands reached only selected worker; locked/hidden modes sent no bytes; multi-worker selection, no-worker empty state, scrollback/draft preservation, independent modes, no launches on selection.');

  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 }); await tab(extra.at(-1).id).click();
    await expect(tab(extra.at(-1).id)).toBeInViewport(); await expect(page.getByRole('button', { name: 'New conversation', exact: true })).toBeInViewport();
    await expect(closeTab(extra.at(-1).name)).toBeInViewport();
    await expect(page.locator('.mdi-center')).toBeInViewport(); await expect(editor).toBeInViewport();
    await expect(page.getByRole('button', { name: /Return to conversation/i })).toHaveCount(0);
    const bounds = await page.evaluate(() => { const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, height: r.height }; }; return { tabs: rect('.conversation-tabs'), plus: rect('[aria-label="New conversation"]'), composer: rect('.layout-composer'), pane: rect('.thread-conversation'), overflow: document.documentElement.scrollWidth > innerWidth + 1 }; });
    assert.ok(bounds.tabs.height <= 40); assert.ok(bounds.plus.x >= bounds.tabs.right - 1); assert.ok(Math.abs(bounds.composer.bottom - bounds.pane.bottom) < 2); assert.equal(bounds.overflow, false);
    const resizer = page.getByRole('separator', { name: 'Resize writing area' }); const size = Number(await resizer.getAttribute('aria-valuenow')); await resizer.press('ArrowDown'); assert.ok(Number(await resizer.getAttribute('aria-valuenow')) < size);
    const shot = path.join(repo, `tabs-${width}.png`); await page.screenshot({ path: shot }); screenshots.push(shot);
  }
  await page.setViewportSize({ width: 1440, height: 900 }); await tab(a.id).click(); const rawShot = path.join(repo, 'real-terminal.png'); await page.screenshot({ path: rawShot }); screenshots.push(rawShot);
  checks.push('14 tabs/long titles at 1440,768,390: scrolling, reachable fixed +, visible Workspace, bottom composer, keyboard splitter.');

  await tab(b.id).click(); await expect(tab(b.id)).toHaveAttribute('aria-selected', 'true');
  await mode(b.name).click(); await expect(mode(b.name)).toHaveAttribute('aria-pressed', 'false');
  await closeTab(b.name).press('Enter');
  await expect(tab(b.id)).toHaveCount(0);
  await expect(tab(extra[0].id)).toHaveAttribute('aria-selected', 'true');
  await expect(tab(extra[0].id)).toBeFocused();
  assert.equal(service.threads.get(b.id).archived, true);
  await history(); await page.getByRole('tabpanel', { name: 'Conversation history' }).getByRole('button', { name: /^Research conversation/ }).click();
  await expect(tab(b.id)).toHaveAttribute('aria-selected', 'true');
  await expect(editor).toHaveValue('Research draft');
  assert.equal(service.threads.get(b.id).archived, false);
  await page.getByRole('button', { name: 'Close Conversation history' }).click();
  await expect(editor).toBeEnabled(); await editor.focus(); await expect(editor).toBeFocused();
  const event = { id: 'synthetic-failure', threadId: a.id, sessionId: w2.id, kind: 'error', text: 'Synthetic worker failure requires inspection.', source: 'Native provider error' };
  service.awareness.event(event); service.awareness.event(event); service.threads.message(a.id, { id: 'background', role: 'assistant', text: 'Background result, not verified.' });
  await expect(page.getByRole('button', { name: /^Attention for Architecture/ })).toBeVisible(); await expect(editor).toBeFocused(); assert.equal(service.threads.selectedId, b.id);
  const aWorkers = service.threads.get(a.id).sessionIds.slice();
  await closeTab(a.name).click(); await expect(tab(a.id)).toHaveCount(0); await expect(tab(b.id)).toBeFocused();
  assert.equal(service.threads.get(a.id).archived, true); assert.deepEqual(service.threads.get(a.id).sessionIds, aWorkers);
  for (const id of aWorkers) assert.equal(service.sessions.get(id).status, 'running');
  assert.equal(input.length, afterSecond);
  await events(); const notice = page.locator('[data-event-id="synthetic-failure"]'); await expect(notice).toHaveCount(1); await expect(notice).toContainText('History'); await notice.getByRole('button', { name: 'Open originating conversation' }).click();
  await expect(tab(a.id)).toHaveAttribute('aria-selected', 'true'); assert.equal(service.threads.get(a.id).archived, true); await expect(activity.getByRole('combobox')).toHaveValue(w2.id); await expect(activity.getByRole('button', { name: 'Enable terminal controls' })).toBeVisible();
  await events(); await notice.getByRole('button', { name: 'Dismiss', exact: true }).click(); await page.getByRole('button', { name: 'Close Needs attention' }).click(); service.awareness.event(event); await expect(page.locator('[data-event-id="synthetic-failure"]')).toHaveCount(0);
  service.awareness.event({ id: 'worker-review', threadId: b.id, kind: 'review', text: 'A worker finished its turn.', source: 'Native completion event' });
  await expect(page.getByRole('button', { name: 'Needs attention: 1. 1 result to review' })).toHaveAttribute('data-urgent', 'false');
  await events(); await expect(page.locator('[data-event-id="worker-review"]')).toContainText('not verified'); await page.locator('[data-event-id="worker-review"]').getByRole('button', { name: 'Snooze 30 minutes' }).click(); await page.getByRole('button', { name: 'Close Needs attention' }).click();
  service.awareness.control({ quiet: true }); service.awareness.event({ ...event, id: 'quiet-error' }); await expect(page.getByRole('button', { name: /^Needs attention:/ })).toHaveCount(0); await events(); await expect(page.locator('[data-event-id="quiet-error"]')).toBeVisible(); await page.getByRole('button', { name: 'Close Needs attention' }).click();
  const question = await service.questions.ask({ source: 'coordinator', sourceId: 'question-fixture', threadId: b.id, sessionId: b.id, chatName: b.name, text: 'Synthetic decision?', options: ['Keep'] });
  await page.getByRole('button', { name: /^Attention for Research/ }).click();
  await expect(page.getByRole('tabpanel', { name: 'Questions', exact: true })).toBeVisible();
  await expect(page.locator(`#question-answer-${question.id}`)).toBeFocused();
  await events(); await expect(page.getByRole('tabpanel', { name: 'Needs attention' })).not.toContainText('Synthetic decision?'); await page.getByRole('button', { name: 'Close Needs attention' }).click();
  await request(`/questions/${question.id}/dismiss`); await expect(page.locator(`[data-question-id="${question.id}"]`)).toHaveCount(0);
  service.awareness.event({ id: 'app-health-fixture', kind: 'health', text: 'Synthetic app-level health problem', source: 'Alpha health' }); await events(); await page.locator('[data-event-id="app-health-fixture"]').getByRole('button', { name: 'Open Alpha health' }).click(); await expect(page.getByRole('tabpanel', { name: 'Alpha health', exact: true })).toBeVisible(); await page.getByRole('tablist', { name: 'Documents', exact: true }).getByRole('button', { name: 'Close Alpha health', exact: true }).click();
  checks.push('Background failure dedup/no focus theft; archived origin navigation retains archive and exact worker; dismiss receipt, snooze, quiet manual access; questions only in Questions and cleared on resolution.');

  // Close target B from A without changing A, then every synthetic conversation.
  await request(`/threads/${a.id}/select`); await contextAction(b.id, 'Close conversation', true); await expect(page.getByRole('dialog', { name: 'Close conversation', exact: true })).toContainText(b.name); await page.getByRole('button', { name: 'Move to History' }).click(); assert.equal(service.threads.selectedId, a.id); assert.equal(service.threads.get(b.id).archived, true);
  for (const thread of service.threads.items.filter(item => !item.archived)) await request(`/threads/${thread.id}/close`);
  // A was explicitly previewed from History; close the preview selection through
  // selecting the final open fixture first so the last close reaches null.
  await request(`/threads/${extra[0].id}/reopen`); await request(`/threads/${extra[0].id}/select`); await tab(extra[0].id).press('Delete');
  await expect(page.getByRole('button', { name: 'New conversation', exact: true })).toBeFocused();
  await expect(page.getByText('No open conversations', { exact: true })).toBeVisible(); await expect(page.locator('.mdi-center')).toBeVisible(); await expect(page.getByRole('button', { name: 'New conversation', exact: true })).toBeInViewport(); await page.reload(); await expect(page.getByText('No open conversations', { exact: true })).toBeVisible();
  await history(); await page.getByRole('tabpanel', { name: 'Conversation history' }).getByRole('button', { name: new RegExp('^Research conversation') }).click(); await expect(editor).toHaveValue('Research draft'); assert.equal(service.sessions.items.size, 3);
  for (const id of [w1.id, w2.id, w3.id]) assert.equal(service.sessions.get(id).status, 'running');
  const oldOrigin = service.origin;
  const fixtureWorkers = [w1.id, w2.id, w3.id].map(id => service.sessions.get(id));
  const conoutReaders = fixtureWorkers.map(session => session.process?._agent?._conoutSocketWorker);
  await service.close();
  assert.ok(fixtureWorkers.every(session => !session.process), 'Synthetic terminal processes exited before service reload');
  // A quiet ConPTY reader can outlive the child exit callback. Drain these
  // fixture-owned readers after normal shutdown so the test can exit naturally.
  for (const reader of conoutReaders) reader?.dispose();
  service = await createService({ repo, uiDir: path.resolve('dist'), mcpOptions: { home: repo, env: {} } }); assert.notEqual(service.origin, oldOrigin); await page.goto(service.urls.workspace); await expect(editor).toHaveValue('Research draft'); await expect(tab(b.id)).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('I’m still working on this request.', { exact: true })).toHaveCount(1);
  await history(); await page.getByRole('tabpanel', { name: 'Conversation history' }).getByRole('button', { name: /^Architecture review/ }).click(); await expect(mode(a.name)).toHaveAttribute('aria-pressed', 'true'); await expect(activity.getByRole('combobox')).toHaveValue(w2.id); assert.ok(service.sessions.list().every(session => session.status === 'stopped'));
  checks.push('Visible × closes selected and background tabs, focuses neighbor or fixed + after last keyboard close, preserves workers/IDs, and History reopens draft and terminal mode across isolated service restart.');
  assert.deepEqual(errors, []); await writeFile(path.join(repo, 'results.json'), JSON.stringify({ status: 'passed', fixtureOnly: true, nativeWindowsPTY: process.platform === 'win32', checks, transcriptScroll, screenshots }, null, 2)); console.log(`Conversation tabs UI passed. Evidence: ${repo}`);
} catch (error) { await writeFile(path.join(repo, 'failure.json'), JSON.stringify({ error: error.stack, checks }, null, 2)); if (page) await page.screenshot({ path: path.join(repo, 'failure.png') }).catch(() => {}); console.error(`Evidence: ${repo}`); throw error; }
finally { await browser?.close(); await service.close(); }
