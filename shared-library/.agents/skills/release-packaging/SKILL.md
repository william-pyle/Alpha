---
name: release-packaging
description: Prepare or change application installers, release packages, update manifests and distribution workflows. Use when a project is building or migrating a package, or preparing a release; follow that project's own release rules for exact commands and names.
---

# Release packaging

First apply [repository ownership preflight](../../../processes/repository-ownership.md).
Verify actual GitHub ownership before changes or handoffs requesting changes.
Only `william-pyle` repositories are eligible. Other owners are research-only:
no edits, issues, comments, PRs or pushes. Unknown ownership stops dependent writes.
Recheck the actual destination before remote writes. Local folders, permissions
and project agents cannot override this boundary.

Read the active project's instructions and release documentation before changing packaging. Identify the authoritative source, current installer, supported platforms, install scope, upgrade identity, asset names, signing state and update path. Keep product-specific commands and identifiers in that project.

When changing an installer, trace a full update from the currently published version: how the old install is found or removed, where the new files go, what happens to shortcuts and pinned entries, and which user data or settings must survive. Check interactive and unattended paths separately. Preserve stable package identifiers and release asset names unless the migration explicitly changes them and all consumers are updated together.

Build packages from the same version and source as the application. Verify that each artifact contains its expected binaries and resources, runs from an installed location, and can be upgraded and uninstalled without removing user data. Test the installer metadata or a disposable install when feasible; do not use an active application session as the test target. Record what was actually built and tested, including any platform or toolchain gap.

A source edit, successful build or uploaded artifact is not a published release or an installed update. Follow the project's release process for versioning, checksums, signing, publication and post-release verification. Do not publish, sign, install over an active session, or change a remote unless that action is authorized by the task and project rules.

## Timing and artifact promotion

Audit actual CI job and step durations before optimizing. Trace nested build hooks:
a package command may rebuild a frontend that an earlier step already built and
tested. Prefer building once, then testing and packaging those same bytes. Retain
all required security, quality, installer, signing and platform checks; measure
the resulting run before claiming a speed improvement.

Finish source, version, workflow and documentation changes before tagging. Where
the project supports promotion, require a successful trusted main-branch run on
the exact tag commit and reuse its immutable artifact. Verify workflow identity,
source SHA, artifact identity/digest, installer and manifest integrity, required
signing and public bytes. Tags must not rebuild or repeat a green full UI suite.
Use the project's stricter signing policy when one exists.

After publication, verify the release, download bytes, update manifest and project
report. Do not add a source commit solely for release housekeeping or wait for a
later commit's CI to declare an earlier release complete. Later changes are
separate work. Preserve installed library overrides; ship revised defaults through
the normal library merge rather than overwriting local files.

Before an authorized host update, coordinate readiness through the host with all
affected active workers. Save durable checkpoints and exact native conversation
IDs, then prepare continuation notes through supported host controls. Verify
publication, installation, the running version and actual continuation separately.
Do not replay an uncertain install or submission. If native verification fails
because of Computer Use transport, follow
[bounded recovery](../../../processes/computer-use-recovery.md); a completed
release or worker turn does not establish native acceptance.
