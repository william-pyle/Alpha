# Alpha release procedure

Use focused local checks for the code changed during development. Finish source,
version, release notes and workflow changes before tagging. Preserve unrelated
working-tree changes and private Workspace data. Publishing and restarting still
require the current owner's authorization.

Push the final release commit to main. Its Windows workflow is the authoritative
full gate: lint, service tests, all UI scripts, web/native build, Rust tests,
installer structure, packaged runtime and release-manifest generation. The same
run uploads `Alpha-Windows-installer`. Do not manually repeat a green full suite.

Only tag that exact successful commit. Tag publication skips the build job and
uses `scripts/promote-release.mjs` to resolve the annotated/lightweight tag and
require the latest main **push** run for its exact SHA, workflow and repository
to be completed successfully. PR, fork, manual, pending, failed, cancelled and
other-commit evidence cannot authorize a release. A newer failed run is not
hidden by an older success for the same commit.

The publication job downloads the immutable artifact by ID from that run, checks
its repository/branch/SHA/run provenance and SHA-256 archive digest, and verifies
that it contains only the expected MSI and update manifest. It checks the
version, destination URL, byte count, MSI checksum, stable upgrade identity,
installer structure and signing status. Alpha currently permits documented
unsigned MSI packages; invalid signatures fail. Nothing is rebuilt on the tag.
Release notes are read from the tagged commit. After publishing, the job
redownloads and verifies both public assets. Its evidence artifact and job
summary identify the source commit, main run, artifact ID and hashes.

Missing or expired artifacts fail closed; obtain fresh authorized main evidence
instead of silently rebuilding during publication or accepting another SHA.
The optional `release_tag` workflow-dispatch input uses this same gate for an
existing tag; it does not bypass testing. Existing releases are not overwritten,
and a draft left by a failed publication needs inspection before recovery.
Per-tag concurrency prevents overlapping publication jobs without cancelling an
in-progress publication. Keep failed runs visible.

After publication verify delivery and update the private Workspace report. Use
the supported updater only when authorized, saving exact native conversation IDs,
continuation instructions and dispatch state first. Check installed and running
versions separately. Do not add a source cleanup commit merely to finish release
bookkeeping, and do not publish another app version solely for workflow changes.

Focused workflow checks: `node --test scripts/test/promote-release.test.mjs`.
These cover exact-SHA success, refusal cases, artifact provenance and integrity,
public metadata and the no-repeat-suite publication contract. Live artifact
promotion and installed UI behavior are separate observations.

## Workspace root cutover

For 0.2.24, keep the old layout while 0.2.23 is running. After the authorized
session checkpoint, record the selected Workspace root, exact continuation IDs,
and a recoverable copy of the three legacy entries outside either layout. For
the Alpha Workspace these entries are `workspace/workspace.json`,
`workspace/workspace.json.previous` and `workspace/_shared`. Check that
`workspace.json`, `workspace.json.previous` and `_shared` at the root are free.
Close other writers, including report builders, during the cutover.

The upgraded host takes the single-instance lock, validates both layouts, and
moves the entries before starting its service. It journals file identities in
`.alpha/workspace-root-cutover.json`. Matching partial moves resume on the next
launch. Destination collisions, unexpected file types and changed identities
stop startup for review. Keep the journal and both locations intact when
diagnosing a failure. This move requires same-volume hard links for the two
registry files. Workspaces on volumes without hard-link support need an offline,
reviewed move before launching the upgraded host.

After launch, verify the installed and running versions separately. Compare the
registry’s stable project IDs, configured repository associations, six Alpha
report routes and shared asset resolution. Confirm saved histories and exact
worker continuation IDs against the checkpoint. Registry formatting or the
built-in Conversations entry can legitimately change when the service starts.

If rollback requires launching 0.2.23, stop the upgraded host and writers.
Keep a separate copy of the latest root entries and the cutover journal if
present. Resolve any conflicting identities before proceeding. With Alpha
stopped, restore the latest registry, previous copy and shared assets to their
exact legacy paths. Verify the files and report links before starting the old
host. Reuse the latest registry so edits made after cutover are retained. Leave
`projects/` and `.alpha/` conversation state in place. A journal from a
partially completed cutover requires review before retrying either version.
