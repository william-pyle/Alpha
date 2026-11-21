import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Threads } from '../threads.mjs';
import { Awareness } from '../awareness.mjs';
import { createService } from '../server.mjs';
import { readNativeConversation } from '../thread-history.mjs';

const temporary = () => mkdtemp(path.join(os.tmpdir(), 'alpha-threads-'));
test('migration preserves native identities, separates histories and remains idempotent', async () => {
  const root = await temporary();
  const native = { id: 'worker-a', nativeId: 'provider-id-unchanged', name: 'A', open: true, status: 'running', projectId: 'alpha', projectPending: false };
  const manager = await new Threads(root).init([native], [{ id: 'r-a', sessionId: native.id, text: 'private A' }]);
  const b = manager.create({ name: 'B', projectId: 'beta' });
  manager.message(b.id, { id: 'b1', role: 'user', text: 'private B' });
  assert.equal(manager.get(native.id).kind, 'native');
  assert.equal(JSON.stringify(manager.context(b.id)).includes('private A'), false);
  assert.equal(JSON.stringify(manager.context(native.id)).includes('private B'), false);
  assert.throws(() => manager.assertSession(b.id, native.id), /another conversation/);
  manager.select(b.id); await manager.close();
  const resumed = await new Threads(root).init([native], [{ id: 'r-a', sessionId: native.id, text: 'private A' }]);
  assert.equal(resumed.get(native.id).messages.length, 1);
  assert.equal(resumed.items.length, 2); assert.equal(resumed.selectedId, b.id);
  assert.equal(native.nativeId, 'provider-id-unchanged'); assert.equal(native.status, 'running');
  await resumed.close();
});

test('voice captions remain in their origin and updates do not duplicate history', async () => {
  const manager = await new Threads(await temporary()).init();
  const a = manager.create({ name: 'A' }), b = manager.create({ name: 'B' });
  manager.select(b.id);
  manager.voice(a.id, 'live-1', [{ role: 'user', text: 'first', start: 0 }]);
  manager.voice(a.id, 'live-1', [{ role: 'user', text: 'first completed', start: 0 }]);
  assert.equal(a.messages.length, 1); assert.equal(a.messages[0].text, 'first completed'); assert.equal(b.messages.length, 0);
  await manager.close();
});

test('awareness deduplicates, persists dismissals, snoozes and never retains desktop samples', async () => {
  const root = await temporary(); let time = 10000000;
  const manager = await new Awareness(root, () => {}, () => time).init();
  const event = { id: 'finished-a', threadId: 'a', kind: 'review', text: 'Review the result', source: 'Native completion' };
  manager.event(event); manager.event(event); assert.equal(manager.items.length, 1);
  manager.control({ id: event.id, action: 'snooze' }); assert.equal(manager.snapshot().items.length, 0);
  time += 31 * 60 * 1000; assert.equal(manager.snapshot().items.length, 1);
  manager.control({ id: event.id, action: 'dismiss', desktop: true }); manager.sample('notepad.exe');
  assert.equal(manager.snapshot().desktop.application, 'notepad.exe');
  time += 16000; assert.equal(manager.snapshot().desktop, null);
  manager.sample('C:/private/secret.exe'); assert.equal(manager.desktop, null);
  manager.sample('1password.exe'); assert.equal(manager.desktop, null);
  manager.sample('notepad.exe'); await manager.close();
  assert.equal((await readFile(manager.file, 'utf8')).includes('notepad.exe'), false);
  const resumed = await new Awareness(root).init(); resumed.event(event); assert.equal(resumed.snapshot().items.length, 0);
  resumed.control({ enabled: false }); resumed.sample('notepad.exe'); assert.equal(resumed.desktop, null);
  await resumed.close();
});

