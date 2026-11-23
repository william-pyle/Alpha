import { useEffect, useRef } from 'react'
import { api, reportError, selectThread, useDesktop } from './client'
import { conversationAttention, importantEvents } from './conversationAttention'
import { Icon } from './Icons'
import type { ConversationMenuOrigin } from './ConversationContextMenu'
import type { AlphaThread } from './types'

const statusLabels: Record<string, string> = {
  idle: 'Ready', starting: 'Starting', connecting: 'Connecting', working: 'Working',
  waiting: 'Waiting for input', 'waiting-for-user': 'Waiting for your answer',
  'needs-attention': 'Needs attention', 'ready-for-review': 'Ready for review',
  stopped: 'Stopped', failed: 'Failed', interrupted: 'Interrupted',
}
const attentionStatuses = ['waiting', 'waiting-for-user', 'needs-attention', 'ready-for-review', 'failed']
const activeStatuses = ['starting', 'connecting', 'working']

export default function ConversationTabs({ threads, selectedId, context, close }: {
  threads: AlphaThread[]; selectedId: string | null;
  context: (target: ConversationMenuOrigin) => void;
  close: (id: string, origin: HTMLButtonElement) => void;
}) {
  const state = useDesktop()
  const strip = useRef<HTMLDivElement>(null)
  const visible = threads.filter(thread => !thread.archived || thread.id === selectedId)
  useEffect(() => { strip.current?.querySelector('.conversation-tab.selected')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }) }, [selectedId])
  return <div ref={strip} className="conversation-tabs" role="tablist" aria-label="Conversations">
    {!visible.length && <span className="conversation-tabs-empty">No open conversations</span>}
    {visible.map((thread, index) => {
      const selected = thread.id === selectedId
      const terminal = thread.viewMode === 'terminal'
      const currentStatus = thread.backgroundWorkActive && thread.status === 'idle' ? 'working' : thread.status
      const status = statusLabels[currentStatus] || currentStatus.replace(/-/g, ' ')
      const statusMark = attentionStatuses.includes(currentStatus) ? 'attention' : activeStatuses.includes(currentStatus) ? 'active' : 'idle'
      const label = [thread.name, terminal ? 'Terminal' : 'Messages', status, thread.unread && 'Unread', thread.archived && 'History'].filter(Boolean).join(', ')
      const attention = conversationAttention(state, thread)
      return <div role="presentation" className={`conversation-tab${selected ? ' selected' : ''}`} key={thread.id} onContextMenu={event => { event.preventDefault(); const origin = event.currentTarget.querySelector<HTMLElement>('[role=tab]')!; context({ id: thread.id, x: event.clientX, y: event.clientY, origin }) }}>
      <button type="button" className="conversation-tab-mode" aria-label={`Worker terminal for ${thread.name}`} aria-pressed={terminal} title={terminal ? `Show Alpha conversation: ${thread.name}` : `Show worker terminal: ${thread.name}`} onClick={() => {
        void api(`/threads/${thread.id}/view`, { viewMode: terminal ? 'alpha' : 'terminal' }).catch(reportError)
      }}><Icon name={terminal ? 'terminal' : 'chats'} size={14} /></button>
      <button type="button" role="tab" id={`conversation-tab-${thread.id}`} aria-controls="conversation-content" aria-selected={selected} tabIndex={selected || !selectedId && index === 0 ? 0 : -1}
        title={label} aria-label={label}
        onClick={() => void selectThread(thread.id).catch(reportError)} onKeyDown={event => {
          if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') { event.preventDefault(); const box = event.currentTarget.getBoundingClientRect(); context({ id: thread.id, x: box.left, y: box.bottom, origin: event.currentTarget }); return }
          if (event.key === 'Delete') { event.preventDefault(); close(thread.id, event.currentTarget); return }
          const next = { ArrowRight: (index + 1) % visible.length, ArrowLeft: (index + visible.length - 1) % visible.length, Home: 0, End: visible.length - 1 }[event.key]
          if (next === undefined) return
          event.preventDefault()
          const target = visible[next]
          document.getElementById(`conversation-tab-${target.id}`)?.focus()
          void selectThread(target.id).catch(reportError)
        }}><span className="conversation-tab-title">{thread.name}</span><span className="conversation-tab-status" data-status={statusMark} aria-hidden="true" /></button>
      {attention.count > 0 && <button type="button" className="conversation-tab-badge" title={attention.label} aria-label={`Attention for ${thread.name}: ${attention.label}`} onClick={() => {
        const question = attention.question
        if (question) void selectThread(thread.id).then(() => window.dispatchEvent(new CustomEvent('alpha-open-question', { detail: question.id }))).catch(reportError)
        else if (importantEvents(state).some(item => item.threadId === thread.id)) window.dispatchEvent(new Event('alpha-important-events'))
        else void selectThread(thread.id).catch(reportError)
      }}>{attention.count}</button>}
      <button type="button" className="conversation-tab-close" aria-label={`Close conversation tab for ${thread.name}`} title="Close tab · Work continues" onClick={event => close(thread.id, event.currentTarget)}>×</button>
    </div>})}
  </div>
}
