import { access, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rmdir, rm, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandHome, readJson, saveJson, within } from './util.mjs';

const exists = file => access(file).then(() => true, () => false);
const missing = error => { if (error.code !== 'ENOENT') throw error; return null; };
const folders = ['workspace', 'projects', 'knowledge', 'processes', 'inbox'];
const registryFile = root => path.join(root, 'workspace/workspace.json');
export async function canonicalFolder(value) {
  if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f]/.test(value)) throw new Error('Choose an absolute Workspace folder.');
  const expanded = expandHome(value.trim());
  if (!path.isAbsolute(expanded)) throw new Error('Choose an absolute Workspace folder.');
  const absolute = path.resolve(expanded);
  if (absolute === path.parse(absolute).root) throw new Error('Choose a dedicated folder, not the root of a drive.');
  const suffix = []; let parent = absolute;
  while (!(await lstat(parent).catch(missing))) { suffix.unshift(path.basename(parent)); parent = path.dirname(parent); }
  const actual = await realpath(parent);
  if (!(await lstat(actual)).isDirectory()) throw new Error('The Workspace path must be a folder.');
  return path.join(actual, ...suffix);
}
async function validWorkspace(root) {
  const file = registryFile(root);
  const registry = JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
  if (!registry || !Array.isArray(registry.entities)) throw new Error('The selected folder has an invalid Workspace registry.');
  return root;
}
async function emptyDestination(root) {
  const info = await lstat(root).catch(missing);
  if (info && (!info.isDirectory() || (await readdir(root)).length)) throw new Error('Choose a new or empty folder. Existing files will not be overwritten.');
}
async function initialize(root) {
  if (await exists(registryFile(root))) return validWorkspace(root);
  await emptyDestination(root);
  for (const folder of folders) await mkdir(path.join(root, folder), { recursive: true });
  // Never replace a registry created by another process.
  await writeFile(registryFile(root), '{"entities":[]}\n', { flag: 'wx' });
  return root;
}
async function checkedTarget(value, protectedRoots = []) {
  const root = await canonicalFolder(value);
  for (const protectedRoot of protectedRoots.filter(Boolean)) {
    const protectedPath = await canonicalFolder(protectedRoot);
    if (within(protectedPath, root) || within(root, protectedPath)) throw new Error('Choose a Workspace folder separate from Alpha application and configuration files.');
  }
  return root;
}
async function validateChange(from, target, mode, protectedRoots) {
  if (!['copy', 'existing'].includes(mode)) throw new Error('Choose Copy current Workspace or Open existing Workspace.');
  const source = await canonicalFolder(from), destination = await checkedTarget(target, protectedRoots);
  if (within(source, destination) || within(destination, source)) throw new Error('Choose a separate folder, outside the current Workspace and its parents.');
  if (mode === 'copy') { await validWorkspace(source); await emptyDestination(destination); }
  else await validWorkspace(destination).catch(() => { throw new Error('Select the Workspace root containing workspace/workspace.json.'); });
  return { source, destination, mode };
}
async function copyTree(source, destination, relative = '') {
  for (const entry of await readdir(path.join(source, relative), { withFileTypes: true })) {
    const name = path.join(relative, entry.name);
    // These are disposable connection/update files, not saved user content.
    if (name === path.join('.alpha', 'runtime.json') || name === path.join('.alpha', 'updates')) continue;
    if (entry.isSymbolicLink()) throw new Error(`The Workspace contains a linked file or folder: ${name}. Copy it manually or choose Open existing Workspace.`);
    const target = path.join(destination, name);
    if (entry.isDirectory()) { await mkdir(target); await copyTree(source, destination, name); }
    else if (entry.isFile()) await copyFile(path.join(source, name), target);
    else throw new Error(`The Workspace contains an unsupported file: ${name}`);
  }
}
async function rebaseReferences(root, source, destination) {
  for (const [name, field] of [['sessions.json', 'cwd'], ['knowledge-sources.json', 'root']]) {
    const file = path.join(root, '.alpha', name);
    if (!(await exists(file))) continue;
    const records = JSON.parse(await readFile(file, 'utf8'));
    if (!Array.isArray(records)) throw new Error(`The saved ${name} list could not be copied safely.`);
    for (const record of records) if (typeof record[field] === 'string' && path.isAbsolute(record[field])) {
      const actual = await realpath(record[field]).catch(() => record[field]);
      if (within(source, actual)) record[field] = path.join(destination, path.relative(source, actual));
    }
    await saveJson(file, records);
  }
}
async function copyWorkspace(source, destination) {
  const parent = path.dirname(destination); await mkdir(parent, { recursive: true });
  const stage = await mkdtemp(path.join(parent, '.alpha-workspace-'));
  try {
    await copyTree(source, stage);
    await rebaseReferences(stage, source, destination);
    await validWorkspace(stage);
    await emptyDestination(destination);
    if (await exists(destination)) await rmdir(destination); // Empty only; never recursive.
    await rename(stage, destination);
  } catch (error) {
    // Remove only this generated staging tree, never the source or destination.
    const actual = await realpath(stage).catch(missing);
    if (actual && path.dirname(actual) === await realpath(parent) && path.basename(actual) === path.basename(stage)) await rm(actual, { recursive: true });
    throw error;
  }
}
// Runs in a short-lived process before the desktop service starts. The previous
// service has stopped, so saved cards, settings and session history are settled.
export async function resolveWorkspace({ configDir, defaultRoot, legacyRoot, supplied, protectedRoots = [] }) {
  const config = path.join(configDir, 'repository.json'), pendingFile = path.join(configDir, 'workspace-change.json');
  const saved = await readJson(config, null), pending = await readJson(pendingFile, null);
  const blocked = [configDir, ...protectedRoots];
  let selected;
  if (supplied) selected = await initialize(await checkedTarget(supplied, blocked));
  else if (pending) {
    if (saved !== pending.source && !(pending.completed && saved === pending.destination)) throw new Error('The saved Workspace changed after this location request. Choose the Workspace again in Settings.');
    // A successful copy with a failed final config write can be retried safely.
    if (pending.completed === true) selected = await validWorkspace(await checkedTarget(pending.destination, blocked));
    else {
      const change = await validateChange(pending.source, pending.destination, pending.mode, blocked);
      if (change.mode === 'copy') await copyWorkspace(change.source, change.destination);
      selected = change.destination;
      await saveJson(pendingFile, { ...change, completed: true });
    }
  } else if (saved) {
    // Keep older AppData workspaces and never silently replace an unavailable one.
    selected = await validWorkspace(await canonicalFolder(saved)).catch(() => { throw new Error('The saved Workspace is unavailable. Reconnect its drive or select another Workspace.'); });
  } else {
    if (legacyRoot && await exists(registryFile(legacyRoot))) selected = await validWorkspace(await canonicalFolder(legacyRoot));
    else selected = await initialize(await checkedTarget(defaultRoot, blocked));
  }
  await saveJson(config, selected);
  await unlink(pendingFile).catch(missing);
  return selected;
}

