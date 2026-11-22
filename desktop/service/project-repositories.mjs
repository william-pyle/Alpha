import { githubRepository } from './github-repository.mjs';
export { githubRepository };
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, rmdir, realpath, rename, readFile } from 'node:fs/promises';
import path from 'node:path';
import { readJson, saveJson, within } from './util.mjs';
import { assertSafePath, safeProjectPaths, assertPrivateProjectRoot } from './project-layout.mjs';

const exec = promisify(execFile);
export const PROJECT_REPOSITORY_OWNER = 'william-pyle';
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const samePath = (a, b) => process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
const present = async target => { try { return await lstat(target); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };

async function checkoutPathWithoutAliases(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || /[\x00-\x1f\x7f]/.test(directory)) fail('The recorded checkout must be an absolute local directory.');
  const resolved = path.resolve(directory);
  for (let ancestor = resolved; ; ancestor = path.dirname(ancestor)) {
    const info = await lstat(ancestor);
    if (info.isSymbolicLink()) fail('Checkout migration cannot use symbolic links or junctions.', 409);
    if (path.dirname(ancestor) === ancestor) break;
  }
  if (!samePath(await realpath(resolved), resolved)) fail('The recorded checkout is a filesystem alias. Resolve its canonical path before migration.', 409);
  return resolved;
}

async function inspectStandaloneCheckout(directory) {
  const git = await present(path.join(directory, '.git'));
  if (!git?.isDirectory() || git.isSymbolicLink()) fail('Only a standalone checkout with its own .git directory can be migrated. Linked worktrees and submodules need a separate migration.', 409);
  for (const relative of ['.git/commondir', '.git/objects/info/alternates', '.git/index.lock', '.git/HEAD.lock', '.git/config.lock', '.git/rebase-merge', '.git/rebase-apply', '.git/MERGE_HEAD', '.git/CHERRY_PICK_HEAD', '.git/REVERT_HEAD']) {
    if (await present(path.join(directory, relative))) fail('The checkout has shared Git storage or an unfinished Git operation. Finish or review it before migration.', 409);
  }
  for (const relative of ['.git/worktrees', '.git/modules']) {
    const folder = path.join(directory, relative);
    if (await present(folder) && (await readdir(folder)).length) fail('The checkout has linked worktrees or submodules. Their paths require a separate migration.', 409);
  }
  let count = 0;
  const visit = async (folder, root = false) => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (++count > 100_000) fail('This checkout has more than 100,000 paths. A separate migration review is required; nothing was moved.', 409);
      const name = entry.name.toLowerCase();
      if (name === 'agents.md') fail('The checkout contains AGENTS.md instructions. Adapt its pinned paths and authoring rules in a separate authorized migration.', 409);
      if (entry.isSymbolicLink()) fail('The checkout contains a symbolic link or junction. Review its destinations before migration.', 409);
      if (name === '.gitmodules' || name === '.git' && !root) fail('The checkout contains a nested repository or submodule. A separate migration is required.', 409);
      if (entry.isDirectory()) await visit(path.join(folder, entry.name));
    }
  };
  await visit(directory, true);
}

function creationInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['account', 'name', 'description', 'visibility', 'requestId'].includes(key))) fail('Enter a repository name, visibility and destination account.');
  const { account, name, visibility, requestId } = value;
  const description = value.description ?? '';
  if (account !== PROJECT_REPOSITORY_OWNER) fail(`The destination account must be ${PROJECT_REPOSITORY_OWNER}.`, 403);
  if (typeof name !== 'string' || !/^[a-z\d][a-z\d._-]{0,99}$/i.test(name) || name.endsWith('.git')) fail('Use 1–100 letters, numbers, dots, underscores or hyphens for the repository name, starting with a letter or number.');
  if (typeof description !== 'string' || description.length > 350 || /[\x00-\x1f\x7f]/.test(description)) fail('Keep the optional description to 350 characters on one line.');
  if (!['public', 'private'].includes(visibility)) fail('Choose public or private visibility.');
  if (typeof requestId !== 'string' || !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(requestId)) fail('Reopen the repository dialog to start a new request.');
  return { account, name, description, visibility, requestId };
}

