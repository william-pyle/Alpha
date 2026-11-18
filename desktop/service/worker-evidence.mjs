import { randomUUID } from 'node:crypto';

export function deliveredTask(previous, { taskId = randomUUID(), at = Date.now() } = {}) {
  return { taskId, deliveredAt: at, acceptance: 'unconfirmed', execution: 'unknown', verification: 'unverified', source: 'Terminal input dispatch', certainty: 'delivery-only', revision: (previous?.revision || 0) + 1, observedAt: at, seen: previous?.seen || [] };
}

// Only provider records establish execution. No timeout, silence, process exit,
// assistant prose or UI rendering can promote an outcome to verified.
export function workerEvent(previous, event, now = Date.now()) {
  const phases = { 'turn-started': 'working', question: 'needs-input', attention: 'needs-input', 'turn-completed': 'finished', 'turn-interrupted': 'interrupted', 'turn-failed': 'failed' };
  if (!phases[event.kind]) return { value: previous, accepted: true };
  const key = event.eventKey || (event.id ? `${event.kind}:${event.id}` : null);
  if (key && previous?.seen?.includes(key)) return { value: previous, accepted: false };
  const at = Number.isFinite(Date.parse(event.at)) ? Date.parse(event.at) : now;
  if (event.at && previous?.deliveredAt && at < previous.deliveredAt) return { value: previous, accepted: false };
  if (event.kind === 'turn-completed' && event.nativeTaskId && previous?.deliveredAt && previous.acceptance === 'unconfirmed') return { value: previous, accepted: false };
  if (previous && at < (previous.providerAt || 0)) return { value: previous, accepted: false };
  if (event.nativeTaskId && previous?.nativeTaskId && event.nativeTaskId !== previous.nativeTaskId && event.kind !== 'turn-started') return { value: previous, accepted: false };
  // The first provider acceptance binds its native turn to the delivered task;
  // keep the original request ID and dispatch time for provenance.
  const awaitingAcceptance = previous?.deliveredAt != null && previous.acceptance === 'unconfirmed' && !previous.nativeTaskId;
  const newTask = event.kind === 'turn-started' && !awaitingAcceptance && (event.nativeTaskId && previous?.nativeTaskId !== event.nativeTaskId || ['finished', 'failed', 'interrupted'].includes(previous?.execution));
  let value = newTask || !previous ? deliveredTask(previous, { taskId: event.nativeTaskId || randomUUID(), at }) : { ...previous };
  if (newTask || !previous) delete value.deliveredAt;
  const native = event.source === 'provider-record';
  value = { ...value, execution: phases[event.kind], verification: 'unverified', source: native ? 'Native provider record' : 'Observed terminal/provider fallback', certainty: native && event.nativeTaskId ? 'task-bound-native' : native ? 'native-session-bound' : 'uncertain', observedAt: now, revision: (previous?.revision || 0) + 1, seen: key ? [...(previous?.seen || []), key].slice(-128) : previous?.seen || [] };
  if (event.nativeTaskId) value.nativeTaskId = event.nativeTaskId;
  if (native) { value.providerAt = at; if (event.kind === 'turn-started') { value.acceptance = 'observed'; value.acceptedAt = at; } }
  return { value, accepted: true };
}
