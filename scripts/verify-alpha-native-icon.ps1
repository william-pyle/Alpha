param(
    [string]$Executable = "$PSScriptRoot/../src-tauri/target/debug/alpha-desktop.exe",
    [string]$OutputDirectory = "$PSScriptRoot/../.test-output/app-identity-native"
)
# Reads Windows executable resources; never launches Alpha or touches shortcuts.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$identityExe = (Resolve-Path -LiteralPath $Executable).Path
$identityIco = (Resolve-Path -LiteralPath "$PSScriptRoot/../src-tauri/icons/icon.ico").Path
$identityOutput = [IO.Path]::GetFullPath($OutputDirectory)
[IO.Directory]::CreateDirectory($identityOutput) | Out-Null
$actualIcon = [System.Drawing.Icon]::ExtractAssociatedIcon($identityExe)
$actualImage = $actualIcon.ToBitmap()
$icoBytes = [IO.File]::ReadAllBytes($identityIco)
$frame = $null
for ($i = 0; $i -lt [BitConverter]::ToUInt16($icoBytes, 4); $i++) {
    $entry = 6 + 16 * $i
    $width = if ($icoBytes[$entry] -eq 0) { 256 } else { [int]$icoBytes[$entry] }
    if ($width -eq $actualImage.Width) {
        $length = [BitConverter]::ToUInt32($icoBytes, $entry + 8)
        $offset = [BitConverter]::ToUInt32($icoBytes, $entry + 12)
        $frame = [byte[]]::new($length)
        [Array]::Copy($icoBytes, $offset, $frame, 0, $length)
        break
    }
}
if ($null -eq $frame) { throw 'Generated ICO has no frame matching the extracted native icon.' }
# Decode the PNG frame directly; GDI+ Icon.ToBitmap does not reliably decode
# PNG-compressed multi-frame ICOs. The actual side still uses Windows Shell.
$frameStream = [IO.MemoryStream]::new($frame)
$expectedImage = [System.Drawing.Bitmap]::new($frameStream)
try {
    if ($actualImage.Size -ne $expectedImage.Size) { throw 'Native icon dimensions differ.' }
    for ($y = 0; $y -lt $actualImage.Height; $y++) {
        for ($x = 0; $x -lt $actualImage.Width; $x++) {
            if ($actualImage.GetPixel($x, $y).ToArgb() -ne $expectedImage.GetPixel($x, $y).ToArgb()) {
                throw "Executable icon differs from generated ICO at ($x, $y)."
            }
        }
    }
    $preview = Join-Path $identityOutput 'native-executable-icon.png'
    $actualImage.Save($preview, [System.Drawing.Imaging.ImageFormat]::Png)
    $result = [ordered]@{ status = 'passed'; executable = $identityExe; executableHash = (Get-FileHash -LiteralPath $identityExe -Algorithm SHA256).Hash; icoHash = (Get-FileHash -LiteralPath $identityIco -Algorithm SHA256).Hash; width = $actualImage.Width; height = $actualImage.Height; exactArgbMatch = $true; launched = $false; installed = $false; preview = $preview }
    $result | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $identityOutput 'results.json') -Encoding UTF8
    $result | ConvertTo-Json
} finally {
    $expectedImage.Dispose(); $frameStream.Dispose(); $actualImage.Dispose(); $actualIcon.Dispose()
}