export class ProjectRepositories {
  constructor({ repo, getProject, patchProject, changed = () => {}, execute = exec, activeSessions = () => [] }) {
    this.repo = path.resolve(repo); this.getProject = getProject; this.patchProject = patchProject; this.changed = changed; this.execute = execute;
    this.activeSessions = activeSessions;
    this.jobs = new Map(); this.tasks = new Map(); this.locks = new Map();
  }
  async command(file, args, options = {}) {
    const environment = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GH_PROMPT_DISABLED: '1' };
    if (file === 'git') for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG']) delete environment[key];
    try {
      return await this.execute(file, args, { cwd: this.repo, windowsHide: true, timeout: file === 'git' ? 10 * 60_000 : 30_000, maxBuffer: 2 * 1024 * 1024, env: environment, ...options });
    } catch (error) {
      // CLI errors may contain credential-bearing remotes or environment details.
      // Retain only a small classification, never stderr or the full command.
      const missing = file === 'gh' && /(?:HTTP\s+404|\b404\s+Not Found)/i.test(String(error.stderr || error.message));
      const detail = error.code === 'ENOENT' ? `${file === 'gh' ? 'GitHub CLI' : 'Git'} is not available.` : error.killed || error.code === 'ETIMEDOUT' ? `${file === 'gh' ? 'GitHub' : 'Git'} operation timed out.` : `${file === 'gh' ? 'GitHub request' : 'Git operation'} failed. Check authentication, network access and local folder permissions, then retry.`;
      throw Object.assign(new Error(detail), { status: missing ? 404 : 502, upstreamNotFound: missing });
    }
  }
  async api(endpoint, args = []) {
    const { stdout } = await this.command('gh', ['api', '--hostname', 'github.com', endpoint, ...args]);
    try { return JSON.parse(stdout); } catch { fail('GitHub returned an unreadable response; no dependent operation was performed.', 502); }
  }
  async account() {
    const user = await this.api('user');
    if (!user || typeof user.login !== 'string' || !user.id) fail('The authenticated GitHub account could not be verified.', 502);
    return { account: user.login, eligible: user.login === PROJECT_REPOSITORY_OWNER, requiredAccount: PROJECT_REPOSITORY_OWNER, verifiedAt: new Date().toISOString() };
  }
  async verify(url, { allowMissing = false } = {}) {
    const parsed = githubRepository(url);
    let value;
    try { value = await this.api(`repos/${parsed.fullName}`); }
    catch (error) { if (allowMissing && error.upstreamNotFound) return null; throw error; }
    const canonical = githubRepository(value?.html_url || '');
    if (!value?.id || typeof value.owner?.login !== 'string' || typeof value.private !== 'boolean' || value.full_name !== canonical.fullName || value.owner.login !== canonical.owner) fail('GitHub repository identity could not be verified.', 502);
    if (value.owner.login !== PROJECT_REPOSITORY_OWNER) fail(`This repository belongs to ${value.owner.login}. Only ${PROJECT_REPOSITORY_OWNER} repositories can be used as a working repository. Keep it in Source repository for read-only reference.`, 403);
    return { id: value.id, fullName: value.full_name, owner: value.owner.login, url: canonical.url, private: value.private === true, verifiedAt: new Date().toISOString() };
  }
  async jobFile(id) {
    safeProjectPaths(this.repo, id);
    const file = path.join(this.repo, '.alpha', 'project-repositories', `${id}.json`);
    await assertSafePath(this.repo, file, { allowMissing: true });
    return file;
  }
  async persist(job) {
    const file = await this.jobFile(job.projectId);
    await mkdir(path.dirname(file), { recursive: true });
    await assertSafePath(this.repo, file, { allowMissing: true });
    const saved = { ...job, updatedAt: new Date().toISOString() };
    await saveJson(file, saved);
    this.jobs.set(job.projectId, saved);
    try { this.changed(structuredClone(saved)); } catch { /* A UI subscriber cannot undo durable state. */ }
    return saved;
  }
  async state(id) {
    await this.getProject(id);
    let job = this.jobs.get(id);
    if (!job) job = await readJson(await this.jobFile(id), null);
    if (!job) return null;
    if (job.projectId !== id || !['associate', 'create'].includes(job.kind)) fail('Repository recovery state is invalid. Files were preserved.', 409);
    if (['queued', 'running'].includes(job.status) && !this.tasks.has(id)) {
      job = await this.persist({ ...job, status: 'interrupted', phase: 'Retry available', error: 'The previous operation was interrupted. Its files and remote repository, if created, were preserved. Retry to verify and continue.' });
      await this.patchProject(id, { repositoryState: 'interrupted', repositoryError: job.error });
    }
    this.jobs.set(id, job);
    return structuredClone(job);
  }
  lock(id, action) {
    safeProjectPaths(this.repo, id);
    const result = (this.locks.get(id) || Promise.resolve()).catch(() => {}).then(action);
    this.locks.set(id, result.catch(() => {}));
    return result;
  }
  async checkoutPreflight(id, { allowExisting = false } = {}) {
    const project = await this.getProject(id), paths = safeProjectPaths(this.repo, id);
    for (const candidate of [project.checkoutPath, project.workingCheckout]) {
      if (candidate && !samePath(candidate, paths.github)) fail(`This project already uses a checkout at ${candidate}. It has been preserved. Resolve its migration before creating another checkout.`, 409);
    }
    await assertSafePath(this.repo, paths.github, { allowMissing: true });
    // A working checkout must never enclose the private project or be nested in
    // an outer checkout. A .git file also denotes a checkout/worktree boundary.
    for (let ancestor = paths.root; ; ancestor = path.dirname(ancestor)) {
      if (await present(path.join(ancestor, '.git'))) fail('The project location is inside another Git checkout. Choose a separate private Workspace before associating a repository.', 409);
      if (path.dirname(ancestor) === ancestor) break;
    }
    const info = await present(paths.github);
    if (info && !info.isDirectory()) fail('The project github location is occupied by a file. It has been preserved.', 409);
    if (info && !allowExisting) fail('The project github folder already exists. Associate its repository or resolve the existing checkout before creating a remote repository.', 409);
    return { project, paths, exists: !!info };
  }
  async checkoutMigrationFile(id) {
    safeProjectPaths(this.repo, id);
    const file = path.join(this.repo, '.alpha', 'checkout-migrations', `${id}.json`);
    await assertSafePath(this.repo, file, { allowMissing: true });
    return file;
  }
  async checkoutMigrationGuards(id, project, from, to, actual) {
    const paths = await assertPrivateProjectRoot(this.repo, id);
    await assertSafePath(this.repo, to, { allowMissing: true });
    if (project.checkoutPinned) fail('The project checkout is explicitly pinned. A separate owner decision is required before moving it.', 409);
    if (await present(path.join(paths.root, 'AGENTS.md'))) fail('The project has AGENTS.md instructions. Its checkout migration is deferred until those paths and authoring rules are explicitly adapted.', 409);
    if (project.tools?.length) fail('The project has registered tools. Review their working paths in a separate migration.', 409);
    if (!project.projectRepositoryUrl) fail('Associate a verified owned Project repository first. A source-only reference is never moved.', 409);
    if (project.sourceCheckout && (within(path.resolve(project.sourceCheckout), from) || within(path.resolve(project.sourceCheckout), actual))) fail('This checkout is registered as a read-only source reference and cannot be moved.', 403);
    if (within(from, to) || within(to, from)) fail('The old checkout and canonical github folder cannot contain one another.', 409);
    if (this.tasks.has(id)) fail('A repository setup operation is still running. Wait for it before migration.', 409);
    const sessions = await this.activeSessions();
    if (sessions.some(session => (session.open || session.status === 'running') && (session.projectId === id || session.cwd && [from, to].some(folder => within(folder, path.resolve(session.cwd)))))) fail('An open or active session uses this project or checkout. It must remain in place until that session is inactive.', 409);
    await checkoutPathWithoutAliases(actual);
    if (!(await lstat(actual)).isDirectory()) fail('The recorded checkout is not a directory.', 409);
    if (await present(path.join(actual, 'AGENTS.md'))) fail('The checkout has AGENTS.md instructions. Its pinned paths require a separate authorized migration.', 409);
    for (let ancestor = path.dirname(actual); ; ancestor = path.dirname(ancestor)) {
      if (await present(path.join(ancestor, '.git'))) fail('The checkout is nested inside another Git tree. A separate migration is required.', 409);
      if (path.dirname(ancestor) === ancestor) break;
    }
    return paths;
  }
  async verifyMigrationCheckout(project, directory) {
    await inspectStandaloneCheckout(directory);
    const { stdout: top } = await this.command('git', ['-C', directory, 'rev-parse', '--show-toplevel']);
    if (!samePath(top.trim(), directory)) fail('The recorded path is not the Git checkout root. No files were moved.', 409);
    const { stdout: gitDir } = await this.command('git', ['-C', directory, 'rev-parse', '--absolute-git-dir']);
    const { stdout: commonDir } = await this.command('git', ['-C', directory, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
    if (!samePath(gitDir.trim(), path.join(directory, '.git')) || !samePath(commonDir.trim(), path.join(directory, '.git'))) fail('Git metadata is shared with another location. A separate migration is required.', 409);
    const { stdout: worktrees } = await this.command('git', ['-C', directory, 'worktree', 'list', '--porcelain']);
    const registered = worktrees.split(/\r?\n/).filter(line => line.startsWith('worktree ')).map(line => line.slice(9));
    if (registered.length !== 1 || !samePath(registered[0], directory)) fail('The repository has additional or unresolved worktrees. Their paths must be migrated separately.', 409);
    const { stdout: index } = await this.command('git', ['-C', directory, 'ls-files', '--stage'], { maxBuffer: 8 * 1024 * 1024 });
    if (/^160000 /m.test(index)) fail('The Git index contains submodules. Their paths need a separate migration.', 409);
    const { stdout: config } = await this.command('git', ['-C', directory, 'config', '--local', '--null', '--list']);
    if (config.split('\0').some(entry => /^(?:include(?:if\.[^\n]*)?\.path|core\.(?:worktree|hookspath))\n/i.test(entry))) fail('The checkout has local Git include, worktree or hook paths. Review those path dependencies in a separate migration.', 409);
    const { stdout: remote } = await this.command('git', ['-C', directory, 'remote', 'get-url', 'origin']);
    const origin = await this.verify(githubRepository(remote.trim()).url), expected = await this.verify(project.projectRepositoryUrl);
    if (origin.id !== expected.id) fail('The recorded checkout does not match the selected Project repository. No files were moved.', 403);
    const { stdout: pushRemotes } = await this.command('git', ['-C', directory, 'remote', 'get-url', '--push', '--all', 'origin']);
    const destinations = pushRemotes.trim().split(/\r?\n/).filter(Boolean);
    if (!destinations.length) fail('The checkout push destination cannot be verified.', 403);
    for (const destination of destinations) if ((await this.verify(githubRepository(destination).url)).id !== origin.id) fail('The checkout has a different push destination. Review its remotes before migration.', 403);
    return origin;
  }
  async checkoutMigrationPlan(id) {
    const project = await this.getProject(id), paths = safeProjectPaths(this.repo, id);
    const from = typeof project.checkoutPath === 'string' && path.isAbsolute(project.checkoutPath) ? path.resolve(project.checkoutPath) : null;
    let plan = { projectId: id, from, to: paths.github, status: 'deferred', reason: null };
    try {
      const journal = await readJson(await this.checkoutMigrationFile(id), null);
      if (journal && ['prepared', 'renamed'].includes(journal.phase)) {
        if (journal.projectId !== id || journal.to !== paths.github || typeof journal.from !== 'string' || !path.isAbsolute(journal.from) || !from || ![journal.from, journal.to].some(candidate => samePath(candidate, from))) fail('The interrupted checkout migration no longer matches project settings. Review both locations; nothing was overwritten.', 409);
        const oldExists = await present(journal.from), newExists = await present(journal.to);
        if (!oldExists && newExists) {
          plan = { ...plan, from: journal.from, recovery: true };
          await this.checkoutMigrationGuards(id, project, journal.from, journal.to, journal.to);
          const verification = await this.verifyMigrationCheckout(project, journal.to);
          if (verification.id !== journal.repository?.id) fail('Repository identity changed after the interrupted move. Review it before recovery.', 409);
          return { ...plan, status: 'ready', reason: 'The directory move completed. Confirm to finish saving its canonical path; the checkout will not be moved again.', verification };
        }
        if (oldExists && !newExists && journal.phase === 'prepared') { /* Safe to re-plan a move that never happened. */ }
        else fail('Checkout migration recovery found conflicting or missing folders. Both locations were preserved for review.', 409);
      }
      if (!from) fail('No existing checkout path is recorded for this project.', 409);
      if (samePath(from, paths.github)) {
        await assertSafePath(this.repo, paths.github);
        return { ...plan, status: 'current', reason: 'The recorded checkout already uses the canonical github folder.' };
      }
      await this.checkoutMigrationGuards(id, project, from, paths.github, from);
      if (await present(paths.github)) fail('The canonical github folder already exists. No merge, overwrite or duplicate checkout is permitted.', 409);
      let nearestParent = path.dirname(paths.github);
      while (!(await present(nearestParent))) nearestParent = path.dirname(nearestParent);
      if ((await lstat(from)).dev !== (await lstat(nearestParent)).dev) fail('The checkout is on a different filesystem. An atomic move is unavailable; copying or deletion is not performed.', 409);
      const verification = await this.verifyMigrationCheckout(project, from);
      const identity = await lstat(from);
      return { ...plan, status: 'ready', reason: 'Verified owned, inactive standalone checkout. An atomic directory move preserves Git history and uncommitted files.', verification, identity: { dev: identity.dev, ino: identity.ino } };
    } catch (error) { return { ...plan, status: 'deferred', reason: String(error.message || 'Checkout migration could not be verified.') }; }
  }
  async updateCheckoutReferences(id, from, to) {
    const file = path.join(safeProjectPaths(this.repo, id).root, 'project.json');
    await assertSafePath(this.repo, file, { allowMissing: true });
    for (let attempt = 0; attempt < 6; attempt++) {
      const source = await readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (source === null) return [];
      let record; try { record = JSON.parse(source.replace(/^\uFEFF/, '')); } catch { fail('Canonical project.json is invalid. The checkout is preserved at its new path; repair the record before retrying.', 409); }
      if (!record || typeof record !== 'object' || Array.isArray(record)) fail('Canonical project.json must contain a project record. The moved checkout was preserved.', 409);
      const changed = [];
      for (const [container, key, label] of [[record, 'applicationRoot', 'applicationRoot'], [record.source, 'checkout', 'source.checkout'], [record.development, 'sourceFolder', 'development.sourceFolder']]) {
        if (container && typeof container[key] === 'string' && samePath(container[key], from)) { container[key] = to; changed.push(label); }
      }
      if (!changed.length) return [];
      try {
        await saveJson(file, record, { beforeReplace: async () => { await assertSafePath(this.repo, file); if (await readFile(file, 'utf8') !== source) throw Object.assign(new Error('Project metadata changed during migration.'), { code: 'ESTALE' }); } });
        return changed;
      } catch (error) { if (error.code === 'ESTALE' && attempt < 5) continue; throw error; }
    }
    fail('Project metadata is being changed. The checkout is preserved; retry after those changes finish.', 409);
  }
  async migrateCheckout(id, { confirmation } = {}) {
    if (confirmation !== id) fail('Confirm the exact project ID before moving its local checkout.');
    return this.lock(id, async () => {
      const plan = await this.checkoutMigrationPlan(id);
      if (plan.status !== 'ready') return plan;
      const project = await this.getProject(id), file = await this.checkoutMigrationFile(id);
      let journal = plan.recovery ? await readJson(file, null) : { projectId: id, from: plan.from, to: plan.to, repository: plan.verification, phase: 'prepared', createdAt: new Date().toISOString() };
      if (!plan.recovery) {
        await saveJson(file, journal);
        // The parent holds its project launch/migration lock; inspect sessions
        // and paths again immediately before the sole filesystem mutation.
        await this.checkoutMigrationGuards(id, project, plan.from, plan.to, plan.from);
        if (await present(plan.to)) fail('The canonical github folder appeared during migration. Both locations were preserved.', 409);
        const identity = await lstat(plan.from);
        if (identity.dev !== plan.identity.dev || identity.ino !== plan.identity.ino) fail('The recorded checkout directory changed during migration. Nothing was moved.', 409);
        const current = await this.getProject(id);
        if (!current.checkoutPath || !samePath(current.checkoutPath, plan.from) || current.projectRepositoryUrl !== project.projectRepositoryUrl || current.checkoutPinned) fail('Project checkout settings changed during migration. Nothing was moved.', 409);
        await mkdir(path.dirname(plan.to), { recursive: true });
        await assertSafePath(this.repo, plan.to, { allowMissing: true });
        try { await rename(plan.from, plan.to); }
        catch { fail('The atomic checkout move could not complete. The original directory was preserved; no copy or deletion was attempted.', 409); }
        journal = { ...journal, phase: 'renamed', movedAt: new Date().toISOString() };
        await saveJson(file, journal);
      }
      // A failure after rename deliberately leaves a durable recovery receipt.
      // Never roll back over a folder another process may have recreated.
      const verification = await this.verifyMigrationCheckout(project, plan.to);
      if (verification.id !== plan.verification.id) fail('Repository identity changed after the directory move. The checkout was preserved for review.', 409);
      const references = await this.updateCheckoutReferences(id, plan.from, plan.to);
      journal = { ...journal, repository: verification, updatedReferences: [...new Set([...(journal.updatedReferences || []), ...references])] };
      await saveJson(file, journal);
      const operation = await this.state(id);
      await this.patchProject(id, { checkoutPath: plan.to, repositoryState: 'ready', repositoryError: null, repositoryVerification: verification });
      const result = { ...journal, phase: 'committed', status: 'applied', recovery: !!plan.recovery, completedAt: new Date().toISOString() };
      await saveJson(file, result);
      if (operation?.kind === 'associate' && operation.remote?.id === verification.id) await this.persist({ ...operation, status: 'completed', phase: 'Working repository moved to canonical folder', checkoutPath: plan.to, remote: verification, error: null, completedAt: result.completedAt });
      return result;
    });
  }
  async validateWorkingDirectory(id, cwd) {
    // Resuming a retained conversation must not reassign or discard its removed
    // project reference. Legacy unassigned sessions keep their original null ID.
    const project = id ? await this.getProject(id, { allowRemoved: true }) : {}, paths = safeProjectPaths(this.repo, id || 'conversations');
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || /[\x00-\x1f\x7f]/.test(cwd)) fail('Choose an existing absolute working folder.');
    const directory = path.resolve(cwd);
    if (!(await present(directory))?.isDirectory()) fail('The working folder is not a directory.');
    if (project.sourceCheckout && within(path.resolve(project.sourceCheckout), directory)) fail('The source checkout is a read-only reference. Choose the verified project repository.', 403);
    if (within(paths.github, directory) && project.repositoryState !== 'ready') fail('The project checkout is not ready. Resolve its repository operation before starting work there.', 409);
    let boundary = null;
    for (let ancestor = directory; ; ancestor = path.dirname(ancestor)) {
      const info = await lstat(ancestor);
      if (info.isSymbolicLink()) fail('A working folder cannot pass through a symbolic link or junction.', 403);
      const git = await present(path.join(ancestor, '.git'));
      if (!boundary && git) {
        if (git.isSymbolicLink()) fail('The Git metadata directory is a symbolic link. Verify the checkout before using it.', 403);
        boundary = ancestor;
      }
      if (path.dirname(ancestor) === ancestor) break;
    }
    if (!boundary) return { cwd: directory, repository: null };
    const { stdout: top } = await this.command('git', ['-C', directory, 'rev-parse', '--show-toplevel']);
    if (!samePath(top.trim(), boundary)) fail('The Git working directory could not be verified.', 403);
    const { stdout: remote } = await this.command('git', ['-C', directory, 'remote', 'get-url', 'origin']);
    const verified = await this.verify(githubRepository(remote.trim()).url);
    if (project.projectRepositoryUrl) {
      const expected = await this.verify(project.projectRepositoryUrl);
      if (verified.id !== expected.id) fail('This checkout does not match the selected project repository. Choose its verified working checkout.', 403);
    } else if (project.sourceRepositoryUrl) {
      const source = githubRepository(project.sourceRepositoryUrl);
      let original;
      try { original = await this.api(`repos/${source.fullName}`); }
      catch { fail('The source repository identity could not be resolved. Associate a verified owned Project repository before starting work in this checkout.', 403); }
      if (!original?.id || original.id === verified.id) fail('The source repository is a read-only reference. Associate a verified owned Project repository before starting work there.', 403);
    }
    const { stdout: pushRemotes } = await this.command('git', ['-C', directory, 'remote', 'get-url', '--push', '--all', 'origin']);
    const destinations = pushRemotes.trim().split(/\r?\n/).filter(Boolean);
    if (!destinations.length) fail('The checkout has no verifiable push destination.', 403);
    for (const destination of destinations) {
      const target = await this.verify(githubRepository(destination).url);
      if (target.id !== verified.id) fail('The checkout has a different push destination. Review its remotes before starting work there.', 403);
    }
    return { cwd: directory, repository: verified };
  }
  async associate(id, input) {
    return this.lock(id, async () => {
      if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.keys(input).length || Object.keys(input).some(key => !['projectRepositoryUrl', 'sourceRepositoryUrl'].includes(key))) fail('Save the project repository and/or source repository URL.');
      const patch = {};
      if (Object.hasOwn(input, 'sourceRepositoryUrl')) patch.sourceRepositoryUrl = githubRepository(input.sourceRepositoryUrl, { optional: true })?.url || '';
      if (!Object.hasOwn(input, 'projectRepositoryUrl')) return { project: await this.patchProject(id, patch), job: await this.state(id) };
      if (this.tasks.has(id)) fail('A repository operation is already running. Wait for its result before changing the working repository.', 409);
      const requested = githubRepository(input.projectRepositoryUrl, { optional: true });
      if (!requested) {
        patch.projectRepositoryUrl = ''; patch.repositoryState = 'unassociated'; patch.repositoryVerification = null; patch.repositoryError = null;
        // Clearing the association never deletes the checkout or its provenance.
        return { project: await this.patchProject(id, patch), job: await this.state(id) };
      }
      const verified = await this.verify(requested.url);
      // Association is durable even if a pinned or partial checkout prevents
      // cloning. The background job exposes that conflict without duplicating it.
      const project = await this.patchProject(id, { ...patch, projectRepositoryUrl: verified.url, repositoryVerification: verified, repositoryState: 'pending', repositoryError: null });
      const job = await this.launch({ projectId: id, kind: 'associate', requestId: randomUUID(), repositoryUrl: verified.url, remote: verified, createdAt: new Date().toISOString() });
      return { project, job };
    });
  }
  async create(id, input) {
    const request = creationInput(input);
    return this.lock(id, async () => {
      const previous = await this.state(id);
      if (previous?.kind === 'create' && previous.requestId === request.requestId) {
        if (JSON.stringify(previous.request) !== JSON.stringify(request)) fail('This request ID belongs to different repository details. Reopen the dialog for a new request.', 409);
        if (previous.status === 'completed' || this.tasks.has(id)) return { job: previous };
        return { job: await this.launch(previous) };
      }
      if (this.tasks.has(id)) fail('A repository operation is already running.', 409);
      const { project } = await this.checkoutPreflight(id);
      if (project.projectRepositoryUrl) fail('This project already has a working repository. Creation is available only while the project repository field is blank.', 409);
      return { job: await this.launch({ projectId: id, kind: 'create', requestId: request.requestId, request, repositoryUrl: `https://github.com/${request.account}/${request.name}`, createdAt: new Date().toISOString() }) };
    });
  }
  async retry(id) {
    return this.lock(id, async () => {
      const previous = await this.state(id);
      if (!previous) fail('There is no repository operation to retry.', 404);
      if (previous.status === 'completed' || this.tasks.has(id)) return { job: previous };
      if (previous.kind === 'create') creationInput(previous.request); else githubRepository(previous.repositoryUrl);
      return { job: await this.launch(previous) };
    });
  }
  async launch(previous) {
    const id = previous.projectId;
    let job = await this.persist({ ...previous, status: 'queued', phase: 'Queued', error: null });
    const task = Promise.resolve().then(async () => {
      const progress = async (phase, extra = {}) => { job = await this.persist({ ...job, ...extra, status: 'running', phase, error: null }); };
      try {
        await this.patchProject(id, { repositoryState: 'pending', repositoryError: null });
        await progress('Verifying repository and local destination');
        const { project } = await this.checkoutPreflight(id, { allowExisting: previous.kind === 'associate' || !!job.remote });
        if (project.projectRepositoryUrl && githubRepository(project.projectRepositoryUrl).url.toLowerCase() !== githubRepository(job.repositoryUrl).url.toLowerCase()) fail('The working repository changed after this operation started. The previous remote and files have been preserved.', 409);
        if (job.kind === 'create') {
          const request = creationInput(job.request);
          const account = await this.account();
          if (!account.eligible || account.account !== request.account) fail(`Sign in to GitHub CLI as ${PROJECT_REPOSITORY_OWNER} before creating this repository.`, 403);
          const existing = await this.verify(job.repositoryUrl, { allowMissing: true });
          if (existing && !job.remote && !job.remoteCreateAttempted) fail('A repository with this name already exists. Use its URL in Project repository; it was not changed.', 409);
          if (existing && existing.private !== (request.visibility === 'private')) fail('The repository has a different visibility from this creation request. It was preserved; review its GitHub settings before associating it.', 409);
          if (existing) job.remote = existing;
          else {
            if (job.remote) fail('The previously created repository is no longer accessible. It was not recreated; review its GitHub state first.', 409);
            await progress('Creating empty GitHub repository', { remoteCreateAttempted: true });
            await this.api('user/repos', ['--method', 'POST', '-f', `name=${request.name}`, '-f', `description=${request.description}`, '-F', `private=${request.visibility === 'private'}`, '-F', 'auto_init=false']);
            job.remote = await this.verify(job.repositoryUrl);
          }
          await progress('Saving the verified repository association', { remote: job.remote, repositoryUrl: job.remote.url });
        } else job.remote = await this.verify(job.repositoryUrl);
        // Persist the receipt before cloning. Failure here still leaves the receipt
        // in the job journal, so retry never creates a second remote repository.
        await this.patchProject(id, { projectRepositoryUrl: job.remote.url, repositoryVerification: job.remote, repositoryState: 'pending', repositoryError: null });
        await progress('Preparing working checkout');
        const checkout = await this.clone(id, job.remote, progress, job);
        await this.patchProject(id, { checkoutPath: checkout.path, repositoryVerification: checkout.verification, repositoryState: 'ready', repositoryError: null });
        job = await this.persist({ ...job, status: 'completed', phase: 'Working repository ready', remote: checkout.verification, checkoutPath: checkout.path, error: null, completedAt: new Date().toISOString() });
      } catch (error) {
        job = { ...job, status: 'failed', phase: 'Needs attention', error: String(error.message || 'Repository operation failed.').slice(0, 1200), errorStatus: error.status || 500 };
        try { await this.patchProject(id, { repositoryState: 'failed', repositoryError: job.error }); } catch { /* Preserve the job receipt if settings are unavailable. */ }
        try { job = await this.persist(job); } catch { this.jobs.set(id, job); try { this.changed(structuredClone(job)); } catch { /* Original failure remains visible. */ } }
      } finally { this.tasks.delete(id); }
      return structuredClone(job);
    });
    this.tasks.set(id, task);
    return structuredClone(job);
  }
  async clone(id, expected, progress = async () => {}, recovery = {}) {
    const { paths, exists } = await this.checkoutPreflight(id, { allowExisting: true });
    // Fresh metadata is required even when an existing checkout appears to match.
    const verified = await this.verify(expected.url);
    if (verified.id !== expected.id) fail('Repository identity changed. No checkout was changed.', 409);
    if (exists && recovery.cloneAttempted && !recovery.cloneSucceeded) fail('A previous clone left local files in the github folder. They were preserved. Review or move that partial checkout before retrying; no replacement repository was created.', 409);
    let createdDirectory = false;
    if (!exists) {
      // Git's insteadOf settings can rewrite even a verified URL. Resolve the
      // effective destination without contacting it, then verify its metadata.
      const { stdout: effectiveUrl } = await this.command('git', ['ls-remote', '--get-url', `${verified.url}.git`]);
      const effective = await this.verify(githubRepository(effectiveUrl.trim()).url);
      if (effective.id !== verified.id) fail('Git configuration redirects this URL to a different repository. No files were cloned.', 409);
      const hooks = path.join(this.repo, '.alpha', 'project-repository-hooks');
      await assertSafePath(this.repo, hooks, { allowMissing: true });
      await mkdir(hooks, { recursive: true });
      await assertSafePath(this.repo, hooks);
      if ((await readdir(hooks)).length) fail('The repository hook isolation folder is not empty. No files were cloned.', 409);
      await mkdir(paths.root, { recursive: true });
      await assertSafePath(this.repo, paths.github, { allowMissing: true });
      await mkdir(paths.github); createdDirectory = true;
      await assertSafePath(this.repo, paths.github);
      try {
        await progress('Cloning repository into the project github folder', { cloneAttempted: true, cloneSucceeded: false });
        // No source/upstream URL, workspace files, add, commit or push is passed to Git.
        // Empty templates avoid inheriting executable hooks from a user template.
        await this.command('git', ['-c', `core.hooksPath=${hooks}`, '-c', 'protocol.file.allow=never', 'clone', '--template=', '--', `${verified.url}.git`, paths.github]);
        await progress('Clone completed; verifying local checkout', { cloneSucceeded: true });
      } catch (error) {
        // Only remove the empty directory reserved by this operation. Partial
        // checkout content is retained for recovery, never recursively removed.
        await assertSafePath(this.repo, paths.github);
        if (createdDirectory && (await readdir(paths.github)).length === 0) await rmdir(paths.github).catch(() => {});
        throw error;
      }
    }
    await assertSafePath(this.repo, paths.github);
    const gitDir = await present(path.join(paths.github, '.git'));
    if (!gitDir?.isDirectory() || gitDir.isSymbolicLink()) fail('The existing github folder is not a complete standalone checkout. Its files were preserved; resolve the folder conflict before retrying.', 409);
    await assertSafePath(this.repo, path.join(paths.github, '.git'));
    await progress('Verifying checkout identity and preserving existing work');
    const { stdout: top } = await this.command('git', ['-C', paths.github, 'rev-parse', '--show-toplevel']);
    if (!samePath(top.trim(), paths.github)) fail('The github folder is nested inside another checkout. No files were changed.', 409);
    const { stdout: remote } = await this.command('git', ['-C', paths.github, 'remote', 'get-url', 'origin']);
    const origin = await this.verify(githubRepository(remote.trim()).url);
    if (origin.id !== verified.id) fail('The existing checkout belongs to a different repository. Its Git history and local changes were preserved.', 409);
    const { stdout: pushRemotes } = await this.command('git', ['-C', paths.github, 'remote', 'get-url', '--push', '--all', 'origin']);
    const destinations = pushRemotes.trim().split(/\r?\n/).filter(Boolean);
    if (!destinations.length) fail('The checkout has no verifiable origin push destination.', 409);
    for (const destination of destinations) {
      const push = await this.verify(githubRepository(destination).url);
      if (push.id !== verified.id) fail('The checkout has a different push destination. It was preserved; review its remote configuration before using it.', 409);
    }
    return { path: paths.github, verification: origin, reused: exists };
  }
  async wait(id) { await this.tasks.get(id); return this.state(id); }
}
