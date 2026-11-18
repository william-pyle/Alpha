import type { CardCategory, WorkspaceEntity } from '../types'
import { categoryIcon, categoryName } from '../lib/categories'
import { ARCHIVED_GROUP, type WorkspaceGroup, type WorkspaceFilters } from '../lib/workspace-groups'
import MakCard from './MakCard'

interface HomeGridProps {
  entities: WorkspaceEntity[]
  categories: CardCategory[]
  pinned: WorkspaceEntity[]
  grouped: Map<WorkspaceGroup, WorkspaceEntity[]>
  offline: boolean
  searching: boolean
  filters: WorkspaceFilters
  onFilters: (filters: WorkspaceFilters) => void
}

export default function HomeGrid({
  categories,
  pinned,
  grouped,
  offline,
  filters,
  onFilters,
}: HomeGridProps) {
  const shown = pinned.length + [...grouped.values()].reduce((n, list) => n + list.length, 0)

  return (
    <div className="home">
      <div className="workspace-home-toolbar mdi-document-nav" role="search" aria-label="Workspace card filters">
        <label>Scope<select aria-label="Workspace scope" title="Active includes all non-archived cards, including done cards" value={filters.scope} onChange={event => onFilters({ ...filters, scope: event.target.value as WorkspaceFilters['scope'] })}><option value="active">Active</option><option value="archived">Archived</option><option value="all">All</option></select></label>
        <label>Category<select aria-label="Workspace category" value={filters.category} onChange={event => onFilters({ ...filters, category: event.target.value })}><option value="">All categories</option>{categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
        <label className="workspace-card-search">Search<input aria-label="Search cards" type="search" value={filters.query} onChange={event => onFilters({ ...filters, query: event.target.value })} placeholder="Search selected scope" /></label>
        {filters.query && <button aria-label="Clear card search" onClick={() => onFilters({ ...filters, query: '' })}>Clear</button>}
      </div>
      {offline && <p role="status">Workspace is offline; showing the last saved cards.</p>}
      {pinned.length > 0 && (
        <section className="home-section">
          <div className="section-head">
            <span className="section-title">{'\u{1F4CC}'} pinned</span>
            <span className="section-count">{pinned.length}</span>
          </div>
          <div className="card-grid">
            {pinned.map(e => (
              <MakCard key={e.id} entity={e} categories={categories} />
            ))}
          </div>
        </section>
      )}

      {[...grouped.entries()].map(([cat, list]) => (
        <section key={cat === ARCHIVED_GROUP ? ":virtual-archive" : `category:${cat}`} className="home-section" data-workspace-group={cat === ARCHIVED_GROUP ? "Archived" : cat}>
          <div className="section-head">
            <span className="section-title">
              {cat === ARCHIVED_GROUP ? 'Archived' : `${categoryIcon(cat, categories)} ${categoryName(cat, categories)}`}
            </span>
            <span className="section-count">{list.length}</span>
          </div>
          <div className="card-grid">
            {list.map(e => (
              <MakCard key={e.id} entity={e} categories={categories} />
            ))}
          </div>
        </section>
      ))}

      {shown === 0 && <p className="home-empty" role="status">No cards match these filters.</p>}

    </div>
  )
}
