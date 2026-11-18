// Real provider measurements, isolated state. No worker, production transcript or UI capture.
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createService } from '../server.mjs';
await mkdir('.test-output', { recursive: true });
const repo = await mkdtemp(path.resolve('.test-output/trust-latency-'));
await mkdir(path.join(repo, 'workspace'));
await writeFile(path.join(repo, 'workspace/workspace.json'), '{"entities":[]}');
const service = await createService({ repo, uiDir: repo, mcpOptions: { home: repo, env: {} } });
const samples = [];
try {
  const thread = service.threads.create({ name: 'Latency measurement', projectId: 'fixture' });
  const coordinator = await service.getCoordinator(thread.id);
  let phases;
  const rpc = coordinator.rpc.bind(coordinator);
  coordinator.rpc = async (method, ...args) => { const start = performance.now(); try { return await rpc(method, ...args); } finally { phases.push({ phase: method, ms: Math.round(performance.now() - start) }); } };
  for (let i = 0; i < 3; i++) {
    phases = [];
    const start = Date.now(), id = `latency-${i}`;
    let firstTextMs = null;
    const progress = () => { firstTextMs ??= Date.now() - start; };
    coordinator.on('progress', progress);
    const response = await fetch(service.origin + `/api/threads/${thread.id}/input`, { method: 'POST', headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ id, text: 'Do not use tools. Reply with exactly: Ready.' }) });
    const ackMs = Date.now() - start;
    assert.equal(response.status, 202);
    const result = await coordinator.operationPromises.get(id);
    coordinator.off('progress', progress);
    assert.equal(result.status, 'completed', result.result);
    samples.push({ mode: i ? 'warm' : 'cold', ackMs, firstTextMs, totalMs: Date.now() - start, phases, timings: result.timings });
  }
  const result = { label: process.argv[2] || 'sample', measuredAt: new Date().toISOString(), prompt: 'Do not use tools. Reply with exactly: Ready.', samples, scope: 'Current source, isolated service and provider context; no speech or running app measurement.' };
  await writeFile(path.join(repo, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ repo, ...result }, null, 2));
} finally { await service.close(); }
