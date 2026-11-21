import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ProjectRepositories, githubRepository } from '../project-repositories.mjs';
import { safeProjectPaths } from '../project-layout.mjs';
import { readJson, saveJson } from '../util.mjs';

const metadata = (name = 'Sample', owner = 'william-pyle', id = 17) => ({ id, full_name: `${owner}/${name}`, html_url: `https://github.com/${owner}/${name}`, owner: { login: owner }, private: true });
const creation = (extra = {}) => ({ account: 'william-pyle', name: 'Sample', description: 'A fixture, never a real remote', visibility: 'private', requestId: randomUUID(), ...extra });
const notFound = () => Object.assign(new Error('Not found'), { stderr: 'gh: Not Found (HTTP 404)' });

async function fixture(t, options = {}) {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'alpha-project-repositories-'));
  const paths = safeProjectPaths(repo, 'sample');
  await mkdir(paths.workspace, { recursive: true });
  await writeFile(path.join(paths.workspace, 'private.txt'), 'Private report: never stage or publish.');
  const record = path.join(paths.root, 'fixture-project.json');
  await saveJson(record, { id: 'sample', title: 'Sample', sourceRepositoryUrl: 'https://github.com/storytold/reference', ...options.project });
  const calls = [], events = [], remotes = new Map(), checkouts = new Map();
  for (const remote of options.remotes || []) remotes.set(remote.full_name.toLowerCase(), remote);
  const control = { account: 'william-pyle', cloneFailures: 0, partialClone: false, patchFailures: 0, remoteFailure: false, ...options.control };
  const execute = async (file, args, commandOptions) => {
    calls.push({ file, args: [...args], cwd: commandOptions.cwd });
    control.onCommand?.(file, args);
    assert.equal(commandOptions.windowsHide, true);
    if (file === 'gh') {
      const endpoint = args[3];
      if (endpoint === 'user') return { stdout: JSON.stringify({ login: control.account, id: 42 }) };
      if (endpoint === 'user/repos') {
        assert.ok(args.includes('POST'));
        const name = args.find(value => value.startsWith('name=')).slice(5);
        const remote = metadata(name, control.account, 31); remotes.set(remote.full_name.toLowerCase(), remote);
        if (control.remoteFailure) { control.remoteFailure = false; throw new Error('Network lost after creation'); }
        return { stdout: JSON.stringify(remote) };
      }
      if (endpoint.startsWith('repos/')) {
        const value = control.metadataOverride || remotes.get(endpoint.slice(6).toLowerCase());
        if (!value) throw notFound();
        return { stdout: JSON.stringify(value) };
      }
    }
    if (file === 'git') {
      if (args.includes('--get-url')) return { stdout: `${control.rewrittenUrl || args.at(-1)}\n` };
      if (args.includes('clone')) {
        if (control.cloneGate) await control.cloneGate;
        const destination = args.at(-1), url = args.at(-2);
        assert.equal(destination, paths.github); assert.equal(url, 'https://github.com/william-pyle/Sample.git');
        if (control.cloneFailures > 0) {
          control.cloneFailures--;
          if (control.partialClone) await writeFile(path.join(destination, 'partial.txt'), 'Keep this partial checkout');
          throw new Error('Clone failed');
        }
        await mkdir(path.join(destination, '.git'));
        await writeFile(path.join(destination, '.git', 'fixture-history'), 'Existing history');
        await writeFile(path.join(destination, 'README.md'), 'Remote content');
        checkouts.set(destination, url);
        return { stdout: '' };
      }
      const directory = args[1];
      if (args.includes('--show-toplevel')) return { stdout: `${control.topLevel || directory}\n` };
      if (args.includes('--absolute-git-dir') || args.includes('--git-common-dir')) return { stdout: `${control.gitDirectory || path.join(directory, '.git')}\n` };
      if (args.includes('worktree') && args.includes('list')) return { stdout: control.worktrees || `worktree ${directory}\nHEAD ${'a'.repeat(40)}\nbranch refs/heads/main\n` };
      if (args.includes('ls-files')) return { stdout: control.gitIndex || `100644 ${'a'.repeat(40)} 0\tREADME.md\n` };
      if (args.includes('config') && args.includes('--list')) return { stdout: control.localConfig || 'core.repositoryformatversion\n0\0core.bare\nfalse\0' };
      if (args.includes('get-url')) return { stdout: `${args.includes('--push') && control.pushUrl || checkouts.get(directory) || 'https://github.com/william-pyle/Sample.git'}\n` };
    }
    throw new Error(`Unexpected mocked command: ${file} ${args.join(' ')}`);
  };
  const getProject = async (id, { allowRemoved = false } = {}) => {
    assert.equal(id, 'sample');
    const project = await readJson(record, null);
    if (project.removedAt && !allowRemoved) throw Object.assign(new Error('Project is removed'), { status: 404 });
    return project;
  };
  const patchProject = async (id, patch) => {
    if (control.patchFailures > 0 && patch.projectRepositoryUrl) { control.patchFailures--; throw new Error('Settings save failed'); }
    if (control.checkoutPatchFailures > 0 && patch.checkoutPath) { control.checkoutPatchFailures--; throw new Error('Checkout settings save failed'); }
    const project = { ...await getProject(id), ...patch };
    await saveJson(record, project); return project;
  };
  const fresh = () => new ProjectRepositories({ repo, getProject, patchProject, changed: job => events.push(job), execute, activeSessions: () => control.sessions || [] });
  const service = fresh();
  t.after(async () => {
    await Promise.all([...service.tasks.values()]);
    assert.equal(path.dirname(repo), path.resolve(os.tmpdir()));
    assert.ok(path.basename(repo).startsWith('alpha-project-repositories-'));
    await rm(repo, { recursive: true, force: true });
  });
  return { repo, paths, record, service, fresh, getProject, calls, events, control, remotes, checkouts };
}

