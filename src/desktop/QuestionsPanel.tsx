import { useEffect, useState } from 'react'
import { api, onServiceEvent, reportError, useDesktop } from './client'
import { Icon } from './Icons'
import type { ChatQuestion } from './types'

const draftKey = (id: string) => `alpha.questionDraft.${id}`

function QuestionCard({ question, connected }: { question: ChatQuestion; connected: boolean }) {
  const [draft, setDraft] = useState(() => localStorage.getItem(draftKey(question.id)) || '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const change = (value: string) => { setDraft(value); localStorage.setItem(draftKey(question.id), value); setError('') }
  const send = async () => {
    if (!draft.trim() || busy || !connected) return
    setBusy(true); setError('')
    try {
      await api(`/questions/${question.id}/answer`, { answer: draft })
      localStorage.removeItem(draftKey(question.id))
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(false) }
  }
  const dismiss = async () => {
    if (busy) return
    setBusy(true); setError('')
    try { await api(`/questions/${question.id}/dismiss`, {}) }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(false) }
  }
  return <article className="question-card">
    <header><strong>{question.chatName}</strong><time>{new Date(question.createdAt).toLocaleString()}</time></header>
    <p>{question.text}</p>
    {!!question.options.length && <div className="question-options" role="group" aria-label={`Suggested answers for ${question.chatName}`}>{question.options.map(option => <button key={option} type="button" aria-pressed={draft === option} onClick={() => change(option)}>{option}</button>)}</div>}
    <label htmlFor={`question-answer-${question.id}`}>Your answer</label>
    <textarea id={`question-answer-${question.id}`} aria-label={`Answer ${question.chatName}`} value={draft} onChange={event => change(event.target.value)} placeholder="Choose an answer or type your own…" rows={2} maxLength={64000} />
    {error && <p className="question-error" role="alert">{error}</p>}
    <footer><button type="button" onClick={() => api(`/sessions/${question.sessionId}/focus`, {}).catch(reportError)}>Open chat</button><button type="button" onClick={() => void dismiss()} disabled={busy || !connected}>Dismiss</button><button className="question-send" type="button" onClick={() => void send()} disabled={!draft.trim() || busy || !connected}>{busy ? 'Sending…' : 'Send answer'}</button></footer>
  </article>
}

export default function QuestionsPanel() {
  const state = useDesktop()
  const [open, setOpen] = useState(() => state.questions.length > 0)
  useEffect(() => onServiceEvent(event => { if (event.type === 'questions' && event.questions?.length) setOpen(true) }), [])
  useEffect(() => { const toggle = () => setOpen(value => !value); window.addEventListener('alpha-toggle-questions', toggle); return () => window.removeEventListener('alpha-toggle-questions', toggle) }, [])
  return <section className={`questions-panel ${open ? 'is-open' : ''}`} aria-label="Questions">
    <button className="questions-toggle" type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}><span><Icon name="help" size={15} />Questions {state.questions.length > 0 && <b>{state.questions.length}</b>}</span><Icon name={open ? 'down' : 'up'} size={15} /></button>
    {open && <div className="questions-list">{state.questions.length ? state.questions.map(question => <QuestionCard key={question.id} question={question} connected={state.connected} />) : <p className="questions-empty">No questions waiting.</p>}</div>}
  </section>
}
