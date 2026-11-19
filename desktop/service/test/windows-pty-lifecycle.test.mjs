import test from 'node:test';
import assert from 'node:assert/strict';
import { guardWindowsPtyKill } from '../windows-pty-lifecycle.mjs';

test('deferred stop, shutdown fallback and exit cleanup enter the native close only once', () => {
  const deferred = []; let calls = 0;
  const proc = { _agent: { kill() { calls++; assert.equal(this, proc._agent); } }, kill() { deferred.push(() => this._agent.kill()); } };
  assert.equal(guardWindowsPtyKill(proc, 'win32'), proc);
  guardWindowsPtyKill(proc, 'win32');
  proc.kill(); proc.kill();
  proc._agent.kill(); // starting-shell fallback wins before deferred readiness
  deferred.forEach(run => run());
  proc._agent.kill(); // onExit cleanup
  assert.equal(calls, 1);
});

test('natural exit still closes once and a fresh terminal has its own lifetime', () => {
  let calls = 0;
  for (let i = 0; i < 2; i++) {
    const proc = guardWindowsPtyKill({ _agent: { kill() { calls++; } } }, 'win32');
    proc._agent.kill(); proc._agent.kill();
  }
  assert.equal(calls, 2);
});

test('native close errors and reentrant cleanup cannot replay an uncertain close', () => {
  let calls = 0;
  const proc = guardWindowsPtyKill({ _agent: { kill() { calls++; proc._agent.kill(); throw new Error('native close failed'); } } }, 'win32');
  assert.throws(() => proc._agent.kill(), /native close failed/);
  proc._agent.kill();
  assert.equal(calls, 1);
});

test('non-Windows terminal behavior is unchanged', () => {
  let calls = 0;
  const kill = () => { calls++; };
  const proc = { _agent: { kill } };
  guardWindowsPtyKill(proc, 'linux');
  assert.equal(proc._agent.kill, kill);
  proc._agent.kill(); proc._agent.kill();
  assert.equal(calls, 2);
});
