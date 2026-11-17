param(
  [switch]$ListVoices,
  [string]$Voice,
  [string]$Output
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $names = @($synth.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name })
  if ($ListVoices) {
    ConvertTo-Json -InputObject $names -Compress
    exit 0
  }
  if ($Voice) {
    if ($names -notcontains $Voice) { throw 'The selected Windows voice is unavailable.' }
    $synth.SelectVoice($Voice)
  }
  [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
  $message = [Console]::In.ReadToEnd()
  if (-not $message.Trim()) { throw 'There is no reply to speak.' }
  if ($Output) { $synth.SetOutputToWaveFile($Output) }
  else { $synth.SetOutputToDefaultAudioDevice() }
  $synth.Speak($message)
} finally {
  $synth.Dispose()
}
