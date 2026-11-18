import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { artifactName, releaseVersion, selectMainRun, selectArtifact, verifyArchive, verifyInstaller, verifyReleaseMetadata } from '../promote-release.mjs';
const sha = 'a'.repeat(40), other = 'b'.repeat(40), expected = { sha, repositoryId: 10, workflowId: 20 };
const run = { id: 30, run_number: 4, run_attempt: 1, head_sha: sha, head_branch: 'main', event: 'push', workflow_id: 20, head_repository: { id: 10 }, status: 'completed', conclusion: 'success' };
const bytes = Buffer.from('synthetic MSI bytes'), digest = createHash('sha256').update(bytes).digest('hex');
const artifact = { id: 40, name: artifactName, expired: false, digest: 'sha256:' + digest, workflow_run: { id: 30, head_sha: sha, head_branch: 'main', repository_id: 10, head_repository_id: 10 } };
const tag = 'v0.2.20', repository = 'william-pyle/Alpha';
const manifest = { version: '0.2.20', platform: 'windows-x64', url: `https://github.com/${repository}/releases/download/${tag}/Alpha-0.2.20-windows-x64.msi`, bytes: bytes.length, sha256: digest };
test('stable version tags only', () => {
  assert.equal(releaseVersion(tag), '0.2.20');
  for (const invalid of ['main', 'v0.2.20/../x', 'v0.2.20;echo bad', 'v0.2.20\n', 'v0.2.20-rc1']) assert.throws(() => releaseVersion(invalid));
});
test('exact successful main commit is accepted', () => assert.equal(selectMainRun([run], expected), run));
test('missing and mismatched commits cannot borrow success', () => {
  assert.throws(() => selectMainRun([], expected));
  assert.throws(() => selectMainRun([{ ...run, head_sha: other }], expected));
});
test('failed, pending, cancelled and skipped runs refuse publication', () => {
  for (const conclusion of ['failure', 'cancelled', 'skipped', null]) assert.throws(() => selectMainRun([{ ...run, conclusion }], expected));
  assert.throws(() => selectMainRun([{ ...run, status: 'in_progress' }], expected));
});
test('wrong branch, event, workflow and fork cannot authorize publication', () => {
  for (const change of [{ head_branch: 'feature' }, { event: 'workflow_dispatch' }, { event: 'pull_request' }, { workflow_id: 21 }, { head_repository: { id: 11 } }]) assert.throws(() => selectMainRun([{ ...run, ...change }], expected));
});
test('newer failed evidence is not hidden by older success on the same SHA', () => {
  assert.throws(() => selectMainRun([run, { ...run, id: 31, run_number: 5, conclusion: 'failure' }], expected));
});
test('one immutable artifact from the selected exact run is accepted', () => assert.equal(selectArtifact([artifact], run, 10), artifact));
test('missing, ambiguous, expired or digest-less artifacts refuse publication', () => {
  for (const items of [[], [artifact, { ...artifact, id: 41 }], [{ ...artifact, expired: true }], [{ ...artifact, digest: null }]]) assert.throws(() => selectArtifact(items, run, 10));
});
test('artifact run, SHA, branch and both repository identities are checked', () => {
  for (const change of [{ id: 31 }, { head_sha: other }, { head_branch: 'feature' }, { repository_id: 11 }, { head_repository_id: 11 }]) assert.throws(() => selectArtifact([{ ...artifact, workflow_run: { ...artifact.workflow_run, ...change } }], run, 10));
});
test('downloaded archive must match the GitHub artifact digest', () => {
  verifyArchive(bytes, artifact); assert.throws(() => verifyArchive(Buffer.concat([bytes, Buffer.from('corrupted')]), artifact));
});
test('tested MSI bytes and manifest must match tag and release destination', () => {
  assert.equal(verifyInstaller(bytes, manifest, { tag, repository }).sha256, digest);
  for (const change of [{ version: '0.2.19' }, { platform: 'other' }, { url: 'https://example.test/installer.msi' }, { bytes: bytes.length + 1 }, { sha256: 'f'.repeat(64) }]) assert.throws(() => verifyInstaller(bytes, { ...manifest, ...change }, { tag, repository }));
  assert.throws(() => verifyInstaller(Buffer.alloc(0), manifest, { tag, repository }));
});
test('publication retains package checks without rerunning or rebuilding full suites', async () => {
  const workflow = (await readFile(new URL('../../.github/workflows/windows.yml', import.meta.url), 'utf8')).replaceAll('\r', '');
  const release = workflow.slice(workflow.indexOf('  release:\n'));
  assert.match(workflow, /if: github.ref_type != 'tag'/);
  assert.match(workflow, /node --test scripts\/test\/promote-release.test.mjs/);
  assert.match(release, /promote-release.mjs gate/); assert.match(release, /promote-release.mjs verify/);
  assert.match(release, /test-installer-msi.ps1/); assert.match(release, /Get-AuthenticodeSignature/);
  assert.doesNotMatch(release, /npm (?:ci|test|run)|cargo test|tauri build/);
});

test('published assets must retain verified version, bytes and hashes', () => {
  const installer = verifyInstaller(bytes, manifest, { tag, repository });
  const release = { tag_name: tag, draft: false, prerelease: false, assets: [{ name: installer.name, size: bytes.length, digest: 'sha256:' + digest }, { name: 'alpha-update.json' }] };
  verifyReleaseMetadata(release, { tag }, installer);
  for (const change of [{ tag_name: 'v0.2.19' }, { draft: true }, { prerelease: true }, { assets: [] }, { assets: [{ ...release.assets[0], digest: 'sha256:' + 'f'.repeat(64) }, release.assets[1]] }]) assert.throws(() => verifyReleaseMetadata({ ...release, ...change }, { tag }, installer));
});
