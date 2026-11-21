import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { CardCategory, WorkspaceEntity } from '../types'
import { updateWorkspaceEntity, type EntityPatch } from '../lib/workspace'
import ProjectSettings from '../desktop/ProjectSettings'
import ConversationDialog from '../desktop/ConversationDialog'
import ConversationContextMenu from '../desktop/ConversationContextMenu'
import { api, isDesktop } from '../desktop/client'
import { formatBytes, ProjectStorageProvider, useProjectStorage } from './ProjectStorage'
import './entity-controls.css'

const labels = { active: 'Active', done: 'Done', archived: 'Archived' } as const
const Controls = createContext<{ open: (entity: WorkspaceEntity, button: HTMLElement) => void; editing: string | null } | null>(null)
type Target = { id: string; button: HTMLElement; anchor: DOMRect }
type BuildCleanupPreview = { id: string; root: string; candidates: { path: string; logicalBytes: number }[]; skipped?: { path: string; reason: string }[]; blockedReason?: string; previewToken: string }
type BuildCleanupResult = { removed: string[]; logicalBytes: number; message: string }
type DeletionPreview = { id: string; root: string; blockedReason?: string; retry?: boolean }

export function EntityStatusButton({ entity }: { entity: WorkspaceEntity }) {
  const controls = useContext(Controls)
  return (
    <button
      type="button"
      className="entity-status-button"
      aria-label={`Edit ${entity.title}: ${labels[entity.status]}`}
      aria-haspopup="dialog"
      aria-expanded={controls?.editing === entity.id}
      title={`${labels[entity.status]} · ${isDesktop ? 'Change status or category' : 'Open the desktop app to edit this project'}`}
      disabled={!isDesktop}
      onClick={event => controls?.open(entity, event.currentTarget)}
    >
      <span className={`status-dot ${entity.status}`} aria-hidden="true" />
    </button>
  )
}

