import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WorkerFileActions } from '../worker-file-actions.mjs';

const firstRevision = 'a'.repeat(64);
const nextRevision = 'b'.repeat(64);
const initialDestination = 'c'.repeat(64);
const home = { projectId: 'home', sessionId: 'worker-one' };
const other = { projectId: 'other', sessionId: 'worker-two' };

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'alpha-worker-file-route-'));
  const projects = ['home', 'other', 'third', 'excluded'].map(id => ({
    id, workspacePath: `projects/${id}/workspace`, steps: [
      { path: 'notes.md' }, { path: '../escape.md' }, { path: 'nested/notes.md' },
      { path: 'credentials.md' }, { path: 'report.md:stream' }, { path: '.alpha.md' },
      { path: 'AGENTS.md' }, { path: 'deleted.md', removedAt: 'fixture' },
      { path: 'alias.md' }, { path: 'ALIAS.md' }, { path: 'external.html' },
    ],
  }));
  for (const item of projects) await mkdir(path.join(root, item.workspacePath), { recursive: true });
  const wire = [];
  const state = { source: firstRevision, destination: initialDestination, changed: 0, denyWrite: false, failures: new Map() };
  function createBoundary() {
    let boundary;
    boundary = new WorkerFileActions({
      projectStore: { repo: root, workspace: { registry: async () => ({ entities: projects }) }, exclusive: async (_id, run) => run(),
        async get(id) { return projects.find(project => project.id === id); } },
      projectStorage: { assertAvailable() {} },
      projectAllowed: id => id !== 'excluded',
      changed: () => { state.changed++; },
      send: request => {
        wire.push(request);
        queueMicrotask(() => {
          const failure = state.failures.get(request.action);
          if (failure) {
            boundary.receive({ type: 'worker-file-operation', requestId: request.requestId, error: 'Synthetic host failure.', ...failure });
            return;
          }
          let result;
          if (request.action === 'inspect') result = { revision: state.source };
          else if (request.action === 'inspect-copy') result = { destinationRevision: state.destination };
          else if (!state.denyWrite) result = { applied: true };
          boundary.receive({ type: 'worker-file-operation', requestId: request.requestId,
            ...(result ? { result } : { status: 409, error: 'Fixture bytes changed in the native operation.' }) });
        });
      },
    });
    t.after(() => boundary.close());
    return boundary;
  }
  const boundary = createBoundary();
  t.after(() => rm(root, { recursive: true }));
  return { boundary, createBoundary, projects, state, wire };
}

test('files expose bounded home references and accept exact IDs shared by the owner', async t => {
  const { boundary, createBoundary, wire } = await fixture(t);
  const [homeFile] = await boundary.list(home);
  const [otherFile] = await boundary.listOwner('other');
  assert.deepEqual(await boundary.list(home), [homeFile]);
  assert.deepEqual(await boundary.list(other), [otherFile]);
  assert.equal(homeFile.label, 'notes.md');
  assert.notEqual(homeFile.id, otherFile.id);
  assert.notEqual((await createBoundary().list(home))[0].id, homeFile.id);
  assert.equal(wire.every(request => request.filename === 'notes.md' && !Object.hasOwn(request, 'text')), true);
  assert.deepEqual(await boundary.list({ projectId: 'excluded' }), []);
  const args = { destinationProjectId: 'third', expectedRevision: otherFile.revision };
  await assert.rejects(boundary.prepare(home, 'copy-file', args, otherFile.id), { status: 404 });
  await assert.rejects(boundary.prepare(home, 'copy-file', { ...args, destinationProjectId: 'excluded' }, homeFile.id), { status: 403 });
  assert.equal(boundary.validate('modify-file', { expectedRevision: firstRevision, edit: 'ensure-final-newline', path: 'C:/fixture' }, homeFile.id), false);
});

test('file intent is independent of rotated handles, revision and session but bound to the action and destination', async t => {
  const { boundary, createBoundary, state } = await fixture(t);
  const [oldFile] = await boundary.listOwner('other');
  const copy = { destinationProjectId: 'home', expectedRevision: oldFile.revision };
  const priorIntent = await boundary.resolveIntent(home, 'copy-file', copy, oldFile.id);
  assert.equal((await boundary.prepare(home, 'copy-file', copy, oldFile.id)).intent, priorIntent);

  state.source = nextRevision;
  const afterReload = createBoundary();
  const [newFile] = await afterReload.listOwner('other');
  assert.notEqual(newFile.id, oldFile.id);
  assert.notEqual(newFile.revision, oldFile.revision);
  assert.equal(await afterReload.resolveIntent({ ...home, sessionId: 'new-worker' }, 'copy-file', {
    ...copy, expectedRevision: newFile.revision,
  }, newFile.id), priorIntent);
  assert.notEqual(await afterReload.resolveIntent(other, 'copy-file', {
    destinationProjectId: 'third', expectedRevision: newFile.revision,
  }, newFile.id), priorIntent);
  assert.notEqual(await afterReload.resolveIntent(home, 'modify-file', {
    edit: 'ensure-final-newline', expectedRevision: newFile.revision,
  }, newFile.id), priorIntent);
});

