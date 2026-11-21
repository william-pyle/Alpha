import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdtemp, mkdir, readFile, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Threads } from '../threads.mjs';
import { Questions } from '../questions.mjs';
import { createService } from '../server.mjs';

test('startup assigns old unassigned conversations and native workers to Conversations once, preserving drafts and other projects', async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'alpha-conversation-assign-'));
  const stateDir = path.join(repo, '.alpha');
  await mkdir(path.join(repo, 'workspace'));
  await mkdir(stateDir);
  await writeFile(path.join(repo, 'workspace/workspace.json'), JSON.stringify({ entities: [{ id: 'fixture', title: 'Existing project', folder: 'fixture', steps: [] }] }));
  const saved = await new Threads(stateDir).init();
  const workerId = randomUUID();
  const worker = { id: workerId, name: 'Legacy native conversation', nativeId: randomUUID(), agent: 'codex', open: false, projectPending: true, cwd: repo };
  const native = saved.observe(worker);
  const standalone = saved.create({ name: 'Legacy standalone conversation' });
  const assigned = saved.create({ name: 'Already assigned conversation', projectId: 'fixture' });
  native.draft = { text: 'Draft to preserve', paths: [] };
  saved.message(native.id, { id: 'legacy-fixture', role: 'user', text: 'History to preserve' });
  await saved.close();
  await writeFile(path.join(stateDir, 'sessions.json'), JSON.stringify([worker]));
  const questions = await new Questions(stateDir).init();
  await questions.ask({ source: 'project', sourceId: 'old-project', threadId: native.id, sessionId: workerId, text: 'Which project should track this history?' });
  const importantQuestion = await questions.ask({ sourceId: 'keep-decision', threadId: native.id, text: 'Should the fixture remain?' });
  await questions.close();
  const options = { repo, uiDir: repo, mcpOptions: { home: repo, env: {} } };
  let service = await createService(options);
  try {
    const migrated = service.threads.get(native.id);
    assert.equal(migrated.projectId, 'conversations');
    assert.equal(migrated.projectPending, false);
    assert.equal(migrated.archived, true);
    assert.deepEqual(migrated.draft, native.draft);
    assert.deepEqual(migrated.messages, native.messages);
    assert.equal(service.threads.get(standalone.id).projectId, 'conversations');
    assert.equal(service.threads.get(assigned.id).projectId, 'fixture');
    assert.equal(service.sessions.get(workerId).projectId, 'conversations');
    assert.equal(service.sessions.get(workerId).nativeId, worker.nativeId);
    assert.equal(service.sessions.get(workerId).cwd, repo);
    assert.deepEqual(service.questions.list().map(item => item.id), [importantQuestion.id]);
  } finally { await service.close(); }
  service = await createService(options);
  try {
    assert.equal(service.threads.get(native.id).projectId, 'conversations');
    assert.equal(service.sessions.get(workerId).projectId, 'conversations');
    assert.equal(service.threads.get(standalone.id).projectId, 'conversations');
  } finally { await service.close(); }
});

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

test('explicit deletion persists a minimal tombstone and prevents session or provider binding resurrection', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'alpha-delete-tombstone-'));
  let threads = await new Threads(root).init();
  const removed = threads.create({ name: 'Old private conversation' }), retained = threads.create({ name: 'Retained conversation' });
  const oldWorker = randomUUID(); removed.sessionIds.push(oldWorker);
  threads.message(removed.id, { id: 'private-message', role: 'user', text: 'PRIVATE TRANSCRIPT MUST GO' });
  threads.message(retained.id, { id: 'shared-copy', role: 'user', source: 'shared', sourceThreadId: removed.id, text: 'PRIVATE SHARED COPY MUST GO' });
  threads.select(removed.id);
  const release = threads.claim(removed.id, 'delete');
  assert.throws(() => threads.claim(removed.id, 'input'), /being deleted|busy/); assert.throws(() => threads.assertAvailable(removed.id), /being deleted/); release();
  await threads.deleteConversation(removed.id, [{ id: oldWorker, nativeId: 'provider-native-binding' }]);
  assert.equal(threads.selectedId, retained.id); assert.equal(threads.items.length, 1); assert.equal(threads.get(retained.id).messages.length, 1);
  assert.throws(() => threads.get(removed.id), /not found/); assert.equal(threads.directory().some(item => item.id === removed.id), false);
  const saved = await readFile(path.join(root, 'threads.json'), 'utf8');
  assert.doesNotMatch(saved, /PRIVATE TRANSCRIPT MUST GO|Old private conversation|provider-native-binding/); assert.match(saved, /PRIVATE SHARED COPY MUST GO/); assert.match(saved, /"deleted"/);
  await threads.close();
  threads = await new Threads(root).init([{ id: 'replacement-worker', nativeId: 'provider-native-binding', name: 'Provider import attempt', open: false, status: 'stopped' }]);
  assert.equal(threads.items.some(item => item.id === 'replacement-worker'), false); assert.equal(threads.items.length, 1);
  await threads.close();
});

