// Isolated conversation check; microphone, model and speaker are mocked.
import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createService } from '../server.mjs';
import { launchBrowser } from './browser.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
await mkdir(path.join(root, '.cache'), { recursive: true });
const repo = await mkdtemp(path.join(root, '.cache', 'conversation-ui-'));
await cp(path.join(root, 'dist'), path.join(repo, 'ui'), { recursive: true });
await cp(path.join(root, 'public/assets'), path.join(repo, 'ui/assets'), { recursive: true });
await mkdir(path.join(repo, 'workspace'));
await mkdir(path.join(repo, '.alpha'));
await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[]}');
await writeFile(path.join(repo, '.alpha/settings.json'), '{"speakReplies":false,"transcribeProvider":"local"}');
const service = await createService({ repo, uiDir: path.join(repo, 'ui') });
const requests = [];
service.quick.ask = async () => null;
service.coordinator.ask = async data => {
  requests.push(data);
  const operation = { id: data.id, text: data.text, status: 'completed', result: `I'm here. ${data.text}`, at: new Date().toISOString() };
  service.coordinator.operations.set(data.id, operation);
  service.coordinator.emit('result', operation);
  return operation;
};
let browser;
try {
  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(10000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    MediaDevices.prototype.getUserMedia = async () => ({ getTracks: () => [{ stop() {} }] });
    window.MediaRecorder = class {
      static isTypeSupported() { return true }
      state = 'inactive'; mimeType = 'audio/webm';
      start() { this.state = 'recording' }
      stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['fixture'], { type: this.mimeType }) }); this.onstop?.() }
    };
  });
  await page.route('**/api/dictation', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ provider: 'local', available: true, maxBytes: 1000000, maxSeconds: 120 }) }));
  await page.route('**/api/transcribe', route => route.fulfill({ contentType: 'application/json', body: '{"text":"Voice hello"}' }));
  await page.goto(service.urls.workspace);
  const pane = page.getByRole('complementary', { name: 'Alpha replies' });
  await expect(pane).toBeVisible();
  await expect(page.locator('.mdi-chats')).toBeVisible();
  await pane.getByRole('textbox', { name: 'Message Alpha' }).fill('Hello, Alpha');
  await pane.getByRole('button', { name: 'Send to Alpha' }).click();
  await expect(pane.getByText("I'm here. Hello, Alpha")).toBeVisible();
  assert.equal(requests.at(-1).text, 'Hello, Alpha');
  service.sessions.emit('reply', { id: 'agent:turn-1', sessionId: 'agent', name: 'Coding chat', text: 'The change is ready for review.' });
  await expect(pane.getByText('The change is ready for review.')).toBeVisible();
  await pane.getByRole('button', { name: 'Dictate a message' }).click();
  await pane.getByRole('button', { name: 'Stop recording and transcribe' }).click();
  await expect(pane.getByText("I'm here. Voice hello")).toBeVisible();
  assert.equal(requests.at(-1).text, 'Voice hello');
  const beforePresence = requests.length;
  await page.getByRole('tab', { name: 'Alpha', exact: true }).click();
  await page.getByRole('button', { name: 'Talk to Alpha' }).click();
  await expect(pane.getByRole('button', { name: 'Stop recording and transcribe' })).toBeVisible();
  await page.getByRole('button', { name: 'Talk to Alpha' }).click();
  await expect.poll(() => requests.length).toBe(beforePresence + 1);
  await page.getByRole('tab', { name: 'Chat', exact: true }).click();
  await page.reload();
  await expect(pane.getByText('The change is ready for review.')).toBeVisible();
  await pane.getByRole('button', { name: "What I've learned" }).click();
  const learning = pane.getByRole('region', { name: "What I've learned" });
  await expect(learning.getByText('No saved lessons yet.')).toBeVisible();
  await learning.getByLabel('Use this for').selectOption('work');
  await learning.getByLabel('What should I do differently?').fill('Check every part of my request.');
  await learning.getByRole('button', { name: 'Remember this' }).click();
  await expect(learning.getByText('Check every part of my request.', { exact: true })).toBeVisible();
  await page.reload();
  await pane.getByRole('button', { name: "What I've learned" }).click();
  await expect(learning.getByText('Check every part of my request.', { exact: true })).toBeVisible();
  await learning.getByRole('button', { name: 'Edit lesson' }).click();
  await learning.getByLabel('What should I do differently?').fill('Check every part and name anything unfinished.');
  await learning.getByRole('button', { name: 'Save lesson' }).click();
  await expect(learning.getByText('Check every part and name anything unfinished.', { exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(repo, 'learning.png') });
  await learning.getByRole('button', { name: 'Forget lesson' }).click();
  await expect(learning.getByText('No saved lessons yet.')).toBeVisible();
  await learning.getByRole('button', { name: 'Back to our chat' }).click();
  await expect(pane.getByText('The change is ready for review.')).toBeVisible();
  const spoken = [];
  service.speech.speak = async text => { spoken.push(text); return { speaking: false, error: null }; };
  await pane.getByRole('button', { name: 'Replies muted' }).click();
  await expect(pane.getByRole('button', { name: 'Speak replies' })).toBeVisible();
  service.sessions.emit('reply', { id: 'agent:turn-2', sessionId: 'agent', name: 'Coding chat', text: 'I found a better way to handle this.' });
  await expect.poll(() => spoken.at(-1)).toBe('I found a better way to handle this.');
  await page.screenshot({ path: path.join(repo, 'conversation.png') });
  await page.setViewportSize({ width: 768, height: 800 });
  await expect(pane).toBeVisible();
  assert.ok((await pane.boundingBox()).width > 700);
  await page.screenshot({ path: path.join(repo, 'conversation-768.png') });
  assert.deepEqual(errors, []);
  console.log(`Alpha replies passed final routing, dictated send, Talk, automatic speech, lesson add/edit/forget/reload and 1280/768px layouts. Screenshot: ${path.join(repo, 'conversation.png')}`);
} finally { await browser?.close(); await service.close(); }
