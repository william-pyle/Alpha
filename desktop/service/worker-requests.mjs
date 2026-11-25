import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { saveJson, secret } from './util.mjs';

const uuid = value => typeof value === 'string' && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value);
const requestKey = value => typeof value === 'string' && /^[\w-]{1,64}$/.test(value);
const fail = (status, message) => Object.assign(new Error(message), { status });
const lifetime = 7 * 24 * 60 * 60_000;
const statuses = new Set(['pending', 'closed', 'stale', 'denied', 'unavailable', 'unconfirmed']);
const actions = new Set(['close-preview', 'stop-terminal']);
const messages = {
  pending: 'Alpha accepted the request and is checking the exact Help preview.',
  closed: 'Alpha closed the requested Help preview.',
  stale: 'That exact Help preview is no longer eligible. Find the current target before requesting it again.',
  denied: 'Terminal stops and interrupts are unavailable through worker requests. Only the owner can use the existing terminal controls.',
  unavailable: 'Alpha could not send this request to an eligible Workspace view.',
  unconfirmed: 'Alpha could not confirm the tab closure. Check the current preview before making a new request.',
};
const sameOrigin = (a, b) => a && b && a.sessionId === b.sessionId && a.threadId === b.threadId && a.projectId === b.projectId && a.nativeId === b.nativeId;
const sameTask = (a, b) => sameOrigin(a, b) && a.taskId === b.taskId && a.nativeTaskId === b.nativeTaskId;
const shape = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

export class WorkerRequests {
  constructor({ stateDir, resolveOrigin, send, clock = Date.now }) {
    Object.assign(this, { resolveOrigin, send, clock });
    this.file = path.join(stateDir, 'worker-requests.json');
    this.grants = new Map();
    this.views = new Map();
    this.records = new Map();
    this.dispatched = new Map();
    this.persisting = new Map();
  }

  async init() {
    try {
      const raw = await readFile(this.file, 'utf8').catch(error => { if (error.code === 'ENOENT') return '[]'; throw error; });
      const records = JSON.parse(raw);
      if (!Array.isArray(records) || records.length > 512 || records.some(item => !uuid(item?.id) || !uuid(item.targetId) ||
          !requestKey(item.key) || !statuses.has(item.status) || !actions.has(item.action) || !Number.isFinite(item.at) || !item.origin ||
          ['sessionId', 'threadId', 'projectId', 'nativeId', 'taskId', 'nativeTaskId'].some(key => typeof item.origin[key] !== 'string'))) {
        throw new Error('Invalid worker request ledger.');
      }
      for (const record of records) if (this.clock() - record.at < lifetime) {
        this.records.set(record.id, { ...record, status: record.status === 'pending' ? 'unconfirmed' : record.status });
      }
      if (records.some(record => record.status === 'pending')) await this.save();
    } catch {
      // Preserve an unreadable ledger and avoid losing deduplication on disk.
      this.disabled = true;
    }
    return this;
  }

  issue(session) {
    if (this.closed || this.disabled || session.agent !== 'codex') return null;
    const token = secret();
    const grant = { session, process: null, calls: 0, retryAt: 0 };
    return {
      token,
      attach: process => { grant.process = process; this.grants.set(token, grant); },
      revoke: () => { grant.process = null; this.grants.delete(token); },
    };
  }

  live(grant) { return grant?.process && grant.session.process === grant.process && !this.closed && !this.disabled; }

  async origin(grant, requireTask) {
    const origin = await this.resolveOrigin(grant.session, requireTask);
    return this.live(grant) ? origin : null;
  }

  authenticate(header) {
    const match = /^Bearer ([\w-]{43})$/.exec(header || '');
    const grant = match && this.grants.get(match[1]);
    if (!this.live(grant)) throw fail(401, 'This managed worker session is unavailable.');
    const now = this.clock();
    if (now >= grant.retryAt) { grant.calls = 0; grant.retryAt = now + 60_000; }
    if (++grant.calls > 40) throw fail(429, 'Wait before sending more Alpha requests.');
    return grant;
  }

  inventory(view, targets) {
    if (!Array.isArray(targets) || targets.length > 1 || targets.some(item => !shape(item, ['id']) || !uuid(item.id))) return;
    this.views.set(view, new Set(targets.map(item => item.id)));
  }

  target(id) {
    const matches = [...this.views].filter(([, targets]) => targets.has(id));
    return matches.length === 1 ? matches[0][0] : null;
  }

  receipt(record) {
    return { receiptId: record.id, action: record.action, targetId: record.targetId, status: record.status, message: messages[record.status] };
  }

  async readReceipt(record) {
    try { await this.persisting.get(record.id); }
    catch { throw fail(503, 'Alpha could not save the receipt. Check the current preview.'); }
    return this.receipt(record);
  }

