import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Coordinator } from '../coordinator.mjs';
import { Sessions } from '../sessions.mjs';
import { startupPrompt } from '../prompt-state.mjs';

test('shutdown settles active and queued operations without a provider timeout or further execution', async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'alpha-shutdown-'));
  const coordinator = await new Coordinator({ repo, stateDir: repo, context: () => ({}) }).init();
  let started = 0;
  coordinator.start = async () => { coordinator.threadId = 'fixture'; started++; };
  coordinator.rpc = async () => ({ turn: { id: 'fixture-turn' } });
  const active = coordinator.ask({ id: 'active', text: 'Work' }), queued = coordinator.ask({ id: 'queued', text: 'More work' });
  for (let i = 0; !coordinator.active && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(coordinator.active);
  await coordinator.close();
  assert.equal((await active).status, 'failed'); assert.equal((await queued).status, 'failed'); assert.equal(started, 1);
  await assert.rejects(coordinator.ask({ id: 'late', text: 'Too late' }), /closing/);
});

test('phase timing, failures, waiting and incremental context remain isolated', async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'alpha-phases-'));
  const context = { recentConversation: [{ id: 'seed', text: 'private seed' }] };
  const coordinator = await new Coordinator({ repo, stateDir: repo, context: () => context, execute: async () => ({ id: 'question' }) }).init();
  const phases = [], inputs = [];
  coordinator.on('operation', event => phases.push(event.phase));
  coordinator.start = async () => { coordinator.threadId = 'fixture'; };
  coordinator.send = () => {};
  coordinator.rpc = async (method, params) => {
    inputs.push(params.input[0].text);
    await coordinator.message({ id: 77, method: 'item/tool/call', params: { tool: 'ask_user_question', arguments: { text: 'Which result?' }, callId: crypto.randomUUID() } });
    await coordinator.message({ method: 'item/agentMessage/delta', params: { threadId: 'fixture', delta: 'Please answer in Questions.' } });
    coordinator.active.resolve('Please answer in Questions.');
    return { turn: { id: 'turn' } };
  };
  const first = await coordinator.ask({ id: 'one', text: 'Ask me', threadId: 'a' });
  assert.equal(first.status, 'completed'); assert.equal(first.phase, 'waiting-for-user');
  assert.equal(first.timings.toolCalls, 1); assert.ok(first.timings.firstTextAt >= first.timings.submittedAt);
  assert.ok(phases.includes('tool') && phases.includes('provider'));
  await coordinator.ask({ id: 'two', text: 'Continue', threadId: 'a' });
  assert.ok(inputs[0].includes('private seed')); assert.ok(!inputs[1].includes('private seed'));
  context.recentConversation[0].text = 'corrected voice caption';
  await coordinator.ask({ id: 'updated', text: 'Use the correction', threadId: 'a' });
  assert.ok(inputs[2].includes('corrected voice caption'));
  coordinator.start = async () => { throw new Error('CLI unavailable'); };
  const failed = await coordinator.ask({ id: 'three', text: 'Try', threadId: 'a' });
  assert.equal(failed.phase, 'failed'); assert.equal(failed.status, 'failed'); assert.ok(failed.timings.completedAt);
  assert.equal(inputs.length, 3); coordinator.close();
});

test('folder trust is waiting, blocks composed tasks, and clears only when prompt disappears', async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'alpha-prompt-'));
  const sessions = await new Sessions(repo, repo).init();
  const session = sessions.make({ id: 'fixture', agent: 'codex', status: 'running', open: false, name: 'Trust prompt', cols: 100, rows: 24 });
  sessions.items.set(session.id, session);
  await sessions.hydrate(session);
  const writes = []; session.process = { write: value => writes.push(value) };
  const prompt = 'Do you trust the files in this directory?\r\n1. Yes, I trust this folder\r\n2. No, exit\r\nEnter to confirm';
  try {
    assert.equal(startupPrompt('Please investigate folder trust detection.'), null);
    assert.equal(startupPrompt('The prompt says "Do you trust this folder?" with Yes, I trust and No, exit.'), null);
    await new Promise(resolve => session.terminal.write(prompt, resolve)); sessions.detectPrompt(session);
    assert.equal(session.activity, 'waiting'); assert.equal(session.attention, true);
    assert.throws(() => sessions.input(session.id, 'do work', { composed: true }), /Folder trust/);
    assert.equal(writes.length, 0);
    await new Promise(resolve => session.terminal.write('\x1b[2J\x1b[HReady for a task', resolve)); sessions.detectPrompt(session);
    assert.equal(session.activity, 'idle'); assert.equal(session.attention, false);
  } finally { session.process = null; await sessions.close(); }
});

test('queued work is visible immediately, serialized and interrupted truthfully on reload', async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'alpha-queue-'));
  const coordinator = await new Coordinator({ repo, stateDir: repo, context: () => ({}) }).init();
  coordinator.start = async () => { coordinator.threadId = 'fixture'; };
  coordinator.rpc = async () => ({ turn: { id: 'fixture' } });
  const first = coordinator.ask({ id: 'one', text: 'First request' });
  while (!coordinator.active?.turnId) await new Promise(resolve => setTimeout(resolve, 5));
  const second = coordinator.ask({ id: 'two', text: 'Second request' });
  assert.equal(coordinator.operations.get('two').phase, 'queued');
  await coordinator.save();
  const restored = await new Coordinator({ repo, stateDir: repo, context: () => ({}) }).init();
  assert.equal(restored.operations.get('two').phase, 'interrupted');
  coordinator.active.resolve('First ready'); await first;
  while (coordinator.active?.operationId !== 'two' || !coordinator.active?.turnId) await new Promise(resolve => setTimeout(resolve, 5));
  coordinator.active.resolve('Second ready');
  const result = await second; assert.ok(result.timings.dequeuedAt >= result.timings.queuedAt);
  coordinator.close(); restored.close();
});