function EntityMenu({ entity, categories, target, onClose, onChanged }: {
  entity: WorkspaceEntity
  categories: CardCategory[]
  target: Target
  onClose: () => void
  onChanged: () => Promise<void>
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const category = entity.category || 'other'

  useLayoutEffect(() => {
    const element = dialog.current!
    element.showModal()
    const position = () => {
      const rect = target.button.isConnected ? target.button.getBoundingClientRect() : target.anchor
      const width = element.offsetWidth, height = element.offsetHeight
      element.style.left = `${Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12))}px`
      element.style.top = `${Math.max(12, Math.min(rect.bottom + 6, window.innerHeight - height - 12))}px`
    }
    position()
    const observer = new ResizeObserver(position)
    observer.observe(element)
    window.addEventListener('resize', position)
    return () => { observer.disconnect(); window.removeEventListener('resize', position); element.close() }
  }, [target])

  useEffect(() => {
    const navigate = () => onClose()
    window.addEventListener('hashchange', navigate)
    return () => window.removeEventListener('hashchange', navigate)
  }, [onClose])

  async function save(patch: EntityPatch) {
    if (saving) return
    setSaving(true); setError('')
    try {
      await updateWorkspaceEntity(entity.id, patch)
      await onChanged()
      onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The project could not be updated. Try again.')
    } finally { setSaving(false) }
  }

  return createPortal(
    <dialog
      ref={dialog}
      className="entity-menu"
      aria-label={`Project settings: ${entity.title}`}
      aria-busy={saving}
      onCancel={event => { event.preventDefault(); if (!saving) onClose() }}
      onClick={event => {
        if (event.target !== event.currentTarget || saving) return
        const rect = event.currentTarget.getBoundingClientRect()
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose()
      }}
      onKeyDown={event => event.stopPropagation()}
    >
      <div className="entity-menu-heading">
        <div><span>Project settings</span><h2>{entity.title}</h2></div>
        <button type="button" className="entity-menu-close" aria-label="Close project settings" disabled={saving} onClick={onClose}>×</button>
      </div>
      <fieldset disabled={saving}>
        <legend>Status</legend>
        <div className="entity-status-options">
          {(Object.keys(labels) as Array<WorkspaceEntity['status']>).map(status => (
            <button type="button" key={status} aria-pressed={entity.status === status} onClick={() => void save({ status })}>
              <span className={`status-dot ${status}`} aria-hidden="true" />
              <span>{labels[status]}</span>
              <span className="entity-status-check" aria-hidden="true">{entity.status === status ? '✓' : ''}</span>
            </button>
          ))}
        </div>
      </fieldset>
      <label className="entity-category-control">
        Category
        <select aria-label="Project category" value={category} disabled={saving} onChange={event => void save({ category: event.target.value })}>
          {categories.map(item => <option key={item.id} value={item.id}>{item.icon} {item.name}</option>)}
        </select>
      </label>
      <button type="button" className="entity-pin-toggle" disabled={saving || !!entity.builtin} onClick={() => void save({ pinned: !entity.pinned })}>
        {entity.pinned ? 'Unpin project' : 'Pin project'}
      </button>
      <p className="entity-menu-hint">Archived projects keep their files and tabs. Use the Workspace Archived or All scope to find them. Their original categories are retained.</p>
      {saving && <p className="entity-menu-feedback" role="status">Saving…</p>}
      {error && <p className="entity-menu-error" role="alert">{error}</p>}
    </dialog>, document.body,
  )
}

function EntityControlsInner({ entities, categories, onChanged, children }: {
  entities: WorkspaceEntity[]
  categories: CardCategory[]
  onChanged: () => Promise<void>
  children: ReactNode
}) {
  const [target, setTarget] = useState<Target | null>(null)
  const entity = entities.find(item => item.id === target?.id)
  const [context, setContext] = useState<{ id: string; x: number; y: number; origin: HTMLElement } | null>(null)
  const [settings, setSettings] = useState<string | null>(null), [removing, setRemoving] = useState<WorkspaceEntity | null>(null), [confirmation, setConfirmation] = useState(''), [removalScope, setRemovalScope] = useState<'keep-files' | 'delete-files'>('keep-files'), [deletion, setDeletion] = useState<DeletionPreview | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [cleanupEntity, setCleanupEntity] = useState<WorkspaceEntity | null>(null), [cleanup, setCleanup] = useState<BuildCleanupPreview | null>(null), [cleanupResult, setCleanupResult] = useState<BuildCleanupResult | null>(null), [cleanupConfirmation, setCleanupConfirmation] = useState('')
  const contextEntity = entities.find(item => item.id === context?.id)
  const { refresh: refreshStorage } = useProjectStorage(contextEntity?.id || cleanupEntity?.id || '')
  const openContext = (element: HTMLElement, x: number, y: number) => { const node = element.closest<HTMLElement>('[data-entity],[data-card]'); const id = node?.dataset.entity || node?.dataset.card; if (id && node) setContext({ id, x, y, origin: node }) }
  const message = (reason: unknown) => reason instanceof Error ? reason.message : String(reason)
  const openDeletion = (item: WorkspaceEntity) => {
    setRemoving(item); setConfirmation(''); setRemovalScope('keep-files'); setDeletion(null); setError('')
    void api<DeletionPreview>(`/workspace/projects/${encodeURIComponent(item.id)}/deletion`).then(value => { setDeletion(value); if (value.retry && !value.blockedReason) setRemovalScope('delete-files') }).catch(reason => setError(message(reason)))
  }
  const openCleanup = (item: WorkspaceEntity) => {
    setCleanupEntity(item); setCleanup(null); setCleanupResult(null); setCleanupConfirmation(''); setError('')
    void api<BuildCleanupPreview>(`/workspace/projects/${encodeURIComponent(item.id)}/build-cleanup`).then(setCleanup).catch(reason => setError(message(reason)))
  }
  function close() {
    setTarget(null)
    if (target?.button.isConnected) target.button.focus({ preventScroll: true })
  }
  return (
    <Controls.Provider value={{ editing: target?.id ?? null, open: (item, button) => setTarget({ id: item.id, button, anchor: button.getBoundingClientRect() }) }}>
      <div style={{ display: 'contents' }} onContextMenu={event => { if (!isDesktop || !(event.target as HTMLElement).closest('[data-entity],[data-card]')) return; event.preventDefault(); openContext(event.target as HTMLElement, event.clientX, event.clientY) }} onKeyDown={event => { if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') { const node = (event.target as HTMLElement).closest<HTMLElement>('[data-entity],[data-card]'); if (!node) return; event.preventDefault(); const box = node.getBoundingClientRect(); openContext(node, box.left + 20, box.top + 20) } }}>{children}</div>
      {context && contextEntity && <ConversationContextMenu target={context} close={() => setContext(null)} items={[
        { label: 'Project settings', run: () => setSettings(contextEntity.id) },
        { label: 'Status and category', run: () => setTarget({ id: contextEntity.id, button: context.origin, anchor: context.origin.getBoundingClientRect() }) },
        { label: 'Refresh size on disk', run: () => { void refreshStorage?.(contextEntity.id).catch(reason => setError(message(reason))) } },
        ...(!contextEntity.builtin && contextEntity.id !== 'conversations' ? [
          { label: contextEntity.status === 'archived' ? 'Restore project' : 'Archive project', run: () => void updateWorkspaceEntity(contextEntity.id, { status: contextEntity.status === 'archived' ? 'active' : 'archived' }).then(onChanged).catch(reason => setError(String(reason))) },
          { label: 'Clear build folders…', run: () => openCleanup(contextEntity) },
          { label: 'Delete project...' , run: () => openDeletion(contextEntity) },
        ] : []),
      ]} />}
      {settings && <ProjectSettings id={settings} close={() => setSettings(null)} />}
      {cleanupEntity && <ConversationDialog title={`Clear build folders: ${cleanupEntity.title}`} close={() => { if (!busy) setCleanupEntity(null) }}><form className="project-settings-form" onSubmit={event => { event.preventDefault(); if (!cleanup) return; setBusy(true); setError(''); void api<BuildCleanupResult>(`/workspace/projects/${encodeURIComponent(cleanupEntity.id)}/build-cleanup`, { confirmation: cleanupConfirmation, previewToken: cleanup.previewToken }).then(result => { setCleanupResult(result); void refreshStorage?.(cleanupEntity.id).catch(() => undefined) }).catch(reason => setError(message(reason))).finally(() => setBusy(false)) }}>
        {!cleanup && !error && <p role="status">Checking generated build folders…</p>}
        {cleanup && <><p className="project-storage-dialog-warning"><strong>This cleanup is irreversible.</strong> Only the generated build folders listed below will be deleted. Project sources and the <code>.git</code> repository are not deleted.</p><p className="project-storage-dialog-note">Local project root: <code>{cleanup.root}</code></p>{cleanup.blockedReason ? <p role="alert">{cleanup.blockedReason}</p> : <>{cleanup.candidates.length ? <ul className="project-storage-candidates">{cleanup.candidates.map(candidate => <li key={candidate.path}><code>{candidate.path}</code> — {formatBytes(candidate.logicalBytes)} logical file data</li>)}</ul> : <p>No generated build folders are available to clear.</p>}{cleanup.skipped?.length ? <details className="project-storage-skipped"><summary>Preserved folders ({cleanup.skipped.length})</summary><ul>{cleanup.skipped.map(item => <li key={`${item.path}:${item.reason}`}><code>{item.path}</code><span>{item.reason}</span></li>)}</ul></details> : null}{cleanup.candidates.length ? <><p className="project-storage-dialog-note">File sizes shown are logical bytes. Disk savings depend on compression, sparse files and shared links.</p><p>Type <strong>{cleanupEntity.id}</strong> to confirm deletion of these generated folders.</p><input aria-label="Confirm build cleanup project ID" autoFocus value={cleanupConfirmation} onChange={event => setCleanupConfirmation(event.target.value)} /></> : null}</>}</>}
        {cleanupResult && <p role="status">{cleanupResult.message} Removed {formatBytes(cleanupResult.logicalBytes)} of generated file data. Disk usage is being refreshed.</p>}{error && <p role="alert">{error}</p>}<footer><button type="button" disabled={busy} onClick={() => setCleanupEntity(null)}>{cleanupResult ? 'Close' : 'Cancel'}</button>{cleanup && !cleanupResult && !cleanup.blockedReason && cleanup.candidates.length > 0 && <button type="submit" disabled={busy || cleanupConfirmation !== cleanupEntity.id}>{busy ? 'Clearing…' : 'Clear listed build folders'}</button>}</footer>
      </form></ConversationDialog>}
      {removing && <ConversationDialog title={`Delete project: ${removing.title}`} close={() => { if (!busy) setRemoving(null) }}><form className="project-settings-form" onSubmit={event => { event.preventDefault(); setBusy(true); setError(''); void api(`/workspace/projects/${encodeURIComponent(removing.id)}/remove`, { scope: removalScope, confirmation }).then(onChanged).then(() => { setRemoving(null); window.dispatchEvent(new Event('alpha-workspace-changed')) }).catch(reason => setError(message(reason))).finally(() => setBusy(false)) }}>
        <p>Remove this project from the Workspace list. This is separate from Archive.</p>{deletion?.retry && <p className="project-storage-dialog-warning"><strong>Local deletion is incomplete.</strong> This project remains listed. Do not start future work in it until local deletion completes.</p>}<div className="project-removal-options"><label><input type="radio" checked={removalScope === 'keep-files'} onChange={() => setRemovalScope('keep-files')} name="removal-scope" value="keep-files" /><strong>Keep all local files (default)</strong><small>The local workspace, checkout, Git history, conversation histories and project references remain.</small></label><label><input type="radio" checked={removalScope === 'delete-files'} disabled={!deletion || !!deletion.blockedReason} onChange={() => { setRemovalScope('delete-files'); setConfirmation('') }} name="removal-scope" value="delete-files" /><strong>{deletion?.retry ? 'Retry local project deletion' : 'Delete local project files'}</strong><small>Permanently deletes the complete local project root, including its workspace, source checkout and local Git history.</small></label></div>
        {!deletion && !error && <p role="status">Checking whether local files can be deleted…</p>}{deletion?.blockedReason && <p role="alert">Local file deletion is unavailable: {deletion.blockedReason}</p>}{removalScope === 'delete-files' && deletion && <p className="project-storage-dialog-warning"><strong>This cannot be undone.</strong> Alpha will delete <code>{deletion.root}</code>. The GitHub repository is never deleted.</p>}{removalScope === 'keep-files' && <p>The GitHub repository is never deleted by Alpha.</p>}<p>Type <strong>{removing.id}</strong> to confirm {removalScope === 'delete-files' ? 'permanent local file deletion' : 'this local list removal'}.</p><input aria-label="Confirm project ID" autoFocus value={confirmation} onChange={event => setConfirmation(event.target.value)} />{error && <p role="alert">{error}</p>}<footer><button type="button" disabled={busy} onClick={() => setRemoving(null)}>Cancel</button><button type="submit" disabled={busy || confirmation !== removing.id || (removalScope === 'delete-files' && (!deletion || !!deletion.blockedReason))}>{busy ? 'Deleting…' : removalScope === 'delete-files' ? deletion?.retry ? 'Retry local deletion' : 'Delete local files and project' : 'Remove project, keep files'}</button></footer>
      </form></ConversationDialog>}
      {entity && target && <EntityMenu key={entity.id} entity={entity} categories={categories} target={target} onClose={close} onChanged={onChanged} />}
    </Controls.Provider>
  )
}

export default function EntityControls(props: {
  entities: WorkspaceEntity[]
  categories: CardCategory[]
  onChanged: () => Promise<void>
  children: ReactNode
}) {
  return <ProjectStorageProvider projectIds={props.entities.map(entity => entity.id)}><EntityControlsInner {...props} /></ProjectStorageProvider>
}
