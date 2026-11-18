import { lazy, Suspense, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { api, onServiceEvent, reportError, selectThread, useDesktop } from './client'
import type { AlphaThread, Operation, ThreadMessage } from './types'
import { liveVoice } from './live'
import MakComposer from './MakComposer'
import MakImages from './MakImages'
import LearningPanel from './LearningPanel'
import { conversationAttention, importantEvents } from './conversationAttention'
import ConversationContextMenu, { type ConversationMenuOrigin } from './ConversationContextMenu'
import ConversationTabs from './ConversationTabs'
import WorkerActivity from './WorkerActivity'
import { NewChat } from './Chats'
import './conversation-pane.css'
import './threads.css'
import ConversationDialog from './ConversationDialog'
import ConversationMarkdown from './ConversationMarkdown'
import CompletionSummary from './CompletionSummary'
import ConversationSearch from './ConversationSearch'
import MessageMenu from './MessageMenu'
import LayoutRegion from './LayoutRegion'
const AlphaPresence = lazy(() => import('./AlphaPresence'))


function NewConversation({ close }: { close: () => void }) {
  const [name, setName] = useState(''), [purpose, setPurpose] = useState(''), [projectId, setProject] = useState(''), [busy, setBusy] = useState(false)
  const [projects, setProjects] = useState<{ id: string; title: string }[]>([])
  const [native, setNative] = useState(false)
  useEffect(() => { void api<{ entities: typeof projects }>('/workspace').then(data => setProjects(data.entities)).catch(reportError) }, [])
  if (native) return <NewChat close={close} />
  return <div className="desk-scrim"><form className="desk-dialog" onSubmit={event => {
    event.preventDefault(); setBusy(true)
    void api<AlphaThread>('/threads', { name, purpose, projectId: projectId || null }).then(async thread => { await selectThread(thread.id); close() }).catch(reportError).finally(() => setBusy(false))
  }}><h2>New conversation</h2><label className="desk-field">Name<input autoFocus value={name} onChange={event => setName(event.target.value)} maxLength={100} placeholder="Example: Alpha response speed" /></label><label className="desk-field">Purpose<input required value={purpose} onChange={event => setPurpose(event.target.value)} maxLength={240} placeholder="What result should this conversation produce?" /></label><p>Leave the name blank to use the first words of your purpose.</p><label className="desk-field">Project<select aria-label="Project for conversation" value={projectId} onChange={event => setProject(event.target.value)}><option value="">Ask me in Questions</option>{projects.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label><p>One Alpha. A separate history and draft for this conversation.</p><button disabled={busy} type="submit">Create conversation</button><button type="button" onClick={close}>Cancel</button><details><summary>Advanced launchers</summary><button type="button" onClick={() => setNative(true)}>New native conversation</button></details></form></div>
}

export default function ThreadConversations() {
  const state = useDesktop(), live = useSyncExternalStore(liveVoice.subscribe, liveVoice.snapshot)
  const thread = state.threads.find(item => item.id === state.selectedThreadId)
  const raw = thread?.viewMode === 'terminal'
  const [visited, setVisited] = useState<string[]>([])
  if (thread && raw && !visited.includes(thread.id)) setVisited([...visited, thread.id])
  const [context, setContext] = useState<ConversationMenuOrigin | null>(null)
  const [closing, setClosing] = useState<{ id: string; name: string } | null>(null), [closeBusy, setCloseBusy] = useState(false)
  const [newThread, setNewThread] = useState(false), [history, setHistory] = useState(false), [learning, setLearning] = useState(false), [sending, setSending] = useState<string[]>([])
  const [workOpen, setWorkOpen] = useState(false), [searchOpen, setSearchOpen] = useState(false)
  useEffect(() => { const search = () => setSearchOpen(true), work = () => setWorkOpen(true); window.addEventListener('alpha-search-conversation', search); window.addEventListener('alpha-work-details', work); return () => { window.removeEventListener('alpha-search-conversation', search); window.removeEventListener('alpha-work-details', work) } }, [])
  useEffect(() => {
    const reveal = (event: Event) => { const id = (event as CustomEvent<string>).detail; const owner = state.threads.find(item => item.sessionIds.includes(id)); if (owner) void api(`/threads/${owner.id}/view`, { workerId: id }).then(() => selectThread(owner.id)).then(() => setWorkOpen(true)).catch(reportError) }
    window.addEventListener('alpha-open-activity', reveal)
    return () => window.removeEventListener('alpha-open-activity', reveal)
  }, [state.threads])
  const [legacy, setLegacy] = useState<Operation[] | null>(null), [progressByThread, setProgress] = useState<Record<string, string>>({})
  const progress = thread ? progressByThread[thread.id] || '' : ''
  const [legacyVoice, setLegacyVoice] = useState<{ id: string; at: string; captions: { role: string; text: string }[] }[]>([])
  const [messageMenu, setMessageMenu] = useState<{ x: number; y: number; origin: HTMLElement; selectedText: string; sourceId: string; message: ThreadMessage } | null>(null)
  const [sharing, setSharing] = useState<{ sourceId: string; message: ThreadMessage } | null>(null), [destination, setDestination] = useState('')
  const [review, setReview] = useState<(AlphaThread & { reasons: string[] })[] | null>(null)
  const [project, setProject] = useState(''), [projects, setProjects] = useState<{ id: string; title: string }[]>([])
  const [editing, setEditing] = useState<AlphaThread | null>(null), [name, setName] = useState(''), [purpose, setPurpose] = useState('')
  const bottom = useRef<HTMLDivElement>(null), seen = useRef(new Set<string>()), hydrated = useRef(false)
  const previousSelection = useRef(state.selectedThreadId)
  const [older, setOlder] = useState<Record<string, ThreadMessage[]>>({})
  const messages = thread ? [...(older[thread.id] || []).filter(item => !thread.messages.some(recent => recent.id === item.id)), ...thread.messages] : []
  const active = ['live', 'connecting', 'closing'].includes(live.status)
  useEffect(() => onServiceEvent(event => {
    if (event.type === 'disconnected') liveVoice.disconnect()
    if (event.type === 'thread-progress' && event.threadId) setProgress(current => ({ ...current, [event.threadId!]: event.text || '' }))
    if (event.type === 'coordinator-result' && event.operation?.threadId) setProgress(current => ({ ...current, [event.operation!.threadId!]: '' }))
  }), [])
  useEffect(() => {
    const switchThread = () => liveVoice.stopImmediately()
    window.addEventListener('alpha-thread-switch', switchThread)
    return () => window.removeEventListener('alpha-thread-switch', switchThread)
  }, [])
  useEffect(() => {
    const switched = previousSelection.current !== state.selectedThreadId
    previousSelection.current = state.selectedThreadId
    for (const item of state.threads) for (const message of item.messages) {
      const key = `${item.id}:${message.id}`
      if (seen.current.has(key)) continue
      seen.current.add(key)
      if (hydrated.current && !switched && item.id === state.selectedThreadId && message.role === 'assistant' && message.status !== 'failed' && message.source !== 'voice') {
        if (active) liveVoice.announce(message.text)
        else if (state.settings.speakReplies !== false && !state.voice.owner && !state.awareness.settings.quiet) void api('/speech/speak', { source: 'thread', threadId: item.id, id: message.id }).catch(reportError)
      }
    }
    hydrated.current = true
  }, [state.threads, state.selectedThreadId, state.settings.speakReplies, state.voice.owner, state.awareness.settings.quiet, active])
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }) }, [thread?.id, thread?.messages.length, progress, live.captions])
  useEffect(() => {
    const history = () => setHistory(true), learning = () => setLearning(true), create = () => setNewThread(true)
    window.addEventListener('alpha-conversation-history', history); window.addEventListener('alpha-learned-preferences', learning); window.addEventListener('alpha-new-conversation', create)
    return () => { window.removeEventListener('alpha-conversation-history', history); window.removeEventListener('alpha-learned-preferences', learning); window.removeEventListener('alpha-new-conversation', create) }
  }, [])
  const contextThread = state.threads.find(item => item.id === context?.id)
  const contextItems = [
    ...(contextThread ? [
      { label: 'Search this conversation', run: () => void selectThread(contextThread.id).then(() => { void api(`/threads/${contextThread.id}/view`, { viewMode: 'alpha' }).then(() => setSearchOpen(true)).catch(reportError) }).catch(reportError) },
      { label: 'Conversation details', run: () => { setName(contextThread.name); setPurpose(contextThread.purpose); setProject(contextThread.projectId || ''); void api<{ entities: typeof projects }>('/workspace').then(data => setProjects(data.entities)).catch(reportError); setEditing(contextThread) } },
      { label: 'Work details', run: () => void selectThread(contextThread.id).then(() => setWorkOpen(true)).catch(reportError) },
      ...(contextThread.archived ? [{ label: 'Reopen conversation', run: () => void api(`/threads/${contextThread.id}/reopen`, {}).catch(reportError) }] : []),
      { label: 'Close conversation', run: () => setClosing({ id: contextThread.id, name: contextThread.name }) },
    ] : []),
    { label: 'History', run: () => setHistory(true) },
    { label: `Important events (${importantEvents(state).length})`, run: () => window.dispatchEvent(new Event('alpha-important-events')) },
    { label: "What I've learned", run: () => setLearning(true) },
  ]
  const send = async (text: string, images: string[]) => {
    if (!thread) return
    const id = thread.id
    setSending(current => [...current, id])
    try { await api(`/threads/${thread.id}/input`, { id: crypto.randomUUID(), text, images }) }
    finally { setSending(current => current.filter(item => item !== id)) }
  }
  return <section className="alpha-conversation-pane thread-conversation" aria-label="Alpha conversation">
    <div className="thread-picker">
      <ConversationTabs threads={state.threads} selectedId={state.selectedThreadId} context={setContext} />
      <button aria-label="New conversation" title="New conversation" onClick={() => setNewThread(true)}>+</button>

    </div>
    {state.settings.viewerEnabled && <LayoutRegion kind="viewer"><Suspense fallback={<div>Loading viewer...</div>}><AlphaPresence /></Suspense></LayoutRegion>}
    <div id="conversation-content" role="tabpanel" aria-labelledby={thread ? `conversation-tab-${thread.id}` : undefined} className="conversation-content">
    <div className="alpha-conversation-scroll" aria-live="polite" hidden={raw} tabIndex={0} aria-label="Conversation feed" onContextMenu={event => {
      if ((event.target as HTMLElement).closest('[data-message-id],button,input,textarea,a,.terminal-area')) return
      event.preventDefault(); setContext({ id: thread?.id || null, x: event.clientX, y: event.clientY, origin: event.currentTarget })
    }} onKeyDown={event => {
      if (event.target !== event.currentTarget || !(event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10')) return
      event.preventDefault(); const box = event.currentTarget.getBoundingClientRect(); setContext({ id: thread?.id || null, x: box.left + 16, y: box.top + 16, origin: event.currentTarget })
    }}>
      {!thread && <div className="alpha-conversation-welcome"><strong>Hi, I'm Alpha.</strong><p>Start a conversation to begin, or reopen one from History.</p><button onClick={() => setHistory(true)}>History</button></div>}
      {thread?.projectPending && <p>Choose this conversation's project in Questions before sending work.</p>}
      {thread?.archived && <button onClick={() => void api(`/threads/${thread.id}/reopen`, {}).catch(reportError)}>Reopen conversation</button>}
      {thread?.kind === 'native' && !thread.nativeHistoryImported && <button onClick={() => void api(`/threads/${thread.id}/native-history`, {}).catch(reportError)}>Load earlier native conversation</button>}
      {thread && messages.length < (thread.messageCount || 0) && <button onClick={() => { const id = thread.id; void api<{ messages: ThreadMessage[] }>(`/threads/${id}/messages?offset=${Math.max(0, (thread.messageCount || 0) - messages.length - 50)}`).then(value => setOlder(current => ({ ...current, [id]: [...value.messages, ...(current[id] || [])] }))).catch(reportError) }}>Earlier messages</button>}
      {thread && messages.filter(message => !active || message.source !== 'voice').map(message => <div key={message.id} tabIndex={0} data-message-id={message.id} aria-label={`${message.role === 'user' ? 'Your' : 'Alpha'} message`} onContextMenu={event => {
        if ((event.target as HTMLElement).closest('a,button,input,textarea')) return
        event.preventDefault(); setMessageMenu({ x: event.clientX, y: event.clientY, origin: event.currentTarget, selectedText: window.getSelection()?.toString() || '', sourceId: thread.id, message })
      }} onKeyDown={event => { if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); const box = event.currentTarget.getBoundingClientRect(); setMessageMenu({ x: Math.max(8, box.left + 16), y: Math.min(innerHeight - 8, box.top + 32), origin: event.currentTarget, selectedText: window.getSelection()?.toString() || '', sourceId: thread.id, message }) } }} role={message.status === 'failed' ? 'alert' : undefined} className={message.role === 'user' ? 'alpha-conversation-user' : 'alpha-conversation-reply'}><span>{message.role === 'user' ? 'You' : 'Alpha'}</span><CompletionSummary message={message} pending={state.questions.some(question => question.threadId === thread.id)} />{!!message.images?.length && <MakImages paths={message.images} />}{message.error && <p role="alert">{message.error}</p>}</div>)}
      {progress && <div className="alpha-conversation-reply"><ConversationMarkdown text={progress} /></div>}
      {active && live.captions.map((item, index) => <p key={index} className={item.role === 'user' ? 'alpha-conversation-user' : 'alpha-conversation-reply'}><span>{item.role === 'user' ? 'You Â· voice' : 'Alpha Â· voice'}</span>{item.text}</p>)}
      <div ref={bottom} />
    </div>
    {visited.map(id => { const item = state.threads.find(candidate => candidate.id === id); return item && <WorkerActivity key={id} thread={item} active={id === thread?.id && !!raw && !workOpen} /> })}
    </div>
    {raw && <div className="composer-destination">Alpha draft saved below. Switch to Alpha view to send it.</div>}
    {thread && <MakComposer key={`composer:${thread.id}`} draftId={thread.id} initialDraft={thread.draft} connected={state.connected && !thread.projectPending && !thread.archived && !raw} sending={sending.includes(thread.id)} onSend={send} autoSendVoice />}
    {context && <ConversationContextMenu target={context} items={contextItems} close={() => setContext(null)} />}
    {searchOpen && thread && <ConversationSearch key={thread.id} threadId={thread.id} close={() => setSearchOpen(false)} jump={(found, id) => { setOlder(current => ({ ...current, [thread.id]: [...new Map([...(current[thread.id] || []), ...found].map(message => [message.id, message])).values()].sort((a, b) => a.at.localeCompare(b.at)) })); requestAnimationFrame(() => requestAnimationFrame(() => { const node = Array.from(document.querySelectorAll<HTMLElement>('[data-message-id]')).find(element => element.dataset.messageId === id); node?.scrollIntoView({ block: 'center' }); node?.focus({ preventScroll: true }) })) }} />}
    {workOpen && <ConversationDialog title="Work details" close={() => setWorkOpen(false)}>{thread && <WorkerActivity key={thread.id} thread={thread} active />}</ConversationDialog>}
    {learning && <ConversationDialog title="Learned preferences" close={() => setLearning(false)}><LearningPanel onClose={() => setLearning(false)} /></ConversationDialog>}
    {history && <ConversationDialog title="Conversation history" close={() => setHistory(false)}><div className="conversation-history">{state.threads.map(item => <button key={item.id} onClick={() => void (item.archived ? api(`/threads/${item.id}/reopen`, {}) : Promise.resolve()).then(() => selectThread(item.id)).then(() => setHistory(false)).catch(reportError)}>{item.name} - {item.projectId || 'Unassigned'}{item.archived ? ' (archived)' : ''}{conversationAttention(state, item).label ? ` ? ${conversationAttention(state, item).label}` : ''}</button>)}</div><button onClick={() => { setHistory(false); void api<{ items: (AlphaThread & { reasons: string[] })[] }>('/threads/review').then(data => setReview(data.items)).catch(reportError) }}>Review conversation metadata</button><button onClick={() => { setHistory(false); void api<{ operations: Operation[]; voiceHistory: typeof legacyVoice }>('/threads/legacy').then(value => { setLegacy(value.operations); setLegacyVoice(value.voiceHistory) }).catch(reportError) }}>Older mixed Alpha history</button></ConversationDialog>}
    {closing && <ConversationDialog title="Close conversation" close={() => { if (!closeBusy) setClosing(null) }}><p>Move <strong>{closing.name}</strong> to History? Its messages, draft and workers are preserved. Reopen it from History.</p><p>Running work continues. Pending questions stay in Questions and keep their original conversation.</p><button disabled={closeBusy} onClick={() => {
      const id = closing.id
      setCloseBusy(true)
      void api<{ archiveUndo?: { id: string } }>(`/threads/${id}/close`, {}).then(result => { setClosing(null); if (result.archiveUndo) window.dispatchEvent(new CustomEvent('alpha-organization-change', { detail: { threadId: id, undoId: result.archiveUndo.id } })) }).catch(reportError).finally(() => setCloseBusy(false))
    }}>Move to History</button><button disabled={closeBusy} onClick={() => setClosing(null)}>Cancel</button></ConversationDialog>}
    {newThread && <NewConversation close={() => setNewThread(false)} />}
    {editing && <div className="desk-scrim"><form className="desk-dialog" onSubmit={event => { event.preventDefault(); void api(`/threads/${editing.id}`, { name, purpose, projectId: project || null }, 'PATCH').then(() => setEditing(null)).catch(reportError) }}><h2>Conversation details</h2><label className="desk-field">Title<input value={name} onChange={event => setName(event.target.value)} /></label><label className="desk-field">Purpose<input value={purpose} onChange={event => setPurpose(event.target.value)} maxLength={240} /></label><label className="desk-field">Project<select aria-label="Conversation project" value={project} onChange={event => setProject(event.target.value)}><option value="">Ask me in Questions</option>{projects.map(item => <option value={item.id} key={item.id}>{item.title}</option>)}</select></label><p>Title, purpose, project and status are visible to other conversations. Detailed messages stay here.</p><button type="submit">Save details</button><button type="button" onClick={() => setEditing(null)}>Cancel</button><button type="button" onClick={() => { setClosing({ id: editing.id, name: editing.name }); setEditing(null) }}>Close conversation</button></form></div>}
    {review && <div className="desk-scrim"><section className="desk-dialog thread-legacy"><h2>Review conversation metadata</h2><p>Only titles, purposes and project assignments are reviewed. Open a conversation to edit its details. Nothing is changed automatically.</p><button onClick={() => setReview(null)}>Close review</button>{review.length === 0 && <p>No missing metadata.</p>}{review.map(item => <article key={item.id}><strong>{item.name}</strong><p>{item.projectId || 'Unassigned'} - {item.reasons.join(' - ')}{item.archived ? ' - Archived' : ''}</p><button onClick={() => void selectThread(item.id).then(() => setReview(null)).catch(reportError)}>Review {item.name}</button></article>)}</section></div>}
    {messageMenu && <MessageMenu {...messageMenu} text={messageMenu.message.text} close={() => setMessageMenu(null)} transfer={() => { setSharing({ sourceId: messageMenu.sourceId, message: messageMenu.message }); setDestination('') }} speak={messageMenu.message.role === 'assistant' ? () => void api('/speech/speak', { source: 'thread', threadId: messageMenu.sourceId, id: messageMenu.message.id }).catch(reportError) : undefined} />}
    {sharing && <ConversationDialog title="Copy to another conversation" close={() => setSharing(null)}><form className="thread-legacy" onSubmit={event => { event.preventDefault(); void api(`/threads/${sharing.sourceId}/share`, { destinationId: destination, messageId: sharing.message.id, transferId: crypto.randomUUID() }).then(() => setSharing(null)).catch(reportError) }}><p>Only this text will be copied. Attachments and the rest of the conversation stay private. This does not start work.</p><blockquote>{sharing.message.text}</blockquote><label className="desk-field">Destination<select required value={destination} onChange={event => setDestination(event.target.value)}><option value="">Choose a conversation</option>{state.threads.filter(item => item.id !== sharing.sourceId).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><button type="submit" disabled={!destination}>Copy message</button><button type="button" onClick={() => setSharing(null)}>Cancel</button></form></ConversationDialog>}
    {legacy && <div className="desk-scrim"><section className="desk-dialog thread-legacy"><h2>Older mixed Alpha history</h2><p>Read-only archive. These entries are not added to any conversation's context.</p><button onClick={() => setLegacy(null)}>Close archive</button>{legacy.map(item => <article key={item.id}><p>You: {item.text}</p><p>Alpha: {item.result}</p></article>)}{legacyVoice.map(item => <article key={item.id}><small>Voice: {new Date(item.at).toLocaleString()}</small>{item.captions.map((caption, index) => <p key={index}>{caption.role === 'user' ? 'You' : 'Alpha'}: {caption.text}</p>)}</article>)}</section></div>}
  </section>
}
