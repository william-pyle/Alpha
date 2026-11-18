import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Workspace } from '../workspace.mjs';
import { Threads } from '../threads.mjs';

test('undo persists, restores original fields, preserves IDs/routes/files and refuses newer changes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'alpha-undo-')); await mkdir(path.join(root, 'workspace'));
  const file = path.join(root, 'workspace/workspace.json');
  const card = { id: 'one', title: 'One', status: 'active', category: 'design', folder: 'original', steps: [{ name: 'Report', path: 'report.html' }], custom: 'preserved' };
  await writeFile(file, JSON.stringify({ entities: [card] }));
  let workspace = new Workspace(root);
  const archived = await workspace.update('one', { status: 'archived', category: 'code' }); assert.ok(archived.undoId);
  workspace = new Workspace(root); await workspace.undo(archived.undoId);
  let saved = JSON.parse(await readFile(file)).entities[0];
  for (const key of Object.keys(card)) assert.deepEqual(saved[key], card[key]);
  await assert.rejects(workspace.undo(archived.undoId), /no longer available/);
  const changed = await workspace.update('one', { category: 'code' }); await workspace.update('one', { category: 'design' });
  await assert.rejects(workspace.undo(changed.undoId), /newer edits/);
  const next = await workspace.update('one', { status: 'archived' });
  saved = JSON.parse(await readFile(file)); saved.entities[0].custom = 'External edit'; await writeFile(file, JSON.stringify(saved));
  await assert.rejects(workspace.undo(next.undoId), /newer edits/); assert.equal(JSON.parse(await readFile(file)).entities[0].custom, 'External edit');
});

test('conversation search covers full saved history, paginates and only returns requested thread', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'alpha-thread-search-'));
  const threads = new Threads(root); const a = threads.create({ name: 'Search older messages', projectId: 'one' }), b = threads.create({ name: 'Private other thread', projectId: 'two' });
  for (let i = 0; i < 160; i++) threads.message(a.id, { id: `m${i}`, role: 'assistant', text: `needle ${i} <script>plain reference</script>` }, false);
  threads.message(b.id, { id: 'secret', role: 'assistant', text: 'needle other private content' }, false);
  assert.equal(threads.search(a.id, 'needle').total, 160); assert.equal(threads.search(a.id, 'needle', 150).matches.length, 10);
  assert.equal(threads.search(a.id, 'needle', 150).matches[0].id, 'm150'); assert.equal(threads.search(a.id, 'private').total, 0);
  assert.equal(threads.search(a.id, '').total, 0);
  await threads.close();
});

test('conversation archive undo preserves drafts and native binding, rejects newer metadata and survives restart', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'alpha-thread-undo-'));
  let threads = new Threads(root); await threads.init();
  const a = threads.create({ name: 'Preserve original work', projectId: 'one' }); a.sessionIds = ['exact-native-worker']; a.draft = { text: 'Keep this draft', paths: [] };
  const undoId = threads.patch(a.id, { archived: true }).archiveUndo.id; await threads.close();
  threads = await new Threads(root).init(); threads.undoArchive(a.id, undoId); assert.equal(threads.get(a.id).archived, false); assert.equal(threads.get(a.id).draft.text, 'Keep this draft'); assert.deepEqual(threads.get(a.id).sessionIds, ['exact-native-worker']);
  const stale = threads.patch(a.id, { archived: true }).archiveUndo.id; threads.patch(a.id, { purpose: 'Newer choice' }); assert.throws(() => threads.undoArchive(a.id, stale), /newer edits/); await threads.close();
});
