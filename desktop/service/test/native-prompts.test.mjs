import test from 'node:test';
import assert from 'node:assert/strict';
import { NativePrompts, nativePrompt } from '../native-prompts.mjs';
import { submissionComposer } from '../terminal-submission.mjs';
import { insideWindowsRoot, codexTrustScope } from '../provider-trust.mjs';
import { Questions } from '../questions.mjs';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const trust = ['Trust this folder? Codex can read, edit, and run files here.', 'C:\\Projects\\Alpha', '› 1. Trust and continue', '  2. Quit', 'enter continue · esc quit'];
export const update = ['Update available · 0.169.0 → 0.169.1', 'Release notes: https://github.com/openai/codex/releases/latest', '› 1. Update now (runs `npm install -g @openai/codex`)', '  2. Skip', '  3. Skip until next version', 'enter continue · esc skip'];
const ready = { lines: ['OpenAI Codex', '› ', '? for shortcuts'], cursorX: 2, cursorY: 1, bracketedPaste: true, startupSettled: true };
function fixture(lines = trust) {
  let time = 1; const writes = [], session = { id: 'chat-a', nativeId: 'native-a', alphaThreadId: 'thread-a', agent: 'codex', status: 'running' };
  let view = { lines }, onWait = () => {}, onWrite = () => {};
  session.process = { write: key => { writes.push(key); onWrite(key); } };
  const bridge = new NativePrompts({ view: async () => view, ready: (s, v) => ['idle', 'busy'].includes(submissionComposer(s.agent, v).state), clock: () => time, wait: async ms => { time += ms; onWait(); }, timeout: 700 });
  const state = bridge.observe(session, view), binding = bridge.binding(state), receipt = {};
  return { session, bridge, binding, receipt, writes, set: value => { view = value; bridge.observe(session, view); }, onWait: fn => { onWait = fn; }, onWrite: fn => { onWrite = fn; }, answer: (label, options) => bridge.answer(session, binding, label, receipt, async () => {}, options) };
}

test('recognizes only complete native menus; update Skip is distinct from security', () => {
  assert.equal(nativePrompt('codex', { lines: update }).kind, 'update');
  assert.equal(nativePrompt('codex', { lines: trust }).kind, 'trust');
  for (const lines of [update.concat('Permission required'), update.slice(0, 4), trust.concat('Password:'), ['PS C:\\>', ...update.slice(2)], update.map(x => x.replace('›', ' '))]) assert.equal(nativePrompt('codex', { lines }), null);
  assert.equal(nativePrompt('claude', { lines: update }), null);
  assert.equal(submissionComposer('codex', { ...ready, lines: update }).state, 'blocked');
});

test('trust delivers exact selection and confirmation only, verifies transition, suppresses duplicates', async () => {
  const f = fixture(); f.onWrite(key => { if (key === '\r') f.set(ready); });
  assert.equal((await f.answer('Trust and continue')).accepted, true);
  assert.deepEqual(f.writes, ['1', '\r']); assert.ok(f.receipt.acceptedAt);
  await assert.rejects(f.answer('Trust and continue')); assert.equal(f.writes.length, 2);
});

test('update skip uses one key with no Enter, never installs or answers security automatically', async () => {
  const f = fixture(update); f.onWrite(() => f.set({ lines: trust }));
  assert.equal((await f.answer('Skip', { automatic: true })).accepted, true); assert.deepEqual(f.writes, ['2']);
  await assert.rejects(fixture().answer('Trust and continue', { automatic: true }), /Only an optional/);
  await assert.rejects(fixture(update).answer('Update now (runs `npm install -g @openai/codex`)'), /deferred/);
});

test('stale generation, changed disclosure, exact session/native/thread/process isolation, and manual interference', async () => {
  for (const mutate of [f => f.set({ lines: trust.map(x => x.replace('Alpha', 'Different')) }), f => { f.session.nativeId = 'native-b'; }, f => { f.session.alphaThreadId = 'thread-b'; }, f => { f.session.id = 'chat-b'; }, f => { f.session.process = { write() { assert.fail('wrong process'); } }; }, f => { f.set({ lines: [] }); f.set({ lines: trust }); }]) {
    const f = fixture(); mutate(f); await assert.rejects(f.answer('Trust and continue'), /changed/); assert.deepEqual(f.writes, []);
  }
  const f = fixture(); f.onWait(() => { f.session.manualInputRevision = 1; });
  await assert.rejects(f.answer('Trust and continue'), /changed/); assert.deepEqual(f.writes, []);
});

