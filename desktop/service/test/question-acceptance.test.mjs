import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { Questions } from '../questions.mjs';

test('durable acceptance clears before continuation finishes; duplicate retries never repeat work', async () => {
  const root = await mkdtemp('.test-output/question-acceptance-');
  const q = await new Questions(root).init();
  const item = await q.ask({ text: 'Which layout should be used?', threadId: 'exact-origin', sourceId: 'fixture' });
  let complete, runs = 0;
  const resume = async () => async () => { runs++; await new Promise(resolve => { complete = resolve; }); };
  const events = []; q.on('changed', list => events.push(list.length));
  await Promise.all([q.answer(item.id, 'Compact', {}, resume), q.answer(item.id, 'Compact', {}, resume)]);
  assert.equal(q.list().length, 0); assert.equal(runs, 1); assert.equal(events.at(-1), 0);
  const saved = JSON.parse(await readFile(q.file));
  assert.equal(saved[0].status, 'answered'); assert.equal(saved[0].threadId, 'exact-origin'); assert.equal(saved[0].answer, 'Compact');
  assert.equal((await new Questions(root).init()).list().length, 0);
  assert.equal((await q.answer(item.id, 'Compact', {}, resume)).alreadyAccepted, true);
  await assert.rejects(q.answer(item.id, 'Different', {}, resume), /different answer/);
  complete(); await new Promise(resolve => setImmediate(resolve)); await q.close(); assert.equal(runs, 1);
});

test('validation and persistence failure retain pending; concurrent arrival is preserved; continuation error is separate audit', async () => {
  const q = await new Questions(await mkdtemp('.test-output/question-failure-')).init();
  const first = await q.ask({ text: 'Which first option should be used?', threadId: 'a' });
  await assert.rejects(q.answer(first.id, 'A', {}, async () => { throw new Error('Retryable validation'); }), /Retryable/);
  assert.equal(q.list().length, 1);
  const changed = q.changed.bind(q); let attempts = 0;
  q.changed = () => ++attempts === 2 ? Promise.reject(new Error('Disk full')) : changed();
  let ran = false;
  await assert.rejects(q.answer(first.id, 'A', {}, async () => () => { ran = true; }), /Disk full/);
  assert.equal(first.status, 'pending'); assert.equal(ran, false); q.changed = changed;
  const second = await q.ask({ text: 'Which second option should be used?', threadId: 'b' });
  let failure; q.on('continuation-failed', value => { failure = value; });
  await q.answer(first.id, 'A', {}, async () => async () => { throw new Error('Provider failed later'); });
  await new Promise(resolve => setImmediate(resolve)); await q.close();
  assert.deepEqual(q.list().map(item => item.id), [second.id]); assert.equal(failure.question.threadId, 'a');
  assert.equal(first.status, 'answered'); assert.equal(first.continuation, 'failed');
});
