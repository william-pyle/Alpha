import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveWorkspace, WorkspaceLocation } from '../workspace-location.mjs';
import { readJson, saveJson } from '../util.mjs';
import { createService } from '../server.mjs';

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'alpha-location-')));
  const options = { configDir: path.join(root,'config'), defaultRoot: path.join(root,'Documents/Alpha'), legacyRoot: path.join(root,'config/Workspace') };
  return { root, options, current: () => readJson(path.join(options.configDir,'repository.json'),null), change: repo => new WorkspaceLocation({repo,configDir:options.configDir}) };
}
const put = async (root, file, text) => { await mkdir(path.dirname(path.join(root,file)),{recursive:true}); await writeFile(path.join(root,file),text); };

test('fresh setup uses Documents or the installer choice, supports Unicode, and upgrades keep the saved folder', async () => {
  const f = await fixture(); const repo = await resolveWorkspace(f.options);
  assert.equal(repo,f.options.defaultRoot);assert.deepEqual(await readJson(path.join(repo,'workspace/workspace.json')), {entities:[]});
  const selected = path.join(f.root,'Chosen Workspace é 日本語');
  assert.equal(await resolveWorkspace({...f.options,supplied:selected}),selected);
  await put(selected,'workspace/note.md','kept');
  assert.equal(await resolveWorkspace({...f.options,defaultRoot:path.join(f.root,'New default')}),selected);
  assert.equal(await readFile(path.join(selected,'workspace/note.md'),'utf8'),'kept');
  assert.equal(await f.current(),selected);
});

test('older AppData Workspace is preserved, including when no repository preference was saved', async () => {
  const f = await fixture(); await put(f.options.legacyRoot,'workspace/workspace.json','{"entities":[]}');
  assert.equal(await resolveWorkspace(f.options),f.options.legacyRoot);
  assert.equal(await resolveWorkspace(f.options),f.options.legacyRoot);
});

test('a queued copy waits for next launch, copies latest content and history, rebases working folders and keeps originals', async () => {
  const f = await fixture(), repo = await resolveWorkspace(f.options), location = f.change(repo), target = path.join(f.root,'New workspace');
  await put(repo,'workspace/note.txt','before'); await put(repo,'.alpha/settings.json','{"appTheme":"smurfs"}');
  await put(repo,'.alpha/sessions.json',JSON.stringify([{id:'one',cwd:repo,nativeId:'retained-id'},{id:'two',cwd:f.root}]));
  await put(repo,'.alpha/knowledge-sources.json',JSON.stringify([{root:path.join(repo,'knowledge')},{root:f.root}]));
  await put(repo,'.alpha/runtime.json','{"ephemeral":true}');
  const pending = await location.set({path:target,mode:'copy'});
  assert.equal(pending.current,repo);assert.equal(pending.pending.destination,target);assert.equal(await f.current(),repo);
  await assert.rejects(readFile(path.join(target,'workspace/note.txt')),{code:'ENOENT'});
  await put(repo,'workspace/note.txt','after the request');
  assert.equal(await resolveWorkspace(f.options),target);
  for (const root of [repo,target]) assert.equal(await readFile(path.join(root,'workspace/note.txt'),'utf8'),'after the request');
  assert.deepEqual(await readJson(path.join(target,'.alpha/settings.json')), {appTheme:'smurfs'});
  const sessions = await readJson(path.join(target,'.alpha/sessions.json'));
  assert.equal(sessions[0].cwd,target);assert.equal(sessions[0].nativeId,'retained-id');assert.equal(sessions[1].cwd,f.root);
  assert.deepEqual((await readJson(path.join(target,'.alpha/knowledge-sources.json'))).map(source=>source.root),[path.join(target,'knowledge'),f.root]);
  await assert.rejects(readFile(path.join(target,'.alpha/runtime.json')),{code:'ENOENT'});
  assert.equal((await location.state()).pending,null);
});

test('open existing and cancel do not copy or modify either Workspace', async () => {
  const f = await fixture(), repo = await resolveWorkspace(f.options), location = f.change(repo), target = path.join(f.root,'Existing');
  await put(target,'workspace/workspace.json','{"entities":[]}');await put(target,'workspace/saved.txt','original');
  await location.set({path:target,mode:'existing'});await location.cancel();assert.equal(await resolveWorkspace(f.options),repo);
  await location.set({path:target,mode:'existing'});assert.equal(await resolveWorkspace(f.options),target);
  assert.equal(await readFile(path.join(target,'workspace/saved.txt'),'utf8'),'original');
  assert.deepEqual(await readdir(path.join(repo,'workspace')),['workspace.json']);
});

