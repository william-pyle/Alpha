import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkerRequests } from '../worker-requests.mjs';

async function fixture(t, options) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'alpha-worker-requests-'));
  const sent = [], stores = [];
  const open = async () => {
    const store = await new WorkerRequests({ stateDir, resolveOrigin: (session, active) => (!active || session.active) && { ...session.origin },
      send: (view, payload) => { sent.push({ view, ...payload }); return true; }, ...options }).init();
    stores.push(store);
    return store;
  };
  t.after(async () => {
    for (const store of stores.reverse()) await store.close();
    await rm(stateDir, { recursive: true, force: true });
  });
  const session = { agent: 'codex', active: true, process: {}, origin: {
    sessionId: randomUUID(), threadId: randomUUID(), nativeId: randomUUID(), projectId: 'conversations', taskId: 'fixture-task', nativeTaskId: 'fixture-turn',
  } };
  const connect = (store, value = session) => {
    const { token, attach, revoke } = store.issue(value);
    attach(value.process);
    return { token, revoke, request: data => store.handle(store.authenticate(`Bearer ${token}`), data) };
  };
  return { stateDir, open, sent, session, connect };
}

test('a closure is recorded only by the exact target view and a receipt survives host reload', async t => {
  const f = await fixture(t), store = await f.open(), first = f.connect(store);
  const view = {}, other = {}, targetId = randomUUID();
  store.inventory(view, [{ id: targetId }]);
  const data = { kind: 'request', requestKey: 'fixture-close', targetId, action: 'close-preview' };
  const [receipt, duplicate] = await Promise.all([first.request(data), first.request(data)]);
  assert.equal(receipt.status, 'pending');
  assert.equal(duplicate.receiptId, receipt.receiptId);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].view, view);
  const read = { kind: 'result', receiptId: receipt.receiptId };
  await store.acknowledge(other, { requestId: receipt.receiptId, targetId, closed: true });
  await store.acknowledge(view, { requestId: receipt.receiptId, targetId: randomUUID(), closed: true });
  assert.equal((await first.request(read)).status, 'pending');
  await store.acknowledge(view, { requestId: receipt.receiptId, targetId, closed: true });
  assert.equal((await first.request(read)).status, 'closed');
  const saved = await readFile(path.join(f.stateDir, 'worker-requests.json'), 'utf8');
  assert.doesNotMatch(saved, new RegExp(first.token));
  assert.equal(JSON.parse(saved)[0].origin.nativeTaskId, 'fixture-turn');
  assert.equal(JSON.parse(saved)[0].status, 'closed');

  await store.close();
  const restarted = await f.open();
  const replacement = f.connect(restarted);
  assert.throws(() => restarted.authenticate(`Bearer ${first.token}`), { status: 401 });
  f.session.origin.nativeTaskId = 'next-native-turn'; f.session.active = false;
  assert.equal((await replacement.request(read)).status, 'closed');
  f.session.origin.threadId = randomUUID();
  await assert.rejects(replacement.request(read), { status: 404 });
  assert.equal(f.sent.length, 1);
});

test('pending work is never replayed after restart and an origin change before dispatch blocks execution', async t => {
  const f = await fixture(t), store = await f.open(), worker = f.connect(store);
  const view = {}, targetId = randomUUID();
  store.inventory(view, [{ id: targetId }]);
  const data = { kind: 'request', requestKey: 'first', targetId, action: 'close-preview' };
  const request = worker.request(data);
  f.session.active = false;
  assert.equal((await request).status, 'unavailable');
  assert.equal(f.sent.length, 0);
  f.session.active = true;
  const receipt = await worker.request({ ...data, requestKey: 'second' });
  assert.equal(receipt.status, 'pending');
  assert.equal(f.sent.length, 1);

  const restored = await f.open();
  restored.inventory(view, [{ id: targetId }]);
  const resumed = f.connect(restored);
  const result = { kind: 'result', receiptId: receipt.receiptId };
  assert.equal((await resumed.request(result)).status, 'unconfirmed');
  assert.equal((await resumed.request({ ...data, requestKey: 'second' })).status, 'unconfirmed');
  assert.equal(f.sent.length, 1);
});

test('unreadable request state fails closed and is preserved', async t => {
  const f = await fixture(t), file = path.join(f.stateDir, 'worker-requests.json');
  await writeFile(file, 'incomplete data');
  const store = await f.open();
  assert.equal(store.issue(f.session), null);
  assert.equal(await readFile(file, 'utf8'), 'incomplete data');
});

