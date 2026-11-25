import assert from 'node:assert/strict';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect } from '@playwright/test';
import { launchBrowser } from './browser.mjs';
import { artifactFixture, destinationProject, fixtureText, frontmatter, importRequest, sourceProject } from './worker-artifact-fixture.mjs';

const fixture = await artifactFixture();
let browser;
try {
  const originating = fixture.worker(destinationProject);
  const current = fixture.worker(sourceProject);
  fixture.service.threads.select(current.thread.id);
  const source = frontmatter('review-fixture');
  await fixture.put(sourceProject, 'agent', 'review-fixture', source);
  browser = await launchBrowser();
  const page = await browser.newPage();
  await page.goto(fixture.service.urls.workspace);
  const documents = page.getByRole('tablist', { name: 'Documents', exact: true });
  const questionsTab = documents.getByRole('tab', { name: 'Questions', exact: true });
  const closeQuestions = documents.getByRole('button', { name: 'Close Questions', exact: true });
  const conversationTab = page.locator('#conversation-tab-' + current.thread.id);
  await expect(conversationTab).toHaveAttribute('aria-selected', 'true');
  await closeQuestions.click();
  await expect(questionsTab).toHaveCount(0);

  const receipt = await fixture.request(originating, importRequest('agent', 'review-fixture'));
  assert.equal(receipt.status, 'pending-approval');
  await expect(questionsTab).toHaveAttribute('aria-selected', 'true');
  await expect(questionsTab).toHaveCount(1);
  const panel = page.getByRole('tabpanel', { name: 'Questions', exact: true });
  const pending = receiptId => panel.locator('.question-card').filter({ hasText: receiptId });
  const history = panel.getByRole('region', { name: 'Recent worker decisions', exact: true });
  const decision = receiptId => history.locator(`[data-worker-receipt="${receiptId}"]`);
  const decide = async (question, choice) => {
    await question.getByRole('button', { name: choice, exact: true }).click();
    await question.getByRole('button', { name: 'Confirm decision', exact: true }).click();
    await expect(question).toHaveCount(0);
  };
  const card = pending(receipt.receiptId);
  await expect(card).toContainText('review-fixture');
  await expect(card).toContainText(sourceProject);
  await expect(card).toContainText(destinationProject);
  await expect(card.getByText(fixtureText, { exact: false })).toHaveCount(0);
  await expect(card.getByRole('textbox')).toHaveCount(0);
  await expect(conversationTab).toHaveAttribute('aria-selected', 'true');

  await decide(card, 'Approve this request');
  await fixture.settle(originating, receipt.receiptId, 'applied');
  await fixture.result(current, receipt.receiptId, 404);
  const saved = await readFile(fixture.artifactPath(destinationProject, 'agent', 'review-fixture'), 'utf8');
  assert.ok(saved.includes(source));

  fixture.newTask(originating);
  await fixture.put(sourceProject, 'agent', 'deny-fixture', frontmatter('deny-fixture'));
  const deniedRequest = importRequest('agent', 'deny-fixture');
  const denied = await fixture.request(originating, deniedRequest);
  assert.equal(denied.status, 'pending-approval');
  await decide(pending(denied.receiptId), 'Deny this request');
  const deniedResult = await fixture.settle(originating, denied.receiptId, 'owner-denied');
  await expect(decision(denied.receiptId)).toContainText('Owner denied');
  await expect(decision(denied.receiptId)).not.toContainText('System blocked');
  await closeQuestions.click();
  await expect(questionsTab).toHaveCount(0);
  fixture.newTask(originating);
  assert.deepEqual(await fixture.request(originating, { ...deniedRequest, requestKey: 'deny-fixture-reworded' }), deniedResult);
  assert.deepEqual(await fixture.questions(), []);
  await expect(questionsTab).toHaveCount(0);

  await fixture.put(sourceProject, 'agent', 'blocked-fixture', frontmatter('blocked-fixture'));
  fixture.blockArtifact('blocked-fixture');
  const blocked = await fixture.request(originating, importRequest('agent', 'blocked-fixture'));
  assert.equal(blocked.status, 'pending-approval');
  await expect(questionsTab).toHaveAttribute('aria-selected', 'true');
  await decide(pending(blocked.receiptId), 'Approve this request');
  const blockedResult = await fixture.settle(originating, blocked.receiptId, 'system-blocked');
  assert.equal(blockedResult.access, 'os-permission');
  await expect(decision(blocked.receiptId)).toContainText('System blocked');
  await expect(decision(blocked.receiptId)).toContainText(blockedResult.nextStep);
  await expect(decision(denied.receiptId)).toContainText('Owner denied');
  await fixture.result(current, denied.receiptId, 404);
  await fixture.result(current, blocked.receiptId, 404);
  assert.deepEqual(fixture.nativeCalls.filter(call => call.action === 'apply').map(call => call.artifactId), ['review-fixture', 'blocked-fixture']);
  for (const id of ['deny-fixture', 'blocked-fixture']) {
    await assert.rejects(lstat(fixture.artifactPath(destinationProject, 'agent', id)), { code: 'ENOENT' });
  }
  assert.deepEqual(fixture.terminalEffects, []);
  await expect(conversationTab).toHaveAttribute('aria-selected', 'true');

  await closeQuestions.click();
  await expect(questionsTab).toHaveCount(0);
  await expect.poll(async () => JSON.parse(await readFile(path.join(fixture.repo, '.alpha/settings.json'), 'utf8')).utilityTabs?.includes('questions')).toBe(false);
  await page.reload();
  await expect(conversationTab).toHaveAttribute('aria-selected', 'true');
  await expect(questionsTab).toHaveCount(0);
  await page.getByRole('button', { name: 'View', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Questions', exact: true }).click();
  await expect(questionsTab).toHaveCount(1);
  await expect(decision(blocked.receiptId)).toContainText('System blocked');
  await expect(decision(denied.receiptId)).toContainText('Owner denied');
  assert.deepEqual(await fixture.questions(), []);

  await fixture.service.threads.save();
  await fixture.close();
  const questionsFile = path.join(fixture.repo, '.alpha/questions.json');
  const audit = JSON.parse(await readFile(questionsFile, 'utf8'));
  const review = audit.find(item => item.sourceId === blocked.receiptId);
  assert.equal(review.workerReceipt.status, 'system-blocked');
  // Model interruption after the terminal ledger write but before the Questions snapshot.
  delete review.workerReceipt;
  review.continuation = 'queued';
  await writeFile(questionsFile, JSON.stringify(audit));
  await fixture.start();
  await page.goto(fixture.service.urls.workspace);
  await expect(conversationTab).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: 'View', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Questions', exact: true }).click();
  await expect(decision(blocked.receiptId)).toContainText('System blocked');
  await expect(decision(denied.receiptId)).toContainText('Owner denied');
  assert.deepEqual(await fixture.questions(), []);
  assert.deepEqual(fixture.fileEffects, ['agent:review-fixture']);
  assert.deepEqual(fixture.terminalEffects, []);
  console.log('Worker artifact approval UI confirmed exact owner-approved import, separate owner denial and system block, no blocked or repeated write, history after reload, and no terminal effects.');
} finally {
  await browser?.close();
  await fixture.cleanup();
}
