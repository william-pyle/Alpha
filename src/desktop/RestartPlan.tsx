import { useEffect, useState } from 'react'
import { api, onServiceEvent, useDesktop } from './client'

type Note = { id: string; sessionId: string; chatName: string; note: string; status: string; error?: string }
export default function RestartPlan() {
  const state = useDesktop()
  const chats = state.sessions.filter(session => session.agent === 'codex' && session.nativeId && session.open)
  const [sessionId, setSessionId] = useState(chats.find(session => session.id === state.selectedId)?.id || chats[0]?.id || '')
  const [note, setNote] = useState(''), [notes, setNotes] = useState<Note[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState('')
  useEffect(() => {
    const refresh = () => void api<Note[]>('/restart-notes').then(setNotes).catch(error => setError(error.message))
    refresh(); return onServiceEvent(event => { if (event.type === 'restart-notes') refresh() })
  }, [])
  const save = async () => {
    setBusy(true); setError('')
    try { await api('/restart-notes', { sessionId, note }); setNotes(await api<Note[]>('/restart-notes')); setNote('') }
    catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  return <details className="alpha-restart-plan"><summary>Resume work after restarting</summary>
    <p>Save a note for an open Codex conversation. On its next launch, Alpha resumes the same native conversation with that note once. The status below distinguishes launching from actually continuing.</p>
    {chats.length ? <><label>Conversation<select aria-label="Conversation to resume" value={sessionId} onChange={event => setSessionId(event.target.value)}>{chats.map(session => <option key={session.id} value={session.id}>{session.name}</option>)}</select></label><label>Restart note<textarea aria-label="Restart note" rows={4} maxLength={12000} value={note} onChange={event => setNote(event.target.value)} placeholder="What is finished? What remains? Which file should Alpha read first?" /></label><button className="desk-secondary" disabled={busy || note.trim().length < 20 || !sessionId} onClick={() => void save()}>Save restart note</button></> : <p>An open Codex conversation with a saved session ID is needed for automatic continuation.</p>}
    {notes.map(item => <article key={item.id}><strong>{item.chatName}</strong> · {item.status}<p>{item.note}</p>{item.error && <p role="alert">{item.error}</p>}{['prepared', 'dispatched', 'failed'].includes(item.status) && <button className="desk-secondary" onClick={() => void api('/restart-notes/cancel', { id: item.id }).catch(error => setError(error.message))}>Cancel restart note</button>}</article>)}
    {error && <p role="alert">{error}</p>}
  </details>
}
