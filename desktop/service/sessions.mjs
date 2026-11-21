import { TerminalSubmissions, submissionComposer } from './terminal-submission.mjs';
import { NativePrompts } from './native-prompts.mjs';
import { approvedProjectTrust } from './provider-trust.mjs';
import { deliveredTask, workerEvent } from './worker-evidence.mjs';
import { EventEmitter } from 'node:events';
import { startupPrompt } from './prompt-state.mjs';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import pty from 'node-pty';
import headless from '@xterm/headless';
import { TerminalSnapshotAddon } from './terminal-snapshot.mjs';
import { terminalCommand, childEnvironment, nativeConversationId } from './agents.mjs';
import { readJson, saveJson } from './util.mjs';
import { claudeTranscript, codexTranscript, tailNativeFile } from './native-events.mjs';
import { findCodexChat } from './codex-history.mjs';
import { englishTitle, restoredTitle } from './titles.mjs';
import { defaultWorkerEffort, workerEfforts } from './effort.mjs';
import { ptyOptions } from './platform.mjs';
import { guardWindowsPtyKill } from './windows-pty-lifecycle.mjs';
import { opencodeVersion, opencodeEnvironment, readOpencodeState, watchOpencode } from './opencode.mjs';
import { prepareAntigravityLog, readAntigravityConversation, validAntigravityId, watchAntigravity } from './antigravity.mjs';
import { assertSafePath } from './project-layout.mjs';

const { Terminal } = headless;
const publicSession = session => {
  const { id, name, agent, cwd, bypass, effort, status, createdAt, lastOutputAt, lastInputAt, exitCode, nativeId, attention, activity, unread, completionVersion, lastCompletedId, cols, rows, open, pinned, tabOrder, tabColor, updatedAt, preview, hasConversation, restoreError, projectId, projectPending } = session;
  return { submissions: session.submissions, submission: session.submissions?.at(-1), workerEvidence: session.workerEvidence, id, name, agent, cwd, bypass, effort, status, createdAt, lastOutputAt, lastInputAt, exitCode, nativeId, attention, activity, unread, completionVersion, lastCompletedId, cols, rows, open, pinned, tabOrder, tabColor, updatedAt, preview, hasConversation, restoreError, projectId, projectPending, alphaThreadId: session.alphaThreadId || null };
};

export class Sessions extends EventEmitter {
  constructor(repo, stateDir) {
    super();
    this.repo = repo;
    this.stateDir = stateDir;
    this.items = new Map();
    this.saveChain = Promise.resolve();
    this.dirty = false;
    this.closed = false;
    this.prompts = new NativePrompts({ view: session => this.promptView(session), ready: (session, view) => ['idle', 'busy'].includes(submissionComposer(session.agent, view).state) });
    this.submission = new TerminalSubmissions({
      view: async session => {
        await this.hydrate(session); await new Promise(resolve => session.terminal.write('', resolve));
        const terminal = session.terminal, buffer = terminal.buffer.active;
        // Codex can render a provisional composer before its startup input
        // handoff finishes. A short startup floor supplements positive mode,
        // stable composer and blocking-prompt checks; it is not acceptance.
        return { lines: Array.from({ length: terminal.rows }, (_, i) => buffer.getLine(buffer.baseY + i)?.translateToString(true) || ''), cursorX: buffer.cursorX, cursorY: buffer.cursorY, bracketedPaste: terminal.modes.bracketedPasteMode, activity: session.activity, startupSettled: Date.now() - session.startedAt >= 2500 };
      },
      persist: () => this.persist(), changed: session => {
        this.changed(session);
        const receipt = session.submissions?.at(-1);
        if (receipt && ['unconfirmed', 'blocked', 'timeout', 'failed'].includes(receipt.stage)) this.emit('notice', { id: `submission:${session.id}:${receipt.taskId}`, sessionId: session.id, name: session.name, kind: 'submission', text: receipt.note, at: new Date().toISOString() });
      },
      accepted: (session, receipt) => {
        session.workerEvidence = { ...deliveredTask(session.workerEvidence, { taskId: receipt.taskId, at: receipt.pastedAt }), acceptance: 'observed', acceptedAt: receipt.acceptedAt, source: 'Exact native input record', certainty: 'native-input-observed' };
      },
    });
  }

