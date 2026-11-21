import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { lstat, readdir, readFile, mkdir, rename, rm } from 'node:fs/promises';
import { safeProjectPaths, assertSafePath, assertPrivateWorkspaceRoot, CONVERSATIONS_PROJECT } from './project-layout.mjs';
import { readJson, saveJson, within } from './util.mjs';

const fail = (message, status = 409) => { throw Object.assign(new Error(message), { status }); };
const present = file => lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
const ignoredNames = new Set(['.git', '.alpha', '.codex', '.claude', 'node_modules', 'workspace', 'agents', 'media', 'assets']);
const same = (a, b) => path.relative(path.resolve(a), path.resolve(b)) === '';

// The native host measures NTFS allocation, including compression and hardlinks.
// A service without that host must not mislabel logical bytes as size on disk.
export class NativeStorage {
  constructor(send) { this.send = send; this.pending = new Map(); this.capability = null; }
  request(type, data, timeout) {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error('Native disk measurement is unavailable. Open the updated Windows app and retry.')); }, timeout);
      this.pending.set(requestId, { resolve, reject, timer });
      try { this.send({ type, requestId, ...data }); } catch (error) { clearTimeout(timer); this.pending.delete(requestId); reject(error); }
    });
  }
  receive(event) {
    if (!['project-storage-result', 'project-storage-capabilities'].includes(event.type)) return;
    const pending = this.pending.get(event.requestId);
    if (!pending) return;
    clearTimeout(pending.timer); this.pending.delete(event.requestId);
    event.error ? pending.reject(new Error(String(event.error))) : pending.resolve(event);
  }
  async measure(directory) {
    this.capability ||= this.request('project-storage-capabilities', {}, 2500);
    if (!(await this.capability).available) throw new Error('Size on disk requires the Windows desktop app.');
    const value = await this.request('project-storage', { path: directory }, 180_000);
    if (![value.allocatedBytes, value.logicalBytes, value.files, value.errors, value.skippedLinks].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error('Native disk measurement returned invalid totals.');
    return value;
  }
  close() { for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Alpha is closing.')); } this.pending.clear(); }
}

export class ProjectStorage {
  constructor({ repo, projects, repositories, measure, sessions = () => [], tools = async () => [], active = () => false, protectedRoots = [], changed = () => {}, removeTree = rm }) {
    this.repo = path.resolve(repo); this.projects = projects; this.repositories = repositories; this.measure = measure;
    this.sessions = sessions; this.tools = tools; this.active = active; this.protectedRoots = protectedRoots;
    this.changed = changed; this.removeTree = removeTree; this.values = new Map(); this.queue = []; this.running = 0; this.previews = new Map(); this.busy = new Set(); this.blockedProjects = new Set(); this.closed = false;
  }
  async initialize() {
    for (const project of (await this.projects.workspace.registry()).entities) if (project.deletionPending || project.removalScope === 'delete-files') this.blockedProjects.add(project.id);
  }
  async list() {
    const entries = (await this.projects.workspace.registry()).entities.filter(item => !item.removedAt);
    return { projects: await Promise.all(entries.map(item => this.size(item.id))) };
  }
  async size(id, refresh = false) {
    const project = await this.projects.get(id);
    if (project.removedAt) fail('Project has been removed.', 404);
    if (project.deletionPending) return { id, status: 'error', error: 'Project deletion is incomplete. Choose Delete project again to retry.' };
    let current = this.values.get(id);
    if (current && ['queued', 'scanning'].includes(current.status)) return { ...current };
    if (!current || refresh || Date.now() - Date.parse(current.measuredAt) > 15 * 60_000) {
      current = { id, status: 'queued' }; this.values.set(id, current); this.queue.push(id); void this.drain();
    }
    return { ...current };
  }
  async drain() {
    if (this.running >= 2 || this.closed) return;
    const id = this.queue.shift(); if (!id) return;
    this.running++; const scanning = { id, status: 'scanning' }; this.values.set(id, scanning);
    try {
      const root = safeProjectPaths(this.repo, id).root;
      await assertSafePath(this.repo, root);
      const { allocatedBytes, logicalBytes, files, skippedLinks, errors } = await this.measure(root);
      if (this.values.get(id) === scanning) this.values.set(id, { id, status: errors ? 'error' : 'ready', allocatedBytes, logicalBytes, files, skippedLinks, errors, measuredAt: new Date().toISOString(), ...(errors ? { error: `Measurement was incomplete (${errors} unreadable entries). Retry when disk access is available.` } : {}) });
    } catch (error) { if (this.values.get(id) === scanning) this.values.set(id, { id, status: 'error', measuredAt: new Date().toISOString(), error: error.message }); }
    finally { this.running--; this.changed(); void this.drain(); }
  }
  assertAvailable(id) {
    if (this.busy.has(id)) fail('This project is being cleaned or deleted. Wait for the result before starting work.');
    if (this.blockedProjects.has(id)) fail('This project has a pending or completed local-file deletion. Choose an available project before starting work.');
  }
  async assertUsable(id) {
    if (!id) return;
    const project = await this.projects.get(id);
    if (project.deletionPending || project.removalScope === 'delete-files') this.blockedProjects.add(id);
    this.assertAvailable(id);
  }
  async inactive(id, root, deleting = false) {
    if (this.active(id)) fail('This project has work in progress. Finish or stop it before cleanup.');
    if (this.sessions().some(s => {
      if (!['running', 'starting'].includes(s.status) && s.activity !== 'working') return false;
      if (s.projectId === id) return true;
      if (!s.cwd) return false;
      const cwd = path.resolve(s.cwd);
      return within(root, cwd) || (!s.projectId || s.projectId === CONVERSATIONS_PROJECT) && within(cwd, root);
    })) fail('A running worker uses this project or a parent working folder. Stop its worker before cleaning or deleting local files. Closing a conversation tab only archives it.');
    if ((await this.tools(id)).some(tool => tool.owned || tool.ready || ['running', 'running-external', 'starting', 'preparing', 'stopping'].includes(tool.state))) fail('A project tool is running. Stop it before cleaning or deleting local files.');
    if (deleting && this.protectedRoots.some(folder => folder && within(root, path.resolve(folder)))) fail('This project contains the running Alpha application or its active data. Delete it from another Workspace after shutting this instance down.');
  }
  async validateRoot(id, deleting = false) {
    const project = await this.projects.get(id, { allowRemoved: false }), paths = safeProjectPaths(this.repo, id);
    if (deleting && (id === CONVERSATIONS_PROJECT || project.builtin)) fail('Built-in projects cannot be deleted.', 403);
    await assertPrivateWorkspaceRoot(paths.root);
    await assertSafePath(this.repo, paths.root);
    if (!(await lstat(paths.root)).isDirectory()) fail('The project directory is unavailable.');
    if (deleting && project.workspacePath !== paths.workspacePath) fail('Migrate this project to its canonical projects folder before deleting its files.');
    if (project.sourceCheckout && within(paths.root, path.resolve(project.sourceCheckout))) fail('The project contains a read-only source reference. Its files cannot be cleaned or deleted.', 403);
    const job = await this.repositories.state?.(id);
    if (['queued', 'running'].includes(job?.status)) fail('Repository setup is still running. Wait for its result before cleaning or deleting local files.');
    // Another project must never lose a shared directory through this action.
    for (const other of (await this.projects.workspace.registry()).entities) {
      if (other.id === id || other.removedAt) continue;
      for (const folder of [other.checkoutPath, other.sourceCheckout, other.workspacePath && path.resolve(this.repo, other.workspacePath)]) {
        if (folder && within(paths.root, path.resolve(folder))) fail('Another project references this directory. Resolve that shared reference before deleting or cleaning files.');
      }
    }
    await this.inactive(id, paths.root, deleting);
    return { project, ...paths };
  }
  async verifyRepository(directory, deleting = false) {
    await assertSafePath(this.repo, directory);
    const git = await present(path.join(directory, '.git'));
    if (!git || git.isSymbolicLink()) fail('Repository metadata is missing or linked; local files were preserved.');
    const { stdout: top } = await this.repositories.command('git', ['-C', directory, 'rev-parse', '--show-toplevel']);
    if (!same(top.trim(), directory)) fail('Repository boundary does not match the project directory.');
    const { stdout: remote } = await this.repositories.command('git', ['-C', directory, 'remote', 'get-url', 'origin']);
    await this.repositories.verify(remote.trim());
    if (deleting) {
      if (!git.isDirectory()) fail('A linked worktree or submodule requires its own removal workflow.');
      for (const file of ['commondir', 'objects/info/alternates', 'index.lock', 'HEAD.lock', 'config.lock']) if (await present(path.join(directory, '.git', file))) fail('Shared or locked Git storage must be resolved before deleting this project.');
      const { stdout: worktrees } = await this.repositories.command('git', ['-C', directory, 'worktree', 'list', '--porcelain']);
      if (worktrees.split(/\r?\n/).filter(line => line.startsWith('worktree ')).length > 1) fail('The repository has additional worktrees. Remove those through Git before deleting the project.');
    }
  }
  async ignored(repository, directory) {
    const relative = path.relative(repository, directory).split(path.sep).join('/');
    try { await this.repositories.command('git', ['-C', repository, 'check-ignore', '-q', '--', `${relative}/`]); }
    catch { return false; }
    const { stdout } = await this.repositories.command('git', ['--literal-pathspecs', '-C', repository, 'ls-files', '-z', '--', relative]);
    return !stdout;
  }
  async candidates(id, root, deleting = false) {
    const candidates = [], verified = new Set(); let visited = 0;
    const visit = async (directory, repository = null) => {
      if (++visited > 30_000) fail('Project discovery exceeded its directory limit. Narrow the project layout before cleanup.');
      const entries = await readdir(directory, { withFileTypes: true });
      const names = new Set(entries.map(entry => entry.name));
      if (names.has('.git')) {
        await this.verifyRepository(directory, deleting); verified.add(directory); repository = directory;
      }
      for (const entry of entries) {
        const full = path.join(directory, entry.name);
        if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name === '.git') continue;
        let kind = null;
        if (entry.name === 'target' && (names.has('Cargo.toml') || await present(path.join(directory, 'src-tauri/Cargo.toml')))) kind = 'Rust build output';
        if (['build', '.gradle'].includes(entry.name) && (names.has('build.gradle') || names.has('build.gradle.kts') || names.has('settings.gradle') || names.has('settings.gradle.kts'))) kind = 'Gradle build output';
        if (['dist', 'coverage', '.next', '.nuxt', '.svelte-kit', '.turbo'].includes(entry.name) && names.has('package.json')) kind = 'JavaScript build output';
        // These are Alpha/Agent Watch disposable test harness outputs, not generic application caches.
        if (['alpha', 'agent-watch'].includes(id) && ['.test-output', '.cache'].includes(entry.name) && same(directory, path.join(root, 'github'))) kind = 'Disposable test output';
        if (kind && repository && await this.ignored(repository, full)) {
          candidates.push({ path: path.relative(root, full).split(path.sep).join('/'), kind }); continue;
        }
        if (!ignoredNames.has(entry.name) && !['target', 'build', 'dist', '.cache', '.test-output', '.gradle'].includes(entry.name)) await visit(full, repository);
      }
    };
    await visit(root);
    return { candidates, repositories: [...verified] };
  }
  async inventory(directory) {
    // Metadata only. A junction is an entry to unlink, never a directory to traverse.
    const digest = createHash('sha256'); let logicalBytes = 0, files = 0;
    const visit = async folder => {
      const entries = (await readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const full = path.join(folder, entry.name), info = await lstat(full);
        if (entry.name === '.git') throw Object.assign(new Error('Contains a nested Git repository; preserved for separate review.'), { code: 'NESTED_REPOSITORY', status: 409 });
        digest.update(`${path.relative(directory, full)}\0${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.isSymbolicLink()}\n`);
        if (info.isDirectory() && !info.isSymbolicLink()) await visit(full);
        else if (info.isFile()) { logicalBytes += info.size; files++; }
      }
    };
    await visit(directory); return { logicalBytes, files, fingerprint: digest.digest('hex') };
  }
  async cleanupCandidates(id, root) {
    const discovered = await this.candidates(id, root), candidates = [], skipped = [];
    const inspect = async item => {
      const directory = path.join(root, item.path);
      try { candidates.push({ ...item, ...await this.inventory(directory) }); }
      catch (error) {
        if (error.code !== 'NESTED_REPOSITORY') throw error;
        // Split known test-output containers around repositories, preserving the
        // complete checkout and all its files. Never waive a Git boundary.
        if (item.kind !== 'Disposable test output' || await present(path.join(directory, '.git'))) { skipped.push({ path: item.path, reason: error.message }); return; }
        const entries = await readdir(directory, { withFileTypes: true });
        skipped.push({ path: item.path, reason: 'Container retained because it includes a repository. Only the safe subfolders listed below can be cleared; files at this container level remain.' });
        for (const entry of entries) if (entry.isDirectory() && !entry.isSymbolicLink()) {
          const subdirectory = path.join(directory, entry.name);
          // A cache can contain deliberately tracked fixture inputs, too.
          const repository = discovered.repositories.filter(repo => within(repo, subdirectory)).sort((a, b) => b.length - a.length)[0];
          if (repository && await this.ignored(repository, subdirectory)) await inspect({ path: path.relative(root, subdirectory).split(path.sep).join('/'), kind: item.kind });
        }
      }
    };
    for (const item of discovered.candidates) await inspect(item);
    return { candidates, skipped };
  }
  async cleanupPlan(id) {
    const root = safeProjectPaths(this.repo, id).root;
    try {
      await this.validateRoot(id);
      const { candidates, skipped } = await this.cleanupCandidates(id, root);
      const previewToken = randomUUID();
      const plan = { id, root, candidates, skipped, previewToken, expires: Date.now() + 10 * 60_000 };
      for (const [token, old] of this.previews) if (old.id === id || old.expires < Date.now()) this.previews.delete(token);
      this.previews.set(previewToken, plan); return plan;
    } catch (error) { return { id, root, candidates: [], blockedReason: error.message, previewToken: '' }; }
  }
  async clean(id, { confirmation, previewToken } = {}) {
    if (confirmation !== id) fail('Confirm the exact project ID before clearing build folders.', 400);
    const plan = this.previews.get(previewToken);
    if (!plan || plan.id !== id || plan.expires < Date.now()) fail('The cleanup preview expired. Review a fresh preview.');
    this.assertAvailable(id); this.busy.add(id);
    try {
      await this.validateRoot(id);
      const fresh = await this.cleanupCandidates(id, plan.root);
      if (JSON.stringify(fresh) !== JSON.stringify({ candidates: plan.candidates, skipped: plan.skipped })) fail('Build output changed after the preview. Finish the build and review a fresh preview.');
      // Validate the complete set before the first mutation.
      await this.inactive(id, plan.root);
      this.previews.delete(previewToken);
      const removed = []; let logicalBytes = 0;
      for (const item of plan.candidates) {
        const directory = path.join(plan.root, item.path);
        await assertSafePath(plan.root, directory);
        try { await this.removeTree(directory, { recursive: true, force: false, maxRetries: 2, retryDelay: 150 }); }
        catch { this.values.delete(id); fail(`Cleanup stopped at ${item.path}; it may be partly removed or locked. ${removed.length} folders were cleared. Close apps using it and review a fresh preview.`); }
        removed.push(item.path); logicalBytes += item.logicalBytes;
      }
      this.values.delete(id); this.changed();
      return { removed, logicalBytes, message: `Cleared ${removed.length} build folders. The next build will regenerate them. GitHub and source files were retained.` };
    } finally { this.busy.delete(id); }
  }
  async deletionPlan(id) {
    const root = safeProjectPaths(this.repo, id).root;
    try {
      const project = await this.projects.get(id);
      if (project.deletionPending) { await this.pendingDeletion(id, project); return { id, root, retry: true }; }
      await this.validateRoot(id, true); await this.verifyDeletion(id, root); return { id, root };
    }
    catch (error) { return { id, root, blockedReason: error.message }; }
  }
  async verifyDeletion(id, root) {
    const { candidates, repositories } = await this.candidates(id, root, true);
    for (const item of candidates) await this.inventory(path.join(root, item.path));
    const disposable = new Set(candidates.map(item => path.join(root, item.path))), checked = new Set(repositories);
    // Inspect ALL remaining directories, including media/workspace and dependency
    // folders. A foreign or linked checkout anywhere in the deletion tree blocks it.
    const visit = async directory => {
      const entries = await readdir(directory, { withFileTypes: true });
      if (entries.some(entry => entry.name === '.git') && !checked.has(directory)) await this.verifyRepository(directory, true);
      for (const entry of entries) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory() && !entry.isSymbolicLink() && entry.name !== '.git' && !disposable.has(full)) await visit(full);
      }
    };
    await visit(root);
  }
  async pendingDeletion(id, project) {
    if (id === CONVERSATIONS_PROJECT || project.builtin) fail('Built-in projects cannot be deleted.', 403);
    if (!/^[a-f0-9-]{36}$/.test(project.deletionOperation || '')) fail('The deletion recovery record needs review.');
    const root = safeProjectPaths(this.repo, id).root;
    await assertPrivateWorkspaceRoot(root);
    const directory = path.join(this.repo, '.alpha', 'project-deletions', project.deletionOperation);
    await assertSafePath(this.repo, directory);
    const journal = path.join(directory, 'deletion.json'), destination = path.join(directory, 'files');
    const record = await readJson(journal, null);
    if (!record || record.id !== id || record.root !== root || record.destination !== destination || !['prepared', 'removing', 'incomplete'].includes(record.phase)) fail('The deletion recovery paths changed. Preserve these files for review.');
    if (await present(root)) {
      if (record.phase !== 'prepared' || await present(destination)) fail('The deletion recovery paths changed. Preserve these files for review.');
      // A shutdown after durable intent but before rename is safe to retry.
      await assertSafePath(this.repo, root); await this.inactive(id, root, true); await this.verifyDeletion(id, root);
      return { root, destination, journal, operation: project.deletionOperation, prepared: true };
    }
    await assertSafePath(this.repo, destination, { allowMissing: true });
    await this.inactive(id, root, true);
    return { root, destination, journal, operation: project.deletionOperation };
  }
  async deleteProject(id, { confirmation } = {}) {
    if (confirmation !== id) fail('Confirm the exact project ID before deleting local project files.', 400);
    if (this.busy.has(id)) fail('This project already has a storage operation in progress.');
    this.busy.add(id);
    try {
      const project = await this.projects.get(id);
      if (project.deletionPending) {
        const pending = await this.pendingDeletion(id, project);
        if (pending.prepared) await rename(pending.root, pending.destination);
        return await this.finishDeletion(id, pending);
      }
      const { root } = await this.validateRoot(id, true);
      await this.verifyDeletion(id, root);
      await this.inactive(id, root, true);
      // Quarantine first: a lock failure leaves the visible project intact. Keep a
      // durable journal so partial filesystem removal is never reported as success.
      const operation = randomUUID(), directory = path.join(this.repo, '.alpha', 'project-deletions', operation);
      await assertSafePath(this.repo, directory, { allowMissing: true });
      await mkdir(directory, { recursive: true });
      const destination = path.join(directory, 'files'), journal = path.join(directory, 'deletion.json');
      await saveJson(journal, { id, root, destination, phase: 'prepared', at: new Date().toISOString() });
      await assertSafePath(this.repo, root); await assertSafePath(this.repo, destination, { allowMissing: true });
      await this.projects.transaction(registry => {
          const item = registry.entities.find(item => item.id === id);
          if (!item || item.removedAt) fail('Project registration changed during deletion.');
          item.deletionPending = true; item.deletionOperation = operation;
      });
      this.blockedProjects.add(id);
      try { await rename(root, destination); }
      catch { fail('The project directory is locked or unavailable. Close applications using it and choose Delete project again to retry. The project remains listed.'); }
      return await this.finishDeletion(id, { root, destination, journal, operation });
    } finally { this.busy.delete(id); }
  }
  async finishDeletion(id, { root, destination, journal, operation }) {
    await saveJson(journal, { id, root, destination, phase: 'removing', at: new Date().toISOString() });
    try {
      await assertSafePath(this.repo, destination, { allowMissing: true });
      if (await present(destination)) await this.removeTree(destination, { recursive: true, force: false, maxRetries: 2, retryDelay: 150 });
    } catch {
      await saveJson(journal, { id, root, destination, phase: 'incomplete', at: new Date().toISOString() });
      fail(`Deletion is incomplete; locked files remain at ${destination}. Close the locking application, then choose Delete project again to retry. No GitHub repository was deleted.`);
    }
    await this.projects.transaction(registry => {
      const item = registry.entities.find(item => item.id === id);
      if (!item || item.deletionOperation !== operation) fail('Project registration changed during deletion.');
      item.removedAt = new Date().toISOString(); item.removalScope = 'delete-files'; delete item.deletionPending;
    });
    await saveJson(journal, { id, root, destination, phase: 'complete', at: new Date().toISOString() });
    this.values.delete(id); this.changed();
    return { id, scope: 'delete-files', deleted: root, retained: ['GitHub repository', 'conversation histories and stable project references'] };
  }
  close() { this.closed = true; this.queue = []; }
}
