import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createService } from '../server.mjs';
import { resolveWorkspace } from '../workspace-location.mjs';
import { launchBrowser } from './browser.mjs';

await mkdir('.test-output',{recursive:true});
const root=await realpath(await mkdtemp(path.resolve('.test-output/location-ui-')));
const configDir=path.join(root,'config'), repo=await resolveWorkspace({configDir,defaultRoot:path.join(root,'Original')});
const destination=path.join(root,'Chosen Workspace é 日本語');
const service=await createService({repo,uiDir:path.resolve('dist'),workspaceLocation:{configDir},mcpOptions:{home:root,env:{}},native:event=>{
  if(event.type==='pick-workspace-folder') queueMicrotask(()=>service.nativeMessage({type:'workspace-folder-picked',requestId:event.requestId,path:destination}));
}});
let browser;
try {
  browser=await launchBrowser();const page=await browser.newPage({viewport:{width:1280,height:900}}), errors=[];
  page.on('pageerror',error=>errors.push(error.message));await page.goto(service.urls.workspace);
  await page.getByRole('button',{name:'Toggle settings',exact:true}).click();
  const location=page.getByRole('region',{name:'Workspace location'});
  await expect(location).toContainText(repo);
  await location.getByRole('button',{name:'Browse…',exact:true}).click();
  await expect(location.getByLabel('Workspace folder',{exact:true})).toHaveValue(destination);
  await location.getByRole('button',{name:'Save location',exact:true}).click();
  await expect(location.getByRole('status')).toContainText('Saved for next launch');
  assert.equal(JSON.parse(await readFile(path.join(configDir,'repository.json'),'utf8')),repo);
  await assert.rejects(readFile(path.join(destination,'workspace/workspace.json')),{code:'ENOENT'});
  await page.reload();await page.getByRole('button',{name:'Toggle settings',exact:true}).click();
  await expect(location.getByRole('status')).toContainText(destination);
  for(const theme of ['alpha','smurfs','higurashi']) {
    await page.getByLabel('Application theme',{exact:true}).selectOption(theme);
    for(const width of [1280,390]) {
      await page.setViewportSize({width,height:900});await location.scrollIntoViewIfNeeded();
      assert.equal(await page.locator('.settings-scroll').evaluate(node=>node.scrollWidth<=node.clientWidth+1),true);
      await page.screenshot({path:path.join(root,`settings-${theme}-${width}.png`)});
    }
  }
  await location.getByRole('button',{name:'Cancel location change',exact:true}).click();await expect(location.getByRole('status')).toHaveCount(0);
  await location.getByLabel('Workspace folder',{exact:true}).fill('relative/path');
  await location.getByRole('button',{name:'Save location',exact:true}).click();await expect(location.getByRole('alert')).toContainText('absolute');
  const existing=path.join(root,'Existing');await mkdir(path.join(existing,'workspace'),{recursive:true});await writeFile(path.join(existing,'workspace/workspace.json'),'{"entities":[]}');
  await location.getByLabel('Workspace folder',{exact:true}).fill(existing);await location.getByRole('combobox',{name:/When Alpha next starts/}).selectOption('existing');
  await location.getByRole('button',{name:'Save location',exact:true}).click();await expect(location.getByRole('status')).toContainText(existing);
  assert.deepEqual(errors,[]);
  await writeFile('.test-output/workspace-location-ui-result.json',JSON.stringify({passed:true,root,checks:['Browse result','Editable folder','Save for next launch','No immediate copy or restart','Reload persistence','Cancel change','Invalid path','Open existing','Three themes at desktop and narrow widths']},null,2));
  console.log('Workspace location UI passed: picker, save, cancel, validation, persistence and responsive themes.');
} finally {await browser?.close();await service.close();}
