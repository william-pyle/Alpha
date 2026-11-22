import { tmpdir as isolatedTmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createService } from '../server.mjs';
import { launchBrowser } from './browser.mjs';

await mkdir('.test-output', { recursive: true });
const repo = await mkdtemp(path.join(process.env.RUNNER_TEMP || isolatedTmpdir(), 'alpha-agent-center-'));
await mkdir(path.join(repo, 'workspace'));
await writeFile(path.join(repo, 'workspace/workspace.json'), JSON.stringify({ entities: [{ id: 'alpha', title: 'Alpha', created: '2026-11-16', folder: 'alpha', steps: [] }, { id: 'mooseville', title: 'Mooseville', created: '2026-11-16', folder: 'excluded', steps: [] }] }));
const updateVersion = '99.9.0', updateBase = `https://github.com/william-pyle/Alpha/releases/download/v${updateVersion}`;
const manifestUrl = `${updateBase}/alpha-update.json`, assetUrl = `${updateBase}/Alpha-${updateVersion}-windows-x64.msi`;
const updateRequests = [], originalFetch = globalThis.fetch;
globalThis.fetch = (url, options) => {
  if (url === 'https://api.github.com/repos/william-pyle/Alpha/releases/latest') {
    updateRequests.push('release');
    return Response.json({ tag_name: `v${updateVersion}`, assets: [{ name: 'alpha-update.json', browser_download_url: manifestUrl }] });
  }
  if (url === manifestUrl) {
    updateRequests.push('manifest');
    return Response.json({ version: updateVersion, platform: 'windows-x64', url: assetUrl, bytes: 1200, sha256: 'a'.repeat(64) });
  }
  if (url === assetUrl) throw new Error('Fixture must not download the update installer');
  return originalFetch(url, options);
};
let service;
try { service = await createService({ repo, uiDir: path.resolve('dist'), mcpOptions: { home: repo, env: {} } }); }
finally { globalThis.fetch = originalFetch; }
const calls = [];
service.coordinator.ask = async data => { calls.push(data); return { ...data, status: 'completed', result: 'Applied the requested choice.', at: new Date().toISOString() }; };
const request = async (route, data) => {
  const response = await fetch(service.origin + '/api' + route, { method: data ? 'POST' : 'GET', headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' }, ...(data ? { body: JSON.stringify(data) } : {}) });
  assert.ok(response.ok, await response.clone().text()); return response.json();
};
let browser, page;
try {
  browser = await launchBrowser(); page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = []; page.on('pageerror', error => { errors.push(error.message); console.log(error.stack); });
  await page.goto(service.urls.workspace);
  const session = await request('/sessions', { agent: 'shell', name: 'Unassigned Work' });
  (await service.getCoordinator(session.id)).ask = service.coordinator.ask;
  const questions = page.getByRole('region', { name: 'Questions' });
  await expect(page.locator('.mdi-statusbar')).toContainText('Ready');
  assert.equal(service.sessions.get(session.id).projectId, 'conversations');
  await expect(questions.getByText('Which card or project should I track Unassigned Work under?')).toHaveCount(0);
  const question = await service.questions.ask({ text: 'Which layout should I use for the test?', options: ['Compact', 'Spacious'], sourceId: 'layout', context: 'Improve the layout.' });
  await page.getByRole('tab', { name: 'Questions', exact: true }).click();
  await questions.getByRole('button', { name: 'Compact', exact: true }).click();
  await questions.getByRole('button', { name: 'Send answer' }).click();
  await expect.poll(() => service.questions.items.find(item => item.id === question.id).status).toBe('answered');
  await expect.poll(() => calls.at(-1)?.text || '').toMatch(/User's answer: Compact/);
  await page.getByRole('button', { name: 'View', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Common agents' }).click();
  const dialog = page.getByRole('tabpanel', { name: 'Common agents' });
  await expect(dialog.getByRole('heading', { name: 'Common agents' })).toBeVisible();
  await dialog.getByText('Automation scope', { exact: true }).click();
  await dialog.getByLabel('Excluded project IDs').fill('mooseville');
  await dialog.getByRole('button', { name: 'Save automation scope' }).click();
  await expect.poll(() => service.common.scope.excludedProjects).toEqual(['mooseville']);
  const agent = dialog.locator('.agent-card').filter({ has: page.getByText('Build Verification', { exact: true }) });
  await agent.getByRole('button', { name: 'Disable Build Verification' }).click();
  await expect(agent.getByRole('button', { name: 'Enable Build Verification' })).toBeVisible();
  await agent.getByRole('button', { name: 'Enable Build Verification' }).click();
  // Synthetic evidence stays inside this disposable test service.
  const fixtureSession = { id: 'evidence-fixture', agent: 'codex', cwd: repo };
  service.common.input(fixtureSession, 'Run fixture checks for native startup.', 'fixture-project', 'build-verification');
  const fixtureRun = await service.common.complete(fixtureSession, { id: 'fixture-completion' });
  await service.common.feedback(fixtureRun.id, { outcome: 'needs-fix', feedback: 'Fixture verification omitted the startup check.', failureKey: 'startup-check' });
  await agent.getByText('Instructions & history', { exact: true }).click();
  const instructions = agent.getByLabel('Instructions for Build Verification');
  await instructions.fill((await instructions.inputValue()) + '\nCheck native startup when fixing launch behavior.');
  await agent.getByLabel('Revision reason for Build Verification').fill('A reported startup failure was missed by unit-only verification.');
  await agent.getByRole('button', { name: 'Save new version' }).click();
  await expect(agent.getByLabel('Version for Build Verification')).toHaveValue('2');
  await agent.getByLabel('Version for Build Verification').selectOption('1');
  await expect(agent.getByLabel('Version for Build Verification')).toHaveValue('1');
  await agent.getByText('Run a task', { exact: true }).click();
  await agent.getByLabel('Task for Build Verification').fill('Run the relevant checks in this fixture project.');
  await agent.getByRole('button', { name: 'Run Build Verification' }).click();
  await expect(agent.getByText('Applied the requested choice.')).toBeVisible();
  assert.match(calls.at(-1).text, /common agent build-verification/);
  await page.screenshot({ path: path.join(repo, 'agents.png') });
  await service.health.report({ area: 'Fixture operation', symptom: 'Repeated delays observed in the fixture', proposal: 'Inspect the recorded delay before redesigning this request.' });
  await page.getByRole('button', { name: 'View', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Alpha health', exact: true }).click();
  const health = page.getByRole('tabpanel', { name: 'Alpha health', exact: true });
  await expect(health.getByText('Repeated delays observed in the fixture')).toBeVisible();
  await health.getByRole('button', { name: 'Mark resolved' }).click();
  await expect(health.getByText('No open health issues.')).toBeVisible();
  await page.getByRole('button', { name: 'Close Alpha health', exact: true }).click();
  const target = service.sessions.make({ id: 'restart-target', nativeId: 'native-target', agent: 'codex', name: 'Restart Target', cwd: repo, open: true, status: 'stopped', createdAt: new Date().toISOString() });
  service.sessions.items.set(target.id, target); service.sessions.changed(target);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('tabpanel', { name: 'Settings' });
  await settings.getByRole('tab', { name: 'Updates', exact: true }).click();
  await expect(settings.getByRole('heading', { name: 'Release evidence' })).toBeVisible();
  await expect(settings.getByRole('button', { name: 'Check for Updates', exact: true })).toHaveCount(0);
  assert.deepEqual(updateRequests, []);
  await page.getByRole('button', { name: 'Help', exact: true }).click();
  await page.screenshot({ path: path.join(repo, 'check-for-updates-menu.png') });
  await page.getByRole('menuitem', { name: 'Check for Updates', exact: true }).click();
  const updates = page.getByRole('tabpanel', { name: 'Check for Updates', exact: true });
  await expect(updates).toBeVisible();
  await expect(updates.getByText(`Update available: Alpha ${updateVersion}.`, { exact: true })).toBeVisible();
  await expect(updates.getByRole('button', { name: 'Download update', exact: true })).toBeVisible();
  await expect(updates.getByRole('button', { name: 'Restart and install', exact: true })).toHaveCount(0);
  assert.deepEqual(updateRequests, ['release', 'manifest']);
  await expect(page.locator('.alpha-update-notice')).toHaveCount(0);
  await page.screenshot({ path: path.join(repo, 'check-for-updates-tab.png') });
  await updates.getByText('Resume work after restarting', { exact: true }).click();
  await updates.getByLabel('Conversation to resume').selectOption(target.id);
  await updates.getByLabel('Restart note').fill('Read the project checkpoint and continue the remaining authorized work.');
  await updates.getByRole('button', { name: 'Save restart note' }).click();
  await expect.poll(() => service.restartNotes.items[0]?.status).toBe('prepared');
  await updates.getByRole('button', { name: 'Cancel restart note' }).click();
  await expect.poll(() => service.restartNotes.items[0]?.status).toBe('cancelled');
  assert.deepEqual(errors, []);
  console.log(`Agent center passed project questions, Alpha answers, exclusion, role revision/rollback/run, health and restart-note UI. Screenshot: ${path.join(repo, 'agents.png')}`);
} catch (error) { console.log(await page?.locator('body').innerText()); await page?.screenshot({ path: path.join(repo, 'failure.png') }); throw error; }
finally { await browser?.close(); await service.close(); }
