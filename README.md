# Alpha

[![Windows build](https://github.com/william-pyle/Alpha/actions/workflows/windows.yml/badge.svg)](https://github.com/william-pyle/Alpha/actions/workflows/windows.yml)
[![Release](https://badgen.net/github/release/william-pyle/Alpha)](https://github.com/william-pyle/Alpha/releases/latest)
[![Downloads](https://badgen.net/github/assets-dl/william-pyle/Alpha/total)](https://github.com/william-pyle/Alpha/releases)
![Windows x64](https://badgen.net/badge/platform/Windows%20x64/blue)
[![MIT license](https://badgen.net/badge/license/MIT/green)](LICENSE)

Alpha is a Windows desktop workspace built from the MrMak 0.5.1 codebase. It keeps
the familiar **Workspace and Chats windows**, navigation, terminals, history,
files, settings, desktop dictation and permission controls.

Version **0.2.0** replaces the earlier experimental Alpha application.

## Install

Download **Alpha-Setup-0.2.0-x64.exe** from the
[latest release](https://github.com/william-pyle/Alpha/releases/latest).
The installer includes the app, local service, Node runtime, native terminal
libraries, theme artwork, icons and Help. It installs WebView2 if needed.

If you installed Alpha 0.1.x, install 0.2.0 once from GitHub to switch to this
replacement. The previous Electron application and its data format are retired;
0.1.x data is not automatically imported. Subsequent releases use the updater in
this application. The installer is currently unsigned.

Install your preferred CLI tools separately and sign in through their own tools.
PowerShell is detected on Windows; Git Bash comes with Git for Windows.

## What changes from the base

- **New chat:** Codex, Claude Code, PowerShell and Git Bash.
- **Always approve:** the existing per-chat permission bypass and saved default.
- **No Phone Access:** no phone gateway, pairing, mobile app or Tailscale service.
- **Alpha identity:** application, windows, tray and installer use Alpha branding.
- **Application themes:** Alpha, Smurfs and Higurashi, applied to both windows.
  Change them in **Settings → Appearance → Application theme**. The controller
  artwork follows Alpha, Papa Smurf or Rena. Reading appearance remains selectable.
- **GitHub updates:** automatic checks after startup and every six hours, plus
  **Settings → Alpha updates → Check for updates**. Choose **Download update**,
  then **Restart and install**. Restart confirmation reports running terminals.

Alpha opens a fresh local Workspace on first launch. To use an existing Workspace
repository, launch `alpha-desktop.exe --repo "C:\path\to\workspace"`. The folder
must contain `workspace/workspace.json`. Runtime state stays under `.alpha` in
that selected repository, separate from MrMak's state.

## Build on Windows

Use Node.js 24, Rust, the Visual Studio C++ build tools and WebView2.

```powershell
npm ci
npm run lint
npm test
npm run build
npm run desktop:test:ui
npm run desktop:build -- --bundles nsis
node scripts/release.mjs
```

The installer and its SHA-256 update manifest are written to `release/`.
GitHub Actions runs the checks and creates a release when a matching `vX.Y.Z`
tag is pushed. The repository contains product source and assets; personal
Workspace records, CLI logins and runtime state are excluded.

## Attribution

Based on the MIT-licensed [MrMak](https://github.com/witnesstodark/mr-mak-workspace) release
`v0.5.1`. See [LICENSE](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md).
The character themes include previously generated illustrations of their named
fictional characters.
