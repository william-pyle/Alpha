import { createHash, randomUUID } from 'node:crypto';
import { startupPrompt } from './prompt-state.mjs';
import { nativePrompt } from './native-prompts.mjs';

export const submissionHash = text => createHash('sha256').update(String(text).replaceAll('\r', '').trim()).digest('hex');
const normalize = text => text.replace(/\s+/g, ' ').trim();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Positive recognition only, using the current viewport and cursor (never old
// scrollback). Unknown prompts fail closed; no Enter/Tab is sent to them.
export function submissionComposer(agent, view) {
  if (!['codex', 'claude'].includes(agent)) return { state: 'unsupported', reason: 'Automatic submission is supported only for recognized Codex and Claude composers.' };
  if (view.startupSettled === false || view.bracketedPaste === false) return { state: 'unknown', reason: 'Waiting for provider bracketed-paste readiness.' };
  const lines = view.lines || [], screen = lines.join('\n');
  if (nativePrompt(agent, view)) return { state: 'blocked', reason: 'A native choice is waiting in Questions. No task text was pasted.' };
  if (/^\s*[›❯>]?\s*\d+[.)]\s+\S/m.test(screen) && /(?:enter|↵).*(?:confirm|continue|select)/i.test(screen)) return { state: 'blocked', reason: 'An interactive choice needs direct user input.' };
  if (/Starting MCP servers|reconnecting|connecting to|loading session/i.test(screen)) return { state: 'unknown', reason: 'Provider is still starting or reconnecting.' };
  const blocked = startupPrompt(screen);
  if (blocked) return { state: 'blocked', reason: blocked };
  const glyph = agent === 'codex' ? /^\s*›\s?/ : /^\s*[>❯]\s?/;
  const index = lines.findLastIndex(line => glyph.test(line));
  if (index < 0 || view.cursorY < index) return { state: 'unknown', reason: 'Waiting for the native message composer.' };
  const tail = lines.slice(index + 1).join('\n');
  if (/^\s*[›❯>]?\s*\d+[.)]\s+\S/m.test(tail) || /(?:allow (?:once|always)|approve|permission required|sign in|log in|trust this|select an option|press enter to continue)/i.test(tail)) return { state: 'blocked', reason: 'An interactive choice needs direct user input.' };
  if (!(agent === 'codex' ? /OpenAI Codex|GPT-|gpt-|context left|for shortcuts|tab to queue/i : /Claude Code|for shortcuts|bypass permissions|shift.tab/i).test(screen)) return { state: 'unknown', reason: 'The provider composer is not recognized.' };
  const prefix = glyph.exec(lines[index])[0], first = lines[index].slice(prefix.length);
  const draft = [first, ...lines.slice(index + 1, view.cursorY + 1)].join('\n').trim();
  const ghost = agent === 'codex' && /^(?:Ask Codex to do anything|Explain this codebase|Find and fix a bug in @filename|Write tests for @filename|Improve documentation in @filename|Summarize recent commits|Implement \{feature\})$/.test(first.trim());
  const empty = view.cursorY === index && view.cursorX <= prefix.length && (!first.trim() || ghost);
  const busy = view.activity === 'working' || /esc to interrupt/i.test(screen);
  return { state: busy ? 'busy' : 'idle', draft, empty, queued: /(?:queued message|message queued|queued follow.up)/i.test(screen) };
}

