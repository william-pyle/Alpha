import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect } from '@playwright/test';
import { createService } from '../server.mjs';
import { launchBrowser } from './browser.mjs';

const repo = await realpath(await mkdtemp(path.join(process.env.RUNNER_TEMP || tmpdir(), 'alpha-worker-project-ui-')));
const fixtureProject = (id, title) => ({
  id, title, folder: id, workspacePath: 'projects/' + id + '/workspace',
  status: 'active', category: 'research', defaultStep: 1,
  steps: [{ name: 'Overview', path: 'index.html' }, { name: 'Review', path: 'review.md' }, { name: 'Evidence', path: 'evidence.md' }],
});
const home = fixtureProject('worker-project-home', 'Worker home project');
const peer = fixtureProject('worker-project-peer', 'Peer project');
for (const project of [home, peer]) {
  const folder = path.join(repo, project.workspacePath);
  await mkdir(folder, { recursive: true });
  await Promise.all([
    writeFile(path.join(folder, 'index.html'), '<h1>Overview</h1>'),
    writeFile(path.join(folder, 'review.md'), '# Original review\n'),
    writeFile(path.join(folder, 'evidence.md'), '# Existing evidence\n'),
  ]);
}
await writeFile(path.join(repo, 'workspace.json'), JSON.stringify({ entities: [home, peer] }));
const service = await createService({ repo, uiDir: path.resolve('dist'), mcpOptions: { home: repo, env: {} } });
const workers = [];
const terminalActions = [];
let browser;

function worker(project, task) {
  const session = service.sessions.make({
    id: randomUUID(), nativeId: randomUUID(), agent: 'codex', name: project.title, cwd: path.join(repo, project.workspacePath),
    projectId: project.id, status: 'running', open: true, startedAt: Date.now(), cols: 90, rows: 32,
  });
  workers.push(session);
  service.sessions.items.set(session.id, session);
  const thread = service.threads.observe(session);
  const process = { write: data => terminalActions.push(data), kill: () => terminalActions.push('kill'), resize() {} };
  session.process = process;
  const bridge = service.sessions.issueWorkerBridge(session);
  bridge.attach(process);
  service.sessions.nativeEvent(session, { kind: 'turn-started', source: 'provider-record', nativeTaskId: task, eventKey: task });
  return { thread, token: bridge.token };
}

async function send(worker, data, status = 200) {
  const result = await fetch(service.origin + '/worker-request', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + worker.token, 'content-type': 'application/json' },
    body: JSON.stringify(data),
  });
  const body = await result.json();
  assert.equal(result.status, status, JSON.stringify(body));
  return body;
}

const action = (worker, name, args, key = name) => send(worker, { kind: 'request', requestKey: key, action: name, arguments: args });

try {
  const first = worker(home, 'home-task');
  const second = worker(peer, 'peer-task');
  service.threads.select(second.thread.id);
  await service.threads.save();
  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(service.urls.workspace + '#/' + home.id + '/1');

  const documents = page.getByRole('tablist', { name: 'Documents', exact: true });
  const questions = documents.getByRole('tab', { name: 'Questions', exact: true });
  const closeQuestions = documents.getByRole('button', { name: 'Close Questions', exact: true });
  const pages = page.getByRole('navigation', { name: 'Document pages' });
  const review = name => pages.getByRole('button', { name, exact: true });
  const root = page.locator('.app-layout');
  await expect(root).toHaveAttribute('data-report-step', '1');
  await expect(review('Review')).toBeVisible();
  await closeQuestions.click();
  await expect(questions).toHaveCount(0);

  const inventory = (await send(first, { kind: 'capabilities' })).projects;
  const edit = inventory.tabs.find(tab => tab.stepIndex === 1);
  assert.equal(inventory.projectId, home.id);
  assert.notEqual((await send(second, { kind: 'capabilities' })).projects.projectId, inventory.projectId);

  const added = await action(first, 'create-report-tab', { projectId: home.id, title: 'New report' });
  assert.equal(added.status, 'applied');
  assert.equal(added.result.stepIndex, 3);
  await expect(review('New report')).toHaveAttribute('data-report-step', '3');
  await review('New report').click();
  await expect(page.getByRole('heading', { name: 'Report', exact: true })).toBeVisible();
  await review('Review').click();
  await expect(root).toHaveAttribute('data-report-step', '1');

  const renamed = await action(first, 'rename-report-tab', { projectId: home.id, tabId: edit.tabId, title: 'Reviewed notes' });
  assert.equal(renamed.status, 'applied');
  await expect(review('Reviewed notes')).toHaveAttribute('data-report-step', '1');
  await expect(review('Review')).toHaveCount(0);
  await expect(questions).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Original review', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const draft = page.getByRole('textbox', { name: /^Edit / });
  await draft.fill('# Private fixture draft');

  const removal = await action(first, 'remove-report-tab', { projectId: home.id, tabId: edit.tabId });
  assert.equal(removal.status, 'pending-approval');
  await expect(questions).toHaveAttribute('aria-selected', 'true');
  const card = page.locator('.question-card').filter({ hasText: removal.receiptId });
  await expect(card).toContainText('Reviewed notes');
  await expect(card).toContainText('file and existing link are retained');
  await card.getByRole('button', { name: 'Approve this request', exact: true }).click();
  await card.getByRole('button', { name: 'Confirm decision', exact: true }).click();
  await expect(card).toHaveCount(0);
  await expect.poll(async () => (await send(first, { kind: 'result', receiptId: removal.receiptId })).status).toBe('applied');
  await send(second, { kind: 'result', receiptId: removal.receiptId }, 404);
  await closeQuestions.click();
  await expect(questions).toHaveCount(0);
  await expect(review('Reviewed notes')).toHaveCount(0);
  await expect(review('Evidence')).toHaveAttribute('data-report-step', '2');
  await expect(review('New report')).toHaveAttribute('data-report-step', '3');
  await expect(page.getByText('This report is no longer listed in the project tabs.', { exact: false })).toBeVisible();
  await expect(draft).toHaveValue('# Private fixture draft');
  assert.equal(await readFile(path.join(repo, home.workspacePath, 'review.md'), 'utf8'), '# Original review\n');
  assert.equal(page.url().slice(page.url().indexOf('#')), '#/' + home.id + '/1');

  const metadata = await action(first, 'update-project', { projectId: home.id, patch: { status: 'done', pinned: true } });
  assert.equal(metadata.status, 'applied');
  assert.equal((await service.workspace.registry()).entities.find(project => project.id === home.id).status, 'done');
  const created = await action(second, 'create-project', { title: 'Synthetic Research', template: 'research' });
  assert.equal(created.status, 'applied');
  await expect(questions).toHaveCount(0);
  const workspaceTab = documents.getByRole('tab', { name: 'Workspace', exact: true });
  await workspaceTab.click();
  await expect(page.getByRole('heading', { name: 'Synthetic Research', exact: true })).toBeVisible();
  const newHash = '#/' + home.id;
  await page.goto(service.urls.workspace + newHash);
  await expect(root).toHaveAttribute('data-report-step', '3');
  assert.equal(service.threads.selectedId, second.thread.id);
  assert.deepEqual(terminalActions, []);
  console.log('Worker project UI passed project creation, metadata, report creation and rename, exact approval and receipt, route preservation, draft retention and no terminal input.');
} finally {
  for (const session of workers) session.process = null;
  await browser?.close();
  await service.close();
}
