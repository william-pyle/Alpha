import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkerProjectActions, validateProjectRequest } from '../worker-project-actions.mjs';
import { Projects } from '../projects.mjs';
import { Workspace } from '../workspace.mjs';
import { CardDocuments } from '../card-documents.mjs';
import { saveJson } from '../util.mjs';

const home = { projectId: 'project-a' };
const peer = { projectId: 'project-b' };

async function fixture(options = {}) {
  const repo = await realpath(await mkdtemp(path.join(os.tmpdir(), 'alpha-worker-projects-')));
  const entities = [home.projectId, peer.projectId, 'mooseville'].map(id => ({
    id, folder: id, workspacePath: 'projects/' + id + '/workspace', title: id, description: 'Preserve',
    category: 'research', status: 'active', defaultStep: 1, custom: { keep: true },
    steps: [
      { name: 'Overview', path: 'index.html' },
      { name: 'Review', path: 'review.md', custom: 'keep tab metadata' },
      { name: 'Evidence', path: 'evidence.md' },
    ],
  }));
  for (const entity of entities) {
    const destination = path.join(repo, entity.workspacePath);
    await mkdir(destination, { recursive: true });
    await Promise.all(entity.steps.map(step => writeFile(path.join(destination, step.path), step.name + ' body')));
  }
  await saveJson(path.join(repo, 'workspace.json'), { entities, custom: 'preserve registry metadata' });
  let changes = 0;
  const workspace = new Workspace(repo, () => changes++);
  const projects = new Projects(workspace), cards = new CardDocuments(workspace);
  const actions = new WorkerProjectActions({ workspace, projects, cards, ...options });
  const run = async (origin, action, data, approved = false) => {
    const { revision } = await actions.prepare(origin, action, data);
    return actions.apply(origin, action, data, { revision, approved });
  };
  return { repo, workspace, projects, cards, actions, run, changes: () => changes, entities };
}

test('creates a host-owned report, renames its stable identity and removes a reviewed tab from navigation without deleting content', async () => {
  const { repo, workspace, projects, cards, actions, run, changes, entities } = await fixture();
  const original = await actions.list(home);
  assert.equal(original.projectId, home.projectId);
  assert.deepEqual(original.tabs.map(item => item.stepIndex), [0, 1, 2]);
  assert.match(original.tabs[1].tabId, /^legacy-[\da-f]{64}$/);
  assert.deepEqual(Object.keys(original.tabs[1]).sort(), ['stepIndex', 'tabId', 'title']);

  const created = await run(home, 'create-report-tab', { projectId: home.projectId, title: 'New status' });
  assert.equal(created.stepIndex, 3);
  const seen = await projects.get(home.projectId);
  assert.deepEqual(seen.steps.slice(0, 3), entities[0].steps);
  assert.equal(seen.steps[3].id, created.tabId);
  assert.equal(await readFile(path.join(repo, seen.workspacePath, seen.steps[3].path), 'utf8'), '# Report\n\n');
  const renamed = await run(home, 'rename-report-tab', { projectId: home.projectId, tabId: original.tabs[1].tabId, title: 'Reviewed' });
  assert.deepEqual(renamed, { projectId: home.projectId, tabId: original.tabs[1].tabId, stepIndex: 1 });
  assert.equal((await projects.get(home.projectId)).steps[1].path, 'review.md');
  assert.equal((await actions.list(home)).tabs[1].title, 'Reviewed');

  const removal = { projectId: home.projectId, tabId: renamed.tabId };
  const plan = await actions.prepare(home, 'remove-report-tab', removal);
  assert.equal(plan.approval, true);
  assert.match(plan.review, /Reviewed.*project-a.*file and existing link are retained/);
  await assert.rejects(actions.apply(home, 'remove-report-tab', removal, { revision: plan.revision }), { status: 403 });
  assert.deepEqual(await actions.apply(home, 'remove-report-tab', removal, { revision: plan.revision, approved: true }), renamed);
  const restoredWorkspace = new Workspace(repo);
  const restored = new WorkerProjectActions({ workspace: restoredWorkspace, projects: new Projects(restoredWorkspace), cards });
  assert.deepEqual((await restored.list(home)).tabs.map(item => item.stepIndex), [0, 2, 3]);
  assert.deepEqual((await workspace.list({ query: home.projectId }))[0].steps.map(item => item.index), [0, 2, 3]);
  assert.equal((await workspace.read(home.projectId, 1)).text, 'Review body');
  const saved = await projects.get(home.projectId);
  assert.deepEqual(saved.steps[0], entities[0].steps[0]);
  assert.deepEqual(saved.steps[2], entities[0].steps[2]);
  assert.equal(saved.defaultStep, 1);
  assert.equal(saved.steps[1].custom, 'keep tab metadata');
  assert.deepEqual(await projects.get(peer.projectId), entities[1]);
  assert.equal(changes(), 3);
});

test('revocation at registry replacement leaves no report or persisted registry mutation', async () => {
  const { actions, projects, repo, entities } = await fixture();
  const request = { projectId: home.projectId, title: 'Revoked report' };
  const plan = await actions.prepare(home, 'create-report-tab', request);
  let authorityChecks = 0;
  const stillAuthorized = async () => ++authorityChecks < 4;
  await assert.rejects(actions.apply(home, 'create-report-tab', request, { ...plan, stillAuthorized }), { status: 403 });
  assert.deepEqual(await projects.get(home.projectId), entities[0]);
  assert.deepEqual((await readdir(path.join(repo, entities[0].workspacePath))).sort(), ['evidence.md', 'index.html', 'review.md']);
  assert.equal(authorityChecks, 4);
});

