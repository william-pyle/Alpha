// Explicit local smoke test using the owner's existing Codex sign-in. Isolated
// workspace, no worker launch, microphone, camera, desktop capture or edits.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createService } from '../server.mjs';
await mkdir('.test-output', { recursive: true });
const repo = await mkdtemp(path.resolve('.test-output/thread-native-'));
await mkdir(path.join(repo, 'workspace'));
await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[]}');
const service = await createService({ repo, uiDir: path.resolve('dist'), mcpOptions: { home: repo, env: {} } });
try {
  const a = service.threads.create({ name: 'Architecture', projectId: 'fixture' });
  const b = service.threads.create({ name: 'Research', projectId: 'fixture' });
  const marker = 'violet-copper-' + crypto.randomUUID();
  service.threads.message(a.id, { id: 'private-seed', role: 'user', text: `My private marker is ${marker}.` });
  const ca = await service.getCoordinator(a.id), cb = await service.getCoordinator(b.id);
  const acknowledgements = [];
  const send = async (thread, id, text) => {
    const start = Date.now();
    const response = await fetch(service.origin + `/api/threads/${thread.id}/input`, { method: 'POST', headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ id, text }) });
    assert.equal(response.status, 202); acknowledgements.push({ id, ms: Date.now() - start });
    return (thread.id === a.id ? ca : cb).operationPromises.get(id);
  };
  const [ra, rb] = await Promise.all([
    send(a, 'smoke-a', 'Do not use tools. Reply with the private marker from this conversation.'),
    send(b, 'smoke-b', 'Do not use tools. What other conversation purposes can you see? Do you know a private marker from another thread? Do not invent one. Keep the answer short.'),
  ]);
  assert.equal(ra.status, 'completed', ra.result); assert.equal(rb.status, 'completed', rb.result);
  assert.ok(ra.result.includes(marker)); assert.ok(!rb.result.includes(marker));
  assert.notEqual(ca.threadId, cb.threadId);
  assert.ok(!JSON.stringify(cb.context()).includes(marker));
  const result = { nativeProviderContextsDistinct: true, privateMarkerRecoveredOnlyInA: true, acknowledgements, timings: [ra, rb].map(({ id, timings }) => ({ id, ...timings })), noWorkerLaunched: service.sessions.list().length === 0, scope: 'Two real Codex provider contexts in an isolated fixture; no owner session changed. This sample does not resolve the previously reported latency issue.' };
  await writeFile(path.join(repo, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ repo, ...result }));
} finally { await service.close(); }
