import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect } from '@playwright/test';
import { createService } from '../server.mjs';
import { launchBrowser } from './browser.mjs';

const root = await mkdtemp(path.join(process.env.RUNNER_TEMP || tmpdir(), 'alpha-performance-ui-'));
const marker = 'private-fixture-filename.txt';
await writeFile(path.join(root, 'workspace.json'), '{"entities":[]}');
await writeFile(path.join(root, marker), 'Synthetic evidence.');
const service = await createService({ repo: root, uiDir: path.resolve('dist'), restoreSessions: false,
  checkUpdates: false, mcpOptions: { home: root, env: {} } });
let browser, page;
try {
  browser = await launchBrowser();
  page = await browser.newPage({ viewport: { width: 1280, height: 850 }, acceptDownloads: true });
  await page.goto(service.urls.workspace);
  await page.getByRole('button', { name: 'Settings', exact: true }).press('Enter');
  await page.getByRole('tab', { name: 'Performance Diagnostics', exact: true }).click();
  const diagnostics = page.getByRole('region', { name: 'Performance Diagnostics', exact: true });
  const enabled = diagnostics.getByRole('checkbox', { name: 'Enable Performance Diagnostics', exact: true });
  const category = diagnostics.getByRole('combobox', { name: 'Capture category', exact: true });
  const arm = diagnostics.getByRole('button', { name: 'Capture next operation', exact: true });
  const runState = diagnostics.getByRole('status');
  const lastCapture = diagnostics.getByRole('region', { name: 'Last capture', exact: true });
  const listFiles = () => page.evaluate(async ({ folder, filename }) => {
    const query = new URLSearchParams({ path: folder, mode: 'all', q: filename });
    const response = await fetch('/api/files?' + query, { headers: { Authorization: 'Bearer ' + sessionStorage.getItem('alpha.token') } });
    return { status: response.status, entries: (await response.json()).entries?.map(entry => entry.name), capture: response.headers.get('X-Alpha-Performance-Capture') };
  }, { folder: root, filename: marker });

  await expect(enabled).toBeEnabled();
  await expect(enabled).not.toBeChecked();
  await expect(category).toHaveCount(0);
  await expect(runState).toHaveText('No capture running.');
  assert.deepEqual(await listFiles(), { status: 200, entries: [marker], capture: null });

  await enabled.click();
  await expect(enabled).toBeChecked();
  await category.selectOption('workspace');
  await expect(category.getByRole('option', { name: 'Conversation input' })).toHaveCount(1);
  await arm.click();
  await expect(runState).toContainText('Waiting for Workspace or files activity.');
  await expect(arm).toBeDisabled();

  const matched = await listFiles();
  assert.equal(matched.status, 200);
  assert.deepEqual(matched.entries, [marker]);
  assert.ok(matched.capture, 'The local request must bind to the armed capture');
  await expect(runState).toHaveText('Capturing Workspace or files timing.');
  await expect(category).toBeDisabled();
  await diagnostics.getByRole('button', { name: 'Stop capture', exact: true }).click();
  await expect(runState).toHaveText('No capture running.');
  await expect(lastCapture).toContainText(/Workspace or files · stopped · \d+\.\d{2} s · \d+ retained · 0 dropped/);
  await lastCapture.getByText('Event timing (latest 60)', { exact: true }).click();
  await expect(lastCapture.getByRole('listitem').filter({ hasText: /\d+\.?\d* ms · http-start/ })).toBeVisible();
  await expect(lastCapture.getByRole('listitem').filter({ hasText: /http-finish.*ms elapsed/ })).toBeVisible();
  await expect(lastCapture.getByRole('listitem').filter({ hasText: /capture-end · stopped/ })).toBeVisible();
  await page.screenshot({ path: path.join(root, 'diagnostics-capture-wide.png') });

  const [download] = await Promise.all([page.waitForEvent('download'), lastCapture.getByRole('button', { name: 'Export JSON', exact: true }).click()]);
  assert.equal(download.suggestedFilename(), `alpha-performance-${matched.capture}.json`);
  const exported = await readFile(await download.path(), 'utf8');
  assert.ok(!exported.includes(marker) && !exported.includes(root) && !exported.includes(service.token), 'Trace must exclude private fixture values');
  const capture = JSON.parse(exported);
  assert.equal(capture.id, matched.capture);
  assert.equal(capture.outcome, 'stopped');
  assert.ok(capture.events.some(event => event.event === 'http-finish' && event.statusCode === 200 && event.durationMs >= 0));

  await category.selectOption('startup');
  await arm.click();
  await expect(runState).toContainText('Waiting for Window hydration activity.');
  const rendered = page.waitForResponse(response => response.url().endsWith('/api/performance-diagnostics/client')
    && response.status() === 204 && response.request().postDataJSON()?.event === 'ui-render');
  await page.reload();
  await rendered;
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Performance Diagnostics', exact: true }).click();
  await diagnostics.getByRole('button', { name: 'Stop capture', exact: true }).click();
  const hydration = service.diagnostics.status().last;
  assert.equal(hydration.category, 'startup');
  for (const event of ['ui-request', 'ui-response', 'ui-render']) {
    assert.ok(hydration.events.some(item => item.event === event && item.durationMs >= 0), event);
  }

  await enabled.click();
  await expect(enabled).not.toBeChecked();
  await expect(category).toHaveCount(0);
  assert.deepEqual(await listFiles(), { status: 200, entries: [marker], capture: null });
  await expect(lastCapture).toBeVisible();
  await page.setViewportSize({ width: 390, height: 850 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  const remove = lastCapture.getByRole('button', { name: 'Delete capture', exact: true });
  await remove.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(root, 'diagnostics-opt-out-narrow.png') });
  await remove.click();
  await expect(lastCapture).toHaveCount(0);
  await expect(enabled).not.toBeChecked();
  console.log(`Performance Diagnostics UI passed disabled, opt-in, arm, capture, stop, event timing, export privacy, opt-out, and deletion. Evidence: ${root}`);
} catch (error) {
  await page?.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
  console.error(`Performance Diagnostics UI fixture: ${root}`);
  throw error;
} finally {
  await browser?.close();
  await service.close();
}
