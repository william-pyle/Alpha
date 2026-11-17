import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { api, clientId, onServiceEvent, reportError, useDesktop } from './client'
import { liveVoice } from './live'
import { Nose } from './Icons'
import MakComposer from './MakComposer'
import MakImages from './MakImages'
import LearningPanel from './LearningPanel'
import type { Operation } from './types'
import './conversation-pane.css'

type Entry = { id: string; at: string; kind: 'operation'; operation: Operation } | { id: string; at: string; kind: 'reply'; name: string; text: string }

export default function ConversationPane() {
  const state = useDesktop()
  const live = useSyncExternalStore(liveVoice.subscribe, liveVoice.snapshot)
  const [sending, setSending] = useState(false)
  const [learningOpen, setLearningOpen] = useState(false)
  const bottom = useRef<HTMLDivElement>(null)
  const seen = useRef<Set<string> | null>(null)
  const active = ['live', 'connecting', 'closing'].includes(live.status)
  const entries = useMemo<Entry[]>(() => [
    ...state.operations.filter(operation => operation.result?.trim() !== 'NO_CHANGE').map(operation => ({ id: `operation:${operation.id}`, at: operation.at, kind: 'operation' as const, operation })),
    ...state.replies.map(reply => ({ id: `reply:${reply.id}`, at: reply.at, kind: 'reply' as const, name: reply.name, text: reply.text })),
  ].sort((a, b) => a.at.localeCompare(b.at)).slice(-100), [state.operations, state.replies])

  useEffect(() => onServiceEvent(event => {
    if (event.type === 'disconnected') liveVoice.disconnect()
    if (event.type === 'notice' && event.notice) liveVoice.announce(`Verified terminal event: ${event.notice.text}. This does not by itself confirm that the project task succeeded.`)
    if (['session', 'navigate', 'connected'].includes(event.type)) liveVoice.context()
  }), [])
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }) }, [entries, live.captions])
  useEffect(() => {
    const completed = entries.filter(item => item.kind === 'reply' || item.operation.status === 'completed').map(item => item.id)
    if (!seen.current) { seen.current = new Set(completed); return }
    for (const id of completed) {
      if (seen.current.has(id)) continue
      seen.current.add(id)
      if (state.settings.speakReplies !== false && !active && !state.voice.owner) {
        const [source, ...rest] = id.split(':')
        void api('/speech/speak', { source, id: rest.join(':') }).catch(reportError)
      }
    }
  }, [entries, state.settings.speakReplies, state.voice.owner, active])

  const send = async (text: string, images: string[]) => {
    setSending(true)
    try {
      const operation = await api<Operation>('/coordinator', { id: crypto.randomUUID(), text, images, selectedId: state.selectedId })
      if (operation.status !== 'completed') throw new Error(operation.result || 'Alpha could not complete this request.')
    } finally { setSending(false) }
  }
  const speak = (source: 'reply' | 'operation', id: string) => api('/speech/speak', { source, id }).catch(reportError)
  const toggleSpeech = () => api('/settings', { speakReplies: state.settings.speakReplies === false }).catch(reportError)
  const toggleLive = () => active ? liveVoice.stop() : liveVoice.start()
  const anotherVoice = state.voice.owner && state.voice.owner.clientId !== clientId

  return <aside className="alpha-conversation-pane" aria-label="Alpha replies">
    <header><div className="alpha-conversation-brand"><Nose size={26} /><div><strong>Alpha</strong><small>Just our conversation</small></div></div><span className="alpha-conversation-status">{active ? live.status === 'live' ? 'Listening' : 'Connecting…' : state.coordinator === 'working' ? 'Thinking…' : 'Here with you'}</span></header>
    <div className="alpha-conversation-toolbar">
      <button type="button" aria-expanded={learningOpen} onClick={() => setLearningOpen(value => !value)}>What I&apos;ve learned</button>
      <button type="button" aria-pressed={state.settings.speakReplies !== false} onClick={() => void toggleSpeech()}>{state.settings.speakReplies !== false ? 'Speak replies' : 'Replies muted'}</button>
      {state.speech.speaking && <button type="button" onClick={() => void api('/speech/stop', {}).catch(reportError)}>Stop speaking</button>}
      {state.voice.configured && <button type="button" disabled={!!anotherVoice || live.status === 'closing'} onClick={toggleLive}>{active ? 'End live voice' : 'Live voice'}</button>}
    </div>
    {learningOpen ? <LearningPanel onClose={() => setLearningOpen(false)} /> : <div className="alpha-conversation-scroll" aria-live="polite">
      {entries.length === 0 && live.captions.length === 0 && <div className="alpha-conversation-welcome"><strong>Hi, I’m Alpha.</strong><p>Tell me what you’re thinking. I’ll keep my replies here while the work stays in the main window.</p><p>You can type or tap the microphone below to talk.</p></div>}
      {entries.map(entry => entry.kind === 'operation' ? <div className="alpha-conversation-exchange" data-origin={entry.operation.origin} key={entry.id}><p className="alpha-conversation-user"><span>You</span>{entry.operation.text}</p>{!!entry.operation.images?.length && <MakImages paths={entry.operation.images} />}{entry.operation.status !== 'running' && <div className={`alpha-conversation-reply${entry.operation.status === 'failed' ? ' failed' : ''}`}><span>Alpha</span><p>{entry.operation.result || 'I could not finish that request.'}</p>{entry.operation.status === 'completed' && <button type="button" aria-label="Speak Alpha reply" title="Speak reply" onClick={() => void speak('operation', entry.operation.id)}>▶</button>}</div>}</div> : <div className="alpha-conversation-reply" key={entry.id}><span>{entry.name}</span><p>{entry.text}</p><button type="button" aria-label={`Speak reply from ${entry.name}`} title="Speak reply" onClick={() => void speak('reply', entry.id.slice(6))}>▶</button></div>)}
      {live.captions.slice(-30).map((caption, index) => <p className={caption.role === 'user' ? 'alpha-conversation-user' : 'alpha-conversation-reply'} key={`${caption.start}-${index}`}><span>{caption.role === 'user' ? 'You' : 'Alpha · live'}</span>{caption.text}</p>)}
      <div ref={bottom} />
    </div>}
    {(live.error || state.speech.error) && <div className="alpha-conversation-error" role="alert">{live.error || state.speech.error}</div>}
    <div hidden={learningOpen}><MakComposer connected={state.connected} sending={sending} onSend={send} autoSendVoice /></div>
  </aside>
}