  async init() {
    await mkdir(this.stateDir, { recursive: true });
    const saved = await readJson(path.join(this.stateDir, 'sessions.json'), []);
    for (const [index, metadata] of saved.entries()) {
      const item = this.make({ ...metadata, name: restoredTitle(metadata.name, index), open: metadata.open ?? metadata.agent !== 'kimi', pinned: !!metadata.pinned, updatedAt: metadata.updatedAt || metadata.lastInputAt || metadata.createdAt, hasConversation: metadata.hasConversation ?? (metadata.agent === 'codex' && !!metadata.nativeId), status: 'stopped', activity: 'idle', attention: !!metadata.unread });
      if (item.workerEvidence && ['working', 'needs-input'].includes(item.workerEvidence.execution)) item.workerEvidence = { ...item.workerEvidence, previousExecution: item.workerEvidence.execution, execution: 'unknown', certainty: 'stale-after-restart' };
      for (const receipt of item.submissions || []) if (!['accepted', 'blocked', 'failed', 'timeout'].includes(receipt.stage)) {
        receipt.stage = receipt.pasteIntentAt ? 'unconfirmed' : 'blocked';
        receipt.note = receipt.pasteIntentAt ? 'Service restarted before acceptance was confirmed. Inspect the saved terminal; this request will not be replayed.' : 'Service restarted before any paste intent. Explicitly resume this submission ID when its native composer is ready.';
      }
      this.items.set(item.id, item);
      if (item.open) await this.hydrate(item);
    }
    this.timer = setInterval(() => { if (this.dirty) this.persist().catch(error => this.emit('service-error', error)); }, 3000);
    this.timer.unref();
    return this;
  }

  make(metadata) {
    return { activity: 'idle', unread: false, completionVersion: 0, tabOrder: this.items.size, tabColor: null, ...metadata, effort: ['codex', 'claude', 'antigravity'].includes(metadata.agent) ? metadata.effort || defaultWorkerEffort : undefined, terminal: null, serializer: null, process: null, sequence: 0, pendingOutput: '', outputTimer: null };
  }

  async hydrate(session) {
    if (session.hydrating) return session.hydrating;
    if (session.terminal) return;
    session.hydrating = (async () => {
      const terminal = new Terminal({ cols: session.cols || 90, rows: session.rows || 32, scrollback: 3000, allowProposedApi: true });
      const serializer = new TerminalSnapshotAddon();
      terminal.loadAddon(serializer);
      session.terminal = terminal; session.serializer = serializer;
      const screen = await readJson(path.join(this.stateDir, `screen-${session.id}.json`), null);
      if (screen?.data) await new Promise(resolve => terminal.write(screen.data, resolve));
    })();
    try { await session.hydrating; } finally { session.hydrating = null; }
  }

