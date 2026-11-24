param(
  [Parameter(Mandatory = $true)][string] $Installer,
  [Parameter(Mandatory = $true)][string] $Sha256,
  [int] $ParentPid = 0,
  [switch] $CheckOnly
)

$ErrorActionPreference = 'Stop'
if ($Sha256 -notmatch '^[a-f0-9]{64}$') { throw 'The update checksum is invalid.' }
$file = (Resolve-Path -LiteralPath $Installer -ErrorAction Stop).Path
if ([IO.Path]::GetExtension($file) -ine '.msi') { throw 'The update must be an MSI file.' }
$hashAlgorithm = [Security.Cryptography.SHA256]::Create()
$hashStream = [IO.File]::OpenRead($file)
try {
  $actualSha256 = [BitConverter]::ToString($hashAlgorithm.ComputeHash($hashStream)).Replace('-', '').ToLowerInvariant()
} finally {
  $hashStream.Dispose()
  $hashAlgorithm.Dispose()
}
if ($actualSha256 -ne $Sha256) {
  throw 'The downloaded MSI checksum changed.'
}

$nsisKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Alpha'
$old = Get-ItemProperty -LiteralPath $nsisKey -ErrorAction SilentlyContinue
$oldUninstaller = $null
if ($old) {
  if ($old.DisplayName -ne 'Alpha' -or $old.Publisher -ne 'jazcosolutions') {
    throw 'An unrecognized Alpha installation is registered. Uninstall it manually before using the MSI.'
  }
  $oldUninstaller = [string]$old.UninstallString
  $oldInstall = [string]$old.InstallLocation
  if (-not $oldUninstaller -or -not $oldInstall) { throw 'The old Alpha uninstaller path is missing.' }
  $oldUninstaller = $oldUninstaller.Trim().Trim('"')
  $oldInstall = $oldInstall.Trim().Trim('"')
  if (-not [IO.Path]::IsPathRooted($oldUninstaller) -or
      -not [string]::Equals([IO.Path]::GetFullPath($oldUninstaller),
        [IO.Path]::GetFullPath((Join-Path $oldInstall 'uninstall.exe')),
        [StringComparison]::OrdinalIgnoreCase) -or
      -not (Test-Path -LiteralPath $oldUninstaller -PathType Leaf)) {
    throw 'The old Alpha uninstaller could not be verified. Uninstall it manually before using the MSI.'
  }
}

if ($CheckOnly) {
  [pscustomobject]@{ Installer = $file; Verified = $true; OldNsisPresent = [bool]$old } |
    ConvertTo-Json -Compress
  return
}

$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if ([Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0 -or
    $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Start the Alpha update from the normal window of the signed-in user.'
}
$alpha = Join-Path (Split-Path -Parent $PSScriptRoot) 'alpha-desktop.exe'
if (-not (Test-Path -LiteralPath $alpha -PathType Leaf)) {
  throw 'The current Alpha installation could not be located for restart.'
}
if ($ParentPid -gt 0) {
  $parent = Get-Process -Id $ParentPid -ErrorAction SilentlyContinue
  if ($parent) {
    if ($parent.Path -ine $alpha) { throw 'The original Alpha process could not be verified.' }
    Wait-Process -InputObject $parent -Timeout 60 -ErrorAction Stop
  }
}
if ($oldUninstaller) {
  # Silent uninstall leaves the unchecked app-data option off and removes stale shortcuts.
  $removed = Start-Process -FilePath $oldUninstaller -ArgumentList '/S' -Wait -PassThru
  if ($removed.ExitCode -ne 0 -or (Test-Path -LiteralPath $nsisKey)) {
    throw 'The old Alpha installation could not be removed. The MSI was not started.'
  }
}
$installed = Start-Process -FilePath (Join-Path $env:WINDIR 'System32\msiexec.exe') -ArgumentList @('/i', ('"{0}"' -f $file), '/passive', '/norestart') -Wait -PassThru -WindowStyle Hidden
if ($installed.ExitCode -notin @(0, 3010)) { throw "Alpha MSI failed with exit code $($installed.ExitCode)." }
if ($installed.ExitCode -eq 3010) {
  Write-Warning 'Alpha was installed. Restart Windows before opening Alpha.'
  return
}
if (-not (Test-Path -LiteralPath $alpha -PathType Leaf)) {
  throw 'Alpha installed but its executable could not be located for restart.'
}
# This helper never elevates. The MSI owns installation, and this original
# user process makes one launch attempt only after the transaction succeeds.
Start-Process -FilePath $alpha -WorkingDirectory (Split-Path -Parent $alpha)
