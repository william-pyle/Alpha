import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createService } from '../server.mjs';

test('script approval uses the owner Questions route and returns a receipt only to the originating worker', async t => {
  const repo = await mkdtemp(path.join(tmpdir(), 'alpha-worker-script-approval-'));
  const workspace = path.join(repo, 'workspace');
  const projects = ['fixture-a', 'fixture-b'];
  await mkdir(path.join(repo, '.alpha'), { recursive: true });
  for (const id of projects) await mkdir(path.join(workspace, id), { recursive: true });
  await writeFile(path.join(workspace, 'workspace.json'), JSON.stringify({
    entities: projects.map(id => ({ id, title: id, folder: id, steps: [] })),
  }));
  const terminals = [];
  const fixtureSessions = [];
  let service;
  async function close() {
    for (const session of fixtureSessions) session.process = null;
    if (service) await service.close();
  }
  t.after(async () => { await close(); await rm(repo, { recursive: true, force: true }); });
  const start = () => createService({ repo, uiDir: path.resolve('dist'), mcpOptions: { home: repo, env: {} } });
  service = await start();
  function worker(projectId, existing) {
    const session = service.sessions.make({
      id: existing?.session.id || randomUUID(),
      nativeId: existing?.session.nativeId || randomUUID(),
      alphaThreadId: existing?.thread.id,
      name: 'Script worker ' + projectId,
      agent: 'codex', cwd: repo, projectId, open: true, status: 'running', startedAt: Date.now(),
    });
    fixtureSessions.push(session);
    service.sessions.items.set(session.id, session);
    const thread = service.threads.observe(session);
    session.process = {
      write: () => terminals.push('write'),
      kill: () => terminals.push('kill'),
      resize: () => {},
    };
    const bridge = service.sessions.issueWorkerBridge(session);
    bridge.attach(session.process);
    const turn = randomUUID();
    service.sessions.nativeEvent(session, { kind: 'turn-started', source: 'provider-record', nativeTaskId: turn, eventKey: turn });
    return { session, thread, token: bridge.token };
  }
  async function call(token, route, body, expected = 200) {
    const response = await fetch(service.origin + route, {
      method: body ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const value = await response.json();
    assert.equal(response.status, expected, JSON.stringify(value));
    return value;
  }
  const request = (worker, body, expected) => call(worker.token, '/worker-request', body, expected);
  const answer = (id, value, token = service.token, expected) =>
    call(token, `/api/questions/${id}/answer`, { answer: value }, expected);
  const questions = () => call(service.token, '/api/questions');
  const body = receiptId => ({ kind: 'result', receiptId });
  async function eventually(read, wanted) {
    const deadline = Date.now() + 7000;
    let value;
    do {
      value = await read();
      if (wanted(value)) return value;
      await delay(250);
    } while (Date.now() < deadline);
    assert.fail(`The fixture timed out. Last state ${JSON.stringify(value)}`);
  }
  function settled(worker, id, status) {
    return eventually(() => request(worker, body(id)), receipt => receipt.status === status);
  }

  const first = worker(projects[0]);
  const other = worker(projects[1]);
  service.threads.select(other.thread.id);
  const capability = async origin => (await request(origin, { kind: 'capabilities' })).scripts[0];
  const script = await capability(first);
  assert.equal(script.scriptId, 'alpha-runtime-check');
  assert.notEqual((await capability(other)).revision, script.revision);
  const invocation = {
    kind: 'request', requestKey: 'fixture-run-script', action: 'run-script',
    arguments: { scriptId: script.scriptId, expectedRevision: script.revision },
  };
  assert.equal((await request(other, invocation)).status, 'stale');
  const receipt = await request(first, invocation);
  assert.equal(receipt.status, 'pending-approval');
  assert.deepEqual(await request(first, invocation), receipt);
  await request(other, body(receipt.receiptId), 404);

  const [question] = await questions();
  assert.equal((await questions()).length, 1);
  assert.equal(question.source, 'worker-approval');
  assert.equal(question.sourceId, receipt.receiptId);
  assert.equal(question.sessionId, first.session.id);
  assert.equal(question.threadId, first.thread.id);
  assert.ok(question.context.includes(script.revision));
  assert.deepEqual(question.options, ['Approve this request', 'Deny this request']);
  await answer(question.id, 'Approve this request', first.token, 401);
  await answer(question.id, 'Approve another script', service.token, 400);
  assert.equal((await request(first, body(receipt.receiptId))).status, 'pending-approval');
  await answer(question.id, 'Approve this request');
  const applied = await settled(first, receipt.receiptId, 'applied');
  assert.deepEqual(Object.keys(applied).sort(), ['action', 'message', 'receiptId', 'status']);
  assert.equal((await answer(question.id, 'Approve this request')).alreadyAccepted, true);
  assert.deepEqual(await request(first, invocation), applied);

  const stale = await request(first, { ...invocation, requestKey: 'fixture-moved-script' });
  const [staleQuestion] = await questions();
  first.session.projectId = projects[1];
  await answer(staleQuestion.id, 'Approve this request');
  await eventually(() => service.questions.items.find(item => item.id === staleQuestion.id).continuation,
    state => state === 'completed');
  first.session.projectId = projects[0];
  await settled(first, stale.receiptId, 'stale');

  const denied = await request(first, { ...invocation, requestKey: 'fixture-denied-script' });
  const [deniedQuestion] = await questions();
  assert.equal(deniedQuestion.sourceId, denied.receiptId);
  await answer(deniedQuestion.id, 'Deny this request');
  const deniedResult = await settled(first, denied.receiptId, 'owner-denied');
  assert.deepEqual(await request(first, { ...invocation, requestKey: 'fixture-denied-script' }), deniedResult);
  await answer(deniedQuestion.id, 'Approve this request', service.token, 409);
  assert.equal(service.threads.selectedId, other.thread.id);
  assert.deepEqual(terminals, []);
  await service.threads.save();
  await close();
  service = await start();
  const resumed = worker(projects[0], first);
  assert.deepEqual(await request(resumed, body(applied.receiptId)), applied);
  assert.deepEqual(await request(resumed, { ...invocation, requestKey: 'fixture-rephrased-script' }), deniedResult);
  await request(other, body(applied.receiptId), 401);
  await request(worker(projects[1], other), body(applied.receiptId), 404);
  assert.deepEqual(await questions(), []);
  assert.deepEqual(terminals, []);
});
