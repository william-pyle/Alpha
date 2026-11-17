import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { api, onServiceEvent, reportError, selectThread, useDesktop } from './client'
import type { AlphaThread, Operation, ThreadMessage } from './types'
import { liveVoice } from './live'
import MakComposer from './MakComposer'
import MakImages from './MakImages'
import LearningPanel from './LearningPanel'
import TerminalPane from './TerminalPane'
import { NewChat } from './Chats'
import './conversation-pane.css'
import './threads.css'
const ignoreAttachmentStatus = () => {}

function NewConversation({ close }: { close: () => void }) {
  const [name, setName] = useState(''), [projectId, setProject] = useState(''), [busy, setBusy] = useState(false)
  const [projects, setProjects] = useState<{ id: string; title: string }[]>([])
  const [native, setNative] = useState(false)
  useEffect(() => { void api<{ entities: typeof projects }>('/workspace').then(data => setProjects(data.entities)).catch(reportError) }, [])
  if (native) return <NewChat close={close} />
  return <div className="desk-scrim"><form className="desk-dialog" onSubmit={event => {
    event.preventDefault(); setBusy(true)
    void api<AlphaThread>('/threads', { name, projectId: projectId || null }).then(async thread => { await selectThread(thread.id); close() }).catch(reportError).finally(() => setBusy(false))
  }}><h2>New conversation</h2><label className="desk-field">Name<input autoFocus value={name} onChange={event => setName(event.target.value)} maxLength={100} placeholder="What are we working on?" /></label><label className="desk-field">Project<select aria-label="Project for conversation" value={projectId} onChange={event => setProject(event.target.value)}><option value="">Ask me in Questions</option>{projects.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label><p>One Alpha. A separate history and draft for this conversation.</p><button disabled={busy} type="submit">Create conversation</button><button type="button" onClick={close}>Cancel</button><details><summary>Advanced launchers</summary><button type="button" onClick={() => setNative(true)}>New native conversation</button></details></form></div>
}

function Activity({ thread }: { thread: AlphaThread }) {
  const state = useDesktop()
  const [open, setOpen] = useState(false), [controls, setControls] = useState(false), [worker, setWorker] = useState(thread.sessionIds[0] || '')
  const session = state.sessions.find(item => item.id === (worker || thread.sessionIds[0]))
  return <details className="thread-activity" onToggle={event => setOpen(event.currentTarget.open)}><summary>Activity · {thread.sessionIds.length} worker{thread.sessionIds.length === 1 ? '' : 's'}</summary>{open && <>
    {!session ? <p>Tools and worker output will appear here when this conversation starts work.</p> : <>
      <select aria-label="Activity worker" value={worker} onChange={event => { setControls(false); setWorker(event.target.value) }}>{thread.sessionIds.map(id => <option value={id} key={id}>{state.sessions.find(item => item.id === id)?.name || id}</option>)}</select>
      <p>Work output · {session.status} · native history preserved</p>
      {session.status !== 'running' && <button onClick={() => void api(`/sessions/${session.id}/resume`, {}).catch(reportError)}>Resume worker</button>}
      <button aria-pressed={controls} onClick={() => setControls(value => !value)}>{controls ? 'Lock terminal controls' : 'Enable terminal controls'}</button>
      {controls && <p>Use these controls for native permission prompts or CLI recovery. Our conversation stays above.</p>}
      <div className="thread-terminal"><TerminalPane key={`${session.id}:${controls}`} id={session.id} agent={session.agent} fontSize={state.settings.terminalFontSize || 13} appearance={state.settings.terminalAppearance || 'original'} readOnly={!controls} onAttachmentStatus={ignoreAttachmentStatus} /></div>
    </>}
  </>}</details>
}

function Attention() {
  const state = useDesktop(), awareness = state.awareness
  const thread = state.threads.find(item => item.id === state.selectedThreadId)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!awareness.settings.enabled || !awareness.settings.desktop) return
    const sample = () => { if (document.visibilityState === 'visible') void api('/awareness/desktop', {}).catch(reportError) }
    sample(); const timer = window.setInterval(sample, 5000)
    return () => clearInterval(timer)
  }, [awareness.settings.enabled, awareness.settings.desktop])
  const control = (value: object) => void api('/awareness', value).catch(reportError)
  const items = awareness.items.filter(item => item.threadId !== state.selectedThreadId || item.kind !== 'review')
  return <details className="thread-attention" open={open} onToggle={event => setOpen(event.currentTarget.open)}><summary>Awareness · {awareness.settings.enabled ? awareness.settings.quiet ? 'quiet' : `${items.length} notices` : 'paused'}{awareness.settings.desktop ? ' · app names on' : ''}</summary>
    <div className="alpha-conversation-toolbar"><button onClick={() => control({ enabled: !awareness.settings.enabled })}>{awareness.settings.enabled ? 'Pause awareness' : 'Resume awareness'}</button><button aria-pressed={awareness.settings.quiet} onClick={() => control({ quiet: !awareness.settings.quiet })}>Quiet mode</button><button aria-pressed={awareness.settings.desktop} onClick={() => control({ desktop: !awareness.settings.desktop })}>{awareness.settings.desktop ? 'Stop app context' : 'Enable app names only'}</button></div>
    <p>Source: Alpha session and Workspace events. Optional Windows context reads only the foreground application name, at most every five seconds. No titles, screen, clipboard or input capture; current sample stays in memory.</p>
    {awareness.desktop && <p role="status">Observed: {awareness.desktop.application} · {new Date(awareness.desktop.at).toLocaleTimeString()}</p>}
    {thread && awareness.settings.desktop && <label><input type="checkbox" checked={!!thread.desktopContext} onChange={event => void api(`/threads/${thread.id}`, { desktopContext: event.target.checked }, 'PATCH').catch(reportError)} />Share current app name with this conversation</label>}
    {!awareness.settings.quiet && awareness.settings.enabled && items.map(item => <article key={item.id}><small>{item.inference ? 'Suggestion based on metadata' : 'Observed event'} · {item.source} · {new Date(item.at).toLocaleTimeString()}</small><p>{item.text}</p>{item.threadId && <button onClick={() => void selectThread(item.threadId!).catch(reportError)}>Open conversation</button>}<button onClick={() => control({ id: item.id, action: 'dismiss' })}>Dismiss</button><button onClick={() => control({ id: item.id, action: 'snooze' })}>Snooze 30 minutes</button></article>)}
  </details>
}

