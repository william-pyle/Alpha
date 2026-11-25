import assert from 'node:assert/strict';
import { lstat, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { artifactFixture, destinationProject, fixtureText, frontmatter, importRequest, sourceProject, thirdPartyProject } from './worker-artifact-fixture.mjs';

const delivered = 'Approve this request';
const denied = 'Deny this request';
const read = target => readFile(target, 'utf8');
const absent = target => assert.rejects(lstat(target), { code: 'ENOENT' });
const forwardSlashes = value => value.split(path.sep).join('/');

async function review(fixture, worker, receipt) {
  assert.equal(receipt.status, 'pending-approval', JSON.stringify(receipt));
  const [question, anyOtherQuestion] = await fixture.questions();
  assert.equal(anyOtherQuestion, undefined);
  assert.equal(question.source, 'worker-approval');
  assert.equal(question.sourceId, receipt.receiptId);
  assert.equal(question.sessionId, worker.session.id);
  assert.equal(question.threadId, worker.thread.id);
  assert.deepEqual(question.options, [delivered, denied]);
  assert.match(question.context, /artifact-source/);
  assert.match(question.context, /artifact-destination/);
  assert.match(question.context, /william-pyle\/fixture/);
  return question;
}

test('exact skill, knowledge and agent imports require native Questions and preserve source bytes', async t => {
  const f = await artifactFixture();
  t.after(f.cleanup);
  const receiving = f.worker(destinationProject);
  const peer = f.worker(sourceProject);
  f.service.threads.select(peer.thread.id);

  const companion = await f.put(sourceProject, 'skill', 'fixture-skill', '# Fixture guide\n', 'references/guide.md');
  const licenseText = 'Fixture copyright 2026. Permission to copy with this notice.\n';
  const sourceLicense = await f.put(sourceProject, 'skill', 'fixture-skill', licenseText, 'LICENSE');
  const existingLicense = await read(sourceLicense);
  const manifest = 'interface:\n  display_name: "Fixture guide"\n  short_description: "View the copied fixture guide"\n';
  await f.put(sourceProject, 'skill', 'fixture-skill', manifest, 'agents/openai.yaml');
  const rawSkill = frontmatter('fixture-skill', `Read [the guide](<${forwardSlashes(companion)}>).\n\n${fixtureText}`);
  const rawAgent = frontmatter('fixture-agent', `Use [Working directory](<${forwardSlashes(f.root(sourceProject))}> "alpha-working-directory").\n\n${fixtureText}`);
  const entries = [
    { kind: 'skill', id: 'fixture-skill', source: rawSkill, verify: output => {
      assert.match(output, /\]\(<?(?:\.\/)?references\/guide\.md>?\)/);
      assert.ok(!output.includes(forwardSlashes(f.root(sourceProject))));
    } },
    { kind: 'knowledge', id: 'fixture-knowledge', source: `# Fixture knowledge\n\n${fixtureText}\n\n[Working directory](<${forwardSlashes(f.root(sourceProject))}> "alpha-working-directory")\n`, verify: output => {
      assert.match(output, /\]\(<?\.\.>? "alpha-working-directory"\)/);
      assert.ok(!output.includes(forwardSlashes(f.root(sourceProject))));
    } },
    { kind: 'agent', id: 'fixture-agent', source: rawAgent, verify: output => {
      assert.match(output, /\]\(<?\.\.\/\.\.>? "alpha-working-directory"\)/);
      assert.ok(!output.includes(forwardSlashes(f.root(sourceProject))));
    } },
  ];
  let firstApplied;
  for (const entry of entries) {
    f.newTask(receiving);
    const sourceFile = await f.put(sourceProject, entry.kind, entry.id, entry.source);
    const destinationFile = f.artifactPath(destinationProject, entry.kind, entry.id);
    const input = importRequest(entry.kind, entry.id);
    const receipt = await f.request(receiving, input);
    const question = await review(f, receiving, receipt);
    assert.match(question.context, new RegExp(entry.id));
    assert.deepEqual(await f.request(receiving, input), receipt);
    await f.result(peer, receipt.receiptId, 404);
    await f.call(receiving.token, `/api/questions/${question.id}/answer`, { answer: delivered }, 401);
    await absent(destinationFile);
    assert.match(question.context, entry.kind === 'skill' ? /references\/guide\.md/ : /Workspace root/);
    assert.doesNotMatch(question.context, /[A-Za-z]:[\\/]/);
    const answerUrl = `/api/questions/${question.id}/answer`;
    await f.owner(answerUrl, { answer: delivered });
    const applied = await f.settle(receiving, receipt.receiptId, 'applied');
    firstApplied ||= applied;
    assert.equal((await f.owner(answerUrl, { answer: delivered })).alreadyAccepted, true);
    assert.deepEqual(await f.request(receiving, input), applied);
    const saved = await read(destinationFile);
    assert.match(saved, /Unique fixture content/);
    entry.verify(saved);
    assert.equal(await read(sourceFile), entry.source);
  }

  assert.equal(await read(f.artifactPath(destinationProject, 'skill', 'fixture-skill', 'references/guide.md')), '# Fixture guide\n');
  assert.equal(await read(f.artifactPath(destinationProject, 'skill', 'fixture-skill', 'LICENSE')), licenseText);
  assert.equal(await read(f.artifactPath(destinationProject, 'skill', 'fixture-skill', 'agents/openai.yaml')), manifest);
  assert.equal(await read(sourceLicense), existingLicense);
  assert.deepEqual(f.fileEffects, ['skill:fixture-skill', 'knowledge:fixture-knowledge', 'agent:fixture-agent']);
  assert.deepEqual(f.terminalEffects, []);
  assert.equal(f.service.threads.selectedId, peer.thread.id);
  assert.deepEqual(await f.questions(), []);
  await f.service.threads.save();
  await f.close();
  await f.start();
  const resumed = f.worker(destinationProject, receiving);
  assert.deepEqual(await f.result(resumed, firstApplied.receiptId), firstApplied);
  await f.result(f.worker(sourceProject, peer), firstApplied.receiptId, 404);
  assert.deepEqual(await f.questions(), []);
});

