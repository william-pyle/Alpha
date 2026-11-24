import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { parse as parseEnv } from 'dotenv';
import { isWindows, resolveCommand, shellCommand, shellLabel, windowsAppDataFolders } from './platform.mjs';
import { validAntigravityId } from './antigravity.mjs';

export { shellCommand };

export function wrapCommand(file, args = []) {
  if (!isWindows || /\.exe$/i.test(file)) return { file, args };
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  const script = `[Console]::InputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); & ${[file, ...args].map(quote).join(' ')}; exit $LASTEXITCODE`;
  return { file: shellCommand().file, args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')] };
}

export const AGENTS = [
  { id: 'codex', label: 'Codex', color: '#88d8bf', command: 'codex', subscription: true },
  { id: 'claude', label: 'Claude Code', color: '#dba68c', command: 'claude', subscription: true },
  { id: 'shell', label: shellLabel(), color: '#89b7ed', command: 'shell', subscription: false },
  { id: 'gitbash', label: 'Git Bash', color: '#eaa16d', command: 'gitbash', subscription: false },
];

export function gitBashPath(env = process.env) {
  const candidates = [env.ALPHA_GIT_BASH, ...[env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs')].filter(Boolean).map(root => path.join(root, 'Git', 'bin', 'bash.exe'))];
  const git = resolveCommand('git', env);
  if (git) candidates.push(path.resolve(path.dirname(git), '../bin/bash.exe'));
  return candidates.find(file => file && path.isAbsolute(file) && existsSync(file)) || null;
}

export function commandPath(name, env = process.env, home) {
  return name === 'gitbash' ? gitBashPath(env) : resolveCommand(name, env, home);
}

function codexSearchEnvironment(env) {
  if (!isWindows) return env;
  return {
    ...env,
    APPDATA: env.ALPHA_WINDOWS_CLI_ROAMING ?? env.APPDATA,
    LOCALAPPDATA: env.ALPHA_WINDOWS_CLI_LOCAL ?? env.LOCALAPPDATA,
  };
}

function codexTerminal(env = process.env) {
  try { return codexBinary(env); }
  catch (error) {
    const shim = isWindows && resolveCommand('codex', codexSearchEnvironment(env), undefined, ['.cmd', '.bat', '.ps1']);
    if (shim) return { file: shim, args: [] };
    throw error;
  }
}

export function inventory(env = process.env) {
  const shell = shellCommand(env);
  const shellAvailable = path.isAbsolute(shell.file) ? existsSync(shell.file) : !!commandPath(shell.file, env);
  let codexAvailable;
  try { codexAvailable = !!codexTerminal(env); } catch { codexAvailable = false; }
  return AGENTS.map(agent => ({ ...agent, available: agent.id === 'shell' ? shellAvailable : agent.id === 'codex' ? codexAvailable : !!commandPath(agent.command, env) }));
}

// Resolve the real Codex binary when available so JSON-RPC does not pass through a shell.
export function codexBinary(env = process.env, home) {
  env = codexSearchEnvironment(env);
  let unreadable = false;
  const isFile = file => {
    try { return statSync(file, { throwIfNoEntry: false })?.isFile() === true; }
    catch (error) {
      if (error.code !== 'ENOTDIR') unreadable = true;
      return false;
    }
  };
  const unavailable = () => unreadable
    ? new Error('Alpha could not read a Codex CLI search location. Check access to the CLI from the signed-in account.')
    : new Error('Alpha could not find the Codex CLI in the configured search locations. Check its installation for this user.');
  if (!isWindows) {
    const executable = resolveCommand('codex', env, home, [''], isFile);
    if (executable) return { file: executable, args: [] };
    throw unavailable();
  }
  const triple = process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
  const platformPackage = `codex-win32-${process.arch}`;
  for (const roaming of windowsAppDataFolders(env, home).roaming) {
    const npmRoot = path.join(roaming, 'npm', 'node_modules', '@openai');
    for (const root of [path.join(npmRoot, 'codex', 'node_modules', '@openai', platformPackage), path.join(npmRoot, platformPackage), path.join(npmRoot, 'codex')]) {
      for (const directory of ['bin', 'codex']) {
        const candidate = path.join(root, 'vendor', triple, directory, 'codex.exe');
        if (isFile(candidate)) return { file: candidate, args: [] };
      }
    }
    const js = path.join(npmRoot, 'codex', 'bin', 'codex.js');
    if (isFile(js)) return { file: process.execPath, args: [js] };
  }
  const executable = resolveCommand('codex', env, home, ['.exe', ''], isFile);
  if (executable) return { file: executable, args: [] };
  if (resolveCommand('codex', env, home, ['.cmd', '.bat', '.ps1'], isFile)) {
    throw new Error('Alpha found a Codex command shim but could not locate its executable. Check the Codex installation or PATH for this user.');
  }
  throw unavailable();
}

// Conversation IDs become CLI arguments. One shaped like an option would be
// parsed as an option, for example a CLI's own permission-bypass flag.
export function nativeConversationId(value) {
  if (value == null || value === '') return undefined;
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new Error('This conversation ID is not valid. Copy it again from the CLI.');
  return value;
}

export function terminalCommand(agent, { bypass = false, resumeId, nativeId, effort, opencodeMajor = 1, antigravityLog, initialPrompt } = {}) {
  if (!AGENTS.some(item => item.id === agent)) throw new Error('Unknown agent');
  resumeId = nativeConversationId(resumeId); nativeId = nativeConversationId(nativeId);
  if (initialPrompt !== undefined && (agent !== 'codex' || !resumeId || typeof initialPrompt !== 'string' || !initialPrompt.trim() || initialPrompt.length > 16000)) throw new Error('A restart prompt requires a saved Codex conversation and a bounded note.');
  const command = agent === 'shell' ? shellCommand() : agent === 'gitbash' ? { file: gitBashPath(), args: ['--login', '-i'] } : agent === 'codex' ? codexTerminal() : { file: commandPath(AGENTS.find(item => item.id === agent).command), args: [] };
  if (!command || !command.file) throw new Error(`${agent} is not installed on this computer`);
  if (agent === 'shell' && (path.isAbsolute(command.file) ? !existsSync(command.file) : !commandPath(command.file))) throw new Error('The local shell is not available on this computer');
  const args = [];
  if (agent === 'codex') {
    if (resumeId) args.push('resume', resumeId);
    // Inline mode retains xterm scrollback for new and resumed conversations.
    args.push('--no-alt-screen');
    if (bypass) args.push('--dangerously-bypass-approvals-and-sandbox');
    if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
  } else if (agent === 'claude') {
    if (resumeId) args.push('--resume', resumeId);
    else if (nativeId) args.push('--session-id', nativeId);
    if (bypass) args.push('--dangerously-skip-permissions');
    if (effort) args.push('--effort', effort);
  } else if (agent === 'antigravity') {
    if (resumeId && !validAntigravityId(resumeId)) throw new Error('Use the Antigravity conversation UUID from its /resume picker.');
    if (resumeId) args.push('--conversation', resumeId);
    if (bypass) args.push('--dangerously-skip-permissions');
    if (effort) args.push('--effort', effort);
    if (antigravityLog) args.push('--log-file', antigravityLog);
  } else if (agent === 'kimi') {
    if (resumeId) args.push('--session', resumeId);
    if (bypass) args.push('--yolo');
  } else if (agent === 'opencode') {
    // A private v2 server keeps each tab's observer and native session separate.
    if (opencodeMajor >= 2) args.push('--standalone');
    if (resumeId) args.push('--session', resumeId);
    if (bypass) args.push('--auto');
  }
  if (initialPrompt) args.push('--', initialPrompt);
  if (!isWindows || ['shell', 'gitbash'].includes(agent)) return { file: command.file || command, args: [...(command.args || []), ...args] };
  // No -NoExit: stale coordinator input cannot become shell commands after the agent exits.
  return wrapCommand(command.file, [...(command.args || []), ...args]);
}

export function childEnvironment(repo) {
  const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', CHERE_INVOKING: '1' };
  // Forward only explicitly named MCP credentials. Voice and unrelated API keys
  // stay private to the service; CLI subscription authentication is unchanged.
  if (repo) {
    const values = parseEnv(readDotEnv(path.join(repo, '.env')));
    for (const [name, value] of Object.entries(values)) if (/^ALPHA_MCP_[A-Z0-9_]+$/.test(name) && !env[name]) env[name] = value;
  }
  // Drop host-agent identity from the parent so every terminal is an independent CLI.
  for (const key of Object.keys(env)) {
    if (/^(CLAUDECODE|CLAUDE_CODE_ENTRYPOINT|CODEX_THREAD_ID|CODEX_TURN_ID|CODEX_SHELL|ANTIGRAVITY_AGENT|ALPHA_TOKEN|ALPHA_PARENT_PID|ALPHA_WINDOWS_CLI_ROAMING|ALPHA_WINDOWS_CLI_LOCAL)$/.test(key) || key.startsWith('ALPHA_OPENCODE_')) delete env[key];
  }
  return env;
}

export function readDotEnv(file) {
  try { return readFileSync(file, 'utf8'); } catch { return ''; }
}
