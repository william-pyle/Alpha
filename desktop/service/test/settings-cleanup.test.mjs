import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createService } from '../server.mjs';
import { Dictation } from '../dictation.mjs';
import { LocalWhisperControl } from '../local-whisper-control.mjs';
import voiceOptions from '../voice-options.json' with { type: 'json' };

test('theme editing and Live voices persist through authenticated settings', async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'alpha-settings-cleanup-'));
  await mkdir(path.join(repo, 'workspace')); await mkdir(path.join(repo, 'ui'));
  await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[]}');
  const service = await createService({ repo, uiDir: path.join(repo, 'ui'), mcpOptions: { home: repo, env: {} } });
  const call = async (route, data) => {
    const response = await fetch(service.origin + '/api' + route, { method: 'POST', headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    return { status: response.status, value: await response.json() };
  };
  try {
    assert.equal(voiceOptions.length, 38);
    assert.equal((await call('/settings', { voiceName: 'willow' })).value.voiceName, 'willow');
    assert.equal((await call('/settings', { voiceName: 'not-a-voice' })).value.voiceName, 'willow');
    const theme = { label: 'Evening', controller: 'Alpha', icon: '/art/alpha.png', backdrop: '', background: '#101820', foreground: '#f0e8dd', accent: '#dc9c65' };
    const created = await call('/themes', { ...theme, action: 'create' });
    assert.equal(created.status, 200); assert.match(created.value.appTheme, /^custom-/);
    const id = created.value.appTheme;
    assert.equal(created.value.themeProfiles.find(item => item.id === id).label, 'Evening');
    assert.equal((await call('/themes', { ...theme, icon: 'https://example.com/tracker.png', action: 'save', id })).status, 400);
    assert.equal((await call('/themes', { ...theme, label: 'Evening blue', action: 'save', id })).value.themeProfiles.find(item => item.id === id).label, 'Evening blue');
    assert.equal((await call('/themes', { ...theme, action: 'save', id: 'smurfs' })).status, 200);
    assert.equal((await call('/themes', { action: 'reset', id: 'smurfs' })).value.themeProfiles.some(item => item.id === 'smurfs'), false);
    const removed = await call('/themes', { action: 'delete', id });
    assert.equal(removed.value.appTheme, 'alpha');
    assert.equal(removed.value.themeProfiles.length, 0);
    assert.equal((await call('/settings', { themeProfiles: [{ id: '__proto__' }], appTheme: '__proto__' })).value.appTheme, 'alpha');
  } finally { await service.close(); }
});

test('warm Whisper worker starts, transcribes and stops without a real model', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'alpha-whisper-worker-'));
  const fake = path.join(root, 'worker.cjs');
  await writeFile(fake, `process.stdout.write('{"ready":true}\\n');let buffer='';process.stdin.on('data',chunk=>{buffer+=chunk;while(buffer.includes('\\n')){const index=buffer.indexOf('\\n');const line=buffer.slice(0,index);buffer=buffer.slice(index+1);if(line)process.stdout.write(JSON.stringify({text:'warm transcription'})+'\\n')}});`);
  const control = new LocalWhisperControl({ spawnProcess: (_program, _args, options) => spawn(process.execPath, [fake], options) });
  try {
    await control.start({ python: 'unused', model: 'unused' });
    assert.equal(control.state(true).running, true);
    assert.deepEqual(await control.transcribe(Buffer.from('sample'), 'wav', new AbortController().signal), { text: 'warm transcription' });
    await control.stop(); assert.equal(control.state(true).running, false);
  } finally { control.close(); }
});

test('Local Whisper install launches the packaged setup script only on request', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'alpha-whisper-install-'));
  const setupScript = path.join(root, 'setup-local-whisper.ps1');
  await writeFile(setupScript, 'exit 0');
  let launched;
  const child = new EventEmitter();
  const control = new LocalWhisperControl({ setupScript, spawnProcess: (program, args, options) => { launched = { program, args, options }; return child; } });
  assert.equal(launched, undefined);
  control.install();
  assert.equal(launched.program, 'powershell.exe');
  assert.deepEqual(launched.args.slice(-2), ['-File', setupScript]);
  assert.equal(launched.options.windowsHide, true);
  assert.equal(control.state(false).installing, true);
  child.emit('exit', 0);
  assert.equal(control.state(true).installing, false);
});

test('Local Whisper controls require the selected provider and report installed and running separately', async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'alpha-whisper-actions-'));
  let installed = false, running = false;
  const control = {
    state: value => ({ installed: value, running, installing: false, starting: false }),
    install: () => { installed = true; }, start: async () => { running = true; }, stop: async () => { running = false; }, close: () => {},
  };
  const dictation = new Dictation(repo, { localStatus: async () => installed, localControl: control });
  await mkdir(path.join(repo, 'workspace')); await mkdir(path.join(repo, 'ui'));
  await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[]}');
  const service = await createService({ repo, uiDir: path.join(repo, 'ui'), dictationOptions: { dictation }, mcpOptions: { home: repo, env: {} } });
  const post = async route => {
    const response = await fetch(service.origin + '/api' + route, { method: 'POST', headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' }, body: '{}' });
    return { status: response.status, value: await response.json() };
  };
  try {
    assert.equal((await post('/dictation/local/start')).status, 400);
    assert.equal((await post('/dictation/local/install')).value.local.installed, true);
    assert.equal((await post('/dictation/local/start')).value.local.running, true);
    const switched = await fetch(service.origin + '/api/dictation', { method: 'POST', headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'off' }) });
    assert.equal((await switched.json()).local.running, false);
    const restored = await fetch(service.origin + '/api/dictation', { method: 'POST', headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'local' }) });
    assert.equal((await restored.json()).provider, 'local');
    assert.equal((await post('/dictation/local/start')).value.local.running, true);
    assert.equal((await post('/dictation/local/stop')).value.local.running, false);
    const response = await fetch(service.origin + '/api/dictation/local/start', { method: 'POST', body: '{}' });
    assert.equal(response.status, 401);
  } finally { await service.close(); }
});
