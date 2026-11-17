import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('closing starting and quiet Windows terminals exits naturally and preserves their saved bindings', { skip: process.platform !== 'win32' }, async () => {
  const source = `
    import { Sessions } from './desktop/service/sessions.mjs';
    import { mkdtemp, readFile } from 'node:fs/promises';
    import os from 'node:os';
    import path from 'node:path';
    import assert from 'node:assert/strict';
    const repo = await mkdtemp(path.join(os.tmpdir(), 'alpha-shutdown-'));
    const sessions = await new Sessions(repo, path.join(repo, 'state')).init();
    const ids = [];
    for (let i = 0; i < 6; i++) ids.push((await sessions.create({agent: 'shell', name: 'Shutdown fixture', projectId: 'alpha'})).id);
    await sessions.close();
    const saved = JSON.parse(await readFile(path.join(repo, 'state/sessions.json'), 'utf8'));
    assert.deepEqual(saved.map(s => s.id), ids);
    assert.ok(saved.every(s => s.open && s.projectId === 'alpha'));
    console.log('shutdown complete');
  `;
  // A forced process.exit would hide leaked ConPTY workers. The child must
  // exit on its own after shutdown, including when closed before its prompt.
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', source], { timeout: 20000, windowsHide: true });
  assert.match(stdout, /shutdown complete/);
});
