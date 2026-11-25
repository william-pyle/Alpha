import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { useWorkspace, archiveCutoff } from './lib/workspace'
import { parseHash, entityHash, resolveStep, type Route } from './lib/route'
import MakLogo from './components/MakLogo'
import Sidebar from './components/Sidebar'
import Topbar from './components/Topbar'
import HomeGrid from './components/HomeGrid'
import EntityControls from './components/EntityControls'
import ReportBoundary from './components/ReportBoundary'
import WorkspaceToolControls from './components/WorkspaceToolControls'
import { workspaceGroups, type WorkspaceFilters } from './lib/workspace-groups'
import { api, reportError, contentUrl, isDesktop, useDesktop } from './desktop/client'

const Compare3D = lazy(() => import('./components/Compare3D'))
const ReportViewer = lazy(() => import('./components/ReportViewer'))
const EditableCard = lazy(() => import('./components/EditableCard'))

export default function App({ mdi = false }: { mdi?: boolean }) {
  const { workspace, offline, lastSync, reload } = useWorkspace()
  const [route, setRoute] = useState<Route>(parseHash)
  const desktop = useDesktop()
  const [filters, setFilters] = useState<WorkspaceFilters>(() => desktop.settings.workspaceFilters || (() => { try { return JSON.parse(localStorage.getItem('alpha.workspaceFilters') || 'null') } catch { return null } })() || { scope: 'active', category: '', query: '' })
  const query = filters.query
  const setQuery = (query: string) => setFilters(current => ({ ...current, query }))
  useEffect(() => {
    localStorage.setItem('alpha.workspaceFilters', JSON.stringify(filters))
    if (!isDesktop) return
    const timer = setTimeout(() => { void api('/settings', { workspaceFilters: filters }).catch(reportError) }, 180)
    return () => clearTimeout(timer)
  }, [filters])
  const [collapsed, setCollapsed] = useState(
    () => isDesktop || localStorage.getItem('mak.sidebarCollapsed') === '1',
  )
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    localStorage.setItem('mak.sidebarCollapsed', collapsed ? '1' : '0')
  }, [collapsed])

  const entities = workspace?.entities ?? []
  const categories = workspace?.categories ?? []
  const entity = entities.find(e => e.id === route.id) ?? null

  const resolvedStep = entity ? resolveStep(entity.steps.length, route.step, entity.defaultStep) : -1
  const stepIndex = entity?.steps[resolvedStep]?.removedAt && resolvedStep !== route.step
    ? entity.steps.reduce((last, step, index) => step.removedAt ? last : index, -1)
    : resolvedStep
  const step = entity?.steps[stepIndex]
  const reportUrl = entity && step ? contentUrl(`/workspace/${entity.folder}/${step.path}`) : null
  const overviewTools = isDesktop && step?.name.toLowerCase() === 'overview'
  const sharedDrive = isDesktop && entity?.id === 'author-ashlyn-brooks' && stepIndex === 8 && step?.path === 'shared-drive.html'

  // Hash → state: entity links navigate natively; this also covers back/forward.
  useEffect(() => {
    const onHash = () => { setRoute(parseHash()); if (isDesktop) setCollapsed(true) }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  // "/" focuses search; "[" toggles the sidebar (handy for a clean screen recording).
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const t = ev.target as HTMLElement | null
      const typing =
        t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
      if (typing) return
      if (ev.key === '/') {
        ev.preventDefault()
        searchRef.current?.focus()
      } else if (ev.key === '[') {
        ev.preventDefault()
        setCollapsed(v => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    document.title = entity ? `Alpha — ${entity.title}` : 'Alpha — Workspace'
  }, [entity])

  const goHome = useCallback(() => {
    history.pushState(null, '', window.location.pathname + window.location.search)
    setRoute({ id: null, step: -1 })
    window.dispatchEvent(new HashChangeEvent('hashchange'))
  }, [])

  const selectStep = useCallback((id: string, index: number) => {
    history.replaceState(null, '', entityHash(id, index))
    setRoute({ id, step: index })
    window.dispatchEvent(new HashChangeEvent('hashchange'))
  }, [])

  if (!workspace) {
    return (
      <div className="boot">
        <MakLogo size={76} />
      </div>
    )
  }

  const q = query.trim().toLowerCase()
  const searching = q.length > 0
  const { pinned, grouped } = workspaceGroups(entities, filters, archiveCutoff())

  return (
    <EntityControls entities={entities} categories={categories} onChanged={reload}>
    <div className={`app-layout${collapsed || mdi ? ' sidebar-collapsed' : ''}${mdi ? ' mdi-layout' : ''}`} data-entity={route.id}
      data-report-step={step && !step.removedAt ? stepIndex : undefined}
      data-report-binding={mdi && step && !step.removedAt ? JSON.stringify([step.id, step.path, step.viewer]) : undefined}>
      {!mdi && <Sidebar
        categories={categories}
        pinned={pinned}
        grouped={grouped}
        activeId={route.id}
        query={query}
        onQuery={setQuery}
        searchRef={searchRef}
        total={entities.length}
        offline={offline}
        lastSync={lastSync}
        onCollapse={() => setCollapsed(true)}
      />}

      {!mdi && <button
        className="sidebar-reopen"
        onClick={() => setCollapsed(false)}
        title="Show menu — press Alpha's nose ( [ )"
        aria-label="Show menu"
      >
        <MakLogo size={38} animated={route.id !== 'my-dream-game'} />
      </button>}

      <main className="main">
        <Topbar
          mdi={mdi}
          categories={categories}
          entities={entities}
          onCategoriesChanged={reload}
          entity={entity}
          stepIndex={stepIndex}
          onStep={selectStep}
          onHome={goHome}
          // A compare3d step's "report" is a JSON manifest — opening it raw in a
          // tab helps nobody, so the external link is hidden for those.
          reportUrl={step?.viewer === 'compare3d' || step?.viewer === 'card' ? null : reportUrl}
        />

        <div className="content">
          <div className="workspace-tool-layout">
          {step?.removedAt && <p role="status">This report is no longer listed in the project tabs. Its saved content is still available here.</p>}
          {overviewTools && entity?.tools?.length ? <WorkspaceToolControls key={entity.id} cardId={entity.id} /> : null}
          <div className="workspace-tool-body">
          <ReportBoundary key={reportUrl || 'home'} onHome={goHome}>
          {entity && reportUrl && step?.viewer === 'card' ? (
            <Suspense fallback={<div className="report-loading">Opening project…</div>}><EditableCard key={`${entity.id}:${stepIndex}`} url={reportUrl} entityId={entity.id} step={stepIndex} /></Suspense>
          ) : entity && reportUrl && step?.viewer === 'compare3d' ? (
            <Suspense fallback={<div className="boot"><MakLogo size={56} animated={false} /></div>}><Compare3D
              key={reportUrl}
              manifestUrl={reportUrl}
              baseUrl={reportUrl.slice(0, reportUrl.lastIndexOf('/'))}
            /></Suspense>
          ) : entity && reportUrl ? (
            <Suspense fallback={<div className="boot"><MakLogo size={56} animated={false} /></div>}><ReportViewer key={`${entity.id}:${stepIndex}:${reportUrl}`} url={reportUrl} title={step?.name ?? entity.title} relativePath={`${entity.workspacePath || `workspace/${entity.folder}`}/${step?.path}`} toolProject={isDesktop && !overviewTools ? entity : undefined} sharedDrive={sharedDrive} /></Suspense>
          ) : (
            <HomeGrid
              entities={entities}
              categories={categories}
              pinned={pinned}
              grouped={grouped}
              offline={offline}
              searching={searching}
              filters={filters}
              onFilters={changes => setFilters(current => ({ ...current, ...changes }))}
            />
          )}
          </ReportBoundary>
          </div>
          </div>
        </div>
      </main>
    </div>
    </EntityControls>
  )
}
