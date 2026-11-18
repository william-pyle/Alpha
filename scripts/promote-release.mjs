import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const artifactName = 'Alpha-Windows-installer';
export function releaseVersion(tag) {
  assert.match(tag, /^v\d+\.\d+\.\d+$/, 'Expected a stable vMAJOR.MINOR.PATCH tag');
  return tag.slice(1);
}
export function selectMainRun(runs, { sha, repositoryId, workflowId }) {
  assert.match(sha, /^[a-f0-9]{40}$/);
  const matching = runs.filter(run => run.head_sha === sha && run.head_branch === 'main' && run.event === 'push' && run.workflow_id === workflowId)
    .sort((a, b) => b.run_number - a.run_number || b.run_attempt - a.run_attempt);
  const run = matching[0];
  assert.ok(run, 'No authoritative main push run for the exact tagged commit');
  assert.equal(run.head_repository?.id, repositoryId, 'CI came from a different repository');
  assert.equal(run.status, 'completed', 'Exact-commit main CI is not complete');
  assert.equal(run.conclusion, 'success', 'Latest exact-commit main CI did not succeed');
  return run;
}
export function selectArtifact(artifacts, run, repositoryId) {
  const matching = artifacts.filter(artifact => artifact.name === artifactName);
  assert.equal(matching.length, 1, 'Expected one immutable installer artifact');
  const artifact = matching[0], origin = artifact.workflow_run;
  assert.equal(artifact.expired, false, 'Installer artifact expired');
  assert.equal(origin?.id, run.id, 'Artifact belongs to another workflow run');
  assert.equal(origin.head_sha, run.head_sha, 'Artifact commit differs from tagged commit');
  assert.equal(origin.head_branch, 'main', 'Artifact is not from main');
  assert.equal(origin.repository_id, repositoryId, 'Artifact repository differs');
  assert.equal(origin.head_repository_id, repositoryId, 'Artifact originated in a fork');
  assert.match(artifact.digest, /^sha256:[a-f0-9]{64}$/, 'Artifact lacks a SHA-256 digest');
  return artifact;
}
export function verifyArchive(bytes, artifact) {
  assert.equal('sha256:' + createHash('sha256').update(bytes).digest('hex'), artifact.digest, 'Downloaded artifact digest differs from GitHub evidence');
}
export function verifyInstaller(bytes, manifest, { tag, repository }) {
  const version = releaseVersion(tag), name = `Alpha-${version}-windows-x64.msi`;
  assert.equal(manifest.version, version, 'Manifest version differs from tag');
  assert.equal(manifest.platform, 'windows-x64');
  assert.equal(manifest.url, `https://github.com/${repository}/releases/download/${tag}/${name}`, 'Unexpected installer URL');
  assert.ok(bytes.length > 0, 'Empty installer');
  assert.equal(manifest.bytes, bytes.length, 'Installer size differs from manifest');
  assert.equal(manifest.sha256, createHash('sha256').update(bytes).digest('hex'), 'Installer checksum differs from manifest');
  return { version, name, bytes: bytes.length, sha256: manifest.sha256 };
}
export function verifyReleaseMetadata(release, evidence, installer) {
  assert.equal(release.tag_name, evidence.tag); assert.equal(release.draft, false); assert.equal(release.prerelease, false);
  assert.deepEqual(release.assets.map(item => item.name).sort(), [installer.name, 'alpha-update.json'].sort());
  const asset = release.assets.find(item => item.name === installer.name);
  assert.equal(asset.size, installer.bytes); assert.equal(asset.digest, 'sha256:' + installer.sha256);
  return asset;
}
async function github(route) {
  const response = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}${route ? '/' + route : ''}`, {
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${process.env.GH_TOKEN}`, 'X-GitHub-Api-Version': '2022-11-28' },
  });
  assert.ok(response.ok, `GitHub ${route}: HTTP ${response.status}`);
  return response.json();
}
async function gate(tag, directory) {
  const version = releaseVersion(tag), repository = process.env.GITHUB_REPOSITORY;
  assert.equal(repository, 'william-pyle/Alpha', 'Publication is only supported from the authoritative repository');
  let object = (await github(`git/ref/tags/${encodeURIComponent(tag)}`)).object;
  for (let depth = 0; object.type === 'tag' && depth < 5; depth++) object = (await github(`git/tags/${object.sha}`)).object;
  assert.equal(object.type, 'commit', 'Tag does not resolve to a commit');
  const sha = object.sha, repo = await github(''), workflow = await github('actions/workflows/windows.yml');
  const product = await github(`contents/package.json?ref=${sha}`);
  assert.equal(JSON.parse(Buffer.from(product.content, 'base64').toString('utf8')).version, version, 'Tag/product version mismatch');
  const runs = [];
  for (let page = 1; page <= 10; page++) {
    const batch = await github(`actions/workflows/${workflow.id}/runs?branch=main&event=push&head_sha=${sha}&per_page=100&page=${page}`);
    runs.push(...batch.workflow_runs);
    if (runs.length >= batch.total_count) break;
    assert.ok(page < 10, 'Too many CI runs to establish unambiguous provenance');
  }
  const run = selectMainRun(runs, { sha, repositoryId: repo.id, workflowId: workflow.id });
  const artifacts = await github(`actions/runs/${run.id}/artifacts?per_page=100`);
  assert.ok(artifacts.total_count <= 100, 'Too many artifacts to establish unambiguous provenance');
  const artifact = selectArtifact(artifacts.artifacts, run, repo.id);
  const response = await fetch(`https://api.github.com/repos/${repository}/actions/artifacts/${artifact.id}/zip`, {
    redirect: 'manual', headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json' },
  });
  assert.equal(response.status, 302, 'GitHub did not provide an artifact download');
  const location = response.headers.get('location'); assert.equal(new URL(location).protocol, 'https:');
  // Never forward the GitHub token to the signed storage URL.
  const download = await fetch(location); assert.ok(download.ok, `Artifact download HTTP ${download.status}`);
  const archive = Buffer.from(await download.arrayBuffer()); verifyArchive(archive, artifact);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'artifact.zip'), archive);
  const evidence = { tag, version, repository, sourceSha: sha, mainRunId: run.id, mainRunAttempt: run.run_attempt, mainRunUrl: run.html_url, artifactId: artifact.id, artifactDigest: artifact.digest, checkedAt: new Date().toISOString() };
  await writeFile(path.join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `source-sha=${sha}\nmain-run-id=${run.id}\nartifact-id=${artifact.id}\ntag=${tag}\n`);
  console.log(JSON.stringify(evidence));
}
async function verify(directory) {
  const evidence = JSON.parse(await readFile(path.join(directory, 'evidence.json'), 'utf8'));
  const name = `Alpha-${releaseVersion(evidence.tag)}-windows-x64.msi`, folder = path.join(directory, 'unpacked');
  assert.deepEqual((await readdir(folder)).sort(), [name, 'alpha-update.json'].sort(), 'Unexpected files in installer artifact');
  const manifest = JSON.parse(await readFile(path.join(folder, 'alpha-update.json'), 'utf8'));
  const result = verifyInstaller(await readFile(path.join(folder, name)), manifest, evidence);
  await writeFile(path.join(directory, 'verified.json'), JSON.stringify({ ...evidence, ...result }, null, 2) + '\n');
  console.log(JSON.stringify({ ...evidence, ...result }));
}
async function verifyPublished(directory) {
  const evidence = JSON.parse(await readFile(path.join(directory, 'verified.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(path.join(directory, 'unpacked/alpha-update.json'), 'utf8'));
  const release = await github(`releases/tags/${evidence.tag}`);
  const asset = verifyReleaseMetadata(release, evidence, evidence);
  const manifestAsset = release.assets.find(item => item.name === 'alpha-update.json');
  const get = async url => { const response = await fetch(url); assert.ok(response.ok, `Public download HTTP ${response.status}`); return Buffer.from(await response.arrayBuffer()); };
  const publicManifest = await get(manifestAsset.browser_download_url);
  assert.equal(publicManifest.length, manifestAsset.size);
  assert.equal('sha256:' + createHash('sha256').update(publicManifest).digest('hex'), manifestAsset.digest);
  assert.deepEqual(JSON.parse(publicManifest), manifest);
  verifyInstaller(await get(asset.browser_download_url), manifest, evidence);
  await writeFile(path.join(directory, 'published.json'), JSON.stringify({ ...evidence, releaseUrl: release.html_url, publicAssetsVerifiedAt: new Date().toISOString() }, null, 2) + '\n');
  console.log(`Public installer and manifest verified: ${release.html_url}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [command, argument, directory = '.release-evidence'] = process.argv.slice(2);
  if (command === 'gate') await gate(argument, directory);
  else if (command === 'verify') await verify(argument || '.release-evidence');
  else if (command === 'verify-public') await verifyPublished(argument || '.release-evidence');
  else throw new Error('Usage: promote-release.mjs gate vX.Y.Z [directory] | verify [directory]');
}
