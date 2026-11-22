import type { CardCategory, WorkspaceEntity } from '../types'
import { entityHash } from '../lib/route'
import { categoryIcon } from '../lib/categories'
import { contentUrl } from '../desktop/client'
import { EntityStatusButton } from './EntityControls'
import { ProjectStorageSize } from './ProjectStorage'
import { githubRepository } from '../../desktop/service/github-repository.mjs'

function configuredRepository(value?: string) {
  if (!value) return null
  try { return githubRepository(value) }
  catch { return null }
}

/**
 * The design-system card: glass surface over the aura, gradient edge
 * (pink→purple; amber when pinned), glow + lift on hover. Building
 * block of the home grid; mirrored as `.mak-card` in
 * scripts/shared/report_style.py for generated reports.
 */
export default function MakCard({ entity, categories }: { entity: WorkspaceEntity; categories: CardCategory[] }) {
  const tabCount = entity.steps.length
  const repository = configuredRepository(entity.projectRepositoryUrl)
  return (
    <div className="entity-card-wrap" data-card={entity.id}>
    <a
      href={entityHash(entity.id)}
      className={`mak-card entity-card${entity.pinned ? ' pinned' : ''}`}
      data-entity={entity.id}
    >
      <div className="card-top">
        <span className="chip">
          <span aria-hidden="true">{categoryIcon(entity.category, categories)}</span>
          {categories.find(item => item.id === entity.category)?.name ?? entity.category ?? 'Other'}
        </span>
        {entity.pinned && <span className="chip chip-pin">pinned</span>}
      </div>

      <div className="card-project-title">
        {entity.icon && <img className="card-project-icon" src={contentUrl(`/workspace/${entity.folder}/${entity.icon}`)} width="48" height="48" alt="" loading="lazy" decoding="async" />}
        <h3 className="card-title">{entity.title}</h3>
      </div>

      {entity.description && <p className="card-desc">{entity.description}</p>}

      <div className="card-foot">
        <span>
          {tabCount} tab{tabCount === 1 ? '' : 's'}
        </span>
        <span>·</span>
        <ProjectStorageSize id={entity.id} />
        <span className="card-open" aria-hidden="true">
          open →
        </span>
      </div>
    </a>
    <div className="entity-card-actions">
      {repository && <a className="entity-github-link" aria-label="Open GitHub repository" title={'Open ' + repository.fullName + ' on GitHub'} href={repository.url} target="_blank" rel="noopener noreferrer">
        <svg viewBox="0 0 16 16" width="17" height="17" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.65 7.65 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8 8 0 0 0 16 8c0-4.42-3.58-8-8-8Z" /></svg>
      </a>}
      <EntityStatusButton entity={entity} />
    </div>
    </div>
  )
}
