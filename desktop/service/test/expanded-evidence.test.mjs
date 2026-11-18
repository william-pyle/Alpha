import test from 'node:test';
import assert from 'node:assert/strict';
import { workerEvent, deliveredTask } from '../worker-evidence.mjs';
import { completionSummary } from '../completion-summary.mjs';
import { UiInspection } from '../ui-inspection.mjs';
import { ReleaseMonitor } from '../release-monitor.mjs';

test('worker lifecycle is ordered, idempotent, task-bound and never upgrades execution to verification', () => {
  let value = deliveredTask(null, { taskId: 'request-a', at: 1000 });
  assert.equal(value.acceptance, 'unconfirmed'); assert.equal(value.execution, 'unknown');
  const event = (kind, time, nativeTaskId = 'turn-a') => ({ kind, source: 'provider-record', at: new Date(time).toISOString(), nativeTaskId, eventKey: `${kind}:${time}:${nativeTaskId}` });
  assert.equal(workerEvent(value, event('turn-completed', 900, 'old-turn')).accepted, false);
  assert.equal(workerEvent(value, event('turn-completed', 1050, 'old-turn')).accepted, false);
  value = workerEvent(value, event('turn-started', 1100)).value; assert.equal(value.acceptance, 'observed');
  assert.equal(value.taskId, 'request-a'); assert.equal(value.nativeTaskId, 'turn-a'); assert.equal(value.deliveredAt, 1000);
  value = workerEvent(value, event('question', 1200)).value; assert.equal(value.execution, 'needs-input');
  assert.equal(workerEvent(value, event('turn-started', 1100)).accepted, false);
  assert.equal(workerEvent(value, event('turn-completed', 1300, 'other-turn')).accepted, false);
  value = workerEvent(value, event('turn-completed', 1400)).value; assert.equal(value.execution, 'finished'); assert.equal(value.verification, 'unverified');
  assert.equal(workerEvent(JSON.parse(JSON.stringify(value)), event('turn-completed', 1400)).accepted, false);
  value = workerEvent(value, event('turn-started', 1500, 'turn-b')).value;
  assert.equal(value.taskId, 'turn-b'); assert.equal(value.deliveredAt, undefined);
  assert.equal(workerEvent(value, event('turn-completed', 1600, 'turn-a')).accepted, false);
  value = workerEvent(value, { kind: 'attention' }, 1700).value; assert.equal(value.certainty, 'uncertain'); assert.equal(value.execution, 'needs-input');
  value = workerEvent(value, event('turn-failed', 1800, 'turn-b')).value; assert.equal(value.execution, 'failed');
});

test('summary requires explicit evidence and separate lifecycle; never truncates full report', () => {
  const input = { changed: ['Layout updated'], passed: [{ text: 'Fixture passed', evidence: 'test fixture-1' }], remaining: ['Installed validation pending'], lifecycle: Object.fromEntries(['tested','published','installed','observed'].map(key => [key, { status: 'unknown' }])) };
  const summary = completionSummary(input, { operationId: 'op1', threadId: 'a' }); assert.equal(summary.operationId, 'op1'); assert.match(summary.verification, /not independently verified/);
  assert.throws(() => completionSummary({ ...input, passed: [{ text: 'All good' }] }, {}), /evidence/);
  assert.throws(() => completionSummary({ ...input, lifecycle: { ...input.lifecycle, installed: { status: 'reported' } } }, {}), /installed/);
});

test('UI inspection is scoped, single-use, revocable, redacted and rejects hidden/dialog evidence', async () => {
  let selected = 'a', enabled = true, event;
  const inspection = new UiInspection({ selected: () => selected, thread: () => ({ allowUiInspection: enabled }), broadcast: (_, value) => { event = value } });
  assert.throws(() => inspection.inspect('b'), /selected/);
  const request = inspection.inspect('a');
  inspection.accept({ ...event, width: 960, height: 700, regions: [{ kind: 'composer', x: 1, y: 500, width: 900, height: 180, visible: true, text: 'SECRET', html: '<script>secret</script>' }], secret: 'NO' });
  const evidence = await request; assert.equal(evidence.regions[0].height, 180); assert.doesNotMatch(JSON.stringify(evidence), /SECRET|script|"secret"/);
  assert.throws(() => inspection.accept(event), /expired/);
  const revoke = inspection.inspect('a'); enabled = false; assert.throws(() => inspection.accept({ ...event }), /authorization/); inspection.close(); await assert.rejects(revoke, /ended/);
  enabled = true; const hidden = inspection.inspect('a'); inspection.accept({ ...event, unavailable: true }); await assert.rejects(hidden, /hidden/);
  selected = 'b'; assert.throws(() => inspection.inspect('a'), /selected/);
});

test('release monitor uses fixed read queries, retains timestamped stale evidence and separates versions', async () => {
  let fail = false, now = 10000; const calls = [];
  const run = async (exe, args) => { calls.push({ exe, args }); if (fail) throw new Error('do not expose token'); if (exe === 'powershell.exe') return { stdout: '[{"version":"0.2.15"}]' }; assert.deepEqual(args.slice(0,3), ['api','--method','GET']); return { stdout: JSON.stringify(args[3].includes('actions') ? { workflow_runs: [{ id: 8, status: 'completed', conclusion: 'failure', head_sha: 'abc' }] } : { tag_name: 'v0.2.18' }) }; };
  const monitor = new ReleaseMonitor({ version: '0.2.17', nativeVersion: '0.2.16', run, now: () => now });
  let feed = await monitor.refresh(); assert.equal(feed.published.version, 'v0.2.18'); assert.equal(feed.running.version, '0.2.16'); assert.equal(feed.build.conclusion, 'failure');
  now += 360000; assert.equal(monitor.snapshot().stale, true); fail = true; feed = await monitor.refresh(); assert.equal(feed.stale, true); assert.equal(feed.published.at, new Date(10000).toISOString()); assert.doesNotMatch(JSON.stringify(feed), /token/); assert.ok(calls.length >= 4);
});
