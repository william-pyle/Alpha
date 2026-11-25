import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createService } from '../server.mjs';

export const sourceProject = 'artifact-source';
export const destinationProject = 'artifact-destination';
export const thirdPartyProject = 'artifact-third-party';
export const fixtureText = 'Unique fixture content visible in the resulting artifact only.';
const projectIds = [sourceProject, destinationProject, thirdPartyProject, 'mooseville'];
const hash = content => createHash('sha256').update(content).digest('hex');
const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const layouts = { skill: '.agents/skills', knowledge: 'knowledge', agent: '.claude/agents' };

function artifactDirectory(projectRoot, kind, artifactId) {
  assert.ok(Object.hasOwn(layouts, kind));
  assert.match(artifactId, slug);
  const parent = path.join(projectRoot, layouts[kind]);
  return kind === 'skill' ? path.join(parent, artifactId) : parent;
}

async function exists(target) {
  return lstat(target).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
}

export async function artifactFixture() {
  const temp = await realpath(tmpdir());
  const repo = await mkdtemp(path.join(temp, 'alpha-worker-artifact-'));
  const root = projectId => {
    assert.ok(projectIds.includes(projectId));
    return path.join(repo, 'projects', projectId, 'workspace');
  };
  const artifactPath = (projectId, kind, artifactId, filename = kind === 'skill' ? 'SKILL.md' : artifactId + '.md') => {
    assert.match(filename, /^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/);
    assert.ok(!filename.split('/').some(part => part === '.' || part === '..'));
    return path.join(artifactDirectory(root(projectId), kind, artifactId), filename);
  };
  const put = async (projectId, kind, artifactId, contents, filename) => {
    const target = artifactPath(projectId, kind, artifactId, filename);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
    return target;
  };
  const entities = projectIds.map(id => ({
    id, title: id, folder: id, workspacePath: `projects/${id}/workspace`, steps: [],
    ...(id === sourceProject ? { projectRepositoryUrl: 'https://github.com/william-pyle/fixture' } : {}),
    ...(id === thirdPartyProject ? { projectRepositoryUrl: 'https://github.com/storytold/fixture' } : {}),
  }));
  let service, sourceRepositoryOwner = 'william-pyle';
  const workers = [], terminalEffects = [], fileEffects = [], nativeCalls = [];
  const osBlocked = new Set();
  const close = async () => {
    for (const session of workers) session.process = null;
    if (service) {
      await service.close();
      service = null;
    }
  };
  const cleanup = async () => {
    try { await close(); }
    finally {
      const actual = await realpath(repo);
      assert.equal(path.dirname(actual), temp);
      assert.match(path.basename(actual), /^alpha-worker-artifact-[a-z\d]+$/i);
      await rm(actual, { recursive: true, force: true });
    }
  };

  async function collect(directory, relative = '') {
    const contents = [];
    for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
      const filename = [relative, entry.name].filter(Boolean).join('/');
      if (entry.isSymbolicLink()) throw Object.assign(new Error('A linked fixture is ineligible.'), { status: 403 });
      if (entry.isDirectory()) contents.push(...await collect(directory, filename));
      else if (entry.isFile()) contents.push({ path: filename, contents: await readFile(path.join(directory, filename), 'utf8') });
    }
    return contents.sort((a, b) => a.path.localeCompare(b.path));
  }

  async function native(event) {
    if (event.type !== 'worker-artifact-operation') return;
    nativeCalls.push({ action: event.action, kind: event.kind, artifactId: event.artifactId });
    const reply = { type: event.type, requestId: event.requestId };
    try {
      const { sourceProjectId, destinationProjectId, kind, artifactId } = event;
      assert.equal(sourceProjectId, sourceProject);
      assert.equal(destinationProjectId, destinationProject);
      const source = artifactPath(sourceProjectId, kind, artifactId);
      const destination = artifactPath(destinationProjectId, kind, artifactId);
      const slot = kind === 'skill' ? path.dirname(destination) : destination;
      if (await exists(slot)) throw Object.assign(new Error('Destination fixture already exists.'), { status: 409, reason: 'collision' });
      const files = kind === 'skill'
        ? await collect(path.dirname(source))
        : [{ path: artifactId + '.md', contents: await readFile(source, 'utf8') }];
      const sourceRevision = hash(JSON.stringify(files));
      const destinationRevision = hash(`absent in ${destinationProjectId}`);
      if (event.action === 'scan') {
        reply.result = { sourceRevision, destinationRevision, files };
      } else {
        assert.equal(event.action, 'apply');
        if (event.sourceRevision !== sourceRevision || event.destinationRevision !== destinationRevision) {
          throw Object.assign(new Error('Reviewed fixture changed.'), { status: 409 });
        }
        if (osBlocked.has(artifactId)) {
          throw Object.assign(new Error('Windows refused synthetic artifact access.'), { status: 403, access: 'os-permission' });
        }
        assert.ok(Array.isArray(event.files) && event.files.length > 0);
        for (const entry of event.files) {
          const target = artifactPath(destinationProjectId, kind, artifactId, entry.path);
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(target, entry.contents, { flag: 'wx' });
        }
        fileEffects.push(kind + ':' + artifactId);
        reply.result = { applied: true };
      }
    } catch (error) {
      if (error instanceof assert.AssertionError) throw error;
      reply.status = error.status || (error.code === 'ENOENT' ? 404 : 503);
      if (reply.status === 409) reply.reason = error.reason || 'changed';
      if (error.access) reply.access = error.access;
      reply.error = 'Synthetic artifact boundary rejected the operation.';
    }
    service.nativeMessage(reply);
  }

  const start = async () => {
    service = await createService({
      repo, uiDir: path.resolve('dist'), initializeProjects: false, mcpOptions: { home: repo, env: {} }, native,
      repositoryOptions: {
        async execute(command, args) {
          assert.equal(command, 'gh');
          const requested = args.at(-1);
          assert.ok(['repos/storytold/fixture', 'repos/william-pyle/fixture'].includes(requested));
          const login = requested === 'repos/william-pyle/fixture' ? sourceRepositoryOwner : 'storytold';
          const fullName = login + '/fixture';
          return { stdout: JSON.stringify({ id: login === 'william-pyle' ? 1234 : 5678,
            full_name: fullName, html_url: 'https://github.com/' + fullName, owner: { login }, private: false }) };
        },
      },
    });
    return service;
  };

  try {
    for (const projectId of projectIds) {
      for (const layout of Object.values(layouts)) await mkdir(path.join(root(projectId), layout), { recursive: true });
    }
    await writeFile(path.join(repo, 'workspace.json'), JSON.stringify({ entities }));
    await start();
  } catch (error) {
    await cleanup();
    throw error;
  }

  function newTask(worker) {
    const turn = randomUUID();
    service.sessions.nativeEvent(worker.session, { kind: 'turn-started', source: 'provider-record', nativeTaskId: turn, eventKey: turn });
  }
  function worker(projectId, existing) {
    const session = service.sessions.make({
      id: existing?.session.id || randomUUID(), nativeId: existing?.session.nativeId || randomUUID(), alphaThreadId: existing?.thread.id,
      name: `Worker for ${projectId}`, agent: 'codex', cwd: root(projectId), projectId, open: true, status: 'running', startedAt: Date.now(),
    });
    workers.push(session);
    service.sessions.items.set(session.id, session);
    const thread = service.threads.observe(session);
    session.process = { write() { terminalEffects.push('write'); }, kill() { terminalEffects.push('kill'); } };
    const grant = service.sessions.issueWorkerBridge(session);
    assert.ok(grant);
    grant.attach(session.process);
    const managed = { session, thread, token: grant.token };
    newTask(managed);
    return managed;
  }

  async function call(token, route, body, expected = 200) {
    const response = await fetch(service.origin + route, {
      method: body ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const result = await response.json();
    assert.equal(response.status, expected, JSON.stringify(result));
    assert.ok(!JSON.stringify(result).includes(fixtureText), 'Artifact content must stay out of request responses.');
    return result;
  }
  const owner = (route, body, expected) => call(service.token, route, body, expected);
  const request = (managed, body, expected) => call(managed.token, '/worker-request', body, expected);
  const result = (managed, receiptId, expected) => request(managed, { kind: 'result', receiptId }, expected);
  const questions = () => owner('/api/questions');
  async function settle(managed, receiptId, wanted) {
    const deadline = Date.now() + 5000;
    let receipt;
    do {
      receipt = await result(managed, receiptId);
      if (receipt.status === wanted) return receipt;
      await delay(50);
    } while (Date.now() < deadline);
    assert.fail(`Receipt expected ${wanted} but stayed ${receipt.status}`);
  }
  return { get service() { return service; }, repo, root, put, artifactPath, start, close, cleanup, worker, newTask, call, owner, request, result, questions,
    settle, nativeCalls, terminalEffects, fileEffects, blockArtifact: id => osBlocked.add(id),
    transferSourceRepository: () => { sourceRepositoryOwner = 'storytold'; } };
}

export const importRequest = (kind, artifactId, requestKey = `copy-${kind}-${artifactId}`, sourceProjectId = sourceProject) => ({
  kind: 'request', requestKey, action: 'import-artifact', arguments: { sourceProjectId, kind, artifactId },
});

export const frontmatter = (id, body = fixtureText) => `---\nname: ${id}\ndescription: Reusable fixture definition.\n---\n\n${body}\n`;
