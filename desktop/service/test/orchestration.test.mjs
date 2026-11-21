import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createService } from '../server.mjs';

async function fixture() {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'alpha-orchestration-'));
  await mkdir(path.join(repo, 'workspace/alpha'), { recursive: true });
  await writeFile(path.join(repo, 'workspace/workspace.json'), JSON.stringify({ entities: [{ id: 'alpha', title: 'Alpha', folder: 'alpha', steps: [] }, { id: 'mooseville', title: 'Mooseville' }] }));
  const service = await createService({ repo, uiDir: repo, mcpOptions: { home: repo, env: {} } });
  const request = (route, data, method) => fetch(service.origin + '/api' + route, { method: method || (data ? 'POST' : 'GET'), headers: { Authorization: `Bearer ${service.token}`, Origin: service.origin, 'Content-Type': 'application/json' }, ...(data ? { body: JSON.stringify(data) } : {}) });
  return { repo, service, request };
}

test('new chats default to Conversations; explicitly unresolved projects retain origin-bound Questions', async () => {
  const { service, request } = await fixture();
  try {
    const response = await request('/sessions', { agent: 'shell', name: 'Project Tracking' });
    assert.equal(response.status, 201); const session = await response.json();
    assert.equal(session.projectPending, false); assert.equal(session.projectId, 'conversations');
    await request(`/threads/${session.id}`, { projectId: null }, 'PATCH');
    assert.equal(service.sessions.get(session.id).projectPending, true);
    for (let index = 0; index < 100 && !service.questions.list().length; index++) await new Promise(resolve => setTimeout(resolve, 10));
    const question = service.questions.list()[0]; assert.equal(question.source, 'project');
    assert.equal((await request(`/sessions/${session.id}/input`, { text: 'echo should-wait', composed: true })).ok, false);
    assert.equal((await request(`/questions/${question.id}/answer`, { answer: 'unknown' })).ok, false);
    assert.equal((await request(`/questions/${question.id}/answer`, { answer: 'Alpha' })).status, 200);
    assert.equal(service.sessions.get(session.id).projectId, 'alpha'); assert.equal(service.sessions.get(session.id).projectPending, false);
    assert.equal((await request(`/sessions/${session.id}/input`, { text: 'echo PROJECT_CONTEXT_OK', composed: true })).status, 200);
    assert.equal((await request('/sessions', { agent: 'shell', name: 'Invalid Project', projectId: 'missing' })).ok, false);
    const explicit = await (await request('/sessions', { agent: 'shell', name: 'Known Project', projectId: 'alpha' })).json();
    assert.equal(explicit.projectPending, false); assert.equal(service.questions.list().length, 0);
    const { Sessions } = await import('../sessions.mjs');
    const restored = await new Sessions(service.sessions.repo, service.sessions.stateDir).init();
    assert.equal(restored.get(session.id).projectId, 'alpha'); await restored.close();
  } finally { await service.close(); }
});

test('common-agent handoffs apply a version, respect exclusions, and automatic maintenance cannot launch work', async () => {
  const { service } = await fixture();
  try {
    const sent = [];
    service.sessions.get = () => ({ id: 'worker', agent: 'codex', cwd: 'C:/Projects/Example', projectId: 'alpha' });
    service.sessions.input = (_id, text) => { sent.push(text); return { delivered: true }; };
    const result = await service.coordinator.execute('send_to_chat', { id: 'worker', text: 'Run the relevant tests.', includeWorkLessons: true }, 'task');
    assert.deepEqual(result.commonAgent, { id: 'build-verification', version: 1 });
    assert.ok(sent[0].includes(service.common.instructions('build-verification').text));
    assert.ok(sent[0].endsWith('Run the relevant tests.'));
    assert.equal(service.common.pending.get('worker').agentId, 'build-verification');
    await service.common.setScope({ excludedProjects: ['mooseville'] });
    service.sessions.get = () => ({ id: 'excluded', agent: 'codex', cwd: 'C:/Projects/Mooseville', projectId: 'mooseville' });
    await assert.rejects(service.coordinator.execute('send_to_chat', { id: 'excluded', text: 'Run the tests.', commonAgentId: 'build-verification' }, 'task'), /excluded/);
    service.coordinator.operations.set('maintenance', { origin: 'maintenance' });
    await assert.rejects(service.coordinator.execute('open_chat', { agent: 'codex', name: 'Unexpected Work' }, 'maintenance'), /cannot launch/);
    assert.ok((await service.coordinator.execute('list_common_agents', {}, 'maintenance')).length >= 6);
  } finally { await service.close(); }
});

test('coordinator questions route through Questions and resume through the coordinator, not a guessed chat', async () => {
  const { service, request } = await fixture();
  try {
    service.coordinator.operations.set('original', { id: 'original', text: 'Choose the layout.', status: 'running', at: new Date().toISOString() });
    const question = await service.coordinator.execute('ask_user_question', { text: 'Which layout should I use?', options: ['Compact', 'Spacious'] }, 'original');
    const requests = [];
    service.coordinator.ask = async data => { requests.push(data); return { ...data, status: 'completed', result: 'I will use the compact layout.' }; };
    const answered = await request(`/questions/${question.id}/answer`, { answer: 'Compact' });
    assert.equal(answered.status, 200); assert.equal(requests.length, 1);
    assert.match(requests[0].text, /User's answer: Compact/); assert.match(requests[0].text, /Choose the layout/);
    assert.equal(service.questions.list().length, 0);
    assert.equal((await fetch(service.origin + '/api/common-agents')).status, 401);
    assert.equal((await fetch(service.origin + '/api/restart-notes')).status, 401);
  } finally { await service.close(); }
});
