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
  if ($Output) { $synth.SetOutputToWaveFile($Output); $synth.Speak($message) }
  else {
    $synth.SetOutputToDefaultAudioDevice()
    # Process queued events on this runspace; background scriptblock callbacks
    # cannot safely use PowerShell's runspace from System.Speech threads.
    $eventName = 'AlphaSpeechViseme'
    # SAPI's mouth shapes follow this synthesizer's playback, without recording
    # the microphone or unrelated Windows audio. 0 is silence; 21 is closed lips.
    $openings = @(0, 75, 100, 90, 65, 45, 35, 30, 50, 85, 75, 85, 45, 40, 35, 20, 30, 25, 15, 25, 40, 0)
    Register-ObjectEvent -InputObject $synth -EventName VisemeReached -SourceIdentifier $eventName | Out-Null
    Register-ObjectEvent -InputObject $synth -EventName SpeakCompleted -SourceIdentifier 'AlphaSpeechCompleted' | Out-Null
    try {
      $prompt = $synth.SpeakAsync($message)
      while (-not $prompt.IsCompleted) {
        foreach ($sample in @(Get-Event -SourceIdentifier $eventName -ErrorAction SilentlyContinue)) {
          $viseme = [int]$sample.SourceEventArgs.Viseme
          $opening = if ($viseme -ge 0 -and $viseme -lt $openings.Length) { $openings[$viseme] } else { 30 }
          [Console]::Out.WriteLine((@{ level = $opening; viseme = $viseme; durationMs = [int]$sample.SourceEventArgs.Duration.TotalMilliseconds } | ConvertTo-Json -Compress))
          Remove-Event -EventIdentifier $sample.EventIdentifier
        }
        Start-Sleep -Milliseconds 25
      }
      [Console]::Out.WriteLine('{"level":0}')
      $completion = Get-Event -SourceIdentifier 'AlphaSpeechCompleted' -ErrorAction SilentlyContinue | Select-Object -Last 1
      if ($completion -and $completion.SourceEventArgs.Error) { throw $completion.SourceEventArgs.Error }
    } finally {
      Unregister-Event -SourceIdentifier $eventName -ErrorAction SilentlyContinue
      Get-Event -SourceIdentifier $eventName -ErrorAction SilentlyContinue | Remove-Event
      Unregister-Event -SourceIdentifier 'AlphaSpeechCompleted' -ErrorAction SilentlyContinue
      Get-Event -SourceIdentifier 'AlphaSpeechCompleted' -ErrorAction SilentlyContinue | Remove-Event
    }
  }
} finally {
  $synth.Dispose()
}
