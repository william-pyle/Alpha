import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';

const execute = promisify(execFile);
const script = fileURLToPath(new URL('./speech.ps1', import.meta.url));
const invalid = message => Object.assign(new Error(message), { status: 400 });

export function spokenReply(markdown) {
  if (typeof markdown !== 'string') return '';
  return markdown.replace(/```[\s\S]*?```/g, ' Code example is in the chat. ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' link in the chat ')
    .replace(/(?:^|\n)\s{0,3}#{1,6}\s+/g, '\n')
    .replace(/[\*_`>]/g, '')
    .replace(/\s+/g, ' ').trim();
}

export class Speech {
  constructor(changed = () => {}, { spawnProcess = spawn, platform = process.platform } = {}) { this.changed = changed; this.spawnProcess = spawnProcess; this.platform = platform; this.child = null; this.state = { speaking: false, error: null }; this.serial = 0; }
  async voices() {
    if (process.platform !== 'win32') return [];
    const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-ListVoices'], { windowsHide: true, timeout: 10000, maxBuffer: 8192 });
    const value = JSON.parse(stdout.trim());
    return Array.isArray(value) ? value : [value];
  }
  async speak(text, voice = '', threadId = null) {
    if (this.platform !== 'win32') throw invalid('Windows speech is unavailable on this system.');
    const message = spokenReply(text);
    if (!message) throw invalid('There is no reply to speak.');
    if (voice && !(await this.voices()).includes(voice)) throw invalid('The selected Windows voice is unavailable.');
    this.stop();
    const serial = ++this.serial;
    const child = this.spawnProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...(voice ? ['-Voice', voice] : [])], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    this.state = { speaking: true, error: null, threadId, level: 0, phase: 'preparing' }; this.changed(this.state);
    createInterface({ input: child.stdout }).on('line', line => {
      if (serial !== this.serial) return;
      try {
        const value = JSON.parse(line);
        if (!Number.isFinite(value.level)) return;
        const at = Date.now();
        this.state = { speaking: true, error: null, threadId, phase: 'playing', level: Math.max(0, Math.min(1, value.level / 100)), levelAt: at, durationMs: Math.max(100, Math.min(1500, Number(value.durationMs) || 150)), source: 'windows-speech-viseme' };
        this.changed(this.state);
      } catch { /* Speech diagnostics are not application events. */ }
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-1000); });
    child.stdin.on('error', () => { /* The synthesizer may exit while a newer reply replaces this one. */ });
    child.once('error', error => { if (serial === this.serial) { this.child = null; this.state = { speaking: false, error: error.message }; this.changed(this.state); } });
    child.once('exit', code => { if (serial === this.serial) { this.child = null; this.state = { speaking: false, error: code === 0 ? null : stderr.trim() || `Speech stopped with code ${code}.` }; this.changed(this.state); } });
    child.stdin.end(message, 'utf8');
    return this.state;
  }
  stop() {
    ++this.serial;
    this.child?.kill(); this.child = null;
    this.state = { speaking: false, error: null }; this.changed(this.state);
    return this.state;
  }
  close() { this.stop(); }
}
