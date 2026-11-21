import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, writeFile, lstat, symlink, rename } from 'node:fs/promises';
import { Workspace } from '../workspace.mjs';
import { Projects } from '../projects.mjs';
import { CardDocuments } from '../card-documents.mjs';
import { assertSafePath, ensureProjectWorkspace, safeProjectPaths } from '../project-layout.mjs';
import { saveJson } from '../util.mjs';
import { createService } from '../server.mjs';
import { Files } from '../files.mjs';

async function fixture(options = {}) {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'alpha-project-safety-'));
  await mkdir(path.join(repo, 'workspace/old'), { recursive: true });
  const entity = { id: 'sample', title: 'Sample project', folder: 'old', category: 'research', type: 'standalone', created: '2026-11-21', status: 'active', custom: 'preserve', steps: [{ name: 'Original route', path: 'report.html' }] };
  await writeFile(path.join(repo, 'workspace/old/report.html'), '<h1>Keep original bytes</h1>');
  await mkdir(path.join(repo, 'workspace/old/media')); await writeFile(path.join(repo, 'workspace/old/media/picture.txt'), 'asset bytes');
  await saveJson(path.join(repo, 'workspace/workspace.json'), { entities: [entity], customRoot: 'preserve' });
  const workspace = new Workspace(repo), projects = new Projects(workspace, options);
  return { repo, workspace, projects, entity };
}