test('GitHub URL validation rejects credentials, traversal, arbitrary hosts and non-repository links', () => {
  assert.equal(githubRepository('git@github.com:william-pyle/Alpha.git').url, 'https://github.com/william-pyle/Alpha');
  assert.equal(githubRepository('https://github.com/storytold/reference').owner, 'storytold');
  assert.equal(githubRepository('', { optional: true }), null);
  for (const value of ['', undefined, ' https://github.com/a/b', 'https://github.com/a/b ', 'http://github.com/a/b', 'https://user:password@github.com/a/b', 'https://github.com.evil.test/a/b', 'https://github.com:444/a/b', 'https://github.com/a/b?token=secret', 'https://github.com/a/b#fragment', 'https://github.com/a/b/tree/main', 'https://github.com/a/../a/b', 'https://github.com/a/%2e%2e/b', 'https://github.com/a\\b', '--upload-pack=evil']) assert.throws(() => githubRepository(value));
});

test('source association is independent, persists and never runs Git or GitHub mutation', async t => {
  const f = await fixture(t, { project: { projectRepositoryUrl: 'https://github.com/william-pyle/Sample' } });
  await f.service.associate('sample', { sourceRepositoryUrl: 'https://github.com/tangency-labs/solidcraft' });
  const saved = await f.fresh().getProject('sample');
  assert.equal(saved.projectRepositoryUrl, 'https://github.com/william-pyle/Sample');
  assert.equal(saved.sourceRepositoryUrl, 'https://github.com/tangency-labs/solidcraft');
  assert.deepEqual(f.calls, []);
  await f.service.associate('sample', { sourceRepositoryUrl: '' });
  assert.equal((await f.getProject('sample')).projectRepositoryUrl, saved.projectRepositoryUrl);
});

test('actual metadata owner overrides URL spelling and unknown ownership blocks all local checkout writes', async t => {
  const f = await fixture(t, { control: { metadataOverride: metadata('Sample', 'storytold') } });
  await assert.rejects(f.service.associate('sample', { projectRepositoryUrl: 'https://github.com/william-pyle/Sample' }), /belongs to storytold/);
  assert.ok(f.calls.every(call => call.file === 'gh' && !call.args.includes('POST')));
  assert.equal((await f.getProject('sample')).projectRepositoryUrl, undefined);
  assert.deepEqual((await readdir(f.paths.root)).sort(), ['fixture-project.json', 'workspace']);
  f.control.metadataOverride = { id: 17, full_name: 'william-pyle/Sample', html_url: 'https://github.com/william-pyle/Sample' };
  await assert.rejects(f.service.associate('sample', { projectRepositoryUrl: 'https://github.com/william-pyle/Sample' }), /identity could not/);
});

