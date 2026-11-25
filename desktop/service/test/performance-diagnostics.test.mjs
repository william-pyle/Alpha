import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PerformanceDiagnostics, diagnosticRoute } from '../performance-diagnostics.mjs';
import { Coordinator } from '../coordinator.mjs';
import { createService } from '../server.mjs';

test('opt-in one-shot keeps a bounded prefix and tail, correlates opaque IDs, and drops payloads', () => {
  let now = 1000;
  const diagnostics = new PerformanceDiagnostics({ capacity: 8, clock: () => ++now });
  assert.equal(diagnostics.begin('conversation'), null);
  assert.throws(() => diagnostics.arm('conversation'), /Enable/);
  diagnostics.configure(true);
  diagnostics.arm('conversation');
  assert.equal(diagnostics.begin('workspace'), null);
  const trace = diagnostics.begin('conversation');
  assert.equal(diagnostics.begin('conversation'), null);
  trace.operation('private-operation');
  trace.worker('private-worker', 'private-task');
  assert.equal(diagnostics.worker('private-worker', 'other-task'), null);
  assert.equal(diagnostics.worker('private-worker', 'private-task'), trace);
  trace.event('http-start', { operation: 'private-operation', method: 'private-payload' });
  for (let i = 0; i < 20; i++) trace.event('ipc-frame', { bytes: i, kind: 'private-content', prompt: 'secret', path: 'private-path' });
  diagnostics.client({ operation: 'unrelated', event: 'ui-render', durationMs: 88 });
  diagnostics.client({ captureId: trace.id, event: 'ui-render', durationMs: 0.75, text: 'private-ui' });
  trace.event('first-text', { operation: 'private-operation', chars: 19, token: 'private-token' });
  const saved = diagnostics.configure(false).last;
  assert.equal(saved.outcome, 'disabled');
  assert.equal(saved.events.length, 8);
  assert.equal(saved.events[0].event, 'capture-start');
  assert.equal(saved.events.at(-1).event, 'capture-end');
  assert.equal(saved.events[1].operation, saved.events.find(event => event.event === 'first-text').operation);
  assert.equal(saved.events.filter(event => event.event === 'ui-render').length, 1);
  assert.equal(saved.events.find(event => event.event === 'first-text').chars, 256);
  assert.ok(saved.events.filter(event => event.bytes !== undefined).every(event => event.bytes % 4096 === 0));
  assert.ok(saved.dropped > 0);
  const frozen = JSON.stringify(saved);
  assert.doesNotMatch(frozen, /private|secret/);
  trace.event('paste', { chars: 123 });
  assert.equal(JSON.stringify(diagnostics.status().last), frozen);
  diagnostics.delete();
  assert.equal(diagnostics.status().last, null);
});

test('arming expires and a capture stops after the held operation and bounded tail', async () => {
  const diagnostics = new PerformanceDiagnostics({ enabled: true, armMs: 5, captureMs: 100, tailMs: 5 });
  diagnostics.arm('settings');
  await delay(15);
  assert.equal(diagnostics.begin('settings'), null);
  diagnostics.arm('conversation');
  const trace = diagnostics.begin('conversation');
  const release = trace.hold();
  trace.finish('ok');
  await delay(15);
  assert.ok(diagnostics.status().active);
  release('failed');
  release('ok');
  await delay(15);
  assert.equal(diagnostics.status().last.outcome, 'failed');
  diagnostics.arm('worker');
  diagnostics.begin('worker');
  await delay(120);
  assert.equal(diagnostics.status().last.outcome, 'expired');
});

