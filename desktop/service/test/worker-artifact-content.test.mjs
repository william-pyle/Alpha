import assert from 'node:assert/strict';
import test from 'node:test';
import { artifactContentName, mapArtifactContent } from '../worker-artifact-content.mjs';

const project = 'synthetic-guide';
const entry = (name, bytes) => ({ name, bytes: Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes) });
const front = '---\nname: synthetic-guide\ndescription: Summarize reference material.\n---\n';
const report = kind => kind === 'skill' ? 'SKILL.md' : project + '.md';
const apply = (kind, text, mapReference = async () => './guide.md') =>
  mapArtifactContent({ kind, artifactId: project, files: [entry(report(kind), text)], mapReference });
const problem = code => ({ code });

test('maps only parsed Markdown destination tokens and preserves license and safe manifest bytes', async () => {
  const licensedFront = front.replace('\n---\n', '\nlicense: LICENSE\n---\n');
  const local = 'C:/Fixtures/User/AppData/Local/Synthetic Source/workspace/.agents/skills/synthetic-guide/references/a.md';
  const skillText = (licensedFront + '# Review\nRead [a guide](<' + local + '#part> "Review text").\nUse [for reference][ref] and [the license](./LICENSE).\n\n[ref]: ./references/a.md\n').replaceAll('\n', '\r\n');
  const manifest = 'interface:\n  display_name: "Fixture reviewer"\n  short_description: "Summarize fixture references"\n  brand_color: "#123abc"\n';
  const license = 'Fixture copyright and required notice.\r\nKeep this text unchanged.\r\n';
  const files = [entry('SKILL.md', skillText), entry('agents/openai.yaml', manifest), entry('LICENSE', license), entry('references/a.md', '# Part\nReturn to [the skill](../SKILL.md).\n')];
  const calls = [];
  const result = await mapArtifactContent({
    kind: 'skill', artifactId: project, files,
    mapReference: ({ file, reference, type }) => {
      calls.push([file, reference, type]);
      if (reference.includes('/references/') || reference.startsWith('./references/')) return './references/a.md';
      return reference;
    },
  });
  assert.equal(result.mapped, 4);
  assert.deepEqual(calls, [
    ['SKILL.md', local, 'markdown-link'],
    ['SKILL.md', './LICENSE', 'markdown-link'],
    ['SKILL.md', './references/a.md', 'markdown-link'],
    ['references/a.md', '../SKILL.md', 'markdown-link'],
  ]);
  assert.equal(result.files[0].bytes.toString(), skillText.replace(local, './references/a.md'));
  assert.deepEqual(result.files[1].bytes, files[1].bytes);
  assert.deepEqual(result.files[2].bytes, files[2].bytes);
  assert.deepEqual(result.files[3].bytes, files[3].bytes);
  assert.deepEqual(files[0].bytes, Buffer.from(skillText));
});

test('validates native standalone knowledge and agent layout and recognizes scoped cwd links', async () => {
  for (const kind of ['knowledge', 'agent']) {
    const body = '# References\n[Working directory](<C:/Fixtures/source/workspace>)\nFollow [the section](#references).\n';
    const original = (kind === 'agent' ? front : '') + body;
    const seen = [];
    const result = await apply(kind, original, input => { seen.push(input); return '../..'; });
    assert.deepEqual(seen, [{
      file: report(kind), reference: 'C:/Fixtures/source/workspace', type: 'working-directory',
    }]);
    assert.equal(result.files[0].bytes.toString(), original.replace('C:/Fixtures/source/workspace', '../..'));
  }
  assert.equal(artifactContentName('skill', project, 'references/a.md'), true);
  assert.equal(artifactContentName('skill', project, 'references/.hidden.md'), false);
  assert.equal(artifactContentName('agent', project, 'settings.local.json'), false);
  assert.equal(artifactContentName('knowledge', project, '../synthetic-guide.md'), false);
  await assert.rejects(apply('agent', '# Missing frontmatter'), problem('unsupported-format'));
});

