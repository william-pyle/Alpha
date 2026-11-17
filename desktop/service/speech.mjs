import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

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
  constructor(changed = () => {}) { this.changed = changed; this.child = null; this.state = { speaking: false, error: null }; this.serial = 0; }
  async voices() {
    if (process.platform !== 'win32') return [];
    const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-ListVoices'], { windowsHide: true, timeout: 10000, maxBuffer: 8192 });
    const value = JSON.parse(stdout.trim());
    return Array.isArray(value) ? value : [value];
  }
  async speak(text, voice = '') {
    if (process.platform !== 'win32') throw invalid('Windows speech is unavailable on this system.');
    const message = spokenReply(text);
    if (!message) throw invalid('There is no reply to speak.');
    if (voice && !(await this.voices()).includes(voice)) throw invalid('The selected Windows voice is unavailable.');
    this.stop();
    const serial = ++this.serial;
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...(voice ? ['-Voice', voice] : [])], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    this.child = child;
    this.state = { speaking: true, error: null }; this.changed(this.state);
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
