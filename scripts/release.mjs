import { readFile, mkdir, readdir, copyFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
const product = JSON.parse(await readFile('package.json', 'utf8'));
const tauri = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8'));
const service = JSON.parse(await readFile('desktop/service/package.json', 'utf8'));
const serviceLock = JSON.parse(await readFile('desktop/service/package-lock.json', 'utf8'));
if (tauri.version !== product.version || service.version !== product.version || serviceLock.version !== product.version || serviceLock.packages?.['']?.version !== product.version || tauri.identifier !== 'com.jazcosolutions.alpha') throw new Error('Product, service, lockfile versions or namespace do not match.');
if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== 'v' + product.version) throw new Error('Release tag does not match the product version.');
await mkdir('release', { recursive: true });
async function artifact(bundle, sourceName, releaseName) {
  if (!(await readdir(bundle)).includes(sourceName)) throw new Error(`Missing Windows installer: ${sourceName}`);
  await copyFile(path.join(bundle, sourceName), path.join('release', releaseName));
  return releaseName;
}
const msi = await artifact('src-tauri/target/release/bundle/msi',
  `Alpha_${product.version}_x64_en-US.msi`, `Alpha-${product.version}-windows-x64.msi`);
// The first transition release keeps the old updater's exact EXE asset name.
// After that release is installed, its newer updater can consume MSI manifests.
const bridge = process.env.ALPHA_BRIDGE_NSIS === '1';
const name = bridge
  ? await artifact('src-tauri/target/release/bundle/nsis',
      `Alpha_${product.version}_x64-setup.exe`, `Alpha-Setup-${product.version}-x64.exe`)
  : msi;
const bytes = await readFile(path.join('release', name));
const manifest = { version: product.version, platform: 'windows-x64', url: `https://github.com/william-pyle/Alpha/releases/download/v${product.version}/${name}`, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
await writeFile('release/alpha-update.json', JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify(manifest));