test('working association clones directly into github, preserves source and private workspace, and verifies push destination', async t => {
  const f = await fixture(t, { remotes: [metadata()] });
  const response = await f.service.associate('sample', { projectRepositoryUrl: 'https://github.com/william-pyle/Sample' });
  assert.equal(response.project.sourceRepositoryUrl, 'https://github.com/storytold/reference');
  const completed = await f.service.wait('sample');
  assert.equal(completed.status, 'completed', completed.error);
  assert.equal(completed.checkoutPath, f.paths.github);
  const saved = await f.getProject('sample');
  assert.equal(saved.checkoutPath, f.paths.github); assert.equal(saved.repositoryVerification.owner, 'william-pyle'); assert.equal(saved.repositoryState, 'ready');
  assert.equal(await readFile(path.join(f.paths.workspace, 'private.txt'), 'utf8'), 'Private report: never stage or publish.');
  assert.ok(!((await readdir(f.paths.github)).includes('workspace')));
  assert.equal(f.calls.filter(call => call.args.includes('clone')).length, 1);
  assert.ok(!f.calls.some(call => call.file === 'git' && call.args.some(arg => ['add', 'commit', 'push', 'remote-delete'].includes(arg))));
  assert.ok(!f.calls.some(call => call.args.some(arg => arg.includes('storytold'))));
  assert.equal((await f.fresh().state('sample')).status, 'completed');
});

test('existing checkout is reused without changing local history or uncommitted files', async t => {
  const f = await fixture(t, { remotes: [metadata()] });
  await mkdir(path.join(f.paths.github, '.git'), { recursive: true });
  await writeFile(path.join(f.paths.github, '.git', 'history'), 'keep Git history');
  await writeFile(path.join(f.paths.github, 'uncommitted.txt'), 'local changes');
  await f.service.associate('sample', { projectRepositoryUrl: 'https://github.com/william-pyle/Sample' });
  assert.equal((await f.service.wait('sample')).status, 'completed');
  assert.equal(await readFile(path.join(f.paths.github, '.git', 'history'), 'utf8'), 'keep Git history');
  assert.equal(await readFile(path.join(f.paths.github, 'uncommitted.txt'), 'utf8'), 'local changes');
  assert.ok(f.calls.every(call => !call.args.includes('clone')));
});

test('external authoritative checkout and nested Git roots are never duplicated', async t => {
  const f = await fixture(t, { remotes: [metadata()], project: { checkoutPath: path.join(os.tmpdir(), 'existing-pinned-checkout') } });
  await f.service.associate('sample', { projectRepositoryUrl: 'https://github.com/william-pyle/Sample' });
  const deferred = await f.service.wait('sample'); assert.equal(deferred.status, 'failed'); assert.match(deferred.error, /Resolve its migration/);
  assert.equal((await f.getProject('sample')).projectRepositoryUrl, 'https://github.com/william-pyle/Sample');
  assert.equal((await f.getProject('sample')).repositoryState, 'failed');
  await assert.rejects(f.service.create('sample', creation()), /Resolve its migration/);
  assert.ok(f.calls.every(call => call.file !== 'git' && !call.args.includes('POST')));
  const project = await f.getProject('sample'); delete project.checkoutPath; await saveJson(f.record, project);
  await mkdir(path.join(f.repo, '.git'));
  await assert.rejects(f.service.create('sample', creation()), /inside another Git checkout/);
});

test('wrong account and occupied destinations reject creation without any remote write', async t => {
  const f = await fixture(t, { control: { account: 'different-account' } });
  await assert.rejects(f.service.create('sample', creation({ account: 'different-account' })), /destination account/);
  await f.service.create('sample', creation());
  const denied = await f.service.wait('sample'); assert.equal(denied.status, 'failed'); assert.match(denied.error, /Sign in/);
  assert.ok(!f.calls.some(call => call.args.includes('POST')));
  await mkdir(f.paths.github); await writeFile(path.join(f.paths.github, 'keep.txt'), 'not a repository');
  await assert.rejects(f.service.create('sample', creation()), /already exists/);
  assert.equal(await readFile(path.join(f.paths.github, 'keep.txt'), 'utf8'), 'not a repository');
});

test('explicit create saves metadata then clones, and repeated submit is idempotent', async t => {
  const f = await fixture(t);
  const input = creation();
  await f.service.create('sample', input);
  assert.equal((await f.service.wait('sample')).status, 'completed');
  await f.service.create('sample', input);
  assert.equal(f.calls.filter(call => call.args.includes('POST')).length, 1);
  assert.equal(f.calls.filter(call => call.args.includes('clone')).length, 1);
  assert.equal((await f.getProject('sample')).sourceRepositoryUrl, 'https://github.com/storytold/reference');
  await assert.rejects(f.service.create('sample', { ...input, name: 'Changed' }), /different repository details/);
  await assert.rejects(f.service.create('sample', creation()), /already exists|already has/);
});

