import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { commandSearchRoots, invalidFilename, ptyOptions, resolveCommand, shellCommand, shellLabel } from '../platform.mjs';
import { codexBinary } from '../agents.mjs';

test('platform policy preserves POSIX names while retaining Windows-safe validation', () => {
  assert.equal(invalidFilename('notes:linux.md'), process.platform === 'win32');
  assert.equal(invalidFilename('notes.md'), false);
  assert.equal(invalidFilename('../escape.md'), true);
  assert.equal(shellLabel(), process.platform === 'win32' ? 'PowerShell' : 'Shell');
  assert.ok(shellCommand().file);
  // Agent chats start through PowerShell even when its folder is missing from PATH.
  if (process.platform === 'win32') assert.equal(shellCommand({ SystemRoot: 'D:\\Windows' }).file, 'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.equal('useConpty' in ptyOptions({ cwd: process.cwd(), env: process.env, cols: 80, rows: 24 }), process.platform === 'win32');
});

test('OpenCode install directory is included in command lookup roots', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'alpha-command-home-'));
  const bin = path.join(home, '.opencode', 'bin');
  await mkdir(bin, { recursive: true });
  const executable = path.join(bin, 'opencode');
  await writeFile(executable, '');

  assert.ok(commandSearchRoots({}, home).includes(bin));
  assert.equal(resolveCommand('opencode', { PATH: '' }, home), executable);
});

test('Windows Codex installation is found with an installer-style PATH', { skip: process.platform !== 'win32' }, async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'alpha-codex-home-'));
  const local = path.join(home, 'AppData', 'Local');
  const bin = path.join(local, 'Programs', 'OpenAI', 'Codex', 'bin');
  await mkdir(bin, { recursive: true });
  const executable = path.join(bin, 'codex.exe');
  await writeFile(executable, '');
  assert.equal(resolveCommand('codex', { PATH: '', LOCALAPPDATA: local }, home), executable);
  assert.equal(resolveCommand('codex', { PATH: '' }, home), executable);
  const preferred = path.join(home, 'chosen-bin');
  await mkdir(preferred); await writeFile(path.join(preferred, 'codex.exe'), '');
  assert.equal(resolveCommand('codex', { PATH: preferred, LOCALAPPDATA: local }, home), path.join(preferred, 'codex.exe'));
});

test('Windows Codex discovery uses the account profile when inherited locations are invalid', { skip: process.platform !== 'win32' }, async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'alpha-codex-account-'));
  const wrong = path.join(home, 'unavailable-profile');
  const bin = path.join(home, 'AppData', 'Local', 'Programs', 'OpenAI', 'Codex', 'bin');
  const shimDir = path.join(home, 'shim');
  await mkdir(bin, { recursive: true }); await mkdir(shimDir);
  const executable = path.join(bin, 'codex.exe');
  await writeFile(executable, 'fixture');
  await writeFile(path.join(shimDir, 'codex.cmd'), 'fixture');
  const env = { PATH: shimDir, USERPROFILE: wrong, LOCALAPPDATA: wrong, APPDATA: wrong };
  assert.deepEqual(codexBinary(env, home), { file: executable, args: [] });
  assert.throws(() => codexBinary(env, wrong), /found a Codex command shim/);
  assert.throws(() => codexBinary({ PATH: 'shim', APPDATA: '.' }, wrong), /could not find/);
});

test('Windows Codex npm binary is found in the account-profile fallback', { skip: process.platform !== 'win32' }, async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'alpha-codex-account-npm-'));
  const wrong = path.join(home, 'unavailable-profile');
  const triple = process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
  const npmBin = path.join(home, 'AppData', 'Roaming', 'npm', 'node_modules', '@openai', `codex-win32-${process.arch}`, 'vendor', triple, 'bin');
  await mkdir(npmBin, { recursive: true });
  const executable = path.join(npmBin, 'codex.exe');
  await writeFile(executable, 'fixture');
  assert.deepEqual(codexBinary({ PATH: '', APPDATA: wrong }, home), { file: executable, args: [] });
  const staleNpmBin = path.join(wrong, 'npm', 'node_modules', '@openai', `codex-win32-${process.arch}`, 'vendor', triple, 'bin');
  await mkdir(staleNpmBin, { recursive: true });
  await writeFile(path.join(staleNpmBin, 'codex.exe'), 'unrelated fixture');
  assert.deepEqual(codexBinary({ PATH: '', APPDATA: wrong, ALPHA_WINDOWS_CLI_ROAMING: path.join(home, 'AppData', 'Roaming') }, home), { file: executable, args: [] });
});
