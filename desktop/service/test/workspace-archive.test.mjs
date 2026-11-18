import test from 'node:test';
import assert from 'node:assert/strict';
import { ARCHIVED_GROUP, isWorkspaceArchived, workspaceGroups } from '../../../src/lib/workspace-groups.ts';

test('virtual archive preserves exact status/age/pin/sample cutoff and category grouping without mutation', () => {
  const base = { title: 'Card', description: 'Fixture', category: 'design', status: 'active', created: '2026-11-10' };
  const entities = [
    { ...base, id: 'fresh-design', updated: '2026-11-17' },
    { ...base, id: 'fresh-code', category: 'code', updated: '2026-11-16' },
    { ...base, id: 'cutoff-equal' },
    { ...base, id: 'old', created: '2026-11-09' },
    { ...base, id: 'old-pin', created: '2020-01-01', pinned: true },
    { ...base, id: 'old-sample', created: '2020-01-01', sample: true },
    { ...base, id: 'explicit-pin', status: 'archived', pinned: true },
    { ...base, id: 'updated-old', created: '2020-01-01', updated: '2026-11-17' },
  ];
  const original = structuredClone(entities), cutoff = '2026-11-10';
  assert.deepEqual(entities.filter(entity => isWorkspaceArchived(entity, cutoff)).map(entity => entity.id), ['old', 'explicit-pin']);
  const off = workspaceGroups(entities, { scope: 'active', category: '', query: '' }, cutoff), on = workspaceGroups(entities, { scope: 'all', category: '', query: '' }, cutoff);
  assert.deepEqual(on.pinned.map(entity => entity.id), ['old-pin']);
  assert.deepEqual([...on.grouped].filter(([key]) => key !== ARCHIVED_GROUP), [...off.grouped]);
  assert.deepEqual(on.grouped.get(ARCHIVED_GROUP).map(entity => entity.id), ['explicit-pin', 'old']);
  const shown = [...on.pinned, ...[...on.grouped.values()].flat()].map(entity => entity.id);
  assert.equal(new Set(shown).size, entities.length); assert.equal(shown.length, entities.length); assert.deepEqual(entities, original);
  const searched = workspaceGroups(entities, { scope: 'all', category: '', query: 'old' }, cutoff);
  assert(searched.grouped.has('design')); assert(searched.grouped.has(ARCHIVED_GROUP));
  assert.equal(workspaceGroups(entities, { scope: 'active', category: '', query: 'explicit-pin' }, cutoff).grouped.size, 0);
  assert.deepEqual(workspaceGroups(entities, { scope: 'archived', category: 'code', query: '' }, cutoff).grouped.get(ARCHIVED_GROUP), []);
  assert.equal(workspaceGroups([], { scope: 'archived', category: '', query: '' }, cutoff).grouped.get(ARCHIVED_GROUP).length, 0);
  assert.equal(workspaceGroups([], { scope: 'active', category: '', query: '' }, cutoff).grouped.size, 0);
  const restored = entities.map(entity => entity.id === 'explicit-pin' ? { ...entity, status: 'active' } : entity);
  assert.equal(workspaceGroups(restored, { scope: 'all', category: '', query: '' }, cutoff).pinned.find(entity => entity.id === 'explicit-pin').category, 'design');
});
