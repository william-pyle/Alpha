import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { saveJson, secret, sleep } from './util.mjs';

const uuid = value => typeof value === 'string' && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value);
const requestKey = value => typeof value === 'string' && /^[\w-]{1,64}$/.test(value);
const fail = (status, message) => Object.assign(new Error(message), { status });
const lifetime = 7 * 24 * 60 * 60_000;
const uiConfirmationMs = 15000;
const terminalStatuses = new Set(['applied', 'stale', 'denied', 'owner-denied', 'system-blocked', 'unavailable', 'unconfirmed', 'error']);
const statuses = new Set([...terminalStatuses, 'pending', 'pending-approval', 'closed']);
const legacyActions = new Set(['close-preview', 'stop-terminal']);
const uiActions = {
  'open-tab': ['project-launcher', 'help-launcher'],
  'activate-tab': ['project-tab', 'help-tab', 'workspace-tab'],
  'close-tab': ['project-tab', 'help-tab'],
  'set-3d-view': ['conversation-layout'],
  'set-message-panel': ['conversation-layout'],
};
const uiKinds = new Set(Object.values(uiActions).flat());
const messages = {
  pending: 'Alpha accepted the request and is checking the exact Help preview.',
  'pending-approval': 'This request is waiting for the owner in Questions.',
  applied: 'Alpha confirmed the requested change.',
  closed: 'Alpha closed the requested Help preview.',
  stale: 'That exact Help preview is no longer eligible. Find the current target before requesting it again.',
  denied: 'Terminal stops and interrupts are unavailable through worker requests. Only the owner can use the existing terminal controls.',
  'owner-denied': 'The owner denied this exact request in Questions.',
  'system-blocked': 'This request is blocked by the current system access boundary.',
  unavailable: 'Alpha could not send this request to an eligible Workspace view.',
  unconfirmed: 'Alpha could not confirm the tab closure. Check the current preview before making a new request.',
  error: 'Alpha could not complete this request. Review the current state before making a new request.',
};
const expandedMessages = {
  pending: 'Alpha accepted the request and is checking the exact target.',
  stale: 'The target or reviewed revision changed. Obtain current details before requesting again.',
  denied: 'This request is unavailable under the current project policy.',
  unavailable: 'Alpha cannot act on this target in the current session or Workspace view.',
  unconfirmed: 'Alpha could not confirm the effect. Check the current state before making a new request.',
};
const blockedAccess = {
  'os-permission': {
    message: 'The operating system refused access using the current Alpha session permissions.',
    nextStep: 'Ask the authorized system administrator to review access to this target, or use a target already available under the current permissions.',
  },
  policy: {
    message: 'The current project, sandbox, or host policy blocks this action.',
    nextStep: 'Check the project and action scope in Alpha. If the restriction is intentional, leave the request closed.',
  },
  'host-unavailable': {
    message: 'Alpha could not use the authorized host service to complete this request.',
    nextStep: 'Check the existing service or Workspace connection in Alpha before submitting a new request.',
  },
};
const accessOf = error => {
  if (error?.workerAccess) return error.workerAccess;
  const code = error?.code || error?.cause?.code;
  if (['EACCES', 'EPERM', 'EROFS', 'ERR_ACCESS_DENIED'].includes(code)) return 'os-permission';
  if (error?.status === 403) return 'policy';
  return null;
};
const artifactReasons = {
  'artifact-collision': 'The destination already has this artifact or a conflicting registration. Existing work was preserved.',
  'artifact-changed': 'The artifact or destination changed after review. Request a fresh review.',
  'artifact-destination': 'The artifact must come from a different eligible project.',
  'artifact-missing': 'The exact project artifact or native layout is unavailable.',
  'artifact-provenance': 'The source or destination project is excluded or its ownership or provenance could not be verified.',
  'artifact-reference': 'A required reference is missing, ambiguous, or outside the supported project mapping. Supply a portable local reference before requesting import again.',
  'artifact-unsupported': 'The artifact contains an unsupported format, protected content, or an unsafe dependency.',
  'artifact-unavailable': 'Alpha could not verify the artifact through the Windows file boundary.',
};
const artifactParseReasons = new Map([
  ['unsupported-format', 'artifact-unsupported'],
  ['unsafe-content', 'artifact-unsupported'],
  ['unresolved-reference', 'artifact-reference'],
]);
const sameOrigin = (a, b) => a && b && a.sessionId === b.sessionId && a.threadId === b.threadId && a.projectId === b.projectId && a.nativeId === b.nativeId;
const sameTask = (a, b) => sameOrigin(a, b) && a.taskId === b.taskId && a.nativeTaskId === b.nativeTaskId;
const shape = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 100 && value.trim() === value &&
  value !== '.' && value !== '..' && !/[\\/:?#\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const equalArguments = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
const exactEffect = (record, data) => record.action === data.action && record.targetId === data.targetId && equalArguments(record.arguments, data.arguments);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const supported = new Set(['codex']);

export class WorkerRequests {
  constructor({ stateDir, resolveOrigin, resolveApprovalOrigin, send, sendUI, validateUI, handlers = {}, askOwner, ownerDecisions = [], clock = Date.now, wait = sleep }) {
    Object.assign(this, { resolveOrigin, resolveApprovalOrigin, send, sendUI, validateUI, handlers, askOwner, ownerDecisions, clock, wait });
    this.file = path.join(stateDir, 'worker-requests.json');
    this.grants = new Map();
    this.views = new Map();
    this.uiViews = new Map();
    this.records = new Map();
    this.dispatched = new Map();
    this.persisting = new Map();
  }

  async init() {
    try {
      const raw = await readFile(this.file, 'utf8').catch(error => { if (error.code === 'ENOENT') return '[]'; throw error; });
      const records = JSON.parse(raw);
      if (!Array.isArray(records) || records.length > 512 || records.some(item => !uuid(item?.id) ||
          !requestKey(item.key) || !statuses.has(item.status) || !this.validAction(item.action, item.arguments, item.targetId) || !Number.isFinite(item.at) || !item.origin ||
          (item.status === 'pending-approval' && (!this.handlers[item.action] || typeof item.revision !== 'string' || !item.revision || item.revision.length > 1000)) ||
          ['sessionId', 'threadId', 'projectId', 'nativeId', 'taskId', 'nativeTaskId'].some(key => typeof item.origin[key] !== 'string'))) {
        throw new Error('Invalid worker request ledger.');
      }
      let recovered = false;
      for (const record of records) {
        const decision = this.ownerDecisions.find(question =>
          question.source === 'worker-approval' && question.status === 'answered' &&
          question.sourceId === record.id && question.sessionId === record.origin.sessionId && question.threadId === record.origin.threadId);
        if (decision?.answer === 'Deny this request' && record.status !== 'owner-denied') {
          record.status = 'owner-denied';
          recovered = true;
        } else if (record.status === 'pending' || record.status === 'pending-approval' && decision?.answer === 'Approve this request') {
          record.status = 'unconfirmed';
          recovered = true;
        }
        if (record.status === 'owner-denied' || this.clock() - record.at < lifetime) this.records.set(record.id, record);
      }
      if (recovered) await this.save();
    } catch {
      // Preserve an unreadable ledger and avoid losing deduplication on disk.
      this.disabled = true;
    }
    return this;
  }

  issue(session) {
    if (this.closed || this.disabled || !supported.has(session.agent)) return null;
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

  validAction(action, args, targetId) {
    if (legacyActions.has(action)) return args === undefined && uuid(targetId);
    if (Object.hasOwn(uiActions, action)) {
      return uuid(targetId) && (uiActions[action].includes('conversation-layout')
        ? shape(args, ['visible']) && typeof args.visible === 'boolean' : args === undefined);
    }
    const handler = Object.hasOwn(this.handlers, action) && this.handlers[action];
    if (!handler) return false;
    try { return handler.validate(action, args, targetId) !== false; }
    catch { return false; }
  }

  uiInventory(view, targets) {
    if (!Array.isArray(targets) || targets.length > 128) return;
    const ids = new Map();
    for (const target of targets) {
      if (!target || !uuid(target.id) || !uiKinds.has(target.kind) || ids.has(target.id) ||
          typeof target.label !== 'string' || target.label.length > 120) return;
      const descriptor = { id: target.id, kind: target.kind, label: target.label.replace(/[\p{Cc}\p{Cf}]/gu, ' ') };
      if (target.kind === 'conversation-layout' || target.kind === 'project-launcher' || target.kind === 'project-tab') {
        if (!identifier(target.projectId)) return;
        descriptor.projectId = target.projectId;
      }
      if (target.kind === 'project-launcher') {
        if (!Number.isSafeInteger(target.stepIndex) || target.stepIndex < 0) return;
        const binding = target.stepBinding;
        if (!binding || typeof binding.path !== 'string' || !binding.path || binding.path.length > 1200 ||
            (binding.id !== undefined && (typeof binding.id !== 'string' || binding.id.length > 140)) ||
            (binding.viewer !== undefined && !['card', 'compare3d'].includes(binding.viewer))) return;
        descriptor.stepIndex = target.stepIndex;
        descriptor.stepBinding = { path: binding.path, id: binding.id, viewer: binding.viewer };
      }
      if (target.kind === 'conversation-layout') {
        if (!uuid(target.threadId)) return;
        descriptor.threadId = target.threadId;
      }
      ids.set(target.id, descriptor);
    }
    if (ids.size) this.uiViews.set(view, ids);
    else this.uiViews.delete(view);
  }

  uiTarget(id, origin, action) {
    const matches = [...this.uiViews].filter(([, targets]) => targets.has(id));
    if (matches.length !== 1) return null;
    const [view, targets] = matches[0], target = targets.get(id);
    if (action && !uiActions[action].includes(target.kind)) return null;
    if (target.projectId && target.projectId !== origin.projectId || target.threadId && target.threadId !== origin.threadId) return null;
    return { view, target };
  }

  receipt(record) {
    const legacy = legacyActions.has(record.action);
    const receipt = { receiptId: record.id, action: record.action, status: record.status, message: (!legacy && expandedMessages[record.status]) || messages[record.status] };
    if (record.action === 'import-artifact' && typeof record.reason === 'string' && Object.hasOwn(artifactReasons, record.reason)) {
      receipt.reason = record.reason;
      receipt.message = artifactReasons[record.reason];
    }
    if (record.status === 'system-blocked') {
      const block = Object.hasOwn(blockedAccess, record.access) ? record.access : 'policy';
      receipt.access = block;
      receipt.message = record.reason ? receipt.message : blockedAccess[block].message;
      receipt.nextStep = blockedAccess[block].nextStep;
    }
    if (record.status === 'unconfirmed') receipt.nextStep = 'Inspect the target and confirm its current state before requesting any further action.';
    if (record.recovery) receipt.recovery = { ...record.recovery };
    if (record.targetId) receipt.targetId = record.targetId;
    if (record.result) receipt.result = record.result;
    return receipt;
  }

  async readReceipt(record) {
    try { await this.persisting.get(record.id); }
    catch { throw fail(503, 'Alpha could not save the receipt. Check the current target.'); }
    return this.receipt(record);
  }

  ownerReceipt(question) {
    if (this.disabled || question.source !== 'worker-approval' || question.status !== 'answered') return null;
    const record = this.records.get(question.sourceId);
    if (!record || record.origin.sessionId !== question.sessionId || record.origin.threadId !== question.threadId) return null;
    return this.receipt(record);
  }

  async handle(grant, data) {
    if (!this.live(grant)) throw fail(401, 'This managed worker session is unavailable.');
    if (data?.kind === 'result' && shape(data, ['kind', 'receiptId']) && uuid(data.receiptId)) {
      const record = this.records.get(data.receiptId);
      if (!record || record.status !== 'owner-denied' && this.clock() - record.at >= lifetime ||
          !sameOrigin(record.origin, await this.origin(grant))) throw fail(404, 'This worker has no such receipt.');
      return this.readReceipt(record);
    }
    const listing = data?.kind === 'targets' && shape(data, ['kind']);
    const capabilities = data?.kind === 'capabilities' && shape(data, ['kind']);
    const requestFields = ['kind', 'requestKey', 'action'];
    if (data && Object.hasOwn(data, 'targetId')) requestFields.push('targetId');
    if (data && Object.hasOwn(data, 'arguments')) requestFields.push('arguments');
    if (!listing && !capabilities && (data?.kind !== 'request' || !shape(data, requestFields) || !requestKey(data.requestKey) ||
        typeof data.action !== 'string' || !this.validAction(data.action, data.arguments, data.targetId))) {
      throw fail(400, 'Use a supported Alpha request with its exact typed arguments.');
    }
    const origin = await this.origin(grant, true);
    if (!origin) throw fail(409, 'Alpha has not verified an active managed task for this session.');
    if (listing) return { targets: [...new Set([...this.views.values()].flatMap(ids => [...ids]))]
      .filter(id => this.target(id)).slice(0, 8).map(id => ({ id, title: 'Help', effect: 'Close the disposable Alpha Help preview' })) };
    if (capabilities) {
      const views = [...new Set([...this.uiViews.values()].flatMap(targets => [...targets.keys()]))]
        .map(id => this.uiTarget(id, origin)?.target).filter(Boolean).slice(0, 64)
        .map(({ stepBinding, ...publicTarget }) => publicTarget);
      const groups = Object.values(this.handlers).filter((handler, index, all) => all.indexOf(handler) === index);
      const inventory = await Promise.all(groups.map(async handler => [handler.group, await Promise.resolve().then(() => handler.list(origin)).catch(() => [])]));
      if (!sameTask(origin, await this.origin(grant, true))) throw fail(409, 'The originating task changed while listing actions.');
      const response = { projectId: origin.projectId, views, ...Object.fromEntries(inventory) };
      // Keep the legacy MCP transport's response bound. Leave a signal when a
      // large project inventory was abbreviated.
      const sized = () => Buffer.byteLength(JSON.stringify(response));
      while (sized() > 15000) {
        const lists = [...Object.values(response), response.projects?.tabs].filter(value => Array.isArray(value) && value.length);
        if (!lists.length) throw fail(413, 'This capability inventory is too large.');
        lists.sort((a, b) => b.length - a.length)[0].pop();
        response.truncated = true;
      }
      return response;
    }

    const now = this.clock();
    for (const [id, record] of this.records) if (!['pending', 'owner-denied'].includes(record.status) && now - record.at >= lifetime) this.records.delete(id);
    const task = [...this.records.values()].filter(record => sameTask(record.origin, origin));
    const duplicate = task.find(record => record.key === data.requestKey);
    if (duplicate) {
      if (duplicate.action !== data.action || duplicate.targetId !== data.targetId || !equalArguments(duplicate.arguments, data.arguments)) throw fail(409, 'This request key already belongs to a different request.');
      return this.readReceipt(duplicate);
    }
    const held = this.heldEffect(origin, data);
    if (held && sameOrigin(held.origin, origin)) return this.readReceipt(held);
    if (task.length >= 4 || this.records.size >= 512 || this.dispatched.size >= 8) throw fail(429, 'Alpha’s worker request limit was reached.');
    const view = data.action === 'close-preview' && this.target(data.targetId);
    const status = data.action === 'stop-terminal' ? 'denied' : data.action === 'close-preview' && !view ? 'stale' : 'pending';
    const record = { id: randomUUID(), key: data.requestKey, action: data.action, targetId: data.targetId, arguments: data.arguments, origin, status, at: now };
    this.records.set(record.id, record);
    try { await this.persist(record); }
    catch { this.records.delete(record.id); throw fail(503, 'Alpha could not save the request. No action was sent.'); }
    if (status !== 'pending') return this.receipt(record);
    if (held) {
      await this.finish(record, held.status);
      return this.readReceipt(record);
    }
    if (!legacyActions.has(record.action)) {
      await this.dispatchExpanded(record, grant);
      return this.readReceipt(record);
    }
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

  heldEffect(origin, data) {
    return [...this.records.values()].find(record => ['owner-denied', 'unconfirmed'].includes(record.status) &&
      record.origin.projectId === origin.projectId && record.action === data.action &&
      (exactEffect(record, data) || digest(data.intent) && record.intent === data.intent));
  }

  async withRecovery(record, stillAuthorized, action) {
    try { return await action(); }
    catch (error) {
      if (accessOf(error) !== 'recoverable-host' || error.noEffect !== true || record.recovery || !await stillAuthorized()) throw error;
      record.recovery = { attempts: 1, status: 'not-recovered' };
      await this.persist(record);
      // Let the existing host drain a transient request, then let the same
      // handler resolve and validate the same target under the original grant.
      await this.wait(120);
      if (!await stillAuthorized()) throw fail(409, 'The originating grant or target is stale.');
      const result = await action();
      if (!terminalStatuses.has(result?.status) || result.status === 'applied') record.recovery.status = 'recovered';
      return result;
    }
  }

  async dispatchExpanded(record, grant) {
    try {
      const current = () => this.origin(grant, true);
      const stillAuthorized = async () => sameTask(record.origin, await current()) &&
        !this.closed && this.records.get(record.id) === record && record.status === 'pending';
      if (!await stillAuthorized()) return await this.finish(record, 'unavailable');
      if (Object.hasOwn(uiActions, record.action)) return await this.dispatchUI(record, current);

      const handler = this.handlers[record.action];
      const prepare = async () => {
        const actionArgs = [record.origin, record.action, record.arguments, record.targetId];
        const resolved = await handler.resolveIntent?.(...actionArgs);
        const intent = digest(resolved) ? resolved : this.intent(record);
        if (record.intent && record.intent !== intent) throw fail(409, 'The exact target changed before recovery.');
        record.intent = intent;
        const held = this.heldEffect(record.origin, record);
        if (held) return { status: held.status };
        return handler.prepare(...actionArgs);
      };
      const checked = await this.withRecovery(record, stillAuthorized, prepare);
      if (!await stillAuthorized()) return await this.finish(record, 'unavailable');
      if (terminalStatuses.has(checked.status)) return await this.finishOutcome(record, checked.status);
      record.revision = checked.revision;
      if (digest(checked.intent)) record.intent = checked.intent;
      const held = this.heldEffect(record.origin, record);
      if (held) return await this.finish(record, held.status);
      if (checked.approval) {
        if (typeof checked.revision !== 'string' || !checked.revision || checked.revision.length > 1000 || !this.askOwner) return await this.finish(record, 'unavailable');
        const waiting = [...this.records.values()].filter(item => item.status === 'pending-approval');
        const projectWaiting = waiting.filter(item => item.origin.projectId === record.origin.projectId);
        if (waiting.length >= 24 || projectWaiting.length >= 4 || projectWaiting.some(item =>
          item.action === record.action && (exactEffect(item, record) || item.intent === record.intent))) {
          return await this.finish(record, 'unavailable');
        }
        await this.finish(record, 'pending-approval');
        await this.askOwner(record, checked.review);
        return;
      }
      await this.applyExpanded(record, false, current);
    } catch (error) {
      await this.finishFailure(record, error);
    }
  }

  intent(record) {
    const args = record.arguments;
    const effect = record.action === 'run-script' ? { scriptId: args.scriptId } : args;
    return createHash('sha256').update(JSON.stringify(canonical([record.action, record.targetId, effect]))).digest('hex');
  }

  async dispatchUI(record, current) {
    const entry = this.uiTarget(record.targetId, record.origin, record.action);
    if (!entry) return this.finish(record, 'stale');
    if (!this.validateUI || !await this.validateUI(entry.target, record.origin)) return this.finish(record, 'stale');
    const liveOrigin = await current();
    const latest = this.uiTarget(record.targetId, liveOrigin || record.origin, record.action);
    if (!sameTask(record.origin, liveOrigin) || latest?.view !== entry.view || !equalArguments(latest?.target, entry.target) ||
        this.dispatched.size >= 8 || [...this.dispatched.values()].some(active => active.record.targetId === record.targetId)) {
      return this.finish(record, 'unavailable');
    }
    const expiresAt = this.clock() + uiConfirmationMs;
    const timer = setTimeout(() => void this.finish(record, 'unconfirmed').catch(() => {}), uiConfirmationMs);
    timer.unref();
    this.dispatched.set(record.id, { record, view: entry.view, expiresAt, timer });
    let sent;
    try { sent = this.sendUI?.(entry.view, { requestId: record.id, targetId: record.targetId, action: record.action, arguments: record.arguments, expiresAt }); }
    catch { return this.finish(record, 'unconfirmed'); }
    if (!sent) await this.finishOutcome(record, 'system-blocked', 'host-unavailable');
  }

  approval(question, answer) {
    if (question.source !== 'worker-approval' || !['Approve this request', 'Deny this request'].includes(answer)) throw fail(400, 'Choose Approve this request or Deny this request.');
    const record = this.records.get(question.sourceId);
    if (!record || record.status !== 'pending-approval' || record.origin.threadId !== question.threadId || record.origin.sessionId !== question.sessionId) return;
    return async () => {
      if (record.status !== 'pending-approval') return this.receipt(record);
      if (answer === 'Deny this request') {
        await this.finish(record, 'owner-denied');
        return this.receipt(record);
      }
      try {
        if (this.clock() - record.at >= lifetime || !sameOrigin(record.origin, await this.resolveApprovalOrigin?.(record.origin))) {
          await this.finish(record, 'stale');
          return this.receipt(record);
        }
        if (record.status !== 'pending-approval' || this.records.get(record.id) !== record) return this.receipt(record);
        await this.finish(record, 'pending');
        // A durable owner answer and the ledger transition both precede any effect.
        await this.applyExpanded(record, true);
      } catch (error) {
        await this.finishFailure(record, error);
      }
      return this.receipt(record);
    };
  }

  async applyExpanded(record, approved, current) {
    try {
      const handler = this.handlers[record.action];
      const stillAuthorized = async () => {
        const match = approved
          ? sameOrigin(record.origin, await this.resolveApprovalOrigin?.(record.origin))
          : sameTask(record.origin, await current());
        return match && !this.closed && this.records.get(record.id) === record && record.status === 'pending';
      };
      if (!await stillAuthorized()) {
        if (this.records.get(record.id) === record) return this.finish(record, 'stale');
        return;
      }
      const result = await this.withRecovery(record, stillAuthorized, () => {
        const held = this.heldEffect(record.origin, record);
        if (held) return { status: held.status };
        return handler.apply(record.origin, record.action, record.arguments, {
          approved, revision: record.revision, targetId: record.targetId, stillAuthorized,
        });
      });
      if (result?.projectId && identifier(result.projectId)) {
        record.result = { projectId: result.projectId };
        if (typeof result.tabId === 'string' && /^[\w-]{1,120}$/.test(result.tabId)) record.result.tabId = result.tabId;
        if (Number.isSafeInteger(result.stepIndex) && result.stepIndex >= 0) record.result.stepIndex = result.stepIndex;
        if (record.action === 'import-artifact' && result.projectId === record.origin.projectId) {
          record.result.sourceProjectId = record.arguments.sourceProjectId;
          record.result.artifactKind = record.arguments.kind;
          record.result.artifactId = record.arguments.artifactId;
        }
      }
      const status = result?.status ?? (record.result ? 'applied' : 'error');
      await this.finishOutcome(record, terminalStatuses.has(status) ? status : 'error', result?.workerAccess);
    } catch (error) {
      await this.finishFailure(record, error);
    }
  }

  finishOutcome(record, status, access) {
    if (status === 'denied' || status === 'system-blocked') {
      record.access = Object.hasOwn(blockedAccess, access) ? access : 'policy';
      return this.finish(record, 'system-blocked');
    }
    return this.finish(record, status);
  }

  failureStatus(error) {
    return [404, 409, 412].includes(error?.status) ? 'stale' : error?.status === 503 ? 'unavailable' : 'error';
  }

  finishFailure(record, error) {
    if (record.action === 'import-artifact') {
      const reason = error?.workerReason || artifactParseReasons.get(error?.code);
      if (typeof reason === 'string' && Object.hasOwn(artifactReasons, reason)) record.reason = reason;
      if (error?.status === 422) return this.finishOutcome(record, 'system-blocked', 'policy');
    }
    const access = accessOf(error);
    if (access === 'unknown-outcome') return this.finish(record, 'unconfirmed');
    if (access === 'recoverable-host') return this.finishOutcome(record, 'system-blocked', 'host-unavailable');
    if (Object.hasOwn(blockedAccess, access)) return this.finishOutcome(record, 'system-blocked', access);
    return this.finish(record, this.failureStatus(error));
  }

  async acknowledge(view, { requestId, targetId, closed }) {
    const pending = this.dispatched.get(requestId);
    if (!pending || pending.record.action !== 'close-preview' || pending.view !== view || pending.record.targetId !== targetId || typeof closed !== 'boolean' || this.clock() >= pending.expiresAt) return;
    if (closed) this.views.get(view)?.delete(targetId);
    await this.finish(pending.record, closed ? 'closed' : 'stale');
  }

  async acknowledgeUI(view, { requestId, targetId, status }) {
    const pending = this.dispatched.get(requestId);
    if (!pending || !Object.hasOwn(uiActions, pending.record.action) || pending.view !== view || pending.record.targetId !== targetId ||
        !['applied', 'stale', 'unavailable', 'unconfirmed'].includes(status) || this.clock() >= pending.expiresAt) return;
    await this.finish(pending.record, status);
  }

  async disconnect(view) {
    this.views.delete(view);
    this.uiViews.delete(view);
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
    if (record.status === 'owner-denied' && status !== 'owner-denied') return;
    clearTimeout(this.dispatched.get(record.id)?.timer);
    this.dispatched.delete(record.id);
    record.status = status;
    try { await this.persist(record); }
    catch {
      if (status !== 'owner-denied') record.status = 'unconfirmed';
      throw Object.assign(fail(503, 'Alpha could not save the action result. Check the current receipt.'), { workerAccess: 'unknown-outcome' });
    }
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
    const views = new Set([...this.views.keys(), ...this.uiViews.keys(), ...[...this.dispatched.values()].map(entry => entry.view)]);
    await Promise.all([...views].map(view => this.disconnect(view)));
  }
}
