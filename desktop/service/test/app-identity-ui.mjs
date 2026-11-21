import { tmpdir as isolatedTmpdir } from 'node:os';
// Fixed brand rendering and native bundle assets, using isolated state only.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect } from '@playwright/test';
import { createService } from '../server.mjs';
import { launchBrowser } from './browser.mjs';

await mkdir('.test-output', { recursive: true });
const repo = await mkdtemp(path.join(process.env.RUNNER_TEMP || isolatedTmpdir(), 'alpha-app-identity-'));
await mkdir(path.join(repo, 'workspace'));
await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[]}');
const service = await createService({ repo, uiDir: path.resolve('dist'), restoreSessions: false, checkUpdates: false, mcpOptions: { home: repo, env: {} } });
const hash = value => createHash('sha256').update(value).digest('hex');
const checks = [], screenshots = [];
let browser;
const request = async (route, data) => {
  const response = await fetch(service.origin + '/api' + route, { method: 'POST', headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  assert.ok(response.ok, await response.clone().text()); return response.json();
};
try {
  const icon = await readFile('src-tauri/icons/icon.ico');
  assert.equal(icon.readUInt16LE(2), 1);
  const frames = Array.from({ length: icon.readUInt16LE(4) }, (_, i) => {
    const entry = 6 + i * 16, size = icon[entry] || 256;
    assert.equal(icon[entry + 1] || 256, size);
    const png = icon.subarray(icon.readUInt32LE(entry + 12), icon.readUInt32LE(entry + 12) + icon.readUInt32LE(entry + 8));
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.equal(png.readUInt32BE(16), size); assert.equal(png.readUInt32BE(20), size);
    return { size, url: `data:image/png;base64,${png.toString('base64')}` };
  });
  assert.deepEqual(frames.map(item => item.size), [16, 20, 24, 32, 40, 48, 64, 128, 256]);
  for (const file of ['public/identity/alpha.ico', 'src-tauri/icons/chats.ico']) assert.deepEqual(await readFile(file), icon);
  const config = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8'));
  for (const file of config.bundle.icon) assert.ok((await readFile(path.join('src-tauri', file))).length);
  for (const file of ['alpha.svg', 'alpha.png', 'alpha.ico']) assert.deepEqual(await readFile(`dist/identity/${file}`), await readFile(`public/identity/${file}`));
  checks.push('Nine Windows ICO frames and legacy aliases agree; configured native paths exist; production UI includes exact fixed SVG/PNG/ICO.');

  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1200, height: 860 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(service.urls.workspace);
  const brand = page.locator('.mdi-brand .app-identity');
  await expect(brand).toBeVisible(); await brand.evaluate(image => image.decode());
  const originalImage = await brand.screenshot();
  await writeFile(path.join(repo, 'brand-original.png'), originalImage);
  const original = hash(originalImage);
  const custom = await request('/themes', { action: 'create', label: 'Identity stress fixture', controller: 'Fixture persona', icon: '/art/rena.png', backdrop: '/art/rena-background.png', background: '#280a31', foreground: '#ffff00', accent: '#ff0000' });
  for (const id of ['alpha', 'smurfs', 'higurashi', custom.appTheme]) for (const appearance of ['light', 'dark']) {
    await request('/settings', { appTheme: id, workspaceTheme: appearance });
    await expect(page.locator('html')).toHaveAttribute('data-alpha-theme', id);
    await expect(page.locator('html')).toHaveAttribute('data-workspace-theme', appearance);
    await expect(brand).toHaveAttribute('src', '/identity/alpha.svg');
    const capture = await brand.screenshot();
    await writeFile(path.join(repo, `brand-${id}-${appearance}.png`), capture);
    assert.equal(hash(capture), original, `Brand pixels changed for ${id}/${appearance}; inspect ${repo}; bounds ${JSON.stringify(await brand.boundingBox())}`);
    assert.equal(await brand.evaluate(el => getComputedStyle(el).filter), 'none');
    await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', '/identity/alpha.svg');
  }
  await page.reload(); await expect(brand).toBeVisible();
  assert.equal(hash(await brand.screenshot()), original);
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await page.getByRole('menuitem', { name: /Settings/ }).click();
  const settings = page.getByRole('tabpanel', { name: 'Settings' });
  await settings.getByRole('tab', { name: 'Theme', exact: true }).click();
  await expect(settings.getByLabel('Persona artwork')).toHaveValue('/art/rena.png');
  await expect(settings.locator('.application-theme-preview img')).toHaveAttribute('src', '/art/rena.png');
  await expect(settings.getByText(/app icon stays the same in every theme/)).toBeVisible();
  const settingsImage = path.join(repo, 'theme-identity-separation.png');
  await page.screenshot({ path: settingsImage }); screenshots.push(settingsImage);
  checks.push('Brand screenshot bytes identical across three built-ins, a custom red/yellow theme, light/dark and reload; favicon invariant; custom persona artwork retained in Settings.');

  const preview = await browser.newPage({ viewport: { width: 1140, height: 780 } });
  const svg = await readFile('public/identity/alpha.svg');
  const source = `data:image/svg+xml;base64,${svg.toString('base64')}`;
  await preview.setContent(`<style>body{margin:0;padding:32px;background:#e9edf2;font:16px Segoe UI;color:#132238}h1{margin:0 0 8px}p{margin:0 0 24px}.grid{display:grid;grid-template-columns:360px 1fr;gap:30px}.panel{padding:24px;border-radius:8px;background:white}.dark{background:#121923;color:#edf2f8}.sizes{display:flex;align-items:end;gap:22px;min-height:92px}.sample{text-align:center}.sample small{display:block;margin-top:12px}img{display:block}.hero{width:320px;height:320px}.zoom{image-rendering:pixelated}.note{margin-top:24px;line-height:1.6}</style><h1>Alpha application identity</h1><p>Unreleased preview · fixed #0F68F0 blue and filled white brain · independent of theme</p><div class="grid"><div><img class="hero" src="${source}"><p class="note">Canonical SVG at 320 px.<br>Square corners follow the owner's request.<br>Flat blue follows MessageCraft's palette.</p></div><div>${['panel','panel dark'].map(cls=>`<div class="${cls}"><div class="sizes">${frames.filter(f=>f.size<=64).map(f=>`<div class="sample"><img src="${f.url}" width="${f.size}" height="${f.size}"><small>${f.size}px</small></div>`).join('')}</div></div>`).join('')}<p class="note">Actual PNG frames extracted from the generated Windows ICO, shown at native size.</p><div class="sizes">${frames.filter(f=>[16,20,32].includes(f.size)).map(f=>`<div class="sample"><img class="zoom" src="${f.url}" width="${f.size*4}" height="${f.size*4}"><small>${f.size}px at 4×</small></div>`).join('')}</div></div></div>`);
  for (const img of await preview.locator('img').all()) await img.evaluate(el => el.decode());
  for (const frame of frames) {
    const result = await preview.evaluate(async frame => {
      const image = new Image(); image.src = frame.url; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = frame.size;
      const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
      const pixels = ctx.getImageData(0, 0, frame.size, frame.size).data;
      let white = 0, whiteCoverage = 0, transparent = 0;
      for(let i=0;i<pixels.length;i+=4) { if(pixels[i+3]!==255) transparent++; if(pixels[i]===255&&pixels[i+1]===255&&pixels[i+2]===255) white++; whiteCoverage += (pixels[i] - 15) / 240; }
      return { corner: Array.from(pixels.slice(0,4)), white, whiteCoverage, transparent };
    }, frame);
    assert.deepEqual(result.corner, [15, 104, 240, 255]); assert.equal(result.transparent, 0);
    // Count antialiased edge coverage at 16px, while requiring genuinely solid interiors.
    assert.ok(result.white > frame.size ** 2 * .1); assert.ok(result.whiteCoverage > frame.size ** 2 * .3);
  }
  const sheet = path.join(repo, 'alpha-icon-preview.png'); await preview.screenshot({ path: sheet }); screenshots.push(sheet);
  checks.push('ICO frames decoded at native sizes: opaque blue corners, solid white brain area; light/dark contact sheet and 4x small-size zooms captured.');
  assert.deepEqual(errors, []);
  await writeFile(path.join(repo, 'results.json'), JSON.stringify({ status: 'passed', fixtureOnly: true, checks, screenshots, canonicalHash: hash(svg), icoHash: hash(icon), installedNativeObserved: false }, null, 2));
  console.log(`App identity checks passed: ${repo}`);
} finally { await browser?.close(); await service.close(); }
