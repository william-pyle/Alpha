import { tmpdir as isolatedTmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createService } from '../server.mjs';
import { launchBrowser } from './browser.mjs';
import { completionSummary } from '../completion-summary.mjs';

const repo = await mkdtemp(path.join(process.env.RUNNER_TEMP || isolatedTmpdir(), 'alpha-expanded-layout-'));
await mkdir(path.join(repo, 'workspace')); await mkdir(path.join(repo, '.alpha'));
await writeFile(path.join(repo, 'workspace/workspace.json'), JSON.stringify({ entities: [{ id: 'fixture', title: 'Fixture Project', category: 'design', status: 'active', pinned: true, folder: 'fixture', steps: [] }] }));
await writeFile(path.join(repo, '.alpha/settings.json'), '{"speakReplies":false}');
const service = await createService({ repo, uiDir: path.resolve('dist'), mcpOptions: { home: repo, env: {} } });
const a = service.threads.create({ name: 'Search older messages', projectId: 'fixture' }), b = service.threads.create({ name: 'Other isolated discussion', projectId: 'fixture', purpose: 'Metadata only' });
for (let i = 0; i < 160; i++) service.threads.message(a.id, { id: `m${i}`, role: i % 2 ? 'user' : 'assistant', text: `Archived test message ${i}${i === 2 ? ' UNIQUE NEEDLE <script>do not execute</script>' : ''}`, at: new Date(1700000000000 + i * 1000).toISOString() }, false);
service.threads.message(b.id, { id: 'secret', role: 'assistant', text: 'OTHER PRIVATE TRANSCRIPT' }, false);
service.threads.select(a.id); await service.threads.save();
let browser;
try {
  browser = await launchBrowser(); const page = await browser.newPage({ viewport: { width: 960, height: 800 } });
  await page.goto(service.urls.workspace);
  const editor = page.getByRole('textbox', { name: 'Message Alpha' }); await editor.fill('Draft survives switching');
  await page.locator(`#conversation-tab-${b.id}`).click();
  await expect(page.locator(`#conversation-tab-${b.id}`)).toHaveAttribute('aria-selected', 'true'); await expect(editor).toHaveValue('');
  await page.locator(`#conversation-tab-${a.id}`).click(); await expect(editor).toHaveValue('Draft survives switching');
  await editor.focus(); await page.keyboard.press('Control+k'); await expect(page.getByRole('dialog', { name: 'Quick switcher', exact: true })).toHaveCount(0); await expect(editor).toBeFocused();
  const searchConversation = async () => { await page.locator(`#conversation-tab-${a.id}`).click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Search this conversation', exact: true }).click(); };
  await searchConversation();
  const search = page.getByRole('dialog', { name: 'Search this conversation', exact: true }); await search.getByRole('textbox').fill('UNIQUE NEEDLE'); await expect(search).toContainText('1 matches'); await search.getByRole('button', { name: /UNIQUE NEEDLE/ }).click();
  await expect(page.locator('[data-message-id="m2"]')).toBeFocused(); await expect(page.locator('[data-message-id="m2"]')).toBeInViewport(); assert.equal(await page.getByText('OTHER PRIVATE TRANSCRIPT').count(), 0);
  // Repeated dialog-to-message handoff must retain focus after modal cleanup.
  for (let attempt = 0; attempt < 3; attempt++) {
    await searchConversation();
    await search.getByRole('textbox').fill('UNIQUE NEEDLE'); await expect(search).toContainText('1 matches');
    await search.getByRole('button', { name: /UNIQUE NEEDLE/ }).click(); await expect(search).toHaveCount(0);
    await expect(page.locator('[data-message-id="m2"]')).toBeFocused();
    await page.locator('[data-message-id="m2"]').press('Tab');
    await expect(page.locator('[data-message-id="m3"]')).toBeFocused();
  }
  const auth = { Authorization: `Bearer ${service.token}` };
  const forbidden = await fetch(`${service.origin}/api/threads/${b.id}/search?q=PRIVATE`, { headers: auth }); assert.equal(forbidden.status, 403);
  const settings = async () => { await page.getByRole('button', { name: 'Tools', exact: true }).click(); await page.getByRole('menuitem', { name: 'Settings' }).click(); await page.getByRole('tab', { name: 'Conversation', exact: true }).click(); };
  await settings(); await page.getByLabel('Conversation text size').selectOption('20'); await page.getByLabel('Conversation line spacing').selectOption('1.8'); await page.getByLabel('Reduce motion', { exact: true }).click(); await expect(page.getByLabel('Reduce motion', { exact: true })).toBeChecked(); await page.getByLabel('Allow layout inspection in this conversation').click(); await expect(page.getByLabel('Allow layout inspection in this conversation')).toBeChecked();
  const coordinator = await service.getCoordinator(a.id);
  const settingsLayout = await coordinator.execute('inspect_alpha_ui', {}); assert.equal(settingsLayout.kind, 'rendered-layout');
  await page.getByRole('button', { name: 'Close settings' }).click();
  const layout = await coordinator.execute('inspect_alpha_ui', {}); assert.equal(layout.kind, 'rendered-layout'); assert.ok(layout.regions.some(item => item.kind === 'composer' && item.height >= 100)); assert.doesNotMatch(JSON.stringify(layout), /PRIVATE|NEEDLE|Draft survives/);
  await writeFile(path.join(repo, 'live-layout-evidence.json'), JSON.stringify(layout, null, 2));
  await page.reload(); await expect(page.locator('.unified-shell')).toHaveAttribute('data-reduced-motion', 'true');
  assert.equal(await page.locator('.conversation-markdown').last().evaluate(node => getComputedStyle(node).fontSize), '20px');
  await settings(); await page.getByLabel('Enable 3D viewer').click(); await expect(page.getByLabel('Enable 3D viewer')).toBeChecked(); await page.getByRole('button', { name: 'Close settings' }).click(); await expect(page.locator('[data-reduced-motion="true"][data-model-ready]')).toHaveCount(1);
  await settings(); await page.getByLabel('Enable 3D viewer').click(); await expect(page.getByLabel('Enable 3D viewer')).not.toBeChecked(); await page.getByLabel('Allow layout inspection in this conversation').click(); await expect(page.getByLabel('Allow layout inspection in this conversation')).not.toBeChecked(); await page.getByRole('button', { name: 'Close settings' }).click(); await assert.rejects(coordinator.execute('inspect_alpha_ui', {}), /Settings/);
  const summary = completionSummary({ changed: ['Fixture layout changed'], passed: [{ text: 'Isolated fixture passed', evidence: 'fixture-test-id' }], remaining: ['Installation pending'], lifecycle: Object.fromEntries(['tested','published','installed','observed'].map(key => [key, { status: 'unknown' }])) }, { operationId: 'fixture-summary', threadId: a.id });
  service.threads.message(a.id, { id: 'summary', role: 'assistant', text: 'FULL DETAILED EVIDENCE stays available', completionSummary: summary });
  await expect(page.getByRole('heading', { name: 'What changed' })).toBeVisible(); await page.getByText('Full report and evidence', { exact: true }).click(); await expect(page.getByText('FULL DETAILED EVIDENCE stays available')).toBeVisible();
  for (const theme of ['light','dark']) {
    await page.getByRole('button', { name: 'Tools', exact: true }).click(); await page.getByRole('menuitem', { name: 'Settings' }).click(); await page.getByRole('tab', { name: 'Theme', exact: true }).click(); await page.getByLabel('Workspace theme', { exact: true }).selectOption(theme); await page.getByRole('button', { name: 'Close settings' }).click();
    for (const width of [960,390]) { await page.setViewportSize({ width, height: 600 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false); await page.locator('[data-message-id="summary"]').scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(repo, `${theme}-${width}.png`) }); }
  }
  await page.setViewportSize({ width: 960, height: 800 });
  await page.locator('.mdi-document-tabs').getByRole('tab', { name: 'Workspace', exact: true }).click();
  const card = page.locator('.home [data-card="fixture"]');
  await card.getByRole('button', { name: /^Edit Fixture Project:/ }).click(); await page.getByRole('dialog', { name: 'Project settings: Fixture Project' }).getByRole('button', { name: 'Archived', exact: true }).click(); await expect(card).toHaveCount(0);
  await page.route('**/api/workspace/undo', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Retry fixture undo"}' }));
  await page.locator('.organization-undo').getByRole('button', { name: 'Undo', exact: true }).click(); await expect(page.locator('.organization-undo')).toContainText('Retry fixture undo');
  await page.unroute('**/api/workspace/undo'); await page.locator('.organization-undo').getByRole('button', { name: 'Undo', exact: true }).click(); await expect(card).toBeVisible();
  await card.getByRole('button', { name: /^Edit Fixture Project:/ }).click(); await page.getByRole('dialog', { name: 'Project settings: Fixture Project' }).getByLabel('Project category').selectOption('dev');
  await page.locator('.organization-undo').getByRole('button', { name: 'Undo', exact: true }).click(); await expect.poll(async () => (await service.workspace.registry()).entities[0].category).toBe('design');
  await expect(page.locator('.mdi-center')).toBeVisible(); await page.locator('.conversation-tabs [aria-selected=true]').click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Conversation details', exact: true }).click();
  await page.getByRole('button', { name: 'Close conversation', exact: true }).click(); await page.getByRole('button', { name: 'Move to History' }).click(); await expect(page.locator(`#conversation-tab-${a.id}`)).toHaveCount(0);
  await page.locator('.organization-undo').getByRole('button', { name: 'Undo', exact: true }).click(); await page.locator(`#conversation-tab-${a.id}`).click(); await expect(editor).toBeEnabled(); await expect(editor).toHaveValue('Draft survives switching'); assert.equal(service.threads.get(a.id).archived, false);
  const worker = service.sessions.make({ id: 'event-fixture', name: 'Structured fixture worker', agent: 'shell', cwd: repo, status: 'running', open: false, alphaThreadId: a.id, projectId: 'fixture' }); service.sessions.items.set(worker.id, worker); a.sessionIds.push(worker.id);
  const eventAt = Date.now();
  service.sessions.nativeEvent(worker, { kind: 'turn-started', nativeTaskId: 'fixture-turn', eventKey: 'fixture-start', source: 'provider-record', at: new Date(eventAt).toISOString() }); await expect(page.locator('.mdi-statusbar')).toContainText('Worker working');
  service.sessions.nativeEvent(worker, { kind: 'question', nativeTaskId: 'fixture-turn', eventKey: 'fixture-question', source: 'provider-record', at: new Date(eventAt + 1).toISOString() }); await expect(page.locator('.mdi-statusbar')).toContainText('Waiting for input');
  service.sessions.nativeEvent(worker, { kind: 'turn-completed', nativeTaskId: 'fixture-turn', id: 'fixture-complete', eventKey: 'fixture-complete', source: 'provider-record', at: new Date(eventAt + 2).toISOString() }); await expect(page.locator('.mdi-statusbar')).toContainText('Ready');
  const revision = worker.workerEvidence.revision; service.sessions.nativeEvent(worker, { kind: 'turn-started', nativeTaskId: 'fixture-turn', eventKey: 'fixture-start', source: 'provider-record', at: new Date(eventAt).toISOString() }); assert.equal(worker.workerEvidence.revision, revision);
  service.sessions.nativeEvent(worker, { kind: 'turn-failed', nativeTaskId: 'fixture-turn', eventKey: 'fixture-failure', source: 'provider-record', at: new Date(eventAt + 3).toISOString() }); await expect(page.locator('.mdi-statusbar')).toContainText('Worker failed');
  await writeFile(path.join(repo, 'results.json'), JSON.stringify({ status: 'passed', fixtureOnly: true, checks: ['Conversation tabs preserve drafts; obsolete Ctrl+K does not open a switcher', 'Long selected-history search and exact message focus, other-thread forbidden', 'Reading persistence and reduced viewer motion', 'Live coordinator-tool layout response, redacted and revoked, available with utility tabs', 'Explicit summary and full evidence', 'Light/dark 960/390 layouts', 'Card archive/category and conversation archive undo; failed undo retains retry and draft', 'Task-bound worker status bar: working, needs-input, idle after completion, failed; duplicate rejected'] }, null, 2));
  console.log(`Expanded layout UI passed: ${repo}`);
} finally { await browser?.close(); await service.close(); }
