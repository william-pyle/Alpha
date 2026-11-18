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
