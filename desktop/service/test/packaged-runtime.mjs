import { mkdtemp, mkdir, writeFile, access, readFile, realpath } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

const runtime = path.resolve(process.argv[2] || '.cache/desktop-runtime');
await mkdir('.test-output', { recursive: true });
const fixture = await realpath(await mkdtemp(path.resolve('.test-output/packaged-runtime-')));
const repo = path.join(fixture,'Workspace'), configDir = path.join(fixture,'config'), nextRepo = path.join(fixture,'Selected Workspace');
const resolve = () => {
  const result = spawnSync(path.join(runtime,'node.exe'),[path.join(runtime,'service/workspace-location.mjs'),'--config',configDir,'--default',repo,'--app-dir',runtime],{encoding:'utf8',windowsHide:true});
  assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout).root;
};
assert.equal(resolve(),repo);
for (const file of ['node.exe', 'service/main.mjs', 'service/default-categories.json', 'service/node_modules/node-pty/package.json', 'ui/index.html', 'ui/help.html', 'ui/art/alpha.png', 'ui/art/smurfs.png', 'ui/art/rena.png', 'NODE-LICENSE.txt']) await access(path.join(runtime, file));
const child = spawn(path.join(runtime, 'node.exe'), [path.join(runtime, 'service/main.mjs'), '--repo', repo, '--ui', path.join(runtime, 'ui'), '--library-root', path.join(fixture, 'SharedLibrary'), '--config',configDir], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ALPHA_TEST: '1' } });
let stderr = ''; child.stderr.on('data', data => { stderr += data; });
const exited = new Promise(resolve => child.once('exit', resolve));
const lines = createInterface({ input: child.stdout });
try {
  const ready = await Promise.race([
    new Promise((resolve, reject) => { child.once('error', reject); lines.on('line', line => { try { const value = JSON.parse(line); if (value.type === 'ready') resolve(value); } catch { /* Native messages only. */ } }); }),
    delay(30000, undefined, { ref: false }).then(() => { throw new Error('Packaged service did not start: ' + stderr); }),
  ]);
  const url = new URL(ready.chats);
  const token = url.searchParams.get('token');
  assert.ok(token, 'Startup URL includes its private service token');
  const call = async (route, data) => {
    const response = await fetch(url.origin + '/api' + route, { method: data === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
    assert.ok(response.ok, await response.clone().text()); return response.json();
  };
  assert.deepEqual((await call('/bootstrap')).agents.map(agent => agent.id), ['codex', 'claude', 'shell', 'gitbash']);
  const library = await call('/library');
  assert.equal(library.skills.length,20); assert.equal(library.conflicts.length,0);
  await access(path.join(library.root,'knowledge/voice-dictation.md'));
  await access(path.join(library.root,'.claude/skills/workspace-authoring/SKILL.md'));
  const card = await call('/workspace/cards', { title: 'Packaged editable card', template: 'research' });
  assert.equal((await call(`/workspace/cards/${card.entity.id}/0`)).document.format,'mrmak-card');
  assert.equal((await fetch(url.origin + '/mobile')).status, 404);
  for (const asset of ['/art/alpha.png', '/art/smurfs.png', '/art/rena.png', '/help.html']) assert.equal((await fetch(url.origin + asset)).status, 200);
  const help = await call('/help'); assert.ok(help.url, 'Packaged Help opens a preview');
  const session = await call('/sessions', { agent: 'shell', name: 'Packaged terminal check', cwd: repo });
  for (let attempt = 0; attempt < 60; attempt++) { if ((await call(`/sessions/${session.id}/screen`)).screen.includes('>')) break; await delay(250); }
  await call(`/sessions/${session.id}/input`, { text: "Write-Output ('PACKAGED_' + 'TERMINAL_OK')\r", paste: false });
  let output = '';
  for (let attempt = 0; attempt < 60; attempt++) { output = (await call(`/sessions/${session.id}/screen`)).screen; if (output.includes('PACKAGED_TERMINAL_OK')) break; await delay(250); }
  assert.ok(output.includes('PACKAGED_TERMINAL_OK'), 'Bundled Node loads the bundled native terminal and runs PowerShell: ' + output);
  assert.equal((await call('/workspace/location')).available,true);
  await call('/workspace/location/save',{path:nextRepo,mode:'copy'});
  assert.equal(JSON.parse(await readFile(path.join(configDir,'repository.json'),'utf8')),repo);
  await writeFile('.test-output/packaged-runtime-result.json', JSON.stringify({ passed: true, runtime, checks: ['Bundled Node', 'Production service', 'Native terminal dependency', 'Production UI and theme assets', 'Packaged Help', 'Phone routes removed', '20 installed shared skills and support files', 'Editable Research card creation and reading'] }, null, 2));
  console.log('Packaged runtime passed: bundled Node, UI, themes, Help, shared library, editable cards and real native terminal.');
} finally {
  child.stdin.end('quit\n');
  await Promise.race([exited, delay(10000, undefined, { ref: false })]);
  if (child.exitCode === null) child.kill();
  lines.close();
}
assert.equal(resolve(),nextRepo);
assert.deepEqual(JSON.parse(await readFile(path.join(nextRepo,'workspace/workspace.json'),'utf8')),JSON.parse(await readFile(path.join(repo,'workspace/workspace.json'),'utf8')));
assert.equal(JSON.parse(await readFile(path.join(nextRepo,'.alpha/sessions.json'),'utf8'))[0].cwd,nextRepo);
const result=JSON.parse(await readFile('.test-output/packaged-runtime-result.json','utf8'));
result.checks.push('Bundled startup selection and deferred Workspace copy preserve cards, history and original files');
await writeFile('.test-output/packaged-runtime-result.json',JSON.stringify(result,null,2));
console.log('Packaged Workspace location passed: selection, deferred copy, preserved cards/history and original files.');
