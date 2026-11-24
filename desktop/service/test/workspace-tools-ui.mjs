import { tmpdir as isolatedTmpdir } from 'node:os';
// Isolated desktop UI check. No owner application or Workspace process is used.
import { expect } from '@playwright/test';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createService } from '../server.mjs';
import { launchBrowser } from './browser.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
await mkdir(path.join(root, '.cache'), { recursive: true });
const repo = await mkdtemp(path.join(process.env.RUNNER_TEMP || isolatedTmpdir(), 'alpha-workspace-tools-ui-'));
await cp(process.env.ALPHA_WORKSPACE_TOOLS_TEST_UI || path.join(root, 'dist'), path.join(repo, 'ui'), { recursive: true });
await cp(path.join(root, 'public/assets'), path.join(repo, 'ui/assets'), { recursive: true });
await mkdir(path.join(repo, 'workspace', 'sample'), { recursive: true });
await writeFile(path.join(repo, 'workspace', 'sample', 'report.html'), '<!doctype html><title>Report</title><h1>Sample Overview</h1>');
await writeFile(path.join(repo, 'workspace', 'sample', 'details.html'), `<!doctype html>
<title>Details</title>
<meta name="alpha-workspace-tools" content="task, unknown, other-card">
<h1>Sample Details</h1>`);
await writeFile(path.join(repo, 'task.mjs'), `
import { appendFile, readFile } from 'node:fs/promises';
await appendFile('ran.txt', process.argv[2] + '\\n');
const runs = await readFile('ran.txt', 'utf8');
process.exitCode = runs === 'task\\n' ? 0 : 1;
`);
const task = (id, name) => ({
  id, name, kind: 'one-shot',
  start: { executable: process.execPath, args: ['task.mjs', id], cwd: repo },
});
const sample = {
  id: 'sample', title: 'Sample', description: 'Tool UI', category: 'dev',
  type: 'group', status: 'active', created: '2026-11-16', folder: 'sample',
  steps: [
    { name: 'Overview', path: 'report.html' },
    { name: 'Details', path: 'details.html' },
    { name: 'Plain report', path: 'report.html' },
  ],
  tools: [
    { ...task('task', 'Fixture task'), launches: [{ id: 'site', name: 'Open site', type: 'url', target: 'https://example.com/' }] },
    task('extra', 'Overview-only task'),
  ],
};
const other = {
  ...sample, id: 'other', title: 'Other',
  tools: [task('other-card', 'Other card task')],
};
await writeFile(path.join(repo, 'workspace', 'workspace.json'), JSON.stringify({ entities: [sample, other] }));
const service = await createService({ repo, uiDir: path.join(repo, 'ui') });
let browser;
try {
  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const starts = [];
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname.startsWith('/api/workspace/tools/')) starts.push(request.url());
  });
  await page.goto(service.urls.workspace + '#/sample/0');
  const tools = page.getByRole('region', { name: 'Workspace tools' });
  const report = page.frameLocator('iframe.report-frame');
  await expect(tools.getByText('Fixture task')).toBeVisible();
  await expect(tools.getByText('Overview-only task')).toBeVisible();
  await expect(tools.getByRole('button', { name: 'Run' })).toHaveCount(2);
  await page.getByRole('button', { name: 'Details', exact: true }).click();
  await expect(report.getByRole('heading', { name: 'Sample Details' })).toBeVisible();
  await expect(tools.getByText('Fixture task')).toBeVisible();
  await expect(tools.getByText('Stopped')).toBeVisible();
  await expect(tools.getByRole('button', { name: 'Run' })).toHaveCount(1);
  await expect(tools.getByText('Overview-only task')).toHaveCount(0);
  await expect(tools.getByText('Other card task')).toHaveCount(0);
  await expect(tools.getByText('unknown')).toHaveCount(0);
  await report.locator('body').evaluate(body => {
    body.dataset.toolResults = '[]';
    document.addEventListener('alpha:workspace-tool-finished', event => {
      const results = JSON.parse(body.dataset.toolResults);
      results.push({ isCustomEvent: event instanceof CustomEvent, detail: event.detail });
      body.dataset.toolResults = JSON.stringify(results);
    });
    parent.postMessage({ type: 'alpha:run-tool', id: 'task' }, '*');
  });
  const completed = { isCustomEvent: true, detail: { id: 'task', success: true } };
  const failed = { isCustomEvent: true, detail: { id: 'task', success: false } };
  const run = tools.getByRole('button', { name: 'Run' });
  await expect(readFile(path.join(repo, 'ran.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  await run.click();
  await expect(tools.getByText('Last run: completed')).toBeVisible();
  await expect(report.locator('body')).toHaveAttribute('data-tool-results', JSON.stringify([completed]));
  await expect(page).toHaveURL(/#\/sample\/1$/);
  await run.click();
  await expect(report.locator('body')).toHaveAttribute('data-tool-results', JSON.stringify([completed, failed]));
  await expect(page).toHaveURL(/#\/sample\/1$/);
  expect(await readFile(path.join(repo, 'ran.txt'), 'utf8')).toBe('task\ntask\n');
  expect(starts.map(url => new URL(url).pathname)).toEqual(Array(2).fill('/api/workspace/tools/sample/task/start'));
  await page.getByRole('button', { name: 'Plain report', exact: true }).click();
  await expect(tools).toHaveCount(0);
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await expect(tools).toBeVisible();
  await expect(page.frameLocator('iframe.report-frame').getByRole('heading', { name: 'Sample Overview' })).toBeVisible();
  if (errors.length) throw new Error(errors.join('\n'));
  console.log('Workspace tools passed Overview placement, report opt-in, task results, and tab navigation at 390px.');
} finally { await browser?.close(); await service.close(); }
