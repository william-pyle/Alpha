<#
.SYNOPSIS
Installs Alpha's offline CPU dictation runtime for the current Windows user.
.DESCRIPTION
Run from the source checkout or the installed runtime. The installer calls this
script after copying Alpha's files. Downloads Python, Python packages and the
multilingual small model only when needed. No provider keys are used.
#>
param(
  [string]$InstallRoot = (Join-Path $env:APPDATA 'com.jazcosolutions.alpha\Whisper'),
  [string]$PythonExe = '',
  [switch]$CheckOnly,
  [switch]$NoDownload,
  [switch]$InstallerMode
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$pythonVersion = '3.12.10'
$pythonUrl = "https://www.python.org/ftp/python/$pythonVersion/python-$pythonVersion-amd64.exe"
$pythonSha256 = '67b5635e80ea51072b87941312d00ec8927c4db9ba18938f7ad2d27b328b95fb'
$packageVersion = '1.2.1'
$hubVersion = '1.32.0'
$modelRepo = 'Systran/faster-whisper-small'
$modelRevision = '536b0662742c02347bc0e980a01041f333bce120'

function Invoke-Checked([string]$Program, [string[]]$Arguments, [string]$Description) {
  Write-Host $Description
  & $Program @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$Description failed (exit $LASTEXITCODE)." }
}

function Test-WhisperReady([string]$RuntimeRoot) {
  $python = Join-Path $RuntimeRoot 'venv\Scripts\python.exe'
  $model = Join-Path $RuntimeRoot 'model'
  foreach ($file in @($python, (Join-Path $model 'model.bin'), (Join-Path $model 'config.json'), (Join-Path $model 'tokenizer.json'))) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { return $false }
  }
  try {
    & $python -c 'import faster_whisper' 2>$null | Out-Null
    return $LASTEXITCODE -eq 0
  } catch { return $false }
}

