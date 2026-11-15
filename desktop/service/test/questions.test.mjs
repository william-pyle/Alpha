import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { Questions, extractQuestions, extractTerminalQuestion } from '../questions.mjs';
import { nativeActivity } from '../native-events.mjs';

test('extracts direct questions and suggested replies from final messages', () => {
  assert.deepEqual(extractQuestions('Ready.\nWhich option should I use?\n- Keep the current layout\n- Use a compact layout'), [{ text: 'Which option should I use?', options: ['Keep the current layout', 'Use a compact layout'] }]);
  assert.deepEqual(extractQuestions('```\nShould I run this?\n```\nShould I continue?'), [{ text: 'Should I continue?', options: ['Yes', 'No'] }]);
  assert.deepEqual(extractQuestions('Done.\nhttps://example.test/?'), []);
  assert.equal(extractTerminalQuestion('Result\nDo you want to continue?'), 'Do you want to continue?');
  assert.equal(extractTerminalQuestion('Do you want to continue?\nPS C:\\>'), null);
});

test('recognizes structured Codex and Claude question events', () => {
  const codex = nativeActivity({ type: 'response_item', payload: { type: 'function_call', name: 'request_user_input', call_id: 'q-1', arguments: JSON.stringify({ questions: [{ question: 'Pick a theme?', options: [{ label: 'Dark' }, { label: 'Light' }] }] }) } }, 'codex');
  assert.equal(codex.kind, 'question');
  assert.equal(codex.questions[0].text, 'Pick a theme?');
  const claude = nativeActivity({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'AskUserQuestion', id: 'q-2', input: { questions: [{ question: 'Use blue?', options: [{ label: 'Yes' }, { label: 'No' }] }] } }] } }, 'claude');
  assert.equal(claude.kind, 'question');
  assert.equal(claude.questions[0].options[0].label, 'Yes');
});

test('persists pending questions and clears one only after its answer reaches the source chat', async () => {
  await mkdir('.test-output', { recursive: true });
  const root = await mkdtemp(path.resolve('.test-output/questions-'));
  const questions = await new Questions(root).init();
  const source = { id: 'chat-one', agent: 'codex', name: 'First chat' };
  assert.equal(questions.capture(source, { id: 'turn-one', message: 'Should I proceed?' }).length, 1);
  assert.equal(questions.capture(source, { id: 'turn-one', message: 'Should I proceed?' }).length, 0);
  await questions.close();
  const restored = await new Questions(root).init();
  assert.equal(restored.list().length, 1);
  const sent = [];
  const sessions = { get: id => ({ id, status: 'running' }), input: (id, answer, options) => { sent.push({ id, answer, options }); } };
  const id = restored.list()[0].id;
  await assert.rejects(restored.answer(id, '', sessions), /Enter an answer/);
  assert.equal(restored.list().length, 1);
  await restored.answer(id, 'Yes, proceed', sessions);
  assert.deepEqual(sent, [{ id: 'chat-one', answer: 'Yes, proceed', options: { composed: true, submit: true, questionAnswer: true } }]);
  assert.equal(restored.list().length, 0);
  await restored.close();
  assert.equal((await new Questions(root).init()).list().length, 0);
});