test('artifact review rejects stale copies, collisions, missing references and unsafe donors', async t => {
  const f = await artifactFixture();
  t.after(f.cleanup);
  const receiving = f.worker(destinationProject);
  const run = async (kind, id, key, sourceId) => {
    f.newTask(receiving);
    return f.request(receiving, importRequest(kind, id, key, sourceId));
  };
  const answer = async (receipt, decision) => {
    const question = await review(f, receiving, receipt);
    await f.owner(`/api/questions/${question.id}/answer`, { answer: decision });
  };
  const failure = (receipt, status, reason) => {
    assert.equal(receipt.status, status, JSON.stringify(receipt));
    assert.equal(receipt.reason, reason, JSON.stringify(receipt));
  };

  const notes = await f.put(sourceProject, 'knowledge', 'stale-notes', '# Original source\n');
  const stale = await run('knowledge', 'stale-notes');
  await writeFile(notes, '# Changed after review\n');
  await answer(stale, delivered);
  await f.settle(receiving, stale.receiptId, 'stale');
  await absent(f.artifactPath(destinationProject, 'knowledge', 'stale-notes'));

  const collisionSource = '# Source to keep\n';
  await f.put(sourceProject, 'knowledge', 'collision', collisionSource);
  const uniqueTarget = await run('knowledge', 'collision');
  const existing = await f.put(destinationProject, 'knowledge', 'collision', '# Destination owner work\n');
  await answer(uniqueTarget, delivered);
  await f.settle(receiving, uniqueTarget.receiptId, 'stale');
  assert.equal(await read(existing), '# Destination owner work\n');
  assert.equal(await read(f.artifactPath(sourceProject, 'knowledge', 'collision')), collisionSource);
  failure(await run('knowledge', 'collision', 'already-exists'), 'stale', 'artifact-collision');
  await f.put(sourceProject, 'skill', 'occupied-skill', frontmatter('occupied-skill'));
  const unregistered = await f.put(destinationProject, 'skill', 'occupied-skill', '# Unregistered destination work\n', 'references/guide.md');
  failure(await run('skill', 'occupied-skill'), 'stale', 'artifact-collision');
  assert.equal(await read(unregistered), '# Unregistered destination work\n');
  await absent(f.artifactPath(destinationProject, 'skill', 'occupied-skill'));

  await f.put(sourceProject, 'agent', 'denied-agent', frontmatter('denied-agent'));
  const refused = await run('agent', 'denied-agent');
  await answer(refused, denied);
  await f.settle(receiving, refused.receiptId, 'owner-denied');
  await absent(f.artifactPath(destinationProject, 'agent', 'denied-agent'));

  await f.put(sourceProject, 'skill', 'missing-link', frontmatter('missing-link', 'Read [the guide](references/missing.md).'));
  failure(await run('skill', 'missing-link'), 'stale', 'artifact-reference');
  await absent(f.artifactPath(destinationProject, 'skill', 'missing-link'));
  await f.put(sourceProject, 'skill', 'protected-link', frontmatter('protected-link', 'Read [settings](../../../.env).'));
  failure(await run('skill', 'protected-link'), 'system-blocked', 'artifact-unsupported');
  await absent(f.artifactPath(destinationProject, 'skill', 'protected-link'));

  const fakeKey = 'api_key = "synthetic-fixture-key-value-do-not-copy"';
  await f.put(sourceProject, 'knowledge', 'secret-fixture', '# Fixture secret\n\n' + fakeKey + '\n');
  const secret = await run('knowledge', 'secret-fixture');
  failure(secret, 'system-blocked', 'artifact-unsupported');
  assert.doesNotMatch(JSON.stringify(secret), /synthetic-fixture-key-value-do-not-copy/);
  await absent(f.artifactPath(destinationProject, 'knowledge', 'secret-fixture'));

  if (process.platform === 'win32') {
    const linked = f.artifactPath(sourceProject, 'skill', 'linked-companion', 'references');
    await f.put(sourceProject, 'skill', 'linked-companion', frontmatter('linked-companion', 'Read [the guide](references/collision.md).'));
    await symlink(path.dirname(existing), linked, 'junction');
    failure(await run('skill', 'linked-companion'), 'system-blocked', 'artifact-unsupported');
    await absent(f.artifactPath(destinationProject, 'skill', 'linked-companion'));
  }

  const before = f.nativeCalls.length;
  failure(await run('knowledge', 'opaque', 'third-party', thirdPartyProject), 'system-blocked', 'artifact-provenance');
  failure(await run('knowledge', 'opaque', 'excluded-project', 'mooseville'), 'system-blocked', 'artifact-provenance');
  assert.equal(f.nativeCalls.length, before, 'Project exclusions must reject before native artifact scan.');
  failure(await run('knowledge', 'opaque', 'home-source', destinationProject), 'system-blocked', 'artifact-destination');
  assert.equal(f.nativeCalls.length, before, 'An import must resolve to a different source project.');
  await f.request(receiving, importRequest('knowledge', '../collision'), 400);
  await f.request(receiving, { ...importRequest('knowledge', 'collision'), arguments: {
    ...importRequest('knowledge', 'collision').arguments, destinationProjectId: sourceProject,
  } }, 400);

  const rechecked = await f.put(sourceProject, 'knowledge', 'rechecked', '# Keep this on the source\n');
  const lostProvenance = await run('knowledge', 'rechecked');
  f.transferSourceRepository();
  await answer(lostProvenance, delivered);
  failure(await f.settle(receiving, lostProvenance.receiptId, 'system-blocked'), 'system-blocked', 'artifact-provenance');
  await absent(f.artifactPath(destinationProject, 'knowledge', 'rechecked'));
  assert.equal(await read(rechecked), '# Keep this on the source\n');
  assert.deepEqual(await f.questions(), []);
  assert.deepEqual(f.fileEffects, []);
  assert.deepEqual(f.terminalEffects, []);
});