test('expanded approval stays bound to the exact request, origin and reviewed revision', async t => {
  const approvals = [], effects = [];
  let revision = 'reviewed', revoked = false;
  const handler = {
    group: 'fixtures',
    validate(action, args, targetId) {
      return targetId === undefined && args?.projectId === 'second-project' && typeof args.change === 'string';
    },
    list: async () => [],
    prepare: async () => ({ approval: true, review: 'Fixture review', revision }),
    async apply(origin, action, args, options) {
      if (!options.approved || !await options.stillAuthorized()) return { status: 'denied' };
      if (options.revision !== revision) return { status: 'stale' };
      effects.push({ origin, action, project: args.projectId });
      return { projectId: args.projectId };
    },
  };
  const f = await fixture(t, {
    handlers: { 'update-project': handler },
    askOwner: async record => { approvals.push({ source: 'worker-approval', sourceId: record.id, threadId: record.origin.threadId, sessionId: record.origin.sessionId }); },
    resolveApprovalOrigin: origin => revoked ? null : origin,
  });
  const store = await f.open(), worker = f.connect(store);
  const other = f.connect(store, { ...f.session, process: {}, origin: { ...f.session.origin, projectId: 'second-project' } });
  const input = (requestKey, change = requestKey) => ({ kind: 'request', requestKey, action: 'update-project', arguments: { projectId: 'second-project', change } });
  const submit = requestKey => worker.request(input(requestKey));
  const result = receipt => ({ kind: 'result', receiptId: receipt.receiptId });
  const old = await submit('fixture-old');
  assert.equal(old.status, 'pending-approval');
  assert.deepEqual(await submit('fixture-old'), old);
  assert.equal(approvals.length, 1);
  assert.equal(store.approval({ ...approvals[0], sessionId: randomUUID() }, 'Approve this request'), undefined);
  assert.throws(() => store.approval(approvals[0], 'Yes'), { status: 400 });
  await assert.rejects(other.request(result(old)), { status: 404 });
  revision = 'changed';
  await store.approval(approvals[0], 'Approve this request')();
  assert.equal((await worker.request(result(old))).status, 'stale');

  const denied = await submit('fixture-deny');
  await store.approval(approvals[1], 'Deny this request')();
  assert.equal((await worker.request(result(denied))).status, 'owner-denied');
  assert.deepEqual(await worker.request(input('different-key', 'fixture-deny')), await worker.request(result(denied)));
  assert.equal(store.approval(approvals[1], 'Approve this request'), undefined);

  const staleOrigin = await submit('fixture-revoked');
  revoked = true;
  await store.approval(approvals[2], 'Approve this request')();
  assert.equal((await worker.request(result(staleOrigin))).status, 'stale');
  assert.deepEqual(effects, []);
  revoked = false;

  const pending = await submit('fixture-current');
  await store.close();
  const restarted = await f.open(), resumed = f.connect(restarted);
  assert.equal((await resumed.request(input('after-restart', 'fixture-deny'))).status, 'owner-denied');
  assert.equal((await resumed.request(result(pending))).status, 'pending-approval');
  const decision = restarted.approval(approvals[3], 'Approve this request');
  await Promise.all([decision(), decision()]);
  assert.equal(effects.length, 1);
  assert.equal((await resumed.request(result(pending))).status, 'applied');
  const raw = await readFile(path.join(f.stateDir, 'worker-requests.json'), 'utf8');
  assert.doesNotMatch(raw, new RegExp(worker.token));
});

test('a durable Questions denial wins over a pending ledger record on restart', async t => {
  const questions = [], effects = [];
  const handler = {
    group: 'files', validate: () => true, list: async () => [],
    resolveIntent: () => '1'.repeat(64),
    prepare: async () => ({ approval: true, review: 'Review file fixture', revision: 'reviewed' }),
    apply: async () => { effects.push(true); return { status: 'applied' }; },
  };
  const f = await fixture(t, {
    handlers: { 'modify-file': handler }, ownerDecisions: questions,
    askOwner: async () => {}, resolveApprovalOrigin: origin => origin,
  });
  const store = await f.open(), worker = f.connect(store);
  const request = { kind: 'request', action: 'modify-file', requestKey: 'original', targetId: randomUUID(), arguments: { expectedRevision: 'one' } };
  const pending = await worker.request(request);
  assert.equal(pending.status, 'pending-approval');
  questions.push({
    source: 'worker-approval', sourceId: pending.receiptId, status: 'answered', answer: 'Deny this request',
    sessionId: f.session.origin.sessionId, threadId: f.session.origin.threadId,
  });
  await store.close();
  const restarted = await f.open(), resumed = f.connect(restarted);
  const denied = await resumed.request({ kind: 'result', receiptId: pending.receiptId });
  assert.equal(denied.status, 'owner-denied');
  assert.deepEqual(await resumed.request(request), denied);
  assert.equal((await resumed.request({ ...request, requestKey: 'alias', targetId: randomUUID(), arguments: { expectedRevision: 'two' } })).status, 'owner-denied');
  assert.equal(restarted.approval(questions[0], 'Approve this request'), undefined);
  assert.deepEqual(effects, []);
});