export default function ThreadConversations() {
  const state = useDesktop(), live = useSyncExternalStore(liveVoice.subscribe, liveVoice.snapshot)
  const thread = state.threads.find(item => item.id === state.selectedThreadId)
  const [newThread, setNewThread] = useState(false), [history, setHistory] = useState(false), [learning, setLearning] = useState(false), [sending, setSending] = useState<string[]>([])
  const [legacy, setLegacy] = useState<Operation[] | null>(null), [progress, setProgress] = useState({ threadId: '', text: '' })
  const [legacyVoice, setLegacyVoice] = useState<{ id: string; at: string; captions: { role: string; text: string }[] }[]>([])
  const [sharing, setSharing] = useState<{ sourceId: string; message: ThreadMessage } | null>(null), [destination, setDestination] = useState('')
  const [editing, setEditing] = useState(false), [name, setName] = useState(''), [purpose, setPurpose] = useState('')
  const bottom = useRef<HTMLDivElement>(null), seen = useRef(new Set<string>()), hydrated = useRef(false)
  const previousSelection = useRef(state.selectedThreadId)
  const [older, setOlder] = useState<Record<string, ThreadMessage[]>>({})
  const messages = thread ? [...(older[thread.id] || []).filter(item => !thread.messages.some(recent => recent.id === item.id)), ...thread.messages] : []
  const active = ['live', 'connecting', 'closing'].includes(live.status)
  useEffect(() => onServiceEvent(event => {
    if (event.type === 'disconnected') liveVoice.disconnect()
    if (event.type === 'thread-progress') setProgress({ threadId: event.threadId || '', text: event.text || '' })
    if (event.type === 'coordinator-result') setProgress(current => current.threadId === event.operation?.threadId ? { threadId: '', text: '' } : current)
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
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }) }, [thread?.id, thread?.messages.length, progress.text, live.captions])
  const send = async (text: string, images: string[]) => {
    if (!thread) return
    const id = thread.id
    setSending(current => [...current, id])
    try { await api(`/threads/${thread.id}/input`, { id: crypto.randomUUID(), text, images }) }
    finally { setSending(current => current.filter(item => item !== id)) }
  }
  return <section className="alpha-conversation-pane thread-conversation" aria-label="Alpha conversation">
    <header><strong>Alpha</strong><small>{thread?.status || 'Here with you'}</small></header>
    <div className="thread-picker"><select aria-label="Conversation" value={thread?.id || ''} onChange={event => void selectThread(event.target.value).catch(reportError)}><option value="" disabled>Choose a conversation</option>{state.threads.filter(item => history || !item.archived || item.id === thread?.id).map(item => <option key={item.id} value={item.id}>{item.unread ? '● ' : ''}{item.name} · {item.projectId || 'Project needed'}{item.archived ? ' · archived' : ''}</option>)}</select><button onClick={() => setNewThread(true)}>New conversation</button><button aria-pressed={history} onClick={() => setHistory(value => !value)}>History</button>{thread && <button onClick={() => { setName(thread.name); setPurpose(thread.purpose); setEditing(true) }}>Conversation details</button>}</div>
    <Attention />
    <div className="alpha-conversation-toolbar"><button onClick={() => setLearning(value => !value)}>What I've learned</button><button aria-pressed={state.settings.speakReplies !== false} onClick={() => void api('/settings', { speakReplies: state.settings.speakReplies === false }).catch(reportError)}>Speak replies</button>{state.speech.speaking && <button onClick={() => void api('/speech/stop', {}).catch(reportError)}>Stop speaking</button>}{state.voice.configured && thread && <button onClick={() => active ? liveVoice.stopImmediately() : void liveVoice.start() }>{active ? 'End live voice' : 'Live voice'}</button>}{history && <button onClick={() => void api<{ operations: Operation[]; voiceHistory: typeof legacyVoice }>('/threads/legacy').then(value => { setLegacy(value.operations); setLegacyVoice(value.voiceHistory) }).catch(reportError)}>Older mixed Alpha history</button>}</div>
    {learning ? <LearningPanel onClose={() => setLearning(false)} /> : <div className="alpha-conversation-scroll" aria-live="polite">
      {!thread && <div className="alpha-conversation-welcome"><strong>Hi, I'm Alpha.</strong><p>Start a conversation. Each one keeps its own history, draft and project while I keep track of the others' purposes and statuses.</p></div>}
      {thread?.projectPending && <p>Choose this conversation's project in Questions before sending work.</p>}
      {thread?.archived && <button onClick={() => void api(`/threads/${thread.id}/resume`, {}).catch(reportError)}>Resume conversation</button>}
      {thread?.kind === 'native' && !thread.nativeHistoryImported && <button onClick={() => void api(`/threads/${thread.id}/native-history`, {}).catch(reportError)}>Load earlier native conversation</button>}
      {thread && messages.length < (thread.messageCount || 0) && <button onClick={() => { const id = thread.id; void api<{ messages: ThreadMessage[] }>(`/threads/${id}/messages?offset=${Math.max(0, (thread.messageCount || 0) - messages.length - 50)}`).then(value => setOlder(current => ({ ...current, [id]: [...value.messages, ...(current[id] || [])] }))).catch(reportError) }}>Earlier messages</button>}
      {thread && messages.filter(message => !active || message.source !== 'voice').map(message => <div key={message.id} role={message.status === 'failed' ? 'alert' : undefined} className={message.role === 'user' ? 'alpha-conversation-user' : 'alpha-conversation-reply'}><span>{message.role === 'user' ? 'You' : 'Alpha'}</span><p>{message.text}</p>{!!message.images?.length && <MakImages paths={message.images} />}{message.error && <p role="alert">{message.error}</p>}{message.role === 'assistant' && <button aria-label="Speak Alpha reply" onClick={() => void api('/speech/speak', { source: 'thread', threadId: thread.id, id: message.id }).catch(reportError)}>▶</button>}<button aria-label="Share this message" onClick={() => { setSharing({ sourceId: thread.id, message }); setDestination('') }}>Share…</button></div>)}
      {progress.threadId === thread?.id && progress.text && <p className="alpha-conversation-reply">{progress.text}</p>}
      {active && live.captions.map((item, index) => <p key={index} className={item.role === 'user' ? 'alpha-conversation-user' : 'alpha-conversation-reply'}><span>{item.role === 'user' ? 'You · voice' : 'Alpha · voice'}</span>{item.text}</p>)}
      <div ref={bottom} />
    </div>}
    {(live.error || state.speech.error) && <p role="alert">{live.error || state.speech.error}</p>}
    {thread && !learning && <MakComposer key={`composer:${thread.id}`} draftId={thread.id} connected={state.connected && !thread.projectPending && !thread.archived} sending={sending.includes(thread.id)} onSend={send} autoSendVoice />}
    {thread && <Activity key={`activity:${thread.id}`} thread={thread} />}
    {newThread && <NewConversation close={() => setNewThread(false)} />}
    {editing && thread && <div className="desk-scrim"><form className="desk-dialog" onSubmit={event => { event.preventDefault(); void api(`/threads/${thread.id}`, { name, purpose }, 'PATCH').then(() => setEditing(false)).catch(reportError) }}><h2>Conversation details</h2><label className="desk-field">Title<input value={name} onChange={event => setName(event.target.value)} /></label><label className="desk-field">Purpose<input value={purpose} onChange={event => setPurpose(event.target.value)} maxLength={240} /></label><p>Title, purpose, project and status are visible to other conversations. Detailed messages stay here.</p><button type="submit">Save details</button><button type="button" onClick={() => setEditing(false)}>Cancel</button><button type="button" onClick={() => void api(`/threads/${thread.id}`, { archived: true }, 'PATCH').then(() => setEditing(false)).catch(reportError)}>Archive conversation · keep workers running</button></form></div>}
    {sharing && <div className="desk-scrim"><form className="desk-dialog thread-legacy" onSubmit={event => { event.preventDefault(); void api(`/threads/${sharing.sourceId}/share`, { destinationId: destination, messageId: sharing.message.id, transferId: crypto.randomUUID() }).then(() => setSharing(null)).catch(reportError) }}><h2>Share one message</h2><p>Only this text will be copied. Attachments and the rest of the conversation stay private. This does not start work.</p><blockquote>{sharing.message.text}</blockquote><label className="desk-field">Destination<select required value={destination} onChange={event => setDestination(event.target.value)}><option value="">Choose a conversation</option>{state.threads.filter(item => item.id !== sharing.sourceId).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><button type="submit" disabled={!destination}>Share this text</button><button type="button" onClick={() => setSharing(null)}>Cancel</button></form></div>}
    {legacy && <div className="desk-scrim"><section className="desk-dialog thread-legacy"><h2>Older mixed Alpha history</h2><p>Read-only archive. These entries are not added to any conversation's context.</p><button onClick={() => setLegacy(null)}>Close archive</button>{legacy.map(item => <article key={item.id}><p>You: {item.text}</p><p>Alpha: {item.result}</p></article>)}{legacyVoice.map(item => <article key={item.id}><small>Voice: {new Date(item.at).toLocaleString()}</small>{item.captions.map((caption, index) => <p key={index}>{caption.role === 'user' ? 'You' : 'Alpha'}: {caption.text}</p>)}</article>)}</section></div>}
  </section>
}
