import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createService } from '../server.mjs';
import { spokenReply } from '../speech.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
test('spoken replies omit code and preserve prose', () => {
  assert.equal(spokenReply('Hello [friend](https://example.com).\n```js\nsecret()\n```'), 'Hello friend. Code example is in the chat.');
  const longReply = 'Here is the explanation. '.repeat(150) + 'This final sentence must also be spoken.';
  assert.equal(spokenReply(longReply), longReply, 'Speech must not silently truncate a long final reply.');
});

test('Windows speech renders a real WAV and reply endpoints stay authenticated', { skip: process.platform !== 'win32', timeout: 20000 }, async () => {
  await mkdir(path.join(root, '.cache'), { recursive: true });
  const repo = await mkdtemp(path.join(root, '.cache', 'speech-test-'));
  await mkdir(path.join(repo, 'workspace'));
  await mkdir(path.join(repo, 'ui'));
  await writeFile(path.join(repo, 'workspace', 'workspace.json'), '{"entities":[]}');
  await writeFile(path.join(repo, 'ui', 'index.html'), '<html>Fixture</html>');
  const output = path.join(repo, 'spoken.wav');
  const script = path.join(root, 'desktop', 'service', 'speech.ps1');
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Output', output], { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  child.stdin.end('Hello, friend.', 'utf8');
  const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  assert.equal(code, 0, stderr);
  const wav = await readFile(output);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.ok(wav.length > 1000);
  const service = await createService({ repo, uiDir: path.join(repo, 'ui') });
  const call = (route, method = 'GET', body, extra = {}) => fetch(service.origin + '/api' + route, { method, headers: { Authorization: `Bearer ${service.token}`, Origin: service.origin, 'Content-Type': 'application/json', ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  try {
    assert.equal((await fetch(service.origin + '/api/speech/voices')).status, 401);
    assert.equal((await call('/speech/stop', 'POST', {}, { Origin: 'https://untrusted.example' })).status, 403);
    assert.equal((await call('/speech/speak', 'POST', { source: 'reply', id: 'missing' })).status, 404);
    const voices = await (await call('/speech/voices')).json();
    assert.ok(voices.voices.length > 0);
    const reply = service.replies.add({ id: 'sample:turn', sessionId: 'sample', name: 'Agent', text: 'Hello from the agent.' });
    assert.equal(reply.text, 'Hello from the agent.');
    const bootstrap = await (await call('/bootstrap')).json();
    assert.equal(bootstrap.replies[0].id, 'sample:turn');
    assert.equal(bootstrap.settings.speakReplies, true);
    const setting = await (await call('/settings', 'POST', { speakReplies: false, speechVoice: voices.voices[0], conversationStyle: 'Curious, clear and playful.' })).json();
    assert.equal(setting.speakReplies, false);
    assert.equal(setting.speechVoice, voices.voices[0]);
    assert.equal(setting.conversationStyle, 'Curious, clear and playful.');
  } finally { await service.close(); }
});
