import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Learning } from '../learning.mjs';
import { createService } from '../server.mjs';
import { voiceSession } from '../voice-profile.mjs';

test('lessons survive restart, concurrent saves, edits and forgetting without losing unrelated lessons', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'alpha-learning-'));
  const learning = await new Learning(stateDir).init();
  await Promise.all([
    learning.save({ kind: 'conversation', text: 'Lead with your answer.' }),
    learning.save({ kind: 'work', text: 'Check every requested behavior before saying done.' }),
  ]);
  await learning.save({ kind: 'conversation', text: 'Lead with your answer.' });
  assert.equal(learning.items.length, 2);
  const id = learning.items[0].id;
  await learning.save({ id, kind: 'conversation', text: 'Lead with your answer, then explain the reason.' });
  let restarted = await new Learning(stateDir).init();
  assert.equal(restarted.items[0].id, id);
  assert.equal(restarted.items[0].text, 'Lead with your answer, then explain the reason.');
  await restarted.forget(id);
  restarted = await new Learning(stateDir).init();
  assert.equal(restarted.items.length, 1);
  assert.equal(restarted.items[0].kind, 'work');
  assert.doesNotMatch(restarted.context(), /Lead with your answer/);
});

test('remembering is grounded in a running user request, not inferred or imported from tool text', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'alpha-grounded-learning-'));
  const learning = await new Learning(stateDir).init();
  const operation = { id: 'correction', status: 'running', text: 'Next time, explain what remains untested.' };
  const input = { kind: 'work', text: 'explain what remains untested.' };
  await learning.remember(input, operation);
  assert.deepEqual(learning.items[0].source, { type: 'conversation', operationId: 'correction' });
  assert.throws(() => learning.remember({ kind: 'work', text: 'The user likes untested code.' }, operation), /current user request/);
  assert.throws(() => learning.remember(input, { ...operation, status: 'completed' }), /current user request/);
  assert.throws(() => learning.remember(input, undefined), /current user request/);
  for (const input of [{ kind: 'unknown', text: 'A meaningful preference.' }, { kind: 'work', text: 'short' }, { kind: 'work', text: 'x'.repeat(601) }]) assert.throws(() => learning.save(input));
  await assert.rejects(learning.save({ id: 'missing', kind: 'work', text: 'A meaningful preference.' }), /no longer exists/);
});

test('new lessons never silently displace existing preferences', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'alpha-learning-limit-'));
  const learning = await new Learning(stateDir).init();
  for (let index = 0; index < 40; index++) await learning.save({ kind: 'work', text: `Remember the explicit work preference number ${index}.` });
  await assert.rejects(learning.save({ kind: 'work', text: 'Another explicit work preference.' }), /40 saved lessons/);
  assert.equal((await new Learning(stateDir).init()).items.length, 40);
});

test('authenticated lesson changes reach subsequent coordinator turns, live voice and task handoffs', async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'alpha-learning-service-'));
  await mkdir(path.join(repo, 'workspace'));
  await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[]}');
  const service = await createService({ repo, uiDir: repo, mcpOptions: { home: repo, env: {} } });
  const request = (route, method = 'GET', data, origin = service.origin) => fetch(service.origin + '/api' + route, { method, headers: { Authorization: `Bearer ${service.token}`, Origin: origin, 'Content-Type': 'application/json' }, ...(data ? { body: JSON.stringify(data) } : {}) });
  const text = 'Check the complete request before finishing.';
  try {
    assert.equal((await fetch(service.origin + '/api/learning')).status, 401);
    assert.equal((await request('/learning', 'POST', { kind: 'work', text }, service.contentOrigin)).status, 403);
    assert.equal((await request('/learning', 'POST', { kind: 'work', text })).status, 200);
    await service.learning.save({ kind: 'conversation', text: 'Use a light conversational tone.' });
    const turns = [];
    service.coordinator.start = async () => { service.coordinator.threadId = 'fixture'; };
    service.coordinator.rpc = async (_method, params) => {
      turns.push(params.input[0].text); service.coordinator.active.resolve('I checked the whole request.');
      return { turn: { id: 'fixture-turn' } };
    };
    await service.coordinator.ask({ id: 'next-turn', text: 'How will you approach this task?' });
    assert.ok(turns.at(-1).includes(text));
    assert.ok(voiceSession({}, service.learning.context()).instructions.includes(text));
    const id = service.learning.items[0].id;
    const sent = [];
    service.sessions.get = () => ({ agent: 'codex' });
    service.sessions.input = (_id, text) => { sent.push(text); return { delivered: true }; };
    await service.coordinator.execute('send_to_chat', { id: 'worker', text: 'Implement this feature.', includeWorkLessons: true }, 'next-turn');
    assert.ok(sent.at(-1).includes(text));
    assert.ok(sent.at(-1).endsWith('Implement this feature.'));
    assert.doesNotMatch(sent.at(-1), /Use a light conversational tone/);
    await service.coordinator.execute('send_to_chat', { id: 'worker', text: 'Option 2' }, 'next-turn');
    assert.equal(sent.at(-1), 'Option 2');
    service.coordinator.operations.set('correction', { id: 'correction', status: 'running', text: 'Remember: keep the explanation focused.', at: new Date().toISOString() });
    await service.coordinator.execute('remember_learning', { kind: 'conversation', text: 'keep the explanation focused.' }, 'correction');
    assert.equal(service.learning.items.at(-1).source.operationId, 'correction');
    assert.equal((await request(`/learning/${id}`, 'DELETE')).status, 200);
    assert.equal((await service.coordinator.ask({ id: 'after-forget', text: 'How about now?' })).status, 'completed');
    assert.ok(!turns.at(-1).includes(text));
    assert.ok(!voiceSession({}, service.learning.context()).instructions.includes(text));
  } finally { await service.close(); }
});
