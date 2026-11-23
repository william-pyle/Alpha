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
const checks = [], screenshots = [], errors = [];
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
  await page.getByRole('button', { name: 'New conversation', exact: true }).click(); await expect(page.getByRole('heading', { name: 'New conversation', exact: true })).toBeVisible(); await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await editor.fill('Architecture draft'); await tab(a.id).focus(); await tab(a.id).press('ArrowRight'); await expect(tab(b.id)).toHaveAttribute('aria-selected', 'true'); await expect(tab(b.id)).toBeFocused(); await expect(editor).toHaveValue('');
  await editor.fill('Research draft'); await tab(b.id).press('Home'); await expect(editor).toHaveValue('Architecture draft'); await page.reload(); await expect(editor).toHaveValue('Architecture draft');
  await contextAction(b.id, 'Conversation details'); await expect(page.getByLabel('Title', { exact: true })).toHaveValue(b.name); await page.getByLabel('Purpose', { exact: true }).fill('Updated only Research'); await page.getByRole('button', { name: 'Save details' }).click();
  await expect.poll(() => service.threads.get(b.id).purpose).toBe('Updated only Research'); assert.equal(service.threads.selectedId, a.id);
  await tab(a.id).focus(); await tab(a.id).press('Shift+F10'); await page.screenshot({ path: path.join(repo, 'conversation-context-menu.png') }); await page.keyboard.press('Escape'); await expect(tab(a.id)).toBeFocused();
  await page.locator('[data-message-id="a-message"]').click({ button: 'right' }); await expect(page.getByRole('menu', { name: 'Message actions' })).toBeVisible(); await expect(page.getByRole('menu', { name: 'Conversation actions' })).toHaveCount(0); await page.keyboard.press('Escape');
  checks.push('Tabs keyboard selection, draft/selected persistence, exact background-tab edit, context Escape focus, message menu preserved.');

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
  await page.getByRole('button', { name: /^Attention for Research/ }).click(); await expect(page.locator(`[data-question-id="${question.id}"]`)).toHaveCount(1);
  await events(); await expect(page.getByRole('tabpanel', { name: 'Needs attention' })).not.toContainText('Synthetic decision?'); await page.getByRole('button', { name: 'Close Needs attention' }).click();
  await request(`/questions/${question.id}/dismiss`); await expect(page.locator(`[data-question-id="${question.id}"]`)).toHaveCount(0);
  service.awareness.event({ id: 'app-health-fixture', kind: 'health', text: 'Synthetic app-level health problem', source: 'Alpha health' }); await events(); await page.locator('[data-event-id="app-health-fixture"]').getByRole('button', { name: 'Open Alpha health' }).click(); await expect(page.getByRole('tabpanel', { name: 'Alpha health', exact: true })).toBeVisible(); await page.getByRole('button', { name: 'Close Alpha health', exact: true }).click();
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
  const oldOrigin = service.origin; await service.close(); service = await createService({ repo, uiDir: path.resolve('dist'), mcpOptions: { home: repo, env: {} } }); assert.notEqual(service.origin, oldOrigin); await page.goto(service.urls.workspace); await expect(editor).toHaveValue('Research draft'); await expect(tab(b.id)).toHaveAttribute('aria-selected', 'true');
  await history(); await page.getByRole('tabpanel', { name: 'Conversation history' }).getByRole('button', { name: /^Architecture review/ }).click(); await expect(mode(a.name)).toHaveAttribute('aria-pressed', 'true'); await expect(activity.getByRole('combobox')).toHaveValue(w2.id); assert.ok(service.sessions.list().every(session => session.status === 'stopped'));
  checks.push('Visible × closes selected and background tabs, focuses neighbor or fixed + after last keyboard close, preserves workers/IDs, and History reopens draft and terminal mode across isolated service restart.');
  assert.deepEqual(errors, []); await writeFile(path.join(repo, 'results.json'), JSON.stringify({ status: 'passed', fixtureOnly: true, nativeWindowsPTY: process.platform === 'win32', checks, screenshots }, null, 2)); console.log(`Conversation tabs UI passed. Evidence: ${repo}`);
} catch (error) { await writeFile(path.join(repo, 'failure.json'), JSON.stringify({ error: error.stack, checks }, null, 2)); if (page) await page.screenshot({ path: path.join(repo, 'failure.png') }).catch(() => {}); console.error(`Evidence: ${repo}`); throw error; }
finally { await browser?.close(); await service.close(); }
