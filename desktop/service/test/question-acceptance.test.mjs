import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { Questions } from '../questions.mjs';
import { nativeActivity } from '../native-events.mjs';
import { submissionHash } from '../terminal-submission.mjs';

await mkdir('.test-output', { recursive: true });

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

test('Codex async delivery binds each sibling question and sends its supported reply envelope', async () => {
  const q = await new Questions(await mkdtemp('.test-output/async-question-')).init();
  const session = { id: 'worker', agent: 'codex', nativeId: 'native-one', alphaThreadId: 'thread-one', status: 'running' };
  const questions = [{ title: 'Which fixture color?', options: ['Blue', 'Green'] }, { title: 'Which fixture color?', options: ['Red', 'Gold'] }];
  const intent = nativeActivity({ type: 'response_item', payload: { type: 'function_call', name: 'request_user_input_async', call_id: 'call-one', arguments: JSON.stringify({ questions }) } }, 'codex');
  q.capture(session, intent); assert.equal(q.list().length, 2); assert.ok(q.list().every(item => item.requiresNative));
  const delivered = nativeActivity({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', id: 'call-one', delivery: 'async', questions } } }, 'codex');
  q.capture(session, delivered); assert.equal(q.list().length, 2);
  assert.deepEqual(q.list().map(item => JSON.parse(item.asyncQuestion.id)), [['request_user_input_async', 'call-one', 0], ['request_user_input_async', 'call-one', 1]]);
  const first = q.list()[0], sent = [];
  const sessions = { get: () => session, input: async (id, text, options) => { sent.push({ id, text, options }); return { accepted: true }; } };
  await q.answer(first.id, 'Blue', sessions);
  assert.deepEqual(JSON.parse(sent[0].text.replace('<send_user_message_question_reply>', '').replace('</send_user_message_question_reply>', '')), [{ questionItemId: '["request_user_input_async","call-one",0]', question: 'Which fixture color?', answer: 'Blue' }]);
  assert.equal(sent[0].options.taskId, `question:${first.id}`); assert.equal(q.list().length, 1);
  await q.answer(first.id, 'Blue', sessions); assert.equal(sent.length, 1);
  session.nativeId = 'different-native'; await assert.rejects(q.answer(q.list()[0].id, 'Red', sessions), /originating/);
  await q.close();
});

test('late native answer acceptance clears exactly its question without retry, including after restore', async () => {
  const root = await mkdtemp('.test-output/late-question-'), q = await new Questions(root).init();
  const session = { id: 'worker', agent: 'codex', nativeId: 'native-one', alphaThreadId: 'thread-one', status: 'running', submissions: [] };
  const [first] = q.capture(session, { id: 'turn-one', message: 'Which fixture color?' });
  const [second] = q.capture(session, { id: 'turn-two', message: 'Which fixture shape?' });
  let sends = 0;
  const sessions = { get: () => session, input: async () => { sends++; return { accepted: false, note: 'Queued; awaiting native acceptance.' }; } };
  await assert.rejects(q.answer(first.id, 'Blue', sessions), /awaiting/);
  assert.equal(q.list().length, 2); await q.close();
  const restored = await new Questions(root).init();
  session.submissions = [{ taskId: `question:${first.id}`, hash: submissionHash('Blue'), acceptedAt: Date.now(), acceptance: 'observed' }];
  await restored.observeSubmission({ ...session, nativeId: 'different' }); assert.equal(restored.list().length, 2);
  await restored.observeSubmission({ ...session, alphaThreadId: 'different' }); assert.equal(restored.list().length, 2);
  await restored.observeSubmission({ ...session, submissions: [{ ...session.submissions[0], hash: submissionHash('Green') }] }); assert.equal(restored.list().length, 2);
  await restored.observeSubmission(session); assert.deepEqual(restored.list().map(item => item.id), [second.id]);
  assert.equal((await restored.answer(first.id, 'Blue', sessions)).alreadyAccepted, true); assert.equal(sends, 1);
  await restored.close();
});
