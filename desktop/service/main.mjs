import path from 'node:path';
import os from 'node:os';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createService } from './server.mjs';
import { saveJson } from './util.mjs';
import { createInterface } from 'node:readline';

const directory = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const option = name => { const index = args.indexOf(name); return index < 0 ? null : args[index + 1]; };
const repo = path.resolve(option('--repo') || process.env.ALPHA_REPO || path.join(directory, '../..'));
const uiDir = path.resolve(option('--ui') || path.join(directory, '../../dist'));
const stateDir = path.resolve(option('--state') || path.join(repo, '.alpha'));
const writeNative = value => process.stdout.write(JSON.stringify(value) + '\n');
const bundledLibrary = path.join(directory, '../shared-library');
const bundle = path.resolve(option('--library-bundle') || (await access(path.join(bundledLibrary,'manifest.json')).then(() => bundledLibrary, () => path.join(directory,'../../.cache/shared-library'))));
const libraryRoot = path.resolve(option('--library-root') || process.env.ALPHA_LIBRARY_ROOT || path.join(process.env.APPDATA || path.join(os.homedir(), '.local/share'), 'com.jazcosolutions.alpha', 'SharedLibrary'));
await access(path.join(bundle, 'manifest.json'));
const configDir = option('--config');
const service = await createService({ repo, uiDir, stateDir, native: writeNative, restoreSessions: true, checkUpdates: process.env.ALPHA_TEST !== '1', sharedLibrary: { bundle, root: libraryRoot }, workspaceLocation: configDir ? { configDir, protectedRoots: [option('--app-dir'), libraryRoot].filter(Boolean) } : undefined });
// Diagnostics are readable project state. Window credentials travel only over
// the private startup pipe to the desktop shell, never through this file.
await saveJson(path.join(stateDir, 'runtime.json'), { pid: process.pid, origin: service.origin });
writeNative({ type: 'ready', ...service.urls });
let exiting = false;
async function stop() {
  if (exiting) return; exiting = true;
  const deadline = setTimeout(() => process.exit(1), 8000); deadline.unref();
  await service.close(); process.exit(0);
}
process.on('SIGINT', stop); process.on('SIGTERM', stop);
if (process.env.ALPHA_PARENT_PID) {
  const parent = Number(process.env.ALPHA_PARENT_PID);
  const timer = setInterval(() => { try { process.kill(parent, 0); } catch { stop(); } }, 2000); timer.unref();
}
createInterface({ input: process.stdin }).on('line', line => {
  if (line.trim() === 'quit') { void stop(); return; }
  try { service.nativeMessage(JSON.parse(line)); } catch { /* Ignore malformed native messages. */ }
});
process.on('uncaughtException', error => { process.stderr.write(`Service error: ${error.message}\n`); stop(); });
