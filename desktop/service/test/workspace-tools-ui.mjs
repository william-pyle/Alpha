import { tmpdir as isolatedTmpdir } from 'node:os';
// Isolated desktop UI check. No owner application or Workspace process is used.
import { expect } from '@playwright/test';
import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createService } from '../server.mjs';
import { launchBrowser } from './browser.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
await mkdir(path.join(root, '.cache'), { recursive: true });
const repo = await mkdtemp(path.join(process.env.RUNNER_TEMP || isolatedTmpdir(), 'alpha-workspace-tools-ui-'));
await cp(path.join(root, 'dist'), path.join(repo, 'ui'), { recursive: true });
await cp(path.join(root, 'public/assets'), path.join(repo, 'ui/assets'), { recursive: true });
await mkdir(path.join(repo, 'workspace', 'sample'), { recursive: true });
await writeFile(path.join(repo, 'workspace', 'sample', 'report.html'), '<!doctype html><title>Report</title><h1>Sample Overview</h1>');
await writeFile(path.join(repo, 'task.mjs'), 'import { writeFile } from "node:fs/promises"; await writeFile("ran.txt", "yes");');
await writeFile(path.join(repo, 'workspace', 'workspace.json'), JSON.stringify({ entities: [{ id: 'sample', title: 'Sample', description: 'Tool UI', category: 'dev', type: 'group', status: 'active', created: '2026-11-16', folder: 'sample', steps: [{ name: 'Overview', path: 'report.html' }, { name: 'Details', path: 'report.html' }], tools: [{ id: 'task', name: 'Fixture task', kind: 'one-shot', start: { executable: process.execPath, args: ['task.mjs'], cwd: repo }, launches: [{ id: 'site', name: 'Open site', type: 'url', target: 'https://example.com/' }] }] }] }));
const service = await createService({ repo, uiDir: path.join(repo, 'ui') });
let browser;
try {
  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(service.urls.workspace + '#/sample/0');
  const tools = page.getByRole('region', { name: 'Workspace tools' });
  await expect(tools.getByText('Fixture task')).toBeVisible();
  await expect(tools.getByText('Stopped')).toBeVisible();
  await tools.getByRole('button', { name: 'Run' }).click();
  await expect(tools.getByText('Last run: completed')).toBeVisible();
  await page.getByRole('button', { name: 'Details', exact: true }).click();
  await expect(tools).toHaveCount(0);
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await expect(tools).toBeVisible();
  await expect(page.frameLocator('iframe.report-frame').getByRole('heading', { name: 'Sample Overview' })).toBeVisible();
  if (errors.length) throw new Error(errors.join('\n'));
  console.log('Workspace tool controls passed Overview placement, Run result, tab navigation and 390px layout.');
} finally { await browser?.close(); await service.close(); }
