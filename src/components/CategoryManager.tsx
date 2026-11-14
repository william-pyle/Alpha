import { useEffect, useRef, useState } from 'react'
import type { CardCategory, WorkspaceEntity } from '../types'
import { api, isDesktop } from '../desktop/client'
import './category-manager.css'

const icons = ['📁', '📂', '🛠️', '🔍', '🎮', '🎨', '📊', '🧲', '📝', '💡', '🧪', '📚', '📷', '🎵', '🌐', '💼', '🗂️', '⭐']
const slug = (name: string) => name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64)

export default function CategoryManager({ categories, entities, onChanged }: { categories: CardCategory[]; entities: WorkspaceEntity[]; onChanged: () => Promise<void> }) {
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [id, setId] = useState('')
  const [icon, setIcon] = useState('📁')
  const [replacement, setReplacement] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const dialog = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    if (open) dialog.current?.showModal()
    else dialog.current?.close()
  }, [open])

  const reset = () => { setEditing(null); setDeleting(null); setName(''); setId(''); setIcon('📁'); setReplacement(''); setError('') }
  const edit = (category: CardCategory) => { setDeleting(null); setEditing(category.id); setId(category.id); setName(category.name); setIcon(category.icon); setError('') }
  const remove = (category: CardCategory) => { setEditing(null); setDeleting(category.id); setReplacement(categories.find(item => item.id !== category.id)?.id || ''); setError('') }
  const save = async (event: React.FormEvent) => {
    event.preventDefault()
    if (busy) return
    setBusy(true); setError('')
    try {
      if (editing) await api(`/workspace/categories/${encodeURIComponent(editing)}`, { name, icon }, 'PATCH')
      else await api('/workspace/categories', { id, name, icon })
      await onChanged(); reset()
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(false) }
  }
  const confirmDelete = async () => {
    if (!deleting || busy) return
    setBusy(true); setError('')
    try {
      await api(`/workspace/categories/${encodeURIComponent(deleting)}`, { replacement }, 'DELETE')
      await onChanged(); reset()
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(false) }
  }

  if (!isDesktop) return null
  const inUse = entities.filter(item => item.category === deleting).length
  return <>
    <button type="button" className="category-manage-open" aria-label="Categories" title="Manage card categories" onClick={() => { reset(); setOpen(true) }}>Categories</button>
    <dialog ref={dialog} className="category-manager" aria-label="Manage card categories" onCancel={event => { if (busy) event.preventDefault(); else { setOpen(false); reset() } }}>
      <header><div><small>WORKSPACE</small><h2>Card categories</h2></div><button type="button" aria-label="Close categories" disabled={busy} onClick={() => { setOpen(false); reset() }}>×</button></header>
      <div className="category-manager-list">{categories.map(category => <div className="category-manager-row" key={category.id}>
        <span className="category-manager-icon" aria-hidden="true">{category.icon}</span><span><strong>{category.name}</strong><small>{category.id} · {entities.filter(item => item.category === category.id).length} cards</small></span>
        <button type="button" disabled={busy} onClick={() => edit(category)} aria-label={`Edit ${category.name}`}>Edit</button>
        <button type="button" disabled={busy || categories.length < 2} onClick={() => remove(category)} aria-label={`Delete ${category.name}`}>Delete</button>
      </div>)}</div>
      {deleting ? <div className="category-manager-form"><h3>Delete {categories.find(item => item.id === deleting)?.name}?</h3><p>{inUse ? `${inUse} card${inUse === 1 ? '' : 's'} will move to the category you choose. Their files and routes stay in place.` : 'This category has no cards.'}</p>
        {inUse > 0 && <label>Move cards to<select value={replacement} onChange={event => setReplacement(event.target.value)}>{categories.filter(item => item.id !== deleting).map(item => <option value={item.id} key={item.id}>{item.icon} {item.name}</option>)}</select></label>}
        <div className="category-manager-actions"><button type="button" onClick={reset} disabled={busy}>Cancel</button><button type="button" className="danger" onClick={() => void confirmDelete()} disabled={busy || (inUse > 0 && !replacement)}>Delete category</button></div>
      </div> : <form className="category-manager-form" onSubmit={save}><h3>{editing ? 'Edit category' : 'Add category'}</h3>
        <label>Name<input value={name} maxLength={60} required onChange={event => { const value = event.target.value; setName(value); if (!editing) setId(slug(value)) }} placeholder="e.g. Writing" /></label>
        <label>Category ID<input value={id} maxLength={64} required disabled={!!editing} pattern="[a-z0-9][a-z0-9-]*" onChange={event => setId(event.target.value)} /><small>Used in Workspace records; stays fixed after creation.</small></label>
        <label>Icon<select value={icons.includes(icon) ? icon : 'custom'} onChange={event => setIcon(event.target.value === 'custom' ? '' : event.target.value)}>{icons.map(value => <option value={value} key={value}>{value}</option>)}<option value="custom">Custom symbol</option></select></label>
        {!icons.includes(icon) && <label>Custom symbol<input value={icon} maxLength={16} required onChange={event => setIcon(event.target.value)} placeholder="Choose one emoji" /></label>}
        <div className="category-manager-actions">{editing && <button type="button" onClick={reset} disabled={busy}>Cancel edit</button>}<button type="submit" disabled={busy || !name.trim() || !id || !icon.trim()}>{busy ? 'Saving…' : editing ? 'Save category' : 'Add category'}</button></div>
      </form>}
      {error && <p className="category-manager-error" role="alert">{error}</p>}
    </dialog>
  </>
}
