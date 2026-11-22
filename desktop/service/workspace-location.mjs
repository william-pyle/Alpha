import { access, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rmdir, rm, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandHome, readJson, saveJson, within } from './util.mjs';
import { assertPrivateWorkspaceRoot, assertSafePath, safeProjectPaths } from './project-layout.mjs';
import { parseWorkspaceRegistry, workspaceRegistryFile, validateWorkspaceLayout, cutoverWorkspaceLayout } from './workspace-layout.mjs';

const exists = file => access(file).then(() => true, () => false);
const missing = error => { if (error.code !== 'ENOENT') throw error; return null; };
const folders = ['_shared', 'projects', 'knowledge', 'processes', 'inbox'];
const copyExcluded = name => name === path.join('.alpha', 'runtime.json') || name === path.join('.alpha', 'updates');
const copyDeferred = reason => new Error(`Copy current Workspace is deferred: ${reason} Use the project's reviewed migration flow or open the existing Workspace. No checkout is copied or moved.`);

async function assertCopyableWorkspace(root) {
  await assertPrivateWorkspaceRoot(root);
  await assertSafePath(root, workspaceRegistryFile(root));
  const registry = parseWorkspaceRegistry(await readFile(workspaceRegistryFile(root), 'utf8'));
  const hasCheckout = record => [record.checkoutPath, record.workingCheckout, record.sourceCheckout, record.applicationRoot, record.source?.checkout, record.development?.sourceFolder, record.projectRepositoryUrl].some(value => typeof value === 'string' && value.trim());
  for (const project of registry.entities) {
    if (!project || typeof project !== 'object') throw copyDeferred('a project record could not be verified.');
    if (hasCheckout(project)) throw copyDeferred(`project ${project.id || '(unknown)'} has a registered repository or checkout.`);
    const projectPaths = safeProjectPaths(root, project.id);
    await assertSafePath(root, projectPaths.github, { allowMissing: true });
    if (await lstat(projectPaths.github).catch(missing)) throw copyDeferred(`project ${project.id} has a github folder that must not be duplicated.`);
    const recordFile = path.join(projectPaths.root, 'project.json');
    await assertSafePath(root, recordFile, { allowMissing: true });
    const source = await readFile(recordFile, 'utf8').catch(missing);
    if (source !== null) {
      let record; try { record = JSON.parse(source.replace(/^\uFEFF/, '')); } catch { throw copyDeferred(`project ${project.id} has unreadable canonical metadata.`); }
      if (!record || typeof record !== 'object' || Array.isArray(record)) throw copyDeferred(`project ${project.id} has invalid canonical metadata.`);
      if (hasCheckout(record)) throw copyDeferred(`project ${project.id} records an existing checkout.`);
    }
  }
  for (const [folder, complete] of [['project-migrations', item => ['committed', 'rolled-back'].includes(item.phase)], ['checkout-migrations', item => item.phase === 'committed'], ['project-repositories', item => item.status === 'completed' && !item.checkoutPath]]) {
    const directory = path.join(root, '.alpha', folder);
    await assertSafePath(root, directory, { allowMissing: true });
    const entries = await readdir(directory, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) throw copyDeferred(`the ${folder} recovery directory has unrecognized state.`);
      const file = path.join(directory, entry.name); await assertSafePath(root, file);
      let item; try { item = JSON.parse(await readFile(file, 'utf8')); } catch { throw copyDeferred(`the ${folder} recovery state is unreadable.`); }
      if (!item || !complete(item)) throw copyDeferred(`an unfinished ${folder} operation or retained checkout needs review.`);
    }
  }
  // Also catch an unregistered/partly cloned repository before creating a
  // staging directory. Old copy code must never duplicate Git metadata.
  const inspect = async (relative = '') => {
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      const name = path.join(relative, entry.name);
      if (copyExcluded(name)) continue;
      if (entry.isSymbolicLink()) throw new Error(`The Workspace contains a linked file or folder: ${name}. Copy it manually or choose Open existing Workspace.`);
      if (entry.name.toLowerCase() === '.git') throw copyDeferred(`a Git checkout exists at ${relative || 'the Workspace root'}.`);
      if (entry.isDirectory()) await inspect(name);
    }
  };
  await inspect();
}
export async function canonicalFolder(value) {
  if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f]/.test(value)) throw new Error('Choose an absolute Workspace folder.');
  const expanded = expandHome(value.trim());
  if (!path.isAbsolute(expanded)) throw new Error('Choose an absolute Workspace folder.');
  const absolute = path.resolve(expanded);
  if (absolute === path.parse(absolute).root) throw new Error('Choose a dedicated folder, not the root of a drive.');
  const suffix = []; let parent = absolute;
  while (!(await lstat(parent).catch(missing))) {
    const next = path.dirname(parent);
    if (next === parent) throw new Error('The Workspace drive or share is unavailable. Choose an available location.');
    suffix.unshift(path.basename(parent)); parent = next;
  }
  const actual = await realpath(parent);
  if (!(await lstat(actual)).isDirectory()) throw new Error('The Workspace path must be a folder.');
  return path.join(actual, ...suffix);
}
async function emptyDestination(root) {
  const info = await lstat(root).catch(missing);
  if (info && (!info.isDirectory() || (await readdir(root)).length)) throw new Error('Choose a new or empty folder. Existing files will not be overwritten.');
}
async function initialize(root) {
  if (await exists(workspaceRegistryFile(root))) return validateWorkspaceLayout(root);
  await emptyDestination(root);
  for (const folder of folders) await mkdir(path.join(root, folder), { recursive: true });
  // Never replace a registry created by another process.
  await writeFile(path.join(root, 'workspace.json'), '{"entities":[]}\n', { flag: 'wx' });
  return root;
}
async function checkedTarget(value, protectedRoots = []) {
  const root = await canonicalFolder(value);
  for (const protectedRoot of protectedRoots.filter(Boolean)) {
    const protectedPath = await canonicalFolder(protectedRoot);
    if (within(protectedPath, root) || within(root, protectedPath)) throw new Error('Choose a Workspace folder separate from Alpha application and configuration files.');
  }
  await assertPrivateWorkspaceRoot(root);
  return root;
}
async function validateChange(from, target, mode, protectedRoots) {
  if (!['copy', 'existing'].includes(mode)) throw new Error('Choose Copy current Workspace or Open existing Workspace.');
  const source = await canonicalFolder(from), destination = await checkedTarget(target, protectedRoots);
  if (within(source, destination) || within(destination, source)) throw new Error('Choose a separate folder, outside the current Workspace and its parents.');
  if (mode === 'copy') { await validateWorkspaceLayout(source); await assertCopyableWorkspace(source); await emptyDestination(destination); }
  else await validateWorkspaceLayout(destination);
  return { source, destination, mode };
}
async function copyTree(source, destination, relative = '') {
  for (const entry of await readdir(path.join(source, relative), { withFileTypes: true })) {
    const name = path.join(relative, entry.name);
    // These are disposable connection/update files, not saved user content.
    if (copyExcluded(name)) continue;
    if (entry.isSymbolicLink()) throw new Error(`The Workspace contains a linked file or folder: ${name}. Copy it manually or choose Open existing Workspace.`);
    if (entry.name.toLowerCase() === '.git') throw copyDeferred(`a Git checkout appeared at ${relative || 'the Workspace root'}.`);
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
  await assertCopyableWorkspace(source);
  await assertPrivateWorkspaceRoot(destination);
  const parent = path.dirname(destination); await mkdir(parent, { recursive: true });
  const stage = await mkdtemp(path.join(parent, '.alpha-workspace-'));
  try {
    await copyTree(source, stage);
    await rebaseReferences(stage, source, destination);
    await validateWorkspaceLayout(stage);
    await assertCopyableWorkspace(source);
    await assertCopyableWorkspace(stage);
    await cutoverWorkspaceLayout(stage);
    await assertPrivateWorkspaceRoot(destination);
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
    if (pending.completed === true) {
      selected = await validateWorkspaceLayout(await checkedTarget(pending.destination, blocked));
      if (pending.mode === 'copy') await assertCopyableWorkspace(selected);
    }
    else {
      const change = await validateChange(pending.source, pending.destination, pending.mode, blocked);
      if (change.mode === 'copy') await copyWorkspace(change.source, change.destination);
      selected = change.destination;
      await saveJson(pendingFile, { ...change, completed: true });
    }
  } else if (saved) {
    // Keep older AppData workspaces and never silently replace an unavailable one.
    selected = await canonicalFolder(saved);
    if (!await lstat(selected).catch(missing)) throw new Error('The saved Workspace is unavailable. Reconnect its drive or select another Workspace.');
  } else {
    if (legacyRoot && await exists(workspaceRegistryFile(legacyRoot))) selected = await validateWorkspaceLayout(await canonicalFolder(legacyRoot));
    else selected = await initialize(await checkedTarget(defaultRoot, blocked));
  }
  await cutoverWorkspaceLayout(selected);
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
