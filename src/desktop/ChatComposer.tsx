import { useRef, useState } from 'react'
import { api } from './client'

const draftKey = (id: string) => `alpha.chatDraft.${id}`

export default function ChatComposer({ id, connected, running }: { id: string; connected: boolean; running: boolean }) {
  const [draft, setDraft] = useState(() => localStorage.getItem(draftKey(id)) || '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const area = useRef<HTMLTextAreaElement>(null)

  const change = (value: string) => { setDraft(value); localStorage.setItem(draftKey(id), value); setError('') }
  const submit = async () => {
    if (!draft.trim() || busy || !connected || !running) return
    setBusy(true); setError('')
    try {
      await api(`/sessions/${encodeURIComponent(id)}/input`, { text: draft, composed: true, submit: true })
      change(''); area.current?.focus()
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(false) }
  }
  const keyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void submit(); return }
    if (event.key === 'Tab') {
      event.preventDefault()
      const input = event.currentTarget, start = input.selectionStart, end = input.selectionEnd
      const next = draft.slice(0, start) + '\t' + draft.slice(end)
      change(next)
      requestAnimationFrame(() => { input.selectionStart = input.selectionEnd = start + 1 })
    }
  }

  return <section className="chat-composer" aria-label="Message editor">
    <label htmlFor={`chat-draft-${id}`}>Message editor <span>Enter for a new line · Ctrl+Enter to send</span></label>
    <div className="chat-composer-input"><textarea ref={area} id={`chat-draft-${id}`} aria-label="Write a message" value={draft} onChange={event => change(event.target.value)} onKeyDown={keyDown} placeholder="Write your message here…" rows={5} maxLength={64000} spellCheck={true} /><button type="button" onClick={() => void submit()} disabled={!draft.trim() || busy || !connected || !running}>{busy ? 'Sending…' : 'Send'}</button></div>
    {error && <p role="alert">{error}</p>}
  </section>
}
