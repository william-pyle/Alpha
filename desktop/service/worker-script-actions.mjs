import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, open, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { projectId } from './project-layout.mjs';

// The worker channel executes only reviewed, bundled sources. Workspace tool
// declarations and project files do not supply either an executable or code.
const registry = new Map([['alpha-runtime-check', {
  label: 'Check Alpha’s restricted runtime',
  file: new URL('./worker-scripts/runtime-check.mjs', import.meta.url),
  sha256: '2a4717698cd92ed9df8555f9245329ebe1d2b7be531cde0666668441497edb49',
}]]);
const invocation = [
  '--permission', '--no-addons', '--no-global-search-paths',
  '--max-old-space-size=32', '--max-semi-space-size=4', '--input-type=module', '-', process.version,
];
const timeoutMs = 5000;
const sourceLimit = 16 * 1024;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const revisionFor = (projectId, script) => sha256(JSON.stringify([
  projectId, script.sha256, process.platform, process.arch, invocation, timeoutMs,
]));
const fail = (status, message) => Object.assign(new Error(message), { status });

const supportedRuntime = Number(process.versions.node.split('.')[0]) >= 24;
function validate(action, args, targetId) {
  if (action !== 'run-script' || targetId != null || !args || typeof args !== 'object' || Array.isArray(args)
      || Object.keys(args).length !== 2 || !Object.hasOwn(args, 'scriptId') || !Object.hasOwn(args, 'expectedRevision')
      || typeof args.scriptId !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(args.scriptId)
      || typeof args.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(args.expectedRevision)) {
    throw fail(400, 'Select a registered Alpha script and supply its exact revision.');
  }
  return args;
}

async function verifiedSource(script) {
  const info = await lstat(script.file);
  if (!info.isFile() || info.size > sourceLimit) throw fail(409, 'The bundled script changed.');
  const file = await open(script.file, 'r');
  try {
    const buffer = Buffer.alloc(sourceLimit + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > sourceLimit) throw fail(409, 'The bundled script changed.');
    // Normalize Git's Windows checkout line endings, then execute exactly the
    // validated bytes via stdin. Nothing reloads the file during execution.
    const source = buffer.subarray(0, bytesRead).toString('utf8').replace(/\r\n/g, '\n');
    if (sha256(source) !== script.sha256) throw fail(409, 'The bundled script changed.');
    return source;
  } finally {
    await file.close();
  }
}

async function execute(source, stillAuthorized) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alpha-worker-script-'));
  try {
    if (!await stillAuthorized()) return 'stale';
    return await new Promise((resolve, reject) => {
      let timedOut = false;
      const child = spawn(process.execPath, invocation, {
        cwd: directory, env: {}, stdio: ['pipe', 'ignore', 'ignore'], shell: false, windowsHide: true,
      });
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeoutMs);
      function finish(status) {
        clearTimeout(timer);
        resolve(status);
      }
      child.once('error', error => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', code => finish(timedOut ? 'unconfirmed' : code === 0 ? 'applied' : 'error'));
      child.stdin.on('error', () => { child.kill(); });
      child.stdin.end(source, 'utf8');
    });
  } finally {
    await rmdir(directory).catch(() => {});
  }
}

export function createWorkerScriptActions({ projectStore, projectStorage }) {
  function requestProject(origin) {
    const id = projectId(origin?.projectId);
    if (id === 'mooseville') throw fail(403, 'This project cannot request an Alpha script.');
    return id;
  }
  async function assertProject(id) {
    await projectStore.get(id, { allowRemoved: false });
    projectStorage.assertAvailable(id);
  }
  async function check(origin, args) {
    const script = supportedRuntime && registry.get(args.scriptId);
    if (!script) throw fail(403, 'This script is unavailable through Alpha worker requests.');
    const id = requestProject(origin);
    await assertProject(id);
    const revision = revisionFor(id, script);
    if (revision !== args.expectedRevision) throw fail(409, 'The requested script revision changed.');
    const source = await verifiedSource(script).catch(error => {
      if (error.code === 'ENOENT') throw fail(409, 'The bundled script changed.');
      throw error;
    });
    return { script, revision, source };
  }
  return {
    validate,
    async list(origin) {
      if (!supportedRuntime) return [];
      const id = requestProject(origin);
      await assertProject(id);
      const available = [];
      for (const [scriptId, script] of registry) {
        if (await verifiedSource(script).catch(() => null)) {
          available.push({ scriptId, label: script.label, revision: revisionFor(id, script) });
        }
      }
      return available;
    },
    async prepare(origin, action, args, targetId) {
      validate(action, args, targetId);
      const { script, revision } = await check(origin, args);
      return {
        approval: true,
        revision,
        review: {
          text: `Run “${script.label}” once for project ${origin.projectId}?`,
          context: `Bundled script ${args.scriptId}, SHA-256 ${script.sha256}. Invocation ${revision}. Uses an empty temporary folder with restricted permissions and no project inputs. Time limit 5 seconds.`,
        },
      };
    },
    async apply(origin, action, args, { approved, revision, targetId, stillAuthorized = () => true } = {}) {
      validate(action, args, targetId);
      if (approved !== true) return { status: 'denied' };
      if (revision !== args.expectedRevision) return { status: 'stale' };
      try {
        return await projectStore.exclusive(requestProject(origin), async () => {
          const { source } = await check(origin, args);
          return { status: await execute(source, stillAuthorized) };
        });
      } catch (error) {
        if (['EACCES', 'EPERM', 'EROFS'].includes(error.code)) throw error;
        return { status: [400, 403].includes(error.status) ? 'denied' : [404, 409].includes(error.status) ? 'stale' : 'error' };
      }
    },
  };
}