  list() { return [...this.items.values()].map(publicSession).sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.tabOrder - b.tabOrder); }
  active() { return this.list().filter(item => item.open); }
  async restore() {
    // Open windows immediately; restore their terminals in the background.
    for (const session of this.items.values()) {
      if (this.closed) return;
      if (!session.open) continue;
      try { await this.resume(session.id); }
      catch (error) { session.restoreError = error.message; session.status = 'stopped'; this.changed(session); }
    }
  }
  get(id) {
    const session = this.items.get(id);
    if (!session) throw Object.assign(new Error('Chat no longer exists'), { status: 404 });
    return session;
  }
  changed(session) {
    this.dirty = true;
    this.emit('session', publicSession(session));
  }

  async create(options) {
    if (this.closed) throw new Error('Alpha is shutting down');
    if (this.active().length >= 80) throw new Error('Close a tab before opening another (80 open tab limit). Closed chats remain in History.');
    const agent = String(options.agent || 'codex');
    if (!['codex', 'claude', 'shell', 'gitbash'].includes(agent)) throw new Error('Unsupported agent.');
    nativeConversationId(options.resumeId);
    if (options.effort && !workerEfforts.includes(options.effort)) throw new Error('Reasoning effort must be medium, high, xhigh or max.');
    const cwd = path.resolve(options.cwd || this.repo);
    if (!(await stat(cwd)).isDirectory()) throw new Error('Working folder must be a directory');
    const now = new Date().toISOString();
    const session = this.make({
      id: randomUUID(), agent, name: englishTitle(options.name, `Conversation ${this.items.size + 1}`),
      tabOrder: Math.max(-1, ...this.list().map(item => item.tabOrder)) + 1,
      cwd, bypass: ['codex', 'claude'].includes(agent) && options.bypass === true, createdAt: now, lastInputAt: null, lastOutputAt: null,
      effort: options.effort, alphaThreadId: options.alphaThreadId || null,
      projectId: options.projectId || null, projectPending: this.trackProjects === true && !options.projectId,
      status: 'starting', nativeId: options.resumeId || (agent === 'claude' ? randomUUID() : null),
      open: true, pinned: false, updatedAt: now, preview: '', hasConversation: !!options.resumeId, restoreError: null,
      attention: false, cols: Math.min(500, Math.max(20, options.cols || 90)), rows: Math.min(200, Math.max(5, options.rows || 32)),
    });
    this.items.set(session.id, session);
    await this.hydrate(session);
    try { await this.launch(session, options.resumeId, await this.nativeBoundary(session, options.resumeId)); }
    catch (error) { this.items.delete(session.id); session.terminal.dispose(); throw error; }
    await this.persist();
    return publicSession(session);
  }

  async importConversation({ agent, nativeId, name, cwd, pinned = false, bypass = false }) {
    if (!['codex', 'claude', 'antigravity', 'opencode', 'kimi'].includes(agent) || typeof nativeId !== 'string' || !nativeId.trim()) throw new Error('Choose an agent and its native conversation ID.');
    nativeId = nativeConversationId(nativeId.trim());
    if (agent === 'antigravity' && !validAntigravityId(nativeId)) throw new Error('Use the Antigravity conversation UUID from its /resume picker.');
    cwd = path.resolve(cwd || this.repo);
    if (!(await stat(cwd)).isDirectory()) throw new Error('Working folder must be a directory');
    const existing = [...this.items.values()].find(item => item.agent === agent && item.nativeId === nativeId);
    if (existing) { existing.name = englishTitle(name, existing.name); existing.pinned = pinned; this.changed(existing); await this.persist(); return publicSession(existing); }
    const now = new Date().toISOString();
    const session = this.make({ id: randomUUID(), agent, nativeId, name: englishTitle(name), cwd: path.resolve(cwd || this.repo), bypass, pinned, open: false, status: 'stopped', createdAt: now, updatedAt: now, hasConversation: true, lastInputAt: null, lastOutputAt: null, preview: '', cols: 90, rows: 32, attention: false });
    this.items.set(session.id, session); this.changed(session); await this.persist();
    return publicSession(session);
  }

  async launch(session, resumeId, nativeWatch) {
    let env = childEnvironment(this.repo);
    if (this.sharedRoot) env.ALPHA_SHARED_LIBRARY = this.sharedRoot;
    let opencodeMajor;
    if (session.agent === 'opencode') {
      opencodeMajor = await opencodeVersion(env);
      // v2 explicitly accepts a new ID through --session. Assign it before
      // launch, so even a very early close retains an exact resume target.
      if (opencodeMajor === 2 && !session.nativeId) session.nativeId = `ses_${randomUUID().replaceAll('-', '')}`;
      if (opencodeMajor === 2) resumeId ||= session.nativeId;
      env = opencodeEnvironment(env, { stateDir: this.stateDir, session, major: opencodeMajor });
    }
    if (this.closed || !session.open) throw new Error('The chat was closed before its terminal started.');
    if (session.agent === 'antigravity' && resumeId && !validAntigravityId(resumeId)) throw new Error('Use the Antigravity conversation UUID from its /resume picker.');
    const antigravityLog = session.agent === 'antigravity' ? await prepareAntigravityLog(this.stateDir, session.id) : undefined;
    const initialPrompt = await this.restartNotes?.claim(session, resumeId);
    let command;
    try {
      const trustArgs = session.agent === 'codex' && process.platform === 'win32' ? await approvedProjectTrust(session.cwd, this.approvedTrustRoots?.() || []) : [];
      command = terminalCommand(session.agent, { bypass: session.bypass, resumeId, nativeId: session.nativeId, effort: session.effort, opencodeMajor, antigravityLog, initialPrompt, trustArgs });
    }
    catch (error) { await this.restartNotes?.failed(session, error); throw error; }
    if (session.agent === 'codex') env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE = `alpha_chat_${session.id}`;
    // Creation and resume both cross this synchronous final boundary. The
    // caller can reject a start if the owning project/conversation became busy
    // or was removed while the asynchronous launch preparation ran.
    this.validateStart?.(session);
    let proc;
    try { proc = guardWindowsPtyKill(pty.spawn(command.file, command.args, ptyOptions({ cwd: session.cwd, env, cols: session.cols, rows: session.rows }))); }
    catch (error) { await this.restartNotes?.failed(session, error); throw error; }
    session.process = proc;
    session.deviceReplies?.dispose();
    // Inactive tabs still have a terminal: answer device queries without needing
    // a visible renderer. The UI suppresses its duplicate protocol replies.
    session.deviceReplies = session.terminal.onData(data => { if (session.process) session.process.write(data); });
    session.status = 'running';
    session.activity = 'idle';
    session.restoreError = null;
    session.exitCode = null;
    session.startedAt = Date.now();
    proc.onData(data => {
      session.lastOutputAt = new Date().toISOString();
      session.terminal.write(data, () => this.detectPrompt(session));
      session.pendingOutput += data;
      // Batch bursts for xterm; never let one high-output terminal flood the UI.
      if (!session.outputTimer) session.outputTimer = setTimeout(() => this.flushOutput(session), 16);
      // BEL is also used by terminal protocols (for example OSC titles). It is
      // not evidence of an agent finishing, or of a prompt that needs attention.
      this.dirty = true;
    });
    proc.onExit(({ exitCode }) => {
      this.flushOutput(session);
      session.process = null;
      session.deviceReplies?.dispose();
      if (process.platform === 'win32') {
        // node-pty 1.1.0 leaves its ConPTY output worker alive after a natural exit.
        // The bundled ConPTY DLL avoids the legacy AttachConsole-on-dead-PID path.
        try { proc.kill(); } catch { /* Native console already closed. */ }
        proc._agent?._conoutSocketWorker?.dispose();
      }
      session.stopNativeWatch?.();
      session.stopNativeWatch = null;
      session.workerEvidence = workerEvent(session.workerEvidence, { kind: exitCode !== 0 ? 'turn-failed' : 'turn-interrupted', source: 'process-exit' }).value;
      session.status = 'exited';
      session.activity = 'idle';
      session.exitCode = exitCode;
      this.changed(session);
      this.emit('notice', { id: randomUUID(), sessionId: session.id, name: session.name, kind: 'exit', text: `${session.name} exited (${exitCode}).`, at: new Date().toISOString() });
      if (session.agent === 'antigravity') this.recoverNative(session).catch(() => {});
      if (session.agent === 'codex' && !session.nativeId) this.read(session.id).then(({ screen }) => {
        const match = /codex resume ([a-f0-9-]{36})/i.exec(screen);
        if (match) { session.nativeId = match[1]; this.changed(session); }
      }).catch(() => {});
      if (session.agent === 'opencode') readOpencodeState(this.stateDir, session.id).then(state => {
        if (state?.launchId === env.ALPHA_OPENCODE_LAUNCH_ID) {
          this.bindNative(session, { id: state.nativeId });
          if (state.completion && session.nativeId === state.nativeId) this.nativeEvent(session, { kind: 'turn-completed', id: state.completion });
        }
      }).catch(() => {});
    });
    this.changed(session);
    // Discovery is read-only, and only accepts an unambiguous native session.
    this.beginDiscovery(session);
    if (session.agent === 'antigravity') session.stopNativeWatch = watchAntigravity(this.stateDir, session.id, id => {
      if (session.process === proc) this.bindAntigravity(session, id);
    });
    if (session.agent === 'opencode') session.stopNativeWatch = watchOpencode(this.stateDir, session, env.ALPHA_OPENCODE_LAUNCH_ID, state => {
      this.bindNative(session, { id: state.nativeId });
      if (session.nativeId !== state.nativeId) return;
      if (state.completion) this.nativeEvent(session, { kind: 'turn-completed', id: state.completion });
      if (state.activity === 'working') this.nativeEvent(session, { kind: 'turn-started' });
      else if (state.activity === 'waiting') this.nativeEvent(session, { kind: 'attention' });
      else if (state.activity === 'idle' && session.activity !== 'idle') this.nativeEvent(session, { kind: 'turn-interrupted' });
    });
    if (nativeWatch) this.watchNative(session, nativeWatch.file, nativeWatch.offset);
    else if (session.agent === 'claude' && session.nativeId) claudeTranscript(session.cwd, session.nativeId).then(file => {
      if (session.process === proc) this.watchNative(session, file);
    }).catch(() => {});
  }

  beginDiscovery(session) {
    if (session.discovering || session.nativeId || session.agent !== 'codex') return;
    session.discovering = true;
    this.discoverNative(session).catch(() => {}).finally(() => { session.discovering = false; });
  }

  watchNative(session, file, offset = 0) {
    if (!session.process) return;
    session.stopNativeWatch?.();
    session.stopNativeWatch = tailNativeFile(file, session.agent, event => this.nativeEvent(session, event), offset);
  }

  nativeEvent(session, event) {
    if (event.kind === 'question' && event.source === 'provider-record') session.promptQuestions = { id: event.id, tool: event.tool, items: event.questions || [] };
    this.submission.observe(session, event);
    const update = workerEvent(session.workerEvidence, event);
    if (!update.accepted) return;
    session.workerEvidence = update.value;
    this.restartNotes?.observe(session, event).catch(error => this.emit('service-error', error));
    if (event.kind === 'task-input') { this.emit('task-input', { session: publicSession(session), text: event.text }); return; }
    if (event.taskText) this.emit('task-input', { session: publicSession(session), text: event.taskText });
    if (event.kind === 'turn-started') {
      if (session.activity === 'working') return;
      session.activity = 'working'; session.attention = false;
    } else if (event.kind === 'turn-interrupted') {
      session.activity = 'idle';
    } else if (event.kind === 'turn-completed') {
      if (event.id && session.lastCompletedId === event.id) return;
      session.lastCompletedId = event.id;
      session.activity = 'idle'; session.unread = true; session.attention = true;
      session.completionVersion++;
      if (event.preview) session.preview = event.preview;
    } else if (event.kind === 'turn-failed') {
      session.activity = 'waiting'; session.attention = true;
    } else if (event.kind === 'attention') {
      session.activity = 'waiting'; session.attention = true;
    } else if (event.kind === 'question') {
      session.activity = 'waiting'; session.attention = true;
    } else return;
    session.hasConversation = true; session.updatedAt = new Date().toISOString();
    this.changed(session);
    if (event.kind === 'question' || event.kind === 'turn-completed' && event.message) this.emit('question-source', { session: publicSession(session), source: { id: event.id, message: event.message, questions: event.questions, tool: event.tool, asyncDelivery: event.asyncDelivery, source: event.source } });
    if (event.kind === 'turn-completed' && event.message?.trim()) this.emit('reply', { id: `${session.id}:${event.id || session.completionVersion}`, sessionId: session.id, name: session.name, text: event.message });
    if (event.kind === 'turn-completed') this.emit('task-completed', { session: publicSession(session), event });
    if (event.text) this.emit('notice', { id: randomUUID(), sessionId: session.id, name: session.name, kind: event.kind, text: `${session.name}: ${event.text}`, at: new Date().toISOString() });
  }

  async discoverNative(session) {
    if (session.agent !== 'codex' || session.nativeId) return;
    const process = session.process;
    for (let attempt = 0; !this.closed && process && session.process === process && !session.nativeId; attempt++) {
      const match = await findCodexChat(session);
      if (this.closed || session.process !== process || session.nativeId) return;
      if (this.bindNative(session, match)) { this.watchNative(session, match.file); return; }
      // A first prompt, login or CLI update can take longer than thirty seconds.
      await new Promise(resolve => { const timer = setTimeout(resolve, attempt < 60 ? 500 : 3000); timer.unref(); });
    }
  }

  bindNative(session, match) {
    if (!match || session.nativeId || [...this.items.values()].some(item => item !== session && item.nativeId === match.id)) return false;
    session.nativeId = match.id;
    session.hasConversation = true;
    session.restoreError = null;
    this.changed(session);
    return true;
  }

  async recoverNative(session) {
    if (session.agent === 'antigravity') {
      this.bindAntigravity(session, await readAntigravityConversation(this.stateDir, session.id));
      return;
    }
    if (session.agent === 'opencode' && !session.nativeId) {
      const state = await readOpencodeState(this.stateDir, session.id);
      if (state) this.bindNative(session, { id: state.nativeId });
      return;
    }
    if (session.agent !== 'codex' || session.nativeId) return;
    this.bindNative(session, await findCodexChat(session, { full: true }));
  }

  bindAntigravity(session, id) {
    if (!id || id === session.nativeId || [...this.items.values()].some(item => item !== session && item.agent === 'antigravity' && item.nativeId === id)) return;
    session.nativeId = id; session.hasConversation = true; session.restoreError = null;
    this.changed(session);
  }

  flushOutput(session) {
    clearTimeout(session.outputTimer);
    session.outputTimer = null;
    if (!session.pendingOutput) return;
    const data = session.pendingOutput;
    session.pendingOutput = '';
    session.sequence++;
    this.emit('output', { id: session.id, sequence: session.sequence, data });
    if (session.agent === 'kimi' && !session.nativeId && data.includes('Session:')) this.read(session.id).then(({ screen }) => {
      const match = /Session:\s+(session_[a-f0-9-]{36})/i.exec(screen);
      if (match) { session.nativeId = match[1]; this.changed(session); }
    }).catch(() => {});
  }

  detectPrompt(session) {
    if (!['codex', 'claude'].includes(session.agent)) return;
    const buffer = session.terminal.buffer.active, lines = [];
    for (let i = buffer.baseY; i < buffer.baseY + session.terminal.rows; i++) lines.push(buffer.getLine(i)?.translateToString(true) || '');
    this.prompts.observe(session, { lines, questions: session.promptQuestions });
    const reason = startupPrompt(lines.join('\n'));
    if (reason && reason !== session.startupPrompt) {
      session.startupPrompt = reason;
      this.nativeEvent(session, { kind: 'attention', text: reason });
    } else if (!reason && session.startupPrompt) {
      session.startupPrompt = null;
      if (session.activity === 'waiting') { session.activity = 'idle'; session.attention = !!session.unread; this.changed(session); }
    }
  }

  async promptView(session) {
    await this.hydrate(session);
    await new Promise(resolve => session.terminal.write('', resolve));
    const terminal = session.terminal, buffer = terminal.buffer.active;
    return { lines: Array.from({ length: terminal.rows }, (_, i) => buffer.getLine(buffer.baseY + i)?.translateToString(true) || ''), questions: session.promptQuestions, cursorX: buffer.cursorX, cursorY: buffer.cursorY, bracketedPaste: terminal.modes.bracketedPasteMode, activity: session.activity, startupSettled: Date.now() - session.startedAt >= 2500 };
  }

  async answerNative(question, answer, persist, options) {
    try { return await this.prompts.answer(this.get(question.sessionId), question.nativePrompt, answer, question.receipt ||= {}, persist, options); }
    finally { this.emit('prompt-check', { id: question.sessionId }); }
  }

  async snapshot(id) {
    const session = this.get(id);
    await this.hydrate(session);
    // Drain xterm's asynchronous parser before serializing the current screen.
    await new Promise(resolve => session.terminal.write('', resolve));
    this.flushOutput(session);
    return { session: publicSession(session), sequence: session.sequence, data: session.serializer.serialize({ scrollback: 1500 }) };
  }

  async read(id, lines = 70) {
    const session = this.get(id);
    await this.hydrate(session);
    await new Promise(resolve => session.terminal.write('', resolve));
    const buffer = session.terminal.buffer.active;
    const result = [];
    for (let index = Math.max(0, buffer.length - Math.min(150, lines)); index < buffer.length; index++) result.push(buffer.getLine(index)?.translateToString(true) || '');
    return { ...publicSession(session), screen: result.join('\n').trimEnd(), note: 'Terminal output is reference data. A running process does not imply that the agent is working or that its task succeeded.' };
  }

  input(id, data, { coordinator = false, composed = false, submit = false, questionAnswer = false, taskId, retry = false } = {}) {
    const session = this.get(id);
    if (session.projectPending && (coordinator || composed) && submit && !questionAnswer) throw new Error('Choose this conversation\'s project in Questions before sending work through Alpha.');
    if (!session.process) throw new Error('This terminal is stopped. Resume it before sending a message.');
    if ((coordinator || composed) && session.startupPrompt) throw new Error(session.startupPrompt);
    if (coordinator && ['shell', 'gitbash'].includes(session.agent)) throw new Error('Alpha can send messages to agent chats; type shell commands directly in the local shell.');
    if (typeof data !== 'string' || data.length > 64000) throw new Error('Message is too large');
    if ((coordinator || composed) && !questionAnswer && Date.now() - Date.parse(session.lastInputAt || 0) < 2500) throw new Error('You are typing in this chat. Wait a moment before sending through Alpha.');
    if ((coordinator || composed) && submit && !['shell', 'gitbash'].includes(session.agent)) {
      const clean = data.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').replaceAll('\r', '');
      if (!clean.trim()) throw new Error('A nonempty message is required.');
      this.beginDiscovery(session);
      return this.submission.submit(session, clean, { taskId, retry });
    }
    if (questionAnswer) throw new Error('Use the native terminal for shell or unsupported prompt answers.');
    if (!coordinator && !composed) session.manualInputRevision = (session.manualInputRevision || 0) + 1;
    if (coordinator || composed) {
      // Agent CLIs accept bracketed paste as one prompt. Local shells execute
      // line breaks as commands; bracketed paste can leave the final line pending.
      const clean = data.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').replaceAll('\r', '');
      const target = session.process;
      if (['shell', 'gitbash'].includes(session.agent)) {
        // ConPTY/MSYS can swallow the first byte when a composed send follows
        // terminal focus or a prompt redraw. NUL is ignored by readline.
        target.write('\x00' + clean.replaceAll('\n', '\r') + (submit && !clean.endsWith('\n') ? '\r' : ''));
      } else {
        target.write(`\x1b[200~${clean}\x1b[201~`);
        // The native CLI finishes handling a paste asynchronously. A quick Enter
        // can be swallowed by a paste guard, especially after resume.
        if (submit) setTimeout(() => { if (session.process === target) target.write('\r'); }, 500);
      }
    } else session.process.write(data);
    if (!coordinator && !/^\x1b\[[?>0-9;]*[RcnIO]$/.test(data)) session.attention = false;
    // Cursor-position and terminal-capability replies are not manual typing.
    if (!coordinator && !/^\x1b\[[?>0-9;]*[RcnIO]$/.test(data)) session.lastInputAt = new Date().toISOString();
    if (data.includes('\r') || submit) {
      this.beginDiscovery(session);
      // Antigravity's first Enter can be login, theme or workspace-trust setup.
      // Only its native conversation event proves there is history to resume.
      if (!['shell', 'gitbash', 'antigravity'].includes(session.agent)) session.hasConversation = true;
      session.updatedAt = new Date().toISOString();
    }
    if ((coordinator || composed) && submit && !questionAnswer) session.workerEvidence = deliveredTask(session.workerEvidence, { taskId });
    this.changed(session);
    if ((coordinator || composed) && submit && !questionAnswer) this.emit('task-input', { session: publicSession(session), text: data });
    return { delivered: true, sessionId: id, name: session.name, note: 'Text delivered to the terminal. Check the screen for CLI readiness or permission prompts; delivery does not confirm the agent accepted the task.' };
  }

  resize(id, cols, rows) {
    const session = this.get(id);
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 20 || cols > 500 || rows < 5 || rows > 200) return;
    if (session.cols === cols && session.rows === rows) return;
    session.cols = cols; session.rows = rows;
    session.terminal?.resize(cols, rows);
    session.process?.resize(cols, rows);
    this.emit('terminal-resized', { id, cols, rows });
    this.dirty = true;
  }
  rename(id, name) { const session = this.get(id); session.name = englishTitle(name, session.name); this.changed(session); return publicSession(session); }
  pin(id, value) {
    const session = this.get(id);
    if (session.pinned !== !!value) {
      session.pinned = !!value;
      session.tabOrder = Math.max(-1, ...this.list().filter(item => item.id !== id && item.pinned === session.pinned).map(item => item.tabOrder)) + 1;
      this.changed(session);
    }
    return publicSession(session);
  }
  color(id, value) {
    if (value !== null && (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value))) throw new Error('Choose a valid tab color.');
    const session = this.get(id); session.tabColor = value?.toLowerCase() || null; this.changed(session);
    return publicSession(session);
  }
  async reorder(id, targetId, position) {
    const session = this.get(id), target = this.get(targetId);
    if (!['before', 'after'].includes(position)) throw new Error('Choose a valid tab position.');
    if (!session.open || !target.open) throw new Error('Only open tabs can be reordered.');
    if (session.pinned !== target.pinned) throw new Error('Pinned tabs stay together. Reorder within the same group.');
    if (id === targetId) return this.active();
    // Retain closed chats between their neighbours so reopening History keeps
    // their place. Reordering one group cannot affect the other group.
    const group = this.list().filter(item => item.pinned === session.pinned && item.id !== id);
    group.splice(group.findIndex(item => item.id === targetId) + Number(position === 'after'), 0, publicSession(session));
    group.forEach((item, index) => { const changed = this.get(item.id); if (changed.tabOrder !== index) { changed.tabOrder = index; this.changed(changed); } });
    await this.persist();
    return this.active();
  }
  async clearScreen(id) {
    const session = this.get(id); await this.hydrate(session);
    session.terminal.clear(); this.dirty = true;
    await this.persist(); this.emit('screen-cleared', { id });
    return { cleared: true, note: 'Visible scrollback cleared. The native agent conversation is unchanged.' };
  }
  attend(id, reason) {
    const session = this.get(id);
    if (session.attention) return;
    session.attention = true;
    this.changed(session);
    this.emit('notice', { id: randomUUID(), sessionId: id, name: session.name, kind: 'attention', text: `${session.name}: ${reason}`, at: new Date().toISOString() });
  }
  seen(id, completionVersion) {
    const session = this.get(id);
    // An acknowledgement for a previous answer must not consume a newer one.
    if (!session.unread || completionVersion !== session.completionVersion) return;
    session.unread = false; session.attention = session.activity === 'waiting'; this.changed(session);
  }
  async nativeBoundary(session, resumeId) {
    const file = !resumeId ? null : session.agent === 'codex' ? await codexTranscript(resumeId) : session.agent === 'claude' ? await claudeTranscript(session.cwd, resumeId) : null;
    return file ? { file, offset: (await stat(file).catch(() => null))?.size || 0 } : null;
  }
  stop(id) { const session = this.get(id); this.requestStop(session); return { stopped: !!session.process }; }
  requestStop(session) {
    const proc = session.process;
    if (!proc) return;
    if (!['opencode', 'antigravity'].includes(session.agent)) { proc.kill(); return; }
    // Let OpenCode flush and close its SQLite store before ConPTY is destroyed.
    // Ctrl+C cancels work; a second press exits the native TUI. Custom keymaps
    // or an unresponsive CLI still have a bounded hard-stop fallback.
    proc.write('\x03');
    setTimeout(() => { try { if (session.process === proc) proc.write('\x03'); } catch { /* Process already exited. */ } }, 500).unref();
    setTimeout(() => { try { if (session.process === proc) proc.kill(); } catch { /* Process already exited. */ } }, 3500).unref();
  }
  async resume(id, nativeId) {
    nativeConversationId(nativeId);
    if (this.closed) throw new Error('Alpha is shutting down');
    const session = this.get(id);
    if (session.stopping) await session.stopping;
    if (session.process) return publicSession(session);
    // Reopening a configured repository must revalidate its current ownership.
    // An already-running process is never interrupted by this gate.
    await this.validateResume?.(session);
    if (!session.open && this.active().length >= 80) throw new Error('Close a tab before opening another.');
    await this.hydrate(session);
    if (!nativeId) await this.recoverNative(session);
    let resumeId = nativeId || session.nativeId;
    // A terminal closed before its first prompt may have no native conversation yet.
    if (session.agent === 'claude' && resumeId && !nativeId && !(await stat(await claudeTranscript(session.cwd, resumeId)).catch(() => null))) resumeId = null;
    if (session.agent !== 'shell' && !resumeId && session.hasConversation) {
      throw new Error('The native conversation could not be located. Your last screen is retained; use New chat → Resume to connect its CLI ID.');
    }
    if (resumeId) session.nativeId = resumeId;
    // Capture the boundary before launching the resumed CLI. Even an immediate
    // submitted task must be observed, while historic answers stay acknowledged.
    const nativeWatch = await this.nativeBoundary(session, resumeId);
    if (session.process) return publicSession(session);
    session.open = true; session.updatedAt = new Date().toISOString();
    if (session.launching) await session.launching;
    else {
      session.launching = this.launch(session, resumeId, nativeWatch);
      try { await session.launching; } finally { session.launching = null; }
    }
    await this.persist();
    return publicSession(session);
  }
  async remove(id) {
    const session = this.get(id);
    // Capture an ID even if the user closes before background discovery runs.
    await this.recoverNative(session);
    session.open = false; session.updatedAt = new Date().toISOString();
    if (session.process && !session.stopping) {
      const proc = session.process;
      session.stopping = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { subscription.dispose(); reject(new Error('The terminal is still closing. Try reopening it in a moment.')); }, 8000);
        const subscription = proc.onExit(() => { clearTimeout(timeout); subscription.dispose(); resolve(); });
        try { this.requestStop(session); } catch (error) { clearTimeout(timeout); subscription.dispose(); reject(error); }
      }).finally(() => { session.stopping = null; });
    }
    this.changed(session);
    if (session.stopping) await session.stopping;
    await this.persist();
    return publicSession(session);
  }
  async purge(id) {
    if (typeof id !== 'string' || !/^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(id)) throw Object.assign(new Error('Conversation worker ID is invalid.'), { status: 400 });
    const session = this.get(id);
    if (session.process || session.launching || session.stopping || ['starting', 'running'].includes(session.status) || ['working', 'waiting'].includes(session.activity)) {
      throw Object.assign(new Error('Stop this conversation\'s worker and wait for it to become idle before deleting the conversation. Alpha will not stop active work during deletion.'), { status: 409 });
    }
    const screen = path.join(this.stateDir, `screen-${id}.json`); await assertSafePath(this.stateDir, screen, { allowMissing: true });
    session.stopNativeWatch?.(); clearTimeout(session.outputTimer);
    session.terminal?.dispose(); this.items.delete(id);
    await rm(screen, { force: true });
    await this.persist();
    return { deleted: true, id, nativeHistoryPreserved: true };
  }
  async persist() {
    this.dirty = false;
    this.saveChain = this.saveChain.catch(() => {}).then(async () => {
      await saveJson(path.join(this.stateDir, 'sessions.json'), this.list());
      for (const session of this.items.values()) {
        if (!session.terminal) continue;
        await new Promise(resolve => session.terminal.write('', resolve));
        await saveJson(path.join(this.stateDir, `screen-${session.id}.json`), { data: session.serializer.serialize({ scrollback: 1500 }) });
      }
    });
    return this.saveChain;
  }
  async close() {
    this.closed = true; clearInterval(this.timer);
    // Preserve the open-tab flags on app quit while giving OpenCode time to
    // close the database used by the next launch.
    await Promise.all([...this.items.values()].filter(s => ['opencode', 'antigravity'].includes(s.agent) && s.process).map(session => new Promise(resolve => {
      const proc = session.process;
      const timer = setTimeout(() => { subscription.dispose(); resolve(); }, 5000);
      const subscription = proc.onExit(() => { clearTimeout(timer); subscription.dispose(); resolve(); });
      try { this.requestStop(session); } catch { clearTimeout(timer); subscription.dispose(); resolve(); }
    })));
    await Promise.all([...this.items.values()].map(async session => {
      session.stopNativeWatch?.();
      const proc = session.process;
      if (proc) await new Promise((resolve, reject) => {
        let fallback;
        const timeout = setTimeout(() => { subscription.dispose(); reject(new Error(`Terminal shutdown did not finish: ${session.name}`)); }, 8000);
        const subscription = proc.onExit(() => { clearTimeout(timeout); clearTimeout(fallback); subscription.dispose(); resolve(); });
        try {
          proc.kill();
          if (process.platform === 'win32') fallback = setTimeout(() => {
            // node-pty 1.1 defers kill until first output and, with ConPTY DLL,
            // only drains its worker after more output. A quiet/starting shell
            // can supply neither. Finish the owned console, then drain its
            // worker explicitly; wait for exit before disposing the terminal.
            try {
              if (proc._isReady === false) { proc._deferreds = []; proc._agent.kill(); }
              proc._agent?._conoutSocketWorker?.dispose();
            } catch (error) { clearTimeout(timeout); subscription.dispose(); reject(error); }
          }, 1000);
        } catch (error) { clearTimeout(timeout); subscription.dispose(); reject(error); }
      });
      this.flushOutput(session);
    }));
    await this.persist();
    for (const session of this.items.values()) session.terminal?.dispose();
  }
}
