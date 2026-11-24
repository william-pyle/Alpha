import { useEffect, useState } from 'react'
import { api, onServiceEvent } from './client'

type Lesson = { id: string; text: string; kind: 'conversation' | 'work'; source: { type: string }; updatedAt: string }

export default function LearningPanel() {
  const [lessons, setLessons] = useState<Lesson[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [kind, setKind] = useState<Lesson['kind']>('conversation')
  useEffect(() => {
    let mounted = true
    const refresh = () => api<Lesson[]>('/learning').then(items => { if (mounted) { setLessons(items); setLoading(false) } }).catch(cause => { if (mounted) { setError(cause.message); setLoading(false) } })
    void refresh()
    const unsubscribe = onServiceEvent(event => { if (event.type === 'learning' || event.type === 'connected') void refresh() })
    return () => { mounted = false; unsubscribe() }
  }, [])
  const reset = () => { setEditing(null); setText(''); setKind('conversation') }
  const save = async () => {
    setBusy(true); setError('')
    try { setLessons(await api<Lesson[]>('/learning', { ...(editing ? { id: editing } : {}), text, kind })); reset() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  const forget = async (id: string) => {
    setBusy(true); setError('')
    try { setLessons(await api<Lesson[]>(`/learning/${encodeURIComponent(id)}`, undefined, 'DELETE')); if (editing === id) reset() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  return <section className="alpha-learning-panel" aria-label="What I've learned">
    <header><strong>What I&apos;ve learned</strong></header>
    <p>Tell me what I should do differently next time. You can also add, edit or forget a lesson here.</p>
    <p className="alpha-learning-note">Lessons are saved on this computer and included in future Alpha conversations. Coding &amp; work lessons also accompany task handoffs. Restart live voice to pick up changes.</p>
    {loading ? <p>Loading lessons...</p> : lessons.length === 0 ? <p>No saved lessons yet.</p> : <ul>{lessons.map(lesson => <li key={lesson.id}>
      <small>{lesson.kind === 'work' ? 'Coding & work' : 'Conversation'} · {lesson.source?.type === 'conversation' ? 'From your words' : 'Added by you'}</small><p>{lesson.text}</p>
      <button type="button" disabled={busy} onClick={() => { setEditing(lesson.id); setText(lesson.text); setKind(lesson.kind) }}>Edit lesson</button>
      <button type="button" disabled={busy} onClick={() => void forget(lesson.id)}>Forget lesson</button>
    </li>)}</ul>}
    <form onSubmit={event => { event.preventDefault(); void save() }}>
      <label htmlFor="alpha-lesson-kind">Use this for</label><select id="alpha-lesson-kind" disabled={busy} value={kind} onChange={event => setKind(event.target.value as Lesson['kind'])}><option value="conversation">Conversation</option><option value="work">Coding &amp; work</option></select>
      <label htmlFor="alpha-lesson-text">What should I do differently?</label><textarea id="alpha-lesson-text" disabled={busy} rows={3} minLength={8} maxLength={600} value={text} onChange={event => setText(event.target.value)} />
      <div><button disabled={busy || loading || text.trim().length < 8} type="submit">{editing ? 'Save lesson' : 'Remember this'}</button>{editing && <button type="button" disabled={busy} onClick={reset}>Cancel edit</button>}</div>
    </form>
    {error && <p role="alert">{error}</p>}
    <p className="alpha-learning-note">Forgetting removes a lesson from future context. It doesn&apos;t delete your conversation history.</p>
  </section>
}
