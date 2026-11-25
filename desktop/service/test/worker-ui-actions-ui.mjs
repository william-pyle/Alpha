import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect } from '@playwright/test';
import { createService } from '../server.mjs';
import { launchBrowser } from './browser.mjs';

const repo = await mkdtemp(path.join(process.env.RUNNER_TEMP || tmpdir(), 'alpha-worker-ui-'));
const workspace = path.join(repo, 'workspace');
const entities = [];
for (const [id, title] of [['first-project', 'First project'], ['other-project', 'Other project']]) {
  const steps = [{ name: 'Summary', path: 'summary.html' }, { name: 'Report', path: 'report.html' }];
  await mkdir(path.join(workspace, id), { recursive: true });
  for (const step of steps) await writeFile(path.join(workspace, id, step.path), `<!doctype html><h1>${title} ${step.name}</h1>`);
  if (id === 'first-project') {
    steps.push({ name: 'Notes', path: 'notes.md' });
    await writeFile(path.join(workspace, id, 'notes.md'), '# Saved fixture note\n');
  }
  entities.push({ id, title, folder: id, steps });
}
await mkdir(path.join(repo, '.alpha'));
await writeFile(path.join(workspace, 'workspace.json'), JSON.stringify({ entities }));
await writeFile(path.join(repo, '.alpha/settings.json'), '{"speakReplies":false,"viewerEnabled":false}');

const service = await createService({ repo, uiDir: path.resolve('dist'), mcpOptions: { home: repo, env: {} } });
const fixtureSessions = [], terminalWrites = [];
let browser;

function startTask(worker) {
  const { session } = worker;
  worker.bridge?.revoke();
  worker.bridge = service.sessions.issueWorkerBridge(session);
  worker.bridge.attach(session.process);
  worker.token = worker.bridge.token;
  const task = randomUUID();
  service.sessions.nativeEvent(session, { kind: 'turn-started', source: 'provider-record', nativeTaskId: task, eventKey: task });
}

function makeWorker(projectId) {
  const session = service.sessions.make({
    id: randomUUID(), nativeId: randomUUID(), agent: 'codex', name: projectId, cwd: repo, projectId,
    status: 'running', open: true, startedAt: Date.now(), cols: 80, rows: 24,
  });
  fixtureSessions.push(session);
  service.sessions.items.set(session.id, session);
  const thread = service.threads.observe(session);
  session.process = { write: value => terminalWrites.push(value), kill: () => terminalWrites.push('kill'), resize() {} };
  const worker = { thread, session };
  startTask(worker);
  return worker;
}

