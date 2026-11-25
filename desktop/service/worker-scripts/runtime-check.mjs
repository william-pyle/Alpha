import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const permissions = ['fs.read', 'fs.write', 'child', 'worker', 'addons', 'wasi', 'inspector'];
function denied(operation) {
  try { operation(); }
  catch (error) { return error.code === 'ERR_ACCESS_DENIED'; }
  return false;
}

const restricted = process.permission && permissions.every(name => !process.permission.has(name));
const clean = !Object.keys(process.env).some(name => /^(ALPHA_|NODE_OPTIONS$|NODE_PATH$)/i.test(name));
const version = process.argv[2];
if (!restricted || !clean || version !== process.version
    || !path.basename(process.cwd()).startsWith('alpha-worker-script-')
    || !denied(() => readFileSync(process.execPath))
    || !denied(() => spawnSync(process.execPath, ['--version']))) {
  process.exitCode = 1;
}
