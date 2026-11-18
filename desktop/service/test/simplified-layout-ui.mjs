// Isolated service and synthetic conversations only; never contacts a live model.
import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createService } from '../server.mjs';
import { launchBrowser, clipboardPermissions } from './browser.mjs';

await mkdir('.test-output', { recursive: true });
const repo = await mkdtemp(path.resolve('.test-output/simplified-layout-'));
await mkdir(path.join(repo, 'workspace')); await mkdir(path.join(repo, '.alpha'));
await writeFile(path.join(repo, 'workspace/workspace.json'), JSON.stringify({ entities: [{ id: 'fixture', title: 'Fixture project', folder: 'fixture', steps: [] }] }));
await writeFile(path.join(repo, '.alpha/settings.json'), '{"speakReplies":false}');
const localFile = path.join(repo, 'example.md'); await writeFile(localFile, '# Local fixture\nOpened deliberately.');
let service = await createService({ repo, uiDir: path.resolve('dist'), mcpOptions: { home: repo, env: {} } });
service.coordinator.ask = async data => ({ ...data, status: 'completed', result: 'NO_CHANGE' });
const a = service.threads.create({ name: 'Simplify conversation layout', purpose: 'Review a comfortable writing layout', projectId: 'fixture' });
const b = service.threads.create({ name: 'Review project decision', purpose: 'Keep decisions in their original conversation', projectId: 'fixture' });
service.threads.select(a.id);
const requests = [], answers = [], checks = [], screenshots = [], metrics = [], errors = [], remote = [];
let releaseAnswer;
const ca = await service.getCoordinator(a.id), cb = await service.getCoordinator(b.id);
ca.ask = async data => { requests.push(data); const result = { ...data, status: 'completed', result: 'Message received in its original conversation.', at: new Date().toISOString() }; ca.emit('result', result); return result; };
cb.ask = async data => { answers.push(data); return new Promise(resolve => { releaseAnswer = () => resolve({ ...data, status: 'completed', result: 'Decision applied.' }); }); };
const markdown = `## A simpler place to write\n\nThe conversation is **primary**. Secondary tools stay available when needed.\n\n| Area | Result |\n| --- | --- |\n| Writing | Comfortable, resizable input |\n| Viewer | Optional in Settings |\n| Questions | Clear after a saved answer |\n\n1. Choose a conversation.\n2. Write your message.\n3. Review the reply.\n\n\`\`\`rust\nfn main() {\n    println!("A clear conversation");\n}\n\`\`\`\n\n[Open local fixture](${localFile.replaceAll('\\', '/')}) · [Documentation](https://example.test/docs)\n\n![remote image](https://unwanted.example/image.png)\n<script>window.unsafeMarkdown = true</script>\n[unsafe](javascript:alert(1))`;
service.threads.message(a.id, { id: 'intro', role: 'user', text: 'Please simplify the layout and make writing comfortable.' });
service.threads.message(a.id, { id: 'markdown', role: 'assistant', text: markdown });
let browser, page;
try {
  browser = await launchBrowser({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  const context = await browser.newContext({ viewport: { width: 960, height: 1000 }, permissions: clipboardPermissions });
  await context.addInitScript(() => {
    window.captureCalls = 0; const media = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (...args) => { window.captureCalls++; return media(...args); };
    window.framesPending = new Set(); const frame = requestAnimationFrame.bind(window), cancel = cancelAnimationFrame.bind(window);
    window.requestAnimationFrame = callback => { let id; id = frame(time => { window.framesPending.delete(id); callback(time); }); window.framesPending.add(id); return id; };
    window.cancelAnimationFrame = id => { window.framesPending.delete(id); cancel(id); };
  });
  page = await context.newPage(); page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/unwanted\.example|example\.test/.test(request.url())) remote.push(request.url()); });
  await page.goto(service.urls.workspace);
  const pane = page.getByRole('region', { name: 'Alpha conversation', exact: true }), editor = pane.getByRole('textbox', { name: 'Message Alpha' }), picker = pane.locator('[role=tab][aria-selected=true]');
  const settings = async () => { await page.getByRole('button', { name: 'Tools', exact: true }).click(); await page.getByRole('menuitem', { name: 'Settings' }).click(); await page.getByRole('tab', { name: 'Conversation', exact: true }).click(); };
  const closeSettings = () => page.getByRole('button', { name: 'Close settings' }).click();
  const menu = async name => { await pane.locator('[role=tab][aria-selected=true]').click({ button: 'right' }); await page.getByRole('menuitem', { name, exact: true }).click(); };
  const notification = async () => { await page.getByRole('button', { name: 'View', exact: true }).click(); await page.getByRole('menuitem', { name: 'Important events', exact: true }).click(); };
  const snap = async name => { const file = path.join(repo, `${name}.png`); await page.screenshot({ path: file }); screenshots.push(file); };
  await expect(editor).toHaveCount(1); await expect(page.getByRole('tablist', { name: 'Sidebar' })).toHaveCount(0);
  await expect(page.locator('.alpha-presence')).toHaveCount(0); await expect(page.locator('.thread-activity')).toHaveCount(0);
  await expect(pane.getByRole('checkbox')).toHaveCount(0); await expect(pane.locator('.thread-phase')).toHaveCount(0);
  await expect(pane.getByRole('table')).toBeVisible(); await expect(pane.getByRole('heading', { name: 'A simpler place to write' })).toBeVisible();
  assert.equal(await page.evaluate(() => !!window.unsafeMarkdown), false); assert.deepEqual(remote, []);
  await pane.getByRole('button', { name: 'Copy code' }).click(); assert.match(await page.evaluate(() => navigator.clipboard.readText()), /fn main/);
  await pane.getByRole('button', { name: 'Open local fixture' }).click(); await expect(page.locator('.mdi-center')).toContainText('Local fixture');
  await expect(page.locator('.mdi-center')).toBeVisible();
  checks.push('One conversation/composer; no competing tabs, persistent Activity, status header or preference toggles. Secure GFM tables/headings/list/code and deliberate local Workspace opening. No remote image loads.');

  await expect(pane.getByRole('button', { name: 'Share this message' })).toHaveCount(0);
  const userMessage = pane.locator('[data-message-id="intro"]'), assistantMessage = pane.locator('[data-message-id="markdown"]');
  const originalCount = service.threads.get(b.id).messages.length;
  await userMessage.click({ button: 'right', position: { x: 20, y: 20 } });
  await page.getByRole('menuitem', { name: 'Copy to another conversation' }).click();
  await page.getByLabel('Destination').selectOption(b.id); await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(service.threads.get(b.id).messages.length, originalCount); await expect(userMessage).toBeFocused();
  await userMessage.press('Shift+F10'); await page.getByRole('menuitem', { name: 'Copy to another conversation' }).click(); await page.getByLabel('Destination').selectOption(b.id); await page.getByRole('button', { name: 'Copy message', exact: true }).click();
  await expect.poll(() => service.threads.get(b.id).messages.length).toBe(originalCount + 1);
  await expect(page.getByRole('dialog', { name: 'Copy to another conversation', exact: true })).toHaveCount(0);
  await expect(userMessage).toBeFocused();
  const copiedUser = service.threads.get(b.id).messages.at(-1); assert.match(copiedUser.text, /Please simplify the layout/); assert.match(copiedUser.text, /Reference explicitly shared from Simplify conversation layout/); assert.equal(copiedUser.images?.length || 0, 0);
  await assistantMessage.focus(); await assistantMessage.press('ContextMenu'); await expect(page.getByRole('menu', { name: 'Message actions' })).toBeVisible(); await page.keyboard.press('Escape'); await expect(assistantMessage).toBeFocused(); await expect(page.getByRole('menu', { name: 'Message actions' })).toHaveCount(0);
  await assistantMessage.press('ContextMenu'); await page.getByRole('menuitem', { name: 'Copy to another conversation' }).click(); await page.getByLabel('Destination').selectOption(b.id); await page.getByRole('button', { name: 'Copy message', exact: true }).click();
  await expect.poll(() => service.threads.get(b.id).messages.length).toBe(originalCount + 2); assert.match(service.threads.get(b.id).messages.at(-1).text, /## A simpler place to write/); assert.equal(requests.length, 0);
  await expect(page.getByRole('dialog', { name: 'Copy to another conversation', exact: true })).toHaveCount(0);
  await expect(assistantMessage).toBeFocused();
  await assistantMessage.locator('h2').evaluate(node => { const range = document.createRange(); range.selectNodeContents(node); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); });
  await assistantMessage.evaluate(node => node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 958, clientY: 998, button: 2 })));
  const contextMenu = page.getByRole('menu', { name: 'Message actions' }); await expect(contextMenu.getByRole('menuitem', { name: 'Copy selected text' })).toBeVisible();
  const menuBounds = await contextMenu.boundingBox(); assert(menuBounds.x >= 0 && menuBounds.y >= 0 && menuBounds.x + menuBounds.width <= 960 && menuBounds.y + menuBounds.height <= 1000);
  await snap('message-context-menu-edge');
  await contextMenu.getByRole('menuitem', { name: 'Copy selected text' }).click(); assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'A simpler place to write');
  await assistantMessage.getByRole('link', { name: 'Documentation' }).dispatchEvent('contextmenu', { clientX: 400, clientY: 400, button: 2 }); await expect(contextMenu).toHaveCount(0);
  await page.locator(`#conversation-tab-${b.id}`).click(); await expect(pane.getByText(/Reference explicitly shared from Simplify conversation layout/).first()).toBeVisible(); await page.locator(`#conversation-tab-${a.id}`).click();
  checks.push('Message context menu: both roles; right-click, ContextMenu and Shift+F10; selected-message-only attributed transfer; cancellation does not copy; destination isolation and no agent work; Escape/focus return; ordinary selected text copy and link context preserved; menu clamped at bottom/right edge.');

  const resize = async (label, delta) => { const divider = page.getByRole('separator', { name: label }); await expect(divider).toBeVisible(); const before = Number(await divider.getAttribute('aria-valuenow')); const box = await divider.boundingBox(); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + delta, { steps: 8 }); await page.mouse.up(); const after = Number(await divider.getAttribute('aria-valuenow')); assert.notEqual(after, before); return { before, after }; };
  const writing = page.getByRole('separator', { name: 'Resize writing area' });
  const pointer = await resize('Resize writing area', -60);
  const size = await editor.boundingBox(); assert(size.height > 150);
  await writing.focus(); await writing.press('ArrowUp'); const savedHeight = Number(await writing.getAttribute('aria-valuenow')); assert(savedHeight > pointer.after);
  const longDraft = Array.from({ length: 50 }, (_, i) => `Line ${i + 1}: editing a substantial message.`).join('\n');
  await editor.fill(longDraft); await editor.press('Control+End'); await editor.press('Shift+Enter'); await editor.press('End'); await editor.type('Final line');
  await page.locator(`#conversation-tab-${b.id}`).click(); await expect(editor).toHaveValue(''); await editor.fill('Private second draft'); await page.locator(`#conversation-tab-${a.id}`).click(); await expect(editor).toHaveValue(`${longDraft}\nFinal line`);
  await page.reload(); await expect(editor).toHaveValue(`${longDraft}\nFinal line`); await expect(writing).toHaveAttribute('aria-valuenow', String(savedHeight));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/dZkAAAAASUVORK5CYII=', 'base64');
  await pane.getByLabel('Choose images for Alpha').setInputFiles({ name: 'layout-fixture.png', mimeType: 'image/png', buffer: png });
  await expect(pane.getByLabel('Attached images').locator('img')).toHaveCount(1); await page.reload(); await expect(pane.getByLabel('Attached images').locator('img')).toHaveCount(1);
  await editor.fill('Review the attached layout.'); await pane.getByRole('button', { name: 'Send to Alpha' }).click(); await expect(editor).toHaveValue('');
  assert.equal(requests.at(-1).threadId, a.id); assert.equal(requests.at(-1).images.length, 1);
  checks.push(`Composer pointer ${pointer.before}->${pointer.after}px; keyboard ->${savedHeight}px; 50-line editing, thread drafts, attachment persistence and send origin verified.`);

  await settings(); await expect(page.getByLabel('Enable 3D viewer')).not.toBeChecked(); await page.getByLabel('Enable 3D viewer').click(); await expect(page.getByLabel('Enable 3D viewer')).toBeChecked(); await closeSettings();
  await expect(page.locator('.alpha-presence-stage')).toHaveAttribute('data-model-ready', 'true', { timeout: 30000 });
  assert.equal(await page.evaluate(() => window.captureCalls), 0);
  const viewerPointer = await resize('Resize 3D viewer', -40);
  const viewer = page.getByRole('separator', { name: 'Resize 3D viewer' }); await viewer.focus(); await viewer.press('ArrowDown');
  const viewerHeight = await viewer.getAttribute('aria-valuenow'); await page.reload(); await expect(viewer).toHaveAttribute('aria-valuenow', viewerHeight);
  assert.equal(await page.evaluate(() => window.captureCalls), 0);
  await snap('viewer-dark-960');
  await settings(); await page.getByRole('button', { name: 'Start camera for eye contact' }).click();
  await page.waitForFunction(() => document.querySelector('.alpha-camera-video')?.srcObject?.getVideoTracks()[0]?.readyState === 'live');
  await page.evaluate(() => { window.fixtureTrack = document.querySelector('.alpha-camera-video').srcObject.getVideoTracks()[0]; });
  await closeSettings(); await expect(page.getByRole('button', { name: /Stop camera/ })).toBeVisible();
  await page.getByRole('button', { name: /Stop camera/ }).click(); await expect.poll(() => page.evaluate(() => window.fixtureTrack.readyState)).toBe('ended');
  await settings(); await page.getByLabel('Enable 3D viewer').click(); await expect(page.getByLabel('Enable 3D viewer')).not.toBeChecked(); await closeSettings();
  await expect(page.locator('.alpha-presence-stage canvas')).toHaveCount(0); await expect(viewer).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.framesPending.size)).toBe(0);
  await page.reload(); await expect(viewer).toHaveCount(0); assert.equal(await page.evaluate(() => window.captureCalls), 0);
  await settings(); await page.getByLabel('Enable 3D viewer').click(); await expect(page.getByLabel('Enable 3D viewer')).toBeChecked(); await closeSettings(); await expect(viewer).toHaveAttribute('aria-valuenow', viewerHeight);
  await settings(); await page.getByLabel('Enable 3D viewer').click(); await expect(page.getByLabel('Enable 3D viewer')).not.toBeChecked(); await closeSettings();
  checks.push(`Viewer pointer ${viewerPointer.before}->${viewerPointer.after}px, keyboard/reload saved ${viewerHeight}px. Enable/disable persisted; canvas removed and zero pending animation frames. Synthetic camera required explicit start, footer Stop ended track, no capture on reload/re-enable.`);

  const q = await service.questions.ask({ text: 'Which design should be applied?', options: ['Compact', 'Roomy'], threadId: b.id, chatName: b.name, sourceId: 'layout-question' });
  await pane.getByRole('button', { name: /^Attention for Review project decision:/ }).click();
  await expect(picker).toHaveAttribute('id', `conversation-tab-${b.id}`);
  const card = page.locator(`[data-question-id="${q.id}"]`); await expect(card.getByRole('textbox')).toBeFocused();
  await card.getByRole('button', { name: 'Roomy', exact: true }).click(); await card.getByRole('button', { name: 'Send answer' }).dblclick();
  await expect(card).toHaveCount(0); await expect(page.getByRole('region', { name: 'Questions', exact: true })).toHaveCount(0); await expect(editor).toBeFocused();
  assert.equal(answers.length, 1); assert.equal(answers[0].threadId, b.id); assert.equal(service.questions.items.find(item => item.id === q.id).status, 'answered');
  await page.reload(); await expect(card).toHaveCount(0); releaseAnswer();
  const one = await service.questions.ask({ text: 'Which first result should be kept?', threadId: a.id, chatName: a.name, sourceId: 'first' });
  const two = await service.questions.ask({ text: 'Which second result should be kept?', threadId: a.id, chatName: a.name, sourceId: 'second' });
  const first = page.locator(`[data-question-id="${one.id}"]`), second = page.locator(`[data-question-id="${two.id}"]`);
  await first.getByRole('textbox').fill('Keep this typed answer');
  await page.route(`**/api/questions/${one.id}/answer`, route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Fixture retryable failure"}' }));
  await first.getByRole('button', { name: 'Send answer' }).click(); await expect(first.getByRole('alert')).toContainText('retryable'); await expect(first.getByRole('textbox')).toHaveValue('Keep this typed answer');
  await page.reload(); await expect(first.getByRole('textbox')).toHaveValue('Keep this typed answer'); await page.unroute(`**/api/questions/${one.id}/answer`);
  let finish; await page.route(`**/api/questions/${one.id}/answer`, async route => { const response = await route.fetch(); finish = () => route.fulfill({ response }); });
  await first.getByRole('button', { name: 'Send answer' }).click(); await expect(first).toHaveCount(0);
  const three = await service.questions.ask({ text: 'Which concurrent result should be kept?', threadId: a.id, chatName: a.name, sourceId: 'third' });
  await expect.poll(() => !!finish).toBe(true); await finish();
  await expect(second).toBeVisible(); await expect(page.locator(`[data-question-id="${three.id}"]`)).toBeVisible();
  await service.questions.answer(two.id, 'Accepted by another client', service.sessions, async () => {}); await expect(second).toHaveCount(0);
  const third = page.locator(`[data-question-id="${three.id}"]`); await third.getByRole('textbox').fill('Final free text'); await third.getByRole('button', { name: 'Send answer' }).click();
  await expect(page.getByRole('region', { name: 'Questions', exact: true })).toHaveCount(0); await expect(editor).toBeFocused();
  assert.equal(requests.at(-1).threadId, a.id); await expect(picker).toHaveAttribute('id', `conversation-tab-${b.id}`);
  checks.push('Questions: options/free text, immediate last-question removal while continuation pending, persisted audit, duplicate prevention, retryable failure/draft reload, multiple pending, event-driven answer, concurrent arrival and cross-thread routing; focus returns to composer.');

  await page.locator(`#conversation-tab-${a.id}`).click();
  const idle = service.sessions.get((await service.sessions.create({ agent: 'shell', name: 'Idle fixture', cwd: repo, projectId: 'fixture' })).id);
  // An isolated shell fixture only; no production worker is accessed.
  idle.status = 'running'; idle.activity = 'idle'; idle.nativeId = 'exact-native-fixture';
  a.sessionIds.push(idle.id); service.threads.publish(); service.sessions.changed(idle);
  await menu('Work details'); const work = page.getByRole('dialog', { name: 'Work details' });
  await expect(work.getByRole('button', { name: 'Enable terminal controls' })).toBeVisible();
  await work.getByRole('button', { name: 'Enable terminal controls' }).click(); await expect(work.getByRole('button', { name: 'Lock terminal controls' })).toBeVisible();
  await work.getByRole('button', { name: 'Close Work details' }).click(); assert.equal(service.sessions.get(idle.id).nativeId, 'exact-native-fixture');
  await page.locator('.status-runtime>summary').click(); await expect(page.locator('.status-detail')).toContainText('0 active workers'); await page.locator('.status-runtime>summary').click();
  await editor.fill('Draft stays while panels open'); await menu("What I've learned"); await page.getByRole('button', { name: 'Close Learned preferences' }).click(); await expect(editor).toHaveValue('Draft stays while panels open');
  checks.push('On-demand Work details preserves exact native identity and manual controls; idle open worker is not counted as active. Secondary panels preserve draft.');

  await settings(); await page.getByLabel('Quiet mode', { exact: true }).click(); await expect(page.getByLabel('Quiet mode', { exact: true })).toBeChecked(); await closeSettings();
  const quiet = await service.questions.ask({ text: 'Which quiet decision should be kept?', threadId: a.id, sourceId: 'quiet' });
  await expect(page.locator('.questions-toggle')).toHaveAttribute('aria-expanded', 'false');
  await pane.getByRole('button', { name: /^Attention for Simplify conversation layout:/ }).click();
  await expect(page.locator(`[data-question-id="${quiet.id}"]`)).toBeVisible(); await service.questions.dismiss(quiet.id);
  await settings(); await page.getByLabel('Quiet mode', { exact: true }).click(); await expect(page.getByLabel('Quiet mode', { exact: true })).not.toBeChecked(); await closeSettings();
  service.awareness.event({ id: 'review-layout', threadId: a.id, kind: 'review', text: 'Result ready for review; not verified.', source: 'Fixture' });
  await notification(); await expect(page.getByRole('dialog', { name: 'Important events' })).toContainText('not verified');
  await page.getByRole('dialog', { name: 'Important events' }).getByRole('button', { name: 'Snooze 30 minutes' }).last().click(); await page.getByRole('button', { name: 'Close Important events' }).click();
  checks.push('Quiet mode in Settings does not auto-open new Questions; explicit notification origin still works. Review remains distinct from verified; snooze available.');

  // Long/streaming Markdown stays inside message scroll, including an incomplete fence.
  ca.start = async () => { ca.threadId = 'fixture-provider'; }; ca.rpc = async () => ({ turn: { id: 'fixture-turn' } });
  const fixtureAsk = ca.ask;
  const { Coordinator } = await import('../coordinator.mjs'); ca.ask = Coordinator.prototype.ask.bind(ca);
  await editor.fill('Stream the layout review'); await editor.press('Enter');
  await expect(page.locator('.status-runtime>summary')).toContainText('waiting for provider');
  await ca.message({ method: 'item/agentMessage/delta', params: { threadId: 'fixture-provider', delta: '## Streaming review\n\n**Readable** while arriving.\n\n```rust\nfn example() {' } });
  await expect(pane.getByRole('heading', { name: 'Streaming review' })).toBeVisible();
  ca.active.resolve(markdown + '\n\n' + 'A long review remains readable. '.repeat(250));
  await expect(page.locator('.status-runtime>summary')).toContainText('not verified');
  ca.ask = fixtureAsk;
  await editor.fill('A comfortable draft ready to edit.');
  for (const theme of ['dark', 'light']) {
    await page.getByRole('button', { name: 'Tools', exact: true }).click(); await page.getByRole('menuitem', { name: 'Settings' }).click(); await page.getByRole('tab', { name: 'Theme', exact: true }).click();
    await page.getByLabel('Workspace theme', { exact: true }).selectOption(theme); await closeSettings();
    for (const viewport of [{ width: 960, height: 1440 }, { width: 960, height: 520 }, { width: 768, height: 600 }, { width: 390, height: 600 }]) {
      await page.setViewportSize(viewport); await expect(editor).toBeVisible();
      let bounds;
      // ResizeObserver updates the saved composer budget after the viewport changes.
      // Keep the full geometry assertions, but wait for that measured layout to commit.
      await expect(async () => {
      bounds = await page.evaluate(() => { const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom }; }; return { messages: rect('.alpha-conversation-scroll'), editor: rect('[aria-label="Message Alpha"]'), header: rect('.thread-picker'), status: rect('.mdi-statusbar'), overflow: document.documentElement.scrollWidth > innerWidth + 1 }; });
      assert.equal(bounds.overflow, false); assert(bounds.header.height <= 85); assert(bounds.editor.height >= 76); assert(bounds.messages.height >= 120); assert(bounds.editor.bottom <= bounds.status.y + 1); assert(bounds.messages.bottom <= bounds.editor.y);
      }).toPass({ timeout: 5000 });
      metrics.push({ theme, ...viewport, ...bounds });
      await page.locator('.alpha-conversation-scroll').evaluate(node => { node.scrollTop = 0; }); await snap(`text-${theme}-${viewport.width}x${viewport.height}`);
    }
  }
  // Viewer and pending Questions together must still leave a usable composer.
  for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width: 960, height: 520 });
    await page.getByRole('button', { name: 'Tools', exact: true }).click(); await page.getByRole('menuitem', { name: 'Settings' }).click(); await page.getByRole('tab', { name: 'Theme', exact: true }).click(); await page.getByLabel('Workspace theme', { exact: true }).selectOption(theme); await closeSettings();
    await settings(); await page.getByLabel('Enable 3D viewer').click(); await expect(page.getByLabel('Enable 3D viewer')).toBeChecked(); await closeSettings();
    await expect(page.locator('.alpha-presence-stage')).toHaveAttribute('data-model-ready', 'true', { timeout: 30000 });
    await snap(`viewer-${theme}-960x520`);
    const pending = await service.questions.ask({ text: 'Which compact fixture should be reviewed?', threadId: a.id, sourceId: `short-${theme}` });
    await expect(page.locator(`[data-question-id="${pending.id}"]`)).toBeVisible();
    const box = await editor.boundingBox(), questionsBox = await page.getByRole('region', { name: 'Questions', exact: true }).boundingBox();
    assert(box.height >= 60); assert(box.y + box.height <= questionsBox.y + 1);
    const compactCard = page.locator(`[data-question-id="${pending.id}"]`);
    await compactCard.getByRole('textbox').fill('Compact answer');
    await compactCard.getByRole('button', { name: 'Send answer' }).scrollIntoViewIfNeeded();
    await snap(`question-viewer-${theme}-960x520`);
    await compactCard.getByRole('button', { name: 'Send answer' }).click();
    await expect(compactCard).toHaveCount(0); await expect(editor).toBeFocused();
    await settings(); await page.getByLabel('Enable 3D viewer').click(); await expect(page.getByLabel('Enable 3D viewer')).not.toBeChecked(); await closeSettings();
  }
  const menuTab = pane.locator('[role=tab][aria-selected=true]');
  await menuTab.focus(); await menuTab.press('Shift+F10'); await expect(page.getByRole('menuitem', { name: 'Search this conversation', exact: true })).toBeFocused();
  await page.getByRole('menuitem', { name: 'History', exact: true }).click(); await expect(page.getByRole('dialog', { name: 'Conversation history' })).toBeVisible(); await page.keyboard.press('Escape'); await expect(menuTab).toBeFocused();
  checks.push('Streaming/incomplete and long Markdown; light/dark rendered at 960x1440, 960x520, 768x600, 390x600. Actual message/composer/header bounds and no viewport overflow asserted.');
  assert.deepEqual(errors, []); assert.deepEqual(remote, []);
  await expect.poll(async () => JSON.parse(await readFile(path.join(repo, '.alpha/settings.json'))).viewerEnabled).toBe(false);
  await service.close(); service = await createService({ repo, uiDir: path.resolve('dist'), mcpOptions: { home: repo, env: {} } });
  await page.goto(service.urls.workspace); await expect(editor).toHaveValue('A comfortable draft ready to edit.'); await expect(page.locator('.alpha-presence')).toHaveCount(0);
  assert.equal(service.questions.list().length, 0); assert.equal(service.threads.get(a.id).sessionIds.includes(idle.id), true);
  checks.push('Isolated service restart/new origin: persisted draft, viewer preference, Questions audit, and worker binding preserved. Running Alpha untouched.');
  await writeFile(path.join(repo, 'results.json'), JSON.stringify({ status: 'passed', fixtureOnly: true, checks, screenshots, metrics, errors }, null, 2));
  console.log(JSON.stringify({ status: 'passed', checks: checks.length, evidence: repo }));
} catch (error) {
  if (page) await page.screenshot({ path: path.join(repo, 'failure.png') }).catch(() => {});
  await writeFile(path.join(repo, 'failure.json'), JSON.stringify({ error: String(error), checks, metrics, errors }, null, 2));
  console.error(`Isolated evidence: ${repo}`); throw error;
} finally { await browser?.close(); await service.close(); }
