import { randomUUID } from 'node:crypto';

// No desktop, pixel capture, text, scripts, selectors or file paths are accepted.
// The first-party renderer answers one expiring, origin-bound layout request.
export class UiInspection {
  constructor({ thread, selected, broadcast, now = Date.now }) { Object.assign(this, { thread, selected, broadcast, now }); this.pending = new Map(); }
  inspect(threadId) {
    if (!threadId || threadId !== this.selected() || !this.thread(threadId).allowUiInspection) throw new Error('Enable layout inspection for the selected conversation in Settings. Other windows and conversations are never inspected.');
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('The visible Alpha renderer did not respond. No UI evidence is available.')); }, 5000);
      this.pending.set(id, { threadId, resolve, reject, timer, at: this.now() });
      this.broadcast('ui-inspection-request', { inspectionId: id, threadId });
    });
  }
  accept(value) {
    const request = this.pending.get(value?.inspectionId);
    if (!request) throw new Error('Inspection request expired or was already answered.');
    if (request.threadId !== value.threadId || this.selected() !== request.threadId || !this.thread(request.threadId).allowUiInspection) throw new Error('Inspection authorization changed.');
    if (value.unavailable) { this.finish(value.inspectionId, new Error('Alpha is hidden or a sensitive dialog is open. No capture was made.')); return { accepted: false }; }
    const number = n => Number.isFinite(n) && Math.abs(n) <= 50000;
    if (!number(value.width) || !number(value.height) || value.width < 1 || value.height < 1 || !Array.isArray(value.regions) || value.regions.length > 8) throw new Error('Invalid rendered layout evidence.');
    const allowed = new Set(['topbar', 'conversation', 'messages', 'composer', 'viewer', 'statusbar', 'questions']);
    const regions = value.regions.map(region => {
      if (!allowed.has(region.kind) || !['x', 'y', 'width', 'height'].every(key => number(region[key]))) throw new Error('Invalid rendered region.');
      return { kind: region.kind, x: region.x, y: region.y, width: region.width, height: region.height, scrollHeight: number(region.scrollHeight) ? region.scrollHeight : null, visible: region.visible === true };
    });
    this.finish(value.inspectionId, null, { source: 'Visible Alpha first-party renderer', evidenceId: value.inspectionId, threadId: request.threadId, capturedAt: new Date(this.now()).toISOString(), kind: 'rendered-layout', width: value.width, height: value.height, regions, redaction: 'No message text, inputs, titles, settings, screenshots, desktop data or other-thread contents collected.' });
    return { accepted: true };
  }
  finish(id, error, value) { const request = this.pending.get(id); if (!request) return; clearTimeout(request.timer); this.pending.delete(id); if (error) request.reject(error); else request.resolve(value); }
  close() { for (const id of this.pending.keys()) this.finish(id, new Error('Inspection ended.')); }
}
