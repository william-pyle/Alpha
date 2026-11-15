import { useEffect, useRef, useState, type DragEvent } from 'react'
import { api, copyImagePath, uploadImage } from './client'

const draftKey = (id: string) => `alpha.chatDraft.${id}`

export default function ChatComposer({ id, connected, running, height }: { id: string; connected: boolean; running: boolean; height?: number }) {
  const [draft, setDraft] = useState(() => localStorage.getItem(draftKey(id)) || '')
  const [busy, setBusy] = useState(false)
  const [savingImage, setSavingImage] = useState(false)
  const [draggingImage, setDraggingImage] = useState(false)
  const [error, setError] = useState('')
  const area = useRef<HTMLTextAreaElement>(null)
  const uploading = useRef(false)

  const change = (value: string) => { setDraft(value); localStorage.setItem(draftKey(id), value); setError('') }
  const submit = async () => {
    if (!draft.trim() || busy || uploading.current || !connected || !running) return
    setBusy(true); setError('')
    try {
      await api(`/sessions/${encodeURIComponent(id)}/input`, { text: draft, composed: true, submit: true })
      change(''); area.current?.focus()
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(false) }
  }
  const attachImages = async (count: number, save: (index: number) => Promise<{ path: string }>) => {
    if (uploading.current) return
    if (count > 12) { setError('Attach up to 12 images at a time.'); return }
    uploading.current = true; setSavingImage(true); setError('')
    try {
      const paths: string[] = []
      for (let index = 0; index < count; index++) paths.push((await save(index)).path)
      const input = area.current
      const start = input?.selectionStart ?? draft.length, end = input?.selectionEnd ?? start
      const inserted = paths.map(path => `"${path.replace(/"/g, '')}"`).join(' ') + ' '
      setDraft(previous => {
        const next = previous.slice(0, start) + inserted + previous.slice(end)
        localStorage.setItem(draftKey(id), next)
        return next
      })
      requestAnimationFrame(() => { if (input) { input.focus(); input.selectionStart = input.selectionEnd = start + inserted.length } })
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { uploading.current = false; setSavingImage(false) }
  }
  const attachRef = useRef(attachImages)
  useEffect(() => { attachRef.current = attachImages })
  useEffect(() => {
    const nativeDrop = (event: Event) => {
      const detail = (event as CustomEvent<{ phase: string; paths?: string[]; x?: number; y?: number }>).detail
      if (!detail) return
      if (detail.phase === 'leave') { setDraggingImage(false); return }
      if (!Number.isFinite(detail.x) || !Number.isFinite(detail.y)) return
      const target = document.elementFromPoint(detail.x!, detail.y!)
      const inside = !!target && !!area.current?.contains(target)
      setDraggingImage(detail.phase !== 'drop' && inside)
      if (detail.phase !== 'drop' || !inside) return
      const paths = detail.paths || []
      if (paths.length) void attachRef.current(paths.length, index => copyImagePath(paths[index]))
    }
    window.addEventListener('alpha-file-drop', nativeDrop)
    return () => window.removeEventListener('alpha-file-drop', nativeDrop)
  }, [id])
  const paste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.items).map(item => item.getAsFile()).filter((file): file is File => !!file && file.type.startsWith('image/'))
    if (!files.length) return
    event.preventDefault()
    void attachImages(files.length, index => uploadImage(files[index]))
  }
  const drop = (event: DragEvent<HTMLTextAreaElement>) => {
    event.preventDefault()
    setDraggingImage(false)
    const files = Array.from(event.dataTransfer.files).filter(file => file.type.startsWith('image/'))
    if (files.length) void attachImages(files.length, index => uploadImage(files[index]))
    else setError('Drop a PNG, JPEG, WebP, GIF or BMP image.')
  }
  const keyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Enter') {
      event.preventDefault()
      if (!event.altKey) { void submit(); return }
      const input = event.currentTarget, start = input.selectionStart, end = input.selectionEnd
      change(draft.slice(0, start) + '\n' + draft.slice(end))
      requestAnimationFrame(() => { input.selectionStart = input.selectionEnd = start + 1 })
      return
    }
    if (event.key === 'Tab') {
      event.preventDefault()
      const input = event.currentTarget, start = input.selectionStart, end = input.selectionEnd
      const next = draft.slice(0, start) + '\t' + draft.slice(end)
      change(next)
      requestAnimationFrame(() => { input.selectionStart = input.selectionEnd = start + 1 })
    }
  }

  return <section className="chat-composer" aria-label="Message editor" style={height ? { height } : undefined}>
    <label htmlFor={`chat-draft-${id}`}>Message editor <span>{savingImage ? 'Saving image to inbox…' : 'Enter to send · Alt+Enter for a new line · Paste or drop images'}</span></label>
    <div className="chat-composer-input"><textarea ref={area} className={draggingImage ? 'image-dragging' : undefined} id={`chat-draft-${id}`} aria-label="Write a message" value={draft} onChange={event => change(event.target.value)} onKeyDown={keyDown} onPaste={paste} onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setDraggingImage(true) }} onDragLeave={() => setDraggingImage(false)} onDrop={drop} placeholder="Write your message here…" rows={5} maxLength={64000} spellCheck={true} /><button type="button" onClick={() => void submit()} disabled={!draft.trim() || busy || savingImage || !connected || !running}>{busy ? 'Sending…' : 'Send'}</button></div>
    {error && <p role="alert">{error}</p>}
  </section>
}