  async handle(grant, data) {
    if (!this.live(grant)) throw fail(401, 'This managed worker session is unavailable.');
    if (data?.kind === 'result' && shape(data, ['kind', 'receiptId']) && uuid(data.receiptId)) {
      const record = this.records.get(data.receiptId);
      if (!record || this.clock() - record.at >= lifetime || !sameOrigin(record.origin, await this.origin(grant))) throw fail(404, 'This worker has no such receipt.');
      return this.readReceipt(record);
    }
    const listing = data?.kind === 'targets' && shape(data, ['kind']);
    if (!listing && (data?.kind !== 'request' || !shape(data, ['kind', 'requestKey', 'action', 'targetId']) ||
        !requestKey(data.requestKey) || !actions.has(data.action) || !uuid(data.targetId))) throw fail(400, 'Use a supported Alpha request with an exact target ID.');
    const origin = await this.origin(grant, true);
    if (!origin) throw fail(409, 'Alpha has not verified an active Codex task for this session.');
    if (listing) return { targets: [...new Set([...this.views.values()].flatMap(ids => [...ids]))]
      .filter(id => this.target(id)).slice(0, 8).map(id => ({ id, title: 'Help', effect: 'Close the disposable Alpha Help preview' })) };

    const now = this.clock();
    for (const [id, record] of this.records) if (record.status !== 'pending' && now - record.at >= lifetime) this.records.delete(id);
    const task = [...this.records.values()].filter(record => sameTask(record.origin, origin));
    const duplicate = task.find(record => record.key === data.requestKey);
    if (duplicate) {
      if (duplicate.action !== data.action || duplicate.targetId !== data.targetId) throw fail(409, 'This request key already belongs to a different request.');
      return this.readReceipt(duplicate);
    }
    if (task.length >= 4 || this.records.size >= 512 || this.dispatched.size >= 8) throw fail(429, 'Alpha’s worker request limit was reached.');
    const view = data.action === 'close-preview' && this.target(data.targetId);
    const status = data.action === 'stop-terminal' ? 'denied' : view ? 'pending' : 'stale';
    const record = { id: randomUUID(), key: data.requestKey, action: data.action, targetId: data.targetId, origin, status, at: now };
    this.records.set(record.id, record);
    try { await this.persist(record); }
    catch { this.records.delete(record.id); throw fail(503, 'Alpha could not save the request. No action was sent.'); }
    if (status !== 'pending') return this.receipt(record);
    if (!sameTask(origin, await this.origin(grant, true))) {
      await this.finish(record, 'unavailable');
    } else if (view !== this.target(record.targetId)) {
      await this.finish(record, 'stale');
    } else if ([...this.dispatched.values()].some(active => active.record.targetId === record.targetId)) {
      await this.finish(record, 'unavailable');
    } else {
      const expiresAt = this.clock() + 6000;
      const timer = setTimeout(() => void this.finish(record, 'unconfirmed').catch(() => {}), 6000);
      timer.unref();
      this.dispatched.set(record.id, { record, view, expiresAt, timer });
      let sent;
      try { sent = this.send(view, { requestId: record.id, targetId: record.targetId, expiresAt }); }
      catch { await this.finish(record, 'unconfirmed'); }
      if (sent === false) await this.finish(record, 'unavailable');
    }
    return this.readReceipt(record);
  }

  async acknowledge(view, { requestId, targetId, closed }) {
    const pending = this.dispatched.get(requestId);
    if (!pending || pending.view !== view || pending.record.targetId !== targetId || typeof closed !== 'boolean' || this.clock() >= pending.expiresAt) return;
    if (closed) this.views.get(view)?.delete(targetId);
    await this.finish(pending.record, closed ? 'closed' : 'stale');
  }

  async disconnect(view) {
    this.views.delete(view);
    await Promise.all([...this.dispatched.values()].filter(active => active.view === view).map(({ record }) => this.finish(record, 'unconfirmed')));
  }

  save() { return saveJson(this.file, [...this.records.values()]); }

  persist(record) {
    const write = this.save().finally(() => {
      if (this.persisting.get(record.id) === write) this.persisting.delete(record.id);
    });
    this.persisting.set(record.id, write);
    return write;
  }

  async finish(record, status) {
    clearTimeout(this.dispatched.get(record.id)?.timer);
    this.dispatched.delete(record.id);
    record.status = status;
    try { await this.persist(record); }
    catch { record.status = 'unconfirmed'; throw fail(503, 'Alpha could not save the action result. Check the current preview.'); }
  }

  async purge(threadId, sessionIds) {
    let changed = false;
    for (const [id, record] of this.records) if (record.origin.threadId === threadId || sessionIds.has(record.origin.sessionId)) {
      clearTimeout(this.dispatched.get(id)?.timer);
      this.dispatched.delete(id);
      this.records.delete(id);
      changed = true;
    }
    if (changed) await this.save();
  }

  async close() {
    this.closed = true;
    this.grants.clear();
    await Promise.all([...this.views.keys()].map(view => this.disconnect(view)));
  }
}
