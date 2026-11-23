import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Awareness } from '../awareness.mjs';
import { createService } from '../server.mjs';

test('attention prioritizes actionable events, rejects stale/future events and retains dedup receipts beyond visible capacity', async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'alpha-attention-'));
  let time = Date.now(); const awareness = await new Awareness(repo, () => {}, () => time).init();
  const event = { id: 'first', threadId: 'a', kind: 'review', text: 'Ready for review, not verified', source: 'Fixture completion' };
  awareness.event(event); awareness.control({ id: 'first', action: 'dismiss' });
  for (let i = 0; i < 505; i++) awareness.event({ ...event, id: `event-${i}` });
  awareness.event(event); assert.ok(!awareness.snapshot().items.some(item => item.id === 'first'));
  awareness.event({ ...event, id: 'old', at: time - 31 * 86400000 });
  awareness.event({ ...event, id: 'future', at: time + 120000 });
  assert.ok(!awareness.items.some(item => ['old', 'future'].includes(item.id)));
  awareness.event({ ...event, id: 'failure', kind: 'error' }); awareness.event({ ...event, id: 'question', kind: 'question', questionId: 'q-a' });
  assert.equal(awareness.snapshot().items[0].questionId, 'q-a');
  awareness.control({ id: 'question', action: 'snooze', quiet: true }); assert.equal(awareness.settings.quiet, true);
  time += 31 * 60000; assert.equal(awareness.snapshot().items[0].id, 'question');
  awareness.event({ ...event, id: 'suggestion', kind: 'overlap', inference: true });
  awareness.event({ ...event, id: 'repeat-suggestion', kind: 'overlap', inference: true });
  assert.ok(!awareness.items.some(item => item.id === 'repeat-suggestion'));
  await awareness.close(); const restored = await new Awareness(repo).init(); restored.event(event);
  assert.ok(!restored.items.some(item => item.id === 'first')); assert.equal(restored.settings.desktop, false); await restored.close();
});

test('pending Questions reconcile after pause and restart; resolved Questions and duplicates stay cleared', async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'alpha-attention-service-')); await mkdir(path.join(repo, 'workspace'));
  await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[]}');
  let service = await createService({ repo, uiDir: repo, mcpOptions: { home: repo, env: {} } });
  const thread = service.threads.create({ name: 'Attention fixture', projectId: 'fixture' });
  service.awareness.control({ enabled: false });
  const question = await service.questions.ask({ text: 'Which fixture result should I review?', threadId: thread.id, sourceId: 'one' });
  assert.ok(!service.awareness.items.some(item => item.questionId === question.id));
  const response = await fetch(service.origin + '/api/awareness', { method: 'POST', headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' }, body: '{"enabled":true}' });
  assert.equal(response.status, 200); assert.ok(service.awareness.snapshot().items.some(item => item.questionId === question.id));
  assert.equal(service.threads.get(thread.id).status, 'waiting-for-user');
  service.threads.get(thread.id).operation = { status: 'completed', phase: 'waiting-for-user', timings: {} }; service.threads.publish();
  await service.close(); service = await createService({ repo, uiDir: repo, mcpOptions: { home: repo, env: {} } });
  try {
    assert.equal(service.awareness.snapshot().items.filter(item => item.questionId === question.id).length, 1);
    await service.questions.dismiss(question.id);
    assert.ok(!service.awareness.snapshot().items.some(item => item.questionId === question.id));
    assert.equal(service.threads.get(thread.id).operation.phase, 'completed');
    assert.equal(service.awareness.settings.desktop, false);
  } finally { await service.close(); }
});

test('a verified worker recovery moves its error to history and keeps other issues current', async t => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'alpha-attention-recovery-'));
  await mkdir(path.join(repo, 'workspace'));
  await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[]}');
  const service = await createService({ repo, uiDir: repo, mcpOptions: { home: repo, env: {} } });
  t.after(() => service.close());
  const worker = service.sessions.make({ id: 'recovering', agent: 'codex', name: 'Recovery fixture', cwd: repo, status: 'running' });
  service.sessions.items.set(worker.id, worker);
  const error = { kind: 'error', source: 'Native provider error', text: 'Fixture provider failure', at: Date.now() - 1000 };
  service.awareness.event({ ...error, id: 'recovered-error', sessionId: worker.id });
  service.awareness.event({ ...error, id: 'unrelated-error', sessionId: 'different-worker' });
  service.awareness.event({ ...error, id: 'unconfirmed-delivery', sessionId: worker.id, source: 'Terminal submission verification' });
  assert.equal(service.awareness.snapshot().items.length, 3);
  worker.workerEvidence = { execution: 'finished', observedAt: Date.now() };
  service.sessions.changed(worker);
  const snapshot = service.awareness.snapshot();
  assert.deepEqual(snapshot.history.map(item => item.id), ['recovered-error']);
  assert.deepEqual(snapshot.items.map(item => item.id).sort(), ['unconfirmed-delivery', 'unrelated-error']);
  await service.awareness.save();
  const restored = await new Awareness(path.dirname(service.awareness.file)).init();
  assert.deepEqual(restored.snapshot().history.map(item => item.id), ['recovered-error']);
});
