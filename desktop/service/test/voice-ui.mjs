import { tmpdir as isolatedTmpdir } from 'node:os';
// No microphone, paid model request, native terminal or personal workspace is used.
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createService } from '../server.mjs';
import { launchBrowser } from './browser.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
await mkdir(path.join(root, '.cache'), { recursive: true });
const repo = await mkdtemp(path.join(process.env.RUNNER_TEMP || isolatedTmpdir(), 'alpha-voice-ui-'));
await mkdir(path.join(repo, 'workspace'));
await mkdir(path.join(repo, '.alpha'));
await writeFile(path.join(repo, '.alpha/settings.json'), '{"speakReplies":false}');
const uiDir = path.join(repo, 'ui');
await cp(path.join(root, 'dist'), uiDir, { recursive: true });
await cp(path.join(root, 'public/assets'), path.join(uiDir, 'assets'), { recursive: true });
await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[]}');
const service = await createService({ repo, uiDir, mcpOptions: { home: repo, env: {} } });
const requests = [];
const thread = service.threads.create({ name: 'Voice input', projectId: 'fixture' });
service.threads.select(thread.id);
const coordinator = await service.getCoordinator(thread.id);
let fail = false;
coordinator.ask = async data => {
  requests.push(data);
  const operation = { ...data, at: new Date().toISOString(), status: 'completed', result: 'Fixture completed.' };
  coordinator.operations.set(data.id, operation);
  coordinator.emit('result', operation);
  return operation;
};
service.quick.ask = async () => null;
const imageBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jvWQAAAAASUVORK5CYII=';
let browser;
try {
  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 650, height: 800 } });
  page.setDefaultTimeout(10000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.fixtureMicRequests = 0;
    // Patch the prototype: WebKit ignores an own-property override on navigator.mediaDevices.
    MediaDevices.prototype.getUserMedia = async () => { window.fixtureMicRequests++; throw new DOMException('Permission denied', 'NotAllowedError'); };
  });
  await page.route('**/api/threads/*/input', route => fail ? route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Fixture request failed. Please retry."}' }) : route.continue());
  for (const surface of ['chats', 'workspace']) {
    await page.goto(service.urls[surface]);
    await page.route('**/api/dictation', route => route.fulfill({ contentType: 'application/json', body: '{"provider":"local","available":true,"maxSeconds":120,"maxBytes":1000000}' }));
    await page.reload();
    await page.getByRole('button', { name: 'Tools', exact: true }).click(); await page.getByRole('menuitem', { name: 'Settings' }).click(); await page.getByRole('tab', { name: 'Conversation', exact: true }).click();
    await page.getByRole('button', { name: 'Dictate a message', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Allow microphone access' }).waitFor();
    await page.getByRole('button', { name: 'Dismiss voice input error' }).click();
    assert.equal(await page.evaluate(() => window.fixtureMicRequests), 1);
    await page.getByRole('button', { name: 'Close settings' }).click();
    const input = page.getByRole('textbox', { name: 'Message Alpha' });
    const before = requests.length;
    await input.fill('First line'); await input.press('Shift+Enter'); await input.pressSequentially('Second line');
    assert.equal(await input.inputValue(), 'First line\nSecond line'); assert.equal(requests.length, before);
    await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true });
    assert.equal(requests.length, before);
    assert.equal(await input.inputValue(), 'First line\nSecond line');
    await input.press('Enter');
    await page.waitForFunction(() => document.querySelector('.voice-compose textarea')?.value === '');
    assert.equal(requests.at(-1).text, 'First line\nSecond line'); assert.equal(requests.length, before + 1);

    await input.fill('Review this screenshot');
    await input.evaluate((element, encoded) => {
      const bytes = Uint8Array.from(atob(encoded), value => value.charCodeAt(0));
      const clipboardData = new DataTransfer(); clipboardData.items.add(new File([bytes], 'Screenshot.png', { type: 'image/png' }));
      element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
    }, imageBase64);
    const attached = page.getByLabel('Attached images', { exact: true });
    await attached.locator('img').waitFor();
    await page.waitForFunction(() => !document.querySelector('.voice-compose button[type=submit]').disabled);
    await attached.getByRole('link').click(); await page.getByRole('dialog', { name: 'Image preview' }).waitFor();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.screenshot({ path: path.join(repo, `composer-${surface}.png`) });
    fail = true;
    await input.press('Enter');
    await page.getByRole('alert').filter({ hasText: 'Fixture request failed' }).waitFor();
    assert.equal(await input.inputValue(), 'Review this screenshot'); assert.equal(await attached.locator('img').count(), 1);
    await page.getByRole('button', { name: 'Dismiss message error' }).click();
    fail = false; await input.press('Enter');
    await page.waitForFunction(() => document.querySelector('.voice-compose textarea')?.value === '');
    assert.equal(await attached.count(), 0);
    assert.equal(requests.at(-1).images.length, 1);
    const saved = requests.at(-1).images[0];
    assert.ok(saved.startsWith(path.join(repo, 'inbox/attachments') + path.sep));
    assert.deepEqual(await readFile(saved), Buffer.from(imageBase64, 'base64'));
    await page.getByLabel('Sent images', { exact: true }).last().locator('img').waitFor();

    await page.locator('input[type=file][aria-label="Choose images for Alpha"]').setInputFiles({ name: 'Reference.png', mimeType: 'image/png', buffer: Buffer.from(imageBase64, 'base64') });
    await attached.locator('img').waitFor();
    await attached.getByRole('button', { name: /^Remove / }).click();
    assert.equal(await attached.count(), 0);
  }
  assert.deepEqual(errors, []);
  console.log('Alpha conversation input passed newline/send/IME, errors, images, retry and draft retention through both compatible routes to the same window.');
  console.log(`Screenshots: ${repo}`);
} finally { await browser?.close(); await service.close(); }
