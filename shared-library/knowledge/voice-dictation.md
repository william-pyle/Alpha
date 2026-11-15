# Local dictation in Alpha

Alpha can turn a microphone recording into text for a desktop chat. Review the
recognized text before sending it. **Talk to Alpha** is the separate live voice
conversation.

## Windows setup

Starting with Alpha 0.2.14, the Windows installer runs Local Whisper setup after
installing the app. On first setup, it downloads Python 3.12, the
`faster-whisper` package and the multilingual small model. The model is about
500 MB, so the first installation needs an internet connection and may take a
few minutes. Transcription runs locally on the CPU after setup; it needs no
provider key or network connection.

If the download fails, Alpha remains installed. Open PowerShell and run the
script from the installed app folder to retry:

```powershell
& "$env:LOCALAPPDATA\Alpha\runtime\setup-local-whisper.ps1"
```

The exact app folder can differ if you chose a custom installation path. The
script is also available in the Alpha source checkout at
`scripts/setup-local-whisper.ps1`. To check without downloading anything, add
`-CheckOnly`. Exit code 0 means ready; exit code 2 means incomplete.

The runtime lives in `%APPDATA%\com.jazcosolutions.alpha\Whisper`, separate
from the selected Workspace. Alpha can still use an existing Workspace-local
`.cache\dictation` installation. The setup script does not change Codex,
Claude Code or global Python settings.

## Use and troubleshooting

In **Tools → Settings → General**, choose local speech to text for desktop
dictation. Start a recording, stop it, review the recognized draft and send when
ready. Test a short sentence and technical terms before relying on it for longer
messages. A transcript never auto-submits a chat message.

If local dictation is unavailable, run the setup script again with a network
connection, then run `-CheckOnly`. Confirm Windows microphone permission and
that another app is not holding the device. Keep microphone recordings and
transcripts out of shared setup notes.

Source and licenses: [faster-whisper](https://github.com/SYSTRAN/faster-whisper),
[multilingual small model](https://huggingface.co/Systran/faster-whisper-small),
and [Python 3.12](https://www.python.org/downloads/release/python-31210/).
