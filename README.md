# Alpha

[![Windows build](https://github.com/william-pyle/Alpha/actions/workflows/windows.yml/badge.svg)](https://github.com/william-pyle/Alpha/actions/workflows/windows.yml)
[![Release](https://badgen.net/github/release/william-pyle/Alpha)](https://github.com/william-pyle/Alpha/releases/latest)
![Windows x64](https://badgen.net/badge/platform/Windows%20x64/blue)
[![MIT license](https://badgen.net/badge/license/MIT/green)](LICENSE)

Alpha brings agent chats, Workspace documents, questions, voice and reusable
knowledge into one Windows desktop window. This source targets **0.2.25**.
See the [0.2.25 release notes](release-notes/v0.2.25.md).

## What you can do

Version 0.2.22 source adds a canonical workspace for each project, a protected
Conversations default and a + create flow. Project settings keep working and
read-only source repositories independent, support asynchronous cloning and
coordinator association, and offer guarded repository creation for blank working
repository settings. Delete project offers keeping local files or permanently
deleting its canonical local project folder. It never deletes a remote
repository. New layouts use `projects/<stable-id>/workspace` with an optional
`github` sibling; existing pinned checkouts and active sessions remain in place.

Exclusive, dismissible menus support keyboard and accessibility controls. Current
activity and Needs attention help track conversations. Six singleton Workspace
utility tabs persist across sessions. The File menu no longer offers Open/Close,
and the QuickSwitcher and Ctrl+K shortcut have been removed. Publication,
installation and native acceptance remain separate verification steps.

### Disk space and deletion

Each project card shows logical file size in decimal units. The Windows scan
counts the uncompressed length of each regular-file entry, including each
hardlinked filename. Measurements run in the background and are cached
for 15 minutes; right-click **Refresh file size** for a fresh measurement.
Linked folders are skipped. A failed scan displays **Unavailable**, never zero.

Right-click **Clear build folders** to review generated output before removing
it. Cleanup recognizes supported Rust, JavaScript and Gradle output backed by
manifests and Git ignore rules, plus Alpha and Agent Watch disposable test output.
Tracked source, dependencies, application data and Git history remain. Preview
sizes are logical bytes; actual disk savings depend on compression and shared
links. Stop project workers/tools first and close external builds. Changed
previews are rejected. Nested Git repositories are preserved and listed under
**Preserved folders**; safe sibling test output can still be cleared. The next
build recreates its output.

**Delete project → Delete local project files** permanently removes
`projects/<stable-id>` after exact-ID confirmation. GitHub repositories and
existing conversation histories remain. Built-in Conversations, running Alpha,
active workers, shared project paths, foreign repositories and linked Git
worktrees are protected. A locked deletion remains visible for retry and records
its remaining files in a local recovery journal. The delete preview measures the
same project root as the card. Disk space freed may differ.

Use **Delete conversation** from a conversation's context menu or
**Conversation history** to remove its Alpha history, draft and local worker
records. Running work and pending Questions must be resolved first. Provider
history held by Codex, Claude or another CLI is retained separately.
Saved attachments and copies explicitly shared into other conversations remain.
If local cleanup is interrupted, Alpha still opens and Conversation history
offers **Retry cleanup** for the remaining files.

- Open Codex, Claude Code, PowerShell or Git Bash chats in the resizable sidebar.
  Each chat has a terminal, message editor, saved drafts and history.
- Answer agent prompts in one Questions section. Choose a suggested answer or
  type your own response and send it back to the originating chat.
- Open Workspace projects, files and Help as document tabs. Create editable Gallery
  and Research projects, organize them by category, preview changes and save.
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

<img src="public/identity/alpha.svg" alt="Alpha application icon" width="120">

## Install

Download the [latest Alpha for Windows x64](https://github.com/william-pyle/Alpha/releases/latest).
The installer includes the application, local service and Node runtime, terminal
libraries, three built-in themes, Help and the shared library. It installs WebView2 if
needed. Releases use MSI installers. Existing 0.2.14 installations first use the
0.2.15 transition release; 0.2.15 can update directly to MSI. Installers are
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
location under **… → General → Workspace location**. Choose
**Copy current Workspace** for a new or empty folder or **Open existing
Workspace** for a folder with `workspace.json` at its root. Alpha upgrades the legacy layout on startup. Save the location and
apply it on Alpha's next normal launch. A copy keeps the original folder.

## Use Alpha

Choose **New conversation** and a project. New conversations default to **Conversations**. Use + beside the project selector to create a project without losing the new-conversation form. Each conversation has its own
history, saved draft, images, voice and worker links. Switch using the named tabs
with a view icon and status. The tab's **×** closes it while work continues.
Reopen it from **Conversation history**. Alpha shares titles, purposes,
projects and statuses across threads, without automatically sharing transcripts.
**Share** copies one previewed message to a chosen conversation without starting work.

**Enter** adds a line. **Alt+Enter** uses the primary button. Choose **Submit** to
start work or **Append** to queue a follow-up behind the active run. Alpha shows
when the follow-up is queued. Paste or drop images into the composer.
Expand **Activity** for native worker output. **Enable terminal controls** is for
native permission prompts or CLI recovery. Existing Codex/Claude identities and
history remain intact; **Load earlier native conversation** imports verified user
messages and final replies. New native launchers are under **New conversation ?
Advanced launchers**. Their existing approval settings still apply.

Workspace and Questions stay available as document tabs. Questions collects pending items for their originating conversations. Use **File → Create project** for Gallery or Research content and **Help → Open Help** for the built-in guide. Close documents using their tab controls. The **…** beside the window controls opens Settings, which contains General, Speech-to-text,
Voice, Updates, Theme, MCP, Categories and Skills. The **View** menu opens Conversation history, Needs attention, Questions, learned preferences, common agents and Alpha health.

Alpha checks GitHub shortly after startup and every six hours. To check now,
choose **Help → Check for Updates**. Choose **Download update**, then
**Restart and install** when ready. Alpha verifies the installer checksum and
warns about active terminals before restarting. Closing the app alone does not
install a downloaded update.

## Skills and knowledge

The installer carries 22 reusable skill folders with supporting knowledge,
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

## 0.2.17

One Alpha window now has one selected conversation and composer. Independent
coordinator contexts keep conversation histories isolated. Background work stays
in Activity, with unread indicators and origin-bound Questions. Legacy mixed
conversation/voice records remain in a read-only archive, outside new prompts.

**Awareness** notices explicit Questions, errors, exits and completed turns that
need review. Possible overlapping projects are labelled suggestions. Dismiss,
snooze, quiet mode and pause prevent repeated chatter; silence is never treated
as task success. Optional **app names only** reads the foreground Windows
executable name, at most every five seconds while Alpha is visible. No window
titles, screenshots, clipboard or input are collected. The current sample stays
in memory; sharing it with a conversation requires that thread's visible toggle.

Camera tracking defaults off. When enabled, it uses local face position for eye
contact, with no identification or saved frames; leaving the Alpha tab or hiding
the window stops it. Microphone capture starts only through Talk/live voice or
dictation controls. Dictation keeps a recoverable recording until accepted or
explicitly discarded. Live voice uses its configured provider and current thread.

Windows voices now send playback-timed SAPI visemes to the mouth animation;
stop, error and thread switching return it to neutral. This follows Alpha's
speech, without recording system audio or a microphone. Live voice retains its
output audio animation. New requests acknowledge promptly and stream replies;
stage timings are recorded, but model and tool latency can still vary.

Local Whisper setup now pins a compatible PyAV decoder and verifies actual audio decoding. This repairs installations where faster-whisper 1.2.1 was paired with incompatible PyAV 19.

The MSI helper waits for the installer process and checks its exit code directly.
Codex discovery also checks its per-user installation when an installer-launched
app inherits an incomplete PATH. These correct the two 0.2.16 restart failures.

## 0.2.16

In 0.2.16, the separate scrolling conversation showed your messages and completed replies;
terminal work stays in Chats. **Speak replies** uses installed Windows voices,
without an API key. Settings → Voice selects the voice and automatic speaking.
The conversation microphone sends local Whisper dictation directly to Alpha.
GPT-Live remains available when its API configuration is present. Microphone and
speaker access depend on Windows permissions and the selected audio devices.

**What I've learned** stores reusable preferences and corrections locally. You
can add, edit or forget them. Alpha includes these lessons in future coordinator
turns and coding handoffs; live voice picks them up on its next connection.
This improves retained context and behavior, not the underlying model weights.
The editable personality encourages curiosity, useful suggestions and candid
discussion of tradeoffs.

**Tools → Common agents** opens reusable roles for Workspace upkeep, build
verification, release preparation, web deployment, research and Rust Windows
engineering. Alpha observes completed task requests, recognizes repeated work
across projects and maintains versioned instructions from failure feedback.
Additional roles require evidence from three tasks across two projects. You
can run, disable, revise or roll back a role and exclude projects. A completed
turn remains unverified until its result is accepted. Automatic maintenance
can update role definitions; it cannot launch project work, publish or install.
**Tools → Alpha health** shows observed request timings and problems with a
proposed next step. Questions from Alpha and agent chats share the Questions area.

Workspace projects can define managed tools with **Start**, **Stop**, readiness
state and **Launch** controls. Alpha stops only processes it owns and identifies;
externally observed services remain visible without being claimed as managed.
Tool definitions and project-specific commands stay in the Workspace registry.

In **Help → Check for Updates → Resume work after restarting**, save a note for an
existing Codex conversation. On the next launch, Alpha resumes that exact native
conversation with the note once. Status distinguishes dispatch, observed resume
and a completed reply. An uncertain launch does not repeatedly replay the note.

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
installation can update through Help → Check for Updates; live laptop review follows that update.

## 0.2.12

The Alpha sidebar tab adds a generated textured 3D android head, animated
circuit board, speech-driven jaw motion, work-state lighting and local face
tracking. Camera use stops when the tab is hidden or disabled. The transparent
render of this head is now the Alpha application and project icon, including
its document tabs. Questions also recognizes asynchronous Codex prompts.
Build and isolated UI checks passed. Actual laptop movement, working-state
lights and live speech can be reviewed after updating the active installation.

## Fixed application identity (0.2.20)

Alpha's application mark is a solid blue square with a filled white brain,
independent of theme or voice persona. The canonical vector is
`public/identity/alpha.svg`. It uses MessageCraft's flat `#0F68F0` blue;
Alpha uses square corners and a larger brain silhouette for small-size clarity.
Theme artwork and the 3D head remain available separately.

Run `npm run icons:generate` after editing the vector. The installed Tauri CLI
renders the existing Windows PNG/ICO and bundle assets; the generator includes
16, 20, 24, 32, 40, 48, 64, 128 and 256 px Windows ICO frames. In-app branding and
the favicon use the same vector. Native window/taskbar, tray, shortcut and MSI
references use the generated bundle icons. `scripts/render-alpha-icon.mjs` is
retained only for historical head/presence artwork, not application identity.

Verify with `node desktop/service/test/app-identity-ui.mjs` after `npm run build`.
The fixture reviews small sizes and theme invariance without launching the
installed application. After `cargo build --manifest-path src-tauri/Cargo.toml`,
run `powershell -NoProfile -File scripts/verify-alpha-native-icon.ps1` to compare
the Windows Shell-extracted executable icon with its generated ICO frame. Installed Shell/taskbar caches still need review after
an authorized update; source assets are not evidence of installation.

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
runs the authoritative full checks and builds the installer on main (and checks
pull requests/manual CI separately). A matching `vX.Y.Z` tag promotes only the
immutable artifact from successful main push CI for that exact commit; it does
not rebuild or repeat service/UI/Rust tests. Publication rechecks artifact
provenance, archive and MSI hashes, product version, installer structure and
the public update manifest. Missing, failed, mismatched or expired evidence
refuses publication. See [release procedure](docs/releasing.md).

The source now builds a per-machine WiX MSI with the standard welcome, install
folder and finish wizard, like ContactCraft and SolidCraft. Tauri builds this
MSI with WiX v3; those projects use WiX v5. The published
0.2.14 installer remains NSIS. Its updater only accepts NSIS, so the 0.2.15
tag publishes both formats and serves an NSIS bridge to older installations.
That bridge has an MSI-aware updater; a later MSI release can
then remove the old NSIS app without deleting its Workspace or settings.
The main-branch workflow now builds MSI only, and future release manifests
point to MSI.
Direct MSI installation requires uninstalling the old NSIS app first. Fresh
MSI installs ask for the Workspace folder on first launch. Local Whisper setup
runs during MSI installation and can be retried with its packaged script.

Product source and assets live here. Personal Workspace records, CLI logins
and runtime state are excluded from the repository. License and provenance
details are in [LICENSE](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md).
