import { useEffect, useRef, useState } from 'react'
import { api, reportError, selectThread, useDesktop } from './client'
import { openWorkspaceUtility } from './workspaceUtilities'
import type { ChatQuestion, WorkerDecision } from './types'
import { useWorkspace } from '../lib/workspace'

const draftKey = (id: string) => `alpha.questionDraft.${id}`
const decisionLabels: Record<string, string> = {
  'owner-denied': 'Owner denied',
  'system-blocked': 'System blocked',
  pending: 'Approval recorded',
  applied: 'Applied',
  closed: 'Closed',
  stale: 'Request changed',
  denied: 'Denied by policy',
  unavailable: 'Unavailable',
  unconfirmed: 'Outcome unconfirmed',
  error: 'Failed',
}
const decisionMessages: Record<string, string> = {
  'owner-denied': 'Your decision ended this request.',
  pending: 'Alpha is checking the approved request.',
  unconfirmed: 'Check the current target state before taking further action.',
}

function WorkerDecisions({ decisions }: { decisions: WorkerDecision[] }) {
  if (!decisions.length) return null
  return <section className="worker-decisions" aria-label="Recent worker decisions">
    <h2>Recent worker decisions</h2>
    <ul aria-live="polite">{decisions.map(item => {
      const message = item.message || decisionMessages[item.status]
      return <li key={item.questionId} data-worker-receipt={item.receiptId}>
        <strong>{decisionLabels[item.status] || 'Outcome unconfirmed'}</strong> · {item.chatName}
        {message && <p>{message}</p>}
        {item.nextStep && <p>{item.nextStep}</p>}
        <p>Receipt <code>{item.receiptId}</code></p>
      </li>
    })}</ul>
  </section>
}

function FileRequestReferences() {
  const { workspace } = useWorkspace()
  const [projectId, setProjectId] = useState('')
  const [targets, setTargets] = useState<{ id: string; label: string; revision: string }[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const load = async () => {
    if (!projectId || busy) return
    setError(''); setTargets(null); setBusy(true)
    try {
      const result = await api<{ targets: NonNullable<typeof targets> }>(`/worker-request-files/${encodeURIComponent(projectId)}`)
      setTargets(result.targets)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to list file references.')
    } finally { setBusy(false) }
  }
  return <details className="file-request-references">
    <summary>File request references</summary>
    <p>Find an eligible registered Markdown report to identify it in a worker request.</p>
    <label>Project <select value={projectId} disabled={busy} onChange={event => { setProjectId(event.target.value); setTargets(null); setError('') }}>
      <option value="">Choose a project</option>
      {workspace?.entities.filter(project => !project.removedAt).map(project => <option key={project.id} value={project.id}>{project.title}</option>)}
    </select></label>
    <button type="button" disabled={!projectId || busy} onClick={() => void load()}>{busy ? 'Looking up…' : 'Show file references'}</button>
    {error && <p role="alert">{error}</p>}
    {targets?.length === 0 && <p>No eligible Markdown reports in this project.</p>}
    {targets?.map(target => <p key={target.id} style={{ overflowWrap: 'anywhere' }}><strong>{target.label}</strong><br />
      File ID <code>{target.id}</code><br />Revision <code>{target.revision}</code>
    </p>)}
  </details>
}

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
  const approval = question.source === 'worker-approval'
  const change = (value: string) => { setDraft(value); localStorage.setItem(draftKey(question.id), value); setError('') }
  const send = async () => {
    if (!draft.trim() || approval && !question.options.includes(draft) || inFlight.current || !connected) return
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
    {approval && <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{question.context}</p>}
    {question.source === 'native' && <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 11 }}>{question.context}</pre>}
    {question.source === 'project' ? <label>Project<select aria-label={`Project for ${question.chatName}`} value={question.options.includes(draft) ? draft : ''} onChange={event => change(event.target.value)}><option value="">Choose a project</option>{question.options.map(option => <option key={option}>{option}</option>)}</select></label> : !!question.options.length && <div className="question-options" role="group" aria-label={`Suggested answers for ${question.chatName}`}>{question.options.map(option => <button key={option} type="button" aria-pressed={draft === option} onClick={() => change(option)}>{option}</button>)}</div>}
    {question.source !== 'native' && !approval && <><label htmlFor={`question-answer-${question.id}`}>Your answer</label>
    <textarea id={`question-answer-${question.id}`} aria-label={`Answer ${question.chatName}`} value={draft} onChange={event => change(event.target.value)} placeholder="Choose an answer or type your own…" rows={2} maxLength={64000} /></>}
    {error && <p className="question-error" role="alert">{error}</p>}
    <footer>{question.threadId && question.source !== 'native' && <button type="button" onClick={() => void selectThread(question.threadId!).catch(reportError)}>Open originating conversation</button>}{(!question.source || question.source === 'native') && <button type="button" onClick={() => void openTerminal().catch(reportError)}>Open terminal</button>}{question.source !== 'project' && question.source !== 'native' && !approval && <button type="button" onClick={() => void dismiss()} disabled={busy || !connected}>Dismiss</button>}<button className="question-send" type="button" onClick={() => void send()} disabled={!draft.trim() || approval && !question.options.includes(draft) || busy || !connected}>{busy ? 'Sending…' : approval ? 'Confirm decision' : 'Send answer'}</button></footer>
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
    <WorkerDecisions decisions={state.workerDecisions} />
    <FileRequestReferences />
  </section>
}
