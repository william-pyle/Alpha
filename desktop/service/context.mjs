import path from 'node:path';
import os from 'node:os';
import { readFile, realpath, stat, readdir } from 'node:fs/promises';
import { within } from './util.mjs';

const ignored = new Set(['node_modules', 'target', 'dist', '__pycache__']);
async function walk(root, accept, output = [], depth = 0) {
  if (depth > 12 || output.length >= 10000) return output;
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (output.length >= 10000) break;
    if (entry.name.startsWith('.') || ignored.has(entry.name) || /^(auth|tokens?|credentials)\./i.test(entry.name) || entry.isSymbolicLink()) continue;
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) await walk(file, accept, output, depth + 1);
    else if (entry.isFile() && accept(entry.name)) output.push(file);
  }
  return output;
}
export class ContextLibrary {
  constructor(repo, { sharedRoot, personalRoots } = {}) {
    this.repo = repo; this.sharedRoot = sharedRoot;
    this.skillRoots = [path.join(repo, '.agents/skills'), path.join(repo, '.claude/skills'), ...(sharedRoot ? [path.join(sharedRoot, '.agents/skills'), path.join(sharedRoot, '.claude/skills')] : []), ...(personalRoots || [path.join(os.homedir(), '.agents/skills'), path.join(os.homedir(), '.codex/skills'), path.join(os.homedir(), '.codex/plugins/cache')])];
  }
  async orientation() {
    const shared = this.sharedRoot ? `Alpha's reusable shared library is ${this.sharedRoot}. Read its LIBRARY.md for the index and usage. Shared skills, knowledge and workflows are available to all projects; the active project's instructions and specific definitions take precedence. Include relevant absolute shared skill/reference paths when handing work to a chat. Child terminals receive ALPHA_SHARED_LIBRARY with this path. Read only material needed for the current task.\n\n` : '';
    const names = ['AGENTS.md', 'context/me.md', 'context/identity.md', 'context/goals.md', 'context/preferences.md', 'desktop/coordinator.md'];
    const parts = await Promise.all(names.map(async name => { const text = await readFile(path.join(this.repo, name), 'utf8').catch(() => ''); return text ? `## ${name}\n${text.slice(0, 14000)}` : ''; }));
    return shared + parts.filter(Boolean).join('\n\n').slice(0, 38000);
  }
  async skills(query = '') {
    const result = [], seen = new Set();
    for (const root of this.skillRoots) {
      for (const file of await walk(root, name => name === 'SKILL.md')) {
        const text = await readFile(file, 'utf8').catch(() => '');
        const name = /^name:\s*(.+)$/m.exec(text)?.[1]?.replace(/^['"]|['"]$/g, '') || path.basename(path.dirname(file));
        const description = /^description:\s*(.+)$/m.exec(text)?.[1]?.replace(/^['"]|['"]$/g, '') || '';
        if (seen.has(name)) continue;
        seen.add(name);
        if (query && !`${name} ${description}`.toLowerCase().includes(query.toLowerCase())) continue;
        result.push({ name, description: description.slice(0, 260), path: file, scope: this.sharedRoot && within(this.sharedRoot, file) ? 'shared' : within(this.repo, file) ? 'project' : 'personal' });
      }
    }
    return { skills: result.slice(0, 180), total: result.length };
  }
  async read(file, offset = 0) {
    const actual = await realpath(path.resolve(this.repo, file));
    const trustedSkill = (await Promise.all(this.skillRoots.map(root => realpath(root).catch(() => null)))).some(root => root && within(root, actual));
    const shared = this.sharedRoot && within(await realpath(this.sharedRoot), actual);
    const relative = path.relative(shared ? this.sharedRoot : this.repo, actual);
    const privateFile = relative.split(/[\\/]/).some(part => part.startsWith('.'));
    const credential = /(?:^|[/\\])(?:\.env(?:\..*)?|auth\.[^/\\]+|tokens?\.[^/\\]+|credentials\.[^/\\]+|settings\.local\.json)$/i.test(actual);
    if ((!within(this.repo, actual) && !shared && !trustedSkill) || (!trustedSkill && privateFile) || credential || !/\.(md|txt|json|toml|ya?ml|html|css|mjs|py)$/i.test(actual)) throw new Error('Read a project context document or shared library resource. Private runtime and credential files are excluded.');
    if ((await stat(actual)).size > 2 * 1024 * 1024) throw new Error('Choose a context document smaller than 2 MB.');
    const text = await readFile(actual, 'utf8'), start = Math.max(0, Number(offset) || 0);
    return { path: actual, text: text.slice(start, start + 24000), nextOffset: start + 24000 < text.length ? start + 24000 : null };
  }
  async search(query) {
    if (typeof query !== 'string' || !query.trim() || query.length > 200) throw new Error('Use a short context search phrase.');
    const roots = ['context','processes','knowledge','projects'].map(folder => path.join(this.repo, folder));
    if (this.sharedRoot) roots.push(...['knowledge','processes'].map(folder => path.join(this.sharedRoot, folder)));
    let matches = ''; const needle = query.toLowerCase();
    for (const root of roots) for (const file of await walk(root, name => /\.(md|txt|json|ya?ml)$/i.test(name))) {
      if ((await stat(file)).size > 2 * 1024 * 1024) continue;
      const lines = (await readFile(file, 'utf8')).split(/\r?\n/); let hits = 0;
      for (let line = 0; line < lines.length; line++) if (lines[line].toLowerCase().includes(needle)) {
        matches += `${file}:${line + 1}:${lines[line]}\n`; if (++hits === 2) break;
      }
      if (matches.length > 18000) return { matches: matches.slice(0,18000), truncated: true };
    }
    return { matches, truncated: false };
  }
}
