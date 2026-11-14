# Alpha desktop architecture

Alpha forks the MrMak 0.5.1 desktop workflow. A Tauri shell opens Workspace and
Chats webviews, backed by one authenticated loopback Node service. Each chat uses
its own native PTY, saved history and selected permission setting.

Chats includes a multiline message editor below the terminal. Enter inserts a
new line, Ctrl+Enter sends, and the Send button does the same. Drafts are saved
locally per chat until the local service accepts delivery. The terminal remains
interactive above the editor.

Card category definitions live in the selected Workspace's
`workspace/workspace.json` as `categories` records with stable ID, display name
and icon. The Categories control in Workspace adds, edits and deletes them;
deleting a used category moves its cards to a chosen replacement. Older
Workspace files are read with compatible defaults and save definitions on the
next card or category change.

Application themes share one persisted setting across both surfaces. Standard
report reading appearance remains independent of artwork and custom report styles.
Desktop dictation is retained; phone pairing, its gateway and mobile UI are removed.

The update service checks the william-pyle/Alpha GitHub release feed shortly after
startup and every six hours. An available update appears in both windows. Only a newer
stable Windows x64 manifest from that repository is accepted. Download and restart
are explicit user actions. The installer is verified by SHA-256 on download and
again before native handoff. The native dialog reports running terminals before
launching the NSIS installer with /P /R /UPDATE and quitting Alpha.

Build and install instructions are in the root README.md. Original license notices
are retained in LICENSE and THIRD_PARTY_NOTICES.md.
