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
    const existing = this.items.find(item => item.source === source && item.sourceId === sourceId && item.text === text.trim() && (source !== 'project' || item.status === 'pending'));
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
    this.emit('changed', this.list());
    this.writes = this.writes.catch(() => {}).then(() => saveJson(this.file, this.items));
    return this.writes;
  }
  capture(session, source) {
    if (!['codex', 'claude', 'shell', 'gitbash'].includes(session.agent)) return [];
    const questions = Array.isArray(source.questions) ? source.questions : extractQuestions(source.message);
    const added = [];
    for (const candidate of questions) {
      const text = String(candidate.text || candidate.question || '').trim().slice(0, 500);
      if (!validQuestion(text)) continue;
      if (source.id && this.items.some(item => item.sessionId === session.id && item.sourceId === source.id && item.text.toLowerCase() === text.toLowerCase())) continue;
      if (this.items.some(item => item.status === 'pending' && item.sessionId === session.id && item.text.toLowerCase() === text.toLowerCase())) continue;
      const options = (candidate.options || []).map(option => typeof option === 'string' ? option : option?.label).filter(value => typeof value === 'string' && value.trim()).map(value => value.trim().slice(0, 200)).slice(0, 6);
      const item = { id: randomUUID(), sessionId: session.id, chatName: session.name, text, options, status: 'pending', sourceId: source.id || null, createdAt: new Date().toISOString() };
      item.threadId = session.alphaThreadId || session.id;
      this.items.push(item); added.push(item);
    }
    if (added.length) { this.items = this.items.slice(-500); this.changed().catch(error => this.emit('error', error)); }
    return added;
  }
  answer(id, text, sessions, resume) {
    if (this.answers.has(id)) return this.answers.get(id);
    const pending = this.deliverAnswer(id, text, sessions, resume).finally(() => this.answers.delete(id));
    this.answers.set(id, pending); return pending;
  }
  async deliverAnswer(id, text, sessions, resume) {
    const question = this.items.find(item => item.id === id && item.status === 'pending');
    if (!question) throw Object.assign(new Error('Question is no longer pending.'), { status: 404 });
    if (typeof text !== 'string' || !text.trim() || text.length > 64000) throw new Error('Enter an answer before sending.');
    if (['coordinator', 'maintenance', 'project'].includes(question.source)) {
      if (!resume) throw new Error('Alpha cannot receive this answer right now.');
      question.attempts = (question.attempts || 0) + 1;
      await this.changed();
      await resume(question, text.trim());
      question.status = 'answered'; question.answer = text.trim(); question.answeredAt = new Date().toISOString();
      await this.changed();
      return { delivered: true, questionId: id, source: question.source };
    }
    const session = sessions.get(question.sessionId);
    if (session.status !== 'running') throw new Error('This chat is stopped. Reconnect it before answering.');
    sessions.input(session.id, text.trim(), { composed: true, submit: true, questionAnswer: true });
    question.status = 'answered'; question.answer = text.trim(); question.answeredAt = new Date().toISOString();
    this.emit('answer', { question, text: text.trim() });
    await this.changed();
    return { delivered: true, questionId: id, sessionId: session.id, note: 'Answer delivered to the terminal. Check the chat to confirm the agent accepted it.' };
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