test('existing remote name is a conflict and is never adopted by a fresh create request', async t => {
  const f = await fixture(t, { remotes: [metadata()] });
  await f.service.create('sample', creation());
  const job = await f.service.wait('sample');
  assert.equal(job.status, 'failed'); assert.match(job.error, /already exists/);
  assert.ok(!f.calls.some(call => call.file === 'git' || call.args.includes('POST')));
});

test('remote creation followed by settings failure resumes after service reconstruction without another remote', async t => {
  const f = await fixture(t, { control: { patchFailures: 1 } });
  await f.service.create('sample', creation());
  const failed = await f.service.wait('sample');
  assert.equal(failed.status, 'failed'); assert.equal(failed.remote.fullName, 'william-pyle/Sample');
  const restarted = f.fresh();
  await restarted.retry('sample'); assert.equal((await restarted.wait('sample')).status, 'completed');
  assert.equal(f.calls.filter(call => call.args.includes('POST')).length, 1);
  assert.equal((await f.getProject('sample')).projectRepositoryUrl, 'https://github.com/william-pyle/Sample');
});

test('ambiguous remote response is recovered by metadata lookup, not duplicate creation', async t => {
  const f = await fixture(t, { control: { remoteFailure: true } });
  await f.service.create('sample', creation());
  assert.equal((await f.service.wait('sample')).status, 'failed');
  const restarted = f.fresh();
  await restarted.retry('sample'); assert.equal((await restarted.wait('sample')).status, 'completed');
  assert.equal(f.calls.filter(call => call.args.includes('POST')).length, 1);
});

test('empty clone failure retries safely; partial clone content is preserved with a recoverable conflict', async t => {
  const f = await fixture(t, { control: { cloneFailures: 1 } });
  await f.service.create('sample', creation());
  assert.equal((await f.service.wait('sample')).status, 'failed');
  assert.equal((await f.getProject('sample')).projectRepositoryUrl, 'https://github.com/william-pyle/Sample');
  await f.service.retry('sample'); assert.equal((await f.service.wait('sample')).status, 'completed');
  assert.equal(f.calls.filter(call => call.args.includes('POST')).length, 1);
  const partial = await fixture(t, { control: { cloneFailures: 1, partialClone: true } });
  await partial.service.create('sample', creation()); await partial.service.wait('sample');
  await partial.service.retry('sample'); const result = await partial.service.wait('sample');
  assert.equal(result.status, 'failed'); assert.match(result.error, /partial checkout/);
  assert.equal(await readFile(path.join(partial.paths.github, 'partial.txt'), 'utf8'), 'Keep this partial checkout');
  assert.equal(partial.calls.filter(call => call.args.includes('POST')).length, 1);
  assert.equal(partial.calls.filter(call => call.args.includes('clone')).length, 1);
});

test('background clone does not block status or source association and working changes are rejected while active', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { remotes: [metadata()], control: { cloneGate: gate } });
  try {
    await f.service.associate('sample', { projectRepositoryUrl: 'https://github.com/william-pyle/Sample' });
    assert.ok(['queued', 'running'].includes((await f.service.state('sample')).status));
    await f.service.associate('sample', { sourceRepositoryUrl: 'https://github.com/storytold/another' });
    await assert.rejects(f.service.associate('sample', { projectRepositoryUrl: '' }), /already running/);
  } finally { release(); }
  assert.equal((await f.service.wait('sample')).status, 'completed');
  assert.equal((await f.getProject('sample')).sourceRepositoryUrl, 'https://github.com/storytold/another');
});

test('a different or unowned push destination fails without changing checkout files', async t => {
  const f = await fixture(t, { remotes: [metadata()], control: { pushUrl: 'https://github.com/storytold/reference' } });
  f.remotes.set('storytold/reference', metadata('reference', 'storytold', 88));
  await f.service.associate('sample', { projectRepositoryUrl: 'https://github.com/william-pyle/Sample' });
  const failed = await f.service.wait('sample'); assert.equal(failed.status, 'failed'); assert.match(failed.error, /belongs to storytold/);
  assert.equal((await f.getProject('sample')).checkoutPath, undefined);
  assert.equal(await readFile(path.join(f.paths.github, 'README.md'), 'utf8'), 'Remote content');
});