test('built-in Conversations is canonical, idempotent and protected across persistence reload', async () => {
  const { repo, projects, workspace } = await fixture();
  await projects.init(); await projects.init();
  const reread = new Projects(new Workspace(repo)); await reread.init();
  const all = (await workspace.registry()).entities;
  assert.equal(all.filter(item => item.id === 'conversations').length, 1);
  assert.equal((await reread.select()).workspacePath, 'projects/conversations/workspace');
  assert.ok((await lstat(path.join(repo, 'projects/conversations/workspace/index.html'))).isFile());
  await assert.rejects(async () => reread.remove('conversations', { scope: 'keep-files', confirmation: 'conversations' }), /cannot be deleted/);
  await assert.rejects(workspace.update('conversations', { status: 'archived' }), /stays active/);
  await assert.rejects(workspace.update('conversations', { pinned: false }), /stays active/);
  assert.equal(all.find(item => item.id === 'sample').custom, 'preserve');
});
test('reserved user project is preserved and default conflict is explicit', async () => {
  const { repo, projects, entity } = await fixture();
  await saveJson(path.join(repo, 'workspace/workspace.json'), { entities: [{ ...entity, id: 'conversations' }] });
  assert.match((await projects.init()).defaultProjectConflict, /occupied/);
  await assert.rejects(projects.select(), /unavailable/);
  assert.equal((await projects.get('conversations')).custom, 'preserve');
});
test('new editable projects create one workspace directly beneath stable root', async () => {
  const { repo, workspace } = await fixture();
  const result = await new CardDocuments(workspace).create({ title: 'My test project', template: 'research' });
  assert.equal(result.entity.workspacePath, `projects/${result.entity.id}/workspace`);
  const read = await new CardDocuments(workspace).read(result.entity.id, 0);
  assert.equal(read.document.title, 'My test project');
  assert.equal(await lstat(path.join(repo, 'workspace', result.entity.folder)).catch(() => null), null);
});
test('lossless migration keeps route and content bytes, aliases and repeated runs are idempotent', async () => {
  const { repo, projects, entity } = await fixture();
  const result = await projects.migrate('sample'); assert.equal(result.status, 'applied');
  const moved = await projects.get('sample'); assert.deepEqual(moved.steps, entity.steps); assert.equal(moved.id, entity.id); assert.equal(moved.folder, entity.folder);
  assert.equal(await readFile(path.join(repo, moved.workspacePath, 'report.html'), 'utf8'), '<h1>Keep original bytes</h1>');
  assert.equal(await readFile(path.join(repo, moved.workspacePath, 'media/picture.txt'), 'utf8'), 'asset bytes');
  assert.equal(await lstat(path.join(repo, 'workspace/old')).catch(() => null), null);
  assert.equal((await projects.migrate('sample')).status, 'current');
  assert.equal(await projects.resolveContent('workspace/old/report.html'), path.join('projects/sample/workspace/report.html'));
  assert.equal((await new Workspace(repo).read('sample')).text, 'Keep original bytes');
});
test('interrupted atomic move recovers without duplicate data or changing routes', async () => {
  const { repo, projects, entity } = await fixture(); const plan = await projects.migrationPlan('sample');
  await saveJson(path.join(repo, '.alpha/project-migrations/sample.json'), { ...plan, phase: 'prepared', before: entity });
  await mkdir(path.dirname(plan.to), { recursive: true }); await rename(plan.from, plan.to);
  assert.equal((await projects.migrationPlan('sample')).status, 'recoverable');
  const recovered = await new Projects(new Workspace(repo)).migrate('sample'); assert.equal(recovered.recovered, true);
  assert.equal((await projects.get('sample')).workspacePath, 'projects/sample/workspace');
});
test('migration defers active sessions, explicit instructions and destination conflicts', async () => {
  const { repo, projects } = await fixture({ sessions: () => [{ projectId: 'sample', cwd: repo, status: 'running' }] });
  assert.equal((await projects.migrate('sample')).status, 'deferred');
  const idle = new Projects(new Workspace(repo)); await mkdir(path.join(repo, 'projects/sample'), { recursive: true });
  await writeFile(path.join(repo, 'projects/sample/AGENTS.md'), 'Pinned renderer');
  assert.match((await idle.migrationPlan('sample')).reason, /instructions/);
  await mkdir(path.join(repo, 'projects/sample/workspace'));
  assert.match((await idle.migrationPlan('sample')).reason, /Destination exists/);
  assert.equal(await readFile(path.join(repo, 'workspace/old/report.html'), 'utf8'), '<h1>Keep original bytes</h1>');
});
test('path validation prevents traversal, junction aliases and private data inside Git trees', async () => {
  const { repo } = await fixture();
  for (const id of ['..', '../other', 'a/b', 'a\\b', 'a:b', 'CON', 'nul', '']) assert.throws(() => safeProjectPaths(repo, id));
  await assert.rejects(assertSafePath(repo, path.join(repo, '../escape'), { allowMissing: true }), /inside/);
  const external = await mkdtemp(path.join(os.tmpdir(), 'alpha-project-outside-'));
  await symlink(external, path.join(repo, 'projects'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(ensureProjectWorkspace(repo, 'escape'), /link|junction/);
  const nested = await fixture(); await mkdir(path.join(nested.repo, '.git'));
  await assert.rejects(ensureProjectWorkspace(nested.repo, 'private'), /Git checkout/);
  assert.equal((await nested.projects.migrate('sample')).status, 'deferred');
});
test('migration rejects links and embedded Git without changing either source', async () => {
  const { repo, projects } = await fixture(); await mkdir(path.join(repo, 'workspace/old/.git'));
  assert.equal((await projects.migrate('sample')).status, 'deferred');
  assert.ok((await lstat(path.join(repo, 'workspace/old/report.html'))).isFile());
});
test('migrated Markdown previews, edits, folder browsing and content URLs retain compatibility', async () => {
  const { repo, projects } = await fixture();
  const original = path.join(repo, 'workspace/old/notes.md'); await writeFile(original, '# Notes\n[Shared](../_shared/report.css)');
  await projects.migrate('sample');
  const files = new Files(repo); files.origin = 'http://127.0.0.1'; files.resolveProjectContent = value => projects.resolveContent(value); files.projectAlias = value => projects.contentAlias(value);
  const preview = await files.preview(original);
  assert.equal(preview.path, path.join(repo, 'projects/sample/workspace/notes.md'));
  assert.match(preview.url, /workspace\/old\/notes.md$/);
  const saved = await files.saveMarkdown({ path: original, text: '# Edited', revision: preview.revision });
  assert.match(saved.url, /workspace\/old\/notes.md$/); assert.equal(saved.text, '# Edited');
  assert.equal((await files.list(path.join(repo, 'workspace/old'))).path, path.join(repo, 'projects/sample/workspace'));
});
test('worker startup and migration share a project lock; a new worker defers the move', async () => {
  const sessions = [], { projects, repo } = await fixture({ sessions: () => sessions });
  let release; const startup = projects.exclusive('sample', async () => { await new Promise(resolve => { release = resolve; }); sessions.push({ projectId: 'sample', cwd: path.join(repo, 'workspace/old'), status: 'running' }); });
  await new Promise(resolve => setImmediate(resolve));
  const migration = projects.migrate('sample'); release(); await startup;
  assert.equal((await migration).status, 'deferred');
  assert.ok((await lstat(path.join(repo, 'workspace/old/report.html'))).isFile());
});
test('Delete is confirmed list removal only; histories, workers, files and stable references survive reload', async () => {
  const thread = { id: 'thread-one', projectId: 'sample', messages: ['private history'] }, worker = { id: 'worker-one', projectId: 'sample', status: 'running' };
  const { repo, projects, workspace } = await fixture({ threads: () => [thread], sessions: () => [worker] });
  await assert.rejects(async () => projects.remove('sample', { confirmation: 'wrong', scope: 'keep-files' }), /Confirm/);
  await assert.rejects(async () => projects.remove('sample', { confirmation: 'sample', scope: 'delete-files' }), /keep-files/);
  const result = await projects.remove('sample', { confirmation: 'sample', scope: 'keep-files' });
  assert.equal(result.references, 1); assert.equal((await workspace.list()).length, 0);
  assert.equal(worker.status, 'running'); assert.equal(thread.projectId, 'sample'); assert.deepEqual(thread.messages, ['private history']);
  assert.ok((await new Projects(new Workspace(repo)).get('sample')).removedAt);
  assert.equal(await readFile(path.join(repo, 'workspace/old/report.html'), 'utf8'), '<h1>Keep original bytes</h1>');
  await assert.rejects(projects.select('sample'), /removed/);
});
test('service defaults only new conversations, keeps UI-selected project and saved data through isolated restart', async t => {
  const { repo } = await fixture(); await mkdir(path.join(repo, 'ui')); await writeFile(path.join(repo, 'ui/index.html'), '<title>Fixture</title>');
  let service = await createService({ repo, uiDir: path.join(repo, 'ui'), mcpOptions: { home: repo, env: {} } });
  t.after(async () => { await service.close(); });
  const request = async (route, data, method = 'POST') => {
    const response = await fetch(`${service.origin}/api${route}`, { method, headers: { Authorization: `Bearer ${service.token}`, Origin: service.origin, 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    return { status: response.status, value: await response.json() };
  };
  const a = await request('/threads', { purpose: 'Default conversation project' }); assert.equal(a.value.projectId, 'conversations');
  const b = await request('/threads', { purpose: 'Explicit project selection', projectId: 'sample' }); assert.equal(b.value.projectId, 'sample');
  const mismatch = await request('/sessions', { agent: 'shell', name: 'Wrong project worker', alphaThreadId: b.value.id, projectId: 'conversations' });
  assert.equal(mismatch.status, 409); assert.equal(service.sessions.list().length, 0);
  const coordinator = await service.getCoordinator(b.value.id);
  await assert.rejects(coordinator.execute('open_chat', { agent: 'codex', name: 'Wrong project task', projectId: 'conversations' }, 'fixture-op'), /authoritative/);
  await request(`/threads/${b.value.id}/draft`, { text: 'Persist this private draft', paths: [] });
  const removed = await request('/workspace/projects/sample/remove', { scope: 'keep-files', confirmation: 'sample' }); assert.equal(removed.status, 200);
  assert.equal((await request('/threads', { purpose: 'Removed project rejected', projectId: 'sample' })).status, 404);
  await service.close(); service = await createService({ repo, uiDir: path.join(repo, 'ui'), mcpOptions: { home: repo, env: {} } });
  const state = (await request('/threads', undefined, 'GET')).value;
  const saved = state.threads.find(item => item.id === b.value.id); assert.equal(saved.projectId, 'sample'); assert.equal(saved.draft.text, 'Persist this private draft');
  assert.equal(state.threads.find(item => item.id === a.value.id).projectId, 'conversations');
});
test('resuming an upstream worker is blocked before process launch and preserves its identity/history', async t => {
  const { repo, projects } = await fixture();
  await projects.patch('sample', { sourceRepositoryUrl: 'https://github.com/reference-owner/source' });
  const cwd = path.join(repo, 'old-source'); await mkdir(path.join(cwd, '.git'), { recursive: true });
  const commands = [];
  const execute = async (file, args) => {
    commands.push([file, ...args]);
    if (file === 'git' && args.includes('--show-toplevel')) return { stdout: cwd };
    if (file === 'git' && args.includes('get-url')) return { stdout: 'https://github.com/reference-owner/source.git' };
    if (file === 'gh') return { stdout: JSON.stringify({ id: 81, private: false, full_name: 'reference-owner/source', owner: { login: 'reference-owner' }, html_url: 'https://github.com/reference-owner/source' }) };
    throw new Error('Unexpected command');
  };
  const service = await createService({ repo, uiDir: repo, repositoryOptions: { execute }, mcpOptions: { home: repo, env: {} } });
  t.after(() => service.close());
  const session = service.sessions.make({ id: 'retained-native-id', agent: 'shell', name: 'Retained source history', cwd, projectId: 'sample', open: false, status: 'stopped', nativeId: null, cols: 80, rows: 24 });
  service.sessions.items.set(session.id, session);
  await assert.rejects(service.sessions.resume(session.id), /Only william-pyle/);
  assert.equal(service.sessions.get(session.id).id, 'retained-native-id'); assert.equal(session.open, false); assert.ok(!session.process);
  assert.ok(commands.every(command => !command.includes('clone') && !command.includes('push')));
});
