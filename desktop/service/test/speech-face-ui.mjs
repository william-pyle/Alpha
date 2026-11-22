import { tmpdir as isolatedTmpdir } from 'node:os';
// Default: deterministic playback events. Opt-in local mode exercises Windows
// output without recording a microphone or changing the owner's running app.
import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createService } from '../server.mjs';
import { launchBrowser } from './browser.mjs';

await mkdir('.test-output', { recursive: true });
const repo = await mkdtemp(path.join(process.env.RUNNER_TEMP || isolatedTmpdir(), 'alpha-speech-face-'));
await mkdir(path.join(repo, 'workspace')); await mkdir(path.join(repo, '.alpha'));
await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[]}');
await writeFile(path.join(repo, '.alpha/settings.json'), '{"speakReplies":false}');
const service = await createService({ repo, uiDir: path.resolve('dist'), mcpOptions: { home: repo, env: {} } });
const a = service.threads.create({ name: 'Voice check', projectId: 'fixture' }), b = service.threads.create({ name: 'Other conversation', projectId: 'fixture' });
service.threads.select(a.id); service.threads.message(a.id, { id: 'voice-test', role: 'assistant', text: 'This is an Alpha Windows voice test.' });
const native = process.env.ALPHA_NATIVE_SPEECH_TEST === '1', levels = [];
const notify = service.speech.changed;
service.speech.changed = state => { levels.push({ at: Date.now(), ...state }); notify(state); };
let timer, browser;
if (!native) service.speech.speak = async (text, voice, threadId) => {
  timer = setInterval(() => { service.speech.state = { speaking: true, error: null, threadId, level: .75, levelAt: Date.now(), phase: 'playing' }; service.speech.changed(service.speech.state); }, 70);
  return { speaking: true, error: null };
};
try {
  browser = await launchBrowser(); const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(service.urls.workspace); await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('tab', { name: 'Conversation', exact: true }).click(); await page.getByLabel('Enable 3D viewer').click(); await expect(page.getByLabel('Enable 3D viewer')).toBeChecked(); await page.getByRole('button', { name: 'Close settings' }).click();
  const face = page.locator('.alpha-presence-stage');
  await expect(face).toHaveAttribute('data-model-ready', 'true', { timeout: 30000 });
  await expect(face).toHaveAttribute('data-mouth-opening', '0.000');
  await page.locator('[data-message-id="voice-test"]').click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Read reply aloud' }).click();
  await expect.poll(async () => Number(await face.getAttribute('data-mouth-opening')), { timeout: 20000 }).toBeGreaterThan(.01);
  await page.screenshot({ path: path.join(repo, 'windows-speaking.png') });
  if (native) await expect.poll(() => service.speech.state.speaking, { timeout: 20000 }).toBe(false);
  clearInterval(timer); service.speech.stop(); await expect(face).toHaveAttribute('data-mouth-opening', '0.000');
  if (!native) {
    // An old or background speech event must not animate the selected thread.
    await page.locator(`#conversation-tab-${b.id}`).click();
    service.speech.changed({ speaking: true, error: null, threadId: a.id, level: 1, levelAt: Date.now() });
    await expect(face).toHaveAttribute('data-mouth-opening', '0.000');
    service.speech.changed({ speaking: false, error: 'Fixture audio device error' });
    await expect(page.getByRole('alert').filter({ hasText: 'Fixture audio device error' })).toBeVisible();
  }
  await page.screenshot({ path: path.join(repo, 'windows-idle.png') });
  assert.ok(levels.some(item => item.level > 0));
  if (native) assert.equal(levels.at(-1).error, null);
  await writeFile(path.join(repo, 'result.json'), JSON.stringify({ nativePlayback: native, audioEvents: levels.length, peak: Math.max(...levels.map(item => item.level || 0)), faceOpened: true, faceReturnedToIdle: true, microphoneUsed: false, cameraUsed: false, audibility: 'Playback events observed; human speaker audibility was not independently heard by the agent.' }, null, 2));
  console.log(`Windows speech face check passed (${native ? 'native playback' : 'simulated audio events'}): ${repo}`);
} finally { clearInterval(timer); await browser?.close(); await service.close(); }
