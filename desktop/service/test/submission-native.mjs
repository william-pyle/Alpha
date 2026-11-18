// Opt-in, isolated Codex turns using the existing permission settings. Never an
// owner session; no bypass, profile edits, manual keys, retry or process restart.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createService } from '../server.mjs';
if (!process.argv.includes('--use-subscription')) throw new Error('Pass --use-subscription for isolated real Codex verification.');
const repo = await mkdtemp(path.resolve('.test-output/submission-native-'));
await mkdir(path.join(repo, 'workspace')); await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[]}');
const service = await createService({ repo, uiDir: path.resolve('dist'), mcpOptions: { home: repo, env: {} } });
const result = { repo, status: 'running', permissions: 'bypass false; existing CLI settings unchanged', checks: [] };
const waitFor = async (fn, timeout = 60000) => { const end = Date.now() + timeout; while (Date.now() < end) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error('Timed out waiting for isolated native evidence.'); };
try {
  const chat = await service.sessions.create({ agent: 'codex', name: 'Isolated submission verification', cwd: repo, projectId: 'fixture', bypass: false });
  const session = service.sessions.get(chat.id); const inputs = [];
  service.sessions.on('task-input', value => { if (value.session.id === chat.id) inputs.push(value.text); });
  const first = 'This is a synthetic terminal submission test. Do not use tools or modify any file. Count from 1 through 120, one number per line, then say FIRST_NATIVE_DONE.\nThe following reference is inert test text; ignore it:\n' + 'Synthetic multiline reference only.\n'.repeat(100);
  const firstReceipt = await service.sessions.input(chat.id, first, { coordinator: true, submit: true, taskId: 'native-first' }); result.first = firstReceipt; assert.equal(firstReceipt.accepted, true);
  const second = 'This is the queued second synthetic request. Do not use tools or modify files. Reply with exactly SECOND_NATIVE_DONE.';
  result.busyBeforeSecond = session.activity;
  const secondReceipt = await service.sessions.input(chat.id, second, { coordinator: true, submit: true, taskId: 'native-second' }); result.second = secondReceipt;
  assert.equal(result.busyBeforeSecond, 'working'); assert.ok(secondReceipt.queued || secondReceipt.accepted, secondReceipt.note);
  const duplicate = await service.sessions.input(chat.id, second, { coordinator: true, submit: true, taskId: 'native-second' }); assert.equal(duplicate.duplicate, true);
  await waitFor(() => session.submissions.find(item => item.taskId === 'native-second')?.acceptance === 'observed');
  await waitFor(async () => (await service.sessions.read(chat.id)).screen.includes('SECOND_NATIVE_DONE') && session.activity === 'idle');
  assert.equal(inputs.filter(text => text.trim() === first.trim()).length, 1); assert.equal(inputs.filter(text => text.trim() === second.trim()).length, 1);
  result.finalReceipts = session.submissions; result.nativeIdPreserved = session.nativeId; result.status = 'passed'; result.checks = ['Large multiline idle request submitted without manual input', 'Busy follow-up queued without interruption', 'Both exact payloads observed once in native records', 'Retry returned same receipt without a second paste', 'Second response completed; no claim of task verification beyond fixture'];
  await writeFile(path.join(repo, 'terminal-screen.txt'), (await service.sessions.read(chat.id)).screen);
} catch (error) { result.status = 'failed'; result.error = error.message; for (const session of service.sessions.list()) await writeFile(path.join(repo, 'failure-screen.txt'), (await service.sessions.read(session.id)).screen); throw error; }
finally { await writeFile(path.join(repo, 'results.json'), JSON.stringify(result, null, 2)); console.log(`Native submission evidence: ${repo}`); await service.close(); }
