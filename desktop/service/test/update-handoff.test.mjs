import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
const execute = promisify(execFile);

test('MSI handoff waits for the process result and preserves quoted installer paths', { skip: process.platform !== 'win32' }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'alpha-update-handoff-'));
  const installer = path.join(directory, 'Alpha fixture with spaces.msi');
  const bytes = Buffer.from('fixture only; never executed');
  await writeFile(installer, bytes);
  const script = path.join(directory, 'verify.ps1');
  await writeFile(script, `param($Helper, $Installer, $Sha256)
$ErrorActionPreference = 'Stop'
function Get-ItemProperty { param($LiteralPath, $ErrorAction) return $null }
function Start-Process {
  param($FilePath, $ArgumentList, [switch]$Wait, [switch]$PassThru, $WindowStyle)
  if (-not $Wait -or -not $PassThru -or $WindowStyle -ne 'Hidden') { throw 'Must wait for a hidden installer process and inspect its result.' }
  if ([IO.Path]::GetFileName($FilePath) -ne 'msiexec.exe') { throw 'Unexpected executable.' }
  if ($ArgumentList[1] -ne ('"{0}"' -f $Installer)) { throw 'Installer path lost its quotes.' }
  if ($ArgumentList -notcontains 'AUTOLAUNCHAPP=1') { throw 'Automatic launch was lost.' }
  $global:AlphaHandoffLaunches++
  return [pscustomobject]@{ ExitCode = $global:AlphaHandoffExitCode }
}
$global:AlphaHandoffLaunches = 0
foreach ($global:AlphaHandoffExitCode in @(0, 3010)) { & $Helper -Installer $Installer -Sha256 $Sha256 }
$global:AlphaHandoffExitCode = 1603
try { & $Helper -Installer $Installer -Sha256 $Sha256; throw 'Expected installation failure.' }
catch { if ($_.Exception.Message -ne 'Alpha MSI failed with exit code 1603.') { throw } }
if ($global:AlphaHandoffLaunches -ne 3) { throw 'Installer process result was not checked for every case.' }
'Verified installer result handling without running an installer.'
`);
  const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Helper', path.resolve('scripts/install-msi-update.ps1'), '-Installer', installer, '-Sha256', createHash('sha256').update(bytes).digest('hex')], { windowsHide: true, timeout: 15000 });
  assert.match(stdout, /Verified installer result handling/);
});
