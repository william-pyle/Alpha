import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { RestartNotes } from '../restart-notes.mjs';
import { terminalCommand } from '../agents.mjs';

test('restart note resumes the exact conversation once and requires observed continuation', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'alpha-restart-'));
  const notes = await new RestartNotes(stateDir).init();
  const session = { id: 'managed', nativeId: 'native-one', name: 'Alpha', agent: 'codex' };
  const item = await notes.prepare(session, 'Read the saved checkpoint and continue the remaining authorized task.');
  await notes.observe(session, { kind: 'turn-completed' }); assert.equal(item.status, 'prepared');
  const restarted = await new RestartNotes(stateDir).init();
  assert.equal(await restarted.claim(session, 'different-native'), undefined);
  const prompt = await restarted.claim(session, 'native-one');
  assert.ok(prompt.includes(item.note)); assert.equal(restarted.items[0].status, 'dispatched');
  assert.equal(await restarted.claim(session, 'native-one'), undefined);
  await restarted.observe(session, { kind: 'turn-completed' }); assert.equal(restarted.items[0].status, 'dispatched');
  await restarted.observe(session, { kind: 'task-input', text: prompt }); assert.equal(restarted.items[0].status, 'resumed');
  await restarted.observe(session, { kind: 'turn-completed' }); assert.equal(restarted.items[0].status, 'completed');
  assert.equal((await new RestartNotes(stateDir).init()).items[0].status, 'completed');
});

test('expired, cancelled and uncertain launch notes do not automatically retry', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'alpha-restart-errors-'));
  const notes = await new RestartNotes(stateDir).init(), session = { id: 'managed', nativeId: 'native-one', name: 'Alpha', agent: 'codex' };
  await assert.rejects(notes.prepare({ ...session, agent: 'shell' }, 'Continue the original authorized task.'), /Codex/);
  let item = await notes.prepare(session, 'Continue the original authorized task.'); await notes.cancel(item.id);
  assert.equal(await notes.claim(session, session.nativeId), undefined);
  item = await notes.prepare(session, 'Continue the original authorized task.'); item.createdAt = '2020-01-01T00:00:00Z';
  assert.equal(await notes.claim(session, session.nativeId), undefined); assert.equal(item.status, 'expired');
  item = await notes.prepare(session, 'Continue the original authorized task.'); await notes.claim(session, session.nativeId);
  await notes.failed(session, new Error('CLI is not available')); assert.equal(item.status, 'failed');
  assert.equal(await notes.claim(session, session.nativeId), undefined);
});

test('restart prompts cannot become CLI options or execute in a shell', async () => {
  assert.throws(() => terminalCommand('shell', { initialPrompt: 'echo unexpected' }), /saved Codex/);
  assert.throws(() => terminalCommand('codex', { initialPrompt: 'continue' }), /saved Codex/);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'alpha-restart-cli-'));
  await writeFile(path.join(directory, process.platform === 'win32' ? 'codex.cmd' : 'codex'), '', { mode: 0o755 });
  const previous = process.env.PATH; process.env.PATH = directory + path.delimiter + previous;
  try {
    const command = terminalCommand('codex', { resumeId: 'native-one', initialPrompt: '--dangerously-bypass-approvals-and-sandbox' });
    const encoded = command.args.indexOf('-EncodedCommand');
    const representation = encoded >= 0 ? Buffer.from(command.args[encoded + 1], 'base64').toString('utf16le') : command.args.join(' ');
    assert.match(representation, /--[' ]+[' ]*--dangerously-bypass/);
  } finally { process.env.PATH = previous; }
});
