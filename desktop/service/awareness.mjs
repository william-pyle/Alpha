import path from 'node:path';
import { readJson, saveJson } from './util.mjs';

// Only explicit events enter this ledger. A quiet terminal is not a stall.
export class Awareness {
  constructor(stateDir, changed = () => {}, clock = Date.now) { this.file = path.join(stateDir, 'awareness.json'); this.changed = changed; this.clock = clock; this.items = []; this.settings = { enabled: true, quiet: false, desktop: false }; this.desktop = null; this.writes = Promise.resolve(); }
  async init() { const data = await readJson(this.file, {}); this.items = data.items || []; this.receipts = data.receipts || Object.fromEntries(this.items.map(item => [item.id, item.at])); this.settings = { ...this.settings, ...data.settings }; return this; }
  snapshot() {
    if (this.desktop && this.clock() - this.desktop.at > 15000) this.desktop = null;
    const priority = { question: 0, error: 1, attention: 2, review: 3 };
    return { settings: this.settings, items: this.items.filter(item => this.clock() - item.at < 30 * 86400000 && !item.dismissed && (!item.snoozeUntil || item.snoozeUntil <= this.clock())).sort((a, b) => (priority[a.kind] ?? 4) - (priority[b.kind] ?? 4) || b.at - a.at), desktop: this.desktop };
  }
  event({ id, threadId = null, questionId = null, sessionId = null, kind, text, source, inference = false, at = this.clock() }) {
    const observedAt = typeof at === 'string' ? Date.parse(at) : at;
    if (!Number.isFinite(observedAt) || observedAt > this.clock() + 60000 || this.clock() - observedAt >= 30 * 86400000) return;
    if (!this.settings.enabled || Object.hasOwn(this.receipts, id) || this.items.some(item => item.id === id)) return;
    const last = this.items.findLast(item => item.threadId === threadId && item.kind === kind);
    if (inference && last && this.clock() - last.at < 30 * 60 * 1000) return;
    this.receipts[id] = observedAt;
    this.receipts = Object.fromEntries(Object.entries(this.receipts).filter(([, time]) => this.clock() - time < 30 * 86400000));
    this.items.push({ id, threadId, questionId, sessionId, kind, text, source, inference, at: observedAt, dismissed: false, snoozeUntil: null });
    // Keep dismissal receipts during retention; never repopulate from old scans.
    this.items = this.items.filter(item => this.clock() - item.at < 30 * 86400000).slice(-500);
    this.publish();
  }
  control(data) {
    for (const key of ['enabled', 'quiet', 'desktop']) if (typeof data[key] === 'boolean') this.settings[key] = data[key];
    if (!this.settings.desktop || !this.settings.enabled) this.desktop = null;
    if (data.id) {
      const item = this.items.find(item => item.id === data.id);
      if (!item) throw new Error('Attention item was not found.');
      if (data.action === 'dismiss') item.dismissed = true;
      else if (data.action === 'snooze') item.snoozeUntil = this.clock() + 30 * 60 * 1000;
      else throw new Error('Choose dismiss or snooze.');
    }
    this.publish(); return this.snapshot();
  }
  resolve(predicate) {
    let changed = false;
    for (const item of this.items) if (!item.dismissed && predicate(item)) { item.dismissed = true; changed = true; }
    if (changed) this.publish();
  }
  sample(application) {
    if (!this.settings.enabled || !this.settings.desktop) { this.desktop = null; return; }
    // The native host returns only an executable basename, never a title/path.
    const name = typeof application === 'string' && /^[\w .()-]{1,100}\.exe$/i.test(application) ? application : null;
    const safe = name && !/password|1password|bitwarden|keepass|credential/i.test(name) ? name : null;
    this.desktop = safe ? { application: safe, source: 'Windows foreground application name', at: this.clock() } : null;
    this.changed(this.snapshot());
  }
  publish() { this.changed(this.snapshot()); void this.save().catch(() => {}); }
  save() { this.writes = this.writes.catch(() => {}).then(() => saveJson(this.file, { schemaVersion: 1, settings: this.settings, items: this.items, receipts: this.receipts })); return this.writes; }
  close() { this.desktop = null; return this.save(); }
}
