import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createService } from '../server.mjs';
import { Dictation } from '../dictation.mjs';

test('upgrade preserves effective dictation provider and model, fresh setups stay local across restarts', async () => {
  const cases = [
    { saved: {}, env: { OPENAI_API_KEY: 'test-key', ALPHA_TRANSCRIBE_MODEL: 'chosen-model' }, provider: 'openai', model: 'chosen-model' },
    { saved: {}, env: { OPENAI_API_KEY: 'test-key', OPENROUTER_API_KEY: 'test-router' }, provider: 'openrouter' },
    { saved: {}, env: { OPENAI_API_KEY: 'test-key', ALPHA_TRANSCRIBE_PROVIDER: 'off' }, provider: 'off' },
    { saved: { transcribeProvider: 'local' }, env: { OPENAI_API_KEY: 'test-key', ALPHA_TRANSCRIBE_PROVIDER: 'openai' }, provider: 'local' },
    { saved: {}, env: {}, provider: 'off' },
    { env: { OPENAI_API_KEY: 'test-key', OPENROUTER_API_KEY: 'test-router' }, provider: 'local' },
    { env: { ALPHA_TRANSCRIBE_PROVIDER: 'openai', OPENAI_API_KEY: 'test-key' }, provider: 'openai' },
  ];
  for (const fixture of cases) {
    const repo = await mkdtemp(path.join(os.tmpdir(), 'alpha-dictation-upgrade-'));
    await mkdir(path.join(repo, 'workspace')); await mkdir(path.join(repo, 'ui')); await mkdir(path.join(repo, '.alpha'));
    await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[]}');
    if (fixture.saved) await writeFile(path.join(repo, '.alpha/settings.json'), JSON.stringify({ terminalAppearance: 'focus', ...fixture.saved }));
    let calls = 0;
    for (let restart = 0; restart < 2; restart++) {
      const dictation = new Dictation(repo, { env: fixture.env, localStatus: async () => false, fetcher: () => { calls++; throw Error('No automatic cloud fallback'); } });
      const service = await createService({ repo, uiDir: path.join(repo, 'ui'), mcpOptions: { home: repo, env: {} }, dictationOptions: { dictation } });
      try {
        const info = await dictation.config();
        assert.equal(info.provider, fixture.provider);
        if (fixture.model) assert.equal(info.model, fixture.model);
        if (fixture.provider === 'local') assert.equal((await dictation.status()).available, false);
        const saved = JSON.parse(await readFile(path.join(repo, '.alpha/settings.json')));
        assert.equal(saved.transcribeProvider, fixture.provider);
        if (fixture.saved) assert.equal(saved.terminalAppearance, 'focus');
      } finally { await service.close(); }
    }
    assert.equal(calls, 0);
  }
});

test('desktop persists dictation choice, rejects untrusted changes and exposes no keys', async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'alpha-dictation-settings-'));
  await mkdir(path.join(repo, 'workspace')); await mkdir(path.join(repo, 'ui'));
  await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[]}');
  const options = () => ({ repo, uiDir: path.join(repo, 'ui'), mcpOptions: { home: repo, env: {} }, dictationOptions: {
    dictation: new Dictation(repo, { env: { OPENAI_API_KEY: 'private-test-key', OPENROUTER_API_KEY: 'private-router-key' }, localStatus: async () => true }),
    transport: { probe: async () => ({ ready: true }), enable: async origin => ({ origin }), disable: async () => {} },
  } });
  let service = await createService(options());
  const desktop = (provider) => fetch(service.origin + '/api/dictation', { method: provider ? 'POST' : 'GET', headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' }, body: provider ? JSON.stringify({ provider }) : undefined });
  try {
    assert.equal((await (await desktop()).json()).provider, 'local');
    assert.equal((await desktop('invalid')).status, 400);
    await desktop('openai');
    const info = await (await desktop()).json();
    assert.equal(info.provider, 'openai'); assert.equal(info.providers.length, 4);
    assert.ok(!JSON.stringify(info).includes('private-test-key'));
    assert.equal((await fetch(service.origin + '/api/dictation', { method: 'POST', body: '{}' })).status, 401);
    await desktop('openrouter'); assert.equal((await (await desktop()).json()).provider, 'openrouter');
    await desktop('off'); assert.equal((await (await desktop()).json()).available, false);
    await service.close(); service = await createService(options());
    assert.equal((await (await desktop()).json()).provider, 'off');
    await desktop('local'); assert.equal((await (await desktop()).json()).available, true);
  } finally { await service.close(); }
});
