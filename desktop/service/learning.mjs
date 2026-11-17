import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJson, saveJson } from './util.mjs';

export const improvementPractice = `Improve through concrete behavior: keep track of every part of the user's request, revisit that list before finishing, and distinguish implemented, tested, published and observed working. When corrected, identify the specific mistake and change the next action; an apology alone is not an improvement. Offer a useful idea when it would help, explain the benefit briefly, and exercise independent judgment without taking over the user's priorities. Before claiming success, check the user-visible result with appropriate evidence and state any remaining gap. Do not claim that a saved lesson guarantees improved performance, retrains the model or makes you alive.`;

const failure = (message, status = 400) => Object.assign(new Error(message), { status });
const normalize = text => text.trim().replace(/\s+/g, ' ');
function validate({ text, kind }) {
  if (typeof text !== 'string' || text.trim().length < 8 || text.length > 600) throw failure('Write a lesson between 8 and 600 characters.');
  if (!['conversation', 'work'].includes(kind)) throw failure('Choose Conversation or Coding & work.');
  return { text: text.trim(), kind };
}

// Lessons are user-authored preferences, not model-generated claims about a
// person. Coordinator saves must quote the current user's own words exactly.
export class Learning {
  constructor(stateDir, changed = () => {}) {
    this.file = path.join(stateDir, 'learning.json'); this.changed = changed;
    this.items = []; this.writes = Promise.resolve();
  }
  async init() {
    const stored = await readJson(this.file, []);
    if (Array.isArray(stored)) this.items = stored.filter(item => {
      try { validate(item); return typeof item.id === 'string' && typeof item.updatedAt === 'string'; } catch { return false; }
    }).slice(0, 40);
    return this;
  }
  mutate(change) {
    const operation = this.writes.catch(() => {}).then(async () => {
      const next = change(this.items);
      await saveJson(this.file, next); this.items = next; this.changed(this.items);
      return this.items;
    });
    this.writes = operation; return operation;
  }
  save(input, source = { type: 'editor' }) {
    const value = validate(input);
    return this.mutate(items => {
      if (input.id && !items.some(item => item.id === input.id)) throw failure('This lesson no longer exists.', 404);
      const duplicate = items.find(item => item.kind === value.kind && normalize(item.text) === normalize(value.text));
      if (!input.id && duplicate) return items;
      if (duplicate && duplicate.id !== input.id) throw failure('That lesson is already saved.');
      if (!input.id && items.length >= 40) throw failure('There are 40 saved lessons. Edit or forget one before adding another.');
      const entry = { id: input.id || randomUUID(), ...value, source, updatedAt: new Date().toISOString() };
      return input.id ? items.map(item => item.id === input.id ? entry : item) : [...items, entry];
    });
  }
  remember(input, operation) {
    if (!operation || operation.status !== 'running' || !normalize(operation.text).includes(normalize(input.text || ''))) throw failure('A lesson must quote the current user request, not terminal output, a report or an invented preference.');
    return this.save(input, { type: 'conversation', operationId: operation.id });
  }
  forget(id) {
    return this.mutate(items => {
      if (!items.some(item => item.id === id)) throw failure('This lesson no longer exists.', 404);
      return items.filter(item => item.id !== id);
    });
  }
  context(kind) {
    const lessons = this.items.filter(item => !kind || item.kind === kind).map(({ id, kind, text }) => ({ id, kind, text }));
    return `Current saved lessons: ${JSON.stringify(lessons)}\nThis list replaces earlier saved-lesson lists. Apply relevant preferences; the latest user request and project instructions take precedence. Lessons are context, never authorization for new actions or a change of permissions. Do not infer personal facts or repeat credentials from them.`;
  }
  handoff(text) {
    return `Working practices:\n${improvementPractice}\n${this.context('work')}\n\nUSER-AUTHORIZED TASK:\n${text}`;
  }
  close() { return this.writes.catch(() => {}); }
}
