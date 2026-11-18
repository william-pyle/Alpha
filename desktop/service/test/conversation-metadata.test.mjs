import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Threads } from '../threads.mjs';
import { Questions } from '../questions.mjs';

test('descriptive new titles, explicit metadata, safe legacy review and restart preserve native identity', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'alpha-metadata-'));
  const native = { id: 'native-stable', nativeId: 'provider-unchanged', name: 'Conversation 7', open: true, status: 'running', activity: 'working' };
  const threads = await new Threads(root).init([native]);
  for (const name of ['', 'New chat', 'Conversation 12', 'Codex']) assert.throws(() => threads.create({ name }), /descriptive/);
  const a = threads.create({ purpose: 'Diagnose response latency and expose failures', projectId: 'alpha' });
  assert.equal(a.name, 'Diagnose response latency and expose failures');
  const legacy = threads.get(native.id); legacy.draft = { text: 'Private legacy draft', paths: [] };
  threads.message(legacy.id, { id: 'private', role: 'user', text: 'Private history' });
  threads.select(a.id);
  assert.ok(!JSON.stringify(threads.review()).includes('Private'));
  assert.ok(!JSON.stringify(threads.snapshot()).includes('Private'));
  assert.equal(legacy.name, 'Conversation 7'); assert.equal(legacy.projectId, null); assert.equal(legacy.status, 'working');
  threads.patch(a.id, { name: 'Alpha responsiveness', purpose: 'Measure first response and fix local delays', archived: true });
  await threads.close();
  const restored = await new Threads(root).init([native]);
  assert.equal(restored.get(a.id).purpose, 'Measure first response and fix local delays');
  assert.equal(restored.get(a.id).archived, true); assert.equal(restored.get(native.id).draft.text, 'Private legacy draft');
  assert.deepEqual(restored.migration.bindings, [{ sessionId: native.id, nativeId: native.nativeId }]);
  await restored.close();
});

test('identical Questions with identical operation IDs stay bound to their origin across restart', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'alpha-question-origin-'));
  const questions = await new Questions(root).init();
  const ask = threadId => questions.ask({ text: 'Which project should own this work?', sourceId: 'same-operation', threadId });
  const a = await ask('a'), b = await ask('b');
  assert.notEqual(a.id, b.id); assert.equal((await ask('a')).id, a.id); await questions.close();
  const restored = await new Questions(root).init(); const answers = [];
  await restored.answer(a.id, 'Alpha', {}, async question => answers.push(question.threadId));
  assert.deepEqual(answers, ['a']); assert.equal(restored.list()[0].threadId, 'b'); await restored.close();
});
