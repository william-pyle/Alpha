import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../desktop/client'
import { RepositoryFields, CreateRepository } from '../desktop/ProjectSettings'
import { entityHash } from '../lib/route'
import type { WorkspaceEntity } from '../types'
import type { CardTemplate } from '../../desktop/service/card-schema.mjs'
import '../styles/editable-cards.css'

export function NewCardDialog({ onClose, onCreated }: { onClose: () => void; onCreated?: (entity: WorkspaceEntity) => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [title, setTitle] = useState(''), [template, setTemplate] = useState<CardTemplate>('gallery')
  const createdProject = useRef<WorkspaceEntity | null>(null)
  const [working, setWorking] = useState(''), [source, setSource] = useState(''), [createRepo, setCreateRepo] = useState(false)
  const ensureProject = async () => {
    if (createdProject.current) return createdProject.current.id
    if (!title.trim()) throw new Error('Enter a project title first.')
    const { entity } = await api<{ entity: WorkspaceEntity }>('/workspace/cards', { title, template })
    createdProject.current = entity; window.dispatchEvent(new Event('alpha-workspace-changed')); return entity.id
  }
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  useEffect(() => { const node = dialog.current; node?.showModal(); return () => node?.close() }, [])
  async function create() {
    if (busy || !title.trim()) return
    setBusy(true); setError('')
    try {
      const id = await ensureProject()
      if (working.trim() || source.trim()) await api(`/workspace/projects/${id}/repositories`, { ...(working.trim() ? { projectRepositoryUrl: working } : {}), ...(source.trim() ? { sourceRepositoryUrl: source } : {}) })
      const entity = createdProject.current!
      window.dispatchEvent(new Event('alpha-workspace-changed')); if (onCreated) onCreated(entity); else location.hash = entityHash(entity.id)
      onClose()
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); setBusy(false) }
  }
  return <>{createPortal(<dialog ref={dialog} className="new-card-dialog" aria-label="Create project" onCancel={event => { event.preventDefault(); if (!busy) onClose() }} onKeyDown={event => event.stopPropagation()}><form onSubmit={event => { event.preventDefault(); void create() }}>
    <div className="new-card-heading"><div><span>Create in Workspace</span><h2>Create project</h2></div><button type="button" aria-label="Close new project" disabled={busy} onClick={onClose}>×</button></div>
    <label>Project title<input autoFocus required maxLength={200} placeholder="Character references, tool research…" value={title} disabled={busy} onChange={event => setTitle(event.target.value)} /></label>
    <fieldset disabled={busy} className="new-card-templates"><legend>Choose a starting view</legend>{(['gallery', 'research'] as const).map(value => <label key={value} className={template === value ? 'selected' : ''}><input type="radio" name="template" value={value} checked={template === value} onChange={() => setTemplate(value)} /><strong>{value === 'gallery' ? 'Gallery' : 'Research'}</strong><span>{value === 'gallery' ? 'Images, reference notes and saved prompts.' : 'Findings, source links and decisions.'}</span></label>)}</fieldset>
    <RepositoryFields working={working} source={source} onWorking={setWorking} onSource={setSource} disabled={busy} create={() => { if (title.trim()) setCreateRepo(true); else setError('Enter a project title before creating its repository.') }} />
    <p className="new-card-hint">Edit it yourself or ask your agent to update it. You can switch views later.</p>
    {error && <p className="card-error" role="alert">{error}</p>}
    <footer><button type="button" disabled={busy} onClick={onClose}>Cancel</button><button type="submit" className="card-primary" disabled={busy || !title.trim()}>{busy ? 'Creating…' : 'Create project'}</button></footer>
  </form></dialog>, document.body)}{createRepo && <CreateRepository ensureProject={ensureProject} close={() => setCreateRepo(false)} created={() => { setCreateRepo(false); setError('Repository setup is running in the background. Continue to your project; Project settings shows progress.'); void api<{ project: WorkspaceEntity }>(`/workspace/projects/${createdProject.current!.id}`).then(value => setWorking(value.project.projectRepositoryUrl || '')) }} />}</>
}

export default function NewCard({ hideTrigger = false }: { hideTrigger?: boolean }) {
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const show = () => setOpen(true)
    window.addEventListener('alpha-new-card', show)
    return () => window.removeEventListener('alpha-new-card', show)
  }, [])
  return <>{!hideTrigger && <button ref={button} className="new-card-button" onClick={() => setOpen(true)}>+ Create project</button>}{open && <NewCardDialog onClose={() => { setOpen(false); button.current?.focus() }} />}</>
}
