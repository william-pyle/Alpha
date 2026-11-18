import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { CommonAgents } from '../common-agents.mjs';
import { Health } from '../health.mjs';
import { projectProfiles } from '../project-profiles.mjs';

const fixture = async () => new CommonAgents({ stateDir: await mkdtemp(path.join(os.tmpdir(), 'alpha-common-')) }).init();
async function completed(common, project, task, agentId) {
  const session = { id: `session-${common.tasks.length}`, agent: 'codex', cwd: project };
  common.input(session, task, project, agentId);
  return common.complete(session, { id: `turn-${common.tasks.length}` });
}

test('cross-project repetition creates a role without claiming accepted results', async () => {
  const common = await fixture();
  for (let index = 0; index < 3; index++) await completed(common, 'project-one', 'Review the responsive layout for this screen.');
  assert.ok(!common.agents.some(agent => agent.id === 'interface-review'));
  await completed(common, 'project-two', 'Review the responsive layout for another screen.');
  const agent = common.get('interface-review');
  assert.equal(agent.origin, 'detected'); assert.equal(agent.evidenceIds.length, 4);
  assert.ok(common.tasks.every(task => task.outcome === 'completed-unverified'));
  assert.ok(common.tasks.every(task => task.agentId === null), 'An observed task must not claim a role was applied.');
  const restored = await new CommonAgents({ stateDir: path.dirname(common.activityFile) }).init();
  assert.equal(restored.get('interface-review').activeVersion, 1);
});

test('excluded projects never become discovery evidence and cannot satisfy creation thresholds', async () => {
  const common = await fixture(); await common.setScope({ excludedProjects: ['mooseville'] });
  await completed(common, 'C:/Projects/Mooseville', 'Review the responsive layout for this screen.');
  await completed(common, 'shared-workspace', 'Review Mooseville interface layout.');
  assert.equal(common.tasks.length, 0);
  assert.equal(common.allows('mooseville'), false);
  assert.equal(common.allows('other-project'), true);
  await assert.rejects(common.create({ name: 'UI inspection', purpose: 'Inspect recurring interface layouts.', instructions: 'Read the project instructions and inspect its actual interface and keyboard behavior before recommending scoped changes.', evidenceIds: [] }), /three completed tasks/);
  assert.deepEqual((await new CommonAgents({ stateDir: path.dirname(common.activityFile) }).init()).scope.excludedProjects, ['mooseville']);
});

test('assigned roles keep run versions, failure feedback, revisions and rollback', async () => {
  const common = await fixture();
  const run = await completed(common, 'project-one', 'Run the relevant tests and check the result.', 'build-verification');
  assert.equal(run.version, 1);
  await common.feedback(run.id, { outcome: 'needs-fix', feedback: 'The verification missed the actual Windows startup failure.' });
  assert.equal(common.list().find(agent => agent.id === 'build-verification').maintenanceNeeded, true);
  const previous = common.instructions('build-verification').text;
  await common.revise('build-verification', { instructions: previous + '\nFor startup fixes, exercise the native startup path with a disposable profile.', reason: 'The recorded run missed a native startup failure despite passing tests.' });
  assert.equal(common.get('build-verification').activeVersion, 2);
  assert.equal(common.tasks[0].version, 1);
  assert.equal(common.list().find(agent => agent.id === 'build-verification').maintenanceNeeded, false);
  await common.control('build-verification', { version: 1, enabled: false });
  assert.equal(common.match('Run the tests.'), null);
  await common.control('build-verification', { enabled: true });
  assert.equal(common.instructions('build-verification').text, previous);
});

test('an in-flight task survives service state reload without becoming a successful result', async () => {
  const common = await fixture();
  const session = { id: 'pending', agent: 'codex', cwd: 'project-one' };
  common.input(session, 'Run the relevant tests.', session.cwd, 'build-verification'); await common.close();
  const restored = await new CommonAgents({ stateDir: path.dirname(common.activityFile) }).init();
  assert.equal(restored.tasks.length, 0); assert.equal(restored.pending.size, 1);
  const task = await restored.complete(session, { id: 'completed-after-restart' });
  assert.equal(task.outcome, 'completed-unverified'); assert.equal(task.agentId, 'build-verification');
});

