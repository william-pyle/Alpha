import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat, realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createService } from '../server.mjs';
const exec = promisify(execFile);

test('authenticated storage/cleanup/deletion routes preserve other projects and conversation bindings after reload', async t => {
  const repo = await realpath(await mkdtemp(path.join(tmpdir(), 'alpha-storage-api-'))), root = path.join(repo, 'projects/sample'), github = path.join(root, 'github');
  await mkdir(github, { recursive: true }); await mkdir(path.join(root, 'workspace')); await mkdir(path.join(repo, 'workspace'));
  await mkdir(path.join(repo, 'projects/other/workspace'), { recursive: true });
  await writeFile(path.join(repo, 'projects/other/workspace/report.html'), 'other project');
  await writeFile(path.join(repo, 'workspace/workspace.json'), JSON.stringify({ entities: ['sample', 'other'].map(id => ({ id, title: id, status: 'active', folder: id, workspacePath: `projects/${id}/workspace`, steps: [] })) }));
  await exec('git', ['init', github], { windowsHide: true });
  await exec('git', ['-C', github, 'remote', 'add', 'origin', 'https://github.com/william-pyle/Sample.git'], { windowsHide: true });
  await writeFile(path.join(github, 'Cargo.toml'), '[package]\nname="sample"\nversion="0.1.0"');
  await writeFile(path.join(github, '.gitignore'), '/target/'); await mkdir(path.join(github, 'target')); await writeFile(path.join(github, 'target/build.bin'), 'regenerate');
  let service;
  const native = event => queueMicrotask(() => {
    if (event.type === 'project-storage-capabilities') service.nativeMessage({ ...event, available: true });
    if (event.type === 'project-storage') service.nativeMessage({ type: 'project-storage-result', requestId: event.requestId, allocatedBytes: 4096, logicalBytes: 8192, files: 2, errors: 0, skippedLinks: 0 });
  });
  const repositoryOptions = { execute: async (file, args, options) => file === 'gh' ? { stdout: JSON.stringify({ id: 123, full_name: 'william-pyle/Sample', html_url: 'https://github.com/william-pyle/Sample', owner: { login: 'william-pyle' }, private: false }) } : exec(file, args, options) };
  const open = () => createService({ repo, uiDir: path.resolve('dist'), initializeProjects: false, mcpOptions: { home: repo, env: {} }, repositoryOptions, native });
  service = await open();
  t.after(async () => { await service.close(); await rm(repo, { recursive: true, force: true }); });
  const request = async (route, data, method = data ? 'POST' : 'GET') => {
    const response = await fetch(service.origin + '/api' + route, { method, headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' }, ...(data ? { body: JSON.stringify(data) } : {}) });
    const value = await response.json(); return { response, value };
  };
  const thread = service.threads.create({ name: 'Retain local history', projectId: 'sample' });
  service.threads.message(thread.id, { role: 'user', text: 'Fixture history survives project deletion.' }); await service.threads.save();
  assert.equal((await fetch(service.origin + '/api/workspace/storage')).status, 401);
  let state = await request('/workspace/storage'); assert.equal(state.response.status, 200);
  for (let n = 0; n < 100 && state.value.projects.some(row => row.status !== 'ready'); n++) { await new Promise(resolve => setTimeout(resolve, 10)); state = await request('/workspace/storage'); }
  assert.equal(state.value.projects[0].allocatedBytes, 4096); assert.equal(state.value.projects[0].logicalBytes, 8192);
  const plan = await request('/workspace/projects/sample/build-cleanup'); assert.equal(plan.value.candidates.length, 1);
  const cleaned = await request('/workspace/projects/sample/build-cleanup', { confirmation: 'sample', previewToken: plan.value.previewToken });
  assert.equal(cleaned.response.status, 200); assert.deepEqual(cleaned.value.removed, ['github/target']);
  assert.equal(await lstat(path.join(github, 'target')).catch(() => null), null);
  const deletion = (await request('/workspace/projects/sample/deletion')).value;
  assert.equal(deletion.blockedReason, undefined);
  assert.equal(deletion.logicalBytes, state.value.projects[0].logicalBytes);
  const removed = await request('/workspace/projects/sample/remove', { confirmation: 'sample', scope: 'delete-files' });
  assert.equal(removed.response.status, 200); assert.equal(await lstat(root).catch(() => null), null);
  assert.equal(await readFile(path.join(repo, 'projects/other/workspace/report.html'), 'utf8'), 'other project');
  await service.close(); service = await open();
  assert.equal(service.threads.get(thread.id).projectId, 'sample');
  assert.equal(service.threads.get(thread.id).messages[0].text, 'Fixture history survives project deletion.');
  const registry = await service.workspace.registry(); assert.ok(registry.entities.find(item => item.id === 'sample').removedAt);
  assert.deepEqual((await request('/workspace/storage')).value.projects.map(row => row.id), ['other']);
});
