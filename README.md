# Alpha

[![Windows build](https://github.com/william-pyle/Alpha/actions/workflows/windows.yml/badge.svg)](https://github.com/william-pyle/Alpha/actions/workflows/windows.yml)
[![Release](https://badgen.net/github/release/william-pyle/Alpha)](https://github.com/william-pyle/Alpha/releases/latest)
[![Downloads](https://badgen.net/github/assets-dl/william-pyle/Alpha/total)](https://github.com/william-pyle/Alpha/releases)
![Windows x64](https://badgen.net/badge/platform/Windows%20x64/blue)
[![MIT license](https://badgen.net/badge/license/MIT/green)](LICENSE)

Alpha is a Windows desktop workspace built from the MrMak 0.5.1 codebase. It
combines Chats and Workspace in one window, with terminals, history, document
tabs, settings, desktop dictation and permission controls.

Version **0.2.3** added a selectable Workspace location in Settings and the installer.

## Version 0.2.9

Fixes the repeated update prompt after installation. Alpha now passes its native
application version to the bundled service, and packaging checks require all
version records to agree. Once 0.2.9 is installed, its startup check recognizes
that release as current. The bottom Questions section appears only while there
are unanswered questions. The message editor accepts pasted screenshots and
other clipboard images, saves them to the Workspace inbox, and inserts their
paths into the draft. Workspace card tabs use each card's icon when available,
and the redundant Workspace/document heading, breadcrumb, New card and search
strip is removed. New card remains in the File menu.
The Workspace microphone is hidden by default; View can show or hide it, and
the choice persists across launches.
Settings groups Workspace skills under their owning projects, even when no
project card is open.

## Version 0.2.6

Chats is a resizable left sidebar. A draggable divider separates each terminal
from its message editor, and the editor size is saved per chat. **Enter** sends
and **Alt+Enter** inserts a newline; the Send button remains available.

The single window has a shared **Questions** section at the bottom.
Alpha collects questions from Codex and Claude turns and from active terminal
prompts, shows suggested answers when the question includes choices, and lets
you type your own reply. Sending delivers the reply to the originating chat.
You can dismiss a question that does not need an answer.

Workspace is a permanent document tab. Cards, opened files and Help get their
own tabs. The File, View, Tools and Help menus replace the old right rail; View
also opens the archive. New card opens a dialog. Settings is a dialog containing
General, MCP, Categories and Skills. A status bar shows connection and document
state. The bottom-left app logo is gone; voice control is at the lower right.

## Version 0.2.4

Alpha 0.2.4 added a multiline chat editor below each
terminal (its keys changed in 0.2.6), an update notice
from the startup GitHub check, and Workspace card category management with
editable names and icons. Category definitions are saved in the selected
Workspace's `workspace/workspace.json`.

The shared library now includes `knowledge/mailcraft-mcp.md`, covering the MailCraft
0.11.1 local MCP bridge, its Windows CLI, connection steps, and approval behavior.
The knowledge file is included automatically in the 0.2.4 installer.
MailCraft itself and the owner's MCP account configuration remain separate installs.
The shared library and editable cards introduced in 0.2.2 remain included.

## Install

Download **Alpha-Setup-0.2.9-x64.exe** from the
[latest release](https://github.com/william-pyle/Alpha/releases/latest).
The installer includes the app, local service, Node runtime, native terminal
libraries, theme artwork, icons, Help and the shared library. It installs WebView2 if needed.

If you installed Alpha 0.1.x, install the latest release once from GitHub to switch to this
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
- **Application themes:** Alpha, Smurfs and Higurashi, applied to the entire window.
  Change them in **Settings → General → Appearance → Application theme**. The controller
  artwork follows Alpha, Papa Smurf or Rena. Reading appearance remains selectable.
- **GitHub updates:** automatic checks after startup and every six hours, plus
  **Settings → General → Alpha updates → Check for updates**. Choose **Download update**,
  then **Restart and install**. Restart confirmation reports running terminals.

## Workspace folder

Fresh installations let you choose the Workspace folder during setup, defaulting
to **Documents\Alpha**. Updates preserve the current folder, including Workspaces
created in AppData by earlier releases.

In **Settings → General → Workspace location**, enter a path or click **Browse…**. Choose
**Copy current Workspace** for a new or empty destination, or **Open existing
Workspace** for a folder that already contains `workspace/workspace.json`.
Click **Save location**, then quit Alpha from its tray menu and reopen it when ready.
The change is applied before the next service starts; saving it does not interrupt chats.
You can cancel a pending change in Settings.

Copies include Workspace files, settings and Alpha chat history. The original folder
is retained, and existing destination files are never overwritten. Linked folders
require a manual copy followed by **Open existing Workspace**. Provider-managed
conversation data remains with its CLI. Shared library files and application preferences
keep their separate application-data location.

You can also launch `alpha-desktop.exe --repo "C:\path\to\workspace"` to select an
existing Workspace or initialize an empty folder. This explicit choice replaces any
pending location change. Project runtime state stays under `.alpha` in the selected root.

## Shared library and editable cards

The installer includes **20 reusable skills** from the official MrMak source,
with general knowledge, workflows, helper scripts, references, licenses and report
templates. Open **Settings → Skills** to view shared or project skills.
Project skills override shared skills of the same name. Optional tools and accounts
are separate installations.

Add future release content in this repository under `shared-library/knowledge/`,
`shared-library/processes/` or `shared-library/.agents/skills/`. Builds automatically
include new files and generate complete Codex and Claude copies. No per-file list
is required. Commit additions and publish the next version tag normally.

The installed library lives under `%APPDATA%/com.jazcosolutions.alpha/SharedLibrary`.
Updates add new defaults and replace unchanged defaults. Local edits and deletions
are preserved; **Review incoming files** opens conflicting package versions.
Editing an installed library does not automatically publish it: copy changes into
the source package and commit them when they should ship to other installations.

Use **File → New card** for an editable Gallery or Research page. Edit titles, notes,
images, prompts, links and statuses; reorder entries, preview and save. Existing
HTML and Markdown remain supported. The compatible `mrmak-card` version 1 JSON
format is documented in [the bundled guide](shared-library/docs/editable-cards.md).
Saves keep recovery copies and refuse to overwrite a newer edit from another window
or agent. Drafts are recoverable within the same window session; save before closing.

## Build on Windows

Use Node.js 24, Rust, the Visual Studio C++ build tools and WebView2.

```powershell
npm ci
npm run lint
npm test
npm run build
npm run desktop:test:ui
npm run desktop:build -- --bundles nsis
npm run desktop:test:installer
node scripts/release.mjs
```

The installer and its SHA-256 update manifest are written to `release/`.
GitHub Actions runs the checks and creates a release when a matching `vX.Y.Z`
tag is pushed. The repository contains product source and assets; personal
Workspace records, CLI logins and runtime state are excluded.

## Attribution

Based on the MIT-licensed [MrMak](https://github.com/witnesstodark/mr-mak-workspace) release
`v0.5.1`, with editable cards and the shared library from its 0.6.3 source.
See [LICENSE](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md).
The character themes include previously generated illustrations of their named
fictional characters.