test('verification requires provenance, acceptance stays separate, corrections and repeat failures retain versions', async () => {
  const common = await fixture();
  assert.equal(common.list().find(agent => agent.id === 'build-verification').outcomes.verified, 0);
  await assert.rejects(common.revise('build-verification', { instructions: common.instructions('build-verification').text, reason: 'A claim without any recorded task evidence.' }), /existing task evidence/);
  const a = await completed(common, 'fixture-one', 'Run the relevant tests for startup.', 'build-verification');
  const b = await completed(common, 'fixture-two', 'Run the relevant tests for startup.', 'build-verification');
  await common.feedback(a.id, { outcome: 'accepted', feedback: 'Looks acceptable.' });
  assert.equal(common.list().find(agent => agent.id === 'build-verification').outcomes.verified, 0);
  await assert.rejects(common.feedback(a.id, { outcome: 'verified', feedback: '' }), /evidence reference/);
  for (const run of [a, b]) await common.feedback(run.id, { outcome: 'needs-fix', feedback: 'Missed the startup failure in this isolated fixture.', failureKey: 'startup-check' });
  const summary = common.list().find(agent => agent.id === 'build-verification').outcomes;
  assert.deepEqual(summary.repeatFailures[0].taskIds, [a.id, b.id]);
  await common.revise('build-verification', { instructions: common.instructions('build-verification').text, reason: 'Address the startup failure recorded in the first fixture.', evidenceIds: [a.id] });
  assert.equal(b.reviewedAt, null); assert.equal(a.addressedByVersion, 2);
  const evidence = { reference: 'fixture://startup-check', check: 'Run fixture startup', result: 'Fixture startup rendered', sourceRevision: 'fixture-commit-123' };
  await common.feedback(a.id, { outcome: 'verified', feedback: 'Fixture repaired and checked.', evidence });
  const agent = common.list().find(agent => agent.id === 'build-verification');
  assert.equal(agent.outcomes.verified, 1); assert.equal(agent.outcomes.corrections, 2); assert.equal(agent.outcomes.repeatFailures.length, 1);
  assert.equal(agent.versionOutcomes.find(item => item.version === 2).verified, 0);
  assert.equal(a.evidence.version, 1); assert.equal(a.provenance.completionId, a.completionId);
  await common.close();
  const restored = await new CommonAgents({ stateDir: path.dirname(common.activityFile) }).init();
  assert.equal(restored.tasks[0].feedbackHistory.length, 3); await restored.close();
});

test('health records repeated observed delays once and keeps request bodies out of metrics', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'alpha-health-'));
  const alerts = [], health = await new Health(stateDir, issue => alerts.push(issue)).init();
  health.measure('/api/health', 100000, 200);
  for (let index = 0; index < 4; index++) health.measure('/api/transcribe', 35000, 200);
  await health.close();
  assert.equal(alerts.length, 1); assert.equal(health.snapshot().recentRequests.length, 4);
  assert.equal(health.issues[0].status, 'open');
  await health.resolve(health.issues[0].id);
  health.measure('/api/transcribe', 35000, 200);
  await health.close();
  assert.equal(alerts.length, 1, 'Resolving an issue resets its old failure window.');
  assert.equal((await new Health(stateDir).init()).issues[0].status, 'resolved');
});

test('project profiles retain different toolchains and skip excluded project records', async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'alpha-profiles-'));
  for (const id of ['android', 'windows']) await mkdir(path.join(repo, 'projects', id), { recursive: true });
  await writeFile(path.join(repo, 'projects/android/project.json'), JSON.stringify({ development: { framework: 'Java Android Views', sourceFolder: 'C:/Android', buildCommand: './gradlew assembleRelease' } }));
  await writeFile(path.join(repo, 'projects/windows/project.json'), JSON.stringify({ source: { language: 'Rust', checkout: 'C:/Windows' }, development: { qualityCommand: 'cargo xtask ci' } }));
  const profiles = await projectProfiles(repo, { entities: ['android', 'windows', 'mooseville'].map(id => ({ id, title: id })) }, { excludedProjects: ['mooseville'] });
  assert.equal(profiles[0].technology, 'Java Android Views'); assert.equal(profiles[1].commands.qualityCommand, 'cargo xtask ci');
  assert.deepEqual(profiles[2], { id: 'mooseville', title: 'mooseville', excluded: true });
});
