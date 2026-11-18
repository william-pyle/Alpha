// Launch only an isolated Codex startup screen. Never answer trust or send work.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Sessions } from '../sessions.mjs';
const repo = await mkdtemp(path.join(os.tmpdir(), 'alpha-trust-prompt-'));
await mkdir('.test-output', { recursive: true });
const out = await mkdtemp(path.resolve('.test-output/trust-prompt-'));
const sessions = await new Sessions(repo, path.join(repo, '.alpha')).init();
try {
  const session = await sessions.create({ agent: 'codex', name: 'Isolated trust prompt', cwd: repo, projectId: 'fixture', bypass: false });
  let screen;
  const end = Date.now() + 15000;
  do { await new Promise(resolve => setTimeout(resolve, 250)); screen = await sessions.read(session.id); } while (!/(?:yes,|no,|enter to confirm)/i.test(screen.screen) && Date.now() < end);
  const promptLines = screen.screen.split('\n').filter(line => /do you trust|trust (?:this|the)|enter to confirm|yes,|no,|project you created/i.test(line)).map(line => line.trim());
  const result = { observedAt: new Date().toISOString(), promptLines, activity: screen.activity, attention: screen.attention, scope: 'New isolated native CLI startup only; no trust answer or task was sent; no existing Alpha session changed.' };
  await writeFile(path.join(out, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify({ out, ...result }, null, 2));
  if (promptLines.length) { assert.equal(screen.activity, 'waiting'); assert.equal(screen.attention, true); }
  else throw new Error('No real trust prompt was observed; do not claim native prompt verification.');
} finally { await sessions.close(); }
