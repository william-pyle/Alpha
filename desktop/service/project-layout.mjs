import path from 'node:path';
import { lstat, mkdir, realpath, readdir } from 'node:fs/promises';
import { within } from './util.mjs';

export const CONVERSATIONS_PROJECT = 'conversations';
const invalid = (message, status = 400) => Object.assign(new Error(message), { status });
const maybeStat = file => lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
export function projectId(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(value) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(value)) throw invalid('Use a stable project ID containing lowercase letters, numbers and hyphens.');
  return value;
}
export function safeProjectPaths(repo, id) {
  const root = path.join(path.resolve(repo), 'projects', projectId(id));
  return { root, workspace: path.join(root, 'workspace'), github: path.join(root, 'github'), workspacePath: `projects/${id}/workspace` };
}
// Inspect every ancestor before creating anything. realpath containment alone
// accepts links within the root, which could alias a different project's data.
export async function assertSafePath(repo, target, { allowMissing = false } = {}) {
  const base = path.resolve(repo), resolved = path.resolve(target);
  if (!within(base, resolved)) throw invalid('Project path must stay inside the selected Workspace.', 403);
  const parts = path.relative(base, resolved).split(path.sep).filter(Boolean);
  let current = path.parse(base).root;
  for (const part of path.relative(current, base).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw invalid('Project paths cannot pass through a symbolic link or junction.', 403);
  }
  for (const [index, part] of parts.entries()) {
    if (part === '..' || /[:\x00-\x1f]/.test(part)) throw invalid('Invalid project path.');
    current = path.join(current, part);
    const info = await lstat(current).catch(error => { if (allowMissing && error.code === 'ENOENT') return null; throw error; });
    if (!info) continue;
    if (info.isSymbolicLink()) throw invalid('Project paths cannot pass through a symbolic link or junction.', 403);
    if (index < parts.length - 1 && !info.isDirectory()) throw invalid('A project path parent is not a directory.');
    if (!within(await realpath(base), await realpath(current))) throw invalid('Project path leaves the Workspace.', 403);
  }
  return resolved;
}
export async function assertPrivateWorkspaceRoot(root) {
  const resolved = path.resolve(root);
  let existing = resolved;
  while (!(await maybeStat(existing))) {
    const parent = path.dirname(existing);
    if (parent === existing) throw invalid('The Workspace drive or share is unavailable. Choose an available location.');
    existing = parent;
  }
  await assertSafePath(existing, resolved, { allowMissing: true });
  let parent = resolved;
  while (true) {
    if (await maybeStat(path.join(parent, '.git'))) throw invalid('Private project data cannot be created inside a Git checkout. Choose a separate Workspace location.');
    if (path.dirname(parent) === parent) break;
    parent = path.dirname(parent);
  }
  return resolved;
}
export async function assertPrivateProjectRoot(repo, id) {
  const paths = safeProjectPaths(repo, id);
  await assertSafePath(repo, paths.workspace, { allowMissing: true });
  // Never put private project records under a working Git tree. The optional
  // checkout is a sibling named github, never a parent of the workspace.
  await assertPrivateWorkspaceRoot(paths.root);
  return paths;
}
export async function ensureProjectWorkspace(repo, id) {
  const paths = await assertPrivateProjectRoot(repo, id);
  await mkdir(paths.workspace, { recursive: true });
  await assertSafePath(repo, paths.workspace);
  return paths;
}
export async function projectWorkspaceDirectory(repo, entity) {
  if (entity.workspacePath) {
    const expected = safeProjectPaths(repo, entity.id);
    if (entity.workspacePath !== expected.workspacePath) throw invalid('Project workspace path does not match its stable ID.');
    return assertSafePath(repo, expected.workspace);
  }
  // Legacy IDs may predate canonical slug rules. Keep their exact IDs/routes;
  // validate the recorded folder independently without enabling a migration.
  if (typeof entity.folder !== 'string' || !entity.folder || path.isAbsolute(entity.folder) || entity.folder.split(/[\\/]/).some(part => !part || part === '..' || part.includes(':'))) throw invalid('Invalid legacy project folder.');
  const legacy = path.join(repo, 'workspace', entity.folder);
  await assertSafePath(repo, legacy);
  return legacy;
}
export async function inspectTree(repo, directory) {
  await assertSafePath(repo, directory);
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (item.name === '.git' || item.isSymbolicLink()) throw invalid('Workspace migration cannot include Git repositories, symbolic links or junctions.');
    if (item.isDirectory()) await inspectTree(repo, path.join(directory, item.name));
  }
}