test('Git URL rewrite cannot clone another owner or local source despite eligible typed URL', async t => {
  const f = await fixture(t, { remotes: [metadata()], control: { rewrittenUrl: 'https://github.com/storytold/reference.git' } });
  f.remotes.set('storytold/reference', metadata('reference', 'storytold', 88));
  await f.service.associate('sample', { projectRepositoryUrl: 'https://github.com/william-pyle/Sample' });
  const job = await f.service.wait('sample'); assert.equal(job.status, 'failed'); assert.match(job.error, /belongs to storytold/);
  assert.ok(!f.calls.some(call => call.args.includes('clone')));
  assert.ok(!(await readdir(f.paths.root)).includes('github'));
});

test('junction escape blocks repository creation before GitHub access', async t => {
  const f = await fixture(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), 'alpha-project-repositories-escape-'));
  t.after(async () => { assert.equal(path.dirname(outside), path.resolve(os.tmpdir())); assert.ok(path.basename(outside).startsWith('alpha-project-repositories-escape-')); await rm(outside, { recursive: true, force: true }); });
  await symlink(outside, f.paths.github, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.service.create('sample', creation()), /symbolic link or junction/);
  assert.deepEqual(f.calls, []); assert.deepEqual(await readdir(outside), []);
});

test('removed projects and invalid IDs cannot launch repository work', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.create('../outside', creation()), /stable project ID/);
  await saveJson(f.record, { ...await f.getProject('sample'), removedAt: new Date().toISOString() });
  await assert.rejects(f.service.create('sample', creation()), /removed/);
  assert.deepEqual(f.calls, []);
});

test('new workers may use ordinary workspace folders but must verify Git checkout ownership and identity', async t => {
  const f = await fixture(t, { remotes: [metadata(), metadata('reference', 'storytold', 88)] });
  assert.deepEqual(await f.service.validateWorkingDirectory('sample', f.paths.workspace), { cwd: f.paths.workspace, repository: null });
  await f.service.associate('sample', { projectRepositoryUrl: 'https://github.com/william-pyle/Sample' });
  await f.service.wait('sample');
  const checked = await f.service.validateWorkingDirectory('sample', f.paths.github);
  assert.equal(checked.repository.owner, 'william-pyle');
  f.checkouts.set(f.paths.github, 'https://github.com/storytold/reference.git');
  await assert.rejects(f.service.validateWorkingDirectory('sample', f.paths.github), /belongs to storytold/);
});

test('new worker cannot use the source-only repository or a partial checkout', async t => {
  const f = await fixture(t, { remotes: [metadata()], project: { sourceRepositoryUrl: 'https://github.com/william-pyle/Sample', repositoryState: 'ready' } });
  await mkdir(path.join(f.paths.github, '.git'), { recursive: true });
  await assert.rejects(f.service.validateWorkingDirectory('sample', f.paths.github), /source repository is a read-only reference/);
  await saveJson(f.record, { ...await f.getProject('sample'), repositoryState: 'failed' });
  await assert.rejects(f.service.validateWorkingDirectory('sample', f.paths.github), /checkout is not ready/);
  assert.ok(!f.calls.some(call => call.args.includes('POST') || call.args.includes('clone')));
});

test('ordinary-looking workspace nested under a source Git tree still requires ownership verification', async t => {
  const f = await fixture(t, { remotes: [metadata('reference', 'storytold', 88)] });
  await mkdir(path.join(f.repo, '.git'));
  f.control.topLevel = f.repo;
  f.checkouts.set(f.paths.workspace, 'https://github.com/storytold/reference.git');
  await assert.rejects(f.service.validateWorkingDirectory('sample', f.paths.workspace), /belongs to storytold/);
  assert.ok(!f.calls.some(call => call.args.includes('POST') || call.args.includes('clone')));
  assert.equal(await readFile(path.join(f.paths.workspace, 'private.txt'), 'utf8'), 'Private report: never stage or publish.');
});

test('an interrupted durable job clears checkout readiness until verified retry', async t => {
  const f = await fixture(t, { project: { repositoryState: 'ready' } });
  const file = await f.service.jobFile('sample');
  await saveJson(file, { projectId: 'sample', kind: 'associate', requestId: randomUUID(), repositoryUrl: 'https://github.com/william-pyle/Sample', status: 'running', phase: 'Preparing checkout' });
  const job = await f.fresh().state('sample');
  assert.equal(job.status, 'interrupted');
  assert.equal((await f.getProject('sample')).repositoryState, 'interrupted');
});

