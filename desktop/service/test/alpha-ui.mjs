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

  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await page.getByRole('menuitem', { name: /Settings/ }).click();
  await page.getByRole('tab', { name: 'Theme', exact: true }).click();
  const picker = page.getByLabel('Application theme', { exact: true });
  for (const theme of ['alpha', 'smurfs', 'higurashi']) {
    await picker.selectOption(theme);
    await expect(page.locator('html')).toHaveAttribute('data-alpha-theme', theme);
    await expect(page.locator('.application-theme-preview img')).toHaveJSProperty('complete', true);
  }
  await page.getByRole('tab', { name: 'General', exact: true }).click();
  await page.getByLabel('Always approve').click();
  await expect.poll(async () => (await call('/bootstrap')).settings.defaultBypass).toBe(true);
  await page.getByRole('button', { name: 'Close settings' }).last().click();

  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await page.getByText('Advanced launchers', { exact: true }).click();
  await page.getByRole('button', { name: 'New native conversation', exact: true }).click();
  assert.equal(await page.locator('.agent-choice').count(), 4);
  await page.getByRole('button', { name: /^Git Bash/ }).click();
  await page.getByLabel(/Chat name/).fill('Git Bash check');
  await page.getByLabel('Project for new chat').selectOption('example');
  await page.getByRole('button', { name: 'Open chat', exact: true }).click();
  await expect.poll(async () => (await call('/bootstrap')).sessions.length).toBe(1);
  const session = (await call('/bootstrap')).sessions[0];
  await call(`/sessions/${session.id}/input`, { text: "printf 'ALPHA_GITBASH_OK\\n'; pwd\r", paste: false });
  await expect.poll(async () => (await call(`/sessions/${session.id}/screen`)).screen, { timeout: 20000 }).toContain('ALPHA_GITBASH_OK');
  await page.locator(`#conversation-tab-${session.id}`).click();
  await page.locator('.conversation-tabs [aria-selected=true]').click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Work details', exact: true }).click();
  await expect(page.locator('.worker-terminal:visible')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enable terminal controls' })).toBeVisible();
  await page.getByRole('button', { name: 'Close Work details' }).click(); await page.getByRole('button', { name: 'View', exact: true }).click(); await page.getByRole('menuitem', { name: 'Workspace', exact: true }).click();
  const sideDivider = page.getByRole('separator', { name: 'Resize Chats sidebar' });
  const sideBefore = (await page.locator('.mdi-chats').boundingBox()).width;
  const sideBox = await sideDivider.boundingBox();
  await page.mouse.move(sideBox.x + sideBox.width / 2, sideBox.y + sideBox.height / 2);
  await page.mouse.down(); await page.mouse.move(sideBox.x + sideBox.width / 2 + 80, sideBox.y + sideBox.height / 2, { steps: 5 }); await page.mouse.up();
  const sideAfter = (await page.locator('.mdi-chats').boundingBox()).width;
  assert.ok(sideAfter > sideBefore + 40);
  await expect.poll(async () => JSON.parse(await readFile(path.join(repo, '.alpha/settings.json'))).chatSidebarWidth).toBe(Math.round(sideAfter));
  const editor = page.getByRole('textbox', { name: 'Message Alpha' });
  await editor.fill("printf 'ALPHA_COMPOSER_OK\\n'");
  await editor.press('Shift+Enter');
  await expect(editor).toHaveValue("printf 'ALPHA_COMPOSER_OK\\n'\n");
  await page.waitForTimeout(2600);
  await editor.press('Enter');
  await expect.poll(async () => (await call(`/sessions/${session.id}/screen`)).screen, { timeout: 20000 }).toContain('ALPHA_COMPOSER_OK');
  await expect(editor).toHaveValue('');

  const droppedSource = path.join(repo, 'Dropped source.png');
  await writeFile(droppedSource, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/dZkAAAAASUVORK5CYII=', 'base64'));
  await editor.fill('echo DROP ');
  await editor.evaluate((input, source) => {
    const rect = input.getBoundingClientRect();
    window.dispatchEvent(new CustomEvent('alpha-file-drop', { detail: { phase: 'drop', paths: [source], x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } }));
  }, droppedSource);
  await expect(page.getByLabel('Attached images', { exact: true }).locator('img')).toHaveCount(1);
  const droppedPath = JSON.parse(await page.evaluate(id => localStorage.getItem('alpha.threadDraft.' + id), session.id)).paths[0];
  assert.deepEqual(await readFile(droppedPath), await readFile(droppedSource));
  await editor.fill('echo BROWSER DROP ');
  await editor.evaluate(input => {
    const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/dZkAAAAASUVORK5CYII='), char => char.charCodeAt(0));
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File([bytes], 'Browser drop.png', { type: 'image/png' }));
    input.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
  });
  await expect(page.getByLabel('Attached images', { exact: true }).locator('img')).toHaveCount(2);
  await page.getByLabel('Attached images', { exact: true }).getByRole('button', { name: /^Remove / }).first().click();
  await page.getByLabel('Attached images', { exact: true }).getByRole('button', { name: /^Remove / }).first().click();
  await editor.fill('');
  assert.equal(context.pages().length, 1);
  await expect(page.locator('.terminal-area')).toHaveCount(0);
  await expect(page.locator('.mak-composer')).toHaveCount(1);
  await page.waitForTimeout(2600);
  await editor.fill("printf 'ALPHA_MULTI_1\\n'\nprintf 'ALPHA_MULTI_2\\n'");
  await page.getByRole('button', { name: 'Send to Alpha', exact: true }).click();
  await expect.poll(async () => (await call(`/sessions/${session.id}/screen`)).screen, { timeout: 20000 }).toContain('ALPHA_MULTI_2');
  assert.equal(context.pages().length, 1);

  await editor.fill('echo IMAGE ');
  await editor.evaluate(input => {
    const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/dZkAAAAASUVORK5CYII='), char => char.charCodeAt(0));
    const clipboardData = new DataTransfer();
    clipboardData.items.add(new File([bytes], 'Screenshot.png', { type: 'image/png' }));
    input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
  });
  await expect(page.getByLabel('Attached images', { exact: true }).locator('img')).toHaveCount(1);
  const imagePath = JSON.parse(await page.evaluate(id => localStorage.getItem('alpha.threadDraft.' + id), session.id)).paths[0];
  assert.deepEqual([...await readFile(imagePath)].slice(0, 8), [137, 80, 78, 71, 13, 10, 26, 10]);
  await expect.poll(async () => (await call(`/sessions/${session.id}/screen`)).screen).not.toContain('IMAGE ');
  await page.waitForTimeout(2600);
  await editor.press('Enter');
  await expect.poll(async () => (await call(`/sessions/${session.id}/screen`)).screen, { timeout: 20000 }).toContain('IMAGE ');
  await expect(editor).toHaveValue('');

  await call(`/sessions/${session.id}/input`, { text: "read -p 'Should Alpha continue? ' reply; printf 'REPLY:%s\\n' \"$reply\"\r", paste: false });
  await expect(page.getByRole('region', { name: 'Questions' })).toContainText('Should Alpha continue?');
  await page.getByRole('button', { name: 'Yes', exact: true }).click();
  await page.getByRole('button', { name: 'Send answer' }).click();
  await expect.poll(async () => (await call(`/sessions/${session.id}/screen`)).screen, { timeout: 20000 }).toContain('REPLY:Yes');
  await expect(page.getByRole('region', { name: 'Questions' })).toHaveCount(0);
  await page.locator('.conversation-tabs [aria-selected=true]').click({ button: 'right' }); await page.getByRole('menuitem', { name: 'History', exact: true }).click();
  await expect(page.getByRole('tablist', { name: 'Conversations' })).toContainText('Git Bash check');
  await expect(page.getByRole('button', { name: 'Older mixed Alpha history' })).toBeVisible();
  await page.getByRole('button', { name: 'Close Conversation history' }).click();

  await page.getByText('Example project', { exact: true }).last().click();
  await expect(page.getByRole('tab', { name: 'Example project' })).toBeVisible();
  await expect(page.frameLocator('iframe.report-frame').getByRole('heading', { name: 'Example project report' })).toBeVisible();
  const saved = JSON.parse(await readFile(path.join(repo, '.alpha/settings.json')));
  assert.equal(saved.appTheme, 'higurashi'); assert.equal(saved.defaultBypass, true);
  const freshContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const freshPage = await freshContext.newPage();
    await freshPage.goto(service.urls.workspace); await freshPage.getByRole('button', { name: 'View', exact: true }).click(); await freshPage.getByRole('menuitem', { name: 'Workspace', exact: true }).click();
    await expect(freshPage.locator('.mak-composer')).toBeVisible();
    assert.equal(Math.round((await freshPage.locator('.mdi-chats').boundingBox()).width), saved.chatSidebarWidth);
    await expect(freshPage.locator('.mdi-menu-bar .mdi-menu-title, .mdi-menu-bar .mdi-menu-settings')).toHaveCount(0);
  } finally { await freshContext.close(); }
  assert.deepEqual(errors, []);
  console.log('Alpha desktop workflow passed: one window, themes, real Git Bash, one composer, Activity, editor keys and image paste/drop, persisted sidebar, questions, history, document tabs and report.');
} finally { await browser?.close(); await service.close(); }
