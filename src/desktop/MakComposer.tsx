import { useEffect, useRef, useState } from 'react'
import { api, copyImagePath, desktopState, uploadImage } from './client'
import { Icon } from './Icons'
import { ZoomImage } from '../components/ImagePreview'
import type { Preview } from './types'

import LayoutRegion from './LayoutRegion'

const maxImages = 12
type Draft = { text: string; paths: string[] }
const writes = new Map<string, Promise<unknown>>()
function saveDraft(id: string, draft: Draft) {
  if (id === 'legacy') return Promise.resolve()
  const write = (writes.get(id) || Promise.resolve()).catch(() => {}).then(() => api(`/threads/${id}/draft`, draft, 'POST', { keepalive: true }))
  writes.set(id, write)
  return write
}

export default function MakComposer({ connected, sending, onSend, draftId = 'legacy', initialDraft }: {
  draftId?: string
  initialDraft?: Draft
  connected: boolean
  sending: boolean
  onSend: (text: string, images: string[]) => Promise<void>
  autoSendVoice?: boolean
}) {
  const [error, setError] = useState('')
  const [saved] = useState(() => {
    try { return JSON.parse(localStorage.getItem(`alpha.threadDraft.${draftId}`) || 'null') as Draft | null || initialDraft || null } catch { return initialDraft || null }
  })
  const [draft, setDraft] = useState(() => saved?.text ?? localStorage.getItem(`alpha.chatDraft.${draftId}`) ?? '')
  const [images, setImages] = useState<Preview[]>(() => (saved?.paths || []).map(path => ({ path, name: path.split(/[\\/]/).pop() || 'Image', size: 0, kind: 'image' })))
  const alive = useRef(true)
  const area = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const currentDraft = useRef<Draft>({ text: draft, paths: images.map(image => image.path) })
  useEffect(() => {
    const value = { text: draft, paths: images.map(image => image.path) }
    currentDraft.current = value
    localStorage.setItem(`alpha.threadDraft.${draftId}`, JSON.stringify(value))
    const timer = window.setTimeout(() => { void saveDraft(draftId, value).catch(() => { if (alive.current) setError('Draft could not be saved to Alpha. Keep this window open and reconnect before restarting.') }) }, 250)
    return () => clearTimeout(timer)
  }, [draft, images, draftId])
  useEffect(() => {
    const flush = () => { void saveDraft(draftId, currentDraft.current).catch(() => {}) }
    window.addEventListener('pagehide', flush)
    return () => { window.removeEventListener('pagehide', flush); flush() }
  }, [draftId])
  useEffect(() => {
    let cancelled = false
    if (saved?.paths.length) void Promise.all(saved.paths.map(path => api<Preview>(`/preview?path=${encodeURIComponent(path)}`))).then(values => { if (!cancelled) setImages(current => current.map(item => values.find(value => value.path === item.path) || item)) }).catch(report => { if (!cancelled) setError(String(report)) })
    return () => { cancelled = true }
  }, [draftId, saved])
  const [uploading, setUploading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const busy = useRef(false)
  const picker = useRef<HTMLInputElement>(null)
  const sendPending = sending || submitting
  const disabled = sendPending || uploading || !connected

  useEffect(() => {
    const updated = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== draftId) return
      const stored = JSON.parse(localStorage.getItem(`alpha.threadDraft.${draftId}`) || '{"text":"","paths":[]}') as { text: string; paths: string[] }
      setDraft(stored.text)
      void Promise.all(stored.paths.map(path => api<Preview>(`/preview?path=${encodeURIComponent(path)}`))).then(values => { if (alive.current) setImages(values) }).catch(reason => { if (alive.current) setError(String(reason)) })
    }
    window.addEventListener('alpha-draft-updated', updated)
    return () => window.removeEventListener('alpha-draft-updated', updated)
  }, [draftId])

  function addPreview(preview: Preview) {
    if (draftId !== 'legacy' && !desktopState().threads.some(thread => thread.id === draftId)) return
    if (alive.current) setImages(previous => [...previous, preview])
    else {
      const stored = JSON.parse(localStorage.getItem(`alpha.threadDraft.${draftId}`) || '{"text":"","paths":[]}') as { text: string; paths: string[] }
      stored.paths.push(preview.path)
      localStorage.setItem(`alpha.threadDraft.${draftId}`, JSON.stringify(stored))
      void saveDraft(draftId, stored).catch(() => {})
      window.dispatchEvent(new CustomEvent('alpha-draft-updated', { detail: draftId }))
    }
  }
  const nativeAttach = useRef<(paths: string[]) => Promise<void>>(async () => {})
  useEffect(() => {
    nativeAttach.current = async paths => {
      if (disabled || busy.current) return
      if (images.length + paths.length > maxImages) { setError(`Attach up to ${maxImages} images per message.`); return }
      busy.current = true; setUploading(true)
      try { for (const path of paths) { const saved = await copyImagePath(path); addPreview(await api<Preview>(`/preview?path=${encodeURIComponent(saved.path)}`)) } }
      catch (reason) { if (alive.current) setError(String(reason)) }
      finally { busy.current = false; if (alive.current) setUploading(false) }
    }
  })
  useEffect(() => {
    const dropped = (event: Event) => {
      const detail = (event as CustomEvent<{ phase: string; paths?: string[]; x?: number; y?: number }>).detail
      if (detail?.phase !== 'drop' || !Number.isFinite(detail.x) || !Number.isFinite(detail.y)) return
      const target = document.elementFromPoint(detail.x!, detail.y!)
      if (target && area.current?.contains(target)) void nativeAttach.current(detail.paths || [])
    }
    window.addEventListener('alpha-file-drop', dropped)
    return () => window.removeEventListener('alpha-file-drop', dropped)
  }, [])

  async function attach(files: File[]) {
    if (!files.length || disabled || busy.current) return
    if (images.length + files.length > maxImages) { setError(`Attach up to ${maxImages} images per message.`); return }
    busy.current = true; setUploading(true); setError('')
    try {
      for (const file of files) {
        const saved = await uploadImage(file)
        const preview = await api<Preview>(`/preview?path=${encodeURIComponent(saved.path)}`)
        addPreview(preview)
      }
    } catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { busy.current = false; setUploading(false) }
  }

  async function send(event: React.FormEvent) {
    event.preventDefault()
    if (disabled || busy.current || (!draft.trim() && !images.length)) return
    busy.current = true; setError('')
    // Keep the saved draft recoverable until delivery succeeds.
    setSubmitting(true)
    try {
      await onSend(draft.trim() || 'Please review the attached images.', images.map(image => image.path))
      if (!alive.current) {
        localStorage.setItem(`alpha.threadDraft.${draftId}`, JSON.stringify({ text: '', paths: [] }))
        void saveDraft(draftId, { text: '', paths: [] }).catch(() => {})
        window.dispatchEvent(new CustomEvent('alpha-draft-updated', { detail: draftId }))
      }
      setDraft(''); setImages([])
    } catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { busy.current = false; setSubmitting(false) }
  }

  return <LayoutRegion kind="composer"><div className="mak-composer">
    {error && <div className="voice-error" role="alert"><span>{error}</span><button className="desk-icon" aria-label="Dismiss message error" onClick={() => setError('')}><Icon name="close" size={14} /></button></div>}
    {!sendPending && images.length > 0 && <div className="voice-attachments" aria-label="Attached images">{images.map(image => <div className="voice-attachment" key={image.path}>
      <ZoomImage src={image.url} alt={image.name} />
      <button className="desk-icon" title={`Remove ${image.name}`} aria-label={`Remove ${image.name}`} disabled={disabled} onClick={() => setImages(previous => previous.filter(item => item.path !== image.path))}><Icon name="close" size={12} /></button>
    </div>)}</div>}
    <form className="voice-compose" onSubmit={send}>
      <input ref={picker} type="file" hidden multiple accept="image/png,image/jpeg,image/webp,image/gif,image/bmp" aria-label="Choose images for Alpha" onChange={event => { const files = Array.from(event.target.files || []); event.target.value = ''; void attach(files) }} />
      <button type="button" title="Attach images" aria-label="Attach images" disabled={disabled} onClick={() => picker.current?.click()}><Icon name="attach" size={17} /></button>
      <textarea ref={area} value={sendPending ? '' : draft} rows={6} onChange={event => setDraft(event.target.value)} placeholder="Tell Alpha…" aria-label="Message Alpha" title="Enter sends; Shift+Enter adds a line" disabled={disabled}
        onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' }}
        onDrop={event => { event.preventDefault(); void attach(Array.from(event.dataTransfer.files).filter(file => file.type.startsWith('image/'))) }}
        onPaste={event => { const files = Array.from(event.clipboardData.files).filter(file => file.type.startsWith('image/')); if (files.length) { event.preventDefault(); void attach(files) } }}
        onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); event.currentTarget.form?.requestSubmit() } }} />
      <button type="submit" title="Send to Alpha" aria-label="Send to Alpha" disabled={disabled || (!draft.trim() && !images.length)}><Icon name="send" size={17} /></button>
    </form>
    {uploading && <div role="status">Saving images...</div>}
  </div></LayoutRegion>
}
