import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkerRequests } from '../worker-requests.mjs';

async function fixture(t) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'alpha-worker-requests-'));
  const sent = [], stores = [];
  const open = async () => {
    const store = await new WorkerRequests({ stateDir, resolveOrigin: (session, active) => (!active || session.active) && { ...session.origin },
      send: (view, payload) => { sent.push({ view, ...payload }); return true; } }).init();
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