async function migrationFixture(t, options = {}) {
  const f = await fixture(t, { remotes: [metadata()], ...options });
  const old = path.join(f.repo, 'legacy-checkout');
  await mkdir(old);
  if (options.gitFile) await writeFile(path.join(old, '.git'), 'gitdir: ../external-metadata');
  else {
    await mkdir(path.join(old, '.git'));
    await writeFile(path.join(old, '.git', 'history.fixture'), Buffer.from([0, 255, 10, 7, 6, 21]));
  }
  await writeFile(path.join(old, 'dirty.txt'), 'Uncommitted work\r\nKeep exact bytes.');
  await writeFile(path.join(old, 'untracked.txt'), 'Do not lose untracked content.');
  await saveJson(f.record, { ...await f.getProject('sample'), checkoutPath: old, projectRepositoryUrl: 'https://github.com/william-pyle/Sample', ...options.project });
  const canonical = path.join(f.paths.root, 'project.json');
  await saveJson(canonical, { applicationRoot: old, source: { checkout: old, repository: 'https://github.com/william-pyle/Sample', upstream: 'https://github.com/storytold/reference' }, development: { sourceFolder: old, command: 'keep this' }, custom: 'Preserve metadata' });
  return { ...f, old, canonical };
}

test('confirmed checkout migration atomically preserves Git history, dirty/untracked files and provenance', async t => {
  const f = await migrationFixture(t);
  const history = await readFile(path.join(f.old, '.git/history.fixture'));
  const dirty = await readFile(path.join(f.old, 'dirty.txt'));
  assert.equal((await f.service.checkoutMigrationPlan('sample')).status, 'ready');
  await assert.rejects(f.service.migrateCheckout('sample', { confirmation: 'other' }), /exact project ID/);
  const moved = await f.service.migrateCheckout('sample', { confirmation: 'sample' });
  assert.equal(moved.status, 'applied'); assert.equal(moved.phase, 'committed');
  assert.equal(await lstat(f.old).catch(() => null), null);
  assert.deepEqual(await readFile(path.join(f.paths.github, '.git/history.fixture')), history);
  assert.deepEqual(await readFile(path.join(f.paths.github, 'dirty.txt')), dirty);
  assert.equal(await readFile(path.join(f.paths.github, 'untracked.txt'), 'utf8'), 'Do not lose untracked content.');
  const project = await f.getProject('sample'), canonical = await readJson(f.canonical);
  assert.equal(project.checkoutPath, f.paths.github); assert.equal(project.repositoryState, 'ready');
  assert.equal(project.sourceRepositoryUrl, 'https://github.com/storytold/reference');
  assert.equal(canonical.applicationRoot, f.paths.github); assert.equal(canonical.source.checkout, f.paths.github); assert.equal(canonical.development.sourceFolder, f.paths.github);
  assert.equal(canonical.source.upstream, 'https://github.com/storytold/reference'); assert.equal(canonical.source.repository, 'https://github.com/william-pyle/Sample'); assert.equal(canonical.custom, 'Preserve metadata');
  assert.equal((await f.fresh().migrateCheckout('sample', { confirmation: 'sample' })).status, 'current');
  assert.ok(!f.calls.some(call => call.args.includes('POST') || call.args.includes('clone') || call.args.includes('push')));
});

test('checkout migration defers pins, project/checkout instructions and open sessions', async t => {
  for (const mode of ['pinned', 'project-instructions', 'checkout-instructions', 'nested-instructions', 'open-project', 'open-cwd']) {
    const f = await migrationFixture(t);
    if (mode === 'pinned') await saveJson(f.record, { ...await f.getProject('sample'), checkoutPinned: true });
    if (mode === 'project-instructions') await writeFile(path.join(f.paths.root, 'AGENTS.md'), 'Keep this checkout pinned.');
    if (mode === 'checkout-instructions') await writeFile(path.join(f.old, 'AGENTS.md'), 'Pinned checkout instructions.');
    if (mode === 'nested-instructions') { await mkdir(path.join(f.old, 'source')); await writeFile(path.join(f.old, 'source/AGENTS.md'), 'Nested path instructions.'); }
    if (mode === 'open-project') f.control.sessions = [{ id: 'worker', projectId: 'sample', open: true, status: 'stopped', cwd: f.repo }];
    if (mode === 'open-cwd') f.control.sessions = [{ id: 'worker', projectId: 'another', open: false, status: 'running', cwd: f.old }];
    const plan = await f.service.migrateCheckout('sample', { confirmation: 'sample' });
    assert.equal(plan.status, 'deferred', mode); assert.match(plan.reason, /pinned|AGENTS|session|instructions/i, mode);
    assert.equal(await readFile(path.join(f.old, 'dirty.txt'), 'utf8'), 'Uncommitted work\r\nKeep exact bytes.');
    assert.equal(await lstat(f.paths.github).catch(() => null), null);
  }
});

