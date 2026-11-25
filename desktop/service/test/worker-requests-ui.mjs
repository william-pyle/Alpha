import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect } from '@playwright/test';
import { createService } from '../server.mjs';
import { launchBrowser } from './browser.mjs';

const repo = await mkdtemp(path.join(process.env.RUNNER_TEMP || tmpdir(), 'alpha-worker-requests-ui-'));
const workspace = path.join(repo, 'workspace');
await mkdir(path.join(workspace, 'fixture'), { recursive: true });
await mkdir(path.join(repo, '.alpha'));
await writeFile(path.join(workspace, 'fixture/report.html'), '<h1>Fixture report</h1>');
await writeFile(path.join(workspace, 'workspace.json'), JSON.stringify({ entities: [{
  id: 'fixture', title: 'Fixture project', folder: 'fixture', steps: [{ name: 'Report', path: 'report.html' }],
}] }));
await writeFile(path.join(repo, '.alpha/settings.json'), '{"speakReplies":false}');

const service = await createService({ repo, uiDir: path.resolve('dist'), mcpOptions: { home: repo, env: {} } });
const terminalActions = [];
const fixtureSessions = [];
let browser;

function worker(name, task) {
  const session = service.sessions.make({
    id: randomUUID(), nativeId: randomUUID(), agent: 'codex', name, cwd: repo,
    projectId: 'conversations', status: 'running', open: true, startedAt: Date.now(), cols: 90, rows: 32,
  });
  fixtureSessions.push(session);
  service.sessions.items.set(session.id, session);
  const thread = service.threads.observe(session);
  const process = {
    write: data => terminalActions.push({ id: session.id, data }),
    kill: () => terminalActions.push({ id: session.id, action: 'kill' }),
    resize: () => {},
  };
  session.process = process;
  const bridge = service.sessions.issueWorkerBridge(session);
  bridge.attach(process);
  service.sessions.nativeEvent(session, { kind: 'turn-started', source: 'provider-record', nativeTaskId: task, eventKey: task });
  return { session, thread, token: bridge.token };
}

