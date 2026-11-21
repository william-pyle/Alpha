import path from 'node:path';
import { readJson, saveJson } from './util.mjs';

export class Replies {
  constructor(stateDir, changed = () => {}) { this.file = path.join(stateDir, 'replies.json'); this.changed = changed; this.items = []; this.saves = Promise.resolve(); }
  async init() { const saved = await readJson(this.file, []); this.items = Array.isArray(saved) ? saved.slice(-200) : []; return this; }
  add({ id, sessionId, name, text }) {
    if (!id || !text?.trim() || this.items.some(item => item.id === id)) return null;
    const item = { id, sessionId, name, text: text.slice(0, 16000), at: new Date().toISOString() };
    this.items = [...this.items, item].slice(-200);
    this.saves = this.saves.catch(() => {}).then(() => saveJson(this.file, this.items));
    this.changed(item);
    return item;
  }
  async purgeSessions(sessionIds = []) {
    const ids = new Set(sessionIds), before = this.items.length;
    this.items = this.items.filter(item => !ids.has(item.sessionId));
    if (this.items.length !== before) {
      const snapshot = this.items;
      this.saves = this.saves.catch(() => {}).then(() => saveJson(this.file, snapshot));
      await this.saves;
    }
    return before - this.items.length;
  }
  async close() { await this.saves; }
}