export class WorkspaceLocation {
  constructor({ repo, configDir, protectedRoots = [], native = () => {}, changed = () => {} }) {
    Object.assign(this, { repo, configDir, protectedRoots, native, changed }); this.pickers = new Map(); this.saving = false;
  }
  async state() { return { available: !!this.configDir, current: this.repo, pending: this.configDir ? await readJson(path.join(this.configDir, 'workspace-change.json'), null) : null }; }
  async set({ path: target, mode }) {
    if (!this.configDir) throw new Error('Workspace location is managed by the installed Alpha application.');
    if (this.saving) throw new Error('A Workspace location change is already being saved.');
    this.saving = true;
    try {
      const change = await validateChange(this.repo, target, mode, [this.configDir, ...this.protectedRoots]);
      const saved = await readJson(path.join(this.configDir, 'repository.json'), null);
      if (saved !== change.source) throw new Error('The saved Workspace differs from this window. Reopen Alpha before changing its location.');
      await saveJson(path.join(this.configDir, 'workspace-change.json'), change);
      const state = await this.state(); this.changed(state); return state;
    } finally { this.saving = false; }
  }
  async cancel() {
    if (!this.configDir || this.saving) throw new Error('Workspace location cannot be changed right now.');
    await unlink(path.join(this.configDir, 'workspace-change.json')).catch(missing);
    const state = await this.state(); this.changed(state); return state;
  }
  browse() {
    if (!this.configDir) throw new Error('The folder picker is available in the installed Alpha application.');
    if (this.pickers.size) throw new Error('A folder picker is already open.');
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pickers.delete(requestId); reject(new Error('The folder picker timed out. You can enter the path directly.')); }, 300000);
      this.pickers.set(requestId, { resolve, reject, timer });
      this.native({ type: 'pick-workspace-folder', requestId, path: this.repo });
    });
  }
  receive(event) {
    if (event.type !== 'workspace-folder-picked') return;
    const picker = this.pickers.get(event.requestId); if (!picker) return;
    clearTimeout(picker.timer); this.pickers.delete(event.requestId);
    picker.resolve({ path: typeof event.path === 'string' ? event.path : null });
  }
  close() { for (const picker of this.pickers.values()) { clearTimeout(picker.timer); picker.reject(new Error('Alpha is closing.')); } this.pickers.clear(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const option = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
  try {
    const configDir = option('--config'); if (!configDir) throw new Error('Workspace configuration directory is missing.');
    const root = await resolveWorkspace({ configDir, defaultRoot: option('--default'), legacyRoot: option('--legacy'), supplied: option('--repo'), protectedRoots: [option('--app-dir')] });
    process.stdout.write(JSON.stringify({ root }) + '\n');
  } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
