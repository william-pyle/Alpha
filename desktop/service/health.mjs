import path from 'node:path';
import { readJson, saveJson } from './util.mjs';

export class Health {
  constructor(stateDir, changed = () => {}) { this.file = path.join(stateDir, 'health.json'); this.changed = changed; this.issues = []; this.samples = []; this.writes = Promise.resolve(); }
  async init() { const saved = await readJson(this.file, []); this.issues = Array.isArray(saved) ? saved : []; return this; }
  snapshot() { return { issues: this.issues, recentRequests: this.samples.slice(-40), slowRequests: this.samples.filter(item => item.slow).length }; }
  measure(route, durationMs, status) {
    if (!route.startsWith('/api/') || ['/api/health', '/api/bootstrap'].includes(route)) return;
    const name = route.replace(/[a-f\d]{8}-[a-f\d-]{27,}/gi, ':id');
    const limit = name === '/api/workspace/shared-drive-original/sync-run' ? 280_000 : /coordinator/.test(name) ? 45000 : /transcribe/.test(name) ? 30000 : 3000;
    const sample = { route: name.slice(0, 180), durationMs: Math.round(durationMs), status, slow: durationMs > limit, at: new Date().toISOString() };
    this.samples.push(sample); this.samples = this.samples.slice(-200);
    if (this.samples.filter(item => item.route === name && (item.slow || item.status >= 500)).length >= 3) void this.report({ id: `slow:${name}`, area: name, symptom: 'Repeated slow or failed requests', proposal: 'Inspect these request timings and failures. Fix the bottleneck; consider moving long work out of the request path if it blocks normal interaction.' }).catch(() => {});
  }
  async report({ id, area, symptom, proposal }) {
    if (![area, symptom, proposal].every(value => typeof value === 'string' && value.trim()) || area.length > 180 || symptom.length > 1000 || proposal.length > 2000) throw new Error('Describe the affected area, observed problem and a concrete next step.');
    const existing = this.issues.find(item => item.id === id && item.status === 'open');
    if (existing) return existing;
    const item = { id: id || `issue-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, area: area.trim(), symptom: symptom.trim(), proposal: proposal.trim(), status: 'open', createdAt: new Date().toISOString() };
    this.issues.push(item); this.issues = this.issues.slice(-80); await this.save(); this.changed(item); return item;
  }
  async resolve(id) {
    const issue = this.issues.findLast(item => item.id === id); if (!issue) throw new Error('Health issue was not found.');
    issue.status = 'resolved'; issue.resolvedAt = new Date().toISOString();
    this.samples = this.samples.filter(item => item.route !== issue.area);
    await this.save(); return issue;
  }
  save() { this.writes = this.writes.catch(() => {}).then(() => saveJson(this.file, this.issues)); return this.writes; }
  close() { return this.writes.catch(() => {}); }
}
