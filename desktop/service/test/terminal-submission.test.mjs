import test from 'node:test';
import assert from 'node:assert/strict';
import { TerminalSubmissions, submissionComposer } from '../terminal-submission.mjs';

test('twelve-terminal dispatch is bounded and resumable with exact acceptance and no duplicate payloads', async () => {
  const sessions = Array.from({ length: 12 }, (_, index) => ({ id: `batch-${index}`, agent: 'codex', nativeId: `native-${index}`, alphaThreadId: 'batch', writes: [] }));
  let release; const gate = new Promise(resolve => { release = resolve; });
  let views = 0, maxRunning = 0;
  const dispatcher = new TerminalSubmissions({ concurrency: 4, timeout: 2000, settle: 0, persist: async () => {}, changed() {}, accepted() {}, wait: async () => new Promise(resolve => setTimeout(resolve, 1)), view: async session => {
    views++; maxRunning = Math.max(maxRunning, dispatcher.running); await gate;
    const draft = session.writes.some(value => value.startsWith('\x1b[200~')) && !session.writes.includes('\t') ? `[Pasted text]` : '';
    return { lines: ['OpenAI Codex', `› ${draft}`, '? for shortcuts'], cursorY: 1, cursorX: draft.length + 2, bracketedPaste: true, startupSettled: true };
  } });
  for (const session of sessions) session.process = { write: value => { session.writes.push(value); if (value === '\t') dispatcher.observe(session, { kind: 'task-input', source: 'provider-record', text: `Work ${session.id}` }); } };
  const results = sessions.map(session => dispatcher.submit(session, `Work ${session.id}`, { taskId: session.id }));
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(views, 4); assert.equal(dispatcher.queue.length, 8);
  release(); assert.ok((await Promise.all(results)).every(result => result.accepted)); assert.equal(maxRunning, 4);
  for (const session of sessions) {
    assert.equal((await dispatcher.submit(session, `Work ${session.id}`, { taskId: session.id, retry: true })).duplicate, true);
    assert.equal(session.writes.length, 2); assert.equal(session.submissions[0].acceptance, 'observed');
  }
});
import { nativeActivity } from '../native-events.mjs';

function fixture({ busy = false, readyAt = 0, accept = true, prompt = null, pasteDelay = 0, race = false, manual = false } = {}) {
  let time = 1000, draft = '', pasted = '', pastedAt = 0, key = false, queued = false;
  const writes = [], session = { id: 'exact-worker', name: 'Synthetic worker', agent: 'codex', process: { write(value) { writes.push(value); if (value.startsWith('\x1b[200~')) { pasted = value.slice(6, -6).replaceAll('\r', '\n'); pastedAt = time; if (race) busy = !busy; } else { key = true; if (busy) { queued = true; draft = ''; } if (accept) dispatcher.observe(session, { kind: 'task-input', source: 'provider-record', text: pasted, at: new Date(time).toISOString() }); } } } };
  const dispatcher = new TerminalSubmissions({ clock: () => time, timeout: 1000, settle: 200, persist: async () => {}, changed: () => {}, accepted: () => {}, wait: async ms => { time += ms; if (manual && pastedAt) session.manualInputRevision = 1; }, view: async () => {
    if (prompt) return { lines: prompt, cursorX: 0, cursorY: 0 };
    if (time < 1000 + readyAt) return { lines: ['Loading…'], cursorX: 0, cursorY: 0 };
    if (pastedAt && !key && time - pastedAt >= pasteDelay) draft = pasted.length > 100 ? `[Pasted Content ${pasted.length} chars]` : pasted;
    const value = draft || 'Ask Codex to do anything';
    return { lines: ['OpenAI Codex', `› ${value}`, `GPT-6 ${busy ? 'esc to interrupt · tab to queue message' : '? for shortcuts'}${queued ? ' · queued message' : ''}`], cursorX: draft ? value.length + 2 : 2, cursorY: 1, activity: busy ? 'working' : 'idle' };
  } });
  return { dispatcher, session, writes, setDraft: value => { draft = value; } };
}

test('multiline/large idle paste submits once, verifies exact native input and deduplicates', async () => {
  const f = fixture({ pasteDelay: 400 }), text = 'Multiline task\n' + 'safe fixture content\n'.repeat(40);
  const result = await f.dispatcher.submit(f.session, text, { taskId: 'once' });
  assert.equal(result.accepted, true); assert.equal(result.submission.action, 'submit');
  assert.deepEqual(f.writes, [`\x1b[200~${text.replaceAll('\n', '\r')}\x1b[201~`, '\t']);
  const again = await f.dispatcher.submit(f.session, text, { taskId: 'once' }); assert.equal(again.duplicate, true); assert.equal(f.writes.length, 2);
  assert.throws(() => f.dispatcher.submit(f.session, 'different', { taskId: 'once' }), /different text/);
  const windows = fixture();
  assert.equal((await windows.dispatcher.submit(windows.session, 'First\r\nSecond')).accepted, true);
  assert.equal(windows.writes[0], '\x1b[200~First\rSecond\x1b[201~');
});

