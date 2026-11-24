import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir,mkdtemp,writeFile } from 'node:fs/promises';
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
await writeFile(path.join(reports,'other.html'), asset.replace('<h1>Fixture</h1>', '<h1>Other fixture</h1>'));
const fixture = {id:project, title:'Source fixture', folder:'fixture', workspacePath,
  steps:[...Array.from({length:8},(_,i)=>({name:'Other '+i,path:'other.html'})),{name:'Shared Drive',path:'shared-drive.html'}]};
await writeFile(path.join(repo,'workspace.json'), JSON.stringify({entities:[fixture]}));
const calls = [];
let service;
service = await createService({repo,uiDir:path.resolve('dist'),mcpOptions:{home:repo,env:{}}, native(event) {
  if (event.type !== 'shared-drive-original') return;
  calls.push(event);
  const data = event.action === 'status' ? {available:true} : {text:'Synthetic',revision:'a'.repeat(64)};
  service.nativeMessage({type:event.type,requestId:event.requestId,result:data});
}});
const browser = await launchBrowser();
try {
  const page = await browser.newPage();
  await page.goto(service.urls.workspace + '#/'+project+'/8');
  const report = page.frameLocator('iframe.report-frame');
  await expect(report.getByText('Fixture')).toBeVisible();
  const request = (action, relativePath) => report.locator('body').evaluate((body,{action,relativePath}) =>
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
      document.dispatchEvent(new CustomEvent('alpha:shared-drive-request',{detail:{requestId,action,relativePath}}));
    }), {action,relativePath});
  assert.deepEqual((await request('status')).result,{available:true});
  assert.equal((await request('text','nested/fixture.txt')).result.text,'Synthetic');
  assert.equal((await request('text','../fixture.txt')).status,400);
  assert.deepEqual(calls.map(event=>event.action),['status','text']);
  await report.getByRole('link', { name: 'Other document' }).click();
  await expect(report.getByRole('heading', { name: 'Other fixture' })).toBeVisible();
  await expect(page).toHaveURL(/\/8$/);
  assert.equal(await request('text','nested/fixture.txt'),null);
  await page.getByRole('button',{name:'Other 0',exact:true}).click();
  await expect(page).toHaveURL(/\/0$/);
  await expect(report.getByRole('heading', { name: 'Other fixture' })).toBeVisible();
  assert.equal(await request('text','nested/fixture.txt'),null);
  assert.equal(calls.length,2);
  console.log('Isolated Alpha iframe bridge passed status, text routing, traversal rejection, and other-tab denial.');
} finally { await browser.close(); await service.close(); }
