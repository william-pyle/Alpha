// Canonical SVG -> existing Tauri raster/bundle pipeline. No theme or GLB input.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, readdir, copyFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const cli = path.join(path.dirname(createRequire(import.meta.url).resolve('@tauri-apps/cli/package.json')), 'tauri.js');
const run = args => {
  const result = spawnSync(process.execPath, [cli, ...args], { stdio: 'inherit', windowsHide: true });
  if (result.error || result.status !== 0) throw result.error || new Error(`Icon generation failed: ${result.status}`);
};
const identity = path.join(root, 'public/identity');
const native = path.join(root, 'src-tauri/icons');
await mkdir(path.join(root, '.cache'), { recursive: true });
const generated = await mkdtemp(path.join(root, '.cache/alpha-icons-'));
const source = path.join(identity, 'alpha.svg');
await run(['icon', source, '--output', generated]);
for (const name of await readdir(generated)) {
  if (/\.(png|ico|icns)$/.test(name)) await copyFile(path.join(generated, name), path.join(native, name));
}
const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const raster = path.join(generated, 'sizes');
await run(['icon', source, '--output', raster, ...[...sizes, 512, 1024].flatMap(size => ['--png', String(size)])]);
// Include intermediate Windows DPI sizes rather than relying on Shell scaling.
const images = await Promise.all(sizes.map(size => readFile(path.join(raster, `${size}x${size}.png`))));
const header = Buffer.alloc(6 + sizes.length * 16);
header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
sizes.forEach((size, index) => {
  const entry = 6 + index * 16;
  header[entry] = header[entry + 1] = size === 256 ? 0 : size;
  header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(images[index].length, entry + 8); header.writeUInt32LE(offset, entry + 12);
  offset += images[index].length;
});
const ico = Buffer.concat([header, ...images]);
for (const file of [path.join(native, 'icon.ico'), path.join(native, 'chats.ico'), path.join(identity, 'alpha.ico')]) await writeFile(file, ico);
await copyFile(path.join(raster, '64x64.png'), path.join(native, '64x64.png'));
await copyFile(path.join(raster, '128x128.png'), path.join(native, 'chats-128x128.png'));
await copyFile(path.join(raster, '512x512.png'), path.join(identity, 'alpha.png'));
console.log(`Generated fixed Alpha identity from ${source}; Windows frames: ${sizes.join(', ')}.`);
