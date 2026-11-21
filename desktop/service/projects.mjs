import path from 'node:path';
import { readFile, writeFile, lstat, rename, mkdir } from 'node:fs/promises';
import { saveJson, readJson, within } from './util.mjs';
import { CONVERSATIONS_PROJECT, safeProjectPaths, assertSafePath, assertPrivateProjectRoot, ensureProjectWorkspace, projectWorkspaceDirectory, inspectTree } from './project-layout.mjs';

const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
export class Projects {
  constructor(workspace, { sessions = () => [], threads = () => [], tools = () => [] } = {}) { this.workspace = workspace; this.repo = workspace.repo; this.sessions = sessions; this.threads = threads; this.tools = tools; this.operations = new Map(); }
  exclusive(id, action) {
    const previous = this.operations.get(id) || Promise.resolve();
    const operation = previous.catch(() => {}).then(action);
    this.operations.set(id, operation);
    void operation.finally(() => { if (this.operations.get(id) === operation) this.operations.delete(id); }).catch(() => {});
    return operation;
  }
  async get(id, { allowRemoved = true } = {}) {
    const item = (await this.workspace.registry()).entities.find(item => item.id === id);
    if (!item || (!allowRemoved && item.removedAt)) fail('Project was not found or has been removed.', 404);
    return item;
  }
  transaction(change) {
    const operation = this.workspace.writes.catch(() => {}).then(async () => {
      for (let attempt = 0; attempt < 6; attempt++) {
        const source = await readFile(this.workspace.file, 'utf8'), registry = JSON.parse(source);
        const result = await change(registry);
        try { await saveJson(this.workspace.file, registry, { beforeReplace: async () => { if (await readFile(this.workspace.file, 'utf8') !== source) throw Object.assign(new Error('Project registry changed; retry.'), { code: 'ESTALE' }); } }); }
        catch (error) { if (error.code === 'ESTALE' && attempt < 5) continue; throw error; }
        this.workspace.changed(); return result;
      }
    });
    this.workspace.writes = operation.catch(() => {}); return operation;
  }
  patch(id, patch) {
    return this.transaction(registry => {
      const item = registry.entities.find(item => item.id === id);
      if (!item || item.removedAt) fail('Project was removed. Its files and history are retained.', 409);
      if (Object.keys(patch).some(key => ['id', 'folder', 'workspacePath', 'steps', 'removedAt', 'builtin'].includes(key))) fail('Project identity and workspace cannot be changed through settings.');
      Object.assign(item, patch, { updated: new Date().toISOString().slice(0, 10) }); return item;
    });
  }
  async init() {
    return this.transaction(async registry => {
      const existing = registry.entities.find(item => item.id === CONVERSATIONS_PROJECT);
      if (existing) {
        // A user-created project with the reserved ID is never overwritten.
        if (!existing.builtin) return { defaultProjectConflict: 'The conversations ID is occupied. Rename/migrate this record explicitly before enabling the built-in default.' };
        delete existing.removedAt; existing.status = 'active'; existing.pinned = true;
        await ensureProjectWorkspace(this.repo, existing.id); return existing;
      }
      const paths = await ensureProjectWorkspace(this.repo, CONVERSATIONS_PROJECT);
      const file = path.join(paths.workspace, 'index.html');
      const welcome = '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Conversations</title><style>body{font:16px system-ui;max-width:60rem;margin:3rem auto;padding:1rem;color-scheme:light dark}h1{font-size:2rem}</style><h1>Conversations</h1><p>Your default project for new conversations. Every conversation keeps its own history, draft and workers.</p><p>Choose another project when starting a conversation to keep its work there. Use View → Conversation history to reopen a conversation.</p></html>';
      const previous = await readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (previous !== null && previous !== welcome) fail('An unregistered Conversations workspace already exists. Review it before registering the built-in project.', 409);
      if (previous === null) await writeFile(file, welcome, { flag: 'wx' });
      const day = new Date().toISOString().slice(0, 10);
      const item = { id: CONVERSATIONS_PROJECT, title: 'Conversations', description: 'Your default home for conversations.', builtin: true, pinned: true, type: 'standalone', category: 'other', status: 'active', created: day, updated: day, folder: CONVERSATIONS_PROJECT, workspacePath: paths.workspacePath, steps: [{ name: 'Overview', path: 'index.html' }], defaultStep: 0 };
      registry.entities.push(item); return item;
    });
  }
  async select(id) {
    const item = await this.get(id || CONVERSATIONS_PROJECT, { allowRemoved: false });
    if (!id && !item.builtin) fail('The Conversations default is unavailable because its ID is occupied.', 409);
    return item;
  }
  async workingDirectory(id, requested) {
    const item = await this.get(id);
    // Existing worker cwd is never rewritten. Explicit custom cwd remains an
    // advanced-launch choice, but cannot use the known upstream reference.
    if (requested) {
      if (item.sourceCheckout && within(path.resolve(item.sourceCheckout), path.resolve(requested))) fail('The source repository is a read-only reference. Choose the owned project checkout.');
      return path.resolve(requested);
    }
    if (item.projectRepositoryUrl && item.repositoryState === 'ready' && item.checkoutPath) {
      const paths = safeProjectPaths(this.repo, item.id);
      if (path.resolve(item.checkoutPath) === paths.github && await lstat(paths.github).catch(() => null)) return assertSafePath(this.repo, paths.github);
    }
    return projectWorkspaceDirectory(this.repo, item);
  }
  remove(id, { confirmation, scope } = {}) {
    if (id === CONVERSATIONS_PROJECT) fail('Conversations is built in and cannot be deleted.', 403);
    if (scope !== 'keep-files' || confirmation !== id) fail('Confirm the exact project ID and choose keep-files. This removes the project from the Workspace list only.');
    return this.transaction(registry => {
      const item = registry.entities.find(item => item.id === id);
      if (!item) fail('Project was not found.', 404);
      if (item.builtin) fail('Built-in projects cannot be deleted.', 403);
      item.removedAt ||= new Date().toISOString(); item.removalScope = 'keep-files';
      return { id, removedAt: item.removedAt, scope, retained: ['all local files', 'Git checkout and history', 'remote repository', 'conversation histories', 'active workers', 'stable project reference'], references: this.threads().filter(thread => thread.projectId === id).length };
    });
  }
  async migrationPlan(id) {
    const item = await this.get(id), paths = safeProjectPaths(this.repo, id), record = await readJson(path.join(paths.root, 'project.json'), {});
    const checkout = record.applicationRoot || record.source?.checkout || record.development?.sourceFolder || null;
    let reason = null, from = null;
    try {
      await assertPrivateProjectRoot(this.repo, id);
      const journal = path.join(this.repo, '.alpha', 'project-migrations', `${id}.json`);
      await assertSafePath(this.repo, journal, { allowMissing: true });
      const pending = await readJson(journal, null);
      if (pending?.id === id && pending?.from === path.join(this.repo, 'workspace', item.folder) && pending.to === paths.workspace && pending.phase === 'prepared' && !await lstat(pending.from).catch(() => null) && await lstat(paths.workspace).catch(() => null)) return { id, status: 'recoverable', from: pending.from, to: paths.workspace, reason: 'An interrupted move is journaled. Resume migration to verify and finish registration.' };
      from = await projectWorkspaceDirectory(this.repo, item);
      await assertSafePath(this.repo, paths.workspace, { allowMissing: true });
      if (item.workspacePath === paths.workspacePath) return { id, status: 'current', from, to: paths.workspace, checkout: checkout && { from: checkout, to: paths.github, status: checkout === paths.github ? 'current' : 'deferred', reason: 'Existing source checkout is preserved. A separate explicit migration must verify ownership, instructions and inactive sessions.' } };
      if (path.resolve(from) === path.join(this.repo, 'workspace')) reason = 'Legacy project shares the registry root. Split its explicit files without moving the registry or other projects.';
      if (await lstat(paths.workspace).catch(() => null)) reason = 'Destination exists; no merge or overwrite is permitted.';
      if (this.sessions().some(session => (session.open || session.status === 'running') && (session.projectId === id || within(from, path.resolve(session.cwd || this.repo))))) reason = 'An open or active session uses this project; migration is deferred until it is inactive.';
      if (item.tools?.length) reason = 'Project has registered tools. Stop/migrate their paths explicitly before moving its workspace.';
      // A project-owned authoring script needs its own adaptation. Do not change
      // another project's instructions or silently break the next report render.
      if (await lstat(path.join(paths.root, 'AGENTS.md')).catch(() => null)) reason ||= 'Project has explicit authoring instructions; adapt its renderer and references before applying migration.';
      await inspectTree(this.repo, from);
    } catch (error) { reason = error.message; }
    return { id, status: reason ? 'deferred' : 'ready', from, to: paths.workspace, reason, stableRoutes: (item.steps || []).map((step, index) => ({ route: `#/${id}/${index}`, file: step.path })), checkout: checkout && { from: checkout, to: paths.github, status: 'deferred', reason: 'Preserve pinned/external checkouts, Git history and active sessions. No repository move is automatic.' } };
  }
  migrate(id) { return this.exclusive(id, () => this.applyMigration(id)); }
  async applyMigration(id) {
    const recovered = await this.recoverMigration(id);
    if (recovered) return recovered;
    const plan = await this.migrationPlan(id);
    if (plan.status !== 'ready') return plan;
    const item = await this.get(id), paths = safeProjectPaths(this.repo, id);
    const journal = path.join(this.repo, '.alpha', 'project-migrations', `${id}.json`);
    await assertSafePath(this.repo, journal, { allowMissing: true });
    await saveJson(journal, { ...plan, phase: 'prepared', before: item, at: new Date().toISOString() });
    // One atomic rename preserves contents and filenames. No copies, recursive
    // deletion, cross-volume fallback or repository move is performed.
    await assertSafePath(this.repo, paths.root, { allowMissing: true }); await mkdir(paths.root, { recursive: true });
    // Sessions created through Alpha share the same project lock. Recheck also
    // catches an existing session reopened while the journal was being written.
    if ((await this.migrationPlan(id)).status !== 'ready') return { ...plan, status: 'deferred', reason: 'Project became active or changed during migration preparation; files were not moved.' };
    await rename(plan.from, plan.to);
    try {
      await this.transaction(registry => {
        const current = registry.entities.find(entity => entity.id === id);
        if (JSON.stringify(current) !== JSON.stringify(item)) fail('Project changed during migration. Move was rolled back.', 409);
        current.workspacePath = paths.workspacePath;
        current.legacyWorkspaceFolder = item.folder;
        return current;
      });
    } catch (error) { await rename(plan.to, plan.from); await saveJson(journal, { ...plan, phase: 'rolled-back', error: error.message }); throw error; }
    const result = { ...plan, status: 'applied', phase: 'committed', at: new Date().toISOString(), compatibility: 'Original report URLs and route filenames remain aliases to the single canonical directory.' };
    await saveJson(journal, result); return result;
  }
  async recoverMigration(id) {
    const paths = safeProjectPaths(this.repo, id), journal = path.join(this.repo, '.alpha', 'project-migrations', `${id}.json`);
    await assertSafePath(this.repo, journal, { allowMissing: true });
    const pending = await readJson(journal, null);
    if (!pending || pending.phase !== 'prepared') return null;
    await assertPrivateProjectRoot(this.repo, id);
    const current = await this.get(id);
    if (pending.id !== id || pending.to !== paths.workspace || pending.from !== path.join(this.repo, 'workspace', current.folder)) fail('Migration recovery paths changed. Review the journal; nothing was overwritten.', 409);
    const from = await lstat(pending.from).catch(() => null), to = await lstat(paths.workspace).catch(() => null);
    if (from && !to) return null;
    if (from || !to) fail('Migration recovery found conflicting or missing folders. Both locations were preserved for review.', 409);
    await inspectTree(this.repo, paths.workspace);
    if (!current.workspacePath) await this.transaction(registry => {
      const item = registry.entities.find(entity => entity.id === id);
      if (JSON.stringify(item) !== JSON.stringify(pending.before)) fail('Project metadata changed during interrupted migration. Review before recovery.', 409);
      item.workspacePath = paths.workspacePath; item.legacyWorkspaceFolder = item.folder;
    });
    else if (current.workspacePath !== paths.workspacePath) fail('Migration recovery workspace changed.', 409);
    const result = { ...pending, before: undefined, phase: 'committed', status: 'applied', recovered: true, at: new Date().toISOString() };
    await saveJson(journal, result); return result;
  }
  async contentAlias(file) {
    const relative = path.relative(this.repo, file).replaceAll('\\', '/');
    const item = (await this.workspace.registry()).entities.find(item => item.workspacePath && relative.startsWith(item.workspacePath + '/'));
    return item ? path.join(this.repo, 'workspace', item.folder, relative.slice(item.workspacePath.length + 1)) : file;
  }
  async resolveContent(relative) {
    const normalized = relative.replaceAll('\\', '/');
    if (!normalized.startsWith('workspace/')) return relative;
    const items = (await this.workspace.registry()).entities.filter(item => item.workspacePath).sort((a, b) => b.folder.length - a.folder.length);
    const item = items.find(item => normalized === `workspace/${item.folder}` || normalized.startsWith(`workspace/${item.folder}/`));
    if (!item) return relative;
    const tail = normalized.slice(`workspace/${item.folder}/`.length);
    const root = await projectWorkspaceDirectory(this.repo, item);
    const target = path.resolve(root, tail);
    if (!within(root, target)) fail('Project content path escapes its workspace.', 403);
    await assertSafePath(this.repo, target);
    return path.relative(this.repo, target);
  }
}
