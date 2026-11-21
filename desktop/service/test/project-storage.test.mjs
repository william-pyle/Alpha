import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { Workspace } from '../workspace.mjs';
import { Projects } from '../projects.mjs';
import { ProjectStorage, NativeStorage } from '../project-storage.mjs';

const exec = promisify(execFile);
const exists = file => lstat(file).then(() => true, () => false);
async function fixture(t, options = {}, id = 'sample') {
  const repo = await realpath(await mkdtemp(path.join(tmpdir(), 'alpha-storage-test-')));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const root = path.join(repo, 'projects', id), github = path.join(root, 'github');
  await mkdir(github, { recursive: true }); await mkdir(path.join(root, 'workspace')); await mkdir(path.join(repo, 'workspace'));
  await writeFile(path.join(repo, 'workspace/workspace.json'), JSON.stringify({ entities: [{ id, title: 'Sample', status: 'active', folder: id, workspacePath: `projects/${id}/workspace`, steps: [] }] }));
  await exec('git', ['init', github], { windowsHide: true });
  await exec('git', ['-C', github, 'remote', 'add', 'origin', 'https://github.com/william-pyle/Sample.git'], { windowsHide: true });
  await writeFile(path.join(github, 'Cargo.toml'), '[package]\nname="sample"\nversion="0.1.0"\n');
  await writeFile(path.join(github, '.gitignore'), '/target/\n');
  await mkdir(path.join(github, 'target')); await writeFile(path.join(github, 'target/build.bin'), 'regenerable');
  await mkdir(path.join(github, 'src')); await writeFile(path.join(github, 'src/main.rs'), 'fn main() {}');
  await exec('git', ['-C', github, 'add', 'Cargo.toml', '.gitignore', 'src/main.rs'], { windowsHide: true });
  const projects = new Projects(new Workspace(repo));
  const verified = [], commands = [];
  const repositories = { command: async (file, args) => { commands.push([file, ...args]); return exec(file, args, { windowsHide: true, maxBuffer: 2_000_000 }); }, verify: async url => { verified.push(url); if (!url.includes('github.com/william-pyle/')) throw new Error('Read-only repository owner'); return { owner: 'william-pyle', id: 123 }; } };
  const storage = new ProjectStorage({ repo, projects, repositories, measure: async () => ({ allocatedBytes: 4096, logicalBytes: 10000, files: 2, errors: 0, skippedLinks: 0 }), ...options });
  t.after(() => storage.close());
  return { repo, root, github, projects, storage, verified, commands };
}

test('card measurements are asynchronous, bounded, cached and do not confuse allocation with logical size', async t => {
  let calls = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const { storage } = await fixture(t, { measure: async () => { calls++; await gate; return { allocatedBytes: 4096, logicalBytes: 9000, files: 1, errors: 0, skippedLinks: 0 }; } });
  assert.ok(['queued', 'scanning'].includes((await storage.list()).projects[0].status));
  await storage.list(); assert.equal(calls <= 1, true); release();
  for (let n = 0; n < 100 && storage.values.get('sample')?.status !== 'ready'; n++) await new Promise(r => setTimeout(r, 10));
  const row = (await storage.list()).projects[0];
  assert.equal(row.status, 'ready'); assert.equal(row.allocatedBytes, 4096); assert.equal(row.logicalBytes, 9000); assert.equal(calls, 1);
});

test('native transport requires capability and validates native disk totals', async t => {
  const bridge = new NativeStorage(event => queueMicrotask(() => bridge.receive(event.type === 'project-storage-capabilities' ? { ...event, available: true } : { type: 'project-storage-result', requestId: event.requestId, allocatedBytes: 2048, logicalBytes: 4096, files: 1, skippedLinks: 0, errors: 0 })));
  t.after(() => bridge.close()); assert.equal((await bridge.measure('C:/fixture')).allocatedBytes, 2048);
  bridge.send = event => queueMicrotask(() => bridge.receive({ type: 'project-storage-result', requestId: event.requestId, allocatedBytes: -1 }));
  await assert.rejects(bridge.measure('C:/fixture'), /invalid totals/);
});