test('busy queue and idle/busy races use non-interrupting Tab and keep acceptance distinct', async () => {
  for (const options of [{ busy: true, accept: false }, { busy: false, race: true, accept: false }, { busy: true, race: true }]) {
    const f = fixture(options), result = await f.dispatcher.submit(f.session, 'Follow-up only', { taskId: 'queue' });
    assert.equal(f.writes.at(-1), '\t'); assert.equal(f.writes.filter(value => value.startsWith('\x1b[200~')).length, 1);
    if (!options.accept && options.accept !== undefined) { assert.equal(result.queued, true); assert.equal(result.accepted, false); }
  }
});

test('delayed readiness waits; unknown, login, permission and existing drafts receive no input', async () => {
  const delayed = fixture({ readyAt: 500 }); assert.equal((await delayed.dispatcher.submit(delayed.session, 'Task')).accepted, true);
  const tooLate = fixture({ readyAt: 900 });
  assert.equal((await tooLate.dispatcher.submit(tooLate.session, 'Wait for stable readiness')).submission.stage, 'timeout');
  assert.deepEqual(tooLate.writes, []);
  for (const prompt of [['PS C:\\work>'], ['Sign in to Codex', 'Press Enter'], ['Do you trust this folder?', '1. Yes, proceed', '2. No, exit']]) {
    const f = fixture({ prompt }); const result = await f.dispatcher.submit(f.session, 'Do not inject'); assert.equal(result.delivered, false); assert.deepEqual(f.writes, []);
  }
  const f = fixture(); f.setDraft('Owner unsent draft'); assert.equal((await f.dispatcher.submit(f.session, 'New task')).delivered, false); assert.deepEqual(f.writes, []);
  assert.equal(submissionComposer('shell', { lines: [] }).state, 'unsupported');
});

test('timeouts/manual edits never resend text or keys, receipts survive dispatcher recreation', async () => {
  const f = fixture({ accept: false }); const result = await f.dispatcher.submit(f.session, 'Pending task', { taskId: 'pending' });
  assert.equal(result.submission.stage, 'unconfirmed'); assert.equal(f.writes.length, 2);
  assert.throws(() => f.dispatcher.submit(f.session, 'Pending task', { taskId: 'new-id' }), /unconfirmed/);
  const fresh = fixture(); fresh.session.submissions = structuredClone(f.session.submissions);
  assert.equal((await fresh.dispatcher.submit(fresh.session, 'Pending task', { taskId: 'pending' })).duplicate, true); assert.deepEqual(fresh.writes, []);
  const manual = fixture({ manual: true, pasteDelay: 400 }); assert.equal((await manual.dispatcher.submit(manual.session, 'Do not combine with typing')).submitted, false); assert.equal(manual.writes.length, 1);
});

test('native input provenance accepts current Codex user text, not injected instructions or another task', () => {
  const record = { timestamp: new Date().toISOString(), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Exact submitted task' }], internal_chat_message_metadata_passthrough: { turn_id: 'native-turn', content_item_kinds: ['user.text'], content_item_metadata: [{ provenance: { type: 'user' } }] } } };
  const event = nativeActivity(record, 'codex'); assert.equal(event.text, 'Exact submitted task'); assert.equal(event.nativeTaskId, 'native-turn'); assert.equal(event.source, 'provider-record');
  record.payload.internal_chat_message_metadata_passthrough.content_item_kinds[0] = 'agents_md.instructions'; assert.equal(nativeActivity(record, 'codex'), null);
  const f = fixture(); f.session.submissions = [{ taskId: 'bound', hash: 'different', pastedAt: 1 }]; f.dispatcher.observe(f.session, event); assert.equal(f.session.submissions[0].acceptedAt, undefined);
});

test('Claude submits only a recognized idle composer and withholds unverified busy queue input', async () => {
  for (const busy of [false, true]) {
    let time = 1000, draft = '';
    const writes = [];
    const session = { id: 'claude-fixture', agent: 'claude', process: { write(value) {
      writes.push(value);
      if (value.startsWith('\x1b[200~')) draft = value.slice(6, -6);
      else dispatcher.observe(session, { kind: 'task-input', source: 'provider-record', text: draft, at: new Date(time).toISOString() });
    } } };
    const dispatcher = new TerminalSubmissions({ clock: () => time, timeout: 1000, settle: 200, persist: async () => {}, changed: () => {}, accepted: () => {}, wait: async ms => { time += ms; }, view: async () => ({ lines: ['Claude Code', `> ${draft}`, '? for shortcuts'], cursorY: 1, cursorX: draft.length + 2, activity: busy ? 'working' : 'idle', bracketedPaste: true, startupSettled: true }) });
    const result = await dispatcher.submit(session, 'Isolated Claude fixture');
    assert.equal(result.accepted, !busy);
    assert.deepEqual(writes, busy ? [] : ['\x1b[200~Isolated Claude fixture\x1b[201~', '\r']);
  }
});