try {
  if (-not [IO.Path]::IsPathRooted($InstallRoot)) { throw 'InstallRoot must be an absolute folder.' }
  $InstallRoot = [IO.Path]::GetFullPath($InstallRoot)
  if ($InstallRoot -eq [IO.Path]::GetPathRoot($InstallRoot)) { throw 'InstallRoot cannot be a drive root.' }
  if ($CheckOnly) {
    if (Test-WhisperReady $InstallRoot) { Write-Host "Local Whisper is ready at $InstallRoot"; exit 0 }
    Write-Host "Local Whisper is not ready at $InstallRoot"
    exit 2
  }
  if ($NoDownload) {
    if (Test-WhisperReady $InstallRoot) { Write-Host "Local Whisper is ready at $InstallRoot"; exit 0 }
    throw 'Local Whisper is incomplete and downloads are disabled.'
  }
  New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
  $marker = Join-Path $InstallRoot 'setup.json'
  if ((Test-Path -LiteralPath $marker) -and (Test-WhisperReady $InstallRoot)) {
    $saved = try { Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json } catch { $null }
    if ($saved.packageVersion -eq $packageVersion -and $saved.modelRevision -eq $modelRevision) {
      Write-Host "Local Whisper is already ready at $InstallRoot"
      exit 0
    }
  }

  $basePython = ''
  if ($PythonExe) {
    if (-not (Test-Path -LiteralPath $PythonExe -PathType Leaf)) { throw "Python executable not found: $PythonExe" }
    $basePython = [IO.Path]::GetFullPath($PythonExe)
  } else {
    $managedPython = Join-Path $env:LOCALAPPDATA 'com.jazcosolutions.alpha\Python312\python.exe'
    if (Test-Path -LiteralPath $managedPython -PathType Leaf) { $basePython = $managedPython }
    if (-not $basePython) {
      $launcher = Get-Command py.exe -ErrorAction SilentlyContinue
      if ($launcher) {
        try {
          $candidate = (& $launcher.Source -3.12 -c 'import sys; print(sys.executable)' 2>$null | Select-Object -Last 1)
          if ($LASTEXITCODE -eq 0 -and $candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { $basePython = $candidate }
        } catch { Write-Host 'Python 3.12 was not found through the Windows launcher.' }
      }
    }
    if (-not $basePython) {
      $managedDir = Split-Path -Parent $managedPython
      New-Item -ItemType Directory -Path $managedDir -Force | Out-Null
      $installer = Join-Path $env:TEMP "alpha-python-$pythonVersion-$PID.exe"
      try {
        Write-Host "Downloading Python $pythonVersion from python.org..."
        Invoke-WebRequest -Uri $pythonUrl -OutFile $installer -UseBasicParsing
        $actualHash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actualHash -ne $pythonSha256) { throw 'Python installer SHA-256 did not match the pinned official release.' }
        $arguments = @('/quiet', 'InstallAllUsers=0', "TargetDir=$managedDir", 'Include_launcher=0', 'Include_test=0', 'Include_doc=0', 'Include_tcltk=0', 'Shortcuts=0', 'AssociateFiles=0', 'PrependPath=0', 'AppendPath=0')
        Write-Host "Installing Python $pythonVersion for Alpha"
        $process = Start-Process -FilePath $installer -ArgumentList $arguments -Wait -PassThru -WindowStyle Hidden
        if ($process.ExitCode -ne 0) { throw "Python installer failed (exit $($process.ExitCode))." }
      } finally {
        Remove-Item -LiteralPath $installer -Force -ErrorAction SilentlyContinue
      }
      if (-not (Test-Path -LiteralPath $managedPython -PathType Leaf)) { throw 'The Python installer completed without creating the expected interpreter.' }
      $basePython = $managedPython
    }
  }
  $version = & $basePython -c 'import sys; print(sys.version_info.major, sys.version_info.minor, sep=chr(46))'
  if ($LASTEXITCODE -ne 0 -or $version.Trim() -ne '3.12') { throw 'Local Whisper setup requires Python 3.12.' }

  $venvPython = Join-Path $InstallRoot 'venv\Scripts\python.exe'
  if (-not (Test-Path -LiteralPath $venvPython -PathType Leaf)) {
    Invoke-Checked $basePython @('-m', 'venv', (Join-Path $InstallRoot 'venv')) 'Creating Alpha Whisper environment'
  }
  $venvVersion = & $venvPython -c 'import sys; print(sys.version_info.major, sys.version_info.minor, sep=chr(46))'
  if ($LASTEXITCODE -ne 0 -or $venvVersion.Trim() -ne '3.12') { throw "Existing Whisper environment is not Python 3.12: $venvPython" }
  Invoke-Checked $venvPython @('-m', 'pip', 'install', '--disable-pip-version-check', '--only-binary=:all:', '--no-input', "faster-whisper==$packageVersion", "huggingface-hub==$hubVersion") 'Installing faster-whisper packages'

  $model = Join-Path $InstallRoot 'model'
  $env:HF_HUB_DISABLE_IMPLICIT_TOKEN = '1'
  $helper = Join-Path $InstallRoot ("setup-model-$PID.py")
  @'
import sys
from huggingface_hub import snapshot_download
from faster_whisper import WhisperModel

command, model, revision = sys.argv[1:4]
if command == "download":
    snapshot_download(
        repo_id="Systran/faster-whisper-small",
        revision=revision,
        local_dir=model,
        allow_patterns=["model.bin", "config.json", "tokenizer.json", "vocabulary.txt"],
    )
elif command == "verify":
    WhisperModel(model, device="cpu", compute_type="int8", local_files_only=True)
    print("Offline model check passed")
else:
    raise ValueError("Unknown setup step")
'@ | Set-Content -LiteralPath $helper -Encoding UTF8
  try {
    Invoke-Checked $venvPython @($helper, 'download', $model, $modelRevision) 'Downloading the multilingual small model'
    Invoke-Checked $venvPython @($helper, 'verify', $model, $modelRevision) 'Checking the model without network access'
  } finally {
    Remove-Item -LiteralPath $helper -Force -ErrorAction SilentlyContinue
  }
  if (-not (Test-WhisperReady $InstallRoot)) { throw 'The installed local Whisper files are incomplete.' }
  [ordered]@{ packageVersion = $packageVersion; model = $modelRepo; modelRevision = $modelRevision; python = $basePython; installedAt = (Get-Date).ToUniversalTime().ToString('o') } |
    ConvertTo-Json | Set-Content -LiteralPath $marker -Encoding UTF8
  Write-Host "Local Whisper is ready at $InstallRoot"
  exit 0
} catch {
  Write-Host "Local Whisper setup failed: $($_.Exception.Message)"
  if ($InstallerMode) { Write-Host 'Alpha itself is installed. Run this setup script again when the download is available.' }
  exit 1
}
