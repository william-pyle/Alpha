import { spawn, execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { saveJson, readJson } from './util.mjs';

const execute = promisify(execFile);
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const idPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const isObject = value => value && typeof value === 'object' && !Array.isArray(value);
const timeout = (value, fallback, maximum) => Number.isInteger(value) && value >= 100 && value <= maximum ? value : fallback;
const keyOf = (card, tool) => `${card}/${tool}`;

function command(value, label) {
  if (!isObject(value) || typeof value.executable !== 'string' || !value.executable.trim() || !Array.isArray(value.args) || value.args.some(arg => typeof arg !== 'string') || typeof value.cwd !== 'string' || !path.isAbsolute(value.cwd)) throw fail(`${label} needs an executable, argument array and absolute working folder.`);
  return { executable: value.executable, args: value.args, cwd: value.cwd };
}

function probe(value) {
  if (value == null) return null;
  if (!isObject(value)) throw fail('Readiness probe is invalid.');
  if (value.type === 'process') return { type: 'process' };
  if (value.type === 'http') {
    let url;
    try { url = new URL(value.url); } catch { throw fail('HTTP readiness URL is invalid.'); }
    if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw fail('HTTP readiness must use a local address.');
    return { type: 'http', url: url.href };
  }
  if (value.type === 'tcp' && ['localhost', '127.0.0.1', '::1'].includes(value.host) && Number.isInteger(value.port) && value.port > 0 && value.port <= 65535) return { type: 'tcp', host: value.host, port: value.port };
  throw fail('Readiness probe is invalid.');
}

export function validateTools(tools) {
  if (tools == null) return [];
  if (!Array.isArray(tools) || tools.length > 20) throw fail('Card tools must be an array of at most 20 tools.');
  const seen = new Set();
  return tools.map(value => {
    if (!isObject(value) || !idPattern.test(value.id) || seen.has(value.id) || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 80 || !['managed-process', 'observed-external', 'one-shot'].includes(value.kind)) throw fail('Card tool definition is invalid or duplicated.');
    seen.add(value.id);
    const start = value.kind === 'observed-external' ? null : command(value.start, 'Tool start');
    const readiness = probe(value.readiness);
    if (value.kind === 'observed-external' && (!readiness || readiness.type === 'process')) throw fail('Observed tools need an HTTP or TCP readiness probe.');
    if (value.launches != null && !Array.isArray(value.launches)) throw fail('Tool launch actions must be an array.');
    const launches = (value.launches || []).map(action => {
      if (!isObject(action) || !idPattern.test(action.id) || typeof action.name !== 'string' || !action.name.trim() || !['url', 'file', 'folder', 'command'].includes(action.type)) throw fail('Tool launch action is invalid.');
      if (action.type === 'command') return { id: action.id, name: action.name, type: action.type, command: command(action.command, 'Launch command'), whenReady: !!action.whenReady };
      if (typeof action.target !== 'string' || !action.target.trim()) throw fail('Tool launch target is invalid.');
      if (action.type === 'url') {
        let url; try { url = new URL(action.target); } catch { throw fail('Tool launch URL is invalid.'); }
        if (!['http:', 'https:'].includes(url.protocol)) throw fail('Tool launch URL must use HTTP or HTTPS.');
      } else if (!path.isAbsolute(action.target)) throw fail('Tool launch file or folder must be absolute.');
      return { id: action.id, name: action.name, type: action.type, target: action.target, whenReady: !!action.whenReady };
    });
    if (launches.length > 20 || new Set(launches.map(item => item.id)).size !== launches.length) throw fail('Tool launch actions are invalid or duplicated.');
    return { id: value.id, name: value.name.trim(), kind: value.kind, start, prepare: value.prepare ? command(value.prepare, 'Tool preparation') : null, readiness, launches, startTimeoutMs: timeout(value.startTimeoutMs, 15000, 120000), stopTimeoutMs: timeout(value.stopTimeoutMs, 5000, 30000) };
  });
}

async function processIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === 'win32') {
    const script = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction Stop; if($p){[pscustomobject]@{created=$p.CreationDate.ToString('o');executable=$p.ExecutablePath} | ConvertTo-Json -Compress}`;
    const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 5000, maxBuffer: 4096 });
    if (!stdout.trim()) return null;
    const found = JSON.parse(stdout);
    return found.created && found.executable ? { pid, created: found.created, executable: found.executable.toLowerCase() } : null;
  }
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const executable = await import('node:fs/promises').then(fs => fs.realpath(`/proc/${pid}/exe`));
    return { pid, created: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19], executable };
  } catch { return null; }
}

const sameIdentity = (a, b) => !!a && !!b && a.pid === b.pid && a.created === b.created && a.executable === b.executable;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function ready(probeValue, running = false) {
  if (!probeValue || probeValue.type === 'process') return running;
  if (probeValue.type === 'http') {
    try { const response = await fetch(probeValue.url, { signal: AbortSignal.timeout(1200), redirect: 'manual' }); return response.ok; } catch { return false; }
  }
  const { connect } = await import('node:net');
  return new Promise(resolve => {
    const socket = connect(probeValue.port, probeValue.host);
    socket.setTimeout(1000);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
  });
}

async function occupied(probeValue) {
  if (!probeValue || probeValue.type === 'process') return false;
  if (probeValue.type === 'tcp') return ready(probeValue);
  const url = new URL(probeValue.url);
  return ready({ type: 'tcp', host: url.hostname === '[::1]' ? '::1' : url.hostname, port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80) });
}

async function run(commandValue, waitMs) {
  const child = spawn(commandValue.executable, commandValue.args, { cwd: commandValue.cwd, windowsHide: true, stdio: 'ignore', shell: false });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(fail('Tool command timed out.', 504)); }, waitMs);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve({ exitCode: 0 }) : reject(fail(`Tool command exited with code ${code}.`, 500)); });
  });
}

export class WorkspaceTools {
  constructor({ workspace, stateDir, native = () => {}, changed = () => {} }) {
    this.workspace = workspace; this.file = path.join(stateDir, 'tool-processes.json'); this.native = native; this.changed = changed;
    this.owned = new Map(); this.live = new Map(); this.operations = new Map(); this.busy = new Set(); this.results = new Map(); this.errors = new Map(); this.saves = Promise.resolve();
  }
  async init() { this.owned = new Map(Object.entries(await readJson(this.file, {}))); return this; }
  persist() { this.saves = this.saves.catch(() => {}).then(() => saveJson(this.file, Object.fromEntries(this.owned))); return this.saves; }
  async tool(cardId, toolId) {
    const entity = (await this.workspace.registry()).entities.find(item => item.id === cardId);
    if (!entity) throw fail('Workspace card was not found.', 404);
    const tool = validateTools(entity.tools).find(item => item.id === toolId);
    if (!tool) throw fail('Workspace tool was not found.', 404);
    return tool;
  }
  async list(cardId) {
    const entity = (await this.workspace.registry()).entities.find(item => item.id === cardId);
    if (!entity) throw fail('Workspace card was not found.', 404);
    return Promise.all(validateTools(entity.tools).map(tool => this.status(cardId, tool)));
  }
  async status(cardId, tool) {
    const key = keyOf(cardId, tool.id), operation = this.operations.get(key), owned = this.owned.get(key);
    if (operation) return this.view(tool, operation, false, key, !!owned);
    if (tool.kind === 'one-shot') return this.view(tool, this.errors.has(key) ? 'error' : 'stopped', false, key);
    if (owned) {
      const identity = await processIdentity(owned.pid);
      if (sameIdentity(owned, identity)) {
        const isReady = await ready(tool.readiness, true);
        if (!isReady && Date.now() - owned.startedAt > tool.startTimeoutMs) this.errors.set(key, 'The managed process is running but is not ready.');
        return this.view(tool, isReady ? 'running' : this.errors.has(key) ? 'error' : 'starting', isReady, key, true);
      }
      this.owned.delete(key); this.live.delete(key); await this.persist();
      if (!this.errors.has(key)) this.errors.set(key, 'The managed process exited.');
      this.changed(cardId);
    }
    const external = tool.readiness?.type !== 'process' && await ready(tool.readiness);
    return this.view(tool, external ? 'running-external' : this.errors.has(key) ? 'error' : 'stopped', !!external, key);
  }
  view(tool, state, isReady, key, owned = false) {
    return { id: tool.id, name: tool.name, kind: tool.kind, state, ready: isReady, owned, error: state === 'error' ? this.errors.get(key) : null, lastResult: this.results.get(key) || null, launches: tool.launches.map(({ id, name, whenReady }) => ({ id, name, available: !whenReady || isReady })) };
  }
  async exclusive(key, action) {
    if (this.busy.has(key)) throw fail('This tool is already changing state.', 409);
    this.busy.add(key);
    try { return await action(); } finally { this.busy.delete(key); }
  }
  async terminate(owned, timeoutMs) {
    if (!sameIdentity(owned, await processIdentity(owned.pid))) return;
    if (process.platform === 'win32') await execute('taskkill.exe', ['/PID', String(owned.pid), '/T'], { windowsHide: true, timeout: 5000 }).catch(() => {});
    else process.kill(-owned.pid, 'SIGTERM');
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && sameIdentity(owned, await processIdentity(owned.pid))) await delay(150);
    if (sameIdentity(owned, await processIdentity(owned.pid))) {
      if (process.platform === 'win32') await execute('taskkill.exe', ['/PID', String(owned.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 });
      else process.kill(-owned.pid, 'SIGKILL');
    }
    if (sameIdentity(owned, await processIdentity(owned.pid))) throw fail('The tool process did not stop.', 500);
  }
  async start(cardId, toolId) {
    const tool = await this.tool(cardId, toolId), key = keyOf(cardId, toolId);
    return this.exclusive(key, async () => {
      if (tool.kind === 'observed-external') throw fail('This tool is observed externally and cannot be started.');
      const before = await this.status(cardId, tool);
      if (before.owned || before.state === 'running-external') return before;
      this.operations.set(key, 'starting'); this.errors.delete(key); this.changed(cardId);
      try {
        if (tool.kind === 'one-shot') {
          if (tool.prepare) await run(tool.prepare, 120000);
          const result = await run(tool.start, tool.startTimeoutMs);
          this.results.set(key, { at: new Date().toISOString(), ...result });
        } else {
          if (tool.prepare) await run(tool.prepare, 120000);
          if (await occupied(tool.readiness)) throw fail('Readiness address is already occupied by another process.', 409);
          const child = spawn(tool.start.executable, tool.start.args, { cwd: tool.start.cwd, windowsHide: true, detached: true, stdio: 'ignore', shell: false });
          await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
          child.unref(); this.live.set(key, child);
          let identity = null;
          for (let attempt = 0; attempt < 8 && !identity; attempt++) { identity = await processIdentity(child.pid); if (!identity) await delay(100); }
          if (!identity) throw fail('Could not verify the new process identity.', 500);
          this.owned.set(key, { ...identity, startedAt: Date.now() }); await this.persist();
          child.once('exit', () => { if (this.owned.get(key)?.created === identity.created) { this.owned.delete(key); this.persist().catch(() => {}); this.errors.set(key, 'The managed process exited.'); this.changed(cardId); } this.live.delete(key); });
          const deadline = Date.now() + tool.startTimeoutMs;
          while (Date.now() < deadline && sameIdentity(identity, await processIdentity(child.pid))) {
            if (await ready(tool.readiness, true)) break;
            await delay(250);
          }
          if (!await ready(tool.readiness, true)) throw fail('The tool did not become ready before the startup timeout.', 504);
        }
      } catch (error) {
        if (tool.kind === 'one-shot') this.results.set(key, { at: new Date().toISOString(), error: error.message });
        const owned = this.owned.get(key);
        if (owned) {
          try { await this.terminate(owned, tool.stopTimeoutMs); this.owned.delete(key); this.live.delete(key); await this.persist(); }
          catch { /* Keep ownership metadata if cleanup could not verify a stop. */ }
        }
        this.errors.set(key, error.message); throw error;
      }
      finally { this.operations.delete(key); this.changed(cardId); }
      return this.status(cardId, tool);
    });
  }
  async stop(cardId, toolId) {
    const tool = await this.tool(cardId, toolId), key = keyOf(cardId, toolId);
    if (tool.kind !== 'managed-process') throw fail('Only a managed process can be stopped.');
    return this.exclusive(key, async () => {
      const owned = this.owned.get(key);
      if (!owned || !sameIdentity(owned, await processIdentity(owned.pid))) throw fail('No verified Alpha-owned process is running.', 409);
      this.operations.set(key, 'stopping'); this.changed(cardId);
      try {
        await this.terminate(owned, tool.stopTimeoutMs);
        this.owned.delete(key); this.live.delete(key); this.errors.delete(key); await this.persist();
      } catch (error) { this.errors.set(key, error.message); throw error; }
      finally { this.operations.delete(key); this.changed(cardId); }
      return this.status(cardId, tool);
    });
  }
  async launch(cardId, toolId, actionId) {
    const tool = await this.tool(cardId, toolId), key = keyOf(cardId, toolId);
    const action = tool.launches.find(item => item.id === actionId);
    if (!action) throw fail('Tool launch action was not found.', 404);
    const state = await this.status(cardId, tool);
    if (action.whenReady && !state.ready) throw fail('Start the tool before launching this action.', 409);
    if (action.type === 'command') {
      try { const result = await run(action.command, 30000); this.results.set(key, { at: new Date().toISOString(), ...result }); }
      catch (error) { this.results.set(key, { at: new Date().toISOString(), error: error.message }); throw error; }
      finally { this.changed(cardId); }
    } else {
      if (action.type !== 'url') {
        const info = await stat(action.target).catch(() => null);
        if (!info || action.type === 'file' && !info.isFile() || action.type === 'folder' && !info.isDirectory()) throw fail('The launch target no longer exists.', 404);
      }
      this.native({ type: 'open-target', kind: action.type, target: action.target });
    }
    return { launched: true, action: action.id };
  }
  async close() { await this.saves; }
}
