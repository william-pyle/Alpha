import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { createWorkerScriptActions } from '../worker-script-actions.mjs';

const action = 'run-script';
const projectA = { projectId: 'fixture-a' };
const projectB = { projectId: 'fixture-b' };
function projects() {
  const present = new Set([projectA.projectId, projectB.projectId]);
  const unavailable = new Set();
  return {
    present,
    unavailable,
    projectStore: {
      async get(id, options) {
        assert.deepEqual(options, { allowRemoved: false });
        if (!present.has(id)) throw Object.assign(new Error('fixture project removed'), { status: 404 });
        return { id };
      },
      async exclusive(id, apply) {
        assert.ok([projectA.projectId, projectB.projectId].includes(id));
        return apply();
      },
    },
    projectStorage: {
      assertAvailable(id) {
        if (unavailable.has(id)) throw Object.assign(new Error('fixture workspace moved'), { status: 409 });
      },
    },
  };
}

async function exactScript(actions, origin = projectA) {
  const [script] = await actions.list(origin);
  assert.equal(script.scriptId, 'alpha-runtime-check');
  assert.match(script.revision, /^[a-f0-9]{64}$/);
  return { scriptId: script.scriptId, expectedRevision: script.revision };
}

test('only the exact registered, project-bound script invocation can be approved', async () => {
  const state = projects();
  const scripts = createWorkerScriptActions(state);
  const choice = await exactScript(scripts);
  const own = await scripts.prepare(projectA, action, choice);
  assert.equal(own.approval, true);
  assert.equal(own.revision, choice.expectedRevision);
  assert.match(own.review.text, /project fixture-a/);
  assert.match(own.review.context, /Invocation [a-f0-9]{64}/);
  assert.notEqual((await exactScript(scripts, projectB)).expectedRevision, own.revision);
  await assert.rejects(scripts.prepare(projectB, action, choice), { status: 409 });
  await assert.rejects(scripts.prepare(projectA, action, { ...choice, scriptId: 'workspace-tool' }), { status: 403 });
  await assert.rejects(scripts.prepare(projectA, action, { ...choice, scriptId: '../runtime-check' }), { status: 400 });
  await assert.rejects(scripts.prepare(projectA, action, { ...choice, args: ['--no-permission'] }), { status: 400 });
  await assert.rejects(scripts.prepare(projectA, action, choice, 'forged-target'), { status: 400 });
  await assert.rejects(scripts.prepare({ projectId: 'mooseville' }, action, choice), { status: 403 });
  assert.deepEqual(await scripts.apply(projectA, action, choice, { revision: own.revision }), { status: 'denied' });
  assert.deepEqual(await scripts.apply(projectA, action, choice, { approved: true, revision: '0'.repeat(64) }), { status: 'stale' });
  assert.deepEqual(await scripts.apply(projectB, action, choice, { approved: true, revision: own.revision }), { status: 'stale' });
  assert.deepEqual(await scripts.apply(projectA, action, choice, { approved: true, revision: own.revision, stillAuthorized: async () => false }), { status: 'stale' });
  state.unavailable.add(projectA.projectId);
  assert.deepEqual(await scripts.apply(projectA, action, choice, { approved: true, revision: own.revision }), { status: 'stale' });
  state.present.delete(projectA.projectId);
  assert.deepEqual(await scripts.apply(projectA, action, choice, { approved: true, revision: own.revision }), { status: 'stale' });
});

test('the approved bundled script runs in the restricted Node runtime without inherited Alpha state', async () => {
  const scripts = createWorkerScriptActions(projects());
  const choice = await exactScript(scripts);
  const { revision } = await scripts.prepare(projectA, action, choice);
  const previous = process.env.ALPHA_SCRIPT_FIXTURE;
  process.env.ALPHA_SCRIPT_FIXTURE = 'synthetic-value';
  try {
    assert.deepEqual(await scripts.apply(projectA, action, choice, { approved: true, revision }), { status: 'applied' });
  } finally {
    if (previous === undefined) delete process.env.ALPHA_SCRIPT_FIXTURE;
    else process.env.ALPHA_SCRIPT_FIXTURE = previous;
  }
});

test('changed bundled source is rejected between review and launch', async t => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'alpha-worker-script-catalog-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const entry = path.join(fixture, 'worker-script-actions.mjs');
  const scriptsRoot = path.join(fixture, 'worker-scripts');
  await mkdir(scriptsRoot);
  const script = path.join(scriptsRoot, 'runtime-check.mjs');
  for (const file of ['worker-script-actions.mjs', 'project-layout.mjs', 'util.mjs']) {
    await copyFile(new URL(`../${file}`, import.meta.url), path.join(fixture, file));
  }
  const source = await readFile(new URL('../worker-scripts/runtime-check.mjs', import.meta.url), 'utf8');
  await writeFile(script, source.replace(/\r?\n/g, '\r\n'));
  const fixtureModule = await import(pathToFileURL(entry));
  const scripts = fixtureModule.createWorkerScriptActions(projects());
  const choice = await exactScript(scripts);
  const { revision } = await scripts.prepare(projectA, action, choice);
  await writeFile(script, 'process.exitCode = 0;\n');
  assert.deepEqual(await scripts.list(projectA), []);
  assert.deepEqual(await scripts.apply(projectA, action, choice, { approved: true, revision }), { status: 'stale' });
});
