import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { filesBelow, digest, libraryPath } from '../desktop/service/shared-library.mjs';

export async function packageLibrary(destination, source = path.resolve('shared-library'), version) {
  await mkdir(destination, { recursive: true });
  version ||= JSON.parse(await readFile('package.json', 'utf8')).version;
  const manifest = { format: 'alpha-shared-library', schema: 1, version, skills: [], files: {} };
  const forbidden = /^(?:\.git|\.cache|\.alpha|\.alpha-library|node_modules|__pycache__|\.venv|\.env(?:\..*)?|auth\.json|credentials\.json|tokens?\.json|settings\.local\.json)$/i;
  const names = new Set();
  for (const name of await filesBelow(source)) {
    if (!libraryPath(name) || name === 'manifest.json' || name.startsWith('.claude/') || name.split('/').some(part => forbidden.test(part)) || /\.(pyc|pyo|pfx|p12)$/i.test(name)) throw new Error(`Do not package local state or generated mirrors: ${name}`);
    const bytes = await readFile(path.join(source, name));
    if (bytes.length > 25 * 1024 * 1024) throw new Error(`Shared-library file too large: ${name}`);
    for (const target of name.startsWith('.agents/skills/') ? [name, name.replace('.agents/', '.claude/')] : [name]) {
      if (names.has(target.toLowerCase())) throw new Error(`Case-conflicting library path: ${target}`);
      names.add(target.toLowerCase());
      await mkdir(path.dirname(path.join(destination, target)), { recursive: true });
      await writeFile(path.join(destination, target), bytes);
      manifest.files[target] = digest(bytes);
    }
    const skill = /^\.agents\/skills\/([^/]+)\/SKILL\.md$/.exec(name);
    if (skill) manifest.skills.push(skill[1]);
  }
  await writeFile(path.join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = await packageLibrary(path.resolve(process.argv[2] || '.cache/shared-library'));
  console.log(`Shared library: ${manifest.skills.length} skills, ${Object.keys(manifest.files).length} files, version ${manifest.version}.`);
}
