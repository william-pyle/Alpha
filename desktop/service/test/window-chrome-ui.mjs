import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createService } from '../server.mjs';
import { launchBrowser } from './browser.mjs';

const repo = await mkdtemp(path.resolve('.test-output/window-chrome-ui-'));
await mkdir(path.join(repo, 'workspace')); await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[]}');
const commands = [], service = await createService({ repo, uiDir: path.resolve('dist'), native: event => commands.push(event), mcpOptions: { home: repo, env: {} } });
const update = maximized => service.nativeMessage({ type: 'window-state', nativeWindow: { available: true, maximized, minimized: false } });
const thread = service.threads.create({ name: 'Review native window layout', projectId: 'fixture' }); service.threads.select(thread.id); service.threads.message(thread.id, { id: 'fixture-reply', role: 'assistant', text: '## Window controls\n\nThe existing top bar contains window commands. The writing area remains resizable.' });
update(false); let browser;
try {
  browser = await launchBrowser(); const page = await browser.newPage({ viewport: { width: 960, height: 800 } });
  await page.goto(service.urls.workspace);
  await expect(page.locator('.mdi-menu-bar')).toHaveCount(1); await expect(page.getByRole('button', { name: 'Maximize window', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Maximize window', exact: true }).click(); assert.equal(commands.at(-1).action, 'toggle-maximize');
  // The icon follows observed host state, never the requested action alone.
  await expect(page.getByRole('button', { name: 'Maximize window', exact: true })).toBeVisible(); update(true);
  await expect(page.getByRole('button', { name: 'Restore window', exact: true })).toHaveAttribute('title', 'Restore');
  await page.getByRole('button', { name: 'Restore window', exact: true }).press('Enter'); update(false);
  await page.getByRole('button', { name: 'Minimize window', exact: true }).click(); assert.equal(commands.at(-1).action, 'minimize');
  await page.getByRole('button', { name: 'Close window', exact: true }).click(); assert.equal(commands.at(-1).action, 'close');
  const drag = page.getByLabel('Window drag area'); await drag.dblclick(); assert.equal(commands.at(-1).action, 'toggle-maximize');
  const rect = await drag.boundingBox(); await page.mouse.move(rect.x + 10, rect.y + 15); await page.mouse.down(); await page.mouse.move(rect.x + 35, rect.y + 15, { steps: 5 }); await page.mouse.up();
  await expect.poll(() => commands.at(-1).action).toBe('drag');
  const count = commands.length; await page.getByRole('button', { name: 'File', exact: true }).click(); assert.equal(commands.length, count); await page.keyboard.press('Escape');
  await page.keyboard.press('Alt+Space'); await expect.poll(() => commands.at(-1).action).toBe('system-menu');
  for (const theme of ['dark', 'light']) {
    await page.getByRole('button', { name: 'Tools', exact: true }).click(); await page.getByRole('menuitem', { name: 'Settings' }).click(); await page.getByRole('tab', { name: 'Theme', exact: true }).click(); await page.getByLabel('Workspace theme', { exact: true }).selectOption(theme); await page.getByRole('button', { name: 'Close settings' }).click();
    for (const width of [960, 390]) { await page.setViewportSize({ width, height: 700 }); await expect(page.getByRole('button', { name: 'Close window', exact: true })).toBeVisible(); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false); await page.screenshot({ path: path.join(repo, `${theme}-${width}.png`) }); }
  }
  await writeFile(path.join(repo, 'results.json'), JSON.stringify({ status: 'passed', fixtureOnly: true, checks: ['Single existing top bar; native command dispatch; observed-state icon/tooltip; pointer drag/double-click; menu clicks not dragging; keyboard system menu; narrow light/dark'], commands: commands.filter(event => event.type === 'window').map(event => event.action) }, null, 2));
  console.log(`Window chrome browser regression passed: ${repo}`);
} finally { await browser?.close(); await service.close(); }
