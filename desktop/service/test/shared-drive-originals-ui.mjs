import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir,mkdtemp,rm,writeFile } from 'node:fs/promises';
import { createService } from '../server.mjs';
import { launchBrowser } from './browser.mjs';
import { expect } from '@playwright/test';
const repo = await mkdtemp(path.join(tmpdir(), 'alpha-shared-drive-bridge-'));
const project = 'author-ashlyn-brooks', workspacePath = 'projects/' + project + '/workspace';
const originals = path.join(repo, 'projects', project, 'SharedDrive');
const reports = path.join(repo, workspacePath);
await mkdir(originals, {recursive:true}); await mkdir(reports,{recursive:true});
await writeFile(path.join(repo,'projects',project,'project.json'),JSON.stringify({sharedDrive:{sync:{mirrorFolder:'SharedDrive'}}}));
const asset = '<!doctype html><html><head><title>Fixture</title></head><body><h1>Fixture</h1><a href="other.html">Other document</a></body></html>';
await writeFile(path.join(reports,'shared-drive.html'), asset);
await writeFile(path.join(reports,'other.html'), asset.replace('<h1>Fixture</h1>',
  '<h1>Other fixture</h1><script>addEventListener("message", e => {' +
  'if (e.data?.type === "alpha:shared-drive-result") document.body.dataset.sharedDriveReply = "received";' +
  '});</script><img src="hold-load.png" alt="">'));
await writeFile(path.join(reports,'hold-load.png'), '');
const fixture = {id:project, title:'Source fixture', folder:'fixture', workspacePath,
  steps:[...Array.from({length:8},(_,i)=>({name:'Other '+i,path:'other.html'})),{name:'Shared Drive',path:'shared-drive.html'}]};
await writeFile(path.join(repo,'workspace.json'), JSON.stringify({entities:[fixture]}));
const calls = [];
const rejections = new Set();
let holdReply = false;
let pendingReply;
let service;
service = await createService({repo,uiDir:path.resolve('dist'),mcpOptions:{home:repo,env:{}}, native(event) {
  if (event.type !== 'shared-drive-original') return;
  calls.push(event);
  let data;
  switch (event.action) {
    case 'status': data = {available:true}; break;
    case 'list-rejections': data = { rejections: [...rejections].sort() }; break;
    case 'set-rejection':
      if (event.rejected) rejections.add(event.relativePath);
      else rejections.delete(event.relativePath);
      data = { relativePath: event.relativePath, rejected: event.rejected };
      break;
    default: data = {text:'Synthetic',revision:'a'.repeat(64)};
  }
  const respond = () => service.nativeMessage({type:event.type,requestId:event.requestId,result:data});
  if (holdReply) pendingReply = respond;
  else respond();
}});
const browser = await launchBrowser();
try {
  const page = await browser.newPage();
  await page.goto(service.urls.workspace + '#/'+project+'/8');
  const report = page.frameLocator('iframe.report-frame');
  await expect(report.getByText('Fixture')).toBeVisible();
  const request = (action, relativePath, rejected) => report.locator('body').evaluate((body,detail) =>
    new Promise(resolve => {
      const requestId = crypto.randomUUID();
      let timer;
      function receive(event) {
        if (event.detail.requestId !== requestId) return;
        clearTimeout(timer);
        document.removeEventListener('alpha:shared-drive-result',receive);
        resolve(event.detail);
      }
      timer=setTimeout(()=>{document.removeEventListener('alpha:shared-drive-result',receive);resolve(null)},1500);
      document.addEventListener('alpha:shared-drive-result',receive);
      document.dispatchEvent(new CustomEvent('alpha:shared-drive-request',{detail:{requestId,...detail}}));
    }), {action,relativePath,rejected});
  assert.deepEqual((await request('status')).result,{available:true});
  assert.equal((await request('text','nested/fixture.txt')).result.text,'Synthetic');
  assert.equal((await request('text','../fixture.txt')).status,400);
  assert.deepEqual((await request('list-rejections')).result, { rejections: [] });
  assert.deepEqual((await request('set-rejection', 'nested\\fixture.txt', true)).result,
    { relativePath: 'nested/fixture.txt', rejected: true });
  await page.reload();
  await expect(report.getByRole('heading', { name: 'Fixture' })).toBeVisible();
  assert.deepEqual((await request('list-rejections')).result, { rejections: ['nested/fixture.txt'] });
  assert.deepEqual((await request('set-rejection', 'nested/fixture.txt', false)).result,
    { relativePath: 'nested/fixture.txt', rejected: false });
  assert.deepEqual((await request('list-rejections')).result, { rejections: [] });
  assert.equal((await request('set-rejection', 'nested/fixture.txt', 'true')).status, 400);
  assert.deepEqual(calls.map(event=>event.action),
    ['status','text','list-rejections','set-rejection','list-rejections','set-rejection','list-rejections']);
  // Keep the next iframe document between its initial script and its load
  // event while an already-authorized request receives its native result.
  holdReply = true;
  await report.locator('body').evaluate(() => document.dispatchEvent(new CustomEvent('alpha:shared-drive-request',
    { detail: { requestId: 'before-navigation', action: 'list-rejections' } })));
  await expect.poll(() => Boolean(pendingReply)).toBe(true);
  holdReply = false;
  let heldImage;
  await page.route('**/hold-load.png', route => { heldImage = route; });
  await report.getByRole('link', { name: 'Other document' }).click();
  await expect.poll(() => Boolean(heldImage)).toBe(true);
  await expect(report.getByRole('heading', { name: 'Other fixture' })).toBeVisible();
  pendingReply();
  const leaked = await report.locator('body').evaluate(body =>
    new Promise(resolve => setTimeout(() => resolve(body.dataset.sharedDriveReply), 200)));
  assert.equal(leaked, undefined);
  await heldImage.fulfill({ status: 200, body: '' });
  await page.unroute('**/hold-load.png');
  await expect(page).toHaveURL(/\/8$/);
  assert.equal(await request('text','nested/fixture.txt'),null);
  assert.equal(await request('list-rejections'), null);
  await page.getByRole('button',{name:'Other 0',exact:true}).click();
  await expect(page).toHaveURL(/\/0$/);
  await expect(report.getByRole('heading', { name: 'Other fixture' })).toBeVisible();
  assert.equal(await request('text','nested/fixture.txt'),null);
  assert.equal(await request('set-rejection', 'nested/fixture.txt', true), null);
  assert.equal(calls.length,8);
  console.log('Isolated Alpha iframe bridge passed original access, rejection list/set after reload, input validation, navigation isolation, and other-tab denial.');
} finally { await browser.close(); await service.close(); await rm(repo, { recursive: true, force: true }); }
