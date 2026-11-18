import { useEffect, useRef } from 'react'
import { api, reportError, selectThread, useDesktop } from './client'
import { conversationAttention, importantEvents } from './conversationAttention'
import { Icon } from './Icons'
import type { ConversationMenuOrigin } from './ConversationContextMenu'
import type { AlphaThread } from './types'

export default function ConversationTabs({ threads, selectedId, context }: { threads: AlphaThread[]; selectedId: string | null; context: (target: ConversationMenuOrigin) => void }) {
  const state = useDesktop()
  const strip = useRef<HTMLDivElement>(null)
  const visible = threads.filter(thread => !thread.archived || thread.id === selectedId)
  useEffect(() => { strip.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }) }, [selectedId])
  return <div ref={strip} className="conversation-tabs" role="tablist" aria-label="Conversations">
    {!visible.length && <span className="conversation-tabs-empty">No open conversations</span>}
    {visible.map((thread, index) => <div role="presentation" className={`conversation-tab ${thread.id === selectedId ? 'selected' : ''}`} key={thread.id} onContextMenu={event => { event.preventDefault(); const origin = event.currentTarget.querySelector<HTMLElement>('[role=tab]')!; context({ id: thread.id, x: event.clientX, y: event.clientY, origin }) }}>
      <button role="tab" id={`conversation-tab-${thread.id}`} aria-controls="conversation-content" aria-selected={thread.id === selectedId} tabIndex={thread.id === selectedId || !selectedId && index === 0 ? 0 : -1}
        title={`${thread.name} — ${thread.projectId || 'Project needed'} · ${thread.status}${thread.unread ? ' · unread' : ''}`} aria-label={`${thread.name}${thread.unread ? ', unread' : ''}, ${thread.status}`}
        onClick={() => void selectThread(thread.id).catch(reportError)} onKeyDown={event => {
          if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') { event.preventDefault(); const box = event.currentTarget.getBoundingClientRect(); context({ id: thread.id, x: box.left, y: box.bottom, origin: event.currentTarget }); return }
          const next = { ArrowRight: (index + 1) % visible.length, ArrowLeft: (index + visible.length - 1) % visible.length, Home: 0, End: visible.length - 1 }[event.key]
          if (next === undefined) return
          event.preventDefault()
          const target = visible[next]
          document.getElementById(`conversation-tab-${target.id}`)?.focus()
          void selectThread(target.id).catch(reportError)
        }}><span className="conversation-tab-title">{thread.name}</span><small>{thread.unread ? '● ' : ''}{thread.status}{thread.archived ? ' · History' : ''}</small></button>
      {conversationAttention(state, thread).count > 0 && <button className="conversation-tab-badge" title={conversationAttention(state, thread).label} aria-label={`Attention for ${thread.name}: ${conversationAttention(state, thread).label}`} onClick={() => {
        const question = conversationAttention(state, thread).question
        if (question) void selectThread(thread.id).then(() => window.dispatchEvent(new CustomEvent('alpha-open-question', { detail: question.id }))).catch(reportError)
        else if (importantEvents(state).some(item => item.threadId === thread.id)) window.dispatchEvent(new Event('alpha-important-events'))
        else void selectThread(thread.id).catch(reportError)
      }}>{conversationAttention(state, thread).count}</button>}
      <button className="conversation-tab-mode" aria-label={`Worker terminal for ${thread.name}`} aria-pressed={thread.viewMode === 'terminal'} title={thread.viewMode === 'terminal' ? `Show Alpha conversation: ${thread.name}` : `Show worker terminal: ${thread.name}`} onClick={() => {
        void api(`/threads/${thread.id}/view`, { viewMode: thread.viewMode === 'terminal' ? 'alpha' : 'terminal' }).catch(reportError)
      }}><Icon name={thread.viewMode === 'terminal' ? 'chats' : 'terminal'} size={15} /></button>
    </div>)}
  </div>
}