async function request(token, body, status = 200, headers = {}) {
  const response = await fetch(`${service.origin}/worker-request`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const value = await response.json();
  assert.equal(response.status, status, JSON.stringify(value));
  return value;
}

try {
  const first = worker('Requesting worker', 'turn-first');
  const second = worker('Other worker', 'turn-second');
  assert.equal(service.sessions.issueWorkerBridge({ ...first.session, projectId: 'mooseville' }), null);
  await service.common.setScope({ excludedProjects: ['fixture'] });
  assert.equal(service.sessions.issueWorkerBridge({ ...first.session, projectId: 'fixture' }), null);
  service.threads.select(first.thread.id);
  await service.threads.save();

  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(service.urls.workspace + '#/fixture/0');

  const documents = page.getByRole('tablist', { name: 'Documents', exact: true });
  const questions = documents.getByRole('tab', { name: 'Questions', exact: true });
  const help = documents.getByRole('tab', { name: 'Help', exact: true });
  const report = documents.getByRole('tab', { name: 'Fixture project', exact: true });
  const firstTab = page.locator(`#conversation-tab-${first.thread.id}`);
  const secondTab = page.locator(`#conversation-tab-${second.thread.id}`);
  const openHelp = async () => {
    await page.getByRole('button', { name: 'Help', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Open Help', exact: true }).click();
    await expect(help).toBeVisible();
  };
  const target = async () => {
    let targets;
    await expect.poll(async () => {
      ({ targets } = await request(first.token, { kind: 'targets' }));
      return targets.length;
    }).toBe(1);
    assert.equal(targets[0].title, 'Help');
    return targets[0].id;
  };

  await expect(firstTab).toHaveAttribute('aria-selected', 'true');
  await expect(report).toBeVisible();
  await documents.getByRole('button', { name: 'Close Questions', exact: true }).click();
  await expect(questions).toHaveCount(0);
  assert.deepEqual((await request(first.token, { kind: 'targets' })).targets, []);
  await openHelp();
  const originalTarget = await target();
  await report.click();
  await secondTab.click();
  await expect(secondTab).toHaveAttribute('aria-selected', 'true');
  await expect(report).toHaveAttribute('aria-selected', 'true');
  assert.equal(await target(), originalTarget);

  const close = { kind: 'request', requestKey: 'close-fixture-help', action: 'close-preview', targetId: originalTarget };
  await request(first.token, { ...close, sessionId: second.session.id }, 400);
  await request(first.token, close, 403, { origin: service.origin });
  await request(service.token, close, 401);
  await expect(help).toBeVisible();
  const accepted = await request(first.token, close);
  const result = { kind: 'result', receiptId: accepted.receiptId };
  await expect(help).toHaveCount(0);
  await expect.poll(async () => (await request(first.token, result)).status).toBe('closed');
  const closed = await request(first.token, result);
  assert.equal(closed.targetId, originalTarget);
  assert.deepEqual(await request(first.token, close), closed);
  await request(second.token, result, 404);
  await expect(report).toHaveAttribute('aria-selected', 'true');
  await expect(secondTab).toHaveAttribute('aria-selected', 'true');
  await expect(questions).toHaveCount(0);

  await expect.poll(async () => JSON.parse(await readFile(path.join(repo, '.alpha/settings.json'), 'utf8')).utilityTabs?.includes('questions')).toBe(false);
  await page.reload();
  await expect(questions).toHaveCount(0);
  await expect(secondTab).toHaveAttribute('aria-selected', 'true');
  assert.deepEqual(await request(first.token, result), closed);
  await request(second.token, result, 404);
  await openHelp();
  const reopenedTarget = await target();
  assert.notEqual(reopenedTarget, originalTarget);
  assert.equal((await request(first.token, { ...close, requestKey: 'stale-fixture-help' })).status, 'stale');
  await expect(help).toBeVisible();

  const stop = await request(first.token, { kind: 'request', requestKey: 'stop-fixture-worker', action: 'stop-terminal', targetId: second.session.id });
  assert.equal(stop.status, 'denied');
  assert.match(stop.message, /unavailable/);
  assert.equal(first.session.workerEvidence.execution, 'working');
  assert.equal(second.session.workerEvidence.execution, 'working');
  assert.deepEqual(terminalActions, []);
  assert.deepEqual(service.questions.list(), []);
  await expect(questions).toHaveCount(0);
  await page.getByRole('button', { name: 'View', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Questions', exact: true }).click();
  await expect(page.getByText('No pending questions.', { exact: true })).toBeVisible();
  await documents.getByRole('button', { name: 'Close Questions', exact: true }).click();
  const ownerQuestion = await service.questions.ask({ sourceId: 'owner-ui-fixture', threadId: first.thread.id, text: 'Which fixture should Alpha keep?' });
  await expect(questions).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText(ownerQuestion.text, { exact: true })).toBeVisible();
  await expect(help).toBeVisible();
  await expect(report).toBeVisible();
  await expect(secondTab).toHaveAttribute('aria-selected', 'true');
  assert.equal(first.session.workerEvidence.execution, 'working');
  assert.equal(second.session.workerEvidence.execution, 'working');
  assert.deepEqual(terminalActions, []);

  const ledger = await readFile(path.join(repo, '.alpha/worker-requests.json'), 'utf8');
  const records = JSON.parse(ledger);
  assert.deepEqual(records.map(record => record.status).sort(), ['closed', 'denied', 'stale']);
  assert.equal(records.find(record => record.id === closed.receiptId).origin.nativeTaskId, 'turn-first');
  assert.equal(ledger.includes(first.token) || ledger.includes(second.token), false);
  assert.deepEqual(errors, []);
  console.log('Worker requests UI passed exact Help closure, original-task receipt, reload, stale targets, denial, and no terminal input. A new owner question selected Questions while routine requests kept it closed.');
} finally {
  for (const session of fixtureSessions) session.process = null;
  await browser?.close();
  await service.close();
}
