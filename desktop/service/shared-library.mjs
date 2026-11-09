import { readdir, readFile, mkdir, writeFile, lstat, realpath, rename } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { readJson, saveJson, within } from './util.mjs';

export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export function libraryPath(value) {
  return typeof value === 'string' && value.length > 0 && !/[\\:\x00-\x1f]/.test(value) && value.split('/').every(part => part && part !== '.' && part !== '..' && !/[. ]$/.test(part)) && !value.startsWith('/');
}
export async function filesBelow(root, relative = '') {
  const result = [];
  for (const entry of (await readdir(path.join(root, relative), { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Shared library cannot contain links: ${name}`);
    if (entry.isDirectory()) result.push(...await filesBelow(root, name));
    else if (entry.isFile()) result.push(name);
  }
  return result;
}
async function safeDestination(root, relative) {
  if (!libraryPath(relative)) throw new Error('Invalid shared-library path');
  let cursor = root;
  for (const part of relative.split('/')) {
    cursor = path.join(cursor, part);
    const info = await lstat(cursor).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (info?.isSymbolicLink()) throw new Error(`Shared-library path is a link: ${relative}`);
  }
  if (!within(root, cursor)) throw new Error('Shared-library path leaves its root');
  return cursor;
}
async function atomicFile(file, bytes) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = file + '.' + randomUUID() + '.tmp';
  await writeFile(temporary, bytes, { flag: 'wx' });
  await rename(temporary, file);
}
export async function installLibrary(bundle, destination) {
  const manifest = JSON.parse(await readFile(path.join(bundle, 'manifest.json'), 'utf8'));
  if (manifest.format !== 'alpha-shared-library' || manifest.schema !== 1 || !/^\d+\.\d+\.\d+$/.test(manifest.version) || !manifest.files || typeof manifest.files !== 'object') throw new Error('Invalid shared-library manifest');
  // Verify the entire package before changing any installed content.
  const payload = new Map(), names = new Set();
  for (const [name, hash] of Object.entries(manifest.files)) {
    if (!libraryPath(name) || name.startsWith('.alpha-library/') || !/^[a-f0-9]{64}$/.test(hash) || names.has(name.toLowerCase())) throw new Error('Invalid shared-library file');
    names.add(name.toLowerCase());
    const bytes = await readFile(await safeDestination(bundle, name));
    if (digest(bytes) !== hash) throw new Error(`Shared-library checksum mismatch: ${name}`);
    payload.set(name, bytes);
  }
  await mkdir(destination, { recursive: true });
  const root = await realpath(destination);
  const stateFile = await safeDestination(root, '.alpha-library/state.json');
  const previous = await readJson(stateFile, { files: {} });
  const state = { version: manifest.version, files: { ...previous.files }, conflicts: [] };
  let added = 0, updated = 0;
  for (const [name, bytes] of payload) {
    const target = await safeDestination(root, name);
    const current = await readFile(target).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    const prior = previous.files?.[name], incomingHash = manifest.files[name];
    if (current && digest(current) === incomingHash) { state.files[name] = { baseHash: incomingHash }; continue; }
    if ((!current && !prior) || (current && prior?.baseHash === digest(current))) {
      await atomicFile(target, bytes); current ? updated++ : added++;
      state.files[name] = { baseHash: incomingHash }; continue;
    }
    // A local edit or deliberate deletion is kept. Incoming defaults are reviewable.
    const incoming = `.alpha-library/incoming/${manifest.version}/${name}`;
    await atomicFile(await safeDestination(root, incoming), bytes);
    state.files[name] = prior || { baseHash: null };
    state.conflicts.push({ path: name, reason: current ? 'locally-modified' : 'locally-deleted', incoming: path.join(root, incoming) });
  }
  await saveJson(stateFile, state);
  return { root, version: manifest.version, skills: manifest.skills, files: payload.size, added, updated, conflicts: state.conflicts };
}