test('service binds project questions and coordinator tools to the originating thread', async () => {
  const repo = await temporary(); await mkdir(path.join(repo, 'workspace'));
  await writeFile(path.join(repo, 'workspace/workspace.json'), JSON.stringify({ entities: [{ id: 'alpha', title: 'Alpha', steps: [], folder: 'alpha' }], categories: [] }));
  const service = await createService({ repo, uiDir: repo });
  const request = async (route, data, method) => {
    const response = await fetch(service.origin + '/api' + route, { method: method || (data ? 'POST' : 'GET'), headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' }, ...(data ? { body: JSON.stringify(data) } : {}) });
    return { status: response.status, data: await response.json() };
  };
  try {
    const a = (await request('/threads', { name: 'A' })).data;
    assert.equal(a.projectId, 'conversations');
    await request(`/threads/${a.id}`, { projectId: null }, 'PATCH');
    const b = (await request('/threads', { name: 'B', projectId: 'alpha' })).data;
    await request(`/threads/${b.id}/select`, {});
    assert.equal((await request(`/threads/${a.id}/input`, { id: 'blocked', text: 'Do work' })).status, 400);
    const question = service.questions.list().find(item => item.threadId === a.id);
    assert.ok(question);
    assert.equal((await request(`/questions/${question.id}/answer`, { answer: 'alpha' })).status, 200);
    assert.equal(service.threads.get(a.id).projectId, 'alpha');
    assert.ok(!service.awareness.snapshot().items.some(item => item.id === `question:${question.id}`));
    service.threads.message(a.id, { id: 'private', role: 'user', text: 'PRIVATE_A_MARKER' });
    const coordA = await service.getCoordinator(a.id), coordB = await service.getCoordinator(b.id);
    assert.notEqual(coordA, coordB); assert.notEqual(coordA.stateDir, coordB.stateDir);
    assert.equal(JSON.stringify(coordB.context()).includes('PRIVATE_A_MARKER'), false);
    await assert.rejects(coordB.execute('read_chat', { id: a.id }, 'x'), /another conversation/);
    await assert.rejects(coordB.execute('preview_file', { path: service.threads.file }, 'x'), /Private conversation/);
    await assert.rejects(coordB.execute('list_files', { path: path.join(repo, '.alpha') }, 'x'), /Private conversation/);
    assert.equal((await coordB.execute('search_history', {}, 'x')).some(item => 'preview' in item || 'messages' in item), false);
    let delivered = 0;
    coordA.ask = async data => { delivered++; const operation = { ...data, at: new Date().toISOString(), status: 'completed', result: 'A reply' }; coordA.emit('result', operation); return operation; };
    const sent = await request(`/threads/${a.id}/input`, { id: 'once', text: 'hello A' });
    assert.equal(sent.status, 202);
    await request(`/threads/${a.id}/input`, { id: 'once', text: 'hello A' });
    assert.equal((await request(`/threads/${a.id}/input`, { id: 'once', text: 'different content' })).status, 400);
    assert.equal(delivered, 1); assert.equal(service.threads.get(b.id).messages.length, 0);
    assert.equal(service.threads.get(a.id).messages.at(-1).text, 'A reply');
    assert.equal((await request('/speech/speak', { source: 'thread', threadId: a.id, id: 'operation:once' })).status, 400);
  } finally { await service.close(); }
});

test('native history imports user messages and final answers without tools, reasoning or other agents', async () => {
  const root = await temporary(), file = path.join(root, 'history.jsonl'), timestamp = new Date().toISOString();
  const records = [
    { timestamp, type: 'event_msg', payload: { type: 'user_message', message: 'user original' } },
    { timestamp, type: 'response_item', payload: { type: 'function_call', name: 'exec', arguments: 'PRIVATE_TOOL' } },
    { timestamp, type: 'event_msg', payload: { type: 'agent_reasoning', text: 'PRIVATE_REASONING' } },
    { timestamp, type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1', last_agent_message: 'verified final' } },
  ];
  await writeFile(file, records.map(item => JSON.stringify(item)).join('\n'));
  const before = await readFile(file, 'utf8');
  const messages = await readNativeConversation(file, 'codex', 'exact-worker');
  assert.deepEqual(messages.map(item => item.text), ['user original', 'verified final']);
  assert.equal(messages[1].id, 'reply:exact-worker:turn-1');
  assert.equal(await readFile(file, 'utf8'), before);
  const manager = await new Threads(root).init([{ id: 'exact-worker', nativeId: 'native-unchanged', name: 'Imported', open: true }]);
  for (let i = 0; i < 2; i++) for (const message of messages) manager.message('exact-worker', message, false);
  assert.equal(manager.get('exact-worker').messages.length, 2);
  const b = manager.create({ name: 'Recipient' });
  manager.share('exact-worker', b.id, messages[1].id, 'transfer-1');
  manager.share('exact-worker', b.id, messages[1].id, 'transfer-1');
  assert.equal(b.messages.length, 1); assert.equal(b.messages[0].images, undefined);
  assert.ok(!JSON.stringify(manager.context(b.id)).includes('user original'));
  await manager.close();
});
