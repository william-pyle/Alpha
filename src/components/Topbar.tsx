import type { CardCategory, WorkspaceEntity } from '../types'
import { isDesktop } from '../desktop/client'
import BrowserSettings from './BrowserSettings'
import NewCard from './NewCard'
import { EntityStatusButton } from './EntityControls'
import CategoryManager from './CategoryManager'

interface TopbarProps {
  mdi?: boolean
  categories: CardCategory[]
  entities: WorkspaceEntity[]
  onCategoriesChanged: () => Promise<void>
  entity: WorkspaceEntity | null
  stepIndex: number
  onStep: (id: string, index: number) => void
  onHome: () => void
  reportUrl: string | null
}

export default function Topbar({ mdi = false, entity, categories, entities, onCategoriesChanged, stepIndex, onStep, onHome, reportUrl }: TopbarProps) {
  if (mdi) return entity && entity.steps.length > 1 ? <nav className="mdi-document-nav" aria-label="Document pages">
    {entity.steps.map((step, index) => <button key={index} type="button" aria-current={index === stepIndex ? 'page' : undefined} onClick={() => onStep(entity.id, index)}>{step.name}</button>)}
  </nav> : null
  return (
    <div className="topbar">
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <button className="crumb-link" onClick={onHome}>
          Workspace
        </button>
        {entity && (
          <>
            <span className="crumb-sep">/</span>
            <span className="crumb-current">{entity.title}</span>
            <EntityStatusButton entity={entity} />
          </>
        )}
        {isDesktop && <NewCard />}
        {isDesktop && !mdi && <CategoryManager categories={categories} entities={entities} onChanged={onCategoriesChanged} />}
        {!isDesktop && <BrowserSettings />}
      </nav>

      {entity && (
        <div className="topbar-right">
          {entity.steps.length > 0 && (
            <div className="step-tabs" role="tablist">
              {entity.steps.map((s, i) => (
                <button
                  key={i}
                  role="tab"
                  aria-selected={i === stepIndex}
                  className={`step-tab${i === stepIndex ? ' active' : ''}`}
                  onClick={() => onStep(entity.id, i)}
                  title={s.name}
                >
                  {s.name}
                </button>
              ))}
            </div>
          )}
          {reportUrl && (
            <a
              className="open-ext"
              href={reportUrl}
              target="_blank"
              rel="noreferrer"
              title="Open report in a new tab"
            >
              ↗
            </a>
          )}
        </div>
      )}
    </div>
  )
}
