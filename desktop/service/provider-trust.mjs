import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
// No glob/prefix comparison: C:\Projects2 and junction escapes are outside.
export function insideWindowsRoot(root, candidate) {
  if (!path.win32.isAbsolute(root) || !path.win32.isAbsolute(candidate)) return false;
  const normalize = value => path.win32.normalize(value.replace(/^\\\\\?\\/, '')).toLowerCase();
  const relative = path.win32.relative(normalize(root), normalize(candidate));
  return relative === '' || (!relative.startsWith('..\\') && relative !== '..' && !path.win32.isAbsolute(relative));
}

export async function approvedProjectTrust(cwd, roots, { canonical = realpath, gitRoot = async directory => {
  try {
    const common = (await exec('git', ['-C', directory, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { windowsHide: true })).stdout.trim();
    return path.basename(common) === '.git' ? path.dirname(common) : (await exec('git', ['-C', directory, 'rev-parse', '--show-toplevel'], { windowsHide: true })).stdout.trim();
  }
  catch { return directory; }
} } = {}) {
  if (!Array.isArray(roots) || !roots.length) return [];
  const actual = await canonical(cwd);
  const target = await canonical(await gitRoot(actual));
  for (const root of roots) {
    const resolved = await canonical(root);
    if (!insideWindowsRoot(root, resolved) || !insideWindowsRoot(root, cwd) || !insideWindowsRoot(resolved, actual) || !insideWindowsRoot(resolved, target)) continue;
    // Provider-supported exact project entry; no wildcard, global bypass,
    // config-file rewrite, permission flag or transfer from an old checkout.
    const key = target.replace(/^\\\\\?\\/, '').replaceAll('\\', '/').toLowerCase();
    return ['-c', `projects.${JSON.stringify(key)}.trust_level="trusted"`];
  }
  return [];
}
