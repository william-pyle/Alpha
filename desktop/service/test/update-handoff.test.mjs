import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
const execute = promisify(execFile);

test('MSI handoff launches from the updater once after a successful install', { skip: process.platform !== 'win32' }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'alpha-update-handoff-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const installer = path.join(directory, 'Alpha fixture with spaces.msi');
  const bytes = Buffer.from('fixture only; never executed');
  await writeFile(installer, bytes);
  await writeFile(path.join(directory, 'alpha-desktop.exe'), 'fixture only; never executed');
  const runtime = path.join(directory, 'runtime');
  await mkdir(runtime);
  const helper = path.join(runtime, 'install-msi-update.ps1');
  await copyFile(path.resolve('scripts/install-msi-update.ps1'), helper);
  const script = path.join(directory, 'verify.ps1');
  await writeFile(script, `param($Helper, $Installer, $Sha256)
$ErrorActionPreference = 'Stop'
function Get-ItemProperty { param($LiteralPath, $ErrorAction) return $null }
function Start-Process {
  param($FilePath, $ArgumentList, [switch]$Wait, [switch]$PassThru, $WindowStyle, $WorkingDirectory)
  if ($FilePath -eq (Join-Path $PSScriptRoot 'alpha-desktop.exe')) {
    if ($WorkingDirectory -ne $PSScriptRoot -or $ArgumentList) { throw 'Relaunch must use the original application and no forwarded arguments.' }
    if ($global:AlphaHandoffExitCode -ne 0) { throw 'Relaunched after a failed or incomplete installation.' }
    if ($global:AlphaHandoffStarts -ne 1) { throw 'Relaunched before installation completed.' }
    $global:AlphaHandoffLaunches++
    return
  }
  if (-not $Wait -or -not $PassThru -or $WindowStyle -ne 'Hidden') { throw 'Must wait for a hidden installer process and inspect its result.' }
  if ([IO.Path]::GetFileName($FilePath) -ne 'msiexec.exe') { throw 'Unexpected executable.' }
  if ($ArgumentList[1] -ne ('"{0}"' -f $Installer)) { throw 'Installer path lost its quotes.' }
  if ($ArgumentList -match '^AUTOLAUNCHAPP') { throw 'The MSI was allowed to launch Alpha.' }
  $global:AlphaHandoffStarts++
  return [pscustomobject]@{ ExitCode = $global:AlphaHandoffExitCode }
}
$global:AlphaHandoffStarts = 0
$global:AlphaHandoffLaunches = 0
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if ([Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0 -or $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  try { & $Helper -Installer $Installer -Sha256 $Sha256; throw 'Expected launch context to be rejected.' }
  catch { if ($_.Exception.Message -ne 'Start the Alpha update from the normal window of the signed-in user.') { throw } }
  if ($global:AlphaHandoffStarts -or $global:AlphaHandoffLaunches) { throw 'Unsafe launch context reached the installer.' }
  'Verified the handoff rejects an elevated or noninteractive process.'
  return
}
foreach ($global:AlphaHandoffExitCode in @(0, 3010)) { & $Helper -Installer $Installer -Sha256 $Sha256 }
$global:AlphaHandoffExitCode = 1603
try { & $Helper -Installer $Installer -Sha256 $Sha256; throw 'Expected installation failure.' }
catch { if ($_.Exception.Message -ne 'Alpha MSI failed with exit code 1603.') { throw } }
if ($global:AlphaHandoffStarts -ne 3 -or $global:AlphaHandoffLaunches -ne 1) { throw 'Unexpected installer or relaunch attempt count.' }
'Verified installer result handling without running an installer.'
`);
  const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Helper', helper, '-Installer', installer, '-Sha256', createHash('sha256').update(bytes).digest('hex')], { windowsHide: true, timeout: 15000 });
  assert.match(stdout, /Verified (installer result handling|the handoff rejects an elevated or noninteractive process)/);
  if (stdout.includes('Verified installer result handling')) assert.match(stdout, /Restart Windows before opening Alpha/);
  t.diagnostic(stdout.trim());
});
