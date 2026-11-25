import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
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
  const privateDirectory = path.join(repo, 'projects', project, '.alpha-shared-drive');
  const privateFile = path.join(privateDirectory, 'rejections.json');
  const journalDirectory = path.join(repo, 'projects', project, '.shared-drive-sync');
  const journalFile = path.join(journalDirectory, 'state.json');
  await mkdir(reportDirectory, { recursive: true });
  await mkdir(root);
  await mkdir(privateDirectory);
  await mkdir(journalDirectory);
  await writeFile(privateFile, '{"version":1,"rejections":["synthetic.txt"]}');
  await writeFile(journalFile, '{"synthetic":true}');
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
  const start = async stateDir => {
    const service = await createService({ repo, stateDir, uiDir: repo, initializeProjects: false, mcpOptions: { home: repo, env: {} },
      native(message) {
        if (message.type !== 'shared-drive-original') return;
        calls.push(message);
        const { type, requestId, action, relativePath, rejected } = message;
        if (action === 'set-rejection' && relativePath === 'unavailable.txt') {
          service.nativeMessage({ type, requestId, status: 503, error: 'Shared Drive rejection state is unavailable.' });
          return;
        }
        const result = {
          status: { available: true }, 'list-rejections': { rejections: [] },
          'set-rejection': { relativePath, rejected }, text: { text: 'Synthetic text', revision: 'a'.repeat(64) },
        }[action];
        service.nativeMessage({ type, requestId, result });
      },
    });
    return service;
  };
  const service = await start();
  let restarted;
  t.after(async () => {
    await restarted?.close();
    await service.close();
    await rm(repo, { recursive: true, force: true });
  });
  const auth = { Authorization: `Bearer ${service.token}` };
  const configuration = await fetch(service.origin + '/api/bootstrap', { headers: auth }).then(response => response.json());
  const raw = `${configuration.contentBase}/projects/${project}/SharedDrive/private.txt`;
  assert.equal((await fetch(raw)).status, 403);
  assert.equal((await fetch(raw, { method: 'HEAD' })).status, 403);
  assert.equal((await fetch(raw, { headers: { Range: 'bytes=0-4' } })).status, 403);
  const privateRelative = 'projects/' + project + '/.alpha-shared-drive/rejections.json';
  assert.equal((await fetch(configuration.contentBase + '/' + privateRelative)).status, 403);
  assert.equal((await fetch(service.origin + '/' + privateRelative)).status, 403);
  assert.equal((await fetch(service.origin + '/' + privateRelative, { method: 'HEAD' })).status, 403);
  assert.equal((await fetch(service.origin + '/api/preview?path=' + encodeURIComponent(privateFile), { headers: auth })).status, 403);
  assert.equal((await fetch(service.origin + '/api/files?path=' + encodeURIComponent(privateDirectory), { headers: auth })).status, 403);
  assert.equal((await fetch(configuration.contentBase + `/projects/${project}/.shared-drive-sync/state.json`)).status, 403);
  assert.equal((await fetch(service.origin + '/api/preview?path=' + encodeURIComponent(journalFile), { headers: auth })).status, 403);
  const projectListing = await fetch(service.origin + '/api/files?mode=all&path=' + encodeURIComponent(path.dirname(privateDirectory)), { headers: auth });
  assert.equal(projectListing.status, 200);
  assert.ok(!(await projectListing.json()).entries.some(entry => ['.alpha-shared-drive', '.shared-drive-sync'].includes(entry.name)));
  if (process.platform === 'win32') {
    await symlink(root, path.join(repo, 'mirror-alias'), 'junction');
    assert.equal((await fetch(`${configuration.contentBase}/mirror-alias/private.txt`)).status, 403);
    assert.equal((await fetch(raw.replace('SharedDrive', 'sharedDRIVE%20'))).status, 403);
    await symlink(privateDirectory, path.join(repo, 'private-alias'), 'junction');
    assert.equal((await fetch(configuration.contentBase + '/private-alias/rejections.json')).status, 403);
    assert.equal((await fetch(service.origin + '/private-alias/rejections.json')).status, 403);
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
  assert.ok(!page.includes(privateDirectory));
  const endpoint = service.origin + '/api/workspace/shared-drive-original';
  const send = (data, headers = auth) => fetch(endpoint, { method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  assert.equal((await send({ action: 'status' }, {})).status, 401);
  assert.equal((await send({ grant, action: 'status' }, { ...auth, Origin: new URL(configuration.contentBase).origin })).status, 403);
  assert.equal((await send({ grant: 'forged', action: 'text', relativePath: 'notes.txt' })).status, 403);
  assert.equal((await send({ grant: 'forged', action: 'save', relativePath: 'private.txt', revision: 'a'.repeat(64), text: 'No' })).status, 403);
  for (const action of ['list-rejections', 'set-rejection']) {
    const data = { action, relativePath: 'notes.txt', rejected: true };
    assert.equal((await send(data, {})).status, 401);
    assert.equal((await send({ ...data, grant }, { ...auth, Origin: service.contentOrigin })).status, 403);
    assert.equal((await send({ ...data, grant: 'forged' })).status, 403);
  }
  for (const action of ['sync-list', 'sync-choice', 'sync-run']) {
    assert.equal((await send({ grant, action }, {})).status, 401);
    assert.equal((await send({ grant, action }, { ...auth, Origin: service.contentOrigin })).status, 403);
    assert.equal((await send({ grant: 'forged', action })).status, 403);
    assert.equal((await send({ grant, action })).status, 404);
  }
  if (process.platform === 'win32') {
    await writeFile(config, JSON.stringify({ sharedDrive: { sync: { mirrorFolder: 'SharedDrive', bridge: 'one-button-v1' } } }));
    assert.equal((await send({ grant, action: 'sync-list', executable: 'powershell.exe' })).status, 503);
    assert.equal((await send({ grant, action: 'sync-choice', relativePath: '../outside.txt', revision: 'a'.repeat(64), choice: 'Delete Locally' })).status, 400);
    const longPath = Array(7).fill('a'.repeat(200)).concat('image.png').join('/');
    // Path validation allows long engine paths before rejecting the missing interpreter.
    assert.equal((await send({ grant, action: 'sync-choice', relativePath: longPath, revision: 'a'.repeat(64), choice: 'Ignore' })).status, 503);
  }
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
  const list = await send({ grant, action: 'list-rejections' });
  assert.equal(list.status, 200);
  assert.deepEqual(await list.json(), { rejections: [] });
  assert.deepEqual(Object.keys(calls.at(-1)).sort(), ['action', 'requestId', 'type']);
  const count = calls.length;
  for (const relativePath of ['../notes.txt', '/notes.txt', 'X:/notes.txt', 'nested\\..\\notes.txt', 'notes.txt:stream',
    'nested/CON.txt', 'nested/notes.txt ', 'nested/notes.txt.', 'nested//notes.txt', 'nested/\u0085notes.txt', '\ud800', 'x'.repeat(1025)]) {
    assert.equal((await send({ grant, action: 'set-rejection', relativePath, rejected: true })).status, 400);
  }
  for (const rejected of [undefined, null, 0, 1, 'false', {}]) {
    assert.equal((await send({ grant, action: 'set-rejection', relativePath: 'notes.txt', rejected })).status, 400);
  }
  assert.equal(calls.length, count);
  const set = await send({ grant, action: 'set-rejection', relativePath: 'nested\\Notes.txt', rejected: false,
    root: 'Z:/unused', destination: 'Z:/unused', text: 'unused' });
  assert.equal(set.status, 200);
  assert.deepEqual(await set.json(), { relativePath: 'nested/Notes.txt', rejected: false });
  assert.deepEqual(Object.keys(calls.at(-1)).sort(), ['action', 'rejected', 'relativePath', 'requestId', 'type']);
  const unavailable = await send({ grant, action: 'set-rejection', relativePath: 'unavailable.txt', rejected: true });
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { error: 'Shared Drive rejection state is unavailable.' });
  restarted = await start(path.join(repo, '.alpha-second-service'));
  assert.notEqual(restarted.origin, service.origin);
  const newAuth = { Authorization: 'Bearer ' + restarted.token, 'Content-Type': 'application/json' };
  const newEndpoint = restarted.origin + '/api/workspace/shared-drive-original';
  const sendNew = (newGrant, headers = newAuth) => fetch(newEndpoint, { method: 'POST', headers,
    body: JSON.stringify({ grant: newGrant, action: 'list-rejections' }) });
  assert.equal((await sendNew(grant)).status, 403);
  const newConfiguration = await fetch(restarted.origin + '/api/bootstrap', { headers: newAuth }).then(response => response.json());
  const newPage = await fetch(newConfiguration.contentBase + '/' + workspacePath + '/shared-drive.html',
    { headers: { 'Sec-Fetch-Dest': 'iframe' } }).then(response => response.text());
  const newGrant = /grant: "([\w-]+)"/.exec(newPage)?.[1];
  assert.ok(newGrant && newGrant !== grant);
  assert.equal((await sendNew(newGrant, { ...newAuth, Origin: service.origin })).status, 403);
  assert.equal((await sendNew(newGrant)).status, 200);
  const gitMarker = path.join(repo, '.git');
  await writeFile(gitMarker, 'synthetic Git marker');
  assert.equal((await send({ grant, action: 'list-rejections' })).status, 403);
  assert.equal((await send({ grant, action: 'set-rejection', relativePath: 'notes.txt', rejected: true })).status, 403);
  await rm(gitMarker);
  await writeFile(config, JSON.stringify({ sharedDrive: { sourceFolder: 'Z:/unavailable-peer' } }));
  assert.equal((await send({ grant, action: 'save', relativePath: 'private.txt', revision: 'a'.repeat(64), text: 'No' })).status, 403);
  assert.equal((await send({ grant, action: 'set-rejection', relativePath: 'private.txt', rejected: true })).status, 403);
  await writeFile(config, JSON.stringify({ sharedDrive: { sync: { mirrorFolder: '../outside' } } }));
  assert.equal((await send({ grant, action: 'text', relativePath: 'private.txt' })).status, 403);
  await writeFile(config, JSON.stringify({ sharedDrive: { sync: { mirrorFolder: 'SharedDrive' } } }));
  entries[0].steps[8].path = 'other.html';
  await writeFile(registry, JSON.stringify({ entities: entries }));
  assert.equal((await send({ grant, action: 'text', relativePath: 'notes.txt' })).status, 403);
  assert.equal((await send({ grant, action: 'list-rejections' })).status, 403);
  assert.equal((await send({ grant, action: 'set-rejection', relativePath: 'notes.txt', rejected: false })).status, 403);
});
