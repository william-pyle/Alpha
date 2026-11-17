// One-window interaction with isolated state and mocked model/audio.
import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createService } from '../server.mjs';
import { launchBrowser } from './browser.mjs';

await mkdir('.test-output', { recursive: true });
const repo = await mkdtemp(path.resolve('.test-output/conversations-'));
await mkdir(path.join(repo, 'workspace')); await mkdir(path.join(repo, '.alpha'));
await writeFile(path.join(repo, 'workspace/workspace.json'), JSON.stringify({ entities: [{ id: 'example', title: 'Example', folder: 'example', steps: [] }] }));
await writeFile(path.join(repo, '.alpha/settings.json'), JSON.stringify({ speakReplies: false, transcribeProvider: 'local' }));
const service = await createService({ repo, uiDir: path.resolve('dist'), mcpOptions: { home: repo, env: {} } });
const a = service.threads.create({ name: 'Architecture', projectId: 'example' });
const b = service.threads.create({ name: 'Research', projectId: 'example' }); service.threads.select(a.id);
const requests = [], spoken = [];
for (const thread of [a, b]) {
  const coordinator = await service.getCoordinator(thread.id);
  coordinator.ask = async data => {
    requests.push(data);
    const operation = { ...data, status: 'completed', result: `${thread.name}: ${data.text}`, at: new Date().toISOString() };
    coordinator.operations.set(data.id, operation); coordinator.emit('result', operation); return operation;
  };
}
service.speech.speak = async (text, voice, threadId) => { spoken.push({ text, threadId }); return { speaking: false, error: null }; };
let browser;
try {
  browser = await launchBrowser(); const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(15000); const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    MediaDevices.prototype.getUserMedia = async () => ({ getTracks: () => [{ stop() {} }] });
    window.MediaRecorder = class { static isTypeSupported() { return true } state = 'inactive'; mimeType = 'audio/webm'; start() { this.state = 'recording' } stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['fixture'], { type: this.mimeType }) }); this.onstop?.() } };
  });
  await page.route('**/api/dictation', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ provider: 'local', available: true, maxBytes: 1000000, maxSeconds: 120 }) }));
  await page.route('**/api/transcribe', route => route.fulfill({ contentType: 'application/json', body: '{"text":"Voice hello"}' }));
  await page.goto(service.urls.workspace);
  const pane = page.getByRole('region', { name: 'Alpha conversation', exact: true }), editor = pane.getByRole('textbox', { name: 'Message Alpha' }), picker = pane.getByLabel('Conversation', { exact: true });
  await expect(pane).toBeVisible(); await expect(editor).toHaveCount(1); await expect(page.locator('.chat-composer')).toHaveCount(0);
  await editor.fill('Private A'); await editor.press('Enter'); await expect(pane.getByText('Architecture: Private A', { exact: true })).toBeVisible();
  await editor.fill('Draft A'); await picker.selectOption(b.id); await expect(editor).toHaveValue('');
  await expect(pane.getByText('Architecture: Private A', { exact: true })).toHaveCount(0);
  await editor.fill('Draft B'); await picker.selectOption(a.id); await expect(editor).toHaveValue('Draft A');
  await page.reload(); await expect(editor).toHaveValue('Draft A');
  await picker.selectOption(b.id); await expect(editor).toHaveValue('Draft B');
  let finishUpload;
  await page.route('**/api/attachments', async route => { const response = await route.fetch(); finishUpload = () => route.fulfill({ response }); });
  await picker.selectOption(a.id);
  await expect(editor).toHaveValue('Draft A'); await expect(editor).toBeEnabled();
  await pane.getByLabel('Choose images for Alpha').setInputFiles({ name: 'Late upload.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/dZkAAAAASUVORK5CYII=', 'base64') });
  await expect.poll(() => !!finishUpload).toBe(true);
  await picker.selectOption(b.id); await expect(editor).toHaveValue('Draft B'); await expect(pane.getByLabel('Attached images', { exact: true })).toHaveCount(0);
  await picker.selectOption(a.id); await expect(editor).toHaveValue('Draft A'); await finishUpload();
  await expect(pane.getByLabel('Attached images', { exact: true }).locator('img')).toHaveCount(1);
  await expect(editor).toHaveValue('Draft A');
  await pane.getByRole('button', { name: /^Remove Late upload/ }).click();
  await picker.selectOption(b.id); await expect(editor).toHaveValue('Draft B');
  await page.unroute('**/api/attachments');
  service.threads.message(a.id, { id: 'late-a', role: 'assistant', text: 'A background result' });
  await expect(pane.getByText('A background result', { exact: true })).toHaveCount(0); assert.equal(spoken.length, 0);
  await picker.selectOption(a.id); await expect(pane.getByText('A background result', { exact: true })).toBeVisible(); assert.equal(spoken.length, 0);
  await editor.fill(''); await pane.getByRole('button', { name: 'Dictate a message' }).click(); await pane.getByRole('button', { name: 'Stop recording and transcribe' }).click();
  await expect(pane.getByText('Architecture: Voice hello', { exact: true })).toBeVisible(); assert.equal(requests.at(-1).threadId, a.id);
  let finishTranscription;
  await page.unroute('**/api/transcribe');
  await page.route('**/api/transcribe', route => { finishTranscription = () => route.fulfill({ contentType: 'application/json', body: '{"text":"Late voice A"}' }).catch(() => {}); });
  await pane.getByRole('button', { name: 'Dictate a message' }).click(); await pane.getByRole('button', { name: 'Stop recording and transcribe' }).click();
  await expect.poll(() => !!finishTranscription).toBe(true); const count = requests.length;
  await picker.selectOption(b.id); await finishTranscription(); await expect(editor).toHaveValue('Draft B'); assert.equal(requests.length, count);
  await picker.selectOption(a.id);
  await pane.locator('.alpha-conversation-reply').filter({ hasText: 'A background result' }).getByRole('button', { name: 'Share this message' }).click();
  await page.getByLabel('Destination').selectOption(b.id); await page.getByRole('button', { name: 'Share this text', exact: true }).click();
  await picker.selectOption(b.id); await expect(pane.getByText(/Reference explicitly shared from Architecture:/)).toContainText('A background result');
  assert.equal(requests.length, count); await expect(pane.getByText('Architecture: Private A', { exact: true })).toHaveCount(0);
  service.awareness.event({ id: 'attention-a', threadId: a.id, kind: 'question', text: 'A decision needs review.', source: 'Fixture question event' });
  await pane.locator('.thread-attention summary').click(); await expect(pane.getByText('A decision needs review.', { exact: true })).toBeVisible();
  await pane.locator('.thread-attention article').filter({ hasText: 'A decision needs review.' }).getByRole('button', { name: 'Dismiss', exact: true }).click(); await page.reload(); await pane.locator('.thread-attention summary').click();
  await expect(pane.getByText('A decision needs review.', { exact: true })).toHaveCount(0);
  await pane.getByRole('button', { name: 'Quiet mode' }).click(); await expect.poll(() => service.awareness.settings.quiet).toBe(true);
  await pane.locator('.thread-attention summary').click();
  await pane.getByRole('button', { name: "What I've learned" }).click(); const learning = pane.getByRole('region', { name: "What I've learned" });
  await learning.getByLabel('Use this for').selectOption('work'); await learning.getByLabel('What should I do differently?').fill('Name anything unfinished.'); await learning.getByRole('button', { name: 'Remember this' }).click();
  await expect(learning.getByText('Name anything unfinished.', { exact: true })).toBeVisible();
  await learning.getByRole('button', { name: 'Forget lesson' }).click(); await expect(learning.getByText('No saved lessons yet.')).toBeVisible(); await learning.getByRole('button', { name: 'Back to our chat' }).click();
  await page.screenshot({ path: path.join(repo, 'conversations-wide.png') });
  for (const width of [768, 390]) { await page.setViewportSize({ width, height: 1000 }); await expect(pane).toBeVisible(); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false); await page.screenshot({ path: path.join(repo, `conversations-${width}.png`) }); }
  assert.deepEqual(errors, []); console.log(`Thread UI passed isolation, drafts, late voice, sharing, awareness and learning. Evidence: ${repo}`);
} finally { await browser?.close(); await service.close(); }