async function request(worker, body, status = 200) {
  const response = await fetch(`${service.origin}/worker-request`, {
    method: 'POST',
    headers: { authorization: `Bearer ${worker.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  assert.equal(response.status, status, JSON.stringify(result));
  return result;
}

async function target(worker, kind, predicate = () => true) {
  let found;
  await expect.poll(async () => {
    const { views } = await request(worker, { kind: 'capabilities' });
    found = views.find(view => view.kind === kind && predicate(view));
    return Boolean(found);
  }).toBe(true);
  return found;
}

function submit(worker, action, targetId, args) {
  return request(worker, { kind: 'request', requestKey: randomUUID(), action, targetId, ...(args && { arguments: args }) });
}

const result = (worker, receipt, status) => request(worker, { kind: 'result', receiptId: receipt.receiptId }, status);
async function settle(worker, receipt, status = 'applied') {
  await expect.poll(async () => (await result(worker, receipt)).status, { timeout: 20000 }).toBe(status);
}

try {
  const first = makeWorker('first-project'), other = makeWorker('other-project');
  service.threads.select(first.thread.id);
  await service.threads.save();

  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.fixtureCaptureCalls = 0;
    navigator.mediaDevices.getUserMedia = async () => { window.fixtureCaptureCalls++; throw new Error('No fixture capture'); };
  });
  await page.goto(service.urls.workspace);

  const documents = page.getByRole('tablist', { name: 'Documents', exact: true });
  const reportTab = documents.getByRole('tab', { name: 'First project', exact: true });
  const help = documents.getByRole('tab', { name: 'Help', exact: true });
  const workspaceTab = documents.getByRole('tab', { name: 'Workspace', exact: true });
  const questions = documents.getByRole('tab', { name: 'Questions', exact: true });
  const firstThread = page.locator(`#conversation-tab-${first.thread.id}`);
  const otherThread = page.locator(`#conversation-tab-${other.thread.id}`);
  const editor = page.getByRole('textbox', { name: 'Message Alpha' });
  const feed = page.getByRole('region', { name: 'Alpha conversation' }).locator('#conversation-content');
  const heading = page.frameLocator('iframe.report-frame').getByRole('heading', { name: 'First project Report' });
  await expect(firstThread).toHaveAttribute('aria-selected', 'true');
  await editor.fill('Draft stays with the first conversation');

  const otherLauncher = await target(other, 'project-launcher', view => view.stepIndex === 1);
  const firstReport = await target(first, 'project-launcher', view => view.stepIndex === 1);
  assert.equal(firstReport.projectId, 'first-project');
  const { views } = await request(first, { kind: 'capabilities' });
  assert.ok(views.every(view => view.projectId !== 'other-project'));
  assert.ok(views.every(view => !Object.hasOwn(view, 'stepBinding')));
  await settle(first, await submit(first, 'open-tab', otherLauncher.id), 'stale');
  await expect(documents.getByRole('tab', { name: 'Other project', exact: true })).toHaveCount(0);

  const open = { kind: 'request', requestKey: 'open-exact-report', action: 'open-tab', targetId: firstReport.id };
  const opened = await request(first, open);
  await settle(first, opened);
  await expect(reportTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('navigation', { name: 'Document pages' }).getByRole('button', { name: 'Report', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(heading).toBeVisible();
  assert.equal((await request(first, open)).receiptId, opened.receiptId);
  await result(other, opened, 404);
  const openProject = await target(first, 'project-tab');
  const workspaceTarget = await target(first, 'workspace-tab');
  await settle(first, await submit(first, 'activate-tab', workspaceTarget.id));
  await expect(workspaceTab).toHaveAttribute('aria-selected', 'true');
  await settle(first, await submit(first, 'activate-tab', openProject.id));
  await expect(reportTab).toHaveAttribute('aria-selected', 'true');
  await expect(heading).toBeVisible();

  startTask(first);
  await settle(first, await submit(first, 'close-tab', openProject.id));
  await expect(reportTab).toHaveCount(0);
  await expect(workspaceTab).toHaveAttribute('aria-selected', 'true');
  assert.deepEqual((await service.workspace.registry()).entities.find(entity => entity.id === 'first-project').steps, entities[0].steps);
  await settle(first, await submit(first, 'open-tab', firstReport.id));
  await expect(heading).toBeVisible();
  assert.notEqual((await target(first, 'project-tab')).id, openProject.id);
  await settle(first, await submit(first, 'close-tab', openProject.id), 'stale');
  await expect(reportTab).toBeVisible();
  const helpLauncher = await target(first, 'help-launcher');
  await settle(first, await submit(first, 'open-tab', helpLauncher.id));
  await expect(help).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.file-preview[data-disposable-help=true]')).toBeVisible();

  startTask(first);
  const helpTarget = await target(first, 'help-tab');
  await reportTab.click();
  await settle(first, await submit(first, 'activate-tab', helpTarget.id));
  await expect(help).toHaveAttribute('aria-selected', 'true');
  await settle(first, await submit(first, 'close-tab', helpTarget.id));
  await expect(help).toHaveCount(0);
  const layout = await target(first, 'conversation-layout');
  assert.equal(layout.threadId, first.thread.id);
  await settle(first, await submit(first, 'set-message-panel', layout.id, { visible: false }));
  await expect(feed).toBeHidden();
  await expect(editor).toBeHidden();
  await otherThread.click();
  await expect(feed).toBeVisible();
  await expect(editor).toBeVisible();
  await firstThread.click();
  await expect(feed).toBeHidden();
  const nextLayout = await target(first, 'conversation-layout');
  assert.notEqual(nextLayout.id, layout.id);
  await settle(first, await submit(first, 'set-message-panel', nextLayout.id, { visible: true }));
  await expect(feed).toBeVisible();
  await expect(editor).toHaveValue('Draft stays with the first conversation');

  startTask(first);
  await settle(first, await submit(first, 'set-3d-view', nextLayout.id, { visible: true }));
  const viewer = page.locator('.alpha-presence-stage');
  await expect(viewer).toBeVisible();
  assert.equal(await page.evaluate(() => window.fixtureCaptureCalls), 0);
  await otherThread.click();
  await expect(viewer).toHaveCount(0);
  await firstThread.click();
  await expect(viewer).toBeVisible();
  const viewerLayout = await target(first, 'conversation-layout');
  await settle(first, await submit(first, 'set-3d-view', viewerLayout.id, { visible: false }));
  await expect(viewer).toHaveCount(0);
  await expect(editor).toHaveValue('Draft stays with the first conversation');
  await expect(firstThread).toHaveAttribute('aria-selected', 'true');

  await page.getByRole('button', { name: 'View', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Hide message panel', exact: true }).click();
  await expect(editor).toBeHidden();
  await page.getByRole('button', { name: 'View', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Show message panel', exact: true }).click();
  await expect(editor).toHaveValue('Draft stays with the first conversation');

  await page.getByRole('button', { name: `Worker terminal for ${first.thread.name}`, exact: true }).click();
  await expect(page.locator('.worker-terminal:not([hidden])')).toBeVisible();
  await settle(first, await submit(first, 'set-message-panel', viewerLayout.id, { visible: false }), 'stale');
  await expect(page.locator('.worker-terminal:not([hidden])')).toBeVisible();
  assert.deepEqual(terminalWrites, []);
  assert.deepEqual(service.questions.list(), []);
  assert.equal(first.session.workerEvidence.execution, 'working');
  assert.equal(other.session.workerEvidence.execution, 'working');

  await page.reload();
  await expect(firstThread).toHaveAttribute('aria-selected', 'true');
  assert.equal((await result(first, opened)).status, 'applied');
  await result(other, opened, 404);
  startTask(first);
  const notes = await target(first, 'project-launcher', view => view.stepIndex === 2);
  await settle(first, await submit(first, 'open-tab', notes.id));
  await expect(page.getByRole('heading', { name: 'Saved fixture note' })).toBeVisible();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('textbox', { name: 'Edit notes.md' }).fill('Protected unsaved report draft');
  await settle(first, await submit(first, 'activate-tab', (await target(first, 'workspace-tab')).id), 'unavailable');
  await expect(page.getByRole('textbox', { name: 'Edit notes.md' })).toHaveValue('Protected unsaved report draft');
  const choice = await service.questions.ask({ text: 'Keep this pending fixture decision?', sourceId: 'worker-ui-owner-decision', threadId: first.thread.id, chatName: first.thread.name });
  await expect(page.locator(`[data-question-id="${choice.id}"]`)).toBeVisible();
  await settle(first, await submit(first, 'activate-tab', (await target(first, 'workspace-tab')).id), 'unavailable');
  await expect(questions).toHaveAttribute('aria-selected', 'true');
  assert.deepEqual(errors, []);
  console.log('Worker UI actions passed in isolated Edge: exact report launch, project/Help activation and close, stale and foreign targets, thread-local message panel, 3D view, retained draft, safe terminal, and protected pending Questions.');
} finally {
  for (const session of fixtureSessions) session.process = null;
  await browser?.close();
  await service.close();
}
