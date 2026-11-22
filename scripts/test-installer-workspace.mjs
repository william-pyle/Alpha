// Compile and run only the shared installer hook in an isolated harness. This
// executable has no application installer/uninstaller, registry or shortcut code.
import { spawnSync } from 'node:child_process';
import { access, copyFile, mkdir, mkdtemp, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
if(process.platform!=='win32') { console.log('NSIS Workspace harness: Windows only.'); process.exit(0); }
const makensis=path.join(process.env.LOCALAPPDATA || path.join(os.homedir(),'AppData/Local'),'tauri/NSIS/makensis.exe');
await access(makensis);
await mkdir('.test-output',{recursive:true});const root=await realpath(await mkdtemp(path.join(process.env.RUNNER_TEMP || os.tmpdir(),'alpha-installer-workspace-')));
const app=path.join(root,'app'), config=path.join(root,'config'), standard=path.join(root,'Documents/Alpha'), chosen=path.join(root,'Chosen é 日本語');
await mkdir(path.join(app,'runtime/service'),{recursive:true});await copyFile(process.execPath,path.join(app,'runtime/node.exe'));
for(const name of ['workspace-location.mjs','workspace-layout.mjs','project-layout.mjs','util.mjs']) await copyFile(path.resolve('desktop/service',name),path.join(app,'runtime/service',name));
const whisperCalls=path.join(root,'whisper-invocations.txt');
await writeFile(path.join(app,'runtime/setup-local-whisper.ps1'),`param([switch]$InstallerMode)\nAdd-Content -LiteralPath '${whisperCalls.replaceAll("'","''")}' -Value 'called'\n`);
const unrelated=path.join(root,'Unrelated');
const quoted=value=>value.replaceAll('$','$$').replaceAll('"','$\\"');
const exe=path.join(root,'workspace-harness.exe'), script=path.join(root,'harness.nsi');
await writeFile(script,'\uFEFF'+`Unicode true
RequestExecutionLevel user
!include MUI2.nsh
!include FileFunc.nsh
Var PassiveMode
Var UpdateMode
!define ALPHA_WORKSPACE_CONFIG "${quoted(config)}"
!define ALPHA_WORKSPACE_DEFAULT "${quoted(standard)}"
!include "${quoted(path.resolve('src-tauri/installer/workspace.nsh'))}"
Name "Alpha Workspace installer test"
OutFile "${quoted(exe)}"
Page custom AlphaWorkspacePageCreate AlphaWorkspacePageLeave
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_LANGUAGE English
Function .onInit
  StrCpy $INSTDIR "${quoted(app)}"
  StrCpy $AlphaWorkspacePath "${quoted(chosen)}"
  ${'${'}GetOptions} $CMDLINE "/DEFAULT" $0
  IfErrors +2
  StrCpy $AlphaWorkspacePath ""
  ${'${'}GetOptions} $CMDLINE "/ALTERNATE" $0
  IfErrors +2
  StrCpy $AlphaWorkspacePath "${quoted(path.join(root,'Should not replace'))}"
  ${'${'}GetOptions} $CMDLINE "/INVALID" $0
  IfErrors +2
  StrCpy $AlphaWorkspacePath "${quoted(unrelated)}"
  ${'${'}GetOptions} $CMDLINE "/P" $PassiveMode
  IfErrors +2
  StrCpy $PassiveMode 1
FunctionEnd
Section
  !insertmacro NSIS_HOOK_POSTINSTALL
SectionEnd
`);
const build=spawnSync(makensis,['/V2',script],{encoding:'utf8',windowsHide:true});assert.equal(build.status,0,build.stdout+build.stderr);
const run=flag=>spawnSync(exe,['/S',...(flag?[`/${flag}`]:[])],{encoding:'utf8',windowsHide:true,timeout:120000});
const assertRun=flag=>{const result=run(flag);assert.equal(result.status,0,`Installer harness ${flag||'default'} failed: ${result.error?.message||''}\n${result.stdout}\n${result.stderr}`);};
const selection=()=>readFile(path.join(config,'repository.json'),'utf8').then(JSON.parse);
assertRun();assert.equal(await selection(),chosen);await access(path.join(chosen,'workspace.json'));
const pending='{"source":"fixture","mode":"copy","destination":"pending choice"}';
await writeFile(path.join(config,'workspace-change.json'),pending);
assertRun('ALTERNATE');assert.equal(await selection(),chosen);
assert.equal(await readFile(path.join(config,'workspace-change.json'),'utf8'),pending);
await unlink(path.join(config,'workspace-change.json'));
await unlink(path.join(config,'repository.json'));
assertRun('DEFAULT');assert.equal(await selection(),standard);
await unlink(path.join(config,'repository.json'));await mkdir(unrelated);await writeFile(path.join(unrelated,'keep.txt'),'kept');
assert.notEqual(run('INVALID').status,0);assert.equal(await readFile(path.join(unrelated,'keep.txt'),'utf8'),'kept');
await assert.rejects(selection(),{code:'ENOENT'});
assert.equal((await readFile(whisperCalls,'utf8')).trim().split(/\r?\n/).length,3);
await writeFile('.test-output/installer-workspace-result.json',JSON.stringify({passed:true,root,checks:['Custom page and hook compile','Chosen Unicode path initialized','Reinstall preserves location','Silent default uses Documents','Nonempty unrelated folder is preserved','Local Whisper setup runs after successful installs only']},null,2));
console.log('Installer hook passed: Workspace selection, upgrade preservation, conflict rejection and Local Whisper invocation.');
