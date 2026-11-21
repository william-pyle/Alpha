import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createService } from '../server.mjs';

async function fixture(t) {
  const repo = await mkdtemp(path.join(tmpdir(), 'alpha-foreground-replies-'));
  await mkdir(path.join(repo, 'workspace'));
  await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[]}');
  const service = await createService({ repo, uiDir: repo, mcpOptions: { home: repo, env: {} } });
  t.after(() => service.close());
  const request = async (route, data, method = data ? 'POST' : 'GET') => {
    const response = await fetch(service.origin + '/api' + route, {
      method, headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  return { service, request, repo };
}

function stubForeground(instance) {
  const calls = [];
  instance.ask = async data => {
    calls.push(data);
    const operation = { ...data, status: 'completed', result: 'I can still reply while the worker is busy.' };
    instance.emit('result', operation);
    return operation;
  };
  return calls;
}

async function waitFor(check) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await delay(10);
  }
  assert.ok(check(), 'Expected the observed state within one second.');
}

test('a held native dispatch does not hold up an Alpha reply, and an explicit work message waits for the bound worker', async t => {
  const { service, request, repo } = await fixture(t);
  const native = service.sessions.make({ id: randomUUID(), agent: 'shell', name: 'Busy native worker', cwd: repo, projectId: 'conversations', status: 'running', open: true });
  service.sessions.items.set(native.id, native);
  const thread = service.threads.observe(native);
  const unrelated = service.threads.create({ name: 'Separate conversation', projectId: 'conversations' });
  service.threads.message(unrelated.id, { id: 'private-other', role: 'user', text: 'EXCLUDE_OTHER_CONVERSATION' });
  service.threads.select(thread.id);
  const foreground = await service.getCoordinator(thread.id, { replyOnly: true });
  const replyCalls = stubForeground(foreground);
  const deliveries = [];
  let releaseDispatch;
  service.sessions.input = async (id, text, options) => {
    deliveries.push({ id, text, taskId: options.taskId });
    if (deliveries.length === 1) await new Promise(resolve => { releaseDispatch = resolve; });
    return { delivered: true, accepted: true, submission: { stage: 'accepted' } };
  };
  try {
    const first = await request(`/threads/${thread.id}/input`, { id: 'work-one', text: 'Start the background work.' });
    assert.equal(first.status, 202);
    assert.equal(first.body.target, 'work');
    await waitFor(() => !!releaseDispatch);
    assert.equal(service.threads.snapshot().threads.find(entry => entry.id === thread.id).backgroundWorkActive, true);

    const reply = await request(`/threads/${thread.id}/input`, { id: 'reply-one', text: 'What is still running?' });
    assert.equal(reply.status, 202);
    assert.equal(reply.body.target, 'reply');
    assert.equal(replyCalls[0].origin, 'foreground');
    assert.equal(replyCalls[0].selectedId, null);
    assert.equal(deliveries.length, 1);
    assert.ok(thread.messages.some(entry => entry.id === 'operation:reply-one'));
    assert.doesNotMatch(JSON.stringify(foreground.context()), /EXCLUDE_OTHER_CONVERSATION|Separate conversation/);
    assert.equal(thread.messages.find(entry => entry.id === 'work-one').status, 'dispatching');

    const queuedMessage = { id: 'work-two', text: 'Run the next check.', target: 'work' };
    assert.equal((await request(`/threads/${thread.id}/input`, queuedMessage)).body.target, 'work');
    assert.equal((await request(`/threads/${thread.id}/input`, queuedMessage)).body.duplicate, true);
    assert.equal((await request(`/threads/${thread.id}/delete`, {}, 'DELETE')).status, 409);
    assert.equal(deliveries.length, 1);
    releaseDispatch();
    await waitFor(() => thread.messages.find(entry => entry.id === 'work-two')?.status === 'dispatched');
    assert.deepEqual(deliveries.map(delivery => [delivery.id, delivery.taskId]), [[native.id, 'work-one'], [native.id, 'work-two']]);
    assert.equal(service.threads.snapshot().threads.find(entry => entry.id === thread.id).backgroundWorkActive, false);
  } finally { releaseDispatch?.(); }
});

test('the work coordinator and the foreground responder have independent operations and status', async t => {
  const { service, request } = await fixture(t);
  const thread = service.threads.create({ name: 'Long work fixture', projectId: 'conversations' });
  const work = await service.getCoordinator(thread.id);
  const foreground = await service.getCoordinator(thread.id, { replyOnly: true });
  assert.notEqual(work, foreground);
  assert.notEqual(work.stateDir, foreground.stateDir);
  const calls = stubForeground(foreground);
  work.operations.set('long-work', { id: 'long-work', status: 'running' });
  work.operationPromises.set('long-work', Promise.resolve());
  thread.status = 'working';
  thread.operation = { id: 'long-work', phase: 'tool' };
  const reply = await request(`/threads/${thread.id}/input`, { id: 'reply-during-tool', text: 'Are you still working?' });
  assert.equal(reply.body.target, 'reply');
  assert.equal(calls.length, 1);
  assert.equal(foreground.context().work.operationPhase, 'tool');
  assert.equal(thread.operation.id, 'long-work');
  assert.equal(thread.status, 'working');
  work.operations.get('long-work').status = 'completed';
  assert.equal(service.threads.snapshot().threads.find(entry => entry.id === thread.id).backgroundWorkActive, false);
});
