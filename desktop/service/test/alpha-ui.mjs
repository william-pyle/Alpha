import { expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createService } from '../server.mjs';
import { launchBrowser } from './browser.mjs';
import { packageLibrary } from '../../../scripts/package-library.mjs';

await mkdir('.test-output', { recursive: true });
const repo = await mkdtemp(path.resolve('.test-output/alpha-workflow-'));
await mkdir(path.join(repo, 'workspace/example'), { recursive: true });
await writeFile(path.join(repo, 'workspace/example/report.html'), '<!doctype html><html data-mak-report="document"><body><h1>Example project report</h1></body></html>');
await writeFile(path.join(repo, 'workspace/workspace.json'), JSON.stringify({ entities: [{ id: 'example', title: 'Example project', folder: 'example', category: 'project', status: 'active', sample: true, created: '2026-11-08', steps: [{ name: 'Report', path: 'report.html' }] }] }));
const bundle = path.join(repo, 'library-bundle'); await packageLibrary(bundle);
const service = await createService({ repo, uiDir: path.resolve('dist'), sharedLibrary: { bundle, root: path.join(repo, 'SharedLibrary') }, mcpOptions: { home: repo, env: {}, probe: async () => ({ status: 'available' }) } });
const call = async (route, data) => {
  const response = await fetch(service.origin + '/api' + route, { method: data === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
  assert.ok(response.ok, await response.clone().text()); return response.json();
};
let browser;
try {
  browser = await launchBrowser();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(service.urls.workspace);
  await expect(page.locator('.mdi-chats')).toBeVisible();
  await expect(page.locator('.files-rail')).toHaveCount(0);
  await expect(page.locator('.voice-dock.workspace .voice-nose .mak-logo')).toHaveCount(0);
  const bootstrap = await call('/bootstrap');
  assert.deepEqual(bootstrap.agents.map(item => item.id), ['codex', 'claude', 'shell', 'gitbash']);
  for (const route of ['/mobile', '/mobile/sw.js', '/api/mobile', '/api/mobile/enable']) assert.equal((await fetch(service.origin + route)).status, 404);

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const picker = page.getByLabel('Application theme', { exact: true });
  for (const theme of ['alpha', 'smurfs', 'higurashi']) {
    await picker.selectOption(theme);
    await expect(page.locator('html')).toHaveAttribute('data-alpha-theme', theme);
    await expect(page.locator('.application-theme-preview img')).toHaveJSProperty('complete', true);
  }
  await page.getByLabel('Always approve').click();
  await expect.poll(async () => (await call('/bootstrap')).settings.defaultBypass).toBe(true);
  await page.getByRole('button', { name: 'Close settings' }).last().click();

  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  assert.equal(await page.locator('.agent-choice').count(), 4);
  await page.getByRole('button', { name: /^Git Bash/ }).click();
  await page.getByLabel(/Chat name/).fill('Git Bash check');
  await page.getByRole('button', { name: 'Open chat', exact: true }).click();
  await expect.poll(async () => (await call('/bootstrap')).sessions.length).toBe(1);
  const session = (await call('/bootstrap')).sessions[0];
  await call(`/sessions/${session.id}/input`, { text: "printf 'ALPHA_GITBASH_OK\\n'; pwd\r", paste: false });
  await expect.poll(async () => (await call(`/sessions/${session.id}/screen`)).screen, { timeout: 20000 }).toContain('ALPHA_GITBASH_OK');
  const divider = page.getByRole('separator', { name: 'Resize terminal and message editor' });
  await expect(divider).toBeVisible();
  const height = async () => (await page.locator('.chat-composer').boundingBox()).height;
  const before = await height(), box = await divider.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down(); await page.mouse.move(box.x + box.width / 2, box.y - 70, { steps: 5 }); await page.mouse.up();
  assert.ok(await height() > before + 40);
  const editor = page.getByRole('textbox', { name: 'Write a message' });
  await editor.fill("printf 'ALPHA_COMPOSER_OK\\n'");
  await editor.press('Alt+Enter');
  await expect(editor).toHaveValue("printf 'ALPHA_COMPOSER_OK\\n'\n");
  await page.waitForTimeout(2600);
  await editor.press('Enter');
  await expect.poll(async () => (await call(`/sessions/${session.id}/screen`)).screen, { timeout: 20000 }).toContain('ALPHA_COMPOSER_OK');
  await expect(editor).toHaveValue('');
  assert.equal(context.pages().length, 1);
  await expect(page.locator('.terminal-area')).toHaveCount(1);
  await expect(page.locator('.chat-composer')).toHaveCount(1);
  await page.waitForTimeout(2600);
  await editor.fill("printf 'ALPHA_MULTI_1\\n'\nprintf 'ALPHA_MULTI_2\\n'");
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(async () => (await call(`/sessions/${session.id}/screen`)).screen, { timeout: 20000 }).toContain('ALPHA_MULTI_2');
  assert.equal(context.pages().length, 1);

  await call(`/sessions/${session.id}/input`, { text: "read -p 'Should Alpha continue? ' reply; printf 'REPLY:%s\\n' \"$reply\"\r", paste: false });
  await expect(page.getByRole('region', { name: 'Questions' })).toContainText('Should Alpha continue?');
  await page.getByRole('button', { name: 'Yes', exact: true }).click();
  await page.getByRole('button', { name: 'Send answer' }).click();
  await expect.poll(async () => (await call(`/sessions/${session.id}/screen`)).screen, { timeout: 20000 }).toContain('REPLY:Yes');
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await expect(page.locator('.history-list')).toContainText('Git Bash check');
  await page.getByRole('button', { name: 'Close history', exact: true }).click();

  await page.getByText('Example project', { exact: true }).last().click();
  await expect(page.getByRole('tab', { name: 'Example project' })).toBeVisible();
  await expect(page.frameLocator('iframe.report-frame').getByRole('heading', { name: 'Example project report' })).toBeVisible();
  const saved = JSON.parse(await readFile(path.join(repo, '.alpha/settings.json')));
  assert.equal(saved.appTheme, 'higurashi'); assert.equal(saved.defaultBypass, true);
  assert.deepEqual(errors, []);
  console.log('Alpha desktop workflow passed: one window, themes, real Git Bash, editor keys, splitter, questions, history, document tabs and report.');
} finally { await browser?.close(); await service.close(); }
