import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

export const platform = process.platform;
export const isWindows = platform === 'win32';
export const isLinux = platform === 'linux';
export const isMacOS = platform === 'darwin';

export function shellLabel() {
  return isWindows ? 'PowerShell' : 'Shell';
}

export function shellCommand(env = process.env) {
  if (isWindows) return { file: path.join(env.SystemRoot || env.WINDIR || 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), args: ['-NoLogo', '-NoProfile'] };
  const shell = env.SHELL || (isMacOS ? '/bin/zsh' : '/bin/sh');
  return { file: shell, args: [] };
}

export function accountHome() {
  try { return os.userInfo().homedir; } catch { return os.homedir(); }
}

export function windowsAppDataFolders(env = process.env, home = accountHome()) {
  const folders = (configured, kind) => [...new Set([configured, path.join(home, 'AppData', kind)].filter(folder => folder && path.isAbsolute(folder)))];
  return { roaming: folders(env.APPDATA, 'Roaming'), local: folders(env.LOCALAPPDATA, 'Local') };
}

export function commandSearchRoots(env = process.env, home = isWindows ? accountHome() : os.homedir()) {
  const roots = [];
  if (isWindows) {
    const { roaming, local } = windowsAppDataFolders(env, home);
    roots.push(...roaming.map(folder => path.join(folder, 'npm')));
    for (const folder of local) roots.push(path.join(folder, 'Programs', 'OpenAI', 'Codex', 'bin'), path.join(folder, 'agy', 'bin'));
  }
  roots.push(path.join(home, '.opencode', 'bin'), path.join(home, '.kimi-code', 'bin'), path.join(home, '.local', 'bin'));
  return roots;
}

export function commandExtensions() {
  return isWindows ? ['.exe', '.cmd', '.bat', '.ps1', ''] : [''];
}

export function resolveCommand(name, env = process.env, home, extensions = commandExtensions(), isFile = existsSync) {
  if (path.isAbsolute(name)) return isFile(name) ? name : null;
  for (const folder of [...String(env.PATH || env.Path || '').split(path.delimiter), ...commandSearchRoots(env, home)]) {
    if (!folder || (isWindows && !path.isAbsolute(folder))) continue;
    for (const ext of extensions) {
      const candidate = path.join(folder, name.toLowerCase().endsWith(ext) && ext ? name : name + ext);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

export function ptyOptions({ cwd, env, cols, rows }) {
  const options = { name: 'xterm-256color', cwd, env, cols, rows };
  if (isWindows) return { ...options, useConpty: true, useConptyDll: true };
  return options;
}

export function processSpawnOptions() {
  return isWindows ? { windowsHide: true } : {};
}

export function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return isWindows ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function invalidFilename(name) {
  if (typeof name !== 'string' || !name || name.length > 240 || /[\x00-\x1f]/.test(name)) return true;
  if (name === '.' || name === '..' || /[/\\]/.test(name)) return true;
  if (!isWindows) return false;
  return /[<>:"|?*]/.test(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name);
}

export async function terminateProcessTree(pid, { force = false } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (isWindows) {
    await new Promise(resolve => execFile('taskkill.exe', ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])], processSpawnOptions(), () => resolve()));
    return;
  }
  const signal = force ? 'SIGKILL' : 'SIGTERM';
  try { process.kill(-pid, signal); } catch { try { process.kill(pid, signal); } catch { /* already stopped */ } }
}

export function revealCommand(file) {
  if (isWindows) return { file: 'explorer.exe', args: [file] };
  if (isMacOS) return { file: 'open', args: [file] };
  return { file: 'xdg-open', args: [file] };
}

export function browserCommand(url) {
  if (isWindows) return { file: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url] };
  if (isMacOS) return { file: 'open', args: [url] };
  return { file: 'xdg-open', args: [url] };
}
