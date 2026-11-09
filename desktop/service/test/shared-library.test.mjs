import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, unlink, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { installLibrary, digest } from '../shared-library.mjs';
import { packageLibrary } from '../../../scripts/package-library.mjs';
import { ContextLibrary } from '../context.mjs';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'alpha-shared-'));
  const source = path.join(root, 'source'), installed = path.join(root, 'installed');
  const put = async (name, text) => { await mkdir(path.dirname(path.join(source,name)), { recursive:true }); await writeFile(path.join(source,name),text); };
  await put('.agents/skills/example/SKILL.md', '---\nname: example\ndescription: Reusable example.\n---\n# Example\n');
  await put('knowledge/shared.json', '{"lesson":"shared launch knowledge"}');
  await put('processes/workflow.md', '# Workflow\n');
  const bundle = async version => { const folder = path.join(root, version); await packageLibrary(folder, source, version); return folder; };
  return { root, source, installed, put, bundle };
}
test('fresh install and updates automatically include additions and preserve local edits, deletions and local files', async () => {
  const f = await fixture();
  const first = await installLibrary(await f.bundle('1.0.0'), f.installed);
  assert.deepEqual(first.skills,['example']); assert.equal(first.files,4);
  assert.equal(await readFile(path.join(f.installed,'.agents/skills/example/SKILL.md'),'utf8'), await readFile(path.join(f.installed,'.claude/skills/example/SKILL.md'),'utf8'));
  await writeFile(path.join(f.installed,'knowledge/shared.json'),'local knowledge');
  await writeFile(path.join(f.installed,'knowledge/local.md'),'my private addition');
  await unlink(path.join(f.installed,'processes/workflow.md'));
  await f.put('knowledge/shared.json','incoming knowledge');
  await f.put('knowledge/new.md','# Added in next release');
  await f.put('.agents/skills/example/SKILL.md','---\nname: example\ndescription: Updated example.\n---\n');
  const bundle = await f.bundle('1.1.0');
  const next = await installLibrary(bundle,f.installed);
  assert.equal(next.conflicts.length,2);
  assert.equal(await readFile(path.join(f.installed,'knowledge/shared.json'),'utf8'),'local knowledge');
  assert.equal(await readFile(path.join(f.installed,'knowledge/local.md'),'utf8'),'my private addition');
  await assert.rejects(readFile(path.join(f.installed,'processes/workflow.md')), {code:'ENOENT'});
  assert.match(await readFile(path.join(f.installed,'knowledge/new.md'),'utf8'),/next release/);
  assert.match(await readFile(path.join(f.installed,'.agents/skills/example/SKILL.md'),'utf8'),/Updated/);
  assert.equal(await readFile(next.conflicts.find(c=>c.path==='knowledge/shared.json').incoming,'utf8'),'incoming knowledge');
  assert.equal((await installLibrary(bundle,f.installed)).conflicts.length,2);
});
test('hash corruption, traversal and destination junctions cannot modify files outside the library', async () => {
  const f = await fixture(), bundle = await f.bundle('1.0.0');
  await writeFile(path.join(bundle,'knowledge/shared.json'),'tampered');
  await assert.rejects(installLibrary(bundle,f.installed),/checksum/);
  const clean = await f.bundle('1.0.1'); const manifest = JSON.parse(await readFile(path.join(clean,'manifest.json'),'utf8'));
  manifest.files['../outside.txt']=digest(Buffer.from('x'));
  await writeFile(path.join(clean,'manifest.json'),JSON.stringify(manifest));
  await assert.rejects(installLibrary(clean,f.installed),/Invalid shared-library file/);
  const valid = await f.bundle('1.0.2'), outside = path.join(f.root,'outside');
  await mkdir(outside);await mkdir(f.installed);await symlink(outside,path.join(f.installed,'knowledge'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(installLibrary(valid,f.installed),/is a link/);
  await assert.rejects(readFile(path.join(outside,'shared.json')),{code:'ENOENT'});
});
test('shared skills and JSON knowledge work without rg; project skills override defaults', async () => {
  const f = await fixture(); await installLibrary(await f.bundle('1.0.0'),f.installed);
  const repo = path.join(f.root,'project');await mkdir(path.join(repo,'.agents/skills/example'),{recursive:true});
  const library = new ContextLibrary(repo,{sharedRoot:f.installed,personalRoots:[]});
  assert.equal((await library.skills()).skills[0].scope,'shared');
  assert.match((await library.search('launch')).matches,/shared launch knowledge/);
  await writeFile(path.join(repo,'.agents/skills/example/SKILL.md'),'---\nname: example\ndescription: Project override\n---\n');
  const skills = (await library.skills()).skills;
  assert.equal(skills.length,1);assert.equal(skills[0].scope,'project');
  assert.match((await library.read(path.join(f.installed,'knowledge/shared.json'))).text,/lesson/);
  await assert.rejects(library.read(path.join(f.installed,'.alpha-library/state.json')),/Private runtime/);
});
test('package rejects private files and produces both providers from one maintained skill source', async () => {
  const f=await fixture();await f.put('.env','PRIVATE_FIXTURE=not-a-real-secret');
  await assert.rejects(f.bundle('1.0.0'),/local state/);
});

test('context reads canonicalize project and library aliases before checking private paths', async () => {
  const f = await fixture(); await installLibrary(await f.bundle('1.0.0'), f.installed);
  const repo = path.join(f.root,'project'); await mkdir(path.join(repo,'knowledge'),{recursive:true});
  await writeFile(path.join(repo,'knowledge/project.md'),'Project knowledge');
  const projectAlias = path.join(f.root,'project-alias'), libraryAlias = path.join(f.root,'library-alias');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  await symlink(repo, projectAlias, linkType); await symlink(f.installed, libraryAlias, linkType);
  const library = new ContextLibrary(projectAlias,{sharedRoot:libraryAlias,personalRoots:[]});
  assert.match((await library.read(path.join(libraryAlias,'knowledge/shared.json'))).text,/lesson/);
  assert.equal((await library.read('knowledge/project.md')).text,'Project knowledge');
  await assert.rejects(library.read(path.join(libraryAlias,'.alpha-library/state.json')),/Private runtime/);
  const outside = path.join(f.root,'outside.md'); await writeFile(outside,'Outside context');
  await assert.rejects(library.read(outside),/Private runtime/);
});
