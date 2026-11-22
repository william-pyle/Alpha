import path from 'node:path';
import { realpath } from 'node:fs/promises';

export function insideWindowsRoot(root, candidate) {
  if (!path.win32.isAbsolute(root) || !path.win32.isAbsolute(candidate)) return false;
  const normalize = value => path.win32.normalize(value.replace(/^\\\\\?\\/, '')).toLowerCase();
  const relative = path.win32.relative(normalize(root), normalize(candidate));
  return relative === '' || (!relative.startsWith('..\\') && relative !== '..' && !path.win32.isAbsolute(relative));
}

// Folder trust can activate project-scoped configuration, including permission
// defaults. Until Codex exposes a way to verify the effective settings and honor
// an existing trust denial before launch, classify scope for a manual review only.
export async function codexTrustScope(cwd, configuredRoot, canonical = realpath) {
  if (!insideWindowsRoot(configuredRoot, cwd) || path.win32.relative(configuredRoot, cwd) === '') return 'outside';
  try {
    const [root, actual] = await Promise.all([canonical(configuredRoot), canonical(cwd)]);
    if (!insideWindowsRoot(configuredRoot, root) || path.win32.relative(configuredRoot, root) !== '') return 'unverified';
    return insideWindowsRoot(root, actual) && path.win32.relative(root, actual) !== '' ? 'in-scope' : 'unverified';
  } catch { return 'unverified'; }
}
