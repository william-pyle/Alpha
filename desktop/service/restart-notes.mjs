import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJson, saveJson } from './util.mjs';

export class RestartNotes {
  constructor(stateDir, changed = () => {}) { this.file = path.join(stateDir, 'restart-notes.json'); this.items = []; this.changed = changed; this.writes = Promise.resolve(); }
  async init() { const saved = await readJson(this.file, []); this.items = Array.isArray(saved) ? saved : []; return this; }
  async prepare(session, note) {
    if (session.agent !== 'codex' || !session.nativeId) throw new Error('Choose a Codex conversation with a saved native session ID.');
    if (typeof note !== 'string' || note.trim().length < 20 || note.length > 12000) throw new Error('Write a restart note between 20 and 12000 characters.');
    const item = { id: randomUUID(), sessionId: session.id, nativeId: session.nativeId, chatName: session.name, note: note.trim(), status: 'prepared', createdAt: new Date().toISOString() };
    this.items = [...this.items.filter(entry => entry.sessionId !== session.id), item].slice(-20); await this.save(); return item;
  }
  async claim(session, resumeId) {
    const item = this.items.find(entry => entry.sessionId === session.id && entry.nativeId === resumeId && entry.status === 'prepared');
    if (!item || session.agent !== 'codex') return undefined;
    if (Date.now() - Date.parse(item.createdAt) > 7 * 86400000) { item.status = 'expired'; await this.save(); return undefined; }
    // Persist before launching: an uncertain launch must not replay the request
    // automatically on the next restart.
    item.status = 'dispatched'; item.dispatchedAt = new Date().toISOString(); await this.save();
    return `[Alpha restart ${item.id}]\nThe user asked to resume this same conversation after Alpha restarted. Read this saved note, inspect the current application and task state, report whether continuation succeeded, then continue the authorized work. Do not repeat completed actions or install another update merely because the note mentions one.\n\n${item.note}`;
  }
  async observe(session, event) {
    const item = this.items.find(entry => entry.sessionId === session.id && entry.nativeId === session.nativeId && ['dispatched', 'resumed'].includes(entry.status));
    if (!item) return;
    if ((event.text || event.taskText || '').includes(`[Alpha restart ${item.id}]`)) { item.status = 'resumed'; item.resumedAt = new Date().toISOString(); await this.save(); }
    else if (event.kind === 'turn-completed' && item.status === 'resumed') { item.status = 'completed'; item.completedAt = new Date().toISOString(); await this.save(); }
  }
  async failed(session, error) { const item = this.items.find(entry => entry.sessionId === session.id && entry.status === 'dispatched'); if (item) { item.status = 'failed'; item.error = String(error.message || error).slice(0, 1000); await this.save(); } }
  async cancel(id) { const item = this.items.find(entry => entry.id === id); if (!item) throw new Error('Restart note was not found.'); item.status = 'cancelled'; await this.save(); return item; }
  save() { this.writes = this.writes.catch(() => {}).then(() => saveJson(this.file, this.items)); this.changed(this.items); return this.writes; }
  close() { return this.writes.catch(() => {}); }
}
