import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { readJson, saveJson } from './util.mjs';

const cleanLine = line => String(line || '').replace(/^\s*(?:#{1,6}\s*|[-*>]\s*)/, '').replace(/\*\*|__/g, '').trim();
const optionLine = line => /^\s*(?:[-*•]|\d+[.)]|[A-D][.)])\s+(.{1,200})$/.exec(line)?.[1]?.trim();
const validQuestion = value => value.length >= 8 && value.length <= 500 && value.endsWith('?') && !/^https?:\/\//i.test(value);

export function extractQuestions(message) {
  if (typeof message !== 'string' || !message.trim()) return [];
  const lines = message.slice(-12000).split(/\r?\n/);
  const result = [];
  let code = false;
  for (let i = 0; i < lines.length && result.length < 5; i++) {
    if (/^\s*```/.test(lines[i])) { code = !code; continue; }
    if (code) continue;
    const question = cleanLine(lines[i]);
    if (!validQuestion(question)) continue;
    const options = [];
    for (let j = i + 1; j < Math.min(lines.length, i + 9); j++) {
      const option = optionLine(lines[j]);
      if (!option) { if (lines[j].trim() && options.length) break; continue; }
      options.push(option);
    }
    if (!options.length && /^(?:do|does|did|should|would|could|can|may|is|are|was|were|have|has)\b/i.test(question)) options.push('Yes', 'No');
    result.push({ text: question, options: options.slice(0, 6) });
  }
  return result;
}

export function extractTerminalQuestion(screen) {
  const last = String(screen || '').split(/\r?\n/).map(cleanLine).filter(Boolean).at(-1) || '';
  return validQuestion(last) ? last : null;
}

export class Questions extends EventEmitter {
  constructor(stateDir) {
    super();
    this.file = path.join(stateDir, 'questions.json');
    this.items = [];
    this.writes = Promise.resolve();
    this.answers = new Map();
  }
  async init() {
    const saved = await readJson(this.file, []);
    this.items = Array.isArray(saved) ? saved.filter(item => item && typeof item.id === 'string' && typeof item.sessionId === 'string' && ['pending', 'answered', 'dismissed'].includes(item.status)).slice(-500) : [];
    return this;
  }
  list() { return this.items.filter(item => item.status === 'pending').sort((a, b) => a.createdAt.localeCompare(b.createdAt)); }
  async ask({ text, options = [], source = 'coordinator', sourceId, operationId, context, chatName = 'Alpha', sessionId = 'alpha', threadId }) {
    if (typeof text !== 'string' || text.trim().length < 8 || text.length > 500) throw new Error('Write a question between 8 and 500 characters.');
    if (!['coordinator', 'maintenance', 'project'].includes(source)) throw new Error('Unknown question source.');
    const existing = this.items.find(item => item.source === source && item.sourceId === sourceId && (item.threadId || null) === (threadId || null) && item.text === text.trim() && (source !== 'project' || item.status === 'pending'));
    if (existing) return existing;
    const item = { id: randomUUID(), sessionId: source === 'project' ? sessionId : 'alpha', source, sourceId: sourceId || null, operationId: operationId || null, context: String(context || '').slice(0, 6000), chatName, text: text.trim(), options: options.filter(value => typeof value === 'string' && value.trim()).map(value => value.trim().slice(0, 200)).slice(0, source === 'project' ? 100 : 6), status: 'pending', createdAt: new Date().toISOString() };
    if (threadId) item.threadId = threadId;
    this.items.push(item); await this.changed(); return item;
  }
  async captureAlpha(operation) {
    const added = [];
    for (const question of extractQuestions(operation.result)) added.push(await this.ask({ ...question, sourceId: operation.id, operationId: operation.id, context: operation.text, threadId: operation.threadId }));
    return added;
  }
  changed() {
    this.writes = this.writes.catch(() => {}).then(() => saveJson(this.file, this.items));
    return this.writes.then(() => this.emit('changed', this.list()));
  }
  capture(session, source) {
    if (!['codex', 'claude', 'shell', 'gitbash'].includes(session.agent)) return [];
    const structured = Array.isArray(source.questions);
    const questions = structured ? source.questions : extractQuestions(source.message);
    const added = [];
    for (const candidate of questions) {
      const text = String(candidate.text || candidate.question || '').trim().slice(0, 500);
      // An explicit question tool may include context after its question mark.
      // Terminal/prose detection remains strict so queued-input status labels
      // never become inferred questions.
      if (structured ? text.length < 8 || /^https?:\/\//i.test(text) : !validQuestion(text)) continue;
      if (source.id && this.items.some(item => item.sessionId === session.id && item.sourceId === source.id && item.text.toLowerCase() === text.toLowerCase())) continue;
      if (this.items.some(item => item.status === 'pending' && item.sessionId === session.id && item.text.toLowerCase() === text.toLowerCase())) continue;
      const options = (candidate.options || []).map(option => typeof option === 'string' ? option : option?.label).filter(value => typeof value === 'string' && value.trim()).map(value => value.trim().slice(0, 200)).slice(0, 6);
      const item = { id: randomUUID(), sessionId: session.id, nativeId: session.nativeId || null, requiresNative: structured, chatName: session.name, text, options, status: 'pending', sourceId: source.id || null, createdAt: new Date().toISOString() };
      item.threadId = session.alphaThreadId || session.id;
      this.items.push(item); added.push(item);
    }
    if (added.length) { this.items = this.items.slice(-500); this.changed().catch(error => this.emit('error', error)); }
    return added;
  }
  async captureNative(session, state, binding) {
    if (!state.prompt) return null;
    const existing = this.items.find(item => item.nativePrompt?.generation === state.generation && item.sessionId === session.id);
    if (existing) return existing;
    for (const item of this.items) if (item.status === 'pending' && item.requiresNative && item.sessionId === session.id && item.sourceId === state.prompt.sourceId) { item.status = 'dismissed'; item.delivery = 'native-menu'; }
    // A new, settled native menu supersedes only older menus in this terminal.
    for (const item of this.items) if (item.status === 'pending' && item.source === 'native' && item.sessionId === session.id) { item.status = 'dismissed'; item.delivery = 'superseded'; }
    const item = { id: randomUUID(), sessionId: session.id, threadId: binding.threadId, chatName: session.name,
      source: 'native', nativePrompt: binding, text: state.prompt.text, context: state.prompt.context,
      options: state.prompt.choices.map(choice => choice.label), status: 'pending', createdAt: new Date().toISOString() };
    const uncertain = this.items.findLast(prior => prior.sessionId === session.id && prior.nativePrompt?.fingerprint === binding.fingerprint && prior.receipt?.intentAt && !prior.receipt.acceptedAt);
    if (uncertain) item.receipt = { ...uncertain.receipt, previousQuestionId: uncertain.id };
    this.items.push(item); await this.changed(); return item;
  }
  async nativeTransition(sessionId) {
    let changed = false;
    for (const item of this.items) if (item.status === 'pending' && item.source === 'native' && item.sessionId === sessionId) {
      item.status = 'dismissed'; item.delivery = 'native-composer-observed'; item.resolvedAt = new Date().toISOString(); changed = true;
    }
    if (changed) await this.changed();
  }
  answer(id, text, sessions, resume) {
    if (this.answers.has(id)) {
      const active = this.answers.get(id);
      if (active.text !== text?.trim()) return Promise.reject(new Error('A different answer is already being delivered.'));
      return active.promise;
    }
    const pending = this.deliverAnswer(id, text, sessions, resume).finally(() => this.answers.delete(id));
    this.answers.set(id, { text: text?.trim(), promise: pending }); return pending;
  }
  async deliverAnswer(id, text, sessions, resume) {
    const accepted = this.items.find(item => item.id === id && item.status === 'answered');
    if (accepted) {
      if (accepted.answer !== text?.trim()) throw Object.assign(new Error('This question already has a different answer.'), { status: 409 });
      return { delivered: true, questionId: id, alreadyAccepted: true };
    }
    const question = this.items.find(item => item.id === id && item.status === 'pending');
    if (!question) throw Object.assign(new Error('Question is no longer pending.'), { status: 404 });
    if (typeof text !== 'string' || !text.trim() || text.length > 64000) throw new Error('Enter an answer before sending.');
    if (['coordinator', 'maintenance', 'project'].includes(question.source)) {
      if (!resume) throw new Error('Alpha cannot receive this answer right now.');
      question.attempts = (question.attempts || 0) + 1;
      await this.changed();
      // Validate and prepare delivery first. A continuation may be returned;
      // it runs only after the answer is durable and the pending list is updated.
      const continuation = await resume(question, text.trim());
      question.status = 'answered'; question.answer = text.trim(); question.answeredAt = new Date().toISOString();
      if (typeof continuation === 'function') question.continuation = 'queued';
      try { await this.changed(); }
      catch (error) { question.status = 'pending'; delete question.answer; delete question.answeredAt; delete question.continuation; throw error; }
      if (typeof continuation === 'function') {
        void Promise.resolve().then(continuation).then(() => { question.continuation = 'completed'; }, error => {
          question.continuation = 'failed'; question.continuationError = String(error.message || error);
          this.emit('continuation-failed', { question, error });
        }).then(() => this.changed()).catch(error => this.emit('error', error));
      }
      return { delivered: true, questionId: id, source: question.source };
    }
    const session = sessions.get(question.sessionId);
    if (session.status !== 'running') throw new Error('This chat is stopped. Reconnect it before answering.');
    if (question.source === 'native') {
      const result = await sessions.answerNative(question, text.trim(), () => this.changed());
      if (!result.accepted) throw new Error('Native answer acceptance is not verified.');
      question.status = 'answered'; question.answer = text.trim(); question.answeredAt = new Date().toISOString(); question.delivery = 'observed';
      await this.changed(); return { ...result, questionId: id };
    }
    if ((question.nativeId || null) !== (session.nativeId || null) || question.threadId !== (session.alphaThreadId || session.id)) throw new Error('The originating native conversation changed. Use its terminal.');
    if (question.requiresNative) throw new Error('This provider question needs its native menu. Use the terminal fallback if no supported choice appears in Questions.');
    const result = await sessions.input(session.id, text.trim(), { composed: true, submit: true, questionAnswer: true, taskId: `question:${question.id}` });
    if (!result?.accepted) throw new Error(result?.note || 'Answer acceptance is not verified. Inspect the terminal before retrying.');
    question.status = 'answered'; question.answer = text.trim(); question.answeredAt = new Date().toISOString();
    question.delivery = 'observed';
    // The submission receipt is already durable; a failed audit write cannot
    // authorize replay of a previously accepted answer.
    this.emit('answer', { question, text: text.trim() });
    await this.changed();
    return { delivered: true, accepted: true, questionId: id, sessionId: session.id, note: 'Exact answer observed in the native input record.' };
  }

  async dismiss(id) {
    const question = this.items.find(item => item.id === id && item.status === 'pending');
    if (!question) throw Object.assign(new Error('Question is no longer pending.'), { status: 404 });
    if (question.source === 'project') throw new Error('Choose a project, or close this new chat to cancel it.');
    question.status = 'dismissed'; question.dismissedAt = new Date().toISOString();
    await this.changed();
    return { dismissed: true, questionId: id };
  }
  close() { return this.writes; }
  async closeSession(id) {
    for (const question of this.items.filter(item => item.sessionId === id && item.source === 'project' && item.status === 'pending')) question.status = 'dismissed';
    await this.changed();
  }
}
