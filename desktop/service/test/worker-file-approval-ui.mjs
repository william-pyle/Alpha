import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect } from '@playwright/test';
import { createService } from '../server.mjs';
import { launchBrowser } from './browser.mjs';

const repo = await mkdtemp(path.join(tmpdir(), 'alpha-worker-file-approval-ui-'));
const projectId = 'file-fixture';
const workspacePath = `projects/${projectId}/workspace`;
const revision = 'a'.repeat(64);
await mkdir(path.join(repo, workspacePath), { recursive: true });
await writeFile(path.join(repo, workspacePath, 'notes.md'), 'Synthetic file contents remain private.');
await writeFile(path.join(repo, 'workspace.json'), JSON.stringify({ entities: [
  { id: projectId, title: 'File fixture', folder: projectId, workspacePath, steps: [{ name: 'Notes', path: 'notes.md' }] },
] }));
let service, browser;
try {
  service = await createService({ repo, uiDir: path.resolve('dist'), mcpOptions: { home: repo, env: {} }, native(event) {
    if (event.type !== 'worker-file-operation') return;
    assert.equal(event.projectId, projectId);
    assert.equal(event.filename, 'notes.md');
    assert.equal(event.action, 'inspect');
    service.nativeMessage({ type: event.type, requestId: event.requestId, result: { revision } });
  } });
  browser = await launchBrowser();
  const page = await browser.newPage();
  await page.goto(service.urls.workspace);
  await page.getByRole('tab', { name: 'Questions', exact: true }).click();
  const questions = page.getByRole('tabpanel', { name: 'Questions' });
  await questions.getByText('File request references', { exact: true }).click();
  await questions.getByRole('combobox').selectOption(projectId);
  await questions.getByRole('button', { name: 'Show file references' }).click();
  await expect(questions.getByText('notes.md', { exact: true })).toBeVisible();
  await expect(questions.getByText(revision, { exact: true })).toBeVisible();
  const codes = questions.locator('details code');
  await expect(codes).toHaveCount(2);
  await expect(codes.first()).toHaveText(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  await expect(questions.getByText('Synthetic file contents remain private.')).toHaveCount(0);
  console.log('Owner Questions shows exact registered Markdown file references and revisions without exposing document contents.');
} finally {
  await browser?.close();
  await service?.close();
  await rm(repo, { recursive: true });
}
