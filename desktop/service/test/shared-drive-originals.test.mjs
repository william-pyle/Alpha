import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createService } from '../server.mjs';

test('Shared Drive originals require the approved report grant and use only the configured root', async t => {
  const repo = await mkdtemp(path.join(tmpdir(), 'alpha-drive-scope-'));
  const project = 'author-ashlyn-brooks';
  const workspacePath = `projects/${project}/workspace`;
  const reportDirectory = path.join(repo, workspacePath);
  const root = path.join(repo, 'projects', project, 'SharedDrive');
  await mkdir(reportDirectory, { recursive: true });
  await mkdir(root);
  const canonicalRoot = await realpath(root);
  await writeFile(path.join(root, 'private.txt'), 'Synthetic private original');
  const config = path.join(repo, 'projects', project, 'project.json');
  await writeFile(config, JSON.stringify({ sharedDrive: { sync: { mirrorFolder: 'SharedDrive' } } }));
  await writeFile(path.join(reportDirectory, 'shared-drive.html'), '<!doctype html><html><head></head><body>Registered report</body></html>');
  await writeFile(path.join(reportDirectory, 'other.html'), '<!doctype html><html><head><meta name="alpha-shared-drive" content="true"></head></html>');
  const entries = [{ id: project, folder: 'fixture', workspacePath,
    steps: [...Array(8).fill({ name: 'Other', path: 'other.html' }), { name: 'Shared Drive', path: 'shared-drive.html' }] }];
  const registry = path.join(repo, 'workspace.json');
  await writeFile(registry, JSON.stringify({ entities: entries }));
  const calls = [];
  let service;
  service = await createService({ repo, uiDir: repo, initializeProjects: false, mcpOptions: { home: repo, env: {} },
    native(message) {
      if (message.type !== 'shared-drive-original') return;
      calls.push(message);
      const result = message.action === 'status' ? { available: true } : { text: 'Synthetic text', revision: 'a'.repeat(64) };
      service.nativeMessage({ type: message.type, requestId: message.requestId, result });
    },
  });
  t.after(() => service.close());
  const auth = { Authorization: `Bearer ${service.token}` };
  const configuration = await fetch(service.origin + '/api/bootstrap', { headers: auth }).then(response => response.json());
  const raw = `${configuration.contentBase}/projects/${project}/SharedDrive/private.txt`;
  assert.equal((await fetch(raw)).status, 403);
  assert.equal((await fetch(raw, { method: 'HEAD' })).status, 403);
  assert.equal((await fetch(raw, { headers: { Range: 'bytes=0-4' } })).status, 403);
  if (process.platform === 'win32') {
    await symlink(root, path.join(repo, 'mirror-alias'), 'junction');
    assert.equal((await fetch(`${configuration.contentBase}/mirror-alias/private.txt`)).status, 403);
    assert.equal((await fetch(raw.replace('SharedDrive', 'sharedDRIVE%20'))).status, 403);
  }
  assert.equal((await fetch(`${service.origin}/api/preview?path=${encodeURIComponent(path.join(root, 'private.txt'))}`, { headers: auth })).status, 403);
  const content = (name, destination = 'iframe') => fetch(`${configuration.contentBase}/${workspacePath}/${name}`,
    { headers: { 'Sec-Fetch-Dest': destination } }).then(response => response.text());
  assert.doesNotMatch(await content('other.html'), /alpha:shared-drive-request/);
  assert.doesNotMatch(await content('shared-drive.html', 'empty'), /alpha:shared-drive-request/);
  const page = await content('shared-drive.html');
  const grant = /grant: "([\w-]+)"/.exec(page)?.[1];
  assert.ok(grant);
  assert.ok(!page.includes(root));
  assert.ok(!page.includes(canonicalRoot));
  const endpoint = service.origin + '/api/workspace/shared-drive-original';
  const send = (data, headers = auth) => fetch(endpoint, { method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  assert.equal((await send({ action: 'status' }, {})).status, 401);
  assert.equal((await send({ grant, action: 'status' }, { ...auth, Origin: new URL(configuration.contentBase).origin })).status, 403);
  assert.equal((await send({ grant: 'forged', action: 'text', relativePath: 'notes.txt' })).status, 403);
  assert.equal((await send({ grant: 'forged', action: 'save', relativePath: 'private.txt', revision: 'a'.repeat(64), text: 'No' })).status, 403);
  assert.equal((await send({ grant, action: 'execute', relativePath: 'notes.txt' })).status, 400);
  for (const relativePath of ['../notes.txt', '/notes.txt', 'X:/notes.txt', 'nested\\..\\notes.txt', 'notes.txt:stream']) {
    assert.equal((await send({ grant, action: 'text', relativePath })).status, 400);
  }
  assert.equal((await send({ grant, action: 'save', relativePath: 'notes.md', revision: 'a'.repeat(64), text: 'Synthetic' })).status, 400);
  assert.equal(calls.length, 0);
  assert.deepEqual(await (await send({ grant, action: 'status' })).json(), { available: true });
  const read = await send({ grant, action: 'text', relativePath: 'nested/notes.txt', root: 'Z:/not-approved' });
  assert.equal(read.status, 200);
  assert.equal((await read.json()).text, 'Synthetic text');
  assert.equal(calls.at(-1).root, canonicalRoot);
  assert.equal(calls.at(-1).relativePath, 'nested/notes.txt');
  await writeFile(config, JSON.stringify({ sharedDrive: { sourceFolder: 'Z:/unavailable-peer' } }));
  assert.equal((await send({ grant, action: 'save', relativePath: 'private.txt', revision: 'a'.repeat(64), text: 'No' })).status, 403);
  await writeFile(config, JSON.stringify({ sharedDrive: { sync: { mirrorFolder: '../outside' } } }));
  assert.equal((await send({ grant, action: 'text', relativePath: 'private.txt' })).status, 403);
  await writeFile(config, JSON.stringify({ sharedDrive: { sync: { mirrorFolder: 'SharedDrive' } } }));
  entries[0].steps[8].path = 'other.html';
  await writeFile(registry, JSON.stringify({ entities: entries }));
  assert.equal((await send({ grant, action: 'text', relativePath: 'notes.txt' })).status, 403);
});
