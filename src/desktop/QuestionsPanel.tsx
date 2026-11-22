import { useEffect, useRef, useState } from 'react'
import { api, reportError, selectThread, useDesktop } from './client'
import { openWorkspaceUtility } from './workspaceUtilities'
import type { ChatQuestion } from './types'

const draftKey = (id: string) => `alpha.questionDraft.${id}`

function QuestionCard({ question, connected }: { question: ChatQuestion; connected: boolean }) {
  const state = useDesktop()
  const openTerminal = async () => {
    const owner = state.threads.find(thread => thread.sessionIds.includes(question.sessionId))
    if (owner) { await api(`/threads/${owner.id}/view`, { viewMode: 'terminal', workerId: question.sessionId }); await selectThread(owner.id) }
    else await api(`/sessions/${question.sessionId}/focus`, {})
  }
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
      localStorage.removeItem(draftKey(question.id))
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
  return <article className="question-card" id={'question-card-' + question.id} tabIndex={-1} data-question-id={question.id}>
    <header><strong>{question.chatName}</strong><time>{new Date(question.createdAt).toLocaleString()}</time></header>
    <p>{question.text}</p>
    {question.source === 'native' && <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 11 }}>{question.context}</pre>}
    {question.source === 'project' ? <label>Project<select aria-label={`Project for ${question.chatName}`} value={question.options.includes(draft) ? draft : ''} onChange={event => change(event.target.value)}><option value="">Choose a project</option>{question.options.map(option => <option key={option}>{option}</option>)}</select></label> : !!question.options.length && <div className="question-options" role="group" aria-label={`Suggested answers for ${question.chatName}`}>{question.options.map(option => <button key={option} type="button" aria-pressed={draft === option} onClick={() => change(option)}>{option}</button>)}</div>}
    {question.source !== 'native' && <><label htmlFor={`question-answer-${question.id}`}>Your answer</label>
    <textarea id={`question-answer-${question.id}`} aria-label={`Answer ${question.chatName}`} value={draft} onChange={event => change(event.target.value)} placeholder="Choose an answer or type your own…" rows={2} maxLength={64000} /></>}
    {error && <p className="question-error" role="alert">{error}</p>}
    <footer>{question.threadId && question.source !== 'native' && <button type="button" onClick={() => void selectThread(question.threadId!).catch(reportError)}>Open originating conversation</button>}{(!question.source || question.source === 'native') && <button type="button" onClick={() => void openTerminal().catch(reportError)}>Open terminal</button>}{question.source !== 'project' && question.source !== 'native' && <button type="button" onClick={() => void dismiss()} disabled={busy || !connected}>Dismiss</button>}<button className="question-send" type="button" onClick={() => void send()} disabled={!draft.trim() || busy || !connected}>{busy ? 'Sending…' : 'Send answer'}</button></footer>
  </article>
}

export default function QuestionsPanel() {
  const state = useDesktop()
  const pending = state.questions.filter(question => question.status === 'pending')
  useEffect(() => {
    const reveal = (event: Event) => {
      const id = (event as CustomEvent<string>).detail
      openWorkspaceUtility('questions')
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const target = document.getElementById('question-answer-' + id) || document.getElementById('question-card-' + id)
        target?.focus()
      }))
    }
    window.addEventListener('alpha-open-question', reveal)
    return () => window.removeEventListener('alpha-open-question', reveal)
  }, [])
  return <section className="utility-document questions-panel" aria-label="Questions">
    <header><h1>Questions</h1></header>
    {!pending.length && <p>No pending questions.</p>}
    <div className="questions-list">{pending.map(question => <QuestionCard key={question.id} question={question} connected={state.connected} />)}</div>
  </section>
}
