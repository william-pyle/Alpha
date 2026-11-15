import path from 'node:path';
import os from 'node:os';
import { existsSync } from 'node:fs';
import { access, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const worker = fileURLToPath(new URL('./whisper-dictation.py', import.meta.url));
export function localConfig(repo, env = {}) {
  const legacy = path.join(repo, '.cache', 'dictation');
  const installed = process.platform === 'win32' ? path.join(env.APPDATA || process.env.APPDATA || path.join(os.homedir(), 'AppData/Roaming'), 'com.jazcosolutions.alpha', 'Whisper') : legacy;
  const ready = root => [path.join(root, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'), path.join(root, 'model/model.bin'), path.join(root, 'model/config.json'), path.join(root, 'model/tokenizer.json')].every(existsSync);
  const root = ready(installed) || !ready(legacy) ? installed : legacy;
  return { python: env.ALPHA_WHISPER_PYTHON || path.join(root, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'), model: env.ALPHA_WHISPER_MODEL || path.join(root, 'model') };
}
export async function localAvailable(config) {
  try { await Promise.all([access(config.python), ...['model.bin', 'config.json', 'tokenizer.json'].map(name => access(path.join(config.model, name)))]); return true; } catch { return false; }
}
export async function localTranscribe(config, audio, extension, signal) {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'alpha-whisper-'));
  try {
    const file = path.join(folder, `recording.${extension}`);
    await writeFile(file, audio, { mode: 0o600 });
    const { stdout } = await execute(config.python, [worker, '--model', config.model, '--audio', file], { signal, timeout: 240000, windowsHide: true, maxBuffer: 512 * 1024 });
    return JSON.parse(stdout);
  } catch {
    throw Object.assign(new Error('Local transcription could not finish. Retry or record a shorter message.'), { status: 502 });
  } finally { await rm(folder, { recursive: true, force: true }); }
}
