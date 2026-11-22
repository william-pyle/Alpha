# Alpha desktop architecture

Alpha uses a Tauri Windows host with a React interface and one authenticated
loopback Node service. Chats and Workspace share one native window. Chats has
a resizable sidebar, terminal and message editor; Workspace, projects, files and
Help use document tabs. The service manages native PTYs, chat history,
Workspace storage, questions and update checks.

The message editor saves drafts per chat. Enter sends and Alt+Enter inserts a
line. Pasted or dropped images are saved in the Workspace inbox and added to
the draft. The shared Questions section routes answers to the chat that asked.

Project categories are stored in the selected Workspace's
`workspace.json` at the Workspace root as stable IDs with names and icons. Settings
contains General, Speech-to-text, Voice, Updates, Theme, MCP, Categories and
Skills. Workspace location remains under General. Theme supports editing the
bundled themes and creating saved color themes with bundled artwork.

The shared library is packaged from `shared-library/` and installed separately
from each Workspace. Project skills take precedence over shared skills with
the same name. The selected Workspace folder and local chat history are kept
across upgrades; provider-managed conversations stay with their own CLIs.

The update service checks the `william-pyle/Alpha` GitHub release feed shortly
after startup and every six hours. It accepts a newer stable Windows x64
manifest from that repository. Download and restart are explicit user actions.
The installer is verified by SHA-256 before native handoff, and the restart
dialog reports active terminals.

Version 0.2.12 added the Alpha sidebar tab with a 3D android presence, local
face tracking, speech-driven mouth movement and circuit activity. A transparent
render of the head is the Alpha app and project icon. Version 0.2.13 holds
brief camera detection gaps, limits sudden head motion and reduces turn range
after observed overshoot on the laptop.

Build and install instructions are in the root README.md. License notices are
retained in LICENSE and THIRD_PARTY_NOTICES.md.
