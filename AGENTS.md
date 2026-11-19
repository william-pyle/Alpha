# Alpha source

## Repository ownership preflight

Before changes or pushes, verify the actual repository owner using GitHub
repository metadata, including the intended destination before remote writes.
Only `william-pyle` repositories are eligible for changes within the authorized
task. Local folder names, clone locations, remote spelling and write access do
not prove ownership. Unknown or unverifiable ownership stops dependent writes
and must be reported.

Other owners are research-only: no source edits, issues, comments, PRs or pushes.
CraftLauncher and CraftWiki (`storytold`), SolidCraft (`tangency-labs`) and CraftLib
(`storytold`) are research-only. Do not resume their implementation through common
agents, project-local fallback or alternate checkouts. Source paths identify
research material, not permission to edit it. Alpha's authorized central inventory
and global guidance may record research without changing those source repositories.

This is Alpha's authoritative application checkout. Project records and the
current six-tab report live in `C:/Projects/AlphaWorkspace/projects/alpha/`.
Read that project's `AGENTS.md` before changing Alpha or preparing a release.

## Release sequence

Finish source, version, documentation and workflow changes before tagging.
If a transition needs special behavior for one tag, configure it on the final
pre-release commit rather than pushing a cleanup commit after publication.
Use a successful main-branch run on that exact commit as the pre-tag gate.
Tag publication reuses that immutable CI artifact without rebuilding or repeating
full suites; retain provenance, installer/manifest integrity and public verification. Do not manually
repeat a green full UI suite.

After publication, check the release, installer bytes, update manifest and
Workspace report. Do not add a source commit solely to finish release
housekeeping or wait through its automatic CI to declare the prior release
complete. Treat later source changes and their CI as separate work.
