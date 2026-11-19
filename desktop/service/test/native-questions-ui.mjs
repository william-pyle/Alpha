// Isolated WebView-compatible UI + headless terminal fixture, no owner state.
import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createService } from '../server.mjs';
import { launchBrowser } from './browser.mjs';

await mkdir('.test-output', { recursive: true });
const root = await mkdtemp(path.resolve('.test-output/native-questions-ui-'));
await mkdir(path.join(root, 'workspace')); await mkdir(path.join(root, '.alpha'));
await writeFile(path.join(root, 'workspace/workspace.json'), JSON.stringify({ entities: [] }));
const service = await createService({ repo: root, uiDir: path.resolve('dist'), restoreSessions: false, checkUpdates: false, mcpOptions: { home: root, env: {} } });
const browser = await launchBrowser();
const writes = [], all = [];
const screen = session => `Trust this folder? Codex can read, edit, and run files here.\r\nC:\\Projects\\${session.name}\r\n› 1. Trust and continue\r\n  2. Quit\r\nenter continue · esc quit`;
const paint = async (session, value) => { await new Promise(resolve => session.terminal.write('\x1b[2J\x1b[H' + value, resolve)); service.sessions.detectPrompt(session); };
const capture = async session => { const state = await service.sessions.prompts.inspect(session); return service.questions.captureNative(session, state, service.sessions.prompts.binding(state)); };
try {
  for (const name of ['First', 'Second']) {
    const thread = service.threads.create({ name, projectId: 'fixture' });
    const session = service.sessions.make({ id: name, agent: 'codex', name, nativeId: `native-${name}`, alphaThreadId: thread.id, status: 'running', open: true, startedAt: Date.now() - 5000, cols: 100, rows: 24 });
    service.sessions.items.set(session.id, session); await service.sessions.hydrate(session); all.push(session);
    service.threads.observe(session);
    session.process = { resize() {}, write(key) {
      writes.push([session.id, key]);
      if (key === '\r') void paint(session, '\x1b[?2004hOpenAI Codex\r\n› \r\n? for shortcuts\x1b[2;3H');
    } };
    await paint(session, screen(session)); await capture(session);
  }
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(service.urls.workspace);
  const panel = page.getByRole('region', { name: 'Questions', exact: true });
  await expect(panel.locator('.question-card')).toHaveCount(1);
  await expect(panel.locator('header strong')).toHaveText('First');
  await expect(panel.getByRole('textbox')).toHaveCount(0);
  await panel.getByRole('button', { name: 'Open terminal', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Enable terminal controls', exact: true })).toHaveAttribute('aria-pressed', 'false');
  assert.equal(service.threads.owner('First').viewMode, 'terminal'); assert.deepEqual(writes, []);
  await page.screenshot({ path: path.join(root, 'questions-wide.png') });
  await panel.getByRole('button', { name: 'Trust and continue', exact: true }).click();
  await panel.getByRole('button', { name: 'Send answer', exact: true }).click();
  await expect(panel.locator('header strong')).toHaveText('Second');
  assert.deepEqual(writes, [['First', '1'], ['First', '\r']]);
  assert.equal(service.questions.items.find(item => item.sessionId === 'First').delivery, 'observed');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(root, 'questions-narrow.png') });
  // A new disclosure after the UI displays a choice must reject that choice.
  await paint(all[1], screen(all[1]).replace('Second', 'Changed'));
  await panel.getByRole('button', { name: 'Trust and continue', exact: true }).click();
  await panel.getByRole('button', { name: 'Send answer', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('prompt changed');
  assert.equal(writes.length, 2);
  await capture(all[1]);
  await panel.getByRole('button', { name: 'Trust and continue', exact: true }).click();
  await panel.getByRole('button', { name: 'Send answer', exact: true }).click();
  await expect(panel).toHaveCount(0);
  assert.deepEqual(writes.slice(2), [['Second', '1'], ['Second', '\r']]);
  await page.screenshot({ path: path.join(root, 'questions-resolved.png') });
  // A queued async reply must remain visible until a later exact acceptance,
  // then disappear without a second click or payload.
  const session = all[1];
  const [asyncQuestion] = service.questions.capture(session, { id: 'async-ui', source: 'provider-record', tool: 'request_user_input_async', asyncDelivery: true, questions: [{ text: 'Which synthetic color should be used?', options: ['Blue', 'Green'] }] });
  let replyPayload, replyTask, sends = 0;
  const originalInput = service.sessions.input;
  service.sessions.input = async (id, payload, options) => {
    assert.equal(id, session.id); sends++; replyPayload = payload; replyTask = options.taskId;
    return { accepted: false, note: 'Queued; waiting for native acceptance.' };
  };
  await panel.getByRole('button', { name: 'Blue', exact: true }).click();
  await panel.getByRole('button', { name: 'Send answer', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('waiting for native acceptance');
  assert.equal(service.questions.list().length, 1); assert.equal(sends, 1);
  assert.ok(replyPayload.includes(asyncQuestion.asyncQuestion.id.replaceAll('"', '\\"')));
  session.submissions = [{ taskId: replyTask, hash: asyncQuestion.answerIntent.hash, acceptedAt: Date.now(), acceptance: 'observed' }];
  service.sessions.emit('task-input', { session, text: replyPayload });
  await expect(panel).toHaveCount(0); assert.equal(sends, 1);
  service.sessions.input = originalInput;
  console.log(JSON.stringify({ passed: true, root, checks: ['one at a time', 'actual choices', 'exact terminal', 'changed disclosure rejected', 'verified transition', 'autohide', 'wide/narrow'] }));
} finally { for (const session of all) session.process = null; await browser.close(); await service.close(); }
