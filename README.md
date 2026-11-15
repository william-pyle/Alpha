# Alpha

[![Windows build](https://github.com/william-pyle/Alpha/actions/workflows/windows.yml/badge.svg)](https://github.com/william-pyle/Alpha/actions/workflows/windows.yml)
[![Release](https://badgen.net/github/release/william-pyle/Alpha)](https://github.com/william-pyle/Alpha/releases/latest)
![Windows x64](https://badgen.net/badge/platform/Windows%20x64/blue)
[![MIT license](https://badgen.net/badge/license/MIT/green)](LICENSE)

Alpha brings agent chats, Workspace documents, questions, voice and reusable
knowledge into one Windows desktop window. The current release is **0.2.15**.

## What you can do

- Open Codex, Claude Code, PowerShell or Git Bash chats in the resizable sidebar.
  Each chat has a terminal, message editor, saved drafts and history.
- Answer agent prompts in one Questions section. Choose a suggested answer or
  type your own response and send it back to the originating chat.
- Open Workspace cards, files and Help as document tabs. Create editable Gallery
  and Research cards, organize them by category, preview changes and save.
- Paste or drop images into a message draft. Alpha saves them to the Workspace
  inbox and inserts their paths without sending the draft.
- Use desktop dictation and Talk to Alpha. Settings has separate Speech-to-text,
  Voice, Updates, and Theme sections. Edit a bundled theme or create a color
  theme with Alpha's artwork.
- Browse shared and project skills and knowledge in Settings. Project skills
  with the same name take precedence over shared skills.
- Choose a Workspace location at installation or later in Settings. Copy a
  Workspace to a new folder or open an existing one.
- Check for Windows updates from GitHub Releases. Download and installation
  require separate user choices.

<img src="public/art/alpha.png" alt="Alpha application icon" width="120">

## Install

Download [Alpha 0.2.15 for Windows x64](https://github.com/william-pyle/Alpha/releases/tag/v0.2.15).
The installer includes the application, local service and Node runtime, terminal
libraries, three built-in themes, Help and the shared library. It installs WebView2 if
needed. Choose the MSI for a fresh installation. Existing NSIS installations can
update through Alpha to receive the transition installer. The installers are
currently unsigned.

Installation also sets up Local Whisper for offline desktop dictation.
The first setup downloads Python 3.12, faster-whisper and the multilingual small
model (about 500 MB). Keep an internet connection during this step. The model
and Python environment live under `%APPDATA%\com.jazcosolutions.alpha\Whisper`,
separate from the Workspace. If the download fails, Alpha still installs. Retry
from Settings → Speech-to-text, or run the packaged script from PowerShell with:

```powershell
& "$env:ProgramFiles\Alpha\runtime\setup-local-whisper.ps1"
```

For a custom installation folder, run `runtime\setup-local-whisper.ps1` there.
Add `-CheckOnly` to verify readiness without a download. After setup,
transcription runs locally on the CPU without a provider key or internet access.

Install Codex, Claude Code and Git for Windows separately if you want those
launchers. Their accounts and provider data remain with their own tools.

A fresh installation lets you choose a Workspace folder and defaults to
`Documents\Alpha`. An upgrade keeps your existing choice. You can change the
location under **Tools → Settings → General → Workspace location**. Choose
**Copy current Workspace** for a new or empty folder or **Open existing
Workspace** for a folder with `workspace/workspace.json`. Save the location and
apply it on Alpha's next normal launch. A copy keeps the original folder.

## Use Alpha

Choose **New chat**, select a launcher and working folder, then name the chat.
In the message editor, **Enter sends** and **Alt+Enter adds a line**. Drag the
divider between the terminal and editor to change their heights. **Always
approve** is available for agent chats and as a saved default in Settings; it
bypasses agent permission prompts.

Workspace stays open as a document tab. Use **File → New card** for Gallery or
Research content, **File → Open file** for a file tab and **Help → Open Help**
for the built-in guide. **Tools → Settings** contains General, Speech-to-text,
Voice, Updates, Theme, MCP, Categories and Skills. The **View** menu opens the archive and controls the Workspace
microphone.

Alpha checks GitHub shortly after startup and every six hours. To check now,
open **Settings → Updates**. Choose **Download update**, then
**Restart and install** when ready. Alpha verifies the installer checksum and
warns about active terminals before restarting. Closing the app alone does not
install a downloaded update.

## Skills and knowledge

The installer carries 21 reusable skill folders with supporting knowledge,
workflows, scripts and report assets. Open **Settings → Skills** to browse them.
Read a skill's full instructions before using it. Optional tools, packages and
provider accounts are separate.

The release source is in [`shared-library/`](shared-library/). Add skills under
`shared-library/.agents/skills/`, general knowledge under
`shared-library/knowledge/` and reusable workflows under
`shared-library/processes/`. Run `npm run library:build` to validate the package
and generate provider copies. Commit those source changes for a later release;
editing an installed library alone does not publish them.

The installed library is under
`%APPDATA%/com.jazcosolutions.alpha/SharedLibrary`. Updates add new defaults
and replace unchanged defaults. Local edits and deletions are preserved, with
incoming conflicts available for review. See the [library guide](shared-library/LIBRARY.md)
and [skill index](shared-library/docs/skills.md).

## 0.2.15

Alpha adds a per-machine WiX MSI. This transition release also publishes an
NSIS installer for the 0.2.14 in-app updater; the next release can use MSI
updates directly. Settings now has separate Speech-to-text, Voice, Updates
and Theme sections. Local Whisper can be installed, started and stopped there.
Voice offers 38 built-in GPT-Live choices. Built-in themes can be edited and
saved color themes can be created using Alpha's artwork.

## 0.2.14

The installer runs Local Whisper setup on fresh installs and upgrades. Its
packaged PowerShell script can retry failed downloads. Alpha uses the shared
per-user model location and still recognizes existing Workspace-local models.

## 0.2.13

Face tracking holds the last head direction through brief missed camera
detections, then returns gently toward center if the face remains out of view.
New detections cannot snap the head to a distant position. The camera-driven
turn range is smaller, reducing overshoot when the viewer moves. The active
installation can update through Settings; live laptop review follows that update.

## 0.2.12

The Alpha sidebar tab adds a generated textured 3D android head, animated
circuit board, speech-driven jaw motion, work-state lighting and local face
tracking. Camera use stops when the tab is hidden or disabled. The transparent
render of this head is now the Alpha application and project icon, including
its document tabs. Questions also recognizes asynchronous Codex prompts.
Build and isolated UI checks passed. Actual laptop movement, working-state
lights and live speech can be reviewed after updating the active installation.

## Build and release

Use Windows x64 with Node.js 24, Rust, Visual Studio C++ build tools and WebView2.

```powershell
npm ci
npm run lint
npm test
npm run build
npm run desktop:test:ui
npm run desktop:build -- --bundles msi
npm run desktop:test:installer
node scripts/release.mjs
```

The installer and `alpha-update.json` are generated in `release/`. The
[Windows workflow](https://github.com/william-pyle/Alpha/actions/workflows/windows.yml)
runs checks on main, pull requests and manual dispatch. A matching `vX.Y.Z`
tag triggers publication of the tested installer and update manifest to
[GitHub Releases](https://github.com/william-pyle/Alpha/releases).

The source now builds a per-machine WiX MSI with the standard welcome, install
folder and finish wizard, like ContactCraft and SolidCraft. Tauri builds this
MSI with WiX v3; those projects use WiX v5. The published
0.2.14 installer remains NSIS. Its updater only accepts NSIS, so 0.2.15
publishes both formats and serves an NSIS bridge to older installations.
That bridge has an MSI-aware updater; a later MSI release can
then remove the old NSIS app without deleting its Workspace or settings.
Remove `ALPHA_BRIDGE_NSIS` and the NSIS build steps from the Windows workflow
after the bridge release is published, before tagging the first MSI-led release.
Direct MSI installation requires uninstalling the old NSIS app first. Fresh
MSI installs ask for the Workspace folder on first launch. Local Whisper setup
runs during MSI installation and can be retried with its packaged script.

Product source and assets live here. Personal Workspace records, CLI logins
and runtime state are excluded from the repository. License and provenance
details are in [LICENSE](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md).
