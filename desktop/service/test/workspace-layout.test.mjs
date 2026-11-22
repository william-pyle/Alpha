import assert from 'node:assert/strict';
import test from 'node:test';
import { lstat, link, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cutoverWorkspaceLayout, validateWorkspaceLayout, workspaceAssetPath, workspaceRegistryFile } from '../workspace-layout.mjs';
import { resolveWorkspace } from '../workspace-location.mjs';
import { Workspace } from '../workspace.mjs';

async function fixture(t) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'alpha-layout-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'work'), configDir = path.join(base, 'config');
  await mkdir(path.join(root, 'workspace/_shared'), { recursive: true });
  await mkdir(path.join(root, 'projects/example/workspace'), { recursive: true });
  await mkdir(path.join(root, '.alpha'));
  const registry = JSON.stringify({ entities: [{ id: 'example', workspacePath: 'projects/example/workspace', projectRepositoryUrl: 'https://github.com/example/repo' }] });
  const files = {
    'workspace/workspace.json': '\uFEFF' + registry,
    'workspace/workspace.json.previous': 'previous registry bytes',
    'workspace/_shared/report.css': 'shared theme',
    'projects/example/workspace/index.html': 'report',
    '.alpha/sessions.json': 'conversation state',
  };
  for (const [name, contents] of Object.entries(files)) await writeFile(path.join(root, name), contents);
  return { root, configDir, files };
}

test('upgraded startup moves registry, backup and shared assets and resumes idempotently', async t => {
  const { root, configDir, files } = await fixture(t);
  const options = { configDir, defaultRoot: root };
  assert.equal(workspaceRegistryFile(root), path.join(root, 'workspace/workspace.json'));
  assert.equal(await resolveWorkspace({ ...options, supplied: root }), root);
  for (const [name, contents] of Object.entries(files)) {
    const moved = name.replace(/^workspace\//, '');
    assert.equal(await readFile(path.join(root, moved), 'utf8'), contents);
    if (moved !== name) await assert.rejects(lstat(path.join(root, name)), { code: 'ENOENT' });
  }
  assert.equal(workspaceRegistryFile(root), path.join(root, 'workspace.json'));
  assert.equal(workspaceAssetPath(root, 'workspace/_shared/report.css'), '_shared/report.css');
  assert.equal((await new Workspace(root).registry()).entities[0].id, 'example');
  assert.equal(await resolveWorkspace(options), root);
  assert.equal(await readFile(path.join(root, 'workspace.json'), 'utf8'), files['workspace/workspace.json']);
});

test('cutover checks collisions before changing anything', async t => {
  const { root, files } = await fixture(t);
  await mkdir(path.join(root, '_shared'));
  await writeFile(path.join(root, '_shared/report.css'), 'keep');
  await assert.rejects(validateWorkspaceLayout(root), /needs review.*_shared/);
  await assert.rejects(cutoverWorkspaceLayout(root), /needs review.*_shared/);
  assert.equal(await readFile(path.join(root, '_shared/report.css'), 'utf8'), 'keep');
  assert.equal(await readFile(path.join(root, 'workspace/workspace.json'), 'utf8'), files['workspace/workspace.json']);
  await assert.rejects(lstat(path.join(root, 'workspace.json')), { code: 'ENOENT' });
});

test('an interrupted hard link resumes only for the journaled file identity', async t => {
  const { root, files } = await fixture(t);
  const moves = await Promise.all(['workspace.json', 'workspace.json.previous', '_shared'].map(async name => {
    const info = await lstat(path.join(root, 'workspace', name), { bigint: true });
    return { name, identity: String(info.dev) + ':' + String(info.ino) };
  }));
  const journal = path.join(root, '.alpha/workspace-root-cutover.json');
  await writeFile(journal, JSON.stringify({ version: 1, moves }));
  await link(path.join(root, 'workspace/workspace.json'), path.join(root, 'workspace.json'));
  await writeFile(path.join(root, 'workspace.json.previous'), 'an unexpected file');
  await assert.rejects(cutoverWorkspaceLayout(root), /workspace.json.previous changed/);
  assert.equal(await readFile(path.join(root, 'workspace.json.previous'), 'utf8'), 'an unexpected file');
  await rm(path.join(root, 'workspace.json.previous'));
  assert.equal(await cutoverWorkspaceLayout(root), root);
  assert.equal(await readFile(path.join(root, 'workspace.json'), 'utf8'), files['workspace/workspace.json']);
  await assert.rejects(lstat(journal), { code: 'ENOENT' });
});
