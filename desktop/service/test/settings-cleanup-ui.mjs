import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createService } from '../server.mjs';
import { Dictation } from '../dictation.mjs';
import { launchBrowser } from './browser.mjs';

await mkdir('.test-output', { recursive: true });
const repo = await mkdtemp(path.resolve('.test-output/settings-cleanup-'));
await mkdir(path.join(repo, 'workspace'));
await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[]}');
let installed = false, running = false;
const localControl = {
  state: value => ({ installed: value, running, installing: false, starting: false }),
  install: () => { installed = true; }, start: async () => { running = true; }, stop: async () => { running = false; }, close: () => {},
};
const dictation = new Dictation(repo, { localStatus: async () => installed, localControl });
const service = await createService({ repo, uiDir: path.resolve('dist'), dictationOptions: { dictation }, mcpOptions: { home: repo, env: {} } });
let browser;
try {
  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(service.urls.workspace);
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await page.getByRole('menuitem', { name: /Settings/ }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await expect(settings.getByLabel('Dictation provider')).toHaveCount(0);
  await expect(settings.getByLabel('Application theme')).toHaveCount(0);

  await settings.getByRole('tab', { name: 'Speech-to-text' }).click();
  const local = settings.getByRole('region', { name: 'Local Whisper status' });
  await expect(settings.getByLabel('Dictation provider')).toHaveValue('local');
  await expect(local.getByRole('status')).toContainText('Not installed');
  await settings.getByRole('button', { name: 'Install Local Whisper' }).click();
  await expect(local.getByRole('status')).toContainText('Installed, but stopped');
  await settings.getByRole('button', { name: 'Start Local Whisper' }).click();
  await expect(local.getByRole('status')).toContainText('Installed and running');
  await settings.getByRole('button', { name: 'Stop Local Whisper' }).click();
  await expect(local.getByRole('status')).toContainText('Installed, but stopped');

  await settings.getByRole('tab', { name: 'Voice', exact: true }).click();
  assert.equal(await settings.getByLabel('Spoken voice').locator('option').count(), 38);
  await settings.getByLabel('Spoken voice').selectOption('willow');
  await expect(settings.getByLabel('Windows reply voice').locator('option').first()).toHaveText('System default');
  await settings.getByLabel('Conversation personality').fill('Curious, inventive, and friendly.');
  await settings.getByRole('button', { name: 'Save conversation personality' }).click();
  await settings.getByLabel('Voice personality').fill('A calm, clear voice that speaks English.');
  await settings.getByRole('button', { name: 'Save personality' }).click();
  await settings.getByRole('tab', { name: 'Updates', exact: true }).click();
  await expect(settings.getByRole('heading', { name: 'Alpha updates' })).toBeVisible();
  await expect(settings.getByRole('button', { name: 'Check for updates' })).toBeVisible();

  await settings.getByRole('tab', { name: 'Theme', exact: true }).click();
  await settings.getByLabel('Background color').fill('#152536');
  await settings.getByRole('button', { name: 'Save theme' }).click();
  await expect(page.locator('html')).toHaveCSS('--bg', '#152536');
  await settings.getByRole('button', { name: 'Restore built-in' }).click();
  await expect(settings.getByRole('status')).toContainText('Built-in theme restored.');
  await settings.getByLabel('Theme to edit').selectOption('new');
  await settings.getByLabel('Theme name').fill('Evening blue');
  await settings.getByLabel('Background color').fill('#19283a');
  await settings.getByRole('button', { name: 'Create theme' }).click();
  await expect(settings.getByLabel('Application theme')).toContainText('Evening blue');
  await expect(page.locator('html')).toHaveCSS('--bg', '#19283a');
  const selected = await settings.getByLabel('Application theme').inputValue();
  assert.match(selected, /^custom-/);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-alpha-theme', selected);
  await expect(page.locator('html')).toHaveCSS('--bg', '#19283a');
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await page.getByRole('menuitem', { name: /Settings/ }).click();
  await settings.getByRole('tab', { name: 'Theme', exact: true }).click();
  await expect(settings.getByLabel('Application theme')).toHaveValue(selected);
  await settings.getByLabel('Workspace theme').selectOption('light');
  await expect(page.locator('html')).toHaveCSS('--bg', '#eaeced');
  await settings.getByLabel('Workspace theme').selectOption('dark');
  await page.setViewportSize({ width: 390, height: 820 });
  await expect(settings.getByRole('tab', { name: 'Theme', exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(repo, 'theme-settings-narrow.png') });
  await settings.getByRole('button', { name: 'Delete theme' }).click();
  await expect(settings.getByLabel('Application theme')).toHaveValue('alpha');
  assert.deepEqual(errors, []);
  const saved = JSON.parse(await readFile(path.join(repo, '.alpha/settings.json'), 'utf8'));
  assert.equal(saved.voiceName, 'willow'); assert.equal(saved.voiceStyle, 'A calm, clear voice that speaks English.');
  assert.equal(saved.conversationStyle, 'Curious, inventive, and friendly.');
  assert.equal(saved.themeProfiles.length, 0);
  console.log('Settings cleanup UI passed: separate sections, Whisper actions, 38 voices, updates, theme edit/create/delete and narrow layout.');
} finally { await browser?.close(); await service.close(); }
