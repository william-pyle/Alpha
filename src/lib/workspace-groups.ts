import type { WorkspaceEntity } from '../types'

// A virtual display key can never collide with or replace a stored category ID.
export const ARCHIVED_GROUP = Symbol('Archived')
export type WorkspaceGroup = string | typeof ARCHIVED_GROUP
const lastTouched = (entity: WorkspaceEntity) => entity.updated ?? entity.created
const byFreshness = (a: WorkspaceEntity, b: WorkspaceEntity) => lastTouched(b).localeCompare(lastTouched(a)) || (a.status === 'active' ? 0 : 1) - (b.status === 'active' ? 0 : 1)
// Preserve the existing seven-day policy, including strict cutoff, pins and samples.
export const isWorkspaceArchived = (entity: WorkspaceEntity, cutoff: string) => entity.status === 'archived' || (!entity.pinned && !entity.sample && lastTouched(entity) < cutoff)

export interface WorkspaceFilters { scope: 'active' | 'archived' | 'all'; category: string; query: string }
export function workspaceGroups(entities: WorkspaceEntity[], filters: WorkspaceFilters, cutoff: string) {
  const q = filters.query.trim().toLowerCase(), searching = !!q
  const matches = (entity: WorkspaceEntity) => !searching || [entity.title, entity.description, entity.category, entity.id].some(value => value?.toLowerCase().includes(q))
  const visible = entities.filter(entity => matches(entity) && (!filters.category || (entity.category || 'other') === filters.category))
  const active = filters.scope === 'archived' ? [] : visible.filter(entity => !isWorkspaceArchived(entity, cutoff)).sort(byFreshness)
  const pinned = active.filter(entity => entity.pinned)
  const grouped = new Map<WorkspaceGroup, WorkspaceEntity[]>()
  for (const entity of active.filter(entity => !entity.pinned)) {
    const category = entity.category || 'other'
    if (!grouped.has(category)) grouped.set(category, [])
    grouped.get(category)!.push(entity)
  }
  // Scope, original category and search are intersected; search never overrides scope.
  const archived = visible.filter(entity => isWorkspaceArchived(entity, cutoff)).sort(byFreshness)
  if (filters.scope !== 'active' && (archived.length || filters.scope === 'archived')) grouped.set(ARCHIVED_GROUP, archived)
  return { pinned, grouped }
}
