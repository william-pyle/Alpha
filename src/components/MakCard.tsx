import type { CardCategory, WorkspaceEntity } from '../types'
import { entityHash } from '../lib/route'
import { categoryIcon } from '../lib/categories'
import { contentUrl } from '../desktop/client'
import { EntityStatusButton } from './EntityControls'

/**
 * The design-system card: glass surface over the aura, gradient edge
 * (pink→purple; amber when pinned), glow + lift on hover. Building
 * block of the home grid; mirrored as `.mak-card` in
 * scripts/shared/report_style.py for generated reports.
 */
export default function MakCard({ entity, categories }: { entity: WorkspaceEntity; categories: CardCategory[] }) {
  const steps = entity.steps.length
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
          {steps} step{steps === 1 ? '' : 's'}
        </span>
        <span>·</span>
        <span>{entity.updated ?? entity.created}</span>
        <span className="card-open" aria-hidden="true">
          open →
        </span>
      </div>
    </a>
    <EntityStatusButton entity={entity} />
    </div>
  )
}