test('coordinator cleanup rejects a linked target and never follows it outside Alpha state', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'alpha-delete-link-')), outside = await mkdtemp(path.join(os.tmpdir(), 'alpha-delete-outside-'));
  const threads = await new Threads(root).init(), item = threads.create({ name: 'Linked coordinator fixture' });
  await writeFile(path.join(outside, 'keep.txt'), 'KEEP'); await mkdir(path.join(root, 'thread-coordinators'));
  await symlink(outside, path.join(root, 'thread-coordinators', item.id), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(threads.deleteConversation(item.id), /symbolic link|junction/);
  assert.equal(await readFile(path.join(outside, 'keep.txt'), 'utf8'), 'KEEP'); assert.equal(threads.pendingDeletions()[0].threadId, item.id);
  await threads.close();
});

test('durable deletion intent hides immediately and startup resumes an interrupted purge', async t => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'alpha-delete-recovery-')); await mkdir(path.join(repo, 'workspace'));
  await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[]}');
  let service = await createService({ repo, uiDir: repo, mcpOptions: { home: repo, env: {} } });
  t.after(() => service.close());
  const request = async route => { const response = await fetch(`${service.origin}/api${route}`, { method: 'DELETE', headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' }, body: '{}' }); return { status: response.status, body: await response.json() }; };
  const thread = service.threads.create({ name: 'Crash recovery conversation' });
  const worker = service.sessions.make({ id: randomUUID(), name: 'Recovery fixture worker', agent: 'codex', nativeId: 'provider-recovery-history', alphaThreadId: thread.id, open: false, status: 'stopped', activity: 'idle', cwd: repo });
  service.sessions.items.set(worker.id, worker); service.threads.observe(worker);
  service.replies.add({ id: 'recovery-reply', sessionId: worker.id, name: worker.name, text: 'Cleanup resumes after restart' });
  service.questions.items.push({ id: 'recovery-question', sessionId: 'alpha', threadId: thread.id, source: 'coordinator', sourceId: 'old', chatName: thread.name, text: 'Already answered recovery question?', status: 'answered', answer: 'Yes', createdAt: new Date().toISOString() }); await service.questions.changed();
  service.awareness.event({ id: 'recovery-notice', threadId: thread.id, sessionId: worker.id, kind: 'review', text: 'Recovery notice', source: 'Fixture' });
  const coordinatorDir = path.join(repo, '.alpha/thread-coordinators', thread.id); await mkdir(coordinatorDir, { recursive: true }); await writeFile(path.join(coordinatorDir, 'operations.json'), '[{"text":"PRIVATE COORDINATOR STATE"}]');
  const originalPurge = service.replies.purgeSessions.bind(service.replies); service.replies.purgeSessions = async () => { throw new Error('Synthetic cleanup interruption'); };
  const failed = await request(`/threads/${thread.id}/delete`); assert.equal(failed.status, 400, JSON.stringify(failed.body)); assert.match(failed.body.error, /Synthetic cleanup interruption/);
  assert.throws(() => service.threads.get(thread.id), /not found/); assert.equal(service.threads.pendingDeletions().some(item => item.threadId === thread.id), true);
  const durable = await readFile(path.join(repo, '.alpha/threads.json'), 'utf8'), pendingRecord = JSON.parse(durable).deleted[0]; assert.equal(pendingRecord.cleanupPending, true); assert.equal(pendingRecord.name, 'Crash recovery conversation'); assert.doesNotMatch(durable, /Cleanup resumes after restart|Recovery notice|Already answered/);
  const backup = coordinatorDir + '-backup', outside = await mkdtemp(path.join(os.tmpdir(), 'alpha-delete-recovery-link-')); await writeFile(path.join(outside, 'keep.txt'), 'KEEP'); await rename(coordinatorDir, backup); await symlink(outside, coordinatorDir, process.platform === 'win32' ? 'junction' : 'dir');
  service.replies.purgeSessions = originalPurge; await service.close();
  service = await createService({ repo, uiDir: repo, mcpOptions: { home: repo, env: {} } });
  assert.equal(service.threads.pendingDeletions().some(item => item.threadId === thread.id), true); assert.deepEqual(service.threads.snapshot().pendingConversationDeletions.map(item => [item.id, item.name]), [[thread.id, thread.name]]);
  assert.equal(service.awareness.snapshot().items.some(item => item.id === `conversation-deletion:${thread.id}`), true); assert.equal(await readFile(path.join(outside, 'keep.txt'), 'utf8'), 'KEEP');
  const blockedRetry = await request(`/threads/${thread.id}/delete`); assert.notEqual(blockedRetry.status, 200); assert.equal(service.threads.pendingDeletions().length, 1);
  await unlink(coordinatorDir); await rename(backup, coordinatorDir);
  const retried = await request(`/threads/${thread.id}/delete`); assert.equal(retried.status, 200); assert.equal(retried.body.cleanupRetried, true);
  assert.equal(service.threads.pendingDeletions().some(item => item.threadId === thread.id), false); assert.equal(service.sessions.items.has(worker.id), false); assert.equal(service.awareness.snapshot().items.some(item => item.id === `conversation-deletion:${thread.id}`), false);
  assert.equal(service.replies.items.some(item => item.sessionId === worker.id), false); assert.equal(service.questions.items.some(item => item.threadId === thread.id), false); assert.equal(service.awareness.items.some(item => item.threadId === thread.id), false);
  await assert.rejects(access(coordinatorDir)); await service.close();
});

test('delete endpoint refuses active work and pending decisions, then purges Alpha-owned state without touching provider identity', async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'alpha-delete-api-')); await mkdir(path.join(repo, 'workspace'));
  await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[]}');
  const service = await createService({ repo, uiDir: repo, mcpOptions: { home: repo, env: {} } });
  const request = async (route, data = {}, method = 'POST') => { const response = await fetch(`${service.origin}/api${route}`, { method, headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' }, ...(method !== 'GET' ? { body: JSON.stringify(data) } : {}) }); return { status: response.status, body: await response.json() }; };
  try {
    const thread = service.threads.create({ name: 'Disposable old conversation' }), retained = service.threads.create({ name: 'Unrelated retained conversation' });
    const worker = service.sessions.make({ id: randomUUID(), name: 'Stopped fixture worker', agent: 'codex', nativeId: 'provider-history-stays', alphaThreadId: thread.id, open: false, status: 'running', activity: 'working', cwd: repo });
    service.sessions.items.set(worker.id, worker); service.threads.observe(worker); service.threads.select(thread.id);
    const release = service.threads.claim(thread.id, 'delete'); assert.throws(() => service.sessions.validateStart(worker), /being deleted/); release();
    let response = await request(`/threads/${thread.id}/delete`, {}, 'DELETE');
    assert.equal(response.status, 409); assert.match(response.body.error, /will not stop active work/i); assert.equal(service.threads.get(thread.id).id, thread.id);
    worker.status = 'stopped'; worker.activity = 'idle'; service.threads.observe(worker);
    assert.equal((await request('/restart-notes', { sessionId: worker.id, note: 'Private restart hint for the disposable fixture.' })).status, 200);
    service.common.input(worker, 'Private task activity for the disposable fixture.');
    const pending = await service.questions.ask({ source: 'coordinator', sourceId: 'delete-question', threadId: thread.id, chatName: thread.name, text: 'Keep this pending fixture decision?' });
    response = await request(`/threads/${thread.id}/delete`, {}, 'DELETE');
    assert.equal(response.status, 409); assert.match(response.body.error, /pending Questions/i);
    await service.questions.dismiss(pending.id);
    const queued = { id: 'answered-history', sessionId: 'alpha', threadId: thread.id, source: 'coordinator', sourceId: 'old', chatName: thread.name, text: 'Old answered question?', status: 'answered', answer: 'Delete it', continuation: 'queued', createdAt: new Date().toISOString() };
    service.questions.items.push(queued); await service.questions.changed();
    response = await request(`/threads/${thread.id}/delete`, {}, 'DELETE'); assert.equal(response.status, 409); assert.match(response.body.error, /answer delivery/i);
    queued.continuation = 'completed'; await service.questions.changed();
    service.replies.add({ id: 'old-reply', sessionId: worker.id, name: worker.name, text: 'Old local reply' });
    service.awareness.event({ id: 'old-notice', threadId: thread.id, sessionId: worker.id, kind: 'review', text: 'Old local notice', source: 'Fixture' });
    service.threads.message(retained.id, { id: 'old-share', role: 'user', source: 'shared', sourceThreadId: thread.id, text: 'Copied private text' });
    response = await request(`/threads/${thread.id}/delete`, {}, 'DELETE');
    assert.equal(response.status, 200); assert.equal(response.body.providerHistory, 'Native provider transcripts were not changed.');
    assert.throws(() => service.threads.get(thread.id), /not found/); assert.equal(service.sessions.items.has(worker.id), false);
    assert.equal(service.replies.items.some(item => item.sessionId === worker.id), false); assert.equal(service.questions.items.some(item => item.threadId === thread.id), false);
    assert.equal(service.awareness.items.some(item => item.threadId === thread.id || item.sessionId === worker.id), false); assert.equal(service.threads.get(retained.id).messages.length, 1);
    assert.equal(service.threads.snapshot().threads.some(item => item.id === thread.id), false); assert.equal(service.threads.directory().some(item => item.id === thread.id), false);
    assert.doesNotMatch(await readFile(path.join(repo, '.alpha/restart-notes.json'), 'utf8'), /Private restart hint/);
    assert.doesNotMatch(await readFile(path.join(repo, '.alpha/common-agent-activity.json'), 'utf8'), /Private task activity/);
    const imported = await request('/history/import', { agent: 'codex', nativeId: worker.nativeId, name: 'Deleted provider import', cwd: repo });
    assert.equal(imported.status, 409);
    assert.match(imported.body.error, /deleted from Alpha/);
    assert.throws(() => service.sessions.validateStart({ ...worker, id: randomUUID(), alphaThreadId: null }), /deleted from Alpha/);
    assert.deepEqual((await request('/history', undefined, 'GET')).body, []);
    const saved = await readFile(path.join(repo, '.alpha/threads.json'), 'utf8');
    assert.doesNotMatch(saved, /Old local|provider-history-stays|Disposable old conversation/); assert.match(saved, /Copied private text/);
  } finally { await service.close(); }
});

test('durable project deletion blocks thread and worker dispatch while keep-files history remains usable', async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'alpha-project-dispatch-')); await mkdir(path.join(repo, 'workspace'));
  await writeFile(path.join(repo, 'workspace/workspace.json'), JSON.stringify({ entities: [
    { id: 'deleted-local', title: 'Deleted local project', folder: 'deleted-local', steps: [], removedAt: new Date().toISOString(), removalScope: 'delete-files' },
    { id: 'kept-history', title: 'Kept files project', folder: 'kept-history', steps: [], removedAt: new Date().toISOString(), removalScope: 'keep-files' },
  ] }));
  const service = await createService({ repo, uiDir: repo, mcpOptions: { home: repo, env: {} }, initializeProjects: false });
  const request = async (route, data) => { const response = await fetch(`${service.origin}/api${route}`, { method: 'POST', headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); return { status: response.status, body: await response.json() }; };
  try {
    const deletedSession = service.sessions.make({ id: randomUUID(), agent: 'codex', name: 'Deleted project worker', projectId: 'deleted-local', alphaThreadId: null, open: false, status: 'stopped', activity: 'idle', cwd: repo });
    await assert.rejects(service.sessions.validateResume(deletedSession), /pending or completed local-file deletion/); assert.throws(() => service.sessions.validateStart(deletedSession), /pending or completed local-file deletion/);
    const keptSession = service.sessions.make({ id: randomUUID(), agent: 'codex', name: 'Kept project worker', projectId: 'kept-history', alphaThreadId: null, open: false, status: 'stopped', activity: 'idle', cwd: repo });
    await service.sessions.validateResume(keptSession); assert.doesNotThrow(() => service.sessions.validateStart(keptSession));
    const thread = service.threads.create({ name: 'Deleted project conversation', projectId: 'deleted-local' }); service.threads.select(thread.id);
    const blocked = await request(`/threads/${thread.id}/input`, { id: randomUUID(), text: 'Must not reach a coordinator or worker.' });
    assert.equal(blocked.status, 409); assert.match(blocked.body.error, /pending or completed local-file deletion/); assert.equal(thread.messages.length, 0); assert.equal(service.coordinator.operationPromises.size, 0);
    service.projectStorage.busy.add('kept-history');
    const busySession = { ...keptSession, id: randomUUID() }; assert.throws(() => service.sessions.validateStart(busySession), /being cleaned or deleted/);
    service.projectStorage.busy.delete('kept-history');
  } finally { await service.close(); }
});
