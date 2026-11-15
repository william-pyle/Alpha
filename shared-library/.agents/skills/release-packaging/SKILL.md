---
name: release-packaging
description: Prepare or change application installers, release packages, update manifests and distribution workflows. Use when a project is building or migrating a package, or preparing a release; follow that project's own release rules for exact commands and names.
---

# Release packaging

Read the active project's instructions and release documentation before changing packaging. Identify the authoritative source, current installer, supported platforms, install scope, upgrade identity, asset names, signing state and update path. Keep product-specific commands and identifiers in that project.

When changing an installer, trace a full update from the currently published version: how the old install is found or removed, where the new files go, what happens to shortcuts and pinned entries, and which user data or settings must survive. Check interactive and unattended paths separately. Preserve stable package identifiers and release asset names unless the migration explicitly changes them and all consumers are updated together.

Build packages from the same version and source as the application. Verify that each artifact contains its expected binaries and resources, runs from an installed location, and can be upgraded and uninstalled without removing user data. Test the installer metadata or a disposable install when feasible; do not use an active application session as the test target. Record what was actually built and tested, including any platform or toolchain gap.

A source edit, successful build or uploaded artifact is not a published release or an installed update. Follow the project's release process for versioning, checksums, signing, publication and post-release verification. Do not publish, sign, install over an active session, or change a remote unless that action is authorized by the task and project rules.