test('reject relative, nested, parent, application/configuration and nonempty copy destinations without overwriting', async () => {
  const f = await fixture(), repo = await resolveWorkspace(f.options), location = f.change(repo);
  const full = path.join(f.root,'unrelated');await put(full,'keep.txt','untouched');
  for (const target of ['relative/path',repo,path.join(repo,'child'),f.root,full,path.join(f.options.configDir,'nested')]) await assert.rejects(location.set({path:target,mode:'copy'}));
  await assert.rejects(location.set({path:full,mode:'existing'}));
  assert.equal(await readFile(path.join(full,'keep.txt'),'utf8'),'untouched');assert.equal(await f.current(),repo);
  await assert.rejects(resolveWorkspace({...f.options,supplied:full}));assert.equal(await f.current(),repo);
});

test('copy checks again at startup and recovers from failures without replacing source, destination or preference', async () => {
  const f = await fixture(), repo = await resolveWorkspace(f.options), location = f.change(repo), target = path.join(f.root,'Destination');
  await location.set({path:target,mode:'copy'});await put(target,'new.txt','appeared after selection');
  await assert.rejects(resolveWorkspace(f.options),/empty folder/);assert.equal(await f.current(),repo);
  assert.equal(await readFile(path.join(target,'new.txt'),'utf8'),'appeared after selection');
  await location.cancel();
  const linked = path.join(f.root,'Linked destination');
  await symlink(repo, linked,process.platform==='win32'?'junction':'dir');
  await assert.rejects(location.set({path:path.join(linked,'child'),mode:'copy'}),/separate folder/);
  await location.set({path:path.join(f.root,'Another target'),mode:'copy'});
  await symlink(target,path.join(repo,'external-link'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(resolveWorkspace(f.options),/linked file or folder/);
  assert.equal(await f.current(),repo);assert.equal((await readdir(f.root)).some(name=>name.startsWith('.alpha-workspace-')),false);
});

test('completed copy can finish its preference update after interruption; missing saved roots do not silently reset', async () => {
  const f = await fixture(), repo = await resolveWorkspace(f.options), target = path.join(f.root,'Completed');
  await put(target,'workspace/workspace.json','{"entities":[]}');
  await saveJson(path.join(f.options.configDir,'workspace-change.json'),{source:repo,destination:target,mode:'copy',completed:true});
  await saveJson(path.join(f.options.configDir,'repository.json'),target);
  assert.equal(await resolveWorkspace(f.options),target);
  await saveJson(path.join(f.options.configDir,'repository.json'),path.join(f.root,'disconnected'));
  await assert.rejects(resolveWorkspace(f.options),/saved Workspace is unavailable/);
});

test('folder-picker results match the request and cancellation leaves the location unchanged', async () => {
  const f = await fixture(), repo = await resolveWorkspace(f.options), events=[];
  const location = new WorkspaceLocation({repo,configDir:f.options.configDir,native:event=>events.push(event)});
  const pending=location.browse();location.receive({type:'workspace-folder-picked',requestId:'other',path:'ignored'});
  location.receive({type:'workspace-folder-picked',requestId:events[0].requestId,path:null});
  assert.deepEqual(await pending,{path:null});assert.equal(await f.current(),repo);location.close();
});

test('location endpoints require authentication and preserve the current running service', async () => {
  const f = await fixture(), repo = await resolveWorkspace(f.options);
  const service=await createService({repo,uiDir:path.join(f.root,'ui'),workspaceLocation:{configDir:f.options.configDir},mcpOptions:{home:f.root,env:{}}});
  try {
    const route=service.origin+'/api/workspace/location/save', data={path:path.join(f.root,'Later'),mode:'copy'};
    const request={method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)};
    assert.equal((await fetch(route,request)).status,401);
    const response=await fetch(route,{...request,headers:{...request.headers,Authorization:`Bearer ${service.token}`}});
    assert.equal(response.status,200);assert.equal((await response.json()).current,repo);assert.equal(await f.current(),repo);
  } finally {await service.close();}
});
