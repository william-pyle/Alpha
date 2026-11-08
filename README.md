# Alpha

[![Windows installer](https://github.com/william-pyle/Alpha/actions/workflows/windows.yml/badge.svg)](https://github.com/william-pyle/Alpha/actions/workflows/windows.yml)
[![Latest release](https://badgen.net/github/release/william-pyle/Alpha)](https://github.com/william-pyle/Alpha/releases/latest)
[![Release downloads](https://badgen.net/github/assets-dl/william-pyle/Alpha/total)](https://github.com/william-pyle/Alpha/releases)
![Windows x64](https://img.shields.io/badge/platform-Windows%20x64-0078D4)
[![Electron](https://img.shields.io/badge/Electron-45-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![Node.js](https://badgen.net/badge/Node.js/24/green)](https://nodejs.org/)

A Windows workspace that brings agent windows, terminals, projects, knowledge,
and questions together in one themeable desktop app.

**[Download Alpha for Windows](https://github.com/william-pyle/Alpha/releases/latest)**

## Install

1. Open the [latest release](https://github.com/william-pyle/Alpha/releases/latest).
2. Download `Alpha-Setup-<version>-x64.exe` and run it.
3. Choose an installation folder, then launch Alpha from the Start menu or desktop shortcut.

The installer includes the desktop runtime. Install **Codex**, **Claude Code**, or
**Git for Windows** separately to use those providers. Alpha detects Windows
PowerShell automatically. Provider accounts, models, and permissions stay with
the tools you install.

The current installer is unsigned. If you used the original **0.1.0 portable
preview**, run the installer once to enable future update prompts. Your existing
Alpha data stays in the same application data folder.

## Release information

| Item                       | Details                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Latest version and notes   | [GitHub Releases](https://github.com/william-pyle/Alpha/releases/latest)                                     |
| First installer release    | [v0.1.1](https://github.com/william-pyle/Alpha/releases/tag/v0.1.1) — Windows installer and prompted updates |
| Platform                   | Windows, x64                                                                                                 |
| Installation               | Per-user setup with Start menu and desktop shortcuts                                                         |
| Application ID             | `com.jazcosolutions.alpha`                                                                                   |
| Release files              | Setup executable, `.exe.blockmap`, and `latest.yml`                                                          |
| Build status and artifacts | [Windows installer workflow](https://github.com/william-pyle/Alpha/actions/workflows/windows.yml)            |

### Updating

The installed app checks GitHub shortly after startup and every six hours.
You can also use **Settings → Check for updates**.

- Choose **Download update** or **Later** when a release is available.
- Keep working while the update downloads.
- Choose **Restart and install** when ready. Alpha asks again before restarting
  and tells you how many running windows will stop.
- Saved projects, knowledge, questions, and window history remain in place.

Closing Alpha does **not** automatically install a downloaded update. The optional
portable edition does not update itself; use the installer edition for updates.

## Features

- **New window:** Codex, Claude Code, PowerShell, and Git Bash. The project dropdown
  starts at **New Project**.
- **Project-owned workspaces:** each project's workspaces live in its own
  `workspaces/` folder.
- **Multiple visible windows:** side-by-side, top/bottom, grid, and tab layouts.
- **Dockable viewer:** view project files or memory inside Alpha or in a separate window.
- **Shared and project-specific memory and skills:** local ranked retrieval selects
  relevant context, with an interactive 3D memory network.
- **Central Questions:** answer questions from different areas in one inbox,
  with answers returned to their requesters.
- **Window communication:** scoped inboxes and MCP tools for agent coordination.
- **Three included themes:** Alpha, Smurfs, and Rena / Higurashi, with a theme
  editor for colors, artwork, application name, and controller identity.

This is an early release. Retrieval uses local ranked text search, and importing
an existing workspace is not automatic. Phone Access is excluded.

## Build from source

Use **Windows x64**, **Node.js 24**, and npm.

```powershell
git clone https://github.com/william-pyle/Alpha.git
cd Alpha
npm ci
npm run build
npm start
```

### Checks and packaging

```powershell
npm run format:check
npm test
npm run test:desktop
npm run package
```

The installer and update metadata are written to `release/`. To build an optional
portable executable instead:

```powershell
npm run package:portable
```

The build uses the official `node-pty` package's precompiled Windows Node-API
binaries. The x64 package does not require a native rebuild.

## Publish a release

From a clean, up-to-date `main` branch:

```powershell
npm version patch
git push origin main --follow-tags
```

Use `npm version minor` or `npm version major` for larger releases. The annotated
`v<version>` tag must match `package.json`; the workflow verifies this.

GitHub Actions builds and tests the app on Windows, builds the installer, checks
the packaged app and SHA-512 metadata, then publishes the setup executable,
blockmap, and `latest.yml` together. Only version-tag releases become application
updates. Main-branch and pull-request builds produce downloadable workflow
artifacts without publishing an update.

Release publishing uses GitHub's temporary workflow token. The application
contains no GitHub credential.

## Data and project structure

Alpha stores user data separately from its source, normally under
`%APPDATA%\Alpha`. Use **Settings → Open Alpha data folder** to find it.

| Location             | Purpose                                              |
| -------------------- | ---------------------------------------------------- |
| `src/`               | React and TypeScript desktop interface               |
| `electron/`          | Desktop runtime, storage, terminals, and updater     |
| `integration/`       | Scoped MCP bridge for agent tools                    |
| `public/art/`        | Included theme artwork and icons                     |
| `scripts/`           | Build and release validation tools                   |
| `tests/`             | Storage, integration, update, and desktop checks     |
| `.github/workflows/` | Windows installer and release automation             |
| `release/`           | Generated installers and metadata; excluded from Git |

Runtime data, test profiles, dependencies, credentials, and generated binaries are
excluded from Git. Anything created for or by Alpha defaults to the
`com.jazcosolutions` namespace unless you specify another.

## Feedback

[Report a bug or request a feature](https://github.com/william-pyle/Alpha/issues).