test('cross-project permission is exact, revision-bound and rechecked with exclusions and new edits', async () => {
  const blocked = new Set();
  const { actions, run, workspace, projects } = await fixture({ allowsProject: id => !blocked.has(id) });
  const update = { projectId: peer.projectId, patch: { status: 'done', pinned: true } };
  const proposed = await actions.prepare(home, 'update-project', update);
  assert.equal(proposed.approval, true);
  assert.match(proposed.review, /project-b.*status = done.*pinned = true/);
  await assert.rejects(actions.apply(home, 'update-project', update, { revision: proposed.revision }), { status: 403 });
  await assert.rejects(actions.apply(peer, 'update-project', update, { ...proposed, approved: true }), { status: 409 });
  await workspace.update(peer.projectId, { pinned: true });
  await assert.rejects(actions.apply(home, 'update-project', update, { ...proposed, approved: true }), { status: 409 });
  const fresh = await actions.prepare(home, 'update-project', update);
  blocked.add(peer.projectId);
  await assert.rejects(actions.apply(home, 'update-project', update, { ...fresh, approved: true }), { status: 403 });
  blocked.clear();
  assert.deepEqual(await actions.apply(home, 'update-project', update, { ...fresh, approved: true }), { projectId: peer.projectId });
  assert.equal((await projects.get(peer.projectId)).status, 'done');
  assert.equal((await projects.get(home.projectId)).status, 'active');
  await assert.rejects(actions.prepare(home, 'update-project', { projectId: 'mooseville', patch: { pinned: true } }), { status: 403 });
  await assert.rejects(actions.prepare(home, 'update-project', { projectId: peer.projectId, patch: { category: 'new-invented-category' } }), { status: 400 });

  const crossTab = { projectId: peer.projectId, tabId: 'step-1', title: 'Cross-project report' };
  const crossPlan = await actions.prepare(home, 'rename-report-tab', crossTab);
  await run(peer, 'rename-report-tab', { ...crossTab, title: 'Edited before approval' });
  await assert.rejects(actions.apply(home, 'rename-report-tab', crossTab, { ...crossPlan, approved: true }), { status: 409 });
  await run(home, 'rename-report-tab', crossTab, true);
  assert.equal((await actions.list(peer)).tabs[1].title, crossTab.title);
  assert.equal((await actions.list(home)).tabs[1].title, 'Review');
});

test('creates only a supported private project template and validates worker payloads', async () => {
  const { repo, actions, run, projects, cards } = await fixture();
  const request = { title: 'New project', template: 'research' };
  assert.ok(actions.validate('create-project', request));
  assert.equal(actions.validate('create-project', request, 'unexpected'), false);
  assert.equal((await actions.prepare(home, 'create-project', request)).approval, false);
  const { projectId } = await run(home, 'create-project', request);
  const project = await projects.get(projectId);
  assert.equal(project.title, request.title);
  assert.equal(project.workspacePath, 'projects/' + projectId + '/workspace');
  assert.equal((await cards.read(projectId, 0)).document.template, 'research');
  assert.ok((await lstat(path.join(repo, project.workspacePath, 'content.card.json'))).isFile());
  const invalid = [
    ['create-project', { ...request, repository: 'ignored' }],
    ['create-project', { ...request, template: 'custom' }],
    ['create-report-tab', { projectId: '../escape', title: 'Name' }],
    ['create-report-tab', { projectId: home.projectId, title: 'Name', path: '../credentials' }],
    ['rename-report-tab', { projectId: home.projectId, tabId: '2', title: 'Name' }],
    ['update-project', { projectId: home.projectId, patch: { workspacePath: '/outside' } }],
    ['update-project', { projectId: home.projectId, patch: { pinned: 'true' } }],
  ];
  for (const [action, payload] of invalid) assert.throws(() => validateProjectRequest(action, payload), { status: 400 });
  await assert.rejects(actions.prepare(home, 'remove-report-tab', { projectId, tabId: 'step-0' }), { status: 409 });
});

test('refuses linked report folders and preserves reserved Alpha report mappings', async () => {
  const { repo, projects, actions, run } = await fixture();
  await projects.transaction(registry => {
    const copy = structuredClone(registry.entities[0]);
    registry.entities.push({ ...copy, id: 'alpha', workspacePath: undefined, folder: 'alpha' });
    registry.entities.push({ ...copy, id: 'fixture-link', workspacePath: undefined, folder: 'linked' });
  });
  const external = await realpath(await mkdtemp(path.join(os.tmpdir(), 'outside-alpha-worker-projects-')));
  await mkdir(path.join(repo, 'workspace'));
  await symlink(external, path.join(repo, 'workspace', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(run(home, 'create-report-tab', { projectId: 'fixture-link', title: 'Denied' }, true), /symbolic link or junction/);
  assert.deepEqual(await readdir(external), []);
  await assert.rejects(actions.prepare(home, 'remove-report-tab', { projectId: 'alpha', tabId: 'step-1' }), { status: 403 });
});