test('native read contention permits revalidation but OS enforcement and unknown writes have no retry signal', async t => {
  const { boundary, state, wire } = await fixture(t);
  const [target] = await boundary.listOwner('other');
  const copy = { destinationProjectId: 'home', expectedRevision: target.revision };
  const prepare = () => boundary.prepare(home, 'copy-file', copy, target.id);
  state.failures.set('inspect-copy', { status: 409, access: 'recoverable-host' });
  await assert.rejects(prepare(), { status: 409, workerAccess: 'recoverable-host', noEffect: true });
  assert.equal(wire.some(request => request.action === 'copy'), false);
  state.failures.delete('inspect-copy');
  const { revision } = await prepare();
  const apply = () => boundary.apply(home, 'copy-file', copy, {
    approved: true, revision, targetId: target.id, stillAuthorized: async () => true,
  });

  state.failures.set('copy', { status: 403, access: 'os-permission' });
  await assert.rejects(apply(), error => error.workerAccess === 'os-permission' && error.noEffect === undefined);
  assert.equal(wire.filter(request => request.action === 'copy').length, 1);
  state.failures.set('copy', { status: 503 });
  await assert.rejects(apply(), error => error.workerAccess === 'unknown-outcome' && error.noEffect === undefined);
  assert.equal(wire.filter(request => request.action === 'copy').length, 2);
  assert.equal(state.changed, 0);
});

test('cross-project copy and edit require a current one-shot approval before native dispatch', async t => {
  const { boundary, state, wire } = await fixture(t);
  const [external] = await boundary.listOwner('other');
  const copy = { destinationProjectId: 'home', expectedRevision: external.revision };
  const approve = () => Promise.resolve(true);
  const copyPlan = await boundary.prepare(home, 'copy-file', copy, external.id);
  assert.equal(copyPlan.approval, true);
  assert.equal(copyPlan.revision, initialDestination);
  assert.match(copyPlan.review, /other \/ notes\.md to home \/ notes\.md/);
  const options = { revision: copyPlan.revision, targetId: external.id, approved: true, stillAuthorized: approve };
  await assert.rejects(boundary.apply(home, 'copy-file', copy, { ...options, approved: false }), { status: 403 });
  await assert.rejects(boundary.apply(home, 'copy-file', copy, { ...options, stillAuthorized: async () => false }), { status: 403 });
  await assert.rejects(boundary.apply(other, 'copy-file', copy, { ...options, stillAuthorized: async () => false }), { status: 403 });
  state.destination = nextRevision;
  await assert.rejects(boundary.apply(home, 'copy-file', copy, options), { status: 409 });
  assert.equal(wire.some(request => request.action === 'copy'), false);
  state.destination = initialDestination;
  assert.deepEqual(await boundary.apply(home, 'copy-file', copy, options), { status: 'applied' });
  assert.equal(wire.at(-1).destinationProjectId, 'home');
  assert.equal(wire.at(-1).expectedRevision, firstRevision);
  assert.equal(wire.at(-1).destinationRevision, initialDestination);

  const edit = { edit: 'ensure-final-newline', expectedRevision: external.revision };
  const editPlan = await boundary.prepare(home, 'modify-file', edit, external.id);
  assert.equal(editPlan.approval, true);
  state.source = nextRevision;
  const editOptions = { ...options, revision: editPlan.revision };
  await assert.rejects(boundary.apply(home, 'modify-file', edit, editOptions), { status: 409 });
  state.source = firstRevision;
  state.denyWrite = true;
  await assert.rejects(boundary.apply(home, 'modify-file', edit, editOptions), { status: 409 });
  assert.equal(state.changed, 1);
  state.denyWrite = false;
  assert.deepEqual(await boundary.apply(home, 'modify-file', edit, editOptions), { status: 'applied' });
  assert.equal(wire.at(-1).edit, 'ensure-final-newline');
  assert.equal(wire.at(-1).projectId, 'other');
  assert.equal(state.changed, 2);
});
