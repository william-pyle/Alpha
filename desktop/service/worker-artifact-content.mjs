import { fromMarkdown } from 'mdast-util-from-markdown';

const slug = /^[a-z0-9][a-z0-9-]{0,63}$/;
const manifest = 'agents/openai.yaml';
const licenseName = /(?:^|\/)(?:LICENSE|NOTICE|COPYING)(?:\.(?:md|txt))?$/i;
const controls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/u;
const protectedPart = /^(?:\..*|AGENTS\.md|CLAUDE\.md|auth(?:[-_.].*)?|tokens?(?:[-_.].*)?|credentials?(?:[-_.].*)?|passwords?(?:[-_.].*)?|secrets?(?:[-_.].*)?|settings(?:[-_.].*)?|(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?|node_modules|target|sessions|grants|memory|history)$/i;
const credentialText = /-----BEGIN (?:[A-Z0-9 ]*PRIVATE KEY|OPENSSH[^-]*)-----|(?:\b(?:gh[pousr]_[a-z0-9]{12,}|github_pat_[a-z0-9_]{12,}|sk-(?:proj-|ant-)?[a-z0-9_-]{12,}|xox[baprs]-[a-z0-9-]{12,}|(?:AKIA|ASIA)[A-Z0-9]{16}|\d{7,}:[a-z0-9_-]{28,})\b)|\bBearer\s+[a-z0-9+/_=-]{10,}|\b(?:password|passphrase|secret|token|api[_-]?key|credentials?|client[_-]?secret|authorization)\s*["']?\s*[:=]\s*["']?\S{4,}/i;
const permissionText = /(^|\n)\s*(?:"|')?(?:permissionMode|allowedTools|disallowedTools|permissions|permission[-_]mode|grants|mcpServers|sandboxMode|approval_policy|skip_permissions|hooks)(?:"|')?\s*[:=]|--(?:dangerously-skip-permissions|dangerously-bypass-approvals-and-sandbox|allow-dangerously-skip-permissions)\b/im;
const runtimeText = /(?:^|[^a-z0-9_])(?:\.(?:env|alpha|codex|git)(?:[/.\\]|$)|%(?:APPDATA|CODEX_HOME)%|\$(?:env:|\{)?(?:APPDATA|CODEX_HOME)\b|ALPHA_WORKER_REQUEST_TOKEN\b|\.claude[/\\](?:projects|settings|credentials)|\.agents[/\\](?!skills(?:[/\\]|$)))/i;
const cwdName = 'Working directory';
const cwdTitle = 'alpha-working-directory';
const fragment = /^#[a-z0-9][a-z0-9_:-]{0,127}$/i;
const licenseUrl = /^https:\/\/(?:spdx\.org\/licenses\/[a-z0-9-.]+\.html|(?:www\.)?opensource\.org\/license[s]?\/[a-z0-9-]+\/?)$/i;
const publicLicenseReference = /\b(?:https:\/\/spdx\.org\/licenses\/[a-z0-9-.]+\.html|https:\/\/(?:www\.)?opensource\.org\/license[s]?\/[a-z0-9-]+\/?|https?:\/\/(?:www\.)?apache\.org\/licenses(?:\/LICENSE-[0-9.]+)?\/?)(?=$|[\s>,)])/gi;

const diagnostic = {
  'unsupported-format': [422, 'The artifact contains a format or manifest field that Alpha cannot validate.'],
  'unsafe-content': [403, 'The artifact contains a protected reference, permission declaration, or credential-like material.'],
  'unresolved-reference': [409, 'The artifact contains an unresolved or ambiguous path reference. Use an exact supported reference.'],
};

function block(code) {
  const [status, message] = diagnostic[code];
  throw Object.assign(new Error(message), { code, status });
}

function scanSensitive(text) {
  if (controls.test(text) || credentialText.test(text) || permissionText.test(text) || runtimeText.test(text)) block('unsafe-content');
}

function scanUnmapped(text) {
  scanSensitive(text);
  if (/(?:\b[a-z]:[\\/]|(?:^|[\s("'=])(?:\\\\|\/\/|~[\\/]|\.\.?[\\/]|\/[a-z0-9._-]+[\\/])|(?:^|[\s("'=])(?:\$\{?[a-z_][a-z0-9_]*\}?|%[a-z_]+%)[\\/])/im.test(text) ||
      /\b[a-z0-9_-]+(?:[\\/][a-z0-9_.-]+)+\.(?:md|txt|ya?ml|json|toml|py|sh|ps1|[cm]?js|exe|svg|png)\b/i.test(text) ||
      /\b(?:(?:file|https?|smb|ftp|ssh|data):[\\/]|www\.[a-z0-9.-]+\b)/i.test(text)) block('unresolved-reference');
}

function decode(bytes) {
  const source = Buffer.isBuffer(bytes) ? bytes : typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : null;
  if (!source || !source.length || source.length > 96 * 1024) block('unsupported-format');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(source); }
  catch { block('unsupported-format'); }
  if (/\r(?!\n)/.test(text)) block('unsupported-format');
  scanSensitive(text);
  return text;
}

function scalar(input) {
  if (!input || input.length > 1024) block('unsupported-format');
  let value;
  if (input.startsWith('"')) {
    try { value = JSON.parse(input); } catch { block('unsupported-format'); }
  } else if (/^'(?:[^']|'')+'$/.test(input)) {
    value = input.slice(1, -1).replaceAll("''", "'");
  } else {
    // A small, unambiguous YAML string subset. More involved YAML structures
    // must stay in the source project until Alpha has an explicit resolver.
    if (/^[|>!&*{\[\]{}%@\x60:#?]|[ \t]#|:\s|:$|^\s|\s$/.test(input) ||
        /^(?:true|false|on|off|yes|no|null|~|[+-]?(?:\d[\w.+:-]*|\.(?:inf|nan)))$/i.test(input)) block('unsupported-format');
    value = input;
  }
  if (typeof value !== 'string' || !value.trim() || /[\r\n\t]/.test(value)) block('unsupported-format');
  scanSensitive(value);
  return value;
}

function frontmatter(text, required, allowed, artifactId) {
  const source = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!source) {
    if (required || /^---(?:\r?\n|$)/.test(text)) block('unsupported-format');
    return { offset: 0 };
  }
  const fields = new Map();
  let metadata = false;
  for (const line of source[1].split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (line === 'metadata:' && allowed.has('metadata') && !fields.has('metadata')) {
      fields.set('metadata', true);
      metadata = true;
      continue;
    }
    if (metadata && line.startsWith('  ')) {
      const field = /^  short-description: (.+)$/.exec(line);
      if (!field || fields.has('short-description')) block('unsupported-format');
      const value = scalar(field[1]);
      scanUnmapped(value);
      fields.set('short-description', value);
      continue;
    }
    metadata = false;
    const member = /^([a-z][a-z-]*): (.+)$/.exec(line);
    if (!member || !allowed.has(member[1]) || member[1] === 'metadata' || fields.has(member[1])) block('unsupported-format');
    const value = scalar(member[2]);
    if (member[1] !== 'license') scanUnmapped(value);
    fields.set(member[1], value);
  }
  if (required && (fields.get('name') !== artifactId || !fields.has('description'))) block('unsupported-format');
  if (fields.has('metadata') && !fields.has('short-description')) block('unsupported-format');
  return { offset: source[0].length, license: fields.get('license') };
}

function openAiManifest(text) {
  const fields = new Set();
  const [entry, ...lines] = text.trimEnd().split(/\r?\n/);
  if (entry !== 'interface:') block('unsupported-format');
  for (const line of lines) {
    const match = /^  (display_name|short_description|brand_color): ("(?:[^"\\]|\\.)*")$/.exec(line);
    if (!match || fields.has(match[1])) block('unsupported-format');
    fields.add(match[1]);
    const value = scalar(match[2]);
    scanUnmapped(value);
    if (value.length > 160 || (match[1] === 'brand_color' && !/^#[0-9a-f]{6}$/i.test(value))) block('unsupported-format');
  }
  if (!fields.size) block('unsupported-format');
}

function fileLocation(name) {
  return typeof name === 'string' && name.length <= 180 &&
    name.split('/').every(part => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,89}$/.test(part) && !part.endsWith('.') && !protectedPart.test(part));
}

function localReference(value, workingDirectory) {
  const match = /^([a-z]:\/|\/)?([a-z0-9_. -]+(?:\/[a-z0-9_. -]+)*\/?)$/i.exec(value);
  if (!match) block('unresolved-reference');
  const parts = match[2].replace(/\/$/, '').split('/');
  if (parts.some(part => part !== part.trim() || (!['.', '..'].includes(part) && (part.endsWith('.') || protectedPart.test(part) && !['.agents', '.claude'].includes(part))))) {
    block('unsafe-content');
  }
  if (!workingDirectory && value.endsWith('/')) block('unresolved-reference');
}

function linkTarget(raw, node) {
  // Match only the terminal destination of a link already parsed by CommonMark.
  // Reject entity escapes, line wraps and other source forms we cannot preserve
  // exactly while changing just the literal destination.
  const found = (node.type === 'definition'
    ? /^\[[^\]\r\n]+\]:[ \t]*(<[^<>\r\n]+>|[^ \t\r\n()<>]+)(?:[ \t]+(?:"[^"\r\n]*"|'[^'\r\n]*'|\([^()\r\n]*\)))?[ \t]*$/d
    : /\([ \t]*(<[^<>\r\n]+>|[^ \t\r\n()<>]+)(?:[ \t]+(?:"[^"\r\n]*"|'[^'\r\n]*'|\([^()\r\n]*\)))?[ \t]*\)$/d).exec(raw);
  if (!found) block('unsupported-format');
  const brackets = found[1].startsWith('<');
  const [start, end] = found.indices[1];
  if ((brackets ? found[1].slice(1, -1) : found[1]) !== node.url) block('unsupported-format');
  return { start, end, brackets };
}

async function markdown(text, offset, file, mapReference) {
  const body = text.slice(offset);
  let root;
  try { root = fromMarkdown(body); }
  catch { block('unsupported-format'); }
  const nodes = [root];
  const replacements = [];
  let mapped = 0;
  while (nodes.length) {
    const node = nodes.pop();
    if (node.type === 'html' || node.type === 'image' || node.type === 'imageReference') block('unsupported-format');
    if (node.type === 'text' || node.type === 'inlineCode' || node.type === 'code') scanUnmapped(node.value);
    if (node.type === 'text' && /\[[^\]\r\n]+\](?:\[[^\]\r\n]*\]|\()/.test(node.value)) block('unresolved-reference');
    if (node.type === 'code') {
      if (node.lang) scanUnmapped(node.lang);
      if (node.meta) scanUnmapped(node.meta);
    }
    if (node.type === 'inlineCode' && /^[a-z0-9_.-]+\.(?:md|txt|ya?ml|json|toml|py|sh|ps1|[cm]?js|exe|svg|png)$/i.test(node.value)) block('unresolved-reference');
    if (node.children) nodes.push(...node.children.slice().reverse());
    if (node.type === 'link' || node.type === 'definition') {
      scanSensitive(node.url);
      if (node.title) scanUnmapped(node.title);
      const name = node.children?.length === 1 && node.children[0].type === 'text' ? node.children[0].value : null;
      const workingDirectory = node.title === cwdTitle || name === cwdName;
      if (workingDirectory && node.type !== 'link') block('unsupported-format');
      if (!workingDirectory && (fragment.test(node.url) || licenseUrl.test(node.url))) continue;
      const hash = node.url.indexOf('#');
      const target = hash === -1 ? node.url : node.url.slice(0, hash);
      const anchor = hash === -1 ? '' : node.url.slice(hash);
      if (anchor && (workingDirectory || !fragment.test(anchor))) block('unresolved-reference');
      localReference(target, workingDirectory);
      const sourceStart = node.position.start.offset;
      const { start, end, brackets } = linkTarget(body.slice(sourceStart, node.position.end.offset), node);
      if (typeof mapReference !== 'function') block('unresolved-reference');
      const converted = await mapReference({ file, reference: target, type: workingDirectory ? 'working-directory' : 'markdown-link' });
      if (typeof converted !== 'string' || !converted || /^(?:[a-z]:\/|\/)/i.test(converted)) block('unresolved-reference');
      localReference(converted, workingDirectory);
      const replacement = converted + anchor;
      replacements.push({
        start: offset + sourceStart + start,
        end: offset + sourceStart + end,
        text: brackets || replacement.includes(' ') ? '<' + replacement + '>' : replacement,
      });
      ++mapped;
    }
  }
  for (const replace of replacements.sort((a, b) => b.start - a.start)) {
    text = text.slice(0, replace.start) + replace.text + text.slice(replace.end);
  }
  return { text, mapped };
}

export function artifactContentName(kind, artifactId, file) {
  if (typeof artifactId !== 'string' || !slug.test(artifactId) || !fileLocation(file)) return false;
  if (kind === 'skill') return file === 'SKILL.md' || file === manifest ||
    (!file.includes('/') && licenseName.test(file)) ||
    (/^references\/[a-z0-9][a-z0-9_./-]*\.md$/i.test(file) && !licenseName.test(file));
  return ['knowledge', 'agent'].includes(kind) && file === artifactId + '.md';
}

export async function mapArtifactContent({ kind, artifactId, files, mapReference }) {
  const primary = kind === 'skill' ? 'SKILL.md' : artifactId + '.md';
  if (!Array.isArray(files) || files.length > 20 || files.some(file => !file || !artifactContentName(kind, artifactId, file.name)) ||
      !files.some(file => file.name === primary) ||
      new Set(files.map(file => file.name.toLowerCase())).size !== files.length) block('unsupported-format');
  let mapped = 0;
  const output = [];
  for (const file of files) {
    let text = decode(file.bytes);
    if (file.name === manifest) openAiManifest(text);
    else if (licenseName.test(file.name)) {
      if (/<\/?[a-z][^<>]*>/i.test(text)) block('unsupported-format');
      scanUnmapped(text.replace(publicLicenseReference, ''));
    }
    else {
      const allowed = kind === 'skill' ? new Set(['name', 'description', 'license', 'metadata'])
        : kind === 'agent' ? new Set(['name', 'description']) : new Set(['title', 'description', 'license']);
      const { offset, license } = frontmatter(text, file.name === primary && kind !== 'knowledge', allowed, artifactId);
      if (license) {
        const declaredFile = license.replace(/^SEE LICENSE IN /i, '').replace(/^\.\//, '');
        if (licenseName.test(declaredFile)) {
          if (declaredFile.includes('/') || !files.some(entry => entry.name === declaredFile)) block('unresolved-reference');
        } else if (!/^[A-Za-z][A-Za-z0-9.+-]{0,79}$/.test(license)) block('unsupported-format');
      }
      const converted = await markdown(text, offset, file.name, mapReference);
      text = converted.text;
      mapped += converted.mapped;
    }
    output.push({ name: file.name, bytes: Buffer.from(text, 'utf8') });
  }
  return { files: output, mapped };
}
