param([string] $MsiPath, [string] $ExpectedVersion)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$version = (Get-Content -Raw -LiteralPath (Join-Path $root 'package.json') | ConvertFrom-Json).version
if (-not $MsiPath) {
  $MsiPath = Join-Path $root "src-tauri\target\release\bundle\msi\Alpha_${version}_x64_en-US.msi"
}
$file = (Resolve-Path -LiteralPath $MsiPath).Path
function Read-Rows($Database, [string] $Sql, [int] $Columns) {
  $view = $Database.OpenView($Sql)
  try {
    [void]$view.Execute()
    while ($null -ne ($record = $view.Fetch())) {
      try {
        $values = @(for ($i = 1; $i -le $Columns; $i++) {
          $record.GetType().InvokeMember('StringData', 'GetProperty', $null, $record, @($i))
        })
        ,$values
      } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($record) }
    }
  } finally {
    [void]$view.Close()
    [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($view)
  }
}
$installer = $null
$database = $null
try {
  $installer = New-Object -ComObject WindowsInstaller.Installer
  $database = $installer.OpenDatabase($file, 0)
  $properties = @{}
  foreach ($row in (Read-Rows $database 'SELECT `Property`, `Value` FROM `Property`' 2)) {
    $properties[$row[0]] = $row[1]
  }
  if (-not $ExpectedVersion) { $ExpectedVersion = $version }
  if ($properties['ProductVersion'] -ne $ExpectedVersion) { throw 'The MSI product version differs from the expected release.' }
  if ($properties['UpgradeCode'].Trim('{}') -ine 'c2fa89e5-546c-51c7-8396-02888a068f36') {
    throw 'The Alpha MSI upgrade identity changed.'
  }
  if ($properties['ALLUSERS'] -ne '1') { throw 'Alpha must install for the machine, like ContactCraft and SolidCraft.' }
  $directories = @{}
  foreach ($row in (Read-Rows $database 'SELECT `Directory`, `Directory_Parent`, `DefaultDir` FROM `Directory`' 3)) {
    $directories[$row[0]] = @($row[1], $row[2])
  }
  if ($directories['INSTALLDIR'][0] -ne 'ProgramFiles64Folder') {
    throw 'Alpha MSI must default to Program Files.'
  }
  $skillDirs = @($directories.Keys | Where-Object { $directories[$_][1] -match '(^|\|)release-packaging$' })
  if ($skillDirs.Count -lt 2) { throw 'The installed MSI is missing a provider copy of release-packaging.' }
  $skillComponents = @(
    Read-Rows $database 'SELECT `Component`, `Directory_` FROM `Component`' 2 |
      Where-Object { $_[1] -in $skillDirs } | ForEach-Object { $_[0] }
  )
  $skillFiles = @(
    Read-Rows $database 'SELECT `Component_`, `FileName` FROM `File`' 2 |
      Where-Object { $_[0] -in $skillComponents -and $_[1] -match 'SKILL[.]md' }
  )
  if ($skillFiles.Count -lt 2) { throw 'Codex and Claude release-packaging SKILL.md files are missing from the MSI.' }
  $registry = @(Read-Rows $database 'SELECT `Root`, `Key`, `Name` FROM `Registry`' 3)
  if (-not @($registry | Where-Object {
    $_[0] -eq '2' -and $_[1] -eq 'Software\jazcosolutions\Alpha' -and $_[2] -eq 'InstallDir'
  }).Count) { throw 'The MSI install folder is not recorded under HKLM.' }
  $guards = @(Read-Rows $database 'SELECT `Condition` FROM `LaunchCondition`' 1)
  if (-not @($guards | Where-Object { $_[0] -match 'NOT OLD_NSIS_UNINSTALL' }).Count) {
    throw 'A direct MSI install could overlap the previous NSIS installation.'
  }
  $actions = @{}
  foreach ($row in (Read-Rows $database 'SELECT `Action`, `Target` FROM `CustomAction`' 2)) {
    $actions[$row[0]] = $row[1]
  }
  if ($actions['SetupLocalWhisper'] -notmatch 'setup-local-whisper[.]ps1') {
    throw 'The MSI no longer invokes the installed Local Whisper setup script.'
  }
  $sequence = @{}
  foreach ($row in (Read-Rows $database 'SELECT `Action`, `Sequence` FROM `InstallExecuteSequence`' 2)) {
    $sequence[$row[0]] = [int]$row[1]
  }
  if (-not ($sequence['InstallFiles'] -lt $sequence['SetupLocalWhisper'] -and
      $sequence['SetupLocalWhisper'] -lt $sequence['InstallFinalize'])) {
    throw 'Local Whisper setup must run after Alpha files are installed.'
  }
  $shortcuts = @(Read-Rows $database 'SELECT `Directory_`, `Name` FROM `Shortcut`' 2)
  if (-not @($shortcuts | Where-Object { $_[0] -eq 'ApplicationProgramsFolder' -and $_[1] -match 'Alpha' }).Count) {
    throw 'The Start menu shortcut is missing.'
  }
  if (@($shortcuts | Where-Object { $_[0] -eq 'DesktopFolder' }).Count) {
    throw 'The MSI unexpectedly creates a desktop shortcut.'
  }
  $hashAlgorithm = [Security.Cryptography.SHA256]::Create()
  $hashStream = [IO.File]::OpenRead($file)
  try {
    $sha = [BitConverter]::ToString($hashAlgorithm.ComputeHash($hashStream)).Replace('-', '').ToLowerInvariant()
  } finally {
    $hashStream.Dispose()
    $hashAlgorithm.Dispose()
  }
  $handoff = & (Join-Path $PSScriptRoot 'install-msi-update.ps1') -Installer $file -Sha256 $sha -CheckOnly |
    ConvertFrom-Json
  if (-not $handoff.Verified) { throw 'The MSI update helper could not verify the package.' }
  Write-Output 'PASS Alpha MSI: machine scope, upgrade identity, Program Files, NSIS guard, Start menu, Local Whisper and both installed skill copies. No installation performed.'
} finally {
  if ($database) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($database) }
  if ($installer) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($installer) }
}