test('checkout migration rejects source-only, unowned and unverifiable repositories without moving files', async t => {
  for (const mode of ['source-only', 'unowned', 'unknown']) {
    const f = await migrationFixture(t);
    if (mode === 'source-only') await saveJson(f.record, { ...await f.getProject('sample'), projectRepositoryUrl: '' });
    if (mode === 'unowned') f.control.metadataOverride = metadata('Sample', 'storytold');
    if (mode === 'unknown') f.remotes.clear();
    const plan = await f.service.checkoutMigrationPlan('sample');
    assert.equal(plan.status, 'deferred', mode);
    assert.ok(await lstat(f.old)); assert.equal(await lstat(f.paths.github).catch(() => null), null);
    assert.ok(!f.calls.some(call => call.args.includes('POST')));
  }
});

test('checkout migration refuses existing target, aliases, linked worktrees and submodules', async t => {
  for (const mode of ['target', 'source-alias', 'child-link', 'git-file', 'worktrees', 'submodules', 'nested-git', 'index-submodule', 'config-include']) {
    const f = await migrationFixture(t, { gitFile: mode === 'git-file' });
    if (mode === 'target') { await mkdir(f.paths.github); await writeFile(path.join(f.paths.github, 'keep.txt'), 'Keep target'); }
    if (mode === 'source-alias') { const alias = path.join(f.repo, 'checkout-alias'); await symlink(f.old, alias, process.platform === 'win32' ? 'junction' : 'dir'); await saveJson(f.record, { ...await f.getProject('sample'), checkoutPath: alias }); }
    if (mode === 'child-link') await symlink(f.paths.workspace, path.join(f.old, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    if (mode === 'worktrees') { await mkdir(path.join(f.old, '.git/worktrees/another'), { recursive: true }); }
    if (mode === 'submodules') await writeFile(path.join(f.old, '.gitmodules'), '[submodule "example"]');
    if (mode === 'nested-git') await mkdir(path.join(f.old, 'nested/.git'), { recursive: true });
    if (mode === 'index-submodule') f.control.gitIndex = `160000 ${'a'.repeat(40)} 0\tmodule\n`;
    if (mode === 'config-include') f.control.localConfig = 'include.path\n../../shared-config\0';
    const plan = await f.service.migrateCheckout('sample', { confirmation: 'sample' });
    assert.equal(plan.status, 'deferred', `${mode}: ${plan.reason}`);
    assert.ok(await lstat(f.old));
    if (mode === 'target') assert.equal(await readFile(path.join(f.paths.github, 'keep.txt'), 'utf8'), 'Keep target');
  }
});

test('checkout migration recovers interrupted metadata save without another move or source/provenance loss', async t => {
  const f = await migrationFixture(t, { control: { checkoutPatchFailures: 1 } });
  await assert.rejects(f.service.migrateCheckout('sample', { confirmation: 'sample' }), /Checkout settings save failed/);
  assert.equal(await lstat(f.old).catch(() => null), null);
  assert.equal((await readJson(await f.service.checkoutMigrationFile('sample'))).phase, 'renamed');
  const restarted = f.fresh(), plan = await restarted.checkoutMigrationPlan('sample');
  assert.equal(plan.status, 'ready', plan.reason); assert.equal(plan.recovery, true);
  const recovered = await restarted.migrateCheckout('sample', { confirmation: 'sample' });
  assert.equal(recovered.status, 'applied'); assert.equal(recovered.recovery, true);
  assert.deepEqual(recovered.updatedReferences.sort(), ['applicationRoot', 'development.sourceFolder', 'source.checkout']);
  assert.equal((await f.getProject('sample')).checkoutPath, f.paths.github);
  assert.equal((await f.getProject('sample')).sourceRepositoryUrl, 'https://github.com/storytold/reference');
  assert.equal(await readFile(path.join(f.paths.github, 'dirty.txt'), 'utf8'), 'Uncommitted work\r\nKeep exact bytes.');
  assert.equal((await restarted.migrateCheckout('sample', { confirmation: 'sample' })).status, 'current');
});

test('checkout recovery preserves both locations if the old path was recreated after interruption', async t => {
  const f = await migrationFixture(t, { control: { checkoutPatchFailures: 1 } });
  await assert.rejects(f.service.migrateCheckout('sample', { confirmation: 'sample' }), /Checkout settings/);
  await mkdir(f.old); await writeFile(path.join(f.old, 'new.txt'), 'New owner content at old location');
  const plan = await f.fresh().migrateCheckout('sample', { confirmation: 'sample' });
  assert.equal(plan.status, 'deferred'); assert.match(plan.reason, /conflicting/);
  assert.equal(await readFile(path.join(f.old, 'new.txt'), 'utf8'), 'New owner content at old location');
  assert.equal(await readFile(path.join(f.paths.github, 'dirty.txt'), 'utf8'), 'Uncommitted work\r\nKeep exact bytes.');
});

test('a session appearing after checkout planning blocks the final rename', async t => {
  const f = await migrationFixture(t);
  f.control.onCommand = (file, args) => { if (file === 'gh' && args[3].startsWith('repos/')) f.control.sessions = [{ id: 'new-worker', projectId: 'sample', status: 'running', cwd: f.old }]; };
  await assert.rejects(f.service.migrateCheckout('sample', { confirmation: 'sample' }), /open or active session/);
  assert.ok(await lstat(f.old)); assert.equal(await lstat(f.paths.github).catch(() => null), null);
});

test('retained removed and legacy unassigned sessions can validate plain cwd without changing assignment', async t => {
  const f = await fixture(t);
  await saveJson(f.record, { ...await f.getProject('sample'), removedAt: new Date().toISOString() });
  assert.deepEqual(await f.service.validateWorkingDirectory('sample', f.paths.workspace), { cwd: f.paths.workspace, repository: null });
  assert.deepEqual(await f.service.validateWorkingDirectory(null, f.paths.workspace), { cwd: f.paths.workspace, repository: null });
  assert.deepEqual(f.calls, []);
});

test('real isolated Git checkout retains commit, index and dirty/untracked status after atomic migration', async t => {
  const f = await fixture(t, { remotes: [metadata()] });
  const executeGit = promisify(execFile), old = path.join(f.repo, 'real-checkout');
  const hooks = path.join(f.repo, 'empty-fixture-hooks'); await mkdir(hooks);
  const run = args => executeGit('git', ['-c', `core.hooksPath=${hooks}`, ...args], { cwd: f.repo, windowsHide: true });
  await run(['init', '--template=', '--initial-branch=main', old]);
  await run(['-C', old, 'remote', 'add', 'origin', 'https://github.com/william-pyle/Sample.git']);
  await writeFile(path.join(old, 'tracked.txt'), 'Original committed fixture');
  await run(['-C', old, 'add', '--', 'tracked.txt']);
  await run(['-C', old, '-c', 'user.name=Alpha fixture', '-c', 'user.email=fixture@localhost', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Isolated migration fixture']);
  await writeFile(path.join(old, 'tracked.txt'), 'Uncommitted fixture change');
  await writeFile(path.join(old, 'untracked.txt'), 'Untracked fixture change');
  await saveJson(f.record, { ...await f.getProject('sample'), checkoutPath: old, projectRepositoryUrl: 'https://github.com/william-pyle/Sample' });
  const beforeHead = (await run(['-C', old, 'rev-parse', 'HEAD'])).stdout;
  const beforeStatus = (await run(['-C', old, 'status', '--porcelain', '-z'])).stdout;
  const beforeIndex = await readFile(path.join(old, '.git/index'));
  const originalExecute = f.service.execute;
  f.service.execute = (file, args, options) => file === 'git' ? executeGit(file, args, options) : originalExecute(file, args, options);
  const plan = await f.service.checkoutMigrationPlan('sample'); assert.equal(plan.status, 'ready', plan.reason);
  const result = await f.service.migrateCheckout('sample', { confirmation: 'sample' }); assert.equal(result.status, 'applied');
  assert.equal((await run(['-C', f.paths.github, 'rev-parse', 'HEAD'])).stdout, beforeHead);
  assert.deepEqual(await readFile(path.join(f.paths.github, '.git/index')), beforeIndex);
  assert.equal((await run(['-C', f.paths.github, 'status', '--porcelain', '-z'])).stdout, beforeStatus);
  assert.equal(await readFile(path.join(f.paths.github, 'tracked.txt'), 'utf8'), 'Uncommitted fixture change');
  assert.equal(await readFile(path.join(f.paths.workspace, 'private.txt'), 'utf8'), 'Private report: never stage or publish.');
  assert.ok(f.calls.every(call => call.file !== 'gh' || !call.args.includes('POST')));
});
