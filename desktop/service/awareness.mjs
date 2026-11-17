import path from 'node:path';
import { readJson, saveJson } from './util.mjs';

// Only explicit events enter this ledger. A quiet terminal is not a stall.
export class Awareness {
  constructor(stateDir, changed = () => {}, clock = Date.now) { this.file = path.join(stateDir, 'awareness.json'); this.changed = changed; this.clock = clock; this.items = []; this.settings = { enabled: true, quiet: false, desktop: false }; this.desktop = null; this.writes = Promise.resolve(); }
  async init() { const data = await readJson(this.file, {}); this.items = data.items || []; this.settings = { ...this.settings, ...data.settings }; return this; }
  snapshot() {
    if (this.desktop && this.clock() - this.desktop.at > 15000) this.desktop = null;
    return { settings: this.settings, items: this.items.filter(item => this.clock() - item.at < 30 * 86400000 && !item.dismissed && (!item.snoozeUntil || item.snoozeUntil <= this.clock())), desktop: this.desktop };
  }
  event({ id, threadId = null, kind, text, source, inference = false }) {
    if (!this.settings.enabled || this.items.some(item => item.id === id)) return;
    const last = this.items.findLast(item => item.threadId === threadId && item.kind === kind);
    if (inference && last && this.clock() - last.at < 30 * 60 * 1000) return;
    this.items.push({ id, threadId, kind, text, source, inference, at: this.clock(), dismissed: false, snoozeUntil: null });
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
  sample(application) {
    if (!this.settings.enabled || !this.settings.desktop) { this.desktop = null; return; }
    // The native host returns only an executable basename, never a title/path.
    const name = typeof application === 'string' && /^[\w .()-]{1,100}\.exe$/i.test(application) ? application : null;
    const safe = name && !/password|1password|bitwarden|keepass|credential/i.test(name) ? name : null;
    this.desktop = safe ? { application: safe, source: 'Windows foreground application name', at: this.clock() } : null;
    this.changed(this.snapshot());
  }
  publish() { this.changed(this.snapshot()); void this.save().catch(() => {}); }
  save() { this.writes = this.writes.catch(() => {}).then(() => saveJson(this.file, { schemaVersion: 1, settings: this.settings, items: this.items })); return this.writes; }
  close() { this.desktop = null; return this.save(); }
}
