import { useState } from 'react'
import { api, reportError, selectThread, useDesktop } from './client'
import { conversationAttention } from './conversationAttention'
import type { AlphaThread, Operation } from './types'
import DeleteConversationDialog from './DeleteConversationDialog'

type LegacyHistory = { operations: Operation[]; voiceHistory: { id: string; at: string; captions: { role: string; text: string }[] }[] }

export default function ConversationHistory() {
  const state = useDesktop()
  const [review, setReview] = useState<(AlphaThread & { reasons: string[] })[] | null>(null)
  const [legacy, setLegacy] = useState<LegacyHistory | null>(null)
  const [deleting, setDeleting] = useState<{ id: string; name: string } | null>(null)
  const [retrying, setRetrying] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const open = async (item: AlphaThread) => {
    if (item.archived) await api(`/threads/${item.id}/reopen`, {})
    await selectThread(item.id)
    document.getElementById(`conversation-tab-${item.id}`)?.focus()
  }
  const load = async (kind: 'review' | 'legacy') => {
    setBusy(true)
    try {
      if (kind === 'review') { const data = await api<{ items: (AlphaThread & { reasons: string[] })[] }>('/threads/review'); setReview(data.items); setLegacy(null) }
      else { setLegacy(await api<LegacyHistory>('/threads/legacy')); setReview(null) }
    } catch (error) { reportError(error) }
    finally { setBusy(false) }
  }
  return <section className="utility-document conversation-history-panel" aria-label="Conversation history">
    <header><h1>Conversation history</h1></header>
    <p>Open a conversation to return to its own history, draft and project. Running work continues when a conversation is closed.</p>
    <nav className="utility-actions" aria-label="History views">
      <button aria-pressed={!review && !legacy} onClick={() => { setReview(null); setLegacy(null) }}>Conversations</button>
      <button disabled={busy} aria-pressed={!!review} onClick={() => void load('review')}>Review conversation metadata</button>
      <button disabled={busy} aria-pressed={!!legacy} onClick={() => void load('legacy')}>Older mixed Alpha history</button>
    </nav>
    {!review && !legacy && <div className="conversation-history">
      {!!state.pendingConversationDeletions?.length && <><h2>Cleanup pending</h2><p>These conversations are already hidden and cannot resume. Retry removes their remaining Alpha-owned local state.</p>{state.pendingConversationDeletions.map(item => <article key={item.id}><span><strong>{item.name}</strong><small>Deleted {new Date(item.deletedAt).toLocaleString()} · {item.id}</small></span><button disabled={retrying === item.id} onClick={() => { setRetrying(item.id); void api(`/threads/${item.id}/delete`, {}, 'DELETE').catch(reportError).finally(() => setRetrying(null)) }}>Retry cleanup</button></article>)}</>}
      {!state.threads.length && !state.pendingConversationDeletions?.length && <p>No conversations yet.</p>}
      {state.threads.map(item => <article key={item.id}><button onClick={() => void open(item).catch(reportError)}><strong>{item.name}</strong><span>{item.projectId || 'Unassigned'}{item.archived ? ' · History' : ''}</span>{conversationAttention(state, item).label && <small>{conversationAttention(state, item).label}</small>}</button><button onClick={() => setDeleting({ id: item.id, name: item.name })} aria-label={`Delete ${item.name}`}>Delete</button></article>)}
    </div>}
    {review && <div className="thread-legacy"><h2>Review conversation metadata</h2><p>Only titles, purposes and project assignments are reviewed. Nothing is changed automatically. Open a conversation and use Conversation details to edit it.</p>{review.length === 0 && <p>No missing metadata.</p>}{review.map(item => <article key={item.id}><strong>{item.name}</strong><p>{item.projectId || 'Unassigned'} · {item.reasons.join(' · ')}{item.archived ? ' · History' : ''}</p><button onClick={() => void open(item).catch(reportError)}>Review {item.name}</button></article>)}</div>}
    {legacy && <div className="thread-legacy"><h2>Older mixed Alpha history</h2><p>Read-only archive. These entries are not added to any conversation’s context.</p>{legacy.operations.map(item => <article key={item.id}><p>You: {item.text}</p><p>Alpha: {item.result}</p></article>)}{legacy.voiceHistory.map(item => <article key={item.id}><small>Voice: {new Date(item.at).toLocaleString()}</small>{item.captions.map((caption, index) => <p key={index}>{caption.role === 'user' ? 'You' : 'Alpha'}: {caption.text}</p>)}</article>)}</div>}
    {deleting && <DeleteConversationDialog conversation={deleting} close={() => setDeleting(null)} />}
  </section>
}
