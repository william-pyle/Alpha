import path from 'node:path';
import os from 'node:os';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const serviceDir = path.dirname(fileURLToPath(import.meta.url));
const worker = path.join(serviceDir, 'whisper-dictation.py');
const packagedScript = path.resolve(serviceDir, '../setup-local-whisper.ps1');
const sourceScript = path.resolve(serviceDir, '../../scripts/setup-local-whisper.ps1');
const failure = message => Object.assign(new Error(message), { status: 503 });

export class LocalWhisperControl {
  constructor({ setupScript = existsSync(packagedScript) ? packagedScript : sourceScript, spawnProcess = spawn } = {}) {
    this.setupScript = setupScript; this.spawnProcess = spawnProcess;
    this.child = null; this.ready = false; this.starting = false; this.installing = false; this.error = '';
    this.pending = null; this.queue = Promise.resolve(); this.startPromise = null;
  }
  state(installed) { return { installed, running: this.ready && !!this.child, starting: this.starting, installing: this.installing, ...(this.error ? { error: this.error } : {}) }; }
  install() {
    if (this.installing) return;
    if (process.platform !== 'win32' || !existsSync(this.setupScript)) throw failure('The packaged Local Whisper setup script is unavailable.');
    this.error = ''; this.installing = true;
    const child = this.spawnProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', this.setupScript], { windowsHide: true, stdio: 'ignore' });
    child.once('error', () => { this.installing = false; this.error = 'Local Whisper setup could not start.'; });
    child.once('exit', code => { this.installing = false; if (code !== 0) this.error = 'Local Whisper setup did not finish. Run the setup again to retry.'; });
  }
  async start(config) {
    if (this.ready) return;
    if (this.startPromise) return this.startPromise;
    this.error = ''; this.starting = true;
    this.startPromise = new Promise((resolve, reject) => {
      const child = this.spawnProcess(config.python, [worker, '--model', config.model, '--serve'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      this.child = child;
      let settled = false;
      const fail = () => {
        this.ready = false; this.starting = false; this.child = null;
        this.error = 'Local Whisper could not start. Check its installation and try again.';
        if (this.pending) { this.pending.reject(failure('Local Whisper stopped during transcription.')); this.pending = null; }
        if (!settled) { settled = true; reject(failure(this.error)); }
      };
      const timer = setTimeout(() => { child.kill(); fail(); }, 90000);
      child.once('error', () => { clearTimeout(timer); fail(); });
      child.once('exit', () => { clearTimeout(timer); if (this.child === child || !settled) fail(); });
      child.stderr.resume();
      createInterface({ input: child.stdout }).on('line', line => {
        let value; try { value = JSON.parse(line); } catch { return; }
        if (!settled && value.ready === true) {
          clearTimeout(timer); settled = true; this.ready = true; this.starting = false; resolve(); return;
        }
        if (this.pending) {
          const pending = this.pending; this.pending = null;
          value.error ? pending.reject(failure(value.error)) : pending.resolve(value);
        }
      });
    }).finally(() => { this.startPromise = null; });
    return this.startPromise;
  }
  async stop() {
    const child = this.child;
    this.child = null; this.ready = false; this.starting = false; this.error = '';
    if (this.pending) { this.pending.reject(failure('Local Whisper was stopped.')); this.pending = null; }
    child?.kill();
  }
  async transcribe(audio, extension, signal) {
    if (!this.ready || !this.child) throw failure('Start Local Whisper and try again.');
    const folder = await mkdtemp(path.join(os.tmpdir(), 'alpha-whisper-warm-'));
    const file = path.join(folder, `recording.${extension}`);
    await writeFile(file, audio, { mode: 0o600 });
    const task = this.queue.catch(() => {}).then(() => new Promise((resolve, reject) => {
      if (!this.ready || !this.child) { reject(failure('Local Whisper stopped.')); return; }
      const abort = () => { void this.stop(); reject(failure('Local transcription was cancelled.')); };
      if (signal.aborted) return abort();
      signal.addEventListener('abort', abort, { once: true });
      this.pending = { resolve: value => { signal.removeEventListener('abort', abort); resolve(value); }, reject: error => { signal.removeEventListener('abort', abort); reject(error); } };
      this.child.stdin.write(JSON.stringify({ audio: file }) + '\n');
    }));
    this.queue = task;
    try { return await task; } finally { await rm(folder, { recursive: true, force: true }); }
  }
  close() { void this.stop(); }
}