test('real loopback Settings endpoint persists preference but never restores a capture', async t => {
  const repo = await mkdtemp(path.join(tmpdir(), 'alpha-diagnostics-test-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  await writeFile(path.join(repo, 'workspace.json'), '{"entities":[]}');
  const make = () => createService({ repo, uiDir: repo, mcpOptions: { home: repo, env: {} } });
  let service = await make();
  try {
    const send = (route, data, auth = true, method = data ? 'POST' : 'GET') => fetch(service.origin + '/api/' + route, {
      method, headers: { ...(auth ? { Authorization: `Bearer ${service.token}` } : {}), 'Content-Type': 'application/json' },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
    const endpoint = 'performance-diagnostics';
    assert.equal((await send(endpoint, null, false)).status, 401);
    assert.equal((await (await send(endpoint)).json()).enabled, false);
    assert.equal((await send(endpoint, { enabled: true })).status, 200);
    assert.equal((await send(endpoint, { action: 'arm', category: 'workspace' })).status, 200);
    const result = await send('workspace?PRIVATE_QUERY');
    assert.ok(result.headers.get('X-Alpha-Performance-Capture'));
    assert.equal((await send(endpoint, { action: 'stop' })).status, 200);
    const before = await (await send(endpoint)).json();
    assert.equal(before.last.events.some(item => item.event === 'http-finish'), true);
    assert.doesNotMatch(JSON.stringify(before), /PRIVATE_QUERY/);
    assert.equal((await send('workspace')).headers.has('X-Alpha-Performance-Capture'), false);
    await service.close();
    service = await make();
    const restored = await (await send(endpoint)).json();
    assert.deepEqual(restored, { enabled: true, armed: null, active: null, last: null });
    assert.equal((await send(endpoint, { enabled: false })).status, 200);
    await service.close();
    service = await make();
    assert.equal((await (await send(endpoint)).json()).enabled, false);
  } finally { await service.close(); }
  assert.equal(diagnosticRoute('GET', '/api/performance-diagnostics'), null);
});

test('coordinator traces protocol boundaries, elapsed status and failure interrupts', { timeout: 5000 }, async t => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'alpha-diagnostics-protocol-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const diagnostics = new PerformanceDiagnostics({ enabled: true });
  diagnostics.arm('conversation');
  const trace = diagnostics.begin('conversation');
  let interrupted = false, reportStatus;
  const coordinator = new Coordinator({ stateDir, repo: stateDir, context: () => ({}),
    execute() { assert.fail('Synthetic status tool call must never run'); },
    statusClock: { setTimeout(callback) { reportStatus = callback; }, clearTimeout() { reportStatus = null; } } });
  coordinator.start = async () => { coordinator.threadId = 'private-thread'; };
  coordinator.rpc = async method => {
    if (method === 'turn/interrupt') { interrupted = true; return {}; }
    await coordinator.message({ method: 'turn/started', params: { threadId: 'private-thread', turn: { id: 'private-turn' } } });
    await coordinator.message({ method: 'item/agentMessage/delta', params: { threadId: 'wrong-thread', turnId: 'private-turn', delta: 'secret' } });
    await coordinator.message({ id: 77, result: {} });
    await coordinator.message({ method: 'error', params: { threadId: 'private-thread', turnId: 'private-turn', willRetry: true,
      error: { message: 'secret raw error', codexErrorInfo: { responseStreamConnectionFailed: { httpStatusCode: 429 } } } } });
    return { turn: { id: 'private-turn' } };
  };
  const request = coordinator.ask({ id: 'private-op', text: 'synthetic local status', threadId: 'alpha-thread', trace });
  while (!coordinator.active?.turnId) await delay(1);
  reportStatus();
  assert.equal(interrupted, false);
  assert.equal(coordinator.operations.get('private-op').status, 'running');
  await coordinator.message({ method: 'turn/completed', params: { threadId: 'private-thread', turn: { id: 'private-turn', status: 'failed', error: { message: 'Provider failed' } } } });
  const result = await request;
  assert.equal(result.status, 'failed');
  assert.equal(interrupted, true);
  await coordinator.message({ method: 'turn/completed', params: { threadId: 'private-thread', turn: { id: 'private-turn', status: 'completed' } } });
  const saved = diagnostics.stop().last;
  assert.ok(saved.events.some(item => item.method === 'turn/started' && item.match === 'early'));
  for (const kind of ['wrong-thread', 'stale-rpc', 'unhandled', 'late', 'no-active']) assert.ok(saved.events.some(item => item.kind === kind), kind);
  for (const phase of ['turn-status', 'interrupt-start', 'interrupt-end']) assert.ok(saved.events.some(item => item.event === phase), phase);
  assert.ok(saved.events.some(item => item.event === 'ipc-frame' && item.kind === 'provider-retry' && item.statusCode === 429));
  assert.equal(saved.events.some(item => item.event === 'first-text'), false);
  assert.doesNotMatch(JSON.stringify(saved), /private|secret|synthetic/);
  diagnostics.arm('conversation');
  const next = diagnostics.begin('conversation');
  coordinator.active = { trace: next, operationId: 'different-op', turnId: 'current', text: '' };
  await coordinator.message({ method: 'item/agentMessage/delta', params: { threadId: 'private-thread', turnId: 'stale-turn', delta: 'secret' } });
  assert.ok(diagnostics.stop().last.events.some(item => item.kind === 'accepted-unchecked' && item.match === 'mismatch'));
  coordinator.active = null;
  await coordinator.close();
});

test('explicit direct worker route captures guarded native receipt without coordinator or content', async t => {
  const repo = await mkdtemp(path.join(tmpdir(), 'alpha-diagnostics-native-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  await writeFile(path.join(repo, 'workspace.json'), '{"entities":[]}');
  const service = await createService({ repo, uiDir: repo, mcpOptions: { home: repo, env: {} } });
  const session = service.sessions.make({ id: 'PRIVATE-WORKER', agent: 'codex', name: 'Fixture worker', cwd: repo, projectId: 'conversations', status: 'running', open: true });
  let draft = '', time = 1000;
  const writes = [];
  session.process = { write(value) {
    writes.push(value);
    if (value === '\t') service.sessions.nativeEvent(session, { kind: 'task-input', source: 'provider-record', text: draft });
    else draft = value.slice(6, -6).replaceAll('\r', '\n');
  } };
  service.sessions.items.set(session.id, session);
  const thread = service.threads.observe(session);
  service.threads.select(thread.id);
  service.sessions.submission.clock = () => time;
  service.sessions.submission.wait = async milliseconds => { time += milliseconds; };
  service.sessions.submission.view = async () => ({
    lines: ['OpenAI Codex', '› ' + draft, '? for shortcuts'],
    cursorY: 1, cursorX: 2 + draft.length, bracketedPaste: true, startupSettled: true,
  });
  try {
    const route = (endpoint, data) => fetch(service.origin + '/api/' + endpoint, {
      method: data ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + service.token, 'Content-Type': 'application/json' },
      ...(data && { body: JSON.stringify(data) }),
    });
    service.diagnostics.configure(true);
    service.diagnostics.arm('conversation');
    const response = await route('threads/' + thread.id + '/input', { id: 'PRIVATE-OP', text: 'PRIVATE-PAYLOAD', target: 'work' });
    assert.equal(response.status, 202);
    for (let i = 0; i < 100 && !session.submissions?.[0]?.acceptedAt; i++) await delay(5);
    assert.equal(session.submissions?.[0]?.acceptance, 'observed');
    service.sessions.nativeEvent(session, { kind: 'turn-completed', source: 'provider-record', id: 'PRIVATE-COMPLETION' });
    const { last } = service.diagnostics.stop();
    const names = last.events.map(event => event.event);
    for (const name of ['worker-queue', 'worker-binding', 'receipt-created', 'composer-state', 'paste-intent', 'paste', 'submit-intent', 'submit', 'native-input', 'worker-completion']) assert.ok(names.includes(name), name);
    assert.ok(names.indexOf('paste') < names.indexOf('submit') && names.indexOf('submit') < names.indexOf('native-input'));
    assert.equal(names.includes('ipc-send'), false);
    assert.equal(writes.length, 2);
    assert.doesNotMatch(JSON.stringify(last), /PRIVATE-|USER MESSAGE|C:\\/i);
  } finally {
    session.process = null;
    await service.close();
  }
});
