import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJson, saveJson } from './util.mjs';
import { taskTitle } from './titles.mjs';

const invalid = message => Object.assign(new Error(message), { status: 400 });
const now = () => new Date().toISOString();

// Alpha identity is separate from provider identity. Existing provider records
// and transcripts remain authoritative and are never rewritten by migration.
export class Threads {
  constructor(stateDir, changed = () => {}, failed = () => {}) {
    this.file = path.join(stateDir, 'threads.json'); this.changed = changed; this.failed = failed;
    this.items = []; this.selectedId = null; this.writes = Promise.resolve();
  }
  async init(sessions = [], replies = [], selectedId = null) {
    const saved = await readJson(this.file, null);
    this.items = saved?.threads || []; this.selectedId = saved?.selectedId || null;
    this.migration = saved?.migration || { at: now(), bindings: sessions.map(({ id, nativeId }) => ({ sessionId: id, nativeId: nativeId || null })), originalsPreserved: true };
    for (const item of this.items) {
      if (item.kind === 'alpha' && ['working', 'connecting'].includes(item.status)) item.status = 'interrupted';
      if (item.kind === 'alpha' && item.operation && !['completed', 'failed', 'waiting-for-user', 'interrupted'].includes(item.operation.phase)) { item.operation.phase = 'interrupted'; item.status = 'interrupted'; }
      for (const message of item.messages) if (message.status === 'dispatching' || item.kind === 'alpha' && message.status === 'dispatched' && !item.messages.some(reply => reply.operationId === message.id)) {
        message.status = 'interrupted'; message.error = 'The app restarted before this request was confirmed. Inspect Work details before deciding whether to resend.';
      }
    }
    for (const session of sessions) this.observe(session, false);
    for (const reply of replies) {
      const owner = this.owner(reply.sessionId);
      if (owner) this.message(owner.id, { id: `reply:${reply.id}`, role: 'assistant', text: reply.text, at: reply.at, sessionId: reply.sessionId }, false);
    }
    this.selectedId ||= this.owner(selectedId)?.id || this.items.find(item => !item.archived)?.id || null;
    await this.save(); return this;
  }
  get(id) { const item = this.items.find(item => item.id === id); if (!item) throw Object.assign(new Error('Conversation was not found.'), { status: 404 }); return item; }
  owner(sessionId) { return this.items.find(item => item.sessionIds.includes(sessionId)); }
  snapshot() { return { threads: this.items.map(item => ({ ...item, draft: item.id === this.selectedId ? item.draft : undefined, messageCount: item.messages.length, messages: item.id === this.selectedId ? item.messages.slice(-100) : [] })), selectedThreadId: this.selectedId }; }
  directory() { return this.items.map(({ id, name, purpose, projectId, status, updatedAt, unread, archived }) => ({ id, name, purpose, projectId, status, updatedAt, unread, archived })); }
  review() { return this.directory().map(item => { const reasons = []; try { taskTitle(item.name); } catch { reasons.push('Choose a descriptive title'); } if (!item.purpose) reasons.push('Add a purpose'); if (!item.projectId) reasons.push('Choose a project'); return { ...item, reasons }; }).filter(item => item.reasons.length); }
  create({ name, purpose = '', projectId = null } = {}) {
    if (this.items.filter(item => !item.archived).length >= 80) throw invalid('Archive a conversation before opening another.');
    const title = taskTitle(name || String(purpose).trim().split(/[.!?\n]/)[0].split(/\s+/).slice(0, 8).join(' '));
    const item = { id: randomUUID(), kind: 'alpha', name: title, purpose: String(purpose).trim().slice(0, 240), projectId, projectPending: !projectId, sessionIds: [], messages: [], status: 'idle', archived: false, unread: false, createdAt: now(), updatedAt: now() };
    this.items.push(item); this.publish(); return item;
  }
  observe(session, publish = true) {
    let created = false;
    let item = this.owner(session.id);
    if (!item && session.alphaThreadId) item = this.items.find(item => item.id === session.alphaThreadId);
    if (!item) {
      item = { id: session.id, kind: 'native', name: session.name, purpose: '', projectId: session.projectId || null, projectPending: !!session.projectPending, sessionIds: [session.id], messages: [], status: session.activity || session.status, archived: !session.open, unread: !!session.unread, createdAt: session.createdAt || now(), updatedAt: session.updatedAt || now() };
      this.items.push(item);
      created = true;
    }
    if (!item.sessionIds.includes(session.id)) item.sessionIds.push(session.id);
    const before = JSON.stringify([item.name, item.projectId, item.projectPending, item.status, item.archived, item.unread]);
    if (item.kind === 'native') Object.assign(item, { name: session.name, projectId: session.projectId || null, projectPending: !!session.projectPending, archived: item.archived || !session.open });
    item.status = session.status === 'running' ? session.activity : session.status;
    item.unread ||= !!session.unread;
    if (publish && (created || before !== JSON.stringify([item.name, item.projectId, item.projectPending, item.status, item.archived, item.unread]))) { item.updatedAt = now(); this.publish(); }
    return item;
  }
  select(id) { const item = this.get(id); this.selectedId = id; item.unread = false; this.publish(); return item; }
  message(id, message, publish = true) {
    const item = this.get(id);
    if (item.messages.some(existing => existing.id === message.id)) return false;
    item.messages.push({ ...message, at: message.at || now() }); item.updatedAt = now();
    if (message.role === 'assistant') item.unread = this.selectedId !== id;
    if (publish) this.publish(); return true;
  }
  search(id, query, offset = 0) {
    const needle = String(query || '').trim().toLocaleLowerCase().slice(0, 500);
    const matches = needle ? this.get(id).messages.flatMap(message => {
      const at = message.text.toLocaleLowerCase().indexOf(needle);
      return at < 0 ? [] : [{ id: message.id, role: message.role, excerpt: message.text.slice(Math.max(0, at - 60), at + needle.length + 140) }];
    }) : [];
    const start = Number.isSafeInteger(offset) ? Math.max(0, offset) : 0;
    return { matches: matches.slice(start, start + 50), total: matches.length };
  }
  history(id, offset = 0) { return this.get(id).messages.slice(Math.max(0, offset), Math.max(0, offset) + 50); }
  share(sourceId, destinationId, messageId, transferId) {
    if (sourceId === destinationId) throw invalid('Choose a different conversation.');
    if (!/^[\w-]{1,100}$/.test(transferId || '')) throw invalid('A transfer ID is required.');
    const source = this.get(sourceId), destination = this.get(destinationId);
    const message = source.messages.find(item => item.id === messageId);
    if (!message || message.text.length > 15000) throw invalid('Choose one message of at most 15,000 characters.');
    this.message(destination.id, { id: `share:${transferId}`, role: 'user', source: 'shared', sourceThreadId: sourceId, sourceMessageId: messageId, text: `Reference explicitly shared from ${source.name}:\n${message.text}` });
    return { shared: true, destinationId, messageId };
  }
  voice(id, sessionId, captions) {
    const thread = this.get(id);
    for (const caption of captions) {
      const key = `voice:${sessionId}:${caption.role}:${caption.start}`;
      const existing = thread.messages.find(item => item.id === key);
      if (existing) existing.text = caption.text;
      else this.message(id, { id: key, role: caption.role, text: caption.text, source: 'voice' }, false);
    }
    this.publish();
  }
  context(id) { const item = this.get(id); return { thread: { id, name: item.name, projectId: item.projectId, purpose: item.purpose }, recentConversation: item.messages.slice(-30), otherThreads: this.directory().filter(other => other.id !== id) }; }
  assertSession(threadId, sessionId) { if (!this.get(threadId).sessionIds.includes(sessionId)) throw Object.assign(new Error('This worker belongs to another conversation. Switch to that conversation to work with it.'), { status: 403 }); }
  undoArchive(id, undoId) {
    const item = this.get(id), undo = item.archiveUndo;
    if (!undo || undo.id !== undoId || undo.revision !== item.organizationRevision) throw Object.assign(new Error('Conversation organization changed after this action; undo would overwrite newer edits.'), { status: 409 });
    item.archived = undo.before; item.organizationRevision = randomUUID(); delete item.archiveUndo;
    this.publish(); return item;
  }
  patch(id, data) {
    const item = this.get(id);
    const validatedName = typeof data.name === 'string' ? taskTitle(data.name) : null;
    const previousArchived = item.archived;
    item.organizationRevision = randomUUID();
    if (validatedName !== null) item.name = validatedName;
    if (typeof data.purpose === 'string') item.purpose = data.purpose.trim().slice(0, 240);
    if (typeof data.archived === 'boolean') {
      item.archived = data.archived;
      item.archiveUndo = { id: randomUUID(), before: previousArchived, revision: item.organizationRevision };
    }
    if (typeof data.allowUiInspection === 'boolean') item.allowUiInspection = data.allowUiInspection;
    if (typeof data.desktopContext === 'boolean') item.desktopContext = data.desktopContext;
    if (Object.hasOwn(data, 'projectId')) { item.projectId = data.projectId || null; item.projectPending = !item.projectId; }
    item.updatedAt = now(); this.publish(); return item;
  }
  publish() { this.changed(this.snapshot()); void this.save().catch(this.failed); }
  save() { this.writes = this.writes.catch(() => {}).then(() => saveJson(this.file, { schemaVersion: 1, migration: this.migration, selectedId: this.selectedId, threads: this.items })); return this.writes; }
  close() { return this.save(); }
}
