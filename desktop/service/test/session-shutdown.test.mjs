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
    import pty from './desktop/service/node_modules/node-pty/lib/index.js';
    const repo = await mkdtemp(path.join(os.tmpdir(), 'alpha-shutdown-'));
    const sessions = await new Sessions(repo, path.join(repo, 'state')).init();
    const ids = [], nativeKills = new Map();
    const spawn = pty.spawn;
    pty.spawn = (...args) => {
      const proc = spawn(...args), agent = proc._agent;
      const kill = agent.kill.bind(agent);
      nativeKills.set(agent, 0);
      agent.kill = () => {
        const count = nativeKills.get(agent) + 1;
        nativeKills.set(agent, count);
        // Measure entry to the native kill path without allowing a duplicate
        // close to corrupt the fixture heap before the assertion can run.
        if (count === 1) return kill();
      };
      return proc;
    };
    for (let i = 0; i < 6; i++) {
      const session = await sessions.create({agent: 'shell', name: 'Shutdown fixture', projectId: 'alpha'});
      ids.push(session.id);
    }
    await sessions.close();
    const saved = JSON.parse(await readFile(path.join(repo, 'state/sessions.json'), 'utf8'));
    assert.deepEqual(saved.map(s => s.id), ids);
    assert.ok(saved.every(s => s.open && s.projectId === 'alpha'));
    assert.equal(nativeKills.size, ids.length);
    assert.deepEqual([...nativeKills.values()], ids.map(() => 1), 'Each native pseudo-console must be closed at most once, including onExit cleanup');
    console.log('shutdown complete');
  `;
  // A forced process.exit would hide leaked ConPTY workers. The child must
  // exit on its own after shutdown, including when closed before its prompt.
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', source], { timeout: 20000, windowsHide: true });
  assert.match(stdout, /shutdown complete/);
});
