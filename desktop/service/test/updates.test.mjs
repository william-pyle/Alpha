import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { Updates, newerVersion } from '../updates.mjs';
const prefix = 'https://github.com/william-pyle/Alpha/releases/download/v0.3.0/';
async function fixture(overrides = {}) {
  const bytes = Buffer.from('fixture installer bytes'), requests = [], events = [];
  const manifest = { version: '0.3.0', platform: 'windows-x64', url: prefix + 'Alpha-Setup-0.3.0-x64.exe', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), ...overrides };
  const directory = await mkdtemp(path.join(os.tmpdir(), 'alpha-update-'));
  const fetcher = async url => {
    requests.push(url);
    if (url.endsWith('/releases/latest')) return Response.json({ tag_name: 'v0.3.0', draft: false, prerelease: false, assets: [{ name: 'alpha-update.json', browser_download_url: prefix + 'alpha-update.json' }] });
    if (url.endsWith('.json')) return Response.json(manifest);
    return new Response(bytes);
  };
  return { updater: new Updates({ directory, version: '0.2.0', fetcher, native: event => events.push(event), activeCount: () => 2 }), requests, events };
}
test('stable version comparison rejects downgrades and prereleases', () => {
  assert.equal(newerVersion('0.3.0', '0.2.0'), true);
  for (const version of ['0.1.2','0.2.0','0.3.0-beta','x']) assert.equal(newerVersion(version, '0.2.0'), false);
});
test('updates require explicit download and installation; downloaded bytes are verified again before native handoff', async () => {
  const { updater, requests, events } = await fixture();
  assert.equal((await updater.check()).status, 'available');
  assert.equal(requests.length, 2); assert.equal(events.length, 0);
  await assert.rejects(updater.install(true));
  assert.equal((await updater.download()).status, 'downloaded');
  assert.equal(requests.length, 3); assert.equal(events.length, 0);
  await assert.rejects(updater.install(false));
  await updater.install(true); assert.equal(events.length, 1); assert.equal(events[0].activeCount, 2);
  await writeFile(updater.file, 'modified');
  await assert.rejects(updater.install(true), /changed/); assert.equal(events.length, 1);
});
test('untrusted URLs and mismatched installer hashes never reach installation', async () => {
  const badUrl = await fixture({ url: 'https://example.com/setup.exe' });
  assert.equal((await badUrl.updater.check()).status, 'error'); assert.equal(badUrl.requests.length, 2);
  const badHash = await fixture({ sha256: '0'.repeat(64) });
  await badHash.updater.check(); assert.equal((await badHash.updater.download()).status, 'error');
  assert.equal(badHash.events.length, 0);
});
test('simultaneous checks and downloads share one operation', async () => {
  const { updater, requests } = await fixture();
  await Promise.all([updater.check(), updater.check()]); assert.equal(requests.length, 2);
  await Promise.all([updater.download(), updater.download()]); assert.equal(requests.length, 3);
});
