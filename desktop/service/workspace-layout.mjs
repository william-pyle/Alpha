import path from 'node:path';
import { existsSync } from 'node:fs';
import { lstat, link, readFile, rename, unlink } from 'node:fs/promises';
import { assertSafePath, inspectTree } from './project-layout.mjs';
import { saveJson } from './util.mjs';

const names = ['workspace.json', 'workspace.json.previous', '_shared'];
const legacy = (root, name) => path.join(root, 'workspace', name);
const present = file => lstat(file, { bigint: true }).catch(error => {
  if (error.code !== 'ENOENT') throw error;
  return null;
});
const identity = info => info && [String(info.dev), String(info.ino)].join(':');
const conflict = name => new Error('Workspace layout needs review: ' + name + '. Resolve the conflict with Alpha closed, then reopen it.');

export function workspaceRegistryFile(root) {
  const current = path.join(root, 'workspace.json');
  const previous = legacy(root, 'workspace.json');
  if (existsSync(current) && existsSync(previous)) throw conflict('both registry locations exist');
  return existsSync(previous) ? previous : current;
}

export function workspaceAssetPath(root, relative) {
  const normalized = relative.replaceAll('\\', '/');
  const matched = /^(?:workspace\/)?(_shared(?:\/.*)?|workspace\.json(?:\.previous)?)$/.exec(normalized);
  if (!matched) return null;
  const canonical = matched[1];
  return existsSync(path.join(root, canonical.split('/')[0])) ? canonical : path.join('workspace', canonical);
}

export function parseWorkspaceRegistry(source) {
  const value = JSON.parse(source.replace(/^\uFEFF/, ''));
  if (!Array.isArray(value?.entities)) throw new Error('The selected folder has an invalid Workspace registry.');
  return value;
}

async function layout(root) {
  const journal = path.join(root, '.alpha', 'workspace-root-cutover.json');
  await assertSafePath(root, journal, { allowMissing: true });
  const saved = (await present(journal)) ? JSON.parse(await readFile(journal, 'utf8')) : null;
  if (saved && (saved.version !== 1 || !Array.isArray(saved.moves) || saved.moves.length < 1 ||
      new Set(saved.moves.map(move => move?.name)).size !== saved.moves.length ||
      saved.moves.some(move => !names.includes(move?.name) || !/^\d+:\d+$/.test(move.identity)))) throw conflict('the cutover journal is invalid');

  const moves = [];
  let verified = false;
  for (const name of names) {
    const from = legacy(root, name), to = path.join(root, name);
    await assertSafePath(root, from, { allowMissing: true });
    await assertSafePath(root, to, { allowMissing: true });
    const [source, destination] = await Promise.all([present(from), present(to)]);
    const isDirectory = name === '_shared';
    if ([source, destination].some(info => info && !(isDirectory ? info.isDirectory() : info.isFile()))) throw conflict(name + ' has an unexpected file type');
    const expected = saved?.moves.find(move => move.name === name);
    if (expected) {
      if ((!source && !destination) || [source, destination].some(info => info && identity(info) !== expected.identity) ||
          (source && destination && isDirectory)) throw conflict(name + ' changed during cutover');
      if (source) moves.push({ name, identity: expected.identity, from, to, isDirectory });
    } else if (source) {
      if (destination || saved) throw conflict(name + ' exists in an unexpected legacy location');
      if (isDirectory) await inspectTree(root, from);
      moves.push({ name, identity: identity(source), from, to, isDirectory });
    }
    if (name === 'workspace.json' && (source || destination)) {
      parseWorkspaceRegistry(await readFile(source ? from : to, 'utf8'));
      verified = true;
    }
  }
  if (!verified) throw new Error('Select a Workspace root containing workspace.json (or the legacy workspace/workspace.json).');
  return { journal, saved, moves };
}

export async function validateWorkspaceLayout(root) { await layout(root); return root; }

// Native startup runs this after obtaining Alpha's single-instance lock and
// before launching the service. A copy is cut over in its private staging area.
export async function cutoverWorkspaceLayout(root) {
  const { journal, saved, moves } = await layout(root);
  if (!saved && !moves.length) return root;
  if (!saved) await saveJson(journal, { version: 1, moves: moves.map(({ name, identity }) => ({ name, identity })) });
  for (const { name, identity: expected, from, to, isDirectory } of moves) {
    const source = await present(from), destination = await present(to);
    if (identity(source) !== expected || (destination && identity(destination) !== expected)) throw conflict(name + ' changed during cutover');
    // Hard-link then unlink files so a conflicting destination is never
    // replaced. The journal recognizes both names after a process interruption.
    if (isDirectory) {
      if (destination) throw conflict(name + ' already exists at the root');
      await rename(from, to);
    } else {
      if (!destination) await link(from, to);
      await unlink(from);
    }
  }
  await unlink(journal);
  return root;
}
