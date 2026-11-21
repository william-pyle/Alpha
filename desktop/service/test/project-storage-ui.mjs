// Isolated UI fixture: API calls are mocked and no live project directory is touched.
import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createService } from '../server.mjs';
import { launchBrowser } from './browser.mjs';

await mkdir('.test-output', { recursive: true });
const repo = await mkdtemp(path.join(process.env.RUNNER_TEMP || tmpdir(), 'alpha-project-storage-ui-'));
await mkdir(path.join(repo, 'workspace'), { recursive: true });
await mkdir(path.join(repo, '.alpha'), { recursive: true });
const entities = [
  { id: 'fixture', title: 'Storage fixture', folder: 'fixture', status: 'active', category: 'research', created: '2026-11-21', updated: '2026-11-21', pinned: true, steps: [] },
  { id: 'blocked', title: 'Active worker fixture', folder: 'blocked', status: 'active', category: 'research', created: '2026-11-21', updated: '2026-11-21', pinned: false, steps: [] },
  { id: 'failed', title: 'Failed measurement fixture', folder: 'failed', status: 'active', category: 'research', created: '2026-11-21', updated: '2026-11-21', pinned: false, steps: [] },
];
await writeFile(path.join(repo, 'workspace/workspace.json'), JSON.stringify({ entities }));
await writeFile(path.join(repo, '.alpha/settings.json'), JSON.stringify({ speakReplies: false, viewerEnabled: false }));
const service = await createService({ repo, uiDir: path.resolve('dist'), mcpOptions: { home: repo, env: {} } });
const calls = { inventory: 0, refresh: [], cleanup: [], remove: [] };
let browser, page;
try {
  browser = await launchBrowser();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(12_000);
  await page.route('**/api/workspace/storage', async route => {
    calls.inventory += 1;
    const pending = calls.inventory === 1;
    await new Promise(resolve => setTimeout(resolve, 30));
    return route.fulfill({ json: { projects: [
      { id: 'fixture', status: pending ? 'scanning' : 'ready', ...(pending ? {} : { allocatedBytes: 1_610_612_736, logicalBytes: 2_147_483_648, measuredAt: '2026-11-21T12:00:00.000Z' }) },
      { id: 'blocked', status: 'ready', allocatedBytes: 12_582_912, logicalBytes: 13_000_000 },
      { id: 'failed', status: 'error', error: 'Fixture read failed' },
    ] } });
  });
  await page.route('**/api/workspace/projects/*/storage', async route => {
    calls.refresh.push({ url: route.request().url(), body: route.request().postDataJSON() });
    return route.fulfill({ json: { id: 'fixture', status: 'ready', allocatedBytes: 1_073_741_824, logicalBytes: 1_200_000_000 } });
  });
  await page.route('**/api/workspace/projects/*/build-cleanup', async route => {
    if (route.request().method() === 'POST') {
      calls.cleanup.push(route.request().postDataJSON());
      return route.fulfill({ json: { removed: ['github/target', 'workspace/dist'], logicalBytes: 805_306_368, message: 'Generated build folders cleared.' } });
    }
    const noEligible = route.request().url().includes('/failed/');
    return route.fulfill({ json: { id: noEligible ? 'failed' : 'fixture', root: path.join(repo, `projects/${noEligible ? 'failed' : 'fixture'}`), candidates: noEligible ? [] : [{ path: 'github/target', logicalBytes: 536_870_912 }, { path: 'workspace/dist', logicalBytes: 268_435_456 }], skipped: [{ path: noEligible ? 'github/.cache/repository-fixture' : 'github/.cache/nested-checkout', reason: 'Contains a nested Git repository and was preserved.' }], previewToken: noEligible ? 'failed-preview-token' : 'fixture-preview-token' } });
  });
  await page.route('**/api/workspace/projects/*/deletion', route => {
    const blocked = route.request().url().includes('/blocked/');
    const retry = route.request().url().includes('/failed/');
    const id = blocked ? 'blocked' : retry ? 'failed' : 'fixture';
    return route.fulfill({ json: { id, root: path.join(repo, `projects/${id}`), ...(blocked ? { blockedReason: 'Stop the active fixture worker before deleting local files.' } : {}), ...(retry ? { retry: true } : {}) } });
  });
  await page.route('**/api/workspace/projects/*/remove', async route => {
    calls.remove.push(route.request().postDataJSON());
    return route.fulfill({ json: { removed: true } });
  });

  await page.goto(service.urls.workspace);
  const fixture = page.locator('.entity-card-wrap[data-card="fixture"]');
  const blocked = page.locator('.entity-card-wrap[data-card="blocked"]');
  const failed = page.locator('.entity-card-wrap[data-card="failed"]');
  await expect(fixture.getByText('Measuring…', { exact: true })).toBeVisible();
  await expect(fixture.getByText('1.50 GiB on disk', { exact: true })).toBeVisible();
  await expect(fixture.locator('.project-storage-size')).toHaveAttribute('title', /Logical size: 2.00 GiB/);
  await expect(blocked.getByText('12.0 MiB on disk', { exact: true })).toBeVisible();
  await expect(failed.getByText('Unavailable', { exact: true })).toBeVisible();
  await expect(failed.locator('.project-storage-size')).toHaveAttribute('title', /Fixture read failed/);
  await expect(page.locator('.entity-card-wrap[data-card="conversations"]').getByText('Unavailable', { exact: true })).toBeVisible();
  assert.ok(calls.inventory >= 2, 'Storage inventory should poll while a row is scanning.');
  const beforeFocus = calls.inventory;
  await page.evaluate(() => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('focus')); });
  await expect.poll(() => calls.inventory).toBe(beforeFocus + 1);
  await page.screenshot({ path: path.join(repo, 'project-storage-cards.png') });
  await page.setViewportSize({ width: 960, height: 720 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  await expect(fixture.locator('.project-storage-size')).toBeVisible();
  await page.screenshot({ path: path.join(repo, 'project-storage-cards-narrow.png') });
  await page.setViewportSize({ width: 1440, height: 900 });

  await fixture.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Refresh size on disk', exact: true }).click();
  await expect(fixture.getByText('1.00 GiB on disk', { exact: true })).toBeVisible();
  assert.equal(calls.refresh.length, 1);

  await fixture.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Clear build folders…', exact: true }).click();
  const cleanup = page.getByRole('dialog', { name: 'Clear build folders: Storage fixture', exact: true });
  await expect(cleanup.getByText('github/target', { exact: true })).toBeVisible();
  await expect(cleanup.getByText('workspace/dist', { exact: true })).toBeVisible();
  await expect(cleanup.getByText(/sources and the.*repository are not deleted/i)).toBeVisible();
  const preserved = cleanup.getByText('Preserved folders (1)', { exact: true });
  await expect(preserved).toBeVisible();
  await expect(cleanup.getByText('github/.cache/nested-checkout', { exact: true })).toBeHidden();
  const cleanupButton = cleanup.getByRole('button', { name: 'Clear listed build folders', exact: true });
  await expect(cleanupButton).toBeDisabled();
  await cleanup.getByRole('textbox', { name: 'Confirm build cleanup project ID', exact: true }).fill('fixture');
  await expect(cleanupButton).toBeEnabled();
  await page.screenshot({ path: path.join(repo, 'build-cleanup-preview.png') });
  await preserved.click();
  await expect(cleanup.getByText('github/.cache/nested-checkout', { exact: true })).toBeVisible();
  await expect(cleanup.getByText(/Contains a nested Git repository/)).toBeVisible();
  await page.screenshot({ path: path.join(repo, 'build-cleanup-preserved.png') });
  await cleanupButton.click();
  await expect(cleanup.getByText(/Removed 768 MiB of generated file data.*Disk usage is being refreshed/)).toBeVisible();
  assert.deepEqual(calls.cleanup, [{ confirmation: 'fixture', previewToken: 'fixture-preview-token' }]);
  await cleanup.getByRole('button', { name: 'Close', exact: true }).click();

  await blocked.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete project...', exact: true }).click();
  const blockedDelete = page.getByRole('dialog', { name: 'Delete project: Active worker fixture', exact: true });
  await expect(blockedDelete.getByText(/Stop the active fixture worker/)).toBeVisible();
  await expect(blockedDelete.getByRole('radio', { name: /Delete local project files/ })).toBeDisabled();
  await blockedDelete.getByRole('button', { name: 'Cancel', exact: true }).click();

  await failed.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete project...', exact: true }).click();
  const retryDelete = page.getByRole('dialog', { name: 'Delete project: Failed measurement fixture', exact: true });
  await expect(retryDelete.getByText(/Local deletion is incomplete/)).toBeVisible();
  await expect(retryDelete.getByText(/Do not start future work/)).toBeVisible();
  await expect(retryDelete.getByRole('radio', { name: /Retry local project deletion/ })).toBeChecked();
  await expect(retryDelete.getByRole('button', { name: 'Retry local deletion', exact: true })).toBeDisabled();
  await retryDelete.getByRole('button', { name: 'Cancel', exact: true }).click();

  await failed.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Clear build folders…', exact: true }).click();
  const noEligibleCleanup = page.getByRole('dialog', { name: 'Clear build folders: Failed measurement fixture', exact: true });
  await expect(noEligibleCleanup.getByText('No generated build folders are available to clear.', { exact: true })).toBeVisible();
  await expect(noEligibleCleanup.getByText('Preserved folders (1)', { exact: true })).toBeVisible();
  await expect(noEligibleCleanup.getByRole('button', { name: 'Clear listed build folders', exact: true })).toHaveCount(0);
  await noEligibleCleanup.getByText('Preserved folders (1)', { exact: true }).click();
  await expect(noEligibleCleanup.getByText('github/.cache/repository-fixture', { exact: true })).toBeVisible();
  await noEligibleCleanup.getByRole('button', { name: 'Cancel', exact: true }).click();

  await fixture.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete project...', exact: true }).click();
  const deletion = page.getByRole('dialog', { name: 'Delete project: Storage fixture', exact: true });
  await deletion.getByRole('radio', { name: /Delete local project files/ }).click();
  await expect(deletion.getByText(/GitHub repository is never deleted/)).toBeVisible();
  await expect(deletion.getByText(new RegExp('projects[\\\\/]fixture'))).toBeVisible();
  const deleteButton = deletion.getByRole('button', { name: 'Delete local files and project', exact: true });
  await expect(deleteButton).toBeDisabled();
  await deletion.getByRole('textbox', { name: 'Confirm project ID', exact: true }).fill('wrong');
  await expect(deleteButton).toBeDisabled();
  await deletion.getByRole('textbox', { name: 'Confirm project ID', exact: true }).fill('fixture');
  await expect(deleteButton).toBeEnabled();
  await page.screenshot({ path: path.join(repo, 'delete-local-project.png') });
  await deleteButton.click();
  await expect(deletion).toBeHidden();
  assert.deepEqual(calls.remove, [{ scope: 'delete-files', confirmation: 'fixture' }]);

  console.log(JSON.stringify({ status: 'passed', fixtureOnly: true, evidence: repo, calls }));
} catch (error) {
  await page?.screenshot({ path: path.join(repo, 'failure.png') });
  console.error(`Project storage UI evidence: ${repo}`);
  throw error;
} finally {
  await browser?.close();
  await service.close();
}
