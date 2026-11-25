import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createService } from '../server.mjs';

test('file approvals disclose exact references and apply only to the reviewed copy or append', async t => {
  const repo = await mkdtemp(path.join(tmpdir(), 'alpha-worker-file-approval-'));
  const homeId = 'fixture-home', externalId = 'fixture-external';
  const projects = [homeId, externalId];
  const file = id => path.join(repo, 'projects', id, 'workspace', 'notes.md');
  const external = file(externalId), home = file(homeId);
  const privateText = 'Synthetic document bytes stay in the files';
  for (const id of projects) await mkdir(path.dirname(file(id)), { recursive: true });
  await writeFile(external, privateText);
  await writeFile(path.join(repo, 'workspace.json'), JSON.stringify({
    entities: projects.map(id => ({ id, title: id, folder: id, workspacePath: `projects/${id}/workspace`,
      steps: [{ name: 'Notes', path: 'notes.md' }] })),
  }));

  const sessions = [], terminalEffects = [], fileEffects = [];
  const digest = content => createHash('sha256').update(content).digest('hex');
  const destinationRevision = digest('empty fixture destination');
  let inspectContention = false;
  let inspectCopyCalls = 0;
  let service;
  async function nativeFixture(event) {
    if (event.type !== 'worker-file-operation') return;
    const reply = { type: event.type, requestId: event.requestId };
    try {
      assert.ok(projects.includes(event.projectId));
      assert.equal(event.filename, 'notes.md');
      assert.ok(!Object.hasOwn(event, 'text'));
      const source = file(event.projectId);
      const bytes = await readFile(source);
      const revision = digest(bytes);
      if (event.action === 'inspect') {
        reply.result = { revision };
      } else if (event.expectedRevision !== revision) {
        reply.status = 409; reply.error = 'Fixture source changed.';
      } else if (event.action === 'inspect-copy') {
        inspectCopyCalls++;
        if (inspectContention) {
          inspectContention = false;
          reply.status = 409;
          reply.access = 'recoverable-host';
          reply.error = 'Synthetic sharing contention before any copy.';
        } else {
          reply.result = { destinationRevision };
        }
      } else if (event.action === 'copy') {
        assert.equal(event.destinationProjectId, homeId);
        assert.equal(event.destinationRevision, destinationRevision);
        await writeFile(home, bytes, { flag: 'wx' });
        fileEffects.push('copy');
        reply.result = { applied: true };
      } else {
        assert.equal(event.action, 'modify');
        assert.equal(event.edit, 'ensure-final-newline');
        await writeFile(source, '\n', { flag: 'a' });
        fileEffects.push('modify');
        reply.result = { applied: true };
      }
    } catch (error) {
      reply.status = error.code === 'ENOENT' ? 404 : 503;
      reply.error = 'The fixture file is unavailable.';
    }
    service.nativeMessage(reply);
  }
  service = await createService({ repo, uiDir: path.resolve('dist'), native: nativeFixture, mcpOptions: { home: repo, env: {} } });
  t.after(async () => {
    for (const session of sessions) session.process = null;
    await service.close();
    await rm(repo, { recursive: true });
  });

  function startTask(session) {
    const turn = randomUUID();
    service.sessions.nativeEvent(session, { kind: 'turn-started', source: 'provider-record', nativeTaskId: turn, eventKey: turn });
  }

  function worker(projectId) {
    const session = service.sessions.make({ id: randomUUID(), nativeId: randomUUID(), name: 'File worker',
      agent: 'codex', cwd: repo, projectId, open: true, status: 'running', startedAt: Date.now() });
    sessions.push(session);
    service.sessions.items.set(session.id, session);
    const thread = service.threads.observe(session);
    session.process = { write() { terminalEffects.push('write'); }, kill() { terminalEffects.push('kill'); } };
    const grant = service.sessions.issueWorkerBridge(session);
    grant.attach(session.process);
    startTask(session);
    return { session, thread, token: grant.token };
  }

  async function call(token, route, data, expected = 200) {
    const response = await fetch(service.origin + route, {
      method: data ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
    const value = await response.json();
    assert.equal(response.status, expected, JSON.stringify(value));
    assert.ok(!JSON.stringify(value).includes(privateText));
    return value;
  }
  const first = worker(homeId), second = worker(externalId);
  service.threads.select(second.thread.id);
  const owner = (route, data) => call(service.token, route, data);
  const request = (body, origin = first, expected) => call(origin.token, '/worker-request', body, expected);
  const result = receiptId => ({ kind: 'result', receiptId });
  async function settle(receiptId, status) {
    for (let tries = 0; tries < 40; tries++) {
      const receipt = await request(result(receiptId));
      if (receipt.status === status) return receipt;
      await delay(25);
    }
    assert.fail(`File receipt did not settle as ${status}`);
  }
  async function review(expected, requestor = first) {
    const [question, other] = await owner('/api/questions');
    assert.equal(other, undefined);
    assert.equal(question.source, 'worker-approval');
    assert.equal(question.sourceId, expected.receiptId);
    assert.equal(question.sessionId, requestor.session.id);
    assert.equal(question.threadId, requestor.thread.id);
    return question;
  }
  const answer = (question, data) => owner(`/api/questions/${question.id}/answer`, { answer: data });
  const references = `/api/worker-request-files/${externalId}`;
  await call(first.token, references, undefined, 401);
  const [target] = (await owner(references)).targets;
  assert.deepEqual(Object.keys(target).sort(), ['id', 'kind', 'label', 'projectId', 'revision']);
  assert.deepEqual((await request({ kind: 'capabilities' })).files, []);

  const copy = { kind: 'request', requestKey: 'copy-notes', action: 'copy-file', targetId: target.id,
    arguments: { destinationProjectId: homeId, expectedRevision: target.revision } };
  const copied = await request(copy);
  assert.equal(copied.status, 'pending-approval');
  assert.deepEqual(await request(copy), copied);
  await request(result(copied.receiptId), second, 404);
  const copyQuestion = await review(copied);
  assert.match(copyQuestion.context, /fixture-external \/ notes\.md to fixture-home \/ notes\.md/);
  await call(first.token, `/api/questions/${copyQuestion.id}/answer`, { answer: 'Approve this request' }, 401);
  await assert.rejects(readFile(home), { code: 'ENOENT' });
  const beforeApproval = inspectCopyCalls;
  inspectContention = true;
  await answer(copyQuestion, 'Approve this request');
  const applied = await settle(copied.receiptId, 'applied');
  assert.equal(inspectCopyCalls, beforeApproval + 2, 'The retry must re-inspect the exact copy and revision.');
  assert.deepEqual(applied.recovery, { attempts: 1, status: 'recovered' });
  assert.equal(await readFile(home, 'utf8'), privateText);
  assert.deepEqual(await request(copy), applied);
  await answer(copyQuestion, 'Approve this request');
  assert.deepEqual(fileEffects, ['copy']);

  const modify = { kind: 'request', requestKey: 'first-edit', action: 'modify-file', targetId: target.id,
    arguments: { expectedRevision: target.revision, edit: 'ensure-final-newline' } };
  const old = await request(modify);
  const editQuestion = await review(old);
  await writeFile(external, privateText + ' and changed');
  await answer(editQuestion, 'Approve this request');
  await settle(old.receiptId, 'stale');
  const [updated] = (await owner(references)).targets;
  const fresh = await request({ ...modify, requestKey: 'current-edit',
    arguments: { ...modify.arguments, expectedRevision: updated.revision } });
  await answer(await review(fresh), 'Approve this request');
  await settle(fresh.receiptId, 'applied');
  assert.equal(await readFile(external, 'utf8'), privateText + ' and changed\n');
  assert.deepEqual(fileEffects, ['copy', 'modify']);

  const [reviewed] = (await owner(references)).targets;
  const deniedRequest = { ...modify, requestKey: 'declined-edit', targetId: reviewed.id,
    arguments: { ...modify.arguments, expectedRevision: reviewed.revision } };
  const denied = await request(deniedRequest);
  await answer(await review(denied), 'Deny this request');
  await settle(denied.receiptId, 'owner-denied');
  await writeFile(external, privateText + ' edited by the owner');
  const [changed] = (await owner(references)).targets;
  startTask(first.session);
  assert.equal((await request({ ...deniedRequest, requestKey: 'reworded-edit', targetId: changed.id,
    arguments: { ...deniedRequest.arguments, expectedRevision: changed.revision },
  })).status, 'owner-denied');
  assert.deepEqual(await owner('/api/questions'), []);
  assert.equal(await readFile(external, 'utf8'), privateText + ' edited by the owner');
  assert.deepEqual(fileEffects, ['copy', 'modify']);
  assert.deepEqual(terminalEffects, []);
  assert.equal(service.threads.selectedId, second.thread.id);
});
