import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { createService } from '../server.mjs';
import { validateTools } from '../workspace-tools.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const listen = () => new Promise(resolve => { const server = http.createServer((_, response) => response.end('ready')); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });

test('tool definitions reject invalid commands and unsafe readiness probes', () => {
  assert.throws(() => validateTools([{ id: 'one', name: 'One', kind: 'managed-process', start: { executable: 'node', args: 'bad', cwd: root } }]));
  assert.throws(() => validateTools([{ id: 'one', name: 'One', kind: 'observed-external', readiness: { type: 'http', url: 'http://example.com/' } }]));
  assert.throws(() => validateTools([{ id: 'one', name: 'One', kind: 'one-shot', start: { executable: 'node', args: [], cwd: root }, launches: {} }]));
});

test('managed tools survive service restart, authenticate actions and never stop an external process', { timeout: 90000 }, async () => {
  await mkdir(path.join(root, '.cache'), { recursive: true });
  const repo = await mkdtemp(path.join(root, '.cache', 'workspace-tools-test-'));
  await mkdir(path.join(repo, 'workspace', 'sample'), { recursive: true });
  await mkdir(path.join(repo, 'ui'));
  await writeFile(path.join(repo, 'ui', 'index.html'), '<html>Fixture</html>');
  const port = await listen(), url = `http://127.0.0.1:${port}/`;
  await writeFile(path.join(repo, 'server.mjs'), 'import http from "node:http"; http.createServer((_, r) => r.end("ready")).listen(Number(process.argv[2]), "127.0.0.1");');
  await writeFile(path.join(repo, 'task.mjs'), 'import { writeFile } from "node:fs/promises"; await writeFile("ran.txt", "yes");');
  const managed = { id: 'preview', name: 'Preview', kind: 'managed-process', start: { executable: process.execPath, args: ['server.mjs', String(port)], cwd: repo }, readiness: { type: 'http', url }, startTimeoutMs: 8000, stopTimeoutMs: 1000, launches: [{ id: 'browser', name: 'Open', type: 'url', target: url, whenReady: true }] };
  const external = { id: 'external', name: 'External', kind: 'observed-external', readiness: { type: 'http', url } };
  const oneShot = { id: 'task', name: 'Task', kind: 'one-shot', start: { executable: process.execPath, args: ['task.mjs'], cwd: repo } };
  await writeFile(path.join(repo, 'workspace', 'workspace.json'), JSON.stringify({ entities: [{ id: 'sample', title: 'Sample', folder: 'sample', steps: [{ name: 'Overview', path: 'report.html' }], tools: [managed, external, oneShot] }] }));
  let service, resumed;
  const opened = [];
  const call = (running, route, method = 'GET', data, extra = {}) => fetch(running.origin + '/api' + route, { method, headers: { Authorization: `Bearer ${running.token}`, Origin: running.origin, 'Content-Type': 'application/json', ...extra }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  try {
    service = await createService({ repo, uiDir: path.join(repo, 'ui'), native: event => opened.push(event) });
    assert.equal((await fetch(service.origin + '/api/workspace/tools/sample')).status, 401);
    assert.equal((await call(service, '/workspace/tools/sample', 'GET', undefined, { Origin: 'https://example.com' })).status, 403);
    assert.equal((await call(service, '/workspace/tools/missing')).status, 404);
    assert.equal((await call(service, '/workspace/tools/sample/preview/launch', 'POST', { actionId: 'browser' })).status, 409);
    assert.equal((await call(service, '/workspace/tools/sample/task/start', 'POST', {})).status, 200);
    assert.equal(await readFile(path.join(repo, 'ran.txt'), 'utf8'), 'yes');
    const started = await call(service, '/workspace/tools/sample/preview/start', 'POST', {});
    assert.equal(started.status, 200, await started.text().catch(() => ''));
    const states = await (await call(service, '/workspace/tools/sample')).json();
    assert.equal(states.find(item => item.id === 'preview').state, 'running');
    assert.equal(states.find(item => item.id === 'external').state, 'running-external');
    assert.equal((await call(service, '/workspace/tools/sample/external/stop', 'POST', {})).status, 400);
    assert.equal((await call(service, '/workspace/tools/sample/preview/launch', 'POST', { actionId: 'browser' })).status, 200);
    assert.deepEqual(opened.at(-1), { type: 'open-target', kind: 'url', target: url });
    const actual = service.workspaceTools.owned.get('sample/preview');
    service.workspaceTools.owned.set('sample/preview', { ...actual, created: 'stale-creation-time' });
    assert.equal((await call(service, '/workspace/tools/sample/preview/stop', 'POST', {})).status, 409);
    service.workspaceTools.owned.set('sample/preview', actual);
    await service.close(); service = null;
    resumed = await createService({ repo, uiDir: path.join(repo, 'ui') });
    const restored = await (await call(resumed, '/workspace/tools/sample')).json();
    assert.equal(restored.find(item => item.id === 'preview').state, 'running');
    assert.equal((await call(resumed, '/workspace/tools/sample/preview/stop', 'POST', {})).status, 200);
    const stopped = await (await call(resumed, '/workspace/tools/sample')).json();
    assert.equal(stopped.find(item => item.id === 'preview').state, 'stopped');
  } finally {
    const active = resumed || service;
    if (active?.workspaceTools.owned.has('sample/preview')) await active.workspaceTools.stop('sample', 'preview').catch(() => {});
    if (resumed) await resumed.close();
    if (service) await service.close();
  }
});
