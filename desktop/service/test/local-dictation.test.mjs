import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {localAvailable, localConfig} from '../local-dictation.mjs';

test('installed Whisper takes precedence while existing Workspace setup remains usable', async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),'alpha-whisper-paths-'));
  const appdata=path.join(root,'appdata'), repo=path.join(root,'workspace');
  const installed=path.join(appdata,'com.jazcosolutions.alpha','Whisper');
  const legacy=path.join(repo,'.cache','dictation');
  const python=process.platform==='win32'?'Scripts/python.exe':'bin/python';
  const create=async folder=>{
    await mkdir(path.join(folder,'venv',path.dirname(python)),{recursive:true});
    await mkdir(path.join(folder,'model'),{recursive:true});
    for(const file of [path.join('venv',python),'model/model.bin','model/config.json','model/tokenizer.json']) await writeFile(path.join(folder,file),'fixture');
  };
  if(process.platform!=='win32'){
    assert.equal(localConfig(repo,{APPDATA:appdata}).python,path.join(legacy,'venv',python));
    return;
  }
  assert.equal(localConfig(repo,{APPDATA:appdata}).python,path.join(installed,'venv',python));
  await create(legacy);
  assert.equal(localConfig(repo,{APPDATA:appdata}).python,path.join(legacy,'venv',python));
  await create(installed);
  const selected=localConfig(repo,{APPDATA:appdata});
  assert.equal(selected.python,path.join(installed,'venv',python));
  assert.equal(await localAvailable(selected),true);
  assert.equal(await localAvailable({...selected,model:path.join(root,'missing')}),false);
});