export class TerminalSubmissions {
  constructor({ view, persist, changed, accepted, clock = Date.now, wait = sleep, timeout = 8000, settle = 350, concurrency = 4 }) {
    Object.assign(this, { view, persist, changed, accepted, clock, wait, timeout, settle }); this.active = new Map();
    this.concurrency = concurrency; this.running = 0; this.queue = [];
  }
  observe(session, event) {
    const text = event.kind === 'task-input' ? event.text : event.taskText;
    if (event.source !== 'provider-record' || !text) return;
    const hash = submissionHash(text);
    const receipt = session.submissions?.findLast(item => item.hash === hash && item.pastedAt && !item.acceptedAt && (!event.at || Date.parse(event.at) >= item.pastedAt));
    if (!receipt) return;
    receipt.stage = 'accepted'; receipt.acceptance = 'observed'; receipt.acceptedAt = this.clock(); receipt.note = 'Exact request observed in the native provider input record; task completion is not verified.';
    this.accepted(session, receipt); this.changed(session);
    void this.persist().catch(() => {});
  }
  submit(session, text, { taskId = randomUUID(), retry = false } = {}) {
    const hash = submissionHash(text), prior = session.submissions?.find(item => item.taskId === taskId);
    if (prior) {
      if (prior.hash !== hash) throw new Error('This submission ID already belongs to different text.');
      if (retry && !prior.pasteIntentAt && !this.active.has(session.id) && ['blocked', 'timeout', 'failed'].includes(prior.stage)) session.submissions = session.submissions.filter(item => item !== prior);
      else return this.active.get(session.id)?.taskId === taskId ? this.active.get(session.id).promise : Promise.resolve(this.result(session, prior, true));
    }
    if (this.active.has(session.id)) throw new Error('A submission is already being checked for this worker. Wait for its result; no text was pasted.');
    if (session.submissions?.some(item => item.pasteIntentAt && !item.acceptedAt && item.stage !== 'queued')) throw new Error('An earlier pasted request is unconfirmed. Inspect this worker terminal before sending again; Alpha will not replay it.');
    // Also suppress retries under a fresh tool-call ID while the same payload is
    // queued or unconfirmed. A newly authorized repeat after acceptance is valid.
    const duplicate = session.submissions?.findLast(item => item.hash === hash && item.pastedAt && !item.acceptedAt);
    if (duplicate) return Promise.resolve(this.result(session, duplicate, true));
    const receipt = { taskId, hash, stage: 'waiting-ready', acceptance: 'unconfirmed', createdAt: this.clock(), note: 'Waiting for a recognized empty composer.' };
    if (this.queue.length >= 80) throw new Error('Dispatch queue is full. Inspect existing submission receipts before resuming.');
    // Stable task IDs remain durable; evicting accepted receipts would silently
    // turn an old retry into new work.
    session.submissions = [...(session.submissions || []), receipt];
    const target = session.process, nativeId = session.nativeId, threadId = session.alphaThreadId;
    const promise = this.bounded(async () => {
      if (session.process !== target || session.nativeId !== nativeId || session.alphaThreadId !== threadId) {
        receipt.stage = 'blocked'; receipt.note = 'The native session changed while dispatch was queued. Nothing was pasted.'; await this.persist(); return this.result(session, receipt);
      }
      return this.run(session, text, receipt);
    }).finally(() => this.active.delete(session.id));
    this.active.set(session.id, { taskId, promise }); return promise;
  }
  async bounded(run) {
    if (this.running >= this.concurrency) await new Promise(resolve => this.queue.push(resolve));
    else this.running++;
    try { return await run(); }
    finally { const next = this.queue.shift(); if (next) next(); else this.running--; }
  }
  result(session, receipt, duplicate = false) { return { delivered: !!receipt.pastedAt, submitted: !!receipt.keyAt, queued: receipt.stage === 'queued', accepted: receipt.acceptance === 'observed', duplicate, sessionId: session.id, name: session.name, submission: { ...receipt }, note: receipt.note }; }
  async run(session, text, receipt) {
    const target = session.process, manual = session.manualInputRevision || 0, nativeId = session.nativeId, threadId = session.alphaThreadId;
    const unchanged = () => session.process === target && target && session.nativeId === nativeId && session.alphaThreadId === threadId && (session.manualInputRevision || 0) === manual;
    const update = async (stage, note) => { receipt.stage = stage; receipt.note = note; this.changed(session); await this.persist(); };
    try {
      await this.persist();
      const deadline = this.clock() + this.timeout;
      let composer, readySince = null, ready = false;
      while (this.clock() < deadline) {
        if (!unchanged()) { await update('blocked', 'Worker changed or user input intervened. No automatic keys were sent.'); return this.result(session, receipt); }
        composer = submissionComposer(session.agent, await this.view(session));
        if (['blocked', 'unsupported'].includes(composer.state)) { await update('blocked', composer.reason); return this.result(session, receipt); }
        if (['idle', 'busy'].includes(composer.state)) {
          if (!composer.empty) { await update('blocked', 'The native composer contains a draft. It was preserved; no text was pasted.'); return this.result(session, receipt); }
          if (session.agent === 'claude' && composer.state === 'busy') { await update('blocked', 'Claude is busy; its safe queue action is not confirmed. Use the terminal after the current turn.'); return this.result(session, receipt); }
          readySince ??= this.clock();
          if (this.clock() - readySince >= this.settle) { ready = true; break; }
        } else readySince = null;
        await this.wait(100);
      }
      if (!ready) { await update('timeout', 'Native composer readiness was not confirmed. Nothing was pasted.'); return this.result(session, receipt); }
      // Persist the intent before the only payload write. A crash can leave an
      // uncertain receipt, but can never invite an automatic second paste.
      receipt.pasteIntentAt = this.clock(); await update('paste-pending', 'Paste prepared; submission and acceptance are not yet confirmed.');
      if (!unchanged()) { await update('unconfirmed', 'Worker or manual input changed before paste. Inspect the terminal; no automatic retry.'); return this.result(session, receipt); }
      composer = submissionComposer(session.agent, await this.view(session));
      if (!composer.empty || !['idle', 'busy'].includes(composer.state) || !unchanged()) { delete receipt.pasteIntentAt; await update('blocked', 'The composer changed before paste. Draft and prompts were left untouched.'); return this.result(session, receipt); }
      receipt.pastedAt = this.clock();
      // Match xterm Clipboard.prepareTextForTerminal: terminal paste uses CR.
      target.write(`\x1b[200~${text.replace(/\r?\n/g, '\r')}\x1b[201~`);
      const pasteDeadline = this.clock() + this.timeout;
      let observed = false;
      while (this.clock() < pasteDeadline) {
        if (!unchanged()) break;
        composer = submissionComposer(session.agent, await this.view(session));
        if (['blocked', 'unsupported'].includes(composer.state)) break;
        if (composer.state === 'unknown') { await this.wait(100); continue; }
        const ownPaste = !composer.empty && (/\[Pasted (?:Content|text)[^\]]*\]/i.test(composer.draft) || normalize(composer.draft).startsWith(normalize(text).slice(0, 60)));
        if (ownPaste && this.clock() - receipt.pastedAt >= this.settle) { observed = true; break; }
        await this.wait(100);
      }
      if (!observed || !unchanged()) { await update('unconfirmed', 'Paste/submission readiness could not be confirmed. Text may remain in the terminal; inspect it. No keys or duplicate payload were sent.'); return this.result(session, receipt); }
      if (session.agent === 'claude' && composer.state === 'busy') { await update('unconfirmed', 'Worker became busy after paste. Draft retained; no interrupting key was sent.'); return this.result(session, receipt); }
      receipt.keyIntentAt = this.clock(); receipt.action = composer.state === 'busy' ? 'queue' : 'submit';
      // Codex Tab queues when busy AND submits when idle. It is safe across an
      // idle/busy race, unlike Enter, which may steer an in-progress turn.
      await update('submitted-unconfirmed', 'Submit/queue action prepared; waiting for native input acceptance.');
      if (!unchanged()) { await update('unconfirmed', 'User input or process changed before submission. Inspect the draft; no further keys sent.'); return this.result(session, receipt); }
      composer = submissionComposer(session.agent, await this.view(session));
      if (!['idle', 'busy'].includes(composer.state) || composer.empty || !unchanged() || session.agent === 'claude' && composer.state === 'busy') { await update('unconfirmed', 'The composer changed before submission. No key was sent; inspect the draft.'); return this.result(session, receipt); }
      receipt.keyAt = this.clock();
      target.write(session.agent === 'codex' ? '\t' : '\r');
      const verifyDeadline = this.clock() + this.timeout;
      while (this.clock() < verifyDeadline) {
        if (receipt.acceptance === 'observed') return this.result(session, receipt);
        if (!unchanged()) break;
        composer = submissionComposer(session.agent, await this.view(session));
        if (session.agent === 'codex' && composer.empty && composer.queued) { await update('queued', 'Native queue indicator observed after the composer cleared. Task acceptance remains pending until its exact native input record arrives.'); return this.result(session, receipt); }
        await this.wait(100);
      }
      await update('unconfirmed', 'Submission was attempted once, but native acceptance was not observed within the verification window. Inspect this worker; do not replay the payload.');
      return this.result(session, receipt);
    } catch (error) {
      receipt.stage = receipt.pastedAt ? 'unconfirmed' : 'failed'; receipt.note = `Submission verification failed: ${error.message}. Inspect the worker before retrying.`; this.changed(session);
      return this.result(session, receipt);
    }
  }
}