test('never confirms a changed prompt; blank redraw and timeouts do not resolve or replay', async () => {
  const f = fixture(); f.onWrite(() => f.set({ lines: update }));
  await assert.rejects(f.answer('Trust and continue'), /changed before confirmation/); assert.deepEqual(f.writes, ['1']);
  const uncertain = fixture(update); uncertain.onWrite(() => uncertain.set({ lines: [] }));
  await assert.rejects(uncertain.answer('Skip'), /not verified/); assert.equal(uncertain.receipt.acceptedAt, undefined);
  uncertain.set({ lines: update }); await assert.rejects(uncertain.answer('Skip')); assert.deepEqual(uncertain.writes, ['2']);
});

test('structured native question needs matching source, complete actual options and safe focus hints', () => {
  const view = { lines: ['Which color should I use?', '› 1. Blue', '  2. Green', 'tab to add notes · enter to submit answer'], questions: { id: 'call-1', tool: 'request_user_input', items: [{ text: 'Which color should I use?', options: ['Blue', 'Green'] }] } };
  assert.equal(nativePrompt('codex', view).kind, 'question');
  assert.equal(nativePrompt('codex', { lines: view.lines }), null);
  assert.equal(nativePrompt('codex', { ...view, lines: view.lines.map(x => x.replace('add notes', 'clear notes')) }), null);
});

test('Codex folder trust classifies canonical scope for manual review', async () => {
  const root = 'C:/Projects';
  const canonical = async value => value;
  assert.equal(insideWindowsRoot(root, 'c:\\PROJECTS\\NewName'), true);
  for (const candidate of ['C:/Projects2/X', 'C:/Projects/../Other', 'D:/Projects/X', '\\\\server\\Projects\\X', 'relative', root]) {
    assert.equal(await codexTrustScope(candidate, root, canonical), 'outside');
  }
  assert.equal(await codexTrustScope('C:/Projects/NewName', root, canonical), 'in-scope');
  assert.equal(await codexTrustScope('C:/Projects/Link', root, async value => value.endsWith('Link') ? 'D:/Private' : value), 'unverified');
  assert.equal(await codexTrustScope('C:/Projects/Link', root, async () => 'C:/Projects/Alias'), 'unverified');
  assert.equal(await codexTrustScope('C:/Projects/Missing', root, async () => { throw new Error('ENOENT'); }), 'unverified');
});

test('native Questions persist acceptance, share identical concurrent answers and reject conflicting ones', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'alpha-native-q-'));
  const questions = await new Questions(root).init(), f = fixture();
  const q = await questions.captureNative(f.session, f.bridge.states.get(f.session.id), f.binding);
  const sessions = { get: () => f.session, answerNative: (item, answer, persist) => f.bridge.answer(f.session, item.nativePrompt, answer, item.receipt ||= {}, persist) };
  f.onWrite(key => { if (key === '\r') f.set(ready); });
  const first = questions.answer(q.id, 'Trust and continue', sessions);
  await assert.rejects(questions.answer(q.id, 'Quit', sessions), /different answer/);
  await Promise.all([first, questions.answer(q.id, 'Trust and continue', sessions)]);
  assert.deepEqual(f.writes, ['1', '\r']); assert.equal(questions.list().length, 0);
  const restored = await new Questions(root).init();
  assert.equal((await restored.answer(q.id, 'Trust and continue', sessions)).alreadyAccepted, true);
  assert.deepEqual(f.writes, ['1', '\r']); await questions.close(); await restored.close();
});

test('uncertain delivery remains pending and a restored identical prompt never replays it', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'alpha-native-uncertain-'));
  const questions = await new Questions(root).init(), f = fixture(update);
  const q = await questions.captureNative(f.session, f.bridge.states.get(f.session.id), f.binding);
  const sessions = { get: () => f.session, answerNative: (item, answer, persist) => f.bridge.answer(f.session, item.nativePrompt, answer, item.receipt ||= {}, persist) };
  await assert.rejects(questions.answer(q.id, 'Skip', sessions), /not verified/); assert.equal(questions.list().length, 1);
  await questions.close(); const restored = await new Questions(root).init();
  f.set({ lines: [] }); f.set({ lines: update }); const state = f.bridge.states.get(f.session.id);
  const current = await restored.captureNative(f.session, state, f.bridge.binding(state));
  await assert.rejects(restored.answer(current.id, 'Skip', sessions), /already attempted/); assert.deepEqual(f.writes, ['2']); await restored.close();
});