test('cleanup previews only ignored build directories, then preserves source, Git and reports', async t => {
  const { storage, github, root, verified, commands } = await fixture(t);
  await writeFile(path.join(root, 'workspace/report.html'), 'keep');
  const plan = await storage.cleanupPlan('sample');
  assert.equal(plan.blockedReason, undefined); assert.deepEqual(plan.candidates.map(c => c.path), ['github/target']);
  assert.equal(plan.candidates[0].logicalBytes, 11);
  assert.equal((await storage.clean('sample', { confirmation: 'sample', previewToken: plan.previewToken })).removed.length, 1);
  assert.equal(await exists(path.join(github, 'target')), false);
  assert.equal(await readFile(path.join(github, 'src/main.rs'), 'utf8'), 'fn main() {}');
  assert.equal(await exists(path.join(github, '.git')), true); assert.equal(await readFile(path.join(root, 'workspace/report.html'), 'utf8'), 'keep');
  assert.ok(verified.length >= 2); assert.ok(commands.every(args => !args.includes('push') && !args.includes('clean')));
});

test('tracked files, nonignored outputs and unfamiliar directories are not cleanup candidates', async t => {
  const { storage, github } = await fixture(t);
  await exec('git', ['-C', github, 'add', '-f', 'target/build.bin'], { windowsHide: true });
  assert.deepEqual((await storage.cleanupPlan('sample')).candidates, []);
  await exec('git', ['-C', github, 'rm', '--cached', 'target/build.bin'], { windowsHide: true });
  await writeFile(path.join(github, '.gitignore'), '');
  assert.deepEqual((await storage.cleanupPlan('sample')).candidates, []);
});

test('stale preview or running worker blocks deletion before any build folder is touched', async t => {
  const sessions = [], { storage, github, repo } = await fixture(t, { sessions: () => sessions });
  const plan = await storage.cleanupPlan('sample');
  await writeFile(path.join(github, 'target/new.bin'), 'new build');
  await assert.rejects(storage.clean('sample', { confirmation: 'sample', previewToken: plan.previewToken }), /changed after the preview/);
  assert.equal(await exists(path.join(github, 'target/build.bin')), true);
  sessions.push({ projectId: 'sample', status: 'running', activity: 'idle' });
  assert.match((await storage.cleanupPlan('sample')).blockedReason, /running worker/);
  assert.match((await storage.deletionPlan('sample')).blockedReason, /running worker/);
  sessions[0] = { status: 'running', activity: 'idle', cwd: repo, projectId: null };
  assert.match((await storage.cleanupPlan('sample')).blockedReason, /unassigned parent/);
});

test('foreign repository, nested repository in build output, and protected running app block destructive actions', async t => {
  const { storage, github, root } = await fixture(t);
  await mkdir(path.join(github, 'target/nested/.git'), { recursive: true });
  assert.match((await storage.cleanupPlan('sample')).skipped[0].reason, /nested Git repository/);
  await rm(path.join(github, 'target/nested'), { recursive: true });
  await exec('git', ['-C', github, 'remote', 'set-url', 'origin', 'https://github.com/other-owner/Sample.git'], { windowsHide: true });
  assert.match((await storage.deletionPlan('sample')).blockedReason, /Read-only repository owner/);
  storage.protectedRoots.push(path.join(root, 'runtime'));
  assert.match((await storage.deletionPlan('sample')).blockedReason, /running Alpha/);
});