test('blocks missing or ambiguous paths without rewriting raw prose, unsafe references or unsupported syntax', async () => {
  const unavailable = () => { throw Object.assign(new Error('Fixture path unavailable'), { code: 'unresolved-reference' }); };
  for (const path of ['./missing.md', './guide.md']) {
    await assert.rejects(apply('knowledge', '[Missing or ambiguous](' + path + ')', unavailable), problem('unresolved-reference'));
  }
  await assert.rejects(apply('knowledge', '[Guide](./guide.md)', () => 'C:/External/target.md'), problem('unresolved-reference'));
  await assert.rejects(apply('knowledge', 'Read C:/Fixtures/raw-guide.md first.'), problem('unresolved-reference'));
  await assert.rejects(apply('knowledge', 'Open '+ String.fromCharCode(96) + 'AGENTS.md' + String.fromCharCode(96) + ' first.'), problem('unresolved-reference'));
  await assert.rejects(apply('knowledge', '[Guide](https://site.example/private)'), problem('unresolved-reference'));
  await assert.rejects(apply('knowledge', '[Guide](./%2e%2e/auth.md)'), problem('unresolved-reference'));
  await assert.rejects(apply('knowledge', '[Guide](../.env)'), problem('unsafe-content'));
  await assert.rejects(apply('knowledge', '[Guide](./credentials.md)'), problem('unsafe-content'));
  await assert.rejects(apply('knowledge', 'Inspect %APPDATA%/test first.'), problem('unsafe-content'));
  await assert.rejects(apply('knowledge', 'Read [the guide][unknown].'), problem('unresolved-reference'));
  await assert.rejects(apply('knowledge', 'Read [unknown][].'), problem('unresolved-reference'));
  await assert.rejects(apply('knowledge', '<div>HTML content</div>'), problem('unsupported-format'));
  await assert.rejects(apply('knowledge', '![Embedded content](./image.png)'), problem('unsupported-format'));
});

test('rejects credentials, permission declarations, opaque artifacts, and ambiguous frontmatter', async () => {
  await assert.rejects(apply('skill', front + 'token = "SYNTHETIC_fixture_secret"'), problem('unsafe-content'));
  await assert.rejects(apply('agent', front.replace('\n---\n', '\npermissionMode: bypassPermissions\n---\n')), problem('unsafe-content'));
  await assert.rejects(apply('agent', front.replace('\n---\n', '\nworking-directory: workspace\n---\n')), problem('unsupported-format'));
  await assert.rejects(apply('agent', front.replace('\n---\n', '\nname: repeated\n---\n')), problem('unsupported-format'));
  await assert.rejects(apply('skill', front.replace('name: synthetic-guide', 'name: &alias synthetic-guide')), problem('unsupported-format'));
  await assert.rejects(apply('skill', front.replace('material.', 'material. # unsupported comment')), problem('unsupported-format'));
  await assert.rejects(apply('skill', front.replace('Summarize reference material.', '0xFF')), problem('unsupported-format'));
  await assert.rejects(apply('skill', front.replace('\n---\n', '\nlicense: LICENSE.txt\n---\n')), problem('unresolved-reference'));
  await assert.rejects(apply('knowledge', Buffer.from([0xff, 0x9a])), problem('unsupported-format'));
  const skill = entry('SKILL.md', front);
  const args = { kind: 'skill', artifactId: project };
  for (const unsafe of [
    entry('agents/openai.yaml', 'policy:\n  allow_implicit_invocation: true\n'),
    entry('scripts/guide.py', 'print("fixture")'),
    entry('references/.env', 'VALUE=synthetic'),
    entry('references/archive.zip', [0x50, 0x4b]),
    entry('LICENSE', 'Notice references file:///private/license.txt.'),
  ]) {
    await assert.rejects(mapArtifactContent({ ...args, files: [skill, unsafe] }), error =>
      ['unsupported-format', 'unresolved-reference', 'unsafe-content'].includes(error.code));
  }
  await assert.rejects(mapArtifactContent({ ...args, files: [
    skill, entry('references/Foo.md', '# A'), entry('references/foo.md', '# B'),
  ] }), problem('unsupported-format'));
});
