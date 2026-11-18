import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Threads } from '../threads.mjs';
import { createService } from '../server.mjs';

test('close chooses a neighbor or null, keeps identity/draft/messages, and view choices survive restart', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'alpha-close-'));
  let threads = await new Threads(root).init();
  const a = threads.create({ name: 'First conversation' }), b = threads.create({ name: 'Second conversation' }), c = threads.create({ name: 'Third conversation' });
  a.sessionIds.push('worker-one'); a.draft = { text: 'Unsent draft', paths: [] };
  threads.message(a.id, { id: 'm1', role: 'assistant', text: 'Keep transcript' });
  threads.view(a.id, { viewMode: 'terminal', workerId: 'worker-one' });
  assert.throws(() => threads.view(b.id, { workerId: 'worker-one' }), /another conversation/);
  assert.throws(() => threads.view(b.id, { viewMode: 'other' }), /Alpha or terminal/);
  threads.select(a.id); threads.closeConversation(b.id); assert.equal(threads.selectedId, a.id);
  threads.closeConversation(a.id); assert.equal(threads.selectedId, c.id);
  const undo = a.archiveUndo.id; threads.view(a.id, { viewMode: 'alpha' }); threads.undoArchive(a.id, undo);
  threads.closeConversation(c.id); assert.equal(threads.selectedId, a.id);
  threads.closeConversation(a.id); assert.equal(threads.selectedId, null);
  await threads.close(); threads = await new Threads(root).init();
  assert.equal(threads.selectedId, null); assert.equal(threads.get(a.id).archived, true);
  assert.equal(threads.get(a.id).workerId, 'worker-one'); assert.equal(threads.get(a.id).viewMode, 'alpha');
  assert.deepEqual(threads.get(a.id).draft, a.draft); assert.deepEqual(threads.get(a.id).messages, a.messages);
  threads.patch(a.id, { archived: false }); threads.select(a.id); await threads.close();
  threads = await new Threads(root).init(); assert.equal(threads.selectedId, a.id); assert.deepEqual(threads.get(a.id).sessionIds, ['worker-one']); await threads.close();
});

test('close/reopen/view endpoints preserve running workers and pending questions without lifecycle calls', async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'alpha-close-api-')); await mkdir(path.join(repo, 'workspace'));
  await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[]}');
  const service = await createService({ repo, uiDir: repo, mcpOptions: { home: repo, env: {} } });
  const request = async (route, data = {}) => { const response = await fetch(`${service.origin}/api${route}`, { method: 'POST', headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); return { status: response.status, body: await response.json() }; };
  try {
    const worker = service.sessions.make({ id: 'synthetic-native', name: 'Synthetic native worker', agent: 'codex', nativeId: 'provider-id-preserved', open: true, status: 'running', bypass: false, cwd: repo });
    service.sessions.items.set(worker.id, worker); service.threads.observe(worker);
    const other = service.threads.create({ name: 'Unrelated work' }); service.threads.select(worker.id);
    const question = await service.questions.ask({ source: 'coordinator', sourceId: 'synthetic-q', threadId: worker.id, sessionId: worker.id, chatName: worker.name, text: 'Keep this pending question?' });
    let lifecycle = 0; service.sessions.resume = async () => { lifecycle++; }; service.sessions.stop = async () => { lifecycle++; };
    assert.equal((await request(`/threads/${worker.id}/view`, { viewMode: 'terminal', workerId: worker.id })).status, 200);
    assert.equal((await request(`/threads/${other.id}/view`, { workerId: worker.id })).status, 403);
    assert.equal((await request(`/threads/${worker.id}/close`)).status, 200);
    assert.equal(service.threads.selectedId, other.id); assert.equal(service.questions.items.find(item => item.id === question.id).status, 'pending');
    assert.equal(worker.status, 'running'); assert.equal(worker.nativeId, 'provider-id-preserved'); assert.equal(worker.bypass, false);
    assert.equal((await request(`/threads/${worker.id}/reopen`)).status, 200); assert.equal(lifecycle, 0);
    assert.equal(service.threads.get(worker.id).viewMode, 'terminal');
  } finally { await service.close(); }
});