test('project deletion discovers hidden foreign repositories and external worktrees', async t => {
  const { storage, root, github } = await fixture(t);
  const nested = path.join(root, 'workspace/media/nested'); await mkdir(nested, { recursive: true });
  await exec('git', ['init', nested], { windowsHide: true });
  await exec('git', ['-C', nested, 'remote', 'add', 'origin', 'https://github.com/other-owner/Nested.git'], { windowsHide: true });
  assert.match((await storage.deletionPlan('sample')).blockedReason, /Read-only repository owner/);
  await rm(nested, { recursive: true });
  await exec('git', ['-C', github, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture'], { windowsHide: true });
  const external = path.join(path.dirname(root), 'worktree');
  await exec('git', ['-C', github, 'worktree', 'add', '--detach', external], { windowsHide: true });
  assert.match((await storage.deletionPlan('sample')).blockedReason, /additional worktrees/);
});

test('cleanup unlinks a junction without touching its destination; root aliases are rejected', async t => {
  const { storage, root, repo, github } = await fixture(t);
  const outside = path.join(repo, 'outside'); await mkdir(outside); await writeFile(path.join(outside, 'important.txt'), 'keep');
  await symlink(outside, path.join(github, 'target/linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const plan = await storage.cleanupPlan('sample');
  assert.equal(plan.blockedReason, undefined);
  await storage.clean('sample', { confirmation: 'sample', previewToken: plan.previewToken });
  assert.equal(await readFile(path.join(outside, 'important.txt'), 'utf8'), 'keep');
  await rm(root, { recursive: true }); await symlink(outside, root, process.platform === 'win32' ? 'junction' : 'dir');
  assert.match((await storage.deletionPlan('sample')).blockedReason, /symbolic link or junction/);
});

test('full deletion removes project directory and persists stable tombstone, with no remote writes', async t => {
  const { storage, projects, root, commands } = await fixture(t);
  await assert.rejects(storage.deleteProject('sample', { confirmation: 'wrong' }), /exact project ID/);
  const result = await storage.deleteProject('sample', { confirmation: 'sample' });
  assert.equal(result.scope, 'delete-files'); assert.equal(await exists(root), false);
  const record = await projects.get('sample'); assert.equal(record.removalScope, 'delete-files'); assert.ok(record.removedAt); assert.equal(record.id, 'sample');
  assert.ok(result.retained.includes('GitHub repository'));
  assert.ok(commands.every(args => args[0] === 'git' && !args.includes('push')));
});

test('a locked partial deletion stays visible and can be retried after a service reload', async t => {
  const { storage, projects, root, repo } = await fixture(t, { removeTree: async () => { throw Object.assign(new Error('locked fixture'), { code: 'EBUSY' }); } });
  await assert.rejects(storage.deleteProject('sample', { confirmation: 'sample' }), /Deletion is incomplete/);
  assert.equal(await exists(root), false);
  const pending = await projects.get('sample'); assert.equal(pending.removedAt, undefined); assert.equal(pending.deletionPending, true);
  await assert.rejects(projects.select('sample'), /deletion is incomplete/);
  const reload = new ProjectStorage({ repo, projects: new Projects(new Workspace(repo)), repositories: storage.repositories, measure: storage.measure }); t.after(() => reload.close());
  await reload.initialize();
  assert.throws(() => reload.assertAvailable('sample'), /pending or completed/);
  assert.equal((await reload.deletionPlan('sample')).retry, true);
  await reload.deleteProject('sample', { confirmation: 'sample' });
  assert.ok((await projects.get('sample')).removedAt);
  assert.equal(await exists(path.join(repo, '.alpha/project-deletions', pending.deletionOperation, 'files')), false);
  await assert.rejects(reload.assertUsable('sample'), /pending or completed/);
});

test('test-cache cleanup preserves nested repositories while clearing safe sibling output', async t => {
  const { storage, github } = await fixture(t, {}, 'alpha');
  await writeFile(path.join(github, '.gitignore'), '/target/\n/.test-output/\n');
  const cache = path.join(github, '.test-output');
  await mkdir(path.join(cache, 'nested-fixture/repository/.git'), { recursive: true });
  await writeFile(path.join(cache, 'nested-fixture/repository/source.txt'), 'preserve all repo files');
  await mkdir(path.join(cache, 'nested-fixture/browser-cache')); await writeFile(path.join(cache, 'nested-fixture/browser-cache/data.bin'), 'cache');
  await mkdir(path.join(cache, 'other-output')); await writeFile(path.join(cache, 'other-output/test.log'), 'generated');
  const plan = await storage.cleanupPlan('alpha'); assert.equal(plan.blockedReason, undefined);
  assert.ok(plan.skipped.some(item => item.path.endsWith('/repository')));
  assert.ok(plan.candidates.some(item => item.path.endsWith('/browser-cache')));
  await storage.clean('alpha', { confirmation: 'alpha', previewToken: plan.previewToken });
  assert.equal(await readFile(path.join(cache, 'nested-fixture/repository/source.txt'), 'utf8'), 'preserve all repo files');
  assert.equal(await exists(path.join(cache, 'other-output')), false);
  assert.equal(await exists(path.join(cache, 'nested-fixture/browser-cache')), false);
  assert.match((await storage.deletionPlan('alpha')).blockedReason, /nested Git repository/);
});

test('a newly introduced ancestor repository blocks cleanup and project deletion', async t => {
  const { storage, repo, github } = await fixture(t);
  const plan = await storage.cleanupPlan('sample');
  await exec('git', ['init', repo], { windowsHide: true });
  await assert.rejects(storage.clean('sample', { confirmation: 'sample', previewToken: plan.previewToken }), /inside a Git checkout/);
  assert.match((await storage.deletionPlan('sample')).blockedReason, /inside a Git checkout/);
  assert.equal(await exists(path.join(github, 'target/build.bin')), true);
});
