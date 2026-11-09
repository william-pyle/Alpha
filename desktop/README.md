# Alpha desktop architecture

Alpha forks the MrMak 0.5.1 desktop workflow. A Tauri shell opens Workspace and
Chats webviews, backed by one authenticated loopback Node service. Each chat uses
its own native PTY, saved history and selected permission setting.

Application themes share one persisted setting across both surfaces. Standard
report reading appearance remains independent of artwork and custom report styles.
Desktop dictation is retained; phone pairing, its gateway and mobile UI are removed.

The update service checks the william-pyle/Alpha GitHub release feed. Only a newer
stable Windows x64 manifest from that repository is accepted. Download and restart
are explicit user actions. The installer is verified by SHA-256 on download and
again before native handoff. The native dialog reports running terminals before
launching the NSIS installer with /P /R /UPDATE and quitting Alpha.

Build and install instructions are in the root README.md. Original license notices
are retained in LICENSE and THIRD_PARTY_NOTICES.md.
