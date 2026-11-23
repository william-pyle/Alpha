import { tmpdir as isolatedTmpdir } from 'node:os';
// Isolated WebView-compatible UI + headless terminal fixture, no owner state.
import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createService } from '../server.mjs';
import { launchBrowser } from './browser.mjs';

await mkdir('.test-output', { recursive: true });
const root = await mkdtemp(path.join(process.env.RUNNER_TEMP || isolatedTmpdir(), 'alpha-native-questions-ui-'));
await mkdir(path.join(root, 'workspace')); await mkdir(path.join(root, '.alpha'));
await writeFile(path.join(root, 'workspace/workspace.json'), JSON.stringify({ entities: [] }));
await writeFile(path.join(root, '.alpha/settings.json'), '{"trustProjectsScope":true}');
const service = await createService({ repo: root, uiDir: path.resolve('dist'), restoreSessions: false, checkUpdates: false, mcpOptions: { home: root, env: {} } });
const browser = await launchBrowser();
const writes = [], all = [];
const screen = session => `Trust this folder? Codex can read, edit, and run files here.\r\n${session.cwd}\r\n› 1. Trust and continue\r\n  2. Quit\r\nenter continue · esc quit`;
const paint = async (session, value) => { await new Promise(resolve => session.terminal.write('\x1b[2J\x1b[H' + value, resolve)); service.sessions.detectPrompt(session); };
const capture = async session => { const state = await service.sessions.prompts.inspect(session); return service.questions.captureNative(session, state, service.sessions.prompts.binding(state)); };
try {
  for (const name of ['First', 'Second']) {
    const thread = service.threads.create({ name, projectId: 'fixture' });
    const cwd = path.win32.join(name === 'First' ? 'C:/Projects' : 'C:/Projects-lookalike', path.basename(root), name);
    const session = service.sessions.make({ id: name, agent: 'codex', name, cwd, nativeId: `native-${name}`, alphaThreadId: thread.id, status: 'running', open: true, startedAt: Date.now() - 5000, cols: 100, rows: 24 });
    service.sessions.items.set(session.id, session); await service.sessions.hydrate(session); all.push(session);
    service.threads.observe(session);
    session.process = { resize() {}, write(key) {
      writes.push([session.id, key]);
      if (key === '\r') void paint(session, '\x1b[?2004hOpenAI Codex\r\n› \r\n? for shortcuts\x1b[2;3H');
    } };
    await paint(session, screen(session)); await capture(session);
  }
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(service.urls.workspace);
  const documents = page.getByRole('tablist', { name: 'Documents', exact: true });
  const questionsTab = documents.getByRole('tab', { name: 'Questions', exact: true });
  const workspaceTab = documents.getByRole('tab', { name: 'Workspace', exact: true });
  const closeQuestions = documents.getByRole('button', { name: 'Close Questions', exact: true });
  const panel = page.getByRole('region', { name: 'Questions', exact: true });
  const openFromView = async name => {
    await page.getByRole('button', { name: 'View', exact: true }).click();
    await page.getByRole('menuitem', { name, exact: true }).click();
  };
  await expect(workspaceTab).toHaveAttribute('aria-selected', 'true');
  await expect(panel).toBeHidden();
  await expect(questionsTab.locator('.mdi-questions-count')).toHaveText('2');
  if (process.platform === 'win32') {
    for (const session of all) service.sessions.emit('prompt-check', { id: session.id });
    await closeQuestions.press('Enter');
    await expect(questionsTab).toHaveCount(0);
    await openFromView('Needs attention');
    const attention = page.getByRole('tabpanel', { name: 'Needs attention', exact: true });
    await expect(attention.getByText(/Alpha could not verify the folder under C:\/Projects/i)).toHaveCount(1);
    assert.deepEqual(writes, [], 'Unverified and lookalike paths require manual action');
    await attention.getByRole('button', { name: 'Open Questions', exact: true }).click();
    await expect(panel.locator('.question-card').filter({ hasText: 'First' })).toBeFocused();
    await closeQuestions.press('Enter');
    const attentionTab = documents.getByRole('tab', { name: 'Needs attention', exact: true });
    await expect(attentionTab).toHaveAttribute('aria-selected', 'true');
    await expect(attentionTab).toBeFocused();
    await expect(workspaceTab).toBeVisible();
    await openFromView('Questions');
    await workspaceTab.click();
  }
  await questionsTab.press('Enter');
  await expect(questionsTab).toHaveAttribute('aria-selected', 'true');
  await expect(panel.locator('.question-card')).toHaveCount(2);
  const first = panel.locator('.question-card').filter({ has: page.locator('header strong', { hasText: /^First$/ }) });
  const second = panel.locator('.question-card').filter({ has: page.locator('header strong', { hasText: /^Second$/ }) });
  await expect(panel.getByRole('textbox')).toHaveCount(0);
  await first.getByRole('button', { name: 'Open terminal', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Enable terminal controls', exact: true })).toHaveAttribute('aria-pressed', 'false');
  assert.equal(service.threads.owner('First').viewMode, 'terminal'); assert.deepEqual(writes, []);
  await page.screenshot({ path: path.join(root, 'questions-wide.png') });
  await first.getByRole('button', { name: 'Trust and continue', exact: true }).click();
  await first.getByRole('button', { name: 'Send answer', exact: true }).click();
  await expect(first).toHaveCount(0);
  await expect(second).toBeVisible();
  await expect(questionsTab.locator('.mdi-questions-count')).toHaveText('1');
  assert.deepEqual(writes, [['First', '1'], ['First', '\r']]);
  assert.equal(service.questions.items.find(item => item.sessionId === 'First').delivery, 'observed');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(root, 'questions-narrow.png') });
  // A new disclosure after the UI displays a choice must reject that choice.
  await paint(all[1], screen(all[1]).replace('Second', 'Changed'));
  await second.getByRole('button', { name: 'Trust and continue', exact: true }).click();
  await second.getByRole('button', { name: 'Send answer', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('prompt changed');
  assert.equal(writes.length, 2);
  await capture(all[1]);
  await second.getByRole('button', { name: 'Trust and continue', exact: true }).click();
  await second.getByRole('button', { name: 'Send answer', exact: true }).click();
  await expect(panel.locator('.question-card')).toHaveCount(0);
  await expect(questionsTab.locator('.mdi-questions-count')).toHaveCount(0);
  assert.deepEqual(writes.slice(2), [['Second', '1'], ['Second', '\r']]);
  await page.screenshot({ path: path.join(root, 'questions-resolved.png') });
  await page.setViewportSize({ width: 1440, height: 1000 });
  // A queued async reply must remain visible until a later exact acceptance,
  // then disappear without a second click or payload.
  const session = all[1];
  const [asyncQuestion] = service.questions.capture(session, { id: 'async-ui', source: 'provider-record', tool: 'request_user_input_async', asyncDelivery: true, questions: [{ text: 'Which synthetic color should be used?', options: ['Blue', 'Green'] }] });
  let replyPayload, replyTask, sends = 0;
  const originalInput = service.sessions.input;
  service.sessions.input = async (id, payload, options) => {
    assert.equal(id, session.id); sends++; replyPayload = payload; replyTask = options.taskId;
    return { accepted: false, note: 'Queued; waiting for native acceptance.' };
  };
  const color = panel.locator(`[data-question-id="${asyncQuestion.id}"]`);
  const colorAnswer = color.getByRole('textbox');
  await color.getByRole('button', { name: 'Blue', exact: true }).click();
  await closeQuestions.press('Enter');
  await expect(questionsTab).toHaveCount(0);
  await expect(panel).toBeHidden();
  await expect(workspaceTab).toHaveAttribute('aria-selected', 'true');
  await expect(workspaceTab).toBeFocused();
  assert.equal(service.questions.list().length, 1);
  assert.equal(sends, 0);

  const firstThread = service.threads.owner('First');
  const lateQuestion = await service.questions.ask({ text: 'Which fixture detail should be retained?', source: 'maintenance', sourceId: 'closed-questions-fixture', threadId: firstThread.id, chatName: firstThread.name });
  const firstAttention = page.getByRole('button', { name: /^Attention for First: 1 pending question/ });
  await expect(firstAttention).toBeVisible();
  await expect(questionsTab).toHaveCount(0);
  await expect(workspaceTab).toHaveAttribute('aria-selected', 'true');
  await page.screenshot({ path: path.join(root, 'questions-closed-with-pending.png') });
  await expect.poll(async () => JSON.parse(await readFile(path.join(root, '.alpha/settings.json'), 'utf8')).utilityTabs?.includes('questions')).toBe(false);
  await page.reload();
  await expect(firstAttention).toBeVisible();
  await expect(questionsTab).toHaveCount(0);
  await expect(workspaceTab).toHaveAttribute('aria-selected', 'true');

  await openFromView('Questions');
  await openFromView('Questions');
  await expect(questionsTab).toHaveCount(1);
  await expect(questionsTab).toHaveAttribute('aria-selected', 'true');
  await expect(questionsTab.locator('.mdi-questions-count')).toHaveText('2');
  await expect(colorAnswer).toHaveValue('Blue');

  await closeQuestions.press('Enter');
  await expect(questionsTab).toHaveCount(0);
  await firstAttention.press('Enter');
  await expect(questionsTab).toHaveCount(1);
  const lateCard = panel.locator(`[data-question-id="${lateQuestion.id}"]`);
  await expect(lateCard.getByRole('textbox')).toBeFocused();
  await expect(page.locator(`#conversation-tab-${firstThread.id}`)).toHaveAttribute('aria-selected', 'true');
  await lateCard.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(lateCard).toHaveCount(0);
  await expect(colorAnswer).toHaveValue('Blue');
  await color.getByRole('button', { name: 'Send answer', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('waiting for native acceptance');
  assert.equal(service.questions.list().length, 1); assert.equal(sends, 1);
  assert.ok(replyPayload.includes(asyncQuestion.asyncQuestion.id.replaceAll('"', '\\"')));
  session.submissions = [{ taskId: replyTask, hash: asyncQuestion.answerIntent.hash, acceptedAt: Date.now(), acceptance: 'observed' }];
  service.sessions.emit('task-input', { session, text: replyPayload });
  await expect(panel.locator('.question-card')).toHaveCount(0); assert.equal(sends, 1);
  await workspaceTab.click(); await expect(panel).toBeHidden();
  service.sessions.input = originalInput;
  console.log(JSON.stringify({ passed: true, root, checks: ['pending Questions stay in a dedicated tab', 'keyboard selection and close', 'actual choices', 'exact terminal', 'changed disclosure rejected', 'verified transition', 'answered cards cleared', 'Workspace return', 'pending arrival while closed', 'closure persists on reload', 'singleton View reopen', 'origin-bound question navigation while closed', 'count and draft preservation', 'wide/narrow'] }));
} finally { for (const session of all) session.process = null; await browser.close(); await service.close(); }
