import { useEffect, useRef, useState } from 'react'
import { api, onServiceEvent, reportError, selectThread, useDesktop } from './client'
import { Icon } from './Icons'
import type { ChatQuestion } from './types'

const draftKey = (id: string) => `alpha.questionDraft.${id}`

function QuestionCard({ question, connected, accepted }: { question: ChatQuestion; connected: boolean; accepted: (id: string) => void }) {
  const [draft, setDraft] = useState(() => localStorage.getItem(draftKey(question.id)) || '')
  const inFlight = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const change = (value: string) => { setDraft(value); localStorage.setItem(draftKey(question.id), value); setError('') }
  const send = async () => {
    if (!draft.trim() || inFlight.current || !connected) return
    inFlight.current = true; setBusy(true); setError('')
    try {
      await api(`/questions/${question.id}/answer`, { answer: draft })
      localStorage.removeItem(draftKey(question.id)); accepted(question.id)
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { inFlight.current = false; setBusy(false) }
  }
  const dismiss = async () => {
    if (busy) return
    setBusy(true); setError('')
    try { await api(`/questions/${question.id}/dismiss`, {}) }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(false) }
  }
  return <article className="question-card" data-question-id={question.id}>
    <header><strong>{question.chatName}</strong><time>{new Date(question.createdAt).toLocaleString()}</time></header>
    <p>{question.text}</p>
    {question.source === 'project' ? <label>Project<select aria-label={`Project for ${question.chatName}`} value={question.options.includes(draft) ? draft : ''} onChange={event => change(event.target.value)}><option value="">Choose a card or project</option>{question.options.map(option => <option key={option}>{option}</option>)}</select></label> : !!question.options.length && <div className="question-options" role="group" aria-label={`Suggested answers for ${question.chatName}`}>{question.options.map(option => <button key={option} type="button" aria-pressed={draft === option} onClick={() => change(option)}>{option}</button>)}</div>}
    <label htmlFor={`question-answer-${question.id}`}>Your answer</label>
    <textarea id={`question-answer-${question.id}`} aria-label={`Answer ${question.chatName}`} value={draft} onChange={event => change(event.target.value)} placeholder="Choose an answer or type your own…" rows={2} maxLength={64000} />
    {error && <p className="question-error" role="alert">{error}</p>}
    <footer>{question.threadId && <button type="button" onClick={() => void selectThread(question.threadId!).catch(reportError)}>Open originating conversation</button>}{!question.source && <button type="button" onClick={() => api(`/sessions/${question.sessionId}/focus`, {}).catch(reportError)}>Open chat</button>}{question.source !== 'project' && <button type="button" onClick={() => void dismiss()} disabled={busy || !connected}>Dismiss</button>}<button className="question-send" type="button" onClick={() => void send()} disabled={!draft.trim() || busy || !connected}>{busy ? 'Sending…' : 'Send answer'}</button></footer>
  </article>
}

export default function QuestionsPanel() {
  const state = useDesktop()
  const [open, setOpen] = useState(true), [focusedId, setFocusedId] = useState('')
  const [acceptedIds, setAcceptedIds] = useState<string[]>([])
  const pending = state.questions.filter(question => question.status === 'pending' && !acceptedIds.includes(question.id))
  const previous = useRef(pending.length)
  useEffect(() => {
    if (previous.current > 0 && pending.length === 0) { setOpen(false); requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('[aria-label="Message Alpha"]')?.focus()) }
    previous.current = pending.length
  }, [pending.length])
  useEffect(() => {
    const reveal = (event: Event) => { setFocusedId((event as CustomEvent<string>).detail); setOpen(true) }
    window.addEventListener('alpha-open-question', reveal)
    return () => window.removeEventListener('alpha-open-question', reveal)
  }, [])
  useEffect(() => { if (open && focusedId) document.getElementById(`question-answer-${focusedId}`)?.focus() }, [open, focusedId])
  useEffect(() => onServiceEvent(event => { if (!state.awareness.settings.quiet && state.awareness.settings.enabled && ['questions', 'connected'].includes(event.type) && event.questions?.length) setOpen(true) }), [state.awareness.settings.quiet, state.awareness.settings.enabled])
  useEffect(() => { const toggle = () => setOpen(value => !value); window.addEventListener('alpha-toggle-questions', toggle); return () => window.removeEventListener('alpha-toggle-questions', toggle) }, [])
  if (pending.length === 0) return null
  return <section className={`questions-panel ${open ? 'is-open' : ''}`} aria-label="Questions">
    <button className="questions-toggle" type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}><span><Icon name="help" size={15} />Questions {pending.length > 0 && <b>{pending.length}</b>}</span><Icon name={open ? 'down' : 'up'} size={15} /></button>
    {open && <div className="questions-list">{pending.length ? pending.map(question => <QuestionCard key={question.id} question={question} connected={state.connected} accepted={id => setAcceptedIds(current => [...current, id])} />) : <p className="questions-empty">No questions waiting.</p>}</div>}
  </section>
}