test('recovery rechecks the exact approval once and never retries enforced access or an unknown write', async t => {
  const approvals = [], attempts = new Map(), effects = [];
  let authorized = true;
  const handler = {
    group: 'files', validate: () => true, list: async () => [],
    prepare: async () => ({ approval: true, review: 'Review isolated file', revision: 'exact-revision' }),
    async apply(origin, action, args, options) {
      assert.equal(options.revision, 'exact-revision');
      assert.equal(options.approved, true);
      assert.equal(await options.stillAuthorized(), true);
      const count = (attempts.get(args.fixture) || 0) + 1;
      attempts.set(args.fixture, count);
      if (args.fixture === 'os') throw Object.assign(new Error('private path'), { code: 'EACCES' });
      if (args.fixture === 'policy') throw Object.assign(new Error('private config'), { status: 403 });
      if (args.fixture === 'unknown') {
        effects.push(args.fixture);
        throw Object.assign(new Error('acknowledgement lost'), { workerAccess: 'unknown-outcome' });
      }
      if (count === 1 || args.fixture === 'stuck') {
        throw Object.assign(new Error('temporary host failure'), { workerAccess: 'recoverable-host', noEffect: args.fixture !== 'no-proof' });
      }
      effects.push(args.fixture);
      return { status: 'applied' };
    },
  };
  let revokeDuringRecovery = false;
  const f = await fixture(t, {
    handlers: { 'modify-file': handler },
    askOwner: async record => approvals.push({ source: 'worker-approval', sourceId: record.id, sessionId: record.origin.sessionId, threadId: record.origin.threadId }),
    resolveApprovalOrigin: origin => authorized ? origin : null,
    wait: async () => { if (revokeDuringRecovery) authorized = false; },
  });
  const store = await f.open(), worker = f.connect(store);
  const input = fixture => ({ kind: 'request', action: 'modify-file', requestKey: fixture, arguments: { fixture } });
  const apply = async fixture => {
    f.session.origin.taskId = fixture;
    const request = input(fixture);
    assert.equal((await worker.request(request)).status, 'pending-approval');
    return store.approval(approvals.at(-1), 'Approve this request')();
  };
  const recovered = await apply('safe');
  assert.equal(recovered.status, 'applied');
  assert.deepEqual(recovered.recovery, { attempts: 1, status: 'recovered' });
  assert.equal(attempts.get('safe'), 2);
  const stopped = await apply('stuck');
  assert.equal(stopped.status, 'system-blocked');
  assert.equal(stopped.access, 'host-unavailable');
  assert.deepEqual(stopped.recovery, { attempts: 1, status: 'not-recovered' });
  assert.equal(attempts.get('stuck'), 2);
  for (const [fixture, access] of [['os', 'os-permission'], ['policy', 'policy'], ['no-proof', 'host-unavailable']]) {
    const blocked = await apply(fixture);
    assert.equal(blocked.status, 'system-blocked');
    assert.equal(blocked.access, access);
    assert.ok(blocked.nextStep);
    assert.doesNotMatch(JSON.stringify(blocked), /private path|private config/);
    assert.equal(attempts.get(fixture), 1);
  }
  const unknown = await apply('unknown');
  assert.equal(unknown.status, 'unconfirmed');
  assert.deepEqual(await worker.request({ ...input('unknown'), requestKey: 'new-key' }), unknown);
  assert.equal(attempts.get('unknown'), 1);
  revokeDuringRecovery = true;
  assert.equal((await apply('revoked')).status, 'stale');
  assert.equal(attempts.get('revoked'), 1);
  assert.deepEqual(effects, ['safe', 'unknown']);
});

test('expanded UI scopes handles to the exact home project, thread and acknowledging view', async t => {
  const deliveries = [];
  const f = await fixture(t, {
    validateUI: async () => true,
    sendUI: (view, payload) => { deliveries.push({ view, payload }); return true; },
  });
  const store = await f.open(), worker = f.connect(store);
  const view = {}, otherView = {};
  const publicWorkspace = { id: randomUUID(), kind: 'workspace-tab', label: 'Workspace' };
  const foreign = { id: randomUUID(), kind: 'project-tab', label: 'Other project', projectId: 'other' };
  const layout = { id: randomUUID(), kind: 'conversation-layout', label: 'Messages layout', projectId: f.session.origin.projectId, threadId: f.session.origin.threadId };
  store.uiInventory(view, [publicWorkspace, foreign, layout]);
  assert.deepEqual((await worker.request({ kind: 'capabilities' })).views, [publicWorkspace, layout]);
  const request = { kind: 'request', requestKey: 'toggle', action: 'set-message-panel', targetId: layout.id, arguments: { visible: false } };
  const receipt = await worker.request(request);
  assert.equal(receipt.status, 'pending');
  assert.equal((await worker.request({ ...request, requestKey: 'foreign', action: 'activate-tab', targetId: foreign.id, arguments: undefined })).status, 'stale');
  await assert.rejects(worker.request({ ...request, arguments: { visible: true } }), { status: 409 });
  assert.equal(deliveries.length, 1);
  const ack = { requestId: receipt.receiptId, status: 'applied', targetId: layout.id };
  await store.acknowledgeUI(otherView, ack);
  await store.acknowledge(view, { ...ack, closed: true });
  const read = { kind: 'result', receiptId: receipt.receiptId };
  assert.equal((await worker.request(read)).status, 'pending');
  await store.acknowledgeUI(view, ack);
  assert.equal((await worker.request(read)).status, 'applied');
});
